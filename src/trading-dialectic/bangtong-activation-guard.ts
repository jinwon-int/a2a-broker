/**
 * bangtong lane: Team1 broker activation GO/NO-GO guard.
 *
 * Evaluates activation readiness for the bangtong (thesis) lane within Team1's
 * trading-dialectic domain. This guard is a read-only safety boundary —
 * it never deploys, restarts, sends provider messages, or ACKs terminal events.
 *
 * Reference: #568, #567
 * Round: a2a-r9b-terminal-brief-activation-readiness-20260513T152714Z
 */

import type { TerminalBriefGitHubEvidenceManifest } from "../github/terminal-brief-evidence.js";
import type { Team1BoundedWarning, Team1StaleDiagnostics } from "./bounded-ops-dashboard.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ActivationGuardVerdict = "GO" | "NO_GO";

export interface ActivationGuardCheck {
  id: string;
  title: string;
  status: "pass" | "fail" | "warn";
  detail: string;
}

export interface ActivationGuardSafetyDeclaration {
  /** This guard never performs a live action. */
  liveActionPerformed: false;
  /** This guard never ACKs a terminal event. */
  terminalAckAttempted: false;
  /** This guard never mutates production DB. */
  dbMutationAttempted: false;
  /** This guard is no-live read-only. */
  noLive: true;
  /** Provider message-id/send success is provider-accepted evidence only, never read/visibility/terminal ACK. */
  providerSendOnlyIsNotTerminalAck: true;
  /** This guard does not replay historical outbox records. */
  historicalOutboxReplayAttempted: false;
  /** This guard does not change secrets or visibility. */
  secretOrVisibilityChangeAttempted: false;
  /** This guard does not force-push or rewrite history. */
  forcePushOrHistoryRewriteAttempted: false;
}

export interface ActivationGuardResult {
  /** Guard result discriminant. */
  decision: ActivationGuardVerdict;
  /** Operator-readable explanation. */
  summary: string;
  /** Per-gate results for the final GO/NO-GO gate ledger. */
  checks: ActivationGuardCheck[];
  /** Safety declaration — never live. */
  safety: ActivationGuardSafetyDeclaration;
  /** Set when the verdict is NO_GO and blocking gates are identified. */
  blocks?: string[];
  /** Set when verifiable receipt evidence exists. */
  receiptBoundaryEvidence?: {
    providerSendIsNotTerminalAck: boolean;
    operatorVisibleIsNotManualAck: boolean;
  };
  /** Compact parent-round title for broker-of-record aggregation. */
  parentRoundTitle?: string;
  /** Parent-round metadata for the broker-of-record. */
  parentMetadata?: {
    parentRoundId: string;
    worker: string;
    progress: number;
    total: number;
  };
  /** Idempotency key for the guard run. */
  guardId: string;
}

export interface ActivationGuardInput {
  /** Parent round/task id for the activation readiness round. */
  parentRoundId: string;
  /** Lane worker name (e.g. "bangtong"). */
  worker: string;
  /** Known total child tasks for this parent round. */
  knownTotal: number;
  /** Expected broker-of-record for this round. */
  expectedBrokerOfRecord: string;
  /** Actual broker-of-record from the upstream dispatcher metadata. */
  brokerOfRecord: string;
  /** Bounded ops dashboard health: pass when all warnings are non-critical and no critical stale state. */
  boundedOpsDashboard: {
    warnings: Team1BoundedWarning[];
    staleDiagnostics: Team1StaleDiagnostics | null;
  };
  /** Receipt/ACK boundary: when true, operator-visible receipt evidence exists and is proven separate from manual ACK. */
  receiptBoundaryProven: boolean;
  /** Parent-round progress metadata from the terminal outbox, when available. */
  parentRoundProgress?: number;
  /** Total workers in the parent round. */
  parentRoundTotal?: number;
  /** Existing terminal brief title, when carried forward from the outbox. */
  terminalBriefTitle?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TERMINAL_BRIEF_TITLE_RE = /^A2A Terminal Brief 완료: [A-Za-z0-9_.-]+\(\d+\/\d+\)$/;
const MAX_TITLE_CHARS = 120;
const MIN_TOTAL = 1;
const MAX_TOTAL = 100;
const CHECK_IDS = {
  parentRoundIdPresent: "parentRoundIdPresent",
  knownTotalValid: "knownTotalValid",
  brokerOfRecordAligned: "brokerOfRecordAligned",
  boundedOpsHealthy: "boundedOpsHealthy",
  receiptBoundaryProven: "receiptBoundaryProven",
  parentMetadataSafe: "parentMetadataSafe",
  terminalBriefTitleSafe: "terminalBriefTitleSafe",
  noLiveSafetyConfirmed: "noLiveSafetyConfirmed",
} as const;

// ---------------------------------------------------------------------------
// Guard implementation
// ---------------------------------------------------------------------------

/**
 * Run the bangtong lane activation GO/NO-GO guard.
 *
 * All gates must pass for a GO verdict. Any fail produces a NO_GO with
 * named blocking gates. Warn-level gates do not block but are reported.
 */
export function runBangtongActivationGuard(input: ActivationGuardInput): ActivationGuardResult {
  const guardId = buildGuardId(input);
  const checks: ActivationGuardCheck[] = [];
  const blocks: string[] = [];
  const warnings: string[] = [];

  // Gate 1: Parent round id must be present and non-empty.
  applyBooleanCheck(checks, blocks, CHECK_IDS.parentRoundIdPresent, "Parent round id present", {
    ok: !!input.parentRoundId && input.parentRoundId.trim().length > 0,
    passDetail: `parent round id: ${safeToken(input.parentRoundId)}`,
    failDetail: "parent round id is missing or empty",
  });

  // Gate 2: Known total must be a valid positive integer.
  const knownTotalOk = Number.isInteger(input.knownTotal) && input.knownTotal >= MIN_TOTAL && input.knownTotal <= MAX_TOTAL;
  applyBooleanCheck(checks, blocks, CHECK_IDS.knownTotalValid, "Known total valid", {
    ok: knownTotalOk,
    passDetail: `known total: ${Number.isInteger(input.knownTotal) ? input.knownTotal : String(input.knownTotal)}`,
    failDetail: `known total must be an integer between ${MIN_TOTAL} and ${MAX_TOTAL}: got ${safeToken(String(input.knownTotal))}`,
  });

  // Gate 3: brokerOfRecord must match the expected broker-of-record.
  const brokerAligned = normalizeToken(input.brokerOfRecord) === normalizeToken(input.expectedBrokerOfRecord);
  applyBooleanCheck(checks, blocks, CHECK_IDS.brokerOfRecordAligned, "Broker-of-record aligned", {
    ok: brokerAligned,
    passDetail: `broker of record: ${safeToken(input.brokerOfRecord)} matches expected ${safeToken(input.expectedBrokerOfRecord)}`,
    failDetail: `broker of record ${safeToken(input.brokerOfRecord)} does not match expected ${safeToken(input.expectedBrokerOfRecord)}`,
  });

  // Gate 4: Bounded ops dashboard must have no critical warnings and no critical stale state.
  const criticalWarnings = input.boundedOpsDashboard.warnings.filter((w) => w.severity === "critical");
  const criticalStale = input.boundedOpsDashboard.staleDiagnostics?.staleWorkers && input.boundedOpsDashboard.staleDiagnostics.staleWorkerAssignments > 0;
  const boundedOpsOk = criticalWarnings.length === 0 && !criticalStale;
  const boundedOpsDetail: string[] = [];
  if (boundedOpsOk) boundedOpsDetail.push("no critical warnings or stale state");
  if (criticalWarnings.length > 0) boundedOpsDetail.push(`critical warnings: ${criticalWarnings.map((w) => w.code).join(", ")}`);
  if (criticalStale) boundedOpsDetail.push(`stale worker assignments: ${input.boundedOpsDashboard.staleDiagnostics!.staleWorkerAssignments}`);
  applyBooleanCheck(checks, blocks, CHECK_IDS.boundedOpsHealthy, "Bounded ops dashboard healthy", {
    ok: boundedOpsOk,
    passDetail: boundedOpsDetail.join("; "),
    failDetail: `bounded ops health check failed: ${boundedOpsDetail.join("; ")}`,
  });

  // Gate 5: Receipt/ACK boundary must be proven.
  applyBooleanCheck(checks, blocks, CHECK_IDS.receiptBoundaryProven, "Receipt/ACK boundary proven", {
    ok: input.receiptBoundaryProven,
    passDetail: "operator-visible receipt is independently proven from manual ACK evidence; provider send-only is not terminal ACK",
    failDetail: "receipt/ACK boundary not proven: operator-visible receipt must be separate from manual ACK, provider send-only is not terminal ACK",
  });

  // Gate 6: Parent metadata safety — parentRoundProgress and parentRoundTotal.
  const progressSafe = metadataProgressSafe(input.parentRoundProgress, input.parentRoundTotal);
  applyBooleanCheck(checks, blocks, CHECK_IDS.parentMetadataSafe, "Parent metadata safe", {
    ok: progressSafe,
    passDetail: "parentRoundProgress and parentRoundTotal are valid and consistent" + (
      input.parentRoundProgress !== undefined && input.parentRoundTotal !== undefined
        ? ` (${input.parentRoundProgress}/${input.parentRoundTotal})`
        : input.parentRoundProgress !== undefined
          ? ` (progress=${input.parentRoundProgress} without total — absent, not reported)`
          : " (absent — not applicable)"
    ),
    failDetail: buildMetadataFailDetail(input.parentRoundProgress, input.parentRoundTotal),
  });

  // Gate 7: TerminalBriefTitle safety check.
  const titleSafe = titleFormatSafe(input.terminalBriefTitle, input.worker, input.parentRoundProgress, input.parentRoundTotal);
  applyBooleanCheck(checks, blocks, CHECK_IDS.terminalBriefTitleSafe, "Terminal brief title safe", {
    ok: titleSafe,
    passDetail: buildTitlePassDetail(input),
    failDetail: buildTitleFailDetail(input),
  });

  // Gate 8: No-live safety confirmed.
  applyBooleanCheck(checks, blocks, CHECK_IDS.noLiveSafetyConfirmed, "No-live safety confirmed", {
    ok: true, // This module never performs live actions.
    passDetail: "guard is read-only: no deploy/restart/reload/live provider send, DB mutation, manual ACK/replay, historical outbox replay, secret change, release, or force-push",
    failDetail: "safety contract violation: this guard must not perform live actions",
  });

  // Build the parent-round title.
  const parentRoundTitle = compactTerminalBriefTitle(input.worker, input.parentRoundProgress, input.parentRoundTotal);

  // Determine verdict.
  const fails = checks.filter((c) => c.status === "fail");
  const decision: ActivationGuardVerdict = fails.length === 0 ? "GO" : "NO_GO";

  // Build summary.
  const summary = buildSummary(decision, checks, blocks, warnings);

  const result: ActivationGuardResult = {
    decision,
    summary,
    checks,
    safety: {
      liveActionPerformed: false,
      terminalAckAttempted: false,
      dbMutationAttempted: false,
      noLive: true,
      providerSendOnlyIsNotTerminalAck: true,
      historicalOutboxReplayAttempted: false,
      secretOrVisibilityChangeAttempted: false,
      forcePushOrHistoryRewriteAttempted: false,
    },
    guardId,
  };

  if (fails.length > 0) {
    result.blocks = [...new Set(blocks)];
  }

  if (input.receiptBoundaryProven) {
    result.receiptBoundaryEvidence = {
      providerSendIsNotTerminalAck: true,
      operatorVisibleIsNotManualAck: true,
    };
  }

  if (parentRoundTitle) {
    result.parentRoundTitle = parentRoundTitle;
  }

  if (input.parentRoundId && input.worker && input.parentRoundProgress && input.parentRoundTotal) {
    result.parentMetadata = {
      parentRoundId: input.parentRoundId,
      worker: input.worker,
      progress: input.parentRoundProgress,
      total: input.parentRoundTotal,
    };
  }

  return result;
}

/**
 * Build a compact parent-round Terminal Brief title in the format
 * "A2A Terminal Brief 완료: <worker>(n/7)".
 *
 * Returns undefined when progress or total is absent, meaning the caller
 * should fall back to a readable default title.
 */
export function compactTerminalBriefTitle(
  worker: string,
  progress?: number,
  total?: number,
): string | undefined {
  if (!worker || progress === undefined || total === undefined) return undefined;
  const safeWorker = safeToken(worker);
  const safeProgress = Number.isInteger(progress) && progress > 0 ? progress : undefined;
  const safeTotal = Number.isInteger(total) && total > 0 ? total : undefined;
  if (!safeWorker || !safeProgress || !safeTotal) return undefined;
  return `A2A Terminal Brief 완료: ${safeWorker}(${safeProgress}/${safeTotal})`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function applyBooleanCheck(
  checks: ActivationGuardCheck[],
  onFail: string[],
  id: string,
  title: string,
  outcome: { ok: boolean; passDetail: string; failDetail: string },
): void {
  checks.push({
    id,
    title,
    status: outcome.ok ? "pass" : "fail",
    detail: outcome.ok ? outcome.passDetail : outcome.failDetail,
  });
  if (!outcome.ok) onFail.push(id);
}

function metadataProgressSafe(progress?: number, total?: number): boolean {
  if (progress === undefined && total === undefined) return true;
  if (progress !== undefined && !(Number.isInteger(progress) && progress > 0 && Number.isFinite(progress))) return false;
  if (total !== undefined && !(Number.isInteger(total) && total > 0 && Number.isFinite(total))) return false;
  if (progress !== undefined && total !== undefined && progress > total) return false;
  return true;
}

function titleFormatSafe(title?: string, worker?: string, progress?: number, total?: number): boolean {
  if (title === undefined) return true; // Absent is OK — fallback handled downstream.
  if (typeof title !== "string") return false;
  if (title.length > MAX_TITLE_CHARS) return false;
  // Verify the regex pattern matches.
  if (!TERMINAL_BRIEF_TITLE_RE.test(title)) return false;
  // Verify the title is consistent with the supplied worker/progress/total.
  const built = compactTerminalBriefTitle(worker ?? "", progress, total);
  if (built && title !== built) return false;
  return true;
}

function buildMetadataFailDetail(progress?: number, total?: number): string {
  if (progress !== undefined && !(Number.isInteger(progress) && progress > 0)) {
    return `parentRoundProgress must be a positive integer: got ${safeToken(String(progress))}`;
  }
  if (total !== undefined && !(Number.isInteger(total) && total > 0)) {
    return `parentRoundTotal must be a positive integer: got ${safeToken(String(total))}`;
  }
  if (progress !== undefined && total !== undefined && progress > total) {
    return `parentRoundProgress (${progress}) exceeds parentRoundTotal (${total})`;
  }
  return "parent metadata consistency check failed";
}

function buildTitlePassDetail(input: ActivationGuardInput): string {
  if (input.terminalBriefTitle) {
    return `terminal brief title matches expected format: ${input.terminalBriefTitle}`;
  }
  return "terminal brief title absent (fallback used downstream)";
}

function buildTitleFailDetail(input: ActivationGuardInput): string {
  if (input.terminalBriefTitle && typeof input.terminalBriefTitle === "string" && input.terminalBriefTitle.length > MAX_TITLE_CHARS) {
    return `terminal brief title exceeds ${MAX_TITLE_CHARS} characters`;
  }
  if (input.terminalBriefTitle && typeof input.terminalBriefTitle === "string" && !TERMINAL_BRIEF_TITLE_RE.test(input.terminalBriefTitle)) {
    return `terminal brief title ${safeToken(input.terminalBriefTitle)} does not match expected pattern "A2A Terminal Brief 완료: <worker>(<progress>/<total>)"`;
  }
  return "terminal brief title safety check failed";
}

function buildSummary(decision: ActivationGuardVerdict, checks: ActivationGuardCheck[], blocks: string[], warnings: string[]): string {
  const passCount = checks.filter((c) => c.status === "pass").length;
  const failCount = checks.filter((c) => c.status === "fail").length;
  const total = checks.length;

  if (decision === "GO") {
    return `GO: all ${passCount}/${total} activation gates passed for Team1 bangtong lane`;
  }
  return [
    `NO_GO: ${failCount}/${total} activation gates failed for Team1 bangtong lane`,
    ...(blocks.length > 0 ? [`Blocking gates: ${[...new Set(blocks)].join(", ")}`] : []),
    ...(warnings.length > 0 ? [`Warnings: ${[...new Set(warnings)].join(", ")}`] : []),
  ].join(". ");
}

function buildGuardId(input: ActivationGuardInput): string {
  const raw = [
    "bangtong-activation",
    input.parentRoundId,
    input.worker,
    String(input.knownTotal),
    input.brokerOfRecord,
    input.receiptBoundaryProven ? "receipt-proven" : "receipt-not-proven",
    new Date().toISOString().slice(0, 19).replace(/[:-]/g, ""),
  ].join("::");
  return `bangtong-guard-${createSimpleHash(raw).slice(0, 16)}`;
}

function createSimpleHash(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    const char = value.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(16).padStart(8, "0");
}

function safeToken(value: string): string {
  return value
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)[-_A-Za-z0-9]+\b/g, "[REDACTED]")
    .replace(/\b(sk|xox[abp])[-_A-Za-z0-9]+\b/g, "[REDACTED]")
    .replace(/\b(token|secret|password|api[_-]?key|authorization|credential)\s*[:=]\s*\S+/gi, "$1=[REDACTED]")
    .replace(/[\r\n]+/g, " ")
    .trim();
}

function normalizeToken(value: string): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : undefined;
}
