/**
 * 游戏 UI 生成（模块九 · ui）的数据层与作业。
 *
 * ## 用户要的是什么
 *
 * 不是「一句话生图」，而是**自己编辑 UI 框架**：在画布上画框、写每框是什么，
 * 再让 MOSS-Image 照框出图；出图之后按同一份画框**切成透明 PNG**（按钮、图标、
 * 面板九宫格……），直接能进游戏。
 *
 * ## 三段流水线
 *
 * ```
 *   ① 画框编辑（纯本地）      →  ② MOSS-Image 生图（本机 ComfyUI）
 *        layout JSON                整图（框的布局由用户定死）
 *                                        ↓
 *   ③ 按框切图（本机 ComfyUI）
 *        WeVisOne-VL 指代抠图  或  Qwen-Image-Edit 编辑抠图
 *        → 每框一张紧裁的透明 PNG + manifest
 * ```
 *
 * ## 为什么抠图不自己写
 *
 * 切图要跑 WeVisOne-VL / Qwen-Edit 的推理，那是 ComfyUI 节点包
 * （`moss-layout-local`）已经做好的事：它同时处理了「剔除邻框」「收边」
 * 「按 alpha 阈值清雾点」「背景板跳过」。宿主只负责把画框、图片、参数
 * 拼成工作流提交，再把产物搬回任务目录。
 *
 * ## 落盘
 *
 * ```
 * <DSH_HOME>/game-material-master/ui-jobs/<u…>/
 * ├── job.json
 * ├── source/          参考图（可选：给 MOSS 做风格 / 内容参考）
 * ├── render/          生图结果（每次生成一张新图，永不覆盖）
 * ├── slices/          切图产物（<批次>/<序号>_<标签>.png + manifest.json）
 * └── out/             导出（zip）
 * ```
 *
 * ## 与其它模块的关键区别
 *
 * 这个模块**不产生任何费用**：MOSS-Image、WeVisOne-VL、Qwen-Edit 全在本机 ComfyUI
 * 上跑。所以没有「计费闸门」，但**有并发闸门**——本地显卡跑两张图会一起变慢，
 * 也会把显存打爆。
 */

import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig, uiJobsRoot } from "./config.js";
import { appendJobLog, messageOf, readJson, sweepTempFiles, writeJsonAtomic, type JobLogEntry } from "./jsonio.js";
import { normalizeComfyBaseUrl, normalizeComfyCookies } from "./comfy.js";
import {
  UI_LABELS,
  compileUiLayout,
  draftUiLayout,
  expandBox,
  isBackdropBox,
  normalizeLayout,
  type UiLayout
} from "./uilayout.js";
import { zipEntries } from "./zip.js";
import { assetBasePath, originForLinks } from "./links.js";

/** UI 任务的三个阶段：画框 / 生图 / 切图。 */
export type UiStageKey = "layout" | "generate" | "slice";
export const UI_STAGES: readonly UiStageKey[] = ["layout", "generate", "slice"];

/**
 * 抠图方案。
 *
 * `wevisone` —— **WeVisOne-VL 指代抠图**（推荐）：把画框裁片和 `caption` 一起喂给
 *   Qwen3-VL 底座，模型先按**指代描述**定位目标，再由 alpha 解码器输出连续蒙版。
 *   与 UI 的层级结构天然吻合：每个框的 caption 本来就是「这里画的是什么」。
 * `qwen` —— Qwen-Image-2.1 编辑链路，逐框裁片 + 去底指令。
 */
export const UI_MATTE_MODES = ["wevisone", "qwen"] as const;
export type UiMatteMode = (typeof UI_MATTE_MODES)[number];

export interface UiStageState {
  status: "idle" | "running" | "done" | "error";
  approved: boolean;
  error?: string;
  at?: number;
}

/** 生图参数。全部有默认值，界面里是「高级设置」。 */
export interface UiGenSettings {
  /** 采样步数。 */
  steps: number;
  /** CFG。 */
  cfg: number;
  sampler: string;
  scheduler: string;
  /** `-1` = 每次随机。 */
  seed: number;
  /** 负面提示词。 */
  negative: string;
}

/** 切图参数。 */
export interface UiSliceSettings {
  /** 抠图方案：WeVisOne-VL（指代抠图）或 Qwen-Image-Edit。 */
  matte: UiMatteMode;
  /** Qwen 链路的裁片缩放基准（0 = 保持原裁切尺寸）；WeVisOne 忽略它。 */
  resolution: number;
  /** 每个框向外多裁的像素。 */
  padding: number;
  /** 低于该 alpha 的像素归零。 */
  threshold: number;
  /** 边缘收缩像素。 */
  grow: number;
  /** 跳过面积 ≥ 50% 画布的背景板。 */
  skipBackdrop: boolean;
  /** WeVisOne / Qwen：清掉留白区混进来的邻框元素。 */
  rejectNeighbors: boolean;
  /** Qwen 编辑指令。 */
  instruction: string;
  /** Qwen 编辑的负向提示词（cfg=1 时基本不生效）。 */
  negative: string;
}

/** 一次生图的产物。 */
export interface UiRender {
  id: string;
  /** 相对任务目录的路径（`render/<id>.png`）。 */
  file: string;
  bytes: number;
  width: number;
  height: number;
  /** 这次生成用的 layout（快照：用户可能之后又改了框）。 */
  layout: UiLayout;
  settings: UiGenSettings;
  createdAt: number;
  /** ComfyUI 的 prompt_id，排障用。 */
  promptId?: string;
  /** 生成耗时（毫秒）。 */
  elapsedMs?: number;
}

/** 一张切出来的透明图。 */
export interface UiSlice {
  /** 序号，与 layout.boxes 的下标 +1 对齐。 */
  index: number;
  label: string;
  /** 框里可见文字（文字框才有）。 */
  text?: string;
  /** 相对任务目录的路径。 */
  file: string;
  bytes: number;
  width: number;
  height: number;
}

/** 一次切图批次。 */
export interface UiSliceBatch {
  id: string;
  /** 用哪一次生图切的。 */
  renderId: string;
  matte: UiMatteMode;
  settings: UiSliceSettings;
  slices: UiSlice[];
  /** 被跳过的框（背景板 / 太小 / 邻框剔除）。 */
  skipped: Array<{ index: number; reason: string }>;
  createdAt: number;
  promptId?: string;
  elapsedMs?: number;
}

export interface UiJob {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** 当前画布（用户正在编辑的那份）。 */
  layout: UiLayout;
  settings: UiGenSettings;
  sliceSettings: UiSliceSettings;
  reviewMode?: "auto" | "manual";
  /** 参考图（可选）：给 MOSS 做风格 / 内容参考。 */
  source?: { file: string; name: string; bytes: number; ext: string };
  status: "idle" | "running" | "ready" | "error";
  error?: string;
  renders: UiRender[];
  batches: UiSliceBatch[];
  stages: Record<UiStageKey, UiStageState>;
  exports: Array<{ id: string; batchId: string | null; file: string; bytes: number; createdAt: number }>;
  log: JobLogEntry[];
}

export interface UiJobSummary {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  status: UiJob["status"];
  busy: boolean;
  boxes: number;
  width: number;
  height: number;
  renders: number;
  slices: number;
  reviewMode: string | null;
}

const JOB_ID_PATTERN = /^u[a-z0-9]{4,40}$/;

/** UI 任务可经资源路由读取的子目录（唯一真源，`index.ts` 直接引用）。 */
export const SERVABLE_UI_DIRS = new Set(["source", "render", "slices", "out"]);

export function uiJobDir(id: string): string {
  return join(uiJobsRoot(), id);
}

export function uiJobFile(id: string): string {
  return join(uiJobDir(id), "job.json");
}

/** 任务内相对路径 → 绝对路径，并挡住目录穿越。 */
export function uiAssetPath(id: string, relative: string): string {
  const base = resolve(uiJobDir(id));
  const target = resolve(base, relative);
  if (target !== base && !target.startsWith(base + sep)) throw new Error(`非法的任务内路径：${relative}`);
  return target;
}

export function isValidUiJobId(id: string): boolean {
  return JOB_ID_PATTERN.test(id);
}

function assertJobId(id: string): void {
  if (!isValidUiJobId(id)) throw new Error(`非法 UI 任务 id：${id}`);
}

function now(): number {
  return Date.now();
}

function logOf(job: UiJob): JobLogEntry[] {
  if (!Array.isArray(job.log)) job.log = [];
  return job.log;
}

export function uiLog(job: UiJob, level: JobLogEntry["level"], message: string): void {
  appendJobLog(logOf(job), level, message);
}

function clampString(value: unknown, max = 20000): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

export function safeUiStem(value: unknown): string {
  const base = basename(String(value ?? ""))
    .replace(/[^\w.\-()\u4e00-\u9fa5]+/gu, "_")
    .replace(/^[._]+/u, "");
  return base === "" ? "ui" : base.slice(0, 80);
}

function deriveUiName(layout: UiLayout): string {
  const flat = layout.summary.replace(/\s+/gu, " ").trim();
  return flat === "" ? "未命名 UI" : flat.slice(0, 24);
}

function defaultStages(): Record<UiStageKey, UiStageState> {
  return {
    layout: { status: "idle", approved: false },
    generate: { status: "idle", approved: false },
    slice: { status: "idle", approved: false }
  };
}

/** 默认生图参数（与官方 MOSS 模板一致：25 步 / cfg 2.5 / er_sde / simple）。 */
export const UI_DEFAULT_SETTINGS: UiGenSettings = {
  steps: 25,
  cfg: 2.5,
  sampler: "er_sde",
  scheduler: "simple",
  seed: -1,
  negative: "text, letters, numbers, words, watermark, logo, signature, photo, realism, blur, noise, jpeg artifacts, cropped object, overlapping objects, deformed edges"
};

/**
 * UI 场景的切图默认值——三处都与「通用素材」的默认值不同，全部来自真机实测：
 *
 * 1. `matte: "wevisone"`。**WeVisOne-VL 是指代抠图**：它把画框裁片连同 `caption`
 *    一起喂给 Qwen3-VL 底座，模型先按描述**定位**目标，再由 alpha 解码器出蒙版。
 *    UI 的每个框本来就写着「这里是什么」，正好就是模型要的指代描述，两者天然对齐。
 *    （对照：BiRefNet 是主体分割模型，它在一张图上找「最像主体的那块」——UI 里
 *    主体永远是那个大面板，面板内的小按钮 / 图标会被判成背景、alpha 全 0，
 *    manifest 记 `no_opaque_pixels` 直接跳过。实测 4 个框只出 1 张。）
 * 2. `skipBackdrop: false`。节点包默认跳过「面积 ≥ 50% 画布」的框（普通素材里
 *    那是整块底图）。但 UI 里**那个大框往往就是面板本体**，正是要做九宫格的
 *    东西——跳过它等于把主菜丢了。
 * 3. `resolution: 0`。Qwen 编辑链路会把裁片**重新缩放到 resolution 见方**
 *    （按原比例），设成 1024 时一个 304×100 的按钮会被放大到 604×602，
 *    出来的图跟原框对不上。0 = 保持原裁切尺寸，逐像素对得上。
 *    （WeVisOne 不走这条路，它自己按裁片原尺寸推理，这个字段对它无意义。）
 */
export const UI_DEFAULT_SLICE: UiSliceSettings = {
  matte: "wevisone",
  resolution: 0,
  padding: 8,
  threshold: 8,
  grow: 1,
  skipBackdrop: false,
  rejectNeighbors: true,
  instruction:
    "Keep this UI element exactly as it is and remove the background completely, leaving only the element itself on a fully transparent background. Preserve the original shape, colors and edges pixel by pixel; do not redraw, rescale, add or restyle anything.",
  negative: "background, panel, scenery, extra objects, text, watermark, blurry edges, glow"
};

export function normalizeGenSettings(raw: unknown, base: UiGenSettings = UI_DEFAULT_SETTINGS): UiGenSettings {
  const entry = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const num = (value: unknown, fallback: number, min: number, max: number): number => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  };
  return {
    steps: Math.round(num(entry.steps, base.steps, 1, 100)),
    cfg: num(entry.cfg, base.cfg, 0, 30),
    sampler: typeof entry.sampler === "string" && entry.sampler.trim() !== "" ? entry.sampler.trim() : base.sampler,
    scheduler: typeof entry.scheduler === "string" && entry.scheduler.trim() !== "" ? entry.scheduler.trim() : base.scheduler,
    seed: Math.round(num(entry.seed, base.seed, -1, 0xffffffff)),
    negative: typeof entry.negative === "string" ? entry.negative.slice(0, 4000) : base.negative
  };
}

export function normalizeSliceSettings(raw: unknown, base: UiSliceSettings = UI_DEFAULT_SLICE): UiSliceSettings {
  const entry = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const num = (value: unknown, fallback: number, min: number, max: number): number => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.round(Math.min(max, Math.max(min, n)));
  };
  /**
   * 老数据的迁移：`birefnet` 已经从方案列表里移除，读回时归到 `wevisone`。
   *
   * 不做这层映射的话，老任务会带着一个**不认识的 matte 值**跑下去 ——
   * `buildSliceWorkflow` 认不出来就会落到 `else` 分支，表现是「任务能跑、
   * 但用的不是界面显示的那个方案」。
   */
  const matte: UiMatteMode =
    entry.matte === "qwen" ? "qwen" : entry.matte === "wevisone" || entry.matte === "birefnet" ? "wevisone" : base.matte;
  return {
    matte,
    // ⚠️ 下限必须是 0：0 = 「保持原裁切尺寸」，这是 UI 场景的默认值。
    // 写成 256 会把 0 夹成 256，Qwen 链路随即把裁片放大到约 256 见方，
    // 切出来的图与画框对不上（实测：304×100 的按钮被放大成 604×602）。
    resolution: num(entry.resolution, base.resolution, 0, 4096),
    padding: num(entry.padding, base.padding, 0, 128),
    threshold: num(entry.threshold, base.threshold, 0, 255),
    grow: num(entry.grow, base.grow, 0, 32),
    skipBackdrop: entry.skipBackdrop === undefined ? base.skipBackdrop : entry.skipBackdrop === true,
    rejectNeighbors: entry.rejectNeighbors === undefined ? base.rejectNeighbors : entry.rejectNeighbors === true,
    instruction: typeof entry.instruction === "string" && entry.instruction.trim() !== "" ? entry.instruction.slice(0, 4000) : base.instruction,
    negative: typeof entry.negative === "string" ? entry.negative.slice(0, 4000) : base.negative
  };
}

/** 读回来的老数据补齐数组与阶段字段，避免界面拿 undefined 当空。 */
function normalizeJob(raw: any, id: string): UiJob {
  const config = raw ?? {};
  const settings = normalizeGenSettings(config.settings);
  const sliceSettings = normalizeSliceSettings(config.sliceSettings);
  const layout = (() => {
    try {
      return normalizeLayout(config.layout);
    } catch {
      return { width: 1024, height: 1024, summary: "未命名 UI", boxes: [] } as UiLayout;
    }
  })();
  const stages = config.stages ?? {};
  return {
    id,
    name: clampString(config.name, 200) || "未命名 UI",
    createdAt: Number(config.createdAt) || now(),
    updatedAt: Number(config.updatedAt) || now(),
    layout,
    settings,
    sliceSettings,
    ...(config.reviewMode === "auto" || config.reviewMode === "manual" ? { reviewMode: config.reviewMode } : {}),
    ...(config.source !== null && typeof config.source === "object" && typeof config.source.file === "string"
      ? {
          source: {
            file: config.source.file,
            name: typeof config.source.name === "string" ? config.source.name : basename(config.source.file),
            bytes: Number(config.source.bytes) || 0,
            ext: typeof config.source.ext === "string" ? config.source.ext : "png"
          }
        }
      : {}),
    status: ["idle", "running", "ready", "error"].includes(config.status) ? config.status : "idle",
    ...(typeof config.error === "string" && config.error !== "" ? { error: config.error } : {}),
    renders: Array.isArray(config.renders)
      ? config.renders
          .filter((r: any) => r !== null && typeof r === "object" && typeof r.file === "string")
          .map((r: any) => ({
            id: typeof r.id === "string" ? r.id : randomUUID().slice(0, 8),
            file: r.file,
            bytes: Number(r.bytes) || 0,
            width: Number(r.width) || layout.width,
            height: Number(r.height) || layout.height,
            layout: (() => {
              try {
                return normalizeLayout(r.layout);
              } catch {
                return layout;
              }
            })(),
            settings: normalizeGenSettings(r.settings, settings),
            createdAt: Number(r.createdAt) || now(),
            ...(typeof r.promptId === "string" ? { promptId: r.promptId } : {}),
            ...(Number.isFinite(Number(r.elapsedMs)) ? { elapsedMs: Number(r.elapsedMs) } : {})
          }))
      : [],
    batches: Array.isArray(config.batches)
      ? config.batches
          .filter((b: any) => b !== null && typeof b === "object" && typeof b.id === "string")
          .map((b: any) => ({
            id: b.id,
            renderId: typeof b.renderId === "string" ? b.renderId : "",
            matte: b.matte === "qwen" ? "qwen" : "wevisone",
            settings: normalizeSliceSettings(b.settings, sliceSettings),
            slices: Array.isArray(b.slices)
              ? b.slices
                  .filter((s: any) => s !== null && typeof s === "object" && typeof s.file === "string")
                  .map((s: any) => ({
                    index: Number(s.index) || 0,
                    label: typeof s.label === "string" ? s.label : "object",
                    ...(typeof s.text === "string" && s.text !== "" ? { text: s.text } : {}),
                    file: s.file,
                    bytes: Number(s.bytes) || 0,
                    width: Number(s.width) || 0,
                    height: Number(s.height) || 0
                  }))
              : [],
            skipped: Array.isArray(b.skipped) ? b.skipped.filter((s: any) => s !== null && typeof s === "object") : [],
            createdAt: Number(b.createdAt) || now(),
            ...(typeof b.promptId === "string" ? { promptId: b.promptId } : {}),
            ...(Number.isFinite(Number(b.elapsedMs)) ? { elapsedMs: Number(b.elapsedMs) } : {})
          }))
      : [],
    stages: {
      layout: normalizeStage(stages.layout),
      generate: normalizeStage(stages.generate),
      slice: normalizeStage(stages.slice)
    },
    exports: Array.isArray(config.exports)
      ? config.exports
          .filter((e: any) => e !== null && typeof e === "object" && typeof e.file === "string")
          .map((e: any) => ({
            id: typeof e.id === "string" ? e.id : randomUUID().slice(0, 8),
            batchId: typeof e.batchId === "string" ? e.batchId : null,
            file: e.file,
            bytes: Number(e.bytes) || 0,
            createdAt: Number(e.createdAt) || now()
          }))
      : [],
    log: Array.isArray(config.log) ? config.log.slice(-200) : []
  };
}

function normalizeStage(raw: any): UiStageState {
  const entry = raw !== null && typeof raw === "object" ? raw : {};
  return {
    status: ["idle", "running", "done", "error"].includes(entry.status) ? entry.status : "idle",
    approved: entry.approved === true,
    ...(typeof entry.error === "string" && entry.error !== "" ? { error: entry.error } : {}),
    ...(Number.isFinite(Number(entry.at)) ? { at: Number(entry.at) } : {})
  };
}

export async function createUiJob(input: {
  name?: string;
  layout?: unknown;
  reviewMode?: "auto" | "manual";
}): Promise<UiJob> {
  const layout = normalizeLayout(
    input.layout ?? {
      width: 1024,
      height: 1024,
      summary: "游戏 UI 面板：深色底板、金色描边、居中标题、底部按钮",
      boxes: [
        { id: "b1", label: "object", caption: "面板底板：圆角矩形，带金色描边", x1: 96, y1: 96, x2: 928, y2: 800 },
        { id: "b2", label: "text", caption: "居中金色标题", text: "每日签到", x1: 320, y1: 160, x2: 704, y2: 280 },
        { id: "b3", label: "object", caption: "底部金色圆角按钮", x1: 360, y1: 640, x2: 664, y2: 736 }
      ]
    }
  );
  const id = `u${now().toString(36)}${randomUUID().slice(0, 6)}`;
  const createdAt = now();
  const job: UiJob = {
    id,
    name: clampString(input.name, 200).trim() || deriveUiName(layout),
    createdAt,
    updatedAt: createdAt,
    layout,
    settings: { ...UI_DEFAULT_SETTINGS },
    sliceSettings: { ...UI_DEFAULT_SLICE },
    ...(input.reviewMode === "manual" ? { reviewMode: "manual" as const } : input.reviewMode === "auto" ? { reviewMode: "auto" as const } : {}),
    status: "idle",
    renders: [],
    batches: [],
    stages: defaultStages(),
    exports: [],
    log: []
  };
  for (const dir of ["source", "render", "slices", "out"]) {
    await mkdir(join(uiJobDir(id), dir), { recursive: true });
  }
  uiLog(job, "info", `新建 UI 任务：${job.name}（${layout.width}×${layout.height}，${layout.boxes.length} 个画框）`);
  await writeJsonAtomic(uiJobFile(id), job);
  return job;
}

export async function readUiJob(id: string): Promise<UiJob | undefined> {
  assertJobId(id);
  const raw = await readJson<any>(uiJobFile(id));
  if (raw === undefined) return undefined;
  return normalizeJob(raw, id);
}

/** 保存画布 / 名称 / 参数 / 审核模式。生成中的任务也允许改，下一次生成才生效。 */
export async function saveUiJob(
  id: string,
  input: { name?: string; layout?: unknown; settings?: unknown; sliceSettings?: unknown; reviewMode?: "auto" | "manual" }
): Promise<Record<string, unknown>> {
  assertJobId(id);
  const job = await patchUiJob(id, (current) => {
    if (typeof input.name === "string") {
      const name = input.name.trim().slice(0, 200);
      if (name !== "") current.name = name;
    }
    if (input.layout !== undefined) {
      current.layout = normalizeLayout(input.layout);
      current.stages.layout.status = "done";
      current.stages.layout.at = now();
    }
    if (input.settings !== undefined) current.settings = normalizeGenSettings(input.settings, current.settings);
    if (input.sliceSettings !== undefined) current.sliceSettings = normalizeSliceSettings(input.sliceSettings, current.sliceSettings);
    if (input.reviewMode === "auto" || input.reviewMode === "manual") current.reviewMode = input.reviewMode;
    uiLog(current, "info", "任务参数已更新");
    return current;
  });
  return uiSnapshot(job, originForLinks());
}

export async function writeUiJob(job: UiJob): Promise<void> {
  assertJobId(job.id);
  await sweepTempFiles(uiJobDir(job.id)).catch(() => undefined);
  await writeJsonAtomic(uiJobFile(job.id), job);
}

const jobQueues = new Map<string, Promise<unknown>>();

/**
 * 按任务串行写。后台任务收尾与用户保存同时发生时，只靠「读-改-写」会丢改动。
 */
export function patchUiJob<T>(id: string, mutator: (job: UiJob) => T | Promise<T>): Promise<T> {
  assertJobId(id);
  const previous = jobQueues.get(id) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const job = await readUiJob(id);
      if (job === undefined) throw new Error(`UI 任务不存在：${id}`);
      const result = await mutator(job);
      job.updatedAt = now();
      await writeUiJob(job);
      return result;
    });
  jobQueues.set(id, next);
  void next.finally(() => {
    if (jobQueues.get(id) === next) jobQueues.delete(id);
  }).catch(() => undefined);
  return next;
}

export async function listUiJobs(): Promise<UiJobSummary[]> {
  let entries: string[] = [];
  try {
    entries = (await readdir(uiJobsRoot(), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && isValidUiJobId(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const jobs: UiJobSummary[] = [];
  for (const id of entries) {
    const job = await readUiJob(id).catch(() => undefined);
    if (job !== undefined) jobs.push(summarizeUiJob(job));
  }
  return jobs.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function summarizeUiJob(job: UiJob): UiJobSummary {
  const latest = job.batches[job.batches.length - 1];
  return {
    id: job.id,
    name: job.name,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    status: job.status,
    busy: uiBusy(job.id, job),
    boxes: job.layout.boxes.length,
    width: job.layout.width,
    height: job.layout.height,
    renders: job.renders.length,
    slices: latest?.slices.length ?? 0,
    reviewMode: job.reviewMode ?? null
  };
}

export async function deleteUiJob(id: string): Promise<void> {
  assertJobId(id);
  const job = await readUiJob(id);
  if (job === undefined) return;
  if (uiBusy(id, job)) throw new Error("任务正在生成，先取消或等它结束再删除。");
  await rm(uiJobDir(id), { recursive: true, force: true });
}

// ── 后台任务表 ──────────────────────────────────────────────────────────

const running = new Map<string, Set<string>>();
const controllers = new Map<string, AbortController>();
let disposed = false;

/** DSH 重载插件时模块级 disposed 会留着，apply 时靠它复位。 */
export function activateUi(): void {
  disposed = false;
  running.clear();
  for (const controller of controllers.values()) controller.abort();
  controllers.clear();
}

export function disposeUi(): void {
  disposed = true;
  for (const controller of controllers.values()) controller.abort();
  controllers.clear();
  running.clear();
}

export function uiBusy(id: string, job?: UiJob): boolean {
  if ((running.get(id)?.size ?? 0) > 0) return true;
  return job?.status === "running";
}

function trackUiTask(id: string, key: string, run: () => Promise<void>): boolean {
  if (disposed) return false;
  const set = running.get(id) ?? new Set<string>();
  if (set.has(key)) return false;
  running.set(id, set);
  set.add(key);
  const controller = new AbortController();
  controllers.set(`${id}:${key}`, controller);
  void run()
    .catch((error) => {
      // ⚠️ 失败时必须**同时**把阶段与任务状态落到 error。
      // 只写一条日志的话，`status` 会永远停在 running —— 界面一直转圈，
      // 而且 `uiBusy()` 认为还在跑，这个任务之后再也启动不了（真机踩过：
      // 切图失败一次后，重试按钮点了完全没反应，也没有任何新日志）。
      const message = messageOf(error);
      void patchUiJob(id, (job) => {
        const stage = job.stages[key as "generate" | "slice"];
        if (stage !== undefined) {
          stage.status = "error";
          stage.error = message;
          stage.at = now();
        }
        job.status = "error";
        job.error = message;
        uiLog(job, "error", `${key} 失败：${message}`);
        return job;
      }).catch(() => undefined);
    })
    .finally(() => {
      set.delete(key);
      controllers.delete(`${id}:${key}`);
      if (set.size === 0 && running.get(id) === set) running.delete(id);
    });
  return true;
}

export function cancelUiTask(id: string, key: "generate" | "slice"): boolean {
  assertJobId(id);
  const controller = controllers.get(`${id}:${key}`);
  if (controller === undefined) return false;
  controller.abort();
  return true;
}

// ── ComfyUI 访问 ────────────────────────────────────────────────────────

interface UiComfyTarget {
  baseUrl: string;
  cookies: string;
  timeoutMs: number;
}

async function comfyTarget(): Promise<UiComfyTarget> {
  const config = await loadConfig();
  // UI 链路允许单独指向另一台 ComfyUI（带显卡的那台）；留空就跟视频那套走。
  const dedicated = config.uiComfyBaseUrl.trim();
  return {
    baseUrl: normalizeComfyBaseUrl(dedicated !== "" ? dedicated : config.comfyBaseUrl),
    cookies: normalizeComfyCookies(config.comfyCookies),
    timeoutMs: Math.max(5000, config.uiTimeoutMs || 1200000)
  };
}

/** 从配置读当前权重名（设置页可改，默认值与本机实测一致）。 */
export async function uiModels(): Promise<UiModels> {
  const config = await loadConfig();
  const pick = (value: string, fallback: string): string => (value.trim() === "" ? fallback : value.trim());
  return {
    mossModel: pick(config.uiMossModel, DEFAULT_UI_MODELS.mossModel),
    mossClip: pick(config.uiMossClip, DEFAULT_UI_MODELS.mossClip),
    mossVae: pick(config.uiMossVae, DEFAULT_UI_MODELS.mossVae),
    wevisoneModel: pick(config.uiWevisoneModel, DEFAULT_UI_MODELS.wevisoneModel),
    qwenModel: pick(config.uiQwenModel, DEFAULT_UI_MODELS.qwenModel),
    qwenClip: pick(config.uiQwenClip, DEFAULT_UI_MODELS.qwenClip),
    qwenVae: pick(config.uiQwenVae, DEFAULT_UI_MODELS.qwenVae)
  };
}

function comfyHeaders(target: UiComfyTarget): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (target.cookies !== "") headers.cookie = target.cookies;
  return headers;
}

/** 提交工作流，返回 prompt_id。 */
export async function submitComfyWorkflow(target: UiComfyTarget, workflow: Record<string, unknown>): Promise<string> {
  const response = await fetch(`${target.baseUrl}/prompt`, {
    method: "POST",
    headers: comfyHeaders(target),
    body: JSON.stringify({ prompt: workflow })
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`ComfyUI 拒绝了工作流（HTTP ${response.status}）：${text.slice(0, 800)}`);
  }
  const parsed = JSON.parse(text) as { prompt_id?: string; node_errors?: unknown };
  if (parsed.prompt_id === undefined) throw new Error(`ComfyUI 没有返回 prompt_id：${text.slice(0, 500)}`);
  return parsed.prompt_id;
}

/**
 * 轮询 history 直到完成；`onProgress` 用来把进度写进任务日志。
 *
 * `tolerateError` 为 true 时**不把执行错误当失败**：Qwen 切片节点会在写完所有
 * PNG 之后、写 manifest 那一步崩掉（上游 bug）。产物已经在磁盘上，所以这里
 * 把「error」当成「跑完了」交回去，由调用方去扫目录。
 */
export async function waitComfyHistory(
  target: UiComfyTarget,
  promptId: string,
  options: { timeoutMs?: number; signal?: AbortSignal; onTick?: (seconds: number) => void; tolerateError?: boolean } = {}
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + (options.timeoutMs ?? 30 * 60 * 1000);
  let waited = 0;
  while (Date.now() < deadline) {
    if (options.signal?.aborted === true) throw new Error("已取消");
    await new Promise((resolveWait) => setTimeout(resolveWait, 2000));
    waited += 2;
    options.onTick?.(waited);
    const response = await fetch(`${target.baseUrl}/history/${promptId}`, { headers: comfyHeaders(target) });
    if (!response.ok) continue;
    const history = (await response.json()) as Record<string, any>;
    const entry = history[promptId];
    if (entry === undefined) continue;
    if (entry.status?.status_str === "error") {
      if (options.tolerateError === true) return entry as Record<string, unknown>;
      const messages = Array.isArray(entry.status?.messages) ? JSON.stringify(entry.status.messages).slice(0, 800) : "";
      throw new Error(`ComfyUI 执行失败：${messages || "见 ComfyUI 控制台"}`);
    }
    return entry as Record<string, unknown>;
  }
  throw new Error(`等待 ComfyUI 超时（${Math.round((options.timeoutMs ?? 30 * 60 * 1000) / 1000)} 秒）`);
}

/** 从 history 的 outputs 里挑出图片文件名（按节点顺序）。 */
export function imagesFromHistory(entry: Record<string, unknown>): Array<{ filename: string; subfolder: string; type: string }> {
  const outputs = (entry.outputs ?? {}) as Record<string, any>;
  const found: Array<{ filename: string; subfolder: string; type: string }> = [];
  for (const value of Object.values(outputs)) {
    const images = (value as any)?.images;
    if (!Array.isArray(images)) continue;
    for (const image of images) {
      if (image === null || typeof image !== "object") continue;
      if (typeof image.filename !== "string") continue;
      found.push({
        filename: image.filename,
        subfolder: typeof image.subfolder === "string" ? image.subfolder : "",
        type: typeof image.type === "string" ? image.type : "output"
      });
    }
  }
  return found;
}

/** 从 `/view` 下载一张图。 */
export async function downloadComfyImage(target: UiComfyTarget, image: { filename: string; subfolder: string; type: string }): Promise<Buffer> {
  const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder, type: image.type });
  const response = await fetch(`${target.baseUrl}/view?${query.toString()}`, { headers: comfyHeaders(target) });
  if (!response.ok) throw new Error(`下载 ComfyUI 产物失败（HTTP ${response.status}）：${image.filename}`);
  return Buffer.from(await response.arrayBuffer());
}

// ── 生图 ────────────────────────────────────────────────────────────────

/** UI 链路用到的 ComfyUI 权重名（全部可在设置页改）。 */
export interface UiModels {
  mossModel: string;
  mossClip: string;
  mossVae: string;
  /** WeVisOne-VL 的权重目录名（`models/wevisone/` 下）。 */
  wevisoneModel: string;
  qwenModel: string;
  qwenClip: string;
  qwenVae: string;
}

/** 与本机 `F:\comfyui` 实测一致的一组默认值。 */
export const DEFAULT_UI_MODELS: UiModels = {
  mossModel: "moss_image_sft_int8_convrot.safetensors",
  mossClip: "qwen3.5_9b_int8_convrot.safetensors",
  mossVae: "flux2-vae.safetensors",
  wevisoneModel: "WeVisOne-VL-2B",
  qwenModel: "qwen_image_2.1_int8_convrot.safetensors",
  qwenClip: "qwen3vl_8b_int8_convrot.safetensors",
  qwenVae: "qwen_image_2.1_vae_bf16.safetensors"
};

/**
 * MOSS-Image 的固定工作流（本机权重组合）。
 *
 * 节点组合来自官方模板 `image_moss_image_t2i_bboxes`，但去掉了它的
 * 「提示词增强」（那要再跑一次大语言模型，翻倍耗时）与 SLG，只留最小链路：
 * UNET → CLIP → layout 编译 → 文本编码 → 采样 → 解码 → 存图。
 *
 * ⚠️ 三处不能改错：
 *   1. `MOSS_Layout_Local_Compile` 的 layout 直接连文本编码，**不要**再拼字符串；
 *   2. latent 的宽高取自 layout 编译输出的第 2、3 个返回值（与画布严格一致）；
 *   3. `type` 必须是 `moss_image`，否则 CLIP 走错通道、出图是乱的。
 */
export function buildMossWorkflow(options: {
  layoutJson: string;
  width: number;
  height: number;
  negative: string;
  settings: UiGenSettings;
  seed: number;
  prefix: string;
  /** 权重名；省略时用默认值（自检里用得到）。 */
  models?: UiModels;
}): Record<string, unknown> {
  const models = options.models ?? DEFAULT_UI_MODELS;
  return {
    "1": { class_type: "UNETLoader", inputs: { unet_name: models.mossModel, weight_dtype: "default" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: models.mossClip, type: "moss_image", device: "default" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: models.mossVae } },
    // ⚠️ 这里**直接**喂编译好的 layout JSON，不要再接 `MOSS_Layout_Local_Compile`：
    // 那个节点吃的是「编辑器草稿」（abs/xyxy + width/height），而 compileUiLayout
    // 产出的已经是 MOSS 最终格式（abs_centralized/yxyx）。接上去会抛
    // `'dict' object has no attribute 'strip'`（实测踩过）。
    "5": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: options.layoutJson } },
    "6": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: options.negative } },
    "7": { class_type: "EmptyFlux2LatentImage", inputs: { width: options.width, height: options.height, batch_size: 1 } },
    "8": {
      class_type: "KSampler",
      inputs: {
        model: ["1", 0],
        seed: options.seed,
        steps: options.settings.steps,
        cfg: options.settings.cfg,
        sampler_name: options.settings.sampler,
        scheduler: options.settings.scheduler,
        positive: ["5", 0],
        negative: ["6", 0],
        latent_image: ["7", 0],
        denoise: 1
      }
    },
    "9": { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["3", 0] } },
    "10": { class_type: "SaveImage", inputs: { images: ["9", 0], filename_prefix: options.prefix } }
  };
}

/**
 * 切图工作流：按画框把整图切成透明 PNG。
 *
 * 两个抠图方案共用同一份 layout，只是换掉中间那个节点：
 *   · `WeVisOne_Layout_Matte_Slice` —— **指代抠图**：画框裁片 + `caption` 一起喂给
 *     Qwen3-VL 底座，模型按描述定位目标，再由 alpha 解码器出连续蒙版。不需要绿幕。
 *   · `QwenEdit_Layout_Matte_Slice` —— Qwen-Image-2.1 编辑链路，逐框裁片去底。
 *
 * 两者产物结构一致（透明 PNG + manifest），所以界面不用区分。
 *
 * ⚠️ WeVisOne 的 `model` 是**权重目录名字符串**，不是 MODEL 连线；
 * 它自己加载 Qwen3-VL + alpha 解码器，**不需要** UNETLoader / CLIPLoader / VAELoader。
 */
export function buildSliceWorkflow(options: {
  renderFile: string;
  layoutJson: string;
  settings: UiSliceSettings;
  prefix: string;
  seed: number;
  models?: UiModels;
}): Record<string, unknown> {
  const models = options.models ?? DEFAULT_UI_MODELS;
  // 切片节点走 `_validate_draft`，要的是**编辑器草稿**（abs/xyxy + width/height），
  // 不是 compileUiLayout 那种 abs_centralized/yxyx。给错会在 Python 里抛
  // `'dict' object has no attribute 'strip'`。
  const base: Record<string, unknown> = {
    "1": { class_type: "LoadImage", inputs: { image: options.renderFile } }
  };
  if (options.settings.matte === "qwen") {
    base["3"] = { class_type: "UNETLoader", inputs: { unet_name: models.qwenModel, weight_dtype: "default" } };
    base["4"] = { class_type: "CLIPLoader", inputs: { clip_name: models.qwenClip, type: "qwen_image", device: "default" } };
    base["5"] = { class_type: "VAELoader", inputs: { vae_name: models.qwenVae } };
    base["6"] = {
      class_type: "QwenEdit_Layout_Matte_Slice",
      inputs: {
        image: ["1", 0],
        layout: options.layoutJson,
        model: ["3", 0],
        clip: ["4", 0],
        vae: ["5", 0],
        seed: options.seed,
        steps: 25,
        cfg: 1,
        sampler_name: "euler",
        scheduler: "simple",
        instruction: options.settings.instruction,
        negative: options.settings.negative,
        resolution: options.settings.resolution,
        padding: options.settings.padding,
        threshold: options.settings.threshold,
        grow: options.settings.grow,
        prefix: options.prefix,
        skip_backdrop: options.settings.skipBackdrop,
        reject_neighbors: options.settings.rejectNeighbors
      }
    };
  } else {
    base["6"] = {
      class_type: "WeVisOne_Layout_Matte_Slice",
      inputs: {
        image: ["1", 0],
        layout: options.layoutJson,
        model: models.wevisoneModel,
        precision: "bf16",
        threshold: options.settings.threshold,
        grow: options.settings.grow,
        padding: options.settings.padding,
        prefix: options.prefix,
        skip_backdrop: options.settings.skipBackdrop,
        reject_neighbors: options.settings.rejectNeighbors,
        // 关掉「常驻显存」：UI 任务是一次一批，留着白占 4.6 GB 显存。
        keep_loaded: false
      }
    };
  }
  return base;
}

// ── 生图 / 切图的执行体 ────────────────────────────────────────────────

/** 参考图上传到 ComfyUI 的 `input/` 目录（`LoadImage` 只认那里）。 */
async function uploadToComfy(target: UiComfyTarget, filename: string, bytes: Buffer): Promise<string> {
  const form = new FormData();
  form.append("image", new Blob([new Uint8Array(bytes)]), filename);
  form.append("overwrite", "true");
  const headers: Record<string, string> = {};
  if (target.cookies !== "") headers.cookie = target.cookies;
  const response = await fetch(`${target.baseUrl}/upload/image`, { method: "POST", headers, body: form });
  const text = await response.text();
  if (!response.ok) throw new Error(`上传参考图到 ComfyUI 失败（HTTP ${response.status}）：${text.slice(0, 400)}`);
  try {
    const parsed = JSON.parse(text) as { name?: string; subfolder?: string };
    const name = typeof parsed.name === "string" ? parsed.name : filename;
    return parsed.subfolder ? `${parsed.subfolder}/${name}` : name;
  } catch {
    return filename;
  }
}

/**
 * 把 PNG 的宽高读出来（只解析 IHDR，不依赖图像库）。
 */
export function pngSize(bytes: Buffer): { width: number; height: number } {
  if (bytes.length < 24) return { width: 0, height: 0 };
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (!isPng) return { width: 0, height: 0 };
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/**
 * 列出 ComfyUI `output/<subfolder>/` 下的 PNG。
 *
 * 为什么不用 history 的 outputs：`QwenEdit_Layout_Matte_Slice` 在**写 manifest**
 * 那一步会抛 `Object of type ModelPatcherDynamic is not JSON serializable`
 * （上游把 MODEL 对象直接塞进了 json.dump），整条节点被标成 error、`outputs`
 * 是空的，**但 PNG 其实已经逐张写盘了**。只看 history 会白白丢掉已经算好的产物
 * （实测：4 个框切得好好的，history 里一张都看不到）。
 *
 * 输出目录的来源，按可靠性排：
 *   1. 设置里显式填的 `comfyOutputDir`；
 *   2. ComfyUI 自己报的路径（`/system_stats` 的 `args.output_directory`）——
 *      同机时这是**唯一真源**，不用用户手填；
 *   3. 都没拿到就不回退（远端 ComfyUI 的磁盘本机读不到）。
 */
async function comfyOutputRoot(target: UiComfyTarget): Promise<string> {
  const config = await loadConfig();
  const explicit = config.comfyOutputDir.trim();
  if (explicit !== "") return explicit;
  try {
    const response = await fetch(`${target.baseUrl}/system_stats`, { headers: comfyHeaders(target) });
    if (!response.ok) return "";
    const stats = (await response.json()) as Record<string, any>;
    // ComfyUI 的 /system_stats 没有单独的 output 字段，只有启动参数 argv。
    // 显式写了 --output-directory 就以它为准；否则按 base_path 推。
    const argv = stats?.system?.argv;
    if (Array.isArray(argv)) {
      for (let i = 0; i < argv.length; i += 1) {
        const item = String(argv[i]);
        if (item === "--output-directory" && typeof argv[i + 1] === "string") return argv[i + 1];
        if (item.startsWith("--output-directory=")) return item.slice("--output-directory=".length);
      }
    }
    const basePath = stats?.system?.base_path ?? stats?.system?.comfyui_root;
    if (typeof basePath === "string" && basePath.trim() !== "") return join(basePath, "output");
  } catch {
    // 读不到就当作「远端」，不回退。
  }
  return "";
}

async function listComfyOutputPngs(target: UiComfyTarget, prefix: string): Promise<Array<{ filename: string; subfolder: string; type: string }>> {
  const root = await comfyOutputRoot(target);
  if (root === "") return [];
  // ⚠️ 节点包把 prefix 的**最后一段当成文件名前缀**，不是目录名：
  // `prefix="gmm_ui_slice/<job>/<batch>"` 实际落在 `output/gmm_ui_slice/<job>/`
  // 下，文件名是 `<batch>_NN_xxx.png`（实测踩过：按整串拼目录会一个文件都读不到）。
  const parts = prefix.replace(/\\/gu, "/").split("/").filter((part) => part !== "");
  const base = parts.pop() ?? "";
  const dir = join(root, ...parts);
  try {
    const names = await readdir(dir);
    return names
      .filter((name) => name.toLowerCase().endsWith(".png") && (base === "" || name.startsWith(base)))
      .sort()
      .map((name) => ({ filename: name, subfolder: parts.join("/"), type: "output" }));
  } catch {
    return [];
  }
}

/**
 * 跑一次生图。
 *
 * 产物落 `render/<id>.png`，并把**这一次的 layout 快照**一起存进 render ——
 * 用户之后改了框，旧图仍能按它自己的框切片（否则切出来的图会错位）。
 */
export async function startUiGeneration(id: string): Promise<{ started: boolean; reason?: string }> {
  assertJobId(id);
  if (disposed) return { started: false, reason: "插件实例已失效，请重启 DSH 后再试" };
  const job = await readUiJob(id);
  if (job === undefined) throw new Error(`UI 任务不存在：${id}`);
  if (uiBusy(id, job)) return { started: false, reason: "任务正在生成中" };
  if (job.layout.boxes.length === 0) throw new Error("请先在画布上画至少一个框");

  const started = trackUiTask(id, "generate", async () => {
    const target = await comfyTarget();
    const models = await uiModels();
    const layoutJson = compileUiLayout(job.layout);
    const seed = job.settings.seed >= 0 ? job.settings.seed : Math.floor(Math.random() * 0x7fffffff);
    const prefix = `gmm_ui/${job.id}`;
    const beginAt = Date.now();

    await patchUiJob(id, (current) => {
      current.status = "running";
      current.error = undefined;
      current.stages.generate.status = "running";
      current.stages.generate.error = undefined;
      current.stages.generate.at = beginAt;
      uiLog(current, "info", `开始生成：${current.layout.width}×${current.layout.height}，${current.layout.boxes.length} 个画框，种子 ${seed}`);
      return current;
    });

    const workflow = buildMossWorkflow({
      layoutJson,
      width: job.layout.width,
      height: job.layout.height,
      negative: job.settings.negative,
      settings: job.settings,
      seed,
      prefix,
      models
    });
    const promptId = await submitComfyWorkflow(target, workflow);
    await patchUiJob(id, (current) => {
      uiLog(current, "info", `已提交 ComfyUI：${promptId}`);
      return current;
    });

    const entry = await waitComfyHistory(target, promptId, {
      timeoutMs: target.timeoutMs,
      onTick: (seconds) => {
        if (seconds % 30 === 0) {
          void patchUiJob(id, (current) => {
            uiLog(current, "info", `生成中… 已等待 ${seconds} 秒`);
            return current;
          }).catch(() => undefined);
        }
      }
    });

    const images = imagesFromHistory(entry);
    if (images.length === 0) throw new Error("ComfyUI 跑完了，但没有产出图片（检查工作流是否含 SaveImage）");
    const bytes = await downloadComfyImage(target, images[0]);
    const renderId = `r${now().toString(36)}${randomUUID().slice(0, 6)}`;
    const relative = join("render", `${renderId}.png`);
    await writeFile(uiAssetPath(id, relative), bytes);
    const size = pngSize(bytes);
    const elapsedMs = Date.now() - beginAt;

    await patchUiJob(id, (current) => {
      current.renders.push({
        id: renderId,
        file: relative.replace(/\\/gu, "/"),
        bytes: bytes.length,
        width: size.width || current.layout.width,
        height: size.height || current.layout.height,
        layout: current.layout,
        settings: current.settings,
        createdAt: now(),
        promptId,
        elapsedMs
      });
      current.status = "ready";
      current.stages.generate.status = "done";
      current.stages.generate.at = now();
      uiLog(current, "info", `生成完成：${(bytes.length / 1024).toFixed(0)} KB，用时 ${(elapsedMs / 1000).toFixed(1)} 秒`);
      return current;
    });
  });

  if (!started) return { started: false, reason: "任务正在生成中" };
  return { started: true };
}

/**
 * 跑一次切图。
 *
 * 需要一张已生成的整图。切图用**那次生图自己的 layout 快照**，
 * 不是当前画布 —— 两者不一致时切出来会错位。
 */
export async function startUiSlice(id: string, renderId?: string): Promise<{ started: boolean; reason?: string }> {
  assertJobId(id);
  if (disposed) return { started: false, reason: "插件实例已失效，请重启 DSH 后再试" };
  const job = await readUiJob(id);
  if (job === undefined) throw new Error(`UI 任务不存在：${id}`);
  if (uiBusy(id, job)) return { started: false, reason: "任务正在处理中" };
  const render = renderId !== undefined && renderId !== "" ? job.renders.find((r) => r.id === renderId) : job.renders[job.renders.length - 1];
  if (render === undefined) throw new Error("还没有可切的图：先点「生成」");

  const started = trackUiTask(id, "slice", async () => {
    const target = await comfyTarget();
    const models = await uiModels();
    const layoutJson = draftUiLayout(render.layout);
    const beginAt = Date.now();
    const batchId = `s${now().toString(36)}${randomUUID().slice(0, 6)}`;
    const prefix = `gmm_ui_slice/${job.id}/${batchId}`;

    await patchUiJob(id, (current) => {
      current.status = "running";
      current.error = undefined;
      current.stages.slice.status = "running";
      current.stages.slice.error = undefined;
      current.stages.slice.at = beginAt;
      uiLog(current, "info", `开始切图（${current.sliceSettings.matte === "qwen" ? "Qwen-Image-Edit" : "WeVisOne-VL"}）`);
      return current;
    });

    // 先把整图交给 ComfyUI 的 input/，LoadImage 才能读到。
    const renderBytes = await readFile(uiAssetPath(id, render.file));
    const uploaded = await uploadToComfy(target, `${job.id}_${render.id}.png`, renderBytes);

    const workflow = buildSliceWorkflow({
      renderFile: uploaded,
      layoutJson,
      settings: job.sliceSettings,
      prefix,
      seed: Math.floor(Math.random() * 0x7fffffff),
      models
    });
    const promptId = await submitComfyWorkflow(target, workflow);
    // 容忍执行错误：Qwen 切片节点会把 PNG 全部写完，然后**在写 manifest 时**
    // 崩掉（`ModelPatcherDynamic is not JSON serializable`，上游把 MODEL 塞进
    // 了 json.dump）。产物已经在磁盘上，不能因为那一步就整批丢掉。
    const entry = await waitComfyHistory(target, promptId, { timeoutMs: target.timeoutMs, tolerateError: true });

    let images = imagesFromHistory(entry);
    let manifestWarning = "";
    if (images.length === 0) {
      // 回退：扫本机 output/<prefix>/ 把已经落盘的 PNG 捡回来。
      images = await listComfyOutputPngs(target, prefix);
      if (images.length > 0) {
        manifestWarning = "（节点包写 manifest 时出错，产物已从输出目录捡回）";
      }
    }
    if (images.length === 0) {
      const root = await comfyOutputRoot(target);
      const parts = prefix.replace(/\\/gu, "/").split("/").filter((part) => part !== "");
      parts.pop();
      throw new Error(
        "切图跑完了，但没有拿到透明 PNG。" +
          (root === ""
            ? "节点包 moss-layout-local 在写 manifest 时会抛 ModelPatcherDynamic 错误（上游 bug），PNG 其实已经写盘。" +
              "请在 设置 → 游戏素材大师 → 游戏 UI 生成 里填「ComfyUI 输出目录」（例如 F:\\comfyui\\ComfyUI\\output），插件会直接从磁盘把图捡回来。"
            : `已经尝试从 ${join(root, ...parts)} 读图但没读到。请确认该目录就是 ComfyUI 的 output 目录，且这次切图真的产出了 PNG。`)
      );
    }

    const dir = join("slices", batchId);
    await mkdir(uiAssetPath(id, dir), { recursive: true });
    const slices: UiSlice[] = [];
    for (const image of images) {
      const bytes = await downloadComfyImage(target, image);
      const stem = safeUiStem(image.filename.replace(/\.png$/iu, ""));
      const relative = join(dir, `${stem}.png`).replace(/\\/gu, "/");
      await writeFile(uiAssetPath(id, relative), bytes);
      const size = pngSize(bytes);
      slices.push({
        index: slices.length + 1,
        label: stem.includes("text") ? "text" : "object",
        file: relative,
        bytes: bytes.length,
        width: size.width,
        height: size.height
      });
    }

    await patchUiJob(id, (current) => {
      current.batches.push({
        id: batchId,
        renderId: render.id,
        matte: current.sliceSettings.matte,
        settings: current.sliceSettings,
        slices,
        skipped: [],
        createdAt: now(),
        promptId,
        elapsedMs: Date.now() - beginAt
      });
      current.status = "ready";
      current.stages.slice.status = "done";
      current.stages.slice.at = now();
      uiLog(current, "info", `切图完成：${slices.length} 张透明 PNG${manifestWarning}`);
      return current;
    });
  });

  if (!started) return { started: false, reason: "任务正在处理中" };
  return { started: true };
}

/** 导出：把一批切图打成 zip。 */
export async function exportUi(id: string, batchId?: string): Promise<Record<string, unknown>> {
  assertJobId(id);
  const job = await readUiJob(id);
  if (job === undefined) throw new Error(`UI 任务不存在：${id}`);
  const batch = batchId !== undefined && batchId !== "" ? job.batches.find((b) => b.id === batchId) : job.batches[job.batches.length - 1];
  if (batch === undefined) throw new Error("还没有切图产物：先点「切图」");
  const entries = await Promise.all(
    batch.slices.map(async (slice) => ({ path: basename(slice.file), data: await readFile(uiAssetPath(id, slice.file)) }))
  );
  const zip = zipEntries(entries);
  const exportId = `e${now().toString(36)}${randomUUID().slice(0, 6)}`;
  const relative = `out/${exportId}_${safeUiStem(job.name)}.zip`;
  await writeFile(uiAssetPath(id, relative), zip);
  const record = { id: exportId, batchId: batch.id, file: relative, bytes: zip.length, createdAt: now() };
  await patchUiJob(id, (current) => {
    current.exports.push(record);
    uiLog(current, "info", `导出：${relative}（${(zip.length / 1024).toFixed(0)} KB）`);
    return current;
  });
  return { ok: true, file: relative, bytes: zip.length, exportId };
}

/** 设置某个阶段的「通过」状态。 */
export async function setUiApproved(id: string, stage: unknown, approved: boolean): Promise<Record<string, unknown>> {
  assertJobId(id);
  const stages: UiStageKey[] = stage === "layout" || stage === "generate" || stage === "slice" ? [stage] : [...UI_STAGES];
  const job = await patchUiJob(id, (current) => {
    for (const key of stages) {
      current.stages[key].approved = approved;
      current.stages[key].at = now();
    }
    uiLog(current, "info", `${approved ? "通过" : "取消通过"}：${stages.join(" / ")}`);
    return current;
  });
  return uiSnapshot(job, originForLinks());
}

/**
 * 连通性自检：确认 ComfyUI 在线，并**核对本机真的有这几个权重**。
 *
 * 只看 `/system_stats` 不够：ComfyUI 活着但缺 MOSS / WeVisOne 权重时，
 * 要等到真跑一次才报错，而那一跑可能是好几分钟。这里顺手把
 * `/object_info` 里声明的可选值捞出来比对，缺什么直接点名。
 */
export async function testUiConnection(): Promise<Record<string, unknown>> {
  const target = await comfyTarget();
  const models = await uiModels();

  const stats = await fetch(`${target.baseUrl}/system_stats`, { headers: comfyHeaders(target) });
  if (!stats.ok) throw new Error(`连不上 ComfyUI（HTTP ${stats.status}）：${target.baseUrl}`);
  const info = await fetch(`${target.baseUrl}/object_info`, { headers: comfyHeaders(target) });
  if (!info.ok) throw new Error(`ComfyUI 的 /object_info 读不到（HTTP ${info.status}）`);
  const nodes = (await info.json()) as Record<string, any>;

  const optionsOf = (node: string, input: string): string[] => {
    const values = nodes[node]?.input?.required?.[input]?.[0];
    return Array.isArray(values) ? values.filter((v: unknown): v is string => typeof v === "string") : [];
  };

  const missing: string[] = [];
  const check = (label: string, value: string, options: string[]): void => {
    if (options.length === 0) return; // 节点没装时不在这里重复报，下面按节点单独报
    if (!options.includes(value)) missing.push(`${label}：${value}`);
  };
  check("MOSS 模型", models.mossModel, optionsOf("UNETLoader", "unet_name"));
  check("MOSS 文本编码器", models.mossClip, optionsOf("CLIPLoader", "clip_name"));
  check("MOSS VAE", models.mossVae, optionsOf("VAELoader", "vae_name"));
  check("Qwen-Edit 模型", models.qwenModel, optionsOf("UNETLoader", "unet_name"));
  check("Qwen-Edit 文本编码器", models.qwenClip, optionsOf("CLIPLoader", "clip_name"));
  check("Qwen-Edit VAE", models.qwenVae, optionsOf("VAELoader", "vae_name"));
  check("WeVisOne-VL 权重", models.wevisoneModel, optionsOf("WeVisOne_Layout_Matte_Slice", "model"));

  const missingNodes = ["WeVisOne_Layout_Matte_Slice", "QwenEdit_Layout_Matte_Slice"].filter((name) => nodes[name] === undefined);
  if (missingNodes.length > 0) {
    throw new Error(
      `ComfyUI 缺少节点：${missingNodes.join("、")}。请安装 moss-layout-local 节点包（游戏 UI 生图的画框切图依赖它）。`
    );
  }
  if (missing.length > 0) {
    throw new Error(`ComfyUI 里找不到这些权重（去设置 → 游戏素材大师 → 游戏 UI 生成里改文件名）：${missing.join("；")}`);
  }

  return {
    ok: true,
    baseUrl: target.baseUrl,
    models,
    message: "ComfyUI 在线，MOSS-Image / WeVisOne-VL / Qwen-Image-Edit 权重都在"
  };
}

export function uiSnapshot(job: UiJob, origin: string): Record<string, unknown> {
  const base = assetBasePath(`/dsh-game-material-master/ui-assets/${job.id}/`);
  const withUrl = <T extends { file: string }>(entry: T): T & { url: string } => ({
    ...entry,
    url: `${base}${entry.file}`
  });
  return {
    ...job,
    assetBase: base,
    origin,
    busy: uiBusy(job.id, job),
    renders: job.renders.map(withUrl),
    batches: job.batches.map((batch) => ({ ...batch, slices: batch.slices.map(withUrl) })),
    exports: job.exports.map(withUrl)
  };
}

export { UI_LABELS, compileUiLayout, draftUiLayout, expandBox, isBackdropBox, normalizeLayout };
export type { UiLayout };
