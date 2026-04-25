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
