import type { TaskRecord, TaskStatus } from "./types.js";
import type { TaskStatusEvent } from "./task-events.js";

const TERMINAL_TASK_STATUSES = new Set<TaskStatus>(["succeeded", "failed", "canceled", "blocked"]);
const URL_KEYS = ["prUrl", "doneUrl", "blockUrl"] as const;
const MAX_SUMMARY_CHARS = 500;

export type TerminalTaskEventKind = "task.terminal";
export type TerminalTaskStatus = Extract<TaskStatus, "succeeded" | "failed" | "canceled" | "blocked">;

export interface TerminalTaskEventPayload {
  taskId: string;
  status: TerminalTaskStatus;
  worker?: string;
  repo?: string;
  issue?: number;
  prUrl?: string;
  doneUrl?: string;
  blockUrl?: string;
  testSummary?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface TerminalTaskOutboxEvent {
  /** Stable id for webhook delivery dedupe/replay. */
  id: string;
  kind: TerminalTaskEventKind;
  taskEventId: number;
  payload: TerminalTaskEventPayload;
  createdAt: string;
  deliveredAt?: string;
  attempts: number;
}

export interface TerminalTaskOutboxSubscribeOptions {
  afterId?: string;
  limit?: number;
}

/**
 * Durable-delivery projection for terminal task events. The class owns the
 * compact, operator-safe payload that future webhook/SSE dispatchers should use;
 * callers can replay by stable event id and repeated enqueue is idempotent.
 */
export class TerminalTaskEventOutbox {
  private readonly events: TerminalTaskOutboxEvent[] = [];
  private readonly seen = new Set<string>();

  enqueue(taskEvent: TaskStatusEvent, task: TaskRecord): TerminalTaskOutboxEvent | null {
    if (!isTerminalStatus(task.status)) return null;
    if (taskEvent.taskId !== task.id) return null;

    const id = formatTerminalTaskEventId(task.id, task.status, task.completedAt ?? task.updatedAt);
    const existing = this.events.find((event) => event.id === id);
    if (existing) return existing;
    if (this.seen.has(id)) return null;

    const event: TerminalTaskOutboxEvent = {
      id,
      kind: "task.terminal",
      taskEventId: taskEvent.id,
      payload: buildTerminalTaskPayload(task),
      createdAt: taskEvent.timestamp,
      attempts: 0,
    };
    this.events.push(event);
    this.seen.add(id);
    return event;
  }

  subscribe(options: TerminalTaskOutboxSubscribeOptions = {}): TerminalTaskOutboxEvent[] {
    let start = 0;
    if (options.afterId) {
      const index = this.events.findIndex((event) => event.id === options.afterId);
      start = index >= 0 ? index + 1 : 0;
    }
    const events = this.events.slice(start);
    return typeof options.limit === "number" && options.limit >= 0
      ? events.slice(0, options.limit)
      : events;
  }

  get size(): number {
    return this.events.length;
  }
}

export function isTerminalStatus(status: TaskStatus): status is TerminalTaskStatus {
  return TERMINAL_TASK_STATUSES.has(status);
}

export function formatTerminalTaskEventId(taskId: string, status: TaskStatus, completedAt: string): string {
  return `terminal:${encodeURIComponent(taskId)}:${status}:${encodeURIComponent(completedAt)}`;
}

function buildTerminalTaskPayload(task: TaskRecord): TerminalTaskEventPayload {
  const output = task.result?.output ?? {};
  const payload: TerminalTaskEventPayload = {
    taskId: task.id,
    status: task.status as TerminalTaskStatus,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
  if (task.claimedBy) payload.worker = task.claimedBy;
  else if (task.assignedWorkerId) payload.worker = task.assignedWorkerId;
  const repo = task.payload["githubRepo"];
  if (typeof repo === "string" && repo.length > 0) payload.repo = repo;
  const issue = task.payload["githubIssueNumber"];
  if (typeof issue === "number" && Number.isFinite(issue)) payload.issue = issue;
  for (const key of URL_KEYS) {
    const value = output[key];
    if (typeof value === "string" && isSafeHttpUrl(value)) payload[key] = value;
  }
  const summary = task.result?.summary ?? task.result?.note ?? task.error?.message;
  const safeSummary = sanitizeSummary(summary);
  if (safeSummary) payload.testSummary = safeSummary;
  if (task.completedAt) payload.completedAt = task.completedAt;
  return payload;
}

function isSafeHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function sanitizeSummary(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed
    .replace(/(^|\s)(?:[A-Za-z]:)?\/[\w./-]+/g, "$1[path]")
    .replace(/\s+/g, " ")
    .slice(0, MAX_SUMMARY_CHARS);
}
