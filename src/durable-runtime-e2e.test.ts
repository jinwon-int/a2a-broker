/**
 * Durable Runtime — HTTP E2E Integration Tests
 *
 * Exercises durable execution payloads through the HTTP API layer.
 * Validates that idempotency keys, lease deadlines, progress, retry metadata,
 * and cancel fan-out all work correctly when routed through the server.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

import { createBrokerServer, type BrokerServerOptions } from "./server.js";
import { emptySnapshot, type BrokerStateStore } from "./core/store.js";
import type { TaskProgress } from "./core/durable-runtime.fixture.js";
import {
  createProgressFixture,
  idempotencyKey,
  leaseDeadlineFromNow,
  retryDelayMs,
  type RetryPolicy,
  DEFAULT_RETRY_POLICY,
  DEFAULT_LEASE_CONFIG,
} from "./core/durable-runtime.fixture.js";

// ---------------------------------------------------------------------------
// Helpers (duplicated from server.test.ts to keep this file self-contained)
// ---------------------------------------------------------------------------

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
    staleReaperEnabled: false,
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

async function registerWorker(baseUrl: string, nodeId: string, role = "analyst") {
  const res = await fetch(`${baseUrl}/workers/register`, {
    method: "POST",
    headers: jsonHeaders({
      "x-a2a-requester-id": nodeId,
      "x-a2a-requester-role": role,
    }),
    body: JSON.stringify({
      nodeId,
      role,
      capabilities: {
        canAnalyze: true,
        canBackfill: true,
        canPatchWorkspace: true,
        canPromoteLive: false,
        workspaceIds: ["ws-default"],
        environments: ["research", "staging"],
      },
    }),
  });
  return res;
}

async function createTask(
  baseUrl: string,
  requesterId: string,
  targetId: string,
  overrides: Record<string, unknown> = {},
) {
  const res = await fetch(`${baseUrl}/tasks`, {
    method: "POST",
    headers: jsonHeaders({
      "x-a2a-requester-id": requesterId,
      "x-a2a-requester-role": "hub",
    }),
    body: JSON.stringify({
      intent: "analyze",
      requester: { id: requesterId, kind: "node", role: "hub" },
      target: { id: targetId, kind: "node", role: "analyst" },
      assignedWorkerId: targetId,
      message: "durable test task",
      ...overrides,
    }),
  });
  return { res, body: await res.json() };
}

// ---------------------------------------------------------------------------
// 1. Idempotency via HTTP
// ---------------------------------------------------------------------------

test("HTTP: create task with idempotency key in payload returns 200", async () => {
  const server = await startTestServer();
  try {
    await registerWorker(server.baseUrl, "worker-a");

    const key = idempotencyKey("http-idem", "session-1", "step-1");
    const { res, body } = await createTask(
      server.baseUrl, "hub-1", "worker-a",
      {
        payload: { idempotencyKey: key },
      },
    );

    assert.ok(res.status === 200 || res.status === 201, `expected 200 or 201, got ${res.status}`);
    assert.ok(body.id);
    assert.equal(body.payload.idempotencyKey, key);
  } finally {
    await server.close();
  }
});

test("HTTP: idempotency key round-trips through GET /tasks/:id", async () => {
  const server = await startTestServer();
  try {
    await registerWorker(server.baseUrl, "worker-a");

    const key = idempotencyKey("http-rt", "ex-42");
    const { body: created } = await createTask(
      server.baseUrl, "hub-1", "worker-a",
      { payload: { idempotencyKey: key, source: "test" } },
    );

    const fetchRes = await fetch(`${server.baseUrl}/tasks/${created.id}`, {
      headers: {
        "x-a2a-requester-id": "hub-1",
        "x-a2a-requester-role": "hub",
      },
    });
    const fetched = await fetchRes.json();

    assert.equal(fetched.payload.idempotencyKey, key);
    assert.equal(fetched.payload.source, "test");
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// 2. Lease deadline via HTTP
// ---------------------------------------------------------------------------

test("HTTP: task created with lease deadline preserves it through claim and start", async () => {
  const server = await startTestServer();
  try {
    await registerWorker(server.baseUrl, "worker-a");

    const deadline = leaseDeadlineFromNow(DEFAULT_LEASE_CONFIG.defaultLeaseMs);
    const { body: task } = await createTask(
      server.baseUrl, "hub-1", "worker-a",
      { payload: { leaseDeadline: deadline } },
    );

    // Claim
    const claimRes = await fetch(`${server.baseUrl}/tasks/${task.id}/claim`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({ workerId: "worker-a" }),
    });
    assert.equal(claimRes.status, 200);

    // Start
    const startRes = await fetch(`${server.baseUrl}/tasks/${task.id}/start`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({ workerId: "worker-a" }),
    });
    assert.equal(startRes.status, 200);

    // Verify lease survived
    const fetchRes = await fetch(`${server.baseUrl}/tasks/${task.id}`, {
      headers: {
        "x-a2a-requester-id": "hub-1",
        "x-a2a-requester-role": "hub",
      },
    });
    const fetched = await fetchRes.json();
    assert.equal(fetched.payload.leaseDeadline, deadline);
    assert.equal(fetched.status, "running");
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// 3. Structured progress via HTTP
// ---------------------------------------------------------------------------

test("HTTP: task with progress payload is visible in task detail", async () => {
  const server = await startTestServer();
  try {
    await registerWorker(server.baseUrl, "worker-a");

    const progress = createProgressFixture("downloading", 45, "fetching data");
    const { body: task } = await createTask(
      server.baseUrl, "hub-1", "worker-a",
      { payload: { progress } },
    );

    const fetchRes = await fetch(`${server.baseUrl}/tasks/${task.id}`, {
      headers: {
        "x-a2a-requester-id": "hub-1",
        "x-a2a-requester-role": "hub",
      },
    });
    const fetched = await fetchRes.json();

    assert.equal(fetched.payload.progress.phase, "downloading");
    assert.equal(fetched.payload.progress.percent, 45);
    assert.equal(fetched.payload.progress.message, "fetching data");
  } finally {
    await server.close();
  }
});

test("HTTP: progress survives claim → complete lifecycle via API", async () => {
  const server = await startTestServer();
  try {
    await registerWorker(server.baseUrl, "worker-a");

    const progress = createProgressFixture("processing", 75);
    const { body: task } = await createTask(
      server.baseUrl, "hub-1", "worker-a",
      { payload: { progress } },
    );

    // Claim
    await fetch(`${server.baseUrl}/tasks/${task.id}/claim`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({ workerId: "worker-a" }),
    });

    // Complete
    const completeRes = await fetch(`${server.baseUrl}/tasks/${task.id}/complete`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({
        workerId: "worker-a",
        result: { summary: "done" },
      }),
    });
    assert.equal(completeRes.status, 200);

    // Verify progress still there
    const fetchRes = await fetch(`${server.baseUrl}/tasks/${task.id}`, {
      headers: {
        "x-a2a-requester-id": "hub-1",
        "x-a2a-requester-role": "hub",
      },
    });
    const fetched = await fetchRes.json();
    assert.equal(fetched.status, "succeeded");
    assert.equal(fetched.payload.progress.phase, "processing");
    assert.equal(fetched.payload.progress.percent, 75);
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// 4. Retry metadata via HTTP
// ---------------------------------------------------------------------------

test("HTTP: task created with retry policy preserves metadata through fail", async () => {
  const server = await startTestServer();
  try {
    await registerWorker(server.baseUrl, "worker-a");

    const retryPolicy: RetryPolicy = {
      maxRetries: 3,
      baseDelayMs: 2_000,
      backoffMultiplier: 2,
    };

    const { body: task } = await createTask(
      server.baseUrl, "hub-1", "worker-a",
      {
        payload: {
          retryPolicy,
          retryAttempt: 0,
        },
      },
    );

    // Claim
    await fetch(`${server.baseUrl}/tasks/${task.id}/claim`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({ workerId: "worker-a" }),
    });

    // Fail
    const failRes = await fetch(`${server.baseUrl}/tasks/${task.id}/fail`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({
        workerId: "worker-a",
        error: { code: "transient", message: "connection reset" },
      }),
    });
    assert.equal(failRes.status, 200);

    // Verify retry metadata survived
    const fetchRes = await fetch(`${server.baseUrl}/tasks/${task.id}`, {
      headers: {
        "x-a2a-requester-id": "hub-1",
        "x-a2a-requester-role": "hub",
      },
    });
    const fetched = await fetchRes.json();
    assert.equal(fetched.status, "failed");
    assert.equal(fetched.error.code, "transient");
    assert.deepEqual(fetched.payload.retryPolicy, retryPolicy);
    assert.equal(fetched.payload.retryAttempt, 0);
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// 5. Cancel fan-out via HTTP
// ---------------------------------------------------------------------------

test("HTTP: cancel task returns 200 and cancels exchange-linked task", async () => {
  const server = await startTestServer();
  try {
    await registerWorker(server.baseUrl, "worker-a");

    // Create exchange
    const exchangeRes = await fetch(`${server.baseUrl}/exchanges`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "hub-1",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({
        requester: { id: "hub-1", kind: "node", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        message: "test cancel",
        intent: "analyze",
      }),
    });
    const exchange = await exchangeRes.json();

    // Accept exchange → auto-creates linked task
    await fetch(`${server.baseUrl}/exchanges/${exchange.id}/messages`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "hub-1",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({
        actor: { id: "hub-1", kind: "node", role: "hub" },
        message: "accepted",
        decision: "accepted",
        targetNodeId: "worker-a",
        assignedWorkerId: "worker-a",
      }),
    });

    // Get linked task
    const exchangeDetail = await fetch(`${server.baseUrl}/exchanges/${exchange.id}`, {
      headers: {
        "x-a2a-requester-id": "hub-1",
        "x-a2a-requester-role": "hub",
      },
    });
    const exchangeState = await exchangeDetail.json();
    assert.ok(exchangeState.activeTaskId);

    // Cancel task via HTTP
    const cancelRes = await fetch(`${server.baseUrl}/tasks/${exchangeState.activeTaskId}/cancel`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "hub-1",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({
        actor: { id: "hub-1", kind: "node", role: "hub" },
        reason: "operator cancel",
      }),
    });
    assert.equal(cancelRes.status, 200);
    const canceled = await cancelRes.json();
    assert.equal(canceled.status, "canceled");

    // Exchange should reflect cancellation
    const updatedExchange = await fetch(`${server.baseUrl}/exchanges/${exchange.id}`, {
      headers: {
        "x-a2a-requester-id": "hub-1",
        "x-a2a-requester-role": "hub",
      },
    });
    const finalExchange = await updatedExchange.json();
    assert.equal(finalExchange.status, "queued");
  } finally {
    await server.close();
  }
});

test("HTTP: canceling a completed task returns 200 with succeeded status", async () => {
  const server = await startTestServer();
  try {
    await registerWorker(server.baseUrl, "worker-a");

    const { body: task } = await createTask(server.baseUrl, "hub-1", "worker-a");

    // Full lifecycle: claim → start → complete
    await fetch(`${server.baseUrl}/tasks/${task.id}/claim`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({ workerId: "worker-a" }),
    });
    await fetch(`${server.baseUrl}/tasks/${task.id}/start`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({ workerId: "worker-a" }),
    });
    await fetch(`${server.baseUrl}/tasks/${task.id}/complete`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({
        workerId: "worker-a",
        result: { summary: "done" },
      }),
    });

    // Try to cancel completed task
    const cancelRes = await fetch(`${server.baseUrl}/tasks/${task.id}/cancel`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "hub-1",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({
        actor: { id: "hub-1", kind: "node", role: "hub" },
        reason: "too late",
      }),
    });
    assert.equal(cancelRes.status, 200);
    const body = await cancelRes.json();
    assert.equal(body.status, "succeeded");
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// 6. Dashboard reflects durable metadata
// ---------------------------------------------------------------------------

test("HTTP: GET /tasks with status filter returns durable payload fields", async () => {
  const server = await startTestServer();
  try {
    await registerWorker(server.baseUrl, "worker-a");

    const key = idempotencyKey("dash-test", "1");
    const deadline = leaseDeadlineFromNow(60_000);
    const progress = createProgressFixture("init", 10);

    await createTask(server.baseUrl, "hub-1", "worker-a", {
      payload: { idempotencyKey: key, leaseDeadline: deadline, progress },
    });

    const listRes = await fetch(`${server.baseUrl}/tasks?status=queued`, {
      headers: {
        "x-a2a-requester-id": "hub-1",
        "x-a2a-requester-role": "hub",
      },
    });
    const listBody = await listRes.json();
    const list = listBody.items ?? listBody;
    assert.ok(list.length >= 1, `expected at least 1 task, got ${list.length}`);

    const withMeta = list.find(
      (t: { payload: Record<string, unknown> }) => t.payload.idempotencyKey === key,
    );
    assert.ok(withMeta, "task with idempotency key should appear in list");
    assert.ok(withMeta.payload.leaseDeadline);
    assert.ok(withMeta.payload.progress);
  } finally {
    await server.close();
  }
});

test("HTTP: GET /tasks/:id returns full durable payload including retry policy", async () => {
  const server = await startTestServer();
  try {
    await registerWorker(server.baseUrl, "worker-a");

    const retryPolicy: RetryPolicy = { ...DEFAULT_RETRY_POLICY };
    const { body: task } = await createTask(server.baseUrl, "hub-1", "worker-a", {
      payload: {
        retryPolicy,
        retryAttempt: 0,
        idempotencyKey: idempotencyKey("retry-http", "1"),
        leaseDeadline: leaseDeadlineFromNow(300_000),
        progress: createProgressFixture("queued", 0, "waiting"),
      },
    });

    const detailRes = await fetch(`${server.baseUrl}/tasks/${task.id}`, {
      headers: {
        "x-a2a-requester-id": "hub-1",
        "x-a2a-requester-role": "hub",
      },
    });
    const detail = await detailRes.json();

    assert.equal(detail.payload.idempotencyKey, "retry-http:1");
    assert.ok(detail.payload.leaseDeadline);
    assert.equal(detail.payload.progress.phase, "queued");
    assert.deepEqual(detail.payload.retryPolicy, retryPolicy);
    assert.equal(detail.payload.retryAttempt, 0);
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// 7. Full durable lifecycle E2E
// ---------------------------------------------------------------------------

test("HTTP: full durable lifecycle — create with metadata, claim, progress, fail, requeue, complete", async () => {
  const server = await startTestServer({
    staleReaperEnabled: false,
  });
  try {
    await registerWorker(server.baseUrl, "worker-a");

    // Step 1: Create with full durable metadata
    const key = idempotencyKey("e2e-durable", "session-7");
    const deadline = leaseDeadlineFromNow(120_000);
    const { body: task } = await createTask(server.baseUrl, "hub-1", "worker-a", {
      intent: "backfill",
      payload: {
        idempotencyKey: key,
        leaseDeadline: deadline,
        retryPolicy: DEFAULT_RETRY_POLICY,
        retryAttempt: 0,
        progress: createProgressFixture("init", 0, "initializing"),
      },
    });
    assert.equal(task.status, "queued");

    // Step 2: Claim
    await fetch(`${server.baseUrl}/tasks/${task.id}/claim`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({ workerId: "worker-a" }),
    });

    // Step 3: Start
    await fetch(`${server.baseUrl}/tasks/${task.id}/start`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({ workerId: "worker-a" }),
    });

    // Step 4: Fail (simulate transient error)
    await fetch(`${server.baseUrl}/tasks/${task.id}/fail`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({
        workerId: "worker-a",
        error: { code: "transient", message: "timeout" },
      }),
    });

    // Step 5: Requeue stale (failed tasks are not auto-requeued, verify status)
    const requeueRes = await fetch(`${server.baseUrl}/tasks/requeue_stale`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "hub-1",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({ olderThanSec: 0 }),
    });
    assert.equal(requeueRes.status, 200);
    const requeueBody = await requeueRes.json();
    assert.equal(requeueBody.requeued, 0); // failed tasks not requeued

    // Step 6: Operator reassigns (fresh attempt)
    const reassignRes = await fetch(`${server.baseUrl}/tasks/${task.id}/reassign`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "hub-1",
        "x-a2a-requester-role": "hub",
      }),
      body: JSON.stringify({
        actor: { id: "hub-1", kind: "node", role: "hub" },
        targetNodeId: "worker-a",
        assignedWorkerId: "worker-a",
        note: "operator retry",
      }),
    });
    assert.equal(reassignRes.status, 200);
    const reassigned = await reassignRes.json();
    assert.equal(reassigned.status, "queued");
    assert.equal(reassigned.requeueCount, 0); // fresh budget after reassign

    // Step 7: Claim and complete on second attempt
    await fetch(`${server.baseUrl}/tasks/${task.id}/claim`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({ workerId: "worker-a" }),
    });
    await fetch(`${server.baseUrl}/tasks/${task.id}/start`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({ workerId: "worker-a" }),
    });

    const completeRes = await fetch(`${server.baseUrl}/tasks/${task.id}/complete`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({
        workerId: "worker-a",
        result: {
          summary: "backfill complete on retry",
          artifactIds: ["artifact-final"],
        },
      }),
    });
    assert.equal(completeRes.status, 200);

    // Step 8: Verify final state preserves all durable metadata
    const finalRes = await fetch(`${server.baseUrl}/tasks/${task.id}`, {
      headers: {
        "x-a2a-requester-id": "hub-1",
        "x-a2a-requester-role": "hub",
      },
    });
    const final = await finalRes.json();
    assert.equal(final.status, "succeeded");
    assert.equal(final.payload.idempotencyKey, key);
    assert.ok(final.payload.leaseDeadline);
    assert.ok(final.payload.retryPolicy);
    assert.equal(final.result.summary, "backfill complete on retry");
    assert.deepEqual(final.result.artifactIds, ["artifact-final"]);
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// 8. Store persistence for durable payloads
// ---------------------------------------------------------------------------

test("HTTP: durable payload metadata survives state persistence cycle", async () => {
  let snapshot = emptySnapshot();
  const store: BrokerStateStore = {
    load() { return snapshot; },
    save(next) { snapshot = structuredClone(next); },
  };

  const server = await startTestServer({ stateStore: store });
  try {
    await registerWorker(server.baseUrl, "worker-a");

    const key = idempotencyKey("persist", "1");
    const deadline = leaseDeadlineFromNow(60_000);
    const progress = createProgressFixture("phase-1", 25);

    const { body: task } = await createTask(server.baseUrl, "hub-1", "worker-a", {
      payload: { idempotencyKey: key, leaseDeadline: deadline, progress },
    });

    // Claim to trigger a state save
    await fetch(`${server.baseUrl}/tasks/${task.id}/claim`, {
      method: "POST",
      headers: jsonHeaders({
        "x-a2a-requester-id": "worker-a",
        "x-a2a-requester-role": "analyst",
      }),
      body: JSON.stringify({ workerId: "worker-a" }),
    });

    // Close server, create new one with same store
    await server.close();

    const server2 = await startTestServer({ stateStore: store });
    try {
      // Verify task survived persistence with all metadata
      const fetchRes = await fetch(`${server2.baseUrl}/tasks/${task.id}`, {
        headers: {
          "x-a2a-requester-id": "hub-1",
          "x-a2a-requester-role": "hub",
        },
      });
      assert.equal(fetchRes.status, 200);
      const fetched = await fetchRes.json();

      assert.equal(fetched.id, task.id);
      assert.equal(fetched.payload.idempotencyKey, key);
      assert.equal(fetched.payload.leaseDeadline, deadline);
      assert.equal(fetched.payload.progress.phase, "phase-1");
      assert.equal(fetched.payload.progress.percent, 25);
    } finally {
      await server2.close();
    }
  } finally {
    // already closed in inner try
  }
});
