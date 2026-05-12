import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BROKER_CLEANUP_APPROVAL,
  applyBrokerCleanupPlan,
  buildBrokerCleanupPlan,
} from "./broker-cleanup.js";
import { emptySnapshot, SqliteBrokerStateStore, type BrokerSnapshot } from "./store.js";

test("broker cleanup plans hot-table prune candidates without mutating", () => {
  const temp = withTempFile("cleanup-plan.db");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath, { loadSource: "hot-tables" });
    store.save({
      ...emptySnapshot(),
      tasks: [
        makeTask("task-active", "running", "worker-a", "2026-05-12T00:00:00.000Z"),
        makeTask("task-old", "succeeded", "worker-a", "2026-05-01T00:00:00.000Z"),
        makeTask("task-new", "failed", "worker-a", "2026-05-12T00:00:00.000Z"),
      ],
      auditEvents: [
        makeAuditEvent("audit-old", "task-old", "2026-05-01T00:00:00.000Z"),
        makeAuditEvent("audit-new", "task-new", "2026-05-12T00:00:00.000Z"),
      ],
      workers: [
        makeWorker("worker-old", "2026-05-01T00:00:00.000Z"),
        makeWorker("worker-new", "2026-05-12T00:00:00.000Z"),
      ],
    });

    const plan = buildBrokerCleanupPlan(store, {
      nowMs: Date.parse("2026-05-12T01:00:00.000Z"),
      taskRetentionMs: 24 * 60 * 60 * 1000,
      maxTerminalTasks: 0,
      auditRetentionMs: 24 * 60 * 60 * 1000,
      maxAuditEvents: 0,
      workerRetentionMs: 24 * 60 * 60 * 1000,
      maxInactiveWorkers: 0,
    });

    assert.equal(plan.dryRun, true);
    assert.equal(plan.summary.candidates, 3);
    assert.deepEqual(plan.plans.find((entry) => entry.table === "broker_tasks")?.pruneIds, ["task-old"]);
    assert.deepEqual(plan.plans.find((entry) => entry.table === "broker_audit_events")?.pruneIds, ["audit-old"]);
    assert.deepEqual(plan.plans.find((entry) => entry.table === "broker_workers")?.pruneIds, ["worker-old"]);
    assert.equal(store.readHotRuntimeSnapshot().tasks.length, 3);

    store.close();
  } finally {
    temp.cleanup();
  }
});

test("broker cleanup apply fails closed without approval and backup proof", () => {
  const temp = withTempFile("cleanup-apply-gate.db");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath, { loadSource: "hot-tables" });
    const plan = buildBrokerCleanupPlan(store, { nowMs: Date.parse("2026-05-12T01:00:00.000Z") });

    assert.throws(
      () => applyBrokerCleanupPlan(store, plan, { approval: BROKER_CLEANUP_APPROVAL }),
      /backupProof/,
    );
    assert.throws(
      () => applyBrokerCleanupPlan(store, plan, { backupProof: { ref: "artifact://backup" } }),
      /approval=APPLY_BROKER_CLEANUP/,
    );

    store.close();
  } finally {
    temp.cleanup();
  }
});

test("broker cleanup apply prunes only planned candidates after explicit approval", () => {
  const temp = withTempFile("cleanup-apply.db");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath, { loadSource: "hot-tables" });
    store.save({
      ...emptySnapshot(),
      tasks: [
        makeTask("task-keep", "running", "worker-a", "2026-05-12T00:00:00.000Z"),
        makeTask("task-prune", "succeeded", "worker-a", "2026-05-01T00:00:00.000Z"),
      ],
    });
    const plan = buildBrokerCleanupPlan(store, {
      nowMs: Date.parse("2026-05-12T01:00:00.000Z"),
      taskRetentionMs: 24 * 60 * 60 * 1000,
      maxTerminalTasks: 0,
    });

    const result = applyBrokerCleanupPlan(store, plan, {
      approval: BROKER_CLEANUP_APPROVAL,
      backupProof: { ref: "artifact://sqlite-backup-20260512" },
    });

    assert.equal(result.summary.prunedCount, 1);
    assert.deepEqual(store.readHotRuntimeSnapshot().tasks.map((task) => task.id), ["task-keep"]);

    store.close();
  } finally {
    temp.cleanup();
  }
});

function withTempFile(name: string): { filePath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-cleanup-"));
  return {
    filePath: join(dir, name),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function makeTask(
  id: string,
  status: BrokerSnapshot["tasks"][number]["status"],
  assignedWorkerId: string,
  updatedAt: string,
): BrokerSnapshot["tasks"][number] {
  return {
    id,
    intent: "chat",
    requester: { id: "requester", kind: "session", role: "hub" },
    target: { id: assignedWorkerId, kind: "node", role: "analyst" },
    message: id,
    targetNodeId: assignedWorkerId,
    assignedWorkerId,
    payload: { correlationId: `corr-${id}` },
    status,
    createdAt: updatedAt,
    updatedAt,
    completedAt: status === "running" ? undefined : updatedAt,
    taskOrigin: "api",
  };
}

function makeAuditEvent(
  id: string,
  targetId: string,
  createdAt: string,
): BrokerSnapshot["auditEvents"][number] {
  return {
    id,
    actorId: "operator-a",
    action: "task.succeeded",
    targetType: "task",
    targetId,
    createdAt,
  };
}

function makeWorker(nodeId: string, lastSeenAt: string): BrokerSnapshot["workers"][number] {
  return {
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
    createdAt: lastSeenAt,
    updatedAt: lastSeenAt,
    lastSeenAt,
  };
}
