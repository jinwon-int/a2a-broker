/**
 * Closeout drift detection helpers (issue #197).
 *
 * "Closeout drift" = a PR is merged but its linked GitHub issue remains open.
 * These are pure, testable functions; the CLI script wraps them with `gh`.
 */

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------

export interface GitHubRef {
  owner: string;
  repo: string;
  number: number;
}

/**
 * Parse a GitHub PR or issue HTML URL into its components.
 * Returns null for any unrecognized format.
 *
 * Accepted forms:
 *   https://github.com/owner/repo/pull/42
 *   https://github.com/owner/repo/issues/42
 */
export function parseGitHubUrl(url: string): (GitHubRef & { kind: "pull" | "issue" }) | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname !== "github.com") return null;

  const m = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/(pull|issues)\/(\d+)\/?$/);
  if (!m) return null;

  return {
    owner: m[1],
    repo: m[2],
    kind: m[3] === "pull" ? "pull" : "issue",
    number: parseInt(m[4], 10),
  };
}

// ---------------------------------------------------------------------------
// Drift classification
// ---------------------------------------------------------------------------

/**
 * The four observable states of a (PR, linked-issue) pair.
 *
 * - `drift`          — PR is merged but issue is still open. Needs operator action.
 * - `clean`          — Both PR merged and issue closed. Fully resolved.
 * - `pr_not_merged`  — PR is not yet merged (open or closed-without-merge). No drift.
 * - `issue_closed`   — Issue already closed regardless of PR state. No drift.
 */
export type DriftState = "drift" | "clean" | "pr_not_merged" | "issue_closed";

export interface PrObservation {
  /** True when the PR has been merged (pull_request.merged === true). */
  merged: boolean;
}

export interface IssueObservation {
  /** True when the issue state is "open". */
  open: boolean;
}

/**
 * Classify the drift state from live observations.
 *
 * Precedence:
 *   1. Issue already closed → `issue_closed` (no action needed)
 *   2. PR not merged         → `pr_not_merged` (drift cannot exist yet)
 *   3. PR merged + issue open → `drift`
 *   4. PR merged + issue closed → `clean`
 */
export function classifyDriftState(
  pr: PrObservation,
  issue: IssueObservation,
): DriftState {
  if (!issue.open) return "issue_closed";
  if (!pr.merged) return "pr_not_merged";
  return "drift";
}

/**
 * True when the observation pair is in closeout drift.
 */
export function isDrift(pr: PrObservation, issue: IssueObservation): boolean {
  return classifyDriftState(pr, issue) === "drift";
}

// ---------------------------------------------------------------------------
// Summary formatter (used by both the script and tests)
// ---------------------------------------------------------------------------

export interface DriftReport {
  state: DriftState;
  prUrl: string;
  issueUrl: string;
  summary: string;
  /** Recommended next step for the operator. */
  action: string;
}

export function buildDriftReport(
  prUrl: string,
  issueUrl: string,
  pr: PrObservation,
  issue: IssueObservation,
): DriftReport {
  const state = classifyDriftState(pr, issue);

  const templates: Record<DriftState, { summary: string; action: string }> = {
    drift: {
      summary: "DRIFT DETECTED — PR is merged but the linked issue is still open.",
      action: "Close the issue manually or re-run the closeout handler.",
    },
    clean: {
      summary: "Clean — PR merged and issue closed.",
      action: "No action required.",
    },
    pr_not_merged: {
      summary: "PR not yet merged — no drift possible.",
      action: "Wait for the PR to merge, then re-run this check.",
    },
    issue_closed: {
      summary: "Issue already closed — no drift.",
      action: "No action required.",
    },
  };

  return { state, prUrl, issueUrl, ...templates[state] };
}
