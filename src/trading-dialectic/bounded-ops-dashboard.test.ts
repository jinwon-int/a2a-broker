import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTeam1BoundedOpsDashboard,
} from "./bounded-ops-dashboard.js";

import type {
  TaskRecord,
  TaskStatus,
  WorkerCapacitySummary,
  WorkerCapacitySummaryItem,
} from "../core/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW_MS = 1_700_000_000_000; // Arbitrary stable timestamp

function iso(offsetSec = 0): string {
  return new Date(NOW_MS + offsetSec * 1000).toISOString();
}

function makeTask(overrides: Partial<TaskRecord> & { id: string }): TaskRecord {
  const rest = overrides as unknown as Record<string, unknown>;
  return {
    id: overrides.id,
    intent: overrides.intent ?? ("analyze" as TaskRecord["intent"]),
    status: overrides.status ?? "queued",
    targetNodeId: overrides.targetNodeId ?? "td-worker-bangtong",
    requester: overrides.requester ?? { id: "requester-1" },
    target: overrides.target ?? { id: "target-1" },
    assignedWorkerId: overrides.assignedWorkerId ?? undefined,
    claimedBy: overrides.claimedBy ?? undefined,
    createdAt: overrides.createdAt ?? iso(-3600),
    updatedAt: overrides.updatedAt ?? iso(-60),
    lastHeartbeatAt: overrides.lastHeartbeatAt ?? undefined,
    completedAt: overrides.completedAt ?? undefined,
    requeueCount: overrides.requeueCount ?? 0,
    error: overrides.error ?? undefined,
    result: overrides.result ?? undefined,
    payload: overrides.payload ?? { kind: "generic" },
    brokerOfRecord: rest.brokerOfRecord as string | undefined,
    teamId: rest.teamId as string | undefined,
  };
}

function makeWorker(overrides: { nodeId: string; role?: string; displayName?: string; lastSeenAt?: string }) {
  return {
    nodeId: overrides.nodeId,
    role: overrides.role ?? "analyst",
    displayName: overrides.displayName,
    lastSeenAt: overrides.lastSeenAt ?? iso(-10),
  };
}

function makeCapacityItem(overrides: Partial<WorkerCapacitySummaryItem> & { nodeId: string }): WorkerCapacitySummaryItem {
  return {
    nodeId: overrides.nodeId,
    role: overrides.role ?? "analyst",
    displayName: overrides.displayName ?? undefined,
    status: overrides.status ?? "online",
    lastSeenAt: overrides.lastSeenAt ?? iso(-10),
    lastSeenAgeSec: overrides.lastSeenAgeSec ?? 10,
    counts: overrides.counts ?? { queued: 0, claimed: 0, running: 0, stale: 0, active: 0 },
    latestTaskUpdatedAt: overrides.latestTaskUpdatedAt ?? undefined,
  };
}

function makeCapacitySummary(items: WorkerCapacitySummaryItem[]): WorkerCapacitySummary {
  return {
    generatedAt: iso(),
    workerOfflineAfterMs: 90_000,
    taskStaleAfterMs: 90_000,
    totals: items.reduce(
      (acc, item) => {
        acc.workers += 1;
        if (item.status === "online") acc.online += 1;
        else acc.staleWorkers += 1;
        acc.queued += item.counts.queued;
        acc.claimed += item.counts.claimed;
        acc.running += item.counts.running;
        acc.staleTasks += item.counts.stale;
        acc.active += item.counts.active;
        return acc;
      },
      { workers: 0, online: 0, staleWorkers: 0, queued: 0, claimed: 0, running: 0, staleTasks: 0, active: 0 },
    ),
    items,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("Team1 bounded dashboard: empty state", () => {
  const dashboard = buildTeam1BoundedOpsDashboard({
    tasks: [],
    workers: [],
    workerCapacity: makeCapacitySummary([]),
    nowMs: NOW_MS,
    brokerId: "seoseo",
    teamId: "team1",
  });

  assert.equal(dashboard.kind, "team1.bounded-ops.dashboard");
  assert.equal(dashboard.version, 1);
  assert.equal(dashboard.broker.brokerId, "seoseo");
  assert.equal(dashboard.broker.teamId, "team1");

  assert.equal(dashboard.tasks.total, 0);
  assert.equal(dashboard.tasks.active, 0);
  assert.equal(dashboard.tasks.terminal, 0);
  assert.deepEqual(dashboard.tasks.byPhase, { thesis: 0, antithesis: 0, rebuttal: 0, synthesis: 0, outcome: 0 });

  assert.equal(dashboard.workers.total, 0);
  assert.equal(dashboard.workers.online, 0);
  assert.equal(dashboard.workers.stale, 0);

  assert.equal(dashboard.staleDiagnostics.staleWorkers, 0);
  assert.equal(dashboard.staleDiagnostics.staleTasks, 0);
  assert.equal(dashboard.staleDiagnostics.staleWorkerAssignments, 0);

  assert.equal(dashboard.health.severity, "ok");
  assert.deepEqual(dashboard.health.warnings, []);
});

test("Team1 bounded dashboard: filters non-Team1 tasks", () => {
  const tdTask = makeTask({
    id: "td-thesis-001",
    payload: { contract: { kind: "trading.dialectic", phase: "thesis" } },
  });
  const nonTdTask = makeTask({
    id: "gen-001",
    intent: "promote_to_live",
    targetNodeId: "generic-worker",
  });

  const dashboard = buildTeam1BoundedOpsDashboard({
    tasks: [tdTask, nonTdTask],
    workers: [makeWorker({ nodeId: "td-worker-bangtong" })],
    workerCapacity: makeCapacitySummary([
      makeCapacityItem({ nodeId: "td-worker-bangtong" }),
    ]),
    nowMs: NOW_MS,
  });

  assert.equal(dashboard.tasks.total, 1);
  assert.equal(dashboard.tasks.active, 1);
  assert.equal(dashboard.tasks.terminal, 0);
  assert.equal(dashboard.tasks.byStatus.queued, 1);
});

test("Team1 bounded dashboard: phase distribution", () => {
  const tdTasks: TaskRecord[] = [
    makeTask({ id: "thesis-001", payload: { contract: { kind: "trading.dialectic", phase: "thesis" } }, status: "queued" }),
    makeTask({ id: "antithesis-001", payload: { contract: { kind: "trading.dialectic", phase: "antithesis" } }, status: "running" }),
    makeTask({ id: "rebuttal-001", payload: { contract: { kind: "trading.dialectic", phase: "rebuttal" } }, status: "claimed" }),
    makeTask({ id: "synthesis-001", payload: { contract: { kind: "trading.dialectic", phase: "synthesis" } }, status: "succeeded" }),
    makeTask({ id: "outcome-001", payload: { contract: { kind: "trading.dialectic", phase: "outcome" } }, status: "succeeded" }),
  ];

  const dashboard = buildTeam1BoundedOpsDashboard({
    tasks: tdTasks,
    workers: [makeWorker({ nodeId: "td-worker" })],
    workerCapacity: makeCapacitySummary([
      makeCapacityItem({ nodeId: "td-worker" }),
    ]),
    nowMs: NOW_MS,
  });

  assert.equal(dashboard.tasks.total, 5);
  assert.equal(dashboard.tasks.active, 3); // queued + running + claimed
  assert.equal(dashboard.tasks.terminal, 2); // two succeeded
  assert.deepEqual(dashboard.tasks.byPhase, {
    thesis: 1, antithesis: 1, rebuttal: 1, synthesis: 1, outcome: 1,
  });
  assert.equal(dashboard.tasks.byStatus.queued, 1);
  assert.equal(dashboard.tasks.byStatus.running, 1);
  assert.equal(dashboard.tasks.byStatus.claimed, 1);
  assert.equal(dashboard.tasks.byStatus.succeeded, 2);
});

test("Team1 bounded dashboard: two-broker load distribution", () => {
  const tdTasks: TaskRecord[] = [
    makeTask({ id: "t1", payload: { contract: { kind: "trading.dialectic", phase: "thesis" } }, brokerOfRecord: "seoseo" as unknown as undefined }),
    makeTask({ id: "t2", payload: { contract: { kind: "trading.dialectic", phase: "thesis" } }, brokerOfRecord: "gwakga" as unknown as undefined }),
    makeTask({ id: "t3", payload: { contract: { kind: "trading.dialectic", phase: "antithesis" } }, brokerOfRecord: "seoseo" as unknown as undefined }),
    makeTask({ id: "t4", payload: { contract: { kind: "trading.dialectic", phase: "antithesis" } } }), // no brokerOfRecord
  ];

  const dashboard = buildTeam1BoundedOpsDashboard({
    tasks: tdTasks,
    workers: [makeWorker({ nodeId: "td-worker" })],
    workerCapacity: makeCapacitySummary([
      makeCapacityItem({ nodeId: "td-worker" }),
    ]),
    nowMs: NOW_MS,
  });

  assert.equal(dashboard.tasks.byBrokerOfRecord.total, 3);
  assert.deepEqual(dashboard.tasks.byBrokerOfRecord.byBroker, { seoseo: 2, gwakga: 1 });
  assert.equal(dashboard.tasks.byBrokerOfRecord.noBrokerOfRecord, 1);
});

test("Team1 bounded dashboard: filters non-Team1 workers", () => {
  const tdTasks: TaskRecord[] = [
    makeTask({ id: "td-1", payload: { contract: { kind: "trading.dialectic", phase: "thesis" } } }),
  ];

  const dashboard = buildTeam1BoundedOpsDashboard({
    tasks: tdTasks,
    workers: [
      makeWorker({ nodeId: "td-worker-bangtong", role: "analyst" }),
      makeWorker({ nodeId: "hub-worker", role: "hub" }),
      makeWorker({ nodeId: "generic-op", role: "operator" }),
    ],
    workerCapacity: makeCapacitySummary([
      makeCapacityItem({ nodeId: "td-worker-bangtong" }),
      makeCapacityItem({ nodeId: "hub-worker" }),
      makeCapacityItem({ nodeId: "generic-op" }),
    ]),
    nowMs: NOW_MS,
  });

  assert.equal(dashboard.workers.total, 1);
  assert.equal(dashboard.workers.online, 1);
  assert.equal(dashboard.workers.items.length, 1);
  assert.equal(dashboard.workers.items[0]!.nodeId, "td-worker-bangtong");
});

test("Team1 bounded dashboard: stale worker diagnostics", () => {
  const staleWorker = makeWorker({
    nodeId: "td-worker-stale",
    lastSeenAt: iso(-300), // 5 minutes ago, past 90s threshold
  });
  const onlineWorker = makeWorker({
    nodeId: "td-worker-online",
    lastSeenAt: iso(-10), // 10 seconds ago
  });

  const tdTasks: TaskRecord[] = [
    makeTask({
      id: "td-stale-assignment",
      status: "running",
      assignedWorkerId: "td-worker-stale",
      lastHeartbeatAt: iso(-300),
    }),
    makeTask({
      id: "td-healthy",
      status: "running",
      assignedWorkerId: "td-worker-online",
    }),
  ];

  const dashboard = buildTeam1BoundedOpsDashboard({
    tasks: tdTasks,
    workers: [staleWorker, onlineWorker],
    workerCapacity: makeCapacitySummary([
      makeCapacityItem({ nodeId: "td-worker-stale", status: "stale", lastSeenAt: iso(-300) }),
      makeCapacityItem({ nodeId: "td-worker-online", status: "online", lastSeenAt: iso(-10) }),
    ]),
    nowMs: NOW_MS,
    thresholds: { staleAfterMs: 90_000 },
  });

  assert.equal(dashboard.workers.total, 2);
  assert.equal(dashboard.workers.online, 1);
  assert.equal(dashboard.workers.stale, 1);

  assert.equal(dashboard.staleDiagnostics.staleWorkers, 1);
  assert.equal(dashboard.staleDiagnostics.staleWorkerAssignments, 1);
  assert.equal(dashboard.staleDiagnostics.staleTasks, 1);

  assert.ok(dashboard.staleDiagnostics.oldestStaleTask !== null);
  assert.equal(dashboard.staleDiagnostics.oldestStaleTask!.taskId, "td-stale-assignment");

  assert.ok(dashboard.staleDiagnostics.oldestStaleAssignment !== null);
  assert.equal(dashboard.staleDiagnostics.oldestStaleAssignment!.workerId, "td-worker-stale");
});

test("Team1 bounded dashboard: requeue tracking", () => {
  const tdTasks: TaskRecord[] = [
    makeTask({
      id: "td-requeued",
      payload: { contract: { kind: "trading.dialectic", phase: "thesis" } },
      requeueCount: 2,
    }),
    makeTask({
      id: "td-clean",
      payload: { contract: { kind: "trading.dialectic", phase: "antithesis" } },
      requeueCount: 0,
    }),
  ];

  const dashboard = buildTeam1BoundedOpsDashboard({
    tasks: tdTasks,
    workers: [makeWorker({ nodeId: "td-worker" })],
    workerCapacity: makeCapacitySummary([makeCapacityItem({ nodeId: "td-worker" })]),
    nowMs: NOW_MS,
  });

  assert.equal(dashboard.tasks.requeuedOrDeadLettered, 1);
});

test("Team1 bounded dashboard: health assessment — critical when many stale tasks", () => {
  const stale = (id: string, status: TaskStatus): TaskRecord =>
    makeTask({
      id,
      status,
      assignedWorkerId: "td-worker-stale",
      lastHeartbeatAt: iso(-300),
      payload: { contract: { kind: "trading.dialectic", phase: "thesis" } },
    });

  const tdTasks = Array.from({ length: 5 }, (_, i) => stale(`stale-${i}`, "running"));

  const dashboard = buildTeam1BoundedOpsDashboard({
    tasks: tdTasks,
    workers: [makeWorker({ nodeId: "td-worker-stale", lastSeenAt: iso(-300) })],
    workerCapacity: makeCapacitySummary([
      makeCapacityItem({ nodeId: "td-worker-stale", status: "stale", lastSeenAt: iso(-300) }),
    ]),
    nowMs: NOW_MS,
    thresholds: { staleAfterMs: 90_000 },
  });

  assert.equal(dashboard.health.severity, "critical");
  assert.ok(dashboard.health.warnings.some((w) => w.code === "stale_tasks"));
});

test("Team1 bounded dashboard: health assessment — warning from requeued tasks", () => {
  const tdTasks = Array.from({ length: 5 }, (_, i) =>
    makeTask({
      id: `td-rq-${i}`,
      payload: { contract: { kind: "trading.dialectic", phase: "thesis" } },
      requeueCount: 1,
    }),
  );

  const dashboard = buildTeam1BoundedOpsDashboard({
    tasks: tdTasks,
    workers: [makeWorker({ nodeId: "td-worker" })],
    workerCapacity: makeCapacitySummary([makeCapacityItem({ nodeId: "td-worker" })]),
    nowMs: NOW_MS,
  });

  // Requeue count >= 5 triggers warning
  assert.equal(dashboard.health.severity, "warning");
  assert.ok(dashboard.health.warnings.some((w) => w.code === "requeued_tasks"));
});

test("Team1 bounded dashboard: multi-broker info warning", () => {
  const tdTasks: TaskRecord[] = [
    makeTask({
      id: "t1",
      payload: { contract: { kind: "trading.dialectic", phase: "thesis" } },
      brokerOfRecord: "seoseo" as unknown as undefined,
    }),
    makeTask({
      id: "t2",
      payload: { contract: { kind: "trading.dialectic", phase: "antithesis" } },
      brokerOfRecord: "gwakga" as unknown as undefined,
    }),
  ];

  const dashboard = buildTeam1BoundedOpsDashboard({
    tasks: tdTasks,
    workers: [makeWorker({ nodeId: "td-worker" })],
    workerCapacity: makeCapacitySummary([makeCapacityItem({ nodeId: "td-worker" })]),
    nowMs: NOW_MS,
  });

  assert.ok(dashboard.health.warnings.some((w) => w.code === "multi_broker_load"));
  assert.equal(dashboard.health.warnings.find((w) => w.code === "multi_broker_load")!.severity, "info");
});

test("Team1 bounded dashboard: terminal task distribution", () => {
  const tdTasks: TaskRecord[] = [
    makeTask({ id: "t-succeeded", status: "succeeded", payload: { contract: { kind: "trading.dialectic", phase: "thesis" } } }),
    makeTask({ id: "t-failed", status: "failed", payload: { contract: { kind: "trading.dialectic", phase: "antithesis" } } }),
    makeTask({ id: "t-canceled", status: "canceled", payload: { contract: { kind: "trading.dialectic", phase: "rebuttal" } } }),
    makeTask({ id: "t-active", status: "running", payload: { contract: { kind: "trading.dialectic", phase: "synthesis" } } }),
  ];

  const dashboard = buildTeam1BoundedOpsDashboard({
    tasks: tdTasks,
    workers: [makeWorker({ nodeId: "td-worker" })],
    workerCapacity: makeCapacitySummary([makeCapacityItem({ nodeId: "td-worker" })]),
    nowMs: NOW_MS,
  });

  assert.equal(dashboard.tasks.terminal, 3);
  assert.equal(dashboard.tasks.active, 1);
  assert.equal(dashboard.tasks.byStatus.succeeded, 1);
  assert.equal(dashboard.tasks.byStatus.failed, 1);
  assert.equal(dashboard.tasks.byStatus.canceled, 1);
  assert.equal(dashboard.tasks.byStatus.running, 1);
});

test("Team1 bounded dashboard: worker capacity items reflect bounded set", () => {
  const dashboard = buildTeam1BoundedOpsDashboard({
    tasks: [],
    workers: [
      makeWorker({ nodeId: "bangtong-agent-1", role: "analyst" }),
      makeWorker({ nodeId: "dengae-agent-2", role: "analyst" }),
      makeWorker({ nodeId: "seoseo-agent-3", role: "researcher" }),
    ],
    workerCapacity: makeCapacitySummary([
      makeCapacityItem({ nodeId: "bangtong-agent-1", counts: { queued: 2, claimed: 1, running: 0, stale: 0, active: 3 } }),
      makeCapacityItem({ nodeId: "dengae-agent-2", counts: { queued: 0, claimed: 0, running: 1, stale: 0, active: 1 } }),
      makeCapacityItem({ nodeId: "seoseo-agent-3", counts: { queued: 0, claimed: 0, running: 0, stale: 0, active: 0 } }),
    ]),
    nowMs: NOW_MS,
  });

  assert.equal(dashboard.workers.total, 3);
  assert.equal(dashboard.workers.items.length, 3);
  assert.equal(dashboard.workers.items[0]!.counts.active, 3);
  assert.equal(dashboard.workers.items[1]!.counts.active, 1);
});

test("Team1 bounded dashboard: intent-based Team1 detection", () => {
  // Use non-Team1 targetNodeId so matching is purely based on intent
  const tdTasks: TaskRecord[] = [
    makeTask({ id: "intent-analyze", intent: "analyze", targetNodeId: "generic-node", payload: { kind: "generic" } }),
    makeTask({ id: "intent-verify", intent: "verify", targetNodeId: "generic-node", payload: { kind: "generic" } }),
    makeTask({ id: "intent-backfill", intent: "backfill", targetNodeId: "generic-node", payload: { kind: "generic" } }),
    makeTask({ id: "intent-chat", intent: "chat", targetNodeId: "generic-node", payload: { kind: "generic" } }), // not Team1
  ];

  const dashboard = buildTeam1BoundedOpsDashboard({
    tasks: tdTasks,
    workers: [makeWorker({ nodeId: "td-worker" })],
    workerCapacity: makeCapacitySummary([makeCapacityItem({ nodeId: "td-worker" })]),
    nowMs: NOW_MS,
  });

  assert.equal(dashboard.tasks.total, 3); // analyze, verify, backfill
});

test("Team1 bounded dashboard: node-id-prefix-based Team1 detection", () => {
  const tdTasks: TaskRecord[] = [
    makeTask({ id: "generic-1", targetNodeId: "bangtong-node-1", intent: "chat" }),
    makeTask({ id: "generic-2", targetNodeId: "dengae-node-1", intent: "chat" }),
    makeTask({ id: "generic-3", targetNodeId: "seoseo-node-1", intent: "chat" }),
    makeTask({ id: "generic-4", targetNodeId: "td-agent-1", intent: "chat" }),
    makeTask({ id: "generic-5", targetNodeId: "trading-agent-1", intent: "chat" }),
    makeTask({ id: "generic-6", targetNodeId: "hub-node", intent: "chat" }), // not Team1
  ];

  const dashboard = buildTeam1BoundedOpsDashboard({
    tasks: tdTasks,
    workers: [makeWorker({ nodeId: "td-worker" })],
    workerCapacity: makeCapacitySummary([makeCapacityItem({ nodeId: "td-worker" })]),
    nowMs: NOW_MS,
  });

  assert.equal(dashboard.tasks.total, 5);
});

test("Team1 bounded dashboard: no-broker-of-record tasks", () => {
  const tdTasks: TaskRecord[] = [
    makeTask({ id: "legacy-1", payload: { contract: { kind: "trading.dialectic", phase: "thesis" } } }),
    makeTask({ id: "legacy-2", payload: { contract: { kind: "trading.dialectic", phase: "antithesis" } } }),
  ];

  const dashboard = buildTeam1BoundedOpsDashboard({
    tasks: tdTasks,
    workers: [makeWorker({ nodeId: "td-worker" })],
    workerCapacity: makeCapacitySummary([makeCapacityItem({ nodeId: "td-worker" })]),
    nowMs: NOW_MS,
  });

  assert.equal(dashboard.tasks.byBrokerOfRecord.total, 0);
  assert.equal(dashboard.tasks.byBrokerOfRecord.noBrokerOfRecord, 2);
  assert.deepEqual(dashboard.tasks.byBrokerOfRecord.byBroker, {});
});

test("Team1 bounded dashboard: generatedAt override", () => {
  const fixedIso = "2025-05-13T12:00:00.000Z";
  const dashboard = buildTeam1BoundedOpsDashboard({
    tasks: [],
    workers: [],
    workerCapacity: makeCapacitySummary([]),
    generatedAt: fixedIso,
  });

  assert.equal(dashboard.generatedAt, fixedIso);
});
