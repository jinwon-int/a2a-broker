/**
 * Terminal Brief state machine — formal lifecycle for terminal event delivery
 * and receipt confirmation.
 *
 * This module defines the canonical states, transitions, and guards for the
 * Terminal Brief lifecycle, from initial accepted-through-outbox through
 * provider send → operator visibility → receipt confirmation.
 *
 * Design follows the same pattern as {@link ExecutionStatus} in
 * `execution-lifecycle-types.ts` and {@link DeliveryStatus} in
 * `delivery-lifecycle-types.ts`.
 *
 * Lifecycle:
 *   accepted → started → produced → provider_sent → provider_accepted
 *       ↘                                                      ↘
 *         failed ← ← ← ← ← ← ← ← ← ← ← ← ← ← ← ← ← ← ← ← ← ←
 *       ↘                                           operator_visible / current_session_visible
 *         timed_out / stale                                           ↘
 *                                                                 receipt_confirmed
 *
 * Safety properties:
 * - provider_sent / provider_accepted are NOT terminal ACK evidence.
 * - Only current_session_visible, operator_visible, operator_confirmed,
 *   or provider_delivery_receipt can transition to receipt_confirmed.
 * - No state transition calls external APIs, sends provider messages, or
 *   mutates production database/outbox state on its own.
 */

// ---------------------------------------------------------------------------
// Terminal Brief receipt/ACK states
// ---------------------------------------------------------------------------

/**
 * All possible states in the Terminal Brief delivery and receipt lifecycle.
 *
 * States prefixed with `outbox_` represent the outbox record's lifecycle;
 * `receipt_` states represent the notification/ACK lifecycle.
 */
export type TerminalBriefEventStatus =
  | "outbox_accepted"
  | "outbox_started"
  | "outbox_produced"
  | "provider_sent"
  | "provider_accepted"
  | "current_session_visible"
  | "operator_visible"
  | "receipt_confirmed"
  | "failed"
  | "timed_out"
  | "stale";

// ---------------------------------------------------------------------------
// Transition table
// ---------------------------------------------------------------------------

/**
 * Canonical transition matrix. Each key maps to the set of valid next states.
 * Unknown/absent transitions are automatically rejected.
 */
export const TERMINAL_BRIEF_TRANSITIONS: Record<
  TerminalBriefEventStatus,
  ReadonlySet<TerminalBriefEventStatus>
> = {
  outbox_accepted: new Set([
    "outbox_started",
    "outbox_produced",
    "provider_sent",
    "failed",
    "timed_out",
    "stale",
  ]),
  outbox_started: new Set([
    "outbox_produced",
    "provider_sent",
    "failed",
    "timed_out",
    "stale",
  ]),
  outbox_produced: new Set([
    "provider_sent",
    "failed",
    "timed_out",
    "stale",
  ]),
  provider_sent: new Set([
    "provider_accepted",
    "current_session_visible",
    "operator_visible",
    "failed",
    "timed_out",
    "stale",
  ]),
  provider_accepted: new Set([
    "current_session_visible",
    "operator_visible",
    "failed",
    "timed_out",
    "stale",
  ]),
  current_session_visible: new Set([
    "operator_visible",
    "receipt_confirmed",
    "stale",
  ]),
  operator_visible: new Set([
    "receipt_confirmed",
    "stale",
  ]),
  receipt_confirmed: new Set(),
  failed: new Set(["outbox_accepted", "outbox_started", "outbox_produced", "provider_sent"]),
  timed_out: new Set(["outbox_accepted", "outbox_started", "outbox_produced", "stale"]),
  stale: new Set(),
};

// ---------------------------------------------------------------------------
// Guard / evidence rules
// ---------------------------------------------------------------------------

/**
 * The set of receipt evidence values that satisfy terminal ACK eligibility.
 * These are the ONLY evidence types that permit transition to
 * `receipt_confirmed`. Provider send success alone is never sufficient.
 */
export const TERMINAL_BRIEF_ACK_ELIGIBLE_EVIDENCE = new Set([
  "current_session_visible",
  "operator_visible",
  "operator_confirmed",
  "provider_delivery_receipt",
]) as ReadonlySet<string>;

/**
 * States where the event is considered "in progress" — not yet terminal.
 */
export const TERMINAL_BRIEF_ACTIVE_STATES: ReadonlySet<TerminalBriefEventStatus> = new Set([
  "outbox_accepted",
  "outbox_started",
  "outbox_produced",
  "provider_sent",
  "provider_accepted",
  "current_session_visible",
  "operator_visible",
]);

/**
 * Terminal (absorbing) states — no further transitions are possible.
 */
export const TERMINAL_BRIEF_TERMINAL_STATES: ReadonlySet<TerminalBriefEventStatus> = new Set([
  "receipt_confirmed",
  "failed",
  "timed_out",
  "stale",
]);

// ---------------------------------------------------------------------------
// Transition guard function
// ---------------------------------------------------------------------------

/**
 * Validate a state transition against the canonical transition table.
 *
 * @param from - Current state.
 * @param to - Desired next state.
 * @returns `true` when the transition is valid, `false` otherwise.
 */
export function canTransitionTerminalBriefEvent(
  from: TerminalBriefEventStatus,
  to: TerminalBriefEventStatus,
): boolean {
  const allowed = TERMINAL_BRIEF_TRANSITIONS[from];
  return allowed !== undefined && allowed.has(to);
}

/**
 * Determine whether a given receipt evidence value permits transition to
 * `receipt_confirmed`.
 */
export function canAckTerminalBriefEvent(evidence: string): boolean {
  return TERMINAL_BRIEF_ACK_ELIGIBLE_EVIDENCE.has(evidence);
}

// ---------------------------------------------------------------------------
// Template metadata
// ---------------------------------------------------------------------------

/**
 * Template metadata for Terminal Brief events, enabling spec-first task
 * creation from reusable templates.
 */
export interface TerminalBriefTemplateMetadata {
  /**
   * Unique template identifier (e.g., "terminal-brief/r23-team2-dungae").
   * Used for idempotent task creation and template version tracking.
   */
  templateId?: string;

  /**
   * Semantic version of the template. Should follow semver conventions.
   * Used for compatibility checks and migration planning.
   */
  templateVersion?: string;

  /**
   * Reference to the task definition that this template instantiates.
   * May be a path, URL, or well-known identifier resolved by the broker.
   */
  taskDefinitionRef?: string;

  /**
   * Arbitrary template parameter values. Keys and value types are defined
   * per-template in the template registry. All values should be operator-safe
   * and sanitizable.
   */
  templateParameters?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// TaskFlow linkage fields
// ---------------------------------------------------------------------------

/**
 * Linkage fields that connect a Terminal Brief event to a managed TaskFlow
 * run. These enable durable workflow tracking across broker restarts and
 * cross-broker handoffs.
 */
export interface TerminalBriefTaskFlowLinkage {
  /**
   * Stable identifier for the TaskFlow run that produced this Terminal Brief.
   * Used for correlating events across brokers and runs.
   */
  taskFlowRunId?: string;

  /**
   * Stable identifier for the TaskFlow task within the run that produced
   * this event. May be a step or stage identifier.
   */
  taskFlowTaskId?: string;

  /**
   * Optional step/phase identifier within a multi-step task. Allows event
   * routing to the correct handler in the managed TaskFlow runtime.
   */
  taskFlowStepId?: string;

  /**
   * Optional reference back to the parent TaskFlow run that triggered this
   * work. Present when the event is a child of another managed workflow.
   */
  parentTaskFlowRunId?: string;

  /**
   * Optional human-readable label for the TaskFlow step that produced this
   * event. Used for operator-facing dashboards and summaries.
   */
  stepLabel?: string;
}

// ---------------------------------------------------------------------------
// Composite runtime event type (combines all metadata)
// ---------------------------------------------------------------------------

/**
 * Full Terminal Brief runtime event shape, combining the state machine
 * position with receipt/ACK state, template metadata, and TaskFlow linkage.
 *
 * This is the high-level envelope consumed by automation APIs, dashboards,
 * and operator closeout tooling.
 */
export interface TerminalBriefRuntimeEvent {
  /** Stable outbox event id. */
  id: string;
  /** Parent round / run key. */
  parentRoundId?: string;
  /** Task identifier. */
  taskId: string;
  /** Current lifecycle status (position in the state machine). */
  status: TerminalBriefEventStatus;
  /** Current receipt status (provider-level delivery state). */
  receiptStatus: string;
  /** Whether receipt-confirmed ACK evidence has been recorded. */
  receiptConfirmed: boolean;
  /** Worker name or id. */
  worker?: string;
  /** Brief operator-safe task description. */
  taskBrief?: string;
  /** Evidence URLs (PR / Done / Block). */
  prUrl?: string;
  doneUrl?: string;
  blockUrl?: string;
  /** Round progress numerator and denominator. */
  parentRoundProgress?: number;
  parentRoundTotal?: number;
  /** ISO timestamps. */
  createdAt: string;
  updatedAt?: string;
  completedAt?: string;
  /** Template metadata (optional). */
  template?: TerminalBriefTemplateMetadata;
  /** TaskFlow linkage fields (optional). */
  taskFlow?: TerminalBriefTaskFlowLinkage;
  /** Broker-of-record that owns operator notification/ACK. */
  brokerOfRecordId?: string;
  /** Broker that produced the original Terminal Brief projection. */
  originBrokerId?: string;
  /** Cross-broker handoff metadata (optional). */
  crossBrokerHandoff?: {
    parentRoundId?: string;
    originBrokerId?: string;
    handoffBrokerId?: string;
    originTaskId?: string;
    childWorkerId?: string;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return true when the event status is terminal (no further transitions
 * possible).
 */
export function isTerminalBriefEventTerminal(status: TerminalBriefEventStatus): boolean {
  return TERMINAL_BRIEF_TERMINAL_STATES.has(status);
}

/**
 * Return true when the event status is active (in progress).
 */
export function isTerminalBriefEventActive(status: TerminalBriefEventStatus): boolean {
  return TERMINAL_BRIEF_ACTIVE_STATES.has(status);
}

/**
 * Map a terminal outbox receipt status to a canonical state machine status.
 */
export function mapReceiptStatusToEventStatus(
  receiptStatus: string,
  receiptConfirmed: boolean,
): TerminalBriefEventStatus {
  if (receiptConfirmed) return "receipt_confirmed";
  switch (receiptStatus) {
    case "accepted": return "outbox_accepted";
    case "started": return "outbox_started";
    case "produced": return "outbox_produced";
    case "provider_sent": return "provider_sent";
    case "provider_accepted": return "provider_accepted";
    case "current_session_visible": return "current_session_visible";
    case "operator_visible": return "operator_visible";
    case "failed": return "failed";
    case "timed_out": return "timed_out";
    case "stale": return "stale";
    default: return "outbox_accepted";
  }
}
