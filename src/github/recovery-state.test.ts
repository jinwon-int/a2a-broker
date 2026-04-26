import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { GitHubRecoveryState } from "./recovery-state.js";
import type {
  GitHubCheckRunEvent,
  GitHubDeliveryContext,
  GitHubIssueEvent,
  GitHubIssueRef,
  GitHubPullRequestEvent,
  GitHubPullRequestRef,
  GitHubPullRequestReviewEvent,
  GitHubRepoRef,
  GitHubUserRef,
} from "./types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const repo: GitHubRepoRef = {
  owner: "acme",
  name: "platform",
  fullName: "acme/platform",
};

const sender: GitHubUserRef = { login: "alice", id: 42, type: "User" };

function makeIssue(overrides: Partial<GitHubIssueRef> = {}): GitHubIssueRef {
  return {
    number: 7,
    title: "Investigate stale lease bug",
    body: "Look at this",
    htmlUrl: "https://github.com/acme/platform/issues/7",
    state: "open",
    user: sender,
    labels: ["bug"],
    ...overrides,
  };
}

function makeIssueEvent(
  overrides: Partial<GitHubIssueEvent> = {},
): GitHubIssueEvent {
  return {
    kind: "issues",
    action: "opened",
    repo,
    issue: makeIssue(),
    sender,
    ...overrides,
  };
}

function makePullRequest(
  overrides: Partial<GitHubPullRequestRef> = {},
): GitHubPullRequestRef {
  return {
    number: 42,
    title: "Fix the lease bug",
    body: "Closes #7",
    htmlUrl: "https://github.com/acme/platform/pull/42",
    state: "open",
    user: sender,
    labels: [],
    prUrl: "https://github.com/acme/platform/pull/42",
    draft: false,
    merged: false,
    ...overrides,
  };
}

function makePullRequestEvent(
  overrides: Partial<GitHubPullRequestEvent> = {},
): GitHubPullRequestEvent {
  return {
    kind: "pull_request",
    action: "opened",
    repo,
    pullRequest: makePullRequest(),
    sender,
    ...overrides,
  };
}

function makeCheckRunEvent(
  overrides: Partial<GitHubCheckRunEvent> = {},
): GitHubCheckRunEvent {
  return {
    kind: "check_run",
    action: "completed",
    repo,
    issueNumber: 42,
    checkRun: {
      name: "ci/build",
      status: "completed",
      conclusion: "success",
      headSha: "deadbeef",
    },
    sender,
    ...overrides,
  };
}

function makeReviewEvent(
  overrides: Partial<GitHubPullRequestReviewEvent> = {},
): GitHubPullRequestReviewEvent {
  return {
    kind: "pull_request_review",
    action: "submitted",
    repo,
    pullRequest: makePullRequest(),
    reviewState: "approved",
    sender,
    ...overrides,
  };
}

function makeContext(
  deliveryId: string,
  receivedAt: string = "2026-04-26T12:00:01Z",
): GitHubDeliveryContext {
  return { deliveryId, receivedAt };
}

// ---------------------------------------------------------------------------
// Idempotency: duplicate delivery
// ---------------------------------------------------------------------------

describe("GitHubRecoveryState — idempotency", () => {
  it("dedups identical delivery ids and leaves state unchanged", () => {
    const recovery = new GitHubRecoveryState();
    const event = makeIssueEvent();

    const first = recovery.ingestEvent(event, makeContext("d1", "2026-04-26T12:00:00Z"));
    const second = recovery.ingestEvent(event, makeContext("d1", "2026-04-26T12:00:00Z"));

    assert.equal(first.updated, true);
    assert.equal(second.updated, false);
    assert.equal(second.skippedReason, "duplicate_delivery");

    const stats = recovery.getReplayStats();
    assert.equal(stats.duplicateDeliveries, 1);
    assert.equal(stats.totalEvents, 1);
    const state = recovery.getIssueState(repo, 7);
    assert.ok(state);
    assert.equal(state!.lastSeq, 1);
  });

  it("replaying the same logical event under different delivery ids yields the same bucket", () => {
    const recovery = new GitHubRecoveryState();

    const a = recovery.ingestEvent(
      makeIssueEvent(),
      makeContext("a", "2026-04-26T12:00:00Z"),
    );
    const b = recovery.ingestEvent(
      makeIssueEvent(),
      makeContext("b", "2026-04-26T12:00:01Z"),
    );

    assert.equal(a.recoveryBucket, b.recoveryBucket);
    assert.equal(b.recoveryBucket, "blocked");
  });
});

// ---------------------------------------------------------------------------
// Out-of-order replay
// ---------------------------------------------------------------------------

describe("GitHubRecoveryState — out-of-order replay", () => {
  it("skips events older than the per-pair watermark and reports reconciled", () => {
    const recovery = new GitHubRecoveryState();

    // Newer PR open arrives first.
    recovery.ingestEvent(
      makePullRequestEvent(),
      makeContext("d-new", "2026-04-26T12:05:00Z"),
    );
    // Older PR sync arrives second — should be skipped as stale.
    const stale = recovery.ingestEvent(
      makePullRequestEvent({ action: "synchronize" }),
      makeContext("d-old", "2026-04-26T12:00:00Z"),
    );

    assert.equal(stale.updated, false);
    assert.equal(stale.reconciled, true);
    assert.equal(stale.skippedReason, "stale_event");

    const stats = recovery.getReplayStats();
    assert.equal(stats.staleSkipped, 1);
    assert.equal(stats.reconciled, 1);
  });

  it("reconciles out-of-order check_run events for the same check name", () => {
    const recovery = new GitHubRecoveryState();
    recovery.ingestEvent(
      makePullRequestEvent(),
      makeContext("d-pr", "2026-04-26T12:00:00Z"),
    );

    // Latest event (success) arrives first.
    recovery.ingestEvent(
      makeCheckRunEvent({
        checkRun: {
          name: "ci/build",
          status: "completed",
          conclusion: "success",
          headSha: "deadbeef",
        },
      }),
      makeContext("d-ck-new", "2026-04-26T12:10:00Z"),
    );
    // Older event for the SAME check name (queued/pending) arrives — must
    // not overwrite the newer success conclusion.
    const stale = recovery.ingestEvent(
      makeCheckRunEvent({
        action: "created",
        checkRun: {
          name: "ci/build",
          status: "in_progress",
          headSha: "deadbeef",
        },
      }),
      makeContext("d-ck-old", "2026-04-26T12:05:00Z"),
    );

    assert.equal(stale.updated, false);
    assert.equal(stale.reconciled, true);

    const state = recovery.getIssueState(repo, 42);
    assert.ok(state);
    assert.equal(state!.checkStatus, "passing");
  });
});

// ---------------------------------------------------------------------------
// Bucket: PR pending → green
// ---------------------------------------------------------------------------

describe("GitHubRecoveryState — PR check progression", () => {
  it("transitions a PR from pending checks to ready_to_review on green", () => {
    const recovery = new GitHubRecoveryState();
    recovery.ingestEvent(
      makePullRequestEvent(),
      makeContext("d-open", "2026-04-26T12:00:00Z"),
    );

    // Pending check.
    const pending = recovery.ingestEvent(
      makeCheckRunEvent({
        action: "created",
        checkRun: {
          name: "ci/build",
          status: "in_progress",
          headSha: "deadbeef",
        },
      }),
      makeContext("d-ck-p", "2026-04-26T12:01:00Z"),
    );
    assert.equal(pending.recoveryBucket, "blocked");

    // Green check.
    const green = recovery.ingestEvent(
      makeCheckRunEvent({
        checkRun: {
          name: "ci/build",
          status: "completed",
          conclusion: "success",
          headSha: "deadbeef",
        },
      }),
      makeContext("d-ck-g", "2026-04-26T12:02:00Z"),
    );
    assert.equal(green.previousBucket, "blocked");
    assert.equal(green.recoveryBucket, "ready_to_review");

    // Replaying the green event under a fresh delivery id (different
    // X-GitHub-Delivery, same logical content, same timestamp) is benign:
    // it refreshes the per-check entry but the bucket stays put.
    const replay = recovery.ingestEvent(
      makeCheckRunEvent({
        checkRun: {
          name: "ci/build",
          status: "completed",
          conclusion: "success",
          headSha: "deadbeef",
        },
      }),
      makeContext("d-ck-g2", "2026-04-26T12:03:00Z"),
    );
    assert.equal(replay.recoveryBucket, "ready_to_review");
    assert.equal(replay.previousBucket, "ready_to_review");

    const state = recovery.getIssueState(repo, 42);
    assert.equal(state!.checkStatus, "passing");
    assert.equal(Object.keys(state!.checks).length, 1);
  });

  it("aggregates multiple checks: failing if any one fails", () => {
    const recovery = new GitHubRecoveryState();
    recovery.ingestEvent(
      makePullRequestEvent(),
      makeContext("d-open", "2026-04-26T12:00:00Z"),
    );

    recovery.ingestEvent(
      makeCheckRunEvent({
        checkRun: {
          name: "ci/build",
          status: "completed",
          conclusion: "success",
          headSha: "deadbeef",
        },
      }),
      makeContext("d-ck-1", "2026-04-26T12:01:00Z"),
    );
    const failing = recovery.ingestEvent(
      makeCheckRunEvent({
        checkRun: {
          name: "ci/lint",
          status: "completed",
          conclusion: "failure",
          headSha: "deadbeef",
        },
      }),
      makeContext("d-ck-2", "2026-04-26T12:02:00Z"),
    );
    assert.equal(failing.recoveryBucket, "blocked");

    const state = recovery.getIssueState(repo, 42);
    assert.equal(state!.checkStatus, "failing");
  });

  it("resets check entries when the PR head SHA advances", () => {
    const recovery = new GitHubRecoveryState();
    recovery.ingestEvent(
      makePullRequestEvent(),
      makeContext("d-open", "2026-04-26T12:00:00Z"),
    );

    // Old SHA: failing check.
    recovery.ingestEvent(
      makeCheckRunEvent({
        checkRun: {
          name: "ci/lint",
          status: "completed",
          conclusion: "failure",
          headSha: "old-sha",
        },
      }),
      makeContext("d-old", "2026-04-26T12:01:00Z"),
    );
    // New SHA: green check — should wipe the old failing one.
    recovery.ingestEvent(
      makeCheckRunEvent({
        checkRun: {
          name: "ci/lint",
          status: "completed",
          conclusion: "success",
          headSha: "new-sha",
        },
      }),
      makeContext("d-new", "2026-04-26T12:02:00Z"),
    );

    const state = recovery.getIssueState(repo, 42);
    assert.equal(state!.headSha, "new-sha");
    assert.equal(state!.checkStatus, "passing");
    assert.equal(Object.keys(state!.checks).length, 1);
  });
});

// ---------------------------------------------------------------------------
// Issue close → closed bucket
// ---------------------------------------------------------------------------

describe("GitHubRecoveryState — issue lifecycle", () => {
  it("moves an issue to the closed bucket on close", () => {
    const recovery = new GitHubRecoveryState();
    recovery.ingestEvent(
      makeIssueEvent(),
      makeContext("d-open", "2026-04-26T12:00:00Z"),
    );

    const closed = recovery.ingestEvent(
      makeIssueEvent({
        action: "closed",
        issue: makeIssue({ state: "closed" }),
      }),
      makeContext("d-close", "2026-04-26T12:01:00Z"),
    );

    assert.equal(closed.recoveryBucket, "closed");
    assert.equal(closed.previousBucket, "blocked");
    const state = recovery.getIssueState(repo, 7);
    assert.equal(state!.state, "closed");
  });

  it("returns to open bucket on reopen", () => {
    const recovery = new GitHubRecoveryState();
    recovery.ingestEvent(
      makeIssueEvent(),
      makeContext("d-o", "2026-04-26T12:00:00Z"),
    );
    recovery.ingestEvent(
      makeIssueEvent({ action: "closed", issue: makeIssue({ state: "closed" }) }),
      makeContext("d-c", "2026-04-26T12:01:00Z"),
    );
    const reopened = recovery.ingestEvent(
      makeIssueEvent({ action: "reopened", issue: makeIssue({ state: "open" }) }),
      makeContext("d-r", "2026-04-26T12:02:00Z"),
    );

    assert.equal(reopened.previousBucket, "closed");
    assert.equal(reopened.recoveryBucket, "blocked");
  });

  it("treats a merged PR as closed", () => {
    const recovery = new GitHubRecoveryState();
    recovery.ingestEvent(
      makePullRequestEvent(),
      makeContext("d-open", "2026-04-26T12:00:00Z"),
    );

    const merged = recovery.ingestEvent(
      makePullRequestEvent({
        action: "closed",
        pullRequest: makePullRequest({ state: "closed", merged: true }),
      }),
      makeContext("d-merge", "2026-04-26T12:05:00Z"),
    );

    assert.equal(merged.recoveryBucket, "closed");
    const state = recovery.getIssueState(repo, 42);
    assert.equal(state!.state, "merged");
  });
});

// ---------------------------------------------------------------------------
// Task status → recovery bucket
// ---------------------------------------------------------------------------

describe("GitHubRecoveryState — task status integration", () => {
  it("classifies failed task + open PR as needs_retry when checks have not fired yet", () => {
    const recovery = new GitHubRecoveryState();
    recovery.ingestEvent(
      makePullRequestEvent(),
      makeContext("d-open", "2026-04-26T12:00:00Z"),
    );

    const result = recovery.setTaskStatus(repo, 42, "failed", {
      taskId: "gh:acme/platform#42",
      observedAt: "2026-04-26T12:01:00Z",
    });
    assert.equal(result.recoveryBucket, "needs_retry");

    const state = recovery.getIssueState(repo, 42);
    assert.equal(state!.taskStatus, "failed");
    assert.deepEqual(state!.linkedTaskIds, ["gh:acme/platform#42"]);
  });

  it("classifies failed task + open issue as needs_retry", () => {
    const recovery = new GitHubRecoveryState();
    recovery.ingestEvent(
      makeIssueEvent(),
      makeContext("d-open", "2026-04-26T12:00:00Z"),
    );

    const result = recovery.setTaskStatus(repo, 7, "failed", {
      observedAt: "2026-04-26T12:01:00Z",
    });
    assert.equal(result.recoveryBucket, "needs_retry");
  });

  it("failing checks beat task-failed and produce blocked", () => {
    const recovery = new GitHubRecoveryState();
    recovery.ingestEvent(
      makePullRequestEvent(),
      makeContext("d-open", "2026-04-26T12:00:00Z"),
    );
    recovery.setTaskStatus(repo, 42, "failed", {
      observedAt: "2026-04-26T12:01:00Z",
    });
    const failing = recovery.ingestEvent(
      makeCheckRunEvent({
        checkRun: {
          name: "ci/build",
          status: "completed",
          conclusion: "failure",
          headSha: "deadbeef",
        },
      }),
      makeContext("d-ck", "2026-04-26T12:02:00Z"),
    );
    assert.equal(failing.recoveryBucket, "blocked");
  });

  it("creates a placeholder state when setTaskStatus precedes any event", () => {
    const recovery = new GitHubRecoveryState();
    const result = recovery.setTaskStatus(repo, 99, "failed", {
      taskId: "gh:acme/platform#99",
      observedAt: "2026-04-26T12:00:00Z",
    });
    assert.equal(result.recoveryBucket, "needs_retry");
    const state = recovery.getIssueState(repo, 99);
    assert.ok(state);
    assert.equal(state!.kind, "issue");
  });
});

// ---------------------------------------------------------------------------
// Review verdicts
// ---------------------------------------------------------------------------

describe("GitHubRecoveryState — reviews", () => {
  it("PR approved + checks passing → ready_to_merge", () => {
    const recovery = new GitHubRecoveryState();
    recovery.ingestEvent(
      makePullRequestEvent(),
      makeContext("d-open", "2026-04-26T12:00:00Z"),
    );
    recovery.ingestEvent(
      makeCheckRunEvent({
        checkRun: {
          name: "ci/build",
          status: "completed",
          conclusion: "success",
          headSha: "deadbeef",
        },
      }),
      makeContext("d-ck", "2026-04-26T12:01:00Z"),
    );
    const review = recovery.ingestEvent(
      makeReviewEvent(),
      makeContext("d-rv", "2026-04-26T12:02:00Z"),
    );

    assert.equal(review.previousBucket, "ready_to_review");
    assert.equal(review.recoveryBucket, "ready_to_merge");
  });

  it("changes_requested moves the bucket to blocked even with green checks", () => {
    const recovery = new GitHubRecoveryState();
    recovery.ingestEvent(
      makePullRequestEvent(),
      makeContext("d-open", "2026-04-26T12:00:00Z"),
    );
    recovery.ingestEvent(
      makeCheckRunEvent({
        checkRun: {
          name: "ci/build",
          status: "completed",
          conclusion: "success",
          headSha: "deadbeef",
        },
      }),
      makeContext("d-ck", "2026-04-26T12:01:00Z"),
    );
    const review = recovery.ingestEvent(
      makeReviewEvent({ reviewState: "changes_requested" }),
      makeContext("d-rv", "2026-04-26T12:02:00Z"),
    );

    assert.equal(review.recoveryBucket, "blocked");
    const state = recovery.getIssueState(repo, 42);
    assert.equal(state!.reviewStatus, "changes_requested");
  });

  it("dismissed review clears the verdict back to none", () => {
    const recovery = new GitHubRecoveryState();
    recovery.ingestEvent(
      makePullRequestEvent(),
      makeContext("d-open", "2026-04-26T12:00:00Z"),
    );
    recovery.ingestEvent(
      makeCheckRunEvent({
        checkRun: {
          name: "ci/build",
          status: "completed",
          conclusion: "success",
          headSha: "deadbeef",
        },
      }),
      makeContext("d-ck", "2026-04-26T12:01:00Z"),
    );
    recovery.ingestEvent(
      makeReviewEvent({ reviewState: "approved" }),
      makeContext("d-rv1", "2026-04-26T12:02:00Z"),
    );
    const dismissed = recovery.ingestEvent(
      makeReviewEvent({ action: "dismissed", reviewState: "dismissed" }),
      makeContext("d-rv2", "2026-04-26T12:03:00Z"),
    );

    assert.equal(dismissed.recoveryBucket, "ready_to_review");
    const state = recovery.getIssueState(repo, 42);
    assert.equal(state!.reviewStatus, "none");
  });

  it("commented reviews leave the verdict alone", () => {
    const recovery = new GitHubRecoveryState();
    recovery.ingestEvent(
      makePullRequestEvent(),
      makeContext("d-open", "2026-04-26T12:00:00Z"),
    );
    recovery.ingestEvent(
      makeReviewEvent({ reviewState: "approved" }),
      makeContext("d-rv1", "2026-04-26T12:01:00Z"),
    );
    recovery.ingestEvent(
      makeReviewEvent({ reviewState: "commented" }),
      makeContext("d-rv2", "2026-04-26T12:02:00Z"),
    );

    const state = recovery.getIssueState(repo, 42);
    assert.equal(state!.reviewStatus, "approved");
  });
});

// ---------------------------------------------------------------------------
// Bucket queries
// ---------------------------------------------------------------------------

describe("GitHubRecoveryState — bucket queries", () => {
  it("getBucketIssues returns matching items in numeric order", () => {
    const recovery = new GitHubRecoveryState();

    // Two open issues → blocked bucket.
    recovery.ingestEvent(
      makeIssueEvent({ issue: makeIssue({ number: 9 }) }),
      makeContext("d-9", "2026-04-26T12:00:00Z"),
    );
    recovery.ingestEvent(
      makeIssueEvent({ issue: makeIssue({ number: 3 }) }),
      makeContext("d-3", "2026-04-26T12:00:01Z"),
    );
    // One closed issue.
    recovery.ingestEvent(
      makeIssueEvent({
        action: "closed",
        issue: makeIssue({ number: 5, state: "closed" }),
      }),
      makeContext("d-5", "2026-04-26T12:00:02Z"),
    );

    const blocked = recovery.getBucketIssues(repo, "blocked");
    assert.deepEqual(blocked.map((s) => s.issueNumber), [3, 9]);

    const closed = recovery.getBucketIssues(repo, "closed");
    assert.deepEqual(closed.map((s) => s.issueNumber), [5]);
  });

  it("getAllBuckets reports counts across the repo", () => {
    const recovery = new GitHubRecoveryState();
    recovery.ingestEvent(
      makeIssueEvent({ issue: makeIssue({ number: 1 }) }),
      makeContext("d-1", "2026-04-26T12:00:00Z"),
    );
    recovery.ingestEvent(
      makeIssueEvent({
        action: "closed",
        issue: makeIssue({ number: 2, state: "closed" }),
      }),
      makeContext("d-2", "2026-04-26T12:00:01Z"),
    );
    recovery.ingestEvent(
      makePullRequestEvent({ pullRequest: makePullRequest({ number: 3 }) }),
      makeContext("d-3", "2026-04-26T12:00:02Z"),
    );
    recovery.ingestEvent(
      makeCheckRunEvent({
        issueNumber: 3,
        checkRun: {
          name: "ci/build",
          status: "completed",
          conclusion: "success",
          headSha: "abc",
        },
      }),
      makeContext("d-3-ck", "2026-04-26T12:00:03Z"),
    );

    const counts = recovery.getAllBuckets(repo);
    assert.equal(counts.blocked, 1); // open issue
    assert.equal(counts.closed, 1); // closed issue
    assert.equal(counts.ready_to_review, 1); // PR with green checks
    assert.equal(counts.ready_to_merge, 0);
    assert.equal(counts.needs_retry, 0);
  });

  it("scopes results to the supplied repo", () => {
    const recovery = new GitHubRecoveryState();
    const otherRepo: GitHubRepoRef = {
      owner: "other",
      name: "thing",
      fullName: "other/thing",
    };
    recovery.ingestEvent(
      makeIssueEvent(),
      makeContext("d-a", "2026-04-26T12:00:00Z"),
    );
    recovery.ingestEvent(
      makeIssueEvent({ repo: otherRepo, issue: makeIssue({ number: 1 }) }),
      makeContext("d-b", "2026-04-26T12:00:01Z"),
    );

    assert.equal(recovery.getBucketIssues(repo, "blocked").length, 1);
    assert.equal(recovery.getBucketIssues(otherRepo, "blocked").length, 1);
  });
});

// ---------------------------------------------------------------------------
// Deferred / unsupported event handling
// ---------------------------------------------------------------------------

describe("GitHubRecoveryState — deferred events", () => {
  it("counts unknown event kinds as deferred without throwing", () => {
    const recovery = new GitHubRecoveryState();
    const result = recovery.ingestEvent(
      // Cast to bypass the discriminated union — deferred-event handling
      // is the explicit code path under test.
      { kind: "workflow_run" } as unknown as GitHubIssueEvent,
      makeContext("d-wf", "2026-04-26T12:00:00Z"),
    );
    assert.equal(result.updated, false);
    assert.equal(result.skippedReason, "deferred_event");

    const stats = recovery.getReplayStats();
    assert.equal(stats.deferredKinds["workflow_run"], 1);
  });
});

// ---------------------------------------------------------------------------
// Replay stats
// ---------------------------------------------------------------------------

describe("GitHubRecoveryState — replay stats", () => {
  it("reports trackedIssues, totalEvents, dedup, and stale-skip counts", () => {
    const recovery = new GitHubRecoveryState();

    recovery.ingestEvent(
      makeIssueEvent({ issue: makeIssue({ number: 1 }) }),
      makeContext("d1", "2026-04-26T12:00:00Z"),
    );
    recovery.ingestEvent(
      makeIssueEvent({ issue: makeIssue({ number: 2 }) }),
      makeContext("d2", "2026-04-26T12:00:01Z"),
    );
    // Duplicate delivery.
    recovery.ingestEvent(
      makeIssueEvent({ issue: makeIssue({ number: 1 }) }),
      makeContext("d1", "2026-04-26T12:00:00Z"),
    );
    // Stale event for issue #1.
    recovery.ingestEvent(
      makeIssueEvent({ issue: makeIssue({ number: 1 }) }),
      makeContext("d-stale", "2026-04-25T00:00:00Z"),
    );

    const stats = recovery.getReplayStats();
    assert.equal(stats.trackedIssues, 2);
    assert.equal(stats.totalEvents, 2);
    assert.equal(stats.duplicateDeliveries, 1);
    assert.equal(stats.staleSkipped, 1);
    assert.equal(stats.reconciled, 1);
  });
});
