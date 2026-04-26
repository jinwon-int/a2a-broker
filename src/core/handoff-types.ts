/**
 * Handoff scenario types for A2A broker (issue #69).
 *
 * Covers S1–S5 handoff scenarios and a recovery ledger for tracking
 * handoff attempts, failures, and resolutions.
 */

// ---------------------------------------------------------------------------
// Handoff scenario identifiers
// ---------------------------------------------------------------------------

/** Canonical handoff scenario identifiers. */
export type HandoffScenarioId =
  | "S1_normal"
  | "S2_receiver_unavailable"
  | "S3_sender_crash"
  | "S4_duplicate"
  | "S5_recovery";

/** Human-readable labels. */
export const HANDOFF_SCENARIO_LABELS: Record<HandoffScenarioId, string> = {
  S1_normal: "S1: Normal handoff",
  S2_receiver_unavailable: "S2: Receiver unavailable",
  S3_sender_crash: "S3: Sender crash mid-handoff",
  S4_duplicate: "S4: Duplicate handoff (idempotency)",
  S5_recovery: "S5: Recovery handoff (retry)",
};

/** Expected outcome categories for each scenario. */
export type HandoffOutcome =
  | "delivered"
  | "rejected"
  | "timed_out"
  | "partial"
  | "deduplicated"
  | "retried"
  | "failed";

// ---------------------------------------------------------------------------
// Handoff state machine
// ---------------------------------------------------------------------------

export type HandoffPhase =
  | "initiated"
  | "dispatched"
  | "acknowledged"
  | "completed"
  | "failed"
  | "timed_out"
  | "canceled";

export type HandoffFailureKind =
  | "receiver_unreachable"
  | "receiver_rejected"
  | "sender_crash"
  | "timeout"
  | "serialization_error"
  | "transport_error"
  | "policy_violation"
  | "duplicate_suppressed";

// ---------------------------------------------------------------------------
// Handoff record (individual attempt)
// ---------------------------------------------------------------------------

export interface HandoffRecord {
  /** Unique id for this handoff attempt. */
  id: string;
  /** Which scenario bucket this attempt falls into. */
  scenarioId: HandoffScenarioId;
  /** Source party (sender). */
  senderNodeId: string;
  /** Source session or exchange. */
  senderSessionId?: string;
  /** Target party (receiver). */
  receiverNodeId: string;
  /** Target session. */
  receiverSessionId?: string;
  /** Task or exchange being handed off. */
  taskId?: string;
  exchangeId?: string;
  /** Current phase. */
  phase: HandoffPhase;
  /** Monotonic sequence within this handoff. */
  seq: number;
  /** Timestamps. */
  initiatedAt: string;
  dispatchedAt?: string;
  acknowledgedAt?: string;
  completedAt?: string;
  failedAt?: string;
  /** Failure details if applicable. */
  failureKind?: HandoffFailureKind;
  failureMessage?: string;
  /** Idempotency key — same key = same logical handoff. */
  idempotencyKey: string;
  /** For S5: reference to the original failed handoff. */
  recoveryOf?: string;
  /** Partial payload for crash recovery (S3). */
  partialSnapshot?: string;
  /** Arbitrary metadata. */
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Scenario classification input
// ---------------------------------------------------------------------------

export interface HandoffContext {
  senderNodeId: string;
  receiverNodeId: string;
  senderSessionId?: string;
  receiverSessionId?: string;
  taskId?: string;
  exchangeId?: string;
  idempotencyKey: string;
  /** Previous attempt being retried. */
  recoveryOf?: string;
  /** Is the receiver currently reachable? */
  receiverReachable?: boolean;
  /** Did the sender crash during a previous attempt? */
  senderCrashed?: boolean;
  /** Has this idempotency key been seen before? */
  duplicateOf?: string;
  /** Previous failure kind, if retrying. */
  previousFailureKind?: HandoffFailureKind;
}

// ---------------------------------------------------------------------------
// Recovery ledger
// ---------------------------------------------------------------------------

export interface RecoveryLedgerEntry {
  /** The handoff record id. */
  handoffId: string;
  /** Scenario classification. */
  scenarioId: HandoffScenarioId;
  /** Final outcome. */
  outcome: HandoffOutcome;
  /** Number of retry attempts (0 = first attempt). */
  attemptNumber: number;
  /** Wall-clock duration in ms. */
  durationMs: number;
  /** Failure kind if the outcome was not delivered. */
  failureKind?: HandoffFailureKind;
  /** Timestamp when this entry was sealed. */
  sealedAt: string;
}

export interface RecoveryLedgerSummary {
  totalAttempts: number;
  byScenario: Record<HandoffScenarioId, number>;
  byOutcome: Record<HandoffOutcome, number>;
  /** Current active (non-terminal) handoffs. */
  activeCount: number;
  /** Handoffs that escalated to S5 recovery. */
  recoveryCount: number;
  /** Average recovery duration in ms. */
  avgRecoveryDurationMs: number;
}
