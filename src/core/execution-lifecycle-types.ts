/**
 * Type definitions for broker remote execution lifecycle and result reconciliation.
 *
 * Models the wake-to-work lifecycle from session readiness through completion:
 *   wake_requested → session_ready → payload_delivered → running → result_reported/failed/timeout
 *
 * Built on top of Round 20 wake audit. Execution state is tracked per-run
 * with lease/timeout semantics. Result artifacts are redacted and structured
 * for closeout reconciliation.
 */

// ---------------------------------------------------------------------------
// Execution states
// ---------------------------------------------------------------------------

export type ExecutionStatus =
  | "wake_requested"
  | "session_ready"
  | "payload_delivered"
  | "running"
  | "result_reported"
  | "failed"
  | "timeout"
  | "cancelled";

export const EXECUTION_TRANSITIONS: Record<
  ExecutionStatus,
  ReadonlySet<ExecutionStatus>
> = {
  wake_requested: new Set(["session_ready", "failed", "timeout", "cancelled"]),
  session_ready: new Set(["payload_delivered", "failed", "timeout", "cancelled"]),
  payload_delivered: new Set(["running", "failed", "timeout", "cancelled"]),
  running: new Set(["result_reported", "failed", "timeout", "cancelled"]),
  result_reported: new Set(),
  failed: new Set(["wake_requested", "session_ready"]),
  timeout: new Set(["wake_requested", "session_ready", "cancelled"]),
  cancelled: new Set(),
};

// ---------------------------------------------------------------------------
// Failure / timeout codes
// ---------------------------------------------------------------------------

export type ExecutionFailureCode =
  | "peer_unreachable"
  | "session_expired"
  | "payload_too_large"
  | "delivery_failed"
  | "runtime_error"
  | "result_parse_error"
  | "auth_failed"
  | "rate_limited"
  | "lease_expired"
  | "execution_timeout"
  | "cancelled_by_operator"
  | "duplicate_payload_suppressed"
  | "other";

export const EXECUTION_FAILURE_CODES = [
  "peer_unreachable",
  "session_expired",
  "payload_too_large",
  "delivery_failed",
  "runtime_error",
  "result_parse_error",
  "auth_failed",
  "rate_limited",
  "lease_expired",
  "execution_timeout",
  "cancelled_by_operator",
  "duplicate_payload_suppressed",
  "other",
] as const satisfies readonly ExecutionFailureCode[];

// ---------------------------------------------------------------------------
// Result artifact (redacted, structured)
// ---------------------------------------------------------------------------

export type ResultOutcome = "success" | "partial" | "rejected";

export interface ResultArtifact {
  /** Structured outcome. */
  outcome: ResultOutcome;
  /** Operator-safe summary of the result. No raw prompt or session text. */
  summary: string;
  /** Artifact IDs produced during execution. */
  artifactIds?: string[];
  /** Structured error code if outcome is rejected. */
  errorCode?: ExecutionFailureCode;
}

// ---------------------------------------------------------------------------
// Execution event (replay-safe)
// ---------------------------------------------------------------------------

export type ExecutionEventKind =
  | "exec_wake_requested"
  | "exec_session_ready"
  | "exec_payload_delivered"
  | "exec_running"
  | "exec_result_reported"
  | "exec_failed"
  | "exec_timeout"
  | "exec_cancelled";

export interface ExecutionEvent {
  /** Monotonically increasing event id for cursor-based replay. */
  id: number;
  /** ISO timestamp. */
  timestamp: string;
  /** Execution run id. */
  runId: string;
  /** Target session key. */
  sessionKey: string;
  /** Peer/node id. */
  peerNodeId: string;
  /** Parent task id. */
  parentTaskId?: string;
  /** Event kind. */
  kind: ExecutionEventKind;
  /** Structured metadata. */
  metadata: {
    failureCode?: ExecutionFailureCode;
    /** Lease deadline ISO timestamp (set on session_ready). */
    leaseDeadline?: string;
    /** Result outcome (set on result_reported). */
    outcome?: ResultOutcome;
    /** Duration ms from payload_delivered → result_reported/failed/timeout. */
    executionDurationMs?: number;
    /** Wake audit event id at time of wake request (for cross-ref). */
    wakeEventId?: number;
  };
}

// ---------------------------------------------------------------------------
// Execution run state (tracked outside replay buffer)
// ---------------------------------------------------------------------------

export interface ExecutionRunState {
  /** Unique run id. */
  runId: string;
  /** Target session key. */
  sessionKey: string;
  /** Peer/node id. */
  peerNodeId: string;
  /** Parent task id. */
  parentTaskId?: string;
  /** Current status. */
  status: ExecutionStatus;
  /** Structured failure code. */
  failureCode?: ExecutionFailureCode;
  /** Result artifact (set on result_reported). */
  result?: ResultArtifact;
  /** Lease deadline ISO timestamp. */
  leaseDeadline?: string;
  /** Wake audit event id at request time. */
  wakeEventId?: number;
  /** ISO timestamps. */
  createdAt: string;
  updatedAt: string;
  /** ISO timestamp when payload was delivered. */
  payloadDeliveredAt?: string;
  /** ISO timestamp when execution started. */
  startedAt?: string;
  /** ISO timestamp of terminal state. */
  completedAt?: string;
  /** Execution attempt count (for retry). */
  attempts: number;
  /** Whether a payload has been delivered for this run (idempotency). */
  payloadDelivered: boolean;
}

// ---------------------------------------------------------------------------
// Aggregate closeout summary
// ---------------------------------------------------------------------------

export type ExecutionCloseoutKind = "completed" | "failed" | "timed_out" | "waiting" | "cancelled";

export interface ExecutionCloseoutSummary {
  runId: string;
  sessionKey: string;
  peerNodeId: string;
  kind: ExecutionCloseoutKind;
  /** Number of attempts. */
  attempts: number;
  /** Result artifact if completed. */
  result?: ResultArtifact;
  /** Failure code if failed/timed_out. */
  failureCode?: ExecutionFailureCode;
  /** ISO timestamp of last state change. */
  updatedAt: string;
}
