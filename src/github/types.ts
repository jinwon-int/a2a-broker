/**
 * GitHub webhook payload types.
 *
 * These mirror the relevant subset of GitHub's webhook events that the
 * broker ingests for `--work-mode github` collaboration. Payloads are
 * deliberately narrow: only the fields the broker reads or projects back
 * are modelled. Full payloads are accepted via the index signature on the
 * raw event so callers can pass through additional metadata for audit.
 */

export type GitHubEventKind =
  | "issues"
  | "issue_comment"
  | "pull_request"
  | "pull_request_review_comment";

export type GitHubUserType = "User" | "Bot" | "Organization";

export interface GitHubUserRef {
  login: string;
  id: number;
  type?: GitHubUserType;
}

export interface GitHubRepoRef {
  owner: string;
  name: string;
  /** "owner/name" — canonical identifier used in projection comment bodies. */
  fullName: string;
}

export interface GitHubIssueRef {
  number: number;
  title: string;
  body?: string;
  htmlUrl: string;
  state: "open" | "closed";
  user?: GitHubUserRef;
  labels?: string[];
}

export interface GitHubPullRequestRef extends GitHubIssueRef {
  /** Mirrors `pull_request.html_url`, useful when projecting a PR marker. */
  prUrl: string;
  draft?: boolean;
  merged?: boolean;
}

export interface GitHubCommentRef {
  id: number;
  body: string;
  htmlUrl: string;
  user?: GitHubUserRef;
  createdAt: string;
}

export type GitHubIssueAction =
  | "opened"
  | "edited"
  | "closed"
  | "reopened"
  | "assigned"
  | "labeled";

export type GitHubCommentAction = "created" | "edited" | "deleted";

export interface GitHubIssueEvent {
  kind: "issues";
  action: GitHubIssueAction;
  repo: GitHubRepoRef;
  issue: GitHubIssueRef;
  sender: GitHubUserRef;
}

export interface GitHubIssueCommentEvent {
  kind: "issue_comment";
  action: GitHubCommentAction;
  repo: GitHubRepoRef;
  issue: GitHubIssueRef;
  comment: GitHubCommentRef;
  sender: GitHubUserRef;
}

export interface GitHubPullRequestEvent {
  kind: "pull_request";
  action: GitHubIssueAction | "synchronize" | "ready_for_review";
  repo: GitHubRepoRef;
  pullRequest: GitHubPullRequestRef;
  sender: GitHubUserRef;
}

export interface GitHubPullRequestCommentEvent {
  kind: "pull_request_review_comment";
  action: GitHubCommentAction;
  repo: GitHubRepoRef;
  pullRequest: GitHubPullRequestRef;
  comment: GitHubCommentRef;
  sender: GitHubUserRef;
}

export type GitHubWebhookEvent =
  | GitHubIssueEvent
  | GitHubIssueCommentEvent
  | GitHubPullRequestEvent
  | GitHubPullRequestCommentEvent;

export interface GitHubDeliveryContext {
  /** Verbatim X-GitHub-Delivery header value; used as the dedup key. */
  deliveryId: string;
  /** ISO timestamp when the broker received the webhook. */
  receivedAt: string;
}

// ---------------------------------------------------------------------------
// Recovery-state projection types
//
// Event kinds the recovery projection consumes IN ADDITION to the four
// `GitHubWebhookEvent` kinds above. They are intentionally NOT added to the
// `GitHubWebhookEvent` union to avoid any change to the existing ingestion
// pipeline; the recovery projection accepts a wider `GitHubRecoveryEvent`
// union that wraps both. See ./recovery-state.ts.
// ---------------------------------------------------------------------------

/**
 * Aggregate CI/check conclusion for a PR. We collapse GitHub's many
 * check-run conclusions (`success`, `failure`, `cancelled`, `timed_out`,
 * `action_required`, `neutral`, `skipped`, `stale`) into a tri-state used
 * by the bucket query. `success`/`neutral`/`skipped` map to `passing`;
 * `failure`/`cancelled`/`timed_out`/`action_required`/`stale` map to
 * `failing`; in-flight / queued runs map to `pending`.
 */
export type GitHubCheckConclusion = "pending" | "passing" | "failing";

/** Aggregate review verdict for a PR. */
export type GitHubReviewVerdict = "approved" | "changes_requested" | "none";

export interface GitHubCheckRunRef {
  name: string;
  /** GitHub's raw status enum. */
  status: "queued" | "in_progress" | "completed";
  /** GitHub's raw conclusion enum (set when status === "completed"). */
  conclusion?:
    | "success"
    | "failure"
    | "neutral"
    | "cancelled"
    | "skipped"
    | "timed_out"
    | "action_required"
    | "stale";
  /** Commit SHA the check ran against. */
  headSha: string;
}

export interface GitHubCheckRunEvent {
  kind: "check_run";
  action: "created" | "completed" | "rerequested" | "requested_action";
  repo: GitHubRepoRef;
  /** PR (or issue) number this check is associated with for routing. */
  issueNumber: number;
  checkRun: GitHubCheckRunRef;
  sender: GitHubUserRef;
}

export type GitHubPullRequestReviewState =
  | "approved"
  | "changes_requested"
  | "commented"
  | "dismissed";

export interface GitHubPullRequestReviewEvent {
  kind: "pull_request_review";
  action: "submitted" | "edited" | "dismissed";
  repo: GitHubRepoRef;
  pullRequest: GitHubPullRequestRef;
  reviewState: GitHubPullRequestReviewState;
  sender: GitHubUserRef;
}

/** Superset of `GitHubWebhookEvent` consumed by the recovery projection. */
export type GitHubRecoveryEvent =
  | GitHubWebhookEvent
  | GitHubCheckRunEvent
  | GitHubPullRequestReviewEvent;

/**
 * Buckets the recovery projection groups issues/PRs into for operator
 * triage. A `(repo, issueNumber)` belongs to exactly one bucket at any time;
 * transitions are driven by ingested events and external task-status
 * updates fed in via `setTaskStatus()`.
 *
 * Bucket precedence (highest first), so that conflicting signals collapse
 * deterministically:
 *   1. `closed`           — issue closed, or PR closed/merged
 *   2. `ready_to_merge`   — PR open, approved, all checks passing
 *   3. `blocked`          — checks failing, or changes requested
 *   4. `needs_retry`      — linked task failed and the issue/PR is still open
 *   5. `ready_to_review`  — PR open with passing checks, no review verdict
 *   6. `blocked`          — fallback for everything else (e.g. fresh issue
 *                           with no progress yet)
 */
export type RecoveryBucket =
  | "blocked"
  | "ready_to_review"
  | "ready_to_merge"
  | "needs_retry"
  | "closed";

export type RecoveryIssueKind = "issue" | "pull_request";

export type RecoveryLifecycleState = "open" | "closed" | "merged";

export interface RecoveryCheckEntry {
  /** Aggregate conclusion bucket. */
  conclusion: GitHubCheckConclusion;
  /** SHA the check is reporting on. */
  headSha: string;
  /** ISO timestamp from the delivery context — used for per-check ordering. */
  receivedAt: string;
}

export interface RecoveryIssueState {
  repoFullName: string;
  issueNumber: number;
  kind: RecoveryIssueKind;
  state: RecoveryLifecycleState;
  title: string;
  htmlUrl: string;
  prUrl?: string;
  /** Latest known head commit SHA for a PR (undefined for plain issues). */
  headSha?: string;
  labels: string[];
  /** Login(s) treated as owners (issue.user, PR author, sender on assign). */
  ownerLogins: string[];
  /** Broker task ids associated with this (repo, issue). */
  linkedTaskIds: string[];
  /** Latest known broker task status. Undefined until populated externally. */
  taskStatus?: import("../core/types.js").TaskStatus;
  /** Per-check-name granular state — used to recompute the aggregate. */
  checks: Record<string, RecoveryCheckEntry>;
  checkStatus: GitHubCheckConclusion;
  reviewStatus: GitHubReviewVerdict;
  /** Watermark of the latest accepted event for this (repo, issue). */
  lastEventAt: string;
  /** Monotonic counter of accepted events for this pair. */
  lastSeq: number;
  /** Bucket as currently classified — kept in sync on every accepted event. */
  bucket: RecoveryBucket;
}
