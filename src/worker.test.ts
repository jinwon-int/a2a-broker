import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { once } from "node:events";

import { emptySnapshot, type BrokerStateStore } from "./core/store.js";
import { createBrokerServer, type BrokerServerOptions } from "./server.js";
import { A2ABrokerWorker, createExternalWorkerHandler, createWorkerConfigFromEnv } from "./worker.js";

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
    rateLimitMaxRequests: 100,
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

function createWorker(baseUrl: string, options: { edgeSecret?: string; homeBrokerId?: string; homeBrokerLeaseFile?: string } = {}) {
  return new A2ABrokerWorker({
    brokerUrl: baseUrl,
    edgeSecret: options.edgeSecret,
    homeBrokerId: options.homeBrokerId,
    homeBrokerLeaseFile: options.homeBrokerLeaseFile,
    requesterKind: "node",
    pollIntervalMs: 25,
    heartbeatIntervalMs: 25,
    handlerTimeoutMs: 1_000,
    userAgent: "a2a-broker-worker-test",
    handler: async (task) => ({
      result: {
        summary: `echo ${task.intent}`,
        output: {
          taskId: task.id,
          message: task.message,
          payload: task.payload,
        },
      },
    }),
    worker: {
      nodeId: "worker-a",
      role: "analyst",
      displayName: "Worker A",
      capabilities: {
        canAnalyze: true,
        canBackfill: false,
        canPatchWorkspace: false,
        canPromoteLive: false,
        workspaceIds: ["test"],
        environments: ["research"],
      },
      metadata: { lane: "test" },
    },
  });
}

async function createTask(baseUrl: string, body: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}/tasks`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-a2a-requester-id": "hub-a",
      "x-a2a-requester-role": "hub",
      "x-a2a-requester-kind": "node",
    },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 201);
  return response.json();
}

test("worker registers, heartbeats, polls queued work, and completes tasks", async () => {
  const server = await startTestServer();
  const worker = createWorker(server.baseUrl);

  try {
    const registered = await worker.register();
    assert.equal(registered.nodeId, "worker-a");
    assert.equal(registered.status, "online");

    const beforeHeartbeat = await worker.getWorker();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const heartbeat = await worker.heartbeat();
    assert.equal(heartbeat.nodeId, "worker-a");

    const afterHeartbeat = await worker.getWorker();
    assert.equal(afterHeartbeat.status, "online");
    assert.ok(Date.parse(afterHeartbeat.lastSeenAt) >= Date.parse(beforeHeartbeat.lastSeenAt));

    const task = await createTask(server.baseUrl, {
      intent: "analyze",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-a", kind: "node", role: "analyst" },
      assignedWorkerId: "worker-a",
      message: "run echo",
      payload: { hello: "world" },
    });

    const queued = await worker.pollQueuedTasks();
    assert.equal(queued.length, 1);
    assert.equal(queued[0].id, task.id);

    const processed = await worker.runOnce();
    assert.equal(processed, 1);

    const taskResponse = await fetch(`${server.baseUrl}/tasks/${task.id}`);
    assert.equal(taskResponse.status, 200);
    const completedTask = await taskResponse.json();

    assert.equal(completedTask.status, "succeeded");
    assert.equal(completedTask.claimedBy, "worker-a");
    assert.equal(completedTask.result.summary, "echo analyze");
    assert.equal(completedTask.result.output.message, "run echo");
    assert.deepEqual(completedTask.result.output.payload, { hello: "world" });

    const auditResponse = await fetch(`${server.baseUrl}/audit`);
    const audit = await auditResponse.json();
    const actions = new Set(audit.items.map((item: { action: string }) => item.action));
    assert.ok(actions.has("worker.registered"));
    assert.ok(actions.has("worker.heartbeat"));
    assert.ok(actions.has("task.claimed"));
    assert.ok(actions.has("task.started"));
    assert.ok(actions.has("task.succeeded"));
  } finally {
    await worker.stop();
    await server.close();
  }
});

test("worker sends task heartbeats while a handler is running", async () => {
  const server = await startTestServer();
  const worker = new A2ABrokerWorker({
    brokerUrl: server.baseUrl,
    requesterKind: "node",
    pollIntervalMs: 25,
    heartbeatIntervalMs: 20,
    handlerTimeoutMs: 1_000,
    userAgent: "a2a-broker-worker-test",
    handler: async (task) => {
      await new Promise((resolve) => setTimeout(resolve, 75));
      return { result: { summary: `slow echo ${task.intent}` } };
    },
    worker: {
      nodeId: "worker-a",
      role: "analyst",
      displayName: "Worker A",
      capabilities: {
        canAnalyze: true,
        canBackfill: false,
        canPatchWorkspace: false,
        canPromoteLive: false,
        workspaceIds: ["test"],
        environments: ["research"],
      },
    },
  });

  try {
    await worker.register();
    await createTask(server.baseUrl, {
      intent: "analyze",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-a", kind: "node", role: "analyst" },
      assignedWorkerId: "worker-a",
      message: "run slow echo",
      payload: {},
    });

    const processed = await worker.runOnce();
    assert.equal(processed, 1);

    const auditResponse = await fetch(`${server.baseUrl}/audit?action=task.heartbeat`);
    const audit = await auditResponse.json();
    assert.ok(audit.items.length >= 1, "expected at least one task heartbeat audit event");

    const taskResponse = await fetch(`${server.baseUrl}/tasks/${audit.items[0].targetId}`);
    const completedTask = await taskResponse.json();
    assert.equal(completedTask.status, "succeeded");
    assert.equal(typeof completedTask.lastHeartbeatAt, "string");
  } finally {
    await worker.stop();
    await server.close();
  }
});

test("worker includes x-a2a-edge-secret when configured", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  const worker = createWorker(server.baseUrl, { edgeSecret: "test-edge-secret" });

  try {
    const registered = await worker.register();
    assert.equal(registered.nodeId, "worker-a");

    const heartbeat = await worker.heartbeat();
    assert.equal(heartbeat.nodeId, "worker-a");
  } finally {
    await worker.stop();
    await server.close();
  }
});

test("worker queued-task polls do not consume the general rate limit budget", async () => {
  const server = await startTestServer({
    rateLimitMaxRequests: 1,
    workerRateLimitMaxRequests: 5,
  });
  const worker = createWorker(server.baseUrl);

  try {
    await worker.register();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const queued = await worker.pollQueuedTasks();
      assert.deepEqual(queued, []);
    }
  } finally {
    await worker.stop();
    await server.close();
  }
});

test("worker env config prefers broker-specific edge secrets over generic ones", () => {
  const config = createWorkerConfigFromEnv({
    BROKER_URL: "http://127.0.0.1:8787",
    WORKER_ID: "worker-a",
    WORKER_HANDLER_BUILTIN: "echo",
    BROKER_EDGE_SECRET: "broker-secret",
    EDGE_SECRET: "generic-secret",
  });

  assert.equal(config.edgeSecret, "broker-secret");
});

test("worker env config reads A2A home broker id and lease file", () => {
  const config = createWorkerConfigFromEnv({
    BROKER_URL: "http://127.0.0.1:8787",
    WORKER_ID: "worker-a",
    WORKER_HANDLER_BUILTIN: "echo",
    A2A_HOME_BROKER_ID: "team2-broker",
    A2A_HOME_BROKER_LEASE_FILE: "/tmp/a2a-home-broker-lease.json",
  });

  assert.equal(config.homeBrokerId, "team2-broker");
  assert.equal(config.homeBrokerLeaseFile, "/tmp/a2a-home-broker-lease.json");
});

test("worker validates matching A2A_HOME_BROKER_ID and writes local lease before registering", async () => {
  const server = await startTestServer({ brokerId: "team2-broker" });
  const tempDir = await mkdtemp(join(tmpdir(), "a2a-worker-lease-test-"));
  const leaseFile = join(tempDir, "home-broker.json");
  const worker = createWorker(server.baseUrl, { homeBrokerId: "team2-broker", homeBrokerLeaseFile: leaseFile });

  try {
    const registered = await worker.register();
    assert.equal(registered.nodeId, "worker-a");

    const lease = JSON.parse(await readFile(leaseFile, "utf8"));
    assert.equal(lease.brokerId, "team2-broker");
    assert.equal(lease.workerId, "worker-a");
    assert.equal(lease.brokerUrl, `${server.baseUrl}/`);
  } finally {
    await worker.stop();
    await server.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("worker fails closed when broker identity mismatches A2A_HOME_BROKER_ID", async () => {
  const server = await startTestServer({ brokerId: "other-broker" });
  const worker = createWorker(server.baseUrl, { homeBrokerId: "team2-broker" });

  try {
    await assert.rejects(() => worker.register(), /home broker mismatch: expected A2A_HOME_BROKER_ID=team2-broker, got other-broker/);
  } finally {
    await worker.stop();
    await server.close();
  }
});

test("worker fails closed when local home-broker lease points at a different broker", async () => {
  const server = await startTestServer({ brokerId: "team2-broker" });
  const tempDir = await mkdtemp(join(tmpdir(), "a2a-worker-lease-test-"));
  const leaseFile = join(tempDir, "home-broker.json");
  await writeFile(leaseFile, JSON.stringify({ brokerId: "old-broker" }), "utf8");
  const worker = createWorker(server.baseUrl, { homeBrokerId: "team2-broker", homeBrokerLeaseFile: leaseFile });

  try {
    await assert.rejects(() => worker.register(), /home broker lease mismatch/);
  } finally {
    await worker.stop();
    await server.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("worker fails tasks when an external handler exits non-zero", async () => {
  const server = await startTestServer();
  const tempDir = await mkdtemp(join(tmpdir(), "a2a-worker-test-"));
  const scriptPath = join(tempDir, "handler.mjs");

  await writeFile(
    scriptPath,
    [
      "import { stdin, stderr } from 'node:process';",
      "let input = '';",
      "stdin.setEncoding('utf8');",
      "stdin.on('data', (chunk) => { input += chunk; });",
      "stdin.on('end', () => {",
      "  const task = JSON.parse(input);",
      "  stderr.write(`external handler rejected ${task.id}`);",
      "  process.exitCode = 7;",
      "});",
    ].join("\n"),
    "utf8",
  );

  const worker = new A2ABrokerWorker({
    brokerUrl: server.baseUrl,
    requesterKind: "node",
    pollIntervalMs: 25,
    heartbeatIntervalMs: 25,
    handlerTimeoutMs: 1_000,
    userAgent: "a2a-broker-worker-test",
    handler: createExternalWorkerHandler({
      command: process.execPath,
      args: [scriptPath],
      timeoutMs: 1_000,
    }),
    worker: {
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
    },
  });

  try {
    await worker.register();
    const task = await createTask(server.baseUrl, {
      intent: "analyze",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-a", kind: "node", role: "analyst" },
      assignedWorkerId: "worker-a",
      message: "run external",
    });

    const processed = await worker.runOnce();
    assert.equal(processed, 1);

    const taskResponse = await fetch(`${server.baseUrl}/tasks/${task.id}`);
    assert.equal(taskResponse.status, 200);
    const failedTask = await taskResponse.json();

    assert.equal(failedTask.status, "failed");
    assert.equal(failedTask.claimedBy, "worker-a");
    assert.equal(failedTask.error.code, "handler_exit_nonzero");
    assert.match(failedTask.error.message, /external handler rejected/);
  } finally {
    await worker.stop();
    await server.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});


test("worker fails GitHub propose_patch tasks without PR or block evidence", async () => {
  const server = await startTestServer();
  const worker = createWorker(server.baseUrl);

  try {
    await worker.register();
    const task = await createTask(server.baseUrl, {
      intent: "propose_patch",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-a", kind: "node", role: "analyst" },
      assignedWorkerId: "worker-a",
      message: "open a GitHub PR",
      payload: { mode: "github-propose-patch", repo: "owner/repo", issue: "#1" },
      taskOrigin: "github",
    });

    const processed = await worker.runOnce();
    assert.equal(processed, 1);

    const taskResponse = await fetch(`${server.baseUrl}/tasks/${task.id}`);
    assert.equal(taskResponse.status, 200);
    const failedTask = await taskResponse.json();

    assert.equal(failedTask.status, "failed");
    assert.equal(failedTask.error.code, "github_completion_evidence_missing");
  } finally {
    await worker.stop();
    await server.close();
  }
});

test("worker fails GitHub issue-instruction propose_patch tasks without PR or block evidence", async () => {
  const server = await startTestServer();
  const worker = createWorker(server.baseUrl);

  try {
    await worker.register();
    const task = await createTask(server.baseUrl, {
      intent: "propose_patch",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-a", kind: "node", role: "analyst" },
      assignedWorkerId: "worker-a",
      message: "process a GitHub issue instruction",
      payload: { mode: "github-issue-instruction", repo: "owner/repo", issue: "#1" },
      taskOrigin: "unknown",
    });

    const processed = await worker.runOnce();
    assert.equal(processed, 1);

    const taskResponse = await fetch(`${server.baseUrl}/tasks/${task.id}`);
    assert.equal(taskResponse.status, 200);
    const failedTask = await taskResponse.json();

    assert.equal(failedTask.status, "failed");
    assert.equal(failedTask.error.code, "github_completion_evidence_missing");
  } finally {
    await worker.stop();
    await server.close();
  }
});

test("worker allows GitHub propose_patch tasks with PR evidence", async () => {
  const server = await startTestServer();
  const worker = new A2ABrokerWorker({
    brokerUrl: server.baseUrl,
    requesterKind: "node",
    pollIntervalMs: 25,
    heartbeatIntervalMs: 25,
    handlerTimeoutMs: 1_000,
    userAgent: "a2a-broker-worker-test",
    handler: async () => ({
      result: {
        summary: "opened PR",
        output: {
          github: {
            prUrl: "https://github.com/owner/repo/pull/2",
          },
        },
      },
    }),
    worker: {
      nodeId: "worker-a",
      role: "analyst",
      capabilities: {
        canAnalyze: true,
        canBackfill: false,
        canPatchWorkspace: true,
        canPromoteLive: false,
        workspaceIds: ["test"],
        environments: ["research"],
      },
    },
  });

  try {
    await worker.register();
    const task = await createTask(server.baseUrl, {
      intent: "propose_patch",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-a", kind: "node", role: "analyst" },
      assignedWorkerId: "worker-a",
      message: "open a GitHub PR",
      payload: { mode: "github-propose-patch", repo: "owner/repo", issue: "#1" },
      taskOrigin: "github",
    });

    const processed = await worker.runOnce();
    assert.equal(processed, 1);

    const taskResponse = await fetch(`${server.baseUrl}/tasks/${task.id}`);
    assert.equal(taskResponse.status, 200);
    const completedTask = await taskResponse.json();

    assert.equal(completedTask.status, "succeeded");
    assert.equal(completedTask.result.output.github.prUrl, "https://github.com/owner/repo/pull/2");
  } finally {
    await worker.stop();
    await server.close();
  }
});

test("worker proposal APIs: createProposal, getProposalDetails, submitValidation", async () => {
  const server = await startTestServer();
  const worker = createWorker(server.baseUrl);

  try {
    await worker.register();

    // Create a proposal via worker API
    const proposal = await worker.createProposal({
      source: { id: "worker-a", kind: "node", role: "analyst" },
      target: { id: "target-node", kind: "node", role: "live-trader" },
      kind: "patch",
      summary: "test patch",
      workspace: { nodeId: "target-node", workspaceId: "ws1" },
      patchText: "- old\n+ new",
    });

    assert.equal(proposal.kind, "patch");
    assert.equal(proposal.summary, "test patch");
    assert.equal(proposal.status, "submitted");

    // Fetch proposal details
    const details = await worker.getProposalDetails(proposal.id);
    assert.equal(details.proposal.id, proposal.id);
    assert.equal(details.validations.length, 0);

    // Submit validation
    await worker.submitValidation(proposal.id, {
      nodeId: "worker-a",
      kind: "backfill",
      verdict: "pass",
      metrics: { sr_improvement: 0.2 },
      note: "backtest passed",
    });

    // Re-fetch — should now be validated
    const afterValidation = await worker.getProposalDetails(proposal.id);
    assert.equal(afterValidation.proposal.status, "validated");
    assert.equal(afterValidation.validations.length, 1);
    assert.equal(afterValidation.validations[0].verdict, "pass");
  } finally {
    await worker.stop();
    await server.close();
  }
});

test("worker proposal API: approveProposal and applyProposal lifecycle", async () => {
  const server = await startTestServer();
  const worker = createWorker(server.baseUrl);

  // Need to register both worker-a and target-node on broker
  // target-node is needed for policy checks
  const targetWorker = new A2ABrokerWorker({
    brokerUrl: server.baseUrl,
    requesterKind: "node",
    pollIntervalMs: 25,
    heartbeatIntervalMs: 25,
    handlerTimeoutMs: 1_000,
    userAgent: "a2a-broker-worker-test",
    handler: async () => ({ result: {} }),
    worker: {
      nodeId: "target-node",
      role: "live-trader",
      capabilities: {
        canAnalyze: false,
        canBackfill: false,
        canPatchWorkspace: true,
        canPromoteLive: true,
        workspaceIds: ["ws1"],
        environments: ["live"],
      },
    },
  });

  try {
    await worker.register();
    await targetWorker.register();

    // Create + validate proposal
    const proposal = await worker.createProposal({
      source: { id: "worker-a", kind: "node", role: "analyst" },
      target: { id: "target-node", kind: "node", role: "live-trader" },
      kind: "params",
      summary: "update threshold",
      workspace: { nodeId: "target-node", workspaceId: "ws1" },
      parameterPayload: { THRESHOLD: 2.5 },
    });

    await worker.submitValidation(proposal.id, {
      nodeId: "worker-a",
      kind: "backfill",
      verdict: "pass",
    });

    // Target-node approves (policy: target node or operator only)
    // target-node's requester identity matches, so approve via targetWorker
    await targetWorker.approveProposal(proposal.id, {
      actor: { id: "target-node", kind: "node", role: "live-trader" },
      note: "approved",
    });

    // Apply
    const applied = await targetWorker.applyProposal(proposal.id, {
      actor: { id: "target-node", kind: "node", role: "live-trader" },
      workspace: { nodeId: "target-node", workspaceId: "ws1" },
      note: "applied locally",
    });

    assert.equal((applied as { status: string }).status, "applied");

    // Verify via details
    const details = await worker.getProposalDetails(proposal.id);
    assert.equal(details.proposal.status, "applied");
    assert.ok(details.audit.some((e: any) => e.action === "proposal.applied"));
  } finally {
    await worker.stop();
    await targetWorker.stop();
    await server.close();
  }
});

test("worker returns 404 for non-existent proposal", async () => {
  const server = await startTestServer();
  const worker = createWorker(server.baseUrl);

  try {
    await worker.register();

    await assert.rejects(
      () => worker.getProposalDetails("nonexistent-id"),
      (error: any) => error.code === "not_found",
    );
  } finally {
    await worker.stop();
    await server.close();
  }
});

// ─── analysis-only / read-only task mode regression tests ───

test("worker completes analysis-only tasks without PR evidence", async () => {
  const server = await startTestServer();
  const worker = createWorker(server.baseUrl);

  try {
    await worker.register();
    const task = await createTask(server.baseUrl, {
      intent: "analyze",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-a", kind: "node", role: "analyst" },
      assignedWorkerId: "worker-a",
      message: "run market regime analysis",
      payload: {
        mode: "analysis-only",
        summary: "BTC dominance scan",
        findings: ["dominance at 58%"],
        risks: ["volume declining"],
      },
      taskOrigin: "api",
    });

    const processed = await worker.runOnce();
    assert.equal(processed, 1);

    const taskResponse = await fetch(`${server.baseUrl}/tasks/${task.id}`);
    assert.equal(taskResponse.status, 200);
    const completedTask = await taskResponse.json();

    assert.equal(completedTask.status, "succeeded", "analysis-only task should succeed");
    assert.equal(completedTask.claimedBy, "worker-a");
    assert.match(completedTask.result.summary, /echo analyze/);
  } finally {
    await worker.stop();
    await server.close();
  }
});

test("worker completes analysis-only tasks with github origin without PR evidence", async () => {
  const server = await startTestServer();
  const worker = createWorker(server.baseUrl);

  try {
    await worker.register();
    const task = await createTask(server.baseUrl, {
      intent: "analyze",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-a", kind: "node", role: "analyst" },
      assignedWorkerId: "worker-a",
      message: "read-only thesis analysis",
      payload: {
        mode: "analysis-only",
        summary: "thesis for BTC/USDT",
        doneCommentUrl: "https://github.com/owner/repo/issues/1#issuecomment-done",
        findings: ["bullish divergence on 4h"],
      },
      taskOrigin: "github",
    });

    const processed = await worker.runOnce();
    assert.equal(processed, 1);

    const taskResponse = await fetch(`${server.baseUrl}/tasks/${task.id}`);
    assert.equal(taskResponse.status, 200);
    const completedTask = await taskResponse.json();

    // Analysis-only tasks with github origin must succeed without PR evidence
    assert.equal(completedTask.status, "succeeded",
      `analysis-only github-origin task should succeed, got: ${JSON.stringify(completedTask.error)}`);
  } finally {
    await worker.stop();
    await server.close();
  }
});

test("worker fails github propose_patch tasks without PR evidence (existing contract preserved)", async () => {
  const server = await startTestServer();
  const worker = createWorker(server.baseUrl);

  try {
    await worker.register();
    const task = await createTask(server.baseUrl, {
      intent: "propose_patch",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-a", kind: "node", role: "analyst" },
      assignedWorkerId: "worker-a",
      message: "open a PR",
      payload: { mode: "github-propose-patch", repo: "owner/repo", issue: "#1" },
      taskOrigin: "github",
    });

    const processed = await worker.runOnce();
    assert.equal(processed, 1);

    const taskResponse = await fetch(`${server.baseUrl}/tasks/${task.id}`);
    assert.equal(taskResponse.status, 200);
    const failedTask = await taskResponse.json();

    // Existing contract: github propose_patch tasks MUST have PR evidence
    assert.equal(failedTask.status, "failed");
    assert.equal(failedTask.error.code, "github_completion_evidence_missing");
  } finally {
    await worker.stop();
    await server.close();
  }
});
