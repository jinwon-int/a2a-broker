import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  verifyPostDispatchMetadata,
  type PostDispatchMetadataVerification,
} from "./post-dispatch-metadata-verifier.js";
import type { TaskRecord } from "./types.js";

// ---------------------------------------------------------------------------
// Factory helpers for consistent tasks
// ---------------------------------------------------------------------------

function isoNow(): string {
  return new Date().toISOString();
}

function isoPast(msAgo = 60_000): string {
  return new Date(Date.now() - msAgo).toISOString();
}

function isoFuture(msAhead = 60_000): string {
  return new Date(Date.now() + msAhead).toISOString();
}

function buildTask(overrides: Partial<TaskRecord> & { id?: string }): TaskRecord {
  const id = overrides.id ?? randomUUID();
  const now = isoNow();
  return {
    id,
    exchangeId: undefined,
    parentTaskId: undefined,
    referenceTaskIds: undefined,
    intent: "chat",
    requester: { id: "hub-a", kind: "node" as const, role: "hub" as const },
    target: { id: "worker-1", kind: "node" as const, role: "analyst" as const },
    targetNodeId: "worker-1",
    assignedWorkerId: "worker-1",
    workspace: undefined,
    message: "test task",
    proposalId: undefined,
    artifactIds: [],
    via: undefined,
    policyContext: undefined,
    payload: {},
    status: "claimed",
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? isoFuture(),
    claimedAt: overrides.claimedAt ?? now,
    claimedBy: overrides.claimedBy ?? "worker-1",
    attemptId: overrides.attemptId ?? randomUUID(),
    completedAt: undefined,
    result: undefined,
    error: undefined,
    cancellation: undefined,
    approval: undefined,
    approvalOutcome: undefined,
    requeueCount: 0,
    lastHeartbeatAt: undefined,
    taskOrigin: "unknown",
    brokerOfRecord: undefined,
    teamId: undefined,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("verifyPostDispatchMetadata passes for a correctly claimed task", () => {
  const task = buildTask({ id: "task-ok-1" });
  const result = verifyPostDispatchMetadata(task);

  assert.equal(result.taskId, "task-ok-1");
  assert.ok(result.timestamp);
  assert.ok(Array.isArray(result.checks));

  // All checks should pass for a healthy post-dispatch task
  const failed = result.checks.filter((c) => !c.passed);
  assert.equal(
    failed.length,
    0,
    `Expected zero failures but got: ${JSON.stringify(failed, null, 2)}`,
  );
  assert.ok(result.passed);
  assert.equal(result.summary.total, result.summary.passed);
  assert.equal(result.summary.failed, 0);
});

test("verifyPostDispatchMetadata passes with expectedWorkerId match", () => {
  const task = buildTask({ id: "task-expected-1", claimedBy: "worker-x", assignedWorkerId: "worker-x", targetNodeId: "worker-x" });
  const result = verifyPostDispatchMetadata(task, "worker-x");

  assert.ok(result.passed);
  // Should have one extra check (expected-worker-match)
  const matchCheck = result.checks.find((c) => c.name === "expected-worker-match");
  assert.ok(matchCheck);
  assert.ok(matchCheck.passed);
});

test("verifyPostDispatchMetadata fails when expectedWorkerId does not match", () => {
  const task = buildTask({ id: "task-wrong-worker", claimedBy: "worker-a", assignedWorkerId: "worker-a", targetNodeId: "worker-a" });
  const result = verifyPostDispatchMetadata(task, "worker-b");

  assert.ok(!result.passed);
  const matchCheck = result.checks.find((c) => c.name === "expected-worker-match");
  assert.ok(matchCheck);
  assert.ok(!matchCheck.passed);
  assert.ok(matchCheck.message.includes("worker-b"));
});

test("verifyPostDispatchMetadata fails when attemptId is missing", () => {
  const task = buildTask({ id: "task-no-attempt", attemptId: undefined });
  const result = verifyPostDispatchMetadata(task);

  assert.ok(!result.passed);
  const attemptCheck = result.checks.find((c) => c.name === "attempt-id-present");
  assert.ok(attemptCheck);
  assert.ok(!attemptCheck.passed);
});

test("verifyPostDispatchMetadata fails when claimedBy is missing", () => {
  const task = buildTask({ id: "task-no-claimant", claimedBy: undefined });
  const result = verifyPostDispatchMetadata(task);

  assert.ok(!result.passed);
  const claimedByCheck = result.checks.find((c) => c.name === "claimed-by-present");
  assert.ok(claimedByCheck);
  assert.ok(!claimedByCheck.passed);
});

test("verifyPostDispatchMetadata fails when claimedAt is missing", () => {
  const task = buildTask({ id: "task-no-claim-time", claimedAt: undefined });
  const result = verifyPostDispatchMetadata(task);

  assert.ok(!result.passed);
  const claimedAtCheck = result.checks.find((c) => c.name === "claimed-at-present");
  assert.ok(claimedAtCheck);
  assert.ok(!claimedAtCheck.passed);
});

test("verifyPostDispatchMetadata fails for queued tasks (not yet dispatched)", () => {
  const task = buildTask({
    id: "task-still-queued",
    status: "queued",
    attemptId: undefined,
    claimedBy: undefined,
    claimedAt: undefined,
  });
  const result = verifyPostDispatchMetadata(task);

  assert.ok(!result.passed);
  const statusCheck = result.checks.find((c) => c.name === "post-dispatch-status");
  assert.ok(statusCheck);
  assert.ok(!statusCheck.passed);
});

test("verifyPostDispatchMetadata passes for running tasks", () => {
  const task = buildTask({
    id: "task-running",
    status: "running",
  });
  const result = verifyPostDispatchMetadata(task);

  const failed = result.checks.filter((c) => !c.passed);
  assert.equal(
    failed.length,
    0,
    `Expected zero failures for running task but got: ${JSON.stringify(failed, null, 2)}`,
  );
  assert.ok(result.passed);
});

test("verifyPostDispatchMetadata fails when claimedAt is before createdAt", () => {
  const task = buildTask({
    id: "task-time-travel",
    createdAt: isoFuture(),  // createdAt in the future
    claimedAt: isoPast(),     // claimedAt in the past
  });
  const result = verifyPostDispatchMetadata(task);

  assert.ok(!result.passed);
  const timeCheck = result.checks.find((c) => c.name === "claimed-at-after-created-at");
  assert.ok(timeCheck);
  assert.ok(!timeCheck.passed);
  assert.ok(timeCheck.message.includes("before createdAt"));
});

test("verifyPostDispatchMetadata fails when updatedAt is before claimedAt", () => {
  const task = buildTask({
    id: "task-update-before-claim",
    updatedAt: isoPast(),     // updatedAt in the past
    claimedAt: new Date().toISOString(), // claimedAt now (later)
  });
  const result = verifyPostDispatchMetadata(task);

  assert.ok(!result.passed);
  const timeCheck = result.checks.find((c) => c.name === "updated-at-after-claimed-at");
  assert.ok(timeCheck);
  assert.ok(!timeCheck.passed);
  assert.ok(timeCheck.message.includes("before claimedAt"));
});

test("verifyPostDispatchMetadata fails when claimedBy does not match assignedWorkerId", () => {
  const task = buildTask({
    id: "task-claim-mismatch",
    claimedBy: "worker-rogue",
    assignedWorkerId: "worker-intended",
  });
  const result = verifyPostDispatchMetadata(task);

  assert.ok(!result.passed);
  const workerCheck = result.checks.find((c) => c.name === "worker-consistency");
  assert.ok(workerCheck);
  assert.ok(!workerCheck.passed);
  assert.ok(workerCheck.message.includes("worker-rogue"));
  assert.ok(workerCheck.message.includes("worker-intended"));
});

test("verifyPostDispatchMetadata passes when claimedBy matches targetNodeId (no explicit assignedWorkerId)", () => {
  const task = buildTask({
    id: "task-target-claimed",
    claimedBy: "worker-node-1",
    assignedWorkerId: undefined,
    targetNodeId: "worker-node-1",
  });
  const result = verifyPostDispatchMetadata(task);

  const failed = result.checks.filter((c) => !c.passed);
  assert.equal(
    failed.length,
    0,
    `Expected zero failures but got: ${JSON.stringify(failed, null, 2)}`,
  );
  assert.ok(result.passed);
});

// ---------------------------------------------------------------------------
// GitHub canonical payload checks
// ---------------------------------------------------------------------------

test("verifyPostDispatchMetadata passes GitHub canonical checks for well-formed github task", () => {
  const task = buildTask({
    id: "task-github-ok",
    intent: "propose_patch",
    taskOrigin: "github",
    payload: {
      mode: "github-propose-patch",
      repo: "acme/platform",
      issue: "#291",
      issueNumber: 291,
      issueUrl: "https://github.com/acme/platform/issues/291",
    },
  });
  const result = verifyPostDispatchMetadata(task);

  const failed = result.checks.filter((c) => !c.passed);
  assert.equal(
    failed.length,
    0,
    `Expected zero failures for canonical GitHub task but got: ${JSON.stringify(failed, null, 2)}`,
  );
  assert.ok(result.passed);
});

test("verifyPostDispatchMetadata skips GitHub checks for non-GitHub tasks", () => {
  const task = buildTask({
    id: "task-non-github",
    taskOrigin: "api",
    payload: { mode: "generic" },
  });
  const result = verifyPostDispatchMetadata(task);

  const githubCheck = result.checks.find((c) => c.name === "github-canonical-payload");
  assert.ok(githubCheck);
  assert.ok(githubCheck.passed); // skipped gracefully
  assert.ok(githubCheck.message.includes("not a GitHub-origin task"));
});

test("verifyPostDispatchMetadata detects missing canonical fields in GitHub task", () => {
  const task = buildTask({
    id: "task-github-malformed",
    intent: "propose_patch",
    taskOrigin: "github",
    payload: {
      mode: "github-propose-patch",
      // missing repo, issueNumber, issueUrl
    },
  });
  const result = verifyPostDispatchMetadata(task);

  assert.ok(!result.passed);
  const repoCheck = result.checks.find((c) => c.name === "github-payload-repo");
  assert.ok(repoCheck);
  assert.ok(!repoCheck.passed);

  const issueNumCheck = result.checks.find((c) => c.name === "github-payload-issue-number");
  assert.ok(issueNumCheck);
  assert.ok(!issueNumCheck.passed);

  const issueUrlCheck = result.checks.find((c) => c.name === "github-payload-issue-url");
  assert.ok(issueUrlCheck);
  assert.ok(!issueUrlCheck.passed);
});

test("verifyPostDispatchMetadata fails GitHub mode check when mode is wrong", () => {
  const task = buildTask({
    id: "task-github-bad-mode",
    taskOrigin: "github",
    payload: {
      mode: "generic-analyze",
      repo: "acme/platform",
      issueNumber: 42,
      issueUrl: "https://github.com/acme/platform/issues/42",
    },
  });
  const result = verifyPostDispatchMetadata(task);

  assert.ok(!result.passed);
  const modeCheck = result.checks.find((c) => c.name === "github-payload-mode");
  assert.ok(modeCheck);
  assert.ok(!modeCheck.passed);
});

test("verifyPostDispatchMetadata handles payload detected as GitHub via mode prefix", () => {
  const task = buildTask({
    id: "task-github-mode-detection",
    taskOrigin: "api", // not "github", but mode is github-ish
    payload: {
      mode: "github-verify",
      repo: "acme/platform",
      issueNumber: 999,
      issueUrl: "https://github.com/acme/platform/issues/999",
    },
  });
  const result = verifyPostDispatchMetadata(task);

  // Should have run the GitHub checks since mode starts with "github-"
  // And they should pass since all fields are valid
  const repoCheck = result.checks.find((c) => c.name === "github-payload-repo");
  assert.ok(repoCheck);
  assert.ok(repoCheck.passed);
  const modeCheck = result.checks.find((c) => c.name === "github-payload-mode");
  assert.ok(modeCheck);
  assert.ok(modeCheck.passed);
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test("verifyPostDispatchMetadata returns result with expected shape", () => {
  const task = buildTask({ id: "task-shape" });
  const result = verifyPostDispatchMetadata(task);

  // Structural checks
  assert.ok(typeof result.taskId === "string");
  assert.ok(typeof result.timestamp === "string");
  assert.ok(Array.isArray(result.checks));
  assert.ok(typeof result.passed === "boolean");
  assert.ok(typeof result.summary === "object");
  assert.ok(typeof result.summary.total === "number");
  assert.ok(typeof result.summary.passed === "number");
  assert.ok(typeof result.summary.failed === "number");
  assert.equal(result.summary.total, result.checks.length);
});

test("verifyPostDispatchMetadata reports sensible totals", () => {
  const task = buildTask({ id: "task-totals" });
  const result = verifyPostDispatchMetadata(task);

  assert.equal(result.summary.total, result.summary.passed + result.summary.failed);
  assert.equal(result.summary.passed, result.checks.filter((c) => c.passed).length);
  assert.equal(result.summary.failed, result.checks.filter((c) => !c.passed).length);
});

test("verifyPostDispatchMetadata with expectedWorkerId adds extra check and adjusts totals", () => {
  const task = buildTask({ id: "task-extra-check" });

  const resultWithout = verifyPostDispatchMetadata(task);
  const resultWith = verifyPostDispatchMetadata(task, "worker-1");

  assert.equal(resultWith.summary.total, resultWithout.summary.total + 1);
  assert.ok(resultWith.checks.some((c) => c.name === "expected-worker-match"));
});

test("verifyPostDispatchMetadata handles worker that claims via targetNodeId but not assignedWorkerId", () => {
  // When assignedWorkerId is not set, broker uses targetNodeId as fallback
  const task = buildTask({
    id: "task-fallback-worker",
    claimedBy: "worker-7",
    assignedWorkerId: undefined,
    targetNodeId: "worker-7",
  });
  const result = verifyPostDispatchMetadata(task);

  const workerCheck = result.checks.find((c) => c.name === "worker-consistency");
  assert.ok(workerCheck);
  assert.ok(workerCheck.passed, "claimedBy should match targetNodeId fallback");
});
