/**
 * GitHub-side ingestion: parse `/a2a assign` commands from issue/comment
 * bodies and turn them into broker parent/child tasks. Also drive lifecycle
 * transitions (close/reopen/merge) back into the broker so the GitHub thread
 * remains the user-visible source of intent.
 *
 * Idempotency / replay strategy:
 *   - Each delivery's `X-GitHub-Delivery` id is recorded; replays are dropped.
 *   - Task ids are deterministic from `(repo, issue, [comment, intent#])`,
 *     so even cross-delivery duplicates collapse onto the same broker task
 *     via the broker's id-based idempotency.
 *   - Per `(repoFullName, issueNumber)` we maintain a `lastSeenAt` watermark
 *     plus a monotonic `lastSeq`. Events whose delivery `receivedAt` is at or
 *     before the recorded watermark are treated as stale replays and dropped.
 *   - Lifecycle events also bump a separate `lifecycleWatermark` so a stale
 *     close/reopen/merge cannot overwrite a newer terminal state.
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
  TaskResult,
  TaskStatus,
} from "../core/types.js";
import type {
  GitHubDeliveryContext,
  GitHubIssueCommentEvent,
  GitHubIssueEvent,
  GitHubIssueRef,
  GitHubPullRequestCommentEvent,
  GitHubPullRequestEvent,
  GitHubPullRequestRef,
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
  | "unsupported_event"
  | "no_parent_task"
  | "stale_lifecycle"
  | "reconciliation_needed";

export type LifecycleAction = "issue_closed" | "issue_reopened" | "pr_merged" | "pr_closed";

export interface LifecycleTransition {
  /** Task status before the lifecycle event was applied. */
  from: TaskStatus;
  /**
   * Status after the lifecycle event. When `reconciled` is true the broker
   * was NOT mutated and `to` reflects the status the event *would* have
   * imposed; downstream consumers must reconcile out-of-band.
   */
  to: TaskStatus;
  /**
   * True when the broker rejected the requested transition (already terminal,
   * or no public API path) and downstream consumers must reconcile.
   */
  reconciled: boolean;
}

export interface IngestionResult {
  /** True if the delivery id was seen before and the event was a no-op. */
  deduped: boolean;
  /**
   * True when the event was dropped because a newer event for the same
   * `(repo, issue)` was already processed (stale replay / out-of-order).
   */
  replaySkipped: boolean;
  /** Parent task id, when one exists or was created. */
  parentTaskId?: string;
  /** Child task ids, ordered by occurrence in the source body. */
  childTaskIds: string[];
  /** Populated when no tasks were created/transitioned, to aid debugging. */
  skippedReason?: IngestionSkippedReason;
  /** Populated for lifecycle events (closed/reopened/merged). */
  lifecycleTransition: LifecycleTransition | null;
}

interface ReplayState {
  /** Monotonic counter of accepted events for a `(repo, issue)` pair. */
  lastSeq: number;
  /** Delivery `receivedAt` of the last accepted event for the pair. */
  lastSeenAt: string;
  /** Delivery `receivedAt` of the last accepted lifecycle event. */
  lifecycleWatermark?: string;
}

export interface ReplayStats {
  /** Number of `(repo, issue)` pairs being tracked. */
  trackedPairs: number;
  /** Total events accepted across all pairs. */
  totalEvents: number;
  /** Total events skipped because their timestamp was older than the watermark. */
  staleSkipped: number;
  /** Total deliveries deduped against the X-GitHub-Delivery seen-set. */
  duplicateDeliveries: number;
  /** Number of pairs that have at least one lifecycle action recorded. */
  lifecycleWatermarks: number;
}

const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "succeeded",
  "failed",
  "canceled",
]);

function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

function emptyResult(overrides: Partial<IngestionResult> = {}): IngestionResult {
  return {
    deduped: false,
    replaySkipped: false,
    childTaskIds: [],
    lifecycleTransition: null,
    ...overrides,
  };
}

export class GitHubIngestionService {
  private readonly broker: InMemoryA2ABroker;
  private readonly defaultIntent: A2AExchangeIntent;
  private readonly requesterId: string;
  private readonly seenDeliveries = new Set<string>();
  private readonly replayState = new Map<string, ReplayState>();
  private replayCounters = {
    totalEvents: 0,
    staleSkipped: 0,
    duplicateDeliveries: 0,
  };

  constructor(options: GitHubIngestionOptions) {
    this.broker = options.broker;
    this.defaultIntent = options.defaultIntent ?? "analyze";
    this.requesterId = options.requesterId ?? "github-ingestion";
  }

  ingest(event: GitHubWebhookEvent, ctx: GitHubDeliveryContext): IngestionResult {
    if (this.seenDeliveries.has(ctx.deliveryId)) {
      this.replayCounters.duplicateDeliveries++;
      return emptyResult({ deduped: true, skippedReason: "duplicate_delivery" });
    }
    this.seenDeliveries.add(ctx.deliveryId);

    const pair = pairKeyForEvent(event);
    if (pair) {
      const accepted = this.acceptEvent(pair, ctx.receivedAt);
      if (!accepted) {
        return emptyResult({
          replaySkipped: true,
          skippedReason: "stale_lifecycle",
        });
      }
    }

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
        return emptyResult({ skippedReason: "unsupported_event" });
    }
  }

  // -------------------------------------------------------------------------
  // Public lifecycle handlers — callable directly when an upstream component
  // already knows what kind of transition it wants to apply, e.g. when
  // backfilling state from a poll rather than from a webhook.
  // -------------------------------------------------------------------------

  handleIssueClosed(
    repo: GitHubRepoRef,
    issue: GitHubIssueRef,
    ctx: GitHubDeliveryContext,
  ): IngestionResult {
    const gate = this.gateLifecycleEntry(repo, issue.number, ctx);
    if (gate) return gate;
    return this.applyLifecycle({
      repo,
      issue,
      targetStatus: "canceled",
      transition: (task) => this.cancelExistingTask(task, "issue closed"),
    });
  }

  handleIssueReopened(
    repo: GitHubRepoRef,
    issue: GitHubIssueRef,
    ctx: GitHubDeliveryContext,
  ): IngestionResult {
    const gate = this.gateLifecycleEntry(repo, issue.number, ctx);
    if (gate) return gate;
    return this.applyLifecycle({
      repo,
      issue,
      targetStatus: "queued",
      // The broker has no public path that promotes a canceled task back to
      // `queued`. Surface every reopen as `reconciliation_needed` so the
      // operator can decide whether to recreate or reassign.
      transition: () => null,
    });
  }

  handlePullRequestMerged(
    repo: GitHubRepoRef,
    pr: GitHubPullRequestRef,
    ctx: GitHubDeliveryContext,
  ): IngestionResult {
    const gate = this.gateLifecycleEntry(repo, pr.number, ctx);
    if (gate) return gate;
    const prResult: TaskResult = {
      summary: `merged ${pr.prUrl}`,
      output: {
        pullRequestUrl: pr.prUrl,
        pullRequestNumber: pr.number,
        merged: true,
      },
    };
    return this.applyLifecycle({
      repo,
      issue: pr,
      targetStatus: "succeeded",
      transition: (task) => this.completeExistingTask(task, prResult),
    });
  }

  handlePullRequestClosed(
    repo: GitHubRepoRef,
    pr: GitHubPullRequestRef,
    ctx: GitHubDeliveryContext,
  ): IngestionResult {
    const gate = this.gateLifecycleEntry(repo, pr.number, ctx);
    if (gate) return gate;
    return this.applyLifecycle({
      repo,
      issue: pr,
      targetStatus: "canceled",
      transition: (task) => this.cancelExistingTask(task, "pull request closed without merge"),
    });
  }

  // -------------------------------------------------------------------------
  // Diagnostics
  // -------------------------------------------------------------------------

  getReplayStats(): ReplayStats {
    let lifecycleWatermarks = 0;
    for (const state of this.replayState.values()) {
      if (state.lifecycleWatermark) lifecycleWatermarks++;
    }
    return {
      trackedPairs: this.replayState.size,
      totalEvents: this.replayCounters.totalEvents,
      staleSkipped: this.replayCounters.staleSkipped,
      duplicateDeliveries: this.replayCounters.duplicateDeliveries,
      lifecycleWatermarks,
    };
  }

  // -------------------------------------------------------------------------
  // Issue + comment handlers
  // -------------------------------------------------------------------------

  private ingestIssue(event: GitHubIssueEvent, ctx: GitHubDeliveryContext): IngestionResult {
    if (event.action === "closed") {
      return this.handleIssueClosed(event.repo, event.issue, ctx);
    }
    if (event.action === "reopened") {
      return this.handleIssueReopened(event.repo, event.issue, ctx);
    }

    const intents = parseAssignmentIntents(event.issue.body);
    if (intents.length === 0) {
      return emptyResult({ skippedReason: "no_assignment_command" });
    }

    const [primary, ...rest] = intents;
    const parentTask = this.ensureParentTask(event.repo, event.issue, primary!, ctx);
    if (!parentTask) {
      return emptyResult({ skippedReason: "unknown_worker" });
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
    return emptyResult({ parentTaskId: parentTask.id, childTaskIds });
  }

  private ingestIssueComment(
    event: GitHubIssueCommentEvent,
    ctx: GitHubDeliveryContext,
  ): IngestionResult {
    if (event.action === "deleted") {
      return emptyResult({ skippedReason: "unsupported_event" });
    }
    const intents = parseAssignmentIntents(event.comment.body);
    if (intents.length === 0) {
      return emptyResult({ skippedReason: "no_assignment_command" });
    }

    const parentTask = this.ensureParentTask(
      event.repo,
      event.issue,
      // Use the first intent as the seed if no parent yet.
      intents[0]!,
      ctx,
    );
    if (!parentTask) {
      return emptyResult({ skippedReason: "unknown_worker" });
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
    return emptyResult({ parentTaskId: parentTask.id, childTaskIds });
  }

  private ingestPullRequest(
    event: GitHubPullRequestEvent,
    ctx: GitHubDeliveryContext,
  ): IngestionResult {
    if (event.action === "closed") {
      if (event.pullRequest.merged) {
        return this.handlePullRequestMerged(event.repo, event.pullRequest, ctx);
      }
      return this.handlePullRequestClosed(event.repo, event.pullRequest, ctx);
    }
    if (event.action === "reopened") {
      return this.handleIssueReopened(event.repo, event.pullRequest, ctx);
    }

    // Pull requests reuse the issue-shaped flow for opened/edited/etc. The
    // PR body can carry an /a2a assign command, and the broker treats the
    // PR number identically to the issue number for idempotent task ids.
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
      taskOrigin: "github",
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
      taskOrigin: "github",
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

  // -------------------------------------------------------------------------
  // Lifecycle plumbing
  // -------------------------------------------------------------------------

  /**
   * Pre-flight for a public lifecycle handler: enforce per-pair watermark and
   * per-pair lifecycle watermark, advancing both when the event is accepted.
   * Returns a result when the event should be short-circuited as stale;
   * returns `null` when the caller should proceed with the transition.
   *
   * Re-entry from `ingest()` is detected by `lastSeenAt === receivedAt`
   * (the outer dispatch already advanced state to this same timestamp) and
   * does not double-advance the pair counter.
   */
  private gateLifecycleEntry(
    repo: GitHubRepoRef,
    issueNumber: number,
    ctx: GitHubDeliveryContext,
  ): IngestionResult | null {
    const pairKey = makePairKey(repo, issueNumber);
    const state = this.replayState.get(pairKey);

    // Lifecycle watermark check first so a stale lifecycle event never
    // double-increments counters via the pair-watermark path.
    if (state?.lifecycleWatermark && ctx.receivedAt < state.lifecycleWatermark) {
      this.replayCounters.staleSkipped++;
      return emptyResult({ replaySkipped: true, skippedReason: "stale_lifecycle" });
    }

    const isReentry = !!state && ctx.receivedAt === state.lastSeenAt;
    if (state && !isReentry && ctx.receivedAt < state.lastSeenAt) {
      this.replayCounters.staleSkipped++;
      return emptyResult({ replaySkipped: true, skippedReason: "stale_lifecycle" });
    }

    if (!state) {
      this.replayState.set(pairKey, {
        lastSeq: 1,
        lastSeenAt: ctx.receivedAt,
        lifecycleWatermark: ctx.receivedAt,
      });
      this.replayCounters.totalEvents++;
      return null;
    }
    if (!isReentry) {
      state.lastSeq++;
      state.lastSeenAt = ctx.receivedAt;
      this.replayCounters.totalEvents++;
    }
    if (!state.lifecycleWatermark || ctx.receivedAt > state.lifecycleWatermark) {
      state.lifecycleWatermark = ctx.receivedAt;
    }
    return null;
  }

  private applyLifecycle(args: {
    repo: GitHubRepoRef;
    issue: GitHubIssueRef;
    /** What the lifecycle event would impose on the task. */
    targetStatus: TaskStatus;
    /**
     * Mutator invoked when the existing task is non-terminal. Returns the
     * post-mutation task, or null when the broker public API offers no path
     * to apply the requested transition.
     */
    transition: (task: TaskRecord) => TaskRecord | null;
  }): IngestionResult {
    const { repo, issue, targetStatus, transition } = args;
    const id = parentTaskId(repo, issue);
    const task = this.broker.getTask(id);
    if (!task) {
      return emptyResult({ skippedReason: "no_parent_task" });
    }

    const fromStatus = task.status;

    // Already at the requested status — benign re-run (e.g. closing twice
    // when the task is already canceled, or reopening a still-queued task).
    if (fromStatus === targetStatus) {
      return emptyResult({
        parentTaskId: task.id,
        lifecycleTransition: { from: fromStatus, to: fromStatus, reconciled: false },
      });
    }

    // Different terminal status — broker won't let us re-transition.
    if (isTerminal(fromStatus)) {
      return emptyResult({
        parentTaskId: task.id,
        skippedReason: "reconciliation_needed",
        lifecycleTransition: { from: fromStatus, to: targetStatus, reconciled: true },
      });
    }

    const post = transition(task);
    if (!post) {
      // Non-terminal but the broker offers no public path to drive this
      // particular transition (e.g. reopen back to queued). Surface for
      // operator reconciliation rather than silently dropping the event.
      return emptyResult({
        parentTaskId: task.id,
        skippedReason: "reconciliation_needed",
        lifecycleTransition: { from: fromStatus, to: targetStatus, reconciled: true },
      });
    }

    return emptyResult({
      parentTaskId: post.id,
      lifecycleTransition: { from: fromStatus, to: post.status, reconciled: false },
    });
  }

  private cancelExistingTask(task: TaskRecord, reason: string): TaskRecord {
    return this.broker.cancelTask(task.id, {
      actor: { id: this.requesterId, kind: "service", role: "operator" },
      reason,
    });
  }

  /**
   * Best-effort completion driven by a PR merge. The broker's `completeTask`
   * requires the task to already be in `claimed` or `running` and to be
   * called with the assigned worker's identity. When those preconditions
   * don't hold we can't drive the transition through the public API, so the
   * caller surfaces `reconciliation_needed` instead.
   */
  private completeExistingTask(task: TaskRecord, result: TaskResult): TaskRecord | null {
    if (task.status !== "claimed" && task.status !== "running") {
      return null;
    }
    const workerId = task.claimedBy ?? task.assignedWorkerId ?? task.targetNodeId;
    if (!workerId || !this.broker.getWorker(workerId)) {
      return null;
    }
    try {
      return this.broker.completeTask(task.id, workerId, result);
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Replay state helpers
  // -------------------------------------------------------------------------

  /**
   * Advance the per-pair watermark. Returns true when the event should be
   * processed; false when it is older than the recorded watermark (stale
   * replay / out-of-order).
   *
   * Equal-timestamp events are accepted: cross-delivery duplicates collapse
   * downstream via the seenDeliveries set and the broker's deterministic
   * task ids; lifecycle handlers are independently idempotent.
   */
  private acceptEvent(pairKey: string, receivedAt: string): boolean {
    const state = this.replayState.get(pairKey);
    if (!state) {
      this.replayState.set(pairKey, { lastSeq: 1, lastSeenAt: receivedAt });
      this.replayCounters.totalEvents++;
      return true;
    }
    if (receivedAt < state.lastSeenAt) {
      this.replayCounters.staleSkipped++;
      return false;
    }
    if (receivedAt > state.lastSeenAt) {
      state.lastSeq++;
      state.lastSeenAt = receivedAt;
    }
    this.replayCounters.totalEvents++;
    return true;
  }
}

// ---------------------------------------------------------------------------
// Pair-key helpers
// ---------------------------------------------------------------------------

function pairKeyForEvent(event: GitHubWebhookEvent): string | null {
  switch (event.kind) {
    case "issues":
    case "issue_comment":
      return makePairKey(event.repo, event.issue.number);
    case "pull_request":
    case "pull_request_review_comment":
      return makePairKey(event.repo, event.pullRequest.number);
    default:
      return null;
  }
}

function makePairKey(repo: GitHubRepoRef, issueNumber: number): string {
  return `${repo.fullName}#${issueNumber}`;
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
