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
  SqliteArtifactRuntimeRepository,
  SqliteAuditRuntimeRepository,
  SqliteBrokerStateStore,
  SqliteExchangeMessageRuntimeRepository,
  SqliteExchangeRuntimeRepository,
  SqliteProposalRuntimeRepository,
  SqliteTaskRuntimeRepository,
  SqliteTombstoneRuntimeRepository,
  SqliteValidationRuntimeRepository,
  SqliteWorkerRuntimeRepository,
  buildHotEntityHintCoverage,
  emptySnapshot,
  serializeBrokerSnapshot,
  writeBrokerSnapshotFile,
  type BrokerSnapshot,
} from "./store.js";
import {
  BROKER_CLEANUP_CONFIRMATION,
  buildBrokerCleanupPlan,
  executeBrokerCleanupPlan,
  validateCleanupExecution,
} from "./broker-cleanup.js";
import type { TerminalTaskOutboxEvent } from "./terminal-event-outbox.js";

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

test("JsonFileBrokerStateStore loads snapshots with legacy and object via metadata", () => {
  const temp = withTempFile("legacy-via-state.json");
  try {
    const task = makeTask("task-legacy-via", "queued", "worker-a");
    const message = makeExchangeMessage("message-legacy-via", "exchange-1", "root");
    writeFileSync(
      temp.filePath,
      JSON.stringify({
        ...emptySnapshot(),
        tasks: [
          {
            ...task,
            via: { transport: "openclaw", channel: "telegram", sessionId: "session-a", traceId: "trace-a" },
          },
          {
            ...makeTask("task-string-via", "queued", "worker-a"),
            via: "openclaw",
          },
        ],
        exchangeMessages: [
          {
            ...message,
            via: { transport: "openclaw", channel: "telegram", traceId: "message-trace" },
          },
          {
            ...makeExchangeMessage("message-string-via", "exchange-1", "thread"),
            via: "openclaw",
          },
        ],
      }),
      "utf8",
    );

    const loaded = new JsonFileBrokerStateStore(temp.filePath).load();
    assert.deepEqual(loaded.tasks[0]?.via, {
      transport: "openclaw",
      channel: "telegram",
      sessionId: "session-a",
      traceId: "trace-a",
    });
    assert.deepEqual(loaded.tasks[1]?.via, { transport: "openclaw" });
    assert.deepEqual(loaded.exchangeMessages[0]?.via, {
      transport: "openclaw",
      channel: "telegram",
      traceId: "message-trace",
    });
    assert.deepEqual(loaded.exchangeMessages[1]?.via, { transport: "openclaw" });
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
      tombstones: [makeTombstone("task-1", "failed")],
    };

    const store = new SqliteBrokerStateStore(temp.filePath);
    store.save(snapshot);
    store.close();

    const reloaded = new SqliteBrokerStateStore(temp.filePath);
    assert.deepEqual(reloaded.load(), snapshot);
    const persistenceInfo = reloaded.getPersistenceInfo();
    assert.ok(persistenceInfo.lastPersistAt, "lastPersistAt should be reported after saving");
    assert.equal(persistenceInfo.lastPersistSkippedFullSnapshot, false);
    delete persistenceInfo.lastPersistAt;
    delete persistenceInfo.lastPersistSkippedFullSnapshot;
    assert.deepEqual(persistenceInfo, {
      kind: "sqlite",
      dbFile: temp.filePath,
      stateVersion: CURRENT_BROKER_STATE_VERSION,
      loadSource: "snapshot",
      schemaVersion: 10,
      journalMode: "wal",
      hotEntityTables: [
        "broker_exchanges",
        "broker_exchange_messages",
        "broker_proposals",
        "broker_artifacts",
        "broker_validations",
        "broker_tasks",
        "broker_tombstones",
        "broker_workers",
        "broker_audit_events",
        "broker_terminal_outbox",
      ],
      hotEntityHintTables: [
        "broker_exchanges",
        "broker_exchange_messages",
        "broker_proposals",
        "broker_artifacts",
        "broker_validations",
        "broker_tasks",
        "broker_tombstones",
        "broker_workers",
        "broker_audit_events",
        "broker_terminal_outbox",
      ],
      hotEntityHintCoverage: {
        ok: true,
        supportedTables: [
          "broker_exchanges",
          "broker_exchange_messages",
          "broker_proposals",
          "broker_artifacts",
          "broker_validations",
          "broker_tasks",
          "broker_tombstones",
          "broker_workers",
          "broker_audit_events",
          "broker_terminal_outbox",
        ],
        missingTables: [],
        supportedCount: 10,
        totalCount: 10,
      },
      hotEntityMirror: {
        ok: true,
        tableCounts: {
          broker_exchanges: 1,
          broker_exchange_messages: 1,
          broker_proposals: 1,
          broker_artifacts: 1,
          broker_validations: 1,
          broker_tasks: 1,
          broker_tombstones: 1,
          broker_workers: 1,
          broker_audit_events: 1,
          broker_terminal_outbox: 0,
        },
        snapshotCounts: {
          exchanges: 1,
          exchangeMessages: 1,
          proposals: 1,
          artifacts: 1,
          validations: 1,
          tasks: 1,
          tombstones: 1,
          workers: 1,
          auditEvents: 1,
          terminalOutbox: 0,
        },
        mismatches: [],
      },
      hotEntityDiagnostics: {
        invalidRows: [],
      },
      hotTableLoadMetrics: {
        tables: {
          broker_exchanges: { count: 1, maxPayloadBytes: 506 },
          broker_exchange_messages: { count: 1, maxPayloadBytes: 215 },
          broker_proposals: { count: 1, maxPayloadBytes: 397 },
          broker_artifacts: { count: 1, maxPayloadBytes: 128 },
          broker_validations: { count: 1, maxPayloadBytes: 171 },
          broker_tasks: {
            count: 1,
            maxPayloadBytes: 381,
            runtimeLoad: { limit: 2000, loadedCount: 1, skippedCount: 0, activeCount: 1, terminalCount: 0 },
          },
          broker_tombstones: { count: 1, maxPayloadBytes: 203 },
          broker_workers: { count: 1, maxPayloadBytes: 313 },
          broker_audit_events: {
            count: 1,
            maxPayloadBytes: 142,
            runtimeLoad: { limit: 5000, loadedCount: 1, skippedCount: 0 },
          },
          broker_terminal_outbox: {
            count: 0,
            maxPayloadBytes: 0,
            unackedCount: 0,
            runtimeLoad: { limit: 1000, loadedCount: 0, skippedCount: 0 },
          },
        },
      },
      hotTableRuntimeLoadLimits: {
        terminalTasks: 2000,
        auditEvents: 5000,
        terminalOutboxEvents: 1000,
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
      assert.equal(readSqliteCount(db, "broker_tombstones"), 1);
      assert.equal(readSqliteCount(db, "broker_workers"), 1);
      assert.equal(readSqliteCount(db, "broker_audit_events"), 1);
      assert.equal(readSqliteCount(db, "broker_terminal_outbox"), 0);
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
      const tombstoneRow = db.prepare("SELECT task_id, terminal_status, tombstone_reason FROM broker_tombstones").get() as {
        task_id: string;
        terminal_status: string;
        tombstone_reason: string;
      };
      assert.equal(tombstoneRow.task_id, "task-1");
      assert.equal(tombstoneRow.terminal_status, "failed");
      assert.equal(tombstoneRow.tombstone_reason, "failed");
    } finally {
      db.close();
    }
  } finally {
    temp.cleanup();
  }
});

test("buildHotEntityHintCoverage reports missing hinted-write support for mirrored table drift", () => {
  assert.deepEqual(
    buildHotEntityHintCoverage(
      ["broker_tasks", "broker_workers", "broker_future_hot_table"],
      ["broker_tasks", "broker_workers"],
    ),
    {
      ok: false,
      supportedTables: ["broker_tasks", "broker_workers"],
      missingTables: ["broker_future_hot_table"],
      supportedCount: 2,
      totalCount: 3,
    },
  );
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

test("SqliteBrokerStateStore projects empty hot tables as an empty runtime snapshot", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);

    assert.deepEqual(store.readHotRuntimeSnapshot(), emptySnapshot());
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore readHotTasks respects maxRows cap", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    store.save({
      version: CURRENT_BROKER_STATE_VERSION,
      exchanges: [],
      exchangeMessages: [],
      proposals: [],
      artifacts: [],
      validations: [],
      workers: [],
      tasks: [
        makeTask("task-a", "queued", "worker-a"),
        makeTask("task-b", "running", "worker-a"),
        makeTask("task-c", "running", "worker-b"),
        makeTask("task-d", "succeeded", "worker-b"),
        makeTask("task-e", "succeeded", "worker-b"),
      ],
      auditEvents: [],
      tombstones: [],
      terminalOutbox: [],
      crossBrokerTerminalBriefs: [],
    });

    assert.equal(store.readHotTasks().length, 5, "bounded: no maxRows returns all 5 tasks");
    assert.equal(store.readHotTasks({ maxRows: 1 }).length, 1, "maxRows=1 must return at most 1 task");
    assert.equal(store.readHotTasks({ maxRows: 3 }).length, 3, "maxRows=3 must return at most 3 tasks");
    assert.equal(store.readHotTasks({ maxRows: 100 }).length, 5, "maxRows larger than dataset returns all rows");
    assert.equal(store.readHotTasks({ maxRows: 0 }).length, 5, "maxRows=0 (disabled) returns all rows");
    // With AND filter + maxRows
    assert.equal(store.readHotTasks({ status: "succeeded", maxRows: 1 }).length, 1, "filtered + maxRows=1 returns 1");

    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore readHotAuditEvents respects maxRows cap", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    store.save({
      version: CURRENT_BROKER_STATE_VERSION,
      exchanges: [],
      exchangeMessages: [],
      proposals: [],
      artifacts: [],
      validations: [],
      workers: [],
      tasks: [],
      auditEvents: [
        makeAuditEvent("audit-1", "task.created", "task-a"),
        makeAuditEvent("audit-2", "task.started", "task-b"),
        makeAuditEvent("audit-3", "task.succeeded", "task-b"),
        makeAuditEvent("audit-4", "task.created", "task-b"),
      ],
      tombstones: [],
      terminalOutbox: [],
      crossBrokerTerminalBriefs: [],
    });

    assert.equal(store.readHotAuditEvents().length, 4, "no maxRows returns all 4 audit events");
    assert.equal(store.readHotAuditEvents({ maxRows: 1 }).length, 1, "maxRows=1 must return at most 1");
    assert.equal(store.readHotAuditEvents({ maxRows: 2 }).length, 2, "maxRows=2 must return at most 2");
    assert.equal(store.readHotAuditEvents({ maxRows: 100 }).length, 4, "maxRows > dataset returns all");
    assert.equal(store.readHotAuditEvents({ maxRows: 0 }).length, 4, "maxRows=0 returns all");

    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore readHotWorkers respects maxRows cap", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    store.save({
      version: CURRENT_BROKER_STATE_VERSION,
      exchanges: [],
      exchangeMessages: [],
      proposals: [],
      artifacts: [],
      validations: [],
      workers: [
        makeWorker("worker-a"),
        makeWorker("worker-b"),
        makeWorker("worker-c"),
      ],
      tasks: [],
      auditEvents: [],
      tombstones: [],
      terminalOutbox: [],
      crossBrokerTerminalBriefs: [],
    });

    assert.equal(store.readHotWorkers().length, 3, "no maxRows returns all 3 workers");
    assert.equal(store.readHotWorkers({ maxRows: 1 }).length, 1, "maxRows=1 must return at most 1");
    assert.equal(store.readHotWorkers({ maxRows: 100 }).length, 3, "maxRows > dataset returns all");
    assert.equal(store.readHotWorkers({ maxRows: 0 }).length, 3, "maxRows=0 returns all");

    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore readHotTombstones respects maxRows cap", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    store.save({
      version: CURRENT_BROKER_STATE_VERSION,
      exchanges: [],
      exchangeMessages: [],
      proposals: [],
      artifacts: [],
      validations: [],
      workers: [],
      tasks: [],
      auditEvents: [],
      tombstones: [
        makeTombstone("t1", "failed", "2026-04-27T01:00:00.000Z"),
        makeTombstone("t2", "dead_lettered", "2026-04-26T01:00:00.000Z"),
        makeTombstone("t3", "canceled", "2026-04-25T01:00:00.000Z"),
      ],
      terminalOutbox: [],
      crossBrokerTerminalBriefs: [],
    });

    assert.equal(store.readHotTombstones().length, 3, "no maxRows returns all 3 tombstones");
    assert.equal(store.readHotTombstones({ maxRows: 1 }).length, 1, "maxRows=1 must return at most 1");
    assert.equal(store.readHotTombstones({ maxRows: 2 }).length, 2, "maxRows=2 must return at most 2");
    assert.equal(store.readHotTombstones({ maxRows: 100 }).length, 3, "maxRows > dataset returns all");
    assert.equal(store.readHotTombstones({ maxRows: 0 }).length, 3, "maxRows=0 returns all");

    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore skips invalid worker hot rows and reports diagnostics", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const validWorker = makeWorker("worker-valid");
    const invalidWorker = {
      nodeId: "worker-invalid",
      role: "analyst",
      createdAt: "2026-04-27T00:00:00.000Z",
      updatedAt: "2026-04-27T00:00:00.000Z",
      lastSeenAt: "2026-04-27T00:00:00.000Z",
    };
    const store = new SqliteBrokerStateStore(temp.filePath, { loadSource: "hot-tables" });
    store.upsertHotWorkers([validWorker]);

    const db = new DatabaseSync(temp.filePath);
    try {
      db.prepare(
        `INSERT INTO broker_workers (node_id, role, last_seen_at, updated_at, payload)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        invalidWorker.nodeId,
        invalidWorker.role,
        invalidWorker.lastSeenAt,
        invalidWorker.updatedAt,
        JSON.stringify(invalidWorker),
      );
    } finally {
      db.close();
    }

    assert.deepEqual(store.load().workers.map((worker) => worker.nodeId), ["worker-valid"]);
    assert.deepEqual(store.readHotWorkers().map((worker) => worker.nodeId), ["worker-valid"]);
    assert.deepEqual(store.getPersistenceInfo().hotEntityDiagnostics?.invalidRows, [{
      table: "broker_workers",
      primaryKey: "worker-invalid",
      schemaError: "Invalid input: expected object, received undefined",
      count: 1,
    }]);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore projects a runtime snapshot from hot tables without a canonical snapshot", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const exchange = makeExchange("exchange-hot", "worker-hot");
    const exchangeMessage = makeExchangeMessage("message-hot", "exchange-hot", "root");
    const proposal = makeProposal("proposal-hot", "submitted", "worker-hot");
    const artifact = makeArtifact("artifact-hot", "proposal-hot");
    const validation = makeValidation("validation-hot", "proposal-hot");
    const auditEvent = makeAuditEvent("audit-hot", "task.created", "task-hot");
    const worker = makeWorker("worker-hot");
    const task = makeTask("task-hot", "queued", "worker-hot");
    const tombstone = makeTombstone("task-hot-terminal", "failed");
    const expected: BrokerSnapshot = {
      ...emptySnapshot(),
      exchanges: [exchange],
      exchangeMessages: [exchangeMessage],
      proposals: [proposal],
      artifacts: [artifact],
      validations: [validation],
      auditEvents: [auditEvent],
      workers: [worker],
      tasks: [task],
      tombstones: [tombstone],
    };

    const store = new SqliteBrokerStateStore(temp.filePath);
    store.upsertHotExchanges([exchange]);
    store.upsertHotExchangeMessages([exchangeMessage]);
    store.upsertHotProposals([proposal]);
    store.upsertHotArtifacts([artifact]);
    store.upsertHotValidations([validation]);
    store.upsertHotAuditEvents([auditEvent]);
    store.upsertHotWorkers([worker]);
    store.upsertHotTasks([task]);
    store.upsertHotTombstones([tombstone]);

    assert.deepEqual(store.load(), emptySnapshot());
    assert.deepEqual(store.readHotRuntimeSnapshot(), expected);
    store.close();

    const db = new DatabaseSync(temp.filePath, { readOnly: true });
    try {
      assert.equal(readSqliteCount(db, "broker_snapshots"), 0);
    } finally {
      db.close();
    }
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore bounds hot runtime hydration without hiding table-native reads", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const activeTask = makeTask("task-running", "running", "worker-a");
    const oldTerminalTask = {
      ...makeTask("task-terminal-old", "succeeded", "worker-a"),
      completedAt: "2026-04-27T00:01:00.000Z",
      updatedAt: "2026-04-27T00:01:00.000Z",
    };
    const newestTerminalTask = {
      ...makeTask("task-terminal-new", "failed", "worker-a"),
      completedAt: "2026-04-27T00:03:00.000Z",
      updatedAt: "2026-04-27T00:03:00.000Z",
    };
    const snapshot: BrokerSnapshot = {
      ...emptySnapshot(),
      tasks: [oldTerminalTask, newestTerminalTask, activeTask],
      auditEvents: [
        makeAuditEvent("audit-old", "task.created", "task-terminal-old", "2026-04-27T00:01:00.000Z"),
        makeAuditEvent("audit-mid", "task.failed", "task-terminal-new", "2026-04-27T00:02:00.000Z"),
        makeAuditEvent("audit-new", "task.started", "task-running", "2026-04-27T00:03:00.000Z"),
      ],
      terminalOutbox: [
        makeTerminalOutboxEvent("outbox-old", "task-terminal-old", "2026-04-27T00:01:00.000Z"),
        makeTerminalOutboxEvent("outbox-mid", "task-terminal-new", "2026-04-27T00:02:00.000Z"),
        makeTerminalOutboxEvent("outbox-new", "task-running", "2026-04-27T00:03:00.000Z"),
      ],
    };

    const store = new SqliteBrokerStateStore(temp.filePath, {
      maxHotRuntimeTerminalTasks: 1,
      maxHotRuntimeAuditEvents: 2,
      maxHotRuntimeTerminalOutboxEvents: 2,
    });
    store.save(snapshot);

    const hotRuntime = store.readHotRuntimeSnapshot();
    assert.deepEqual(new Set(hotRuntime.tasks.map((task) => task.id)), new Set(["task-running", "task-terminal-new"]));
    assert.deepEqual(hotRuntime.auditEvents.map((event) => event.id), ["audit-new", "audit-mid"]);
    assert.deepEqual(hotRuntime.terminalOutbox?.map((event) => event.id), ["outbox-mid", "outbox-new"]);

    assert.equal(store.readHotTasks().length, 3);
    assert.equal(store.readHotAuditEvents().length, 3);
    assert.equal(store.readHotTerminalOutbox().length, 3);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore hot runtime projection can diverge from stale canonical load", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const staleTask = makeTask("task-stale", "queued", "worker-a");
    const hotTask = {
      ...staleTask,
      status: "claimed" as const,
      claimedBy: "worker-a",
      claimedAt: "2026-04-27T00:02:00.000Z",
      updatedAt: "2026-04-27T00:02:00.000Z",
    };
    const staleSnapshot: BrokerSnapshot = {
      ...emptySnapshot(),
      tasks: [staleTask],
    };

    const store = new SqliteBrokerStateStore(temp.filePath);
    store.save(staleSnapshot);
    store.upsertHotTasks([hotTask]);

    assert.deepEqual(store.load(), staleSnapshot);
    assert.deepEqual(store.readHotRuntimeSnapshot().tasks, [hotTask]);
    assert.notDeepEqual(store.readHotRuntimeSnapshot(), store.load());
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore can opt into hot-table runtime load source", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const staleTask = makeTask("task-stale", "queued", "worker-a");
    const hotTask = {
      ...staleTask,
      status: "claimed" as const,
      claimedBy: "worker-a",
      claimedAt: "2026-04-27T00:02:00.000Z",
      updatedAt: "2026-04-27T00:02:00.000Z",
    };
    const staleSnapshot: BrokerSnapshot = {
      ...emptySnapshot(),
      tasks: [staleTask],
    };
    const hotSnapshot: BrokerSnapshot = {
      ...emptySnapshot(),
      tasks: [hotTask],
    };

    const canonicalStore = new SqliteBrokerStateStore(temp.filePath);
    canonicalStore.save(staleSnapshot);
    canonicalStore.upsertHotTasks([hotTask]);
    canonicalStore.close();

    const hotLoadStore = new SqliteBrokerStateStore(temp.filePath, { loadSource: "hot-tables" });
    assert.deepEqual(hotLoadStore.load(), hotSnapshot);
    assert.equal(hotLoadStore.getPersistenceInfo().loadSource, "hot-tables");
    hotLoadStore.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore hot-table load source preserves first-load JSON import", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const importedSnapshot: BrokerSnapshot = {
      ...emptySnapshot(),
      tasks: [makeTask("task-imported-hot-load", "queued", "worker-a")],
    };
    const jsonFile = join(temp.dir, "state.json");
    writeBrokerSnapshotFile(jsonFile, importedSnapshot);

    const store = new SqliteBrokerStateStore(temp.filePath, {
      importJsonFile: jsonFile,
      loadSource: "hot-tables",
    });

    assert.deepEqual(store.load(), importedSnapshot);
    assert.deepEqual(store.readHotRuntimeSnapshot(), importedSnapshot);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteTaskRuntimeRepository writes task state directly to broker_tasks", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    const repository = new SqliteTaskRuntimeRepository(store);

    repository.upsertTask(makeTask("task-runtime", "queued", "worker-a"));
    repository.upsertTask({
      ...makeTask("task-runtime", "claimed", "worker-a"),
      claimedBy: "worker-a",
      claimedAt: "2026-04-27T00:02:00.000Z",
      updatedAt: "2026-04-27T00:02:00.000Z",
    });

    const task = repository.getTask("task-runtime");
    assert.equal(task?.status, "claimed");
    assert.equal(task?.claimedBy, "worker-a");
    assert.deepEqual(
      repository.listTasks({ status: "claimed", claimedBy: "worker-a", assignedWorkerId: "worker-a", taskOrigin: "api" }).map((item) => item.id),
      ["task-runtime"],
    );
    assert.deepEqual(store.load().tasks, []);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("Sqlite exchange runtime repositories write directly to exchange hot tables", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    const exchangeRepository = new SqliteExchangeRuntimeRepository(store);
    const messageRepository = new SqliteExchangeMessageRuntimeRepository(store);

    exchangeRepository.upsertExchange(makeExchange("exchange-runtime", "worker-a"));
    messageRepository.upsertExchangeMessage(makeExchangeMessage("exchange-runtime-root", "exchange-runtime", "root"));
    messageRepository.upsertExchangeMessage(makeExchangeMessage(
      "exchange-runtime-thread",
      "exchange-runtime",
      "thread",
      "exchange-runtime-root",
      "2026-04-27T00:01:00.000Z",
    ));
    exchangeRepository.upsertExchange({
      ...makeExchange("exchange-runtime", "worker-a"),
      latestMessageId: "exchange-runtime-thread",
      messageCount: 2,
      lastMessageAt: "2026-04-27T00:01:00.000Z",
      updatedAt: "2026-04-27T00:01:00.000Z",
    });

    const exchange = exchangeRepository.getExchange("exchange-runtime");
    assert.equal(exchange?.latestMessageId, "exchange-runtime-thread");
    assert.equal(exchange?.messageCount, 2);
    assert.deepEqual(exchangeRepository.listExchanges().map((item) => item.id), ["exchange-runtime"]);
    assert.equal(messageRepository.getExchangeMessage("exchange-runtime-thread")?.parentMessageId, "exchange-runtime-root");
    assert.deepEqual(
      messageRepository.listExchangeMessages("exchange-runtime").map((item) => item.id),
      ["exchange-runtime-root", "exchange-runtime-thread"],
    );
    assert.deepEqual(store.load().exchanges, []);
    assert.deepEqual(store.load().exchangeMessages, []);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteProposalRuntimeRepository writes proposal state directly to broker_proposals", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    const repository = new SqliteProposalRuntimeRepository(store);

    repository.upsertProposal(makeProposal("proposal-runtime", "submitted", "worker-a"));
    repository.upsertProposal({
      ...makeProposal("proposal-runtime", "approved", "worker-a"),
      summary: "runtime proposal updated",
      updatedAt: "2026-04-27T00:02:00.000Z",
    });
    repository.upsertProposal({
      ...makeProposal("proposal-runtime-other", "validated", "worker-b", "2026-04-27T00:01:00.000Z"),
      kind: "params",
      parameterPayload: { threshold: 3 },
    });

    const proposal = repository.getProposal("proposal-runtime");
    assert.equal(proposal?.status, "approved");
    assert.equal(proposal?.summary, "runtime proposal updated");
    assert.deepEqual(
      repository.listProposals({ status: "approved", sourceNodeId: "source-a", targetNodeId: "worker-a", kind: "patch" }).map((item) => item.id),
      ["proposal-runtime"],
    );
    assert.deepEqual(
      repository.listProposals({ kind: "params" }).map((item) => item.parameterPayload),
      [{ threshold: 3 }],
    );
    assert.deepEqual(store.load().proposals, []);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteArtifactRuntimeRepository writes artifact metadata directly to broker_artifacts", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    const repository = new SqliteArtifactRuntimeRepository(store);

    repository.upsertArtifact(makeArtifact("artifact-runtime", "proposal-runtime"));
    repository.upsertArtifact({
      ...makeArtifact("artifact-runtime", "proposal-runtime"),
      summary: "runtime artifact updated",
      uri: "memory://runtime-artifact-updated",
      createdAt: "2026-04-27T00:02:00.000Z",
    });
    repository.upsertArtifact({
      ...makeArtifact("artifact-runtime-other", "proposal-runtime", "2026-04-27T00:01:00.000Z"),
      kind: "bundle",
      contentType: "application/json",
      sizeBytes: 123,
    });
    repository.upsertArtifact(makeArtifact("artifact-runtime-foreign", "proposal-foreign", "2026-04-27T00:03:00.000Z"));

    const artifact = repository.getArtifact("artifact-runtime");
    assert.equal(artifact?.summary, "runtime artifact updated");
    assert.equal(artifact?.uri, "memory://runtime-artifact-updated");
    assert.deepEqual(
      repository.listArtifactsForProposal("proposal-runtime").map((item) => [item.id, item.kind]),
      [["artifact-runtime", "report"], ["artifact-runtime-other", "bundle"]],
    );
    assert.deepEqual(store.load().artifacts, []);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteValidationRuntimeRepository writes validation results directly to broker_validations", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    const repository = new SqliteValidationRuntimeRepository(store);

    repository.upsertValidation(makeValidation("validation-runtime", "proposal-runtime"));
    repository.upsertValidation({
      ...makeValidation("validation-runtime", "proposal-runtime"),
      verdict: "fail",
      note: "runtime validation updated",
      metrics: { confidence: "low" },
      createdAt: "2026-04-27T00:02:00.000Z",
    });
    repository.upsertValidation({
      ...makeValidation("validation-runtime-other", "proposal-runtime", "2026-04-27T00:01:00.000Z"),
      kind: "paper",
      nodeId: "worker-b",
    });
    repository.upsertValidation(makeValidation("validation-runtime-foreign", "proposal-foreign", "2026-04-27T00:03:00.000Z"));

    const validation = repository.getValidation("validation-runtime");
    assert.equal(validation?.verdict, "fail");
    assert.equal(validation?.note, "runtime validation updated");
    assert.deepEqual(validation?.metrics, { confidence: "low" });
    assert.deepEqual(
      repository.listValidationsForProposal("proposal-runtime").map((item) => [item.id, item.kind]),
      [["validation-runtime", "smoke"], ["validation-runtime-other", "paper"]],
    );
    assert.deepEqual(store.load().validations, []);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteWorkerRuntimeRepository writes worker state directly to broker_workers", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    const repository = new SqliteWorkerRuntimeRepository(store);

    repository.upsertWorker(makeWorker("worker-runtime"));
    repository.upsertWorker({
      ...makeWorker("worker-runtime"),
      displayName: "runtime worker",
      updatedAt: "2026-04-27T00:01:00.000Z",
      lastSeenAt: "2026-04-27T00:01:00.000Z",
      metadata: { heartbeat: "direct" },
    });

    const worker = repository.getWorker("worker-runtime");
    assert.equal(worker?.displayName, "runtime worker");
    assert.deepEqual(worker?.metadata, { heartbeat: "direct" });
    assert.deepEqual(
      repository.listWorkers({ role: "analyst", environment: "research", workspaceId: "smoke" }).map((item) => item.nodeId),
      ["worker-runtime"],
    );
    assert.deepEqual(store.load().workers, []);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteAuditRuntimeRepository writes audit events directly to broker_audit_events", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    const repository = new SqliteAuditRuntimeRepository(store);

    repository.appendAuditEvent(makeAuditEvent("audit-runtime-created", "task.created", "task-runtime"));
    repository.appendAuditEvent({
      ...makeAuditEvent("audit-runtime-started", "task.started", "task-runtime", "2026-04-27T00:01:00.000Z"),
      actorId: "worker-runtime",
      proposalId: "proposal-runtime",
    });

    assert.deepEqual(
      repository.listAuditEvents({ targetId: "task-runtime" }).map((event) => event.id),
      ["audit-runtime-started", "audit-runtime-created"],
    );
    assert.deepEqual(
      repository.listAuditEvents({ proposalId: "proposal-runtime", actorId: "worker-runtime", action: "task.started" }).map((event) => event.id),
      ["audit-runtime-started"],
    );
    assert.deepEqual(store.load().auditEvents, []);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteAuditRuntimeRepository coalesces worker heartbeats and enforces hot-table max", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    const repository = new SqliteAuditRuntimeRepository(store, { maxHotAuditEvents: 3 });

    repository.appendAuditEvent({
      ...makeAuditEvent("heartbeat-1", "worker.heartbeat", "worker-runtime", "2026-04-27T00:00:00.000Z"),
      actorId: "worker-runtime",
      targetType: "worker",
    });
    repository.appendAuditEvent({
      ...makeAuditEvent("heartbeat-2", "worker.heartbeat", "worker-runtime", "2026-04-27T00:01:00.000Z"),
      actorId: "worker-runtime",
      targetType: "worker",
    });
    assert.deepEqual(
      repository.listAuditEvents({ action: "worker.heartbeat" }).map((event) => [event.id, event.createdAt]),
      [["worker-heartbeat:worker-runtime", "2026-04-27T00:01:00.000Z"]],
    );
    repository.appendAuditEvent({
      ...makeAuditEvent("task-heartbeat-1", "task.heartbeat", "task-runtime", "2026-04-27T00:01:30.000Z"),
      actorId: "worker-runtime",
    });
    repository.appendAuditEvent({
      ...makeAuditEvent("task-heartbeat-2", "task.heartbeat", "task-runtime", "2026-04-27T00:01:45.000Z"),
      actorId: "worker-runtime",
    });
    assert.deepEqual(
      repository.listAuditEvents({ action: "task.heartbeat" }).map((event) => [event.id, event.createdAt]),
      [["task-heartbeat:task-runtime", "2026-04-27T00:01:45.000Z"]],
    );

    repository.appendAuditEvent(makeAuditEvent("audit-runtime-created", "task.created", "task-runtime", "2026-04-27T00:02:00.000Z"));
    repository.appendAuditEvent(makeAuditEvent("audit-runtime-started", "task.started", "task-runtime", "2026-04-27T00:03:00.000Z"));
    repository.appendAuditEvent(makeAuditEvent("audit-runtime-succeeded", "task.succeeded", "task-runtime", "2026-04-27T00:04:00.000Z"));

    assert.deepEqual(
      repository.listAuditEvents().map((event) => event.id),
      ["audit-runtime-succeeded", "audit-runtime-started", "audit-runtime-created"],
    );
    assert.deepEqual(
      repository.listAuditEvents({ action: "worker.heartbeat" }).map((event) => [event.id, event.createdAt]),
      [],
    );
    assert.deepEqual(store.readHotAuditDiagnostics(), {
      total: 3,
      heartbeat: 0,
      heartbeatRatio: 0,
      workerHeartbeat: 0,
      workerHeartbeatRatio: 0,
      taskHeartbeat: 0,
      taskHeartbeatRatio: 0,
      recentWindowMs: 600_000,
      recentTotal: 0,
      recentHeartbeat: 0,
      recentHeartbeatRatio: 0,
      recentWorkerHeartbeat: 0,
      recentWorkerHeartbeatRatio: 0,
      recentTaskHeartbeat: 0,
      recentTaskHeartbeatRatio: 0,
      warnings: [],
    });
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteAuditRuntimeRepository caps heartbeat audit rows separately from meaningful audit rows", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    const repository = new SqliteAuditRuntimeRepository(store, {
      maxHotAuditEvents: 20,
      maxHotHeartbeatAuditEvents: 3,
    });

    for (let i = 0; i < 8; i += 1) {
      repository.appendAuditEvent({
        ...makeAuditEvent(`task-heartbeat-${i}`, "task.heartbeat", `task-${i}`, `2026-04-27T00:0${i}:00.000Z`),
        actorId: `worker-${i}`,
      });
    }
    for (let i = 0; i < 4; i += 1) {
      repository.appendAuditEvent(makeAuditEvent(`audit-meaningful-${i}`, "task.created", `meaningful-${i}`, `2026-04-27T00:1${i}:00.000Z`));
    }

    assert.deepEqual(
      repository.listAuditEvents({ action: "task.heartbeat" }).map((event) => event.id),
      ["task-heartbeat:task-7", "task-heartbeat:task-6", "task-heartbeat:task-5"],
    );
    assert.deepEqual(
      repository.listAuditEvents({ action: "task.created" }).map((event) => event.id),
      ["audit-meaningful-3", "audit-meaningful-2", "audit-meaningful-1", "audit-meaningful-0"],
    );
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("hot audit diagnostics separate historical heartbeat residue from recent churn", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    const oldHeartbeatEvents = Array.from({ length: 24 }, (_, index) => ({
      ...makeAuditEvent(`old-heartbeat-${index}`, "worker.heartbeat", "worker-runtime", `2026-04-27T00:${String(index).padStart(2, "0")}:00.000Z`),
      actorId: "worker-runtime",
      targetType: "worker" as const,
    }));
    store.save({
      ...emptySnapshot(),
      auditEvents: [
        ...oldHeartbeatEvents,
        makeAuditEvent("old-task-created", "task.created", "task-runtime", "2026-04-27T00:30:00.000Z"),
      ],
    });

    const historical = store.readHotAuditDiagnostics();
    assert.equal(historical.total, 25);
    assert.equal(historical.heartbeat, 24);
    assert.equal(historical.workerHeartbeat, 24);
    assert.equal(historical.taskHeartbeat, 0);
    assert.equal(historical.recentHeartbeat, 0);
    assert.equal(historical.recentWorkerHeartbeat, 0);
    assert.deepEqual(historical.warnings, [], "historical heartbeat-heavy residue should not look like active churn");

    const now = Date.now();
    const recentHeartbeatEvents = Array.from({ length: 20 }, (_, index) => ({
      ...makeAuditEvent(`recent-heartbeat-${index}`, "worker.heartbeat", "worker-runtime", new Date(now - index * 1000).toISOString()),
      actorId: "worker-runtime",
      targetType: "worker" as const,
    }));
    store.save({
      ...emptySnapshot(),
      auditEvents: [
        ...oldHeartbeatEvents,
        ...recentHeartbeatEvents,
        makeAuditEvent("recent-task-created", "task.created", "task-runtime", new Date(now).toISOString()),
      ],
    });

    const active = store.readHotAuditDiagnostics();
    assert.equal(active.recentHeartbeat, 20);
    assert.equal(active.recentWorkerHeartbeat, 20);
    assert.ok(active.recentHeartbeatRatio > 0.8);
    assert.ok(active.recentWorkerHeartbeatRatio > 0.8);
    assert.match(active.warnings.join("\n"), /heartbeat audit events are \d+% of broker_audit_events in the last 10 minutes/);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteTombstoneRuntimeRepository writes tombstones directly to broker_tombstones", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    const repository = new SqliteTombstoneRuntimeRepository(store);

    repository.upsertTombstone(makeTombstone("task-runtime-old", "failed", "2026-04-27T00:01:00.000Z"));
    repository.upsertTombstone({
      ...makeTombstone("task-runtime-new", "dead_lettered", "2026-04-27T00:02:00.000Z"),
      requeueCount: 3,
      error: { code: "exceeded_requeue_limit", message: "dead lettered" },
    });

    assert.equal(repository.getTombstone("task-runtime-new")?.requeueCount, 3);
    assert.deepEqual(
      repository.listTombstones({ tombstoneReason: "dead_lettered", since: "2026-04-27T00:01:30.000Z" }).map((tombstone) => tombstone.taskId),
      ["task-runtime-new"],
    );
    assert.deepEqual(store.load().tombstones, []);
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

test("SqliteBrokerStateStore treats pruned audit hot rows as a retention window", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const snapshot: BrokerSnapshot = {
      ...emptySnapshot(),
      auditEvents: [
        makeAuditEvent("audit-old", "task.created", "task-retained", "2026-04-27T00:00:00.000Z"),
        makeAuditEvent("audit-middle", "task.started", "task-retained", "2026-04-27T00:01:00.000Z"),
        makeAuditEvent("audit-new", "task.succeeded", "task-retained", "2026-04-27T00:02:00.000Z"),
      ],
    };

    const store = new SqliteBrokerStateStore(temp.filePath);
    store.save(snapshot);
    store.pruneHotAuditEventsToMax(1);

    const status = store.readHotEntityMirrorStatus();
    assert.equal(status.ok, true);
    assert.deepEqual(status.mismatches, []);
    assert.deepEqual(status.retentionWindows, [
      {
        table: "broker_audit_events",
        snapshotKey: "auditEvents",
        tableCount: 1,
        snapshotCount: 3,
        reason: "audit_hot_retention",
        prunedCount: 2,
      },
    ]);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore still reports audit hot-table id drift", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const snapshot: BrokerSnapshot = {
      ...emptySnapshot(),
      auditEvents: [
        makeAuditEvent("audit-one", "task.created", "task-drift", "2026-04-27T00:00:00.000Z"),
        makeAuditEvent("audit-two", "task.started", "task-drift", "2026-04-27T00:01:00.000Z"),
      ],
    };

    const store = new SqliteBrokerStateStore(temp.filePath);
    store.save(snapshot);
    store.close();

    const db = new DatabaseSync(temp.filePath);
    try {
      db.prepare("UPDATE broker_audit_events SET id = ? WHERE id = ?").run("audit-rogue", "audit-two");
    } finally {
      db.close();
    }

    const reloaded = new SqliteBrokerStateStore(temp.filePath);
    const status = reloaded.readHotEntityMirrorStatus();
    assert.equal(status.ok, false);
    assert.deepEqual(status.mismatches, [
      {
        table: "broker_audit_events",
        snapshotKey: "auditEvents",
        tableCount: 2,
        snapshotCount: 2,
        reason: "id_drift",
      },
    ]);
    assert.equal(status.retentionWindows, undefined);
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

test("SqliteBrokerStateStore save hints update dirty task and audit rows while preserving retained rows", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const initialTask = makeTask("task-dirty", "queued", "worker-a");
    const retainedTask = makeTask("task-retained", "queued", "worker-b");
    const initialAudit = makeAuditEvent("audit-dirty", "task.created", "task-dirty");
    const retainedAudit = makeAuditEvent("audit-retained", "task.created", "task-retained");
    const store = new SqliteBrokerStateStore(temp.filePath);
    store.save({
      ...emptySnapshot(),
      tasks: [initialTask, retainedTask],
      auditEvents: [initialAudit, retainedAudit],
    });

    const dirtyTask = {
      ...initialTask,
      status: "claimed" as const,
      claimedBy: "worker-a",
      claimedAt: "2026-04-27T00:02:00.000Z",
      updatedAt: "2026-04-27T00:02:00.000Z",
    };
    const dirtyAudit = makeAuditEvent("audit-dirty-2", "task.claimed", "task-dirty", "2026-04-27T00:02:00.000Z");
    store.save(
      {
        ...emptySnapshot(),
        tasks: [dirtyTask, retainedTask],
        auditEvents: [initialAudit, retainedAudit, dirtyAudit],
      },
      {
        hotTasks: [dirtyTask],
        hotAuditEvents: [dirtyAudit],
      },
    );

    assert.deepEqual(store.readHotTasks().map((task) => task.id).sort(), ["task-dirty", "task-retained"]);
    assert.equal(store.readHotTasks({ id: "task-dirty" })[0]?.status, "claimed");
    assert.deepEqual(
      store.readHotAuditEvents({ targetId: "task-retained" }).map((event) => event.id),
      ["audit-retained"],
    );
    assert.equal(store.readHotEntityMirrorStatus().ok, true);

    store.save(
      {
        ...emptySnapshot(),
        tasks: [dirtyTask],
        auditEvents: [initialAudit, dirtyAudit],
      },
      {
        hotTasks: [],
        hotAuditEvents: [],
      },
    );
    assert.deepEqual(store.readHotTasks().map((task) => task.id), ["task-dirty"]);
    assert.deepEqual(store.readHotAuditEvents().map((event) => event.id).sort(), ["audit-dirty", "audit-dirty-2"]);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore incremental hints leave unrelated hot tables untouched", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    const task = makeTask("task-stable", "succeeded", "worker-a");
    const outbox = makeTerminalOutboxEvent("outbox-stable", "task-stable", "2026-04-27T00:03:00.000Z");
    const worker = makeWorker("worker-a");
    const audit = makeAuditEvent("audit-stable", "task.succeeded", "task-stable");
    store.save({
      ...emptySnapshot(),
      tasks: [task],
      workers: [worker],
      auditEvents: [audit],
      terminalOutbox: [outbox],
    });

    const heartbeat = {
      ...worker,
      updatedAt: "2026-04-27T00:04:00.000Z",
      lastSeenAt: "2026-04-27T00:04:00.000Z",
    };
    const heartbeatAudit = {
      ...makeAuditEvent("worker-heartbeat:worker-a", "worker.heartbeat", "worker-a", "2026-04-27T00:04:00.000Z"),
      targetType: "worker",
    } satisfies BrokerSnapshot["auditEvents"][number];

    store.save(
      {
        ...emptySnapshot(),
        tasks: [task],
        workers: [heartbeat],
        auditEvents: [audit, heartbeatAudit],
        terminalOutbox: [outbox],
      },
      {
        hotWorkers: [heartbeat],
        hotAuditEvents: [heartbeatAudit],
      },
    );

    assert.deepEqual(store.readHotTasks().map((row) => row.id), ["task-stable"]);
    assert.deepEqual(store.readHotTerminalOutbox().map((row) => row.id), ["outbox-stable"]);
    assert.equal(store.readHotWorkers({ nodeId: "worker-a" })[0]?.lastSeenAt, heartbeat.lastSeenAt);
    assert.deepEqual(
      store.readHotAuditEvents().map((row) => row.id).sort(),
      ["audit-stable", "worker-heartbeat:worker-a"],
    );
    assert.equal(store.getPersistenceInfo().lastPersistSkippedFullSnapshot, true);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore plans task hot-table retention from DB rows", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const oldFailed = {
      ...makeTask("task-old-failed", "failed", "worker-a"),
      completedAt: "2026-04-27T00:00:00.000Z",
      updatedAt: "2026-04-27T00:00:00.000Z",
    };
    const oldSucceeded = {
      ...makeTask("task-old-succeeded", "succeeded", "worker-a"),
      completedAt: "2026-04-27T00:01:00.000Z",
      updatedAt: "2026-04-27T00:01:00.000Z",
    };
    const oldProtected = {
      ...makeTask("task-old-protected", "canceled", "worker-a"),
      completedAt: "2026-04-27T00:02:00.000Z",
      updatedAt: "2026-04-27T00:02:00.000Z",
    };
    const recentTerminal = {
      ...makeTask("task-recent-terminal", "succeeded", "worker-a"),
      completedAt: "2026-04-27T00:45:00.000Z",
      updatedAt: "2026-04-27T00:45:00.000Z",
    };
    const running = {
      ...makeTask("task-running-old", "running", "worker-a"),
      updatedAt: "2026-04-27T00:00:00.000Z",
    };
    const store = new SqliteBrokerStateStore(temp.filePath);
    store.save({
      ...emptySnapshot(),
      tasks: [oldFailed, oldSucceeded, oldProtected, recentTerminal, running],
    });

    const plan = store.planHotTaskRetention({
      nowMs: Date.parse("2026-04-27T01:00:00.000Z"),
      retentionMs: 30 * 60 * 1000,
      maxTerminalRecords: 1,
      protectedTaskIds: ["task-old-protected"],
    });

    assert.equal(plan.table, "broker_tasks");
    assert.deepEqual(plan.pruneIds, ["task-old-failed"]);
    assert.deepEqual(plan.retainedIds, [
      "task-old-protected",
      "task-old-succeeded",
      "task-recent-terminal",
      "task-running-old",
    ]);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore plans audit hot-table retention with protected targets", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const oldPruned = makeAuditEvent("audit-old-pruned", "task.failed", "task-pruned", "2026-04-27T00:00:00.000Z");
    const oldPrunedByAge = makeAuditEvent("audit-old-by-age", "task.succeeded", "task-kept", "2026-04-27T00:01:00.000Z");
    const oldProtected = makeAuditEvent("audit-old-protected", "task.created", "task-protected", "2026-04-27T00:02:00.000Z");
    const recent = makeAuditEvent("audit-recent", "task.claimed", "task-recent", "2026-04-27T00:45:00.000Z");
    const store = new SqliteBrokerStateStore(temp.filePath);
    store.save({
      ...emptySnapshot(),
      auditEvents: [oldPruned, oldPrunedByAge, oldProtected, recent],
    });

    const plan = store.planHotAuditRetention({
      nowMs: Date.parse("2026-04-27T01:00:00.000Z"),
      retentionMs: 30 * 60 * 1000,
      maxRecords: 1,
      protectedIds: { taskIds: ["task-protected"] },
    });

    assert.equal(plan.table, "broker_audit_events");
    assert.deepEqual(plan.pruneIds, ["audit-old-by-age", "audit-old-pruned"]);
    assert.deepEqual(plan.retainedIds, [
      "audit-old-protected",
      "audit-recent",
    ]);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore caps recent worker heartbeat audit rows even when worker is protected", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const workerId = "worker-hot";
    const heartbeats = [
      makeAuditEvent("heartbeat-1", "worker.heartbeat", workerId, "2026-04-27T00:00:01.000Z"),
      makeAuditEvent("heartbeat-2", "worker.heartbeat", workerId, "2026-04-27T00:00:02.000Z"),
      makeAuditEvent("heartbeat-3", "worker.heartbeat", workerId, "2026-04-27T00:00:03.000Z"),
    ].map((event) => ({ ...event, targetType: "worker" as const }));
    const registered = {
      ...makeAuditEvent("worker-registered", "worker.registered", workerId, "2026-04-27T00:00:00.000Z"),
      targetType: "worker" as const,
    };
    const store = new SqliteBrokerStateStore(temp.filePath);
    store.save({
      ...emptySnapshot(),
      auditEvents: [registered, ...heartbeats],
    });

    const plan = store.planHotAuditRetention({
      nowMs: Date.parse("2026-04-27T00:01:00.000Z"),
      retentionMs: 60 * 60 * 1000,
      maxRecords: 2,
      protectedIds: { workerIds: [workerId] },
    });

    assert.deepEqual(plan.pruneIds, ["heartbeat-1"]);
    assert.deepEqual(plan.retainedIds, ["heartbeat-2", "heartbeat-3", "worker-registered"]);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore caps recent task heartbeat audit rows even when task is protected", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const taskId = "task-hot";
    const heartbeats = [
      makeAuditEvent("task-heartbeat-1", "task.heartbeat", taskId, "2026-04-27T00:00:01.000Z"),
      makeAuditEvent("task-heartbeat-2", "task.heartbeat", taskId, "2026-04-27T00:00:02.000Z"),
      makeAuditEvent("task-heartbeat-3", "task.heartbeat", taskId, "2026-04-27T00:00:03.000Z"),
    ];
    const created = makeAuditEvent("task-created", "task.created", taskId, "2026-04-27T00:00:00.000Z");
    const store = new SqliteBrokerStateStore(temp.filePath);
    store.save({
      ...emptySnapshot(),
      auditEvents: [created, ...heartbeats],
    });

    const plan = store.planHotAuditRetention({
      nowMs: Date.parse("2026-04-27T00:01:00.000Z"),
      retentionMs: 60 * 60 * 1000,
      maxRecords: 2,
      protectedIds: { taskIds: [taskId] },
    });

    assert.deepEqual(plan.pruneIds, ["task-heartbeat-1"]);
    assert.deepEqual(plan.retainedIds, ["task-created", "task-heartbeat-2", "task-heartbeat-3"]);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore applies task and audit hot retention plans", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const taskKeep = makeTask("task-keep", "succeeded", "worker-a");
    const taskPrune = makeTask("task-prune", "failed", "worker-a");
    const auditKeep = makeAuditEvent("audit-keep", "task.succeeded", "task-keep");
    const auditPrune = makeAuditEvent("audit-prune", "task.failed", "task-prune");
    const store = new SqliteBrokerStateStore(temp.filePath);
    store.save({
      ...emptySnapshot(),
      tasks: [taskKeep, taskPrune],
      auditEvents: [auditKeep, auditPrune],
    });

    const [taskResult, auditResult] = store.applyHotRetentionPlans([
      {
        table: "broker_tasks",
        cutoffMs: 0,
        retainedIds: ["task-keep"],
        pruneIds: ["task-prune", "task-missing"],
      },
      {
        table: "broker_audit_events",
        cutoffMs: 0,
        retainedIds: ["audit-keep"],
        pruneIds: ["audit-prune"],
      },
    ]);

    assert.deepEqual(taskResult, {
      table: "broker_tasks",
      retainedCount: 1,
      requestedPruneCount: 2,
      prunedCount: 1,
      remainingCount: 1,
    });
    assert.deepEqual(auditResult, {
      table: "broker_audit_events",
      retainedCount: 1,
      requestedPruneCount: 1,
      prunedCount: 1,
      remainingCount: 1,
    });
    assert.deepEqual(store.readHotTasks().map((task) => task.id), ["task-keep"]);
    assert.deepEqual(store.readHotAuditEvents().map((event) => event.id), ["audit-keep"]);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore save hints prune missing task and audit rows through retention plans", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    const taskKeep = makeTask("task-keep", "queued", "worker-a");
    const taskPrune = makeTask("task-prune", "failed", "worker-a");
    const auditKeep = makeAuditEvent("audit-keep", "task.created", "task-keep");
    const auditPrune = makeAuditEvent("audit-prune", "task.failed", "task-prune");
    store.save({
      ...emptySnapshot(),
      tasks: [taskKeep, taskPrune],
      auditEvents: [auditKeep, auditPrune],
    });

    store.save(
      {
        ...emptySnapshot(),
        tasks: [taskKeep],
        auditEvents: [auditKeep],
      },
      {
        hotTasks: [taskKeep],
        hotAuditEvents: [auditKeep],
      },
    );

    assert.deepEqual(store.readHotTasks().map((task) => task.id), ["task-keep"]);
    assert.deepEqual(store.readHotAuditEvents().map((event) => event.id), ["audit-keep"]);
    assert.equal(store.readHotEntityMirrorStatus().ok, true);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("broker cleanup plan reports dry-run candidates with stable gates", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const oldTerminal = {
      ...makeTask("cleanup-old-terminal", "failed", "worker-idle"),
      completedAt: "2026-04-27T00:00:00.000Z",
      updatedAt: "2026-04-27T00:00:00.000Z",
    };
    const active = {
      ...makeTask("cleanup-active", "running", "worker-active"),
      updatedAt: "2026-04-27T00:00:00.000Z",
    };
    const store = new SqliteBrokerStateStore(temp.filePath);
    store.save({
      ...emptySnapshot(),
      tasks: [oldTerminal, active],
      workers: [makeWorker("worker-idle"), makeWorker("worker-active")],
      auditEvents: [
        makeAuditEvent("cleanup-audit-old-terminal", "task.failed", oldTerminal.id, "2026-04-27T00:00:00.000Z"),
        makeAuditEvent("cleanup-audit-active", "task.started", active.id, "2026-04-27T00:00:00.000Z"),
      ],
      terminalOutbox: [
        makeOutboxEvent("cleanup-outbox-acked", oldTerminal.id, 1, "2026-04-27T00:00:00.000Z", "2026-04-27T00:00:00.000Z"),
        makeOutboxEvent("cleanup-outbox-unacked", oldTerminal.id, 2, "2026-04-27T00:00:00.000Z", null),
      ],
    });

    const plan = buildBrokerCleanupPlan(store, {
      nowMs: Date.parse("2026-04-27T01:00:00.000Z"),
      taskRetentionMs: 30 * 60 * 1000,
      maxTerminalTasks: 0,
      auditRetentionMs: 30 * 60 * 1000,
      maxAuditEvents: 0,
      workerRetentionMs: 30 * 60 * 1000,
      maxInactiveWorkers: 0,
      terminalOutboxRetentionMs: 30 * 60 * 1000,
      maxAcknowledgedTerminalOutboxEvents: 0,
    });

    assert.equal(plan.kind, "broker.cleanup.plan");
    assert.equal(plan.mode, "dry-run");
    assert.equal(plan.summary.totalPruneCandidates, 4);
    assert.equal(plan.summary.highestRisk, "high");
    assert.equal(plan.planId.length, 16);
    assert.deepEqual(plan.tables.find((table) => table.table === "broker_tasks")?.pruneIds, [oldTerminal.id]);
    assert.deepEqual(plan.tables.find((table) => table.table === "broker_audit_events")?.pruneIds, ["cleanup-audit-old-terminal"]);
    assert.deepEqual(plan.tables.find((table) => table.table === "broker_workers")?.pruneIds, ["worker-idle"]);
    assert.deepEqual(plan.tables.find((table) => table.table === "broker_terminal_outbox")?.pruneIds, ["cleanup-outbox-acked"]);
    assert.deepEqual(plan.tables.find((table) => table.table === "broker_terminal_outbox")?.retainedIds, ["cleanup-outbox-unacked"]);
    assert.equal(plan.tables.find((table) => table.table === "broker_workers")?.executionBlockedByDefault, true);
    assert.equal(plan.tables.find((table) => table.table === "broker_terminal_outbox")?.executionBlockedByDefault, true);
    assert.match(plan.notes.join("\n"), /Terminal outbox pruning is dry-run-only/);
    assert.equal(store.readHotTasks().length, 2, "dry-run plan must not mutate task rows");
    assert.equal(store.readHotTerminalOutbox().length, 2, "dry-run plan must not mutate terminal outbox rows");
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("broker cleanup execution blocks terminal outbox pruning as dry-run-only", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    store.save({
      ...emptySnapshot(),
      terminalOutbox: [
        makeOutboxEvent("cleanup-outbox-acked", "task-outbox", 1, "2026-04-27T00:00:00.000Z", "2026-04-27T00:00:00.000Z"),
      ],
    });

    const plan = buildBrokerCleanupPlan(store, {
      nowMs: Date.parse("2026-04-27T01:00:00.000Z"),
      terminalOutboxRetentionMs: 30 * 60 * 1000,
      maxAcknowledgedTerminalOutboxEvents: 0,
    });

    assert.deepEqual(plan.tables.find((table) => table.table === "broker_terminal_outbox")?.pruneIds, ["cleanup-outbox-acked"]);
    assert.throws(
      () => executeBrokerCleanupPlan(store, plan, {
        approvalToken: plan.planId,
        confirmation: BROKER_CLEANUP_CONFIRMATION,
        backupProof: "sqlite backup: /tmp/backup.sqlite sha256=abc123",
      }),
      /terminal outbox prune candidates are dry-run-only/,
    );
    assert.equal(store.readHotTerminalOutbox().length, 1, "blocked execution must not mutate terminal outbox rows");
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("broker cleanup execution requires approval, backup proof, and worker override", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const oldTerminal = {
      ...makeTask("cleanup-exec-terminal", "failed", "worker-prune"),
      completedAt: "2026-04-27T00:00:00.000Z",
      updatedAt: "2026-04-27T00:00:00.000Z",
    };
    const store = new SqliteBrokerStateStore(temp.filePath);
    store.save({
      ...emptySnapshot(),
      tasks: [oldTerminal],
      workers: [makeWorker("worker-prune")],
      auditEvents: [makeAuditEvent("cleanup-exec-audit", "task.failed", oldTerminal.id, "2026-04-27T00:00:00.000Z")],
    });

    const plan = buildBrokerCleanupPlan(store, {
      nowMs: Date.parse("2026-04-27T01:00:00.000Z"),
      taskRetentionMs: 30 * 60 * 1000,
      maxTerminalTasks: 0,
      auditRetentionMs: 30 * 60 * 1000,
      maxAuditEvents: 0,
      workerRetentionMs: 30 * 60 * 1000,
      maxInactiveWorkers: 0,
    });

    assert.deepEqual(validateCleanupExecution(plan, {}), [
      "approvalToken does not match planId",
      `confirmation must equal ${BROKER_CLEANUP_CONFIRMATION}`,
      "backupProof is required before cleanup execution",
      "worker prune candidates require allowWorkerPrune=true because stale workers may still be valid home-broker records",
    ]);

    assert.throws(
      () => executeBrokerCleanupPlan(store, plan, {
        approvalToken: plan.planId,
        confirmation: BROKER_CLEANUP_CONFIRMATION,
        backupProof: "sqlite backup: /tmp/backup.sqlite sha256=abc123",
      }),
      /worker prune candidates require allowWorkerPrune=true/,
    );

    const result = executeBrokerCleanupPlan(store, plan, {
      approvalToken: plan.planId,
      confirmation: BROKER_CLEANUP_CONFIRMATION,
      backupProof: "sqlite backup: /tmp/backup.sqlite sha256=abc123",
      allowWorkerPrune: true,
    });

    assert.equal(result.kind, "broker.cleanup.execution");
    assert.deepEqual(result.results.map((item) => [item.table, item.prunedCount]), [
      ["broker_tasks", 1],
      ["broker_audit_events", 1],
      ["broker_workers", 1],
      ["broker_terminal_outbox", 0],
    ]);
    assert.equal(result.auditEvent.action, "broker.cleanup.applied");
    assert.equal(result.auditEvent.targetType, "broker");
    assert.equal(result.auditEvent.targetId, plan.planId);
    assert.equal(store.readHotTasks().length, 0);
    assert.deepEqual(store.readHotAuditEvents().map((event) => event.action), ["broker.cleanup.applied"]);
    assert.equal(store.readHotWorkers().length, 0);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore supports worker hot-table upserts and retention plans", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const oldPruned = makeWorker("worker-old-pruned");
    const oldKeptByCap = {
      ...makeWorker("worker-old-kept"),
      lastSeenAt: "2026-04-27T00:01:00.000Z",
      updatedAt: "2026-04-27T00:01:00.000Z",
    };
    const oldProtected = {
      ...makeWorker("worker-old-protected"),
      lastSeenAt: "2026-04-27T00:02:00.000Z",
      updatedAt: "2026-04-27T00:02:00.000Z",
    };
    const recent = {
      ...makeWorker("worker-recent"),
      lastSeenAt: "2026-04-27T00:45:00.000Z",
      updatedAt: "2026-04-27T00:45:00.000Z",
    };
    const store = new SqliteBrokerStateStore(temp.filePath);
    store.save({
      ...emptySnapshot(),
      workers: [oldPruned, oldKeptByCap, oldProtected, recent],
    });

    const updatedRecent = {
      ...recent,
      displayName: "recent worker",
      lastSeenAt: "2026-04-27T00:50:00.000Z",
      updatedAt: "2026-04-27T00:50:00.000Z",
    };
    store.upsertHotWorkers([updatedRecent]);
    assert.equal(store.readHotWorkers({ nodeId: "worker-recent" })[0]?.displayName, "recent worker");

    const plan = store.planHotWorkerRetention({
      nowMs: Date.parse("2026-04-27T01:00:00.000Z"),
      retentionMs: 30 * 60 * 1000,
      maxInactiveWorkers: 1,
      protectedWorkerIds: ["worker-old-protected"],
    });
    assert.equal(plan.table, "broker_workers");
    assert.deepEqual(plan.pruneIds, ["worker-old-pruned"]);
    assert.deepEqual(plan.retainedIds, ["worker-old-kept", "worker-old-protected", "worker-recent"]);

    const result = store.applyHotRetentionPlan(plan);
    assert.deepEqual(result, {
      table: "broker_workers",
      retainedCount: 3,
      requestedPruneCount: 1,
      prunedCount: 1,
      remainingCount: 3,
    });
    assert.deepEqual(store.readHotWorkers().map((worker) => worker.nodeId).sort(), [
      "worker-old-kept",
      "worker-old-protected",
      "worker-recent",
    ]);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore save hints update dirty worker rows and prune missing workers", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    const workerKeep = makeWorker("worker-keep");
    const workerPrune = makeWorker("worker-prune");
    store.save({
      ...emptySnapshot(),
      workers: [workerKeep, workerPrune],
    });

    const dirtyWorker = {
      ...workerKeep,
      displayName: "kept worker",
      lastSeenAt: "2026-04-27T00:03:00.000Z",
      updatedAt: "2026-04-27T00:03:00.000Z",
    };
    store.save(
      {
        ...emptySnapshot(),
        workers: [dirtyWorker],
      },
      {
        hotWorkers: [dirtyWorker],
      },
    );

    assert.deepEqual(store.readHotWorkers().map((worker) => worker.nodeId), ["worker-keep"]);
    assert.equal(store.readHotWorkers({ nodeId: "worker-keep" })[0]?.displayName, "kept worker");
    assert.equal(store.readHotEntityMirrorStatus().ok, true);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore supports exchange hot-table upserts and hinted pruning", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    const exchangeKeep = makeExchange("exchange-keep", "worker-a");
    const exchangePrune = makeExchange("exchange-prune", "worker-a");
    const rootKeep = makeExchangeMessage("message-keep-root", "exchange-keep", "root");
    const rootPrune = makeExchangeMessage("message-prune-root", "exchange-prune", "root");
    store.save({
      ...emptySnapshot(),
      exchanges: [exchangeKeep, exchangePrune],
      exchangeMessages: [rootKeep, rootPrune],
    });

    const updatedExchange = {
      ...exchangeKeep,
      status: "running" as const,
      updatedAt: "2026-04-27T00:03:00.000Z",
    };
    const threadMessage = makeExchangeMessage(
      "message-keep-thread",
      "exchange-keep",
      "thread",
      "message-keep-root",
      "2026-04-27T00:03:00.000Z",
    );
    store.save(
      {
        ...emptySnapshot(),
        exchanges: [updatedExchange],
        exchangeMessages: [rootKeep, threadMessage],
      },
      {
        hotExchanges: [updatedExchange],
        hotExchangeMessages: [threadMessage],
      },
    );

    assert.deepEqual(store.readHotExchanges().map((exchange) => exchange.id), ["exchange-keep"]);
    assert.deepEqual(store.readHotExchangeMessages({ exchangeId: "exchange-keep" }).map((message) => message.id), [
      "message-keep-root",
      "message-keep-thread",
    ]);
    assert.equal(store.readHotEntityMirrorStatus().ok, true);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore supports proposal artifact and validation hot-table upserts and hinted pruning", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    const proposalKeep = makeProposal("proposal-keep", "submitted", "worker-a");
    const proposalPrune = makeProposal("proposal-prune", "rejected", "worker-a");
    const artifactKeep = makeArtifact("artifact-keep", "proposal-keep");
    const artifactPrune = makeArtifact("artifact-prune", "proposal-prune");
    const validationKeep = makeValidation("validation-keep", "proposal-keep");
    const validationPrune = makeValidation("validation-prune", "proposal-prune");
    store.save({
      ...emptySnapshot(),
      proposals: [proposalKeep, proposalPrune],
      artifacts: [artifactKeep, artifactPrune],
      validations: [validationKeep, validationPrune],
    });

    const updatedProposal = {
      ...proposalKeep,
      status: "validated" as const,
      artifactIds: [artifactKeep.id],
      updatedAt: "2026-04-27T00:03:00.000Z",
    };
    const updatedArtifact = {
      ...artifactKeep,
      summary: "kept artifact",
    };
    const updatedValidation = {
      ...validationKeep,
      verdict: "pass" as const,
    };
    store.save(
      {
        ...emptySnapshot(),
        proposals: [updatedProposal],
        artifacts: [updatedArtifact],
        validations: [updatedValidation],
      },
      {
        hotProposals: [updatedProposal],
        hotArtifacts: [updatedArtifact],
        hotValidations: [updatedValidation],
      },
    );

    assert.deepEqual(store.readHotProposals().map((proposal) => [proposal.id, proposal.status]), [["proposal-keep", "validated"]]);
    assert.deepEqual(store.readHotArtifacts().map((artifact) => [artifact.id, artifact.summary]), [["artifact-keep", "kept artifact"]]);
    assert.deepEqual(store.readHotValidations().map((validation) => [validation.id, validation.verdict]), [["validation-keep", "pass"]]);
    assert.equal(store.readHotEntityMirrorStatus().ok, true);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore supports tombstone hot-table reads and hinted pruning", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    const keep = makeTombstone("task-keep", "failed", "2026-04-27T00:03:00.000Z");
    const prune = makeTombstone("task-prune", "canceled", "2026-04-27T00:01:00.000Z");
    store.save({
      ...emptySnapshot(),
      tombstones: [keep, prune],
    });

    assert.deepEqual(store.readHotTombstones().map((tombstone) => tombstone.taskId), ["task-keep", "task-prune"]);
    assert.deepEqual(store.readHotTombstones({ tombstoneReason: "failed" }).map((tombstone) => tombstone.taskId), ["task-keep"]);
    assert.deepEqual(store.readHotTombstones({ since: "2026-04-27T00:02:00.000Z" }).map((tombstone) => tombstone.taskId), ["task-keep"]);

    const updated = { ...keep, durationMs: 180_000, tombstonedAt: "2026-04-27T00:04:00.000Z" };
    store.save(
      {
        ...emptySnapshot(),
        tombstones: [updated],
      },
      {
        hotTombstones: [updated],
      },
    );

    assert.deepEqual(store.readHotTombstones().map((tombstone) => [tombstone.taskId, tombstone.durationMs]), [["task-keep", 180_000]]);
    assert.equal(store.readHotEntityMirrorStatus().ok, true);
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
    assert.equal(store.getPersistenceInfo().schemaVersion, 10);
    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore accepts operator-origin hot task payloads", () => {
  const temp = withTempFile("state.sqlite");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    const operatorTask: BrokerSnapshot["tasks"][number] = {
      ...makeTask("task-operator", "queued", "worker-a"),
      taskOrigin: "operator",
    };
    store.save({
      ...emptySnapshot(),
      tasks: [operatorTask],
    });
    store.close();

    const reloaded = new SqliteBrokerStateStore(temp.filePath);
    assert.deepEqual(reloaded.readHotTasks({ taskOrigin: "operator" }).map((task) => task.id), ["task-operator"]);
    assert.equal(reloaded.load().tasks[0]!.taskOrigin, "operator");
    reloaded.close();
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

function makeTombstone(
  taskId: string,
  tombstoneReason: NonNullable<BrokerSnapshot["tombstones"]>[number]["tombstoneReason"],
  tombstonedAt = "2026-04-27T00:02:00.000Z",
): NonNullable<BrokerSnapshot["tombstones"]>[number] {
  return {
    taskId,
    terminalStatus: tombstoneReason === "canceled" ? "canceled" : "failed",
    tombstoneReason,
    durationMs: 120_000,
    requeueCount: 0,
    error: tombstoneReason === "failed" ? { code: "handler_error", message: "failed" } : undefined,
    tombstonedAt,
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

function makeTerminalOutboxEvent(id: string, taskId: string, createdAt: string): TerminalTaskOutboxEvent {
  return {
    id,
    kind: "task.terminal",
    taskEventId: Number(createdAt.slice(17, 19)),
    payload: {
      taskId,
      status: "succeeded",
      worker: "worker-a",
      createdAt,
      updatedAt: createdAt,
      completedAt: createdAt,
    },
    createdAt,
    receipt: {
      status: "accepted",
      updatedAt: createdAt,
    },
    attempts: 0,
  };
}

function makeOutboxEvent(
  id: string,
  taskId: string,
  eventId: number,
  createdAt: string,
  acknowledgedAt: string | null,
): BrokerSnapshot["terminalOutbox"] extends (infer T)[] | undefined ? T : never {
  const event: Record<string, unknown> = {
    id,
    kind: "task.terminal" as const,
    taskEventId: eventId,
    payload: {
      taskId,
      status: "succeeded" as const,
      createdAt,
      updatedAt: createdAt,
    },
    createdAt,
    receipt: {
      status: "produced" as const,
      updatedAt: createdAt,
    },
    attempts: 0,
  };
  if (acknowledgedAt) {
    event.ack = {
      status: "receipt_confirmed" as const,
      evidence: "operator_visible" as const,
      acknowledgedAt,
    };
  }
  return event as unknown as NonNullable<BrokerSnapshot["terminalOutbox"]>[number];
}

test("SqliteBrokerStateStore.readHotTableLoadMetrics returns per-table counts and max payload sizes", () => {
  const temp = withTempFile("hot-metrics.db");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);

    // Seed with known counts using save (which writes to hot tables)
    const t0 = "2026-04-27T00:00:00.000Z";
    const tasks: BrokerSnapshot["tasks"] = Array.from({ length: 5 }, (_, i) => ({
      ...makeTask(`task-${i}`, "succeeded", "worker-0"),
      createdAt: t0,
      updatedAt: t0,
    }));
    const auditEvents = Array.from({ length: 10 }, (_, i) =>
      makeAuditEvent(`audit-${i}`, "task.created", "task-0", t0),
    );
    const workers = [makeWorker("worker-0")];
    const terminalOutbox = [
      makeOutboxEvent("outbox-acked", "task-0", 0, t0, t0),
      makeOutboxEvent("outbox-unacked", "task-1", 1, t0, null),
    ];
    const tombstones = [makeTombstone("task-0", "failed", t0)];

    store.save(
      {
        ...emptySnapshot(),
        tasks,
        auditEvents,
        workers,
        terminalOutbox,
        tombstones,
      },
      {},
    );

    const metrics = store.readHotTableLoadMetrics();

    // Verify task counts and payload size
    assert.ok(metrics.tables["broker_tasks"], "broker_tasks should exist");
    assert.equal(metrics.tables["broker_tasks"].count, 5, "task count");
    assert.ok(metrics.tables["broker_tasks"].maxPayloadBytes > 0, "tasks should have nonzero max payload");
    assert.deepEqual(metrics.tables["broker_tasks"].runtimeLoad, {
      limit: 2000,
      loadedCount: 5,
      skippedCount: 0,
      activeCount: 0,
      terminalCount: 5,
    });

    // Verify audit event counts
    assert.equal(metrics.tables["broker_audit_events"].count, 10, "audit event count");
    assert.deepEqual(metrics.tables["broker_audit_events"].runtimeLoad, {
      limit: 5000,
      loadedCount: 10,
      skippedCount: 0,
    });

    // Verify terminal outbox with unacked count
    assert.equal(metrics.tables["broker_terminal_outbox"].count, 2, "terminal outbox count");
    assert.equal(metrics.tables["broker_terminal_outbox"].unackedCount, 1, "unacked count should be 1");
    assert.deepEqual(metrics.tables["broker_terminal_outbox"].runtimeLoad, {
      limit: 1000,
      loadedCount: 2,
      skippedCount: 0,
    });

    // Verify tombstone counts
    assert.equal(metrics.tables["broker_tombstones"].count, 1, "tombstone count");

    // Verify worker counts
    assert.equal(metrics.tables["broker_workers"].count, 1, "worker count");

    // Verify empty tables report zero
    assert.equal(metrics.tables["broker_artifacts"].count, 0, "artifacts should be zero");
    assert.equal(metrics.tables["broker_validations"].count, 0, "validations should be zero");
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore hot-table runtime load caps hydrate bounded rows and expose skipped counts", () => {
  const temp = withTempFile("hot-runtime-caps.db");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath, {
      loadSource: "hot-tables",
      maxHotRuntimeTerminalTasks: 2,
      maxHotRuntimeAuditEvents: 3,
      maxHotRuntimeTerminalOutboxEvents: 1,
    });
    const t0 = "2026-04-27T00:00:00.000Z";
    const activeTasks: BrokerSnapshot["tasks"] = Array.from({ length: 3 }, (_, i) => ({
      ...makeTask(`active-${i}`, (["queued", "claimed", "running"] as const)[i], "worker-0"),
      createdAt: t0,
      updatedAt: t0,
    }));
    const terminalTasks: BrokerSnapshot["tasks"] = Array.from({ length: 5 }, (_, i) => ({
      ...makeTask(`terminal-${i}`, i % 2 === 0 ? "succeeded" : "failed", "worker-0"),
      createdAt: t0,
      updatedAt: `2026-04-27T00:00:0${i}.000Z`,
    }));
    const auditEvents = Array.from({ length: 6 }, (_, i) =>
      makeAuditEvent(`audit-cap-${i}`, "task.created", `terminal-${i % terminalTasks.length}`, t0),
    );
    const terminalOutbox = Array.from({ length: 4 }, (_, i) =>
      makeOutboxEvent(`outbox-cap-${i}`, `terminal-${i}`, i, `2026-04-27T00:00:0${i}.000Z`, i === 0 ? null : t0),
    );

    store.save({
      ...emptySnapshot(),
      tasks: [...activeTasks, ...terminalTasks],
      auditEvents,
      terminalOutbox,
    }, {});

    const loaded = store.load();
    assert.equal(loaded.tasks.length, 5, "active tasks plus the newest two terminal tasks hydrate");
    assert.equal(loaded.auditEvents.length, 3, "audit runtime hydration respects configured cap");
    assert.equal(loaded.terminalOutbox?.length ?? 0, 1, "terminal outbox runtime hydration respects configured cap");

    const metrics = store.readHotTableLoadMetrics();
    assert.deepEqual(metrics.tables["broker_tasks"].runtimeLoad, {
      limit: 2,
      loadedCount: 5,
      skippedCount: 3,
      activeCount: 3,
      terminalCount: 5,
    });
    assert.deepEqual(metrics.tables["broker_audit_events"].runtimeLoad, {
      limit: 3,
      loadedCount: 3,
      skippedCount: 3,
    });
    assert.equal(metrics.tables["broker_terminal_outbox"].unackedCount, 1);
    assert.deepEqual(metrics.tables["broker_terminal_outbox"].runtimeLoad, {
      limit: 1,
      loadedCount: 1,
      skippedCount: 3,
    });
    assert.deepEqual(store.readHotTableRuntimeLoadLimits(), {
      terminalTasks: 2,
      auditEvents: 3,
      terminalOutboxEvents: 1,
    });
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore.readHotRuntimeSnapshot survives representative load (hot-tables load source)", () => {
  const temp = withTempFile("hot-regr.db");
  try {
    // Create with hot-tables load source to exercise the exact regression path from #497
    const store = new SqliteBrokerStateStore(temp.filePath, { loadSource: "hot-tables" });

    // Seed representative data matching observed seoseo broker shape
    const t0 = "2026-04-27T00:00:00.000Z";
    const taskCount = 660;
    const auditCount = 1908;
    const workerCount = 21;
    const tombstoneCount = 177;
    const outboxCount = 389;
    const exchangeCount = 15;
    const exchangeMessageCount = 31;
    const proposalCount = 13;

    const tasks: BrokerSnapshot["tasks"] = Array.from({ length: taskCount }, (_, i) => ({
      ...makeTask(`task-r-${i}`, i % 4 === 0 ? "failed" : "succeeded", "worker-0"),
      createdAt: t0,
      updatedAt: t0,
    }));
    const auditEvents = Array.from({ length: auditCount }, (_, i) =>
      makeAuditEvent(`audit-r-${i}`, i % 3 === 0 ? "worker.heartbeat" : "task.created", "task-0", t0),
    );
    const workers = Array.from({ length: workerCount }, (_, i) =>
      makeWorker(`worker-r-${i}`),
    );
    const terminalOutbox = Array.from({ length: outboxCount }, (_, i) =>
      makeOutboxEvent(
        `outbox-r-${i}`,
        `task-r-${i % taskCount}`,
        i,
        t0,
        i < 200 ? null : t0,
      ),
    );
    const tombstones = Array.from({ length: tombstoneCount }, (_, i) =>
      makeTombstone(`task-r-${i}`, "failed", t0),
    );
    const exchanges = Array.from({ length: exchangeCount }, (_, i) =>
      makeExchange(`ex-r-${i}`, "worker-0", t0),
    );
    const exchangeMessages = Array.from({ length: exchangeMessageCount }, (_, i) =>
      makeExchangeMessage(`exmsg-r-${i}`, `ex-r-${i % exchangeCount}`, "root", undefined, t0),
    );
    const proposals = Array.from({ length: proposalCount }, (_, i) =>
      makeProposal(`proposal-r-${i}`, "submitted", "worker-0", t0),
    );

    const snapshot: BrokerSnapshot = {
      ...emptySnapshot(),
      tasks,
      auditEvents,
      workers,
      terminalOutbox,
      tombstones,
      exchanges,
      exchangeMessages,
      proposals,
    };

    store.save(snapshot, {});

    // Read back the entire hot-table snapshot — this is the exact code path
    // that caused OOM in issue #497
    const loaded = store.load();

    // Verify counts match (this asserts the read path is correct and doesn't crash)
    assert.equal(loaded.tasks.length, taskCount, "loaded task count should match seeded");
    assert.equal(loaded.auditEvents.length, auditCount, "loaded audit event count should match seeded");
    assert.equal(loaded.workers.length, workerCount, "loaded worker count should match seeded");
    assert.equal(loaded.terminalOutbox?.length ?? 0, outboxCount, "loaded terminal outbox count should match seeded");
    assert.equal(loaded.tombstones?.length ?? 0, tombstoneCount, "loaded tombstone count should match seeded");
    assert.equal(loaded.exchanges.length, exchangeCount, "loaded exchange count should match seeded");
    assert.equal(loaded.exchangeMessages.length, exchangeMessageCount, "loaded exchange message count should match seeded");
    assert.equal(loaded.proposals.length, proposalCount, "loaded proposal count should match seeded");

    // Verify structural integrity: all tasks have id and status
    assert.ok(loaded.tasks.every((t) => typeof t.id === "string" && typeof t.status === "string"), "all tasks have id and status");
    assert.ok(loaded.auditEvents.every((e) => typeof e.id === "string" && typeof e.action === "string"), "all audit events have id and action");
    assert.ok(loaded.workers.every((w) => typeof w.nodeId === "string"), "all workers have nodeId");

    // Verify readHotEntityMirrorStatus reports OK after consistent save/load
    const mirror = store.readHotEntityMirrorStatus();
    assert.ok(mirror.ok, `mirror status should be ok: ${JSON.stringify(mirror.mismatches)}`);
    assert.equal(mirror.mismatches.length, 0, "no mismatches after consistent load");

    // Verify readHotTableLoadMetrics gives correct counts
    const metrics = store.readHotTableLoadMetrics();
    assert.equal(metrics.tables["broker_tasks"].count, taskCount, "hot table metrics: task count");
    assert.equal(metrics.tables["broker_terminal_outbox"].unackedCount, 200, "hot table metrics: unacked count");
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore planHotTaskRetention identifies prune candidates", () => {
  const temp = withTempFile("hot-retention.db");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    const t0 = "2026-04-27T00:00:00.000Z";

    // 500 terminal tasks + 160 active tasks
    const terminalTasks: BrokerSnapshot["tasks"] = Array.from({ length: 500 }, (_, i) => ({
      ...makeTask(`rt-${i}`, i % 3 === 0 ? "failed" : "succeeded", "worker-0"),
      createdAt: t0,
      updatedAt: t0,
    }));
    const activeTasks: BrokerSnapshot["tasks"] = Array.from({ length: 160 }, (_, i) => ({
      ...makeTask(`ra-${i}`, (["queued", "running", "claimed"] as const)[i % 3], "worker-0"),
      createdAt: t0,
      updatedAt: t0,
    }));

    store.save(
      { ...emptySnapshot(), tasks: [...terminalTasks, ...activeTasks], workers: [makeWorker("worker-0")] },
      {},
    );

    // Plan retention with a short window — should identify many terminal tasks for pruning
    const plan = store.planHotTaskRetention({
      retentionMs: 60 * 60 * 1000, // 1 hour
      maxTerminalRecords: 100,
    });

    // The plan should have retain and prune recommendations
    assert.equal(plan.table, "broker_tasks", "plan should target broker_tasks");
    assert.ok(plan.retainedIds.length >= 100, `should retain at least maxTerminalRecords (got ${plan.retainedIds.length})`);
    assert.ok(plan.pruneIds.length > 0, "should identify prune candidates");
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore readHotRuntimeSnapshot caps non-terminal tasks with maxHotRuntimeNonTerminalTasks", () => {
  const temp = withTempFile("hot-nonterminal-cap.db");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath, {
      loadSource: "hot-tables",
      maxHotRuntimeNonTerminalTasks: 3,
      maxHotRuntimeTerminalTasks: 2,
    });

    // 10 non-terminal tasks (queued/claimed/running) + 5 terminal tasks (succeeded/failed)
    const nonTerminal: BrokerSnapshot["tasks"] = Array.from({ length: 10 }, (_, i) => ({
      ...makeTask(`nt-${i}`, (["queued", "claimed", "running"] as const)[i % 3], "worker-0"),
      createdAt: `2026-04-27T00:0${i}:00.000Z`,
      updatedAt: `2026-04-27T00:0${i}:00.000Z`,
    }));
    const terminal: BrokerSnapshot["tasks"] = Array.from({ length: 5 }, (_, i) => ({
      ...makeTask(`t-${i}`, i % 2 === 0 ? "succeeded" : "failed", "worker-0"),
      createdAt: `2026-04-27T01:0${i}:00.000Z`,
      updatedAt: `2026-04-27T01:0${i}:00.000Z`,
    }));

    store.save({ ...emptySnapshot(), tasks: [...nonTerminal, ...terminal], workers: [makeWorker("worker-0")] });

    const hotSnapshot = store.readHotRuntimeSnapshot();
    const hotTasks = hotSnapshot.tasks;
    // Should have at most 3 non-terminal (ordered by updated_at DESC, id ASC) + at most 2 terminal
    assert.ok(hotTasks.length <= 5, `expected at most 5 hot tasks, got ${hotTasks.length}`);

    const nonTerminalIds = hotTasks
      .filter((t) => ["queued", "claimed", "running"].includes(t.status))
      .map((t) => t.id);
    assert.ok(nonTerminalIds.length <= 3, `expected at most 3 non-terminal tasks, got ${nonTerminalIds.length}`);
    // The most recent non-terminal tasks should be included
    assert.ok(nonTerminalIds.includes("nt-9"), "most recent non-terminal task should be included");
    assert.ok(nonTerminalIds.includes("nt-8"), "second most recent non-terminal task should be included");

    const terminalIds = hotTasks
      .filter((t) => ["succeeded", "failed", "canceled"].includes(t.status))
      .map((t) => t.id);
    assert.ok(terminalIds.length <= 2, `expected at most 2 terminal tasks, got ${terminalIds.length}`);

    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore readHotTerminalOutboxDiagnostics reports unacked staleness", () => {
  const temp = withTempFile("hot-outbox-diag.db");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    const now = new Date();
    const oldDate = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();

    const snapshot: BrokerSnapshot = {
      ...emptySnapshot(),
      terminalOutbox: [
        makeTerminalOutboxEvent("outbox-1", "task-1", oldDate),
        {
          ...makeTerminalOutboxEvent("outbox-2", "task-2", now.toISOString()),
          ack: {
            status: "receipt_confirmed" as const,
            evidence: "operator_visible" as const,
            acknowledgedAt: now.toISOString(),
          },
        },
        makeTerminalOutboxEvent("outbox-3", "task-3", oldDate),
      ],
    };
    store.save(snapshot);

    const diag = store.readHotTerminalOutboxDiagnostics();
    assert.equal(diag.total, 3);
    assert.equal(diag.acked, 1);
    assert.equal(diag.unacked, 2);
    assert.ok(diag.unackedRatio > 0.5);
    assert.ok(diag.oldestUnackedCreatedAt !== null);
    assert.ok(diag.oldestUnackedAgeMs !== null);
    assert.ok(diag.oldestUnackedAgeMs! > 12 * 24 * 60 * 60 * 1000, "oldest unacked should be >12 days old");
    // The oldest unacked warning should fire (>7 days)
    assert.ok(diag.warnings.some((w) => w.includes("days old")), "should warn about old unacked entry");

    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore incremental persist skips full snapshot serialization when hot hints present", () => {
  const temp = withTempFile("incremental-persist.db");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    const snapshot: BrokerSnapshot = {
      ...emptySnapshot(),
      tasks: [makeTask("task-1", "queued", "worker-a"), makeTask("task-2", "running", "worker-b")],
      auditEvents: [makeAuditEvent("audit-1", "task.created", "task-1"), makeAuditEvent("audit-2", "task.claimed", "task-2")],
      workers: [makeWorker("worker-a"), makeWorker("worker-b")],
      terminalOutbox: [makeTerminalOutboxEvent("outbox-1", "task-1", "2026-04-27T00:00:00.000Z"), makeTerminalOutboxEvent("outbox-2", "task-2", "2026-04-27T00:00:00.000Z")],
    };
    // Full persist: snapshot row MUST be written
    store.save(snapshot);

    let info = store.getPersistenceInfo();
    assert.ok(info.lastPersistAt !== undefined, "lastPersistAt should be set after persist");
    assert.equal(info.lastPersistSkippedFullSnapshot, false, "full persist should not skip snapshot");

    // Incremental persist: snapshot row should NOT be serialized again; only hot tables written
    const dirtyTask = { ...snapshot.tasks[0], status: "claimed" as const, claimedAt: "2026-05-01T00:00:00.000Z", updatedAt: "2026-05-01T00:00:00.000Z" };
    store.save(
      {
        ...emptySnapshot(),
        tasks: [dirtyTask, snapshot.tasks[1]],
        auditEvents: snapshot.auditEvents,
        terminalOutbox: snapshot.terminalOutbox,
      },
      {
        hotTasks: [dirtyTask],
        hotAuditEvents: [snapshot.auditEvents[0]],
      },
    );

    info = store.getPersistenceInfo();
    assert.equal(info.lastPersistSkippedFullSnapshot, true, "incremental persist should skip snapshot");
    assert.ok(info.lastHotHintCounts !== undefined, "hot hint counts should be recorded");
    assert.equal(info.lastHotHintCounts!.hotTasks, 1, "should report 1 dirty task hint");
    assert.equal(info.lastHotHintCounts!.hotAuditEvents, 1, "should report 1 dirty audit hint");

    // Verify hot table has the updated data
    const hotTasks = store.readHotTasks();
    const task1 = hotTasks.find((t) => t.id === "task-1");
    assert.equal(task1?.status, "claimed", "hot table should contain updated task");

    store.close();
  } finally {
    temp.cleanup();
  }
});

test("SqliteBrokerStateStore getPersistenceInfo returns incremental persist diagnostics", () => {
  const temp = withTempFile("persist-diag.db");
  try {
    const store = new SqliteBrokerStateStore(temp.filePath);
    const snapshot: BrokerSnapshot = {
      ...emptySnapshot(),
      tasks: [makeTask("task-pd-1", "queued", "worker-a"), makeTask("task-pd-2", "running", "worker-b")],
      auditEvents: [makeAuditEvent("audit-pd-1", "task.created", "task-pd-1")],
      workers: [makeWorker("worker-a")],
    };
    // Full persist
    store.save(snapshot);
    let info = store.getPersistenceInfo();
    assert.ok(info.lastPersistAt !== undefined, "lastPersistAt should be set");
    assert.equal(info.lastPersistSkippedFullSnapshot, false, "full persist should not skip snapshot");
    assert.equal(info.lastHotHintCounts, undefined, "no hot hints should mean no hot hint counts");

    // Incremental persist with hints
    const dirtyTask = { ...snapshot.tasks[0], status: "claimed" as const, claimedAt: "2026-05-01T00:00:00.000Z", updatedAt: "2026-05-01T00:00:00.000Z" };
    store.save(
      {
        ...emptySnapshot(),
        tasks: [dirtyTask, snapshot.tasks[1]],
        auditEvents: snapshot.auditEvents,
        workers: snapshot.workers,
      },
      {
        hotTasks: [dirtyTask],
        hotWorkers: [snapshot.workers[0]],
      },
    );

    info = store.getPersistenceInfo();
    assert.ok(info.lastPersistAt !== undefined, "lastPersistAt should still be set");
    assert.equal(info.lastPersistSkippedFullSnapshot, true, "incremental persist should skip snapshot");
    assert.ok(info.lastHotHintCounts !== undefined, "hot hint counts should be present");
    assert.equal(info.lastHotHintCounts!.hotTasks, 1, "should report 1 dirty task");
    assert.equal(info.lastHotHintCounts!.hotWorkers, 1, "should report 1 dirty worker");
    // No terminal outbox events were dirty
    assert.equal(info.lastHotHintCounts!.hotTerminalOutboxEvents, 0, "no terminal outbox hints");

    store.close();
  } finally {
    temp.cleanup();
  }
});
