import type { TaskRecord, TaskStatus } from "./types.js";
import type { TaskStatusEvent } from "./task-events.js";

const TERMINAL_TASK_STATUSES = new Set<TaskStatus>(["succeeded", "failed", "canceled", "blocked"]);
const TERMINAL_TASK_EVENT_KINDS = new Set<TaskStatusEvent["kind"]>(["succeeded", "failed", "canceled"]);
const TERMINAL_TASK_ACK_EVIDENCE = new Set<TerminalTaskOutboxAckEvidence>([
  "operator_visible",
  "operator_confirmed",
  "provider_delivery_receipt",
]);
const URL_KEYS = ["prUrl", "doneUrl", "blockUrl"] as const;
const MAX_SUMMARY_CHARS = 500;
const MAX_ACK_NOTE_CHARS = 240;

export const DEFAULT_TERMINAL_TASK_OUTBOX_RETENTION = 1000;

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
  /** Stable id for external notifier dedupe/replay. */
  id: string;
  kind: TerminalTaskEventKind;
  taskEventId: number;
  payload: TerminalTaskEventPayload;
  createdAt: string;
  /**
   * Receipt-confirmed terminal ack state. This is intentionally stricter than
   * Gateway/provider send success: callers must supply operator-visible or
   * provider delivery receipt evidence before the broker marks this cursor acked.
   */
  ack?: TerminalTaskOutboxAckState;
  /** @deprecated Older snapshots may contain this; new acks use `ack.acknowledgedAt`. */
  deliveredAt?: string;
  attempts: number;
}

export type TerminalTaskOutboxAckEvidence =
  | "operator_visible"
  | "operator_confirmed"
  | "provider_delivery_receipt";

export interface TerminalTaskOutboxAckInput {
  evidence: TerminalTaskOutboxAckEvidence;
  acknowledgedAt?: string;
  receiptId?: string;
  note?: string;
}

export interface TerminalTaskOutboxAckState {
  status: "receipt_confirmed";
  evidence: TerminalTaskOutboxAckEvidence;
  acknowledgedAt: string;
  receiptId?: string;
  note?: string;
}

export interface TerminalTaskOutboxSubscribeOptions {
  afterId?: string;
  limit?: number;
}

export interface TerminalTaskOutboxSubscribeResult {
  events: TerminalTaskOutboxEvent[];
  cursor: string | null;
  reconciledUnacked: number;
}

export interface TerminalTaskEventOutboxOptions {
  /** Maximum retained outbox records. Older records are evicted FIFO. */
  maxEvents?: number;
  /** Previously persisted outbox records to replay after broker restart. */
  events?: TerminalTaskOutboxEvent[];
}

/**
 * Durable-delivery projection for terminal task events. The class owns the
 * compact, operator-safe payload that future webhook/SSE dispatchers should use;
 * callers can replay by stable event id and repeated enqueue is idempotent.
 *
 * This outbox only stores broker-local records. It never calls Telegram (or any
 * other external transport); seoseo/OpenClaw plugin-notifier owns delivery to
 * operator Telegram/main-session surfaces.
 */
export class TerminalTaskEventOutbox {
  private readonly events: TerminalTaskOutboxEvent[] = [];
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];
  private readonly maxEvents: number;
  private readonly maxSeen: number;

  constructor(options: TerminalTaskEventOutboxOptions = {}) {
    this.maxEvents = normalizePositiveInt(options.maxEvents, DEFAULT_TERMINAL_TASK_OUTBOX_RETENTION);
    this.maxSeen = this.maxEvents * 2;
    this.restoreSnapshot(options.events ?? []);
  }

  enqueue(taskEvent: TaskStatusEvent, task: TaskRecord): TerminalTaskOutboxEvent | null {
    if (!TERMINAL_TASK_EVENT_KINDS.has(taskEvent.kind)) return null;
    if (!isTerminalStatus(task.status)) return null;
    if (taskEvent.status !== task.status) return null;
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
    this.markSeen(id);
    this.enforceRetention();
    return event;
  }

  subscribe(options: TerminalTaskOutboxSubscribeOptions = {}): TerminalTaskOutboxEvent[] {
    return this.forwardEvents(options);
  }

  /**
   * Subscribe while also returning a safe cursor and retrying retained records
   * that are still missing receipt-confirmed ack evidence at/before afterId.
   *
   * This closes the send/crash gap: a notifier can advance its own fetch cursor
   * only for newly returned records, while unacknowledged records before the
   * cursor are replayed until acknowledge() receives receipt evidence.
   */
  subscribeWithCursor(options: TerminalTaskOutboxSubscribeOptions = {}): TerminalTaskOutboxSubscribeResult {
    const afterIndex = this.indexOfId(options.afterId);
    const replayStart = options.afterId && afterIndex < 0 ? 0 : afterIndex + 1;
    const unacknowledgedBeforeCursor = afterIndex >= 0
      ? this.events.slice(0, afterIndex + 1).filter((event) => !isReceiptConfirmed(event))
      : [];
    const newEvents = this.events.slice(replayStart);
    const replay = [...unacknowledgedBeforeCursor, ...newEvents];
    const events = this.applyLimit(replay, options.limit);
    return {
      events,
      cursor: this.nextCursor(options.afterId, afterIndex, events),
      reconciledUnacked: events.filter((event) => {
        const index = this.events.findIndex((candidate) => candidate.id === event.id);
        return index >= 0 && index <= afterIndex && !isReceiptConfirmed(event);
      }).length,
    };
  }

  reconcile(options: TerminalTaskOutboxSubscribeOptions = {}): TerminalTaskOutboxSubscribeResult {
    return this.subscribeWithCursor(options);
  }

  /**
   * Mark an outbox record as acknowledged by an external notifier. The record
   * remains replayable until normal retention evicts it, and the stable id keeps
   * repeated enqueue/ack operations idempotent.
   */
  acknowledge(id: string, receipt: TerminalTaskOutboxAckInput): TerminalTaskOutboxEvent | null {
    if (!receipt || !isTerminalTaskOutboxAckEvidence(receipt.evidence)) {
      throw new TypeError("terminal outbox ack requires receipt/operator-visible evidence");
    }
    const event = this.events.find((candidate) => candidate.id === id);
    if (!event) return null;
    event.ack = buildAckState(receipt);
    delete event.deliveredAt;
    event.attempts += 1;
    return event;
  }

  get size(): number {
    return this.events.length;
  }

  /** Return a persistence-safe copy of retained records. */
  snapshot(): TerminalTaskOutboxEvent[] {
    return structuredClone(this.events);
  }

  /** Merge previously persisted records without duplicating stable ids. */
  restoreSnapshot(events: TerminalTaskOutboxEvent[]): void {
    for (const event of events) {
      this.restore(event);
    }
    this.enforceRetention();
  }

  private restore(event: TerminalTaskOutboxEvent): void {
    if (this.seen.has(event.id)) return;
    const restored = structuredClone(event);
    if (!restored.ack && restored.deliveredAt) {
      restored.ack = {
        status: "receipt_confirmed",
        evidence: "operator_visible",
        acknowledgedAt: restored.deliveredAt,
        note: "migrated legacy deliveredAt ack",
      };
    }
    this.events.push(restored);
    this.markSeen(event.id);
  }

  private forwardEvents(options: TerminalTaskOutboxSubscribeOptions): TerminalTaskOutboxEvent[] {
    const start = this.indexAfter(options.afterId);
    return this.applyLimit(this.events.slice(start), options.limit);
  }

  private indexAfter(afterId: string | undefined): number {
    if (!afterId) return 0;
    const index = this.indexOfId(afterId);
    return index >= 0 ? index + 1 : 0;
  }

  private indexOfId(id: string | undefined): number {
    return id ? this.events.findIndex((event) => event.id === id) : -1;
  }

  private applyLimit(events: TerminalTaskOutboxEvent[], limit: number | undefined): TerminalTaskOutboxEvent[] {
    return typeof limit === "number" && limit >= 0 ? events.slice(0, limit) : events;
  }

  private nextCursor(afterId: string | undefined, afterIndex: number, events: TerminalTaskOutboxEvent[]): string | null {
    if (!afterId || afterIndex < 0) return events.at(-1)?.id ?? null;
    const newestReturned = events
      .map((event) => this.events.findIndex((candidate) => candidate.id === event.id))
      .filter((index) => index > afterIndex)
      .at(-1);
    return typeof newestReturned === "number" ? this.events[newestReturned]!.id : afterId;
  }

  private markSeen(id: string): void {
    this.seen.add(id);
    this.seenOrder.push(id);
    while (this.seenOrder.length > this.maxSeen) {
      const evicted = this.seenOrder.shift();
      if (evicted) this.seen.delete(evicted);
    }
  }

  private enforceRetention(): void {
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
  }
}

export function isTerminalStatus(status: TaskStatus): status is TerminalTaskStatus {
  return TERMINAL_TASK_STATUSES.has(status);
}

export function isTerminalTaskOutboxAckEvidence(value: unknown): value is TerminalTaskOutboxAckEvidence {
  return typeof value === "string" && TERMINAL_TASK_ACK_EVIDENCE.has(value as TerminalTaskOutboxAckEvidence);
}

export function formatTerminalTaskEventId(taskId: string, status: TaskStatus, completedAt: string): string {
  return `terminal:${encodeURIComponent(taskId)}:${status}:${encodeURIComponent(completedAt)}`;
}

function isReceiptConfirmed(event: TerminalTaskOutboxEvent): boolean {
  return event.ack?.status === "receipt_confirmed" || Boolean(event.deliveredAt);
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
    const value = firstSafeHttpUrl(output[key], task.payload[key]);
    if (value) payload[key] = value;
  }
  const summary = task.result?.summary ?? task.result?.note ?? task.error?.message;
  const safeSummary = sanitizeSummary(summary);
  if (safeSummary) payload.testSummary = safeSummary;
  if (task.completedAt) payload.completedAt = task.completedAt;
  return payload;
}

function firstSafeHttpUrl(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    try {
      const url = new URL(value);
      if (url.protocol === "https:" || url.protocol === "http:") return value;
    } catch {
      // Ignore malformed or local path evidence.
    }
  }
  return undefined;
}

function sanitizeSummary(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed
    .replace(/\b(?:ghp|gho|ghu|ghs|github_pat|sk|xox[abp])-[-_A-Za-z0-9]+\b/g, "[redacted]")
    .replace(/\b(token|secret|password|api[_-]?key)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/(^|\s)(?:[A-Za-z]:)?\/[\w./-]+/g, "$1[path]")
    .replace(/\s+/g, " ")
    .slice(0, MAX_SUMMARY_CHARS);
}

function buildAckState(receipt: TerminalTaskOutboxAckInput): TerminalTaskOutboxAckState {
  const ack: TerminalTaskOutboxAckState = {
    status: "receipt_confirmed",
    evidence: receipt.evidence,
    acknowledgedAt: receipt.acknowledgedAt ?? new Date().toISOString(),
  };
  const receiptId = sanitizeAckText(receipt.receiptId, MAX_ACK_NOTE_CHARS);
  if (receiptId) ack.receiptId = receiptId;
  const note = sanitizeAckText(receipt.note, MAX_ACK_NOTE_CHARS);
  if (note) ack.note = note;
  return ack;
}

function sanitizeAckText(value: unknown, maxChars: number): string | undefined {
  const sanitized = sanitizeSummary(value);
  if (!sanitized) return undefined;
  return sanitized.slice(0, maxChars);
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}
