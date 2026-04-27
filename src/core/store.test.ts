import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      schemaVersion: 1,
      journalMode: "wal",
      importedFromJsonFile: undefined,
      lastImportAt: undefined,
    });
    reloaded.close();
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
  } finally {
    temp.cleanup();
  }
});
