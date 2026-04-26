/**
 * Type definitions for broker wake audit and durable session resume.
 *
 * Models the lifecycle of remote OpenClaw session wake/resume requests:
 *   wake_requested → wake_accepted → resumed/launched → replied/failed
 *
 * All events are operator-safe: no raw prompt, session transcript, or
 * free-form log content. Only structured metadata for downstream consumers
 * (plugin adapter, OpenClaw handoff surface, dashboards).
 */

// ---------------------------------------------------------------------------
// Wake event kinds
// ---------------------------------------------------------------------------

export type WakeEventKind =
  | "wake_requested"
  | "wake_accepted"
  | "wake_resumed"
  | "wake_launched"
  | "wake_replied"
  | "wake_failed"
  | "wake_unreachable"
  | "wake_duplicate_suppressed";

// ---------------------------------------------------------------------------
// Wake status (tracked per-session for idempotency)
// ---------------------------------------------------------------------------

export type WakeStatus =
  | "requested"
  | "accepted"
  | "resumed"
  | "launched"
  | "replied"
  | "failed"
  | "unreachable"
  | "duplicate_suppressed";

export const WAKE_TRANSITIONS: Record<
  WakeStatus,
  ReadonlySet<WakeStatus>
> = {
  requested: new Set(["accepted", "failed", "unreachable", "duplicate_suppressed"]),
  accepted: new Set(["resumed", "launched", "failed", "unreachable"]),
  resumed: new Set(["replied", "failed"]),
  launched: new Set(["replied", "failed"]),
  replied: new Set(),
  failed: new Set(["requested", "accepted"]),
  unreachable: new Set(["requested", "accepted"]),
  duplicate_suppressed: new Set(),
};

// ---------------------------------------------------------------------------
// Failure reason codes (structured only)
// ---------------------------------------------------------------------------

export type WakeFailureCode =
  | "peer_unreachable"
  | "session_expired"
  | "auth_failed"
  | "rate_limited"
  | "resume_cursor_gap"
  | "runtime_error"
  | "timeout"
  | "duplicate_wake"
  | "other";

export const WAKE_FAILURE_CODES = [
  "peer_unreachable",
  "session_expired",
  "auth_failed",
  "rate_limited",
  "resume_cursor_gap",
  "runtime_error",
  "timeout",
  "duplicate_wake",
  "other",
] as const satisfies readonly WakeFailureCode[];

// ---------------------------------------------------------------------------
// Wake audit event (replay-safe)
// ---------------------------------------------------------------------------

export interface WakeEvent {
  /** Monotonically increasing event id for cursor-based replay. */
  id: number;
  /** ISO timestamp. */
  timestamp: string;
  /** Target session key being woken. */
  sessionKey: string;
  /** Peer/node id that owns the target session. */
  peerNodeId: string;
  /** Runtime run id (if assigned). */
  runId?: string;
  /** Parent task id (if this wake is task-scoped). */
  parentTaskId?: string;
  /** Event kind. */
  kind: WakeEventKind;
  /** Structured metadata — never raw prompt/session text. */
  metadata: {
    /** Replay cursor at wake time (for resume continuity). */
    replayCursor?: number;
    /** Structured failure code when kind is wake_failed/wake_unreachable. */
    failureCode?: WakeFailureCode;
    /** Previous event id (for duplicate detection). */
    dedupEventId?: number;
    /** Response duration ms (from accepted → replied/failed). */
    durationMs?: number;
  };
}

// ---------------------------------------------------------------------------
// Wake session state (tracked outside replay buffer for idempotency)
// ---------------------------------------------------------------------------

export interface WakeSessionState {
  /** Session key. */
  sessionKey: string;
  /** Current status in the wake lifecycle. */
  status: WakeStatus;
  /** Peer/node id. */
  peerNodeId: string;
  /** Runtime run id (once assigned). */
  runId?: string;
  /** Parent task id (if task-scoped). */
  parentTaskId?: string;
  /** Last known replay cursor. */
  replayCursor?: number;
  /** ISO timestamp of last status change. */
  updatedAt: string;
  /** ISO timestamp of initial wake request. */
  requestedAt: string;
  /** ISO timestamp when wake was accepted. */
  acceptedAt?: string;
  /** ISO timestamp when session resumed/launched. */
  startedAt?: string;
  /** ISO timestamp when terminal reply received. */
  completedAt?: string;
  /** Structured failure code. */
  failureCode?: WakeFailureCode;
  /** Wake attempt count (incremented on retry). */
  wakeAttempts: number;
}
