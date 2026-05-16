import { createHash } from "node:crypto";

import type { TaskStatus } from "./types.js";
import {
  validateTerminalBriefMetadata as canonicalValidateTerminalBriefMetadata,
  extractDispatchMetadata,
  type TerminalBriefDispatchMetadata,
  type TerminalBriefHandoffMetadata,
  type TerminalBriefProjectionMetadata,
  type TerminalBriefNotificationOwnership,
} from "./terminal-brief-metadata.js";

const TERMINAL_STATUSES = new Set<TaskStatus>(["succeeded", "failed", "canceled", "blocked"]);
const MAX_SUMMARY_CHARS = 500;
const MAX_BRIEF_CHARS = 160;
const MAX_REASON_CHARS = 240;

export type CrossBrokerTerminalBriefAckDecision = "accepted" | "duplicate_replay" | "rejected";

export type CrossBrokerTerminalBriefRejectCode =
  | "bad_request"
  | "missing_parent"
  | "wrong_origin"
  | "stale_replay"
  | "terminal_ack_forbidden"
  | "missing_dispatch_metadata"
  | "completed_count_exceeded";

export interface TerminalBriefDispatchValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Fields needed for Terminal Brief dispatch metadata validation, extracted so
 * both request and normalized-projection shapes can be checked without casts.
 */
export interface TerminalBriefDispatchValidationInput {
  parentRoundId?: string;
  originBrokerId?: string;
  brokerOfRecordId?: string;
  parentRoundTotal?: number;
  parentRoundOrder?: number;
}

/**
 * Validate Terminal Brief projection metadata before dispatch.
 * Requires parentRoundId, originBrokerId, parentRoundTotal, and
 * crossBrokerHandoff fields to be present and valid.
 *
 * Delegates to the canonical schema validation from {@link validateTerminalBriefMetadata}
 * (the canonical all-hands lane schema). The local type
 * {@link TerminalBriefDispatchValidationInput} remains for backward compatibility.
 */
export function validateTerminalBriefForDispatch(
  input: TerminalBriefDispatchValidationInput,
  receiverBrokerId?: string,
): TerminalBriefDispatchValidationResult {
  const canonical = canonicalValidateTerminalBriefMetadata(
    input as Record<string, unknown>,
    receiverBrokerId,
  );
  const errors = canonical.issues
    .filter((i) => i.severity === "error")
    .map((i) => i.message);
  return { valid: errors.length === 0, errors };
}

export interface CrossBrokerTerminalBriefProjectionRequest {
  /** Parent round/task id owned by the receiving broker-of-record. */
  parentRoundId: string;
  /** Broker that produced the child Terminal Brief. */
  originBrokerId: string;
  /** Receiving broker id the packet was addressed to. Required when the receiver has a broker id. */
  brokerOfRecordId?: string;
  childTaskId?: string;
  childRunId?: string;
  /** Worker that produced the child Terminal Brief, when distinct from the handoff broker. */
  childWorkerId?: string;
  /** Backward-compatible alias accepted from compact handoff packets. */
  workerId?: string;
  status: Extract<TaskStatus, "succeeded" | "failed" | "canceled" | "blocked">;
  summary?: string;
  taskBrief?: string;
  evidenceUrl?: string;
  completedAt: string;
  emittedAt?: string;
  /** Cross-broker projections are not Terminal Brief ACKs; this must be absent/false. */
  terminalAck?: boolean;
  /** Total worker/task count expected for the parent round (denominator). */
  parentRoundTotal?: number | string;
  /** 1-based worker/task order within the parent round (title numerator). */
  parentRoundOrder?: number | string;
}

export interface CrossBrokerTerminalBriefProjection {
  id: string;
  parentRoundId: string;
  originBrokerId: string;
  brokerOfRecordId?: string;
  childTaskId?: string;
  childRunId?: string;
  /** Worker that produced the child Terminal Brief, when distinct from the handoff broker. */
  childWorkerId?: string;
  status: Extract<TaskStatus, "succeeded" | "failed" | "canceled" | "blocked">;
  summary?: string;
  taskBrief?: string;
  evidenceUrl?: string;
  completedAt: string;
  emittedAt: string;
  receivedAt: string;
  sourceDigest: string;
  replayCount: number;
  ack: {
    decision: "accepted" | "duplicate_replay";
    terminalAck: false;
    reason: string;
    updatedAt: string;
  };
  /** Total worker/task count expected for the parent round (denominator). */
  parentRoundTotal?: number;
  /** 1-based worker/task order within the parent round (title numerator). */
  parentRoundOrder?: number;
}

export interface CrossBrokerTerminalBriefProjectionFilters {
  parentRoundId?: string;
  originBrokerId?: string;
}

export type CrossBrokerTerminalBriefProjectionResult =
  | {
      accepted: true;
      replayed: false;
      record: CrossBrokerTerminalBriefProjection;
      ack: CrossBrokerTerminalBriefProjection["ack"];
    }
  | {
      accepted: true;
      replayed: true;
      record: CrossBrokerTerminalBriefProjection;
      ack: CrossBrokerTerminalBriefProjection["ack"];
    }
  | {
      accepted: false;
      replayed: false;
      ack: {
        decision: "rejected";
        terminalAck: false;
        code: CrossBrokerTerminalBriefRejectCode;
        reason: string;
        updatedAt: string;
      };
    };

export interface CrossBrokerTerminalBriefProjectionStoreOptions {
  brokerId?: string;
  hasParentRound(parentRoundId: string): boolean;
  parentBrokerOfRecord?(parentRoundId: string): string | undefined;
  now?(): Date;
}

/**
 * Broker-local storage/protocol guard for cross-broker child Terminal Brief projections.
 *
 * Records are keyed by parent round, producing broker, and the best available
 * child identity. This keeps duplicate packets for the same child idempotent
 * while allowing several Gwakga-executed children to aggregate under the same
 * Seoseo-origin parent round without overwriting each other.
 */
export class CrossBrokerTerminalBriefProjectionStore {
  private readonly records = new Map<string, CrossBrokerTerminalBriefProjection>();

  constructor(
    records: CrossBrokerTerminalBriefProjection[] = [],
    private readonly options: CrossBrokerTerminalBriefProjectionStoreOptions,
  ) {
    for (const record of records) {
      this.records.set(recordKey(record), normalizeRecord(record));
    }
  }

  ingest(request: CrossBrokerTerminalBriefProjectionRequest): CrossBrokerTerminalBriefProjectionResult {
    const now = (this.options.now?.() ?? new Date()).toISOString();
    const normalized = normalizeRequest(request);
    if (!normalized) {
      return reject("bad_request", "cross-broker Terminal Brief projection requires parentRoundId, originBrokerId, terminal status, and completedAt", now);
    }

    // Dispatch metadata preflight: require parentRoundId, originBrokerId,
    // parentRoundTotal, and crossBrokerHandoff fields before storage and enqueue.
    // This closes the gap where a projection would be stored but never dispatchable.
    const preflight = validateTerminalBriefForDispatch(
      {
        parentRoundId: normalized.parentRoundId,
        originBrokerId: normalized.originBrokerId,
        brokerOfRecordId: normalized.brokerOfRecordId,
        parentRoundTotal: normalized.parentRoundTotal,
        parentRoundOrder: normalized.parentRoundOrder,
      },
      normalizeToken(this.options.brokerId),
    );
    if (!preflight.valid) {
      return reject("missing_dispatch_metadata", `Terminal Brief dispatch metadata validation failed: ${preflight.errors.join("; ")}`, now);
    }
    if (request.terminalAck === true) {
      return reject("terminal_ack_forbidden", "cross-broker Terminal Brief projection is aggregate evidence only and cannot ACK a Terminal Brief", now);
    }

    const receiverBrokerId = normalizeToken(this.options.brokerId);
    const addressedBrokerId = normalizeToken(normalized.brokerOfRecordId);
    if (receiverBrokerId && addressedBrokerId && addressedBrokerId !== receiverBrokerId) {
      return reject("wrong_origin", `projection addressed to broker-of-record ${addressedBrokerId}, not ${receiverBrokerId}`, now);
    }
    if (receiverBrokerId && normalized.originBrokerId === receiverBrokerId) {
      return reject("wrong_origin", "cross-broker projection origin must differ from receiving broker", now);
    }
    if (!this.options.hasParentRound(normalized.parentRoundId)) {
      return reject("missing_parent", `parent round ${normalized.parentRoundId} is not present on this broker`, now);
    }
    const parentBroker = normalizeToken(this.options.parentBrokerOfRecord?.(normalized.parentRoundId));
    if (receiverBrokerId && parentBroker && parentBroker !== receiverBrokerId) {
      return reject("wrong_origin", `parent round ${normalized.parentRoundId} belongs to broker-of-record ${parentBroker}`, now);
    }

    // Completed-count validation: reject if accepting this projection would cause
    // the count of distinct projections for this round+origin to exceed parentRoundTotal.
    // Replacements (same recordKey, newer completedAt) are allowed since they don't
    // increase the count.
    if (normalized.parentRoundTotal) {
      const existingCountForRoundOrigin = [...this.records.values()]
        .filter((r) => r.parentRoundId === normalized.parentRoundId && r.originBrokerId === normalized.originBrokerId)
        .length;
      const key = recordKey(normalized);
      const keyAlreadyStored = this.records.has(key);
      const effectiveCount = keyAlreadyStored ? existingCountForRoundOrigin : existingCountForRoundOrigin + 1;
      if (effectiveCount > normalized.parentRoundTotal) {
        return reject("completed_count_exceeded", `cross-broker Terminal Brief projection limit reached for round ${normalized.parentRoundId} from origin ${normalized.originBrokerId}: ${effectiveCount} would exceed parentRoundTotal ${normalized.parentRoundTotal}`, now);
      }
    }

    const key = recordKey(normalized);
    const sourceDigest = digestProjection(normalized);
    const existing = this.records.get(key);
    if (existing?.sourceDigest === sourceDigest) {
      const replayed = {
        ...existing,
        replayCount: existing.replayCount + 1,
        ack: {
          decision: "duplicate_replay" as const,
          terminalAck: false as const,
          reason: "duplicate projection replay suppressed by parentRoundId/originBrokerId/sourceDigest",
          updatedAt: now,
        },
      };
      this.records.set(key, replayed);
      return { accepted: true, replayed: true, record: structuredClone(replayed), ack: replayed.ack };
    }
    if (existing && Date.parse(normalized.completedAt) <= Date.parse(existing.completedAt)) {
      return reject("stale_replay", "projection is older than the stored parentRoundId/originBrokerId aggregate", now);
    }

    const record: CrossBrokerTerminalBriefProjection = {
      id: key,
      ...normalized,
      emittedAt: normalized.emittedAt ?? normalized.completedAt,
      receivedAt: now,
      sourceDigest,
      replayCount: existing?.replayCount ?? 0,
      ack: {
        decision: "accepted",
        terminalAck: false,
        reason: "projection stored for broker-of-record aggregation; no Terminal Brief ACK was emitted",
        updatedAt: now,
      },
    };
    this.records.set(key, record);
    return { accepted: true, replayed: false, record: structuredClone(record), ack: record.ack };
  }

  get(parentRoundId: string, originBrokerId: string): CrossBrokerTerminalBriefProjection | undefined {
    const record = [...this.records.values()]
      .filter((candidate) => candidate.parentRoundId === parentRoundId && candidate.originBrokerId === originBrokerId)
      .sort(compareRecords)[0];
    return record ? structuredClone(record) : undefined;
  }

  list(filters: CrossBrokerTerminalBriefProjectionFilters = {}): CrossBrokerTerminalBriefProjection[] {
    return [...this.records.values()]
      .filter((record) => !filters.parentRoundId || record.parentRoundId === filters.parentRoundId)
      .filter((record) => !filters.originBrokerId || record.originBrokerId === filters.originBrokerId)
      .sort(compareRecords)
      .map((record) => structuredClone(record));
  }

  restore(records: CrossBrokerTerminalBriefProjection[]): void {
    this.records.clear();
    for (const record of records) {
      this.records.set(recordKey(record), normalizeRecord(record));
    }
  }

  snapshot(): CrossBrokerTerminalBriefProjection[] {
    return this.list();
  }
}

function normalizeRequest(request: CrossBrokerTerminalBriefProjectionRequest): Omit<CrossBrokerTerminalBriefProjection, "id" | "receivedAt" | "sourceDigest" | "replayCount" | "ack" | "emittedAt"> & { emittedAt?: string } | undefined {
  const parentRoundId = normalizeToken(request.parentRoundId);
  const originBrokerId = normalizeToken(request.originBrokerId);
  const status = request.status;
  const completedAt = normalizeIso(request.completedAt);
  if (!parentRoundId || !originBrokerId || !TERMINAL_STATUSES.has(status) || !completedAt) return undefined;
  const brokerOfRecordId = normalizeToken(request.brokerOfRecordId);
  const childTaskId = normalizeToken(request.childTaskId);
  const childRunId = normalizeToken(request.childRunId);
  const childWorkerId = normalizeToken(request.childWorkerId ?? request.workerId);
  const emittedAt = normalizeIso(request.emittedAt);
  const evidenceUrl = normalizeHttpUrl(request.evidenceUrl);
  const summary = sanitizeText(request.summary, MAX_SUMMARY_CHARS);
  const taskBrief = sanitizeText(request.taskBrief, MAX_BRIEF_CHARS);
  const parentRoundTotal = normalizePositiveInt(request.parentRoundTotal);
  const parentRoundOrder = normalizePositiveInt(request.parentRoundOrder);
  return {
    parentRoundId,
    originBrokerId,
    ...(brokerOfRecordId ? { brokerOfRecordId } : {}),
    ...(childTaskId ? { childTaskId } : {}),
    ...(childRunId ? { childRunId } : {}),
    ...(childWorkerId ? { childWorkerId } : {}),
    status,
    ...(summary ? { summary } : {}),
    ...(taskBrief ? { taskBrief } : {}),
    ...(evidenceUrl ? { evidenceUrl } : {}),
    completedAt,
    ...(emittedAt ? { emittedAt } : {}),
    ...(parentRoundTotal ? { parentRoundTotal } : {}),
    ...(parentRoundOrder ? { parentRoundOrder } : {}),
  };
}

function normalizeRecord(record: CrossBrokerTerminalBriefProjection): CrossBrokerTerminalBriefProjection {
  const parentRoundTotal = normalizePositiveInt(record.parentRoundTotal);
  const parentRoundOrder = normalizePositiveInt(record.parentRoundOrder);
  const { parentRoundTotal: _parentRoundTotal, parentRoundOrder: _parentRoundOrder, ...rest } = record;
  return {
    ...rest,
    ...(parentRoundTotal ? { parentRoundTotal } : {}),
    ...(parentRoundOrder ? { parentRoundOrder } : {}),
    ack: {
      decision: record.ack?.decision === "duplicate_replay" ? "duplicate_replay" : "accepted",
      terminalAck: false,
      reason: sanitizeText(record.ack?.reason, MAX_REASON_CHARS) ?? "stored cross-broker projection",
      updatedAt: normalizeIso(record.ack?.updatedAt) ?? record.receivedAt,
    },
  };
}

function reject(code: CrossBrokerTerminalBriefRejectCode, reason: string, updatedAt: string): CrossBrokerTerminalBriefProjectionResult {
  return {
    accepted: false,
    replayed: false,
    ack: {
      decision: "rejected",
      terminalAck: false,
      code,
      reason: sanitizeText(reason, MAX_REASON_CHARS) ?? code,
      updatedAt,
    },
  };
}

function digestProjection(record: ReturnType<typeof normalizeRequest> & {}): string {
  return `sha256:${createHash("sha256").update(stableStringify(record)).digest("hex")}`;
}

function recordKey(record: Pick<CrossBrokerTerminalBriefProjection, "parentRoundId" | "originBrokerId" | "childTaskId" | "childWorkerId" | "parentRoundOrder">): string {
  const childKey = record.childTaskId
    ?? (record.childWorkerId ? `worker:${record.childWorkerId}` : undefined)
    ?? (record.parentRoundOrder ? `order:${record.parentRoundOrder}` : undefined)
    ?? "broker";
  return `${record.parentRoundId}::${record.originBrokerId}::${childKey}`;
}

function compareRecords(a: CrossBrokerTerminalBriefProjection, b: CrossBrokerTerminalBriefProjection): number {
  return a.parentRoundId.localeCompare(b.parentRoundId)
    || a.originBrokerId.localeCompare(b.originBrokerId)
    || ((a.parentRoundOrder ?? Number.MAX_SAFE_INTEGER) - (b.parentRoundOrder ?? Number.MAX_SAFE_INTEGER))
    || (a.childTaskId ?? "").localeCompare(b.childTaskId ?? "")
    || (a.childWorkerId ?? "").localeCompare(b.childWorkerId ?? "");
}

function normalizeToken(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeIso(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
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

function normalizeHttpUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" || url.protocol === "http:") return url.toString();
  } catch {
    // Ignore malformed or unsafe local evidence URLs.
  }
  return undefined;
}

function sanitizeText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const sanitized = trimmed
    .replace(/\b(?:ghp|gho|ghu|ghs|github_pat|sk|xox[abp])-[-_A-Za-z0-9]+\b/g, "[redacted]")
    .replace(/\b(token|secret|password|api[_-]?key)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/(^|\s)(?:[A-Za-z]:)?\/[\w./-]+/g, "$1[path]")
    .replace(/\s+/g, " ")
    .slice(0, maxChars);
  return sanitized || undefined;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
