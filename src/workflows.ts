/**
 * 多工作流的保存与切换。
 *
 * 背景：以前设置里只有一个 `customWorkflow` 字符串 —— 想同时留着
 * 「文生图」「带参考图的图生图」「换模型重绘」三份工作流就得来回粘贴覆盖，
 * 而且粘错一次**不报任何错**，只是下一张图的构图全变了。
 *
 * 现在改成一份**有序列表**，存在配置里：
 *
 * ```json
 * { "workflows": [ { "id": "w...", "name": "文生图 · 25 步", "json": "{...}", "builtin": false } ] }
 * ```
 *
 * 约定：
 *   · `activeWorkflowId` 指向当前使用的那一份；它被删掉时自动落到第一份。
 *   · 列表**永远不空**：删到最后一份会补回内置的默认工作流，
 *     否则「生图」会变成一个点了没反应的按钮。
 *   · `id` 是稳定键：图片任务记的是 `workflowId`，不是工作流内容 ——
 *     改了工作流之后老任务会跟着用新版，这正是用户想要的（"我修好了工作流"）。
 */

import { randomUUID } from "node:crypto";

/** 一份保存下来的工作流。 */
export interface SavedWorkflow {
  id: string;
  name: string;
  /** API 格式的工作流 JSON（文本，与 ComfyUI「导出（API）」得到的完全一致）。 */
  json: string;
  /** 内置的默认工作流：可以改名字与内容，但不参与「删光了补一份」之外的自动生成。 */
  builtin?: boolean;
}

/** 工作流名上限：太长的名字在任务面板的下拉框里会截断成一样的前缀。 */
const MAX_NAME = 60;
const MAX_WORKFLOWS = 40;

export function newWorkflowId(): string {
  return `w${Date.now().toString(36)}${randomUUID().slice(0, 6)}`;
}

/** 把用户输入的名字收敛成一个可用的短名。 */
export function normalizeWorkflowName(raw: unknown, fallback = "未命名工作流"): string {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text === "") return fallback;
  return text.slice(0, MAX_NAME);
}

/**
 * 把任意形状的输入收敛成一份合法的工作流列表。
 *
 * 三个约束（每个都对应一类真机坏法）：
 *   1. **不能是空数组** —— 空的列表等于「没有工作流可选」，生图按钮会变成死的。
 *   2. **id 必须唯一** —— 任务靠 id 找工作流，重复 id 会让「切了没反应」。
 *   3. **json 必须是能解析的对象** —— 存进去的时候校验，比等到提交时才 400 好得多。
 */
export function normalizeWorkflows(raw: unknown, fallbackJson: string): SavedWorkflow[] {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set<string>();
  const out: SavedWorkflow[] = [];
  for (const entry of list) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    let id = typeof record.id === "string" ? record.id.trim() : "";
    if (id === "" || seen.has(id)) id = newWorkflowId();
    seen.add(id);
    const json = typeof record.json === "string" ? record.json : "";
    if (!isWorkflowJson(json)) continue;
    out.push({
      id,
      name: normalizeWorkflowName(record.name),
      json,
      builtin: record.builtin === true
    });
    if (out.length >= MAX_WORKFLOWS) break;
  }
  if (out.length === 0) {
    out.push({ id: newWorkflowId(), name: "默认工作流", json: fallbackJson, builtin: true });
  }
  return out;
}

/** 这段文本是不是一份能用的工作流（对象、非数组、非空）。 */
export function isWorkflowJson(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === "") return false;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    return Object.keys(parsed as Record<string, unknown>).length > 0;
  } catch {
    return false;
  }
}

/**
 * 当前该用哪一份。`activeId` 失效时落到第一份，**永远回得出一个值**。
 *
 * 调用点遍布「读配置的每一条路径」（界面角标 / 任务创建 / 生图分发），
 * 所以列表意外为空时也**不能抛**：给一份空壳，让上层照常渲染，
 * 由 `imageProviderBlocker` 去告诉用户「还没有任何工作流」。
 */
export function pickWorkflow(workflows: SavedWorkflow[], activeId: string): SavedWorkflow {
  const list = Array.isArray(workflows) ? workflows : [];
  return list.find((entry) => entry.id === activeId) ?? list[0] ?? { id: "", name: "", json: "" };
}

/** 新增一份（返回新列表与新 id）。 */
export function addWorkflow(
  workflows: SavedWorkflow[],
  input: { name?: unknown; json: string }
): { workflows: SavedWorkflow[]; id: string } {
  const id = newWorkflowId();
  const entry: SavedWorkflow = {
    id,
    name: normalizeWorkflowName(input.name, `工作流 ${workflows.length + 1}`),
    json: input.json
  };
  return { workflows: [...workflows, entry].slice(0, MAX_WORKFLOWS), id };
}

/**
 * 改一份。
 *
 * `json` 传进来时**必须**是合法工作流，否则整个操作被拒绝 ——
 * 静默存下一份坏 JSON 会让之后每一次生图都失败，而失败信息看起来
 * 像是「ComfyUI 出错了」，离真正的原因很远。
 */
export function updateWorkflow(
  workflows: SavedWorkflow[],
  id: string,
  patch: { name?: unknown; json?: string }
): { workflows: SavedWorkflow[]; error?: string } {
  const index = workflows.findIndex((entry) => entry.id === id);
  if (index < 0) return { workflows, error: "找不到这份工作流（可能已被删除）" };
  const next = workflows.slice();
  const current = next[index];
  const updated: SavedWorkflow = { ...current };
  if (patch.name !== undefined) updated.name = normalizeWorkflowName(patch.name, current.name);
  if (patch.json !== undefined) {
    if (!isWorkflowJson(patch.json)) return { workflows, error: "工作流 JSON 解析失败：它必须是一个非空对象（API 格式）" };
    updated.json = patch.json;
  }
  next[index] = updated;
  return { workflows: next };
}

/**
 * 删一份。删光了会补回内置默认工作流（见文件头第 3 条）。
 * 返回新的 activeId —— 删掉的正好是当前那份时，落到第一份。
 */
export function removeWorkflow(
  workflows: SavedWorkflow[],
  id: string,
  fallbackJson: string
): { workflows: SavedWorkflow[]; activeId?: string } {
  const next = workflows.filter((entry) => entry.id !== id);
  if (next.length === 0) {
    const restored: SavedWorkflow[] = [{ id: newWorkflowId(), name: "默认工作流", json: fallbackJson, builtin: true }];
    return { workflows: restored, activeId: restored[0].id };
  }
  return { workflows: next, activeId: next[0].id };
}
