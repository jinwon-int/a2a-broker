/**
 * Closeout reconciliation loop helpers (issue #202).
 *
 * Extends the #197 drift diagnostic with operator-loop classifications:
 *   ok | merged-open-drift | not-merged | missing-link | cross-repo
 *
 * These are pure, testable functions; the CLI script wraps them with `gh`.
 */

import {
  parseGitHubUrl,
  classifyDriftState,
  buildDriftReport,
  type PrObservation,
  type IssueObservation,
} from "./closeout-drift.js";

// ---------------------------------------------------------------------------
// Extended reconciliation types
// ---------------------------------------------------------------------------

/**
 * Operator-facing reconciliation state, broader than DriftState.
 *
 * - `ok`                — PR and issue in sync (clean or pr_not_merged).
 * - `merged-open-drift` — PR merged, issue still open (the drift case).
 * - `not-merged`        — PR not yet merged; nothing to reconcile.
 * - `missing-link`      — PR/issue not found, or zero PRs linked.
 * - `cross-repo`        — PR and issue belong to different repos.
 */
export type ReconciliationState =
  | "ok"
  | "merged-open-drift"
  | "not-merged"
  | "missing-link"
  | "cross-repo";

export interface ReconciliationInput {
  prUrl: string;
  issueUrl: string;
  pr: PrObservation | null;
  issue: IssueObservation | null;
  /** Number of PRs linked to the issue (0 = no link). */
  linkedPrCount: number;
}

export interface ReconciliationOutput {
  state: ReconciliationState;
  prUrl: string;
  issueUrl: string;
  /** Human-readable summary line. */
  summary: string;
  /** Operator action recommendation. */
  action: string;
}

// ---------------------------------------------------------------------------
// Link analysis
// ---------------------------------------------------------------------------

/**
 * True when the PR and issue belong to the same repo+owner.
 */
export function sameRepo(prUrl: string, issueUrl: string): boolean {
  const pr = parseGitHubUrl(prUrl);
  const issue = parseGitHubUrl(issueUrl);
  if (!pr || !issue) return false;
  return pr.owner === issue.owner && pr.repo === issue.repo;
}

// ---------------------------------------------------------------------------
// Reconciliation classifier
// ---------------------------------------------------------------------------

/**
 * Classify a (PR, issue) pair into the extended reconciliation taxonomy.
 *
 * Precedence:
 *   1. Missing PR or issue observation → `missing-link`
 *   2. Cross-repo (different owner/repo) → `cross-repo`
 *   3. PR not merged                        → `not-merged`
 *   4. No linked PRs (linkedPrCount === 0)  → `missing-link`
 *   5. PR merged + issue open               → `merged-open-drift`
 *   6. PR merged + issue closed             → `ok`
 *   7. Issue closed regardless              → `ok`
 */
export function classifyReconciliation(input: ReconciliationInput): ReconciliationState {
  const { pr, issue, linkedPrCount, prUrl, issueUrl } = input;

  // Missing observations
  if (!pr || !issue) return "missing-link";

  // Cross-repo guard
  if (!sameRepo(prUrl, issueUrl)) return "cross-repo";

  // Unlinked PR count guard
  if (linkedPrCount === 0) return "missing-link";

  // Standard drift classification
  const driftState = classifyDriftState(pr, issue);
  switch (driftState) {
    case "drift":
      return "merged-open-drift";
    case "pr_not_merged":
      return "not-merged";
    case "issue_closed":
    case "clean":
      return "ok";
  }
}

// ---------------------------------------------------------------------------
// Report builder
// ---------------------------------------------------------------------------

const RECONCILE_ACTIONS: Record<ReconciliationState, { summary: string; action: string }> = {
  ok: {
    summary: "OK — PR and issue are in sync. No drift detected.",
    action: "No action required.",
  },
  "merged-open-drift": {
    summary: "DRIFT DETECTED — PR is merged but the linked issue is still open.",
    action:
      "Close the issue manually (`gh issue close`) or re-trigger the closeout handler. See docs/closeout-reconcile-runbook.md.",
  },
  "not-merged": {
    summary: "NOT MERGED — PR has not yet been merged.",
    action: "Wait for PR merge, then re-run this reconciliation check.",
  },
  "missing-link": {
    summary: "MISSING LINK — PR/issue not found or no linked PR on the issue.",
    action:
      "Verify the PR actually references this issue in its body/title. Check `gh pr view <PR> --json body,title`. If the link is valid, re-run after a short delay.",
  },
  "cross-repo": {
    summary: "CROSS-REPO — PR and issue belong to different repositories.",
    action: "Confirm this is intentional (e.g., multi-repo task). If not, verify the URLs and re-run.",
  },
};

export function buildReconciliationReport(input: ReconciliationInput): ReconciliationOutput {
  const state = classifyReconciliation(input);
  return {
    state,
    prUrl: input.prUrl,
    issueUrl: input.issueUrl,
    ...RECONCILE_ACTIONS[state],
  };
}

// ---------------------------------------------------------------------------
// JSON serialisation
// ---------------------------------------------------------------------------

export function reconciliationReportToJson(report: ReconciliationOutput): string {
  return JSON.stringify(
    {
      state: report.state,
      prUrl: report.prUrl,
      issueUrl: report.issueUrl,
      summary: report.summary,
      action: report.action,
    },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// Exit code mapping
// ---------------------------------------------------------------------------

/**
 * Map a ReconciliationState to a process exit code.
 *
 *   0 — ok, not-merged (no drift, clean)
 *   1 — merged-open-drift (real drift, needs action)
 *   4 — missing-link, cross-repo (anomaly, deserves attention but not a drift)
 */
export function reconciliationExitCode(state: ReconciliationState): number {
  switch (state) {
    case "ok":
    case "not-merged":
      return 0;
    case "merged-open-drift":
      return 1;
    case "missing-link":
    case "cross-repo":
      return 4;
  }
}
