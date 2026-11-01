/**
 * ComfyUI 生图后端自检（纯本地、零计费）。
 *
 * 插件现在只保留 **ComfyUI** 一种生图协议（火山方舟 / OpenAI / SD WebUI 都已删除），
 * 所以这里只覆盖 ComfyUI：起一台本地假服务端，把「提交 → 轮询 → 取图」整条链路
 * 以及**工作流参数的发现与应用**都跑一遍。
 *
 * 断言的重点不是「有没有返回字节」，而是**请求真的长对了**：
 *   · 端点与顺序（上传参考图 → /prompt → /history → /view）；
 *   · 占位符按 JSON 类型替换（`{{width}}` 必须是数字）；
 *   · 参数面板改的值**赢过**占位符与工作流里的默认值；
 *   · 多工作流：切 id 真的换了工作流。
 */
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = await mkdtemp(join(tmpdir(), "gmm-comfy-image-"));
process.env.DSH_HOME = HOME;
await mkdir(join(HOME, "game-material-master"), { recursive: true });

const { generateComfyImage, parseSizeSpec } = await import("../lib/customimage.js");
const { generateImageWithProvider, imageBackendOf, imageModelOf, imageSizeOf, imageProviderBlocker, imageProviderSummary, testCustomImage } = await import("../lib/imageprovider.js");
const { loadConfig, saveConfig, normalizeConfig } = await import("../lib/config.js");
const { discoverWorkflowParams, applyWorkflowParams } = await import("../lib/workflowparams.js");
const { normalizeWorkflows, pickWorkflow, addWorkflow, updateWorkflow, removeWorkflow, isWorkflowJson } = await import("../lib/workflows.js");
const { encodePng } = await import("../lib/png.js");

const failures = [];
let checks = 0;
function check(name, ok, detail = "") {
  checks += 1;
  if (ok) {
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ✗ ${name}${detail === "" ? "" : ` — ${detail}`}`);
  }
}
function section(title) {
  console.log(`\n${title}`);
}

const PNG = encodePng(Buffer.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]), 2, 2);
const REF_PNG = encodePng(Buffer.alloc(4 * 4 * 4, 200), 4, 4);
const REF_DATA_URI = `data:image/png;base64,${REF_PNG.toString("base64")}`;

// ── 假 ComfyUI ─────────────────────────────────────────────────────────
const received = [];
let comfyHistoryCalls = 0;
let comfySubmitError = null;
let comfyExecError = null;

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const body = await readBody(req);
  received.push({
    method: req.method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    contentType: req.headers["content-type"] ?? "",
    authorization: req.headers.authorization ?? "",
    body
  });
  const json = (payload, status = 200) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  };

  if (url.pathname.endsWith("/upload/image")) return json({ name: "gmm-uploaded.png", subfolder: "sub", type: "input" });
  if (url.pathname.endsWith("/prompt")) {
    if (comfySubmitError !== null) return json({ error: { message: comfySubmitError } }, 400);
    return json({ prompt_id: "pid-1", number: 1, node_errors: {} });
  }
  if (url.pathname.includes("/history/")) {
    comfyHistoryCalls += 1;
    // 第一次故意空：真实 ComfyUI 也是这样，先有条目、后面才有 outputs。
    if (comfyHistoryCalls === 1) return json({});
    if (comfyExecError !== null) {
      return json({ "pid-1": { status: { status_str: "error", messages: [["execution_error", { node_type: "KSampler", exception_message: comfyExecError }]] }, outputs: {} } });
    }
    return json({
      "pid-1": {
        status: { completed: true, status_str: "success" },
        outputs: { "9": { images: [{ filename: "ComfyUI_00001_.png", subfolder: "", type: "output" }] } }
      }
    });
  }
  if (url.pathname.endsWith("/view")) {
    res.writeHead(200, { "Content-Type": "image/png" });
    return res.end(PNG);
  }
  // 节点定义：给 /object_info 用的最小实现（参数发现要靠它拿真实类型）。
  if (url.pathname.startsWith("/object_info/")) {
    const classType = decodeURIComponent(url.pathname.slice("/object_info/".length));
    const specs = {
      KSampler: {
        input: {
          required: {
            seed: ["INT", { min: 0, max: 4294967295, default: 0 }],
            steps: ["INT", { min: 1, max: 200, default: 20 }],
            cfg: ["FLOAT", { min: 0, max: 30, default: 7 }],
            sampler_name: [["euler", "ddim", "dpmpp_2m"], {}],
            scheduler: [["normal", "karras"], {}]
          }
        }
      },
      EmptyLatentImage: { input: { required: { width: ["INT", { min: 16, max: 8192 }], height: ["INT", { min: 16, max: 8192 }] } } },
      CLIPTextEncode: { input: { required: { text: ["STRING", { multiline: true }] } } },
      LoadImage: { input: { required: { image: [["a.png", "b.png"], {}] } } }
    };
    return json(specs[classType] === undefined ? {} : { [classType]: specs[classType] });
  }
  return json({ error: { message: `unexpected path ${url.pathname}` } }, 404);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const PORT = server.address().port;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const pathHits = (fragment) => received.filter((entry) => entry.path.includes(fragment));
const jsonOf = (entry) => JSON.parse(entry.body.toString("utf8"));

const WORKFLOW = JSON.stringify({
  "3": { class_type: "KSampler", inputs: { seed: "{{seed}}", steps: "{{steps}}", cfg: "{{cfg}}", sampler_name: "{{sampler}}", scheduler: "normal", denoise: 1, model: ["4", 0], positive: ["6", 0], negative: ["7", 0], latent_image: ["5", 0] } },
  "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd_xl_base_1.0.safetensors" } },
  "5": { class_type: "EmptyLatentImage", inputs: { width: "{{width}}", height: "{{height}}", batch_size: 1 } },
  "6": { class_type: "CLIPTextEncode", inputs: { text: "{{prompt}}", clip: ["4", 1] } },
  "7": { class_type: "CLIPTextEncode", inputs: { text: "{{negative_prompt}}", clip: ["4", 1] } },
  "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } },
  "9": { class_type: "SaveImage", inputs: { filename_prefix: "gmm", images: ["8", 0] } }
});

// ── 1. 尺寸解析 ────────────────────────────────────────────────────────
section("1) 尺寸写法");
check("1024x1024", JSON.stringify(parseSizeSpec("1024x1024")) === JSON.stringify({ width: 1024, height: 1024 }));
check("全角 ×", JSON.stringify(parseSizeSpec("800×600")) === JSON.stringify({ width: 800, height: 600 }));
check("2K → 2048 见方", JSON.stringify(parseSizeSpec("2K")) === JSON.stringify({ width: 2048, height: 2048 }));
check("认不出来返回 undefined（交给工作流自己的值）", parseSizeSpec("huge") === undefined);
check("空串返回 undefined", parseSizeSpec("") === undefined);

// ── 2. 一次完整调用 ────────────────────────────────────────────────────
section("2) 提交 → 轮询 → 取图");
received.length = 0;
comfyHistoryCalls = 0;
const result = await generateComfyImage({
  baseUrl: ORIGIN,
  apiKey: "",
  prompt: "一只戴帽子的猫",
  images: [],
  size: "1024x768",
  timeoutMs: 30000,
  negativePrompt: "模糊",
  steps: 25,
  cfgScale: 6.5,
  sampler: "euler",
  denoising: 0.8,
  seed: 12345,
  workflow: WORKFLOW
});
check("拿到图片字节", result.bytes.length > 0 && result.ext === "png", `${result.bytes.length} 字节 / ${result.ext}`);
check("先提交 /prompt", pathHits("/prompt").length === 1);
check("再轮询 /history", pathHits("/history/").length >= 2, `${pathHits("/history/").length} 次`);
check("最后取 /view", pathHits("/view").length === 1);
check("没有打任何 OpenAI 端点", pathHits("/images/").length === 0);
check("没有打任何 SD WebUI 端点", pathHits("/sdapi/").length === 0);

const submitted = jsonOf(pathHits("/prompt")[0]);
const wf = submitted.prompt;
check("占位符 {{width}} 被替换成**数字**", wf["5"].inputs.width === 1024, JSON.stringify(wf["5"].inputs.width));
check("占位符 {{height}} 被替换成数字", wf["5"].inputs.height === 768);
check("{{seed}} 是数字", wf["3"].inputs.seed === 12345);
check("{{steps}} 是数字", wf["3"].inputs.steps === 25);
check("{{cfg}} 是浮点数", wf["3"].inputs.cfg === 6.5);
check("{{sampler}} 写进 sampler_name", wf["3"].inputs.sampler_name === "euler");
check("提示词写进正向编码", wf["6"].inputs.text === "一只戴帽子的猫");
check("负面提示词写进负向编码", wf["7"].inputs.text === "模糊");
check("连线没被破坏（model 仍是 [\"4\",0]）", JSON.stringify(wf["3"].inputs.model) === JSON.stringify(["4", 0]));
check("提交体带 client_id", typeof submitted.client_id === "string" && submitted.client_id.startsWith("gmm-"));

// ── 3. 参考图 ──────────────────────────────────────────────────────────
section("3) 带参考图");
received.length = 0;
comfyHistoryCalls = 0;
await generateComfyImage({
  baseUrl: ORIGIN,
  apiKey: "",
  prompt: "改成戴红帽子",
  images: [REF_DATA_URI],
  size: "1024x1024",
  timeoutMs: 30000,
  negativePrompt: "",
  steps: 20,
  cfgScale: 7,
  sampler: "euler",
  denoising: 0.65,
  seed: 1,
  workflow: WORKFLOW
});
check("参考图先上传到 /upload/image", pathHits("/upload/image").length === 1);
check("上传是 multipart", pathHits("/upload/image")[0].contentType.includes("multipart/form-data"));
const withRef = jsonOf(pathHits("/prompt")[0]).prompt;
// 这份工作流里**没有** LoadImage，也没有 {{image}}，所以文件名无处可写 ——
// 这本身是合法用法（纯文生图的工作流被当成图生图跑）。真正的接线在下面单独测。
check("没有 LoadImage 时不会凭空插节点", JSON.stringify(withRef).includes("gmm-uploaded.png") === false);
{
  // 带 LoadImage 的工作流：没写 {{image}} 也要把上传后的文件名写进去。
  received.length = 0;
  comfyHistoryCalls = 0;
  const withLoadImage = JSON.stringify({
    "3": { class_type: "KSampler", inputs: { seed: 1, steps: 20, cfg: 7, sampler_name: "euler", denoise: 0.65, model: ["4", 0], positive: ["6", 0], negative: ["7", 0], latent_image: ["5", 0] } },
    "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "x.safetensors" } },
    "5": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: "x", clip: ["4", 1] } },
    "7": { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["4", 1] } },
    "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } },
    "10": { class_type: "LoadImage", inputs: { image: "" } },
    "9": { class_type: "SaveImage", inputs: { filename_prefix: "gmm", images: ["8", 0] } }
  });
  await generateComfyImage({
    baseUrl: ORIGIN, apiKey: "", prompt: "改成戴红帽子", images: [REF_DATA_URI], size: "1024x1024",
    timeoutMs: 30000, negativePrompt: "", steps: 20, cfgScale: 7, sampler: "euler", denoising: 0.65, seed: 1,
    workflow: withLoadImage
  });
  const patched = jsonOf(pathHits("/prompt")[0]).prompt;
  check("没写 {{image}} 时自动改 LoadImage 的文件名", patched["10"].inputs.image === "sub/gmm-uploaded.png", JSON.stringify(patched["10"].inputs));
}

// ── 4. 参数面板：发现与应用 ────────────────────────────────────────────
section("4) 工作流参数");
const { fetchComfyObjectInfo } = await import("../lib/comfy.js");
const info = await fetchComfyObjectInfo({ baseUrl: ORIGIN, timeoutMs: 5000, cookies: "" }, ["KSampler", "EmptyLatentImage", "CLIPTextEncode", "CheckpointLoaderSimple"]);
check("读到了节点定义", Object.keys(info).length >= 3, Object.keys(info).join(","));
const parsedWorkflow = JSON.parse(WORKFLOW);
const params = discoverWorkflowParams(parsedWorkflow, info);
check("发现了参数", params.length > 0, `${params.length} 个`);
const byKey = (key) => params.find((param) => param.key === key);
check("seed 是数字控件", byKey("3.seed")?.kind === "int");
check("seed 带取值范围", byKey("3.seed")?.min === 0 && byKey("3.seed")?.max === 4294967295);
check("cfg 是浮点控件", byKey("3.cfg")?.kind === "float");
check("sampler_name 是下拉框", byKey("3.sampler_name")?.kind === "enum");
check("下拉框候选值来自节点定义", JSON.stringify(byKey("3.sampler_name")?.options) === JSON.stringify(["euler", "ddim", "dpmpp_2m"]));
check("提示词是多行文本", byKey("6.text")?.kind === "text" && byKey("6.text")?.multiline === true);
check("连线槽不出现在参数里", params.every((param) => !Array.isArray(parsedWorkflow[param.nodeId]?.inputs?.[param.input])));
check("ckpt_name 也在参数里（换模型不用改 JSON）", byKey("4.ckpt_name") !== undefined);

// 应用：类型必须跟着**节点定义**走（工作流里那些槽位还是 "{{seed}}" 字符串）
const applied = applyWorkflowParams(parsedWorkflow, { "3.seed": "999", "3.cfg": 3.5, "3.sampler_name": "ddim" }, params);
check("字符串数字写回 int 槽时转成数字", applied["3"].inputs.seed === 999, JSON.stringify(applied["3"].inputs.seed));
check("浮点按浮点写回", applied["3"].inputs.cfg === 3.5);
check("枚举按字符串写回", applied["3"].inputs.sampler_name === "ddim");
check("没改的键保持原样", applied["5"].inputs.width === "{{width}}");
check("不改动入参（纯函数）", parsedWorkflow["3"].inputs.seed === "{{seed}}");
// 没给声明时退回按当前值：字符串占位符会被写成字符串 —— 这正是为什么必须传 declared。
const naive = applyWorkflowParams(parsedWorkflow, { "3.seed": "999" });
check("没有声明时退回按当前值（这条记录了为什么必须传 declared）", naive["3"].inputs.seed === "999");

// ── 4b. 没写 {{prompt}} 时的兜底（顺拓扑找文本节点）────────────────────
section("4b) 提示词兜底");
{
  /**
   * 真实场景：用户从 ComfyUI 导出的工作流里，提示词是**写死的字符串**
   * （他试跑时填的那句），一个占位符都没有。以前插件只替换占位符、不碰写死的值，
   * 于是任务面板上填的提示词**完全不生效**、每次出同一张图、不报任何错。
   */
  const hardcoded = JSON.stringify({
    "13": { class_type: "ResolutionSelector", inputs: { aspect_ratio: "16:9", megapixels: 1 } },
    "452": { class_type: "TextEncodeQwenImage21", inputs: { prompt: "一棵孤独的树", negative_prompt: "", resolution: 1024, clip: ["453", 0] } },
    "453": { class_type: "CLIPLoader", inputs: { clip_name: "qwen3vl.safetensors", type: "qwen_image" } },
    "456": { class_type: "EmptyLatentImage", inputs: { width: ["13", 0], height: ["13", 1], batch_size: 1 } },
    "458": { class_type: "KSampler", inputs: { seed: 1, steps: 8, cfg: 1, sampler_name: "euler", denoise: 1, model: ["474", 0], positive: ["452", 0], negative: ["452", 1], latent_image: ["456", 0] } },
    "474": { class_type: "UNETLoader", inputs: { unet_name: "qwen.safetensors" } },
    "461": { class_type: "SaveImage", inputs: { filename_prefix: "x", images: ["458", 0] } }
  });

  received.length = 0;
  comfyHistoryCalls = 0;
  const fallback = await generateComfyImage({
    baseUrl: ORIGIN, apiKey: "", prompt: "赛璐璐风格的森林小径", images: [], size: "1024x1024",
    timeoutMs: 30000, negativePrompt: "", steps: 8, cfgScale: 1, sampler: "euler", denoising: 1, seed: 1,
    workflow: hardcoded
  });
  const sent = jsonOf(pathHits("/prompt")[0]).prompt;
  check(
    "没有 {{prompt}} 时顺着采样器 positive 把写死的提示词换掉",
    sent["452"].inputs.prompt === "赛璐璐风格的森林小径",
    JSON.stringify(sent["452"].inputs.prompt)
  );
  check("正负向接在同一节点时不会把负面提示词写进去（否则会覆盖正向）", sent["452"].inputs.negative_prompt === "");
  check("兜底成功时不产生告警", (fallback.warnings ?? []).length === 0, JSON.stringify(fallback.warnings));

  // 找不到采样器 / 文本节点：**必须告警**，不能静默出图。
  received.length = 0;
  comfyHistoryCalls = 0;
  const orphan = await generateComfyImage({
    baseUrl: ORIGIN, apiKey: "", prompt: "任意提示词", images: [], size: "1024x1024",
    timeoutMs: 30000, negativePrompt: "", steps: 8, cfgScale: 1, sampler: "euler", denoising: 1, seed: 1,
    workflow: JSON.stringify({ "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "x.safetensors" } } })
  });
  check(
    "找不到可写的文本节点时给出告警（不静默）",
    (orphan.warnings ?? []).some((text) => text.includes("没有生效")),
    JSON.stringify(orphan.warnings)
  );

  // 正负向分别接两个节点：两条都写。
  received.length = 0;
  comfyHistoryCalls = 0;
  const split = JSON.stringify({
    "6": { class_type: "CLIPTextEncode", inputs: { text: "写死的正向", clip: ["4", 1] } },
    "7": { class_type: "CLIPTextEncode", inputs: { text: "写死的负向", clip: ["4", 1] } },
    "3": { class_type: "KSampler", inputs: { seed: 1, steps: 8, cfg: 1, sampler_name: "euler", denoise: 1, model: ["4", 0], positive: ["6", 0], negative: ["7", 0], latent_image: ["5", 0] } },
    "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "x.safetensors" } },
    "5": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
    "9": { class_type: "SaveImage", inputs: { filename_prefix: "x", images: ["3", 0] } }
  });
  await generateComfyImage({
    baseUrl: ORIGIN, apiKey: "", prompt: "正向提示词", images: [], size: "1024x1024",
    timeoutMs: 30000, negativePrompt: "负向提示词", steps: 8, cfgScale: 1, sampler: "euler", denoising: 1, seed: 1,
    workflow: split
  });
  const splitSent = jsonOf(pathHits("/prompt")[0]).prompt;
  check("正负向分开接时两条都写", splitSent["6"].inputs.text === "正向提示词" && splitSent["7"].inputs.text === "负向提示词",
    `${splitSent["6"].inputs.text} / ${splitSent["7"].inputs.text}`);

  // 模型文件名不能被当成提示词改掉。
  check(
    "只改提示词类输入，不碰 ckpt_name / unet_name",
    splitSent["4"].inputs.ckpt_name === "x.safetensors" && sent["474"].inputs.unet_name === "qwen.safetensors"
  );

  /**
   * 图片模块的 ComfyUI 页签不再提供提示词输入框（只走工作流 API）：
   * 这时候提示词是空串，**不该写工作流、也不该告警** —— 图照样按工作流里写的出。
   */
  received.length = 0;
  comfyHistoryCalls = 0;
  const noPrompt = await generateComfyImage({
    baseUrl: ORIGIN, apiKey: "", prompt: "", images: [], size: "1024x1024",
    timeoutMs: 30000, negativePrompt: "", steps: 8, cfgScale: 1, sampler: "euler", denoising: 1, seed: 1,
    workflow: hardcoded
  });
  const noPromptSent = jsonOf(pathHits("/prompt")[0]).prompt;
  check("没填提示词时不动工作流里写死的提示词", noPromptSent["452"].inputs.prompt === "一棵孤独的树", JSON.stringify(noPromptSent["452"].inputs.prompt));
  check("没填提示词时不产生「提示词没生效」告警", (noPrompt.warnings ?? []).length === 0, JSON.stringify(noPrompt.warnings));
}

// ── 5. 参数优先级：面板 > 占位符 > 工作流默认 ─────────────────────────
section("5) 参数面板的值要赢过占位符");
received.length = 0;
comfyHistoryCalls = 0;
await generateComfyImage({
  baseUrl: ORIGIN,
  apiKey: "",
  prompt: "测试",
  images: [],
  size: "1024x1024",
  timeoutMs: 30000,
  negativePrompt: "",
  steps: 20,
  cfgScale: 7,
  sampler: "euler",
  denoising: 0.65,
  seed: 1,
  workflow: WORKFLOW,
  params: { "3.steps": 42, "3.sampler_name": "ddim" }
});
const overridden = jsonOf(pathHits("/prompt")[0]).prompt;
check("参数面板改的 steps 生效（压过 {{steps}}）", overridden["3"].inputs.steps === 42, String(overridden["3"].inputs.steps));
check("参数面板改的 sampler 生效", overridden["3"].inputs.sampler_name === "ddim");
check("没在面板里改的仍走占位符", overridden["3"].inputs.cfg === 7);

// ── 6. 失败路径 ────────────────────────────────────────────────────────
section("6) 失败路径");
received.length = 0;
comfySubmitError = "KSampler: invalid seed";
let submitError = null;
try {
  await generateComfyImage({ baseUrl: ORIGIN, apiKey: "", prompt: "x", images: [], size: "1024x1024", timeoutMs: 30000, negativePrompt: "", steps: 20, cfgScale: 7, sampler: "euler", denoising: 0.65, seed: 1, workflow: WORKFLOW });
} catch (error) {
  submitError = error;
}
check("提交被拒时抛错并带上服务端的原话", submitError !== null && String(submitError.message).includes("invalid seed"), String(submitError?.message));
comfySubmitError = null;

received.length = 0;
comfyHistoryCalls = 0;
comfyExecError = "CUDA out of memory";
let execError = null;
try {
  await generateComfyImage({ baseUrl: ORIGIN, apiKey: "", prompt: "x", images: [], size: "1024x1024", timeoutMs: 30000, negativePrompt: "", steps: 20, cfgScale: 7, sampler: "euler", denoising: 0.65, seed: 1, workflow: WORKFLOW });
} catch (error) {
  execError = error;
}
check("执行失败时带上节点名与异常", execError !== null && String(execError.message).includes("KSampler") && String(execError.message).includes("out of memory"), String(execError?.message));
comfyExecError = null;

let emptyError = null;
try {
  await generateComfyImage({ baseUrl: ORIGIN, apiKey: "", prompt: "x", images: [], size: "1024x1024", timeoutMs: 30000, negativePrompt: "", steps: 20, cfgScale: 7, sampler: "euler", denoising: 0.65, seed: 1, workflow: "" });
} catch (error) {
  emptyError = error;
}
check("没工作流时给出可操作的说明", emptyError !== null && String(emptyError.message).includes("工作流"), String(emptyError?.message));

let badJsonError = null;
try {
  await generateComfyImage({ baseUrl: ORIGIN, apiKey: "", prompt: "x", images: [], size: "1024x1024", timeoutMs: 30000, negativePrompt: "", steps: 20, cfgScale: 7, sampler: "euler", denoising: 0.65, seed: 1, workflow: "not json" });
} catch (error) {
  badJsonError = error;
}
check("工作流不是合法 JSON 时报解析失败", badJsonError !== null && String(badJsonError.message).includes("解析失败"), String(badJsonError?.message));

// ── 7. 多工作流 ────────────────────────────────────────────────────────
section("7) 多工作流");
const w1 = { id: "wa", name: "文生图", json: '{"1":{}}' };
const w2 = { id: "wb", name: "带参考图", json: '{"2":{}}' };
check("pickWorkflow 按 id 命中", pickWorkflow([w1, w2], "wb").name === "带参考图");
check("pickWorkflow 的 id 失效时落到第一份", pickWorkflow([w1, w2], "nope").id === "wa");
check("pickWorkflow 对空数组也不抛（上层靠 blocker 提示）", pickWorkflow([], "x").id === "");
const added = addWorkflow([w1], { name: "第三份", json: '{"3":{}}' });
check("addWorkflow 追加一份", added.workflows.length === 2 && added.workflows[1].name === "第三份");
const renamed = updateWorkflow(added.workflows, added.id, { name: "改过名" });
check("updateWorkflow 改名字", renamed.workflows[1].name === "改过名");
const badUpdate = updateWorkflow(added.workflows, added.id, { json: "not json" });
check("updateWorkflow 拒绝非法 JSON 并给出原因", badUpdate.error !== undefined && badUpdate.workflows[1].json === '{"3":{}}');
const removed = removeWorkflow([w1], "wa", '{"fallback":{}}');
check("删到一份不剩时补回一份", removed.workflows.length === 1 && removed.workflows[0].json === '{"fallback":{}}');
check("补回时 activeId 指向新的那份", removed.activeId === removed.workflows[0].id);
check("normalizeWorkflows 丢掉非法 JSON", normalizeWorkflows([{ id: "a", name: "x", json: "nope" }], '{"1":{}}').length === 1);
check("normalizeWorkflows 修掉重复 id", (() => {
  const list = normalizeWorkflows([{ id: "dup", name: "a", json: '{"1":{}}' }, { id: "dup", name: "b", json: '{"2":{}}' }], '{"1":{}}');
  return list.length === 2 && list[0].id !== list[1].id;
})());
check("isWorkflowJson 认数组为非法", isWorkflowJson("[]") === false);
check("isWorkflowJson 认空对象为非法", isWorkflowJson("{}") === false);

// ── 8. 配置层：默认值 / 阻塞 / 分发 ────────────────────────────────────
section("8) 配置与分发");
const defaults = normalizeConfig({});
check("默认后端是 ComfyUI", defaults.imageProvider === "comfyui", String(defaults.imageProvider));
check("默认带一份工作流", defaults.workflows.length === 1);
check("默认 activeWorkflowId 指向它", defaults.activeWorkflowId === defaults.workflows[0].id);
check("老配置的 ark 被归一到 comfyui", normalizeConfig({ imageProvider: "ark" }).imageProvider === "comfyui");
check("老配置的 custom 被归一到 comfyui", normalizeConfig({ imageProvider: "custom" }).imageProvider === "comfyui");
check("老配置的 customWorkflow 被迁移成列表里的一份", (() => {
  const migrated = normalizeConfig({ customWorkflow: '{"legacy":{}}' });
  return migrated.workflows.some((entry) => entry.json.includes("legacy"));
})());
check("ToAPIs 仍然保留", normalizeConfig({ imageProvider: "toapis" }).imageProvider === "toapis");

await saveConfig({ imageProvider: "comfyui", customBaseUrl: ORIGIN, workflows: [{ id: "wx", name: "自检工作流", json: WORKFLOW }], activeWorkflowId: "wx" });
const config = await loadConfig();
check("摘要写明后端与工作流名", imageProviderSummary(config).includes("ComfyUI") && imageProviderSummary(config).includes("自检工作流"), imageProviderSummary(config));
check("地址齐了就判定可开跑", imageProviderBlocker(config) === undefined, String(imageProviderBlocker(config)));

received.length = 0;
comfyHistoryCalls = 0;
const dispatched = await generateImageWithProvider({ prompt: "分发测试", images: [], size: "1024x1024", watermark: false });
check("分发层真的走了 ComfyUI", dispatched.bytes.length > 0 && pathHits("/prompt").length === 1);
const dispatchBody = jsonOf(pathHits("/prompt")[0]).prompt;
check("分发层用的是配置里那份工作流", dispatchBody["3"] !== undefined && dispatchBody["9"] !== undefined);
check("分发层把提示词带上了", dispatchBody["6"].inputs.text === "分发测试");

received.length = 0;
comfyHistoryCalls = 0;
const testResult = await testCustomImage();
check("测试连接返回工作流名与字节数", testResult.model === "自检工作流" && testResult.bytes > 0, JSON.stringify(testResult));

// ── 9. 任务级后端覆盖（页签）────────────────────────────────────────────
section("9) 任务级后端覆盖");
{
  const cfg = await loadConfig();
  check("不传 backend 时跟随全局", imageBackendOf(cfg, undefined) === cfg.imageProvider, String(imageBackendOf(cfg, undefined)));
  check("传 toapis 时覆盖全局", imageBackendOf(cfg, "toapis") === "toapis");
  check("传 comfyui 时覆盖全局", imageBackendOf({ ...cfg, imageProvider: "toapis" }, "comfyui") === "comfyui");
  check("非法 backend 值回落到全局", imageBackendOf({ ...cfg, imageProvider: "toapis" }, "nope") === "toapis");

  // 模型 / 尺寸都按**实际会用的那个后端**算，而不是全局。
  check("模型按后端分派（comfyui → 工作流名）", imageModelOf(cfg, "comfyui") === "自检工作流", imageModelOf(cfg, "comfyui"));
  check("模型按后端分派（toapis → ToAPIs 模型）", imageModelOf(cfg, "toapis") === cfg.toapisImageModel, imageModelOf(cfg, "toapis"));
  check("尺寸按后端分派（comfyui → customSize）", imageSizeOf(cfg, "comfyui") === cfg.customSize);
  check("尺寸按后端分派（toapis → toapisImageSize）", imageSizeOf(cfg, "toapis") === cfg.toapisImageSize);

  // 阻塞判断：全局 comfyui 就绪时，任务选 toapis 仍要按 toapis 判。
  await saveConfig({ toapisApiKey: "" });
  const noKey = await loadConfig();
  check(
    "ComfyUI 就绪不影响 ToAPIs 的阻塞判断",
    imageProviderBlocker(noKey, "comfyui") === undefined && imageProviderBlocker(noKey, "toapis") !== undefined,
    `comfyui=${imageProviderBlocker(noKey, "comfyui")} toapis=${imageProviderBlocker(noKey, "toapis")}`
  );
  await saveConfig({ toapisApiKey: "tk" });
}

/**
 * ToAPIs 的任务级覆盖必须**真的写进请求体**。
 *
 * 只测 `imageBackendOf` 这类纯函数不够 —— 覆盖值是经 `generateImageWithProvider`
 * 合并进 config 再交给 `generateToapisImage` 的，中间任何一处漏了都表现为
 * 「任务上填了模型，请求里还是全局那个」，而这**不报任何错**。
 */
section("9b) ToAPIs 任务级参数真的进了请求");
{
  let captured = null;
  const toapisServer = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const json = (payload) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (req.method === "POST" && url.pathname.endsWith("/images/generations")) {
      captured = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      return json({ id: "t1", status: "completed", result: { data: [{ url: `http://127.0.0.1:${toapisPort}/out.png` }] } });
    }
    if (url.pathname === "/out.png") {
      res.writeHead(200, { "Content-Type": "image/png" });
      return res.end(PNG);
    }
    if (url.pathname.includes("/images/generations/")) {
      return json({ id: "t1", status: "completed", result: { data: [{ url: `http://127.0.0.1:${toapisPort}/out.png` }] } });
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end("{}");
  });
  await new Promise((resolve) => toapisServer.listen(0, "127.0.0.1", resolve));
  const toapisPort = toapisServer.address().port;

  await saveConfig({
    toapisBaseUrl: `http://127.0.0.1:${toapisPort}/v1`,
    toapisApiKey: "tk",
    toapisImageModel: "gpt-image-2-vip",
    toapisImageQuality: "low",
    toapisImageBackground: "auto",
    toapisTimeoutMs: 15000
  });

  try {
    await generateImageWithProvider({
      prompt: "p", images: [], size: "1K", watermark: false,
      backend: "toapis", toapisModel: "gpt-image-2", toapisQuality: "high", toapisBackground: "transparent"
    });
    check("任务级 ToAPIs 模型写进请求体", captured?.model === "gpt-image-2", String(captured?.model));
    check("任务级 ToAPIs 质量写进请求体", captured?.quality === "high", String(captured?.quality));
    check("任务级 ToAPIs 背景写进请求体", captured?.background === "transparent", String(captured?.background));

    captured = null;
    await generateImageWithProvider({ prompt: "p", images: [], size: "1K", watermark: false, backend: "toapis" });
    check("不填时回落到全局模型", captured?.model === "gpt-image-2-vip", String(captured?.model));
    check("不填时回落到全局质量", captured?.quality === "low", String(captured?.quality));
    check("全局背景是 auto 时不发 background 字段", captured?.background === undefined, String(captured?.background));
  } catch (error) {
    check("ToAPIs 覆盖验证没有抛错", false, String(error?.message));
  }
  await new Promise((resolve) => toapisServer.close(resolve));
  // 把全局后端改回去，免得影响后面的断言。
  await saveConfig({ imageProvider: "comfyui", customBaseUrl: ORIGIN });
}

await saveConfig({ customBaseUrl: "" });
check("地址空时阻塞说明点名去哪配", /设置/.test(String(imageProviderBlocker(await loadConfig()))), String(imageProviderBlocker(await loadConfig())));
await saveConfig({ customBaseUrl: ORIGIN });

await rm(HOME, { recursive: true, force: true });
await new Promise((resolve) => server.close(resolve));

console.log(`\n共 ${checks} 项检查，失败 ${failures.length} 项。`);
if (failures.length > 0) {
  console.log(failures.map((name) => `  ✗ ${name}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log("ComfyUI 生图后端自检全部通过。");
}
