/**
 * ComfyUI 生图后端。
 *
 * 只保留 ComfyUI 一种协议：提交 → 轮询 `/history` → `GET /view` 取回图片字节。
 *
 * 这里**只负责一次调用**，不做重试、不碰落盘：重试与产物管理在各自的模块里。
 */
import { sniffExt } from "./ark.js";
import { applyWorkflowParams } from "./workflowparams.js";
export class CustomImageError extends Error {
    status;
    constructor(message, status) {
        super(message);
        this.name = "CustomImageError";
        this.status = status;
    }
}
/** 拼端点：容忍用户把末尾斜杠写多了。 */
function joinUrl(baseUrl, path) {
    return `${baseUrl.replace(/\/+$/, "")}${path}`;
}
/** 鉴权头：本地服务通常不需要；云端 / 反代用 Bearer Token。 */
function authHeaders(apiKey) {
    const key = apiKey.trim();
    if (key === "")
        return {};
    if (key.includes(":")) {
        return { Authorization: `Basic ${Buffer.from(key, "utf8").toString("base64")}` };
    }
    return { Authorization: `Bearer ${key}` };
}
function makeSignalContext(timeoutMs, signal) {
    const timeout = AbortSignal.timeout(Math.max(10000, timeoutMs));
    return {
        timeoutMs,
        signal,
        timeout,
        composed: signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    };
}
/** 统一的网络错误翻译：超时 / 主动取消 / 连不上，三种要给用户完全不同的提示。 */
function networkError(context, error) {
    if (context.timeout.aborted) {
        return new CustomImageError(`ComfyUI 请求超时（${Math.round(context.timeoutMs / 1000)} 秒）`);
    }
    if (context.signal?.aborted === true)
        return new CustomImageError("ComfyUI 请求已被取消");
    return new CustomImageError(`无法连接 ComfyUI：${error instanceof Error ? error.message : String(error)}`);
}
async function fetchOrThrow(url, init, context) {
    try {
        return await fetch(url, { ...init, signal: context.composed });
    }
    catch (error) {
        throw networkError(context, error);
    }
}
/** 读错误体：能捞到一句人话就够。 */
async function errorMessageOf(response) {
    const text = await response.text().catch(() => "");
    if (text.trim() === "")
        return `HTTP ${response.status} ${response.statusText}`;
    try {
        const parsed = JSON.parse(text);
        const candidate = parsed?.error ?? parsed;
        const message = typeof candidate?.message === "string"
            ? candidate.message
            : typeof candidate?.error === "string"
                ? candidate.error
                : typeof parsed?.detail === "string"
                    ? JSON.stringify(parsed.detail)
                    : text.slice(0, 400);
        return message;
    }
    catch {
        return text.slice(0, 400);
    }
}
async function ensureOk(response, context, what) {
    if (response.ok)
        return;
    const detail = await errorMessageOf(response);
    throw new CustomImageError(`ComfyUI ${what}失败（HTTP ${response.status}）：${detail}`, response.status);
}
// ── 尺寸 ──────────────────────────────────────────────────────────────
/**
 * 把尺寸写成 `宽x高`。
 *
 * 三种写法都认：`1024x1024` / `1024×1024` / `1K`(→1024) `2K`(→2048) `4K`(→4096)。
 * 认不出来返回 undefined —— 此时不传尺寸、用工作流自己的值，
 * 而不是硬塞一个可能让请求 400 的值。
 */
export function parseSizeSpec(size) {
    const text = size.trim().toLowerCase().replace("×", "x");
    const explicit = /^(\d{2,5})\s*x\s*(\d{2,5})$/.exec(text);
    if (explicit !== null) {
        const width = Number.parseInt(explicit[1], 10);
        const height = Number.parseInt(explicit[2], 10);
        if (width > 0 && height > 0)
            return { width, height };
    }
    const bucket = /^(\d)\s*k$/.exec(text);
    if (bucket !== null) {
        const side = Number.parseInt(bucket[1], 10) * 1024;
        return { width: side, height: side };
    }
    return undefined;
}
/** 把 data URI / http URL 统一取成字节。 */
async function readBytes(source, context) {
    const match = /^data:([^;,]+)?;base64,(.*)$/s.exec(source);
    if (match !== null)
        return Buffer.from(match[2], "base64");
    if (/^https?:/i.test(source)) {
        const response = await fetchOrThrow(source, { method: "GET" }, context);
        await ensureOk(response, context, "下载参考图");
        return Buffer.from(await response.arrayBuffer());
    }
    throw new CustomImageError("参考图既不是 data URI 也不是 http(s) 地址，无法发送给 ComfyUI");
}
function mimeOfBytes(bytes, fallback) {
    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50)
        return "image/png";
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8)
        return "image/jpeg";
    if (bytes.length >= 12 && bytes.toString("ascii", 8, 12) === "WEBP")
        return "image/webp";
    return fallback;
}
/** data URI / URL → Blob（multipart 上传要用）。 */
async function toBlob(source, context, name) {
    const bytes = await readBytes(source, context);
    const mime = mimeOfBytes(bytes, "image/png");
    const ext = mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png";
    const filename = /\.[a-z0-9]{2,4}$/i.test(name) ? name : `${name}.${ext}`;
    return { blob: new Blob([new Uint8Array(bytes)], { type: mime }), filename };
}
// ── ComfyUI 协议 ───────────────────────────────────────────────────────
/** 占位符 → 值。数值类会**按数字写进 JSON**（写成字符串 ComfyUI 的 int 输入会报错）。 */
function workflowValues(request, seed, imageNames) {
    const size = parseSizeSpec(request.size) ?? { width: 1024, height: 1024 };
    const values = {
        prompt: request.prompt,
        negative_prompt: request.negativePrompt,
        width: size.width,
        height: size.height,
        seed,
        steps: request.steps,
        cfg: request.cfgScale,
        sampler: request.sampler,
        denoising: request.denoising,
        model: "",
        batch: 1
    };
    if (imageNames.length > 0)
        values.image = imageNames[0];
    imageNames.forEach((name, index) => {
        values[`image${index + 1}`] = name;
    });
    return values;
}
/**
 * 按 **JSON 树**替换占位符，而不是在 JSON 文本上做字符串替换。
 *
 * 文本替换的坑很实在：提示词里带一个引号就能把整份工作流变成非法 JSON，
 * 而 `"{{width}}"` 这种写在引号里的占位符会变成字符串 —— ComfyUI 的
 * `EmptyLatentImage.width` 是 int，收到 `"1024"` 直接报 type 错误。
 * 走树替换时：整个字符串恰好等于一个占位符 → 取原始类型（数字就是数字）；
 * 嵌在字符串中间 → 取文本形态。
 */
function substituteWorkflow(node, values, used) {
    if (typeof node === "string") {
        const exact = /^\{\{(\w+)\}\}$/.exec(node);
        if (exact !== null && Object.prototype.hasOwnProperty.call(values, exact[1])) {
            used.add(exact[1]);
            return values[exact[1]];
        }
        return node.replace(/\{\{(\w+)\}\}/g, (whole, key) => {
            if (!Object.prototype.hasOwnProperty.call(values, key))
                return whole;
            used.add(key);
            return String(values[key]);
        });
    }
    if (Array.isArray(node))
        return node.map((item) => substituteWorkflow(item, values, used));
    if (node !== null && typeof node === "object") {
        const out = {};
        for (const [key, value] of Object.entries(node)) {
            out[key] = substituteWorkflow(value, values, used);
        }
        return out;
    }
    return node;
}
/**
 * 没写 `{{image}}` 时的兜底：直接把第一个 `LoadImage` 节点的文件名换掉。
 *
 * 用户从 ComfyUI 界面「导出（API）」拿到的默认工作流里，加载图片的节点就叫
 * `LoadImage`、输入名就叫 `image` —— 这是 ComfyUI 自己的约定，不会变。
 */
function patchLoadImage(node, name) {
    if (Array.isArray(node))
        return node.some((item) => patchLoadImage(item, name));
    if (node === null || typeof node !== "object")
        return false;
    const record = node;
    let touched = false;
    if (record.class_type === "LoadImage" && record.inputs !== null && typeof record.inputs === "object") {
        record.inputs.image = name;
        touched = true;
    }
    for (const value of Object.values(record)) {
        if (patchLoadImage(value, name))
            touched = true;
    }
    return touched;
}
/**
 * 没写 `{{prompt}}` 时的兜底：顺着采样器的 **positive 连线**找到文本编码节点，把提示词写进去。
 *
 * 为什么要有这条：用户从 ComfyUI 导出的工作流里，提示词往往是**写死的字符串**
 * （他在界面里试跑时填的那句），插件只替换占位符、不碰写死的值 ——
 * 于是任务面板上填的提示词**完全不生效**，而且不报任何错，只是每次出的都是同一张图。
 * 这跟「改了尺寸也不生效」是同一类坑，`patchLatentSize` 已经兜了尺寸，提示词也该兜。
 *
 * 怎么找目标：**不能**扫「所有字符串输入」——模型文件名、LoRA 名也是长字符串，
 * 改错了会把工作流弄坏且报错信息离现场很远。正确做法是顺着拓扑找：
 *   `KSampler.positive` → `["459:452", 0]` → 那个节点的文本输入。
 * 找不到采样器（或它没接 positive）时返回 false，让调用方报一条**能看懂**的提示。
 *
 * `negative` 只在用户确实填了负面提示词时才写，且要求它与 positive **不是同一个节点**
 * （Qwen 系工作流常把正负向接在同一个文本编码节点的两个输出槽上）。
 */
function patchPromptByTopology(workflow, prompt, negativePrompt) {
    const nodes = workflow;
    /** 输入名里带这些词的才是提示词，别把 ckpt_name / lora_name 当成文本改掉。 */
    const PROMPT_KEYS = ["text", "prompt", "positive", "positive_prompt", "text_g"];
    const isPromptKey = (key) => {
        const lower = key.toLowerCase();
        return PROMPT_KEYS.includes(lower) || lower.endsWith("_prompt") || lower === "text";
    };
    /** 在某个节点里写文本；返回是否写成功。 */
    const writeInto = (nodeId, text) => {
        const node = nodes[nodeId];
        if (node === undefined || node.inputs === null || typeof node.inputs !== "object")
            return false;
        for (const key of Object.keys(node.inputs)) {
            if (!isPromptKey(key))
                continue;
            const current = node.inputs[key];
            // 只改字符串（连线是数组，跳过）；空串也允许写 —— 那是「用户没填负面提示词」。
            if (typeof current !== "string")
                continue;
            node.inputs[key] = text;
            return true;
        }
        return false;
    };
    /** 从采样器读一条连线：`["459:452", 0]` → 节点 id。 */
    const linkedNode = (samplerId, slot) => {
        const link = nodes[samplerId]?.inputs?.[slot];
        if (!Array.isArray(link) || link.length !== 2 || typeof link[0] !== "string")
            return undefined;
        return link[0];
    };
    // 找采样器：class_type 里带 sampler / guider 的都认（KSampler / KSamplerAdvanced / SamplerCustom…）。
    const samplerIds = Object.keys(nodes).filter((id) => /sampler|guider/i.test(String(nodes[id]?.class_type ?? "")));
    for (const samplerId of samplerIds) {
        const positiveId = linkedNode(samplerId, "positive");
        if (positiveId === undefined)
            continue;
        if (!writeInto(positiveId, prompt))
            continue;
        let negative = false;
        if (negativePrompt.trim() !== "") {
            const negativeId = linkedNode(samplerId, "negative");
            // 正负向接在同一个节点上时，**只写正向**：再写一次会把它覆盖成负面提示词。
            if (negativeId !== undefined && negativeId !== positiveId)
                negative = writeInto(negativeId, negativePrompt);
        }
        return { positive: true, negative };
    }
    return { positive: false, negative: false };
}
/**
 * 没写 `{{width}}` / `{{height}}` 时的兜底：直接改空 latent 节点的宽高。
 *
 * 这是「改了尺寸也不生效」的常见原因：用户从 ComfyUI 导出的 API 工作流里，
 * `EmptyLatentImage` 的宽高是写死的数字，而插件只替换占位符、不碰写死的值。
 * 只改**本身是数字**的输入（连线的输入是数组，跳过），并且只认 `Empty*`
 * 这一类节点，避免把放大节点 / 参考图尺寸一起改掉。
 */
function patchLatentSize(node, width, height) {
    if (Array.isArray(node))
        return node.some((item) => patchLatentSize(item, width, height));
    if (node === null || typeof node !== "object")
        return false;
    const record = node;
    let touched = false;
    const classType = typeof record.class_type === "string" ? record.class_type : "";
    const inputs = record.inputs;
    if (/empty/i.test(classType) && inputs !== null && typeof inputs === "object") {
        if (typeof inputs.width === "number" || (typeof inputs.width === "string" && /^\d+$/.test(inputs.width))) {
            inputs.width = width;
            touched = true;
        }
        if (typeof inputs.height === "number" || (typeof inputs.height === "string" && /^\d+$/.test(inputs.height))) {
            inputs.height = height;
            touched = true;
        }
    }
    for (const value of Object.values(record)) {
        if (patchLatentSize(value, width, height))
            touched = true;
    }
    return touched;
}
function comfyOutputImages(outputs) {
    const found = [];
    if (outputs === null || typeof outputs !== "object")
        return found;
    for (const node of Object.values(outputs)) {
        const images = node?.images;
        if (!Array.isArray(images))
            continue;
        for (const image of images) {
            if (typeof image?.filename === "string") {
                found.push({
                    filename: image.filename,
                    subfolder: typeof image.subfolder === "string" ? image.subfolder : "",
                    type: typeof image.type === "string" ? image.type : "output"
                });
            }
        }
    }
    return found;
}
/** 从 `/history` 的 status 里捞执行错误（节点名 + 异常），这是排错的唯一线索。 */
function comfyStatusError(status) {
    if (status === null || typeof status !== "object")
        return undefined;
    const messages = status.messages;
    if (Array.isArray(messages)) {
        for (const message of messages) {
            if (Array.isArray(message) && message[0] === "execution_error" && typeof message[1]?.exception_message === "string") {
                const node = message[1]?.node_type ?? message[1]?.node_id ?? "未知节点";
                return `${node}：${message[1].exception_message}`;
            }
        }
    }
    if (typeof status.status_str === "string" && status.status_str === "error")
        return "执行失败（工作流里某个节点报错）";
    return undefined;
}
async function generateComfyUi(request, context) {
    if (request.workflow.trim() === "") {
        throw new CustomImageError("没有可用的工作流：在设置页粘贴一份 ComfyUI 的「导出（API）」JSON，或在任务面板里换一份");
    }
    let parsed;
    try {
        parsed = JSON.parse(request.workflow);
    }
    catch (error) {
        throw new CustomImageError(`工作流 JSON 解析失败：${error instanceof Error ? error.message : String(error)}`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new CustomImageError("工作流 JSON 必须是一个对象（API 格式），不是数组或裸值");
    }
    const auth = authHeaders(request.apiKey);
    const base = request.baseUrl;
    const seed = request.seed < 0 ? Math.floor(Math.random() * 2147483647) : request.seed;
    /** 「某样东西没生效」的告警，随结果回给调用方写进任务日志（不静默）。 */
    const warnings = [];
    // 参考图先传上去，拿到文件名再替换进工作流。
    const imageNames = [];
    for (const [index, image] of request.images.entries()) {
        const { blob, filename } = await toBlob(image, context, `gmm-ref-${Date.now()}-${index + 1}.png`);
        const form = new FormData();
        form.set("image", blob, filename);
        form.set("overwrite", "true");
        const uploaded = await fetchOrThrow(joinUrl(base, "/upload/image"), { method: "POST", headers: auth, body: form }, context);
        await ensureOk(uploaded, context, "上传参考图");
        const info = (await uploaded.json().catch(() => undefined));
        const name = typeof info?.name === "string" && info.name !== "" ? info.name : filename;
        const subfolder = typeof info?.subfolder === "string" ? info.subfolder : "";
        imageNames.push(subfolder === "" ? name : `${subfolder}/${name}`);
    }
    const used = new Set();
    let workflow = substituteWorkflow(parsed, workflowValues(request, seed, imageNames), used);
    if (imageNames.length > 0 && !used.has("image")) {
        patchLoadImage(workflow, imageNames[0]);
    }
    /**
     * 工作流里没写 width / height 占位符时，把尺寸写进空 latent 节点 —— 否则
     * 用户在设置里改输出尺寸，ComfyUI 仍然按工作流里写死的值出图（典型表现：
     * 「改了也不行，永远 1254×1254」）。
     */
    if (!used.has("width") || !used.has("height")) {
        const size = parseSizeSpec(request.size);
        if (size !== undefined)
            patchLatentSize(workflow, size.width, size.height);
    }
    /**
     * 最后把参数面板里改过的值写回去。
     *
     * 放在占位符替换**之后**是有意的：参数面板显示的是工作流里的真实输入，
     * 用户在那里改的东西必须赢过占位符与默认值，否则「调了没反应」。
     *
     * 类型按**节点定义**判定（`request.paramKinds`）：工作流里的槽位往往还是
     * `"{{seed}}"` 这种字符串，只看当前值会把数字写成字符串，ComfyUI 的 int 直接报错。
     */
    if (request.params !== undefined && Object.keys(request.params).length > 0) {
        const declared = request.paramKinds === undefined
            ? undefined
            : Object.entries(request.paramKinds).map(([key, kind]) => {
                const dot = key.indexOf(".");
                return { key, nodeId: key.slice(0, dot), nodeType: "", nodeTitle: "", input: key.slice(dot + 1), label: "", kind, value: "" };
            });
        workflow = applyWorkflowParams(workflow, request.params, declared);
    }
    /**
     * 工作流里没写 `{{prompt}}` 时，顺着采样器的 positive 连线把提示词写进文本编码节点。
     *
     * 放在**参数面板之后**：参数面板里显式改过提示词的人，那个值应该赢；
     * 这里只补「谁都没写」的那种情况（用户从 ComfyUI 导出的工作流，提示词是写死的字符串）。
     *
     * ⚠️ 这条以前是缺的，表现是「任务面板上填的提示词完全不生效、每次出同一张图、不报任何错」。
     *
     * 图片模块的 ComfyUI 页签已经不再提供提示词输入框（只走工作流 API），
     * 所以「谁都没写」在这里是**正常状态**：`request.prompt` 为空时什么都不写、
     * 也不告警 —— 图照样按工作流里写的出。八方向 / 序列帧 / UI 那些模块仍会带提示词，
     * 走的是同一条兜底。
     */
    if (!used.has("prompt") && request.prompt.trim() !== "") {
        const patched = patchPromptByTopology(workflow, request.prompt, request.negativePrompt);
        if (!patched.positive) {
            /**
             * 连采样器的 positive 都找不到，说明这份工作流的结构插件不认识。
             * 这时候**不能静默**：用户会以为提示词生效了，实际每次都是同一张图。
             * 但也不该直接拒绝 —— 有些工作流（固定文案的海报模板）本来就不吃外部提示词。
             * 所以只写一条可见的告警，让调用方把它带进任务日志。
             */
            warnings.push("工作流里没有 {{prompt}} 占位符，也没找到接在采样器 positive 上的文本节点：本次提示词没有生效（出图会是工作流里写死的那句）。在 ComfyUI 里把提示词改成 {{prompt}} 再导出即可。");
        }
    }
    const clientId = `gmm-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    const queued = await fetchOrThrow(joinUrl(base, "/prompt"), {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: workflow, client_id: clientId })
    }, context);
    if (!queued.ok) {
        const detail = await errorMessageOf(queued);
        throw new CustomImageError(`ComfyUI 提交工作流失败（HTTP ${queued.status}）：${detail}` +
            (queued.status === 400 ? "（多半是工作流里有节点参数不合法，先在 ComfyUI 里跑通再导出 API 格式）" : ""), queued.status);
    }
    const queuedPayload = (await queued.json().catch(() => undefined));
    const promptId = queuedPayload?.prompt_id;
    if (typeof promptId !== "string" || promptId === "") {
        throw new CustomImageError(`ComfyUI 没有返回 prompt_id：${JSON.stringify(queuedPayload).slice(0, 400)}`);
    }
    const nodeErrors = queuedPayload?.node_errors;
    if (nodeErrors !== null && typeof nodeErrors === "object" && Object.keys(nodeErrors).length > 0) {
        throw new CustomImageError(`工作流校验不通过：${JSON.stringify(nodeErrors).slice(0, 600)}`);
    }
    // 轮询历史。本地跑一张图几十秒起步，所以间隔取 1 秒、整体受 timeout 控制。
    let entry;
    for (;;) {
        if (context.composed.aborted)
            throw networkError(context, new Error("aborted"));
        await sleep(1000, context);
        const history = await fetchOrThrow(joinUrl(base, `/history/${encodeURIComponent(promptId)}`), { method: "GET", headers: auth }, context);
        await ensureOk(history, context, "查询任务状态");
        const payload = (await history.json().catch(() => undefined));
        const candidate = payload?.[promptId];
        if (candidate !== undefined) {
            // 有的实现是「先出现条目、再补 outputs」，所以还要等到有产出或明确报错。
            const failure = comfyStatusError(candidate?.status);
            if (failure !== undefined)
                throw new CustomImageError(`ComfyUI 执行失败：${failure}`);
            const images = comfyOutputImages(candidate?.outputs);
            if (images.length > 0) {
                entry = { ...candidate, __images: images };
                break;
            }
            const completed = candidate?.status?.completed === true || candidate?.status?.status_str === "success";
            if (completed)
                throw new CustomImageError("ComfyUI 执行完成，但没有任何图片输出（工作流最后接的不是 SaveImage / PreviewImage？）");
        }
    }
    const first = entry.__images[0];
    const query = new URLSearchParams({ filename: first.filename, subfolder: first.subfolder, type: first.type });
    const view = await fetchOrThrow(joinUrl(base, `/view?${query.toString()}`), { method: "GET", headers: auth }, context);
    await ensureOk(view, context, "下载生成结果");
    const bytes = Buffer.from(await view.arrayBuffer());
    return {
        bytes,
        ext: sniffExt(bytes),
        remoteUrl: joinUrl(base, `/view?${query.toString()}`),
        usage: { seed, promptId, filename: first.filename },
        // 空数组 = 一切正常；非空时调用方必须写进任务日志（「提示词没生效」这种必须让人看见）。
        warnings
    };
}
function sleep(ms, context) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            context.composed.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        function onAbort() {
            clearTimeout(timer);
            reject(networkError(context, new Error("aborted")));
        }
        if (context.composed.aborted) {
            onAbort();
            return;
        }
        context.composed.addEventListener("abort", onAbort, { once: true });
    });
}
// ── 入口 ───────────────────────────────────────────────────────────────
/** 调一次 ComfyUI。`images` 为空时是文生图，非空时按工作流的 `LoadImage` / `{{image}}` 带参考图。 */
export async function generateComfyImage(request, signal) {
    if (request.baseUrl.trim() === "") {
        throw new CustomImageError("尚未配置 ComfyUI 的地址（设置 → 游戏素材大师 → 生图后端）");
    }
    const context = makeSignalContext(request.timeoutMs, signal);
    return generateComfyUi(request, context);
}
