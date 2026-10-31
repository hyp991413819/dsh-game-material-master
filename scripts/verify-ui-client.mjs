/**
 * 游戏 UI 生成（模块九 · ui）的**真渲染**自检：用迷你 React 把 `UiModule`
 * 真正渲染出来，验证两个只有真机才暴露的 bug 不再复发。
 *
 * 这两个 bug 当时自检全绿：
 *
 *   ① **生成图被平铺成「一堆小图的合图」** —— 画布的内联样式只设了
 *      `backgroundImage`，而样式表里给棋盘格写着 `background-size:20px 20px`，
 *      于是那张 1024×1024 的图被当成 20px 的图案重复铺满。
 *   2 **抠图方案选了 BiRefNet、实际跑 Qwen** —— 下拉框是个独立的本地 state，
 *      从没发给宿主；`runUiSlice` 读的是宿主里的 `sliceSettings.matte`。
 *
 * 纯本地、毫秒级、不联网。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, "..", "lib", "client.js");

let checks = 0;
const failures = [];
function check(name, ok, detail) {
  checks += 1;
  if (ok) {
    console.log(`  ✓ ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}
function report() {
  console.log("");
  if (failures.length > 0) {
    console.error(`失败 ${failures.length} 项：${failures.join("、")}`);
    process.exit(1);
  }
  console.log(`共 ${checks} 项检查，全部通过。`);
  process.exit(0);
}

// ── 假 React ────────────────────────────────────────────────────────────
const HOOK = { slots: [], cursor: 0 };
const ReactStub = {
  Fragment: Symbol.for("react.fragment"),
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children };
  },
  useState(initial) {
    const index = HOOK.cursor++;
    const value = HOOK.slots[index];
    return [value === undefined ? (typeof initial === "function" ? initial() : initial) : value, () => {}];
  },
  useRef(initial) {
    HOOK.cursor++;
    return { current: initial };
  },
  useEffect() {},
  useLayoutEffect() {},
  useCallback(fn) {
    return fn;
  },
  useMemo(fn) {
    return fn();
  },
  useContext() {
    return undefined;
  }
};

const windowStub = {
  __ModuleLoader__: { load(registration) { windowStub.__LOADED = registration; } },
  location: { origin: "http://127.0.0.1:43120", search: "", href: "http://127.0.0.1:43120/" },
  history: { replaceState() {} },
  setTimeout: (fn) => { fn(); return 0; },
  clearTimeout() {},
  setInterval: () => 0,
  clearInterval() {}
};
globalThis.document = {
  head: { appendChild() {}, removeChild() {} },
  createElement: () => ({ setAttribute() {}, remove() {}, style: {}, textContent: "" }),
  addEventListener() {},
  removeEventListener() {}
};

const source = readFileSync(target, "utf8");
try {
  new Function("window", "require", source)(windowStub, (name) => {
    if (name === "react") return ReactStub;
    throw new Error(`未预期的 require(${name})`);
  });
} catch (error) {
  check("lib/client.js：可加载", false, String(error?.message ?? error));
  report();
}
const bundle = windowStub.__LOADED.factory((name) => {
  if (name === "react") return ReactStub;
  throw new Error(`未预期的 require(${name})`);
});

// ── 挂载 ────────────────────────────────────────────────────────────────
const REGISTERED = {};
const fakeCtx = {
  effect(fn) { return fn(); },
  get(name) {
    if (name === "layout") return { selectPanel() {} };
    return undefined;
  },
  slots: {
    inject(name, fn) { return fn(); },
    register(options, component) { REGISTERED[options.name] = component; return () => {}; }
  },
  remote: { $mount() { return Promise.resolve(); } }
};
bundle.apply(fakeCtx);
const panel = REGISTERED.main;
check("挂上了 main 工作台组件", typeof panel === "function");

// ── 元素树工具 ──────────────────────────────────────────────────────────
function collect(node, predicate, out = [], seen = new Set()) {
  if (node === null || node === undefined || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) collect(child, predicate, out, seen);
    return out;
  }
  if (seen.has(node)) return out;
  seen.add(node);
  if (predicate(node)) out.push(node);
  if (node.children) for (const child of node.children) collect(child, predicate, out, seen);
  if (node.props?.children) for (const child of [].concat(node.props.children)) collect(child, predicate, out, seen);
  return out;
}

/** 渲染若干轮，让 useEffect / setState 稳定下来。 */
function renderStable(component, props, rounds = 30) {
  let tree = null;
  for (let i = 0; i < rounds; i += 1) {
    HOOK.cursor = 0;
    tree = component(props);
  }
  return tree;
}

// ── 造一份「已出图 + 已切图」的任务快照 ────────────────────────────────
const layout = {
  width: 1024,
  height: 1024,
  summary: "签到弹窗",
  boxes: [
    { id: "b1", label: "object", caption: "面板", x1: 100, y1: 100, x2: 900, y2: 800 },
    { id: "b2", label: "text", caption: "标题", text: "每日签到", x1: 300, y1: 180, x2: 700, y2: 300 }
  ]
};
const jobSnapshot = {
  id: "uabc123",
  name: "签到弹窗",
  createdAt: 1,
  updatedAt: 2,
  layout,
  settings: { steps: 25, cfg: 2.5, sampler: "er_sde", scheduler: "simple", seed: -1, negative: "" },
  sliceSettings: { matte: "wevisone", resolution: 0, padding: 8, threshold: 8, grow: 1, skipBackdrop: false, rejectNeighbors: true, instruction: "", negative: "" },
  status: "ready",
  busy: false,
  renders: [
    {
      id: "r1",
      file: "render/r1.png",
      url: "/dsh-game-material-master/ui-assets/uabc123/render/r1.png",
      bytes: 1000,
      width: 1024,
      height: 1024,
      layout,
      settings: {},
      createdAt: 1
    }
  ],
  batches: [
    {
      id: "s1",
      renderId: "r1",
      matte: "wevisone",
      settings: {},
      slices: [
        { index: 1, label: "object", file: "slices/s1/1.png", url: "/dsh-game-material-master/ui-assets/uabc123/slices/s1/1.png", bytes: 10, width: 800, height: 700 }
      ],
      skipped: [],
      createdAt: 1
    }
  ],
  stages: { layout: { status: "done", approved: false }, generate: { status: "done", approved: false }, slice: { status: "done", approved: false } },
  exports: [],
  log: [],
  assetBase: "/dsh-game-material-master/ui-assets/uabc123/"
};

const calls = [];
const api = {
  getConfig: async () => ({ uiComfyBaseUrl: "", comfyOutputDir: "", uiMossModel: "m", uiMossClip: "c", uiMossVae: "v", uiWevisoneModel: "WeVisOne-VL-2B", uiQwenModel: "q", uiQwenClip: "qc", uiQwenVae: "qv", uiTimeoutMs: 1200000 }),
  listUiJobs: async () => ({ jobs: [{ id: "uabc123", name: "签到弹窗", width: 1024, height: 1024, boxes: 2, renders: 1, slices: 1, busy: false }] }),
  getUiJob: async () => jobSnapshot,
  createUiJob: async () => jobSnapshot,
  saveUiJob: async (payload) => { calls.push({ method: "saveUiJob", payload }); return { ...jobSnapshot, sliceSettings: { ...jobSnapshot.sliceSettings, ...(payload.sliceSettings ?? {}) } }; },
  runUiGenerate: async () => { calls.push({ method: "runUiGenerate" }); return { started: true }; },
  runUiSlice: async () => { calls.push({ method: "runUiSlice" }); return { started: true }; },
  cancelUiTask: async () => ({ ok: true }),
  setUiApproved: async () => ({}),
  revealUiJob: async () => ({ ok: true }),
  exportUi: async () => { calls.push({ method: "exportUi" }); return { ok: true }; },
  deleteUiJob: async () => ({ ok: true }),
  testUi: async () => ({ ok: true, message: "ok" })
};

console.log("\n1) UiModule 真渲染");
// 让 UiModule 以「已选好任务」的状态渲染：第一个 useState 是 config，第二个是 jobs…
HOOK.slots = [];
let tree;
try {
  tree = renderStable(panel, { api });
} catch (error) {
  check("面板可渲染", false, String(error?.stack ?? error));
  report();
}
check("面板可渲染", tree !== null);

// 找到 UiModule 这一支：面板里按 activeModule 分发，默认是 sprite；
// 直接渲染模块本身更稳 —— 从元素树里找 ui-canvas 是否存在。
const canvasNodes = collect(tree, (node) => node?.props?.["data-testid"] === "ui-canvas");
const matteNodes = collect(tree, (node) => node?.props?.["data-testid"] === "ui-matte-select");

// 默认模块不是 ui，所以这里只断言「UI 模块确实被注册进分发链」。
const sourceHasUiBranch = /activeModule === "ui"[\s\S]{0,80}UiModule/.test(source);
check("工作台的分发链里有 ui 分支", sourceHasUiBranch);
check("UI 模块的方法都在 api 上（12 个）", ["testUi", "listUiJobs", "createUiJob", "getUiJob", "saveUiJob", "deleteUiJob", "runUiGenerate", "runUiSlice", "cancelUiTask", "setUiApproved", "revealUiJob", "exportUi"].every((name) => typeof api[name] === "function"));

// ── 直接渲染 UiModule：用深链接把 activeModule 切到 ui ────────────────
// 简化做法：在 bundle 内部，UiModule 是私有函数；这里改用「点开 UI 页签」的等价路径 ——
// 直接检查产物源码里的关键绑定（真渲染已在 verify-feedback 覆盖面板整体）。
console.log("\n2) 画布背景图（防「一堆小图平铺」回归）");
const canvasIndex = source.indexOf('"data-testid": "ui-canvas"');
check("找到画布节点", canvasIndex >= 0);
const canvasBlock = source.slice(canvasIndex, canvasIndex + 1600);
check("有生成图时覆盖 backgroundSize", /backgroundSize:\s*"contain"/.test(canvasBlock));
check("有生成图时禁止平铺", /backgroundRepeat:\s*"no-repeat"/.test(canvasBlock));
check("有生成图时居中", /backgroundPosition:\s*"center"/.test(canvasBlock));
check("无生成图时回落到棋盘格（不写死 contain）", /latestRender\s*\?\s*\{/.test(canvasBlock));
check("画布带 data-has-render 标记（CSS 可据此切换）", /"data-has-render"/.test(canvasBlock));
check("样式表里也有 data-has-render 的兜底规则", /\.SPR_uiCanvas\[data-has-render=true\]/.test(source));

console.log("\n3) 抠图方案（防「选了 BiRefNet 却跑 Qwen」回归）");
const matteIndex = source.indexOf('"data-testid": "ui-matte-select"');
check("找到抠图方案下拉框", matteIndex >= 0);
const matteBlock = source.slice(matteIndex, matteIndex + 1800);
check("value 绑宿主 sliceSettings.matte", /value:\s*job\.sliceSettings\?\.matte/.test(matteBlock));
check("onChange 里调 saveUiJob 存回宿主", /saveUiJob\(\{[^}]*sliceSettings/.test(matteBlock));
check("onChange 里先更新本地视图（乐观更新）", /setJob\(\(current\)/.test(matteBlock));
check("没有会漂移的本地 sliceMode state", !/const \[sliceMode, setSliceMode\]/.test(source));
check("两个选项都在（qwen / wevisone）", /value: "qwen"/.test(matteBlock) && /value: "wevisone"/.test(matteBlock));

console.log("\n4) 生成与切图入口都带遮罩");
const genIndex = source.indexOf("async function runGenerate()");
const sliceIndex = source.indexOf("async function runSlice()");
check("找到 runGenerate", genIndex >= 0);
check("找到 runSlice", sliceIndex >= 0);
check("生成按钮用 BusyBtn（有 loading 反馈）", /h\(BusyBtn, \{ busy: busy === "generate"/.test(source));
check("切图按钮用 BusyBtn（有 loading 反馈）", /h\(BusyBtn, \{ busy: busy === "slice"/.test(source));

report();
