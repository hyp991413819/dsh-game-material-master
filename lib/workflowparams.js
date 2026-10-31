/**
 * 工作流参数发现：把一份 ComfyUI 的 **API 格式**工作流，变成一组「用户可设置的表单控件」。
 *
 * 为什么要做这件事：同一份工作流在不同人手里要调的参数完全不同 ——
 * 有人要改 KSampler 的步数，有人要改某个自定义节点的 `threshold`。
 * 让用户在插件里手写一份「参数清单」既啰嗦又容易和工作流脱节（改了工作流忘了改清单，
 * **不报任何错**，只是那个控件改了没反应）。
 *
 * 所以参数一律**从 ComfyUI 的 `/object_info` 现场读**：
 *   · 工作流里每个节点 → 查它的节点定义 → 拿到每个输入的**真实类型与取值范围**；
 *   · 只暴露「本身是字面量」的输入（`["4", 0]` 这种是连线，改了会破坏拓扑）；
 *   · 控件类型由定义决定：`INT`/`FLOAT` → 数字框（带 min/max/step），
 *     枚举（`[["euler","ddim",...], {...}]`）→ 下拉框，`STRING` → 文本 / 多行。
 *
 * ⚠️ `/object_info` 拿不到时（ComfyUI 没开、节点包没装）**不能抛错**：
 * 设置页与任务面板要照常渲染，只是退化成「按工作流里已有的值猜类型」。
 * 猜出来的控件照样能用 —— 用户填的值会原样写回工作流。
 */
/** 我们不希望出现在表单里的输入：连线槽、纯内部参数。 */
const SKIP_INPUTS = new Set(["clip", "vae", "model", "control_net", "latent_image", "samples", "image", "mask", "positive", "negative"]);
/** 常见输入的友好中文名；没列到的直接用原输入名（不猜、不翻译错）。 */
const INPUT_LABELS = {
    text: "提示词",
    prompt: "提示词",
    negative_prompt: "负面提示词",
    width: "宽度",
    height: "高度",
    seed: "种子",
    noise_seed: "噪声种子",
    steps: "采样步数",
    cfg: "CFG / 引导强度",
    sampler_name: "采样器",
    scheduler: "调度器",
    denoise: "重绘强度",
    batch_size: "批量大小",
    filename_prefix: "文件名前缀",
    ckpt_name: "模型文件",
    unet_name: "UNet 模型",
    vae_name: "VAE",
    clip_name: "文本编码器",
    weight_dtype: "权重精度",
    guidance: "引导",
    shift: "位移",
    threshold: "阈值",
    grow: "边缘收缩",
    padding: "外扩像素",
    precision: "精度",
    keep_loaded: "常驻显存",
    skip_backdrop: "跳过背景板",
    reject_neighbors: "剔除邻框"
};
function labelOf(input) {
    return INPUT_LABELS[input] ?? input;
}
function isLink(value) {
    // ComfyUI 的连线写法是 `[来源节点id, 输出槽位]`（长度 2 的数组）。
    return Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && typeof value[1] === "number";
}
/** 从 `{ min, max, step, default }` 里取范围；定义里没有就不填。 */
function rangeOf(spec) {
    const meta = Array.isArray(spec) && spec.length > 1 && spec[1] !== null && typeof spec[1] === "object" ? spec[1] : undefined;
    if (meta === undefined)
        return {};
    const out = {};
    if (typeof meta.min === "number")
        out.min = meta.min;
    if (typeof meta.max === "number")
        out.max = meta.max;
    if (typeof meta.step === "number")
        out.step = meta.step;
    return out;
}
/** 节点定义里某个输入的声明（先 required 再 optional）。 */
function inputSpecOf(spec, input) {
    if (spec === undefined)
        return undefined;
    const group = spec.input ?? spec;
    return group.required?.[input] ?? group.optional?.[input];
}
/**
 * 没有 `/object_info` 时的类型推断：只看工作流里那个值本身。
 *
 * 这条兜底很重要 —— ComfyUI 没启动时设置页照样要能编辑工作流，
 * 不能因为「读不到节点定义」就整块表单消失。
 */
function guessKind(value) {
    if (typeof value === "boolean")
        return "boolean";
    if (typeof value === "number")
        return Number.isInteger(value) ? "int" : "float";
    if (typeof value === "string") {
        const text = value.trim();
        if (/^-?\d+$/.test(text))
            return "int";
        if (/^-?\d*\.\d+$/.test(text))
            return "float";
        if (text.includes("\n") || text.length > 60)
            return "text";
        return "text";
    }
    return undefined;
}
/**
 * 从工作流 + 节点定义里抽出可设置参数。
 *
 * 顺序按节点 id 数字升序、再按定义里的输入顺序 —— 表单顺序稳定，
 * 不会因为 JSON 键序变化而每次刷新都换一个样子。
 */
export function discoverWorkflowParams(workflow, info = {}) {
    const params = [];
    const ids = Object.keys(workflow).sort((a, b) => {
        const na = Number.parseInt(a, 10);
        const nb = Number.parseInt(b, 10);
        if (Number.isNaN(na) || Number.isNaN(nb))
            return a.localeCompare(b);
        return na - nb;
    });
    for (const nodeId of ids) {
        const node = workflow[nodeId];
        if (node === undefined || node.inputs === null || typeof node.inputs !== "object")
            continue;
        const nodeType = typeof node.class_type === "string" ? node.class_type : "";
        const meta = node._meta;
        const nodeTitle = typeof meta?.title === "string" && meta.title.trim() !== "" ? meta.title : nodeType;
        const spec = info[nodeType];
        // 有定义时按定义顺序（更接近 ComfyUI 界面里的排列），否则按工作流里的键序。
        const declared = spec === undefined ? [] : Object.keys({ ...(spec.input ?? spec).required, ...(spec.input ?? spec).optional });
        const names = declared.length > 0 ? declared : Object.keys(node.inputs);
        for (const input of names) {
            const raw = node.inputs[input];
            if (raw === undefined)
                continue;
            if (isLink(raw))
                continue;
            if (SKIP_INPUTS.has(input))
                continue;
            if (typeof raw === "object" && raw !== null)
                continue;
            const decl = inputSpecOf(spec, input);
            const head = Array.isArray(decl) ? decl[0] : undefined;
            let kind;
            let options;
            let multiline = false;
            if (Array.isArray(head)) {
                // 枚举：`[["euler","ddim"], {...}]` —— 第一项是候选列表。
                const candidates = head.filter((item) => typeof item === "string");
                if (candidates.length > 0) {
                    kind = "enum";
                    options = candidates;
                }
            }
            else if (head === "INT")
                kind = "int";
            else if (head === "FLOAT")
                kind = "float";
            else if (head === "BOOLEAN")
                kind = "boolean";
            else if (head === "STRING") {
                kind = "text";
                const meta2 = Array.isArray(decl) && decl.length > 1 && decl[1] !== null && typeof decl[1] === "object" ? decl[1] : undefined;
                multiline = meta2?.multiline === true;
            }
            // 定义没给类型（或压根没查到）时，按工作流里的值猜。
            if (kind === undefined)
                kind = guessKind(raw);
            if (kind === undefined)
                continue;
            const param = {
                key: `${nodeId}.${input}`,
                nodeId,
                nodeType,
                nodeTitle,
                input,
                label: labelOf(input),
                kind,
                value: raw
            };
            if (options !== undefined)
                param.options = options;
            if (kind === "text" && multiline)
                param.multiline = true;
            if (kind === "int" || kind === "float") {
                const range = rangeOf(decl);
                if (range.min !== undefined)
                    param.min = range.min;
                if (range.max !== undefined)
                    param.max = range.max;
                if (range.step !== undefined)
                    param.step = range.step;
            }
            params.push(param);
        }
    }
    return params;
}
/**
 * 把用户改过的参数写回工作流（**不修改入参**，返回新对象）。
 *
 * 类型必须跟着**节点定义**走，而不是跟着当前值走：
 * 工作流里那些槽位往往还是 `"{{seed}}"` 这样的字符串占位符，
 * 只看当前值会把数字写成字符串，ComfyUI 的 int 输入直接报 type 错误。
 * 所以调用方要把 `discoverWorkflowParams` 的结果一起传进来（`declared`）；
 * 没有声明时退回「按当前值的类型」——总比一律写字符串好。
 */
export function applyWorkflowParams(workflow, values, declared) {
    const out = structuredClone(workflow);
    const kindOf = new Map();
    for (const param of declared ?? [])
        kindOf.set(param.key, param.kind);
    for (const [key, value] of Object.entries(values)) {
        const dot = key.indexOf(".");
        if (dot <= 0)
            continue;
        const nodeId = key.slice(0, dot);
        const input = key.slice(dot + 1);
        const node = out[nodeId];
        if (node === undefined || node.inputs === null || typeof node.inputs !== "object")
            continue;
        const inputs = node.inputs;
        const current = inputs[input];
        // 连线槽一律不碰：改了会把工作流拓扑弄坏，而且报错信息离现场很远。
        if (isLink(current) || current === undefined)
            continue;
        const kind = kindOf.get(key);
        if (kind === "int" || kind === "float") {
            const numeric = typeof value === "number" ? value : Number(value);
            if (!Number.isFinite(numeric))
                continue;
            // int 槽按 int 写；float 槽保留小数。判定依据是**声明的类型**，
            // 没声明时才看当前值是不是整数。
            const asInt = kind === "int" || (kind === undefined && typeof current === "number" && Number.isInteger(current));
            inputs[input] = asInt ? Math.round(numeric) : numeric;
        }
        else if (kind === "boolean") {
            inputs[input] = value === true || value === "true";
        }
        else if (kind === "enum" || kind === "text") {
            inputs[input] = String(value);
        }
        else if (typeof current === "boolean") {
            inputs[input] = value === true || value === "true";
        }
        else if (typeof current === "number") {
            const numeric = typeof value === "number" ? value : Number(value);
            if (!Number.isFinite(numeric))
                continue;
            inputs[input] = Number.isInteger(current) ? Math.round(numeric) : numeric;
        }
        else {
            inputs[input] = String(value);
        }
    }
    return out;
}
/**
 * 参数的默认值表（新建任务 / 重置时用）。
 *
 * 只收「值得给用户一个初值」的那些，其余保持工作流原样 ——
 * 把每个参数都抄一遍没有意义，还会让任务文件变得很大。
 */
export function defaultParamValues(params) {
    const values = {};
    for (const param of params)
        values[param.key] = param.value;
    return values;
}
