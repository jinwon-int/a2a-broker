import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { InMemoryA2ABroker } from "../core/broker.js";
import {
  GitHubIngestionService,
  parseAssignmentIntents,
} from "./ingestion.js";
import type {
  GitHubDeliveryContext,
  GitHubIssueCommentEvent,
  GitHubIssueEvent,
  GitHubIssueRef,
  GitHubPullRequestEvent,
  GitHubPullRequestRef,
  GitHubRepoRef,
  GitHubUserRef,
} from "./types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function registerWorker(broker: InMemoryA2ABroker, nodeId: string): void {
  broker.registerWorker({
    nodeId,
    role: "analyst",
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: false,
      canPromoteLive: false,
      workspaceIds: ["test"],
      environments: ["research"],
    },
  });
}

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
    body: "Investigate the stale lease behavior; flaky in CI.",
    htmlUrl: "https://github.com/acme/platform/issues/7",
    state: "open",
    user: sender,
    labels: ["bug"],
    ...overrides,
  };
}

function makeIssueEvent(overrides: Partial<GitHubIssueEvent> = {}): GitHubIssueEvent {
  return {
    kind: "issues",
    action: "opened",
    repo,
    issue: makeIssue(),
    sender,
    ...overrides,
  };
}

function makeCommentEvent(
  body: string,
  overrides: Partial<GitHubIssueCommentEvent> = {},
): GitHubIssueCommentEvent {
  return {
    kind: "issue_comment",
    action: "created",
    repo,
    issue: makeIssue(),
    comment: {
      id: 1234,
      body,
      htmlUrl: "https://github.com/acme/platform/issues/7#issuecomment-1234",
      user: sender,
      createdAt: "2026-04-26T12:00:00Z",
    },
    sender,
    ...overrides,
  };
}

function makeContext(
  deliveryId: string,
  receivedAt: string = "2026-04-26T12:00:01Z",
): GitHubDeliveryContext {
  return {
    deliveryId,
    receivedAt,
  };
}

function makePullRequest(
  overrides: Partial<GitHubPullRequestRef> = {},
): GitHubPullRequestRef {
  return {
    number: 42,
    title: "Fix the lease bug",
    body: "Closes #7. /a2a assign worker-a --work-mode github",
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

// ---------------------------------------------------------------------------
// parseAssignmentIntents
// ---------------------------------------------------------------------------

describe("parseAssignmentIntents", () => {
  it("returns an empty array when no command is present", () => {
    assert.deepEqual(parseAssignmentIntents("just a normal comment"), []);
    assert.deepEqual(parseAssignmentIntents(""), []);
    assert.deepEqual(parseAssignmentIntents(undefined as unknown as string), []);
  });

  it("parses a basic /a2a assign command with a target node id", () => {
    const intents = parseAssignmentIntents(
      "/a2a assign worker-a --work-mode github",
    );
    assert.equal(intents.length, 1);
    assert.equal(intents[0]!.target, "worker-a");
    assert.equal(intents[0]!.workMode, "github");
  });

  it("defaults workMode to github when not specified", () => {
    const intents = parseAssignmentIntents("/a2a assign worker-a");
    assert.equal(intents.length, 1);
    assert.equal(intents[0]!.workMode, "github");
  });

  it("parses an explicit --intent flag", () => {
    const intents = parseAssignmentIntents(
      "/a2a assign worker-a --work-mode github --intent analyze",
    );
    assert.equal(intents[0]!.intent, "analyze");
  });

  it("rejects an unknown intent value", () => {
    const intents = parseAssignmentIntents(
      "/a2a assign worker-a --intent not-a-real-intent",
    );
    assert.equal(intents.length, 1);
    assert.equal(intents[0]!.intent, undefined);
  });

  it("captures the trailing message after a `--` separator", () => {
    const intents = parseAssignmentIntents(
      "/a2a assign worker-a --work-mode github -- look at the queue depth issue",
    );
    assert.equal(intents[0]!.message, "look at the queue depth issue");
  });

  it("supports multiple commands in one body", () => {
    const intents = parseAssignmentIntents(
      [
        "Hi team!",
        "/a2a assign worker-a --work-mode github",
        "and",
        "/a2a assign worker-b --intent analyze -- look at PR build",
      ].join("\n"),
    );
    assert.equal(intents.length, 2);
    assert.equal(intents[0]!.target, "worker-a");
    assert.equal(intents[1]!.target, "worker-b");
    assert.equal(intents[1]!.intent, "analyze");
    assert.equal(intents[1]!.message, "look at PR build");
  });

  it("ignores commands missing a target", () => {
    const intents = parseAssignmentIntents("/a2a assign --work-mode github");
    assert.deepEqual(intents, []);
  });
});

// ---------------------------------------------------------------------------
// GitHubIngestionService
// ---------------------------------------------------------------------------

describe("GitHubIngestionService", () => {
  it("creates a parent task from an issue body containing /a2a assign", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker, "worker-a");
    const ingestion = new GitHubIngestionService({ broker });

    const issue = makeIssue({
      body: "Need help here.\n/a2a assign worker-a --work-mode github -- review this",
    });
    const result = ingestion.ingest(makeIssueEvent({ issue }), makeContext("d1"));

    assert.equal(result.deduped, false);
    assert.ok(result.parentTaskId);
    const parent = broker.getTask(result.parentTaskId!);
    assert.ok(parent);
    assert.equal(parent.targetNodeId, "worker-a");
    assert.equal(parent.assignedWorkerId, "worker-a");
    assert.equal(parent.payload.githubDeliveryId, "d1");
    assert.equal(parent.payload.githubRepo, "acme/platform");
    assert.equal(parent.payload.githubIssueNumber, 7);
    assert.equal(parent.payload.githubWorkMode, "github");
    assert.equal(parent.message, "review this");
  });

  it("returns deduped=true when the same delivery id is replayed", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker, "worker-a");
    const ingestion = new GitHubIngestionService({ broker });

    const issue = makeIssue({
      body: "/a2a assign worker-a --work-mode github",
    });
    const event = makeIssueEvent({ issue });

    const first = ingestion.ingest(event, makeContext("d1"));
    const second = ingestion.ingest(event, makeContext("d1"));

    assert.equal(first.deduped, false);
    assert.equal(second.deduped, true);
    assert.equal(broker.listTasks({}).length, 1);
  });

  it("does not create duplicate parent tasks across distinct deliveries for the same issue", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker, "worker-a");
    const ingestion = new GitHubIngestionService({ broker });

    const issue = makeIssue({
      body: "/a2a assign worker-a --work-mode github",
    });

    const first = ingestion.ingest(
      makeIssueEvent({ issue, action: "opened" }),
      makeContext("d1"),
    );
    const second = ingestion.ingest(
      makeIssueEvent({ issue, action: "edited" }),
      makeContext("d2"),
    );

    assert.equal(first.parentTaskId, second.parentTaskId);
    assert.equal(broker.listTasks({}).length, 1);
  });

  it("creates a child task on a comment-driven assignment, parented to the issue task", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker, "worker-a");
    registerWorker(broker, "worker-b");
    const ingestion = new GitHubIngestionService({ broker });

    const issueResult = ingestion.ingest(
      makeIssueEvent({
        issue: makeIssue({
          body: "/a2a assign worker-a --work-mode github",
        }),
      }),
      makeContext("d1"),
    );
    assert.ok(issueResult.parentTaskId);

    const commentResult = ingestion.ingest(
      makeCommentEvent(
        "Follow up: /a2a assign worker-b --work-mode github --intent analyze",
      ),
      makeContext("d2"),
    );

    assert.equal(commentResult.deduped, false);
    assert.equal(commentResult.childTaskIds.length, 1);
    const child = broker.getTask(commentResult.childTaskIds[0]!);
    assert.ok(child);
    assert.equal(child.parentTaskId, issueResult.parentTaskId);
    assert.equal(child.assignedWorkerId, "worker-b");
    assert.equal(child.intent, "analyze");
    assert.equal(child.payload.githubCommentId, 1234);
  });

  it("synthesizes a parent task when the first command appears in a comment, not the issue body", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker, "worker-a");
    const ingestion = new GitHubIngestionService({ broker });

    const result = ingestion.ingest(
      makeCommentEvent("/a2a assign worker-a --work-mode github -- triage"),
      makeContext("d1"),
    );

    assert.equal(result.deduped, false);
    assert.ok(result.parentTaskId);
    assert.equal(result.childTaskIds.length, 1);
    const parent = broker.getTask(result.parentTaskId!);
    const child = broker.getTask(result.childTaskIds[0]!);
    assert.ok(parent);
    assert.ok(child);
    assert.equal(child.parentTaskId, parent.id);
  });

  it("ignores a comment with no /a2a command", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker, "worker-a");
    const ingestion = new GitHubIngestionService({ broker });

    const result = ingestion.ingest(
      makeCommentEvent("just a normal status update"),
      makeContext("d1"),
    );

    assert.equal(result.deduped, false);
    assert.equal(result.parentTaskId, undefined);
    assert.deepEqual(result.childTaskIds, []);
    assert.equal(broker.listTasks({}).length, 0);
  });

  it("skips assignment to an unregistered worker without throwing", () => {
    const broker = new InMemoryA2ABroker();
    const ingestion = new GitHubIngestionService({ broker });

    const result = ingestion.ingest(
      makeIssueEvent({
        issue: makeIssue({
          body: "/a2a assign ghost-worker --work-mode github",
        }),
      }),
      makeContext("d1"),
    );

    assert.equal(result.parentTaskId, undefined);
    assert.equal(result.skippedReason, "unknown_worker");
    assert.equal(broker.listTasks({}).length, 0);
  });

  it("creates one task per command when the body contains multiple assignments", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker, "worker-a");
    registerWorker(broker, "worker-b");
    const ingestion = new GitHubIngestionService({ broker });

    const result = ingestion.ingest(
      makeIssueEvent({
        issue: makeIssue({
          body: [
            "/a2a assign worker-a --work-mode github",
            "/a2a assign worker-b --work-mode github --intent analyze",
          ].join("\n"),
        }),
      }),
      makeContext("d1"),
    );

    assert.ok(result.parentTaskId);
    assert.equal(result.childTaskIds.length, 1);
    assert.equal(broker.listTasks({}).length, 2);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle ingestion + replay durability
// ---------------------------------------------------------------------------

function seedParentTask(
  broker: InMemoryA2ABroker,
  ingestion: GitHubIngestionService,
  workerId = "worker-a",
  receivedAt = "2026-04-26T12:00:00Z",
): { parentTaskId: string } {
  registerWorker(broker, workerId);
  const result = ingestion.ingest(
    makeIssueEvent({
      issue: makeIssue({
        body: `/a2a assign ${workerId} --work-mode github`,
      }),
    }),
    makeContext("seed", receivedAt),
  );
  if (!result.parentTaskId) throw new Error("seed task not created");
  return { parentTaskId: result.parentTaskId };
}

describe("GitHubIngestionService — lifecycle handling", () => {
  it("cancels the parent task when an issue is closed", () => {
    const broker = new InMemoryA2ABroker();
    const ingestion = new GitHubIngestionService({ broker });
    const { parentTaskId } = seedParentTask(broker, ingestion);

    const result = ingestion.ingest(
      makeIssueEvent({ action: "closed" }),
      makeContext("d-close", "2026-04-26T12:01:00Z"),
    );

    assert.equal(result.skippedReason, undefined);
    assert.ok(result.lifecycleTransition);
    assert.equal(result.lifecycleTransition!.from, "queued");
    assert.equal(result.lifecycleTransition!.to, "canceled");
    assert.equal(result.lifecycleTransition!.reconciled, false);
    assert.equal(broker.getTask(parentTaskId)!.status, "canceled");
  });

  it("does not error when the same issue is closed twice", () => {
    const broker = new InMemoryA2ABroker();
    const ingestion = new GitHubIngestionService({ broker });
    const { parentTaskId } = seedParentTask(broker, ingestion);

    const first = ingestion.ingest(
      makeIssueEvent({ action: "closed" }),
      makeContext("d-close-1", "2026-04-26T12:01:00Z"),
    );
    const second = ingestion.ingest(
      makeIssueEvent({ action: "closed" }),
      makeContext("d-close-2", "2026-04-26T12:02:00Z"),
    );

    assert.equal(first.lifecycleTransition!.to, "canceled");
    assert.equal(first.lifecycleTransition!.reconciled, false);
    assert.equal(second.lifecycleTransition!.from, "canceled");
    assert.equal(second.lifecycleTransition!.to, "canceled");
    assert.equal(second.lifecycleTransition!.reconciled, false);
    assert.equal(second.skippedReason, undefined);
    assert.equal(broker.getTask(parentTaskId)!.status, "canceled");
  });

  it("cancels even when no /a2a command is present in the issue body", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker, "worker-a");
    const ingestion = new GitHubIngestionService({ broker });

    // Seed a parent task via ingestion (with /a2a command).
    const seed = ingestion.ingest(
      makeIssueEvent({
        issue: makeIssue({
          body: "/a2a assign worker-a --work-mode github",
        }),
      }),
      makeContext("seed", "2026-04-26T12:00:00Z"),
    );
    const parentTaskId = seed.parentTaskId!;

    // Now close the issue with a body that does NOT carry the command.
    const result = ingestion.handleIssueClosed(
      repo,
      makeIssue({ body: "no command here", state: "closed" }),
      makeContext("d-close", "2026-04-26T12:01:00Z"),
    );

    assert.equal(result.parentTaskId, parentTaskId);
    assert.equal(result.lifecycleTransition!.to, "canceled");
    assert.equal(broker.getTask(parentTaskId)!.status, "canceled");
  });

  it("surfaces reconciliation_needed when reopening a canceled task", () => {
    const broker = new InMemoryA2ABroker();
    const ingestion = new GitHubIngestionService({ broker });
    const { parentTaskId } = seedParentTask(broker, ingestion);

    ingestion.ingest(
      makeIssueEvent({ action: "closed" }),
      makeContext("d-close", "2026-04-26T12:01:00Z"),
    );
    const reopened = ingestion.ingest(
      makeIssueEvent({ action: "reopened", issue: makeIssue({ state: "open" }) }),
      makeContext("d-reopen", "2026-04-26T12:02:00Z"),
    );

    assert.equal(reopened.skippedReason, "reconciliation_needed");
    assert.ok(reopened.lifecycleTransition);
    assert.equal(reopened.lifecycleTransition!.from, "canceled");
    assert.equal(reopened.lifecycleTransition!.to, "queued");
    assert.equal(reopened.lifecycleTransition!.reconciled, true);
    // Broker state is unchanged — reconciliation is a downstream concern.
    assert.equal(broker.getTask(parentTaskId)!.status, "canceled");
  });

  it("treats reopened on a still-queued task as a benign no-op", () => {
    const broker = new InMemoryA2ABroker();
    const ingestion = new GitHubIngestionService({ broker });
    const { parentTaskId } = seedParentTask(broker, ingestion);

    const result = ingestion.ingest(
      makeIssueEvent({ action: "reopened" }),
      makeContext("d-reopen", "2026-04-26T12:01:00Z"),
    );

    assert.equal(result.skippedReason, undefined);
    assert.ok(result.lifecycleTransition);
    assert.equal(result.lifecycleTransition!.from, "queued");
    assert.equal(result.lifecycleTransition!.to, "queued");
    assert.equal(result.lifecycleTransition!.reconciled, false);
    assert.equal(broker.getTask(parentTaskId)!.status, "queued");
  });

  it("completes the task with PR metadata when a PR is merged from claimed state", () => {
    const broker = new InMemoryA2ABroker();
    const ingestion = new GitHubIngestionService({ broker });
    registerWorker(broker, "worker-a");

    // Seed a parent task tied to PR number 42.
    ingestion.ingest(
      makePullRequestEvent({
        action: "opened",
        pullRequest: makePullRequest({
          body: "/a2a assign worker-a --work-mode github",
        }),
      }),
      makeContext("d-pr-open", "2026-04-26T12:00:00Z"),
    );
    const taskId = `gh:acme/platform#42`;
    broker.claimTask(taskId, "worker-a");

    const merged = ingestion.ingest(
      makePullRequestEvent({
        action: "closed",
        pullRequest: makePullRequest({ merged: true }),
      }),
      makeContext("d-pr-merged", "2026-04-26T12:05:00Z"),
    );

    assert.equal(merged.skippedReason, undefined);
    assert.equal(merged.lifecycleTransition!.from, "claimed");
    assert.equal(merged.lifecycleTransition!.to, "succeeded");
    assert.equal(merged.lifecycleTransition!.reconciled, false);
    const task = broker.getTask(taskId)!;
    assert.equal(task.status, "succeeded");
    assert.equal(task.result?.output?.pullRequestUrl, "https://github.com/acme/platform/pull/42");
    assert.equal(task.result?.output?.merged, true);
  });

  it("ingesting the same PR merge twice produces a single transition", () => {
    const broker = new InMemoryA2ABroker();
    const ingestion = new GitHubIngestionService({ broker });
    registerWorker(broker, "worker-a");

    ingestion.ingest(
      makePullRequestEvent({
        action: "opened",
        pullRequest: makePullRequest({
          body: "/a2a assign worker-a --work-mode github",
        }),
      }),
      makeContext("d-pr-open", "2026-04-26T12:00:00Z"),
    );
    const taskId = `gh:acme/platform#42`;
    broker.claimTask(taskId, "worker-a");

    const first = ingestion.ingest(
      makePullRequestEvent({
        action: "closed",
        pullRequest: makePullRequest({ merged: true }),
      }),
      makeContext("d-pr-m1", "2026-04-26T12:05:00Z"),
    );
    const second = ingestion.ingest(
      makePullRequestEvent({
        action: "closed",
        pullRequest: makePullRequest({ merged: true }),
      }),
      makeContext("d-pr-m2", "2026-04-26T12:06:00Z"),
    );

    assert.equal(first.lifecycleTransition!.to, "succeeded");
    assert.equal(first.lifecycleTransition!.reconciled, false);
    // Second merge sees an already-succeeded task at the requested status.
    assert.equal(second.lifecycleTransition!.from, "succeeded");
    assert.equal(second.lifecycleTransition!.to, "succeeded");
    assert.equal(second.lifecycleTransition!.reconciled, false);
    assert.equal(broker.getTask(taskId)!.status, "succeeded");
  });

  it("cancels the task when a PR is closed without merge", () => {
    const broker = new InMemoryA2ABroker();
    const ingestion = new GitHubIngestionService({ broker });
    registerWorker(broker, "worker-a");

    ingestion.ingest(
      makePullRequestEvent({
        action: "opened",
        pullRequest: makePullRequest({
          body: "/a2a assign worker-a --work-mode github",
        }),
      }),
      makeContext("d-pr-open", "2026-04-26T12:00:00Z"),
    );

    const closed = ingestion.ingest(
      makePullRequestEvent({
        action: "closed",
        pullRequest: makePullRequest({ merged: false }),
      }),
      makeContext("d-pr-close", "2026-04-26T12:05:00Z"),
    );

    assert.equal(closed.lifecycleTransition!.to, "canceled");
    assert.equal(broker.getTask("gh:acme/platform#42")!.status, "canceled");
  });
});

// ---------------------------------------------------------------------------
// Replay protection: dedup, sequence, watermark, out-of-order
// ---------------------------------------------------------------------------

describe("GitHubIngestionService — replay protection", () => {
  it("collapses duplicate comment bodies arriving via different delivery ids", () => {
    const broker = new InMemoryA2ABroker();
    const ingestion = new GitHubIngestionService({ broker });
    registerWorker(broker, "worker-a");

    const body = "/a2a assign worker-a --work-mode github -- triage";
    const first = ingestion.ingest(
      makeCommentEvent(body),
      makeContext("d-c1", "2026-04-26T12:00:00Z"),
    );
    const second = ingestion.ingest(
      makeCommentEvent(body),
      makeContext("d-c2", "2026-04-26T12:00:01Z"),
    );

    assert.ok(first.parentTaskId);
    assert.equal(first.childTaskIds.length, 1);
    // Different delivery ids both pass dedup, but deterministic task ids
    // collapse onto the same broker tasks: still exactly 2 tasks total.
    assert.equal(second.parentTaskId, first.parentTaskId);
    assert.deepEqual(second.childTaskIds, first.childTaskIds);
    assert.equal(broker.listTasks({}).length, 2);
  });

  it("skips events older than the recorded watermark (out-of-order)", () => {
    const broker = new InMemoryA2ABroker();
    const ingestion = new GitHubIngestionService({ broker });
    seedParentTask(broker, ingestion, "worker-a", "2026-04-26T12:00:00Z");

    // Newer lifecycle event arrives first.
    const newer = ingestion.ingest(
      makeIssueEvent({ action: "closed" }),
      makeContext("d-newer", "2026-04-26T12:05:00Z"),
    );
    // An older lifecycle event then arrives — must be skipped as stale.
    const older = ingestion.ingest(
      makeIssueEvent({ action: "reopened" }),
      makeContext("d-older", "2026-04-26T12:02:00Z"),
    );

    assert.equal(newer.lifecycleTransition!.to, "canceled");
    assert.equal(newer.replaySkipped, false);

    assert.equal(older.replaySkipped, true);
    assert.equal(older.skippedReason, "stale_lifecycle");
    assert.equal(older.lifecycleTransition, null);
    // Broker state still reflects the newer event only.
    assert.equal(
      broker.getTask("gh:acme/platform#7")!.status,
      "canceled",
    );
  });

  it("processes closed → reopened in correct order without skipping", () => {
    const broker = new InMemoryA2ABroker();
    const ingestion = new GitHubIngestionService({ broker });
    const { parentTaskId } = seedParentTask(broker, ingestion);

    const closed = ingestion.ingest(
      makeIssueEvent({ action: "closed" }),
      makeContext("d-c", "2026-04-26T12:01:00Z"),
    );
    const reopened = ingestion.ingest(
      makeIssueEvent({ action: "reopened" }),
      makeContext("d-r", "2026-04-26T12:02:00Z"),
    );

    assert.equal(closed.lifecycleTransition!.to, "canceled");
    assert.equal(closed.replaySkipped, false);
    // Reopen is non-stale (newer than close watermark) but the broker
    // can't promote a canceled task back to queued — surfaces as
    // reconciliation_needed.
    assert.equal(reopened.replaySkipped, false);
    assert.equal(reopened.skippedReason, "reconciliation_needed");
    assert.equal(reopened.lifecycleTransition!.from, "canceled");
    assert.equal(reopened.lifecycleTransition!.to, "queued");
    assert.equal(reopened.lifecycleTransition!.reconciled, true);
    // Broker still canceled — operator must reconcile.
    assert.equal(broker.getTask(parentTaskId)!.status, "canceled");
  });

  it("getReplayStats returns accurate counts across delivery dedup, accept, and stale skip", () => {
    const broker = new InMemoryA2ABroker();
    const ingestion = new GitHubIngestionService({ broker });
    seedParentTask(broker, ingestion, "worker-a", "2026-04-26T12:00:00Z");

    // Replay the seed delivery — caught by seenDeliveries.
    ingestion.ingest(
      makeIssueEvent({
        issue: makeIssue({
          body: "/a2a assign worker-a --work-mode github",
        }),
      }),
      makeContext("seed", "2026-04-26T12:00:00Z"),
    );
    // A second valid event for the same pair.
    ingestion.ingest(
      makeIssueEvent({ action: "closed" }),
      makeContext("d-close", "2026-04-26T12:05:00Z"),
    );
    // An out-of-order older event — should be dropped as stale.
    ingestion.ingest(
      makeIssueEvent({ action: "reopened" }),
      makeContext("d-stale", "2026-04-26T12:01:00Z"),
    );

    const stats = ingestion.getReplayStats();
    assert.equal(stats.trackedPairs, 1);
    // Two events accepted: the seed and the close.
    assert.equal(stats.totalEvents, 2);
    // One delivery dedup hit (seed replayed).
    assert.equal(stats.duplicateDeliveries, 1);
    // One stale-skip (out-of-order reopen).
    assert.equal(stats.staleSkipped, 1);
    // The close advanced the lifecycle watermark.
    assert.equal(stats.lifecycleWatermarks, 1);
  });

  it("tracks separate (repo, issue) pairs independently", () => {
    const broker = new InMemoryA2ABroker();
    const ingestion = new GitHubIngestionService({ broker });
    registerWorker(broker, "worker-a");

    ingestion.ingest(
      makeIssueEvent({
        issue: makeIssue({
          number: 7,
          body: "/a2a assign worker-a --work-mode github",
        }),
      }),
      makeContext("d-7", "2026-04-26T12:00:00Z"),
    );
    ingestion.ingest(
      makeIssueEvent({
        issue: makeIssue({
          number: 8,
          body: "/a2a assign worker-a --work-mode github",
        }),
      }),
      makeContext("d-8", "2026-04-26T12:00:01Z"),
    );

    const stats = ingestion.getReplayStats();
    assert.equal(stats.trackedPairs, 2);
    assert.equal(stats.totalEvents, 2);
  });
});
