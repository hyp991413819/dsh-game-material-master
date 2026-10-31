/**
 * 游戏 UI 生成（模块九 · ui）的画框模型与 MOSS-Image layout 编译。
 *
 * ## 这一层在做什么
 *
 * 用户要的不是「一句话生图」，而是**自己编辑 UI 框架**：在画布上画若干框，
 * 每个框写清「这里是什么」（面板 / 标题 / 按钮 / 图标 / 文字），再让模型照框出图。
 * 框给了模型硬约束，所以布局是用户定的，不是模型猜的。
 *
 * 画框最终要变成 MOSS-Image 认得的 **layout JSON**：
 *
 *   {
 *     "summary": {"caption": "整张图的描述"},
 *     "items": [{"label": "object|character|text", "caption": "这框里是什么",
 *                "text": "文字框的实际文字", "bbox": [y1, x1, y2, x2], "palette": [...]}],
 *     "bbox_coord_space": "abs_centralized",
 *     "bbox_format": "yxyx"
 *   }
 *
 * ⚠️ **坐标系是 MOSS 的硬契约**：像素坐标要**减去画布中心**，而且顺序是
 * `y, x, y, x`（不是常见的 `x1,y1,x2,y2`）。写反了不会报错，模型只是把框
 * 摆到别处——本文件与 `F:\comfyui\...\moss-layout-local\__init__.py` 的
 * `_pixel_to_centralized_yxyx` 必须逐位一致，`verify-ui.mjs` 有黄金对照。
 *
 * ## 与 ComfyUI 节点包的关系
 *
 * 宿主**不依赖**那个 Python 节点包：layout 由本文件自己编译（纯本地、零成本、
 * 可离线复现），生成的 layout JSON 直接喂给 MOSS-Image 的文本编码。
 * 切片那一步才交给节点包（`MOSS_Layout_Matte_Slice` / `QwenEdit_Layout_Matte_Slice`），
 * 因为它们要跑 BiRefNet / Qwen-Edit 的推理。
 */

/** 画框类型。`object` 与 `character` 都出图，`text` 由模型渲染文字。 */
export const UI_LABELS = ["object", "character", "text"] as const;
export type UiLabel = (typeof UI_LABELS)[number];

/** 一个画框。坐标是**画布像素、左上原点、右下开区间**。 */
export interface UiBox {
  id: string;
  label: UiLabel;
  /** 这框里画什么。必填——空描述等于没画框。 */
  caption: string;
  /** `label === "text"` 时必填：框里实际可见的文字。 */
  text?: string;
  /** 配色（可选）：给模型一个色板提示。 */
  palette?: string[];
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** 一张 UI 画布：尺寸 + 全局描述 + 画框。 */
export interface UiLayout {
  width: number;
  height: number;
  /** 整张图的描述（MOSS 的 `summary.caption`）。 */
  summary: string;
  /** `single` / `multi_panel` / `collage`，可选，透传给 MOSS。 */
  canvas?: "single" | "multi_panel" | "collage";
  /** 全局配色（可选）。 */
  palette?: string[];
  boxes: UiBox[];
}

/** 画布边长必须 16 对齐（MOSS / latent 都按 16 网格走）。 */
export const UI_SIZE_STEP = 16;
export const UI_MIN_SIZE = 256;
export const UI_MAX_SIZE = 2048;

/** 一个画布最多几个框。多了模型会糊成一团，界面也画不下。 */
export const UI_MAX_BOXES = 40;

export class UiLayoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UiLayoutError";
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** 把任意输入读成数字；读不出来抛错（**不静默夹**，夹了会摆错框还不报错）。 */
function readNumber(value: unknown, what: string): number {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (!isFiniteNumber(n)) throw new UiLayoutError(`${what}必须是数字，当前为 ${JSON.stringify(value)}`);
  return n;
}

/**
 * 校验画布尺寸。
 *
 * 必须是 16 的正整数倍：MOSS 的 layout 提示词按像素摆框，而扩散的 latent
 * 网格是 16；不对齐时框与像素会错半格，界面上看不出、导出的图却会偏。
 */
export function normalizeCanvasSize(value: unknown, axis: "宽" | "高"): number {
  const n = readNumber(value, `画布${axis}度`);
  if (!Number.isInteger(n)) throw new UiLayoutError(`画布${axis}度必须是整数，当前为 ${n}`);
  if (n < UI_MIN_SIZE || n > UI_MAX_SIZE) {
    throw new UiLayoutError(`画布${axis}度必须在 ${UI_MIN_SIZE}~${UI_MAX_SIZE} 之间，当前为 ${n}`);
  }
  if (n % UI_SIZE_STEP !== 0) {
    throw new UiLayoutError(`画布${axis}度必须是 ${UI_SIZE_STEP} 的正整数倍，当前为 ${n}`);
  }
  return n;
}

/** 校验单个画框；返回规整后的副本（坐标取整）。 */
export function normalizeBox(raw: unknown, index: number, width: number, height: number): UiBox {
  const record = raw as Record<string, unknown> | null;
  if (record === null || typeof record !== "object") throw new UiLayoutError(`第 ${index} 个画框格式错误`);

  const label = record.label;
  if (typeof label !== "string" || !(UI_LABELS as readonly string[]).includes(label)) {
    throw new UiLayoutError(`第 ${index} 个画框的类型必须是 object / character / text，当前为 ${JSON.stringify(label)}`);
  }

  const caption = typeof record.caption === "string" ? record.caption.trim() : "";
  if (caption === "") throw new UiLayoutError(`第 ${index} 个画框请填写描述（这框里画什么）`);

  const text = typeof record.text === "string" ? record.text : "";
  if (label === "text" && text.trim() === "") {
    throw new UiLayoutError(`第 ${index} 个画框是文字类型，请填写实际可见的文字`);
  }

  const x1 = Math.round(readNumber(record.x1, `第 ${index} 个画框的 x1`));
  const y1 = Math.round(readNumber(record.y1, `第 ${index} 个画框的 y1`));
  const x2 = Math.round(readNumber(record.x2, `第 ${index} 个画框的 x2`));
  const y2 = Math.round(readNumber(record.y2, `第 ${index} 个画框的 y2`));

  if (!(0 <= x1 && x1 < x2 && x2 <= width && 0 <= y1 && y1 < y2 && y2 <= height)) {
    throw new UiLayoutError(
      `第 ${index} 个画框越界或面积为 0：(${x1}, ${y1})-(${x2}, ${y2})，画布 ${width}×${height}`
    );
  }

  const palette =
    Array.isArray(record.palette) && record.palette.length > 0 && record.palette.every((c) => typeof c === "string")
      ? (record.palette as string[])
      : undefined;

  const box: UiBox = {
    id: typeof record.id === "string" && record.id !== "" ? record.id : `b${index}`,
    label: label as UiLabel,
    caption,
    x1,
    y1,
    x2,
    y2
  };
  if (label === "text") box.text = text;
  if (palette !== undefined) box.palette = palette;
  return box;
}

/** 校验整份 layout；返回规整后的副本。 */
export function normalizeLayout(raw: unknown): UiLayout {
  const record = raw as Record<string, unknown> | null;
  if (record === null || typeof record !== "object") throw new UiLayoutError("画布数据格式错误");

  const width = normalizeCanvasSize(record.width, "宽");
  const height = normalizeCanvasSize(record.height, "高");

  const summary = typeof record.summary === "string" ? record.summary.trim() : "";
  if (summary === "") throw new UiLayoutError("请填写全局描述（整张图是什么）");

  const boxesIn = record.boxes;
  if (!Array.isArray(boxesIn) || boxesIn.length === 0) throw new UiLayoutError("请至少画一个画框");
  if (boxesIn.length > UI_MAX_BOXES) {
    throw new UiLayoutError(`画框最多 ${UI_MAX_BOXES} 个，当前为 ${boxesIn.length} 个`);
  }

  const boxes = boxesIn.map((box, index) => normalizeBox(box, index + 1, width, height));
  const seen = new Set<string>();
  for (const box of boxes) {
    if (seen.has(box.id)) throw new UiLayoutError(`画框 id 重复：${box.id}`);
    seen.add(box.id);
  }

  const layout: UiLayout = { width, height, summary, boxes };
  if (record.canvas === "single" || record.canvas === "multi_panel" || record.canvas === "collage") {
    layout.canvas = record.canvas;
  }
  if (Array.isArray(record.palette) && record.palette.length > 0 && record.palette.every((c) => typeof c === "string")) {
    layout.palette = record.palette as string[];
  }
  return layout;
}

/**
 * 像素坐标 → MOSS 的 `abs_centralized` / `yxyx`。
 *
 * 与 `moss-layout-local` 的 `_pixel_to_centralized_yxyx` 逐位一致：
 * 每个分量减去画布中心，且顺序是 **y1, x1, y2, x2**。
 */
export function pixelToCentralizedYxyx(box: { x1: number; y1: number; x2: number; y2: number }, width: number, height: number): [number, number, number, number] {
  return [box.y1 - Math.floor(height / 2), box.x1 - Math.floor(width / 2), box.y2 - Math.floor(height / 2), box.x2 - Math.floor(width / 2)];
}

/**
 * 编译成 MOSS-Image 的 layout JSON 文本（就是喂给文本编码的那串 prompt）。
 */
export function compileUiLayout(layout: UiLayout): string {
  const items = layout.boxes.map((box) => {
    const item: Record<string, unknown> = { label: box.label, caption: box.caption };
    if (box.label === "text") item.text = box.text ?? "";
    if (box.palette !== undefined) item.palette = box.palette;
    item.bbox = pixelToCentralizedYxyx(box, layout.width, layout.height);
    return item;
  });

  const summary: Record<string, unknown> = { caption: layout.summary };
  if (layout.canvas !== undefined) summary.canvas = layout.canvas;
  if (layout.palette !== undefined) summary.palette = layout.palette;

  return JSON.stringify(
    { summary, items, bbox_coord_space: "abs_centralized", bbox_format: "yxyx" },
    null,
    undefined
  );
}

/**
 * 导出成 **ComfyUI 节点包认的「编辑器草稿」格式**。
 *
 * ⚠️ 这是与 {@link compileUiLayout} **完全不同**的两种形态，别混用：
 *
 * | 用途 | 格式 | 坐标 |
 * |---|---|---|
 * | MOSS 文本编码（生图） | `abs_centralized` / `yxyx` | 减画布中心 |
 * | `MOSS_Layout_Matte_Slice` 等切片节点 | `abs` / `xyxy` + `width`/`height` | 像素左上原点 |
 *
 * 把编译后的格式喂给切片节点，会在 `_validate_draft` 里抛
 * `'dict' object has no attribute 'strip'`（实测踩过）；反过来则框全摆错位置。
 */
export function draftUiLayout(layout: UiLayout): string {
  const items = layout.boxes.map((box) => {
    const item: Record<string, unknown> = { label: box.label, caption: box.caption };
    if (box.label === "text") item.text = box.text ?? "";
    if (box.palette !== undefined) item.palette = box.palette;
    item.bbox = [box.x1, box.y1, box.x2, box.y2];
    return item;
  });
  const summary: Record<string, unknown> = { caption: layout.summary };
  if (layout.canvas !== undefined) summary.canvas = layout.canvas;
  if (layout.palette !== undefined) summary.palette = layout.palette;
  return JSON.stringify(
    { width: layout.width, height: layout.height, bbox_coord_space: "abs", bbox_format: "xyxy", summary, items },
    null,
    undefined
  );
}

/**
 * 画框里占画布面积最大的那个 = 背景板。
 *
 * 与 Python 端 `_is_backdrop_item` 同一判据（面积 ≥ 50% 画布）。
 * 切片时要跳过它：它是一整块不透明底图，抠掉背景等于把整张图抠没了。
 */
export function isBackdropBox(box: { x1: number; y1: number; x2: number; y2: number }, width: number, height: number): boolean {
  const area = (box.x2 - box.x1) * (box.y2 - box.y1);
  return area >= width * height * 0.5;
}

/**
 * 框向外扩 `padding` 像素（切片用），再夹回画布。
 *
 * 切片时外扩一点点能把贴边的阴影 / 描边收进去；但落在**邻框**里的部分要剔除，
 * 否则会把隔壁元素切进这张图（Python 端同样处理）。
 */
export function expandBox(
  box: { x1: number; y1: number; x2: number; y2: number },
  padding: number,
  width: number,
  height: number
): { x1: number; y1: number; x2: number; y2: number } {
  const pad = Math.max(0, Math.round(padding));
  return {
    x1: Math.max(0, box.x1 - pad),
    y1: Math.max(0, box.y1 - pad),
    x2: Math.min(width, box.x2 + pad),
    y2: Math.min(height, box.y2 + pad)
  };
}
