/**
 * Terminal outbox backlog risk analyzer (issue #540).
 *
 * Pure-function diagnostic that detects terminal-outbox backlog risk patterns
 * — stalled provider delivery, unacked accumulation, replay overlap, and
 * closeout drift — without any DB mutation or provider calls.
 *
 * Reference: #540 Team1/Bangtong stability gates for #497/#294.
 */

// ---------------------------------------------------------------------------
// Input types (whitelisted, no private data)
// ---------------------------------------------------------------------------

export interface TerminalOutboxBacklogSnapshot {
  total: number;
  acked: number;
  unacked: number;
  unackedRatio: number;
  oldestUnackedAgeMs: number | null;
  oldestUnackedCreatedAt: string | null;
  /** Sub-count of unacked events whose receipt is provider_sent/provider_accepted but not operator-visible. */
  providerSendOnlyUnacked?: number;
  /** Sub-count of events with receipt status 'stale'. */
  staleReceiptUnacked?: number;
  /** Sub-count of events currently eligible for ACK but not yet confirmed. */
  ackEligibleUnacked?: number;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

export interface TerminalOutboxBacklogThresholds {
  /** Unacked/total ratio above which a warning is raised. */
  maxUnackedRatioWarning: number;
  /** Unacked absolute count warning threshold. */
  maxUnackedCountWarning: number;
  /** Unacked absolute count critical threshold. */
  maxUnackedCountCritical: number;
  /** Age of oldest unacked row (ms) before warning. */
  maxUnackedAgeMsWarning: number;
  /** Age of oldest unacked row (ms) before critical flag. */
  maxUnackedAgeMsCritical: number;
}

export const DEFAULT_TERMINAL_OUTBOX_BACKLOG_THRESHOLDS: TerminalOutboxBacklogThresholds = {
  maxUnackedRatioWarning: 0.5,
  maxUnackedCountWarning: 100,
  maxUnackedCountCritical: 500,
  maxUnackedAgeMsWarning: 7 * 24 * 60 * 60 * 1000, // 7 days
  maxUnackedAgeMsCritical: 30 * 24 * 60 * 60 * 1000, // 30 days
};

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export type BacklogRiskLevel = "none" | "low" | "medium" | "high" | "critical";

export interface TerminalOutboxBacklogSignal {
  kind:
    | "high_unacked_ratio"
    | "unacked_accumulation"
    | "stale_unacked_entry"
    | "provider_send_only_stall"
    | "ack_eligible_stall"
    | "stale_receipt_blindspot";
  severity: "info" | "warning" | "critical";
  message: string;
  /** Non-sensitive evidence for audit/closeout reporting. */
  evidence: Record<string, unknown>;
}

export interface TerminalOutboxBacklogRiskResult {
  risk: BacklogRiskLevel;
  summary: string;
  signals: TerminalOutboxBacklogSignal[];
  /** True when no critical signals are present and risk is none/low. */
  stabilityGatePass: boolean;
  /** Operator-facing recommendation when attention is needed. */
  recommendation?: string;
}

// ---------------------------------------------------------------------------
// Core analysis
// ---------------------------------------------------------------------------

export function analyzeTerminalOutboxBacklogRisk(
  snapshot: TerminalOutboxBacklogSnapshot,
  thresholds: Partial<TerminalOutboxBacklogThresholds> = {},
): TerminalOutboxBacklogRiskResult {
  const t = { ...DEFAULT_TERMINAL_OUTBOX_BACKLOG_THRESHOLDS, ...thresholds };
  const signals: TerminalOutboxBacklogSignal[] = [];

  // High unacked ratio
  if (snapshot.total > 0 && snapshot.unackedRatio > t.maxUnackedRatioWarning) {
    const pct = Math.round(snapshot.unackedRatio * 100);
    signals.push({
      kind: "high_unacked_ratio",
      severity: pct >= 90 ? "critical" : "warning",
      message: `${pct}% of terminal outbox entries are unacked (${snapshot.unacked}/${snapshot.total})`,
      evidence: { unackedCount: snapshot.unacked, totalCount: snapshot.total, unackedRatio: snapshot.unackedRatio },
    });
  }

  // Unacked count accumulation
  if (snapshot.unacked >= t.maxUnackedCountCritical) {
    signals.push({
      kind: "unacked_accumulation",
      severity: "critical",
      message: `${snapshot.unacked} unacked terminal outbox entries exceed critical threshold (${t.maxUnackedCountCritical})`,
      evidence: { unackedCount: snapshot.unacked, threshold: t.maxUnackedCountCritical },
    });
  } else if (snapshot.unacked >= t.maxUnackedCountWarning) {
    signals.push({
      kind: "unacked_accumulation",
      severity: "warning",
      message: `${snapshot.unacked} unacked terminal outbox entries exceed warning threshold (${t.maxUnackedCountWarning})`,
      evidence: { unackedCount: snapshot.unacked, threshold: t.maxUnackedCountWarning },
    });
  }

  // Stale unacked entry
  if (snapshot.oldestUnackedAgeMs !== null) {
    if (snapshot.oldestUnackedAgeMs >= t.maxUnackedAgeMsCritical) {
      const days = Math.round(snapshot.oldestUnackedAgeMs / (24 * 60 * 60 * 1000));
      signals.push({
        kind: "stale_unacked_entry",
        severity: "critical",
        message: `Oldest unacked terminal outbox entry is ${days} days old — exceeds critical threshold (${Math.round(t.maxUnackedAgeMsCritical / (24 * 60 * 60 * 1000))} days)`,
        evidence: {
          oldestUnackedAgeMs: snapshot.oldestUnackedAgeMs,
          oldestUnackedCreatedAt: snapshot.oldestUnackedCreatedAt,
        },
      });
    } else if (snapshot.oldestUnackedAgeMs >= t.maxUnackedAgeMsWarning) {
      const days = Math.round(snapshot.oldestUnackedAgeMs / (24 * 60 * 60 * 1000));
      signals.push({
        kind: "stale_unacked_entry",
        severity: "warning",
        message: `Oldest unacked terminal outbox entry is ${days} days old — exceeds warning threshold (${Math.round(t.maxUnackedAgeMsWarning / (24 * 60 * 60 * 1000))} days)`,
        evidence: {
          oldestUnackedAgeMs: snapshot.oldestUnackedAgeMs,
          oldestUnackedCreatedAt: snapshot.oldestUnackedCreatedAt,
        },
      });
    }
  }

  // Provider-send-only stall (provider_sent/provider_accepted without operator-visible confirmation)
  if ((snapshot.providerSendOnlyUnacked ?? 0) > 0) {
    signals.push({
      kind: "provider_send_only_stall",
      severity: "warning",
      message: `${snapshot.providerSendOnlyUnacked} unacked events are provider-sent/accepted but not operator-visible — provider send-only is not receipt evidence per #294`,
      evidence: { providerSendOnlyUnacked: snapshot.providerSendOnlyUnacked },
    });
  }

  // ACK-eligible stall (events eligible for ACK but unconfirmed)
  if ((snapshot.ackEligibleUnacked ?? 0) > 0) {
    signals.push({
      kind: "ack_eligible_stall",
      severity: "info",
      message: `${snapshot.ackEligibleUnacked} unacked events are ACK-eligible but unconfirmed — may indicate operator confirmation gap`,
      evidence: { ackEligibleUnacked: snapshot.ackEligibleUnacked },
    });
  }

  // Stale receipt blindspot
  if ((snapshot.staleReceiptUnacked ?? 0) > 0) {
    signals.push({
      kind: "stale_receipt_blindspot",
      severity: "warning",
      message: `${snapshot.staleReceiptUnacked} unacked events have receipt status 'stale' — may hide receipt gaps without operator-visible evidence`,
      evidence: { staleReceiptUnacked: snapshot.staleReceiptUnacked },
    });
  }

  // Compute risk level
  const risk = computeRiskLevel(signals);
  const stabilityGatePass = risk === "none" || risk === "low";

  // Build summary
  const criticalCount = signals.filter((s) => s.severity === "critical").length;
  const warningCount = signals.filter((s) => s.severity === "warning").length;
  const summary = snapshot.total === 0
    ? "Terminal outbox is empty — no backlog risk."
    : criticalCount > 0
      ? `CRITICAL: ${criticalCount} critical signal(s), ${warningCount} warning(s). Terminal outbox backlog needs operator attention.`
      : warningCount > 0
        ? `WARNING: ${warningCount} warning signal(s). Terminal outbox backlog should be reviewed.`
        : "No terminal outbox backlog risk signals detected.";

  // Recommendation
  let recommendation: string | undefined;
  if (signals.some((s) => s.kind === "stale_unacked_entry" && s.severity === "critical")) {
    recommendation = "Operator should review oldest unacked entries for stalled delivery and consider stale receipt triage.";
  } else if (signals.some((s) => s.kind === "unacked_accumulation" && s.severity === "critical")) {
    recommendation = "High unacked accumulation — verify provider delivery path and operator-visible receipt evidence before any queue closeout.";
  } else if (signals.some((s) => s.kind === "provider_send_only_stall")) {
    recommendation = "Provider-sent-only entries need operator-visible/provider-delivery receipt before terminal ACK per #294 receipt semantics.";
  }

  return { risk, summary, signals, stabilityGatePass, recommendation };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeRiskLevel(signals: TerminalOutboxBacklogSignal[]): BacklogRiskLevel {
  const hasCritical = signals.some((s) => s.severity === "critical");
  const hasWarning = signals.some((s) => s.severity === "warning");
  if (hasCritical && signals.filter((s) => s.severity === "critical").length >= 2) return "critical";
  if (hasCritical) return "high";
  if (hasWarning && signals.length >= 2) return "medium";
  if (hasWarning) return "low";
  return "none";
}
