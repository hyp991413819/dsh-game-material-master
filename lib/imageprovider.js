/**
 * 生图后端的分发层。
 *
 * 插件支持两类生图后端（`config.imageProvider`）：
 *
 *   · `comfyui`（默认）—— 本机 / 自建 ComfyUI，走 `customimage.generateComfyImage`；
 *   · `toapis` —— ToAPIs 异步接口，走 `toapis.generateToapisImage`。
 *
 * 所有生图调用点（八方向图 / 图片生成 / 骨骼动画 / 地图地块）都只经过这里。
 * 这样「换生图后端」只改一处，各模块不必各判一次 provider —— 历史教训是
 * 这种「每处判一次」的分叉迟早会漏一处，而漏掉的那一处**不报错**，
 * 只是偷偷还在用另一家模型。
 *
 * ⚠️ 火山方舟（Ark）与 OpenAI / SD WebUI 两条协议已经**删除**。
 * 老配置里的 `imageProvider: "ark"` 会被 `normalizeConfig` 归一到 `comfyui`，
 * 这里不再有对应的分支。
 */
import { assertToapisReady, generateToapisImage } from "./toapis.js";
import { loadConfig } from "./config.js";
import { fetchComfyObjectInfo } from "./comfy.js";
import { CustomImageError, generateComfyImage } from "./customimage.js";
import { discoverWorkflowParams } from "./workflowparams.js";
import { pickWorkflow } from "./workflows.js";
export function isCustomProvider(config) {
    return config.imageProvider === "comfyui";
}
/**
 * 当前生图模型。
 *
 * ComfyUI 的模型由**工作流**决定（`CheckpointLoaderSimple.ckpt_name` 之类），
 * 没有一个全局的「模型名」——所以这里回的是「当前工作流的名字」，
 * 界面拿它当角标显示，比显示一个空字符串有用。
 */
export function imageModelOf(config) {
    if (config.imageProvider === "toapis")
        return config.toapisImageModel;
    return pickWorkflow(config.workflows, config.activeWorkflowId)?.name ?? "";
}
/** 当前输出尺寸。 */
export function imageSizeOf(config) {
    if (config.imageProvider === "toapis")
        return config.toapisImageSize;
    return config.customSize;
}
/** 当前水印开关。水印是 ToAPIs / 方舟系的参数，ComfyUI 一律不带。 */
export function imageWatermarkOf(config) {
    return false;
}
/** 当前请求超时。 */
export function imageTimeoutOf(config) {
    return config.imageProvider === "toapis" ? config.toapisTimeoutMs : config.customTimeoutMs;
}
/**
 * 「部件重绘」用的模型。
 *
 * ComfyUI 侧同样由工作流决定，所以跟主模型一致；
 * 需要不同的重绘参数就在工作流列表里另存一份、由调用方传 `workflowId`。
 */
export function imageRedrawModelOf(config) {
    return imageModelOf(config);
}
/** 所有后端都使用同一份全局输出尺寸（保留此函数是为了兼容旧调用方）。 */
export function imageUsesConfiguredSize(_config) {
    return true;
}
/** ComfyUI 后端的必填项检查（不看 `imageProvider`，供「测试连接」按钮用）。 */
export function customImageBlocker(config) {
    if (config.customBaseUrl.trim() === "") {
        return "尚未配置 ComfyUI 的地址（设置 → 游戏素材大师 → 生图后端 → ComfyUI）";
    }
    if (config.workflows.length === 0) {
        return "还没有任何工作流：在设置页里粘贴一份 ComfyUI 的「导出（API）」JSON";
    }
    return undefined;
}
/**
 * 当前后端「能不能开跑」。返回 undefined = 可以。
 *
 * 错误文案里必须写清**去哪里配**：两种后端的用户不是同一批人，
 * 只说「未配置」会让人在设置页里来回找。
 */
export function imageProviderBlocker(config) {
    if (config.imageProvider === "toapis") {
        try {
            assertToapisReady(config);
            return undefined;
        }
        catch (error) {
            return String(error.message);
        }
    }
    return customImageBlocker(config);
}
export function assertImageProviderReady(config) {
    const blocker = imageProviderBlocker(config);
    if (blocker !== undefined)
        throw new Error(blocker);
}
/** 一句话摘要（界面角标与工具面共用）。 */
export function imageProviderSummary(config) {
    if (config.imageProvider === "toapis")
        return `ToAPIs · ${config.toapisImageModel}`;
    const workflow = pickWorkflow(config.workflows, config.activeWorkflowId);
    // 工作流列表理论上永远非空（见 workflows.normalizeWorkflows），但这里是**读配置的
    // 每一条路径都会走到**的地方：夹具 / 老数据 / 半截配置都可能让它是空的，
    // 而崩溃发生在 decorateConfig 里 —— 整个设置页都打不开，比少一个名字严重得多。
    const name = workflow?.name ?? "（未配置工作流）";
    return `ComfyUI · ${config.customBaseUrl} · ${name}`;
}
/** 调一次生图，自动按当前后端分发。 */
export async function generateImageWithProvider(request, signal) {
    const config = await loadConfig();
    assertImageProviderReady(config);
    if (config.imageProvider === "toapis")
        return generateToapisImage(config, request, signal);
    const workflow = pickWorkflow(config.workflows, request.workflowId ?? config.activeWorkflowId);
    /**
     * 参数的类型要按**节点定义**判定，不能按工作流里的当前值 ——
     * 那些槽位往往还是 `"{{seed}}"` 这种字符串占位符，猜成字符串就会让
     * ComfyUI 的 int 输入报 type 错误。这里只在真的要传参数时才去查一次。
     */
    const paramKinds = request.params !== undefined && Object.keys(request.params).length > 0
        ? await paramKindsOf(config, workflow.json)
        : undefined;
    return generateComfyImage({
        baseUrl: config.customBaseUrl,
        apiKey: config.customApiKey,
        prompt: request.prompt,
        images: request.images,
        size: request.size,
        timeoutMs: request.timeoutMs ?? config.customTimeoutMs,
        negativePrompt: config.customNegativePrompt,
        steps: config.customSteps,
        cfgScale: config.customCfgScale,
        sampler: config.customSampler,
        denoising: config.customDenoising,
        seed: config.customSeed,
        workflow: workflow.json,
        params: request.params,
        paramKinds
    }, signal);
}
/**
 * 查一份工作流里各参数的类型（失败时返回 undefined，让下游按当前值猜）。
 *
 * 查不到不是错误：ComfyUI 没开的时候参数面板本来就退化成「按值推断」，
 * 这里保持一致 —— 生图本身会给出更有用的错误（连不上 / 工作流无效）。
 */
async function paramKindsOf(config, workflowJson) {
    try {
        const parsed = JSON.parse(workflowJson);
        const classTypes = Object.values(parsed)
            .map((node) => (typeof node?.class_type === "string" ? node.class_type : ""))
            .filter((item) => item !== "");
        if (classTypes.length === 0)
            return undefined;
        const info = await fetchComfyObjectInfo({ baseUrl: config.customBaseUrl, timeoutMs: 8000, cookies: config.comfyCookies }, classTypes);
        if (Object.keys(info).length === 0)
            return undefined;
        const params = discoverWorkflowParams(parsed, info);
        const kinds = {};
        for (const param of params)
            kinds[param.key] = param.kind;
        return kinds;
    }
    catch {
        return undefined;
    }
}
/**
 * 连通性自检：对 ComfyUI 真实生成一张小图。
 *
 * 只有真跑一次才能同时验证「地址对不对」和「工作流真的能出图」，看配置看不出来。
 */
export async function testCustomImage() {
    const config = await loadConfig();
    const blocker = customImageBlocker(config);
    if (blocker !== undefined)
        throw new Error(blocker);
    const workflow = pickWorkflow(config.workflows, config.activeWorkflowId);
    const result = await generateComfyImage({
        baseUrl: config.customBaseUrl,
        apiKey: config.customApiKey,
        prompt: "一张纯绿色背景的空白测试图，画面中只有一个居中的小圆点",
        images: [],
        size: config.customSize,
        timeoutMs: config.customTimeoutMs,
        negativePrompt: config.customNegativePrompt,
        steps: config.customSteps,
        cfgScale: config.customCfgScale,
        sampler: config.customSampler,
        denoising: config.customDenoising,
        // 测试图固定种子，便于对比两次测试的结果是否一致（排查缓存 / 没真跑的问题）。
        seed: 20261016,
        workflow: workflow.json
    });
    return {
        ok: true,
        provider: "ComfyUI",
        model: workflow.name,
        bytes: result.bytes.length,
        ext: result.ext
    };
}
export { CustomImageError };
