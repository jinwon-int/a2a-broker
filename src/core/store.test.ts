import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  CURRENT_BROKER_STATE_VERSION,
  JsonFileBrokerStateStore,
  SqliteBrokerStateStore,
  emptySnapshot,
  type BrokerSnapshot,
} from "./store.js";

function withTempFile(name: string): {
  dir: string;
  filePath: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-store-"));
  return {
    dir,
    filePath: join(dir, name),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("JsonFileBrokerStateStore loads backward-compatible empty objects", () => {
  const temp = withTempFile("state.json");
  try {
    writeFileSync(temp.filePath, "{}", "utf8");

    const store = new JsonFileBrokerStateStore(temp.filePath);
    assert.deepEqual(store.load(), emptySnapshot());
  } finally {
    temp.cleanup();
  }
});

test("JsonFileBrokerStateStore rejects oversized snapshots", () => {
  const temp = withTempFile("large-state.json");
  try {
    writeFileSync(
      temp.filePath,
      JSON.stringify({
        version: CURRENT_BROKER_STATE_VERSION,
        exchanges: [],
        exchangeMessages: [],
        proposals: [],
        artifacts: [],
        validations: [],
        auditEvents: [],
        workers: [],
        tasks: [],
        padding: "x".repeat(1_024),
      }),
      "utf8",
    );

    const store = new JsonFileBrokerStateStore(temp.filePath, { maxBytes: 128 });
    assert.throws(() => store.load(), /broker snapshot exceeds max size/);
  } finally {
    temp.cleanup();
  }
});

test("JsonFileBrokerStateStore rejects malformed snapshot entries", () => {
  const temp = withTempFile("invalid-state.json");
  try {
    writeFileSync(
      temp.filePath,
      JSON.stringify({
        version: CURRENT_BROKER_STATE_VERSION,
        exchanges: [{ id: 123 }],
      }),
      "utf8",
    );

    const store = new JsonFileBrokerStateStore(temp.filePath);
    assert.throws(() => store.load(), /invalid broker snapshot/);
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore saves and reloads snapshots with WAL metadata", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const snapshot: BrokerSnapshot = {
      ...emptySnapshot(),
      workers: [
        {
          nodeId: "worker-a",
          role: "analyst",
          capabilities: {
            canAnalyze: true,
            canBackfill: false,
            canPatchWorkspace: false,
            canPromoteLive: false,
            workspaceIds: ["smoke"],
            environments: ["research"],
          },
          createdAt: "2026-04-27T00:00:00.000Z",
          updatedAt: "2026-04-27T00:00:00.000Z",
          lastSeenAt: "2026-04-27T00:00:00.000Z",
        },
      ],
      auditEvents: [
        {
          id: "audit-1",
          actorId: "operator-a",
          action: "task.created",
          targetType: "task",
          targetId: "task-1",
          createdAt: "2026-04-27T00:00:00.000Z",
        },
      ],
      tasks: [
        {
          id: "task-1",
          intent: "chat",
          requester: { id: "requester", kind: "session", role: "hub" },
          target: { id: "worker-a", kind: "node", role: "analyst" },
          message: "inspect me",
          targetNodeId: "worker-a",
          assignedWorkerId: "worker-a",
          payload: { correlationId: "corr-1" },
          status: "queued",
          createdAt: "2026-04-27T00:00:00.000Z",
          updatedAt: "2026-04-27T00:00:00.000Z",
          taskOrigin: "api",
        },
      ],
    };

    const store = new SqliteBrokerStateStore(temp.filePath);
    store.save(snapshot);
    store.close();

    const reloaded = new SqliteBrokerStateStore(temp.filePath);
    assert.deepEqual(reloaded.load(), snapshot);
    assert.deepEqual(reloaded.getPersistenceInfo(), {
      kind: "sqlite",
      dbFile: temp.filePath,
      stateVersion: CURRENT_BROKER_STATE_VERSION,
      schemaVersion: 3,
      journalMode: "wal",
      hotEntityTables: ["broker_tasks", "broker_workers", "broker_audit_events"],
      importedFromJsonFile: undefined,
      lastImportAt: undefined,
    });
    reloaded.close();

    const db = new DatabaseSync(temp.filePath, { readOnly: true });
    try {
      assert.equal(readSqliteCount(db, "broker_tasks"), 1);
      assert.equal(readSqliteCount(db, "broker_workers"), 1);
      assert.equal(readSqliteCount(db, "broker_audit_events"), 1);
      const taskRow = db.prepare("SELECT id, status, intent, assigned_worker_id, task_origin FROM broker_tasks").get() as {
        id: string;
        status: string;
        intent: string;
        assigned_worker_id: string;
        task_origin: string;
      };
      assert.equal(taskRow.id, "task-1");
      assert.equal(taskRow.status, "queued");
      assert.equal(taskRow.intent, "chat");
      assert.equal(taskRow.assigned_worker_id, "worker-a");
      assert.equal(taskRow.task_origin, "api");
    } finally {
      db.close();
    }
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore imports an existing JSON snapshot atomically on first load", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const jsonFile = join(temp.dir, "state.json");
    const snapshot: BrokerSnapshot = {
      ...emptySnapshot(),
      tasks: [
        {
          id: "task-imported",
          intent: "chat",
          requester: { id: "requester", kind: "session", role: "hub" },
          target: { id: "worker-a", kind: "node", role: "analyst" },
          message: "import me",
          targetNodeId: "worker-a",
          assignedWorkerId: "worker-a",
          payload: { correlationId: "corr-1" },
          status: "queued",
          createdAt: "2026-04-27T00:00:00.000Z",
          updatedAt: "2026-04-27T00:00:00.000Z",
          taskOrigin: "api",
        },
      ],
    };
    writeFileSync(jsonFile, JSON.stringify(snapshot), "utf8");

    const store = new SqliteBrokerStateStore(temp.filePath, { importJsonFile: jsonFile });
    assert.deepEqual(store.load(), snapshot);
    const info = store.getPersistenceInfo();
    assert.equal(info.importedFromJsonFile, jsonFile);
    assert.match(info.lastImportAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
    store.close();

    const reloaded = new SqliteBrokerStateStore(temp.filePath);
    assert.deepEqual(reloaded.load(), snapshot);
    reloaded.close();

    const db = new DatabaseSync(temp.filePath, { readOnly: true });
    try {
      assert.equal(readSqliteCount(db, "broker_tasks"), 1);
      const importedTaskRow = db.prepare("SELECT id, status, target_node_id FROM broker_tasks").get() as {
        id: string;
        status: string;
        target_node_id: string;
      };
      assert.equal(importedTaskRow.id, "task-imported");
      assert.equal(importedTaskRow.status, "queued");
      assert.equal(importedTaskRow.target_node_id, "worker-a");
    } finally {
      db.close();
    }
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore reads hot entities from mirrored tables with filters", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const snapshot: BrokerSnapshot = {
      ...emptySnapshot(),
      workers: [
        makeWorker("worker-a"),
        makeWorker("worker-b"),
      ],
      tasks: [
        makeTask("task-queued", "queued", "worker-a"),
        makeTask("task-running", "running", "worker-a"),
        makeTask("task-done", "succeeded", "worker-b"),
      ],
      auditEvents: [
        makeAuditEvent("audit-1", "task.created", "task-queued"),
        makeAuditEvent("audit-2", "task.started", "task-running"),
        makeAuditEvent("audit-3", "task.succeeded", "task-done"),
      ],
    };

    const store = new SqliteBrokerStateStore(temp.filePath);
    store.save(snapshot);

    assert.deepEqual(
      store.readHotTasks({ assignedWorkerId: "worker-a" }).map((task) => task.id),
      ["task-running", "task-queued"],
    );
    assert.deepEqual(
      store.readHotTasks({ status: "succeeded" }).map((task) => task.id),
      ["task-done"],
    );
    assert.deepEqual(
      store.readHotTasks({ id: "task-queued" }).map((task) => task.payload),
      [{ correlationId: "corr-task-queued" }],
    );
    assert.deepEqual(
      store.readHotTasks({ targetNodeId: "worker-a", intent: "chat", taskOrigin: "api" }).map((task) => task.id),
      ["task-running", "task-queued"],
    );
    assert.deepEqual(
      store.readHotWorkers().map((worker) => worker.nodeId),
      ["worker-a", "worker-b"],
    );
    assert.deepEqual(
      store.readHotWorkers({ nodeId: "worker-b" }).map((worker) => worker.nodeId),
      ["worker-b"],
    );
    assert.deepEqual(
      store.readHotWorkers({ role: "analyst" }).map((worker) => worker.nodeId),
      ["worker-a", "worker-b"],
    );
    assert.deepEqual(
      store.readHotAuditEvents({ targetId: "task-running" }).map((event) => event.id),
      ["audit-2"],
    );
    assert.deepEqual(
      store.readHotAuditEvents({ action: "task.created" }).map((event) => event.targetId),
      ["task-queued"],
    );
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore migrates v2 task hot table with task origin column", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const db = new DatabaseSync(temp.filePath);
    db.exec(`
      CREATE TABLE broker_tasks (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        intent TEXT NOT NULL,
        target_node_id TEXT NOT NULL,
        assigned_worker_id TEXT,
        updated_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
    `);
    db.close();

    const store = new SqliteBrokerStateStore(temp.filePath);
    const snapshot: BrokerSnapshot = {
      ...emptySnapshot(),
      tasks: [makeTask("task-migrated", "queued", "worker-a")],
    };
    store.save(snapshot);
    assert.deepEqual(
      store.readHotTasks({ taskOrigin: "api", targetNodeId: "worker-a" }).map((task) => task.id),
      ["task-migrated"],
    );
    assert.equal(store.getPersistenceInfo().schemaVersion, 3);
    store.close();
  } finally {
    temp.cleanup();
  }
});

function readSqliteCount(db: DatabaseSync, tableName: string): number {
  const row = db.prepare(`SELECT count(*) AS count FROM ${tableName}`).get() as { count: number };
  return row.count;
}

function makeWorker(nodeId: string): BrokerSnapshot["workers"][number] {
  return {
    nodeId,
    role: "analyst",
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: false,
      canPromoteLive: false,
      workspaceIds: ["smoke"],
      environments: ["research"],
    },
    createdAt: "2026-04-27T00:00:00.000Z",
    updatedAt: "2026-04-27T00:00:00.000Z",
    lastSeenAt: "2026-04-27T00:00:00.000Z",
  };
}

function makeTask(
  id: string,
  status: BrokerSnapshot["tasks"][number]["status"],
  assignedWorkerId: string,
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
    createdAt: "2026-04-27T00:00:00.000Z",
    updatedAt: id === "task-running" ? "2026-04-27T00:02:00.000Z" : "2026-04-27T00:01:00.000Z",
    taskOrigin: "api",
  };
}

function makeAuditEvent(
  id: string,
  action: BrokerSnapshot["auditEvents"][number]["action"],
  targetId: string,
): BrokerSnapshot["auditEvents"][number] {
  return {
    id,
    actorId: "operator-a",
    action,
    targetType: "task",
    targetId,
    createdAt: "2026-04-27T00:00:00.000Z",
  };
}
