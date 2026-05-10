/**
 * Autonomous aggregate closeout reconciler (issue #78).
 *
 * Consumes child task events and produces deterministic closeout decisions
 * for parent aggregate tasks without polling.
 *
 * Decision types: `ready` | `waiting` | `blocked` | `failed`
 */

import type { BrokerExitCondition, TaskStatus } from "./types.js";

// ---------------------------------------------------------------------------
// Closeout decision
// ---------------------------------------------------------------------------

export type CloseoutDecision = "ready" | "waiting" | "blocked" | "failed";

export interface CloseoutVerdict {
  /** Deterministic decision for the parent aggregate. */
  decision: CloseoutDecision;
  /** Human-readable reason. */
  reason: string;
  /** Number of children in each terminal/non-terminal state. */
  stateCounts: {
    total: number;
    succeeded: number;
    failed: number;
    canceled: number;
    active: number;
    queued: number;
    stale: number;
  };
  /** Which child IDs contributed to the decision. */
  signals: string[];
  /** Timestamp of this verdict. */
  decidedAt: string;
  /** Sequence number (monotonically increasing). */
  seq: number;
  /**
   * Broker outcome classification (issue #471).
   * Refines the closeout decision with the exit condition:
   * pr_success, no_change_done, no_change_block, or infra_failure.
   * Set when the reconciler can determine why a task ended based on
   * child evidence.
   */
  outcomeClass?: BrokerExitCondition;
}

// ---------------------------------------------------------------------------
// Child event (input to reconciler)
// ---------------------------------------------------------------------------

export interface ChildTaskEvent {
  childTaskId: string;
  status: TaskStatus;
  /** Optional: is this child stale (no heartbeat beyond threshold)? */
  stale?: boolean;
  /** Optional: requeue count for this child. */
  requeueCount?: number;
  /** Optional: error message if failed. */
  errorMessage?: string;
  /** Optional: artifact IDs if succeeded. */
  artifactIds?: string[];
  /** Optional: timestamp of this observation. */
  observedAt?: string;
}

export interface CloseoutConfig {
  /** Fail-fast: if true, any child failure blocks parent. Default: true. */
  failFast?: boolean;
  /** Max requeue attempts before treating as permanently failed. Default: 3. */
  maxRequeueAttempts?: number;
  /** Staleness threshold in seconds. If stale, child is considered blocked. Default: true. */
  treatStaleAsBlocked?: boolean;
}

const DEFAULT_CONFIG: Required<CloseoutConfig> = {
  failFast: true,
  maxRequeueAttempts: 3,
  treatStaleAsBlocked: true,
};

// ---------------------------------------------------------------------------
// Reconciler
// ---------------------------------------------------------------------------

export class CloseoutReconciler {
  private readonly children = new Map<string, ChildTaskEvent>();
  private seq = 0;
  private readonly config: Required<CloseoutConfig>;

  constructor(config?: CloseoutConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Ingest a child task event. Returns the updated verdict. */
  ingest(event: ChildTaskEvent): CloseoutVerdict {
    const existing = this.children.get(event.childTaskId);
    if (existing && existing.status === event.status && existing.stale === event.stale) {
      // No-op: same state
      return this.computeVerdict();
    }
    this.children.set(event.childTaskId, { ...event, observedAt: event.observedAt ?? new Date().toISOString() });
    this.seq++;
    return this.computeVerdict();
  }

  /** Get current verdict without ingesting new data. */
  currentVerdict(): CloseoutVerdict {
    return this.computeVerdict();
  }

  /** Get all tracked child events. */
  getChildren(): ChildTaskEvent[] {
    return [...this.children.values()];
  }

  /** Get tracked child count. */
  getChildCount(): number {
    return this.children.size;
  }

  /** Reset reconciler state. */
  reset(): void {
    this.children.clear();
    this.seq = 0;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private computeVerdict(): CloseoutVerdict {
    const children = [...this.children.values()];
    const total = children.length;

    if (total === 0) {
      return this.verdict("waiting", "No children tracked", [], { total: 0, succeeded: 0, failed: 0, canceled: 0, active: 0, queued: 0, stale: 0 });
    }

    let succeeded = 0, failed = 0, canceled = 0, active = 0, queued = 0, stale = 0;
    const signals: string[] = [];

    for (const child of children) {
      switch (child.status) {
        case "succeeded":
          succeeded++;
          break;
        case "failed":
          failed++;
          if (this.config.failFast) {
            signals.push(child.childTaskId);
          }
          break;
        case "canceled":
          canceled++;
          signals.push(child.childTaskId);
          break;
        case "running":
        case "claimed":
          active++;
          if (child.stale && this.config.treatStaleAsBlocked) {
            stale++;
            signals.push(child.childTaskId);
          }
          break;
        case "queued":
          queued++;
          break;
      }
    }

    const terminal = succeeded + failed + canceled;
    const blocked = (this.config.failFast ? failed : 0) + canceled + stale;

    // Decision logic
    if (blocked > 0 && this.config.failFast) {
      const reasons: string[] = [];
      if (failed > 0) reasons.push(`${failed} failed`);
      if (canceled > 0) reasons.push(`${canceled} canceled`);
      if (stale > 0) reasons.push(`${stale} stale`);
      return this.verdict("blocked", reasons.join(", "), signals, { total, succeeded, failed, canceled, active, queued, stale });
    }

    // Check for max-requeue exceeded children
    const maxRequeueExceeded = children.filter(
      c => (c.requeueCount ?? 0) >= this.config.maxRequeueAttempts && c.status !== "succeeded",
    );
    if (maxRequeueExceeded.length > 0) {
      return this.verdict("failed", `${maxRequeueExceeded.length} child(ren) exceeded max requeue (${this.config.maxRequeueAttempts})`, maxRequeueExceeded.map(c => c.childTaskId), { total, succeeded, failed, canceled, active, queued, stale });
    }

    // All terminal
    if (terminal === total) {
      if (failed > 0 && !this.config.failFast) {
        // Non-fail-fast: parent succeeds even with failures
        return this.verdict("ready", `All children terminal (${succeeded} succeeded, ${failed} failed — fail-fast disabled)`, [], { total, succeeded, failed, canceled, active, queued, stale });
      }
      return this.verdict("ready", `All ${total} children succeeded`, [], { total, succeeded, failed, canceled, active, queued, stale });
    }

    // Has stale children but not fail-fast mode
    if (stale > 0 && !this.config.failFast) {
      return this.verdict("waiting", `${stale} stale child(ren), ${terminal}/${total} terminal`, signals, { total, succeeded, failed, canceled, active, queued, stale });
    }

    // Still in progress
    return this.verdict("waiting", `${terminal}/${total} terminal, ${active} active, ${queued} queued`, signals, { total, succeeded, failed, canceled, active, queued, stale });
  }

  private verdict(
    decision: CloseoutDecision,
    reason: string,
    signals: string[],
    stateCounts: CloseoutVerdict["stateCounts"],
  ): CloseoutVerdict {
    return {
      decision,
      reason,
      stateCounts,
      signals,
      decidedAt: new Date().toISOString(),
      seq: this.seq,
    };
  }
}

// ---------------------------------------------------------------------------
// Command-center comment formatter
// ---------------------------------------------------------------------------

export interface CloseoutComment {
  text: string;
  verdict: CloseoutVerdict;
}

/** Format a verdict as a command-center closeout comment. */
export function formatCloseoutComment(verdict: CloseoutVerdict, parentId?: string): CloseoutComment {
  const icon = { ready: "✅", waiting: "⏳", blocked: "🚫", failed: "❌" }[verdict.decision];
  const s = verdict.stateCounts;

  const lines = [
    `${icon} **Closeout: ${verdict.decision.toUpperCase()}**`,
    `> ${verdict.reason}`,
    `> Children: ${s.succeeded}✓ ${s.failed}✗ ${s.canceled}⊘ ${s.active}⟳ ${s.queued}⋯ ${s.stale}⏰`,
  ];

  if (verdict.signals.length > 0) {
    lines.push(`> Signals: ${verdict.signals.join(", ")}`);
  }

  if (parentId) {
    lines.push(`> Parent: \`${parentId}\` | seq: ${verdict.seq}`);
  }

  return { text: lines.join("\n"), verdict };
}
