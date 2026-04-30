/**
 * Delegated runtime regression tests for the A2A broker.
 *
 * These tests load each fixture state from `delegated-runtime.ts` into a broker
 * instance and assert behavioral invariants that should remain stable across
 * future seam changes. They act as change detectors — if a refactoring silently
 * breaks cancel, stale recovery, or tombstone behavior, these tests fail.
 *
 * @see jinwon-int/a2a-broker#22
 * @see jinwon-int/openclaw#15 (dashboard read-surface coverage — cross-linked)
 */

import test from "node:test";
import assert from "node:assert/strict";

import { InMemoryA2ABroker } from "./broker.js";
import { CURRENT_BROKER_STATE_VERSION } from "./store.js";
import {
  buildWaitingState,
  buildResumedState,
  buildCompletedState,
  buildFailedState,
  buildCanceledState,
  buildTimedOutState,
  buildStaleState,
  buildTombstonedState,
  ALL_RUNTIME_STATES,
  TERMINAL_RUNTIME_STATES,
  INFLIGHT_RUNTIME_STATES,
} from "../fixtures/delegated-runtime.js";

// ---------------------------------------------------------------------------
// Fixture loading helper
// ---------------------------------------------------------------------------

function loadBrokerFromFixture(fixture: ReturnType<typeof buildWaitingState>, options?: ConstructorParameters<typeof InMemoryA2ABroker>[2]) {
  return new InMemoryA2ABroker(undefined, fixture, options);
}

// ---------------------------------------------------------------------------
// Parameterized fixture integrity tests
// ---------------------------------------------------------------------------

for (const fixture of ALL_RUNTIME_STATES) {
  test(`fixture "${fixture.name}" loads into broker with correct task and exchange status`, () => {
    const broker = loadBrokerFromFixture(fixture.build());
    const tasks = broker.listTasks({});
    const exchanges = broker.listExchanges();

    assert.equal(tasks.length, 1, `expected 1 task for ${fixture.name}`);
    assert.equal(exchanges.length, 1, `expected 1 exchange for ${fixture.name}`);
    assert.equal(tasks[0].status, fixture.expectedTaskStatus);
    assert.equal(exchanges[0].status, fixture.expectedExchangeStatus);
    // Task must be linked to exchange
    assert.equal(tasks[0].exchangeId, exchanges[0].id);
    assert.equal(exchanges[0].activeTaskId, tasks[0].id);
  });
}

// ---------------------------------------------------------------------------
// Per-state behavioral regression
// ---------------------------------------------------------------------------

test("waiting state: task is claimable and exchange transitions to running on claim", () => {
  const broker = loadBrokerFromFixture(buildWaitingState());
  const task = broker.listTasks({})[0];
  const exchange = broker.listExchanges()[0];

  // Verify initial state
  assert.equal(task.status, "queued");
  assert.equal(task.claimedBy, undefined);
  assert.equal(exchange.status, "queued");

  // Claim should succeed
  const claimed = broker.claimTask(task.id, task.assignedWorkerId!);
  assert.equal(claimed.status, "claimed");
  assert.equal(claimed.claimedBy, task.assignedWorkerId);

  // Exchange should still be queued until start
  const refreshedExchange = broker.getExchange(exchange.id);
  assert.equal(refreshedExchange?.status, "running");
});

test("resumed state: task transitions through start → complete with correct audit trail", () => {
  const broker = loadBrokerFromFixture(buildResumedState());
  const task = broker.listTasks({})[0];

  assert.equal(task.status, "running");
  assert.equal(task.claimedBy, "worker-regression");

  // Start should be idempotent (already running via fixture)
  // Complete the task
  const completed = broker.completeTask(task.id, "worker-regression", {
    summary: "regression analysis done",
    artifactIds: ["artifact-result-1"],
  });

  assert.equal(completed.status, "succeeded");
  assert.equal(completed.result?.summary, "regression analysis done");
  assert.ok(completed.artifactIds?.includes("artifact-result-1"));

  // Verify audit trail
  const taskAudits = broker.listAuditEvents({ targetId: task.id });
  const actions = taskAudits.map((e) => e.action);
  assert.ok(actions.includes("task.created"));
  assert.ok(actions.includes("task.claimed"));
  assert.ok(actions.includes("task.started"));
  assert.ok(actions.includes("task.succeeded"));

  // Verify dashboard reflects completion
  const dashboard = broker.getDashboard({ nowMs: Date.now() });
  assert.equal(dashboard.history.totalCompleted, 1);
  assert.equal(dashboard.queue.total, 0);
});

test("failed state: cannot claim or complete a failed task", () => {
  const broker = loadBrokerFromFixture(buildFailedState());
  const task = broker.listTasks({})[0];

  assert.equal(task.status, "failed");
  assert.equal(task.error?.code, "handler_error");

  // Claim should throw — task is already terminal
  assert.throws(
    () => broker.claimTask(task.id, "worker-regression"),
    /cannot claim task/,
  );

  // Start should throw
  assert.throws(
    () => broker.startTask(task.id, "worker-regression"),
    /cannot start task/,
  );

  // Complete should return existing task (idempotent terminal guard)
  const completeResult = broker.completeTask(task.id, "worker-regression");
  assert.equal(completeResult.status, "failed");
  assert.equal(completeResult.error?.code, "handler_error");

  // Fail should return existing task (idempotent terminal guard)
  const failResult = broker.failTask(task.id, "worker-regression");
  assert.equal(failResult.status, "failed");
  assert.equal(failResult.error?.code, "handler_error");

  // Cancel should be idempotent on terminal states
  const cancelResult = broker.cancelTask(task.id, {
    actor: { id: "ops-regression", kind: "node", role: "operator" },
    reason: "already failed",
  });
  assert.equal(cancelResult.status, "failed");

  // Dashboard should reflect failure
  const dashboard = broker.getDashboard({ nowMs: Date.now() });
  assert.equal(dashboard.history.totalFailed, 1);
  assert.equal(dashboard.history.recent.length, 1);
  assert.equal(dashboard.history.recent[0].status, "failed");
  assert.equal(dashboard.history.recent[0].error?.code, "handler_error");
});

test("canceled state: exchange is back to queued, task is not claimable", () => {
  const broker = loadBrokerFromFixture(buildCanceledState());
  const task = broker.listTasks({})[0];
  const exchange = broker.listExchanges()[0];

  assert.equal(task.status, "canceled");
  assert.equal(task.error?.code, "canceled");
  assert.equal(exchange.status, "queued");

  // Should not be claimable
  assert.throws(
    () => broker.claimTask(task.id, "worker-regression"),
    /cannot claim task/,
  );

  // Cancel should be idempotent
  const cancelResult = broker.cancelTask(task.id, {
    actor: { id: "hub-regression", kind: "node", role: "hub" },
  });
  assert.equal(cancelResult.status, "canceled");
});

test("timed-out state: task has requeueCount=1 and can be re-claimed", () => {
  const broker = loadBrokerFromFixture(buildTimedOutState());
  const task = broker.listTasks({})[0];

  assert.equal(task.status, "queued");
  assert.equal(task.requeueCount, 1);
  assert.equal(task.claimedBy, undefined);

  // Task should be re-claimable
  const claimed = broker.claimTask(task.id, "worker-regression");
  assert.equal(claimed.status, "claimed");
  assert.equal(claimed.requeueCount, 1, "requeueCount should be preserved across claim");

  // Dashboard should show requeue in recovery
  const dashboard = broker.getDashboard({ nowMs: Date.now() });
  assert.equal(dashboard.observability.recovery.totalRequeued, 1);
});

test("stale state: reaper requeues the claimed task from dead worker", () => {
  // Use a requeue cap that won't trigger dead-lettering
  const broker = loadBrokerFromFixture(buildStaleState(), { maxRequeueAttempts: 5 });
  const task = broker.listTasks({})[0];
  const exchange = broker.listExchanges()[0];

  assert.equal(task.status, "claimed");
  assert.equal(task.claimedBy, "worker-stale");

  // Simulate reaper with 0ms threshold — requeues immediately
  const { requeued, deadLettered } = broker.requeueStaleTasksDetailed(0, {
    workerOfflineAfterMs: 60_000, // 1 minute
    nowMs: Date.parse("2026-04-19T01:00:00.000Z"),
  });

  assert.equal(requeued.length, 1);
  assert.equal(deadLettered.length, 0);

  const requeuedTask = broker.getTask(task.id);
  assert.equal(requeuedTask?.status, "queued");
  assert.equal(requeuedTask?.requeueCount, 1);
  assert.equal(requeuedTask?.claimedBy, undefined, "claimedBy should be cleared");
  assert.equal(requeuedTask?.assignedWorkerId, "worker-stale", "assignedWorkerId should be preserved");

  // Exchange should return to queued
  const refreshedExchange = broker.getExchange(exchange.id);
  assert.equal(refreshedExchange?.status, "queued");

  // Dashboard recovery counters
  const dashboard = broker.getDashboard({
    nowMs: Date.parse("2026-04-19T01:00:00.000Z"),
    offlineAfterMs: 60_000,
  });
  assert.equal(dashboard.observability.recovery.totalRequeued, 1);
  assert.equal(dashboard.observability.recovery.totalDeadLettered, 0);
});

test("tombstoned state: dead-lettered task has exceeded_requeue_limit error and is not recoverable", () => {
  const broker = loadBrokerFromFixture(buildTombstonedState());
  const task = broker.listTasks({})[0];
  const exchange = broker.listExchanges()[0];

  assert.equal(task.status, "failed");
  assert.equal(task.error?.code, "exceeded_requeue_limit");
  assert.equal(task.requeueCount, 3);
  assert.ok(task.completedAt);

  // Error details should be preserved for forensics
  const details = task.error?.details as Record<string, unknown> | undefined;
  assert.equal(details?.requeueCount, 3);
  assert.ok(typeof details?.maxRequeueAttempts === "number");
  assert.equal(details?.previousStatus, "claimed");
  assert.ok(typeof details?.lastRequeueReason === "string");

  // Exchange should also be failed
  assert.equal(exchange.status, "failed");

  // Should not be claimable
  assert.throws(
    () => broker.claimTask(task.id, "worker-regression"),
    /cannot claim task/,
  );

  // Reaper should not requeue a tombstoned task (it's already failed)
  const { requeued, deadLettered } = broker.requeueStaleTasksDetailed(0);
  assert.equal(requeued.length, 0, "tombstoned task should not be requeued");
  assert.equal(deadLettered.length, 0, "already failed, not dead-lettered again");

  // Dashboard should report the dead-letter
  const dashboard = broker.getDashboard({ nowMs: Date.now() });
  assert.equal(dashboard.history.totalFailed, 1);
  assert.equal(dashboard.observability.recovery.totalDeadLettered, 1);
  assert.equal(dashboard.observability.recovery.recentDeadLetters.length, 1);
  assert.equal(dashboard.observability.recovery.recentDeadLetters[0].error?.code, "exceeded_requeue_limit");

  // Audit trail should show the full lifecycle
  const taskAudits = broker.listAuditEvents({ targetId: task.id });
  const requeueAudits = taskAudits.filter((e) => e.action === "task.requeued");
  assert.equal(requeueAudits.length, 3, "expected 3 requeue audit events");

  const failedAudit = taskAudits.find((e) => e.action === "task.failed" && e.actorId === "broker");
  assert.ok(failedAudit, "expected a broker-initiated task.failed audit event");
});

// ---------------------------------------------------------------------------
// Cross-fixture behavioral change detector
// ---------------------------------------------------------------------------

test("all non-terminal fixtures produce valid dashboard counts", () => {
  for (const fixture of ALL_RUNTIME_STATES) {
    if (TERMINAL_RUNTIME_STATES.has(fixture.name)) {
      continue;
    }

    const broker = loadBrokerFromFixture(fixture.build());
    const dashboard = broker.getDashboard({ nowMs: Date.now() });

    // Queue count should reflect the fixture state
    assert.ok(typeof dashboard.queue.total === "number");
    assert.ok(typeof dashboard.queue.byStatus[fixture.expectedTaskStatus] === "number");

    // Workers should always be visible
    assert.equal(dashboard.workers.total, 1);
    assert.ok(dashboard.workers.byNode.length >= 1);
  }
});

test("terminal fixtures produce correct history and observability counters", () => {
  for (const fixture of ALL_RUNTIME_STATES) {
    if (!TERMINAL_RUNTIME_STATES.has(fixture.name)) {
      continue;
    }

    const broker = loadBrokerFromFixture(fixture.build());
    const dashboard = broker.getDashboard({ nowMs: Date.now() });

    if (fixture.name === "completed") {
      assert.equal(dashboard.history.totalCompleted, 1);
    } else if (fixture.name === "failed") {
      assert.equal(dashboard.history.totalFailed, 1);
    } else if (fixture.name === "canceled") {
      // Canceled tasks don't count as completed or failed in history
      assert.equal(dashboard.history.totalCompleted, 0);
      assert.equal(dashboard.history.totalFailed, 0);
    } else if (fixture.name === "tombstoned") {
      assert.equal(dashboard.history.totalFailed, 1);
      assert.equal(dashboard.observability.recovery.totalDeadLettered, 1);
    }
  }
});

test("in-flight fixtures expose active task counts on workers", () => {
  for (const fixture of ALL_RUNTIME_STATES) {
    if (!INFLIGHT_RUNTIME_STATES.has(fixture.name)) {
      continue;
    }

    const broker = loadBrokerFromFixture(fixture.build());
    const dashboard = broker.getDashboard({ nowMs: Date.now() });

    const activeWorker = dashboard.workers.byNode.find(
      (w) => w.activeTaskCount > 0,
    );
    assert.ok(activeWorker, `expected active task count > 0 for ${fixture.name}`);
    assert.ok(activeWorker.activeTaskCount >= 1);
  }
});

// ---------------------------------------------------------------------------
// Full lifecycle regression: waiting → resumed → completed
// ---------------------------------------------------------------------------

test("full lifecycle regression: waiting → claim → start → complete with SSE event tracking", () => {
  const broker = loadBrokerFromFixture(buildWaitingState());
  const task = broker.listTasks({})[0];

  const updates: Array<{ reason: string; status: string; final: boolean }> = [];
  const unsubscribe = broker.subscribeToTask(task.id, (u) => {
    updates.push({ reason: u.reason, status: u.task.status, final: u.final });
  });

  // Drive the lifecycle
  broker.claimTask(task.id, "worker-regression");
  broker.startTask(task.id, "worker-regression");
  broker.completeTask(task.id, "worker-regression", { summary: "lifecycle regression done" });
  unsubscribe();

  assert.deepEqual(
    updates.map((u) => u.reason),
    ["claimed", "started", "succeeded"],
  );
  assert.deepEqual(
    updates.map((u) => u.status),
    ["claimed", "running", "succeeded"],
  );
  assert.deepEqual(
    updates.map((u) => u.final),
    [false, false, true],
  );

  // Verify the broker state is consistent
  const finalTask = broker.getTask(task.id);
  assert.equal(finalTask?.status, "succeeded");
  assert.equal(finalTask?.result?.summary, "lifecycle regression done");

  const finalExchange = broker.getExchange(finalTask!.exchangeId!);
  assert.equal(finalExchange?.status, "completed");
});

// ---------------------------------------------------------------------------
// Cancel regression: cancel at each lifecycle stage
// ---------------------------------------------------------------------------

test("cancel regression: cancel a queued task before claim", () => {
  const broker = loadBrokerFromFixture(buildWaitingState());
  const task = broker.listTasks({})[0];

  const updates: Array<{ reason: string; status: string; final: boolean }> = [];
  const unsubscribe = broker.subscribeToTask(task.id, (u) => {
    updates.push({ reason: u.reason, status: u.task.status, final: u.final });
  });

  broker.cancelTask(task.id, {
    actor: { id: "ops-regression", kind: "node", role: "operator" },
    reason: "pre-claim cancel",
  });
  unsubscribe();

  assert.deepEqual(updates.map((u) => u.reason), ["canceled"]);
  assert.equal(updates[0].final, true);
  assert.equal(broker.getTask(task.id)?.status, "canceled");
});

test("cancel regression: cancel a running task mid-execution", () => {
  const broker = loadBrokerFromFixture(buildResumedState());
  const task = broker.listTasks({})[0];

  assert.equal(task.status, "running");

  const updates: Array<{ reason: string; status: string; final: boolean }> = [];
  const unsubscribe = broker.subscribeToTask(task.id, (u) => {
    updates.push({ reason: u.reason, status: u.task.status, final: u.final });
  });

  broker.cancelTask(task.id, {
    actor: { id: "ops-regression", kind: "node", role: "operator" },
    reason: "mid-execution cancel",
  });
  unsubscribe();

  assert.deepEqual(updates.map((u) => u.reason), ["canceled"]);
  assert.equal(updates[0].final, true);
  assert.equal(broker.getTask(task.id)?.status, "canceled");
});

// ---------------------------------------------------------------------------
// Stale → tombstone lifecycle regression
// ---------------------------------------------------------------------------

test("stale-to-tombstone lifecycle: repeated stale recoveries lead to dead-letter", () => {
  const broker = loadBrokerFromFixture(buildWaitingState(), {
    maxRequeueAttempts: 2,
  });
  const task = broker.listTasks({})[0];

  const updates: Array<{ reason: string; status: string; final: boolean }> = [];
  const unsubscribe = broker.subscribeToTask(task.id, (u) => {
    updates.push({ reason: u.reason, status: u.task.status, final: u.final });
  });

  // Cycle 1: claim → stale requeue
  broker.claimTask(task.id, "worker-regression");
  let result = broker.requeueStaleTasksDetailed(0);
  assert.equal(result.requeued.length, 1);
  assert.equal(result.deadLettered.length, 0);

  // Cycle 2: claim → stale requeue (now at cap)
  broker.claimTask(task.id, "worker-regression");
  result = broker.requeueStaleTasksDetailed(0);
  assert.equal(result.requeued.length, 1);
  assert.equal(result.deadLettered.length, 0);

  // Cycle 3: claim → stale requeue → DEAD LETTER
  broker.claimTask(task.id, "worker-regression");
  result = broker.requeueStaleTasksDetailed(0);
  assert.equal(result.requeued.length, 0);
  assert.equal(result.deadLettered.length, 1);

  unsubscribe();

  // Verify SSE event sequence
  const reasons = updates.map((u) => u.reason);
  assert.ok(reasons.includes("claimed"));
  assert.ok(reasons.includes("requeued"));
  assert.ok(reasons.includes("dead_lettered"));

  const deadLetterEvent = updates.find((u) => u.reason === "dead_lettered");
  assert.equal(deadLetterEvent?.final, true);
  assert.equal(deadLetterEvent?.status, "failed");

  // Verify final state
  const finalTask = broker.getTask(task.id);
  assert.equal(finalTask?.status, "failed");
  assert.equal(finalTask?.error?.code, "exceeded_requeue_limit");

  const finalExchange = broker.getExchange(finalTask!.exchangeId!);
  assert.equal(finalExchange?.status, "failed");

  // Verify dashboard
  const dashboard = broker.getDashboard({ nowMs: Date.now() });
  assert.equal(dashboard.observability.recovery.totalRequeued, 2);
  assert.equal(dashboard.observability.recovery.totalDeadLettered, 1);
});

// ---------------------------------------------------------------------------
// Dashboard consistency across fixture states
// ---------------------------------------------------------------------------

test("dashboard queue.byStatus contains keys for active statuses", () => {
  const broker = loadBrokerFromFixture(buildWaitingState());
  const dashboard = broker.getDashboard({ nowMs: Date.now() });
  // byStatus is a countBy result — only keys for present statuses are guaranteed.
  // A waiting-state broker should have at least "queued".
  assert.ok("queued" in dashboard.queue.byStatus, "missing byStatus key: queued");
  assert.equal(typeof dashboard.queue.byStatus["queued"], "number");
});

test("dashboard worker status reflects stale worker in stale fixture", () => {
  const broker = loadBrokerFromFixture(buildStaleState());
  const dashboard = broker.getDashboard({
    nowMs: Date.parse("2026-04-19T01:00:00.000Z"),
    offlineAfterMs: 60_000,
  });

  // Worker should be stale (lastSeenAt is 2 hours old)
  const worker = dashboard.workers.byNode.find((w) => w.nodeId === "worker-stale");
  assert.ok(worker, "expected worker-stale in dashboard");
  assert.equal(worker.status, "stale");
  assert.equal(dashboard.workers.stale, 1);
  assert.equal(dashboard.workers.online, 0);
});

// ---------------------------------------------------------------------------
// Snapshot round-trip integrity
// ---------------------------------------------------------------------------

test("all fixtures round-trip through exportSnapshot without data loss", () => {
  for (const fixture of ALL_RUNTIME_STATES) {
    const snapshot = fixture.build();
    const broker = loadBrokerFromFixture(snapshot);
    const exported = broker.exportSnapshot();

    // Verify task count
    assert.equal(exported.tasks.length, snapshot.tasks.length, `${fixture.name}: task count mismatch`);

    // Verify exchange count
    assert.equal(exported.exchanges.length, snapshot.exchanges.length, `${fixture.name}: exchange count mismatch`);

    // Verify worker count
    assert.equal(exported.workers.length, snapshot.workers.length, `${fixture.name}: worker count mismatch`);

    // Verify task statuses preserved
    for (const originalTask of snapshot.tasks) {
      const exportedTask = exported.tasks.find((t) => t.id === originalTask.id);
      assert.ok(exportedTask, `${fixture.name}: task ${originalTask.id} not found in export`);
      assert.equal(exportedTask.status, originalTask.status);
    }
  }
});
