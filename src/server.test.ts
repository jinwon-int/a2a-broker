import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createBrokerServer, type BrokerServerOptions } from "./server.js";
import {
  DECISION_DIALECTIC_KIND,
  DECISION_DIALECTIC_VERSION,
  type DecisionDialecticTaskInputV1,
  type DecisionDialecticTaskV1,
} from "./decision-dialectic/types.js";
import {
  emptySnapshot,
  SqliteBrokerStateStore,
  type BrokerSnapshot,
  type BrokerStateStore,
} from "./core/store.js";
import {
  TRADING_DIALECTIC_KIND,
  TRADING_DIALECTIC_VERSION,
  type TradingDialecticTaskInputV1,
  type TradingDialecticTaskV1,
} from "./trading-dialectic/types.js";
import type { WorkerRegistrationResponse } from "./core/types.js";

function createInMemoryStateStore(): BrokerStateStore {
  let snapshot = emptySnapshot();
  return {
    load() {
      return snapshot;
    },
    save(nextSnapshot) {
      snapshot = structuredClone(nextSnapshot);
    },
  };
}

async function startTestServer(options: Partial<BrokerServerOptions> = {}) {
  const runtime = createBrokerServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "https://broker.test/",
    stateStore: createInMemoryStateStore(),
    enforceRequesterIdentity: true,
    // Default tests off unless explicitly enabled so periodic sweeps don't race with
    // assertions about idle broker state.
    staleReaperEnabled: options.staleReaperEnabled ?? false,
    ...options,
  });
  runtime.server.listen(0, "127.0.0.1");
  await once(runtime.server, "listening");
  const address = runtime.server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to bind test server");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    runtime,
    close: async () => {
      runtime.server.close();
      runtime.server.closeAllConnections?.();
      await once(runtime.server, "close");
    },
  };
}

function jsonHeaders(headers: Record<string, string> = {}): Record<string, string> {
  return {
    "content-type": "application/json",
    ...headers,
  };
}

async function withEnv<T>(patch: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const previous = new Map(Object.keys(patch).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function registerTestWorker(
  baseUrl: string,
  nodeId: string,
  role: string,
  edgeSecret?: string,
): Promise<void> {
  const headers: Record<string, string> = {
    "x-a2a-requester-id": nodeId,
    "x-a2a-requester-role": role,
  };
  if (edgeSecret) {
    headers["x-a2a-edge-secret"] = edgeSecret;
  }
  const res = await fetch(`${baseUrl}/workers/register`, {
    method: "POST",
    headers: jsonHeaders(headers),
    body: JSON.stringify({
      nodeId,
      role,
      capabilities: {
        canAnalyze: true,
        canBackfill: false,
        canPatchWorkspace: false,
        canPromoteLive: false,
        workspaceIds: ["test"],
        environments: ["research"],
      },
    }),
  });
  if (res.status !== 201) {
    throw new Error(
      `failed to register test worker ${nodeId}: ${res.status} ${await res.text()}`,
    );
  }
}

test("server accepts a broker-agnostic Hermes-style worker poll and evidence flow", async () => {
  const server = await startTestServer({ enforceRequesterIdentity: false });
  const workerId = "hermes-agent-reference-worker";
  try {
    const registerRes = await fetch(server.baseUrl + "/workers/register", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        nodeId: workerId,
        role: "analyst",
        displayName: "Hermes Agent Reference Worker",
        brokerUrl: "http://127.0.0.1:8787",
        workerMode: "mobile",
        capabilities: {
          canAnalyze: true,
          canBackfill: false,
          canPatchWorkspace: true,
          canPromoteLive: false,
          workspaceIds: ["public-safe-reference"],
          environments: ["research"],
        },
        metadata: {
          runtime: "hermes-agent",
          openClawRequired: "false",
          transport: "http-poll",
        },
      }),
    });
    assert.equal(registerRes.status, 201);
    const registered = await registerRes.json() as WorkerRegistrationResponse;
    assert.equal(registered.nodeId, workerId);
    assert.equal(registered.workerMode, "mobile");
    assert.deepEqual(registered.metadata, {
      runtime: "hermes-agent",
      openClawRequired: "false",
      transport: "http-poll",
    });

    const heartbeatRes = await fetch(server.baseUrl + "/workers/" + workerId + "/heartbeat", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ metadata: { runtime: "hermes-agent", heartbeat: "ok" } }),
    });
    assert.equal(heartbeatRes.status, 200);
    const heartbeat = await heartbeatRes.json() as WorkerRegistrationResponse;
    assert.deepEqual(heartbeat.metadata, { runtime: "hermes-agent", heartbeat: "ok" });

    const createRes = await fetch(server.baseUrl + "/tasks", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        id: "task-hermes-reference-worker",
        requester: { id: "hermes-requester", kind: "service", role: "hub" },
        target: { id: workerId, kind: "node", role: "analyst" },
        targetNodeId: workerId,
        intent: "analyze",
        message: "Broker-agnostic worker contract smoke task",
        payload: { source: "hermes-worker-integration-test" },
        taskOrigin: "api",
      }),
    });
    assert.equal(createRes.status, 201);

    const pollRes = await fetch(
      server.baseUrl + "/tasks?worker=" + encodeURIComponent(workerId) + "&status=pending&detail=full",
    );
    assert.equal(pollRes.status, 200);
    const polled = await pollRes.json() as { items: Array<{ id: string; status: string; assignedWorkerId?: string }> };
    assert.deepEqual(polled.items.map((task) => [task.id, task.status, task.assignedWorkerId]), [
      ["task-hermes-reference-worker", "queued", workerId],
    ]);

    const claimRes = await fetch(server.baseUrl + "/tasks/task-hermes-reference-worker/claim", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ workerId }),
    });
    assert.equal(claimRes.status, 200);

    const startRes = await fetch(server.baseUrl + "/tasks/task-hermes-reference-worker/start", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ workerId }),
    });
    assert.equal(startRes.status, 200);

    const evidenceRes = await fetch(server.baseUrl + "/tasks/task-hermes-reference-worker/evidence", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        workerId,
        outcome: "done",
        result: {
          summary: "Hermes-style worker produced redacted terminal evidence",
          output: { referenceWorker: "hermes-agent", openClawRequired: false },
        },
      }),
    });
    assert.equal(evidenceRes.status, 200);
    const evidenced = await evidenceRes.json() as {
      status: string;
      result?: { summary?: string; output?: Record<string, unknown> };
    };
    assert.equal(evidenced.status, "succeeded");
    assert.equal(evidenced.result?.summary, "Hermes-style worker produced redacted terminal evidence");
    assert.deepEqual(evidenced.result?.output, { referenceWorker: "hermes-agent", openClawRequired: false });
  } finally {
    await server.close();
  }
});

test("server requires a real PUBLIC_BASE_URL", () => {
  assert.throws(
    () =>
      createBrokerServer({
        host: "127.0.0.1",
        port: 0,
        publicBaseUrl: "http://<masked-host>:8787",
        stateStore: createInMemoryStateStore(),
      }),
    /PUBLIC_BASE_URL must not use the placeholder/,
  );

  assert.throws(
    () =>
      createBrokerServer({
        host: "127.0.0.1",
        port: 0,
        publicBaseUrl: "",
        stateStore: createInMemoryStateStore(),
      }),
    /PUBLIC_BASE_URL is required/,
  );
});

test("server exposes empty worker capacity preflight as compact response", async () => {
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/workers/capacity`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.items, []);
    assert.equal(body.totals.workers, 0);
    assert.equal(body.totals.active, 0);
  } finally {
    await server.close();
  }
});

test("server surfaces env-injected broker version/build revision on health and dashboard status", async () => {
  await withEnv({
    A2A_BROKER_REVISION: "78b2b42fca6e",
    A2A_BROKER_VERSION: "0.2.3",
    A2A_BROKER_SOURCE: undefined,
    A2A_BROKER_BUILT_AT: undefined,
    A2A_BROKER_RUNTIME: undefined,
    A2A_BROKER_IMAGE_TAG: undefined,
    A2A_BROKER_IMAGE_DIGEST: undefined,
  }, async () => {
    const server = await startTestServer({ buildInfoFile: "/dev/null" });
    try {
      assert.equal(server.runtime.config.version, "0.2.3");
      assert.equal(server.runtime.config.build.revision, "78b2b42fca6e");

      const healthRes = await fetch(`${server.baseUrl}/health`);
      assert.equal(healthRes.status, 200);
      assert.equal(healthRes.headers.get("cache-control"), "no-store");
      const health = await healthRes.json();
      assert.equal(health.version, "0.2.3");
      assert.deepEqual(health.build, {
        component: "a2a-broker",
        revision: "78b2b42fca6e",
        source: "github.com/jinwon-int/a2a-broker",
      });

      const dashboardRes = await fetch(`${server.baseUrl}/dashboard`, {
        headers: {
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        },
      });
      assert.equal(dashboardRes.status, 200);
      const dashboard = await dashboardRes.json();
      assert.equal(dashboard.version, health.version);
      assert.deepEqual(dashboard.build, health.build);
    } finally {
      await server.close();
    }
  });
});

test("server exposes lightweight liveness without persistence diagnostics", async () => {
  const server = await startTestServer({
    edgeSecret: "test-edge-secret",
  });
  try {
    const res = await fetch(`${server.baseUrl}/livez`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.service, "a2a-broker");
    assert.equal(typeof body.uptimeSec, "number");
    assert.equal(body.persistence, undefined);
    assert.equal(body.auditDiagnostics, undefined);
    assert.equal(body.terminalOutboxDiagnostics, undefined);
  } finally {
    await server.close();
  }
});

test("server exposes durable broker identity on health and worker registration", async () => {
  await withEnv({ A2A_BROKER_ID: "broker-env-1", BROKER_ID: undefined }, async () => {
    const envServer = await startTestServer();
    try {
      assert.equal(envServer.runtime.config.brokerId, "broker-env-1");

      const healthRes = await fetch(`${envServer.baseUrl}/health`);
      assert.equal(healthRes.status, 200);
      const health = await healthRes.json();
      assert.equal(health.brokerId, "broker-env-1");
    } finally {
      await envServer.close();
    }
  });

  await withEnv({ A2A_BROKER_ID: "broker-env-ignored", BROKER_ID: undefined }, async () => {
    const server = await startTestServer({ brokerId: "broker-option-1" });
    try {
      assert.equal(server.runtime.config.brokerId, "broker-option-1");

      const registerRes = await fetch(`${server.baseUrl}/workers/register`, {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-requester-id": "worker-a",
          "x-a2a-requester-role": "analyst",
        }),
        body: JSON.stringify({
          nodeId: "worker-a",
          role: "analyst",
          capabilities: {
            canAnalyze: true,
            canBackfill: false,
            canPatchWorkspace: false,
            canPromoteLive: false,
            workspaceIds: ["test"],
            environments: ["research"],
          },
        }),
      });
      assert.equal(registerRes.status, 201);
      const registration = await registerRes.json() as WorkerRegistrationResponse;
      assert.equal(registration.status, "online");
      assert.equal(registration.brokerId, "broker-option-1");
    } finally {
      await server.close();
    }
  });
});

test("server uses unknown build revision fallback instead of null", async () => {
  await withEnv({ A2A_BROKER_REVISION: undefined, BROKER_RELEASE_REVISION: undefined, RELEASE_REVISION: undefined }, async () => {
    const server = await startTestServer({ buildInfoFile: "/dev/null" });
    try {
      const healthRes = await fetch(`${server.baseUrl}/health`);
      assert.equal(healthRes.status, 200);
      const health = await healthRes.json();
      assert.equal(typeof health.version, "string");
      assert.notEqual(health.version, "");
      assert.equal(health.build.revision, "unknown");
      assert.notEqual(health.build.revision, null);
    } finally {
      await server.close();
    }
  });
});

test("server redacts unsafe build metadata from health", async () => {
  await withEnv({
    A2A_BROKER_REVISION: "https://credential.example.invalid/unsafe-revision",
    A2A_BROKER_SOURCE: "https://credential.example.invalid/private/repo.git",
    A2A_BROKER_IMAGE_TAG: "private.registry.local/team/image:tag with secret",
    A2A_BROKER_IMAGE_DIGEST: "not-a-valid-digest-with-secret-path",
  }, async () => {
    const server = await startTestServer();
    try {
      const healthRes = await fetch(`${server.baseUrl}/health`);
      assert.equal(healthRes.status, 200);
      const healthText = await healthRes.text();
      assert.doesNotMatch(healthText, /credential\.example\.invalid|unsafe-revision|secret-path|private\.registry/);
      const health = JSON.parse(healthText);
      assert.equal(health.build.revision, "redacted");
      assert.equal(health.build.source, "github.com/jinwon-int/a2a-broker");
      assert.equal(health.build.image, undefined);
    } finally {
      await server.close();
    }
  });
});

test("server rejects invalid requester identity headers with 400", async () => {
  const server = await startTestServer();
  try {
    const invalidRoleRes = await fetch(`${server.baseUrl}/dashboard`, {
      headers: {
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "invalid-role",
      },
    });
    assert.equal(invalidRoleRes.status, 400);
    const invalidRoleBody = await invalidRoleRes.json();
    assert.match(invalidRoleBody.error.message, /x-a2a-requester-role must be one of/);

    const missingIdRes = await fetch(`${server.baseUrl}/dashboard`, {
      headers: {
        "x-a2a-requester-kind": "node",
      },
    });
    assert.equal(missingIdRes.status, 400);
    const missingIdBody = await missingIdRes.json();
    assert.match(missingIdBody.error.message, /x-a2a-requester-id is required/);
  } finally {
    await server.close();
  }
});

test("server rejects unauthorized reassign with 401", async () => {
  const server = await startTestServer();
  try {
    const workerPayload = {
      role: "analyst",
      capabilities: {
        canAnalyze: true,
        canBackfill: false,
        canPatchWorkspace: false,
        canPromoteLive: false,
        workspaceIds: ["test"],
        environments: ["research"],
      },
    };

    await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      },
      body: JSON.stringify({ nodeId: "worker-a", ...workerPayload }),
    });
    await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-a2a-requester-id": "worker-b",
        "x-a2a-requester-role": "analyst",
      },
      body: JSON.stringify({ nodeId: "worker-b", ...workerPayload }),
    });

    const exchangeRes = await fetch(`${server.baseUrl}/exchanges`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      },
      body: JSON.stringify({
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        message: "root",
        intent: "analyze",
      }),
    });
    const exchange = await exchangeRes.json();

    await fetch(`${server.baseUrl}/exchanges/${exchange.id}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      },
      body: JSON.stringify({
        actor: { id: "hub-a", kind: "node", role: "hub" },
        message: "accepted",
        decision: "accepted",
        targetNodeId: "worker-a",
        assignedWorkerId: "worker-a",
      }),
    });

    const exchangeStateRes = await fetch(`${server.baseUrl}/exchanges/${exchange.id}`);
    const exchangeState = await exchangeStateRes.json();
    const reassignRes = await fetch(`${server.baseUrl}/tasks/${exchangeState.activeTaskId}/reassign`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      },
      body: JSON.stringify({
        actor: { id: "worker-a", kind: "node", role: "analyst" },
        targetNodeId: "worker-b",
        assignedWorkerId: "worker-b",
        note: "should fail",
      }),
    });

    assert.equal(reassignRes.status, 401);
    const errorBody = await reassignRes.json();
    assert.equal(errorBody.error.code, "unauthorized");
  } finally {
    await server.close();
  }
});

test("server approves blocked live-impact task with operator audit metadata", async () => {
  const server = await startTestServer();
  try {
    await registerTestWorker(server.baseUrl, "worker-a", "analyst");

    const createRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "analyst-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({
        intent: "promote_to_live",
        requester: { id: "analyst-a", kind: "node", role: "analyst" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        message: "promote after review",
      }),
    });
    assert.equal(createRes.status, 201);
    const task = await createRes.json();
    assert.equal(task.status, "blocked");

    const deniedApprove = await fetch(`${server.baseUrl}/tasks/${task.id}/approve`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "analyst-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({
        actor: { id: "analyst-a", kind: "node", role: "analyst" },
        reason: "not authorized",
      }),
    });
    assert.equal(deniedApprove.status, 401);

    const approveRes = await fetch(`${server.baseUrl}/tasks/${task.id}/approve`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "operator-a",
        "x-a2a-requester-role": "operator",
      }),
      body: JSON.stringify({
        actor: { id: "operator-a", kind: "node", role: "operator" },
        approvalId: "approval-http-1",
        reason: "change ticket reviewed",
      }),
    });
    assert.equal(approveRes.status, 200);
    const approved = await approveRes.json();
    assert.equal(approved.status, "queued");
    assert.equal(approved.approval.approvalId, "approval-http-1");
    assert.equal(approved.approval.approvedBy, "operator-a");
    assert.equal(approved.approval.actorRole, "operator");
    assert.equal(approved.approval.requesterRole, "analyst");
    assert.equal(approved.approval.reason, "change ticket reviewed");

    const auditRes = await fetch(`${server.baseUrl}/audit?action=task.approved&targetId=${task.id}`);
    const audit = await auditRes.json();
    assert.equal(audit.items.length, 1);
    assert.equal(audit.items[0].actorId, "operator-a");
    assert.equal(audit.items[0].note, "change ticket reviewed");
  } finally {
    await server.close();
  }
});

test("server surfaces invalid worker hot row diagnostics on health and dashboard", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-invalid-worker-"));
  const sqliteFile = join(dir, "state.sqlite");
  const runtime = createBrokerServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "https://broker.test/",
    stateFile: join(dir, "state.json"),
    sqliteFile,
    persistenceBackend: "sqlite",
    staleReaperEnabled: false,
  });
  try {
    const db = new DatabaseSync(sqliteFile);
    try {
      db.prepare(
        `INSERT INTO broker_workers (node_id, role, last_seen_at, updated_at, payload)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        "worker-invalid",
        "analyst",
        "2026-04-27T00:00:00.000Z",
        "2026-04-27T00:00:00.000Z",
        JSON.stringify({
          nodeId: "worker-invalid",
          role: "analyst",
          createdAt: "2026-04-27T00:00:00.000Z",
          updatedAt: "2026-04-27T00:00:00.000Z",
          lastSeenAt: "2026-04-27T00:00:00.000Z",
        }),
      );
    } finally {
      db.close();
    }

    runtime.server.listen(0, "127.0.0.1");
    await once(runtime.server, "listening");
    const address = runtime.server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to bind test server");
    }

    const expectedInvalidRows = [{
      table: "broker_workers",
      primaryKey: "worker-invalid",
      schemaError: "Invalid input: expected object, received undefined",
      count: 1,
    }];
    const health = await (await fetch(`http://127.0.0.1:${address.port}/health`)).json();
    assert.deepEqual(health.persistence.hotEntityDiagnostics.invalidRows, expectedInvalidRows);

    const dashboard = await (await fetch(`http://127.0.0.1:${address.port}/dashboard`)).json();
    assert.deepEqual(dashboard.hotEntityDiagnostics.invalidRows, expectedInvalidRows);
  } finally {
    runtime.stopStaleReaper();
    await new Promise<void>((resolve) => runtime.server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server reports SQLite persistence metadata when SQLite backend is enabled", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-sqlite-server-"));
  const runtime = createBrokerServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "https://broker.test/",
    stateFile: join(dir, "state.json"),
    sqliteFile: join(dir, "state.sqlite"),
    persistenceBackend: "sqlite",
    staleReaperEnabled: false,
  });
  try {
    runtime.server.listen(0, "127.0.0.1");
    await once(runtime.server, "listening");
    const address = runtime.server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to bind test server");
    }

    const res = await fetch(`http://127.0.0.1:${address.port}/health`);
    assert.equal(res.status, 200);
    const health = await res.json();
    assert.equal(health.persistence.kind, "sqlite");
    assert.equal(health.persistence.dbFile, join(dir, "state.sqlite"));
    assert.equal(health.persistence.stateVersion, 8);
    assert.equal(health.persistence.schemaVersion, 10);
    assert.equal(health.persistence.journalMode, "wal");
    assert.deepEqual(health.persistence.hotEntityTables, [
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
    ]);
    assert.deepEqual(health.persistence.hotEntityHintTables, health.persistence.hotEntityTables);
    assert.deepEqual(health.persistence.hotEntityHintCoverage, {
      ok: true,
      supportedTables: health.persistence.hotEntityTables,
      missingTables: [],
      supportedCount: 10,
      totalCount: 10,
    });
    assert.deepEqual(health.persistence.hotTableRuntimeLoadLimits, {
      terminalTasks: 2000,
      auditEvents: 5000,
      terminalOutboxEvents: 1000,
    });
    assert.deepEqual(health.persistence.hotTableLoadMetrics.tables["broker_tasks"].runtimeLoad, {
      limit: 2000,
      loadedCount: 0,
      skippedCount: 0,
      activeCount: 0,
      terminalCount: 0,
    });
    assert.deepEqual(health.auditDiagnostics, {
      total: 0,
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
  } finally {
    runtime.stopStaleReaper();
    await new Promise<void>((resolve) => runtime.server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("health p99 stays under 500ms with SQLite cache over 50 requests", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-health-p99-"));
  const runtime = createBrokerServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "https://broker.test/",
    stateFile: join(dir, "state.json"),
    sqliteFile: join(dir, "state.sqlite"),
    persistenceBackend: "sqlite",
    staleReaperEnabled: false,
  });
  try {
    // Pre-seed a small realistic workload so COUNT / mirror status paths are exercised.
    for (let i = 0; i < 20; i++) {
      runtime.broker.registerWorker({
        nodeId: `worker-p99-${i}`,
        role: "analyst",
        capabilities: {
          canAnalyze: true,
          canBackfill: false,
          canPatchWorkspace: false,
          canPromoteLive: false,
          workspaceIds: [],
          environments: [],
        },
      });
      runtime.broker.createTask({
        intent: "analyze",
        requester: { id: `req-${i}`, kind: "node", role: "hub" },
        target: { id: `worker-p99-${i}`, kind: "node", role: "analyst" },
      });
    }

    runtime.server.listen(0, "127.0.0.1");
    await once(runtime.server, "listening");
    const address = runtime.server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to bind test server");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const latencies: number[] = [];
    let cachedResponses = 0;
    let uncachedResponses = 0;

    for (let i = 0; i < 50; i++) {
      const start = performance.now();
      const res = await fetch(`${baseUrl}/health`);
      const elapsed = performance.now() - start;
      assert.equal(res.status, 200);
      const body = await res.json();
      latencies.push(elapsed);
      assert.equal(body.ok, true);
      assert.notEqual(body.service, undefined);
      if (body.timing && body.timing.fromCache) {
        cachedResponses++;
      } else {
        uncachedResponses++;
      }
    }

    latencies.sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length * 0.5)];
    const p95 = latencies[Math.floor(latencies.length * 0.95)];
    const p99 = latencies[Math.floor(latencies.length * 0.99)];

    // The first request is always uncached (cold); verify cache kicks in.
    assert.ok(cachedResponses > 0, `expected some cached responses, got cached=${cachedResponses} uncached=${uncachedResponses}`);

    // Diagnostics cache should keep p99 comfortably under 500ms.
    assert.ok(
      p99 < 500,
      `p99 latency ${p99.toFixed(1)}ms exceeds 500ms threshold (p50=${p50.toFixed(1)}ms, p95=${p95.toFixed(1)}ms)`,
    );
  } finally {
    runtime.stopStaleReaper();
    await new Promise<void>((resolve) => runtime.server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server reads /audit from SQLite hot tables when SQLite store is active", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-sqlite-audit-"));
  const store = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  const snapshot: BrokerSnapshot = {
    ...emptySnapshot(),
    auditEvents: [
      {
        id: "audit-from-sqlite",
        actorId: "operator-a",
        action: "task.started",
        targetType: "task",
        targetId: "task-a",
        proposalId: "proposal-a",
        createdAt: "2026-04-27T00:00:00.000Z",
      },
    ],
  };
  store.save(snapshot);
  const runtime = createBrokerServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "https://broker.test/",
    stateStore: store,
    enforceRequesterIdentity: false,
    staleReaperEnabled: false,
  });
  try {
    runtime.broker.listAuditEvents = (() => {
      throw new Error("/audit should use SQLite hot read path");
    }) as typeof runtime.broker.listAuditEvents;
    runtime.server.listen(0, "127.0.0.1");
    await once(runtime.server, "listening");
    const address = runtime.server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to bind test server");
    }

    const res = await fetch(
      `http://127.0.0.1:${address.port}/audit?action=task.started&targetId=task-a&proposalId=proposal-a&actorId=operator-a`,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.items, snapshot.auditEvents);
  } finally {
    runtime.stopStaleReaper();
    await new Promise<void>((resolve) => runtime.server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server reads /tasks from SQLite hot tables for supported filters", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-sqlite-tasks-"));
  const store = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  const snapshot: BrokerSnapshot = {
    ...emptySnapshot(),
    tasks: [
      {
        id: "task-from-sqlite",
        intent: "chat",
        requester: { id: "requester", kind: "session", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        targetNodeId: "worker-a",
        assignedWorkerId: "worker-a",
        payload: { source: "sqlite-hot-table" },
        status: "queued",
        createdAt: "2026-04-27T00:00:00.000Z",
        updatedAt: "2026-04-27T00:00:00.000Z",
        taskOrigin: "api",
      },
    ],
  };
  store.save(snapshot);
  const runtime = createBrokerServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "https://broker.test/",
    stateStore: store,
    enforceRequesterIdentity: false,
    staleReaperEnabled: false,
  });
  try {
    runtime.broker.listTasks = (() => {
      throw new Error("/tasks should use SQLite hot read path for supported filters");
    }) as typeof runtime.broker.listTasks;
    runtime.server.listen(0, "127.0.0.1");
    await once(runtime.server, "listening");
    const address = runtime.server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to bind test server");
    }

    const res = await fetch(
      `http://127.0.0.1:${address.port}/tasks?detail=full&status=queued&assignedWorkerId=worker-a&targetNodeId=worker-a&intent=chat&taskOrigin=api`,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.items, snapshot.tasks);
  } finally {
    runtime.stopStaleReaper();
    await new Promise<void>((resolve) => runtime.server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GET /tasks returns lightweight task summaries and keeps full detail opt-in", async () => {
  const { baseUrl, close } = await startTestServer({ enforceRequesterIdentity: false });
  try {
    const largeOutput = "x".repeat(20_000);
    await registerTestWorker(baseUrl, "worker-a", "analyst");
    const createRes = await fetch(`${baseUrl}/tasks`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        id: "task-list-diet",
        requester: { id: "requester", kind: "session", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        targetNodeId: "worker-a",
        intent: "chat",
        payload: { rawLog: largeOutput },
      }),
    });
    assert.equal(createRes.status, 201);

    const task = await createRes.json();
    await fetch(`${baseUrl}/tasks/${task.id}/claim`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ workerId: "worker-a" }),
    });
    await fetch(`${baseUrl}/tasks/${task.id}/start`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ workerId: "worker-a" }),
    });
    await fetch(`${baseUrl}/tasks/${task.id}/complete`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        workerId: "worker-a",
        result: {
          summary: "short summary",
          artifactIds: ["artifact-1"],
          output: { rawLog: largeOutput },
        },
      }),
    });

    const listBody = await (await fetch(`${baseUrl}/tasks`)).json();
    assert.equal(listBody.items[0].id, "task-list-diet");
    assert.equal(listBody.items[0].resultSummary, "short summary");
    assert.deepEqual(listBody.items[0].artifactIds, ["artifact-1"]);
    assert.equal("payload" in listBody.items[0], false);
    assert.equal("result" in listBody.items[0], false);
    assert.ok(JSON.stringify(listBody).length < 2_000);

    const rpcListBody = await (await fetch(`${baseUrl}/a2a/jsonrpc`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ListTasks", params: {} }),
    })).json();
    assert.equal(rpcListBody.result.tasks[0].metadata.resultSummary, "short summary");
    assert.equal("result" in rpcListBody.result.tasks[0].metadata, false);
    assert.ok(JSON.stringify(rpcListBody).length < 2_000);

    const detailBody = await (await fetch(`${baseUrl}/tasks/${task.id}`)).json();
    assert.equal(detailBody.payload.rawLog.length, largeOutput.length);
    assert.equal(detailBody.result.output.rawLog.length, largeOutput.length);

    const fullListBody = await (await fetch(`${baseUrl}/tasks?detail=full`)).json();
    assert.equal(fullListBody.items[0].payload.rawLog.length, largeOutput.length);
    assert.equal(fullListBody.items[0].result.output.rawLog.length, largeOutput.length);
  } finally {
    await close();
  }
});

test("GET /tasks applies explicit bounded limits", async () => {
  const { baseUrl, close } = await startTestServer({ enforceRequesterIdentity: false });
  try {
    await registerTestWorker(baseUrl, "worker-a", "analyst");
    for (let i = 0; i < 3; i += 1) {
      const createRes = await fetch(`${baseUrl}/tasks`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          id: `task-list-bound-${i}`,
          requester: { id: "requester", kind: "session", role: "hub" },
          target: { id: "worker-a", kind: "node", role: "analyst" },
          targetNodeId: "worker-a",
          intent: "chat",
          message: `bounded task ${i}`,
        }),
      });
      assert.equal(createRes.status, 201);
    }

    const limitedBody = await (await fetch(`${baseUrl}/tasks?limit=2`)).json();
    assert.equal(limitedBody.count, 2);
    assert.equal(limitedBody.limit, 2);
    assert.equal(limitedBody.items.length, 2);

    const cappedBody = await (await fetch(`${baseUrl}/tasks?limit=9999`)).json();
    assert.equal(cappedBody.count, 3);
    assert.equal(cappedBody.limit, 500);

    const badLimitRes = await fetch(`${baseUrl}/tasks?limit=1.5`);
    assert.equal(badLimitRes.status, 400);
  } finally {
    await close();
  }
});

test("server can hydrate broker runtime from SQLite hot-table load source", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-sqlite-hot-load-"));
  const sqliteFile = join(dir, "state.sqlite");
  const hotTask: BrokerSnapshot["tasks"][number] = {
    id: "task-hot-load-source",
    intent: "chat",
    requester: { id: "requester", kind: "session", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    targetNodeId: "worker-a",
    assignedWorkerId: "worker-a",
    payload: { source: "sqlite-hot-load-source" },
    status: "queued",
    createdAt: "2026-04-27T00:00:00.000Z",
    updatedAt: "2026-04-27T00:00:00.000Z",
    taskOrigin: "api",
  };
  const seedStore = new SqliteBrokerStateStore(sqliteFile);
  seedStore.upsertHotTasks([hotTask]);
  seedStore.close();

  const runtime = createBrokerServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "https://broker.test/",
    persistenceBackend: "sqlite",
    sqliteFile,
    sqliteLoadSource: "hot-tables",
    stateStore: undefined,
    enforceRequesterIdentity: false,
    staleReaperEnabled: false,
  });
  try {
    const loadedTask = runtime.broker.getTask("task-hot-load-source");
    assert.equal(runtime.config.sqliteLoadSource, "hot-tables");
    assert.equal(loadedTask?.id, hotTask.id);
    assert.equal(loadedTask?.status, "queued");
    assert.equal(loadedTask?.payload.source, "sqlite-hot-load-source");
  } finally {
    runtime.stopStaleReaper();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server exposes broker cleanup dry-run plan for SQLite hot tables", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-cleanup-plan-"));
  const store = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  const oldTask: BrokerSnapshot["tasks"][number] = {
    id: "cleanup-api-old-task",
    intent: "chat",
    requester: { id: "requester", kind: "session", role: "hub" },
    target: { id: "worker-cleanup", kind: "node", role: "analyst" },
    targetNodeId: "worker-cleanup",
    assignedWorkerId: "worker-cleanup",
    payload: {},
    status: "failed",
    createdAt: "2026-04-27T00:00:00.000Z",
    updatedAt: "2026-04-27T00:00:00.000Z",
    completedAt: "2026-04-27T00:00:00.000Z",
    taskOrigin: "api",
  };
  store.save({ ...emptySnapshot(), tasks: [oldTask] });
  const server = await startTestServer({ stateStore: store });
  try {
    const res = await fetch(
      `${server.baseUrl}/operator/cleanup/plan?now_ms=${Date.parse("2026-04-27T01:00:00.000Z")}&task_retention_ms=1800000&max_terminal_tasks=0`,
      { headers: { "x-a2a-requester-id": "operator-a", "x-a2a-requester-role": "operator" } },
    );
    assert.equal(res.status, 200);
    const plan = await res.json();
    assert.equal(plan.kind, "broker.cleanup.plan");
    assert.equal(plan.mode, "dry-run");
    assert.deepEqual(plan.tables.find((table: { table: string }) => table.table === "broker_tasks").pruneIds, [oldTask.id]);
    assert.equal(store.readHotTasks().length, 1, "dry-run API must not prune rows");
  } finally {
    await server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server falls back to broker task reads for unsupported SQLite task filters", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-sqlite-tasks-fallback-"));
  const store = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  store.save(emptySnapshot());
  const runtime = createBrokerServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "https://broker.test/",
    stateStore: store,
    enforceRequesterIdentity: false,
    staleReaperEnabled: false,
  });
  try {
    runtime.broker.listTasks = ((filters) => [
      {
        id: `fallback-${filters?.exchangeId ?? "unknown"}`,
        intent: "chat",
        requester: { id: "requester", kind: "session", role: "hub" },
        target: { id: "worker-fallback", kind: "node", role: "analyst" },
        targetNodeId: "worker-fallback",
        payload: {},
        status: "queued",
        createdAt: "2026-04-27T00:00:00.000Z",
        updatedAt: "2026-04-27T00:00:00.000Z",
      },
    ]) as typeof runtime.broker.listTasks;
    runtime.server.listen(0, "127.0.0.1");
    await once(runtime.server, "listening");
    const address = runtime.server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to bind test server");
    }

    const res = await fetch(`http://127.0.0.1:${address.port}/tasks?exchangeId=exchange-fallback`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.items[0].id, "fallback-exchange-fallback");
  } finally {
    runtime.stopStaleReaper();
    await new Promise<void>((resolve) => runtime.server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server reads /tasks/:id from SQLite hot tables when SQLite store is active", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-sqlite-task-detail-"));
  const store = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  const snapshot: BrokerSnapshot = {
    ...emptySnapshot(),
    tasks: [
      {
        id: "task-detail-from-sqlite",
        intent: "chat",
        requester: { id: "requester", kind: "session", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        targetNodeId: "worker-a",
        payload: { source: "sqlite-task-detail" },
        status: "running",
        createdAt: "2026-04-27T00:00:00.000Z",
        updatedAt: "2026-04-27T00:01:00.000Z",
      },
    ],
  };
  store.save(snapshot);
  const runtime = createBrokerServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "https://broker.test/",
    stateStore: store,
    enforceRequesterIdentity: false,
    staleReaperEnabled: false,
  });
  try {
    runtime.broker.getTask = (() => {
      throw new Error("/tasks/:id should use SQLite hot read path");
    }) as typeof runtime.broker.getTask;
    runtime.server.listen(0, "127.0.0.1");
    await once(runtime.server, "listening");
    const address = runtime.server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to bind test server");
    }

    const res = await fetch(`http://127.0.0.1:${address.port}/tasks/task-detail-from-sqlite`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, snapshot.tasks[0]);
  } finally {
    runtime.stopStaleReaper();
    await new Promise<void>((resolve) => runtime.server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server returns 404 for missing /tasks/:id from SQLite hot tables", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-sqlite-task-detail-missing-"));
  const store = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  store.save(emptySnapshot());
  const runtime = createBrokerServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "https://broker.test/",
    stateStore: store,
    enforceRequesterIdentity: false,
    staleReaperEnabled: false,
  });
  try {
    runtime.broker.getTask = (() => {
      throw new Error("missing /tasks/:id should use SQLite hot read path");
    }) as typeof runtime.broker.getTask;
    runtime.server.listen(0, "127.0.0.1");
    await once(runtime.server, "listening");
    const address = runtime.server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to bind test server");
    }

    const res = await fetch(`http://127.0.0.1:${address.port}/tasks/missing-task`);
    assert.equal(res.status, 404);
  } finally {
    runtime.stopStaleReaper();
    await new Promise<void>((resolve) => runtime.server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server reads task diagnostics tombstones from SQLite hot tables when SQLite store is active", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-sqlite-task-diagnostics-"));
  const store = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  const task: BrokerSnapshot["tasks"][number] = {
    id: "task-diagnostics-from-sqlite",
    intent: "chat",
    requester: { id: "requester", kind: "session", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    targetNodeId: "worker-a",
    payload: {},
    status: "failed",
    error: { code: "handler_error", message: "old broker tombstone" },
    createdAt: "2026-04-27T00:00:00.000Z",
    updatedAt: "2026-04-27T00:02:00.000Z",
    completedAt: "2026-04-27T00:02:00.000Z",
  };
  store.save({
    ...emptySnapshot(),
    tasks: [task],
    tombstones: [
      {
        taskId: task.id,
        terminalStatus: "failed",
        tombstoneReason: "failed",
        durationMs: 120_000,
        requeueCount: 0,
        error: { code: "handler_error", message: "old broker tombstone" },
        tombstonedAt: "2026-04-27T00:02:00.000Z",
      },
    ],
  });
  store.upsertHotTombstones([
    {
      taskId: task.id,
      terminalStatus: "failed",
      tombstoneReason: "dead_lettered",
      durationMs: 130_000,
      requeueCount: 5,
      error: { code: "exceeded_requeue_limit", message: "hot tombstone from sqlite" },
      tombstonedAt: "2026-04-27T00:03:00.000Z",
    },
  ]);
  const runtime = createBrokerServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "https://broker.test/",
    stateStore: store,
    enforceRequesterIdentity: false,
    staleReaperEnabled: false,
  });
  try {
    runtime.broker.getTaskDiagnostics = (() => {
      throw new Error("task diagnostics should use SQLite hot read path");
    }) as typeof runtime.broker.getTaskDiagnostics;
    runtime.server.listen(0, "127.0.0.1");
    await once(runtime.server, "listening");
    const address = runtime.server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to bind test server");
    }

    const detailRes = await fetch(`http://127.0.0.1:${address.port}/tasks/${task.id}/diagnostics`);
    assert.equal(detailRes.status, 200);
    const detail = await detailRes.json();
    assert.equal(detail.tombstone.tombstoneReason, "dead_lettered");
    assert.equal(detail.tombstone.error.message, "hot tombstone from sqlite");
    assert.equal(detail.brokerHints.tombstoneReason, "dead_lettered");
    assert.equal(detail.interruption.kind, "dead_lettered");

    const listRes = await fetch(`http://127.0.0.1:${address.port}/tasks/diagnostics`);
    assert.equal(listRes.status, 200);
    const list = await listRes.json();
    assert.equal(list.items[0].taskId, task.id);
    assert.equal(list.items[0].tombstone.tombstoneReason, "dead_lettered");
  } finally {
    runtime.stopStaleReaper();
    await new Promise<void>((resolve) => runtime.server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server reads task diagnostics worker and requeue context from SQLite hot tables when SQLite store is active", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-sqlite-task-diagnostics-context-"));
  const store = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  const now = new Date().toISOString();
  const task: BrokerSnapshot["tasks"][number] = {
    id: "task-diagnostics-context-from-sqlite",
    intent: "chat",
    requester: { id: "requester", kind: "session", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    targetNodeId: "worker-a",
    assignedWorkerId: "worker-a",
    payload: {},
    status: "running",
    requeueCount: 1,
    createdAt: now,
    updatedAt: now,
    claimedAt: now,
    lastHeartbeatAt: now,
  };
  const snapshotWorker: BrokerSnapshot["workers"][number] = {
    nodeId: "worker-a",
    role: "analyst",
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: false,
      canPromoteLive: false,
      workspaceIds: ["test"],
      environments: ["research"],
    },
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
  };
  store.save({
    ...emptySnapshot(),
    tasks: [task],
    workers: [snapshotWorker],
    auditEvents: [
      {
        id: "audit-snapshot-requeue",
        actorId: "broker",
        action: "task.requeued",
        targetType: "task",
        targetId: task.id,
        note: "snapshot requeue context",
        createdAt: "2026-04-27T00:01:00.000Z",
      },
    ],
  });
  store.upsertHotWorkers([
    {
      ...snapshotWorker,
      updatedAt: "2000-01-01T00:00:00.000Z",
      lastSeenAt: "2000-01-01T00:00:00.000Z",
    },
  ]);
  store.upsertHotAuditEvents([
    {
      id: "audit-hot-requeue",
      actorId: "broker",
      action: "task.requeued",
      targetType: "task",
      targetId: task.id,
      note: "hot sqlite requeue context",
      createdAt: "2026-04-27T00:02:00.000Z",
    },
  ]);
  const runtime = createBrokerServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "https://broker.test/",
    stateStore: store,
    enforceRequesterIdentity: false,
    staleReaperEnabled: false,
  });
  try {
    runtime.broker.getTaskDiagnostics = (() => {
      throw new Error("task diagnostics should use SQLite hot read path");
    }) as typeof runtime.broker.getTaskDiagnostics;
    runtime.server.listen(0, "127.0.0.1");
    await once(runtime.server, "listening");
    const address = runtime.server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to bind test server");
    }

    const detailRes = await fetch(`http://127.0.0.1:${address.port}/tasks/${task.id}/diagnostics`);
    assert.equal(detailRes.status, 200);
    const detail = await detailRes.json();
    assert.equal(detail.brokerHints.staleWorker, true);
    assert.equal(detail.brokerHints.workerLastSeenAt, "2000-01-01T00:00:00.000Z");
    assert.equal(detail.brokerHints.lastRequeueReason, "hot sqlite requeue context");
    assert.equal(detail.interruption.kind, "stale_worker");

    const listRes = await fetch(`http://127.0.0.1:${address.port}/tasks/diagnostics`);
    assert.equal(listRes.status, 200);
    const list = await listRes.json();
    assert.equal(list.items[0].brokerHints.staleWorker, true);
    assert.equal(list.items[0].brokerHints.workerLastSeenAt, "2000-01-01T00:00:00.000Z");
    assert.equal(list.items[0].brokerHints.lastRequeueReason, "hot sqlite requeue context");
  } finally {
    runtime.stopStaleReaper();
    await new Promise<void>((resolve) => runtime.server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server reads /workers from SQLite hot tables when SQLite store is active", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-sqlite-workers-"));
  const store = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  const lastSeenAt = new Date().toISOString();
  const snapshot: BrokerSnapshot = {
    ...emptySnapshot(),
    workers: [
      {
        nodeId: "worker-from-sqlite",
        role: "analyst",
        capabilities: {
          canAnalyze: true,
          canBackfill: false,
          canPatchWorkspace: false,
          canPromoteLive: false,
          workspaceIds: ["test"],
          environments: ["research"],
        },
        createdAt: "2026-04-27T00:00:00.000Z",
        updatedAt: "2026-04-27T00:00:00.000Z",
        lastSeenAt,
      },
      {
        nodeId: "worker-filtered-out",
        role: "analyst",
        capabilities: {
          canAnalyze: true,
          canBackfill: false,
          canPatchWorkspace: false,
          canPromoteLive: false,
          workspaceIds: ["other"],
          environments: ["research"],
        },
        createdAt: "2026-04-27T00:00:00.000Z",
        updatedAt: "2026-04-27T00:00:00.000Z",
        lastSeenAt,
      },
    ],
  };
  store.save(snapshot);
  const runtime = createBrokerServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "https://broker.test/",
    stateStore: store,
    enforceRequesterIdentity: false,
    staleReaperEnabled: false,
  });
  try {
    runtime.broker.listWorkerViews = (() => {
      throw new Error("/workers should use SQLite hot read path");
    }) as typeof runtime.broker.listWorkerViews;
    runtime.server.listen(0, "127.0.0.1");
    await once(runtime.server, "listening");
    const address = runtime.server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to bind test server");
    }

    const res = await fetch(`http://127.0.0.1:${address.port}/workers?role=analyst&environment=research&workspaceId=test`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.items, [{ ...snapshot.workers[0], status: "online" }]);
  } finally {
    runtime.stopStaleReaper();
    await new Promise<void>((resolve) => runtime.server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server reads /workers/:id from SQLite hot tables when SQLite store is active", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-sqlite-worker-detail-"));
  const store = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  const lastSeenAt = new Date().toISOString();
  const snapshot: BrokerSnapshot = {
    ...emptySnapshot(),
    workers: [
      {
        nodeId: "worker-detail-from-sqlite",
        role: "analyst",
        capabilities: {
          canAnalyze: true,
          canBackfill: false,
          canPatchWorkspace: false,
          canPromoteLive: false,
          workspaceIds: ["test"],
          environments: ["research"],
        },
        createdAt: "2026-04-27T00:00:00.000Z",
        updatedAt: "2026-04-27T00:00:00.000Z",
        lastSeenAt,
      },
    ],
  };
  store.save(snapshot);
  const runtime = createBrokerServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "https://broker.test/",
    stateStore: store,
    enforceRequesterIdentity: false,
    staleReaperEnabled: false,
  });
  try {
    runtime.broker.getWorkerView = (() => {
      throw new Error("/workers/:id should use SQLite hot read path");
    }) as typeof runtime.broker.getWorkerView;
    runtime.server.listen(0, "127.0.0.1");
    await once(runtime.server, "listening");
    const address = runtime.server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to bind test server");
    }

    const res = await fetch(`http://127.0.0.1:${address.port}/workers/worker-detail-from-sqlite`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { ...snapshot.workers[0], status: "online" });
  } finally {
    runtime.stopStaleReaper();
    await new Promise<void>((resolve) => runtime.server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server returns 404 for missing /workers/:id from SQLite hot tables", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-sqlite-worker-detail-missing-"));
  const store = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  store.save(emptySnapshot());
  const runtime = createBrokerServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "https://broker.test/",
    stateStore: store,
    enforceRequesterIdentity: false,
    staleReaperEnabled: false,
  });
  try {
    runtime.broker.getWorkerView = (() => {
      throw new Error("missing /workers/:id should use SQLite hot read path");
    }) as typeof runtime.broker.getWorkerView;
    runtime.server.listen(0, "127.0.0.1");
    await once(runtime.server, "listening");
    const address = runtime.server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to bind test server");
    }

    const res = await fetch(`http://127.0.0.1:${address.port}/workers/missing-worker`);
    assert.equal(res.status, 404);
  } finally {
    runtime.stopStaleReaper();
    await new Promise<void>((resolve) => runtime.server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server reads /exchanges from SQLite hot tables when SQLite store is active", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-sqlite-exchanges-"));
  const store = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  const snapshot: BrokerSnapshot = {
    ...emptySnapshot(),
    exchanges: [
      {
        id: "exchange-old",
        requester: { id: "requester", kind: "session", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        targetNodeId: "worker-a",
        message: "old exchange",
        maxTurns: 4,
        intent: "chat",
        status: "running",
        rootMessageId: "message-old-root",
        latestMessageId: "message-old-root",
        messageCount: 1,
        lastMessageAt: "2026-04-27T00:00:00.000Z",
        createdAt: "2026-04-27T00:00:00.000Z",
        updatedAt: "2026-04-27T00:00:00.000Z",
      },
      {
        id: "exchange-new",
        requester: { id: "requester", kind: "session", role: "hub" },
        target: { id: "worker-b", kind: "node", role: "analyst" },
        targetNodeId: "worker-b",
        assignedWorkerId: "worker-b",
        message: "new exchange",
        maxTurns: 4,
        intent: "analyze",
        status: "queued",
        rootMessageId: "message-new-root",
        latestMessageId: "message-new-root",
        messageCount: 1,
        lastMessageAt: "2026-04-27T00:01:00.000Z",
        createdAt: "2026-04-27T00:01:00.000Z",
        updatedAt: "2026-04-27T00:01:00.000Z",
      },
    ],
  };
  store.save(snapshot);
  const runtime = createBrokerServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "https://broker.test/",
    stateStore: store,
    enforceRequesterIdentity: false,
    staleReaperEnabled: false,
  });
  try {
    runtime.broker.listExchanges = (() => {
      throw new Error("/exchanges should use SQLite hot read path");
    }) as typeof runtime.broker.listExchanges;
    runtime.server.listen(0, "127.0.0.1");
    await once(runtime.server, "listening");
    const address = runtime.server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to bind test server");
    }

    const res = await fetch(`http://127.0.0.1:${address.port}/exchanges`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.items, [snapshot.exchanges[1], snapshot.exchanges[0]]);
  } finally {
    runtime.stopStaleReaper();
    await new Promise<void>((resolve) => runtime.server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server reads /exchanges/:id from SQLite hot tables when SQLite store is active", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-sqlite-exchange-detail-"));
  const store = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  const snapshot: BrokerSnapshot = {
    ...emptySnapshot(),
    exchanges: [
      {
        id: "exchange-detail-from-sqlite",
        requester: { id: "requester", kind: "session", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        targetNodeId: "worker-a",
        assignedWorkerId: "worker-a",
        message: "detail exchange",
        maxTurns: 4,
        intent: "chat",
        status: "running",
        rootMessageId: "message-root",
        latestMessageId: "message-root",
        messageCount: 1,
        lastMessageAt: "2026-04-27T00:00:00.000Z",
        activeTaskId: "task-a",
        createdAt: "2026-04-27T00:00:00.000Z",
        updatedAt: "2026-04-27T00:00:00.000Z",
      },
    ],
  };
  store.save(snapshot);
  const runtime = createBrokerServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "https://broker.test/",
    stateStore: store,
    enforceRequesterIdentity: false,
    staleReaperEnabled: false,
  });
  try {
    runtime.broker.getExchange = (() => {
      throw new Error("/exchanges/:id should use SQLite hot read path");
    }) as typeof runtime.broker.getExchange;
    runtime.server.listen(0, "127.0.0.1");
    await once(runtime.server, "listening");
    const address = runtime.server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to bind test server");
    }

    const res = await fetch(`http://127.0.0.1:${address.port}/exchanges/exchange-detail-from-sqlite`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, snapshot.exchanges[0]);
  } finally {
    runtime.stopStaleReaper();
    await new Promise<void>((resolve) => runtime.server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server returns 404 for missing /exchanges/:id from SQLite hot tables", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-sqlite-exchange-detail-missing-"));
  const store = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  store.save(emptySnapshot());
  const runtime = createBrokerServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "https://broker.test/",
    stateStore: store,
    enforceRequesterIdentity: false,
    staleReaperEnabled: false,
  });
  try {
    runtime.broker.getExchange = (() => {
      throw new Error("missing /exchanges/:id should use SQLite hot read path");
    }) as typeof runtime.broker.getExchange;
    runtime.server.listen(0, "127.0.0.1");
    await once(runtime.server, "listening");
    const address = runtime.server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to bind test server");
    }

    const res = await fetch(`http://127.0.0.1:${address.port}/exchanges/missing-exchange`);
    assert.equal(res.status, 404);
  } finally {
    runtime.stopStaleReaper();
    await new Promise<void>((resolve) => runtime.server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server reads /exchanges/:id/messages from SQLite hot tables with thread filters", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-sqlite-exchange-messages-"));
  const store = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  const snapshot: BrokerSnapshot = {
    ...emptySnapshot(),
    exchanges: [
      {
        id: "exchange-messages-from-sqlite",
        requester: { id: "requester", kind: "session", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        targetNodeId: "worker-a",
        message: "root",
        maxTurns: 4,
        intent: "chat",
        status: "running",
        rootMessageId: "message-root",
        latestMessageId: "message-grandchild",
        messageCount: 4,
        lastMessageAt: "2026-04-27T00:03:00.000Z",
        createdAt: "2026-04-27T00:00:00.000Z",
        updatedAt: "2026-04-27T00:03:00.000Z",
      },
    ],
    exchangeMessages: [
      {
        id: "message-root",
        exchangeId: "exchange-messages-from-sqlite",
        kind: "root",
        message: "root",
        requester: { id: "requester", kind: "session", role: "hub" },
        targetNodeId: "worker-a",
        createdAt: "2026-04-27T00:00:00.000Z",
        updatedAt: "2026-04-27T00:00:00.000Z",
      },
      {
        id: "message-child",
        exchangeId: "exchange-messages-from-sqlite",
        kind: "thread",
        message: "child",
        actor: { id: "worker-a", kind: "node", role: "analyst" },
        parentMessageId: "message-root",
        createdAt: "2026-04-27T00:01:00.000Z",
        updatedAt: "2026-04-27T00:01:00.000Z",
      },
      {
        id: "message-sibling",
        exchangeId: "exchange-messages-from-sqlite",
        kind: "thread",
        message: "sibling",
        actor: { id: "requester", kind: "session", role: "hub" },
        parentMessageId: "message-root",
        createdAt: "2026-04-27T00:02:00.000Z",
        updatedAt: "2026-04-27T00:02:00.000Z",
      },
      {
        id: "message-grandchild",
        exchangeId: "exchange-messages-from-sqlite",
        kind: "thread",
        message: "grandchild",
        actor: { id: "worker-a", kind: "node", role: "analyst" },
        parentMessageId: "message-child",
        createdAt: "2026-04-27T00:03:00.000Z",
        updatedAt: "2026-04-27T00:03:00.000Z",
      },
    ],
  };
  store.save(snapshot);
  const runtime = createBrokerServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "https://broker.test/",
    stateStore: store,
    enforceRequesterIdentity: false,
    staleReaperEnabled: false,
  });
  try {
    runtime.broker.listExchangeMessages = (() => {
      throw new Error("/exchanges/:id/messages should use SQLite hot read path");
    }) as typeof runtime.broker.listExchangeMessages;
    runtime.server.listen(0, "127.0.0.1");
    await once(runtime.server, "listening");
    const address = runtime.server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to bind test server");
    }

    const baseUrl = `http://127.0.0.1:${address.port}/exchanges/exchange-messages-from-sqlite/messages`;
    const allRes = await fetch(baseUrl);
    assert.equal(allRes.status, 200);
    const allBody = await allRes.json();
    assert.deepEqual(allBody.items.map((message: { id: string }) => message.id), [
      "message-root",
      "message-child",
      "message-sibling",
      "message-grandchild",
    ]);
    assert.deepEqual(allBody.threads[0].replies.map((message: { id: string }) => message.id), [
      "message-child",
      "message-sibling",
    ]);
    assert.deepEqual(allBody.threads[0].replies[0].replies.map((message: { id: string }) => message.id), [
      "message-grandchild",
    ]);

    const childRes = await fetch(`${baseUrl}?parentMessageId=message-root`);
    assert.equal(childRes.status, 200);
    const childBody = await childRes.json();
    assert.deepEqual(childBody.items.map((message: { id: string }) => message.id), [
      "message-child",
      "message-sibling",
    ]);
    assert.equal(childBody.parentMessageId, "message-root");

    const descendantRes = await fetch(`${baseUrl}?parentMessageId=message-child&includeDescendants=true`);
    assert.equal(descendantRes.status, 200);
    const descendantBody = await descendantRes.json();
    assert.deepEqual(descendantBody.items.map((message: { id: string }) => message.id), [
      "message-child",
      "message-grandchild",
    ]);
    assert.deepEqual(descendantBody.threads[0].replies.map((message: { id: string }) => message.id), [
      "message-grandchild",
    ]);
  } finally {
    runtime.stopStaleReaper();
    await new Promise<void>((resolve) => runtime.server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server preserves missing exchange message 404s on SQLite hot read path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-sqlite-exchange-messages-missing-"));
  const store = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  store.save({
    ...emptySnapshot(),
    exchanges: [
      {
        id: "exchange-without-parent",
        requester: { id: "requester", kind: "session", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        targetNodeId: "worker-a",
        message: "root",
        maxTurns: 4,
        intent: "chat",
        status: "running",
        rootMessageId: "message-root",
        latestMessageId: "message-root",
        messageCount: 0,
        lastMessageAt: "2026-04-27T00:00:00.000Z",
        createdAt: "2026-04-27T00:00:00.000Z",
        updatedAt: "2026-04-27T00:00:00.000Z",
      },
    ],
  });
  const runtime = createBrokerServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "https://broker.test/",
    stateStore: store,
    enforceRequesterIdentity: false,
    staleReaperEnabled: false,
  });
  try {
    runtime.broker.listExchangeMessages = (() => {
      throw new Error("missing parent lookup should use SQLite hot read path");
    }) as typeof runtime.broker.listExchangeMessages;
    runtime.server.listen(0, "127.0.0.1");
    await once(runtime.server, "listening");
    const address = runtime.server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to bind test server");
    }

    const res = await fetch(
      `http://127.0.0.1:${address.port}/exchanges/exchange-without-parent/messages?parentMessageId=missing-message`,
    );
    assert.equal(res.status, 404);
  } finally {
    runtime.stopStaleReaper();
    await new Promise<void>((resolve) => runtime.server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server reads /proposals from SQLite hot tables when SQLite store is active", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-sqlite-proposals-"));
  const store = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  const snapshot: BrokerSnapshot = {
    ...emptySnapshot(),
    proposals: [
      {
        id: "proposal-old-filtered-out",
        source: { id: "source-a", kind: "node", role: "analyst" },
        target: { id: "worker-a", kind: "node", role: "operator" },
        sourceNodeId: "source-a",
        targetNodeId: "worker-a",
        kind: "patch",
        summary: "old",
        workspace: { nodeId: "worker-a", workspaceId: "test" },
        artifactIds: [],
        status: "rejected",
        createdAt: "2026-04-27T00:00:00.000Z",
        updatedAt: "2026-04-27T00:00:00.000Z",
      },
      {
        id: "proposal-from-sqlite",
        source: { id: "source-a", kind: "node", role: "analyst" },
        target: { id: "worker-b", kind: "node", role: "operator" },
        sourceNodeId: "source-a",
        targetNodeId: "worker-b",
        kind: "patch",
        summary: "sqlite proposal",
        workspace: { nodeId: "worker-b", workspaceId: "test" },
        artifactIds: [],
        status: "submitted",
        createdAt: "2026-04-27T00:01:00.000Z",
        updatedAt: "2026-04-27T00:01:00.000Z",
      },
    ],
  };
  store.save(snapshot);
  const runtime = createBrokerServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "https://broker.test/",
    stateStore: store,
    enforceRequesterIdentity: false,
    staleReaperEnabled: false,
  });
  try {
    runtime.broker.listProposals = (() => {
      throw new Error("/proposals should use SQLite hot read path");
    }) as typeof runtime.broker.listProposals;
    runtime.server.listen(0, "127.0.0.1");
    await once(runtime.server, "listening");
    const address = runtime.server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to bind test server");
    }

    const res = await fetch(
      `http://127.0.0.1:${address.port}/proposals?status=submitted&sourceNodeId=source-a&targetNodeId=worker-b&kind=patch`,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.items, [
      {
        id: "proposal-from-sqlite",
        sourceNodeId: "source-a",
        targetNodeId: "worker-b",
        kind: "patch",
        summary: "sqlite proposal",
        status: "submitted",
        updatedAt: "2026-04-27T00:01:00.000Z",
      },
    ]);
  } finally {
    runtime.stopStaleReaper();
    await new Promise<void>((resolve) => runtime.server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server reads /proposals/:id details from SQLite hot paths and artifact/validation repository seams", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-sqlite-proposal-detail-"));
  const store = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  const snapshot: BrokerSnapshot = {
    ...emptySnapshot(),
    proposals: [
      {
        id: "proposal-detail-from-sqlite",
        source: { id: "source-a", kind: "node", role: "analyst" },
        target: { id: "worker-a", kind: "node", role: "operator" },
        sourceNodeId: "source-a",
        targetNodeId: "worker-a",
        kind: "params",
        summary: "detail proposal",
        workspace: { nodeId: "worker-a", workspaceId: "test" },
        parameterPayload: { leverage: 1 },
        artifactIds: ["artifact-a"],
        status: "validated",
        createdAt: "2026-04-27T00:00:00.000Z",
        updatedAt: "2026-04-27T00:01:00.000Z",
      },
    ],
    artifacts: [
      {
        id: "artifact-a",
        proposalId: "proposal-detail-from-sqlite",
        kind: "report",
        uri: "memory://artifact-a",
        createdAt: "2026-04-27T00:02:00.000Z",
      },
    ],
    validations: [
      {
        id: "validation-a",
        proposalId: "proposal-detail-from-sqlite",
        nodeId: "validator-a",
        kind: "smoke",
        verdict: "pass",
        metrics: {},
        artifactIds: [],
        createdAt: "2026-04-27T00:03:00.000Z",
      },
    ],
    auditEvents: [
      {
        id: "audit-a",
        actorId: "source-a",
        action: "proposal.created",
        targetType: "proposal",
        targetId: "proposal-detail-from-sqlite",
        proposalId: "proposal-detail-from-sqlite",
        createdAt: "2026-04-27T00:04:00.000Z",
      },
    ],
  };
  store.save(snapshot);
  const runtime = createBrokerServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "https://broker.test/",
    stateStore: store,
    enforceRequesterIdentity: false,
    staleReaperEnabled: false,
  });
  try {
    runtime.broker.getProposalDetails = (() => {
      throw new Error("/proposals/:id should use SQLite hot read path for proposal details");
    }) as typeof runtime.broker.getProposalDetails;
    runtime.server.listen(0, "127.0.0.1");
    await once(runtime.server, "listening");
    const address = runtime.server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to bind test server");
    }

    const res = await fetch(`http://127.0.0.1:${address.port}/proposals/proposal-detail-from-sqlite`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.proposal, snapshot.proposals[0]);
    assert.deepEqual(body.artifacts, snapshot.artifacts);
    assert.deepEqual(body.validations, snapshot.validations);
    assert.deepEqual(body.audit, snapshot.auditEvents);
  } finally {
    runtime.stopStaleReaper();
    await new Promise<void>((resolve) => runtime.server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server returns 404 for missing /proposals/:id from SQLite hot tables", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-sqlite-proposal-detail-missing-"));
  const store = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  store.save(emptySnapshot());
  const runtime = createBrokerServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "https://broker.test/",
    stateStore: store,
    enforceRequesterIdentity: false,
    staleReaperEnabled: false,
  });
  try {
    runtime.broker.getProposalDetails = (() => {
      throw new Error("missing /proposals/:id should use SQLite hot read path");
    }) as typeof runtime.broker.getProposalDetails;
    runtime.server.listen(0, "127.0.0.1");
    await once(runtime.server, "listening");
    const address = runtime.server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to bind test server");
    }

    const res = await fetch(`http://127.0.0.1:${address.port}/proposals/missing-proposal`);
    assert.equal(res.status, 404);
  } finally {
    runtime.stopStaleReaper();
    await new Promise<void>((resolve) => runtime.server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("server returns subtree items and thread structure for exchange messages", async () => {
  const server = await startTestServer();
  try {
    const workerPayload = {
      role: "analyst",
      capabilities: {
        canAnalyze: true,
        canBackfill: false,
        canPatchWorkspace: false,
        canPromoteLive: false,
        workspaceIds: ["test"],
        environments: ["research"],
      },
    };

    await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      },
      body: JSON.stringify({ nodeId: "worker-a", ...workerPayload }),
    });

    const exchangeRes = await fetch(`${server.baseUrl}/exchanges`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      },
      body: JSON.stringify({
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        message: "root",
        intent: "analyze",
      }),
    });
    const exchange = await exchangeRes.json();

    const acceptedRes = await fetch(`${server.baseUrl}/exchanges/${exchange.id}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      },
      body: JSON.stringify({
        actor: { id: "hub-a", kind: "node", role: "hub" },
        message: "accepted",
        decision: "accepted",
        parentMessageId: exchange.rootMessageId,
        targetNodeId: "worker-a",
        assignedWorkerId: "worker-a",
        via: { transport: "http", traceId: "server-test-accept" },
      }),
    });
    const accepted = await acceptedRes.json();

    await fetch(`${server.baseUrl}/exchanges/${exchange.id}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      },
      body: JSON.stringify({
        actor: { id: "worker-a", kind: "node", role: "analyst" },
        message: "need clarification",
        decision: "needs_clarification",
        parentMessageId: accepted.id,
      }),
    });

    const subtreeRes = await fetch(
      `${server.baseUrl}/exchanges/${exchange.id}/messages?parentMessageId=${accepted.id}&includeDescendants=true`,
    );
    assert.equal(subtreeRes.status, 200);
    const subtree = await subtreeRes.json();

    assert.equal(subtree.items.length, 2);
    assert.equal(subtree.threads.length, 1);
    assert.equal(subtree.threads[0].id, accepted.id);
    assert.equal(subtree.threads[0].via.traceId, "server-test-accept");
    assert.equal(subtree.threads[0].replies.length, 1);
    assert.equal(subtree.threads[0].replies[0].decision, "needs_clarification");
  } finally {
    await server.close();
  }
});

test("server exposes a public agent card on the well-known path", async () => {
  const server = await startTestServer({
    serviceName: "seoseo-broker",
    publicBaseUrl: "https://broker.example.com/",
    edgeSecret: "test-edge-secret",
  });

  try {
    const response = await fetch(`${server.baseUrl}/.well-known/agent-card.json`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "public, max-age=300");

    const card = await response.json();
    assert.equal(card.name, "seoseo-broker");
    assert.equal(card.url, "https://broker.example.com/a2a/jsonrpc");
    assert.equal(card.protocolVersion, "1.0");
    assert.equal(card.capabilities.streaming, true);
    assert.equal(card.capabilities.pushNotifications, false);
    assert.ok(Array.isArray(card.skills));
    assert.ok(card.skills.some((skill: { id: string }) => skill.id === "propose_patch"));
  } finally {
    await server.close();
  }
});

test("server exposes JSON-RPC SendMessage and task methods behind the A2A facade", async () => {
  const server = await startTestServer({
    edgeSecret: "test-edge-secret",
  });

  try {
    const workerPayload = {
      role: "analyst",
      capabilities: {
        canAnalyze: true,
        canBackfill: false,
        canPatchWorkspace: false,
        canPromoteLive: false,
        workspaceIds: ["test"],
        environments: ["research"],
      },
    };

    await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({ nodeId: "worker-a", ...workerPayload }),
    });

    const sendRes = await fetch(`${server.baseUrl}/a2a/jsonrpc`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "SendMessage",
        params: {
          message: {
            parts: [{ text: "analyze drift" }],
          },
          metadata: {
            targetNodeId: "worker-a",
            intent: "analyze",
            traceId: "send-1",
          },
        },
      }),
    });
    assert.equal(sendRes.status, 200);
    const sendBody = await sendRes.json();
    assert.equal(sendBody.result.task.status.state, "submitted");
    assert.equal(sendBody.result.task.metadata.internalStatus, "queued");
    assert.equal(sendBody.result.task.metadata.targetNodeId, "worker-a");
    assert.equal(sendBody.result.task.metadata.intent, "analyze");
    assert.ok(typeof sendBody.result.contextId === "string");
    assert.ok(typeof sendBody.result.messageId === "string");

    const exchangeStateRes = await fetch(`${server.baseUrl}/exchanges/${sendBody.result.contextId}`, {
      headers: {
        "x-a2a-edge-secret": "test-edge-secret",
      },
    });
    const exchangeState = await exchangeStateRes.json();
    assert.equal(exchangeState.rootMessageId, sendBody.result.messageId);
    assert.equal(exchangeState.activeTaskId, sendBody.result.task.id);

    const followupRes = await fetch(`${server.baseUrl}/a2a/jsonrpc`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "SendMessage",
        params: {
          message: {
            text: "follow up note",
          },
          metadata: {
            contextId: sendBody.result.contextId,
            parentMessageId: sendBody.result.messageId,
            targetNodeId: "worker-a",
            assignedWorkerId: "worker-a",
            traceId: "send-2",
          },
        },
      }),
    });
    assert.equal(followupRes.status, 200);
    const followupBody = await followupRes.json();
    assert.equal(followupBody.result.contextId, sendBody.result.contextId);
    assert.notEqual(followupBody.result.messageId, sendBody.result.messageId);
    assert.equal(followupBody.result.task.id, sendBody.result.task.id);

    const getTaskRes = await fetch(`${server.baseUrl}/a2a/jsonrpc`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
      }),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "GetTask",
        params: {
          taskId: exchangeState.activeTaskId,
        },
      }),
    });
    assert.equal(getTaskRes.status, 200);
    const getTaskBody = await getTaskRes.json();
    assert.equal(getTaskBody.result.task.id, exchangeState.activeTaskId);
    assert.equal(getTaskBody.result.task.status.state, "submitted");
    assert.equal(getTaskBody.result.task.metadata.internalStatus, "queued");

    const cancelRes = await fetch(`${server.baseUrl}/a2a/jsonrpc`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "CancelTask",
        params: {
          taskId: exchangeState.activeTaskId,
          reason: "operator stop",
          actor: { id: "hub-a", role: "hub", kind: "node" },
        },
      }),
    });
    assert.equal(cancelRes.status, 200);
    const cancelBody = await cancelRes.json();
    assert.equal(cancelBody.result.task.status.state, "canceled");
    assert.equal(cancelBody.result.task.metadata.internalStatus, "canceled");
  } finally {
    await server.close();
  }
});

test("server requires x-a2a-edge-secret on non-health routes when configured", async () => {
  const server = await startTestServer({
    edgeSecret: "test-edge-secret",
    rateLimitMaxRequests: 1,
    workerRateLimitMaxRequests: 1,
  });

  try {
    const healthRes = await fetch(`${server.baseUrl}/health`);
    assert.equal(healthRes.status, 200);

    const livezRes = await fetch(`${server.baseUrl}/livez`);
    assert.equal(livezRes.status, 200);

    const agentCardRes = await fetch(`${server.baseUrl}/.well-known/agent-card.json`);
    assert.equal(agentCardRes.status, 200);

    const missingSecretRes = await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({
        nodeId: "worker-a",
        role: "analyst",
        capabilities: {
          canAnalyze: true,
          canBackfill: false,
          canPatchWorkspace: false,
          canPromoteLive: false,
          workspaceIds: ["test"],
          environments: ["research"],
        },
      }),
    });
    assert.equal(missingSecretRes.status, 401);

    const wrongSecretRes = await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "wrong-secret",
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({
        nodeId: "worker-a",
        role: "analyst",
        capabilities: {
          canAnalyze: true,
          canBackfill: false,
          canPatchWorkspace: false,
          canPromoteLive: false,
          workspaceIds: ["test"],
          environments: ["research"],
        },
      }),
    });
    assert.equal(wrongSecretRes.status, 401);

    const allowedRes = await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({
        nodeId: "worker-a",
        role: "analyst",
        capabilities: {
          canAnalyze: true,
          canBackfill: false,
          canPatchWorkspace: false,
          canPromoteLive: false,
          workspaceIds: ["test"],
          environments: ["research"],
        },
      }),
    });
    assert.equal(allowedRes.status, 201);

    const health = await healthRes.json();
    assert.equal(health.requestSecurity.edgeSecretRequired, true);
  } finally {
    await server.close();
  }
});

test("server splits worker lifecycle rate limits from general request limits", async () => {
  const server = await startTestServer({
    edgeSecret: "test-edge-secret",
    rateLimitMaxRequests: 1,
    rateLimitWindowSec: 60,
    workerRateLimitMaxRequests: 3,
    workerRateLimitWindowSec: 60,
  });

  try {
    const registerRes = await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({
        nodeId: "worker-a",
        role: "analyst",
        capabilities: {
          canAnalyze: true,
          canBackfill: false,
          canPatchWorkspace: false,
          canPromoteLive: false,
          workspaceIds: ["test"],
          environments: ["research"],
        },
      }),
    });
    assert.equal(registerRes.status, 201);
    assert.equal(registerRes.headers.get("x-a2a-ratelimit-bucket"), "worker");

    const auditOne = await fetch(`${server.baseUrl}/audit`, {
      headers: {
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      },
    });
    assert.equal(auditOne.status, 200);
    assert.equal(auditOne.headers.get("x-a2a-ratelimit-bucket"), "general");

    const heartbeatRes = await fetch(`${server.baseUrl}/workers/worker-a/heartbeat`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({}),
    });
    assert.equal(heartbeatRes.status, 200);
    assert.equal(heartbeatRes.headers.get("x-a2a-ratelimit-bucket"), "worker");

    const auditTwo = await fetch(`${server.baseUrl}/audit`, {
      headers: {
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      },
    });
    assert.equal(auditTwo.status, 429);

  } finally {
    await server.close();
  }
});

test("server rejects requeue_stale unless requester is a hub or operator", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });

  try {
    const unauthorizedRes = await fetch(`${server.baseUrl}/tasks/requeue_stale`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      }),
    });
    assert.equal(unauthorizedRes.status, 401);
    const unauthorizedBody = await unauthorizedRes.json();
    assert.equal(unauthorizedBody.error.code, "unauthorized");

    const allowedRes = await fetch(`${server.baseUrl}/tasks/requeue_stale`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      }),
    });
    assert.equal(allowedRes.status, 200);
    const allowedBody = await allowedRes.json();
    assert.equal(allowedBody.ok, true);
    assert.equal(allowedBody.policy, "requeue_only");
  } finally {
    await server.close();
  }
});

test("server rejects artifact attachment from an unrelated requester", async () => {
  const server = await startTestServer();
  try {
    const proposalRes = await fetch(`${server.baseUrl}/proposals`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "research-a",
        "x-a2a-requester-role": "researcher",
      }),
      body: JSON.stringify({
        source: { id: "research-a", kind: "node", role: "researcher" },
        target: { id: "live-a", kind: "node", role: "live-trader" },
        kind: "patch",
        summary: "tighten threshold",
        workspace: { nodeId: "live-a", workspaceId: "ws-live" },
        patchText: "diff --git a/config.ts b/config.ts",
      }),
    });
    assert.equal(proposalRes.status, 201);
    const proposal = await proposalRes.json();

    const artifactRes = await fetch(`${server.baseUrl}/proposals/${proposal.id}/artifacts`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "outsider-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({
        kind: "patch",
        uri: "file:///tmp/proposal.diff",
        summary: "outsider should not attach this",
      }),
    });

    assert.equal(artifactRes.status, 401);
    const errorBody = await artifactRes.json();
    assert.equal(errorBody.error.code, "unauthorized");
  } finally {
    await server.close();
  }
});

test("server rejects validation from a node outside the proposal parties", async () => {
  const server = await startTestServer();
  try {
    const proposalRes = await fetch(`${server.baseUrl}/proposals`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "research-a",
        "x-a2a-requester-role": "researcher",
      }),
      body: JSON.stringify({
        source: { id: "research-a", kind: "node", role: "researcher" },
        target: { id: "live-a", kind: "node", role: "live-trader" },
        kind: "patch",
        summary: "tighten threshold",
        workspace: { nodeId: "live-a", workspaceId: "ws-live" },
        patchText: "diff --git a/config.ts b/config.ts",
      }),
    });
    assert.equal(proposalRes.status, 201);
    const proposal = await proposalRes.json();

    const validationRes = await fetch(`${server.baseUrl}/proposals/${proposal.id}/validate`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "outsider-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({
        nodeId: "outsider-a",
        kind: "smoke",
        verdict: "pass",
        note: "should be rejected",
      }),
    });

    assert.equal(validationRes.status, 403);
    const errorBody = await validationRes.json();
    assert.equal(errorBody.error.code, "policy_denied");
  } finally {
    await server.close();
  }
});

test("server rejects apply attempts from the proposal source after approval", async () => {
  const server = await startTestServer();
  try {
    const proposalRes = await fetch(`${server.baseUrl}/proposals`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "research-a",
        "x-a2a-requester-role": "researcher",
      }),
      body: JSON.stringify({
        source: { id: "research-a", kind: "node", role: "researcher" },
        target: { id: "live-a", kind: "node", role: "live-trader" },
        kind: "patch",
        summary: "tighten threshold",
        workspace: { nodeId: "live-a", workspaceId: "ws-live" },
        patchText: "diff --git a/config.ts b/config.ts",
      }),
    });
    assert.equal(proposalRes.status, 201);
    const proposal = await proposalRes.json();

    const approveRes = await fetch(`${server.baseUrl}/proposals/${proposal.id}/approve`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "live-a",
        "x-a2a-requester-role": "live-trader",
      }),
      body: JSON.stringify({
        actor: { id: "live-a", kind: "node", role: "live-trader" },
        note: "approved by target",
      }),
    });
    assert.equal(approveRes.status, 200);

    const applyRes = await fetch(`${server.baseUrl}/proposals/${proposal.id}/apply`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "research-a",
        "x-a2a-requester-role": "researcher",
      }),
      body: JSON.stringify({
        actor: { id: "research-a", kind: "node", role: "researcher" },
        workspace: { nodeId: "live-a", workspaceId: "ws-live" },
        note: "source should not apply target workspace",
      }),
    });

    assert.equal(applyRes.status, 403);
    const errorBody = await applyRes.json();
    assert.equal(errorBody.error.code, "policy_denied");
  } finally {
    await server.close();
  }
});

test("server classifies claim, start, complete, and fail into the worker lifecycle bucket", async () => {
  const server = await startTestServer({
    edgeSecret: "test-edge-secret",
    rateLimitMaxRequests: 10,
    workerRateLimitMaxRequests: 10,
  });

  try {
    const workerPayload = {
      nodeId: "worker-a",
      role: "analyst",
      capabilities: {
        canAnalyze: true,
        canBackfill: false,
        canPatchWorkspace: false,
        canPromoteLive: false,
        workspaceIds: ["test"],
        environments: ["research"],
      },
    };

    const registerRes = await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify(workerPayload),
    });
    assert.equal(registerRes.status, 201);

    const taskCreateRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({
        intent: "analyze",
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        assignedWorkerId: "worker-a",
        message: "run task",
      }),
    });
    assert.equal(taskCreateRes.status, 201);
    const task = await taskCreateRes.json();

    const claimRes = await fetch(`${server.baseUrl}/tasks/${task.id}/claim`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({ workerId: "worker-a" }),
    });
    assert.equal(claimRes.status, 200);
    assert.equal(claimRes.headers.get("x-a2a-ratelimit-bucket"), "worker");

    const startRes = await fetch(`${server.baseUrl}/tasks/${task.id}/start`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({ workerId: "worker-a" }),
    });
    assert.equal(startRes.status, 200);
    assert.equal(startRes.headers.get("x-a2a-ratelimit-bucket"), "worker");

    const completeRes = await fetch(`${server.baseUrl}/tasks/${task.id}/complete`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({
        workerId: "worker-a",
        result: { summary: "done" },
      }),
    });
    assert.equal(completeRes.status, 200);
    assert.equal(completeRes.headers.get("x-a2a-ratelimit-bucket"), "worker");

    const failedTaskCreateRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({
        intent: "analyze",
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        assignedWorkerId: "worker-a",
        message: "run task 2",
      }),
    });
    assert.equal(failedTaskCreateRes.status, 201);
    const failedTask = await failedTaskCreateRes.json();

    const claimFailedTaskRes = await fetch(`${server.baseUrl}/tasks/${failedTask.id}/claim`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({ workerId: "worker-a" }),
    });
    assert.equal(claimFailedTaskRes.status, 200);
    assert.equal(claimFailedTaskRes.headers.get("x-a2a-ratelimit-bucket"), "worker");

    const startFailedTaskRes = await fetch(`${server.baseUrl}/tasks/${failedTask.id}/start`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({ workerId: "worker-a" }),
    });
    assert.equal(startFailedTaskRes.status, 200);
    assert.equal(startFailedTaskRes.headers.get("x-a2a-ratelimit-bucket"), "worker");

    const failRes = await fetch(`${server.baseUrl}/tasks/${failedTask.id}/fail`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({
        workerId: "worker-a",
        error: { code: "handler_error", message: "task failed" },
      }),
    });
    assert.equal(failRes.status, 200);
    assert.equal(failRes.headers.get("x-a2a-ratelimit-bucket"), "worker");
  } finally {
    await server.close();
  }
});

test("GET /dashboard returns aggregated summary without authentication", async () => {
  const server = await startTestServer({
    edgeSecret: "test-secret",
    enforceRequesterIdentity: true,
  });
  try {
    // Dashboard should require edge secret (it's not /health)
    const noSecretRes = await fetch(`${server.baseUrl}/dashboard`);
    assert.equal(noSecretRes.status, 401);

    const res = await fetch(`${server.baseUrl}/dashboard`, {
      headers: { "x-a2a-edge-secret": "test-secret" },
    });
    assert.equal(res.status, 200);
    const dashboard = await res.json();

    assert.ok(dashboard.generatedAt);
    assert.ok(typeof dashboard.queue === "object");
    assert.ok(typeof dashboard.queue.total === "number");
    assert.ok(typeof dashboard.queue.byStatus === "object");
    assert.ok(typeof dashboard.queue.oldestPending === "object");
    assert.ok(typeof dashboard.history === "object");
    assert.ok(typeof dashboard.history.totalCompleted === "number");
    assert.ok(typeof dashboard.history.totalFailed === "number");
    assert.ok(typeof dashboard.history.recent === "object");
    assert.ok(typeof dashboard.proposals === "object");
    assert.ok(typeof dashboard.proposals.total === "number");
    assert.ok(typeof dashboard.proposals.pendingAction === "object");
    assert.ok(typeof dashboard.workers === "object");
    assert.ok(typeof dashboard.workers.total === "number");
    assert.ok(typeof dashboard.workers.online === "number");
    assert.ok(typeof dashboard.workers.stale === "number");
    assert.ok(typeof dashboard.workers.byNode === "object");
    assert.ok(typeof dashboard.observability === "object");
    assert.ok(typeof dashboard.observability.queuePressure === "object");
    assert.ok(typeof dashboard.observability.recovery === "object");
    assert.ok(typeof dashboard.observability.workerHealth === "object");
    assert.ok(typeof dashboard.staleReaper === "object");
    assert.ok(typeof dashboard.staleReaper.enabled === "boolean");
    assert.ok(typeof dashboard.staleReaper.runCount === "number");
    assert.ok(typeof dashboard.attention === "object");
    assert.ok(typeof dashboard.attention.highestSeverity === "string");
    assert.ok(Array.isArray(dashboard.attention.items));
    assert.ok(typeof dashboard.requestPressure === "object");
    assert.ok(typeof dashboard.requestPressure.general === "object");
    assert.ok(typeof dashboard.requestPressure.worker === "object");

    // Empty state defaults
    assert.equal(dashboard.queue.total, 0);
    assert.equal(dashboard.history.totalCompleted, 0);
    assert.equal(dashboard.workers.total, 0);
    assert.equal(dashboard.observability.queuePressure.queued, 0);
    assert.equal(dashboard.observability.recovery.totalDeadLettered, 0);
    assert.equal(dashboard.staleReaper.runCount, 0);
    assert.equal(dashboard.attention.highestSeverity, "none");
    assert.equal(dashboard.attention.items.length, 0);
  } finally {
    await server.close();
  }
});

test("GET /dashboard reflects task lifecycle after create/claim/complete", async () => {
  const server = await startTestServer({ edgeSecret: "s" });
  try {
    const h = (extra: Record<string, string> = {}) => ({
      "content-type": "application/json",
      "x-a2a-edge-secret": "s",
      ...extra,
    });

    // Register worker
    await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: h({ "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({
        nodeId: "w1",
        role: "analyst",
        capabilities: {
          canAnalyze: true,
          canBackfill: false,
          canPatchWorkspace: false,
          canPromoteLive: false,
          workspaceIds: ["ws"],
          environments: ["research"],
        },
      }),
    });

    // Check empty dashboard
    const emptyDash = await (await fetch(`${server.baseUrl}/dashboard`, {
      headers: { "x-a2a-edge-secret": "s" },
    })).json();
    assert.equal(emptyDash.queue.total, 0);
    assert.equal(emptyDash.workers.total, 1);

    // Create a task
    const taskRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: h({ "x-a2a-requester-id": "hub-1", "x-a2a-requester-role": "hub" }),
      body: JSON.stringify({
        intent: "analyze",
        requester: { id: "hub-1", kind: "node", role: "hub" },
        target: { id: "w1", kind: "node", role: "analyst" },
        assignedWorkerId: "w1",
        message: "test-task",
      }),
    });
    const task = await taskRes.json();

    // Dashboard should show 1 pending task
    const queuedDash = await (await fetch(`${server.baseUrl}/dashboard`, {
      headers: { "x-a2a-edge-secret": "s" },
    })).json();
    assert.equal(queuedDash.queue.total, 1);
    assert.equal(queuedDash.queue.byStatus["queued"], 1);
    assert.ok(typeof queuedDash.queue.oldestPending[0].statusSinceAt === "string");
    assert.ok(typeof queuedDash.queue.oldestPending[0].statusAgeSec === "number");

    // Claim and complete
    await fetch(`${server.baseUrl}/tasks/${task.id}/claim`, {
      method: "POST",
      headers: h({ "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({ workerId: "w1" }),
    });
    await fetch(`${server.baseUrl}/tasks/${task.id}/start`, {
      method: "POST",
      headers: h({ "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({ workerId: "w1" }),
    });

    const runningDash = await (await fetch(`${server.baseUrl}/dashboard`, {
      headers: { "x-a2a-edge-secret": "s" },
    })).json();
    assert.ok(typeof runningDash.observability.queuePressure.oldestRunning.statusSinceAt === "string");
    assert.ok(typeof runningDash.observability.queuePressure.oldestRunning.statusAgeSec === "number");
    assert.ok(typeof runningDash.workers.byNode[0].lastSeenAgeSec === "number");

    await fetch(`${server.baseUrl}/tasks/${task.id}/complete`, {
      method: "POST",
      headers: h({ "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({ workerId: "w1", result: { summary: "done" } }),
    });

    // Dashboard should show completed
    const doneDash = await (await fetch(`${server.baseUrl}/dashboard`, {
      headers: { "x-a2a-edge-secret": "s" },
    })).json();
    assert.equal(doneDash.queue.total, 0);
    assert.equal(doneDash.history.totalCompleted, 1);
    assert.equal(doneDash.history.completedLastHour, 1);
    assert.equal(doneDash.history.recent.length, 1);
    assert.equal(doneDash.history.recent[0].status, "succeeded");
    assert.equal(doneDash.observability.queuePressure.queued, 0);
    assert.equal(doneDash.observability.queuePressure.claimed, 0);
    assert.equal(doneDash.observability.queuePressure.running, 0);
  } finally {
    await server.close();
  }
});

test("GET /operator/task-report summarizes watched task progress and results", async () => {
  const server = await startTestServer({ edgeSecret: "s" });
  try {
    const h = (extra: Record<string, string> = {}) => ({
      "content-type": "application/json",
      "x-a2a-edge-secret": "s",
      ...extra,
    });

    await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: h({ "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({
        nodeId: "w1",
        role: "analyst",
        capabilities: {
          canAnalyze: true,
          canBackfill: false,
          canPatchWorkspace: true,
          canPromoteLive: false,
          workspaceIds: ["ws"],
          environments: ["research"],
        },
      }),
    });

    const create = async (pullRequest: string, payloadExtra: Record<string, unknown> = {}) => {
      const res = await fetch(`${server.baseUrl}/tasks`, {
        method: "POST",
        headers: h({ "x-a2a-requester-id": "hub-1", "x-a2a-requester-role": "hub" }),
        body: JSON.stringify({
          intent: "propose_patch",
          requester: { id: "hub-1", kind: "node", role: "hub" },
          target: { id: "w1", kind: "node", role: "analyst" },
          assignedWorkerId: "w1",
          message: `fix ${pullRequest}`,
          taskOrigin: "github",
          payload: { pullRequest, lane: "operator-report", ...payloadExtra },
        }),
      });
      const text = await res.text();
      assert.equal(res.status, 201, text);
      return JSON.parse(text);
    };

    const runningTask = await create("#10", { parentIssue: "jinwon-int/a2a-broker#364" });
    const doneTask = await create("#11", { parentIssueUrl: "https://github.com/jinwon-int/a2a-broker/issues/364" });
    await create("#12", { parentIssue: "jinwon-int/a2a-broker#360" });

    await fetch(`${server.baseUrl}/tasks/${runningTask.id}/claim`, {
      method: "POST",
      headers: h({ "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({ workerId: "w1" }),
    });
    await fetch(`${server.baseUrl}/tasks/${runningTask.id}/start`, {
      method: "POST",
      headers: h({ "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({ workerId: "w1" }),
    });
    await fetch(`${server.baseUrl}/tasks/${doneTask.id}/claim`, {
      method: "POST",
      headers: h({ "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({ workerId: "w1" }),
    });
    await fetch(`${server.baseUrl}/tasks/${doneTask.id}/complete`, {
      method: "POST",
      headers: h({ "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({
        workerId: "w1",
        result: { output: { github: { prUrl: "https://github.com/o/r/pull/11" } } },
      }),
    });

    const reportRes = await fetch(
      `${server.baseUrl}/operator/task-report?task_id=${runningTask.id}&task_id=${doneTask.id}&stale_after_ms=1`,
      { headers: { "x-a2a-edge-secret": "s", "x-a2a-requester-id": "hub-1", "x-a2a-requester-role": "hub" } },
    );
    const reportText = await reportRes.text();
    assert.equal(reportRes.status, 200, reportText);
    const report = JSON.parse(reportText);

    assert.equal(report.total, 2);
    assert.equal(report.terminal, 1);
    assert.equal(report.active, 1);
    assert.equal(report.allTerminal, false);
    const running = report.items.find((item: { taskId: string }) => item.taskId === runningTask.id);
    const done = report.items.find((item: { taskId: string }) => item.taskId === doneTask.id);
    assert.equal(running.kind, "stale");
    assert.match(running.reportLine, /중간보고 필요/);
    assert.equal(done.kind, "result");
    assert.equal(done.github.prUrl, "https://github.com/o/r/pull/11");
    assert.match(done.reportLine, /완료/);

    const parentReportRes = await fetch(
      `${server.baseUrl}/operator/task-report?parent_issue=jinwon-int/a2a-broker%23364`,
      { headers: { "x-a2a-edge-secret": "s", "x-a2a-requester-id": "hub-1", "x-a2a-requester-role": "hub" } },
    );
    const parentReportText = await parentReportRes.text();
    assert.equal(parentReportRes.status, 200, parentReportText);
    const parentReport = JSON.parse(parentReportText);
    assert.deepEqual(parentReport.items.map((item: { taskId: string }) => item.taskId).sort(), [doneTask.id, runningTask.id].sort());
  } finally {
    await server.close();
  }
});

test("GET /dashboard respects query parameters for limits", async () => {
  const server = await startTestServer({ edgeSecret: "s" });
  try {
    const h = (extra: Record<string, string> = {}) => ({
      "content-type": "application/json",
      "x-a2a-edge-secret": "s",
      ...extra,
    });

    await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: h({ "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({
        nodeId: "w1",
        role: "analyst",
        capabilities: {
          canAnalyze: true,
          canBackfill: false,
          canPatchWorkspace: false,
          canPromoteLive: false,
          workspaceIds: ["ws"],
          environments: ["research"],
        },
      }),
    });

    // Create multiple tasks
    for (let i = 0; i < 5; i++) {
      await fetch(`${server.baseUrl}/tasks`, {
        method: "POST",
        headers: h({ "x-a2a-requester-id": "hub-1", "x-a2a-requester-role": "hub" }),
        body: JSON.stringify({
          intent: "analyze",
          requester: { id: "hub-1", kind: "node", role: "hub" },
          target: { id: "w1", kind: "node", role: "analyst" },
          assignedWorkerId: "w1",
          message: `task-${i}`,
        }),
      });
    }

    // Default limit (5)
    const defaultDash = await (await fetch(`${server.baseUrl}/dashboard`, {
      headers: { "x-a2a-edge-secret": "s" },
    })).json();
    assert.equal(defaultDash.queue.oldestPending.length, 5);

    // Custom limit (2)
    const limitedDash = await (await fetch(`${server.baseUrl}/dashboard?oldest_pending_limit=2`, {
      headers: { "x-a2a-edge-secret": "s" },
    })).json();
    assert.equal(limitedDash.queue.oldestPending.length, 2);
  } finally {
    await server.close();
  }
});

test("stale reaper sweep requeues a claimed task with a dead worker without operator action", async () => {
  const server = await startTestServer({
    edgeSecret: "s",
    // Disable the periodic timer so the test drives sweeps deterministically.
    staleReaperEnabled: false,
    staleReaperOlderThanSec: 0,
    workerOfflineAfterSec: 1,
  });
  try {
    const h = (extra: Record<string, string> = {}) => ({
      "content-type": "application/json",
      "x-a2a-edge-secret": "s",
      ...extra,
    });

    await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: h({ "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({
        nodeId: "w1",
        role: "analyst",
        capabilities: {
          canAnalyze: true,
          canBackfill: false,
          canPatchWorkspace: false,
          canPromoteLive: false,
          workspaceIds: ["ws"],
          environments: ["research"],
        },
      }),
    });

    const taskRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: h({ "x-a2a-requester-id": "hub-1", "x-a2a-requester-role": "hub" }),
      body: JSON.stringify({
        intent: "analyze",
        requester: { id: "hub-1", kind: "node", role: "hub" },
        target: { id: "w1", kind: "node", role: "analyst" },
        assignedWorkerId: "w1",
        message: "analyze payload",
      }),
    });
    const task = await taskRes.json();

    await fetch(`${server.baseUrl}/tasks/${task.id}/claim`, {
      method: "POST",
      headers: h({ "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({ workerId: "w1" }),
    });

    const requeuedCount = server.runtime.runStaleReaperSweep();
    assert.equal(requeuedCount, 1);

    const taskAfter = await (await fetch(`${server.baseUrl}/tasks/${task.id}`, {
      headers: h({ "x-a2a-requester-id": "hub-1", "x-a2a-requester-role": "hub" }),
    })).json();
    assert.equal(taskAfter.status, "queued");
    assert.equal(taskAfter.assignedWorkerId, "w1");

    const status = server.runtime.getStaleReaperStatus();
    assert.equal(status.runCount, 1);
    assert.equal(status.lastRequeued, 1);
    assert.equal(status.lastError, undefined);
    assert.ok(status.lastRunAt);
  } finally {
    await server.close();
  }
});

test("stale reaper surfaces config and last-run status via /health", async () => {
  const server = await startTestServer({
    staleReaperEnabled: true,
    staleReaperIntervalSec: 120,
    staleReaperOlderThanSec: 240,
  });
  try {
    const health = await (await fetch(`${server.baseUrl}/health`)).json();
    assert.ok(health.staleReaper);
    assert.equal(health.staleReaper.enabled, true);
    assert.equal(health.staleReaper.intervalSec, 120);
    assert.equal(health.staleReaper.olderThanSec, 240);
    assert.equal(health.staleReaper.runCount, 0);
    assert.ok(health.requestPressure);
    assert.ok(health.requestPressure.general);
    assert.ok(health.requestPressure.worker);

    assert.equal(server.runtime.config.staleReaperEnabled, true);
    assert.equal(server.runtime.config.staleReaperIntervalSec, 120);
    assert.equal(server.runtime.config.staleReaperOlderThanSec, 240);
  } finally {
    await server.close();
  }
});

test("stopStaleReaper is idempotent and safe after server close", async () => {
  const server = await startTestServer({ staleReaperEnabled: true, staleReaperIntervalSec: 3600 });
  const { runtime } = server;
  await server.close();
  // server.close fires the "close" event which already stopped the reaper; extra calls
  // must not throw.
  runtime.stopStaleReaper();
  runtime.stopStaleReaper();
});

test("stale reaper dead-letters tasks exceeding maxRequeueAttempts and exposes the cap on /health", async () => {
  const server = await startTestServer({
    edgeSecret: "s",
    staleReaperEnabled: false,
    staleReaperOlderThanSec: 0,
    workerOfflineAfterSec: 1,
    maxRequeueAttempts: 1,
  });
  try {
    const h = (extra: Record<string, string> = {}) => ({
      "content-type": "application/json",
      "x-a2a-edge-secret": "s",
      ...extra,
    });

    const health = await (await fetch(`${server.baseUrl}/health`)).json();
    assert.equal(health.staleReaper.maxRequeueAttempts, 1);
    assert.equal(health.staleReaper.totalDeadLettered, 0);

    await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: h({ "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({
        nodeId: "w1",
        role: "analyst",
        capabilities: {
          canAnalyze: true,
          canBackfill: false,
          canPatchWorkspace: false,
          canPromoteLive: false,
          workspaceIds: ["ws"],
          environments: ["research"],
        },
      }),
    });

    const taskRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: h({ "x-a2a-requester-id": "hub-1", "x-a2a-requester-role": "hub" }),
      body: JSON.stringify({
        intent: "analyze",
        requester: { id: "hub-1", kind: "node", role: "hub" },
        target: { id: "w1", kind: "node", role: "analyst" },
        assignedWorkerId: "w1",
        message: "analyze payload",
      }),
    });
    const task = await taskRes.json();

    // First cycle: claim then reap — should requeue (attempt 1).
    await fetch(`${server.baseUrl}/tasks/${task.id}/claim`, {
      method: "POST",
      headers: h({ "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({ workerId: "w1" }),
    });
    assert.equal(server.runtime.runStaleReaperSweep(), 1);

    // Second cycle: claim then reap — should dead-letter because the cap was reached.
    await fetch(`${server.baseUrl}/tasks/${task.id}/claim`, {
      method: "POST",
      headers: h({ "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({ workerId: "w1" }),
    });
    assert.equal(server.runtime.runStaleReaperSweep(), 0);

    const finalTask = await (await fetch(`${server.baseUrl}/tasks/${task.id}`, {
      headers: h({ "x-a2a-requester-id": "hub-1", "x-a2a-requester-role": "hub" }),
    })).json();
    assert.equal(finalTask.status, "failed");
    assert.equal(finalTask.error.code, "exceeded_requeue_limit");
    assert.equal(finalTask.requeueCount, 1);

    const status = server.runtime.getStaleReaperStatus();
    assert.equal(status.runCount, 2);
    assert.equal(status.lastRequeued, 0);
    assert.equal(status.lastDeadLettered, 1);
    assert.equal(status.totalDeadLettered, 1);

    const healthAfter = await (await fetch(`${server.baseUrl}/health`)).json();
    assert.equal(healthAfter.staleReaper.totalDeadLettered, 1);
    assert.equal(healthAfter.staleReaper.lastDeadLettered, 1);

    const dashboardAfter = await (await fetch(`${server.baseUrl}/dashboard`, {
      headers: { "x-a2a-edge-secret": "s" },
    })).json();
    assert.equal(dashboardAfter.observability.recovery.totalRequeued, 1);
    assert.equal(dashboardAfter.observability.recovery.totalDeadLettered, 1);
    assert.equal(dashboardAfter.observability.recovery.recentDeadLetters.length, 1);
    assert.equal(dashboardAfter.staleReaper.runCount, 2);
    assert.equal(dashboardAfter.staleReaper.totalDeadLettered, 1);
    assert.equal(dashboardAfter.staleReaper.lastDeadLettered, 1);
    assert.equal(dashboardAfter.attention.highestSeverity, "warn");
    assert.ok(dashboardAfter.attention.items.some((item: { code: string }) => item.code === "dead-lettered-tasks"));
  } finally {
    await server.close();
  }
});

test("GET /dashboard attention flags aged claimed and running tasks", async () => {
  const server = await startTestServer({
    edgeSecret: "s",
    staleReaperEnabled: false,
    staleReaperOlderThanSec: 1,
    workerOfflineAfterSec: 120,
  });
  try {
    const h = (extra: Record<string, string> = {}) => ({
      "content-type": "application/json",
      "x-a2a-edge-secret": "s",
      ...extra,
    });

    await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: h({ "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({
        nodeId: "w1",
        role: "analyst",
        capabilities: {
          canAnalyze: true,
          canBackfill: false,
          canPatchWorkspace: false,
          canPromoteLive: false,
          workspaceIds: ["ws"],
          environments: ["research"],
        },
      }),
    });

    const taskRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: h({ "x-a2a-requester-id": "hub-1", "x-a2a-requester-role": "hub" }),
      body: JSON.stringify({
        intent: "analyze",
        requester: { id: "hub-1", kind: "node", role: "hub" },
        target: { id: "w1", kind: "node", role: "analyst" },
        assignedWorkerId: "w1",
        message: "attention task",
      }),
    });
    const task = await taskRes.json();

    await fetch(`${server.baseUrl}/tasks/${task.id}/claim`, {
      method: "POST",
      headers: h({ "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({ workerId: "w1" }),
    });
    await new Promise((resolve) => setTimeout(resolve, 1100));

    let dashboard = await (await fetch(`${server.baseUrl}/dashboard`, {
      headers: { "x-a2a-edge-secret": "s" },
    })).json();
    assert.ok(dashboard.attention.items.some((item: { code: string }) => item.code === "aged-claimed-task"));

    await fetch(`${server.baseUrl}/tasks/${task.id}/start`, {
      method: "POST",
      headers: h({ "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({ workerId: "w1" }),
    });
    await new Promise((resolve) => setTimeout(resolve, 1100));

    dashboard = await (await fetch(`${server.baseUrl}/dashboard`, {
      headers: { "x-a2a-edge-secret": "s" },
    })).json();
    assert.ok(dashboard.attention.items.some((item: { code: string }) => item.code === "aged-running-task"));
  } finally {
    await server.close();
  }
});

test("POST /tasks/requeue_stale reports both requeued and dead-lettered counts", async () => {
  const server = await startTestServer({
    edgeSecret: "s",
    staleReaperEnabled: false,
    workerOfflineAfterSec: 1,
    maxRequeueAttempts: 1,
  });
  try {
    const h = (extra: Record<string, string> = {}) => ({
      "content-type": "application/json",
      "x-a2a-edge-secret": "s",
      ...extra,
    });

    await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: h({ "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({
        nodeId: "w1",
        role: "analyst",
        capabilities: {
          canAnalyze: true,
          canBackfill: false,
          canPatchWorkspace: false,
          canPromoteLive: false,
          workspaceIds: ["ws"],
          environments: ["research"],
        },
      }),
    });

    const taskRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: h({ "x-a2a-requester-id": "hub-1", "x-a2a-requester-role": "hub" }),
      body: JSON.stringify({
        intent: "analyze",
        requester: { id: "hub-1", kind: "node", role: "hub" },
        target: { id: "w1", kind: "node", role: "analyst" },
        assignedWorkerId: "w1",
        message: "analyze payload",
      }),
    });
    const task = await taskRes.json();

    // Burn attempt #1 via the manual endpoint.
    await fetch(`${server.baseUrl}/tasks/${task.id}/claim`, {
      method: "POST",
      headers: h({ "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({ workerId: "w1" }),
    });
    const firstSweep = await (await fetch(
      `${server.baseUrl}/tasks/requeue_stale?older_than_seconds=0`,
      {
        method: "POST",
        headers: h({ "x-a2a-requester-id": "ops", "x-a2a-requester-role": "operator" }),
      },
    )).json();
    assert.equal(firstSweep.requeued, 1);
    assert.equal(firstSweep.deadLettered, 0);
    assert.equal(firstSweep.maxRequeueAttempts, 1);
    assert.equal(firstSweep.items[0].requeueCount, 1);

    // Second sweep: the task is over its cap and must dead-letter.
    await fetch(`${server.baseUrl}/tasks/${task.id}/claim`, {
      method: "POST",
      headers: h({ "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({ workerId: "w1" }),
    });
    const secondSweep = await (await fetch(
      `${server.baseUrl}/tasks/requeue_stale?older_than_seconds=0`,
      {
        method: "POST",
        headers: h({ "x-a2a-requester-id": "ops", "x-a2a-requester-role": "operator" }),
      },
    )).json();
    assert.equal(secondSweep.requeued, 0);
    assert.equal(secondSweep.deadLettered, 1);
    assert.equal(secondSweep.deadLetteredItems[0].id, task.id);
    assert.equal(secondSweep.deadLetteredItems[0].error.code, "exceeded_requeue_limit");
  } finally {
    await server.close();
  }
});

interface ParsedSseEvent {
  event: string;
  data: string;
  id?: string;
}

function parseSseBlock(block: string): ParsedSseEvent | null {
  if (!block.trim()) {
    return null;
  }
  let event = "message";
  let data = "";
  let id: string | undefined;
  let hasEventField = false;
  let hasDataField = false;
  let hasIdField = false;
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) {
      continue;
    }
    if (line.startsWith("event:")) {
      hasEventField = true;
      event = line.slice(line.startsWith("event: ") ? "event: ".length : "event:".length).trim();
    } else if (line.startsWith("data:")) {
      hasDataField = true;
      const fragment = line.slice(line.startsWith("data: ") ? "data: ".length : "data:".length);
      data = data ? `${data}\n${fragment}` : fragment;
    } else if (line.startsWith("id:")) {
      hasIdField = true;
      id = line.slice(line.startsWith("id: ") ? "id: ".length : "id:".length).trim();
    }
  }
  if (!hasEventField && !hasDataField && !hasIdField) {
    return null;
  }
  return { event, data, id };
}

async function readAllSseEvents(response: Response): Promise<ParsedSseEvent[]> {
  const body = response.body;
  assert.ok(body, "SSE response must have a body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
  }
  buffer += decoder.decode();

  const events: ParsedSseEvent[] = [];
  for (const block of buffer.split(/\n\n/)) {
    const event = parseSseBlock(block);
    if (event) {
      events.push(event);
    }
  }
  return events;
}

async function readSseEventsUntil(
  response: Response,
  predicate: (events: ParsedSseEvent[]) => boolean,
  timeoutMs = 5_000,
): Promise<ParsedSseEvent[]> {
  const body = response.body;
  assert.ok(body, "SSE response must have a body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const events: ParsedSseEvent[] = [];
  let buffer = "";
  const deadline = Date.now() + timeoutMs;

  try {
    while (Date.now() <= deadline) {
      const remainingMs = deadline - Date.now();
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("timed out waiting for SSE events")), remainingMs);
        }),
      ]);
      if (chunk.done) {
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseSseBlock(block);
        if (event) {
          events.push(event);
          if (predicate(events)) {
            await reader.cancel();
            return events;
          }
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }

  throw new Error(`timed out waiting for SSE events; received ${events.length}`);
}

test("GET/POST /a2a/tasks/terminal-outbox replays and acknowledges compact records", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret", rateLimitMaxRequests: 20 });
  try {
    await registerTestWorker(server.baseUrl, "worker-a", "analyst", "test-edge-secret");

    const hubHeaders = jsonHeaders({
      "x-a2a-edge-secret": "test-edge-secret",
      "x-a2a-requester-id": "hub-a",
      "x-a2a-requester-role": "hub",
    });
    const taskRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: hubHeaders,
      body: JSON.stringify({
        intent: "analyze",
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        assignedWorkerId: "worker-a",
        payload: { githubRepo: "acme/example", githubIssueNumber: 246, rawPrompt: "do-not-leak" },
        message: "do not leak this prompt",
      }),
    });
    const task = await taskRes.json();

    const workerHeaders = jsonHeaders({
      "x-a2a-edge-secret": "test-edge-secret",
      "x-a2a-requester-id": "worker-a",
      "x-a2a-requester-role": "analyst",
    });
    await fetch(`${server.baseUrl}/tasks/${task.id}/claim`, {
      method: "POST",
      headers: workerHeaders,
      body: JSON.stringify({ workerId: "worker-a" }),
    });
    await fetch(`${server.baseUrl}/tasks/${task.id}/complete`, {
      method: "POST",
      headers: workerHeaders,
      body: JSON.stringify({
        workerId: "worker-a",
        result: {
          summary: "Done from /work/repo/dist/server.test.js token=fake-token-placeholder",
          output: {
            doneUrl: "https://github.com/acme/example/issues/246#issuecomment-done",
            rawLog: "do-not-leak",
          },
        },
      }),
    });

    const listRes = await fetch(`${server.baseUrl}/a2a/tasks/terminal-outbox`, {
      headers: {
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      },
    });
    assert.equal(listRes.status, 200);
    const list = await listRes.json();
    assert.equal(list.kind, "task.terminal.outbox");
    assert.equal(list.count, 1);
    const [event] = list.events;
    assert.equal(event.kind, "task.terminal");
    assert.equal(event.payload.taskId, task.id);
    assert.equal(event.payload.status, "succeeded");
    assert.equal(event.payload.worker, "worker-a");
    assert.equal(event.payload.repo, "acme/example");
    assert.equal(event.payload.issue, 246);
    assert.equal(event.payload.doneUrl, "https://github.com/acme/example/issues/246#issuecomment-done");
    assert.match(event.payload.testSummary, /Done from \[path\]/);
    assert.equal(list.cursor, event.id);

    const replayRes = await fetch(
      `${server.baseUrl}/a2a/tasks/terminal-outbox?after_id=${encodeURIComponent(event.id)}`,
      {
        headers: {
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "hub-a",
          "x-a2a-requester-role": "hub",
        },
      },
    );
    const replay = await replayRes.json();
    assert.equal(replay.count, 0);
    assert.equal(replay.cursor, event.id);

    const falseAckRes = await fetch(`${server.baseUrl}/a2a/tasks/terminal-outbox/ack`, {
      method: "POST",
      headers: hubHeaders,
      body: JSON.stringify({ id: event.id, deliveredAt: "2026-05-02T00:00:00.000Z" }),
    });
    assert.equal(falseAckRes.status, 400);

    for (const evidence of ["gateway_send_success", "provider_send_success", "provider_accepted"]) {
      const sendSuccessAckRes = await fetch(`${server.baseUrl}/a2a/tasks/terminal-outbox/ack`, {
        method: "POST",
        headers: hubHeaders,
        body: JSON.stringify({ id: event.id, receipt: { evidence } }),
      });
      assert.equal(sendSuccessAckRes.status, 400, evidence);
    }

    const providerSentAt = "2026-05-01T23:59:00.000Z";
    const providerSentRes = await fetch(`${server.baseUrl}/a2a/tasks/terminal-outbox/receipt`, {
      method: "POST",
      headers: hubHeaders,
      body: JSON.stringify({
        id: event.id,
        receipt: { status: "provider_sent", updatedAt: providerSentAt, note: "provider accepted message-id=abc" },
      }),
    });
    assert.equal(providerSentRes.status, 200);
    const providerSent = await providerSentRes.json();
    assert.equal(providerSent.event.ack, undefined);
    assert.deepEqual(providerSent.event.receipt, {
      status: "provider_sent",
      updatedAt: providerSentAt,
      note: "provider accepted message-id=abc",
    });

    const reportRes = await fetch(`${server.baseUrl}/operator/task-report?task_id=${encodeURIComponent(task.id)}`, {
      headers: hubHeaders,
    });
    assert.equal(reportRes.status, 200);
    const report = await reportRes.json();
    assert.equal(report.items[0].receiptStatus, "provider_sent");
    assert.equal(report.items[0].terminalBrief.cursor, event.id);
    assert.equal(report.items[0].terminalBrief.ackStatus, "unacknowledged");
    assert.equal(report.items[0].terminalBrief.evidenceUrl, "https://github.com/acme/example/issues/246#issuecomment-done");
    assert.match(report.items[0].reportLine, /receipt gap: provider_sent/);

    const providerAcceptedAt = "2026-05-01T23:59:30.000Z";
    const providerAcceptedRes = await fetch(`${server.baseUrl}/a2a/tasks/terminal-outbox/receipt`, {
      method: "POST",
      headers: hubHeaders,
      body: JSON.stringify({
        id: event.id,
        receipt: { status: "provider_accepted", updatedAt: providerAcceptedAt, note: "provider accepted only" },
      }),
    });
    assert.equal(providerAcceptedRes.status, 200);
    const providerAccepted = await providerAcceptedRes.json();
    assert.equal(providerAccepted.event.ack, undefined);
    assert.deepEqual(providerAccepted.event.receipt, {
      status: "provider_accepted",
      updatedAt: providerAcceptedAt,
      note: "provider accepted only",
    });

    const acknowledgedAt = "2026-05-02T00:00:00.000Z";
    const ackRes = await fetch(`${server.baseUrl}/a2a/tasks/terminal-outbox/ack`, {
      method: "POST",
      headers: hubHeaders,
      body: JSON.stringify({
        id: event.id,
        receipt: {
          evidence: "operator_visible",
          acknowledgedAt,
          receiptId: "operator-message-246",
        },
      }),
    });
    assert.equal(ackRes.status, 200);
    const ack = await ackRes.json();
    assert.deepEqual(ack.event.ack, {
      status: "receipt_confirmed",
      evidence: "operator_visible",
      acknowledgedAt,
      receiptId: "operator-message-246",
    });
    assert.deepEqual(ack.event.receipt, {
      status: "operator_visible",
      updatedAt: acknowledgedAt,
      evidence: "operator_visible",
      receiptId: "operator-message-246",
    });
    assert.equal(ack.event.deliveredAt, undefined);
    assert.equal(ack.event.attempts, 1);

    const serialized = JSON.stringify({ list, ack });
    for (const forbidden of ["do not leak", "rawPrompt", "rawLog", "do-not-leak", "fake-token-placeholder", "/work/repo"]) {
      assert.ok(!serialized.includes(forbidden), forbidden);
    }
  } finally {
    await server.close();
  }
});

test("terminal outbox receipt and ACK endpoints persist SQLite hot rows", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-sqlite-outbox-"));
  const store = new SqliteBrokerStateStore(join(dir, "state.sqlite"), { loadSource: "hot-tables" });
  const server = await startTestServer({ stateStore: store, edgeSecret: "test-edge-secret" });
  try {
    await registerTestWorker(server.baseUrl, "worker-a", "analyst", "test-edge-secret");

    const hubHeaders = jsonHeaders({
      "x-a2a-edge-secret": "test-edge-secret",
      "x-a2a-requester-id": "hub-a",
      "x-a2a-requester-role": "hub",
    });
    const workerHeaders = jsonHeaders({
      "x-a2a-edge-secret": "test-edge-secret",
      "x-a2a-requester-id": "worker-a",
      "x-a2a-requester-role": "analyst",
    });

    const createRes = await fetch(server.baseUrl + "/tasks", {
      method: "POST",
      headers: hubHeaders,
      body: JSON.stringify({
        intent: "analyze",
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        assignedWorkerId: "worker-a",
        message: "persist terminal outbox ACK",
      }),
    });
    assert.equal(createRes.status, 201);
    const task = await createRes.json();

    const claimRes = await fetch(server.baseUrl + "/tasks/" + encodeURIComponent(task.id) + "/claim", {
      method: "POST",
      headers: workerHeaders,
      body: JSON.stringify({ workerId: "worker-a" }),
    });
    assert.equal(claimRes.status, 200);

    const completeRes = await fetch(server.baseUrl + "/tasks/" + encodeURIComponent(task.id) + "/complete", {
      method: "POST",
      headers: workerHeaders,
      body: JSON.stringify({ workerId: "worker-a", result: { summary: "done" } }),
    });
    assert.equal(completeRes.status, 200);

    const [event] = store.readHotTerminalOutbox();
    assert.ok(event, "terminal outbox event should be persisted before ACK");
    assert.equal(event.ack, undefined);
    let diagnostics = store.readHotTerminalOutboxDiagnostics();
    assert.equal(diagnostics.total, 1);
    assert.equal(diagnostics.acked, 0);
    assert.equal(diagnostics.unacked, 1);
    assert.equal(diagnostics.unackedRatio, 1);
    assert.equal(diagnostics.oldestUnackedCreatedAt, event.createdAt);
    assert.deepEqual(diagnostics.warnings, []);

    const receiptAt = "2026-05-02T00:00:00.000Z";
    const receiptRes = await fetch(server.baseUrl + "/a2a/tasks/terminal-outbox/receipt", {
      method: "POST",
      headers: hubHeaders,
      body: JSON.stringify({
        id: event.id,
        receipt: { status: "provider_accepted", updatedAt: receiptAt, note: "provider accepted only" },
      }),
    });
    assert.equal(receiptRes.status, 200);
    let persisted = store.readHotTerminalOutbox()[0]!;
    assert.deepEqual(persisted.receipt, {
      status: "provider_accepted",
      updatedAt: receiptAt,
      note: "provider accepted only",
    });
    assert.equal(store.readHotTerminalOutboxDiagnostics().unacked, 1);

    const acknowledgedAt = "2026-05-02T00:01:00.000Z";
    const ackRes = await fetch(server.baseUrl + "/a2a/tasks/terminal-outbox/ack", {
      method: "POST",
      headers: hubHeaders,
      body: JSON.stringify({
        id: event.id,
        receipt: {
          evidence: "operator_visible",
          acknowledgedAt,
          receiptId: "operator-message-1",
        },
      }),
    });
    assert.equal(ackRes.status, 200);
    persisted = store.readHotTerminalOutbox()[0]!;
    assert.deepEqual(persisted.ack, {
      status: "receipt_confirmed",
      evidence: "operator_visible",
      acknowledgedAt,
      receiptId: "operator-message-1",
    });
    assert.equal(persisted.receipt.status, "operator_visible");
    assert.equal(persisted.attempts, 1);
    diagnostics = store.readHotTerminalOutboxDiagnostics();
    assert.equal(diagnostics.total, 1);
    assert.equal(diagnostics.acked, 1);
    assert.equal(diagnostics.unacked, 0);
    assert.equal(diagnostics.unackedRatio, 0);
    assert.equal(diagnostics.oldestUnackedCreatedAt, null);
    assert.equal(diagnostics.oldestUnackedAgeMs, null);
    assert.deepEqual(diagnostics.warnings, []);

    const duplicateAckRes = await fetch(server.baseUrl + "/a2a/tasks/terminal-outbox/ack", {
      method: "POST",
      headers: hubHeaders,
      body: JSON.stringify({
        id: event.id,
        receipt: {
          evidence: "operator_visible",
          acknowledgedAt,
          receiptId: "operator-message-1",
        },
      }),
    });
    assert.equal(duplicateAckRes.status, 200);
    persisted = store.readHotTerminalOutbox()[0]!;
    assert.equal(persisted.attempts, 1, "duplicate ACK should not create another terminal attempt");
    assert.equal(store.readHotTerminalOutboxDiagnostics().acked, 1);
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GET /a2a/tasks/terminal-outbox reconciles unacknowledged records before cursor", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    await registerTestWorker(server.baseUrl, "worker-a", "analyst", "test-edge-secret");

    const hubHeaders = jsonHeaders({
      "x-a2a-edge-secret": "test-edge-secret",
      "x-a2a-requester-id": "hub-a",
      "x-a2a-requester-role": "hub",
    });
    const workerHeaders = jsonHeaders({
      "x-a2a-edge-secret": "test-edge-secret",
      "x-a2a-requester-id": "worker-a",
      "x-a2a-requester-role": "analyst",
    });

    for (const name of ["one", "two", "three"]) {
      const createRes = await fetch(`${server.baseUrl}/tasks`, {
        method: "POST",
        headers: hubHeaders,
        body: JSON.stringify({
          intent: "analyze",
          requester: { id: "hub-a", kind: "node", role: "hub" },
          target: { id: "worker-a", kind: "node", role: "analyst" },
          assignedWorkerId: "worker-a",
          payload: { githubRepo: "acme/example", githubIssueNumber: 240 },
          message: `task ${name}`,
        }),
      });
      const task = await createRes.json();
      await fetch(`${server.baseUrl}/tasks/${task.id}/claim`, {
        method: "POST",
        headers: workerHeaders,
        body: JSON.stringify({ workerId: "worker-a" }),
      });
      await fetch(`${server.baseUrl}/tasks/${task.id}/complete`, {
        method: "POST",
        headers: workerHeaders,
        body: JSON.stringify({ workerId: "worker-a", result: { summary: `done ${name}` } }),
      });
    }

    const firstPollRes = await fetch(`${server.baseUrl}/a2a/tasks/terminal-outbox`, { headers: hubHeaders });
    const firstPoll = await firstPollRes.json();
    assert.equal(firstPoll.count, 3);
    const [first, second, third] = firstPoll.events;
    assert.ok(first && second && third);

    const ackRes = await fetch(`${server.baseUrl}/a2a/tasks/terminal-outbox/ack`, {
      method: "POST",
      headers: hubHeaders,
      body: JSON.stringify({ id: first.id, receipt: { evidence: "operator_visible", acknowledgedAt: "2026-05-02T00:00:00.000Z" } }),
    });
    assert.equal(ackRes.status, 200);

    const reconcileRes = await fetch(
      `${server.baseUrl}/a2a/tasks/terminal-outbox?after_id=${encodeURIComponent(second.id)}&reconcile_unacked=true`,
      { headers: hubHeaders },
    );
    const reconcile = await reconcileRes.json();
    assert.equal(reconcile.count, 2);
    assert.equal(reconcile.reconciledUnacked, 1);
    assert.deepEqual(reconcile.events.map((event: any) => event.id), [second.id, third.id]);
    assert.equal(reconcile.cursor, third.id);

    const retryOnlyRes = await fetch(
      `${server.baseUrl}/a2a/tasks/terminal-outbox?after_id=${encodeURIComponent(third.id)}&limit=1&reconcile_unacked=true`,
      { headers: hubHeaders },
    );
    const retryOnly = await retryOnlyRes.json();
    assert.deepEqual(retryOnly.events.map((event: any) => event.id), [second.id]);
    assert.equal(retryOnly.cursor, third.id);
  } finally {
    await server.close();
  }
});

test("SSE /a2a/workers/:id/assignment-events streams queued assignment hints with replay", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    await registerTestWorker(server.baseUrl, "worker-a", "analyst", "test-edge-secret");
    await registerTestWorker(server.baseUrl, "worker-b", "analyst", "test-edge-secret");

    const workerHeaders = {
      "x-a2a-edge-secret": "test-edge-secret",
      "x-a2a-requester-id": "worker-a",
      "x-a2a-requester-role": "analyst",
    };
    const sseRes = await fetch(`${server.baseUrl}/a2a/workers/worker-a/assignment-events`, {
      headers: workerHeaders,
    });
    assert.equal(sseRes.status, 200);

    const hubHeaders = jsonHeaders({
      "x-a2a-edge-secret": "test-edge-secret",
      "x-a2a-requester-id": "hub-a",
      "x-a2a-requester-role": "hub",
    });
    const taskRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: hubHeaders,
      body: JSON.stringify({
        intent: "analyze",
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        assignedWorkerId: "worker-a",
        payload: { githubRepo: "acme/example", githubIssueNumber: 377, rawPrompt: "do-not-leak" },
        message: "secret task prompt must not be streamed",
      }),
    });
    assert.equal(taskRes.status, 201);
    const task = await taskRes.json() as { id: string };

    const events = await readSseEventsUntil(
      sseRes,
      (seen) => seen.some((event) => event.event === "worker-assignment"),
    );
    const assignment = events.find((event) => event.event === "worker-assignment");
    assert.ok(assignment);
    assert.ok(assignment.id);
    const data = JSON.parse(assignment.data);
    assert.equal(data.taskId, task.id);
    assert.equal(data.status, "queued");
    assert.equal(data.assignedWorkerId, "worker-a");
    assert.equal(data.metadata.repoFullName, "acme/example");
    assert.equal(data.metadata.issueNumber, 377);
    assert.equal(assignment.data.includes("secret task prompt"), false);
    assert.equal(assignment.data.includes("do-not-leak"), false);

    const replayRes = await fetch(`${server.baseUrl}/a2a/workers/worker-a/assignment-events`, {
      headers: {
        ...workerHeaders,
        "Last-Event-ID": "0",
      },
    });
    assert.equal(replayRes.status, 200);
    const replayEvents = await readSseEventsUntil(
      replayRes,
      (seen) => seen.some((event) => event.event === "worker-assignment"),
    );
    assert.equal(
      replayEvents.some((event) => event.event === "worker-assignment" && JSON.parse(event.data).taskId === task.id),
      true,
    );

    const strangerRes = await fetch(`${server.baseUrl}/a2a/workers/worker-a/assignment-events`, {
      headers: {
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "worker-b",
        "x-a2a-requester-role": "analyst",
      },
    });
    assert.equal(strangerRes.status, 401);
  } finally {
    await server.close();
  }
});

test("SSE /a2a/tasks/terminal-events streams compact terminal events with replay ids", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    await registerTestWorker(server.baseUrl, "worker-a", "analyst", "test-edge-secret");

    const hubHeaders = jsonHeaders({
      "x-a2a-edge-secret": "test-edge-secret",
      "x-a2a-requester-id": "hub-a",
      "x-a2a-requester-role": "hub",
    });
    const taskRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: hubHeaders,
      body: JSON.stringify({
        intent: "analyze",
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        assignedWorkerId: "worker-a",
        payload: { githubRepo: "acme/example", githubIssueNumber: 217, secret: "nope" },
        message: "do not leak this prompt",
      }),
    });
    const task = await taskRes.json();

    const sseRes = await fetch(`${server.baseUrl}/a2a/tasks/terminal-events`, {
      headers: {
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
        accept: "text/event-stream",
      },
    });
    assert.equal(sseRes.status, 200);
    assert.match(sseRes.headers.get("content-type") ?? "", /text\/event-stream/);

    const workerHeaders = jsonHeaders({
      "x-a2a-edge-secret": "test-edge-secret",
      "x-a2a-requester-id": "worker-a",
      "x-a2a-requester-role": "analyst",
    });
    await fetch(`${server.baseUrl}/tasks/${task.id}/claim`, {
      method: "POST",
      headers: workerHeaders,
      body: JSON.stringify({ workerId: "worker-a" }),
    });
    await fetch(`${server.baseUrl}/tasks/${task.id}/complete`, {
      method: "POST",
      headers: workerHeaders,
      body: JSON.stringify({
        workerId: "worker-a",
        result: {
          output: {
            prUrl: "https://github.com/acme/example/pull/9",
            doneUrl: "https://github.com/acme/example/issues/217#issuecomment-2",
            testSummary: { status: "passed", total: 1, passed: 1 },
          },
        },
      }),
    });

    const events = await readSseEventsUntil(sseRes, (seen) => seen.some((e) => e.event === "task-terminal"));
    const terminal = events.find((e) => e.event === "task-terminal");
    assert.ok(terminal);
    assert.equal(terminal.id, "1");
    const payload = JSON.parse(terminal.data);
    assert.equal(payload.taskId, task.id);
    assert.equal(payload.status, "succeeded");
    assert.equal(payload.worker, "worker-a");
    assert.equal(payload.repo, "acme/example");
    assert.equal(payload.issue, 217);
    assert.equal(payload.prUrl, "https://github.com/acme/example/pull/9");
    assert.equal(payload.doneUrl, "https://github.com/acme/example/issues/217#issuecomment-2");
    assert.deepEqual(payload.testSummary, { status: "passed", total: 1, passed: 1 });
    const serialized = JSON.stringify(payload);
    assert.ok(!serialized.includes("do not leak"));
    assert.ok(!serialized.includes("secret"));

    const replayRes = await fetch(`${server.baseUrl}/a2a/tasks/terminal-events`, {
      headers: {
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
        "last-event-id": "0",
        accept: "text/event-stream",
      },
    });
    const replayed = await readSseEventsUntil(replayRes, (seen) => seen.some((e) => e.event === "task-terminal"));
    assert.equal(replayed.find((e) => e.event === "task-terminal")?.id, "1");
  } finally {
    await server.close();
  }
});

test("SSE /a2a/tasks/:id/events streams snapshot plus lifecycle updates and closes on terminal", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({
        nodeId: "worker-a",
        role: "analyst",
        capabilities: {
          canAnalyze: true,
          canBackfill: false,
          canPatchWorkspace: false,
          canPromoteLive: false,
          workspaceIds: ["test"],
          environments: ["research"],
        },
      }),
    });

    const taskRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({
        intent: "analyze",
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        assignedWorkerId: "worker-a",
        message: "run analysis",
      }),
    });
    const task = await taskRes.json();

    const sseRes = await fetch(`${server.baseUrl}/a2a/tasks/${task.id}/events`, {
      headers: {
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
        accept: "text/event-stream",
      },
    });
    assert.equal(sseRes.status, 200);
    assert.match(sseRes.headers.get("content-type") ?? "", /text\/event-stream/);
    assert.equal(sseRes.headers.get("cache-control"), "no-cache, no-store, no-transform");

    const workerHeaders = jsonHeaders({
      "x-a2a-edge-secret": "test-edge-secret",
      "x-a2a-requester-id": "worker-a",
      "x-a2a-requester-role": "analyst",
    });
    await fetch(`${server.baseUrl}/tasks/${task.id}/claim`, {
      method: "POST",
      headers: workerHeaders,
      body: JSON.stringify({ workerId: "worker-a" }),
    });
    await fetch(`${server.baseUrl}/tasks/${task.id}/start`, {
      method: "POST",
      headers: workerHeaders,
      body: JSON.stringify({ workerId: "worker-a" }),
    });
    await fetch(`${server.baseUrl}/tasks/${task.id}/complete`, {
      method: "POST",
      headers: workerHeaders,
      body: JSON.stringify({ workerId: "worker-a", result: { summary: "done" } }),
    });

    const events = await readAllSseEvents(sseRes);
    const types = events.map((e) => e.event);
    assert.deepEqual(types, [
      "task-snapshot",
      "task-status-update",
      "task-status-update",
      "task-status-update",
    ]);

    const snapshot = JSON.parse(events[0].data);
    assert.equal(snapshot.task.id, task.id);
    assert.equal(snapshot.task.status.state, "submitted");
    assert.equal(snapshot.reason, "snapshot");
    assert.equal(snapshot.final, false);

    const reasons = events.slice(1).map((e) => JSON.parse(e.data).reason);
    assert.deepEqual(reasons, ["claimed", "started", "succeeded"]);

    const terminal = JSON.parse(events[events.length - 1].data);
    assert.equal(terminal.final, true);
    assert.equal(terminal.task.status.state, "completed");
  } finally {
    await server.close();
  }
});

test("SSE /a2a/tasks/:id/events closes immediately for already-terminal tasks", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({
        nodeId: "worker-a",
        role: "analyst",
        capabilities: {
          canAnalyze: true,
          canBackfill: false,
          canPatchWorkspace: false,
          canPromoteLive: false,
          workspaceIds: ["test"],
          environments: ["research"],
        },
      }),
    });
    const taskRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({
        intent: "analyze",
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        assignedWorkerId: "worker-a",
        message: "run analysis",
      }),
    });
    const task = await taskRes.json();

    await fetch(`${server.baseUrl}/tasks/${task.id}/cancel`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({ actor: { id: "hub-a", role: "hub", kind: "node" }, reason: "stop" }),
    });

    const sseRes = await fetch(`${server.baseUrl}/a2a/tasks/${task.id}/events`, {
      headers: {
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      },
    });
    assert.equal(sseRes.status, 200);
    const events = await readAllSseEvents(sseRes);
    assert.equal(events.length, 1);
    assert.equal(events[0].event, "task-snapshot");
    const snapshot = JSON.parse(events[0].data);
    assert.equal(snapshot.task.status.state, "canceled");
    assert.equal(snapshot.final, true);
  } finally {
    await server.close();
  }
});

test("SSE /a2a/tasks/:id/events rejects unauthorized subscribers", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({
        nodeId: "worker-a",
        role: "analyst",
        capabilities: {
          canAnalyze: true,
          canBackfill: false,
          canPatchWorkspace: false,
          canPromoteLive: false,
          workspaceIds: ["test"],
          environments: ["research"],
        },
      }),
    });
    const taskRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({
        intent: "analyze",
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        assignedWorkerId: "worker-a",
        message: "run analysis",
      }),
    });
    const task = await taskRes.json();

    const strangerRes = await fetch(`${server.baseUrl}/a2a/tasks/${task.id}/events`, {
      headers: {
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "stranger",
        "x-a2a-requester-role": "researcher",
      },
    });
    assert.equal(strangerRes.status, 401);
    await strangerRes.body?.cancel();

    const missingRes = await fetch(`${server.baseUrl}/a2a/tasks/does-not-exist/events`, {
      headers: {
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      },
    });
    assert.equal(missingRes.status, 404);
    await missingRes.body?.cancel();
  } finally {
    await server.close();
  }
});

test("SSE /a2a/operator/events streams snapshot with current worker heartbeat alerts", async () => {
  const server = await startTestServer({
    edgeSecret: "test-edge-secret",
    workerOfflineAfterSec: 1,
  });
  try {
    await registerTestWorker(server.baseUrl, "worker-a", "analyst", "test-edge-secret");
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    const sseController = new AbortController();
    const sseRes = await fetch(`${server.baseUrl}/a2a/operator/events`, {
      signal: sseController.signal,
      headers: {
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "ops",
        "x-a2a-requester-role": "operator",
        accept: "text/event-stream",
      },
    });
    assert.equal(sseRes.status, 200);
    assert.match(sseRes.headers.get("content-type") ?? "", /text\/event-stream/);

    const events = await readSseEventsUntil(
      sseRes,
      (seen) => seen.some((event) => event.event === "operator-snapshot"),
    );
    sseController.abort();

    const snapshotEvent = events.find((event) => event.event === "operator-snapshot");
    assert.ok(snapshotEvent, "expected operator-snapshot event");
    const snapshot = JSON.parse(snapshotEvent!.data);
    assert.equal(snapshot.summary.workers.total, 1);
    assert.equal(
      snapshot.alerts.alerts.some(
        (alert: { kind: string; workerId?: string }) =>
          alert.kind === "worker.heartbeat_missed" && alert.workerId === "worker-a",
      ),
      true,
    );
  } finally {
    await server.close();
  }
});

test("SSE /a2a/operator/events skips idle alert replay work and returns a fresh snapshot on subscribe", async () => {
  const server = await startTestServer({
    edgeSecret: "test-edge-secret",
    workerOfflineAfterSec: 1,
  });
  try {
    await registerTestWorker(server.baseUrl, "worker-a", "analyst", "test-edge-secret");
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    const createRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({
        intent: "analyze",
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        assignedWorkerId: "worker-a",
        message: "operator replay check",
      }),
    });
    assert.equal(createRes.status, 201);

    const heartbeatRes = await fetch(`${server.baseUrl}/workers/worker-a/heartbeat`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({}),
    });
    assert.equal(heartbeatRes.status, 200);

    const replayController = new AbortController();
    const replayRes = await fetch(`${server.baseUrl}/a2a/operator/events`, {
      signal: replayController.signal,
      headers: {
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "ops",
        "x-a2a-requester-role": "operator",
        accept: "text/event-stream",
        "Last-Event-ID": "operator:0",
      },
    });
    assert.equal(replayRes.status, 200);

    const replayEvents = await readSseEventsUntil(
      replayRes,
      (events) => events.some((event) => event.event === "operator-snapshot"),
    );
    replayController.abort();

    assert.deepEqual(replayEvents.map((event) => event.event), ["operator-snapshot"]);
    const replaySnapshot = JSON.parse(replayEvents.find((event) => event.event === "operator-snapshot")!.data);
    assert.equal(
      replaySnapshot.alerts.alerts.some((alert: { kind: string }) => alert.kind === "worker.heartbeat_missed"),
      false,
    );
  } finally {
    await server.close();
  }
});

test("SSE /a2a/operator/events does not buffer idle summary projections without subscribers", async () => {
  const server = await startTestServer({
    edgeSecret: "test-edge-secret",
  });
  try {
    await registerTestWorker(server.baseUrl, "worker-a", "analyst", "test-edge-secret");

    const replayController = new AbortController();
    const replayRes = await fetch(`${server.baseUrl}/a2a/operator/events`, {
      signal: replayController.signal,
      headers: {
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "ops",
        "x-a2a-requester-role": "operator",
        accept: "text/event-stream",
        "Last-Event-ID": "operator:0",
      },
    });
    assert.equal(replayRes.status, 200);

    const events = await readSseEventsUntil(
      replayRes,
      (seen) => seen.some((event) => event.event === "operator-snapshot"),
    );
    replayController.abort();

    assert.deepEqual(events.map((event) => event.event), ["operator-snapshot"]);
    const snapshot = JSON.parse(events[0]!.data);
    assert.equal(snapshot.summary.workers.total, 1);
  } finally {
    await server.close();
  }
});

test("SSE /a2a/operator/events falls back to a fresh snapshot when Last-Event-ID is outside the replay buffer", async () => {
  const server = await startTestServer({
    edgeSecret: "test-edge-secret",
  });
  try {
    server.runtime.broker.registerWorker({
      nodeId: "worker-a",
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

    for (let i = 0; i < 205; i += 1) {
      server.runtime.broker.createTask({
        intent: "analyze",
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        assignedWorkerId: "worker-a",
        message: `buffered task ${i}`,
      });
    }

    const sseRes = await fetch(`${server.baseUrl}/a2a/operator/events`, {
      headers: {
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "ops",
        "x-a2a-requester-role": "operator",
        accept: "text/event-stream",
        "Last-Event-ID": "operator:0",
      },
    });
    assert.equal(sseRes.status, 200);

    const events = await readSseEventsUntil(
      sseRes,
      (seen) => seen.some((event) => event.event === "operator-snapshot"),
    );

    assert.deepEqual(events.map((event) => event.event), ["operator-snapshot"]);
    const snapshot = JSON.parse(events[0]!.data);
    assert.equal(snapshot.summary.queue.total, 205);
  } finally {
    await server.close();
  }
});

test("SSE /a2a/operator/events rejects non-operator subscribers", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const res = await fetch(`${server.baseUrl}/a2a/operator/events`, {
      headers: {
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "researcher-1",
        "x-a2a-requester-role": "researcher",
      },
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.match(body.error.message, /operator\.subscribe requester role must be one of/);
  } finally {
    await server.close();
  }
});

test("server keeps peer status default-off and exposes a2a.peer.status when enabled", async () => {
  const defaultOffServer = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    await registerTestWorker(defaultOffServer.baseUrl, "worker-a", "analyst", "test-edge-secret");
    const disabledRes = await fetch(`${defaultOffServer.baseUrl}/a2a/jsonrpc`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "disabled",
        method: "a2a.peer.status",
        params: { target: "worker-a" },
      }),
    });
    const disabled = await disabledRes.json();
    assert.equal(disabled.error.code, -32601);
  } finally {
    await defaultOffServer.close();
  }

  const enabledServer = await startTestServer({
    edgeSecret: "test-edge-secret",
    peerStatusEnabled: true,
  });
  try {
    await registerTestWorker(enabledServer.baseUrl, "worker-a", "analyst", "test-edge-secret");
    const enabledRes = await fetch(`${enabledServer.baseUrl}/a2a/jsonrpc`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "enabled",
        method: "a2a.peer.status",
        params: { target: "worker-a" },
      }),
    });
    const enabled = await enabledRes.json();
    assert.equal(enabled.result.schemaVersion, 1);
    assert.equal(enabled.result.target, "worker-a");
    assert.equal(enabled.result.gateway.reachable, true);
    assert.equal(enabled.result.worker.registered, true);
    assert.equal(enabled.result.health, "ok");
  } finally {
    await enabledServer.close();
  }
});

test("JSON-RPC SubscribeToTask returns current task plus SSE subscription URL", async () => {
  const server = await startTestServer({
    edgeSecret: "test-edge-secret",
    publicBaseUrl: "https://broker.example.com/",
  });
  try {
    await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({
        nodeId: "worker-a",
        role: "analyst",
        capabilities: {
          canAnalyze: true,
          canBackfill: false,
          canPatchWorkspace: false,
          canPromoteLive: false,
          workspaceIds: ["test"],
          environments: ["research"],
        },
      }),
    });
    const taskRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({
        intent: "analyze",
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        assignedWorkerId: "worker-a",
        message: "run analysis",
      }),
    });
    const task = await taskRes.json();

    const rpcRes = await fetch(`${server.baseUrl}/a2a/jsonrpc`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "SubscribeToTask",
        params: { taskId: task.id },
      }),
    });
    assert.equal(rpcRes.status, 200);
    const body = await rpcRes.json();
    assert.equal(body.result.task.id, task.id);
    assert.equal(body.result.subscription.transport, "sse");
    assert.equal(
      body.result.subscription.url,
      `https://broker.example.com/a2a/tasks/${task.id}/events`,
    );
    assert.ok(Array.isArray(body.result.subscription.eventTypes));
    assert.ok(body.result.subscription.eventTypes.includes("task-status-update"));
  } finally {
    await server.close();
  }
});

function buildTradingDialecticTaskFixture(
  overrides: Partial<TradingDialecticTaskV1> = {},
): TradingDialecticTaskV1 {
  return {
    kind: TRADING_DIALECTIC_KIND,
    version: TRADING_DIALECTIC_VERSION,
    taskId: "td-task-01",
    revision: 4,
    state: "EXECUTION_ROUTED",
    meta: {
      symbol: "BTCUSDT",
      venue: "binance",
      marketType: "perp",
      side: "long",
      accountRef: "acct-live-01",
      timeHorizon: "intraday",
      urgency: "normal",
      strategyId: "mean-revert-01",
      riskBudgetRef: "risk-live-01",
      snapshotAt: "2026-04-19T09:00:00.000Z",
      dataFreshnessMs: 1500,
      openedAt: "2026-04-19T09:00:00.000Z",
      expiresAt: "2026-04-19T10:00:00.000Z",
      openedBy: "seoseo",
    },
    roles: {
      thesisAgent: { agentId: "bangtong" },
      antithesisAgent: { agentId: "dengae" },
      synthAgent: { agentId: "seoseo" },
    },
    context: {
      marketSnapshot: { bid: 64000, ask: 64010 },
      contextRefs: ["ctx-01"],
      maxProbeRiskR: 0.5,
      maxFullRiskR: 1,
      maxLeverage: 5,
      maxTimestampDriftMs: 2000,
    },
    thesis: {
      author: { agentId: "bangtong" },
      submittedAt: "2026-04-19T09:05:00.000Z",
      regimeHypothesis: "trend-up",
      tradeIdea: "long perp",
      whyNow: "breakout confirmed",
      entryPlan: "limit at pullback",
      invalidation: "below prior swing",
      targets: ["64500", "65000"],
      confidence: 0.7,
      evidenceRefs: ["ev-01"],
      assumptions: ["liquidity holds"],
      riskNotes: ["watch funding"],
    },
    antithesis: {
      author: { agentId: "dengae" },
      submittedAt: "2026-04-19T09:10:00.000Z",
      counterView: "false breakout risk",
      alternativeRegime: "chop",
      whyThesisMayFail: "thin volume",
      failureModes: ["liquidity vacuum"],
      contradictions: ["weakening RSI"],
      vetoFlags: [],
      evidenceRefs: ["ev-02"],
      confidence: 0.6,
    },
    rebuttal: {
      author: { agentId: "bangtong" },
      submittedAt: "2026-04-19T09:15:00.000Z",
      response: "volume returning post-open",
      defendedClaims: ["trend intact"],
      concededRisks: ["funding spike risk"],
      residualRisks: ["news event"],
    },
    synthesis: {
      author: { agentId: "seoseo" },
      submittedAt: "2026-04-19T09:20:00.000Z",
      preserve: ["entry plan"],
      discard: ["aggressive sizing"],
      metaRule: "probe-first under low conviction",
      verdict: "EXECUTE_PROBE",
      triggerSet: ["price>64200"],
      sizeRule: "0.5R",
      killSwitch: ["price<63500"],
      unresolved: ["funding outcome"],
    },
    decision: {
      action: "EXECUTE_PROBE",
      routeTo: "bangtong",
      ttlSec: 600,
      hardVeto: false,
      executionPolicyRef: "policy-probe-v1",
      decisionBasisRevision: 4,
    },
    ...overrides,
  };
}

function buildTradingDialecticPayload(
  overrides: Partial<TradingDialecticTaskV1> = {},
  phase: TradingDialecticTaskInputV1["contract"]["phase"] = "synthesis",
): TradingDialecticTaskInputV1 {
  return {
    contract: {
      kind: TRADING_DIALECTIC_KIND,
      version: TRADING_DIALECTIC_VERSION,
      phase,
      task: buildTradingDialecticTaskFixture(overrides),
    },
  };
}

function buildDecisionDialecticTaskFixture(
  overrides: Partial<DecisionDialecticTaskV1> = {},
): DecisionDialecticTaskV1 {
  return {
    kind: DECISION_DIALECTIC_KIND,
    version: DECISION_DIALECTIC_VERSION,
    taskId: "dd-task-01",
    revision: 3,
    state: "DECISION_ROUTED",
    meta: {
      topic: "gateway-heartbeat-polling",
      domain: "operations",
      urgency: "high",
      openedAt: "2026-05-18T00:00:00.000Z",
      snapshotAt: "2026-05-18T00:02:00.000Z",
      expiresAt: "2026-05-18T06:00:00.000Z",
      openedBy: "seoseo",
      contextRefs: ["wiki:pages/a2a/dialectic-mode.md"],
      tags: ["a2ad", "ops"],
    },
    roles: {
      thesisAgent: { agentId: "sogyo", teamId: "team1", roleHint: "thesis" },
      antithesisAgent: { agentId: "nosuk", teamId: "team1", roleHint: "antithesis" },
      rebuttalAgent: { agentId: "bangtong", teamId: "team1", roleHint: "rebuttal" },
      synthAgent: { agentId: "yukson", teamId: "team1", roleHint: "synthesis" },
    },
    context: {
      brief: "Evaluate whether to reduce heartbeat polling pressure.",
      objective: "Keep operator liveness without overloading broker foreground sessions.",
      constraints: ["no production restart in this task", "no provider send"],
      decisionCriteria: ["liveness preserved", "event loop pressure reduced"],
      evidenceRefs: ["gh:jinwon-int/a2a-broker#489"],
      availableTools: ["logs", "unit-tests"],
      hardVetoPolicy: ["would require unapproved restart", "drops operator visibility"],
      domainContext: {
        brokerId: "seoseo",
        team: "team1",
      },
    },
    thesis: {
      author: { agentId: "sogyo" },
      submittedAt: "2026-05-18T00:05:00.000Z",
      claim: "Reduce redundant idle polling.",
      proposal: "Bound idle polling and keep explicit heartbeat updates.",
      rationale: "The operator channel should stay responsive during closeout rounds.",
      expectedBenefits: ["lower event-loop pressure", "clearer liveness signal"],
      evidenceRefs: ["ev-01"],
      assumptions: ["foreground sessions remain the report channel"],
      risks: ["over-reducing polling may hide stalls"],
      confidence: 0.72,
    },
    antithesis: {
      author: { agentId: "nosuk" },
      submittedAt: "2026-05-18T00:10:00.000Z",
      counterClaim: "Too much reduction can hide worker stalls.",
      whyThesisMayFail: "Operators rely on visible heartbeat signals.",
      failureModes: ["stale status", "silent failure"],
      contradictions: ["liveness and lower polling trade off"],
      vetoFlags: [
        {
          code: "drops_operator_visibility",
          reason: "A change that removes visible heartbeat evidence must block.",
          severity: "warn",
        },
      ],
      evidenceRefs: ["ev-02"],
      confidence: 0.64,
    },
    rebuttal: {
      author: { agentId: "bangtong" },
      submittedAt: "2026-05-18T00:15:00.000Z",
      response: "Keep heartbeat summaries while bounding duplicate scans.",
      defendedClaims: ["operator visibility remains explicit"],
      concededRisks: ["some polling is still needed"],
      residualRisks: ["misconfigured interval"],
    },
    synthesis: {
      author: { agentId: "yukson" },
      submittedAt: "2026-05-18T00:20:00.000Z",
      preserve: ["explicit heartbeat signal"],
      discard: ["unbounded duplicate polling"],
      decisionRule: "Proceed only as a bounded no-live implementation.",
      verdict: "PROCEED_WITH_GUARDRAILS",
      guardrails: ["no restart", "unit tests only"],
      followups: ["separate live canary approval"],
      unresolved: ["production interval tuning"],
    },
    decision: {
      action: "PROCEED_WITH_GUARDRAILS",
      routeTo: "yukson",
      ttlSec: 1800,
      hardVeto: false,
      decisionPolicyRef: "decision-dialectic-no-live-v1",
      decisionBasisRevision: 3,
    },
    ...overrides,
  };
}

function buildDecisionDialecticPayload(
  overrides: Partial<DecisionDialecticTaskV1> = {},
  phase: DecisionDialecticTaskInputV1["contract"]["phase"] = "synthesis",
): DecisionDialecticTaskInputV1 {
  return {
    contract: {
      kind: DECISION_DIALECTIC_KIND,
      version: DECISION_DIALECTIC_VERSION,
      phase,
      task: buildDecisionDialecticTaskFixture(overrides),
    },
  };
}

test("decision-dialectic read model returns generic stage rail and dynamic role routing", async () => {
  const server = await startTestServer({
    edgeSecret: "test-edge-secret",
    enforceRequesterIdentity: true,
  });
  try {
    await registerTestWorker(server.baseUrl, "sogyo", "analyst", "test-edge-secret");
    const createRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({
        intent: "analyze",
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "sogyo", kind: "node", role: "analyst" },
        assignedWorkerId: "sogyo",
        message: "evaluate generic decision dialectic",
        payload: buildDecisionDialecticPayload(),
      }),
    });
    assert.equal(createRes.status, 201);
    const task = await createRes.json();

    const readRes = await fetch(`${server.baseUrl}/tasks/${task.id}/decision-dialectic`, {
      headers: {
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      },
    });
    assert.equal(readRes.status, 200);
    const body = await readRes.json();

    assert.equal(body.kind, "decision.dialectic");
    assert.equal(body.version, 1);
    assert.equal(body.brokerTaskId, task.id);
    assert.equal(body.contract.taskId, "dd-task-01");
    assert.equal(body.contract.state, "DECISION_ROUTED");
    assert.equal(body.contract.phase, "synthesis");
    assert.equal(body.meta.topic, "gateway-heartbeat-polling");
    assert.equal(body.meta.domain, "operations");
    assert.equal(body.roles.thesisAgent.agentId, "sogyo");
    assert.equal(body.roles.antithesisAgent.agentId, "nosuk");
    assert.equal(body.roles.rebuttalAgent.agentId, "bangtong");
    assert.equal(body.roles.synthAgent.agentId, "yukson");
    assert.equal(body.context.domainContext.brokerId, "seoseo");

    const stageNames = ["thesis", "antithesis", "rebuttal", "synthesis", "outcome"];
    for (const stage of stageNames) {
      assert.ok(body.stages[stage], `expected stage ${stage}`);
      assert.equal(body.stages[stage].name, stage);
    }
    assert.equal(body.stages.thesis.author.agentId, "sogyo");
    assert.equal(body.stages.antithesis.vetoFlags[0].code, "drops_operator_visibility");
    assert.equal(body.stages.synthesis.verdict, "PROCEED_WITH_GUARDRAILS");
    assert.equal(body.stages.outcome.present, false);

    assert.equal(body.decisionCard.present, true);
    assert.equal(body.decisionCard.verdict, "PROCEED_WITH_GUARDRAILS");
    assert.equal(body.decisionCard.route, "yukson");
    assert.equal(body.decisionCard.hardVeto, false);
    assert.equal(body.decisionCard.decisionPolicyRef, "decision-dialectic-no-live-v1");
    assert.equal(body.decisionCard.decisionBasisRevision, 3);
    assert.equal(body.decisionCard.ttlSec, 1800);
    assert.equal(body.decisionCard.decidedBy.agentId, "yukson");
    assert.match(body.summary.decision, /PROCEED_WITH_GUARDRAILS/);
  } finally {
    await server.close();
  }
});

test("decision-dialectic execution advances phase tasks and applies ordered patches", async () => {
  const server = await startTestServer({
    edgeSecret: "test-edge-secret",
    enforceRequesterIdentity: true,
  });
  try {
    for (const workerId of ["sogyo", "nosuk", "bangtong", "yukson"]) {
      await registerTestWorker(server.baseUrl, workerId, "analyst", "test-edge-secret");
    }

    const createRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({
        intent: "analyze",
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "sogyo", kind: "node", role: "analyst" },
        assignedWorkerId: "sogyo",
        brokerOfRecord: "seoseo",
        teamId: "team1",
        message: "run generic decision dialectic",
        payload: buildDecisionDialecticPayload(
          {
            revision: 0,
            state: "OPEN",
            thesis: undefined,
            antithesis: undefined,
            rebuttal: undefined,
            synthesis: undefined,
            decision: undefined,
            outcome: undefined,
          },
          "thesis",
        ),
      }),
    });
    assert.equal(createRes.status, 201);
    const parent = await createRes.json();
    const fixture = buildDecisionDialecticTaskFixture();

    const advanceThesisRes = await fetch(`${server.baseUrl}/tasks/${parent.id}/decision-dialectic/advance`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({}),
    });
    assert.equal(advanceThesisRes.status, 201);
    const thesisAdvance = await advanceThesisRes.json();
    assert.equal(thesisAdvance.phase, "thesis");
    assert.equal(thesisAdvance.parentTaskId, parent.id);
    assert.equal(thesisAdvance.childTask.parentTaskId, parent.id);
    assert.equal(thesisAdvance.childTask.targetNodeId, "sogyo");
    assert.equal(thesisAdvance.childTask.assignedWorkerId, "sogyo");
    assert.equal(thesisAdvance.childTask.payload.promptSpec.schemaName, "decisionDialectic.thesis.v1");
    assert.equal(thesisAdvance.childTask.payload.execution.expectedRevision, 0);
    assert.equal(thesisAdvance.childTask.brokerOfRecord, "seoseo");
    assert.equal(thesisAdvance.childTask.teamId, "team1");

    const thesisPatchRes = await fetch(`${server.baseUrl}/tasks/${parent.id}/decision-dialectic/patch`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "sogyo",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({
        op: "append.thesis",
        patchId: "patch-thesis-1",
        taskId: "dd-task-01",
        expectedRevision: 0,
        authorAgent: "sogyo",
        at: "2026-05-18T00:05:00.000Z",
        payload: fixture.thesis,
      }),
    });
    assert.equal(thesisPatchRes.status, 200);
    const thesisReadModel = await thesisPatchRes.json();
    assert.equal(thesisReadModel.contract.revision, 1);
    assert.equal(thesisReadModel.contract.state, "THESIS_SUBMITTED");
    assert.equal(thesisReadModel.contract.phase, "antithesis");
    assert.equal(thesisReadModel.stages.thesis.present, true);

    const advanceAntithesisRes = await fetch(`${server.baseUrl}/tasks/${parent.id}/decision-dialectic/advance`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({}),
    });
    assert.equal(advanceAntithesisRes.status, 201);
    const antithesisAdvance = await advanceAntithesisRes.json();
    assert.equal(antithesisAdvance.phase, "antithesis");
    assert.equal(antithesisAdvance.childTask.targetNodeId, "nosuk");
    assert.equal(antithesisAdvance.childTask.payload.execution.expectedRevision, 1);

    for (const patch of [
      {
        op: "append.antithesis",
        patchId: "patch-antithesis-1",
        expectedRevision: 1,
        authorAgent: "nosuk",
        payload: fixture.antithesis,
      },
      {
        op: "append.rebuttal",
        patchId: "patch-rebuttal-1",
        expectedRevision: 2,
        authorAgent: "bangtong",
        payload: fixture.rebuttal,
      },
      {
        op: "set.synthesis_decision",
        patchId: "patch-synthesis-1",
        expectedRevision: 3,
        authorAgent: "yukson",
        payload: {
          author: { agentId: "yukson" },
          submittedAt: "2026-05-18T00:20:00.000Z",
          synthesis: fixture.synthesis,
          decision: fixture.decision,
        },
      },
    ]) {
      const patchRes = await fetch(`${server.baseUrl}/tasks/${parent.id}/decision-dialectic/patch`, {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": patch.authorAgent,
          "x-a2a-requester-role": "analyst",
        }),
        body: JSON.stringify({
          ...patch,
          taskId: "dd-task-01",
          at: "2026-05-18T00:20:00.000Z",
        }),
      });
      assert.equal(patchRes.status, 200);
    }

    const readRes = await fetch(`${server.baseUrl}/tasks/${parent.id}/decision-dialectic`, {
      headers: {
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      },
    });
    assert.equal(readRes.status, 200);
    const readModel = await readRes.json();
    assert.equal(readModel.contract.revision, 4);
    assert.equal(readModel.contract.state, "DECISION_ROUTED");
    assert.equal(readModel.contract.phase, "outcome");
    assert.equal(readModel.decisionCard.verdict, "PROCEED_WITH_GUARDRAILS");
    assert.equal(readModel.decisionCard.route, "yukson");
  } finally {
    await server.close();
  }
});

test("decision-dialectic execution rejects out-of-order patches", async () => {
  const server = await startTestServer({
    edgeSecret: "test-edge-secret",
    enforceRequesterIdentity: true,
  });
  try {
    await registerTestWorker(server.baseUrl, "sogyo", "analyst", "test-edge-secret");
    await registerTestWorker(server.baseUrl, "nosuk", "analyst", "test-edge-secret");
    const createRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({
        intent: "analyze",
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "sogyo", kind: "node", role: "analyst" },
        assignedWorkerId: "sogyo",
        message: "run generic decision dialectic",
        payload: buildDecisionDialecticPayload(
          {
            revision: 0,
            state: "OPEN",
            thesis: undefined,
            antithesis: undefined,
            rebuttal: undefined,
            synthesis: undefined,
            decision: undefined,
            outcome: undefined,
          },
          "thesis",
        ),
      }),
    });
    assert.equal(createRes.status, 201);
    const parent = await createRes.json();
    const fixture = buildDecisionDialecticTaskFixture();

    const patchRes = await fetch(`${server.baseUrl}/tasks/${parent.id}/decision-dialectic/patch`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "nosuk",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({
        op: "append.antithesis",
        patchId: "patch-antithesis-early",
        taskId: "dd-task-01",
        expectedRevision: 0,
        authorAgent: "nosuk",
        at: "2026-05-18T00:10:00.000Z",
        payload: fixture.antithesis,
      }),
    });
    assert.equal(patchRes.status, 409);
    const body = await patchRes.json();
    assert.equal(body.error.code, "invalid_transition");
    assert.match(body.error.message, /thesis is required/);
  } finally {
    await server.close();
  }
});

test("decision-dialectic route returns 404 when task is not a decision.dialectic", async () => {
  const server = await startTestServer({
    edgeSecret: "test-edge-secret",
    enforceRequesterIdentity: true,
  });
  try {
    await registerTestWorker(server.baseUrl, "bangtong", "live-trader", "test-edge-secret");
    const createRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({
        intent: "analyze",
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "bangtong", kind: "node", role: "live-trader" },
        assignedWorkerId: "bangtong",
        message: "trade BTCUSDT",
        payload: buildTradingDialecticPayload(),
      }),
    });
    assert.equal(createRes.status, 201);
    const task = await createRes.json();

    const readRes = await fetch(`${server.baseUrl}/tasks/${task.id}/decision-dialectic`, {
      headers: {
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      },
    });
    assert.equal(readRes.status, 404);
    const body = await readRes.json();
    assert.equal(body.error.code, "not_found");
    assert.match(body.error.message, /decision\.dialectic/);
  } finally {
    await server.close();
  }
});

test("trading-dialectic read model returns operator stage rail and decision card", async () => {
  const server = await startTestServer({
    edgeSecret: "test-edge-secret",
    enforceRequesterIdentity: true,
  });
  try {
    await registerTestWorker(server.baseUrl, "bangtong", "live-trader", "test-edge-secret");
    const createRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({
        intent: "analyze",
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "bangtong", kind: "node", role: "live-trader" },
        assignedWorkerId: "bangtong",
        message: "trade BTCUSDT",
        payload: buildTradingDialecticPayload(),
      }),
    });
    assert.equal(createRes.status, 201);
    const task = await createRes.json();

    const readRes = await fetch(`${server.baseUrl}/tasks/${task.id}/trading-dialectic`, {
      headers: {
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      },
    });
    assert.equal(readRes.status, 200);
    const body = await readRes.json();

    assert.equal(body.kind, "trading.dialectic");
    assert.equal(body.version, 1);
    assert.equal(body.brokerTaskId, task.id);
    assert.equal(body.contract.taskId, "td-task-01");
    assert.equal(body.contract.revision, 4);
    assert.equal(body.contract.state, "EXECUTION_ROUTED");
    assert.equal(body.contract.phase, "synthesis");
    assert.equal(body.meta.symbol, "BTCUSDT");
    assert.equal(body.roles.synthAgent.agentId, "seoseo");

    const stageNames = ["thesis", "antithesis", "rebuttal", "synthesis", "outcome"];
    for (const stage of stageNames) {
      assert.ok(body.stages[stage], `expected stage ${stage}`);
      assert.equal(body.stages[stage].name, stage);
    }
    assert.equal(body.stages.thesis.present, true);
    assert.equal(body.stages.thesis.author.agentId, "bangtong");
    assert.equal(body.stages.thesis.at, "2026-04-19T09:05:00.000Z");
    assert.equal(body.stages.antithesis.present, true);
    assert.deepEqual(body.stages.antithesis.vetoFlags, []);
    assert.equal(body.stages.synthesis.present, true);
    assert.equal(body.stages.synthesis.verdict, "EXECUTE_PROBE");
    assert.equal(body.stages.outcome.present, false);
    assert.equal(body.stages.outcome.data, undefined);

    assert.equal(body.decisionCard.present, true);
    assert.equal(body.decisionCard.verdict, "EXECUTE_PROBE");
    assert.equal(body.decisionCard.route, "bangtong");
    assert.equal(body.decisionCard.hardVeto, false);
    assert.equal(body.decisionCard.executionPolicyRef, "policy-probe-v1");
    assert.equal(body.decisionCard.decisionBasisRevision, 4);
    assert.equal(body.decisionCard.ttlSec, 600);
    assert.equal(body.decisionCard.decidedBy.agentId, "seoseo");
    assert.equal(body.decisionCard.decidedAt, "2026-04-19T09:20:00.000Z");

    assert.equal(typeof body.summary.headline, "string");
    assert.equal(typeof body.summary.decision, "string");
    assert.match(body.summary.decision, /EXECUTE_PROBE/);
  } finally {
    await server.close();
  }
});

test("trading-dialectic read model omits absent decision card and stages", async () => {
  const server = await startTestServer({
    edgeSecret: "test-edge-secret",
    enforceRequesterIdentity: true,
  });
  try {
    await registerTestWorker(server.baseUrl, "bangtong", "live-trader", "test-edge-secret");
    const createRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({
        intent: "analyze",
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "bangtong", kind: "node", role: "live-trader" },
        assignedWorkerId: "bangtong",
        message: "early stage trade",
        payload: buildTradingDialecticPayload(
          {
            state: "THESIS_SUBMITTED",
            revision: 1,
            antithesis: undefined,
            rebuttal: undefined,
            synthesis: undefined,
            decision: undefined,
            outcome: undefined,
          },
          "thesis",
        ),
      }),
    });
    assert.equal(createRes.status, 201);
    const task = await createRes.json();

    const readRes = await fetch(`${server.baseUrl}/tasks/${task.id}/trading-dialectic`, {
      headers: {
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      },
    });
    assert.equal(readRes.status, 200);
    const body = await readRes.json();

    assert.equal(body.contract.state, "THESIS_SUBMITTED");
    assert.equal(body.contract.phase, "thesis");
    assert.equal(body.stages.thesis.present, true);
    assert.equal(body.stages.antithesis.present, false);
    assert.equal(body.stages.synthesis.present, false);
    assert.equal(body.stages.synthesis.verdict, undefined);
    assert.equal(body.stages.outcome.present, false);
    assert.equal(body.decisionCard.present, false);
    assert.equal(body.decisionCard.verdict, undefined);
    assert.equal(body.decisionCard.route, undefined);
  } finally {
    await server.close();
  }
});

test("trading-dialectic route returns 404 when task is not a trading.dialectic", async () => {
  const server = await startTestServer({
    edgeSecret: "test-edge-secret",
    enforceRequesterIdentity: true,
  });
  try {
    await registerTestWorker(server.baseUrl, "worker-a", "analyst", "test-edge-secret");
    const createRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({
        intent: "analyze",
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        assignedWorkerId: "worker-a",
        message: "non-dialectic task",
      }),
    });
    assert.equal(createRes.status, 201);
    const task = await createRes.json();

    const readRes = await fetch(`${server.baseUrl}/tasks/${task.id}/trading-dialectic`, {
      headers: {
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      },
    });
    assert.equal(readRes.status, 404);
    const body = await readRes.json();
    assert.equal(body.error.code, "not_found");
    assert.match(body.error.message, /trading\.dialectic/);

    const missingRes = await fetch(
      `${server.baseUrl}/tasks/does-not-exist/trading-dialectic`,
      {
        headers: {
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "hub-a",
          "x-a2a-requester-role": "hub",
        },
      },
    );
    assert.equal(missingRes.status, 404);
    const missingBody = await missingRes.json();
    assert.equal(missingBody.error.code, "not_found");
    assert.match(missingBody.error.message, /task not found/);
  } finally {
    await server.close();
  }
});

test("trading-dialectic route rejects unsupported version with 400", async () => {
  const server = await startTestServer({
    edgeSecret: "test-edge-secret",
    enforceRequesterIdentity: true,
  });
  try {
    await registerTestWorker(server.baseUrl, "worker-a", "analyst", "test-edge-secret");
    const createRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({
        intent: "analyze",
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        assignedWorkerId: "worker-a",
        message: "future-version contract",
        payload: {
          contract: {
            kind: TRADING_DIALECTIC_KIND,
            version: 99,
            phase: "thesis",
            task: buildTradingDialecticTaskFixture(),
          },
        },
      }),
    });
    assert.equal(createRes.status, 201);
    const task = await createRes.json();

    const readRes = await fetch(`${server.baseUrl}/tasks/${task.id}/trading-dialectic`, {
      headers: {
        "x-a2a-edge-secret": "test-edge-secret",
        "x-a2a-requester-id": "hub-a",
        "x-a2a-requester-role": "hub",
      },
    });
    assert.equal(readRes.status, 400);
    const body = await readRes.json();
    assert.equal(body.error.code, "bad_request");
    assert.match(body.error.message, /unsupported.*version/);
  } finally {
    await server.close();
  }
});

test("server persists task wake plan and decision through HTTP", async () => {
  const server = await startTestServer();
  try {
    await registerTestWorker(server.baseUrl, "worker-a", "analyst");
    const hubHeaders = jsonHeaders({
      "x-a2a-requester-id": "hub-a",
      "x-a2a-requester-role": "hub",
    });

    const createRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: hubHeaders,
      body: JSON.stringify({
        id: "task-wake-http",
        intent: "chat",
        requester: { id: "hub-a", kind: "node", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        assignedWorkerId: "worker-a",
        message: "wake target",
        payload: { waitRunId: "wait-http", correlationId: "corr-http" },
      }),
    });
    assert.equal(createRes.status, 201);

    const planRes = await fetch(`${server.baseUrl}/tasks/task-wake-http/wake/plan`, {
      method: "POST",
      headers: hubHeaders,
      body: JSON.stringify({
        targetSessionKey: "agent:worker-a",
        targetNodeId: "worker-a",
        waitRunId: "wait-http",
        correlationId: "corr-http",
      }),
    });
    assert.equal(planRes.status, 201);
    const plan = await planRes.json() as Record<string, unknown>;
    assert.equal(plan.shouldDispatch, true);
    assert.equal((plan.wake as Record<string, unknown>).wakeKey, "corr-http:wait-http");

    const decisionRes = await fetch(`${server.baseUrl}/tasks/task-wake-http/wake/decision`, {
      method: "POST",
      headers: hubHeaders,
      body: JSON.stringify({
        status: "skipped",
        code: "wake_disabled",
        message: "default off",
      }),
    });
    assert.equal(decisionRes.status, 200);
    const task = await decisionRes.json() as Record<string, unknown>;
    assert.equal((task.wake as Record<string, unknown>).status, "skipped");
    assert.equal((task.wake as Record<string, unknown>).code, "wake_disabled");

    const replayRes = await fetch(`${server.baseUrl}/tasks/task-wake-http/wake/plan`, {
      method: "POST",
      headers: hubHeaders,
      body: JSON.stringify({
        targetSessionKey: "agent:worker-a",
        targetNodeId: "worker-a",
        waitRunId: "wait-http",
        correlationId: "corr-http",
      }),
    });
    assert.equal(replayRes.status, 200);
    const replay = await replayRes.json() as Record<string, unknown>;
    assert.equal(replay.replayed, true);
    assert.equal(replay.shouldDispatch, false);
  } finally {
    await server.close();
  }
});

test("GET /release/evidence returns read-only dry-run release evidence without mutating tasks", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    server.runtime.broker.registerWorker({
      nodeId: "dungae",
      role: "analyst",
      capabilities: {
        canAnalyze: true,
        canBackfill: false,
        canPatchWorkspace: true,
        canPromoteLive: false,
        workspaceIds: ["repo"],
        environments: ["research"],
      },
    });
    const created = server.runtime.broker.createTask({
      id: "release-evidence-task-1",
      intent: "propose_patch",
      requester: { id: "operator-a", kind: "user", role: "operator" },
      target: { id: "dungae", kind: "node", role: "analyst" },
      payload: {
        mode: "github-propose-patch",
        issue: 479,
        issueUrl: "https://github.com/jinwon-int/a2a-broker/issues/479",
      },
      taskOrigin: "github",
    });
    server.runtime.broker.claimTask(created.id, "dungae");
    server.runtime.broker.startTask(created.id, "dungae");
    server.runtime.broker.completeTask(created.id, "dungae", {
      output: {
        github: {
          repo: "jinwon-int/a2a-broker",
          issue: "#479",
          doneCommentUrl: "https://github.com/jinwon-int/a2a-broker/issues/479#issuecomment-4415413329",
        },
        receipt: { status: "operator_visible", evidence: "operator_visible" },
      },
    });
    const before = server.runtime.broker.getTask(created.id)?.updatedAt;

    const res = await fetch(
      `${server.baseUrl}/release/evidence?task_id=${created.id}&repo=jinwon-int/a2a-broker&issue=479&parentIssue=jinwon-int/a2a-plane%23197&runId=a2a-source-dryrun-orchestrator-20260510T133022Z`,
      {
        headers: {
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        },
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.kind, "broker.release-evidence.export");
    assert.equal(body.mode, "dry-run/read-only");
    assert.equal(body.readOnly, true);
    assert.equal(body.gates.liveActionAllowed, false);
    assert.equal(body.gates.mutationAllowed, false);
    assert.equal(body.gates.ok, true);
    assert.equal(body.taskSummary.total, 1);
    assert.equal(body.evidenceSummary.done, 1);
    assert.deepEqual(body.links.doneComments, [
      "https://github.com/jinwon-int/a2a-broker/issues/479#issuecomment-4415413329",
    ]);
    assert.equal(server.runtime.broker.getTask(created.id)?.updatedAt, before);
  } finally {
    await server.close();
  }
});

test("POST /terminal-brief/closeout/gate returns approval-gated dry-run plan", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const workflow = {
      kind: "a2a-broker.terminal-brief-finalizer-workflow.packet",
      version: 1,
      generatedAt: "2026-05-18T15:00:00.000Z",
      mode: "read-only/no-live",
      parentRoundId: "round-700",
      decision: "ready",
      currentStep: "finalizer_review",
      idempotencyKey: "tb-finalizer-workflow:fixture",
      finalizer: {
        brokerOfRecordId: "seoseo",
        owner: "seoseo",
        required: true,
        singleFinalizerRequired: true,
      },
      source: {
        handoffDecision: "ready",
        handoffIdempotencyKey: "tb-finalizer-handoff:fixture",
        evidenceUrls: 1,
        receiptGaps: 1,
        blockers: 0,
      },
      workflow: {
        closeoutComment: {
          mode: "draft-only",
          title: "Draft: Terminal Brief closeout ready - round-700",
          body: "Draft closeout body. This was not posted automatically.",
          postPermitted: false,
        },
        taskflowSeed: {
          createRecords: false,
          currentStep: "finalizer_review",
          stateJson: { source: "terminal-brief-finalizer-workflow" },
          waitJson: { kind: "broker_finalizer_review" },
        },
      },
      checklist: [],
      reviewItems: ["single broker finalizer must review"],
      blockers: [],
      nextActions: [],
      approvalSensitiveActionsExcluded: [
        "GitHub PR merge, issue close, or comment post",
        "live provider/Hermes/Telegram/OpenClaw send",
        "terminal ACK/replay",
      ],
      semantics: {
        workflowPacketIsNotFinalAction: true,
        commentIsDraftOnly: true,
        taskflowSeedCreatesNoRecords: true,
        brokerFinalizerRequired: true,
        singleFinalizerRequired: true,
        providerOrProducedReceiptIsTerminalAck: false,
        performsGitHubMutation: false,
        performsProviderSend: false,
        performsTerminalAck: false,
        performsRuntimeRestartOrDeploy: false,
        performsDbMutation: false,
      },
    };

    const res = await fetch(
      server.baseUrl + "/terminal-brief/closeout/gate?issueUrl=https://github.com/jinwon-int/a2a-broker/issues/700&prUrl=https://github.com/jinwon-int/a2a-broker/pull/701",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        }),
        body: JSON.stringify({ workflowPacket: workflow }),
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.kind, "a2a-broker.terminal-brief-closeout-gate.packet");
    assert.equal(body.decision, "ready_for_approval");
    assert.equal(body.gateState, "approval_required");
    assert.equal(body.executePermitted, false);
    assert.equal(body.integrationContract.openclawMessageSendRequired, false);
    assert.equal(body.semantics.performsGitHubMutation, false);
    assert.equal(body.actions.every((action: Record<string, unknown>) => action.executePermitted === false), true);
  } finally {
    await server.close();
  }
});

test("POST /terminal-brief/closeout/approval-request returns draft-only approval request", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const gate = {
      kind: "a2a-broker.terminal-brief-closeout-gate.packet",
      version: 1,
      generatedAt: "2026-05-18T16:00:00.000Z",
      mode: "read-only/no-live",
      parentRoundId: "round-702",
      decision: "ready_for_approval",
      gateState: "approval_required",
      dryRunOnly: true,
      executePermitted: false,
      idempotencyKey: "tb-closeout-gate:fixture-702",
      finalizer: {
        brokerOfRecordId: "seoseo",
        owner: "seoseo",
        required: true,
        singleFinalizerRequired: true,
      },
      source: {
        workflowDecision: "ready",
        workflowStep: "finalizer_review",
        workflowIdempotencyKey: "tb-finalizer-workflow:fixture-702",
        targetIssueUrl: "https://github.com/jinwon-int/a2a-broker/issues/702",
        targetPrUrl: "https://github.com/jinwon-int/a2a-broker/pull/703",
        blockers: 0,
        reviewItems: 1,
      },
      draftCloseout: {
        title: "Draft: Terminal Brief closeout ready - round-702",
        body: "Draft closeout body. This was not posted automatically.",
        postPermitted: false,
        targetIssueUrl: "https://github.com/jinwon-int/a2a-broker/issues/702",
        targetPrUrl: "https://github.com/jinwon-int/a2a-broker/pull/703",
      },
      actions: [
        {
          action: "post_closeout_comment",
          status: "proposed",
          requiresApproval: true,
          executePermitted: false,
          target: "https://github.com/jinwon-int/a2a-broker/issues/702",
          reason: "draft closeout comment is ready but posting is a separate approved mutation",
        },
        {
          action: "merge_pull_request",
          status: "proposed",
          requiresApproval: true,
          executePermitted: false,
          target: "https://github.com/jinwon-int/a2a-broker/pull/703",
          reason: "merge is only a proposed follow-up after finalizer approval",
        },
        {
          action: "live_provider_send",
          status: "forbidden",
          requiresApproval: true,
          executePermitted: false,
          reason: "live sends must stay outside the source-only gate",
        },
      ],
      approvalChecklist: [],
      blockers: [],
      nextActions: [],
      integrationContract: {
        transport: "json",
        harnessNeutral: true,
        openclawMessageSendRequired: false,
        hermesAdapterCompatible: true,
      },
      semantics: {
        closeoutGateIsNotFinalAction: true,
        dryRunOnly: true,
        routeIsReadOnly: true,
        brokerFinalizerRequired: true,
        singleFinalizerRequired: true,
        approvalRequiredBeforeGitHubMutation: true,
        approvalRequiredBeforeLiveAction: true,
        providerOrProducedReceiptIsTerminalAck: false,
        performsGitHubMutation: false,
        performsProviderSend: false,
        performsTerminalAck: false,
        performsRuntimeRestartOrDeploy: false,
        performsDbMutation: false,
        createsTaskFlowRecords: false,
        performsReleaseOrPublish: false,
        movesSecretsOrCredentials: false,
      },
    };

    const res = await fetch(
      server.baseUrl + "/terminal-brief/closeout/approval-request",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        }),
        body: JSON.stringify({ gatePacket: gate }),
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.kind, "a2a-broker.terminal-brief-approval-request.packet");
    assert.equal(body.decision, "request_ready");
    assert.equal(body.requestDispatchPermitted, false);
    assert.equal(body.approvalGrantPermitted, false);
    assert.equal(body.executionPermitted, false);
    assert.equal(body.request.sendPermitted, false);
    assert.equal(body.request.presentationPlan.sendPermitted, false);
    assert.equal(body.request.presentationPlan.buttonsEnabled, false);
    assert.equal(body.integrationContract.openclawMessageSendRequired, false);
    assert.equal(body.integrationContract.sendsApprovalRequest, false);
    assert.equal(body.request.requestedActions.every((action: Record<string, unknown>) => action.executePermitted === false), true);
    assert.equal(body.request.nonRequestableActions.find((action: Record<string, unknown>) => action.action === "live_provider_send")?.status, "forbidden");
  } finally {
    await server.close();
  }
});

test("POST /terminal-brief/closeout/approval-executor returns no-live execute-blocked shell", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const approvalRequest = {
      kind: "a2a-broker.terminal-brief-approval-request.packet",
      version: 1,
      generatedAt: "2026-05-18T20:20:00.000Z",
      mode: "read-only/no-live",
      parentRoundId: "round-704",
      decision: "request_ready",
      dryRunOnly: true,
      requestDispatchPermitted: false,
      approvalGrantPermitted: false,
      executionPermitted: false,
      idempotencyKey: "tb-approval-request:fixture-704",
      finalizer: {
        brokerOfRecordId: "seoseo",
        owner: "seoseo",
        required: true,
        singleFinalizerRequired: true,
      },
      source: {
        closeoutGateDecision: "ready_for_approval",
        closeoutGateState: "approval_required",
        closeoutGateIdempotencyKey: "tb-closeout-gate:fixture-704",
        targetIssueUrl: "https://github.com/jinwon-int/a2a-broker/issues/704",
        targetPrUrl: "https://github.com/jinwon-int/a2a-broker/pull/705",
        proposedActions: 2,
        blockedActions: 0,
        forbiddenActions: 1,
      },
      request: {
        mode: "draft-only",
        title: "Draft approval request: Terminal Brief closeout - round-704",
        body: "Draft approval request body. This was not sent automatically.",
        sendPermitted: false,
        requestedActions: [
          {
            action: "post_closeout_comment",
            status: "requested",
            sourceGateStatus: "proposed",
            requiresApproval: true,
            executePermitted: false,
            target: "https://github.com/jinwon-int/a2a-broker/issues/704",
            reason: "draft closeout comment is ready but posting is a separate approved mutation",
          },
          {
            action: "merge_pull_request",
            status: "requested",
            sourceGateStatus: "proposed",
            requiresApproval: true,
            executePermitted: false,
            target: "https://github.com/jinwon-int/a2a-broker/pull/705",
            reason: "merge is only a proposed follow-up after finalizer approval",
          },
        ],
        nonRequestableActions: [
          {
            action: "live_provider_send",
            status: "forbidden",
            requiresApproval: true,
            executePermitted: false,
            reason: "live sends must stay outside the source-only gate",
          },
        ],
        presentationPlan: {
          kind: "approval_buttons",
          sendPermitted: false,
          buttonsEnabled: false,
          buttons: [],
        },
        cliPlan: {
          mode: "plan-only",
          command: "terminal_brief_approval_request --input closeout-gate.json --json",
          executePermitted: false,
          requiredHumanApproval: true,
        },
      },
      blockers: [],
      nextActions: [],
      integrationContract: {
        transport: "json",
        harnessNeutral: true,
        openclawMessageSendRequired: false,
        hermesAdapterCompatible: true,
        sendsApprovalRequest: false,
      },
      semantics: {
        approvalRequestPlannerOnly: true,
        requestNotSent: true,
        approvalNotGranted: true,
        executionNotPermitted: true,
        routeIsReadOnly: true,
        brokerFinalizerRequired: true,
        singleFinalizerRequired: true,
        idempotentRequestDraft: true,
        replayRequiresSameIdempotencyKey: true,
        performsGitHubMutation: false,
        performsProviderSend: false,
        performsTerminalAck: false,
        performsRuntimeRestartOrDeploy: false,
        performsDbMutation: false,
        createsTaskFlowRecords: false,
        performsHistoricalReplay: false,
        performsReleaseOrPublish: false,
        movesSecretsOrCredentials: false,
      },
    };

    const res = await fetch(
      server.baseUrl + "/terminal-brief/closeout/approval-executor",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        }),
        body: JSON.stringify({
          approvalRequest,
          selectedAction: "merge_pull_request",
          attemptExecute: true,
        }),
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.kind, "a2a-broker.terminal-brief-approval-executor.packet");
    assert.equal(body.state, "execute_blocked");
    assert.equal(body.dispatchPermitted, false);
    assert.equal(body.approvalGrantPermitted, false);
    assert.equal(body.executionPermitted, false);
    assert.equal(body.dispatch.requestDispatched, false);
    assert.equal(body.approval.realApprovalGranted, false);
    assert.equal(body.approval.simulatedApprovalOnly, true);
    assert.equal(body.execution.state, "execute_blocked");
    assert.equal(body.execution.executed, false);
    assert.equal(body.integrationContract.openclawMessageSendRequired, false);
    assert.equal(body.integrationContract.sendsApprovalRequest, false);
    assert.equal(body.integrationContract.grantsApproval, false);
    assert.equal(body.integrationContract.executesAction, false);
  } finally {
    await server.close();
  }
});

test("POST /terminal-brief/closeout/approval-dispatch returns no-live adapter transcript", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const approvalExecutor = {
      kind: "a2a-broker.terminal-brief-approval-executor.packet",
      version: 1,
      generatedAt: "2026-05-18T21:00:00.000Z",
      mode: "read-only/no-live",
      parentRoundId: "round-706",
      state: "dispatch_pending",
      dryRunOnly: true,
      dispatchPermitted: false,
      approvalGrantPermitted: false,
      executionPermitted: false,
      idempotencyKey: "tb-approval-executor:fixture-706",
      finalizer: {
        brokerOfRecordId: "seoseo",
        owner: "seoseo",
        required: true,
        singleFinalizerRequired: true,
      },
      source: {
        approvalRequestDecision: "request_ready",
        approvalRequestIdempotencyKey: "tb-approval-request:fixture-706",
        targetIssueUrl: "https://github.com/jinwon-int/a2a-broker/issues/706",
        targetPrUrl: "https://github.com/jinwon-int/a2a-broker/pull/707",
        requestedActions: 2,
        nonRequestableActions: 1,
      },
      dispatch: {
        state: "dispatch_pending",
        transport: "none",
        requestDispatchPermitted: false,
        requestDispatched: false,
        requestSendPermitted: false,
        reason: "dispatch is intentionally held",
      },
      approval: {
        state: "none",
        realApprovalGranted: false,
        simulatedApprovalOnly: false,
        reason: "no approval selection was supplied",
      },
      execution: {
        state: "not_attempted",
        executePermitted: false,
        executed: false,
        reason: "execution was not attempted and remains forbidden",
      },
      blockers: [],
      nextActions: [],
      integrationContract: {
        transport: "json",
        harnessNeutral: true,
        openclawMessageSendRequired: false,
        hermesAdapterCompatible: true,
        sendsApprovalRequest: false,
        grantsApproval: false,
        executesAction: false,
      },
      semantics: {
        approvalExecutorShellOnly: true,
        dispatchNotPerformed: true,
        approvalNotReallyGranted: true,
        simulatedApprovalOnly: false,
        executionNotPermitted: true,
        routeIsReadOnly: true,
        brokerFinalizerRequired: true,
        singleFinalizerRequired: true,
        performsGitHubMutation: false,
        performsProviderSend: false,
        performsTerminalAck: false,
        performsRuntimeRestartOrDeploy: false,
        performsDbMutation: false,
        createsTaskFlowRecords: false,
        performsHistoricalReplay: false,
        performsReleaseOrPublish: false,
        movesSecretsOrCredentials: false,
      },
    };

    const res = await fetch(
      server.baseUrl + "/terminal-brief/closeout/approval-dispatch",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        }),
        body: JSON.stringify({
          approvalExecutor,
          adapter: "gongyung",
          target: "hermes://gongyung/approval",
          channel: "operator",
          requestedBy: "seoseo",
        }),
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.kind, "a2a-broker.terminal-brief-approval-dispatch-adapter.packet");
    assert.equal(body.state, "dispatch_draft_ready");
    assert.equal(body.adapter.type, "gongyung");
    assert.equal(body.adapter.requiresOpenClawMessageSend, false);
    assert.equal(body.dispatchPermitted, false);
    assert.equal(body.providerSendPermitted, false);
    assert.equal(body.approvalGrantPermitted, false);
    assert.equal(body.executionPermitted, false);
    assert.equal(body.transcript.sent, false);
    assert.equal(body.transcript.sendPermitted, false);
    assert.equal(body.receiptDraft.providerAccepted, false);
    assert.equal(body.receiptDraft.currentSessionVisible, false);
    assert.equal(body.receiptDraft.terminalAck, false);
    assert.equal(body.integrationContract.openclawMessageSendRequired, false);
    assert.equal(body.integrationContract.hermesAdapterCompatible, true);
    assert.equal(body.integrationContract.gongyungAdapterCompatible, true);
    assert.equal(body.integrationContract.sendsApprovalRequest, false);
    assert.equal(body.integrationContract.grantsApproval, false);
    assert.equal(body.integrationContract.executesAction, false);
  } finally {
    await server.close();
  }
});

test("POST /terminal-brief/closeout/approval-receipt returns no-live receipt evidence classification", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const approvalDispatch = {
      kind: "a2a-broker.terminal-brief-approval-dispatch-adapter.packet",
      version: 1,
      generatedAt: "2026-05-18T21:30:00.000Z",
      mode: "read-only/no-live",
      parentRoundId: "round-708",
      state: "dispatch_draft_ready",
      dryRunOnly: true,
      dispatchPermitted: false,
      providerSendPermitted: false,
      approvalGrantPermitted: false,
      executionPermitted: false,
      terminalReceiptMutationPermitted: false,
      idempotencyKey: "tb-approval-dispatch:fixture-708",
      finalizer: {
        brokerOfRecordId: "broker-finalizer",
        owner: "broker-finalizer",
        required: true,
        singleFinalizerRequired: true,
      },
      adapter: {
        id: "gongyung",
        type: "gongyung",
        harnessNeutral: true,
        protocol: "json-transcript",
        requiresOpenClawMessageSend: false,
        supportsExternalHarnesses: true,
        liveSendPermitted: false,
      },
      source: {
        executorState: "dispatch_pending",
        executorIdempotencyKey: "tb-approval-executor:fixture-708",
        approvalRequestIdempotencyKey: "tb-approval-request:fixture-708",
        targetIssueUrl: "https://github.com/jinwon-int/a2a-broker/issues/708",
        targetPrUrl: "https://github.com/jinwon-int/a2a-broker/pull/710",
        selectedAction: "post_closeout_comment",
        selectedTarget: "https://github.com/jinwon-int/a2a-broker/issues/708",
        requestedActions: 2,
        nonRequestableActions: 1,
      },
      transcript: {
        mode: "draft-only",
        target: "hermes://gongyung/approval",
        channel: "operator",
        requestedBy: "broker-finalizer",
        title: "Draft approval dispatch: Terminal Brief closeout - round-708",
        body: "Terminal Brief approval adapter transcript (dry-run).",
        sendPermitted: false,
        sent: false,
      },
      receiptDraft: {
        mode: "draft-only",
        id: "tb-approval-dispatch-receipt:fixture-708",
        providerAccepted: false,
        currentSessionVisible: false,
        terminalAck: false,
        approvalGranted: false,
        actionExecuted: false,
        reason: "dispatch transcript draft only for gongyung; no provider send exists",
      },
      blockers: [],
      nextActions: [],
      integrationContract: {
        transport: "json",
        adapterInterfaceVersion: 1,
        harnessNeutral: true,
        openclawMessageSendRequired: false,
        hermesAdapterCompatible: true,
        gongyungAdapterCompatible: true,
        sendsApprovalRequest: false,
        producesLiveReceipt: false,
        grantsApproval: false,
        executesAction: false,
      },
      semantics: {
        adapterShellOnly: true,
        transcriptDraftOnly: true,
        dispatchNotPerformed: true,
        receiptIsDraftOnly: true,
        providerAcceptedIsVisibilityProof: false,
        approvalNotReallyGranted: true,
        executionNotPermitted: true,
        routeIsReadOnly: true,
        brokerFinalizerRequired: true,
        singleFinalizerRequired: true,
        performsGitHubMutation: false,
        performsProviderSend: false,
        performsTerminalAck: false,
        performsRuntimeRestartOrDeploy: false,
        performsDbMutation: false,
        createsTaskFlowRecords: false,
        performsHistoricalReplay: false,
        performsReleaseOrPublish: false,
        movesSecretsOrCredentials: false,
      },
    };

    const res = await fetch(
      server.baseUrl + "/terminal-brief/closeout/approval-receipt",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        }),
        body: JSON.stringify({
          approvalDispatch,
          receiptEvidence: [
            {
              kind: "current_session_visible",
              observedAt: new Date().toISOString(),
              receiptId: "receipt-visible-route",
              currentSessionId: "session-current",
            },
          ],
          maxAgeMs: 300000,
        }),
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.kind, "a2a-broker.terminal-brief-approval-receipt-ingestor.packet");
    assert.equal(body.state, "accepted");
    assert.equal(body.receiptEvidenceAccepted, true);
    assert.equal(body.classification.currentSessionVisible, true);
    assert.equal(body.classification.providerAcceptedIsVisibilityProof, false);
    assert.equal(body.classification.terminalAckEligible, true);
    assert.equal(body.terminalAckPermitted, false);
    assert.equal(body.terminalReceiptMutationPermitted, false);
    assert.equal(body.approvalGrantPermitted, false);
    assert.equal(body.executionPermitted, false);
    assert.equal(body.integrationContract.providerAcceptedIsVisibilityProof, false);
    assert.equal(body.integrationContract.grantsApproval, false);
    assert.equal(body.integrationContract.executesAction, false);
  } finally {
    await server.close();
  }
});

test("POST /terminal-brief/closeout/finalizer-approval-status returns no-live finalizer status table", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const approvalDispatch = {
      kind: "a2a-broker.terminal-brief-approval-dispatch-adapter.packet",
      version: 1,
      generatedAt: "2026-05-18T22:30:00.000Z",
      mode: "read-only/no-live",
      parentRoundId: "round-709",
      state: "dispatch_draft_ready",
      idempotencyKey: "tb-approval-dispatch:fixture-709",
      finalizer: {
        brokerOfRecordId: "broker-finalizer",
        owner: "broker-finalizer",
        required: true,
        singleFinalizerRequired: true,
      },
      adapter: {
        id: "gongyung",
        type: "gongyung",
      },
      source: {
        targetIssueUrl: "https://github.com/jinwon-int/a2a-broker/issues/709",
        targetPrUrl: "https://github.com/jinwon-int/a2a-broker/pull/711",
        selectedAction: "post_closeout_comment",
        selectedTarget: "https://github.com/jinwon-int/a2a-broker/issues/709",
        requestedActions: 2,
        nonRequestableActions: 1,
      },
      transcript: {
        target: "hermes://gongyung/approval",
        channel: "operator",
      },
      blockers: [],
    };
    const approvalReceipt = {
      kind: "a2a-broker.terminal-brief-approval-receipt-ingestor.packet",
      version: 1,
      generatedAt: "2026-05-18T22:30:00.000Z",
      mode: "read-only/no-live",
      parentRoundId: "round-709",
      state: "accepted",
      idempotencyKey: "tb-approval-receipt:fixture-709",
      receiptEvidenceAccepted: true,
      classification: {
        providerAccepted: false,
        currentSessionVisible: true,
        manualOperatorConfirmed: false,
        approvalGrantAccepted: true,
        terminalAckEligible: true,
      },
      blockers: [],
    };

    const res = await fetch(
      server.baseUrl + "/terminal-brief/closeout/finalizer-approval-status",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        }),
        body: JSON.stringify({
          approvalDispatch,
          approvalReceipt,
        }),
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.kind, "a2a-broker.terminal-brief-finalizer-approval-status.packet");
    assert.equal(body.state, "ready_for_finalizer_review");
    assert.equal(body.table.requiredRowsReady, 3);
    assert.equal(body.approval.currentSessionVisible, true);
    assert.equal(body.approval.approvalGrantAccepted, true);
    assert.equal(body.approval.terminalAckPermitted, false);
    assert.equal(body.approval.approvalGrantPermitted, false);
    assert.equal(body.approval.executionPermitted, false);
    assert.equal(body.defaultOnReadiness.sourceCriteriaMet, true);
    assert.equal(body.defaultOnReadiness.defaultOnPermitted, false);
    assert.equal(body.integrationContract.grantsApproval, false);
    assert.equal(body.integrationContract.executesAction, false);
  } finally {
    await server.close();
  }
});

test("POST /terminal-brief/sidecar/dry-run-gate returns no-live sidecar operating gate", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const sidecarRehearsal = {
      kind: "a2a-broker.terminal-brief-sidecar-integration-rehearsal",
      version: 1,
      generatedAt: "2026-05-18T23:30:00.000Z",
      mode: "read-only/no-live",
      parentRoundId: "round-712",
      decision: "candidate",
      sidecar: {
        spoolRecords: 3,
        finalCountSignalsFromSpool: 3,
        receiptDecisions: 1,
        terminalReceiptStatuses: ["produced"],
        providerSendAttempted: false,
        terminalAckAttempted: false,
        dryRunOnly: true,
        unsafeSpoolRecords: [],
      },
      finalCountCandidate: {
        decision: "candidate",
        idempotencyKey: "tb-final-count:fixture-712",
      },
      blockers: [],
    };
    const finalizerApprovalStatus = {
      kind: "a2a-broker.terminal-brief-finalizer-approval-status.packet",
      version: 1,
      generatedAt: "2026-05-18T23:30:00.000Z",
      mode: "read-only/no-live",
      parentRoundId: "round-712",
      state: "ready_for_finalizer_review",
      idempotencyKey: "tb-finalizer-approval-status:fixture-712",
      defaultOnReadiness: {
        sourceCriteriaMet: true,
        defaultOnPermitted: false,
        missingEvidence: [],
      },
      blockers: [],
    };

    const res = await fetch(
      server.baseUrl + "/terminal-brief/sidecar/dry-run-gate",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        }),
        body: JSON.stringify({
          sidecarRehearsal,
          finalizerApprovalStatus,
          operatingEvidence: {
            observedAt: new Date().toISOString(),
            cursorPersisted: true,
            boundedPolling: true,
            pollIntervalMs: 15000,
            maxBatch: 20,
            gatewayReady: true,
            eventLoopDegraded: false,
            queueBacklog: 0,
            dryRunOnly: true,
            operatorEventsCrossBrokersEnabled: false,
            supervisedSidecar: true,
          },
        }),
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.kind, "a2a-broker.terminal-brief-sidecar-dry-run-gate.packet");
    assert.equal(body.state, "ready_for_operator_approval");
    assert.equal(body.table.requiredRowsReady, 5);
    assert.equal(body.readiness.sourceCriteriaMet, true);
    assert.equal(body.readiness.alwaysOnDryRunCandidate, true);
    assert.equal(body.readiness.alwaysOnDryRunStartPermitted, false);
    assert.equal(body.readiness.defaultOnPermitted, false);
    assert.equal(body.readiness.liveActivationPermitted, false);
    assert.equal(body.integrationContract.startsSidecar, false);
    assert.equal(body.integrationContract.enablesDefaultOn, false);
    assert.equal(body.semantics.performsRuntimeRestartOrDeploy, false);
  } finally {
    await server.close();
  }
});

test("POST /terminal-brief/sidecar/activation-approval returns no-live approval request draft", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const sidecarDryRunGate = {
      kind: "a2a-broker.terminal-brief-sidecar-dry-run-gate.packet",
      version: 1,
      generatedAt: "2026-05-18T14:00:00.000Z",
      mode: "read-only/no-live",
      parentRoundId: "round-714",
      state: "ready_for_operator_approval",
      dryRunOnly: true,
      sourceOnlyNoLive: true,
      idempotencyKey: "tb-sidecar-dry-run-gate:fixture-714",
      source: {
        sidecarDecision: "candidate",
        sidecarSpoolRecords: 3,
        sidecarReceiptDecisions: 1,
        sidecarDryRunOnly: true,
        providerSendAttempted: false,
        terminalAckAttempted: false,
        finalCountDecision: "candidate",
        finalizerStatus: "ready_for_finalizer_review",
        finalizerStatusIdempotencyKey: "tb-finalizer-approval-status:fixture-714",
      },
      operatingEvidence: {
        observedAt: "2026-05-18T14:00:00.000Z",
        stale: false,
        cursorPersisted: true,
        boundedPolling: true,
        pollIntervalMs: 15000,
        maxBatch: 20,
        gatewayReady: true,
        eventLoopDegraded: false,
        queueBacklog: 0,
        dryRunOnly: true,
        operatorEventsCrossBrokersEnabled: false,
        supervisedSidecar: true,
      },
      table: {
        rows: [],
        requiredRowsReady: 5,
        requiredRows: 5,
        readyRows: 5,
        totalRows: 6,
      },
      readiness: {
        sourceCriteriaMet: true,
        alwaysOnDryRunCandidate: true,
        alwaysOnDryRunStartPermitted: false,
        defaultOnPermitted: false,
        liveActivationPermitted: false,
        missingEvidence: [],
        blockers: [],
        nextAction: "request explicit operator approval for dry-run sidecar supervision/canary",
      },
      blockers: [],
      nextActions: [],
      approvalSensitiveActionsExcluded: [],
      integrationContract: {
        transport: "json",
        gateVersion: 1,
        harnessNeutral: true,
        openclawMessageSendRequired: false,
        hermesAdapterCompatible: true,
        gongyungAdapterCompatible: true,
        consumesSidecarIntegrationRehearsal: true,
        consumesFinalizerApprovalStatus: true,
        grantsApproval: false,
        startsSidecar: false,
        enablesDefaultOn: false,
        executesAction: false,
      },
      semantics: {
        operatingGateOnly: true,
        sourceOnlyNoLive: true,
        gateDoesNotMutateState: true,
        sidecarDryRunCandidateDoesNotStartSidecar: true,
        providerAcceptedIsVisibilityProof: false,
        terminalAckEligibleDoesNotPermitAck: true,
        approvalGrantEvidenceDoesNotGrantApproval: true,
        defaultOnNotEnabledByThisPacket: true,
        executionNotPermitted: true,
        routeIsReadOnly: true,
        brokerFinalizerRequired: true,
        performsGitHubMutation: false,
        performsProviderSend: false,
        performsTerminalAck: false,
        performsRuntimeRestartOrDeploy: false,
        performsDbMutation: false,
        createsTaskFlowRecords: false,
        performsHistoricalReplay: false,
        performsReleaseOrPublish: false,
        movesSecretsOrCredentials: false,
      },
    };

    const res = await fetch(
      server.baseUrl + "/terminal-brief/sidecar/activation-approval",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        }),
        body: JSON.stringify({
          sidecarDryRunGate,
          activationApproval: {
            requestedBy: "broker-finalizer",
            operatorTarget: "operator-a",
            approvalWindowMinutes: 30,
          },
        }),
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.kind, "a2a-broker.terminal-brief-sidecar-activation-approval.packet");
    assert.equal(body.state, "approval_request_draft_ready");
    assert.equal(body.requestDraft.status, "draft_not_sent");
    assert.equal(body.requestDraft.dispatchPermitted, false);
    assert.equal(body.readiness.sidecarStartPermitted, false);
    assert.equal(body.readiness.defaultOnPermitted, false);
    assert.equal(body.readiness.providerSendPermitted, false);
    assert.equal(body.readiness.terminalAckPermitted, false);
    assert.equal(body.integrationContract.sendsApprovalRequest, false);
    assert.equal(body.integrationContract.startsSidecar, false);
    assert.equal(body.semantics.requestDraftIsNotSend, true);
  } finally {
    await server.close();
  }
});

test("POST /terminal-brief/sidecar/activation-receipt returns no-live activation receipt evidence", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const sidecarActivationApproval = {
      kind: "a2a-broker.terminal-brief-sidecar-activation-approval.packet",
      version: 1,
      generatedAt: "2026-05-18T15:00:00.000Z",
      mode: "read-only/no-live",
      parentRoundId: "round-716",
      state: "approval_request_draft_ready",
      dryRunOnly: true,
      sourceOnlyNoLive: true,
      idempotencyKey: "tb-sidecar-activation-approval:fixture-716",
      source: {
        gateState: "ready_for_operator_approval",
        gateIdempotencyKey: "tb-sidecar-dry-run-gate:fixture-716",
        sourceCriteriaMet: true,
        alwaysOnDryRunCandidate: true,
        requiredRowsReady: 5,
        requiredRows: 5,
        sidecarDecision: "candidate",
        finalizerStatus: "ready_for_finalizer_review",
      },
      requestDraft: {
        status: "draft_not_sent",
        requestedAction: "approve_supervised_terminal_brief_sidecar_dry_run_start",
        requestedBy: "broker-finalizer",
        operatorTarget: "operator-a",
        approvalExpiresAt: "2026-05-18T15:30:00.000Z",
        dispatchRequired: true,
        dispatchPermitted: false,
        transcriptDraft: "Request: approve supervised Terminal Brief sidecar dry-run start.",
      },
      activationPlan: {
        supervisedDryRunOnly: true,
        cursorPersisted: true,
        boundedPolling: true,
        pollIntervalMs: 15000,
        maxBatch: 20,
        gatewayReady: true,
        eventLoopDegraded: false,
        queueBacklog: 0,
        abortQueueBacklog: 1000,
        abortConditions: [],
        rollbackInstructions: [],
      },
      readiness: {
        approvalRequestDraftReady: true,
        sidecarStartPermitted: false,
        defaultOnPermitted: false,
        liveActivationPermitted: false,
        approvalGrantPermitted: false,
        providerSendPermitted: false,
        terminalAckPermitted: false,
        executionPermitted: false,
        missingEvidence: [],
        blockers: [],
        nextAction: "dispatch this draft through the selected harness adapter and ingest explicit operator approval evidence before any sidecar start",
      },
      blockers: [],
      nextActions: [],
      approvalSensitiveActionsExcluded: [],
      integrationContract: {
        transport: "json",
        approvalPacketVersion: 1,
        harnessNeutral: true,
        openclawMessageSendRequired: false,
        hermesAdapterCompatible: true,
        gongyungAdapterCompatible: true,
        consumesSidecarDryRunGate: true,
        producesApprovalRequestDraft: true,
        sendsApprovalRequest: false,
        grantsApproval: false,
        startsSidecar: false,
        enablesDefaultOn: false,
        executesAction: false,
      },
      semantics: {
        approvalRequestDraftOnly: true,
        sourceOnlyNoLive: true,
        requestDraftIsNotSend: true,
        approvalRequestIsNotApprovalGrant: true,
        sidecarStartRequiresSeparateApprovedExecutor: true,
        defaultOnNotEnabledByThisPacket: true,
        providerAcceptedIsVisibilityProof: false,
        terminalAckEligibleDoesNotPermitAck: true,
        routeIsReadOnly: true,
        brokerFinalizerRequired: true,
        performsGitHubMutation: false,
        performsProviderSend: false,
        performsTerminalAck: false,
        performsRuntimeRestartOrDeploy: false,
        performsDbMutation: false,
        createsTaskFlowRecords: false,
        performsHistoricalReplay: false,
        performsReleaseOrPublish: false,
        movesSecretsOrCredentials: false,
      },
    };

    const res = await fetch(
      server.baseUrl + "/terminal-brief/sidecar/activation-receipt",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        }),
        body: JSON.stringify({
          sidecarActivationApproval,
          activationReceiptEvidence: [
            { kind: "current_session_visible", observedAt: new Date().toISOString() },
            {
              kind: "approval_grant",
              observedAt: new Date().toISOString(),
              approvedAction: "approve_supervised_terminal_brief_sidecar_dry_run_start",
              approvedTarget: "round-716",
              operatorId: "operator-a",
            },
          ],
        }),
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.kind, "a2a-broker.terminal-brief-sidecar-activation-receipt-ingestor.packet");
    assert.equal(body.state, "accepted");
    assert.equal(body.receiptEvidenceAccepted, true);
    assert.equal(body.approvalEvidenceAccepted, true);
    assert.equal(body.classification.providerAcceptedIsVisibilityProof, false);
    assert.equal(body.readiness.sidecarStartPermitted, false);
    assert.equal(body.readiness.defaultOnPermitted, false);
    assert.equal(body.readiness.approvalGrantPermitted, false);
    assert.equal(body.readiness.providerSendPermitted, false);
    assert.equal(body.readiness.terminalAckPermitted, false);
    assert.equal(body.integrationContract.grantsApproval, false);
    assert.equal(body.integrationContract.startsSidecar, false);
    assert.equal(body.semantics.receiptIngestorOnly, true);
  } finally {
    await server.close();
  }
});

test("POST /terminal-brief/sidecar/start-executor-gate returns no-live start executor gate", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const sidecarActivationReceipt = {
      kind: "a2a-broker.terminal-brief-sidecar-activation-receipt-ingestor.packet",
      version: 1,
      generatedAt: "2026-05-18T16:00:00.000Z",
      mode: "read-only/no-live",
      parentRoundId: "round-718",
      state: "accepted",
      dryRunOnly: true,
      sourceOnlyNoLive: true,
      receiptEvidenceAccepted: true,
      approvalEvidenceAccepted: true,
      idempotencyKey: "tb-sidecar-activation-receipt:fixture-718",
      source: {
        activationApprovalState: "approval_request_draft_ready",
        activationApprovalIdempotencyKey: "tb-sidecar-activation-approval:fixture-718",
        requestedAction: "approve_supervised_terminal_brief_sidecar_dry_run_start",
        requestedBy: "broker-finalizer",
        operatorTarget: "operator-a",
        dispatchRequired: true,
        dispatchPermitted: false,
      },
      evidence: {
        received: 3,
        acceptedKinds: ["current_session_visible", "approval_grant"],
        staleKinds: [],
        conflictingKinds: [],
        rejectedKinds: [],
        records: [],
      },
      classification: {
        providerAccepted: true,
        currentSessionVisible: true,
        manualOperatorConfirmed: false,
        approvalGrantAccepted: true,
        receiptProofAccepted: true,
        rejected: false,
        expired: false,
        stale: false,
        terminalAckEligible: true,
        providerAcceptedIsVisibilityProof: false,
        reason: "visibility/manual receipt evidence and matching approval grant evidence accepted as no-live evidence only",
      },
      readiness: {
        sourceCriteriaMet: true,
        approvalEvidenceAccepted: true,
        sidecarStartPermitted: false,
        defaultOnPermitted: false,
        liveActivationPermitted: false,
        approvalGrantPermitted: false,
        providerSendPermitted: false,
        terminalAckPermitted: false,
        executionPermitted: false,
        blockers: [],
        nextAction: "feed accepted no-live approval evidence into the supervised dry-run start executor gate",
      },
      blockers: [],
      nextActions: [],
      approvalSensitiveActionsExcluded: [],
      integrationContract: {
        transport: "json",
        evidenceSchemaVersion: 1,
        harnessNeutral: true,
        openclawMessageSendRequired: false,
        hermesAdapterCompatible: true,
        gongyungAdapterCompatible: true,
        consumesActivationApprovalPacket: true,
        providerAcceptedIsVisibilityProof: false,
        terminalAckRequiresVisibilityProof: true,
        grantsApproval: false,
        startsSidecar: false,
        enablesDefaultOn: false,
        executesAction: false,
      },
      semantics: {
        receiptIngestorOnly: true,
        sourceOnlyNoLive: true,
        evidenceDoesNotMutateState: true,
        providerAcceptedIsVisibilityProof: false,
        terminalAckEligibleDoesNotPermitAck: true,
        approvalGrantEvidenceDoesNotGrantApproval: true,
        sidecarStartRequiresSeparateApprovedExecutor: true,
        defaultOnNotEnabledByThisPacket: true,
        executionNotPermitted: true,
        routeIsReadOnly: true,
        brokerFinalizerRequired: true,
        performsGitHubMutation: false,
        performsProviderSend: false,
        performsTerminalAck: false,
        performsRuntimeRestartOrDeploy: false,
        performsDbMutation: false,
        createsTaskFlowRecords: false,
        performsHistoricalReplay: false,
        performsReleaseOrPublish: false,
        movesSecretsOrCredentials: false,
      },
    };

    const res = await fetch(
      server.baseUrl + "/terminal-brief/sidecar/start-executor-gate",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        }),
        body: JSON.stringify({
          sidecarActivationReceipt,
          startExecutorGate: {
            requestedExecutor: "dry-run-executor",
            commandName: "terminal-brief-sidecar",
            commandArgs: ["--dry-run"],
            envKeys: ["EDGE_SECRET"],
          },
        }),
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.kind, "a2a-broker.terminal-brief-sidecar-start-executor-gate.packet");
    assert.equal(body.state, "ready_for_start_executor_review");
    assert.equal(body.readiness.startExecutorDispatchPermitted, false);
    assert.equal(body.readiness.sidecarStartPermitted, false);
    assert.equal(body.readiness.defaultOnPermitted, false);
    assert.equal(body.readiness.providerSendPermitted, false);
    assert.equal(body.readiness.terminalAckPermitted, false);
    assert.equal(body.readiness.executionPermitted, false);
    assert.equal(body.startPlan.commandShape.commandExecutionPermitted, false);
    assert.equal(body.startPlan.commandShape.secretsIncluded, false);
    assert.equal(body.integrationContract.dispatchesStartExecutor, false);
    assert.equal(body.integrationContract.startsSidecar, false);
    assert.equal(body.semantics.commandShapeIsMetadataOnly, true);
  } finally {
    await server.close();
  }
});

test("POST /terminal-brief/sidecar/executor-invocation-rehearsal returns no-live invocation rehearsal", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const startExecutorGate = {
      kind: "a2a-broker.terminal-brief-sidecar-start-executor-gate.packet",
      version: 1,
      generatedAt: "2026-05-18T18:00:00.000Z",
      mode: "read-only/no-live",
      parentRoundId: "round-720",
      state: "ready_for_start_executor_review",
      dryRunOnly: true,
      sourceOnlyNoLive: true,
      idempotencyKey: "tb-sidecar-start-executor-gate:fixture-720",
      source: {
        receiptState: "accepted",
        receiptIdempotencyKey: "tb-sidecar-activation-receipt:fixture-720",
        receiptEvidenceAccepted: true,
        approvalEvidenceAccepted: true,
        terminalAckEligible: true,
        requestedAction: "approve_supervised_terminal_brief_sidecar_dry_run_start",
        operatorTarget: "operator-a",
      },
      startPlan: {
        supervisedDryRunOnly: true,
        requestedExecutor: "gongyung-sidecar-dry-run-executor",
        operatorApprovalReference: "operator-visible-approval-720",
        dryRunReason: "sidecar-gongyung-spool-dry-run",
        commandShape: {
          kind: "metadata_only",
          commandName: "terminal-brief-sidecar",
          commandArgs: ["--dry-run", "--poll-ms", "15000"],
          envKeys: ["EDGE_SECRET"],
          commandExecutionPermitted: false,
          secretsIncluded: false,
        },
        abortConditions: ["Gateway readiness is false"],
        rollbackInstructions: ["do not start the sidecar from this gate packet"],
      },
      readiness: {
        sourceCriteriaMet: true,
        startExecutorReviewReady: true,
        startExecutorDispatchPermitted: false,
        sidecarStartPermitted: false,
        defaultOnPermitted: false,
        liveActivationPermitted: false,
        approvalGrantPermitted: false,
        providerSendPermitted: false,
        terminalAckPermitted: false,
        executionPermitted: false,
        missingEvidence: [],
        blockers: [],
        nextAction: "request explicit operator approval for a separate supervised dry-run start executor invocation",
      },
      blockers: [],
      nextActions: [],
      approvalSensitiveActionsExcluded: [],
      integrationContract: {
        transport: "json",
        gateVersion: 1,
        harnessNeutral: true,
        openclawMessageSendRequired: false,
        hermesAdapterCompatible: true,
        gongyungAdapterCompatible: true,
        consumesActivationReceiptIngestorPacket: true,
        dispatchesStartExecutor: false,
        grantsApproval: false,
        startsSidecar: false,
        enablesDefaultOn: false,
        executesAction: false,
      },
      semantics: {
        startExecutorGateOnly: true,
        sourceOnlyNoLive: true,
        gateDoesNotMutateState: true,
        commandShapeIsMetadataOnly: true,
        providerAcceptedIsVisibilityProof: false,
        terminalAckEligibleDoesNotPermitAck: true,
        approvalGrantEvidenceDoesNotGrantApproval: true,
        sidecarStartRequiresSeparateApprovedExecutor: true,
        defaultOnNotEnabledByThisPacket: true,
        executionNotPermitted: true,
        routeIsReadOnly: true,
        brokerFinalizerRequired: true,
        performsGitHubMutation: false,
        performsProviderSend: false,
        performsTerminalAck: false,
        performsRuntimeRestartOrDeploy: false,
        performsDbMutation: false,
        createsTaskFlowRecords: false,
        performsHistoricalReplay: false,
        performsReleaseOrPublish: false,
        movesSecretsOrCredentials: false,
      },
    };

    const res = await fetch(
      server.baseUrl + "/terminal-brief/sidecar/executor-invocation-rehearsal",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        }),
        body: JSON.stringify({
          startExecutorGate,
          executorInvocationRehearsal: {
            adapterName: "gongyung",
            executorRuntime: "metadata-only",
            supervisor: "terminal-brief-sidecar-worker",
          },
        }),
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.kind, "a2a-broker.terminal-brief-sidecar-executor-invocation-rehearsal.packet");
    assert.equal(body.state, "ready_for_executor_invocation_rehearsal");
    assert.equal(body.readiness.startExecutorDispatchPermitted, false);
    assert.equal(body.readiness.executorInvocationPermitted, false);
    assert.equal(body.readiness.processSpawnPermitted, false);
    assert.equal(body.readiness.sidecarStartPermitted, false);
    assert.equal(body.readiness.defaultOnPermitted, false);
    assert.equal(body.readiness.providerSendPermitted, false);
    assert.equal(body.readiness.terminalAckPermitted, false);
    assert.equal(body.readiness.executionPermitted, false);
    assert.equal(body.invocationPlan.commandShape.commandExecutionPermitted, false);
    assert.equal(body.invocationPlan.commandShape.processSpawnPermitted, false);
    assert.equal(body.invocationPlan.commandShape.secretsIncluded, false);
    assert.equal(body.integrationContract.invokesExecutor, false);
    assert.equal(body.integrationContract.spawnsProcess, false);
    assert.equal(body.integrationContract.startsSidecar, false);
    assert.equal(body.semantics.executorInvocationRehearsalOnly, true);
  } finally {
    await server.close();
  }
});
