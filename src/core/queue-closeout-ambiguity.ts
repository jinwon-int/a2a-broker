/**
 * Queue closeout ambiguity detector (issue #540).
 *
 * Pure-function diagnostic that identifies ambiguous queue closeout state
 * patterns — stale tasks without owners, mixed closeout states, orphaned
 * replays, and requeue loops — without any DB mutation.
 *
 * Reference: #540 Team1/Bangtong stability gates for #497/#294.
 */

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface QueueCloseoutSnapshot {
  /** Per-status task counts. */
  counts: {
    queued: number;
    claimed: number;
    running: number;
    succeeded: number;
    failed: number;
    canceled: number;
    blocked: number;
  };
  /** Total tasks tracked. */
  total: number;
  /** Number of terminal tasks (succeeded + failed + canceled + blocked). */
  terminal: number;
  /** Closeout reconciler decision if available. */
  closeoutDecision?: "ready" | "waiting" | "blocked" | "failed";
  /** Active tasks that are stale (no heartbeat beyond threshold). */
  staleWorkers?: number;
  /** Terminal tasks whose terminal outbox entries are still unacked. */
  terminalUnackedOutbox?: number;
  /** Tasks exceeding max requeue depth. */
  maxRequeueExceeded?: number;
  /** Total requeue events across non-terminal tasks. */
  requeueDepth?: number;
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

export interface QueueCloseoutAmbiguityThresholds {
  /** Warn when stale workers exceed this count. */
  maxStaleWorkersWarning: number;
  /** When closeout decision is 'waiting' and terminal ratio > this, flag as ambiguous. */
  terminalRatioThreshold: number;
  /** Max requeue depth before flagging a loop. */
  maxRequeueDepthWarning: number;
}

export const DEFAULT_QUEUE_CLOSEOUT_AMBIGUITY_THRESHOLDS: QueueCloseoutAmbiguityThresholds = {
  maxStaleWorkersWarning: 3,
  terminalRatioThreshold: 0.9,
  maxRequeueDepthWarning: 10,
};

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export type CloseoutAmbiguity = "clear" | "ambiguous" | "blocked";

export interface AmbiguityPattern {
  kind:
    | "stale_with_no_owner"
    | "terminal_not_acknowledged"
    | "mixed_closeout_state"
    | "orphaned_replay"
    | "requeue_loop"
    | "blocked_with_no_signal"
    | "closeout_decision_mismatch";
  severity: "info" | "warning" | "critical";
  message: string;
  evidence: Record<string, unknown>;
}

export interface QueueCloseoutAmbiguityResult {
  ambiguity: CloseoutAmbiguity;
  summary: string;
  patterns: AmbiguityPattern[];
  stabilityGatePass: boolean;
  recommendation?: string;
}

// ---------------------------------------------------------------------------
// Core analysis
// ---------------------------------------------------------------------------

export function detectQueueCloseoutAmbiguity(
  snapshot: QueueCloseoutSnapshot,
  thresholds: Partial<QueueCloseoutAmbiguityThresholds> = {},
): QueueCloseoutAmbiguityResult {
  const t = { ...DEFAULT_QUEUE_CLOSEOUT_AMBIGUITY_THRESHOLDS, ...thresholds };
  const patterns: AmbiguityPattern[] = [];

  // 1. Stale workers with no owner
  if ((snapshot.staleWorkers ?? 0) > t.maxStaleWorkersWarning) {
    patterns.push({
      kind: "stale_with_no_owner",
      severity: "warning",
      message: `${snapshot.staleWorkers} stale worker(s) detected — no active owner, may block queue closeout`,
      evidence: { staleWorkers: snapshot.staleWorkers, threshold: t.maxStaleWorkersWarning },
    });
  }

  // 2. Terminal tasks with unacked outbox entries
  if ((snapshot.terminalUnackedOutbox ?? 0) > 0) {
    const count = snapshot.terminalUnackedOutbox!;
    patterns.push({
      kind: "terminal_not_acknowledged",
      severity: count > 10 ? "critical" : "warning",
      message: `${count} terminal task(s) have unacked outbox entries — closeout is ambiguous until receipt evidence is confirmed`,
      evidence: { terminalUnackedOutbox: count },
    });
  }

  // 3. Mixed closeout state (many terminal but still active/running)
  if (snapshot.total > 0) {
    const terminalRatio = snapshot.terminal / snapshot.total;
    const hasActive = snapshot.counts.claimed > 0 || snapshot.counts.running > 0 || snapshot.counts.queued > 0;
    if (terminalRatio >= t.terminalRatioThreshold && hasActive) {
      patterns.push({
        kind: "mixed_closeout_state",
        severity: "warning",
        message: `${Math.round(terminalRatio * 100)}% of tasks are terminal but ${snapshot.counts.claimed + snapshot.counts.running + snapshot.counts.queued} tasks are still active/queued — closeout decision is ambiguous`,
        evidence: { terminalRatio, active: snapshot.counts.claimed + snapshot.counts.running + snapshot.counts.queued, queued: snapshot.counts.queued },
      });
    }
  }

  // 4. Closeout decision mismatch
  if (snapshot.closeoutDecision) {
    const decision = snapshot.closeoutDecision;
    const terminalRatio = snapshot.total > 0 ? snapshot.terminal / snapshot.total : 0;
    if (decision === "ready" && terminalRatio < 1) {
      patterns.push({
        kind: "closeout_decision_mismatch",
        severity: "critical",
        message: `Closeout decision is 'ready' but only ${Math.round(terminalRatio * 100)}% of ${snapshot.total} tasks are terminal`,
        evidence: { decision, terminalRatio, total: snapshot.total, terminal: snapshot.terminal },
      });
    }
    if (decision === "waiting" && terminalRatio >= 1 && snapshot.total > 0) {
      patterns.push({
        kind: "closeout_decision_mismatch",
        severity: "warning",
        message: `Closeout decision is 'waiting' but all ${snapshot.total} tasks are terminal — may be a stale status`,
        evidence: { decision, terminalRatio, total: snapshot.total },
      });
    }
  }

  // 5. Orphaned replay (claimed/running but no recent activity)
  if ((snapshot.staleWorkers ?? 0) > 0 && (snapshot.counts.claimed > 0 || snapshot.counts.running > 0)) {
    patterns.push({
      kind: "orphaned_replay",
      severity: "info",
      message: `${snapshot.staleWorkers} stale worker(s) with ${snapshot.counts.claimed} claimed and ${snapshot.counts.running} running tasks — may indicate orphaned replay`,
      evidence: { staleWorkers: snapshot.staleWorkers, claimed: snapshot.counts.claimed, running: snapshot.counts.running },
    });
  }

  // 6. Requeue loop
  if ((snapshot.requeueDepth ?? 0) > t.maxRequeueDepthWarning) {
    patterns.push({
      kind: "requeue_loop",
      severity: "warning",
      message: `Requeue depth ${snapshot.requeueDepth} exceeds warning threshold ${t.maxRequeueDepthWarning} — possible requeue loop`,
      evidence: { requeueDepth: snapshot.requeueDepth, threshold: t.maxRequeueDepthWarning },
    });
  }

  // 7. Blocked with no signal (closeout already blocked but patterns unclear)
  if (snapshot.closeoutDecision === "blocked" && snapshot.counts.blocked === 0) {
    patterns.push({
      kind: "blocked_with_no_signal",
      severity: "warning",
      message: "Closeout is marked blocked but no tasks are in 'blocked' status — may be a false blocked signal",
      evidence: { decision: "blocked", blockedCount: snapshot.counts.blocked },
    });
  }

  // Compute ambiguity
  const criticalCount = patterns.filter((p) => p.severity === "critical").length;
  const warningCount = patterns.filter((p) => p.severity === "warning").length;

  let ambiguity: CloseoutAmbiguity;
  if (criticalCount > 0 || snapshot.closeoutDecision === "blocked") {
    ambiguity = "blocked";
  } else if (warningCount > 0) {
    ambiguity = "ambiguous";
  } else {
    ambiguity = "clear";
  }

  const stabilityGatePass = ambiguity === "clear";

  // Summary
  const summary = snapshot.total === 0
    ? "Queue is empty — no closeout ambiguity."
    : ambiguity === "blocked"
      ? `BLOCKED: ${criticalCount} critical, ${warningCount} warning pattern(s). Closeout state must be resolved before gate passes.`
      : ambiguity === "ambiguous"
        ? `AMBIGUOUS: ${warningCount} warning pattern(s). Closeout state needs review.`
        : "CLEAR: No ambiguous closeout patterns detected.";

  // Recommendation
  let recommendation: string | undefined;
  if (patterns.some((p) => p.kind === "terminal_not_acknowledged" && p.severity === "critical")) {
    recommendation = "Resolve unacked terminal outbox entries before closeout — provider-sent is not receipt evidence per #294.";
  } else if (patterns.some((p) => p.kind === "closeout_decision_mismatch" && p.severity === "critical")) {
    recommendation = "Reconcile closeout decision — terminal ratio does not match declared state.";
  } else if (patterns.some((p) => p.kind === "requeue_loop")) {
    recommendation = "Investigate requeue loop — reduce requeue depth or mark affected tasks for manual triage.";
  }

  return { ambiguity, summary, patterns, stabilityGatePass, recommendation };
}
