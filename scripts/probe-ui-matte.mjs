/**
 * 抠图方案 A/B 探针（**占显卡**，零计费）。
 *
 * 用**同一张**已渲染好的 MOSS 图，把 `wevisone` / `qwen` 两个切片节点各跑一遍，
 * 产物按方案落到 `<output>/gmm_ab_wevisone/` 与 `<output>/gmm_ab_qwen/`，
 * 方便人眼与像素统计逐张对照。
 *
 * 为什么要这个脚本：之前比较两种方案时，两次探针各自跑了一次 MOSS 生图，
 * 而 MOSS 有随机性 —— 等于拿两张不同的源图比两种抠图，结论不成立。
 *
 * 自包含（只依赖 `lib/uilayout.js` 的两个纯函数），不碰 `src/`，也不读插件配置：
 * 直接对 127.0.0.1:8188 说话。节点写完 manifest 会崩（上游 bug），所以判据是
 * **轮询 /history + 扫 output 目录**，不是看返回值。
 *
 * 用法：
 *   node scripts/probe-ui-matte.mjs
 *   node scripts/probe-ui-matte.mjs --only wevisone
 *   node scripts/probe-ui-matte.mjs --render <绝对路径>
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { existsSync } from "node:fs";

const uilayout = await import("../lib/uilayout.js");

const BASE = "http://127.0.0.1:8188";
const OUTPUT_ROOT = "F:\\comfyui\\ComfyUI\\output";
const INPUT_DIR = "F:\\comfyui\\ComfyUI\\input";

const args = process.argv.slice(2);
const argValue = (name, fallback) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : fallback;

const only = argValue("--only", null);
const renderPath = argValue(
  "--render",
  "F:\\comfyui\\ComfyUI\\output\\gmm_ui\\umvvvuibn560d20_00001_.png"
);

if (!existsSync(renderPath)) {
  console.error(`找不到渲染图：${renderPath}`);
  process.exit(1);
}

const MODELS = {
  wevisoneModel: "WeVisOne-VL-2B",
  qwenModel: "qwen_image_2.1_int8_convrot.safetensors",
  qwenClip: "qwen3vl_8b_int8_convrot.safetensors",
  qwenVae: "qwen_image_2.1_vae_bf16.safetensors"
};

const SLICE = {
  matte: "wevisone",
  resolution: 0,
  padding: 8,
  threshold: 8,
  grow: 1,
  skipBackdrop: false,
  rejectNeighbors: true,
  instruction:
    "只保留这个 UI 元素本身，去掉背景与周围其他元素，背景必须完全透明；元素的外形、颜色、描边、文字和位置与参考图完全一致。",
  negative: "多余的边框，背景，地面，投影，其他物体，模糊，重复，乱码，错字"
};

/** 与 e2e-ui.mjs 同一套样例画框，便于横向对照。 */
const LAYOUT = {
  width: 1024,
  height: 1024,
  summary:
    "Game UI popup panel: dark navy plate with an ornate gold frame, a centered gold title, one gold rounded button at the bottom, and a small treasure chest icon in the middle.",
  boxes: [
    {
      id: "b1",
      label: "object",
      caption: "the whole dark navy rectangular panel with its gold border",
      x1: 120,
      y1: 120,
      x2: 904,
      y2: 800
    },
    {
      id: "b2",
      label: "text",
      caption: "centered gold title text",
      text: "DAILY SIGN-IN",
      x1: 300,
      y1: 180,
      x2: 724,
      y2: 300
    }
  ]
};

async function api(path, init) {
  const response = await fetch(`${BASE}${path}`, init);
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} → HTTP ${response.status}: ${text.slice(0, 400)}`);
  return text === "" ? null : JSON.parse(text);
}

function buildWorkflow(renderFile, layoutJson, matte, prefix) {
  const workflow = {
    "1": { class_type: "LoadImage", inputs: { image: renderFile } }
  };
  if (matte === "qwen") {
    workflow["3"] = { class_type: "UNETLoader", inputs: { unet_name: MODELS.qwenModel, weight_dtype: "default" } };
    workflow["4"] = { class_type: "CLIPLoader", inputs: { clip_name: MODELS.qwenClip, type: "qwen_image", device: "default" } };
    workflow["5"] = { class_type: "VAELoader", inputs: { vae_name: MODELS.qwenVae } };
    workflow["6"] = {
      class_type: "QwenEdit_Layout_Matte_Slice",
      inputs: {
        image: ["1", 0],
        layout: layoutJson,
        model: ["3", 0],
        clip: ["4", 0],
        vae: ["5", 0],
        seed: 42,
        steps: 25,
        cfg: 1,
        sampler_name: "euler",
        scheduler: "simple",
        instruction: SLICE.instruction,
        negative: SLICE.negative,
        resolution: SLICE.resolution,
        padding: SLICE.padding,
        threshold: SLICE.threshold,
        grow: SLICE.grow,
        prefix,
        skip_backdrop: SLICE.skipBackdrop,
        reject_neighbors: SLICE.rejectNeighbors
      }
    };
  } else {
    workflow["6"] = {
      class_type: "WeVisOne_Layout_Matte_Slice",
      inputs: {
        image: ["1", 0],
        layout: layoutJson,
        model: MODELS.wevisoneModel,
        precision: "bf16",
        threshold: SLICE.threshold,
        grow: SLICE.grow,
        padding: SLICE.padding,
        prefix,
        skip_backdrop: SLICE.skipBackdrop,
        reject_neighbors: SLICE.rejectNeighbors,
        keep_loaded: true
      }
    };
  }
  return workflow;
}

async function uploadImage(filename, bytes) {
  const form = new FormData();
  form.append("image", new Blob([bytes], { type: "image/png" }), filename);
  form.append("overwrite", "true");
  const response = await fetch(`${BASE}/upload/image`, { method: "POST", body: form });
  const text = await response.text();
  if (!response.ok) throw new Error(`上传失败 HTTP ${response.status}: ${text.slice(0, 300)}`);
  const parsed = JSON.parse(text);
  return parsed.subfolder ? `${parsed.subfolder}/${parsed.name}` : parsed.name;
}

/** 轮询直到 prompt 出现在 history 或超时；节点崩了也要能退出。 */
async function waitHistory(promptId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const history = await api(`/history/${promptId}`);
    const entry = history?.[promptId];
    if (entry) return entry;
  }
  throw new Error("等待超时");
}

async function listOutputs(prefix) {
  const [sub, base] = prefix.split("/");
  const dir = join(OUTPUT_ROOT, sub);
  if (!existsSync(dir)) return { dir, files: [] };
  const files = (await readdir(dir)).filter((name) => name.startsWith(base)).sort();
  const withSize = [];
  for (const name of files) {
    const info = await stat(join(dir, name));
    withSize.push({ name, bytes: info.size });
  }
  return { dir, files: withSize };
}

const renderBytes = await readFile(renderPath);
const uploadName = `probe_${basename(renderPath)}`;
const uploaded = await uploadImage(uploadName, renderBytes);
console.log(`渲染图：${uploadName} → ComfyUI input/${uploaded}`);
console.log(`画框：${LAYOUT.boxes.length} 个`);

const layoutJson = uilayout.draftUiLayout(LAYOUT);
const plans = [
  { matte: "wevisone", prefix: "gmm_ab_wevisone/element" },
  { matte: "qwen", prefix: "gmm_ab_qwen/element" }
].filter((plan) => !only || plan.matte === only);

for (const plan of plans) {
  console.log(`\n=== ${plan.matte} ===`);
  const workflow = buildWorkflow(uploaded, layoutJson, plan.matte, plan.prefix);
  const started = Date.now();
  const submitted = await api("/prompt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: workflow })
  });
  const promptId = submitted.prompt_id;
  console.log(`  已提交 ${promptId}`);
  if (submitted.node_errors && Object.keys(submitted.node_errors).length > 0) {
    console.log(`  节点报错：${JSON.stringify(submitted.node_errors).slice(0, 600)}`);
  }
  try {
    await waitHistory(promptId, 30 * 60 * 1000);
    console.log(`  完成，用时 ${((Date.now() - started) / 1000).toFixed(0)} 秒`);
  } catch (error) {
    console.log(`  等待结束：${error.message}（节点崩了也要看盘上产物）`);
  }
  const { dir, files } = await listOutputs(plan.prefix);
  console.log(`  产物目录：${dir}`);
  for (const file of files) {
    console.log(`    ${file.name}  ${(file.bytes / 1024).toFixed(0)} KB`);
  }
}

console.log("\n下一步：逐张读图 + 量 alpha / 锐度，再决定默认方案。");
