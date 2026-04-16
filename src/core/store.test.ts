import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InMemoryA2ABroker } from "./broker.js";
import { JsonFileBrokerStateStore } from "./store.js";
import type { A2APartyRole, RegisterWorkerRequest } from "./types.js";

function registerWorker(
  broker: InMemoryA2ABroker,
  nodeId: string,
  role: A2APartyRole,
  options: {
    workspaceIds?: string[];
    environments?: Array<"research" | "staging" | "live">;
    canAnalyze?: boolean;
    canBackfill?: boolean;
    canPatchWorkspace?: boolean;
    canPromoteLive?: boolean;
  } = {},
): void {
  const request: RegisterWorkerRequest = {
    nodeId,
    role,
    capabilities: {
      canAnalyze: options.canAnalyze ?? (role === "analyst" || role === "researcher"),
      canBackfill: options.canBackfill ?? false,
      canPatchWorkspace: options.canPatchWorkspace ?? role === "live-trader",
      canPromoteLive: options.canPromoteLive ?? role === "live-trader",
      workspaceIds: options.workspaceIds ?? ["ws-live"],
      environments: options.environments ?? [role === "live-trader" ? "live" : "research"],
    },
  };
  broker.registerWorker(request);
}

test("file-backed reload preserves proposal/apply lifecycle and exchange task state", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "a2a-broker-store-"));
  const stateFile = join(tempDir, "state.json");
  const store = new JsonFileBrokerStateStore(stateFile);
  const broker = new InMemoryA2ABroker(store, store.load());

  try {
    registerWorker(broker, "research-a", "researcher", {
      canAnalyze: true,
      canBackfill: true,
      environments: ["research"],
    });
    registerWorker(broker, "live-a", "live-trader", {
      canPatchWorkspace: true,
      canPromoteLive: true,
      environments: ["live"],
    });

    const exchange = broker.startExchange({
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "live-a", kind: "node", role: "live-trader" },
      message: "apply the reviewed change",
      intent: "apply_local_change",
    });

    broker.addExchangeMessage(exchange.id, {
      actor: { id: "hub-a", kind: "node", role: "hub" },
      message: "accepted",
      decision: "accepted",
      targetNodeId: "live-a",
      assignedWorkerId: "live-a",
    });

    const taskId = broker.getExchange(exchange.id)?.activeTaskId;
    assert.ok(taskId);
    broker.claimTask(taskId, "live-a");
    broker.startTask(taskId, "live-a");
    broker.completeTask(taskId, "live-a", { summary: "exchange completed" });

    const proposal = broker.createProposal({
      source: { id: "research-a", kind: "node", role: "researcher" },
      target: { id: "live-a", kind: "node", role: "live-trader" },
      kind: "patch",
      summary: "tighten the live threshold",
      workspace: { nodeId: "live-a", workspaceId: "ws-live" },
      patchText: "diff --git a/config.ts b/config.ts",
    });

    const artifact = broker.attachArtifact(proposal.id, {
      kind: "patch",
      uri: "file:///tmp/proposal.diff",
      summary: "candidate diff",
    });

    broker.submitValidationResult(proposal.id, {
      nodeId: "research-a",
      kind: "smoke",
      verdict: "pass",
      artifactIds: [artifact.id],
      note: "smoke passed",
    });

    broker.approveProposal(proposal.id, {
      actor: { id: "live-a", kind: "node", role: "live-trader" },
      note: "target approved",
    });

    broker.applyProposalLocally(proposal.id, {
      actor: { id: "live-a", kind: "node", role: "live-trader" },
      workspace: { nodeId: "live-a", workspaceId: "ws-live" },
      note: "applied locally",
    });

    const reloaded = new InMemoryA2ABroker(store, store.load());

    const reloadedTask = reloaded.getTask(taskId);
    assert.ok(reloadedTask);
    assert.equal(reloadedTask.status, "succeeded");
    assert.equal(reloadedTask.result?.summary, "exchange completed");

    const reloadedExchange = reloaded.getExchange(exchange.id);
    assert.ok(reloadedExchange);
    assert.equal(reloadedExchange.status, "completed");
    assert.equal(reloadedExchange.activeTaskId, taskId);
    assert.equal(reloadedExchange.currentDecision, "accepted");

    const proposalDetails = reloaded.getProposalDetails(proposal.id);
    assert.ok(proposalDetails);
    assert.equal(proposalDetails.proposal.status, "applied");
    assert.equal(proposalDetails.artifacts.length, 1);
    assert.equal(proposalDetails.validations.length, 1);

    const actions = proposalDetails.audit.map((event) => event.action);
    assert.ok(actions.includes("proposal.created"));
    assert.ok(actions.includes("artifact.attached"));
    assert.ok(actions.includes("validation.submitted"));
    assert.ok(actions.includes("proposal.approved"));
    assert.ok(actions.includes("proposal.applied"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
