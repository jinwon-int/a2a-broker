import test from "node:test";
import assert from "node:assert/strict";

import { InMemoryA2ABroker } from "../core/broker.js";
import type { WorkerRecord } from "../core/types.js";
import { executeA2AJsonRpc, type ExecuteJsonRpcOptions, type JsonRpcSuccess, type JsonRpcFailure } from "./json-rpc.js";
import {
  PEER_STATUS_VERBOSE_SCOPE,
  PeerStatusService,
  type PeerStatusResponse,
  type PeerStatusError,
} from "./peer-status.js";
import { createBrokerAgentCard } from "./agent-card.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createBroker(): InMemoryA2ABroker {
  return new InMemoryA2ABroker();
}

function registerWorker(broker: InMemoryA2ABroker, nodeId: string): void {
  broker.registerWorker({
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
  });
}

const defaultAgentCard = createBrokerAgentCard({
  serviceName: "test-broker",
  publicBaseUrl: "https://broker.test/",
});

function createJsonRpcOptions(
  broker: InMemoryA2ABroker,
  overrides?: Partial<ExecuteJsonRpcOptions>,
): ExecuteJsonRpcOptions {
  const peerStatusService = new PeerStatusService(broker);
  return {
    broker,
    agentCard: defaultAgentCard,
    requesterIdentity: { id: "caller-node", kind: "node", role: "hub" },
    enforceRequesterIdentity: true,
    peerStatusService,
    ...overrides,
  };
}

function peerStatusRpc(
  options: ExecuteJsonRpcOptions,
  target: string,
  maxCacheAgeMs?: number,
): JsonRpcSuccess | JsonRpcFailure {
  return executeA2AJsonRpc(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "PeerStatus",
      params: { target, maxCacheAgeMs },
    },
    options,
  );
}

function isPeerStatusResponse(v: unknown): v is PeerStatusResponse {
  return typeof v === "object" && v !== null && "health" in v && "target" in v;
}

function isPeerStatusError(v: unknown): v is PeerStatusError {
  return typeof v === "object" && v !== null && "errorCode" in v;
}

// ---------------------------------------------------------------------------
// Tests: Basic status computation
// ---------------------------------------------------------------------------

test("PeerStatus returns ok for a registered worker", () => {
  const broker = createBroker();
  registerWorker(broker, "worker-a");
  const options = createJsonRpcOptions(broker);

  const result = peerStatusRpc(options, "worker-a");
  assert.ok("result" in result, "should be a success response");
  if (!("result" in result)) return;

  const data = result.result as PeerStatusResponse;
  assert.equal(data.schemaVersion, 1);
  assert.equal(data.target, "worker-a");
  assert.equal(data.health, "ok");
  assert.equal(data.gateway.reachable, true);
  assert.equal(data.worker.registered, true);
});

test("PeerStatus returns target_unknown for unregistered worker", () => {
  const broker = createBroker();
  const options = createJsonRpcOptions(broker);

  const result = peerStatusRpc(options, "ghost-node");
  assert.ok("error" in result, "should be an error response");
  if (!("error" in result)) return;
  assert.equal((result.error?.data as Record<string, unknown>)?.brokerCode, "target_unknown");
});

test("PeerStatus returns unauthenticated without caller identity", () => {
  const broker = createBroker();
  registerWorker(broker, "worker-a");
  const options = createJsonRpcOptions(broker, {
    requesterIdentity: null,
    enforceRequesterIdentity: true,
  });

  const result = peerStatusRpc(options, "worker-a");
  assert.ok("error" in result);
  if (!("error" in result)) return;
  assert.equal((result.error?.data as Record<string, unknown>)?.brokerCode, "unauthenticated");
});

test("PeerStatus denies verbose queries without explicit scope", () => {
  const broker = createBroker();
  registerWorker(broker, "worker-a");
  const options = createJsonRpcOptions(broker);

  const result = executeA2AJsonRpc(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "PeerStatus",
      params: { target: "worker-a", verbose: true },
    },
    options,
  );
  assert.ok("error" in result, "should be an error response");
  if (!("error" in result)) return;

  assert.equal(result.error.code, -32003);
  assert.equal((result.error?.data as Record<string, unknown>)?.brokerCode, "scope_denied");
  assert.equal((result.error?.data as Record<string, unknown>)?.requiredScope, PEER_STATUS_VERBOSE_SCOPE);
});

test("PeerStatus accepts verbose queries with explicit scope", () => {
  const broker = createBroker();
  registerWorker(broker, "worker-a");
  const options = createJsonRpcOptions(broker, {
    requesterIdentity: {
      id: "caller-node",
      kind: "node",
      role: "hub",
      scopes: [PEER_STATUS_VERBOSE_SCOPE],
    },
  });

  const result = executeA2AJsonRpc(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "PeerStatus",
      params: { target: "worker-a", verbose: true },
    },
    options,
  );
  assert.ok("result" in result, "should be a success response");
  if (!("result" in result)) return;

  const data = result.result as PeerStatusResponse;
  assert.equal(data.target, "worker-a");
  assert.equal(data.health, "ok");
});

test("PeerStatus returns method not found without peerStatusService", () => {
  const broker = createBroker();
  registerWorker(broker, "worker-a");
  const options: ExecuteJsonRpcOptions = {
    broker,
    agentCard: defaultAgentCard,
    requesterIdentity: { id: "caller", kind: "node", role: "hub" },
    enforceRequesterIdentity: true,
    // No peerStatusService
  };

  const result = peerStatusRpc(options, "worker-a");
  assert.ok("error" in result);
  if (!("error" in result)) return;
  assert.equal(result.error?.code, -32601);
});

// ---------------------------------------------------------------------------
// Tests: Health states
// ---------------------------------------------------------------------------

test("health is unreachable when worker is not registered", () => {
  const broker = createBroker();
  const service = new PeerStatusService(broker);

  // The service can compute status for any target, even unregistered ones.
  // In JSON-RPC this would be caught by the target_unknown check,
  // but the service itself can handle it.
  const result = service.query({ target: "unknown" }, "caller");
  assert.ok(isPeerStatusResponse(result));
  assert.equal((result as PeerStatusResponse).health, "unreachable");
});

test("health is ok for a fresh registered worker with no tasks", () => {
  const broker = createBroker();
  registerWorker(broker, "worker-a");
  const service = new PeerStatusService(broker);

  const result = service.query({ target: "worker-a" }, "caller");
  assert.ok(isPeerStatusResponse(result));
  assert.equal((result as PeerStatusResponse).health, "ok");
});

// ---------------------------------------------------------------------------
// Tests: Cache behavior
// ---------------------------------------------------------------------------

test("cache serves result within TTL", () => {
  const broker = createBroker();
  registerWorker(broker, "worker-a");
  const service = new PeerStatusService(broker, { cacheTtlMs: 5000 });

  // First query: fresh compute
  const first = service.query({ target: "worker-a" }, "caller");
  assert.ok(isPeerStatusResponse(first));
  assert.equal((first as PeerStatusResponse).cacheAgeMs, 0);

  // Second query: cache hit (immediate)
  const second = service.query({ target: "worker-a" }, "caller");
  assert.ok(isPeerStatusResponse(second));
  assert.ok(
    (second as PeerStatusResponse).cacheAgeMs <= 10,
    "cache age should be very small",
  );
});

test("maxCacheAgeMs=0 forces fresh computation", () => {
  const broker = createBroker();
  registerWorker(broker, "worker-a");
  const service = new PeerStatusService(broker, { cacheTtlMs: 5000 });

  // First query to populate cache
  service.query({ target: "worker-a" }, "caller");

  // Force recompute with maxCacheAgeMs=0
  const result = service.query({ target: "worker-a", maxCacheAgeMs: 0 }, "caller");
  assert.ok(isPeerStatusResponse(result));
  assert.equal((result as PeerStatusResponse).cacheAgeMs, 0);
});

// ---------------------------------------------------------------------------
// Tests: Rate limiting
// ---------------------------------------------------------------------------

test("rate limiting blocks after exceeding limit", () => {
  const broker = createBroker();
  registerWorker(broker, "worker-a");
  const service = new PeerStatusService(broker, { cacheTtlMs: 0 }); // Force recomputes

  const limit = 25; // RATE_LIMIT(20) + RATE_BURST(5)
  let rateLimited = false;

  for (let i = 0; i < limit + 5; i++) {
    const result = service.query({ target: "worker-a", maxCacheAgeMs: 0 }, "caller");
    if (isPeerStatusError(result) && result.errorCode === "rate_limited") {
      rateLimited = true;
      assert.ok(result.retryAfterMs !== undefined);
      assert.ok(result.retryAfterMs! > 0);
      break;
    }
  }

  assert.ok(rateLimited, "should eventually be rate limited");
});

test("rate limiting is per (caller, target) pair", () => {
  const broker = createBroker();
  registerWorker(broker, "worker-a");
  registerWorker(broker, "worker-b");
  const service = new PeerStatusService(broker, { cacheTtlMs: 0 });

  // Saturate caller→worker-a
  for (let i = 0; i < 30; i++) {
    service.query({ target: "worker-a", maxCacheAgeMs: 0 }, "caller-1");
  }

  // caller-1 → worker-a should be rate limited
  const blocked = service.query({ target: "worker-a", maxCacheAgeMs: 0 }, "caller-1");
  assert.ok(isPeerStatusError(blocked), "caller-1→worker-a should be rate limited");

  // But caller-2 → worker-a should still work
  const allowed = service.query({ target: "worker-a", maxCacheAgeMs: 0 }, "caller-2");
  assert.ok(isPeerStatusResponse(allowed), "caller-2→worker-a should not be rate limited");

  // And caller-1 → worker-b should still work
  const allowed2 = service.query({ target: "worker-b", maxCacheAgeMs: 0 }, "caller-1");
  assert.ok(isPeerStatusResponse(allowed2), "caller-1→worker-b should not be rate limited");
});

// ---------------------------------------------------------------------------
// Tests: Privacy
// ---------------------------------------------------------------------------

test("default summary response stays allow-listed and contains no sensitive fields", () => {
  const broker = createBroker();
  registerWorker(broker, "worker-a");
  const service = new PeerStatusService(broker);

  const result = service.query({ target: "worker-a" }, "caller");
  assert.ok(isPeerStatusResponse(result));

  const response = result as PeerStatusResponse;
  assert.deepEqual(
    Object.keys(response).sort(),
    ["cacheAgeMs", "gateway", "health", "observedAt", "rateLimit", "schemaVersion", "target", "tasks", "worker"],
  );
  assert.ok(
    Object.keys(response.gateway).every((key) => ["reachable", "version", "mode"].includes(key)),
    "gateway shape should stay within the read-only summary contract",
  );
  assert.ok(
    Object.keys(response.worker).every((key) => ["registered", "workerMode", "lastHeartbeatAt", "capacity"].includes(key)),
    "worker shape should stay within the read-only summary contract",
  );
  assert.deepEqual(Object.keys(response.tasks).sort(), ["active", "queued", "stale"]);

  const responseStr = JSON.stringify(result);

  // These should never appear
  const forbidden = [
    "message", "promptTokens", "completionTokens", "costUsd", "exchangeId", "taskId", "contextId",
    "sessionId", "sessionLabel", "transcript",
    "toolCall", "toolResult", "prompt", "systemPrompt",
    "memory", "telegram", "password", "token", "secret",
    "userId", "username",
  ];

  for (const field of forbidden) {
    assert.ok(
      !responseStr.includes(field),
      `response should not contain "${field}"`,
    );
  }
});

// ---------------------------------------------------------------------------
// Tests: Task counts
// ---------------------------------------------------------------------------

test("task counts reflect broker state", () => {
  const broker = createBroker();
  registerWorker(broker, "worker-a");
  registerWorker(broker, "hub-a");
  const service = new PeerStatusService(broker, { cacheTtlMs: 0 });

  // Create some tasks
  broker.createTask({
    intent: "chat",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "test task 1",
  });

  broker.createTask({
    intent: "chat",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "test task 2",
  });

  const result = service.query({ target: "worker-a", maxCacheAgeMs: 0 }, "caller");
  assert.ok(isPeerStatusResponse(result));

  const response = result as PeerStatusResponse;
  assert.equal(response.tasks.queued, 2);
  assert.equal(response.tasks.active, 0);
  assert.equal(response.tasks.stale, 0);
});

// ---------------------------------------------------------------------------
// Tests: Global recompute cap (light)
// ---------------------------------------------------------------------------

test("service handles multiple queries without errors", () => {
  const broker = createBroker();
  registerWorker(broker, "worker-a");
  const service = new PeerStatusService(broker, { cacheTtlMs: 0 });

  for (let i = 0; i < 10; i++) {
    const result = service.query({ target: "worker-a", maxCacheAgeMs: 0 }, `caller-${i}`);
    assert.ok(
      isPeerStatusResponse(result) || isPeerStatusError(result),
      "should return valid result",
    );
  }
});

// ---------------------------------------------------------------------------
// Tests: Busy state
// ---------------------------------------------------------------------------

test("health is busy when all capacity slots are occupied", () => {
  const broker = createBroker();
  registerWorker(broker, "worker-a");
  registerWorker(broker, "hub-a");
  const service = new PeerStatusService(broker, { cacheTtlMs: 0 });

  // Create 10 tasks (default slot count for persistent worker)
  for (let i = 0; i < 10; i++) {
    broker.createTask({
      intent: "chat",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-a", kind: "node", role: "analyst" },
      assignedWorkerId: "worker-a",
      message: `test task ${i}`,
    });
  }

  const result = service.query({ target: "worker-a", maxCacheAgeMs: 0 }, "caller");
  assert.ok(isPeerStatusResponse(result));
  const response = result as PeerStatusResponse;
  assert.equal(response.health, "busy");
  assert.equal(response.worker.capacity?.slotsTotal, 10);
  assert.equal(response.worker.capacity?.slotsBusy, 10);
});

test("health is ok when some capacity remains", () => {
  const broker = createBroker();
  registerWorker(broker, "worker-a");
  registerWorker(broker, "hub-a");
  const service = new PeerStatusService(broker, { cacheTtlMs: 0 });

  // Create only 5 tasks (half capacity)
  for (let i = 0; i < 5; i++) {
    broker.createTask({
      intent: "chat",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-a", kind: "node", role: "analyst" },
      assignedWorkerId: "worker-a",
      message: `test task ${i}`,
    });
  }

  const result = service.query({ target: "worker-a", maxCacheAgeMs: 0 }, "caller");
  assert.ok(isPeerStatusResponse(result));
  const response = result as PeerStatusResponse;
  assert.equal(response.health, "ok");
  assert.equal(response.worker.capacity?.slotsTotal, 10);
  assert.equal(response.worker.capacity?.slotsBusy, 5);
});

// ---------------------------------------------------------------------------
// Tests: Mobile worker mode
// ---------------------------------------------------------------------------

test("mobile worker has reduced capacity (3 slots)", () => {
  const broker = createBroker();
  broker.registerWorker({
    nodeId: "mobile-node",
    role: "analyst",
    workerMode: "mobile",
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: false,
      canPromoteLive: false,
      workspaceIds: ["test"],
      environments: ["research"],
    },
  });
  const service = new PeerStatusService(broker, { cacheTtlMs: 0 });

  const result = service.query({ target: "mobile-node" }, "caller");
  assert.ok(isPeerStatusResponse(result));
  const response = result as PeerStatusResponse;
  assert.equal(response.worker.workerMode, "mobile");
  assert.equal(response.worker.capacity?.slotsTotal, 3);
  assert.equal(response.worker.capacity?.slotsBusy, 0);
});

test("mobile worker becomes busy at 3 tasks instead of 10", () => {
  const broker = createBroker();
  broker.registerWorker({
    nodeId: "mobile-node",
    role: "analyst",
    workerMode: "mobile",
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: false,
      canPromoteLive: false,
      workspaceIds: ["test"],
      environments: ["research"],
    },
  });
  broker.registerWorker({
    nodeId: "hub-a",
    role: "hub",
    capabilities: {
      canAnalyze: false,
      canBackfill: false,
      canPatchWorkspace: false,
      canPromoteLive: false,
      workspaceIds: ["test"],
      environments: ["research"],
    },
  });
  const service = new PeerStatusService(broker, { cacheTtlMs: 0 });

  // Create 3 tasks — fills mobile capacity
  for (let i = 0; i < 3; i++) {
    broker.createTask({
      intent: "chat",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "mobile-node", kind: "node", role: "analyst" },
      assignedWorkerId: "mobile-node",
      message: `test task ${i}`,
    });
  }

  const result = service.query({ target: "mobile-node", maxCacheAgeMs: 0 }, "caller");
  assert.ok(isPeerStatusResponse(result));
  const response = result as PeerStatusResponse;
  assert.equal(response.health, "busy");
  assert.equal(response.worker.capacity?.slotsBusy, 3);
});

test("mobile worker uses shorter stale threshold (30 s default)", () => {
  const broker = createBroker();
  broker.registerWorker({
    nodeId: "mobile-node",
    role: "analyst",
    workerMode: "mobile",
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: false,
      canPromoteLive: false,
      workspaceIds: ["test"],
      environments: ["research"],
    },
  });
  const service = new PeerStatusService(broker, {
    cacheTtlMs: 0,
    mobileOfflineAfterMs: 30_000,
    workerOfflineAfterMs: 90_000,
  });

  // Mobile worker just registered — should be ok
  const fresh = service.query({ target: "mobile-node", maxCacheAgeMs: 0 }, "caller");
  assert.ok(isPeerStatusResponse(fresh));
  assert.equal((fresh as PeerStatusResponse).health, "ok");
  assert.equal((fresh as PeerStatusResponse).worker.workerMode, "mobile");
});

test("persistent worker (default mode) has standard capacity", () => {
  const broker = createBroker();
  broker.registerWorker({
    nodeId: "server-node",
    role: "analyst",
    // no workerMode → defaults to persistent
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: false,
      canPromoteLive: false,
      workspaceIds: ["test"],
      environments: ["research"],
    },
  });
  const service = new PeerStatusService(broker, { cacheTtlMs: 0 });

  const result = service.query({ target: "server-node" }, "caller");
  assert.ok(isPeerStatusResponse(result));
  const response = result as PeerStatusResponse;
  assert.equal(response.worker.workerMode, undefined); // absent for default persistent
  assert.equal(response.worker.capacity?.slotsTotal, 10);
});

test("health priority: stale beats busy when worker heartbeat is old", () => {
  const broker = createBroker();
  broker.registerWorker({
    nodeId: "busy-node",
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
  broker.registerWorker({
    nodeId: "hub-a",
    role: "hub",
    capabilities: {
      canAnalyze: false,
      canBackfill: false,
      canPatchWorkspace: false,
      canPromoteLive: false,
      workspaceIds: ["test"],
      environments: ["research"],
    },
  });

  // Fill all slots
  for (let i = 0; i < 10; i++) {
    broker.createTask({
      intent: "chat",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "busy-node", kind: "node", role: "analyst" },
      assignedWorkerId: "busy-node",
      message: `test task ${i}`,
    });
  }

  // Without stale worker, it's busy
  const serviceFresh = new PeerStatusService(broker, { cacheTtlMs: 0, workerOfflineAfterMs: 90_000 });
  const freshResult = serviceFresh.query({ target: "busy-node", maxCacheAgeMs: 0 }, "caller");
  assert.ok(isPeerStatusResponse(freshResult));
  assert.equal((freshResult as PeerStatusResponse).health, "busy");

  // Set the worker's lastSeenAt far in the past to simulate stale heartbeat
  const busyWorker = broker.getWorker("busy-node");
  assert.ok(busyWorker !== null);
  const oneHourAgo = new Date(Date.now() - 3600_000).toISOString();
  (busyWorker as any).lastSeenAt = oneHourAgo;

  // Now stale beats busy
  const serviceStale = new PeerStatusService(broker, { cacheTtlMs: 0, workerOfflineAfterMs: 90_000 });
  const staleResult = serviceStale.query({ target: "busy-node", maxCacheAgeMs: 0 }, "caller");
  assert.ok(isPeerStatusResponse(staleResult));
  assert.equal((staleResult as PeerStatusResponse).health, "stale");
});

// ---------------------------------------------------------------------------
// Tests: JSON-RPC integration
// ---------------------------------------------------------------------------

test("PeerStatus via JSON-RPC returns proper structure", () => {
  const broker = createBroker();
  registerWorker(broker, "worker-a");
  const options = createJsonRpcOptions(broker);

  const result = peerStatusRpc(options, "worker-a");
  assert.ok("result" in result);
  if (!("result" in result)) return;

  const data = result.result as PeerStatusResponse;
  assert.equal(data.schemaVersion, 1);
  assert.equal(data.target, "worker-a");
  assert.equal(typeof data.observedAt, "number");
  assert.equal(typeof data.cacheAgeMs, "number");
  assert.ok(data.gateway);
  assert.ok(data.worker);
  assert.ok(data.tasks);
  assert.ok(data.health);
  assert.ok(data.rateLimit);
});

test("PeerStatus via JSON-RPC with missing target returns error", () => {
  const broker = createBroker();
  const options = createJsonRpcOptions(broker);

  const result = executeA2AJsonRpc(
    { jsonrpc: "2.0", id: 1, method: "PeerStatus", params: {} },
    options,
  );
  assert.ok("error" in result);
  if (!("error" in result)) return;
});
