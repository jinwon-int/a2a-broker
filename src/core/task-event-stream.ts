import { CursorEventBuffer } from "./event-buffer.js";
import type { AuditAction, AuditEvent, TaskRecord } from "./types.js";
import type {
  TaskStatusEvent,
  TaskStatusEventKind,
  TaskStatusEventMetadata,
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
  "task.claimed": "claimed",
  "task.started": "started",
  "task.succeeded": "succeeded",
  "task.failed": "failed",
  "task.canceled": "canceled",
  "task.requeued": "requeued",
  "task.reassigned": "reassigned",
};

/**
 * In-memory stream of {@link TaskStatusEvent}s with cursor-based replay and a
 * bounded FIFO retention buffer. The stream is fed from the broker's audit-event
 * pipeline (`appendAuditEvent`) so the audit log remains the source of truth;
 * this class only re-projects task-scoped audit events into a slim, operator-safe
 * shape suitable for parent aggregates and dashboards.
 */
export class TaskEventStream {
  private readonly buffer: CursorEventBuffer<TaskStatusEvent>;

  constructor(options: TaskEventStreamOptions = {}) {
    const requested = options.maxEvents;
    const maxEvents =
      requested !== undefined && requested > 0 ? requested : DEFAULT_TASK_EVENT_RETENTION;
    this.buffer = new CursorEventBuffer<TaskStatusEvent>(maxEvents);
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
    return this.buffer.push(event);
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

  /** Largest event id ever assigned. Useful as the initial cursor. */
  get latestId(): number {
    return this.buffer.latestId;
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
}
