/**
 * Post-dispatch verifier for cross-broker terminal brief projections (R12/PR #602).
 *
 * Validates dispatch-critical fields — parentRoundId, originBrokerId,
 * parentRoundTotal, parentRoundOrder, crossBrokerHandoff — and provides a time-windowed
 * snapshot/check flow (30–60 s) against parent metadata consistency.
 *
 * No deploy, restart, live canary, ACK, replay, or DB mutation occurs.
 * This is purely verification/evidence for the operator dashboard.
 */

import type { CrossBrokerTerminalBriefProjectionRequest } from "./cross-broker-terminal-brief.js";
import type { TerminalTaskEventPayload } from "./terminal-event-outbox.js";

// ---------------------------------------------------------------------------
// Status types
// ---------------------------------------------------------------------------

/** Individual field verification status. */
export type FieldStatus = "valid" | "missing" | "mismatched";

/** Overall snapshot check verdict. */
export type SnapshotVerdict = "consistent" | "inconsistent" | "expired";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Result for a single verified field. */
export interface FieldResult {
  field: string;
  status: FieldStatus;
  expected?: unknown;
  actual?: unknown;
  detail?: string;
}

/** Full dispatch verification result. */
export interface DispatchVerificationResult {
  passed: boolean;
  fields: FieldResult[];
  checkedAt: string;
  summary: string;
}

/** Parent metadata snapshot captured at dispatch time. */
export interface ParentMetadataSnapshot {
  parentRoundId: string;
  originBrokerId: string;
  parentRoundTotal?: number;
  parentRoundOrder?: number;
  crossBrokerHandoff?: TerminalTaskEventPayload["crossBrokerHandoff"];
  capturedAt: string;
  snapshotWindowMs: number;
}

/** Result of checking a stored snapshot against current metadata. */
export interface SnapshotCheckResult {
  snapshot: ParentMetadataSnapshot;
  verdict: SnapshotVerdict;
  checkedAt: string;
  elapsedMs: number;
  fields: FieldResult[];
}

// ---------------------------------------------------------------------------
// Snapshot store
// ---------------------------------------------------------------------------

export interface SnapshotStore {
  get(parentRoundId: string): ParentMetadataSnapshot | undefined;
  set(snapshot: ParentMetadataSnapshot): void;
  delete(parentRoundId: string): void;
  entries(): [string, ParentMetadataSnapshot][];
}

export class InMemorySnapshotStore implements SnapshotStore {
  private readonly snapshots = new Map<string, ParentMetadataSnapshot>();

  get(parentRoundId: string): ParentMetadataSnapshot | undefined {
    return this.snapshots.get(parentRoundId);
  }

  set(snapshot: ParentMetadataSnapshot): void {
    this.snapshots.set(snapshot.parentRoundId, snapshot);
  }

  delete(parentRoundId: string): void {
    this.snapshots.delete(parentRoundId);
  }

  entries(): [string, ParentMetadataSnapshot][] {
    return [...this.snapshots.entries()];
  }
}

// ---------------------------------------------------------------------------
// Default configuration
// ---------------------------------------------------------------------------

export interface PostDispatchVerifierOptions {
  /**
   * Minimum window in ms before a snapshot is eligible for check.
   * Default: 30 000 (30 s).
   */
  minSnapshotWindowMs?: number;
  /**
   * Maximum window in ms before a snapshot is considered expired.
   * Default: 60 000 (60 s).
   */
  maxSnapshotWindowMs?: number;
  /** Clock provider for determinism in tests. */
  now?: () => Date;
}

const DEFAULT_OPTIONS: Required<PostDispatchVerifierOptions> = {
  minSnapshotWindowMs: 30_000,
  maxSnapshotWindowMs: 60_000,
  now: () => new Date(),
};

// ---------------------------------------------------------------------------
// Verifier
// ---------------------------------------------------------------------------

export class PostDispatchVerifier {
  private readonly opts: Required<PostDispatchVerifierOptions>;
  private readonly store: SnapshotStore;

  constructor(
    store?: SnapshotStore,
    options?: PostDispatchVerifierOptions,
  ) {
    this.opts = { ...DEFAULT_OPTIONS, ...options };
    this.store = store ?? new InMemorySnapshotStore();
  }

  /**
   * Verify the critical dispatch fields of a cross-broker Terminal Brief
   * projection request. Returns a structured result with per-field status.
   */
  verifyDispatch(
    request: CrossBrokerTerminalBriefProjectionRequest,
    receiverBrokerId?: string,
  ): DispatchVerificationResult {
    const fields: FieldResult[] = [];
    const now = this.opts.now().toISOString();

    // parentRoundId
    this.checkField(fields, "parentRoundId", request.parentRoundId, [
      { predicate: (v) => typeof v === "string" && v.trim().length > 0, status: "valid" as const, expected: "non-empty string" },
    ]);

    // originBrokerId
    this.checkField(fields, "originBrokerId", request.originBrokerId, [
      { predicate: (v) => typeof v === "string" && v.trim().length > 0, status: "valid" as const, expected: "non-empty string" },
    ]);

    // originBrokerId must differ from receiver
    if (typeof request.originBrokerId === "string" && request.originBrokerId.trim().length > 0) {
      const normalizedOrigin = request.originBrokerId.trim();
      if (receiverBrokerId && normalizedOrigin === receiverBrokerId.trim()) {
        fields.push({
          field: "originBrokerId",
          status: "mismatched",
          expected: `different from receiverBrokerId "${receiverBrokerId}"`,
          actual: normalizedOrigin,
          detail: "origin broker must not equal the receiving broker",
        });
      }
    }

    // parentRoundTotal and parentRoundOrder are required so compact titles
    // preserve the operator-planned numerator/denominator instead of relying
    // on arrival order.
    const total = normalizePositiveInt(request.parentRoundTotal);
    if (total === undefined) {
      fields.push({
        field: "parentRoundTotal",
        status: request.parentRoundTotal === undefined || request.parentRoundTotal === null ? "missing" : "mismatched",
        expected: "positive integer or numeric string",
        actual: request.parentRoundTotal,
        detail: "parentRoundTotal is required and must be a positive integer",
      });
    }

    const order = normalizePositiveInt(request.parentRoundOrder);
    if (order === undefined) {
      fields.push({
        field: "parentRoundOrder",
        status: request.parentRoundOrder === undefined || request.parentRoundOrder === null ? "missing" : "mismatched",
        expected: "positive integer or numeric string",
        actual: request.parentRoundOrder,
        detail: "parentRoundOrder is required and must be a positive integer",
      });
    } else if (total !== undefined && order > total) {
      fields.push({
        field: "parentRoundOrder",
        status: "mismatched",
        expected: "less than or equal to " + total,
        actual: order,
        detail: "parentRoundOrder must not exceed parentRoundTotal",
      });
    }

    // brokerOfRecordId vs receiver
    if (request.brokerOfRecordId && receiverBrokerId) {
      const normAddressed = request.brokerOfRecordId.trim();
      const normReceiver = receiverBrokerId.trim();
      if (normAddressed !== normReceiver) {
        fields.push({
          field: "brokerOfRecordId",
          status: "mismatched",
          expected: normReceiver,
          actual: normAddressed,
          detail: "brokerOfRecordId must match the receiving broker",
        });
      }
    }

    const passed = fields.every((f) => f.status === "valid");
    const summary = passed
      ? "All dispatch fields verified successfully"
      : `Dispatch verification failed: ${fields.filter((f) => f.status !== "valid").length} field(s) with issues`;

    return { passed, fields, checkedAt: now, summary };
  }

  /**
   * Verify crossBrokerHandoff embedded in a TerminalTaskEventPayload.
   * This is called after the outbox event has been created.
   */
  verifyCrossBrokerHandoff(
    payload: TerminalTaskEventPayload,
  ): FieldResult[] {
    const fields: FieldResult[] = [];
    const handoff = payload.crossBrokerHandoff;

    if (!handoff) {
      fields.push({
        field: "crossBrokerHandoff",
        status: "missing",
        detail: "cross-broker handoff metadata is absent from the terminal event payload",
      });
      return fields;
    }

    // parentRoundId within handoff
    if (typeof handoff.parentRoundId !== "string" || handoff.parentRoundId.trim().length === 0) {
      fields.push({
        field: "crossBrokerHandoff.parentRoundId",
        status: "missing",
        expected: "non-empty string",
        actual: handoff.parentRoundId,
        detail: "handoff parentRoundId is required",
      });
    }

    // originBrokerId within handoff
    if (typeof handoff.originBrokerId !== "string" || handoff.originBrokerId.trim().length === 0) {
      fields.push({
        field: "crossBrokerHandoff.originBrokerId",
        status: "missing",
        expected: "non-empty string",
        actual: handoff.originBrokerId,
        detail: "handoff originBrokerId is required",
      });
    }

    // handoff fields are structurally valid
    if (handoff.handoffBrokerId !== undefined) {
      if (typeof handoff.handoffBrokerId !== "string" || handoff.handoffBrokerId.trim().length === 0) {
        fields.push({
          field: "crossBrokerHandoff.handoffBrokerId",
          status: "mismatched",
          expected: "non-empty string when present",
          actual: handoff.handoffBrokerId,
          detail: "handoffBrokerId must be a non-empty string",
        });
      }
    }

    // notificationOwnership scope guard
    if (payload.notificationOwnership) {
      if (payload.notificationOwnership.providerSendPermittedByProjection !== false) {
        fields.push({
          field: "notificationOwnership.providerSendPermittedByProjection",
          status: "mismatched",
          expected: false,
          actual: payload.notificationOwnership.providerSendPermittedByProjection,
          detail: "cross-broker projections must not permit provider send",
        });
      }
      if (payload.notificationOwnership.terminalAckPermittedByProjection !== false) {
        fields.push({
          field: "notificationOwnership.terminalAckPermittedByProjection",
          status: "mismatched",
          expected: false,
          actual: payload.notificationOwnership.terminalAckPermittedByProjection,
          detail: "cross-broker projections must not permit terminal ACK",
        });
      }
    }

    return fields;
  }

  // -------------------------------------------------------------------------
  // Snapshot/check flow (30–60 s window)
  // -------------------------------------------------------------------------

  /**
   * Capture a snapshot of the parent metadata at dispatch time.
   * Returns the stored snapshot.
   */
  snapshotParentMetadata(
    parentRoundId: string,
    originBrokerId: string,
    parentRoundTotal?: number,
    parentRoundOrder?: number,
    crossBrokerHandoff?: TerminalTaskEventPayload["crossBrokerHandoff"],
  ): ParentMetadataSnapshot {
    const capturedAt = this.opts.now().toISOString();
    const snapshot: ParentMetadataSnapshot = {
      parentRoundId,
      originBrokerId,
      parentRoundTotal,
      parentRoundOrder,
      crossBrokerHandoff: crossBrokerHandoff ? { ...crossBrokerHandoff } : undefined,
      capturedAt,
      snapshotWindowMs: this.opts.maxSnapshotWindowMs,
    };
    this.store.set(snapshot);
    return snapshot;
  }

  /**
   * Check a stored snapshot against an expected set of metadata values.
   * Returns the elapsed time, a verdict, and per-field results.
   *
   * The snapshot is considered:
   * - "expired" if more than maxSnapshotWindowMs have elapsed since capture
   * - "inconsistent" if any field differs from the expected values
   * - "consistent" if all fields match
   */
  checkSnapshot(
    parentRoundId: string,
    expected: {
      parentRoundId?: string;
      originBrokerId?: string;
      parentRoundTotal?: number;
      parentRoundOrder?: number;
    },
  ): SnapshotCheckResult {
    const now = this.opts.now();
    const checkedAt = now.toISOString();
    const snapshot = this.store.get(parentRoundId);

    if (!snapshot) {
      return {
        snapshot: {
          parentRoundId,
          originBrokerId: "",
          capturedAt: checkedAt,
          snapshotWindowMs: this.opts.maxSnapshotWindowMs,
        },
        verdict: "inconsistent",
        checkedAt,
        elapsedMs: 0,
        fields: [
          {
            field: "snapshot",
            status: "missing",
            expected: "stored snapshot",
            detail: `No snapshot found for parentRoundId "${parentRoundId}"`,
          },
        ],
      };
    }

    const elapsedMs = now.getTime() - new Date(snapshot.capturedAt).getTime();
    const fields: FieldResult[] = [];

    // Check expiry: must be within the configured window
    if (elapsedMs > this.opts.maxSnapshotWindowMs) {
      return {
        snapshot,
        verdict: "expired",
        checkedAt,
        elapsedMs,
        fields: [
          {
            field: "snapshot.timing",
            status: "mismatched",
            expected: `≤ ${this.opts.maxSnapshotWindowMs} ms`,
            actual: `${elapsedMs} ms`,
            detail: `Snapshot captured at ${snapshot.capturedAt} is outside the ${this.opts.maxSnapshotWindowMs} ms check window (elapsed: ${elapsedMs} ms)`,
          },
        ],
      };
    }

    // per-field comparison
    if (expected.parentRoundId !== undefined && snapshot.parentRoundId !== expected.parentRoundId) {
      fields.push({
        field: "parentRoundId",
        status: "mismatched",
        expected: expected.parentRoundId,
        actual: snapshot.parentRoundId,
        detail: "parentRoundId in snapshot does not match expected value",
      });
    }

    if (expected.originBrokerId !== undefined && snapshot.originBrokerId !== expected.originBrokerId) {
      fields.push({
        field: "originBrokerId",
        status: "mismatched",
        expected: expected.originBrokerId,
        actual: snapshot.originBrokerId,
        detail: "originBrokerId in snapshot does not match expected value",
      });
    }

    if (expected.parentRoundTotal !== undefined && snapshot.parentRoundTotal !== expected.parentRoundTotal) {
      fields.push({
        field: "parentRoundTotal",
        status: "mismatched",
        expected: expected.parentRoundTotal,
        actual: snapshot.parentRoundTotal,
        detail: "parentRoundTotal in snapshot does not match expected value",
      });
    }

    if (expected.parentRoundOrder !== undefined && snapshot.parentRoundOrder !== expected.parentRoundOrder) {
      fields.push({
        field: "parentRoundOrder",
        status: "mismatched",
        expected: expected.parentRoundOrder,
        actual: snapshot.parentRoundOrder,
        detail: "parentRoundOrder in snapshot does not match expected value",
      });
    }

    const verdict: SnapshotVerdict = fields.length === 0 ? "consistent" : "inconsistent";

    return {
      snapshot,
      verdict,
      checkedAt,
      elapsedMs,
      fields,
    };
  }

  /**
   * Convenience: run the full post-dispatch verification in one call.
   * Captures a snapshot and immediately reports the verification results.
   */
  verifyDispatchWithSnapshot(
    request: CrossBrokerTerminalBriefProjectionRequest,
    receiverBrokerId?: string,
    expectedParentTotal?: number,
  ): {
    dispatchResult: DispatchVerificationResult;
    snapshot: ParentMetadataSnapshot;
    handoffFields: FieldResult[];
  } {
    const dispatchResult = this.verifyDispatch(request, receiverBrokerId);
    const snapshot = this.snapshotParentMetadata(
      request.parentRoundId,
      request.originBrokerId,
      normalizePositiveInt(request.parentRoundTotal) ?? expectedParentTotal,
      normalizePositiveInt(request.parentRoundOrder),
    );
    const payload: TerminalTaskEventPayload = {
      taskId: request.childTaskId ?? `cross-broker:${request.parentRoundId}:${request.originBrokerId}`,
      status: request.status,
      createdAt: request.completedAt,
      updatedAt: request.completedAt,
      completedAt: request.completedAt,
      ...(normalizePositiveInt(request.parentRoundTotal) ? { parentRoundTotal: normalizePositiveInt(request.parentRoundTotal) } : {}),
      ...(normalizePositiveInt(request.parentRoundOrder) ? { parentRoundProgress: normalizePositiveInt(request.parentRoundOrder) } : {}),
      crossBrokerHandoff: {
        parentRoundId: request.parentRoundId,
        originBrokerId: request.brokerOfRecordId ?? "unknown-parent-broker",
        handoffBrokerId: request.originBrokerId,
        ...(request.childTaskId ? { originTaskId: request.childTaskId } : {}),
        ...(request.childWorkerId ?? request.workerId ? { childWorkerId: request.childWorkerId ?? request.workerId } : {}),
      },
      notificationOwnership: {
        ownerBrokerId: request.brokerOfRecordId ?? "unknown-parent-broker",
        scope: "parent-broker-only",
        providerSendPermittedByProjection: false,
        terminalAckPermittedByProjection: false,
        reason: "cross-broker projections are parent-broker aggregation evidence only; child/handoff brokers do not notify or ACK",
      },
    };
    const handoffFields = this.verifyCrossBrokerHandoff(payload);

    return { dispatchResult, snapshot, handoffFields };
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private checkField(
    fields: FieldResult[],
    fieldName: string,
    value: unknown,
    rules: Array<{
      predicate: (v: unknown) => boolean;
      status: FieldStatus;
      expected: unknown;
    }>,
  ): void {
    for (const rule of rules) {
      if (rule.predicate(value)) {
        if (rule.status !== "valid") {
          fields.push({
            field: fieldName,
            status: rule.status,
            expected: rule.expected,
            actual: value,
            detail: `Field value "${value}" did not satisfy expected constraint`,
          });
        }
        return;
      }
    }

    // No rule matched — value is missing or invalid
    if (value === undefined || value === null || (typeof value === "string" && value.trim().length === 0)) {
      fields.push({
        field: fieldName,
        status: "missing",
        expected: rules.length > 0 ? rules[0].expected : "defined",
        actual: value,
        detail: `Field "${fieldName}" is absent or empty`,
      });
    } else {
      fields.push({
        field: fieldName,
        status: "mismatched",
        expected: rules.length > 0 ? rules[0].expected : "valid value",
        actual: value,
        detail: `Field "${fieldName}" value did not match expected format`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
