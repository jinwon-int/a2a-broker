/**
 * Session Isolation Regression Tests
 *
 * These tests enforce the source-level invariant that A2A full-handler
 * workers MUST dispatch tasks with task-scoped ephemeral session ids,
 * NOT shared/long-lived sessions like `main` or `telegram`.
 *
 * @see jinon86/a2a-broker#164
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  deriveTaskSessionId,
  deriveSessionIdFromTask,
  validateSessionIsolation,
  buildSessionIsolatedArgs,
  FORBIDDEN_SESSION_IDS,
  A2A_SESSION_ID_PREFIX,
} from "./session-isolation.js";

import type { TaskRecord } from "../core/types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "550e8400-e29b-41d4-a716-446655440000",
    intent: "propose_patch",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    targetNodeId: "worker-a",
    assignedWorkerId: "worker-a",
    status: "queued",
    message: "test task",
    payload: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Session ID derivation
// ---------------------------------------------------------------------------

test("deriveTaskSessionId produces canonical format a2a-<nodeId>-<taskId>", () => {
  const sid = deriveTaskSessionId("dungae", "abc-123");
  assert.equal(sid, "a2a-dungae-abc-123");
});

test("deriveTaskSessionId is deterministic", () => {
  const a = deriveTaskSessionId("bangtong", "task-x");
  const b = deriveTaskSessionId("bangtong", "task-x");
  assert.equal(a, b);
});

test("deriveTaskSessionId produces different ids for different nodes", () => {
  const sid1 = deriveTaskSessionId("dungae", "task-1");
  const sid2 = deriveTaskSessionId("sogyo", "task-1");
  assert.notEqual(sid1, sid2);
});

test("deriveTaskSessionId produces different ids for different tasks", () => {
  const sid1 = deriveTaskSessionId("dungae", "task-1");
  const sid2 = deriveTaskSessionId("dungae", "task-2");
  assert.notEqual(sid1, sid2);
});

test("deriveTaskSessionId throws on empty nodeId", () => {
  assert.throws(
    () => deriveTaskSessionId("", "task-1"),
    /nodeId must be a non-empty string/,
  );
});

test("deriveTaskSessionId throws on empty taskId", () => {
  assert.throws(
    () => deriveTaskSessionId("dungae", ""),
    /taskId must be a non-empty string/,
  );
});

test("deriveSessionIdFromTask extracts id from TaskRecord", () => {
  const task = makeTask({ id: "task-uuid-001" });
  const sid = deriveSessionIdFromTask(task, "dungae");
  assert.equal(sid, "a2a-dungae-task-uuid-001");
});

// ---------------------------------------------------------------------------
// Session ID prefix
// ---------------------------------------------------------------------------

test("all derived session ids share the a2a- prefix", () => {
  for (const [node, task] of [
    ["dungae", "t1"],
    ["sogyo", "t2"],
    ["bangtong", "t3"],
  ]) {
    assert.ok(deriveTaskSessionId(node, task).startsWith(A2A_SESSION_ID_PREFIX));
  }
});

// ---------------------------------------------------------------------------
// Regression: forbidden shared sessions
// ---------------------------------------------------------------------------

test("FORBIDDEN_SESSION_IDS includes 'main' (shared/Telegram session)", () => {
  assert.ok(FORBIDDEN_SESSION_IDS.has("main"));
  assert.ok(FORBIDDEN_SESSION_IDS.has("telegram"));
  assert.ok(FORBIDDEN_SESSION_IDS.has("a2a-worker"));
});

test("validateSessionIsolation rejects handler using 'main' session", () => {
  const task = makeTask({ id: "task-abc" });
  const check = validateSessionIsolation(task, "dungae", [
    "--session-id",
    "main",
    "--other",
    "arg",
  ]);
  assert.equal(check.valid, false);
  assert.equal(check.foundSessionId, "main");
  assert.match(check.reason ?? "", /forbidden shared session/);
});

test("validateSessionIsolation rejects handler using 'telegram' session", () => {
  const task = makeTask({ id: "task-abc" });
  const check = validateSessionIsolation(task, "dungae", [
    "--session-id",
    "telegram",
  ]);
  assert.equal(check.valid, false);
  assert.equal(check.foundSessionId, "telegram");
  assert.match(check.reason ?? "", /forbidden shared session/);
});

test("validateSessionIsolation rejects handler using 'a2a-worker' shared session", () => {
  const task = makeTask({ id: "task-abc" });
  const check = validateSessionIsolation(task, "dungae", [
    "--session-id",
    "a2a-worker",
  ]);
  assert.equal(check.valid, false);
  assert.equal(check.foundSessionId, "a2a-worker");
  assert.match(check.reason ?? "", /forbidden shared session/);
});

// ---------------------------------------------------------------------------
// Regression: missing --session-id flag
// ---------------------------------------------------------------------------

test("validateSessionIsolation rejects handler args without --session-id", () => {
  const task = makeTask();
  const check = validateSessionIsolation(task, "dungae", [
    "--model",
    "opus",
    "--message",
    "hello",
  ]);
  assert.equal(check.valid, false);
  assert.match(check.reason ?? "", /do not include --session-id/);
});

test("validateSessionIsolation rejects empty args array", () => {
  const task = makeTask();
  const check = validateSessionIsolation(task, "dungae", []);
  assert.equal(check.valid, false);
  assert.match(check.reason ?? "", /do not include --session-id/);
});

// ---------------------------------------------------------------------------
// Regression: wrong session id
// ---------------------------------------------------------------------------

test("validateSessionIsolation rejects handler with mismatched session id", () => {
  const task = makeTask({ id: "task-abc" });
  const check = validateSessionIsolation(task, "dungae", [
    "--session-id",
    "a2a-dungae-different-task",
  ]);
  assert.equal(check.valid, false);
  assert.equal(check.foundSessionId, "a2a-dungae-different-task");
  assert.match(check.reason ?? "", /session id mismatch/);
});

test("validateSessionIsolation rejects handler using another task's session", () => {
  const taskA = makeTask({ id: "task-alpha" });
  const taskB = makeTask({ id: "task-beta" });

  // Handler args derive session from task B, but we validate against task A
  const argsForB = ["--session-id", deriveTaskSessionId("dungae", "task-beta")];
  const check = validateSessionIsolation(taskA, "dungae", argsForB);

  assert.equal(check.valid, false);
  assert.match(check.reason ?? "", /session id mismatch/);
});

// ---------------------------------------------------------------------------
// Regression: valid session isolation passes
// ---------------------------------------------------------------------------

test("validateSessionIsolation accepts correctly scoped session id", () => {
  const task = makeTask({ id: "task-abc" });
  const expectedSid = deriveTaskSessionId("dungae", "task-abc");
  const check = validateSessionIsolation(task, "dungae", [
    "--session-id",
    expectedSid,
    "--extra",
    "value",
  ]);
  assert.equal(check.valid, true);
  assert.equal(check.foundSessionId, expectedSid);
});

test("validateSessionIsolation accepts --sessionId alias", () => {
  const task = makeTask({ id: "task-camel" });
  const expectedSid = deriveTaskSessionId("dungae", "task-camel");
  const check = validateSessionIsolation(task, "dungae", [
    "--sessionId",
    expectedSid,
  ]);
  assert.equal(check.valid, true);
});

// ---------------------------------------------------------------------------
// buildSessionIsolatedArgs
// ---------------------------------------------------------------------------

test("buildSessionIsolatedArgs appends --session-id when absent", () => {
  const args = buildSessionIsolatedArgs(
    ["--model", "opus"],
    "dungae",
    "task-x",
  );
  const sidIndex = args.indexOf("--session-id");
  assert.ok(sidIndex >= 0);
  assert.equal(args[sidIndex + 1], "a2a-dungae-task-x");
});

test("buildSessionIsolatedArgs replaces existing --session-id", () => {
  const args = buildSessionIsolatedArgs(
    ["--model", "opus", "--session-id", "main"],
    "dungae",
    "task-x",
  );
  const sidIndex = args.indexOf("--session-id");
  assert.ok(sidIndex >= 0);
  assert.equal(args[sidIndex + 1], "a2a-dungae-task-x");
});

test("buildSessionIsolatedArgs preserves unrelated args", () => {
  const args = buildSessionIsolatedArgs(
    ["--model", "opus", "--print", "--permission-mode", "bypassPermissions"],
    "dungae",
    "task-999",
  );
  assert.ok(args.includes("--model"));
  assert.ok(args.includes("opus"));
  assert.ok(args.includes("--print"));
  assert.equal(args[args.indexOf("--session-id") + 1], "a2a-dungae-task-999");
});

// ---------------------------------------------------------------------------
// Retry / requeue semantics
// ---------------------------------------------------------------------------

test("retry of same task produces same session id (task-scoped, not attempt-scoped)", () => {
  const task = makeTask({ id: "task-retry-me" });
  const attempt1Sid = deriveSessionIdFromTask(task, "dungae");
  const attempt2Sid = deriveSessionIdFromTask(task, "dungae");
  assert.equal(attempt1Sid, attempt2Sid);
});

test("two different tasks produce different session ids (no cross-contamination)", () => {
  const taskA = makeTask({ id: "task-a" });
  const taskB = makeTask({ id: "task-b" });
  const sidA = deriveSessionIdFromTask(taskA, "dungae");
  const sidB = deriveSessionIdFromTask(taskB, "dungae");
  assert.notEqual(sidA, sidB);
});

test("same task across different nodes produces different session ids", () => {
  const task = makeTask({ id: "shared-task" });
  const dungaeSid = deriveSessionIdFromTask(task, "dungae");
  const sogyoSid = deriveSessionIdFromTask(task, "sogyo");
  assert.notEqual(dungaeSid, sogyoSid);
});

// ---------------------------------------------------------------------------
// Full-handler dispatch regression (the key invariant)
// ---------------------------------------------------------------------------

test("regression: full-handler dispatch without --session-id is detected", () => {
  // Simulate a worker handler config that forgot to add --session-id
  const task = makeTask({ id: "task-gh-164" });
  const bareHandlerArgs = [
    "openclaw",
    "agent",
    "--model",
    "opus",
    "--message",
    "run task",
  ];

  // This is the regression we want to catch — no session isolation
  const check = validateSessionIsolation(task, "dungae", bareHandlerArgs);
  assert.equal(check.valid, false, "bare args without --session-id must fail validation");
  assert.match(
    check.reason ?? "",
    /do not include --session-id/,
    "error must clearly state --session-id is missing",
  );
});

test("regression: full-handler dispatch into 'main' session is detected", () => {
  const task = makeTask({ id: "task-gh-164" });

  // Simulate what happens when a worker accidentally uses --session-id main
  const sharedSessionArgs = [
    "openclaw",
    "agent",
    "--session-id",
    "main",
    "--message",
    "run task",
  ];

  const check = validateSessionIsolation(task, "dungae", sharedSessionArgs);
  assert.equal(check.valid, false, "shared 'main' session must fail validation");
  assert.equal(check.foundSessionId, "main");
  assert.match(check.reason ?? "", /forbidden shared session/);
});

test("regression: full-handler with correct task-scoped session passes", () => {
  const task = makeTask({ id: "task-gh-164" });
  const expectedSid = deriveSessionIdFromTask(task, "dungae");

  const isolatedArgs = [
    "openclaw",
    "agent",
    "--session-id",
    expectedSid,
    "--model",
    "opus",
    "--message",
    "run task",
  ];

  const check = validateSessionIsolation(task, "dungae", isolatedArgs);
  assert.equal(check.valid, true, "correctly scoped session must pass validation");
  assert.equal(check.expectedSessionId, expectedSid);
});

// ---------------------------------------------------------------------------
// Boundary cases
// ---------------------------------------------------------------------------

test("validateSessionIsolation handles --session-id at end of args", () => {
  const task = makeTask({ id: "edge-case" });
  const expectedSid = deriveTaskSessionId("dungae", "edge-case");
  const check = validateSessionIsolation(task, "dungae", [
    "--session-id",
    expectedSid,
  ]);
  assert.equal(check.valid, true);
});

test("validateSessionIsolation handles --session-id at beginning of args", () => {
  const task = makeTask({ id: "first-arg" });
  const expectedSid = deriveTaskSessionId("dungae", "first-arg");
  const check = validateSessionIsolation(task, "dungae", [
    "--session-id",
    expectedSid,
    "--model",
    "opus",
    "do-work",
  ]);
  assert.equal(check.valid, true);
});

test("validateSessionIsolation returns false for --session-id with no following value", () => {
  const task = makeTask();
  const check = validateSessionIsolation(task, "dungae", ["--session-id"]);
  assert.equal(check.valid, false);
  assert.match(check.reason ?? "", /do not include --session-id/);
});

test("deriveTaskSessionId handles task IDs with special characters", () => {
  const sid = deriveTaskSessionId(
    "dungae",
    "69ebedd8-0c5e-4386-97b4-273c20281eb1",
  );
  assert.equal(
    sid,
    "a2a-dungae-69ebedd8-0c5e-4386-97b4-273c20281eb1",
  );
});

test("deriveTaskSessionId trims whitespace from inputs", () => {
  // Whitespace-only nodeId should throw
  assert.throws(
    () => deriveTaskSessionId("   ", "task-1"),
    /nodeId must be a non-empty string/,
  );
});
