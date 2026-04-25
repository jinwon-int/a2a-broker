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

function makeContext(deliveryId: string): GitHubDeliveryContext {
  return {
    deliveryId,
    receivedAt: "2026-04-26T12:00:01Z",
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
