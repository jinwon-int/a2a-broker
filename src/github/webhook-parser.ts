/**
 * Webhook event parser: converts raw GitHub webhook payloads (as received
 * by an HTTP endpoint) into the typed `GitHubWebhookEvent` union consumed
 * by `GitHubIngestionService`.
 *
 * The parser validates required headers (`X-GitHub-Event`, `X-GitHub-Delivery`)
 * and attempts to coerce the body into one of the four supported event kinds.
 * Unknown or unsupported events are returned as `null`.
 */

import type {
  GitHubWebhookEvent,
  GitHubEventKind,
  GitHubDeliveryContext,
  GitHubIssueEvent,
  GitHubIssueAction,
  GitHubIssueCommentEvent,
  GitHubCommentAction,
  GitHubPullRequestEvent,
  GitHubPullRequestCommentEvent,
  GitHubRepoRef,
  GitHubIssueRef,
  GitHubPullRequestRef,
  GitHubCommentRef,
  GitHubUserRef,
} from "./types.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface WebhookParseResult {
  event: GitHubWebhookEvent;
  ctx: GitHubDeliveryContext;
}

/**
 * Parse a raw GitHub webhook payload into a typed event + delivery context.
 *
 * @param eventHeader  The `X-GitHub-Event` header value.
 * @param deliveryHeader  The `X-GitHub-Delivery` header value.
 * @param body  The parsed JSON body of the webhook payload.
 * @returns A `WebhookParseResult` on success, or `null` when the event is
 *          unsupported or the body cannot be coerced.
 */
export function parseGitHubWebhook(
  eventHeader: string | undefined,
  deliveryHeader: string | undefined,
  body: Record<string, unknown> | null | undefined,
): WebhookParseResult | null {
  if (!eventHeader || !deliveryHeader || !body) return null;

  if (typeof body !== "object" || body === null) return null;

  const event = coerceWebhookEvent(eventHeader, body as Record<string, unknown>);
  if (!event) return null;

  return {
    event,
    ctx: {
      deliveryId: deliveryHeader,
      receivedAt: new Date().toISOString(),
    },
  };
}

/**
 * Validate that required GitHub webhook headers are present.
 * Returns a user-facing error message when invalid, or null when OK.
 */
export function validateWebhookHeaders(
  eventHeader: string | undefined,
  deliveryHeader: string | undefined,
): string | null {
  if (!eventHeader) {
    return "Missing X-GitHub-Event header";
  }
  if (!deliveryHeader) {
    return "Missing X-GitHub-Delivery header";
  }
  const supportedKinds: GitHubEventKind[] = [
    "issues",
    "issue_comment",
    "pull_request",
    "pull_request_review_comment",
  ];
  if (!supportedKinds.includes(eventHeader as GitHubEventKind)) {
    return `Unsupported X-GitHub-Event: ${eventHeader}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Coercion helpers
// ---------------------------------------------------------------------------

function coerceWebhookEvent(
  eventHeader: string,
  body: Record<string, unknown>,
): GitHubWebhookEvent | null {
  switch (eventHeader) {
    case "issues":
      return coerceIssueEvent(body);
    case "issue_comment":
      return coerceIssueCommentEvent(body);
    case "pull_request":
      return coercePullRequestEvent(body);
    case "pull_request_review_comment":
      return coercePullRequestCommentEvent(body);
    default:
      return null;
  }
}

function coerceRepoRef(body: Record<string, unknown>): GitHubRepoRef | null {
  const raw = body.repository as Record<string, unknown> | undefined;
  if (!raw) return null;
  const owner = raw.owner as Record<string, unknown> | undefined;
  const ownerLogin = typeof owner?.login === "string" ? owner.login : "";
  const repoName = typeof raw.name === "string" ? raw.name : "";
  const fullName = typeof raw.full_name === "string" ? raw.full_name : `${ownerLogin}/${repoName}`;
  if (!ownerLogin || !repoName) return null;
  return { owner: ownerLogin, name: repoName, fullName };
}

function coerceUserRef(body: Record<string, unknown>): GitHubUserRef | null {
  const sender = body.sender as Record<string, unknown> | undefined;
  if (!sender) return null;
  const login = typeof sender.login === "string" ? sender.login : "";
  const id = typeof sender.id === "number" ? sender.id : 0;
  if (!login) return null;
  return { login, id, type: (sender.type as GitHubUserRef["type"]) ?? "User" };
}

function coerceIssueRef(raw: Record<string, unknown> | undefined): GitHubIssueRef | null {
  if (!raw) return null;
  const number = typeof raw.number === "number" ? raw.number : NaN;
  const title = typeof raw.title === "string" ? raw.title : "";
  const body = typeof raw.body === "string" ? raw.body : undefined;
  const htmlUrl = typeof raw.html_url === "string" ? raw.html_url : "";
  const state = (raw.state === "open" || raw.state === "closed") ? raw.state : "open";
  if (!Number.isFinite(number) || !title) return null;
  const user = raw.user as Record<string, unknown> | undefined;
  const labelsRaw = raw.labels as Array<Record<string, unknown>> | undefined;
  const labels = labelsRaw?.map((l) => String(l.name ?? "")).filter(Boolean);
  return {
    number,
    title,
    body,
    htmlUrl: htmlUrl || "",
    state: state as "open" | "closed",
    ...(user ? { user: coerceSimpleUserRef(user) } : {}),
    ...(labels && labels.length > 0 ? { labels } : {}),
  };
}

function coercePullRequestRef(
  raw: Record<string, unknown> | undefined,
  body: Record<string, unknown>,
): GitHubPullRequestRef | null {
  if (!raw) return null;
  const base = coerceIssueRef(raw);
  if (!base) return null;
  const prUrl = typeof raw.html_url === "string" ? raw.html_url : "";
  const draft = typeof raw.draft === "boolean" ? raw.draft : undefined;
  const merged = typeof raw.merged === "boolean" ? raw.merged : undefined;
  return {
    ...base,
    prUrl,
    draft,
    merged,
  };
}

function coerceCommentRef(raw: Record<string, unknown> | undefined): GitHubCommentRef | null {
  if (!raw) return null;
  const id = typeof raw.id === "number" ? raw.id : NaN;
  const commentBody = typeof raw.body === "string" ? raw.body : "";
  const htmlUrl = typeof raw.html_url === "string" ? raw.html_url : "";
  const createdAt = typeof raw.created_at === "string" ? raw.created_at : new Date().toISOString();
  if (!Number.isFinite(id)) return null;
  const user = raw.user as Record<string, unknown> | undefined;
  return {
    id,
    body: commentBody,
    htmlUrl,
    createdAt,
    ...(user ? { user: coerceSimpleUserRef(user) } : {}),
  };
}

function coerceSimpleUserRef(raw: Record<string, unknown>): GitHubUserRef {
  return {
    login: typeof raw.login === "string" ? raw.login : "unknown",
    id: typeof raw.id === "number" ? raw.id : 0,
    type: (raw.type as GitHubUserRef["type"]) ?? "User",
  };
}

// ---------------------------------------------------------------------------
// Per-event-type coercion
// ---------------------------------------------------------------------------

function coerceIssueEvent(body: Record<string, unknown>): GitHubIssueEvent | null {
  const repo = coerceRepoRef(body);
  const sender = coerceUserRef(body);
  const issue = coerceIssueRef(body.issue as Record<string, unknown> | undefined);
  if (!repo || !sender || !issue) return null;

  const action = normalizeIssueAction(body.action as string | undefined);
  if (!action) return null;

  return {
    kind: "issues",
    action,
    repo,
    issue,
    sender,
  };
}

function coerceIssueCommentEvent(body: Record<string, unknown>): GitHubIssueCommentEvent | null {
  const repo = coerceRepoRef(body);
  const sender = coerceUserRef(body);
  const issue = coerceIssueRef(body.issue as Record<string, unknown> | undefined);
  const comment = coerceCommentRef(body.comment as Record<string, unknown> | undefined);
  if (!repo || !sender || !issue || !comment) return null;

  const action = normalizeCommentAction(body.action as string | undefined);
  if (!action) return null;

  return {
    kind: "issue_comment",
    action,
    repo,
    issue,
    comment,
    sender,
  };
}

function coercePullRequestEvent(body: Record<string, unknown>): GitHubPullRequestEvent | null {
  const repo = coerceRepoRef(body);
  const sender = coerceUserRef(body);
  const pr = coercePullRequestRef(
    body.pull_request as Record<string, unknown> | undefined,
    body,
  );
  if (!repo || !sender || !pr) return null;

  const action = normalizeIssueAction(body.action as string | undefined);
  if (!action) return null;

  return {
    kind: "pull_request",
    action,
    repo,
    pullRequest: pr,
    sender,
  };
}

function coercePullRequestCommentEvent(
  body: Record<string, unknown>,
): GitHubPullRequestCommentEvent | null {
  const repo = coerceRepoRef(body);
  const sender = coerceUserRef(body);
  const pr = coercePullRequestRef(
    body.pull_request as Record<string, unknown> | undefined,
    body,
  );
  const comment = coerceCommentRef(body.comment as Record<string, unknown> | undefined);
  if (!repo || !sender || !pr || !comment) return null;

  const action = normalizeCommentAction(body.action as string | undefined);
  if (!action) return null;

  return {
    kind: "pull_request_review_comment",
    action,
    repo,
    pullRequest: pr,
    comment,
    sender,
  };
}

// ---------------------------------------------------------------------------
// Action normalization
// ---------------------------------------------------------------------------

const VALID_ISSUE_ACTIONS = new Set([
  "opened", "edited", "closed", "reopened", "assigned", "labeled",
]);
const VALID_COMMENT_ACTIONS = new Set(["created", "edited", "deleted"]);

function normalizeIssueAction(raw: string | undefined): GitHubIssueAction | null {
  if (typeof raw !== "string") return null;
  return VALID_ISSUE_ACTIONS.has(raw) ? (raw as GitHubIssueAction) : null;
}

function normalizeCommentAction(raw: string | undefined): GitHubCommentAction | null {
  if (typeof raw !== "string") return null;
  return VALID_COMMENT_ACTIONS.has(raw) ? (raw as GitHubCommentAction) : null;
}
