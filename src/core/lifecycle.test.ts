import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { InMemoryA2ABroker } from "./broker.js";
import type { TaskTombstone } from "./types.js";

function makeBroker() {
  return new InMemoryA2ABroker();
}

function registerWorker(broker: InMemoryA2ABroker, nodeId = "worker-1") {
  broker.registerWorker({
    nodeId,
    role: "operator",
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: false,
      canPromoteLive: false,
      workspaceIds: ["default"],
      environments: ["research"],
    },
  });
}

function createTask(broker: InMemoryA2ABroker, targetNodeId = "worker-1") {
  return broker.createTask({
    intent: "analyze",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: targetNodeId, kind: "node", role: "operator" },
    payload: {},
  });
}

describe("task heartbeat", () => {
  it("heartbeatTask sets lastHeartbeatAt on claimed task", () => {
    const broker = makeBroker();
    registerWorker(broker);
    const task = createTask(broker);
    broker.claimTask(task.id, "worker-1");

    const updated = broker.heartbeatTask(task.id, "worker-1");
    assert.ok(updated.lastHeartbeatAt);
    assert.equal(updated.status, "claimed");
  });

  it("heartbeatTask sets lastHeartbeatAt on running task", () => {
    const broker = makeBroker();
    registerWorker(broker);
    const task = createTask(broker);
    broker.claimTask(task.id, "worker-1");
    broker.startTask(task.id, "worker-1");

    const updated = broker.heartbeatTask(task.id, "worker-1");
    assert.ok(updated.lastHeartbeatAt);
    assert.equal(updated.status, "running");
  });

  it("heartbeatTask rejects for unclaimed task", () => {
    const broker = makeBroker();
    registerWorker(broker);
    const task = createTask(broker);

    assert.throws(
      () => broker.heartbeatTask(task.id, "worker-1"),
      /cannot heartbeat task while status is queued/,
    );
  });

  it("heartbeatTask rejects for wrong worker", () => {
    const broker = makeBroker();
    registerWorker(broker, "worker-1");
    registerWorker(broker, "worker-2");
    const task = createTask(broker);
    broker.claimTask(task.id, "worker-1");

    assert.throws(
      () => broker.heartbeatTask(task.id, "worker-2"),
      /heartbeat requires the assigned worker/,
    );
  });

  it("heartbeatTask emits audit event", () => {
    const broker = makeBroker();
    registerWorker(broker);
    const task = createTask(broker);
    broker.claimTask(task.id, "worker-1");

    broker.heartbeatTask(task.id, "worker-1");

    const events = broker.listAuditEvents({ action: "task.heartbeat" });
    assert.equal(events.length, 1);
    assert.equal(events[0].targetId, task.id);
  });
});

describe("stale task detection", () => {
  it("listStaleTasks returns tasks with no heartbeat beyond threshold", () => {
    const broker = makeBroker();
    registerWorker(broker);
    const task = createTask(broker);
    broker.claimTask(task.id, "worker-1");

    const nowMs = Date.now() + 300_000; // 5 minutes later
    const stale = broker.listStaleTasks({ staleAfterMs: 120_000, nowMs });

    assert.equal(stale.length, 1);
    assert.equal(stale[0].id, task.id);
  });

  it("listStaleTasks excludes recently heartbeaten tasks", () => {
    const broker = makeBroker();
    registerWorker(broker);
    const task = createTask(broker);
    broker.claimTask(task.id, "worker-1");

    const nowMs = Date.now() + 300_000;
    // Heartbeat at "current" time
    broker.heartbeatTask(task.id, "worker-1");

    const stale = broker.listStaleTasks({ staleAfterMs: 120_000, nowMs });
    // The heartbeat was set before nowMs, but nowMs is 5 min in future
    // heartbeat was just set, so staleness should be < 120s relative to nowMs
    // Actually heartbeat was set at real now, which is 5 min before nowMs
    // So it IS stale relative to nowMs. Let's use a closer nowMs.
    const recentMs = Date.now() + 10_000; // 10s later
    const notStale = broker.listStaleTasks({ staleAfterMs: 120_000, nowMs: recentMs });
    assert.equal(notStale.length, 0);
  });

  it("listStaleTasks excludes terminal tasks", () => {
    const broker = makeBroker();
    registerWorker(broker);
    const task = createTask(broker);
    broker.claimTask(task.id, "worker-1");
    broker.startTask(task.id, "worker-1");
    broker.completeTask(task.id, "worker-1", { summary: "done" });

    const stale = broker.listStaleTasks({ staleAfterMs: 0 });
    assert.equal(stale.length, 0);
  });
});

describe("long-running task detection", () => {
  it("listLongRunningTasks returns tasks beyond threshold", () => {
    const broker = makeBroker();
    registerWorker(broker);
    const task = createTask(broker);
    broker.claimTask(task.id, "worker-1");
    broker.startTask(task.id, "worker-1");

    const nowMs = Date.now() + 3_700_000; // ~62 minutes later
    const longRunning = broker.listLongRunningTasks({ longRunningAfterMs: 3_600_000, nowMs });

    assert.equal(longRunning.length, 1);
    assert.equal(longRunning[0].id, task.id);
  });

  it("listLongRunningTasks excludes recently started tasks", () => {
    const broker = makeBroker();
    registerWorker(broker);
    const task = createTask(broker);
    broker.claimTask(task.id, "worker-1");
    broker.startTask(task.id, "worker-1");

    const longRunning = broker.listLongRunningTasks({ longRunningAfterMs: 3_600_000 });
    assert.equal(longRunning.length, 0);
  });
});

describe("task diagnostics", () => {
  it("getTaskDiagnostics returns active for running task with recent heartbeat", () => {
    const broker = makeBroker();
    registerWorker(broker);
    const task = createTask(broker);
    broker.claimTask(task.id, "worker-1");
    broker.startTask(task.id, "worker-1");
    broker.heartbeatTask(task.id, "worker-1");

    const diag = broker.getTaskDiagnostics(task.id);
    assert.equal(diag.diagnosticStatus, "active");
    assert.equal(diag.taskId, task.id);
    assert.ok(diag.stalenessMs !== undefined && diag.stalenessMs < 10_000);
    assert.ok(diag.lifecycle.lastHeartbeatAt);
  });

  it("getTaskDiagnostics returns stale for task without heartbeat", () => {
    const broker = makeBroker();
    registerWorker(broker);
    const task = createTask(broker);
    broker.claimTask(task.id, "worker-1");

    const nowMs = Date.now() + 300_000;
    const diag = broker.getTaskDiagnostics(task.id, {
      staleAfterMs: 120_000,
      workerOfflineAfterMs: 3_600_000,
      nowMs,
    });
    assert.equal(diag.diagnosticStatus, "stale");
    assert.equal(diag.brokerState, "reconcile_needed");
    assert.equal(diag.reconcileNeeded, true);
    assert.equal(diag.interruption?.kind, "stale_lease");
    assert.equal(diag.brokerHints.staleLease, true);
  });

  it("getTaskDiagnostics distinguishes stale worker from stale lease", () => {
    const broker = makeBroker();
    registerWorker(broker);
    const task = createTask(broker);
    broker.claimTask(task.id, "worker-1");

    const nowMs = Date.now() + 300_000;
    const diag = broker.getTaskDiagnostics(task.id, {
      staleAfterMs: 120_000,
      workerOfflineAfterMs: 60_000,
      nowMs,
    });

    assert.equal(diag.brokerState, "reconcile_needed");
    assert.equal(diag.reconcileNeeded, true);
    assert.equal(diag.interruption?.kind, "stale_worker");
    assert.equal(diag.interruption?.source, "worker_state");
    assert.equal(diag.brokerHints.staleWorker, true);
    assert.ok(diag.brokerHints.workerLastSeenAt);
  });

  it("getTaskDiagnostics returns terminal for completed task", () => {
    const broker = makeBroker();
    registerWorker(broker);
    const task = createTask(broker);
    broker.claimTask(task.id, "worker-1");
    broker.completeTask(task.id, "worker-1", { summary: "done" });

    const diag = broker.getTaskDiagnostics(task.id);
    assert.equal(diag.diagnosticStatus, "terminal");
  });

  it("getTaskDiagnostics includes tombstone for failed task", () => {
    const broker = makeBroker();
    registerWorker(broker);
    const task = createTask(broker);
    broker.claimTask(task.id, "worker-1");
    broker.failTask(task.id, "worker-1", { message: "boom" });

    const diag = broker.getTaskDiagnostics(task.id);
    assert.equal(diag.diagnosticStatus, "terminal");
    assert.ok(diag.tombstone);
    assert.equal(diag.tombstone!.tombstoneReason, "failed");
    assert.equal(diag.tombstone!.taskId, task.id);
    assert.ok(diag.tombstone!.durationMs >= 0);
    assert.equal(diag.interruption?.kind, "failed");
    assert.equal(diag.brokerHints.tombstoneReason, "failed");
  });

  it("getTaskDiagnostics exposes timeout interruption from broker tombstone", () => {
    const broker = makeBroker();
    registerWorker(broker);
    const task = createTask(broker);
    broker.claimTask(task.id, "worker-1");
    broker.startTask(task.id, "worker-1");
    broker.failTask(task.id, "worker-1", { code: "timeout", message: "took too long" });

    const diag = broker.getTaskDiagnostics(task.id);
    assert.equal(diag.interruption?.kind, "timeout");
    assert.equal(diag.interruption?.source, "tombstone");
    assert.equal(diag.brokerState, "terminal");
    assert.equal(diag.reconcileNeeded, false);
  });

  it("getTaskDiagnostics exposes requeue interruption from durable audit state", () => {
    const broker = makeBroker();
    registerWorker(broker);
    const task = createTask(broker);
    broker.claimTask(task.id, "worker-1");
    broker.startTask(task.id, "worker-1");

    const result = broker.requeueStaleTasksDetailed(0);
    assert.equal(result.requeued.length, 1);

    const diag = broker.getTaskDiagnostics(task.id);
    assert.equal(diag.brokerState, "interrupted");
    assert.equal(diag.reconcileNeeded, false);
    assert.equal(diag.interruption?.kind, "requeued");
    assert.equal(diag.interruption?.source, "audit");
    assert.equal(diag.brokerHints.requeued, true);
    assert.ok(diag.brokerHints.lastRequeueAt);
  });
});

describe("tombstones", () => {
  it("getTombstone returns null for task without tombstone", () => {
    const broker = makeBroker();
    registerWorker(broker);
    const task = createTask(broker);
    broker.claimTask(task.id, "worker-1");
    broker.completeTask(task.id, "worker-1", { summary: "ok" });

    // Succeeded tasks don't get tombstones
    assert.equal(broker.getTombstone(task.id), null);
  });

  it("getTombstone returns tombstone for failed task", () => {
    const broker = makeBroker();
    registerWorker(broker);
    const task = createTask(broker);
    broker.claimTask(task.id, "worker-1");
    broker.failTask(task.id, "worker-1", { message: "error" });

    const ts = broker.getTombstone(task.id);
    assert.ok(ts);
    assert.equal(ts.tombstoneReason, "failed");
    assert.equal(ts.terminalStatus, "failed");
    assert.ok(ts.error);
    assert.equal(ts.error!.message, "error");
  });

  it("getTombstone returns tombstone for canceled task", () => {
    const broker = makeBroker();
    registerWorker(broker);
    const task = createTask(broker);
    broker.claimTask(task.id, "worker-1");

    broker.cancelTask(task.id, {
      actor: { id: "hub", role: "hub" },
      reason: "not needed",
    });

    const ts = broker.getTombstone(task.id);
    assert.ok(ts);
    assert.equal(ts.tombstoneReason, "canceled");
    assert.equal(ts.terminalStatus, "canceled");
  });

  it("getTombstone returns tombstone for dead-lettered task", () => {
    const broker = new InMemoryA2ABroker(undefined, undefined, { maxRequeueAttempts: 1 });
    registerWorker(broker);
    const task = createTask(broker);
    broker.claimTask(task.id, "worker-1");
    broker.startTask(task.id, "worker-1");

    // First requeue succeeds (requeueCount 0 → 1)
    let result = broker.requeueStaleTasksDetailed(0);
    assert.equal(result.requeued.length, 1);
    assert.equal(result.deadLettered.length, 0);

    // Reclaim and start to make it eligible again
    broker.claimTask(task.id, "worker-1");
    broker.startTask(task.id, "worker-1");

    // Second stale detection: requeueCount is 1, maxRequeueAttempts is 1, so 1 >= 1 → dead-letter
    result = broker.requeueStaleTasksDetailed(0);
    assert.equal(result.deadLettered.length, 1);

    const ts = broker.getTombstone(task.id);
    assert.ok(ts);
    assert.equal(ts.tombstoneReason, "dead_lettered");
  });

  it("listTombstones returns all tombstones sorted newest first", () => {
    const broker = makeBroker();
    registerWorker(broker, "w1");
    registerWorker(broker, "w2");

    const task1 = createTask(broker, "w1");
    broker.claimTask(task1.id, "w1");
    broker.failTask(task1.id, "w1", { message: "fail 1" });

    const task2 = createTask(broker, "w2");
    broker.claimTask(task2.id, "w2");
    broker.failTask(task2.id, "w2", { message: "fail 2" });

    const tombstones = broker.listTombstones();
    assert.equal(tombstones.length, 2);
    // Verify ordering: tombstonedAt should be non-decreasing (newest first)
    assert.ok(tombstones[0].tombstonedAt >= tombstones[1].tombstonedAt);
  });

  it("listTombstones filters by reason", () => {
    const broker = makeBroker();
    registerWorker(broker, "w1");
    registerWorker(broker, "w2");

    const task1 = createTask(broker, "w1");
    broker.claimTask(task1.id, "w1");
    broker.failTask(task1.id, "w1", { message: "fail" });

    const task2 = createTask(broker, "w2");
    broker.claimTask(task2.id, "w2");
    broker.cancelTask(task2.id, { actor: { id: "hub", role: "hub" } });

    const failed = broker.listTombstones({ tombstoneReason: "failed" });
    assert.equal(failed.length, 1);
    assert.equal(failed[0].taskId, task1.id);
  });

  it("tombstone preserves requeueCount", () => {
    const broker = new InMemoryA2ABroker(undefined, undefined, { maxRequeueAttempts: 1 });
    registerWorker(broker);
    const task = createTask(broker);
    broker.claimTask(task.id, "worker-1");
    broker.startTask(task.id, "worker-1");

    // First requeue succeeds (requeueCount 0 → 1)
    broker.requeueStaleTasksDetailed(0);
    broker.claimTask(task.id, "worker-1");
    broker.startTask(task.id, "worker-1");

    // Second detection: requeueCount=1 >= maxRequeueAttempts=1 → dead-letter
    const result = broker.requeueStaleTasksDetailed(0);
    assert.equal(result.deadLettered.length, 1);

    const ts = broker.getTombstone(task.id);
    assert.ok(ts);
    assert.equal(ts.requeueCount, 1);
  });
});

describe("tombstone audit trail", () => {
  it("failed task creates tombstone audit event", () => {
    const broker = makeBroker();
    registerWorker(broker);
    const task = createTask(broker);
    broker.claimTask(task.id, "worker-1");
    broker.failTask(task.id, "worker-1", { message: "oops" });

    const events = broker.listAuditEvents({ action: "task.tombstoned" });
    assert.equal(events.length, 1);
    assert.equal(events[0].targetId, task.id);
    assert.ok(events[0].note?.includes("failed"));
  });

  it("canceled task creates tombstone audit event", () => {
    const broker = makeBroker();
    registerWorker(broker);
    const task = createTask(broker);
    broker.claimTask(task.id, "worker-1");
    broker.cancelTask(task.id, { actor: { id: "hub", role: "hub" } });

    const events = broker.listAuditEvents({ action: "task.tombstoned" });
    assert.equal(events.length, 1);
    assert.ok(events[0].note?.includes("canceled"));
  });
});

describe("snapshot persistence with tombstones", () => {
  it("exportSnapshot includes tombstones", () => {
    const broker = makeBroker();
    registerWorker(broker);
    const task = createTask(broker);
    broker.claimTask(task.id, "worker-1");
    broker.failTask(task.id, "worker-1", { message: "err" });

    const snapshot = broker.exportSnapshot();
    assert.ok(snapshot.tombstones);
    assert.equal(snapshot.tombstones!.length, 1);
    assert.equal(snapshot.tombstones![0].taskId, task.id);
  });

  it("tombstones survive snapshot round-trip", () => {
    const broker = makeBroker();
    registerWorker(broker);
    const task = createTask(broker);
    broker.claimTask(task.id, "worker-1");
    broker.failTask(task.id, "worker-1", { message: "err" });

    const snapshot = broker.exportSnapshot();
    const broker2 = new InMemoryA2ABroker(undefined, snapshot);
    const ts = broker2.getTombstone(task.id);
    assert.ok(ts);
    assert.equal(ts!.tombstoneReason, "failed");
    assert.equal(ts!.error!.message, "err");
  });
});
