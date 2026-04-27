import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  CURRENT_BROKER_STATE_VERSION,
  JsonFileBrokerStateStore,
  SqliteBrokerStateStore,
  emptySnapshot,
  serializeBrokerSnapshot,
  writeBrokerSnapshotFile,
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

test("broker snapshot export helpers write canonical versioned JSON atomically", () => {
  const temp = withTempFile("export/state.json");
  try {
    const snapshot: BrokerSnapshot = {
      ...emptySnapshot(),
      version: 1,
      tasks: [makeTask("task-export", "queued", "worker-a")],
    };

    const serialized = serializeBrokerSnapshot(snapshot);
    assert.equal(JSON.parse(serialized).version, CURRENT_BROKER_STATE_VERSION);

    writeBrokerSnapshotFile(temp.filePath, snapshot);
    const exported = JSON.parse(readFileSync(temp.filePath, "utf8"));
    assert.equal(exported.version, CURRENT_BROKER_STATE_VERSION);
    assert.deepEqual(exported.tasks.map((task: BrokerSnapshot["tasks"][number]) => task.id), ["task-export"]);
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore saves and reloads snapshots with WAL metadata", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const snapshot: BrokerSnapshot = {
      ...emptySnapshot(),
      exchanges: [makeExchange("exchange-1", "worker-a")],
      exchangeMessages: [makeExchangeMessage("message-1", "exchange-1", "root")],
      proposals: [makeProposal("proposal-1", "submitted", "worker-a")],
      artifacts: [makeArtifact("artifact-1", "proposal-1")],
      validations: [makeValidation("validation-1", "proposal-1")],
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
      schemaVersion: 7,
      journalMode: "wal",
      hotEntityTables: [
        "broker_exchanges",
        "broker_exchange_messages",
        "broker_proposals",
        "broker_artifacts",
        "broker_validations",
        "broker_tasks",
        "broker_workers",
        "broker_audit_events",
      ],
      hotEntityMirror: {
        ok: true,
        tableCounts: {
          broker_exchanges: 1,
          broker_exchange_messages: 1,
          broker_proposals: 1,
          broker_artifacts: 1,
          broker_validations: 1,
          broker_tasks: 1,
          broker_workers: 1,
          broker_audit_events: 1,
        },
        snapshotCounts: {
          exchanges: 1,
          exchangeMessages: 1,
          proposals: 1,
          artifacts: 1,
          validations: 1,
          tasks: 1,
          workers: 1,
          auditEvents: 1,
        },
        mismatches: [],
      },
      importedFromJsonFile: undefined,
      lastImportAt: undefined,
    });
    reloaded.close();

    const db = new DatabaseSync(temp.filePath, { readOnly: true });
    try {
      assert.equal(readSqliteCount(db, "broker_exchanges"), 1);
      assert.equal(readSqliteCount(db, "broker_exchange_messages"), 1);
      assert.equal(readSqliteCount(db, "broker_proposals"), 1);
      assert.equal(readSqliteCount(db, "broker_artifacts"), 1);
      assert.equal(readSqliteCount(db, "broker_validations"), 1);
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
      const exchangeRow = db.prepare("SELECT id, status, intent, target_node_id FROM broker_exchanges").get() as {
        id: string;
        status: string;
        intent: string;
        target_node_id: string;
      };
      assert.equal(exchangeRow.id, "exchange-1");
      assert.equal(exchangeRow.status, "running");
      assert.equal(exchangeRow.intent, "chat");
      assert.equal(exchangeRow.target_node_id, "worker-a");
      const exchangeMessageRow = db.prepare("SELECT id, exchange_id, kind FROM broker_exchange_messages").get() as {
        id: string;
        exchange_id: string;
        kind: string;
      };
      assert.equal(exchangeMessageRow.id, "message-1");
      assert.equal(exchangeMessageRow.exchange_id, "exchange-1");
      assert.equal(exchangeMessageRow.kind, "root");
      const proposalRow = db.prepare("SELECT id, status, kind, target_node_id FROM broker_proposals").get() as {
        id: string;
        status: string;
        kind: string;
        target_node_id: string;
      };
      assert.equal(proposalRow.id, "proposal-1");
      assert.equal(proposalRow.status, "submitted");
      assert.equal(proposalRow.kind, "patch");
      assert.equal(proposalRow.target_node_id, "worker-a");
      const artifactRow = db.prepare("SELECT id, proposal_id, kind FROM broker_artifacts").get() as {
        id: string;
        proposal_id: string;
        kind: string;
      };
      assert.equal(artifactRow.id, "artifact-1");
      assert.equal(artifactRow.proposal_id, "proposal-1");
      assert.equal(artifactRow.kind, "report");
      const validationRow = db.prepare("SELECT id, proposal_id, node_id, verdict FROM broker_validations").get() as {
        id: string;
        proposal_id: string;
        node_id: string;
        verdict: string;
      };
      assert.equal(validationRow.id, "validation-1");
      assert.equal(validationRow.proposal_id, "proposal-1");
      assert.equal(validationRow.node_id, "validator-a");
      assert.equal(validationRow.verdict, "pass");
    } finally {
      db.close();
    }
  } finally {
    temp.cleanup();
  }
});

test("SQLite export script writes canonical JSON snapshots", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const exportFile = join(temp.dir, "exported-state.json");
    const snapshot: BrokerSnapshot = {
      ...emptySnapshot(),
      tasks: [makeTask("task-sqlite-export", "succeeded", "worker-a")],
      auditEvents: [makeAuditEvent("audit-export", "task.succeeded", "task-sqlite-export")],
    };

    const store = new SqliteBrokerStateStore(temp.filePath);
    store.save(snapshot);
    store.close();

    execFileSync("node", [
      "scripts/export-sqlite-state.mjs",
      "--db",
      temp.filePath,
      "--out",
      exportFile,
    ], {
      cwd: join(import.meta.dirname, "..", ".."),
      stdio: ["ignore", "pipe", "pipe"],
    });

    const exported = JSON.parse(readFileSync(exportFile, "utf8"));
    assert.equal(exported.version, CURRENT_BROKER_STATE_VERSION);
    assert.deepEqual(exported.tasks, snapshot.tasks);
    assert.deepEqual(exported.auditEvents, snapshot.auditEvents);
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
      exchanges: [
        makeExchange("exchange-a", "worker-a", "2026-04-27T00:01:00.000Z"),
        makeExchange("exchange-b", "worker-b", "2026-04-27T00:02:00.000Z"),
      ],
      exchangeMessages: [
        makeExchangeMessage("message-root", "exchange-a", "root", undefined, "2026-04-27T00:00:00.000Z"),
        makeExchangeMessage("message-child", "exchange-a", "thread", "message-root", "2026-04-27T00:01:00.000Z"),
        makeExchangeMessage("message-other", "exchange-b", "root", undefined, "2026-04-27T00:02:00.000Z"),
      ],
      proposals: [
        makeProposal("proposal-submitted", "submitted", "worker-a", "2026-04-27T00:01:00.000Z"),
        makeProposal("proposal-approved", "approved", "worker-b", "2026-04-27T00:02:00.000Z"),
      ],
      artifacts: [
        makeArtifact("artifact-old", "proposal-submitted", "2026-04-27T00:01:00.000Z"),
        makeArtifact("artifact-new", "proposal-submitted", "2026-04-27T00:02:00.000Z"),
        makeArtifact("artifact-other", "proposal-approved", "2026-04-27T00:03:00.000Z"),
      ],
      validations: [
        makeValidation("validation-old", "proposal-submitted", "2026-04-27T00:01:00.000Z"),
        makeValidation("validation-new", "proposal-submitted", "2026-04-27T00:02:00.000Z"),
        makeValidation("validation-other", "proposal-approved", "2026-04-27T00:03:00.000Z"),
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
      store.readHotExchanges().map((exchange) => exchange.id),
      ["exchange-b", "exchange-a"],
    );
    assert.deepEqual(
      store.readHotExchanges({ id: "exchange-a" }).map((exchange) => exchange.targetNodeId),
      ["worker-a"],
    );
    assert.deepEqual(
      store.readHotExchangeMessages({ exchangeId: "exchange-a" }).map((message) => message.id),
      ["message-root", "message-child"],
    );
    assert.deepEqual(
      store.readHotProposals().map((proposal) => proposal.id),
      ["proposal-approved", "proposal-submitted"],
    );
    assert.deepEqual(
      store.readHotProposals({ status: "submitted", targetNodeId: "worker-a", kind: "patch" }).map((proposal) => proposal.id),
      ["proposal-submitted"],
    );
    assert.deepEqual(
      store.readHotArtifacts({ proposalId: "proposal-submitted" }).map((artifact) => artifact.id),
      ["artifact-new", "artifact-old"],
    );
    assert.deepEqual(
      store.readHotValidations({ proposalId: "proposal-submitted" }).map((validation) => validation.id),
      ["validation-new", "validation-old"],
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

test("SqliteBrokerStateStore reports hot table mirror count drift", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const snapshot: BrokerSnapshot = {
      ...emptySnapshot(),
      tasks: [makeTask("task-counted", "queued", "worker-a")],
    };

    const store = new SqliteBrokerStateStore(temp.filePath);
    store.save(snapshot);
    assert.deepEqual(store.readHotEntityMirrorStatus().mismatches, []);
    store.close();

    const db = new DatabaseSync(temp.filePath);
    try {
      db.exec("DELETE FROM broker_tasks");
    } finally {
      db.close();
    }

    const reloaded = new SqliteBrokerStateStore(temp.filePath);
    const status = reloaded.readHotEntityMirrorStatus();
    assert.equal(status.ok, false);
    assert.deepEqual(status.mismatches, [
      {
        table: "broker_tasks",
        snapshotKey: "tasks",
        tableCount: 0,
        snapshotCount: 1,
      },
    ]);
    reloaded.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore supports granular task and audit hot-table upserts", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    store.save({
      ...emptySnapshot(),
      tasks: [makeTask("task-upsert", "queued", "worker-a")],
      auditEvents: [makeAuditEvent("audit-upsert", "task.created", "task-upsert")],
    });

    const updatedTask = {
      ...makeTask("task-upsert", "succeeded", "worker-b"),
      completedAt: "2026-04-27T00:03:00.000Z",
      updatedAt: "2026-04-27T00:03:00.000Z",
    };
    const updatedAudit = makeAuditEvent("audit-upsert", "task.succeeded", "task-upsert", "2026-04-27T00:03:00.000Z");
    const appendedAudit = makeAuditEvent("audit-appended", "task.claimed", "task-upsert", "2026-04-27T00:02:00.000Z");

    store.upsertHotTasks([updatedTask]);
    store.upsertHotAuditEvents([updatedAudit, appendedAudit]);

    assert.deepEqual(
      store.readHotTasks({ id: "task-upsert" }),
      [updatedTask],
    );
    assert.deepEqual(
      store.readHotAuditEvents({ targetId: "task-upsert" }).map((event) => event.id),
      ["audit-upsert", "audit-appended"],
    );
    assert.deepEqual(store.readHotEntityTableCounts().broker_tasks, 1);
    assert.deepEqual(store.readHotEntityTableCounts().broker_audit_events, 2);
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
    assert.equal(store.getPersistenceInfo().schemaVersion, 7);
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

function makeExchange(
  id: string,
  targetNodeId: string,
  createdAt = "2026-04-27T00:00:00.000Z",
): BrokerSnapshot["exchanges"][number] {
  return {
    id,
    requester: { id: "requester", kind: "session", role: "hub" },
    target: { id: targetNodeId, kind: "node", role: "analyst" },
    targetNodeId,
    assignedWorkerId: targetNodeId,
    message: id,
    maxTurns: 4,
    intent: "chat",
    status: "running",
    rootMessageId: `${id}-root`,
    latestMessageId: `${id}-root`,
    messageCount: 1,
    lastMessageAt: createdAt,
    activeTaskId: `${id}-task`,
    createdAt,
    updatedAt: createdAt,
  };
}

function makeExchangeMessage(
  id: string,
  exchangeId: string,
  kind: BrokerSnapshot["exchangeMessages"][number]["kind"],
  parentMessageId?: string,
  createdAt = "2026-04-27T00:00:00.000Z",
): BrokerSnapshot["exchangeMessages"][number] {
  const message: BrokerSnapshot["exchangeMessages"][number] = {
    id,
    exchangeId,
    kind,
    message: id,
    actor: { id: "requester", kind: "session", role: "hub" },
    createdAt,
    updatedAt: createdAt,
  };
  if (parentMessageId) {
    message.parentMessageId = parentMessageId;
  }
  return message;
}

function makeProposal(
  id: string,
  status: BrokerSnapshot["proposals"][number]["status"],
  targetNodeId: string,
  createdAt = "2026-04-27T00:00:00.000Z",
): BrokerSnapshot["proposals"][number] {
  return {
    id,
    source: { id: "source-a", kind: "node", role: "analyst" },
    target: { id: targetNodeId, kind: "node", role: "operator" },
    sourceNodeId: "source-a",
    targetNodeId,
    kind: "patch",
    summary: id,
    workspace: { nodeId: targetNodeId, workspaceId: "test" },
    artifactIds: [],
    status,
    createdAt,
    updatedAt: createdAt,
  };
}

function makeArtifact(
  id: string,
  proposalId: string,
  createdAt = "2026-04-27T00:00:00.000Z",
): BrokerSnapshot["artifacts"][number] {
  return {
    id,
    proposalId,
    kind: "report",
    uri: `memory://${id}`,
    createdAt,
  };
}

function makeValidation(
  id: string,
  proposalId: string,
  createdAt = "2026-04-27T00:00:00.000Z",
): BrokerSnapshot["validations"][number] {
  return {
    id,
    proposalId,
    nodeId: "validator-a",
    kind: "smoke",
    verdict: "pass",
    metrics: {},
    artifactIds: [],
    createdAt,
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
  createdAt = "2026-04-27T00:00:00.000Z",
): BrokerSnapshot["auditEvents"][number] {
  return {
    id,
    actorId: "operator-a",
    action,
    targetType: "task",
    targetId,
    createdAt,
  };
}
