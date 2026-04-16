import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

import { InMemoryA2ABroker } from "../core/broker.js";
import { emptySnapshot, type BrokerStateStore } from "../core/store.js";
import { createBrokerServer, type BrokerServerOptions } from "../server.js";
import { A2ABrokerWorker, type WorkerTaskHandler } from "../worker.js";
import { createIntentRouter } from "./intent-router.js";
import {
  createValidateProposalHandler,
  createApplyProposalHandler,
  createProposePatchHandler,
  createProposeParamsHandler,
  type ProposalValidator,
  type ProposalApplier,
} from "./proposal-handlers.js";

// --- Test infrastructure ---

function createInMemoryStateStore(): BrokerStateStore {
  let snapshot = emptySnapshot();
  return {
    load() { return snapshot; },
    save(nextSnapshot) { snapshot = structuredClone(nextSnapshot); },
  };
}

async function startTestServer(options: Partial<BrokerServerOptions> = {}) {
  const runtime = createBrokerServer({
    host: "127.0.0.1",
    port: 0,
    stateStore: createInMemoryStateStore(),
    enforceRequesterIdentity: true,
    rateLimitMaxRequests: 100,
    workerRateLimitMaxRequests: 200,
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
    broker: runtime.broker,
  };
}

function makeApiWorker(baseUrl: string) {
  return new A2ABrokerWorker({
    brokerUrl: baseUrl,
    requesterKind: "node",
    pollIntervalMs: 25,
    heartbeatIntervalMs: 25,
    handlerTimeoutMs: 2_000,
    userAgent: "a2a-worker-test",
    handler: async () => ({}),
    worker: {
      nodeId: "worker-a",
      role: "analyst",
      displayName: "Test Worker",
      capabilities: {
        canAnalyze: true,
        canBackfill: true,
        canPatchWorkspace: true,
        canPromoteLive: false,
        workspaceIds: ["ws-test"],
        environments: ["research", "staging"],
      },
    },
  });
}

/** Create a task via broker API. Requester identity matches the body's requester field. */
async function createTaskOnBroker(
  baseUrl: string,
  body: Record<string, unknown>,
) {
  const requesterId = (body.requester as any)?.id ?? "hub-a";
  const requesterRole = (body.requester as any)?.role ?? "hub";
  const res = await fetch(`${baseUrl}/tasks`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-a2a-requester-id": requesterId,
      "x-a2a-requester-role": requesterRole,
      "x-a2a-requester-kind": "node",
    },
    body: JSON.stringify(body),
  });
  if (res.status !== 201) {
    const text = await res.text();
    throw new Error(`createTaskOnBroker failed: ${res.status} ${text}`);
  }
  return res.json();
}

function createWorkerWithHandler(baseUrl: string, handler: WorkerTaskHandler) {
  return new A2ABrokerWorker({
    brokerUrl: baseUrl,
    requesterKind: "node",
    pollIntervalMs: 25,
    heartbeatIntervalMs: 25,
    handlerTimeoutMs: 2_000,
    userAgent: "a2a-worker-test",
    handler,
    worker: {
      nodeId: "worker-a",
      role: "analyst",
      displayName: "Test Worker",
      capabilities: {
        canAnalyze: true,
        canBackfill: true,
        canPatchWorkspace: true,
        canPromoteLive: false,
        workspaceIds: ["ws-test"],
        environments: ["research", "staging"],
      },
    },
  });
}

function setupWorkersOnBroker(broker: InMemoryA2ABroker) {
  broker.registerWorker({
    nodeId: "worker-a",
    role: "analyst",
    capabilities: {
      canAnalyze: true,
      canBackfill: true,
      canPatchWorkspace: true,
      canPromoteLive: false,
      workspaceIds: ["ws-test"],
      environments: ["research", "staging"],
    },
  });
  broker.registerWorker({
    nodeId: "target-node",
    role: "live-trader",
    capabilities: {
      canAnalyze: false,
      canBackfill: false,
      canPatchWorkspace: true,
      canPromoteLive: true,
      workspaceIds: ["ws-test"],
      environments: ["live"],
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
      workspaceIds: [],
      environments: [],
    },
  });
}

function createProposalOnBroker(broker: InMemoryA2ABroker) {
  return broker.createProposal({
    source: { id: "worker-a", kind: "node", role: "analyst" },
    target: { id: "target-node", kind: "node", role: "live-trader" },
    kind: "patch",
    summary: "lower VOL_SPIKE threshold to 2.5",
    rationale: "backtest showed improved SR",
    workspace: { nodeId: "target-node", workspaceId: "ws-test" },
    patchText: '- const VOL_SPIKE = 3.0;\n+ const VOL_SPIKE = 2.5;',
  });
}

// --- Tests ---

test("validate_change: validator pass → proposal status becomes validated", async () => {
  const server = await startTestServer();
  setupWorkersOnBroker(server.broker);
  const proposal = createProposalOnBroker(server.broker);

  const apiWorker = makeApiWorker(server.baseUrl);
  const validator: ProposalValidator = {
    async validate() {
      return {
        verdict: "pass",
        kind: "backfill",
        metrics: { sr_improvement: 0.3 },
        note: "30d backtest positive",
      };
    },
  };

  const worker = createWorkerWithHandler(server.baseUrl, createIntentRouter({
    handlers: [{
      intent: "validate_change",
      handler: createValidateProposalHandler(apiWorker, validator),
    }],
  }));

  try {
    await worker.register();
    const task = await createTaskOnBroker(server.baseUrl, {
      intent: "validate_change",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "target-node", kind: "node", role: "live-trader" },
      assignedWorkerId: "worker-a",
      proposalId: proposal.id,
      message: "validate",
    });

    assert.equal(await worker.runOnce(), 1);

    const completed = await (await fetch(`${server.baseUrl}/tasks/${task.id}`)).json();
    assert.equal(completed.status, "succeeded");
    assert.match(completed.result.summary, /validation pass/);

    const details = server.broker.getProposalDetails(proposal.id)!;
    assert.equal(details.proposal.status, "validated");
    assert.equal(details.validations[0].verdict, "pass");
    assert.equal(details.validations[0].nodeId, "worker-a");
  } finally {
    await worker.stop();
    await server.close();
  }
});

test("validate_change: validator fail → proposal still marked validated with fail verdict", async () => {
  const server = await startTestServer();
  setupWorkersOnBroker(server.broker);
  const proposal = createProposalOnBroker(server.broker);

  const apiWorker = makeApiWorker(server.baseUrl);
  const validator: ProposalValidator = {
    async validate() {
      return { verdict: "fail", kind: "replay", metrics: { sr_change: -0.5 }, note: "SR degrades" };
    },
  };

  const worker = createWorkerWithHandler(server.baseUrl, createIntentRouter({
    handlers: [{
      intent: "validate_change",
      handler: createValidateProposalHandler(apiWorker, validator),
    }],
  }));

  try {
    await worker.register();
    const task = await createTaskOnBroker(server.baseUrl, {
      intent: "validate_change",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "target-node", kind: "node", role: "live-trader" },
      assignedWorkerId: "worker-a",
      proposalId: proposal.id,
      message: "validate",
    });

    await worker.runOnce();

    const details = server.broker.getProposalDetails(proposal.id)!;
    assert.equal(details.proposal.status, "validated");
    assert.equal(details.validations[0].verdict, "fail");
  } finally {
    await worker.stop();
    await server.close();
  }
});

test("validate_change: non-existent proposal → task fails with proposal_not_found", async () => {
  const server = await startTestServer();
  setupWorkersOnBroker(server.broker);

  const apiWorker = makeApiWorker(server.baseUrl);
  const validator: ProposalValidator = {
    async validate() { return { verdict: "pass", kind: "backfill" }; },
  };

  const worker = createWorkerWithHandler(server.baseUrl, createIntentRouter({
    handlers: [{
      intent: "validate_change",
      handler: createValidateProposalHandler(apiWorker, validator),
    }],
  }));

  try {
    await worker.register();
    // Create task without proposalId to bypass broker check,
    // then set it so the handler thinks it has one
    const task = server.broker.createTask({
      intent: "validate_change",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "target-node", kind: "node", role: "live-trader" },
      assignedWorkerId: "worker-a",
      message: "validate",
    });
    // Mutate proposalId so handler tries to fetch nonexistent proposal
    task.proposalId = "nonexistent-id";

    await worker.runOnce();

    const failed = await (await fetch(`${server.baseUrl}/tasks/${task.id}`)).json();
    assert.equal(failed.status, "failed");
    assert.equal(failed.error.code, "proposal_not_found");
  } finally {
    await worker.stop();
    await server.close();
  }
});

test("apply_local_change: approved proposal → status becomes applied", async () => {
  const server = await startTestServer();
  setupWorkersOnBroker(server.broker);
  const proposal = createProposalOnBroker(server.broker);

  // Register an operator node so it can approve proposals
  server.broker.registerWorker({
    nodeId: "operator-1",
    role: "operator",
    capabilities: {
      canAnalyze: false, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false,
      workspaceIds: [], environments: [],
    },
  });

  // Approve proposal via operator
  server.broker.approveProposal(proposal.id, {
    actor: { id: "operator-1", kind: "node", role: "operator" },
    note: "approved",
  });

  // Verify status is approved before apply
  const preApply = server.broker.getProposalDetails(proposal.id)!;
  if (preApply.proposal.status !== "approved") {
    throw new Error(`expected approved, got ${preApply.proposal.status}`);
  }

  // The applying worker must be target-node (policy: only target node or operator)
  const apiWorkerTarget = new A2ABrokerWorker({
    brokerUrl: server.baseUrl,
    requesterKind: "node",
    pollIntervalMs: 25,
    heartbeatIntervalMs: 25,
    handlerTimeoutMs: 2_000,
    userAgent: "a2a-worker-test",
    handler: async () => ({}),
    worker: {
      nodeId: "target-node",
      role: "live-trader",
      displayName: "Target Node",
      capabilities: {
        canAnalyze: false, canBackfill: false, canPatchWorkspace: true, canPromoteLive: true,
        workspaceIds: ["ws-test"], environments: ["live", "staging"],
      },
    },
  });

  const applier: ProposalApplier = {
    async apply(task) {
      return { note: `applied to ${task.workspace?.workspaceId}` };
    },
  };

  const worker = createWorkerWithHandler(server.baseUrl, createIntentRouter({
    handlers: [{
      intent: "apply_local_change",
      handler: createApplyProposalHandler(applier),
    }],
  }));

  // Override worker ID to target-node for policy compliance
  const targetWorker = new A2ABrokerWorker({
    brokerUrl: server.baseUrl,
    requesterKind: "node",
    pollIntervalMs: 25,
    heartbeatIntervalMs: 25,
    handlerTimeoutMs: 2_000,
    userAgent: "a2a-worker-test",
    handler: createIntentRouter({
      handlers: [{
        intent: "apply_local_change",
        handler: createApplyProposalHandler(applier),
      }],
    }),
    worker: {
      nodeId: "target-node",
      role: "live-trader",
      displayName: "Target Node",
      capabilities: {
        canAnalyze: false, canBackfill: false, canPatchWorkspace: true, canPromoteLive: true,
        workspaceIds: ["ws-test"], environments: ["live", "staging"],
      },
    },
  });

  try {
    await targetWorker.register();
    const task = server.broker.createTask({
      intent: "apply_local_change",
      requester: { id: "operator-1", kind: "node", role: "operator" },
      target: { id: "target-node", kind: "node", role: "live-trader" },
      assignedWorkerId: "target-node",
      proposalId: proposal.id,
      workspace: { nodeId: "target-node", workspaceId: "ws-test" },
      message: "apply",
    });

    assert.equal(await targetWorker.runOnce(), 1);

    const completed = await (await fetch(`${server.baseUrl}/tasks/${task.id}`)).json();
    assert.equal(completed.status, "succeeded");
    assert.match(completed.result.summary, /applied proposal/);

    const details = server.broker.getProposalDetails(proposal.id)!;
    assert.equal(details.proposal.status, "applied");
  } finally {
    await targetWorker.stop();
    await server.close();
  }
});

test("propose_patch: creates new patch proposal on broker", async () => {
  const server = await startTestServer();
  setupWorkersOnBroker(server.broker);

  const apiWorker = makeApiWorker(server.baseUrl);
  const worker = createWorkerWithHandler(server.baseUrl, createIntentRouter({
    handlers: [{
      intent: "propose_patch",
      handler: createProposePatchHandler(apiWorker),
    }],
  }));

  try {
    await worker.register();
    const task = await createTaskOnBroker(server.baseUrl, {
      intent: "propose_patch",
      requester: { id: "worker-a", kind: "node", role: "analyst" },
      target: { id: "target-node", kind: "node", role: "live-trader" },
      assignedWorkerId: "worker-a",
      workspace: { nodeId: "target-node", workspaceId: "ws-test" },
      message: "propose patch",
      payload: {
        targetNodeId: "target-node",
        summary: "update threshold",
        patchText: "- old\n+ new",
      },
    });

    assert.equal(await worker.runOnce(), 1);

    const completed = await (await fetch(`${server.baseUrl}/tasks/${task.id}`)).json();
    assert.equal(completed.status, "succeeded");
    assert.match(completed.result.summary, /created patch proposal/);
    assert.ok(completed.result.output.proposalId);

    const proposals = server.broker.listProposals();
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].kind, "patch");
    assert.equal(proposals[0].summary, "update threshold");
  } finally {
    await worker.stop();
    await server.close();
  }
});

test("propose_params: creates new params proposal on broker", async () => {
  const server = await startTestServer();
  setupWorkersOnBroker(server.broker);

  const apiWorker = makeApiWorker(server.baseUrl);
  const worker = createWorkerWithHandler(server.baseUrl, createIntentRouter({
    handlers: [{
      intent: "propose_params",
      handler: createProposeParamsHandler(apiWorker),
    }],
  }));

  try {
    await worker.register();
    const task = await createTaskOnBroker(server.baseUrl, {
      intent: "propose_params",
      requester: { id: "worker-a", kind: "node", role: "analyst" },
      target: { id: "target-node", kind: "node", role: "live-trader" },
      assignedWorkerId: "worker-a",
      workspace: { nodeId: "target-node", workspaceId: "ws-test" },
      message: "propose params",
      payload: {
        targetNodeId: "target-node",
        summary: "update VOL_SPIKE to 2.5",
        parameterPayload: { VOL_SPIKE: 2.5, VOL_SPIKE_USD: 5000 },
        rationale: "backtest improvement",
      },
    });

    assert.equal(await worker.runOnce(), 1);

    const completed = await (await fetch(`${server.baseUrl}/tasks/${task.id}`)).json();
    assert.equal(completed.status, "succeeded");

    const proposals = server.broker.listProposals();
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].kind, "params");
    assert.deepEqual(proposals[0].parameterPayload, { VOL_SPIKE: 2.5, VOL_SPIKE_USD: 5000 });
  } finally {
    await worker.stop();
    await server.close();
  }
});

test("propose_patch: missing required payload fields → task fails", async () => {
  const server = await startTestServer();
  setupWorkersOnBroker(server.broker);

  const apiWorker = makeApiWorker(server.baseUrl);
  const worker = createWorkerWithHandler(server.baseUrl, createIntentRouter({
    handlers: [{
      intent: "propose_patch",
      handler: createProposePatchHandler(apiWorker),
    }],
  }));

  try {
    await worker.register();
    // Create task directly via broker to avoid extra validation
    const task = server.broker.createTask({
      intent: "propose_patch",
      requester: { id: "worker-a", kind: "node", role: "analyst" },
      target: { id: "worker-a", kind: "node", role: "analyst" },
      assignedWorkerId: "worker-a",
      message: "incomplete",
      payload: {},
    });

    await worker.runOnce();

    const taskResponse = await fetch(`${server.baseUrl}/tasks/${task.id}`);
    assert.equal(taskResponse.status, 200);
    const failed = await taskResponse.json();
    assert.equal(failed.status, "failed");
    assert.ok(failed.error);
    assert.equal(failed.error.code, "missing_payload_field");
  } finally {
    await worker.stop();
    await server.close();
  }
});
