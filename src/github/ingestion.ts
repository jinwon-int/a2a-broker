/**
 * GitHub-side ingestion: parse `/a2a assign` commands from issue/comment
 * bodies and turn them into broker parent/child tasks.
 *
 * Idempotency strategy:
 *   - Each delivery's `X-GitHub-Delivery` id is recorded; replays are dropped.
 *   - Task ids are deterministic from `(repo, issue, [comment, intent#])`,
 *     so even cross-delivery duplicates collapse onto the same broker task
 *     via the broker's id-based idempotency.
 *
 * The broker is the source of truth for tasks. This module only translates
 * GitHub events into broker calls — it does not post to GitHub. Projection
 * back to GitHub comments lives in ./projection.ts.
 */

import type { InMemoryA2ABroker } from "../core/broker.js";
import type {
  A2AExchangeIntent,
  CreateTaskRequest,
  TaskRecord,
} from "../core/types.js";
import type {
  GitHubDeliveryContext,
  GitHubIssueCommentEvent,
  GitHubIssueEvent,
  GitHubIssueRef,
  GitHubPullRequestCommentEvent,
  GitHubPullRequestEvent,
  GitHubRepoRef,
  GitHubWebhookEvent,
} from "./types.js";

// ---------------------------------------------------------------------------
// Assignment intent parsing
// ---------------------------------------------------------------------------

const KNOWN_INTENTS: ReadonlySet<string> = new Set<A2AExchangeIntent>([
  "chat",
  "analyze",
  "backfill",
  "propose_patch",
  "propose_params",
  "validate_change",
  "apply_local_change",
  "promote_to_live",
  "rollback_live",
]);

export type GitHubWorkMode = "github" | "local";

export interface AssignmentIntent {
  /** Original command text (single line). */
  raw: string;
  /** Worker node id the command targets. */
  target: string;
  /** Defaults to `github` when unspecified. */
  workMode: GitHubWorkMode;
  /** Parsed `--intent` value if it matched a known A2AExchangeIntent. */
  intent?: A2AExchangeIntent;
  /** Free-form text after `--`, if any. */
  message?: string;
  /** All key/value flag pairs (excluding the structured fields above). */
  args: Record<string, string>;
}

const COMMAND_PREFIX = "/a2a assign";

export function parseAssignmentIntents(text: string | null | undefined): AssignmentIntent[] {
  if (typeof text !== "string" || text.length === 0) {
    return [];
  }

  const intents: AssignmentIntent[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const idx = line.toLowerCase().indexOf(COMMAND_PREFIX);
    if (idx < 0) continue;
    const command = line.slice(idx);
    const parsed = parseCommandLine(command);
    if (parsed) intents.push(parsed);
  }
  return intents;
}

function parseCommandLine(line: string): AssignmentIntent | null {
  const remainder = line.slice(COMMAND_PREFIX.length).trim();
  if (!remainder) return null;

  // Split a trailing free-form message off `-- <message>`.
  let message: string | undefined;
  let head = remainder;
  const sepIdx = remainder.indexOf(" -- ");
  if (sepIdx >= 0) {
    head = remainder.slice(0, sepIdx).trim();
    message = remainder.slice(sepIdx + 4).trim() || undefined;
  }

  const tokens = head.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  // First positional token must be a target node id (no leading `--`).
  const targetToken = tokens.shift()!;
  if (targetToken.startsWith("--")) return null;
  const target = targetToken;

  const args: Record<string, string> = {};
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (!token.startsWith("--")) continue;
    const eq = token.indexOf("=");
    if (eq >= 0) {
      args[token.slice(2, eq)] = token.slice(eq + 1);
    } else {
      const next = tokens[i + 1];
      if (next && !next.startsWith("--")) {
        args[token.slice(2)] = next;
        i++;
      } else {
        args[token.slice(2)] = "true";
      }
    }
  }

  const workModeRaw = args["work-mode"] ?? "github";
  const workMode: GitHubWorkMode = workModeRaw === "local" ? "local" : "github";

  const intentArg = args["intent"];
  const intent: A2AExchangeIntent | undefined =
    intentArg && KNOWN_INTENTS.has(intentArg) ? (intentArg as A2AExchangeIntent) : undefined;

  return {
    raw: line,
    target,
    workMode,
    ...(intent ? { intent } : {}),
    ...(message ? { message } : {}),
    args,
  };
}

// ---------------------------------------------------------------------------
// Ingestion service
// ---------------------------------------------------------------------------

export interface GitHubIngestionOptions {
  broker: InMemoryA2ABroker;
  /** Intent used when a command does not specify one. Defaults to `analyze`. */
  defaultIntent?: A2AExchangeIntent;
  /** Identity used as the requester when synthesizing tasks. */
  requesterId?: string;
}

export type IngestionSkippedReason =
  | "duplicate_delivery"
  | "no_assignment_command"
  | "unknown_worker"
  | "unsupported_event";

export interface IngestionResult {
  /** True if the delivery id was seen before and the event was a no-op. */
  deduped: boolean;
  /** Parent task id, when one exists or was created. */
  parentTaskId?: string;
  /** Child task ids, ordered by occurrence in the source body. */
  childTaskIds: string[];
  /** Populated when no tasks were created, to aid debugging. */
  skippedReason?: IngestionSkippedReason;
}

export class GitHubIngestionService {
  private readonly broker: InMemoryA2ABroker;
  private readonly defaultIntent: A2AExchangeIntent;
  private readonly requesterId: string;
  private readonly seenDeliveries = new Set<string>();

  constructor(options: GitHubIngestionOptions) {
    this.broker = options.broker;
    this.defaultIntent = options.defaultIntent ?? "analyze";
    this.requesterId = options.requesterId ?? "github-ingestion";
  }

  ingest(event: GitHubWebhookEvent, ctx: GitHubDeliveryContext): IngestionResult {
    if (this.seenDeliveries.has(ctx.deliveryId)) {
      return { deduped: true, childTaskIds: [], skippedReason: "duplicate_delivery" };
    }
    this.seenDeliveries.add(ctx.deliveryId);

    switch (event.kind) {
      case "issues":
        return this.ingestIssue(event, ctx);
      case "issue_comment":
        return this.ingestIssueComment(event, ctx);
      case "pull_request":
        return this.ingestPullRequest(event, ctx);
      case "pull_request_review_comment":
        return this.ingestPullRequestComment(event, ctx);
      default:
        return { deduped: false, childTaskIds: [], skippedReason: "unsupported_event" };
    }
  }

  // -------------------------------------------------------------------------
  // Issue + comment handlers
  // -------------------------------------------------------------------------

  private ingestIssue(event: GitHubIssueEvent, ctx: GitHubDeliveryContext): IngestionResult {
    const intents = parseAssignmentIntents(event.issue.body);
    if (intents.length === 0) {
      return { deduped: false, childTaskIds: [], skippedReason: "no_assignment_command" };
    }

    const [primary, ...rest] = intents;
    const parentTask = this.ensureParentTask(event.repo, event.issue, primary!, ctx);
    if (!parentTask) {
      return { deduped: false, childTaskIds: [], skippedReason: "unknown_worker" };
    }

    const childTaskIds: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const intent = rest[i]!;
      const child = this.createChildTask({
        repo: event.repo,
        issue: event.issue,
        commentId: null,
        index: i,
        intent,
        ctx,
        parentTaskId: parentTask.id,
      });
      if (child) childTaskIds.push(child.id);
    }
    return { deduped: false, parentTaskId: parentTask.id, childTaskIds };
  }

  private ingestIssueComment(
    event: GitHubIssueCommentEvent,
    ctx: GitHubDeliveryContext,
  ): IngestionResult {
    if (event.action === "deleted") {
      return { deduped: false, childTaskIds: [], skippedReason: "unsupported_event" };
    }
    const intents = parseAssignmentIntents(event.comment.body);
    if (intents.length === 0) {
      return { deduped: false, childTaskIds: [], skippedReason: "no_assignment_command" };
    }

    const parentTask = this.ensureParentTask(
      event.repo,
      event.issue,
      // Use the first intent as the seed if no parent yet.
      intents[0]!,
      ctx,
    );
    if (!parentTask) {
      return { deduped: false, childTaskIds: [], skippedReason: "unknown_worker" };
    }

    const childTaskIds: string[] = [];
    for (let i = 0; i < intents.length; i++) {
      const intent = intents[i]!;
      const child = this.createChildTask({
        repo: event.repo,
        issue: event.issue,
        commentId: event.comment.id,
        index: i,
        intent,
        ctx,
        parentTaskId: parentTask.id,
      });
      if (child) childTaskIds.push(child.id);
    }
    return { deduped: false, parentTaskId: parentTask.id, childTaskIds };
  }

  private ingestPullRequest(
    event: GitHubPullRequestEvent,
    ctx: GitHubDeliveryContext,
  ): IngestionResult {
    // Pull requests reuse the issue-shaped flow: the PR body can carry an
    // /a2a assign command, and the broker treats the PR number identically
    // to the issue number for idempotent task ids.
    return this.ingestIssue(
      {
        kind: "issues",
        action: "opened",
        repo: event.repo,
        issue: event.pullRequest,
        sender: event.sender,
      },
      ctx,
    );
  }

  private ingestPullRequestComment(
    event: GitHubPullRequestCommentEvent,
    ctx: GitHubDeliveryContext,
  ): IngestionResult {
    return this.ingestIssueComment(
      {
        kind: "issue_comment",
        action: event.action,
        repo: event.repo,
        issue: event.pullRequest,
        comment: event.comment,
        sender: event.sender,
      },
      ctx,
    );
  }

  // -------------------------------------------------------------------------
  // Task creation
  // -------------------------------------------------------------------------

  private ensureParentTask(
    repo: GitHubRepoRef,
    issue: GitHubIssueRef,
    seedIntent: AssignmentIntent,
    ctx: GitHubDeliveryContext,
  ): TaskRecord | null {
    const id = parentTaskId(repo, issue);
    const existing = this.broker.getTask(id);
    if (existing) return existing;

    if (!this.broker.getWorker(seedIntent.target)) {
      return null;
    }

    const request: CreateTaskRequest = {
      id,
      intent: seedIntent.intent ?? this.defaultIntent,
      requester: { id: this.requesterId, kind: "service", role: "operator" },
      target: { id: seedIntent.target, kind: "node" },
      assignedWorkerId: seedIntent.target,
      message: seedIntent.message ?? `${repo.fullName}#${issue.number}: ${issue.title}`,
      payload: {
        githubDeliveryId: ctx.deliveryId,
        githubReceivedAt: ctx.receivedAt,
        githubRepo: repo.fullName,
        githubIssueNumber: issue.number,
        githubIssueUrl: issue.htmlUrl,
        githubWorkMode: seedIntent.workMode,
        githubKind: "issue",
      },
    };
    return this.broker.createTask(request);
  }

  private createChildTask(args: {
    repo: GitHubRepoRef;
    issue: GitHubIssueRef;
    commentId: number | null;
    index: number;
    intent: AssignmentIntent;
    ctx: GitHubDeliveryContext;
    parentTaskId: string;
  }): TaskRecord | null {
    const { repo, issue, commentId, index, intent, ctx, parentTaskId: parent } = args;
    if (!this.broker.getWorker(intent.target)) {
      return null;
    }

    const id = childTaskId(repo, issue, commentId, index);
    const existing = this.broker.getTask(id);
    if (existing) return existing;

    const request: CreateTaskRequest = {
      id,
      parentTaskId: parent,
      intent: intent.intent ?? this.defaultIntent,
      requester: { id: this.requesterId, kind: "service", role: "operator" },
      target: { id: intent.target, kind: "node" },
      assignedWorkerId: intent.target,
      message: intent.message ?? intent.raw,
      payload: {
        githubDeliveryId: ctx.deliveryId,
        githubReceivedAt: ctx.receivedAt,
        githubRepo: repo.fullName,
        githubIssueNumber: issue.number,
        githubIssueUrl: issue.htmlUrl,
        githubWorkMode: intent.workMode,
        ...(commentId !== null ? { githubCommentId: commentId } : {}),
        githubKind: commentId !== null ? "comment" : "issue",
        githubCommandIndex: index,
      },
    };
    return this.broker.createTask(request);
  }
}

// ---------------------------------------------------------------------------
// Deterministic task ids
// ---------------------------------------------------------------------------

function parentTaskId(repo: GitHubRepoRef, issue: GitHubIssueRef): string {
  return `gh:${repo.fullName}#${issue.number}`;
}

function childTaskId(
  repo: GitHubRepoRef,
  issue: GitHubIssueRef,
  commentId: number | null,
  index: number,
): string {
  const suffix = commentId !== null ? `c${commentId}` : "body";
  return `gh:${repo.fullName}#${issue.number}:${suffix}:${index}`;
}
