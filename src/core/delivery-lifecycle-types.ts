/**
 * Type definitions for broker status/result delivery lifecycle (Round 22).
 *
 * Models the post-execution delivery path:
 *   result_ready → delivery_pending → delivering → delivered → acked
 *                                                        ↘ failed → retrying → timed_out
 *
 * Separates execution concern (Round 21) from delivery concern:
 * - ExecutionManager tracks "did the remote node do the work?"
 * - DeliveryManager tracks "did the originator receive the result?"
 *
 * Each delivery is owner-scoped and payload-redacted. Only structured
 * DeliveryArtifact (summary + artifact IDs) is stored — no raw prompt
 * or session text.
 */

// ---------------------------------------------------------------------------
// Delivery states
// ---------------------------------------------------------------------------

export type DeliveryStatus =
  | "result_ready"
  | "delivery_pending"
  | "delivering"
  | "delivered"
  | "acked"
  | "failed"
  | "retrying"
  | "timed_out";

export const DELIVERY_TRANSITIONS: Record<
  DeliveryStatus,
  ReadonlySet<DeliveryStatus>
> = {
  result_ready: new Set(["delivery_pending", "failed", "timed_out"]),
  delivery_pending: new Set(["delivering", "retrying", "failed", "timed_out"]),
  delivering: new Set(["delivered", "failed", "timed_out"]),
  delivered: new Set(["acked", "timed_out"]),
  acked: new Set(),
  failed: new Set(["retrying", "timed_out"]),
  retrying: new Set(["delivery_pending", "failed", "timed_out"]),
  timed_out: new Set(["retrying"]),
};

// ---------------------------------------------------------------------------
// Failure / timeout codes
// ---------------------------------------------------------------------------

export type DeliveryFailureCode =
  | "originator_unreachable"
  | "channel_unavailable"
  | "payload_too_large"
  | "delivery_timeout"
  | "ack_timeout"
  | "rate_limited"
  | "auth_failed"
  | "duplicate_delivery_suppressed"
  | "max_retries_exceeded"
  | "serialization_error"
  | "other";

export const DELIVERY_FAILURE_CODES = [
  "originator_unreachable",
  "channel_unavailable",
  "payload_too_large",
  "delivery_timeout",
  "ack_timeout",
  "rate_limited",
  "auth_failed",
  "duplicate_delivery_suppressed",
  "max_retries_exceeded",
  "serialization_error",
  "other",
] as const satisfies readonly DeliveryFailureCode[];

// ---------------------------------------------------------------------------
// Delivery artifact (redacted, structured)
// ---------------------------------------------------------------------------

export interface DeliveryArtifact {
  /** Originating execution run id. */
  runId: string;
  /** Outcome from execution. */
  outcome: "success" | "partial" | "rejected";
  /** Operator-safe summary. No raw prompt or session text. */
  summary: string;
  /** Artifact IDs produced during execution. */
  artifactIds?: string[];
  /** Structured error code if execution was rejected. */
  executionErrorCode?: string;
}

// ---------------------------------------------------------------------------
// Delivery event (replay-safe)
// ---------------------------------------------------------------------------

export type DeliveryEventKind =
  | "del_result_ready"
  | "del_pending"
  | "del_delivering"
  | "del_delivered"
  | "del_acked"
  | "del_failed"
  | "del_retrying"
  | "del_timed_out";

export interface DeliveryEvent {
  /** Monotonically increasing event id for cursor-based replay. */
  id: number;
  /** ISO timestamp. */
  timestamp: string;
  /** Unique delivery id. */
  deliveryId: string;
  /** Originating execution run id. */
  runId: string;
  /** Target session key (originator). */
  originatorSessionKey: string;
  /** Peer/node id of originator. */
  originatorNodeId: string;
  /** Parent task id. */
  parentTaskId?: string;
  /** Event kind. */
  kind: DeliveryEventKind;
  /** Structured metadata. */
  metadata: {
    failureCode?: DeliveryFailureCode;
    /** Delivery attempt number (incremented on each retry cycle). */
    attempt: number;
    /** Max retries configured for this delivery. */
    maxRetries?: number;
    /** Delivery deadline ISO timestamp. */
    deliveryDeadline?: string;
    /** ACK deadline ISO timestamp. */
    ackDeadline?: string;
    /** Duration ms from delivering → delivered/failed. */
    deliveryDurationMs?: number;
    /** Duration ms from delivered → acked/timeout. */
    ackDurationMs?: number;
    /** Channel used for delivery. */
    channel?: string;
  };
}

// ---------------------------------------------------------------------------
// Delivery state (tracked per delivery)
// ---------------------------------------------------------------------------

export interface DeliveryState {
  /** Unique delivery id. */
  deliveryId: string;
  /** Originating execution run id. */
  runId: string;
  /** Target session key (originator). */
  originatorSessionKey: string;
  /** Peer/node id of originator. */
  originatorNodeId: string;
  /** Parent task id. */
  parentTaskId?: string;
  /** Current delivery status. */
  status: DeliveryStatus;
  /** Structured artifact to deliver (redacted). */
  artifact: DeliveryArtifact;
  /** Failure code if in failed/timed_out state. */
  failureCode?: DeliveryFailureCode;
  /** Current delivery attempt (starts at 1). */
  attempt: number;
  /** Maximum retry attempts. */
  maxRetries: number;
  /** Delivery deadline ISO timestamp. */
  deliveryDeadline?: string;
  /** ACK deadline ISO timestamp (set after delivered). */
  ackDeadline?: string;
  /** Channel used for delivery. */
  channel?: string;
  /** Whether delivery has been acknowledged. */
  acknowledged: boolean;
  /** Whether this is a duplicate (suppressed). */
  duplicateSuppressed: boolean;
  /** ISO timestamps. */
  createdAt: string;
  updatedAt: string;
  /** ISO timestamp when delivery attempt started. */
  deliveryStartedAt?: string;
  /** ISO timestamp when delivery succeeded. */
  deliveredAt?: string;
  /** ISO timestamp when ack was received. */
  ackedAt?: string;
  /** ISO timestamp of terminal state. */
  completedAt?: string;
}

// ---------------------------------------------------------------------------
// Delivery closeout summary
// ---------------------------------------------------------------------------

export type DeliveryCloseoutKind =
  | "acked"
  | "delivered_unacked"
  | "failed"
  | "timed_out"
  | "max_retries_exceeded"
  | "pending"
  | "duplicate_suppressed";

export interface DeliveryCloseoutSummary {
  deliveryId: string;
  runId: string;
  originatorSessionKey: string;
  originatorNodeId: string;
  kind: DeliveryCloseoutKind;
  attempts: number;
  artifact?: DeliveryArtifact;
  failureCode?: DeliveryFailureCode;
  channel?: string;
  updatedAt: string;
}
