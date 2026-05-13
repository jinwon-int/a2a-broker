import { createHash } from "node:crypto";

import type { TaskStatus } from "./types.js";

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
  | "terminal_ack_forbidden";

export interface CrossBrokerTerminalBriefProjectionRequest {
  /** Parent round/task id owned by the receiving broker-of-record. */
  parentRoundId: string;
  /** Broker that produced the child Terminal Brief. */
  originBrokerId: string;
  /** Receiving broker id the packet was addressed to. Required when the receiver has a broker id. */
  brokerOfRecordId?: string;
  childTaskId?: string;
  childRunId?: string;
  status: Extract<TaskStatus, "succeeded" | "failed" | "canceled" | "blocked">;
  summary?: string;
  taskBrief?: string;
  evidenceUrl?: string;
  completedAt: string;
  emittedAt?: string;
  /** Cross-broker projections are not Terminal Brief ACKs; this must be absent/false. */
  terminalAck?: boolean;
  /** Total worker/task count expected for the parent round (denominator). */
  parentRoundTotal?: number;
}

export interface CrossBrokerTerminalBriefProjection {
  id: string;
  parentRoundId: string;
  originBrokerId: string;
  brokerOfRecordId?: string;
  childTaskId?: string;
  childRunId?: string;
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
 * The key is intentionally only `(parentRoundId, originBrokerId)`: replaying the same child
 * broker packet converges to one aggregate row, while stale or misaddressed packets fail closed
 * and never become Terminal Brief ACKs.
 */
export class CrossBrokerTerminalBriefProjectionStore {
  private readonly records = new Map<string, CrossBrokerTerminalBriefProjection>();

  constructor(
    records: CrossBrokerTerminalBriefProjection[] = [],
    private readonly options: CrossBrokerTerminalBriefProjectionStoreOptions,
  ) {
    for (const record of records) {
      this.records.set(recordKey(record.parentRoundId, record.originBrokerId), normalizeRecord(record));
    }
  }

  ingest(request: CrossBrokerTerminalBriefProjectionRequest): CrossBrokerTerminalBriefProjectionResult {
    const now = (this.options.now?.() ?? new Date()).toISOString();
    const normalized = normalizeRequest(request);
    if (!normalized) {
      return reject("bad_request", "cross-broker Terminal Brief projection requires parentRoundId, originBrokerId, terminal status, and completedAt", now);
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

    const key = recordKey(normalized.parentRoundId, normalized.originBrokerId);
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
    const record = this.records.get(recordKey(parentRoundId, originBrokerId));
    return record ? structuredClone(record) : undefined;
  }

  list(filters: CrossBrokerTerminalBriefProjectionFilters = {}): CrossBrokerTerminalBriefProjection[] {
    return [...this.records.values()]
      .filter((record) => !filters.parentRoundId || record.parentRoundId === filters.parentRoundId)
      .filter((record) => !filters.originBrokerId || record.originBrokerId === filters.originBrokerId)
      .sort((a, b) => a.parentRoundId.localeCompare(b.parentRoundId) || a.originBrokerId.localeCompare(b.originBrokerId))
      .map((record) => structuredClone(record));
  }

  restore(records: CrossBrokerTerminalBriefProjection[]): void {
    this.records.clear();
    for (const record of records) {
      this.records.set(recordKey(record.parentRoundId, record.originBrokerId), normalizeRecord(record));
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
  const emittedAt = normalizeIso(request.emittedAt);
  const evidenceUrl = normalizeHttpUrl(request.evidenceUrl);
  const summary = sanitizeText(request.summary, MAX_SUMMARY_CHARS);
  const taskBrief = sanitizeText(request.taskBrief, MAX_BRIEF_CHARS);
  return {
    parentRoundId,
    originBrokerId,
    ...(brokerOfRecordId ? { brokerOfRecordId } : {}),
    ...(childTaskId ? { childTaskId } : {}),
    ...(childRunId ? { childRunId } : {}),
    status,
    ...(summary ? { summary } : {}),
    ...(taskBrief ? { taskBrief } : {}),
    ...(evidenceUrl ? { evidenceUrl } : {}),
    completedAt,
    ...(emittedAt ? { emittedAt } : {}),
  };
}

function normalizeRecord(record: CrossBrokerTerminalBriefProjection): CrossBrokerTerminalBriefProjection {
  return {
    ...record,
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

function recordKey(parentRoundId: string, originBrokerId: string): string {
  return `${parentRoundId}::${originBrokerId}`;
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
