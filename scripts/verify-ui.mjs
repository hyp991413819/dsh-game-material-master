/**
 * 游戏 UI 生成（模块九 · ui）的内核自检：画框校验、MOSS layout 编译、
 * 两种切图格式的差异、工作流拼装、资源路由与工具面。
 *
 * 纯本地、不联网、不花钱：所有 ComfyUI 交互都用假对象核对**发出去的形状**，
 * 不真的提交任务。
 *
 * 重点盯三条「错了不报错、只是结果不对」的契约：
 *   1. `compileUiLayout` 的坐标必须是 `abs_centralized` / `yxyx`（减画布中心、
 *      顺序 y,x,y,x）——写错框会摆到别处；
 *   2. `draftUiLayout` 必须是 `abs` / `xyxy`（像素左上原点）——给错切片节点
 *      会在 Python 里抛 `'dict' object has no attribute 'strip'`；
 *   3. 两种格式**不能混用**（把编译后的喂给切片节点，或反过来）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    const result = fn();
    if (result === false) throw new Error("返回 false");
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push(`${name}：${error instanceof Error ? error.message : String(error)}`);
    console.log(`  ✗ ${name} — ${error instanceof Error ? error.message : String(error)}`);
  }
}

function checkThrows(name, fn, matcher) {
  try {
    fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (matcher !== undefined && !matcher.test(message)) {
      failures.push(`${name}：报错文案不匹配 —— ${message}`);
      console.log(`  ✗ ${name} — 报错文案不匹配：${message}`);
      return;
    }
    passed += 1;
    console.log(`  ✓ ${name}`);
    return;
  }
  failures.push(`${name}：本该报错却通过了`);
  console.log(`  ✗ ${name} — 本该报错却通过了`);
}

const ui = await import("../lib/uilayout.js");
const uigen = await import("../lib/uigen.js");

console.log("\n1) 画布尺寸校验");
check("1024×1024 通过", () => ui.normalizeCanvasSize(1024, "宽") === 1024);
check("256（下界）通过", () => ui.normalizeCanvasSize(256, "宽") === 256);
check("2048（上界）通过", () => ui.normalizeCanvasSize(2048, "宽") === 2048);
checkThrows("非 16 倍数被拒", () => ui.normalizeCanvasSize(1000, "宽"), /16 的正整数倍/);
checkThrows("小于 256 被拒", () => ui.normalizeCanvasSize(128, "宽"), /256~2048/);
checkThrows("大于 2048 被拒", () => ui.normalizeCanvasSize(4096, "宽"), /256~2048/);
checkThrows("非数字被拒", () => ui.normalizeCanvasSize("abc", "宽"), /必须是数字/);
checkThrows("小数被拒", () => ui.normalizeCanvasSize(1024.5, "宽"), /必须是整数/);

console.log("\n2) 画框校验");
const base = { width: 1024, height: 1024, summary: "测试" };
check("合法框通过并取整", () => {
  const box = ui.normalizeBox({ label: "object", caption: "按钮", x1: 10.4, y1: 20.6, x2: 100, y2: 200 }, 1, 1024, 1024);
  return box.x1 === 10 && box.y1 === 21 && box.label === "object";
});
checkThrows("缺描述被拒", () => ui.normalizeBox({ label: "object", caption: "  ", x1: 0, y1: 0, x2: 10, y2: 10 }, 1, 1024, 1024), /请填写描述/);
checkThrows("非法类型被拒", () => ui.normalizeBox({ label: "hack", caption: "x", x1: 0, y1: 0, x2: 10, y2: 10 }, 1, 1024, 1024), /object \/ character \/ text/);
checkThrows("文字框缺 text 被拒", () => ui.normalizeBox({ label: "text", caption: "标题", x1: 0, y1: 0, x2: 10, y2: 10 }, 1, 1024, 1024), /请填写实际可见的文字/);
checkThrows("越界框被拒", () => ui.normalizeBox({ label: "object", caption: "x", x1: 0, y1: 0, x2: 2000, y2: 10 }, 1, 1024, 1024), /越界/);
checkThrows("面积为 0 被拒", () => ui.normalizeBox({ label: "object", caption: "x", x1: 10, y1: 10, x2: 10, y2: 20 }, 1, 1024, 1024), /越界或面积为 0/);
checkThrows("坐标不是数字被拒", () => ui.normalizeBox({ label: "object", caption: "x", x1: "a", y1: 0, x2: 10, y2: 10 }, 1, 1024, 1024), /必须是数字/);

console.log("\n3) 整份 layout");
const sample = {
  width: 1024,
  height: 1024,
  summary: "签到弹窗",
  boxes: [
    { id: "b1", label: "object", caption: "面板", x1: 100, y1: 100, x2: 900, y2: 800 },
    { id: "b2", label: "text", caption: "标题", text: "每日签到", x1: 300, y1: 180, x2: 700, y2: 300 }
  ]
};
check("合法 layout 通过", () => ui.normalizeLayout(sample).boxes.length === 2);
checkThrows("空画框被拒", () => ui.normalizeLayout({ ...sample, boxes: [] }), /至少画一个画框/);
checkThrows("缺 summary 被拒", () => ui.normalizeLayout({ ...sample, summary: "" }), /全局描述/);
checkThrows("id 重复被拒", () => ui.normalizeLayout({ ...sample, boxes: [sample.boxes[0], { ...sample.boxes[1], id: "b1" }] }), /id 重复/);
checkThrows("超过 40 个框被拒", () => {
  const many = Array.from({ length: 41 }, (_, i) => ({ id: `b${i}`, label: "object", caption: "x", x1: 0, y1: 0, x2: 16, y2: 16 }));
  return ui.normalizeLayout({ ...sample, boxes: many });
}, /最多 40 个/);

console.log("\n4) 坐标换算（黄金对照：与 moss-layout-local 的 _pixel_to_centralized_yxyx 逐位一致）");
// Python 侧：return [y1 - h//2, x1 - w//2, y2 - h//2, x2 - w//2]
check("1024 画布：中心偏移 512", () => {
  const out = ui.pixelToCentralizedYxyx({ x1: 100, y1: 200, x2: 300, y2: 400 }, 1024, 1024);
  return JSON.stringify(out) === JSON.stringify([-312, -412, -112, -212]);
});
check("顺序是 y,x,y,x（不是 x,y,x,y）", () => {
  const out = ui.pixelToCentralizedYxyx({ x1: 10, y1: 20, x2: 30, y2: 40 }, 100, 100);
  // 减 50：y1=20 -> -30；x1=10 -> -40；y2=40 -> -10；x2=30 -> -20
  return JSON.stringify(out) === JSON.stringify([-30, -40, -10, -20]);
});
check("非方形画布各用各的中心", () => {
  const out = ui.pixelToCentralizedYxyx({ x1: 0, y1: 0, x2: 800, y2: 600 }, 800, 600);
  return JSON.stringify(out) === JSON.stringify([-300, -400, 300, 400]);
});
check("奇数尺寸用 floor 取中心", () => {
  // 与 Python 的 `height // 2` 一致（向下取整），不是 Math.round。
  const out = ui.pixelToCentralizedYxyx({ x1: 0, y1: 0, x2: 10, y2: 10 }, 101, 101);
  return JSON.stringify(out) === JSON.stringify([-50, -50, -40, -40]);
});

console.log("\n5) 编译格式：compileUiLayout（给 MOSS 文本编码）");
check("bbox_coord_space 是 abs_centralized", () => {
  const parsed = JSON.parse(ui.compileUiLayout(ui.normalizeLayout(sample)));
  return parsed.bbox_coord_space === "abs_centralized";
});
check("bbox_format 是 yxyx", () => JSON.parse(ui.compileUiLayout(ui.normalizeLayout(sample))).bbox_format === "yxyx");
check("文字框带上 text", () => {
  const parsed = JSON.parse(ui.compileUiLayout(ui.normalizeLayout(sample)));
  return parsed.items[1].text === "每日签到" && parsed.items[1].label === "text";
});
check("物体框不带 text 键", () => {
  const parsed = JSON.parse(ui.compileUiLayout(ui.normalizeLayout(sample)));
  return parsed.items[0].text === undefined;
});
check("summary 带 caption", () => JSON.parse(ui.compileUiLayout(ui.normalizeLayout(sample))).summary.caption === "签到弹窗");
check("坐标是减过画布中心的", () => {
  const parsed = JSON.parse(ui.compileUiLayout(ui.normalizeLayout(sample)));
  return JSON.stringify(parsed.items[0].bbox) === JSON.stringify([-412, -412, 288, 388]);
});

console.log("\n6) 编译格式：draftUiLayout（给切片节点）");
check("bbox_coord_space 是 abs", () => JSON.parse(ui.draftUiLayout(ui.normalizeLayout(sample))).bbox_coord_space === "abs");
check("bbox_format 是 xyxy", () => JSON.parse(ui.draftUiLayout(ui.normalizeLayout(sample))).bbox_format === "xyxy");
check("带 width / height（切片节点要它算缩放）", () => {
  const parsed = JSON.parse(ui.draftUiLayout(ui.normalizeLayout(sample)));
  return parsed.width === 1024 && parsed.height === 1024;
});
check("坐标是原始像素（不减中心）", () => {
  const parsed = JSON.parse(ui.draftUiLayout(ui.normalizeLayout(sample)));
  return JSON.stringify(parsed.items[0].bbox) === JSON.stringify([100, 100, 900, 800]);
});
check("两种格式的同一个框坐标确实不同（防混用）", () => {
  const compiled = JSON.parse(ui.compileUiLayout(ui.normalizeLayout(sample))).items[0].bbox;
  const draft = JSON.parse(ui.draftUiLayout(ui.normalizeLayout(sample))).items[0].bbox;
  return JSON.stringify(compiled) !== JSON.stringify(draft);
});

console.log("\n7) 背景板判定（面积 ≥ 50% 画布）");
check("整张画布是背景板", () => ui.isBackdropBox({ x1: 0, y1: 0, x2: 1024, y2: 1024 }, 1024, 1024) === true);
check("刚好一半算背景板", () => ui.isBackdropBox({ x1: 0, y1: 0, x2: 1024, y2: 512 }, 1024, 1024) === true);
check("大面板（约 60%）算背景板", () => ui.isBackdropBox({ x1: 100, y1: 100, x2: 900, y2: 800 }, 1024, 1024) === true);
check("小按钮不算", () => ui.isBackdropBox({ x1: 360, y1: 640, x2: 664, y2: 740 }, 1024, 1024) === false);

console.log("\n8) 外扩裁切");
check("外扩 8px", () => {
  const out = ui.expandBox({ x1: 100, y1: 100, x2: 200, y2: 200 }, 8, 1024, 1024);
  return out.x1 === 92 && out.y1 === 92 && out.x2 === 208 && out.y2 === 208;
});
check("贴边时夹回画布", () => {
  const out = ui.expandBox({ x1: 2, y1: 2, x2: 100, y2: 100 }, 8, 1024, 1024);
  return out.x1 === 0 && out.y1 === 0;
});
check("负 padding 当作 0", () => {
  const out = ui.expandBox({ x1: 100, y1: 100, x2: 200, y2: 200 }, -5, 1024, 1024);
  return out.x1 === 100 && out.x2 === 200;
});

console.log("\n9) MOSS 生图工作流");
const settings = { ...uigen.UI_DEFAULT_SETTINGS };
const moss = uigen.buildMossWorkflow({
  layoutJson: '{"summary":{"caption":"x"}}',
  width: 1024,
  height: 768,
  negative: "text",
  settings,
  seed: 42,
  prefix: "gmm_ui/test"
});
check("layout 直接进文本编码（不经编译节点）", () => {
  const encode = moss["5"];
  return encode.class_type === "CLIPTextEncode" && encode.inputs.text === '{"summary":{"caption":"x"}}';
});
check("工作流里没有 MOSS_Layout_Local_Compile", () =>
  !Object.values(moss).some((node) => node.class_type === "MOSS_Layout_Local_Compile"));
check("CLIPLoader 的 type 是 moss_image", () => moss["2"].inputs.type === "moss_image");
check("latent 用画布尺寸", () => moss["7"].inputs.width === 1024 && moss["7"].inputs.height === 768);
check("采样参数来自 settings", () => moss["8"].inputs.steps === settings.steps && moss["8"].inputs.cfg === settings.cfg);
check("种子透传", () => moss["8"].inputs.seed === 42);
check("存图前缀透传", () => moss["10"].inputs.filename_prefix === "gmm_ui/test");

console.log("\n10) 切图工作流（两种抠图方案）");
const sliceBase = { renderFile: "in.png", layoutJson: '{"width":1024}', prefix: "gmm_ui_slice/x", seed: 7 };
const qwen = uigen.buildSliceWorkflow({ ...sliceBase, settings: { ...uigen.UI_DEFAULT_SLICE, matte: "qwen" } });
const wevis = uigen.buildSliceWorkflow({ ...sliceBase, settings: { ...uigen.UI_DEFAULT_SLICE, matte: "wevisone" } });
check("qwen 用 QwenEdit_Layout_Matte_Slice", () => qwen["6"].class_type === "QwenEdit_Layout_Matte_Slice");
check("wevisone 用 WeVisOne_Layout_Matte_Slice", () => wevis["6"].class_type === "WeVisOne_Layout_Matte_Slice");
check("qwen 接了 MODEL / CLIP / VAE", () => {
  const node = qwen["6"];
  return Array.isArray(node.inputs.model) && Array.isArray(node.inputs.clip) && Array.isArray(node.inputs.vae);
});
check("切片节点收到的是 draft 格式（字符串原样透传）", () => qwen["6"].inputs.layout === '{"width":1024}');
check("默认抠图方案是 wevisone（指代抠图，贴合 UI）", () => uigen.UI_DEFAULT_SLICE.matte === "wevisone");
check("默认不跳背景板（大框往往是面板本体）", () => uigen.UI_DEFAULT_SLICE.skipBackdrop === false);
check("默认 resolution=0（保持原裁切尺寸）", () => uigen.UI_DEFAULT_SLICE.resolution === 0);

// WeVisOne 的接线与 BiRefNet / Qwen 都不一样，这里逐条钉住。
check("wevisone 的 model 是权重目录名字符串（不是 MODEL 连线）", () => {
  const value = wevis["6"].inputs.model;
  return typeof value === "string" && value.length > 0;
});
check("wevisone 不接 UNETLoader / CLIPLoader / VAELoader", () => {
  const types = Object.values(wevis).map((node) => node.class_type);
  return !types.includes("UNETLoader") && !types.includes("CLIPLoader") && !types.includes("VAELoader");
});
check("wevisone 带 precision（默认 bf16）", () => wevis["6"].inputs.precision === "bf16");
check("wevisone 关掉常驻显存（keep_loaded=false，别白占 4.6 GB）", () => wevis["6"].inputs.keep_loaded === false);
check("wevisone 透传 reject_neighbors", () => wevis["6"].inputs.reject_neighbors === uigen.UI_DEFAULT_SLICE.rejectNeighbors);
check("wevisone 没有 per_element（那是 BiRefNet 专有参数）", () => wevis["6"].inputs.per_element === undefined);
check("wevisone 的 layout 也是 draft 格式（字符串原样透传）", () => wevis["6"].inputs.layout === '{"width":1024}');
check("老数据的 birefnet 会迁移成 wevisone", () => uigen.normalizeSliceSettings({ matte: "birefnet" }).matte === "wevisone");
check("wevisone 原样保留", () => uigen.normalizeSliceSettings({ matte: "wevisone" }).matte === "wevisone");

console.log("\n11) 设置归一化");
check("越界的 steps 被夹到 1~100", () => uigen.normalizeGenSettings({ steps: 999 }).steps === 100);
check("非法 matte 回落到默认", () => uigen.normalizeSliceSettings({ matte: "hack" }).matte === "wevisone");
check("resolution 夹到 0~4096", () => uigen.normalizeSliceSettings({ resolution: 99999 }).resolution === 4096);
check("resolution=0 不会被夹走（= 保持原裁切尺寸）", () => uigen.normalizeSliceSettings({ resolution: 0 }).resolution === 0);
check("默认 resolution 就是 0", () => uigen.normalizeSliceSettings({}).resolution === 0);
check("布尔字段默认值正确", () => uigen.normalizeSliceSettings({}).skipBackdrop === false && uigen.normalizeSliceSettings({}).rejectNeighbors === true);

console.log("\n12) 任务 id 与快照");
check("u 前缀是合法 UI 任务 id", () => uigen.isValidUiJobId("uabc123"));
check("p 前缀不是 UI 任务", () => uigen.isValidUiJobId("pabc123") === false);
check("uiSnapshot 的 assetBase 指向 ui-assets", () => {
  const job = {
    id: "uabc123",
    name: "t",
    createdAt: 1,
    updatedAt: 1,
    layout: { width: 1024, height: 1024, summary: "x", boxes: [] },
    settings: uigen.UI_DEFAULT_SETTINGS,
    sliceSettings: uigen.UI_DEFAULT_SLICE,
    status: "idle",
    renders: [{ id: "r1", file: "render/r1.png", bytes: 1, width: 1, height: 1, layout: { width: 1024, height: 1024, summary: "x", boxes: [] }, settings: uigen.UI_DEFAULT_SETTINGS, createdAt: 1 }],
    batches: [],
    stages: {},
    exports: [],
    log: []
  };
  const snapshot = uigen.uiSnapshot(job, "http://localhost");
  return snapshot.assetBase.includes("/ui-assets/uabc123/") && snapshot.renders[0].url.endsWith("/render/r1.png");
});
check("SERVABLE_UI_DIRS 含四个子目录", () => {
  const dirs = uigen.SERVABLE_UI_DIRS;
  return dirs.has("source") && dirs.has("render") && dirs.has("slices") && dirs.has("out");
});

console.log("\n13) PNG 尺寸解析");
check("读得出 PNG 宽高", () => {
  // 最小合法 PNG 头：8 字节签名 + 4 字节长度 + "IHDR" + 宽 + 高
  const buffer = Buffer.alloc(32);
  buffer.writeUInt8(0x89, 0);
  buffer.write("PNG", 1, "ascii");
  buffer.writeUInt32BE(640, 16);
  buffer.writeUInt32BE(480, 20);
  const size = uigen.pngSize(buffer);
  return size.width === 640 && size.height === 480;
});
check("非 PNG 返回 0", () => uigen.pngSize(Buffer.from("not a png at all, definitely not")).width === 0);

// ── 界面静态契约 ────────────────────────────────────────────────────────
//
// 这两条都是**真机踩出来的**、且自检当时全绿：
//   ① 生成图被平铺成「一堆小图的合图」——内联只设了 backgroundImage，
//      样式表里的 background-size:20px 把它当图案重复；
//   ② 抠图方案选了 BiRefNet、实际跑 Qwen——下拉框只是个本地 state，
//      从没发给宿主，而 `runUiSlice` 读的是宿主的 sliceSettings.matte。
const here = dirname(fileURLToPath(import.meta.url));
const clientSource = readFileSync(join(here, "..", "src", "client.ts"), "utf8");

console.log("\n14) 界面静态契约（防真机回归）");
check("画布设置生成图时必须同时覆盖 backgroundSize", () => {
  const index = clientSource.indexOf('"data-testid": "ui-canvas"');
  if (index < 0) throw new Error("找不到 UI 画布");
  const block = clientSource.slice(index, index + 1400);
  return /backgroundSize:\s*"contain"/.test(block);
});
check("画布设置生成图时必须禁止平铺（backgroundRepeat no-repeat）", () => {
  const index = clientSource.indexOf('"data-testid": "ui-canvas"');
  const block = clientSource.slice(index, index + 1400);
  return /backgroundRepeat:\s*"no-repeat"/.test(block);
});
check("抠图方案下拉框绑定的是宿主的 sliceSettings.matte", () => {
  const index = clientSource.indexOf('"data-testid": "ui-matte-select"');
  if (index < 0) throw new Error("找不到抠图方案下拉框");
  const block = clientSource.slice(index, index + 1600);
  return /value:\s*job\.sliceSettings\?\.matte/.test(block);
});
check("改抠图方案时真的调 saveUiJob 存回宿主", () => {
  const index = clientSource.indexOf('"data-testid": "ui-matte-select"');
  const block = clientSource.slice(index, index + 1600);
  return /saveUiJob\(\{[^}]*sliceSettings/.test(block);
});
check("UI 模块里没有会漂移的本地 sliceMode state", () => {
  // 本地 state 只改界面、不发给宿主，正是那个「选了不生效」的成因。
  return !/const \[sliceMode, setSliceMode\]/.test(clientSource);
});

console.log(`\n共 ${passed + failures.length} 项检查，失败 ${failures.length} 项。`);
if (failures.length > 0) {
  console.error(`失败项：${failures.join("；")}`);
  process.exitCode = 1;
} else {
  console.log("游戏 UI 生成内核自检全部通过。");
}
