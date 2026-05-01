import { CursorEventBuffer } from "./event-buffer.js";
import type { AuditAction, AuditEvent, TaskRecord } from "./types.js";
import type {
  TaskStatusEvent,
  TaskStatusEventKind,
  TaskStatusEventMetadata,
  TerminalTaskEvent,
  TerminalTaskEventStatus,
  TerminalTaskTestSummary,
} from "./task-events.js";

/** Default cap on retained events. Older events are evicted FIFO when exceeded. */
export const DEFAULT_TASK_EVENT_RETENTION = 1000;

export interface TaskEventStreamOptions {
  /**
   * Maximum number of events retained in memory. Older events are evicted
   * FIFO once the cap is reached. Defaults to {@link DEFAULT_TASK_EVENT_RETENTION}.
   * Values <= 0 fall back to the default.
   */
  maxEvents?: number;
}

export interface TaskEventSubscribeOptions {
  /**
   * Return only events with `id > afterId`. Omit (or pass any value < the
   * first retained id) to receive every event still in the buffer.
   */
  afterId?: number;
  /** Restrict to events for a single task id. */
  taskId?: string;
  /** Restrict to events whose task is a child of this parent task id. */
  parentTaskId?: string;
  /** Cap the number of events returned (after filtering). */
  limit?: number;
}

const ACTION_TO_KIND: Partial<Record<AuditAction, TaskStatusEventKind>> = {
  "task.created": "created",
  "task.approved": "approved",
  "task.claimed": "claimed",
  "task.started": "started",
  "task.succeeded": "succeeded",
  "task.failed": "failed",
  "task.canceled": "canceled",
  "task.requeued": "requeued",
  "task.reassigned": "reassigned",
};

const TERMINAL_ACTIONS = new Set<AuditAction>([
  "task.succeeded",
  "task.failed",
  "task.canceled",
]);
const NOTIFIABLE_TERMINAL_STATUSES = new Set<TerminalTaskEventStatus>([
  "succeeded",
  "failed",
  "canceled",
  "blocked",
]);

export type TerminalTaskEventListener = (event: TerminalTaskEvent) => void;

/**
 * In-memory stream of {@link TaskStatusEvent}s with cursor-based replay and a
 * bounded FIFO retention buffer. The stream is fed from the broker's audit-event
 * pipeline (`appendAuditEvent`) so the audit log remains the source of truth;
 * this class only re-projects task-scoped audit events into a slim, operator-safe
 * shape suitable for parent aggregates and dashboards.
 */
export class TaskEventStream {
  private readonly buffer: CursorEventBuffer<TaskStatusEvent>;
  private readonly terminalBuffer: CursorEventBuffer<TerminalTaskEvent>;
  private readonly terminalListeners = new Set<TerminalTaskEventListener>();

  constructor(options: TaskEventStreamOptions = {}) {
    const requested = options.maxEvents;
    const maxEvents =
      requested !== undefined && requested > 0 ? requested : DEFAULT_TASK_EVENT_RETENTION;
    this.buffer = new CursorEventBuffer<TaskStatusEvent>(maxEvents);
    this.terminalBuffer = new CursorEventBuffer<TerminalTaskEvent>(maxEvents);
  }

  /**
   * Project an audit event onto the stream when the audit event corresponds to a
   * task lifecycle transition. No-ops (returns null) for non-task targets, for
   * actions that don't map to a {@link TaskStatusEventKind} (heartbeats,
   * tombstones, wake bookkeeping), or when the supplied task does not match the
   * audit `targetId`.
   */
  push(audit: AuditEvent, task: TaskRecord): TaskStatusEvent | null {
    if (audit.targetType !== "task") return null;
    if (audit.targetId !== task.id) return null;
    const kind = ACTION_TO_KIND[audit.action];
    if (!kind) return null;

    const event = this.buildEvent(kind, audit, task);
    const pushed = this.buffer.push(event);
    if (TERMINAL_ACTIONS.has(audit.action) || isNotifiableTerminalStatus(task.status)) {
      const terminalEvent = this.terminalBuffer.push(this.buildTerminalEvent(task));
      for (const listener of [...this.terminalListeners]) {
        try {
          listener(terminalEvent);
        } catch (error) {
          console.error(
            `[a2a-broker] terminal task event listener threw: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }
    return pushed;
  }

  /**
   * Cursor-based replay over the retained buffer. With no options, returns
   * every event currently retained in chronological order.
   */
  subscribe(options: TaskEventSubscribeOptions = {}): TaskStatusEvent[] {
    return this.buffer.subscribe({
      afterId: options.afterId,
      limit: options.limit,
      matches: (event) => {
        if (options.taskId && event.taskId !== options.taskId) return false;
        if (options.parentTaskId && event.parentTaskId !== options.parentTaskId) return false;
        return true;
      },
    });
  }

  /** Replay compact terminal task events with `id > afterId`. */
  subscribeTerminal(options: { afterId?: number; limit?: number } = {}): TerminalTaskEvent[] {
    return this.terminalBuffer.subscribe({
      afterId: options.afterId,
      limit: options.limit,
    });
  }

  /** Subscribe to new terminal task events. Returns an unsubscribe function. */
  onTerminal(listener: TerminalTaskEventListener): () => void {
    this.terminalListeners.add(listener);
    return () => {
      this.terminalListeners.delete(listener);
    };
  }

  /** Largest event id ever assigned. Useful as the initial cursor. */
  get latestId(): number {
    return this.buffer.latestId;
  }

  /** Largest compact terminal event id ever assigned. Useful as the initial cursor. */
  get latestTerminalId(): number {
    return this.terminalBuffer.latestId;
  }

  /** Number of events currently retained (post FIFO eviction). */
  get size(): number {
    return this.buffer.size;
  }

  private buildEvent(
    kind: TaskStatusEventKind,
    audit: AuditEvent,
    task: TaskRecord,
  ): TaskStatusEvent {
    const metadata: TaskStatusEventMetadata = {};
    if (task.taskOrigin) metadata.taskOrigin = task.taskOrigin;
    if (task.targetNodeId) metadata.targetNodeId = task.targetNodeId;
    if (task.assignedWorkerId) metadata.assignedWorkerId = task.assignedWorkerId;
    if (task.intent) metadata.intent = task.intent;

    const repo = task.payload?.["githubRepo"];
    if (typeof repo === "string" && repo.length > 0) metadata.repoFullName = repo;
    const issue = task.payload?.["githubIssueNumber"];
    if (typeof issue === "number" && Number.isFinite(issue)) metadata.issueNumber = issue;

    const event: TaskStatusEvent = {
      id: this.buffer.allocateId(),
      timestamp: audit.createdAt,
      taskId: task.id,
      status: task.status,
      kind,
      metadata,
    };
    if (task.parentTaskId) event.parentTaskId = task.parentTaskId;
    return event;
  }

  private buildTerminalEvent(task: TaskRecord): TerminalTaskEvent {
    const output = isRecord(task.result?.output) ? task.result.output : {};
    const event: TerminalTaskEvent = {
      id: this.terminalBuffer.allocateId(),
      taskId: task.id,
      status: isNotifiableTerminalStatus(task.status) ? task.status : "succeeded",
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    };
    if (task.completedAt) event.completedAt = task.completedAt;
    if (task.claimedBy) event.worker = task.claimedBy;
    else if (task.assignedWorkerId) event.worker = task.assignedWorkerId;

    const repo = firstString(task.payload?.["githubRepo"], task.payload?.["repo"], output["repo"]);
    if (repo) event.repo = repo;
    const issue = firstFiniteNumber(task.payload?.["githubIssueNumber"], task.payload?.["issue"], output["issue"]);
    if (issue !== undefined) event.issue = issue;

    const prUrl = firstHttpUrl(output["prUrl"], output["pullRequestUrl"], task.payload?.["prUrl"]);
    if (prUrl) event.prUrl = prUrl;
    const doneUrl = firstHttpUrl(output["doneUrl"], task.payload?.["doneUrl"]);
    if (doneUrl) event.doneUrl = doneUrl;
    const blockUrl = firstHttpUrl(output["blockUrl"], task.payload?.["blockUrl"]);
    if (blockUrl) event.blockUrl = blockUrl;

    const testSummary = normalizeTestSummary(output["testSummary"]);
    if (testSummary) event.testSummary = testSummary;
    return event;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0 && value.length <= 200) {
      return value;
    }
  }
  return undefined;
}

function firstFiniteNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function firstHttpUrl(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string" || value.length > 500) continue;
    try {
      const url = new URL(value);
      if (url.protocol === "https:" || url.protocol === "http:") return url.toString();
    } catch {
      // Ignore malformed or non-URL strings.
    }
  }
  return undefined;
}

function isNotifiableTerminalStatus(status: unknown): status is TerminalTaskEventStatus {
  return typeof status === "string" && NOTIFIABLE_TERMINAL_STATUSES.has(status as TerminalTaskEventStatus);
}

function normalizeTestSummary(value: unknown): TerminalTaskTestSummary | undefined {
  if (!isRecord(value)) return undefined;
  const summary: TerminalTaskTestSummary = {};
  const status = value["status"];
  if (status === "passed" || status === "failed" || status === "skipped" || status === "unknown") {
    summary.status = status;
  }
  for (const key of ["total", "passed", "failed", "skipped"] as const) {
    const count = value[key];
    if (typeof count === "number" && Number.isInteger(count) && count >= 0) {
      summary[key] = count;
    }
  }
  const text = value["summary"];
  if (typeof text === "string" && text.length > 0) {
    summary.summary = sanitizeOperatorText(text).slice(0, 300);
  }
  return Object.keys(summary).length > 0 ? summary : undefined;
}

function sanitizeOperatorText(value: string): string {
  return value
    .replace(/\b(?:ghp|gho|ghu|ghs|github_pat|sk|xox[abp])-[-_A-Za-z0-9]+\b/g, "[redacted]")
    .replace(/\b(token|secret|password|api[_-]?key)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/(^|\s)(?:[A-Za-z]:)?\/[\w./-]+/g, "$1[path]")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
