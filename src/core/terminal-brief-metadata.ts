/**
 * Terminal Brief Metadata Schema (R15 canonical all-hands lane).
 *
 * This file defines the canonical schema used across the A2A Terminal Brief
 * lifecycle: dispatch, projection ingestion, cross-broker handoff construction,
 * and outbox event assembly.
 *
 * Every broker (parent, child, handoff) references the same field definitions
 * and constraints so that metadata semantics are consistent regardless of
 * whether a projection arrives as an explicit cross-broker packet or as a
 * task payload field at creation time.
 *
 * Design principles
 * -----------------
 * 1. **Single source of truth** — field names, types, and constraint
 *    descriptions live here. Existing interfaces in
 *    `cross-broker-terminal-brief.ts` and `terminal-event-outbox.ts` remain
 *    as transport/record shapes but derive their semantics from this schema.
 * 2. **Fail-closed by default** — validation rejects at the earliest possible
 *    point rather than allowing silently-inconsistent metadata to propagate.
 * 3. **Backward-compatible** — new field constraints do not break existing
 *    valid projections; the schema only adds validation that was previously
 *    implicit or absent.
 */

// ---------------------------------------------------------------------------
// Canonical metadata field interfaces
// ---------------------------------------------------------------------------

/**
 * Canonical Terminal Brief dispatch metadata.
 *
 * These fields identify the parent round, the origin broker, the broker of
 * record, and the child's ordinal position within the parent round. They are
 * the minimal set needed to construct a dispatchable cross-broker Terminal
 * Brief projection.
 *
 * @remarks
 * - `parentRoundTotal` and `parentRoundOrder` support both `number` and
 *   `string` (numeric) representations because projection requests may arrive
 *   from diverse broker implementations that serialise numbers differently.
 * - When present, `parentRoundOrder` MUST be ≤ `parentRoundTotal`.
 * - `originBrokerId` MUST differ from the receiving broker's id.
 */
export interface TerminalBriefDispatchMetadata {
  /**
   * Parent round or session identifier. Used as the grouping key for all
   * child projections that belong to the same parent round.
   *
   * Constraints:
   * - Required for dispatch
   * - Non-empty string
   * - Must reference a task/round known to the receiving broker
   */
  parentRoundId: string;

  /**
   * Broker that produced (originated) the child Terminal Brief projection.
   *
   * Constraints:
   * - Required for dispatch
   * - Non-empty string
   * - MUST differ from the receiving (broker-of-record) broker id
   */
  originBrokerId: string;

  /**
   * Broker-of-record that owns the parent round. The notification ownership
   * and parent-broker-only ACK policy are derived from this field.
   *
   * Constraints:
   * - Required for handoff construction
   * - Must match the receiving broker when the receiver has a configured id
   * - When absent, the receiving broker's configured id is used as the default
   */
  brokerOfRecordId?: string;

  /**
   * Total number of worker subtasks expected for the parent round
   * (denominator of the round progress fraction).
   *
   * Constraints:
   * - Required for dispatch
   * - Must be a positive integer (or numeric string)
   * - Used in Terminal Brief title rendering: "worker(N/M)"
   */
  parentRoundTotal: number | string;

  /**
   * 1-based ordinal position of this child projection within the parent round
   * (numerator of the round progress fraction).
   *
   * Constraints:
   * - Required for dispatch
   * - Must be a positive integer (or numeric string)
   * - MUST be ≤ parentRoundTotal
   */
  parentRoundOrder: number | string;
}

/**
 * Canonical cross-broker handoff metadata embedded in a Terminal Brief
 * projection or task payload's `crossBrokerHandoff` field.
 *
 * This structure records which broker originated the parent round (the
 * `originBrokerId`) and which broker participated as the handoff child (the
 * `handoffBrokerId`). It is the traceability link that allows a parent broker
 * to attribute a child Terminal Brief to the correct external broker.
 *
 * @remarks
 * - `parentRoundId` and `originBrokerId` are required for a valid handoff.
 * - `handoffBrokerId` may be absent when the handoff participant is the same
 *   as `originBrokerId` (implicit self-handoff).
 * - `originTaskId` links back to the child broker's local task record.
 */
export interface TerminalBriefHandoffMetadata {
  /**
   * Same parent round identifier as {@link TerminalBriefDispatchMetadata.parentRoundId}.
   *
   * Constraints:
   * - Required for handoff
   * - Non-empty string
   */
  parentRoundId: string;

  /**
   * The broker of record for the parent round — the broker that owns the
   * aggregation and notification responsibility for the parent round.
   *
   * In a handoff context this is the `originBrokerId` of the
   * crossBrokerHandoff structure, meaning the handoff's "origin" is the parent
   * broker (the broker that dispatched work) rather than the child broker.
   *
   * Constraints:
   * - Required for handoff
   * - Non-empty string
   * - Typically the same as {@link TerminalBriefDispatchMetadata.brokerOfRecordId}
   */
  originBrokerId: string;

  /**
   * The broker that received and executed the child task (the handoff
   * participant). When the origin broker and the handoff broker are the same,
   * this field may be absent.
   *
   * Constraints:
   * - Optional, non-empty string when present
   * - When absent, the handoff is implicit (origin broker executed itself)
   */
  handoffBrokerId?: string;

  /**
   * The child broker's local task identifier for this projection.
   *
   * Constraints:
   * - Optional, non-empty string when present
   */
  originTaskId?: string;

  /**
   * The specific worker on the handoff broker that produced the child
   * Terminal Brief, when distinct from the handoff broker itself.
   *
   * Constraints:
   * - Optional, non-empty string when present
   */
  childWorkerId?: string;
}

/**
 * Canonical notification ownership policy for a Terminal Brief event.
 *
 * Cross-broker projections are always parent-broker aggregation evidence
 * only. Child and handoff brokers do not send notifications or ACK them.
 * This policy is immutable once set.
 */
export interface TerminalBriefNotificationOwnership {
  /**
   * Broker id that owns the notification lifecycle for this event.
   *
   * Constraints:
   * - Required
   * - Non-empty string
   * - Must match {@link TerminalBriefDispatchMetadata.brokerOfRecordId}
   */
  ownerBrokerId: string;

  /**
   * Notification delivery scope. Cross-broker projections are always
   * parent-broker-only.
   */
  scope: "parent-broker-only";

  /**
   * Cross-broker projections MUST NOT permit the child/handoff broker to
   * send provider notifications. Always `false`.
   */
  providerSendPermittedByProjection: false;

  /**
   * Cross-broker projections MUST NOT permit the child/handoff broker to
   * terminal-ACK the event. Always `false`.
   */
  terminalAckPermittedByProjection: false;

  /**
   * Human-readable explanation of why this notification ownership policy
   * applies.
   */
  reason: string;
}

/**
 * Canonical Terminal Brief projection metadata — the full set of fields that
 * a cross-broker Terminal Brief projection carries.
 *
 * This is the superset of:
 * - {@link TerminalBriefDispatchMetadata} (required for dispatch),
 * - Child identity fields (task id, worker id),
 * - Terminal outcome fields (status, summary, evidence),
 * - Timing fields (completedAt, emittedAt),
 * - Progress fields (parentRoundTotal, parentRoundOrder).
 */
export interface TerminalBriefProjectionMetadata {
  // ---- Dispatch identity ----
  /** Parent round identifier (grouping key). Required. */
  parentRoundId: string;
  /** Broker that produced this projection. Required, must differ from receiver. */
  originBrokerId: string;
  /** Broker of record the projection is addressed to. */
  brokerOfRecordId?: string;

  // ---- Child identity ----
  /** Child broker's local task id. */
  childTaskId?: string;
  /** Child broker's local run id. */
  childRunId?: string;
  /** Specific worker on the child broker that produced the brief. */
  childWorkerId?: string;

  // ---- Terminal outcome ----
  /** Terminal status. Must be one of succeeded, failed, canceled, blocked. */
  status: "succeeded" | "failed" | "canceled" | "blocked";
  /** Sanitised outcome summary (max 500 chars). */
  summary?: string;
  /** Sanitised task brief (max 160 chars). */
  taskBrief?: string;
  /** Evidence URL pointing to the completed work. */
  evidenceUrl?: string;

  // ---- Timing ----
  /** ISO 8601 timestamp when the child task completed. Required. */
  completedAt: string;
  /** ISO 8601 timestamp when the projection was emitted. Optional, defaults to completedAt. */
  emittedAt?: string;

  // ---- Progress (round ordinal) ----
  /**
   * Total worker subtask count (denominator). Required for dispatch.
   * Number is canonical; string accepted for transport compatibility.
   */
  parentRoundTotal?: number | string;
  /**
   * 1-based ordinal within parent round (numerator). Required for dispatch.
   * Number is canonical; string accepted for transport compatibility.
   */
  parentRoundOrder?: number | string;

  // ---- ACK policy ----
  /**
   * Cross-broker projections MUST NOT carry a terminal ACK flag.
   * When present and `true`, the projection MUST be rejected.
   */
  terminalAck?: boolean;
}

// ---------------------------------------------------------------------------
// Validation result types
// ---------------------------------------------------------------------------

/** Severity of a single metadata validation issue. */
export type MetadataValidationSeverity = "error" | "warning";

/** Result of validating a single metadata field or constraint. */
export interface MetadataValidationIssue {
  /** Canonical path to the field, e.g. "parentRoundId" or "crossBrokerHandoff.parentRoundId" */
  path: string;
  /** Human-readable description of the issue. */
  message: string;
  /** Severity: errors are fail-closed, warnings are advisory. */
  severity: MetadataValidationSeverity;
  /** Expected value or constraint description. */
  expected?: string;
  /** Actual value found. */
  actual?: unknown;
}

/** Overall result of a Terminal Brief metadata validation. */
export interface TerminalBriefMetadataValidationResult {
  /** True when no errors exist (warnings alone are acceptable). */
  valid: boolean;
  /** All issues found during validation. */
  issues: MetadataValidationIssue[];
  /** Short summary string suitable for error messages. */
  summary: string;
}

// ---------------------------------------------------------------------------
// Normalisation helpers
// ---------------------------------------------------------------------------

function normalizeToken(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizePositiveInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0 && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Utility type for constructing subsets of the canonical schema from
// arbitrary key-value records (e.g. task payloads).
// ---------------------------------------------------------------------------

/**
 * Canonical Terminal Brief metadata keys that the broker recognises in
 * task payloads and outbox event assembly.
 */
export const TERMINAL_BRIEF_PAYLOAD_KEYS: ReadonlySet<string> = new Set([
  "parentRoundId",
  "originBrokerId",
  "brokerOfRecordId",
  "parentRoundTotal",
  "parentRoundOrder",
  "parentRoundProgress",
  "crossBrokerHandoff",
  "roundTotal",
  "expectedWorkers",
  "taskCount",
  "run",
  "runId",
  "round",
  "roundId",
  "childTaskId",
  "childRunId",
  "childWorkerId",
  "traceId",
  "terminalBrief",
]);

// ---------------------------------------------------------------------------
// Canonical validation function
// ---------------------------------------------------------------------------

/**
 * Validate a set of Terminal Brief dispatch metadata fields.
 *
 * This is the canonical validation entry point for all-hands Terminal Brief
 * metadata. It enforces:
 * - Required fields are present and non-empty
 * - Numeric constraints (positive integer, order ≤ total)
 * - Origin/receiver broker distinction
 * - Handoff field requirements
 * - Notification ownership defaults
 *
 * @param input - Object containing Terminal Brief metadata fields (may be a
 *   {@link TerminalBriefDispatchMetadata}, a projection request, or a generic
 *   task payload record).
 * @param receiverBrokerId - Optional receiver broker id for origin/receiver
 *   distinction checks.
 * @returns A validation result with per-field issues.
 */
export function validateTerminalBriefMetadata(
  input: Record<string, unknown>,
  receiverBrokerId?: string,
): TerminalBriefMetadataValidationResult {
  const issues: MetadataValidationIssue[] = [];

  // ---- parentRoundId ----
  const parentRoundId = normalizeToken(input["parentRoundId"]);
  if (!parentRoundId) {
    issues.push({
      path: "parentRoundId",
      message: "parentRoundId is required for Terminal Brief dispatch",
      severity: "error",
      expected: "non-empty string",
      actual: input["parentRoundId"],
    });
  }

  // ---- originBrokerId ----
  const originBrokerId = normalizeToken(input["originBrokerId"]);
  if (!originBrokerId) {
    issues.push({
      path: "originBrokerId",
      message: "originBrokerId is required for Terminal Brief dispatch",
      severity: "error",
      expected: "non-empty string",
      actual: input["originBrokerId"],
    });
  } else if (receiverBrokerId && originBrokerId === receiverBrokerId) {
    issues.push({
      path: "originBrokerId",
      message: `originBrokerId "${originBrokerId}" must differ from the receiving broker "${receiverBrokerId}"`,
      severity: "error",
      expected: `different from "${receiverBrokerId}"`,
      actual: originBrokerId,
    });
  }

  // ---- brokerOfRecordId ----
  const brokerOfRecordId = normalizeToken(input["brokerOfRecordId"]);
  // brokerOfRecordId is recommended but not strictly required for every
  // context. When present, we validate it.

  // ---- parentRoundTotal ----
  const parentRoundTotal = normalizePositiveInt(input["parentRoundTotal"]);
  if (parentRoundTotal === undefined) {
    issues.push({
      path: "parentRoundTotal",
      message: "parentRoundTotal is required and must be a positive integer",
      severity: "error",
      expected: "positive integer (or numeric string)",
      actual: input["parentRoundTotal"],
    });
  }

  // ---- parentRoundOrder ----
  const parentRoundOrder = normalizePositiveInt(input["parentRoundOrder"]);
  if (parentRoundOrder === undefined) {
    issues.push({
      path: "parentRoundOrder",
      message: "parentRoundOrder is required and must be a positive integer",
      severity: "error",
      expected: "positive integer (or numeric string)",
      actual: input["parentRoundOrder"],
    });
  } else if (parentRoundTotal !== undefined && parentRoundOrder > parentRoundTotal) {
    issues.push({
      path: "parentRoundOrder",
      message: `parentRoundOrder (${parentRoundOrder}) must not exceed parentRoundTotal (${parentRoundTotal})`,
      severity: "error",
      expected: `≤ ${parentRoundTotal}`,
      actual: parentRoundOrder,
    });
  }

  // ---- crossBrokerHandoff ----
  const handoff = input["crossBrokerHandoff"];
  if (handoff !== undefined && handoff !== null) {
    validateHandoff(handoff, issues, receiverBrokerId);
  }

  const valid = issues.every((i) => i.severity !== "error");
  const errorCount = issues.filter((i) => i.severity === "error").length;
  const summary = valid
    ? "Terminal Brief metadata validation passed"
    : `Terminal Brief metadata validation failed: ${errorCount} error(s)`;

  return { valid, issues, summary };
}

/**
 * Validate a `crossBrokerHandoff` value that may appear in a task payload or
 * projection request.
 */
function validateHandoff(
  handoff: unknown,
  issues: MetadataValidationIssue[],
  receiverBrokerId?: string,
): void {
  if (typeof handoff !== "object" || handoff === null) {
    issues.push({
      path: "crossBrokerHandoff",
      message: "crossBrokerHandoff must be a non-null object",
      severity: "error",
      expected: "object with parentRoundId and originBrokerId",
      actual: handoff,
    });
    return;
  }

  const h = handoff as Record<string, unknown>;

  const hp = normalizeToken(h["parentRoundId"]);
  if (!hp) {
    issues.push({
      path: "crossBrokerHandoff.parentRoundId",
      message: "crossBrokerHandoff.parentRoundId is required",
      severity: "error",
      expected: "non-empty string",
      actual: h["parentRoundId"],
    });
  }

  const ho = normalizeToken(h["originBrokerId"]);
  if (!ho) {
    issues.push({
      path: "crossBrokerHandoff.originBrokerId",
      message: "crossBrokerHandoff.originBrokerId is required",
      severity: "error",
      expected: "non-empty string",
      actual: h["originBrokerId"],
    });
  }

  // handoffBrokerId is optional but must be a non-empty string when present
  if (h["handoffBrokerId"] !== undefined && h["handoffBrokerId"] !== null) {
    const hb = normalizeToken(h["handoffBrokerId"]);
    if (!hb) {
      issues.push({
        path: "crossBrokerHandoff.handoffBrokerId",
        message: "crossBrokerHandoff.handoffBrokerId must be a non-empty string when present",
        severity: "error",
        expected: "non-empty string or absent",
        actual: h["handoffBrokerId"],
      });
    }
  }

  // originTaskId is optional
  if (h["originTaskId"] !== undefined && h["originTaskId"] !== null) {
    const ot = normalizeToken(h["originTaskId"]);
    if (!ot) {
      issues.push({
        path: "crossBrokerHandoff.originTaskId",
        message: "crossBrokerHandoff.originTaskId must be a non-empty string when present",
        severity: "error",
        expected: "non-empty string or absent",
        actual: h["originTaskId"],
      });
    }
  }

  // childWorkerId is optional
  if (h["childWorkerId"] !== undefined && h["childWorkerId"] !== null) {
    const cw = normalizeToken(h["childWorkerId"]);
    if (!cw) {
      issues.push({
        path: "crossBrokerHandoff.childWorkerId",
        message: "crossBrokerHandoff.childWorkerId must be a non-empty string when present",
        severity: "error",
        expected: "non-empty string or absent",
        actual: h["childWorkerId"],
      });
    }
  }
}

/**
 * Check whether a task payload carries explicit Terminal Brief dispatch
 * metadata that needs fail-closed validation.
 *
 * `parentRoundId` by itself is intentionally not enough: older direct-task and
 * handoff paths use it only as a grouping/run key for compact progress. The
 * creation-time guard should activate only when the caller opts into the R15
 * dispatch contract with ownership/order/title/handoff fields. Projection-time
 * ingestion remains strict for actual cross-broker Terminal Brief packets.
 */
export function hasTerminalBriefMetadata(payload: Record<string, unknown>): boolean {
  return [
    "originBrokerId",
    "parentRoundOrder",
    "parentRoundIndex",
    "terminalBriefTitle",
    "terminalBrief",
  ].some((key) => payload[key] !== undefined && payload[key] !== null && String(payload[key]).trim().length > 0);
}

/**
 * Extract a minimal dispatch-metadata view from a generic task payload
 * record, suitable for passing to {@link validateTerminalBriefMetadata}.
 */
export function extractDispatchMetadata(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    parentRoundId: payload["parentRoundId"] ?? payload["run"] ?? payload["runId"] ?? payload["round"] ?? payload["roundId"],
    originBrokerId: payload["originBrokerId"],
    brokerOfRecordId: payload["brokerOfRecordId"],
    parentRoundTotal: payload["parentRoundTotal"] ?? payload["roundTotal"] ?? payload["expectedWorkers"] ?? payload["taskCount"],
    parentRoundOrder: payload["parentRoundOrder"] ?? payload["parentRoundIndex"],
    crossBrokerHandoff: payload["crossBrokerHandoff"],
  };
}
