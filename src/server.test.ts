import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

import { createBrokerServer, type BrokerServerOptions } from "./server.js";
import { emptySnapshot, type BrokerStateStore } from "./core/store.js";

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
    close: async () => {
      runtime.server.close();
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
    assert.equal(card.capabilities.streaming, false);
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

    // Empty state defaults
    assert.equal(dashboard.queue.total, 0);
    assert.equal(dashboard.history.totalCompleted, 0);
    assert.equal(dashboard.workers.total, 0);
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
