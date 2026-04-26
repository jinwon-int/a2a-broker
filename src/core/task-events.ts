import type { A2AExchangeIntent, TaskOrigin, TaskStatus } from "./types.js";

/**
 * Task lifecycle event kinds emitted by the broker. Mirrors the task-scoped
 * audit actions (`task.created`, `task.claimed`, …) but is scoped to status
 * transitions a downstream consumer cares about. Intentionally narrower than
 * the audit-event vocabulary: heartbeats, tombstones, and wake bookkeeping are
 * excluded so subscribers see one event per visible state change.
 */
export type TaskStatusEventKind =
  | "created"
  | "approved"
  | "claimed"
  | "started"
  | "succeeded"
  | "failed"
  | "canceled"
  | "requeued"
  | "reassigned";

/**
 * Operator-safe metadata projected onto a task status event. By design this
 * struct excludes the raw task message, payload, and any session/prompt body
 * so subscribers can be wired to dashboards or upstream parents without
 * re-litigating the broker's redaction rules. GitHub-origin tasks expose
 * `repoFullName` / `issueNumber` (sourced from the ingestion payload) so an
 * operator can correlate the event to a triage queue without reading the
 * payload directly.
 */
export interface TaskStatusEventMetadata {
  taskOrigin?: TaskOrigin;
  targetNodeId?: string;
  assignedWorkerId?: string;
  intent?: A2AExchangeIntent;
  repoFullName?: string;
  issueNumber?: number;
}

/**
 * A slim, operator-safe projection of a task state transition. Each event
 * carries a monotonically increasing `id` for cursor-based replay and the
 * `status` the task moved into when the event was emitted.
 */
export interface TaskStatusEvent {
  /** Monotonically increasing event id for cursor-based replay. */
  id: number;
  /** ISO timestamp of the source audit event. */
  timestamp: string;
  /** The task that changed. */
  taskId: string;
  /** Parent task id if this is a child task. Omitted for top-level tasks. */
  parentTaskId?: string;
  /** The task's status at the moment the event was emitted. */
  status: TaskStatus;
  /** The event kind (mirrors the audit action but task-scoped). */
  kind: TaskStatusEventKind;
  /** Operator-safe metadata. Never contains raw prompts or session text. */
  metadata: TaskStatusEventMetadata;
}
