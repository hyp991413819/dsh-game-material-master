/**
 * 游戏 UI 生成（模块九）的**真实端到端**自检：真的调本机 ComfyUI 跑一次
 * 生图 + 一次切图，把产物留在磁盘上并打印绝对路径，方便人眼验收。
 *
 * ⚠️ 与 `verify-ui.mjs` 的分工：
 *   · `verify-ui.mjs` —— 纯本地、毫秒级、只核对内核与形状，CI 里跑；
 *   · 本文件 —— 会**真的占显卡几分钟**，只在人工验收时跑。
 *
 * 零计费（MOSS / WeVisOne-VL / Qwen-Edit 全在本机），但需要：
 *   · ComfyUI 在 8188 上跑着；
 *   · 装了 moss-layout-local 节点包；
 *   · 有 moss_image / wevisone / qwen_image_2.1 的权重。
 *
 * 用法：
 *   node scripts/e2e-ui.mjs                     # 默认 2 个框、qwen 切图
 *   node scripts/e2e-ui.mjs --matte qwen        # 换抠图方案
 *   node scripts/e2e-ui.mjs --generate-only     # 只生图，不切图
 */
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const args = process.argv.slice(2);
const matte = args.includes("--matte") ? args[args.indexOf("--matte") + 1] : "wevisone";
const generateOnly = args.includes("--generate-only");

const uigen = await import("../lib/uigen.js");

function fail(message) {
  console.error(`\n✗ ${message}`);
  process.exitCode = 1;
}

console.log("游戏 UI 生成 · 真实端到端");
console.log(`  抠图方案：${matte}${generateOnly ? "（只生图）" : ""}`);

// 1) 连通性 + 权重检查（这一步免费，也最快失败）
console.log("\n1) 检查 ComfyUI 与权重");
try {
  const result = await uigen.testUiConnection();
  console.log(`  ✓ ${result.message}`);
  console.log(`    ${result.baseUrl}`);
} catch (error) {
  fail(`ComfyUI 自检失败：${error instanceof Error ? error.message : String(error)}`);
  console.log("\n先确认 ComfyUI 在跑、节点包与权重都齐，再重跑本脚本。");
  process.exit(1);
}

// 2) 建任务（画框是本机内存里的样例，不写进用户数据目录）
console.log("\n2) 建一个样例任务");
const layout = {
  width: 1024,
  height: 1024,
  summary:
    "Game UI popup panel: dark navy plate with an ornate gold frame, a centered gold title, one gold rounded button at the bottom, and a small treasure chest icon in the middle.",
  boxes: [
    { id: "b1", label: "object", caption: "panel plate: dark navy rounded rectangle with an ornate gold frame", x1: 120, y1: 120, x2: 904, y2: 800 },
    { id: "b2", label: "text", caption: "centered gold title text", text: "DAILY SIGN-IN", x1: 300, y1: 180, x2: 724, y2: 300 },
    { id: "b3", label: "object", caption: "gold rounded button", x1: 360, y1: 640, x2: 664, y2: 740 },
    { id: "b4", label: "object", caption: "small treasure chest icon", x1: 452, y1: 380, x2: 572, y2: 500 }
  ]
};
const job = await uigen.createUiJob({ name: "e2e-ui 样例", layout });
console.log(`  ✓ 任务 ${job.id}（${layout.boxes.length} 个画框）`);
const dir = uigen.uiJobDir(job.id);
console.log(`    数据目录：${dir}`);

/**
 * 等一个阶段跑完。
 *
 * ⚠️ 判据是**阶段状态**，不是 `busy`：`busy` 读的是进程内的后台任务表，
 * 而这里的方法调用与任务都在本进程里 —— 但 `busy` 在任务收尾的瞬间就会变
 * false，比阶段状态先一步；用它当判据会拿到「还没写 renders」的中间态。
 */
async function waitFor(id, key, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const current = await uigen.readUiJob(id);
    if (current === undefined) throw new Error("任务不见了");
    const stage = current.stages[key];
    if (stage?.status === "error") throw new Error(stage.error ?? "阶段失败");
    if (stage?.status === "done") return current;
  }
  throw new Error(`等待超时（${Math.round(timeoutMs / 1000)} 秒）`);
}

// 3) 生图
console.log("\n3) MOSS-Image 生图（约 1~3 分钟）");
const started = await uigen.startUiGeneration(job.id);
if (started.started !== true) fail(`没能开始生成：${started.reason ?? "未知原因"}`);
else {
  const done = await waitFor(job.id, "generate", 20 * 60 * 1000);
  const render = done.renders[done.renders.length - 1];
  console.log(`  ✓ 出图：${render.width}×${render.height} · ${(render.bytes / 1024).toFixed(0)} KB · ${((render.elapsedMs ?? 0) / 1000).toFixed(0)} 秒`);
  console.log(`    绝对路径：${join(dir, render.file)}`);
}

if (generateOnly) {
  console.log(`\n产物目录：${dir}`);
  process.exit(process.exitCode ?? 0);
}

// 4) 切图
console.log(`\n4) 按框切图（${matte}，每框约 1~2 分钟）`);
await uigen.saveUiJob(job.id, { sliceSettings: { ...uigen.UI_DEFAULT_SLICE, matte } });
const slicing = await uigen.startUiSlice(job.id);
if (slicing.started !== true) fail(`没能开始切图：${slicing.reason ?? "未知原因"}`);
else {
  const done = await waitFor(job.id, "slice", 30 * 60 * 1000);
  const batch = done.batches[done.batches.length - 1];
  console.log(`  ✓ 切出 ${batch.slices.length} 张透明 PNG（跳过 ${batch.skipped.length} 个框）`);
  for (const slice of batch.slices) {
    console.log(`    ${slice.index}. ${slice.label} ${slice.width}×${slice.height} · ${(slice.bytes / 1024).toFixed(0)} KB`);
  }
  if (batch.skipped.length > 0) {
    console.log(`    跳过的框：${batch.skipped.map((s) => `#${s.index}(${s.reason})`).join(" ")}`);
  }

  // 5) 导出 zip
  console.log("\n5) 导出 zip");
  const exported = await uigen.exportUi(job.id);
  console.log(`  ✓ ${exported.file}（${(exported.bytes / 1024).toFixed(0)} KB）`);
  console.log(`    绝对路径：${join(dir, exported.file)}`);
}

console.log(`\n产物目录：${dir}`);
console.log("（这个目录会保留，方便人眼验收；不需要了就整个删掉。）");
