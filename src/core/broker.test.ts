import test from "node:test";
import assert from "node:assert/strict";

import { InMemoryA2ABroker, type TaskUpdate, type BufferedTaskEvent } from "./broker.js";
import { CURRENT_BROKER_STATE_VERSION, type BrokerSnapshot } from "./store.js";
import type { WorkerRecord } from "./types.js";

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

test("requeueStaleTasks caps requeues and dead-letters the task to failed", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { maxRequeueAttempts: 2 });
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

  // Drive three consecutive claim → stale-requeue cycles. The first two should succeed as
  // requeues; the third must dead-letter because the task has already been requeued twice.
  broker.claimTask(taskId, "worker-a");
  let result = broker.requeueStaleTasksDetailed(0);
  assert.equal(result.requeued.length, 1);
  assert.equal(result.deadLettered.length, 0);
  assert.equal(result.requeued[0].requeueCount, 1);

  broker.claimTask(taskId, "worker-a");
  result = broker.requeueStaleTasksDetailed(0);
  assert.equal(result.requeued.length, 1);
  assert.equal(result.deadLettered.length, 0);
  assert.equal(result.requeued[0].requeueCount, 2);

  broker.claimTask(taskId, "worker-a");
  result = broker.requeueStaleTasksDetailed(0);
  assert.equal(result.requeued.length, 0);
  assert.equal(result.deadLettered.length, 1);

  const deadLettered = result.deadLettered[0];
  assert.equal(deadLettered.status, "failed");
  assert.equal(deadLettered.error?.code, "exceeded_requeue_limit");
  assert.equal(deadLettered.requeueCount, 2);
  assert.ok(deadLettered.completedAt);

  const finalTask = broker.getTask(taskId);
  assert.ok(finalTask);
  assert.equal(finalTask.status, "failed");
  assert.equal(finalTask.error?.code, "exceeded_requeue_limit");

  // Dead-lettering should also close the linked exchange so operator dashboards do not keep
  // it pinned as running forever.
  const finalExchange = broker.getExchange(exchange.id);
  assert.ok(finalExchange);
  assert.equal(finalExchange.status, "failed");
});

test("maxRequeueAttempts=0 disables the cap and allows unlimited requeues", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { maxRequeueAttempts: 0 });
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

  for (let i = 0; i < 10; i++) {
    broker.claimTask(taskId, "worker-a");
    const { requeued, deadLettered } = broker.requeueStaleTasksDetailed(0);
    assert.equal(requeued.length, 1, `iteration ${i} should requeue`);
    assert.equal(deadLettered.length, 0, `iteration ${i} should not dead-letter`);
  }

  const finalTask = broker.getTask(taskId);
  assert.ok(finalTask);
  assert.equal(finalTask.status, "queued");
  assert.equal(finalTask.requeueCount, 10);
});

test("reassignTask resets requeueCount so the new target gets a fresh attempt budget", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { maxRequeueAttempts: 1 });
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
  const taskId = broker.getExchange(exchange.id)?.activeTaskId;
  assert.ok(taskId);

  // Burn the single requeue attempt worker-a gets.
  broker.claimTask(taskId, "worker-a");
  let result = broker.requeueStaleTasksDetailed(0);
  assert.equal(result.requeued[0].requeueCount, 1);

  // Operator reassigns to worker-b; the fresh target should not inherit the dead-letter
  // pressure from worker-a's flap.
  const reassigned = broker.reassignTask(taskId, {
    actor: { id: "ops", kind: "node", role: "operator" },
    targetNodeId: "worker-b",
    assignedWorkerId: "worker-b",
  });
  assert.equal(reassigned.requeueCount, 0);

  broker.claimTask(taskId, "worker-b");
  result = broker.requeueStaleTasksDetailed(0);
  assert.equal(result.requeued.length, 1, "reassigned task should be requeuable again");
  assert.equal(result.deadLettered.length, 0);
  assert.equal(result.requeued[0].requeueCount, 1);
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
  const statuses = new Set(dashboard.history.recent.map((r) => r.status));
  assert.ok(statuses.has("succeeded") && statuses.has("failed"));
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

test("retention prunes stale terminal state but preserves the newest referenced graph", () => {
  const oldIso = "2020-01-01T00:00:00.000Z";
  const newerOldIso = "2020-01-02T00:00:00.000Z";
  const workerCapabilities: WorkerRecord["capabilities"] = {
    canAnalyze: true,
    canBackfill: false,
    canPatchWorkspace: false,
    canPromoteLive: false,
    workspaceIds: ["test"],
    environments: ["research"],
  };
  const hub = { id: "hub-a", kind: "node" as const, role: "hub" as const };
  const retainedWorker = {
    id: "worker-ref",
    kind: "node" as const,
    role: "analyst" as const,
  };
  const prunedWorker = {
    id: "worker-pruned",
    kind: "node" as const,
    role: "analyst" as const,
  };

  const snapshot: BrokerSnapshot = {
    version: CURRENT_BROKER_STATE_VERSION,
    exchanges: [
      {
        id: "exchange-retained",
        requester: hub,
        target: retainedWorker,
        targetNodeId: retainedWorker.id,
        assignedWorkerId: retainedWorker.id,
        message: "keep me",
        maxTurns: 1,
        intent: "analyze",
        status: "completed",
        rootMessageId: "message-retained",
        latestMessageId: "message-retained",
        messageCount: 1,
        lastMessageAt: newerOldIso,
        activeTaskId: "task-retained",
        createdAt: oldIso,
        updatedAt: newerOldIso,
      },
      {
        id: "exchange-pruned",
        requester: hub,
        target: prunedWorker,
        targetNodeId: prunedWorker.id,
        assignedWorkerId: prunedWorker.id,
        message: "prune me",
        maxTurns: 1,
        intent: "analyze",
        status: "completed",
        rootMessageId: "message-pruned",
        latestMessageId: "message-pruned",
        messageCount: 1,
        lastMessageAt: oldIso,
        activeTaskId: "task-pruned",
        createdAt: oldIso,
        updatedAt: oldIso,
      },
    ],
    exchangeMessages: [
      {
        id: "message-retained",
        exchangeId: "exchange-retained",
        kind: "root",
        message: "keep me",
        requester: hub,
        targetNodeId: retainedWorker.id,
        createdAt: newerOldIso,
        updatedAt: newerOldIso,
      },
      {
        id: "message-pruned",
        exchangeId: "exchange-pruned",
        kind: "root",
        message: "prune me",
        requester: hub,
        targetNodeId: prunedWorker.id,
        createdAt: oldIso,
        updatedAt: oldIso,
      },
    ],
    proposals: [
      {
        id: "proposal-retained",
        source: retainedWorker,
        target: retainedWorker,
        sourceNodeId: retainedWorker.id,
        targetNodeId: retainedWorker.id,
        kind: "patch",
        summary: "keep me",
        workspace: { nodeId: retainedWorker.id, workspaceId: "ws-1" },
        artifactIds: ["artifact-retained"],
        status: "applied",
        createdAt: oldIso,
        updatedAt: oldIso,
      },
      {
        id: "proposal-pruned",
        source: prunedWorker,
        target: prunedWorker,
        sourceNodeId: prunedWorker.id,
        targetNodeId: prunedWorker.id,
        kind: "patch",
        summary: "prune me",
        workspace: { nodeId: prunedWorker.id, workspaceId: "ws-2" },
        artifactIds: ["artifact-pruned"],
        status: "applied",
        createdAt: oldIso,
        updatedAt: oldIso,
      },
    ],
    artifacts: [
      {
        id: "artifact-retained",
        proposalId: "proposal-retained",
        kind: "diff",
        uri: "file:///retained.patch",
        createdAt: oldIso,
      },
      {
        id: "artifact-pruned",
        proposalId: "proposal-pruned",
        kind: "diff",
        uri: "file:///pruned.patch",
        createdAt: oldIso,
      },
    ],
    validations: [
      {
        id: "validation-retained",
        proposalId: "proposal-retained",
        nodeId: retainedWorker.id,
        kind: "smoke",
        verdict: "pass",
        metrics: {},
        artifactIds: ["artifact-retained"],
        createdAt: oldIso,
      },
      {
        id: "validation-pruned",
        proposalId: "proposal-pruned",
        nodeId: prunedWorker.id,
        kind: "smoke",
        verdict: "pass",
        metrics: {},
        artifactIds: ["artifact-pruned"],
        createdAt: oldIso,
      },
    ],
    auditEvents: [
      {
        id: "audit-retained",
        actorId: retainedWorker.id,
        action: "task.succeeded",
        targetType: "task",
        targetId: "task-retained",
        proposalId: "proposal-retained",
        createdAt: oldIso,
      },
      {
        id: "audit-pruned",
        actorId: prunedWorker.id,
        action: "task.succeeded",
        targetType: "task",
        targetId: "task-pruned",
        proposalId: "proposal-pruned",
        createdAt: oldIso,
      },
    ],
    workers: [
      {
        nodeId: retainedWorker.id,
        role: retainedWorker.role,
        capabilities: workerCapabilities,
        createdAt: oldIso,
        updatedAt: oldIso,
        lastSeenAt: oldIso,
      },
      {
        nodeId: prunedWorker.id,
        role: prunedWorker.role,
        capabilities: workerCapabilities,
        createdAt: oldIso,
        updatedAt: oldIso,
        lastSeenAt: oldIso,
      },
    ],
    tasks: [
      {
        id: "task-retained",
        exchangeId: "exchange-retained",
        intent: "analyze",
        requester: hub,
        target: retainedWorker,
        message: "keep me",
        proposalId: "proposal-retained",
        artifactIds: ["artifact-retained"],
        assignedWorkerId: retainedWorker.id,
        createdAt: oldIso,
        status: "succeeded",
        targetNodeId: retainedWorker.id,
        payload: {},
        updatedAt: newerOldIso,
        completedAt: newerOldIso,
        claimedBy: retainedWorker.id,
        result: {
          summary: "done",
          artifactIds: ["artifact-retained"],
        },
      },
      {
        id: "task-pruned",
        exchangeId: "exchange-pruned",
        intent: "analyze",
        requester: hub,
        target: prunedWorker,
        message: "prune me",
        proposalId: "proposal-pruned",
        artifactIds: ["artifact-pruned"],
        assignedWorkerId: prunedWorker.id,
        createdAt: oldIso,
        status: "succeeded",
        targetNodeId: prunedWorker.id,
        payload: {},
        updatedAt: oldIso,
        completedAt: oldIso,
        claimedBy: prunedWorker.id,
      },
    ],
  };

  const broker = new InMemoryA2ABroker(undefined, snapshot, {
    retention: {
      terminalRetentionMs: 0,
      maxTerminalExchanges: 0,
      maxTerminalTasks: 1,
      maxTerminalProposals: 0,
      inactiveWorkerRetentionMs: 0,
      maxInactiveWorkers: 0,
      auditRetentionMs: 0,
      maxAuditEvents: 0,
    },
  });

  const retained = broker.exportSnapshot();

  assert.deepEqual(retained.exchanges.map((exchange) => exchange.id), ["exchange-retained"]);
  assert.deepEqual(retained.exchangeMessages.map((message) => message.id), ["message-retained"]);
  assert.deepEqual(retained.tasks.map((task) => task.id), ["task-retained"]);
  assert.deepEqual(retained.proposals.map((proposal) => proposal.id), ["proposal-retained"]);
  assert.deepEqual(retained.artifacts.map((artifact) => artifact.id), ["artifact-retained"]);
  assert.deepEqual(retained.validations.map((validation) => validation.id), ["validation-retained"]);
  assert.deepEqual(retained.auditEvents.map((event) => event.id), ["audit-retained"]);
  assert.deepEqual(retained.workers.map((worker) => worker.nodeId), [retainedWorker.id]);
});

test("subscribeToTask streams lifecycle updates and marks terminal events final", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "run analysis",
  });

  const updates: TaskUpdate[] = [];
  const unsubscribe = broker.subscribeToTask(task.id, (update) => {
    updates.push(update);
  });

  broker.claimTask(task.id, "worker-a");
  broker.startTask(task.id, "worker-a");
  broker.completeTask(task.id, "worker-a", { summary: "done" });

  unsubscribe();

  assert.deepEqual(
    updates.map((u) => u.reason),
    ["claimed", "started", "succeeded"],
  );
  assert.deepEqual(
    updates.map((u) => u.task.status),
    ["claimed", "running", "succeeded"],
  );
  assert.deepEqual(
    updates.map((u) => u.final),
    [false, false, true],
  );
  // Snapshot safety: mutating the delivered task should not affect broker state.
  updates[0].task.status = "canceled";
  assert.equal(broker.getTask(task.id)?.status, "succeeded");
});

test("subscribeToTask emits dead_lettered and requeued updates during stale recovery", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { maxRequeueAttempts: 1 });
  registerWorker(broker, "worker-a");

  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "run analysis",
  });
  broker.claimTask(task.id, "worker-a");

  const updates: TaskUpdate[] = [];
  const unsubscribe = broker.subscribeToTask(task.id, (update) => {
    updates.push(update);
  });

  // First sweep requeues (within cap).
  broker.requeueStaleTasksDetailed(0, { nowMs: Date.now() + 60_000 });
  // Second sweep dead-letters because requeueCount already matches maxRequeueAttempts=1.
  broker.claimTask(task.id, "worker-a");
  broker.requeueStaleTasksDetailed(0, { nowMs: Date.now() + 120_000 });

  unsubscribe();

  const reasons = updates.map((u) => u.reason);
  assert.ok(reasons.includes("requeued"), `expected requeued in ${reasons.join(",")}`);
  assert.ok(reasons.includes("dead_lettered"), `expected dead_lettered in ${reasons.join(",")}`);
  const terminal = updates.find((u) => u.reason === "dead_lettered");
  assert.ok(terminal);
  assert.equal(terminal.final, true);
  assert.equal(terminal.task.status, "failed");
});

test("subscribeToTask unsubscribe stops further deliveries", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");
  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "run analysis",
  });

  const updates: TaskUpdate[] = [];
  const unsubscribe = broker.subscribeToTask(task.id, (update) => {
    updates.push(update);
  });

  broker.claimTask(task.id, "worker-a");
  unsubscribe();
  broker.startTask(task.id, "worker-a");

  assert.deepEqual(
    updates.map((u) => u.reason),
    ["claimed"],
  );
});

test("subscribeToTask includes monotonically increasing seq numbers", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "run analysis",
  });

  const updates: TaskUpdate[] = [];
  const unsubscribe = broker.subscribeToTask(task.id, (update) => {
    updates.push(update);
  });

  broker.claimTask(task.id, "worker-a");
  broker.startTask(task.id, "worker-a");
  broker.completeTask(task.id, "worker-a", { summary: "done" });

  unsubscribe();

  assert.ok(updates.length === 3);
  assert.ok(updates[0].seq < updates[1].seq);
  assert.ok(updates[1].seq < updates[2].seq);
});

test("replayTaskEvents returns events buffered after the given seq", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "run analysis",
  });

  // Subscribe to trigger buffering.
  const updates: TaskUpdate[] = [];
  const unsubscribe = broker.subscribeToTask(task.id, (update) => {
    updates.push(update);
  });

  broker.claimTask(task.id, "worker-a");
  broker.startTask(task.id, "worker-a");
  broker.completeTask(task.id, "worker-a", { summary: "done" });

  unsubscribe();

  // Replay from seq 0 should return events with seq > 0.
  const replayed = broker.replayTaskEvents(task.id, 0);
  assert.ok(replayed.length >= 2);
  for (const event of replayed) {
    assert.ok(event.seq > 0);
  }
});

test("replayTaskEvents returns empty for unknown task", () => {
  const broker = new InMemoryA2ABroker();
  const replayed = broker.replayTaskEvents("nonexistent", 0);
  assert.deepEqual(replayed, []);
});

test("formatSseEventId and parseSseEventId round-trip", () => {
  const broker = new InMemoryA2ABroker();
  const id = broker.formatSseEventId("task-abc", 42);
  assert.equal(id, "task-abc:42");
  const parsed = broker.parseSseEventId(id);
  assert.deepEqual(parsed, { taskId: "task-abc", seq: 42 });
});

test("parseSseEventId returns null for malformed values", () => {
  const broker = new InMemoryA2ABroker();
  assert.equal(broker.parseSseEventId(""), null);
  assert.equal(broker.parseSseEventId("no-colon"), null);
  assert.equal(broker.parseSseEventId(":123"), null);
  assert.equal(broker.parseSseEventId("task:notanumber"), null);
});

test("event buffer respects maxBufferedEventsPerTask limit", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, {
    maxBufferedEventsPerTask: 3,
  });
  registerWorker(broker, "worker-a");

  // Create multiple tasks and drive lifecycle to generate events.
  for (let i = 0; i < 5; i++) {
    const task = broker.createTask({
      intent: "analyze",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-a", kind: "node", role: "analyst" },
      assignedWorkerId: "worker-a",
      message: `run analysis ${i}`,
    });
    broker.claimTask(task.id, "worker-a");
    broker.startTask(task.id, "worker-a");
    broker.completeTask(task.id, "worker-a", { summary: `done ${i}` });
  }

  // Pick the first task and verify buffer is capped at 3.
  const allTasks = broker.listTasks({});
  const firstTask = allTasks[0];
  const allEvents = broker.replayTaskEvents(firstTask.id, -1);
  assert.ok(allEvents.length <= 3, `expected <= 3 events, got ${allEvents.length}`);
});

