/**
 * Handoff scenario classifier and recovery ledger (issue #69).
 *
 * Classifies handoff attempts into S1–S5 scenarios and maintains a
 * durable ledger of handoff outcomes for recovery and observability.
 */

import { randomUUID } from "node:crypto";
import type {
  HandoffScenarioId,
  HandoffPhase,
  HandoffFailureKind,
  HandoffOutcome,
  HandoffContext,
  HandoffLoopDecision,
  HandoffRecord,
  RecoveryLedgerEntry,
  RecoveryLedgerSummary,
} from "./handoff-types.js";
import { HANDOFF_SCENARIO_LABELS } from "./handoff-types.js";

const DEFAULT_MAX_HANDOFF_HOPS = 8;

// ---------------------------------------------------------------------------
// Scenario classification
// ---------------------------------------------------------------------------

/**
 * Classify a handoff context into one of S1–S5 scenarios.
 *
 * Decision tree:
 *   1. Duplicate idempotency key seen before → S4
 *   2. Recovery of a previous failed handoff → S5
 *   3. Receiver unreachable or previously rejected → S2
 *   4. Sender crashed during a previous attempt → S3
 *   5. Otherwise → S1
 */
export function classifyHandoff(ctx: HandoffContext): HandoffScenarioId {
  if (ctx.duplicateOf) return "S4_duplicate";
  if (ctx.recoveryOf) return "S5_recovery";
  if (!ctx.receiverReachable || ctx.previousFailureKind === "receiver_unreachable" || ctx.previousFailureKind === "receiver_rejected") {
    return "S2_receiver_unavailable";
  }
  if (ctx.senderCrashed || ctx.previousFailureKind === "sender_crash") {
    return "S3_sender_crash";
  }
  return "S1_normal";
}

// ---------------------------------------------------------------------------
// Expected outcomes per scenario
// ---------------------------------------------------------------------------

/** Expected primary outcome for a scenario. */
export function expectedOutcome(scenarioId: HandoffScenarioId): HandoffOutcome {
  switch (scenarioId) {
    case "S1_normal": return "delivered";
    case "S2_receiver_unavailable": return "rejected";
    case "S3_sender_crash": return "partial";
    case "S4_duplicate": return "deduplicated";
    case "S5_recovery": return "retried";
  }
}

/** Determine if a scenario should trigger automatic retry. */
export function shouldAutoRetry(scenarioId: HandoffScenarioId): boolean {
  return scenarioId === "S2_receiver_unavailable" || scenarioId === "S3_sender_crash";
}

/** Determine if a scenario should escalate to recovery ledger. */
export function shouldEscalate(scenarioId: HandoffScenarioId): boolean {
  return scenarioId !== "S1_normal";
}

// ---------------------------------------------------------------------------
// Handoff record factory
// ---------------------------------------------------------------------------

export function createHandoffRecord(
  ctx: HandoffContext,
  scenarioId?: HandoffScenarioId,
): HandoffRecord {
  const id = scenarioId ?? classifyHandoff(ctx);
  const loop = evaluateHandoffLoop(ctx);
  return {
    id: randomUUID(),
    scenarioId: id,
    senderNodeId: ctx.senderNodeId,
    senderSessionId: ctx.senderSessionId,
    receiverNodeId: ctx.receiverNodeId,
    receiverSessionId: ctx.receiverSessionId,
    taskId: ctx.taskId,
    exchangeId: ctx.exchangeId,
    phase: "initiated",
    seq: 0,
    initiatedAt: new Date().toISOString(),
    idempotencyKey: ctx.idempotencyKey,
    recoveryOf: ctx.recoveryOf,
    partialSnapshot: ctx.senderCrashed ? JSON.stringify({ crashed: true, at: new Date().toISOString() }) : undefined,
    originNodeId: loop.originNodeId,
    hopPath: loop.hopPath,
    hopCount: loop.hopCount,
    maxHops: loop.maxHops,
    metadata: {
      ...(loop.allowed ? {} : { loopGuard: loop }),
    },
  };
}

/**
 * Evaluate whether dispatching sender → receiver would create a handoff loop.
 *
 * A single one-way dispatch such as A → B is allowed. Re-delegating the same
 * logical task back to any node already in the path is rejected, which covers
 * both direct ping-pong (A → B → A) and indirect loops (A → B → C → A).
 */
export function evaluateHandoffLoop(ctx: HandoffContext): HandoffLoopDecision {
  const originNodeId = ctx.originNodeId ?? ctx.hopPath?.[0] ?? ctx.senderNodeId;
  const normalizedPath = normalizeHopPath(ctx.hopPath, ctx.senderNodeId, originNodeId);
  const maxHops = ctx.maxHops ?? DEFAULT_MAX_HANDOFF_HOPS;
  const nextHopPath = [...normalizedPath, ctx.receiverNodeId];
  const base = {
    originNodeId,
    hopPath: normalizedPath,
    nextHopPath,
    hopCount: nextHopPath.length - 1,
    maxHops,
  };

  if (ctx.senderNodeId === ctx.receiverNodeId) {
    return { ...base, allowed: false, reason: "same_sender_receiver" };
  }
  if (nextHopPath.length - 1 > maxHops) {
    return { ...base, allowed: false, reason: "max_hops_exceeded" };
  }
  if (normalizedPath.includes(ctx.receiverNodeId)) {
    const reason = normalizedPath[normalizedPath.length - 2] === ctx.receiverNodeId
      ? "direct_loop"
      : "indirect_loop";
    return { ...base, allowed: false, reason };
  }
  return { ...base, allowed: true };
}

export function applyHandoffLoopGuard(record: HandoffRecord): HandoffRecord {
  const decision = record.metadata?.loopGuard as HandoffLoopDecision | undefined;
  if (!decision || decision.allowed) return record;
  if (record.phase !== "initiated") return record;
  return transitionPhase(record, "failed", {
    failureKind: "handoff_loop_guard",
    failureMessage: `handoff loop guard rejected ${record.senderNodeId} → ${record.receiverNodeId}: ${decision.reason}`,
  });
}

function normalizeHopPath(hopPath: string[] | undefined, senderNodeId: string, originNodeId: string): string[] {
  const path = (hopPath && hopPath.length > 0 ? hopPath : [originNodeId]).filter(Boolean);
  if (path[0] !== originNodeId) path.unshift(originNodeId);
  if (path[path.length - 1] !== senderNodeId) path.push(senderNodeId);
  return path;
}

// ---------------------------------------------------------------------------
// Phase transitions
// ---------------------------------------------------------------------------

const VALID_TRANSITIONS: Record<HandoffPhase, ReadonlySet<HandoffPhase>> = {
  initiated: new Set(["dispatched", "failed", "canceled"]),
  dispatched: new Set(["acknowledged", "completed", "failed", "timed_out", "canceled"]),
  acknowledged: new Set(["completed", "failed", "timed_out", "canceled"]),
  completed: new Set([]),
  failed: new Set([]),
  timed_out: new Set([]),
  canceled: new Set([]),
};

export function transitionPhase(
  record: HandoffRecord,
  next: HandoffPhase,
  opts?: { failureKind?: HandoffFailureKind; failureMessage?: string },
): HandoffRecord {
  const allowed = VALID_TRANSITIONS[record.phase];
  if (!allowed.has(next)) {
    throw new Error(
      `Invalid handoff phase transition: ${record.phase} → ${next} ` +
      `(allowed: ${[...allowed].join(", ")})`,
    );
  }
  const now = new Date().toISOString();
  record.phase = next;
  record.seq++;
  switch (next) {
    case "dispatched":
      record.dispatchedAt = now;
      break;
    case "acknowledged":
      record.acknowledgedAt = now;
      break;
    case "completed":
      record.completedAt = now;
      break;
    case "failed":
      record.failedAt = now;
      if (opts?.failureKind) record.failureKind = opts.failureKind;
      if (opts?.failureMessage) record.failureMessage = opts.failureMessage;
      break;
    case "timed_out":
      record.failedAt = now;
      record.failureKind = "timeout";
      break;
    case "canceled":
      record.failedAt = now;
      record.failureKind = "policy_violation";
      break;
  }
  return record;
}

// ---------------------------------------------------------------------------
// Recovery ledger
// ---------------------------------------------------------------------------

export class RecoveryLedger {
  private readonly entries = new Map<string, RecoveryLedgerEntry>();
  private readonly handoffs = new Map<string, HandoffRecord>();
  private readonly idempotencyIndex = new Map<string, Set<string>>(); // key → handoffIds

  /** Record a new handoff attempt. */
  record(record: HandoffRecord): void {
    applyHandoffLoopGuard(record);
    this.handoffs.set(record.id, record);
    let ids = this.idempotencyIndex.get(record.idempotencyKey);
    if (!ids) {
      ids = new Set();
      this.idempotencyIndex.set(record.idempotencyKey, ids);
    }
    ids.add(record.id);
  }

  /** Get a handoff by id. */
  getHandoff(id: string): HandoffRecord | undefined {
    return this.handoffs.get(id);
  }

  /** Check if an idempotency key has been seen. Returns first matching id. */
  findDuplicate(idempotencyKey: string): string | undefined {
    const ids = this.idempotencyIndex.get(idempotencyKey);
    return ids ? ids.values().next().value : undefined;
  }

  /** Get all handoffs for a given task. */
  getByTask(taskId: string): HandoffRecord[] {
    return [...this.handoffs.values()].filter(h => h.taskId === taskId);
  }

  /** Get all handoffs for a given idempotency key (original + retries). */
  getByIdempotencyKey(idempotencyKey: string): HandoffRecord[] {
    const ids = this.idempotencyIndex.get(idempotencyKey);
    if (!ids) return [];
    const result: HandoffRecord[] = [];
    for (const id of ids) {
      const h = this.handoffs.get(id);
      if (h) result.push(h);
    }
    // Also pull in recovery chain members
    const allIds = new Set(ids);
    let grown = true;
    while (grown) {
      grown = false;
      for (const h of this.handoffs.values()) {
        if (h.recoveryOf && allIds.has(h.recoveryOf) && !allIds.has(h.id)) {
          allIds.add(h.id);
          result.push(h);
          grown = true;
        }
      }
    }
    return result;
  }

  /**
   * Seal a handoff attempt: compute outcome, create ledger entry.
   * Returns the ledger entry.
   */
  seal(handoffId: string): RecoveryLedgerEntry {
    const h = this.handoffs.get(handoffId);
    if (!h) throw new Error(`Unknown handoff: ${handoffId}`);

    const outcome = computeOutcome(h);
    const durationMs = h.completedAt || h.failedAt
      ? new Date(h.completedAt || h.failedAt!).getTime() - new Date(h.initiatedAt).getTime()
      : 0;

    const attemptChain = this.getByIdempotencyKey(h.idempotencyKey);
    const attemptNumber = attemptChain.indexOf(h);

    const entry: RecoveryLedgerEntry = {
      handoffId: h.id,
      scenarioId: h.scenarioId,
      outcome,
      attemptNumber: Math.max(0, attemptNumber),
      durationMs,
      failureKind: h.failureKind,
      sealedAt: new Date().toISOString(),
    };

    this.entries.set(handoffId, entry);
    return entry;
  }

  /** Get a sealed ledger entry. */
  getEntry(handoffId: string): RecoveryLedgerEntry | undefined {
    return this.entries.get(handoffId);
  }

  /** Compute summary statistics. */
  summary(): RecoveryLedgerSummary {
    const byScenario: Record<HandoffScenarioId, number> = {
      S1_normal: 0, S2_receiver_unavailable: 0, S3_sender_crash: 0,
      S4_duplicate: 0, S5_recovery: 0,
    };
    const byOutcome: Record<HandoffOutcome, number> = {
      delivered: 0, rejected: 0, timed_out: 0, partial: 0,
      deduplicated: 0, retried: 0, failed: 0,
    };
    let recoveryDurationSum = 0;
    let recoveryCount = 0;

    for (const entry of this.entries.values()) {
      byScenario[entry.scenarioId]++;
      byOutcome[entry.outcome]++;
      if (entry.scenarioId === "S5_recovery") {
        recoveryCount++;
        recoveryDurationSum += entry.durationMs;
      }
    }

    const activeCount = [...this.handoffs.values()].filter(
      h => !this.entries.has(h.id),
    ).length;

    return {
      totalAttempts: this.entries.size,
      byScenario,
      byOutcome,
      activeCount,
      recoveryCount,
      avgRecoveryDurationMs: recoveryCount > 0 ? Math.round(recoveryDurationSum / recoveryCount) : 0,
    };
  }

  /** Get all sealed entries. */
  getAllEntries(): RecoveryLedgerEntry[] {
    return [...this.entries.values()];
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function computeOutcome(h: HandoffRecord): HandoffOutcome {
  switch (h.phase) {
    case "completed":
      if (h.scenarioId === "S4_duplicate") return "deduplicated";
      if (h.scenarioId === "S5_recovery") return "retried";
      return "delivered";
    case "timed_out":
      return "timed_out";
    case "failed":
      if (h.scenarioId === "S3_sender_crash") return "partial";
      if (h.failureKind === "receiver_rejected" || h.failureKind === "receiver_unreachable") return "rejected";
      return "failed";
    case "canceled":
      return "failed";
    default:
      return "partial";
  }
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export { HANDOFF_SCENARIO_LABELS };
export type {
  HandoffScenarioId,
  HandoffPhase,
  HandoffFailureKind,
  HandoffOutcome,
  HandoffContext,
  HandoffRecord,
  HandoffLoopDecision,
  RecoveryLedgerEntry,
  RecoveryLedgerSummary,
} from "./handoff-types.js";
