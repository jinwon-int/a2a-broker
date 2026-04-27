import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBrokerServer, type BrokerServerOptions } from "./server.js";
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
    assert.equal(health.persistence.stateVersion, 7);
    assert.equal(health.persistence.schemaVersion, 3);
    assert.equal(health.persistence.journalMode, "wal");
    assert.deepEqual(health.persistence.hotEntityTables, [
      "broker_tasks",
      "broker_workers",
      "broker_audit_events",
    ]);
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
      `http://127.0.0.1:${address.port}/tasks?status=queued&assignedWorkerId=worker-a&targetNodeId=worker-a&intent=chat&taskOrigin=api`,
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

test("SSE /a2a/operator/events replays missed alert opened and resolved events with Last-Event-ID", async () => {
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
      (events) =>
        events.some((event) => event.event === "operator-alert-opened") &&
        events.some((event) => event.event === "operator-alert-resolved") &&
        events.some((event) => event.event === "operator-snapshot"),
    );
    replayController.abort();

    const opened = replayEvents.find((event) => event.event === "operator-alert-opened");
    assert.ok(opened, "expected replayed operator-alert-opened event");
    assert.equal(JSON.parse(opened!.data).alert.kind, "worker.heartbeat_missed");

    const resolved = replayEvents.find((event) => event.event === "operator-alert-resolved");
    assert.ok(resolved, "expected replayed operator-alert-resolved event");
    assert.equal(JSON.parse(resolved!.data).alert.workerId, "worker-a");

    const replaySnapshot = JSON.parse(replayEvents.find((event) => event.event === "operator-snapshot")!.data);
    assert.equal(
      replaySnapshot.alerts.alerts.some((alert: { kind: string }) => alert.kind === "worker.heartbeat_missed"),
      false,
    );
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
