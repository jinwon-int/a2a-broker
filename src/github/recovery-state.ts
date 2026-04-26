/**
 * GitHub event replay → operator recovery-state projection (issue #67).
 *
 * Companion to `./ingestion.ts`. Where ingestion drives broker tasks from
 * GitHub commands, this module folds GitHub events (plus external task
 * status updates) into a per-`(repo, issue)` projection that classifies
 * each item into a `RecoveryBucket` for operator triage.
 *
 * Buckets:
 *   - `closed`            — issue closed or PR closed/merged
 *   - `ready_to_merge`    — PR open, approved, all checks passing
 *   - `blocked`           — failing checks, changes requested, or fallback
 *   - `needs_retry`       — linked broker task failed, issue/PR still open
 *   - `ready_to_review`   — PR open with passing checks, no review verdict
 *
 * Replay durability:
 *   - Each delivery's `X-GitHub-Delivery` id is recorded; replays are dropped.
 *   - Per `(repo, issueNumber)` we maintain a `lastEventAt` watermark and a
 *     monotonic `lastSeq`. Stale events (`receivedAt < lastEventAt`) are
 *     skipped and reported with `reconciled: true` so the caller knows the
 *     projection already reflects newer state.
 *   - Per-check entries store their own `receivedAt`, so out-of-order
 *     `check_run` events for distinct check names are folded in correctly
 *     even when one delivery beats another.
 *
 * Deferred event kinds (intentionally NOT projected here, listed so future
 * work has a clear catalogue and so unknown events bump a counter rather
 * than throwing):
 *   - `check_suite`       — aggregated by `check_run` already; suite-level
 *                            roll-ups would just duplicate state.
 *   - `status`            — legacy commit-status API; superseded by
 *                            `check_run` for our use.
 *   - `workflow_run`,
 *     `workflow_job`      — Actions internals; not needed for triage today.
 *   - `deployment`,
 *     `deployment_status` — release pipeline, separate concern.
 *   - `push`, `release`,
 *     `create`, `delete`  — refs/branches/tags; not issue-scoped.
 *   - `label`, `member`,
 *     `team_add`, etc.    — admin events with no triage signal here.
 *
 * The broker is the source of truth for tasks. This module never mutates
 * broker state; callers feed task transitions in via `setTaskStatus()`.
 */

import type { TaskStatus } from "../core/types.js";
import type {
  GitHubCheckConclusion,
  GitHubCheckRunEvent,
  GitHubCheckRunRef,
  GitHubDeliveryContext,
  GitHubIssueCommentEvent,
  GitHubIssueEvent,
  GitHubIssueRef,
  GitHubPullRequestCommentEvent,
  GitHubPullRequestEvent,
  GitHubPullRequestRef,
  GitHubPullRequestReviewEvent,
  GitHubRecoveryEvent,
  GitHubRepoRef,
  GitHubReviewVerdict,
  RecoveryBucket,
  RecoveryCheckEntry,
  RecoveryIssueKind,
  RecoveryIssueState,
  RecoveryLifecycleState,
} from "./types.js";

// ---------------------------------------------------------------------------
// Public result + diagnostic types
// ---------------------------------------------------------------------------

export type RecoverySkippedReason =
  | "duplicate_delivery"
  | "stale_event"
  | "deferred_event"
  | "no_state";

export interface RecoveryIngestionResult {
  /** True when the projection was mutated (state created or updated). */
  updated: boolean;
  /** Bucket the (repo, issue) sits in after this event. */
  recoveryBucket?: RecoveryBucket;
  /** Bucket the (repo, issue) sat in before this event (undefined on first sight). */
  previousBucket?: RecoveryBucket;
  /**
   * True when the event was older than the recorded watermark and therefore
   * not applied. The projection already reflects newer state, so the caller
   * may safely treat the event as a no-op.
   */
  reconciled: boolean;
  skippedReason?: RecoverySkippedReason;
}

export interface RecoveryReplayStats {
  /** Number of `(repo, issue)` pairs being projected. */
  trackedIssues: number;
  /** Total events accepted (created or updated state). */
  totalEvents: number;
  /** Deliveries deduped by X-GitHub-Delivery id. */
  duplicateDeliveries: number;
  /** Events skipped because their `receivedAt` was older than the watermark. */
  staleSkipped: number;
  /** Events whose payload was older than the per-pair watermark; same as `staleSkipped`. */
  reconciled: number;
  /** Counter per deferred event kind we declined to project. */
  deferredKinds: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const ALL_BUCKETS: ReadonlyArray<RecoveryBucket> = [
  "blocked",
  "ready_to_review",
  "ready_to_merge",
  "needs_retry",
  "closed",
];

const DEFERRED_KINDS: ReadonlySet<string> = new Set([
  "check_suite",
  "status",
  "workflow_run",
  "workflow_job",
  "deployment",
  "deployment_status",
  "push",
  "release",
  "create",
  "delete",
  "label",
  "member",
  "team_add",
]);

export class GitHubRecoveryState {
  private readonly issues = new Map<string, RecoveryIssueState>();
  private readonly seenDeliveries = new Set<string>();
  private totalEvents = 0;
  private duplicateDeliveries = 0;
  private staleSkipped = 0;
  private readonly deferredKinds: Record<string, number> = {};

  // -------------------------------------------------------------------------
  // Ingestion
  // -------------------------------------------------------------------------

  ingestEvent(
    event: GitHubRecoveryEvent,
    ctx: GitHubDeliveryContext,
  ): RecoveryIngestionResult {
    if (this.seenDeliveries.has(ctx.deliveryId)) {
      this.duplicateDeliveries++;
      return {
        updated: false,
        reconciled: false,
        skippedReason: "duplicate_delivery",
      };
    }
    this.seenDeliveries.add(ctx.deliveryId);

    switch (event.kind) {
      case "issues":
        return this.applyIssueEvent(event, ctx);
      case "issue_comment":
        return this.applyIssueCommentEvent(event, ctx);
      case "pull_request":
        return this.applyPullRequestEvent(event, ctx);
      case "pull_request_review_comment":
        return this.applyPullRequestCommentEvent(event, ctx);
      case "check_run":
        return this.applyCheckRunEvent(event, ctx);
      case "pull_request_review":
        return this.applyPullRequestReviewEvent(event, ctx);
      default: {
        // Unknown / deferred kind. Type-assertion for narrowing closes the
        // discriminated union: the runtime payload may still arrive (caller
        // built the event from a webhook) but TypeScript treats this as
        // `never` after exhausting the union above.
        const kind = (event as { kind?: string }).kind ?? "unknown";
        if (DEFERRED_KINDS.has(kind)) {
          this.deferredKinds[kind] = (this.deferredKinds[kind] ?? 0) + 1;
        } else {
          this.deferredKinds[kind] = (this.deferredKinds[kind] ?? 0) + 1;
        }
        return {
          updated: false,
          reconciled: false,
          skippedReason: "deferred_event",
        };
      }
    }
  }

  /**
   * Fold an external broker task status update into the projection. Used
   * when a task transitions to `failed`, `canceled`, `succeeded`, etc., so
   * that the recovery bucket reflects the latest task state. The `(repo,
   * issue)` need not have been seen by `ingestEvent` first; a minimal
   * placeholder state is created on demand.
   */
  setTaskStatus(
    repo: GitHubRepoRef,
    issueNumber: number,
    status: TaskStatus,
    options: { taskId?: string; observedAt?: string } = {},
  ): RecoveryIngestionResult {
    const observedAt = options.observedAt ?? new Date().toISOString();
    const key = makePairKey(repo, issueNumber);
    let state = this.issues.get(key);
    let previousBucket: RecoveryBucket | undefined;

    if (!state) {
      state = createPlaceholderState(repo, issueNumber, observedAt);
      this.issues.set(key, state);
    } else {
      previousBucket = state.bucket;
    }

    state.taskStatus = status;
    if (options.taskId && !state.linkedTaskIds.includes(options.taskId)) {
      state.linkedTaskIds.push(options.taskId);
    }
    if (observedAt > state.lastEventAt) {
      state.lastEventAt = observedAt;
    }
    state.lastSeq++;
    this.totalEvents++;

    const newBucket = computeBucket(state);
    state.bucket = newBucket;

    return {
      updated: previousBucket !== newBucket || previousBucket === undefined,
      recoveryBucket: newBucket,
      previousBucket,
      reconciled: false,
    };
  }

  // -------------------------------------------------------------------------
  // Query helpers
  // -------------------------------------------------------------------------

  getIssueState(repo: GitHubRepoRef, issueNumber: number): RecoveryIssueState | null {
    return this.issues.get(makePairKey(repo, issueNumber)) ?? null;
  }

  getBucketIssues(repo: GitHubRepoRef, bucket: RecoveryBucket): RecoveryIssueState[] {
    const out: RecoveryIssueState[] = [];
    for (const state of this.issues.values()) {
      if (state.repoFullName === repo.fullName && state.bucket === bucket) {
        out.push(state);
      }
    }
    out.sort((a, b) => a.issueNumber - b.issueNumber);
    return out;
  }

  getAllBuckets(repo: GitHubRepoRef): Record<RecoveryBucket, number> {
    const counts: Record<RecoveryBucket, number> = {
      blocked: 0,
      ready_to_review: 0,
      ready_to_merge: 0,
      needs_retry: 0,
      closed: 0,
    };
    for (const state of this.issues.values()) {
      if (state.repoFullName !== repo.fullName) continue;
      counts[state.bucket]++;
    }
    return counts;
  }

  getReplayStats(): RecoveryReplayStats {
    return {
      trackedIssues: this.issues.size,
      totalEvents: this.totalEvents,
      duplicateDeliveries: this.duplicateDeliveries,
      staleSkipped: this.staleSkipped,
      reconciled: this.staleSkipped,
      deferredKinds: { ...this.deferredKinds },
    };
  }

  // -------------------------------------------------------------------------
  // Per-event handlers
  // -------------------------------------------------------------------------

  private applyIssueEvent(
    event: GitHubIssueEvent,
    ctx: GitHubDeliveryContext,
  ): RecoveryIngestionResult {
    return this.applyIssueLike(event.repo, event.issue, "issue", event.action, ctx);
  }

  private applyIssueCommentEvent(
    event: GitHubIssueCommentEvent,
    ctx: GitHubDeliveryContext,
  ): RecoveryIngestionResult {
    // Comments only refresh ownership/lastEventAt — the issue body/state
    // is unchanged. Treat as a touch event.
    return this.applyIssueLike(event.repo, event.issue, "issue", "edited", ctx);
  }

  private applyPullRequestEvent(
    event: GitHubPullRequestEvent,
    ctx: GitHubDeliveryContext,
  ): RecoveryIngestionResult {
    return this.applyIssueLike(
      event.repo,
      event.pullRequest,
      "pull_request",
      event.action,
      ctx,
      event.pullRequest,
    );
  }

  private applyPullRequestCommentEvent(
    event: GitHubPullRequestCommentEvent,
    ctx: GitHubDeliveryContext,
  ): RecoveryIngestionResult {
    return this.applyIssueLike(
      event.repo,
      event.pullRequest,
      "pull_request",
      "edited",
      ctx,
      event.pullRequest,
    );
  }

  private applyCheckRunEvent(
    event: GitHubCheckRunEvent,
    ctx: GitHubDeliveryContext,
  ): RecoveryIngestionResult {
    const key = makePairKey(event.repo, event.issueNumber);
    let state = this.issues.get(key);
    if (!state) {
      // No prior state: create a PR placeholder so checks have something to
      // attach to. The PR `state` defaults to `open` since we are receiving
      // checks (which do not fire against closed PRs from GitHub's side).
      state = createPlaceholderState(event.repo, event.issueNumber, ctx.receivedAt, {
        kind: "pull_request",
        headSha: event.checkRun.headSha,
      });
      this.issues.set(key, state);
    }
    const previousBucket = state.bucket;

    // SHA advance: when a check arrives for a different head SHA than what
    // we have on file, use the delivery timestamp to disambiguate replay
    // vs forward advance. An older timestamp means the event predates our
    // watermark and is a stale check for a SHA we've moved past; a newer
    // timestamp means the head SHA has rolled forward and old checks are
    // no longer authoritative for the new commit.
    if (state.headSha && event.checkRun.headSha !== state.headSha) {
      if (ctx.receivedAt < state.lastEventAt) {
        this.staleSkipped++;
        return {
          updated: false,
          recoveryBucket: previousBucket,
          previousBucket,
          reconciled: true,
          skippedReason: "stale_event",
        };
      }
      state.checks = {};
      state.headSha = event.checkRun.headSha;
    } else if (!state.headSha) {
      state.headSha = event.checkRun.headSha;
    }

    // Per-check stale-replay guard for the same check name on the same SHA.
    const existing = state.checks[event.checkRun.name];
    if (existing && ctx.receivedAt < existing.receivedAt) {
      this.staleSkipped++;
      return {
        updated: false,
        recoveryBucket: previousBucket,
        previousBucket,
        reconciled: true,
        skippedReason: "stale_event",
      };
    }
    const conclusion = mapCheckConclusion(event.checkRun);

    const entry: RecoveryCheckEntry = {
      conclusion,
      headSha: event.checkRun.headSha,
      receivedAt: ctx.receivedAt,
    };
    state.checks[event.checkRun.name] = entry;
    state.checkStatus = aggregateCheckStatus(state.checks);

    bumpWatermark(state, ctx.receivedAt);
    this.totalEvents++;

    state.bucket = computeBucket(state);
    return {
      updated: true,
      recoveryBucket: state.bucket,
      previousBucket,
      reconciled: false,
    };
  }

  private applyPullRequestReviewEvent(
    event: GitHubPullRequestReviewEvent,
    ctx: GitHubDeliveryContext,
  ): RecoveryIngestionResult {
    const key = makePairKey(event.repo, event.pullRequest.number);
    let state = this.issues.get(key);
    if (!state) {
      state = createPlaceholderState(event.repo, event.pullRequest.number, ctx.receivedAt, {
        kind: "pull_request",
      });
      this.issues.set(key, state);
    }
    const previousBucket = state.bucket;

    if (ctx.receivedAt < state.lastEventAt) {
      this.staleSkipped++;
      return {
        updated: false,
        recoveryBucket: previousBucket,
        previousBucket,
        reconciled: true,
        skippedReason: "stale_event",
      };
    }

    // Patch in the latest PR ref so URL/labels/state stay fresh.
    mergePullRequestRef(state, event.pullRequest);

    const verdict = mapReviewVerdict(event.action, event.reviewState);
    if (verdict !== null) {
      state.reviewStatus = verdict;
    }

    bumpWatermark(state, ctx.receivedAt);
    this.totalEvents++;

    state.bucket = computeBucket(state);
    return {
      updated: true,
      recoveryBucket: state.bucket,
      previousBucket,
      reconciled: false,
    };
  }

  private applyIssueLike(
    repo: GitHubRepoRef,
    issue: GitHubIssueRef,
    kind: RecoveryIssueKind,
    action: string,
    ctx: GitHubDeliveryContext,
    pr?: GitHubPullRequestRef,
  ): RecoveryIngestionResult {
    const key = makePairKey(repo, issue.number);
    let state = this.issues.get(key);
    let previousBucket: RecoveryBucket | undefined;

    if (state && ctx.receivedAt < state.lastEventAt) {
      this.staleSkipped++;
      return {
        updated: false,
        recoveryBucket: state.bucket,
        previousBucket: state.bucket,
        reconciled: true,
        skippedReason: "stale_event",
      };
    }

    if (!state) {
      state = createStateFromIssue(repo, issue, kind, ctx.receivedAt, pr);
      this.issues.set(key, state);
    } else {
      previousBucket = state.bucket;
      // Refresh fields that may have changed.
      state.title = issue.title;
      state.htmlUrl = issue.htmlUrl;
      state.labels = issue.labels ? [...issue.labels] : state.labels;
      if (issue.user?.login && !state.ownerLogins.includes(issue.user.login)) {
        state.ownerLogins.push(issue.user.login);
      }
      if (pr) {
        mergePullRequestRef(state, pr);
      }
    }

    state.state = deriveLifecycleState(issue, action, pr);
    bumpWatermark(state, ctx.receivedAt);
    this.totalEvents++;

    state.bucket = computeBucket(state);
    return {
      updated: true,
      recoveryBucket: state.bucket,
      previousBucket,
      reconciled: false,
    };
  }
}

function makePairKey(repo: GitHubRepoRef, issueNumber: number): string {
  return `${repo.fullName}#${issueNumber}`;
}

// ---------------------------------------------------------------------------
// State construction + helpers
// ---------------------------------------------------------------------------

function createStateFromIssue(
  repo: GitHubRepoRef,
  issue: GitHubIssueRef,
  kind: RecoveryIssueKind,
  receivedAt: string,
  pr?: GitHubPullRequestRef,
): RecoveryIssueState {
  const ownerLogins: string[] = [];
  if (issue.user?.login) ownerLogins.push(issue.user.login);

  const state: RecoveryIssueState = {
    repoFullName: repo.fullName,
    issueNumber: issue.number,
    kind,
    state: issue.state === "closed" ? "closed" : "open",
    title: issue.title,
    htmlUrl: issue.htmlUrl,
    labels: issue.labels ? [...issue.labels] : [],
    ownerLogins,
    linkedTaskIds: [],
    checks: {},
    checkStatus: "pending",
    reviewStatus: "none",
    lastEventAt: receivedAt,
    // bumped to 1 by the caller's bumpWatermark() — the creating event
    // counts as the first accepted event for this pair.
    lastSeq: 0,
    bucket: "blocked", // recomputed below
  };
  if (pr) {
    state.prUrl = pr.prUrl;
    if (pr.merged) state.state = "merged";
  }
  state.bucket = computeBucket(state);
  return state;
}

function createPlaceholderState(
  repo: GitHubRepoRef,
  issueNumber: number,
  receivedAt: string,
  overrides: { kind?: RecoveryIssueKind; headSha?: string } = {},
): RecoveryIssueState {
  const state: RecoveryIssueState = {
    repoFullName: repo.fullName,
    issueNumber,
    kind: overrides.kind ?? "issue",
    state: "open",
    title: "",
    htmlUrl: "",
    labels: [],
    ownerLogins: [],
    linkedTaskIds: [],
    checks: {},
    checkStatus: "pending",
    reviewStatus: "none",
    lastEventAt: receivedAt,
    // bumped to 1 by the caller's bumpWatermark() / setTaskStatus().
    lastSeq: 0,
    bucket: "blocked",
  };
  if (overrides.headSha) state.headSha = overrides.headSha;
  state.bucket = computeBucket(state);
  return state;
}

function mergePullRequestRef(state: RecoveryIssueState, pr: GitHubPullRequestRef): void {
  state.kind = "pull_request";
  state.prUrl = pr.prUrl;
  if (pr.title) state.title = pr.title;
  if (pr.htmlUrl) state.htmlUrl = pr.htmlUrl;
  if (pr.labels) state.labels = [...pr.labels];
  if (pr.user?.login && !state.ownerLogins.includes(pr.user.login)) {
    state.ownerLogins.push(pr.user.login);
  }
}

function deriveLifecycleState(
  issue: GitHubIssueRef,
  action: string,
  pr?: GitHubPullRequestRef,
): RecoveryLifecycleState {
  if (pr?.merged) return "merged";
  if (action === "closed" || issue.state === "closed") return "closed";
  if (action === "reopened") return "open";
  return issue.state;
}

function bumpWatermark(state: RecoveryIssueState, receivedAt: string): void {
  if (receivedAt > state.lastEventAt) {
    state.lastEventAt = receivedAt;
  }
  state.lastSeq++;
}

// ---------------------------------------------------------------------------
// Aggregations
// ---------------------------------------------------------------------------

function aggregateCheckStatus(
  checks: Record<string, RecoveryCheckEntry>,
): GitHubCheckConclusion {
  const entries = Object.values(checks);
  if (entries.length === 0) return "pending";
  let hasFailing = false;
  let hasPending = false;
  for (const entry of entries) {
    if (entry.conclusion === "failing") hasFailing = true;
    else if (entry.conclusion === "pending") hasPending = true;
  }
  if (hasFailing) return "failing";
  if (hasPending) return "pending";
  return "passing";
}

function mapCheckConclusion(check: GitHubCheckRunRef): GitHubCheckConclusion {
  if (check.status !== "completed") return "pending";
  switch (check.conclusion) {
    case "success":
    case "neutral":
    case "skipped":
      return "passing";
    case "failure":
    case "cancelled":
    case "timed_out":
    case "action_required":
    case "stale":
      return "failing";
    default:
      return "pending";
  }
}

function mapReviewVerdict(
  action: GitHubPullRequestReviewEvent["action"],
  reviewState: GitHubPullRequestReviewEvent["reviewState"],
): GitHubReviewVerdict | null {
  if (action === "dismissed" || reviewState === "dismissed") return "none";
  if (reviewState === "approved") return "approved";
  if (reviewState === "changes_requested") return "changes_requested";
  // commented / edited without a verdict change — leave the existing verdict.
  return null;
}

// ---------------------------------------------------------------------------
// Bucket classification
// ---------------------------------------------------------------------------

function computeBucket(state: RecoveryIssueState): RecoveryBucket {
  if (state.state === "closed" || state.state === "merged") {
    return "closed";
  }

  const isPullRequest = state.kind === "pull_request";

  if (isPullRequest) {
    if (state.reviewStatus === "approved" && state.checkStatus === "passing") {
      return "ready_to_merge";
    }
    if (state.checkStatus === "failing") return "blocked";
    if (state.reviewStatus === "changes_requested") return "blocked";
    if (state.taskStatus === "failed") return "needs_retry";
    if (state.checkStatus === "passing") return "ready_to_review";
    return "blocked";
  }

  // Plain issue.
  if (state.taskStatus === "failed") return "needs_retry";
  return "blocked";
}

// ---------------------------------------------------------------------------
// Re-exports for convenience
// ---------------------------------------------------------------------------

export const RECOVERY_BUCKETS: ReadonlyArray<RecoveryBucket> = ALL_BUCKETS;
