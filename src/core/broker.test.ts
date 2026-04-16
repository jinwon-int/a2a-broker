import test from "node:test";
import assert from "node:assert/strict";

import { InMemoryA2ABroker } from "./broker.js";

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

test("accepted exchange thread creates and links an exchange task", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const exchange = broker.startExchange({
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    message: "run analysis",
    intent: "analyze",
  });

  const threadMessage = broker.addExchangeMessage(exchange.id, {
    actor: { id: "hub-a", kind: "node", role: "hub" },
    message: "accepted for worker-a",
    decision: "accepted",
    targetNodeId: "worker-a",
    assignedWorkerId: "worker-a",
  });

  const refreshedExchange = broker.getExchange(exchange.id);
  assert.ok(refreshedExchange);
  assert.equal(refreshedExchange.status, "running");
  assert.equal(refreshedExchange.currentDecision, "accepted");
  assert.equal(refreshedExchange.assignedWorkerId, "worker-a");
  assert.equal(refreshedExchange.latestMessageId, threadMessage.id);
  assert.ok(refreshedExchange.activeTaskId);

  const linkedTask = broker.getTask(refreshedExchange.activeTaskId);
  assert.ok(linkedTask);
  assert.equal(linkedTask.exchangeId, exchange.id);
  assert.equal(linkedTask.assignedWorkerId, "worker-a");
  assert.equal(linkedTask.status, "queued");
});

test("needs_clarification cancels active exchange task and returns exchange to queued", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const exchange = broker.startExchange({
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    message: "run analysis",
    intent: "analyze",
  });

  broker.addExchangeMessage(exchange.id, {
    actor: { id: "hub-a", kind: "node", role: "hub" },
    message: "accepted",
    decision: "accepted",
    targetNodeId: "worker-a",
    assignedWorkerId: "worker-a",
  });

  broker.addExchangeMessage(exchange.id, {
    actor: { id: "worker-a", kind: "node", role: "analyst" },
    message: "need more detail",
    decision: "needs_clarification",
  });

  const refreshedExchange = broker.getExchange(exchange.id);
  assert.ok(refreshedExchange);
  assert.equal(refreshedExchange.status, "queued");
  assert.equal(refreshedExchange.currentDecision, "needs_clarification");
  assert.ok(refreshedExchange.activeTaskId);

  const linkedTask = broker.getTask(refreshedExchange.activeTaskId);
  assert.ok(linkedTask);
  assert.equal(linkedTask.status, "canceled");
});

test("partially_accepted keeps exchange running with an active task", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const exchange = broker.startExchange({
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    message: "run analysis",
    intent: "analyze",
  });

  broker.addExchangeMessage(exchange.id, {
    actor: { id: "hub-a", kind: "node", role: "hub" },
    message: "partial accept",
    decision: "partially_accepted",
    targetNodeId: "worker-a",
    assignedWorkerId: "worker-a",
  });

  const refreshedExchange = broker.getExchange(exchange.id);
  assert.ok(refreshedExchange);
  assert.equal(refreshedExchange.status, "running");
  assert.equal(refreshedExchange.currentDecision, "partially_accepted");
  assert.ok(refreshedExchange.activeTaskId);
});

test("declined marks exchange failed and cancels any active task", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const exchange = broker.startExchange({
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    message: "run analysis",
    intent: "analyze",
  });

  broker.addExchangeMessage(exchange.id, {
    actor: { id: "hub-a", kind: "node", role: "hub" },
    message: "accepted",
    decision: "accepted",
    targetNodeId: "worker-a",
    assignedWorkerId: "worker-a",
  });

  broker.addExchangeMessage(exchange.id, {
    actor: { id: "hub-a", kind: "node", role: "hub" },
    message: "declined",
    decision: "declined",
  });

  const refreshedExchange = broker.getExchange(exchange.id);
  assert.ok(refreshedExchange);
  assert.equal(refreshedExchange.status, "failed");
  assert.equal(refreshedExchange.currentDecision, "declined");
  assert.ok(refreshedExchange.activeTaskId);

  const linkedTask = broker.getTask(refreshedExchange.activeTaskId);
  assert.ok(linkedTask);
  assert.equal(linkedTask.status, "canceled");
});

test("stale requeue keeps assignedWorkerId unchanged", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const exchange = broker.startExchange({
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    message: "run analysis",
    intent: "analyze",
  });

  broker.addExchangeMessage(exchange.id, {
    actor: { id: "hub-a", kind: "node", role: "hub" },
    message: "accepted",
    decision: "accepted",
    targetNodeId: "worker-a",
    assignedWorkerId: "worker-a",
  });

  const taskId = broker.getExchange(exchange.id)?.activeTaskId;
  assert.ok(taskId);
  const task = broker.getTask(taskId);
  assert.ok(task);
  broker.claimTask(task.id, "worker-a");
  const requeued = broker.requeueStaleTasks(0, { nowMs: Date.now() });
  assert.equal(requeued.length, 1);
  assert.equal(requeued[0].assignedWorkerId, "worker-a");
  assert.equal(requeued[0].status, "queued");
});

test("completing an accepted exchange task marks the exchange completed", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const exchange = broker.startExchange({
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    message: "run analysis",
    intent: "analyze",
  });

  broker.addExchangeMessage(exchange.id, {
    actor: { id: "hub-a", kind: "node", role: "hub" },
    message: "accepted",
    decision: "accepted",
    targetNodeId: "worker-a",
    assignedWorkerId: "worker-a",
  });

  const taskId = broker.getExchange(exchange.id)?.activeTaskId;
  assert.ok(taskId);

  broker.claimTask(taskId, "worker-a");
  broker.startTask(taskId, "worker-a");
  const completedTask = broker.completeTask(taskId, "worker-a", {
    summary: "analysis complete",
    artifactIds: ["artifact-1"],
  });

  assert.equal(completedTask.status, "succeeded");
  assert.deepEqual(completedTask.artifactIds, ["artifact-1"]);

  const refreshedExchange = broker.getExchange(exchange.id);
  assert.ok(refreshedExchange);
  assert.equal(refreshedExchange.status, "completed");
  assert.equal(refreshedExchange.activeTaskId, taskId);
  assert.equal(refreshedExchange.assignedWorkerId, "worker-a");
  assert.equal(refreshedExchange.currentDecision, "accepted");
});

test("routing update reassigns the active exchange task instead of creating a new one", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");
  registerWorker(broker, "worker-b");

  const exchange = broker.startExchange({
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    message: "run analysis",
    intent: "analyze",
  });

  broker.addExchangeMessage(exchange.id, {
    actor: { id: "hub-a", kind: "node", role: "hub" },
    message: "accepted",
    decision: "accepted",
    targetNodeId: "worker-a",
    assignedWorkerId: "worker-a",
  });

  const originalTaskId = broker.getExchange(exchange.id)?.activeTaskId;
  assert.ok(originalTaskId);

  const rerouteMessage = broker.addExchangeMessage(exchange.id, {
    actor: { id: "hub-a", kind: "node", role: "hub" },
    message: "route this to worker-b",
    targetNodeId: "worker-b",
    assignedWorkerId: "worker-b",
  });

  const refreshedExchange = broker.getExchange(exchange.id);
  assert.ok(refreshedExchange);
  assert.equal(refreshedExchange.status, "queued");
  assert.equal(refreshedExchange.latestMessageId, rerouteMessage.id);
  assert.equal(refreshedExchange.activeTaskId, originalTaskId);
  assert.equal(refreshedExchange.targetNodeId, "worker-b");
  assert.equal(refreshedExchange.assignedWorkerId, "worker-b");

  const task = broker.getTask(originalTaskId);
  assert.ok(task);
  assert.equal(task.status, "queued");
  assert.equal(task.targetNodeId, "worker-b");
  assert.equal(task.assignedWorkerId, "worker-b");
  assert.equal(task.claimedBy, undefined);
  assert.equal(broker.listTasks({ exchangeId: exchange.id }).length, 1);
});

test("getDashboard returns aggregated queue, history, proposals, and workers", () => {
  const nowMs = Date.now();
  const broker = new InMemoryA2ABroker();

  // Register workers
  broker.registerWorker({
    nodeId: "w-online",
    role: "analyst",
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: false,
      canPromoteLive: false,
      workspaceIds: ["ws1"],
      environments: ["research"],
    },
    metadata: {},
  });

  broker.registerWorker({
    nodeId: "w-stale",
    role: "researcher",
    capabilities: {
      canAnalyze: true,
      canBackfill: true,
      canPatchWorkspace: false,
      canPromoteLive: false,
      workspaceIds: ["ws1"],
      environments: ["research"],
    },
    metadata: {},
  });

  // Create tasks in various states
  broker.createTask({
    intent: "analyze",
    requester: { id: "hub-1", kind: "node", role: "hub" },
    target: { id: "w-online", kind: "node", role: "analyst" },
    assignedWorkerId: "w-online",
    message: "task-queued-1",
  });
  broker.createTask({
    intent: "backfill",
    requester: { id: "hub-1", kind: "node", role: "hub" },
    target: { id: "w-online", kind: "node", role: "analyst" },
    assignedWorkerId: "w-online",
    message: "task-queued-2",
  });

  const dashboard = broker.getDashboard({
    nowMs,
    offlineAfterMs: 90_000,
    recentHistoryLimit: 5,
    oldestPendingLimit: 3,
    pendingActionLimit: 5,
  });

  // Queue
  assert.equal(dashboard.queue.total, 2);
  assert.equal(dashboard.queue.byStatus["queued"], 2);
  assert.equal(dashboard.queue.oldestPending.length, 2);

  // History (no completed tasks yet)
  assert.equal(dashboard.history.totalCompleted, 0);
  assert.equal(dashboard.history.totalFailed, 0);
  assert.equal(dashboard.history.recent.length, 0);

  // Proposals (none yet)
  assert.equal(dashboard.proposals.total, 0);

  // Workers (both registerWorker calls use isoNow(), so both have same lastSeenAt → both online)
  assert.equal(dashboard.workers.total, 2);
  assert.equal(dashboard.workers.online, 2);
  assert.equal(dashboard.workers.stale, 0);
  assert.ok(dashboard.workers.byNode.find((w) => w.nodeId === "w-online")!.status === "online");
  assert.ok(dashboard.workers.byNode.find((w) => w.nodeId === "w-stale")!.status === "online");

  // Timestamp
  assert.ok(new Date(dashboard.generatedAt).getTime() > 0);
});

test("getDashboard history tracks completed and failed tasks", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "w1");

  const task1 = broker.createTask({
    intent: "analyze",
    requester: { id: "hub-1", kind: "node", role: "hub" },
    target: { id: "w1", kind: "node", role: "analyst" },
    assignedWorkerId: "w1",
    message: "success-task",
  });
  broker.claimTask(task1.id, "w1");
  broker.completeTask(task1.id, "w1", { summary: "done" });

  const task2 = broker.createTask({
    intent: "backfill",
    requester: { id: "hub-1", kind: "node", role: "hub" },
    target: { id: "w1", kind: "node", role: "analyst" },
    assignedWorkerId: "w1",
    message: "fail-task",
  });
  broker.claimTask(task2.id, "w1");
  broker.failTask(task2.id, "w1", { code: "timeout", message: "took too long" });

  const dashboard = broker.getDashboard({ nowMs: Date.now() });

  assert.equal(dashboard.history.totalCompleted, 1);
  assert.equal(dashboard.history.totalFailed, 1);
  assert.equal(dashboard.history.recent.length, 2);
  const statuses = dashboard.history.recent.map((r) => r.status);
  assert.ok(statuses.includes("succeeded") && statuses.includes("failed"));
  const succeeded = dashboard.history.recent.find((r) => r.status === "succeeded")!;
  const failed = dashboard.history.recent.find((r) => r.status === "failed")!;
  assert.ok(succeeded.result?.summary === "done");
  assert.ok(failed.error?.code === "timeout");
});

test("getDashboard proposals shows pending action items", () => {
  const broker = new InMemoryA2ABroker();
  broker.registerWorker({
    nodeId: "w1",
    role: "analyst",
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: false,
      canPromoteLive: false,
      workspaceIds: ["ws1"],
      environments: ["research"],
    },
  });
  broker.registerWorker({
    nodeId: "w2",
    role: "live-trader",
    capabilities: {
      canAnalyze: false,
      canBackfill: false,
      canPatchWorkspace: true,
      canPromoteLive: true,
      workspaceIds: ["ws1"],
      environments: ["live"],
    },
  });

  // submitted proposal (needs validation)
  broker.createProposal({
    source: { id: "w1", kind: "node", role: "analyst" },
    target: { id: "w2", kind: "node", role: "live-trader" },
    kind: "patch",
    summary: "fix signal threshold",
    workspace: { nodeId: "w2", workspaceId: "ws1" },
    patchText: "diff --git a/config.ts ...",
  });

  const dashboard = broker.getDashboard({ nowMs: Date.now() });

  assert.equal(dashboard.proposals.total, 1);
  assert.equal(dashboard.proposals.byStatus["submitted"], 1);
  assert.equal(dashboard.proposals.pendingAction.length, 1);
  assert.equal(dashboard.proposals.pendingAction[0].status, "submitted");
});

test("getDashboard workers shows active task counts", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "w1");

  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub-1", kind: "node", role: "hub" },
    target: { id: "w1", kind: "node", role: "analyst" },
    assignedWorkerId: "w1",
    message: "active-task",
  });
  broker.claimTask(task.id, "w1");

  const dashboard = broker.getDashboard({ nowMs: Date.now() });

  const w1 = dashboard.workers.byNode.find((w) => w.nodeId === "w1")!;
  assert.equal(w1.activeTaskCount, 1);
  assert.equal(w1.role, "analyst");
});
