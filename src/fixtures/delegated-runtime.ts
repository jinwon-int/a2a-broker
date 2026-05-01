/**
 * Delegated runtime regression fixtures for the A2A broker.
 *
 * Each fixture represents a named runtime state that the broker's delegated
 * task lifecycle can enter. These are intentionally explicit — not just
 * status snapshots, but full broker states with workers, exchanges, tasks,
 * and audit trails — so they act as change detectors for behavioral drift.
 *
 * Usage in tests:
 *   import { buildWaitingState, buildTombstonedState } from "../fixtures/delegated-runtime.js";
 *   const broker = loadBrokerFromFixture(buildWaitingState());
 *   // assert behavioral invariants...
 *
 * @see jinwon-int/a2a-broker#22
 * @see jinwon-int/openclaw#15 (dashboard read-surface coverage)
 */

import { randomUUID } from "node:crypto";
import type { BrokerSnapshot } from "../core/store.js";
import type {
  A2APartyRef,
  A2AExchangeState,
  A2AExchangeMessageRecord,
  AuditEvent,
  TaskRecord,
  WorkerRecord,
} from "../core/types.js";

// ---------------------------------------------------------------------------
// Shared builders
// ---------------------------------------------------------------------------

const HUB: A2APartyRef = { id: "hub-regression", kind: "node", role: "hub" };
const OPERATOR: A2APartyRef = { id: "ops-regression", kind: "node", role: "operator" };

function worker(
  nodeId: string,
  overrides: Partial<WorkerRecord> = {},
): WorkerRecord {
  return {
    nodeId,
    role: "analyst",
    displayName: `${nodeId} (regression)`,
    capabilities: {
      canAnalyze: true,
      canBackfill: true,
      canPatchWorkspace: false,
      canPromoteLive: false,
      workspaceIds: ["regression-ws"],
      environments: ["research"],
    },
    metadata: {},
    createdAt: "2026-04-19T00:00:00.000Z",
    updatedAt: "2026-04-19T00:00:00.000Z",
    lastSeenAt: "2026-04-19T00:00:00.000Z",
    ...overrides,
  };
}

function baseTask(
  exchangeId: string,
  overrides: Partial<TaskRecord> = {},
): TaskRecord & { id: string } {
  const id = randomUUID();
  return {
    id,
    exchangeId,
    intent: "analyze",
    requester: HUB,
    target: { id: "worker-regression", kind: "node", role: "analyst" },
    targetNodeId: "worker-regression",
    assignedWorkerId: "worker-regression",
    workspace: { nodeId: "worker-regression", workspaceId: "regression-ws" },
    message: "regression test task",
    payload: {},
    status: "queued",
    createdAt: "2026-04-19T01:00:00.000Z",
    updatedAt: "2026-04-19T01:00:00.000Z",
    ...overrides,
  };
}

function baseExchange(
  _taskId: string,
  overrides: Partial<A2AExchangeState> = {},
): A2AExchangeState & { id: string } {
  const id = randomUUID();
  return {
    id,
    requester: HUB,
    target: { id: "worker-regression", kind: "node", role: "analyst" },
    targetNodeId: "worker-regression",
    assignedWorkerId: "worker-regression",
    message: "regression exchange",
    maxTurns: 8,
    intent: "analyze",
    status: "queued",
    rootMessageId: randomUUID(),
    latestMessageId: randomUUID(),
    messageCount: 1,
    lastMessageAt: "2026-04-19T01:00:00.000Z",
    activeTaskId: undefined as unknown as string,
    createdAt: "2026-04-19T01:00:00.000Z",
    updatedAt: "2026-04-19T01:00:00.000Z",
    ...overrides,
  };
}

function rootMessage(
  exchangeId: string,
  overrides: Partial<A2AExchangeMessageRecord> = {},
): A2AExchangeMessageRecord & { id: string } {
  const id = randomUUID();
  return {
    id,
    exchangeId,
    kind: "root",
    message: "regression root message",
    requester: HUB,
    targetNodeId: "worker-regression",
    createdAt: "2026-04-19T01:00:00.000Z",
    updatedAt: "2026-04-19T01:00:00.000Z",
    ...overrides,
  };
}

function acceptMessage(
  exchangeId: string,
  parentId: string,
  overrides: Partial<A2AExchangeMessageRecord> = {},
): A2AExchangeMessageRecord & { id: string } {
  const id = randomUUID();
  return {
    id,
    exchangeId,
    kind: "thread",
    message: "accepted for regression worker",
    actor: HUB,
    decision: "accepted",
    targetNodeId: "worker-regression",
    assignedWorkerId: "worker-regression",
    parentMessageId: parentId,
    createdAt: "2026-04-19T01:00:01.000Z",
    updatedAt: "2026-04-19T01:00:01.000Z",
    ...overrides,
  };
}

function audit(
  overrides: Partial<AuditEvent> = {},
): AuditEvent & { id: string } {
  const id = randomUUID();
  return {
    id,
    actorId: "hub-regression",
    action: "task.created",
    targetType: "task",
    targetId: "",
    createdAt: "2026-04-19T01:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fixture factories — one per delegated runtime state
// ---------------------------------------------------------------------------

/**
 * **waiting** — Task is queued, exchange is queued, worker has not claimed yet.
 * Represents the initial state after delegation dispatch.
 */
export function buildWaitingState(): BrokerSnapshot {
  const exchange = baseExchange("");
  const task = baseTask(exchange.id);
  exchange.activeTaskId = task.id;
  const rootMsg = rootMessage(exchange.id);
  const acceptMsg = acceptMessage(exchange.id, rootMsg.id);

  // Fix up cross-references
  exchange.rootMessageId = rootMsg.id;
  exchange.latestMessageId = acceptMsg.id;
  exchange.messageCount = 2;
  exchange.lastMessageAt = acceptMsg.createdAt;

  return {
    version: 1,
    workers: [worker("worker-regression")],
    exchanges: [exchange],
    exchangeMessages: [rootMsg, acceptMsg],
    tasks: [task],
    proposals: [],
    artifacts: [],
    validations: [],
    auditEvents: [
      audit({ action: "worker.registered", targetType: "worker", targetId: "worker-regression" }),
      audit({ action: "exchange.message.added", targetType: "exchange-message", targetId: rootMsg.id }),
      audit({ action: "exchange.message.added", targetType: "exchange-message", targetId: acceptMsg.id }),
      audit({ action: "task.created", targetType: "task", targetId: task.id, note: task.message }),
    ],
  };
}

/**
 * **resumed** — Task is running, worker has claimed and started.
 * Represents the active execution state after a worker picks up the task.
 */
export function buildResumedState(): BrokerSnapshot {
  const exchange = baseExchange("", {
    status: "running",
    currentDecision: "accepted",
    updatedAt: "2026-04-19T01:00:01.000Z",
  });
  const task = baseTask(exchange.id, {
    status: "running",
    claimedBy: "worker-regression",
    claimedAt: "2026-04-19T01:00:02.000Z",
    updatedAt: "2026-04-19T01:00:02.000Z",
  });
  exchange.activeTaskId = task.id;
  const rootMsg = rootMessage(exchange.id);
  const acceptMsg = acceptMessage(exchange.id, rootMsg.id);

  exchange.rootMessageId = rootMsg.id;
  exchange.latestMessageId = acceptMsg.id;
  exchange.messageCount = 2;
  exchange.lastMessageAt = acceptMsg.createdAt;

  return {
    version: 1,
    workers: [worker("worker-regression")],
    exchanges: [exchange],
    exchangeMessages: [rootMsg, acceptMsg],
    tasks: [task],
    proposals: [],
    artifacts: [],
    validations: [],
    auditEvents: [
      audit({ action: "worker.registered", targetType: "worker", targetId: "worker-regression" }),
      audit({ action: "exchange.message.added", targetType: "exchange-message", targetId: rootMsg.id }),
      audit({ action: "exchange.message.added", targetType: "exchange-message", targetId: acceptMsg.id }),
      audit({ action: "task.created", targetType: "task", targetId: task.id }),
      audit({ actorId: "worker-regression", action: "task.claimed", targetType: "task", targetId: task.id, createdAt: "2026-04-19T01:00:02.000Z" }),
      audit({ actorId: "worker-regression", action: "task.started", targetType: "task", targetId: task.id, createdAt: "2026-04-19T01:00:02.000Z" }),
    ],
  };
}

/**
 * **completed** — Task succeeded with a result. Exchange is completed.
 */
export function buildCompletedState(): BrokerSnapshot {
  const exchange = baseExchange("", {
    status: "completed",
    currentDecision: "accepted",
    updatedAt: "2026-04-19T01:00:05.000Z",
  });
  const task = baseTask(exchange.id, {
    status: "succeeded",
    claimedBy: "worker-regression",
    claimedAt: "2026-04-19T01:00:02.000Z",
    completedAt: "2026-04-19T01:00:05.000Z",
    updatedAt: "2026-04-19T01:00:05.000Z",
    result: {
      summary: "analysis complete",
      artifactIds: ["artifact-regression-1"],
    },
    artifactIds: ["artifact-regression-1"],
  });
  exchange.activeTaskId = task.id;
  const rootMsg = rootMessage(exchange.id);
  const acceptMsg = acceptMessage(exchange.id, rootMsg.id);

  exchange.rootMessageId = rootMsg.id;
  exchange.latestMessageId = acceptMsg.id;
  exchange.messageCount = 2;
  exchange.lastMessageAt = acceptMsg.createdAt;

  return {
    version: 1,
    workers: [worker("worker-regression")],
    exchanges: [exchange],
    exchangeMessages: [rootMsg, acceptMsg],
    tasks: [task],
    proposals: [],
    artifacts: [],
    validations: [],
    auditEvents: [
      audit({ action: "worker.registered", targetType: "worker", targetId: "worker-regression" }),
      audit({ action: "exchange.message.added", targetType: "exchange-message", targetId: rootMsg.id }),
      audit({ action: "exchange.message.added", targetType: "exchange-message", targetId: acceptMsg.id }),
      audit({ action: "task.created", targetType: "task", targetId: task.id }),
      audit({ actorId: "worker-regression", action: "task.claimed", targetType: "task", targetId: task.id, createdAt: "2026-04-19T01:00:02.000Z" }),
      audit({ actorId: "worker-regression", action: "task.started", targetType: "task", targetId: task.id, createdAt: "2026-04-19T01:00:02.000Z" }),
      audit({ actorId: "worker-regression", action: "task.succeeded", targetType: "task", targetId: task.id, note: "analysis complete", createdAt: "2026-04-19T01:00:05.000Z" }),
    ],
  };
}

/**
 * **failed** — Task failed with an error. Exchange is failed.
 */
export function buildFailedState(): BrokerSnapshot {
  const exchange = baseExchange("", {
    status: "failed",
    currentDecision: "accepted",
    updatedAt: "2026-04-19T01:00:04.000Z",
  });
  const task = baseTask(exchange.id, {
    status: "failed",
    claimedBy: "worker-regression",
    claimedAt: "2026-04-19T01:00:02.000Z",
    completedAt: "2026-04-19T01:00:04.000Z",
    updatedAt: "2026-04-19T01:00:04.000Z",
    error: {
      code: "handler_error",
      message: "analysis pipeline crashed",
      details: { stack: "at regression (test)" },
    },
  });
  exchange.activeTaskId = task.id;
  const rootMsg = rootMessage(exchange.id);
  const acceptMsg = acceptMessage(exchange.id, rootMsg.id);

  exchange.rootMessageId = rootMsg.id;
  exchange.latestMessageId = acceptMsg.id;
  exchange.messageCount = 2;
  exchange.lastMessageAt = acceptMsg.createdAt;

  return {
    version: 1,
    workers: [worker("worker-regression")],
    exchanges: [exchange],
    exchangeMessages: [rootMsg, acceptMsg],
    tasks: [task],
    proposals: [],
    artifacts: [],
    validations: [],
    auditEvents: [
      audit({ action: "worker.registered", targetType: "worker", targetId: "worker-regression" }),
      audit({ action: "exchange.message.added", targetType: "exchange-message", targetId: rootMsg.id }),
      audit({ action: "exchange.message.added", targetType: "exchange-message", targetId: acceptMsg.id }),
      audit({ action: "task.created", targetType: "task", targetId: task.id }),
      audit({ actorId: "worker-regression", action: "task.claimed", targetType: "task", targetId: task.id, createdAt: "2026-04-19T01:00:02.000Z" }),
      audit({ actorId: "worker-regression", action: "task.started", targetType: "task", targetId: task.id, createdAt: "2026-04-19T01:00:02.000Z" }),
      audit({ actorId: "worker-regression", action: "task.failed", targetType: "task", targetId: task.id, note: "analysis pipeline crashed", createdAt: "2026-04-19T01:00:04.000Z" }),
    ],
  };
}

/**
 * **canceled** — Task was canceled by an operator or requester.
 * Exchange returns to queued. Active task is canceled.
 */
export function buildCanceledState(): BrokerSnapshot {
  const exchange = baseExchange("", {
    status: "queued",
    currentDecision: "accepted",
    updatedAt: "2026-04-19T01:00:03.000Z",
  });
  const task = baseTask(exchange.id, {
    status: "canceled",
    claimedBy: "worker-regression",
    claimedAt: "2026-04-19T01:00:02.000Z",
    completedAt: "2026-04-19T01:00:03.000Z",
    updatedAt: "2026-04-19T01:00:03.000Z",
    error: {
      code: "canceled",
      message: "canceled by operator: manual stop requested",
    },
  });
  exchange.activeTaskId = task.id;
  const rootMsg = rootMessage(exchange.id);
  const acceptMsg = acceptMessage(exchange.id, rootMsg.id);

  exchange.rootMessageId = rootMsg.id;
  exchange.latestMessageId = acceptMsg.id;
  exchange.messageCount = 2;
  exchange.lastMessageAt = acceptMsg.createdAt;

  return {
    version: 1,
    workers: [worker("worker-regression")],
    exchanges: [exchange],
    exchangeMessages: [rootMsg, acceptMsg],
    tasks: [task],
    proposals: [],
    artifacts: [],
    validations: [],
    auditEvents: [
      audit({ action: "worker.registered", targetType: "worker", targetId: "worker-regression" }),
      audit({ action: "exchange.message.added", targetType: "exchange-message", targetId: rootMsg.id }),
      audit({ action: "exchange.message.added", targetType: "exchange-message", targetId: acceptMsg.id }),
      audit({ action: "task.created", targetType: "task", targetId: task.id }),
      audit({ actorId: "worker-regression", action: "task.claimed", targetType: "task", targetId: task.id, createdAt: "2026-04-19T01:00:02.000Z" }),
      audit({ actorId: "ops-regression", action: "task.canceled", targetType: "task", targetId: task.id, note: "manual stop requested", createdAt: "2026-04-19T01:00:03.000Z" }),
    ],
  };
}

/**
 * **timed-out** — Task was claimed but went stale and was requeued.
 * The worker missed the heartbeat window, so the broker recycled the task
 * back to `queued` with an incremented `requeueCount`.
 */
export function buildTimedOutState(): BrokerSnapshot {
  const exchange = baseExchange("", {
    status: "queued",
    currentDecision: "accepted",
    updatedAt: "2026-04-19T01:05:00.000Z",
  });
  const task = baseTask(exchange.id, {
    status: "queued",
    requeueCount: 1,
    claimedBy: undefined,
    claimedAt: undefined,
    updatedAt: "2026-04-19T01:05:00.000Z", // 5 min later — reaped
  });
  exchange.activeTaskId = task.id;
  const rootMsg = rootMessage(exchange.id);
  const acceptMsg = acceptMessage(exchange.id, rootMsg.id);

  exchange.rootMessageId = rootMsg.id;
  exchange.latestMessageId = acceptMsg.id;
  exchange.messageCount = 2;
  exchange.lastMessageAt = acceptMsg.createdAt;

  return {
    version: 1,
    workers: [worker("worker-regression")],
    exchanges: [exchange],
    exchangeMessages: [rootMsg, acceptMsg],
    tasks: [task],
    proposals: [],
    artifacts: [],
    validations: [],
    auditEvents: [
      audit({ action: "worker.registered", targetType: "worker", targetId: "worker-regression" }),
      audit({ action: "exchange.message.added", targetType: "exchange-message", targetId: rootMsg.id }),
      audit({ action: "exchange.message.added", targetType: "exchange-message", targetId: acceptMsg.id }),
      audit({ action: "task.created", targetType: "task", targetId: task.id }),
      audit({ actorId: "worker-regression", action: "task.claimed", targetType: "task", targetId: task.id, createdAt: "2026-04-19T01:00:02.000Z" }),
      audit({ actorId: "broker", action: "task.requeued", targetType: "task", targetId: task.id, note: "requeued claimed task without reassignment (attempt 1): claimed task is stale", createdAt: "2026-04-19T01:05:00.000Z" }),
    ],
  };
}

/**
 * **stale** — Worker has gone stale (lastSeenAt is old), task is still claimed.
 * This is the state *before* the reaper runs — the task is stuck on a dead worker.
 */
export function buildStaleState(): BrokerSnapshot {
  const staleTimestamp = "2026-04-18T23:00:00.000Z"; // 2 hours ago

  const exchange = baseExchange("", {
    status: "running",
    currentDecision: "accepted",
    assignedWorkerId: "worker-stale",
    targetNodeId: "worker-stale",
    target: { id: "worker-stale", kind: "node", role: "analyst" },
    updatedAt: "2026-04-18T23:00:00.000Z",
  });
  const task = baseTask(exchange.id, {
    status: "claimed",
    claimedBy: "worker-stale",
    claimedAt: "2026-04-18T23:00:00.000Z",
    updatedAt: "2026-04-18T23:00:00.000Z",
    targetNodeId: "worker-stale",
    assignedWorkerId: "worker-stale",
    target: { id: "worker-stale", kind: "node", role: "analyst" },
  });
  exchange.activeTaskId = task.id;
  const rootMsg = rootMessage(exchange.id);
  const acceptMsg = acceptMessage(exchange.id, rootMsg.id, {
    targetNodeId: "worker-stale",
    assignedWorkerId: "worker-stale",
  });

  exchange.rootMessageId = rootMsg.id;
  exchange.latestMessageId = acceptMsg.id;
  exchange.messageCount = 2;
  exchange.lastMessageAt = acceptMsg.createdAt;

  return {
    version: 1,
    workers: [
      worker("worker-stale", {
        nodeId: "worker-stale",
        lastSeenAt: staleTimestamp,
        updatedAt: staleTimestamp,
      }),
    ],
    exchanges: [exchange],
    exchangeMessages: [rootMsg, acceptMsg],
    tasks: [task],
    proposals: [],
    artifacts: [],
    validations: [],
    auditEvents: [
      audit({ action: "worker.registered", targetType: "worker", targetId: "worker-stale" }),
      audit({ action: "exchange.message.added", targetType: "exchange-message", targetId: rootMsg.id }),
      audit({ action: "exchange.message.added", targetType: "exchange-message", targetId: acceptMsg.id }),
      audit({ action: "task.created", targetType: "task", targetId: task.id }),
      audit({ actorId: "worker-stale", action: "task.claimed", targetType: "task", targetId: task.id, createdAt: staleTimestamp }),
    ],
  };
}

/**
 * **tombstoned** — Task exceeded maxRequeueAttempts and was dead-lettered to `failed`.
 * The error code is `exceeded_requeue_limit`. The exchange is also failed.
 */
export function buildTombstonedState(): BrokerSnapshot {
  const exchange = baseExchange("", {
    status: "failed",
    currentDecision: "accepted",
    updatedAt: "2026-04-19T01:10:00.000Z",
  });
  const task = baseTask(exchange.id, {
    status: "failed",
    claimedBy: "worker-regression",
    claimedAt: "2026-04-19T01:00:02.000Z",
    completedAt: "2026-04-19T01:10:00.000Z",
    updatedAt: "2026-04-19T01:10:00.000Z",
    requeueCount: 3,
    error: {
      code: "exceeded_requeue_limit",
      message: "dead-lettered after 3 automatic requeues: claimed task is stale",
      details: {
        requeueCount: 3,
        maxRequeueAttempts: 3,
        previousStatus: "claimed",
        lastRequeueReason: "claimed task is stale",
      },
    },
  });
  exchange.activeTaskId = task.id;
  const rootMsg = rootMessage(exchange.id);
  const acceptMsg = acceptMessage(exchange.id, rootMsg.id);

  exchange.rootMessageId = rootMsg.id;
  exchange.latestMessageId = acceptMsg.id;
  exchange.messageCount = 2;
  exchange.lastMessageAt = acceptMsg.createdAt;

  return {
    version: 1,
    workers: [worker("worker-regression")],
    exchanges: [exchange],
    exchangeMessages: [rootMsg, acceptMsg],
    tasks: [task],
    proposals: [],
    artifacts: [],
    validations: [],
    auditEvents: [
      audit({ action: "worker.registered", targetType: "worker", targetId: "worker-regression" }),
      audit({ action: "exchange.message.added", targetType: "exchange-message", targetId: rootMsg.id }),
      audit({ action: "exchange.message.added", targetType: "exchange-message", targetId: acceptMsg.id }),
      audit({ action: "task.created", targetType: "task", targetId: task.id }),
      audit({ actorId: "worker-regression", action: "task.claimed", targetType: "task", targetId: task.id, createdAt: "2026-04-19T01:00:02.000Z" }),
      // 3 claim + requeue cycles
      audit({ actorId: "broker", action: "task.requeued", targetType: "task", targetId: task.id, note: "requeued claimed task (attempt 1)", createdAt: "2026-04-19T01:03:00.000Z" }),
      audit({ actorId: "worker-regression", action: "task.claimed", targetType: "task", targetId: task.id, createdAt: "2026-04-19T01:04:00.000Z" }),
      audit({ actorId: "broker", action: "task.requeued", targetType: "task", targetId: task.id, note: "requeued claimed task (attempt 2)", createdAt: "2026-04-19T01:07:00.000Z" }),
      audit({ actorId: "worker-regression", action: "task.claimed", targetType: "task", targetId: task.id, createdAt: "2026-04-19T01:08:00.000Z" }),
      audit({ actorId: "broker", action: "task.requeued", targetType: "task", targetId: task.id, note: "requeued claimed task (attempt 3)", createdAt: "2026-04-19T01:09:00.000Z" }),
      audit({ actorId: "worker-regression", action: "task.claimed", targetType: "task", targetId: task.id, createdAt: "2026-04-19T01:09:30.000Z" }),
      // Final dead-letter
      audit({ actorId: "broker", action: "task.failed", targetType: "task", targetId: task.id, note: "dead-lettered after 3 automatic requeues", createdAt: "2026-04-19T01:10:00.000Z" }),
    ],
  };
}

// ---------------------------------------------------------------------------
// Fixture index — all states in a canonical order for parameterized tests
// ---------------------------------------------------------------------------

export const ALL_RUNTIME_STATES = [
  { name: "waiting", build: buildWaitingState, expectedTaskStatus: "queued" as const, expectedExchangeStatus: "queued" as const },
  { name: "resumed", build: buildResumedState, expectedTaskStatus: "running" as const, expectedExchangeStatus: "running" as const },
  { name: "completed", build: buildCompletedState, expectedTaskStatus: "succeeded" as const, expectedExchangeStatus: "completed" as const },
  { name: "failed", build: buildFailedState, expectedTaskStatus: "failed" as const, expectedExchangeStatus: "failed" as const },
  { name: "canceled", build: buildCanceledState, expectedTaskStatus: "canceled" as const, expectedExchangeStatus: "queued" as const },
  { name: "timed-out", build: buildTimedOutState, expectedTaskStatus: "queued" as const, expectedExchangeStatus: "queued" as const },
  { name: "stale", build: buildStaleState, expectedTaskStatus: "claimed" as const, expectedExchangeStatus: "running" as const },
  { name: "tombstoned", build: buildTombstonedState, expectedTaskStatus: "failed" as const, expectedExchangeStatus: "failed" as const },
] as const;

/**
 * Terminal runtime states — tasks in these states should not be claimable/startable.
 */
export const TERMINAL_RUNTIME_STATES = new Set(["completed", "failed", "canceled", "tombstoned"]);

/**
 * Non-terminal runtime states where the task is actively in-flight.
 */
export const INFLIGHT_RUNTIME_STATES = new Set(["resumed", "stale"]);
