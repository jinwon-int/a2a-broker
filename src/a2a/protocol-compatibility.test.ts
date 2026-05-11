import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createBrokerAgentCard } from "./agent-card.js";
import { projectBrokerTask, projectBrokerTaskForList } from "./task-projection.js";
import type { TaskRecord, TaskStatus } from "../core/types.js";
import {
  A2A_AGENT_CARD_GOLDEN,
  A2A_COMPATIBILITY_PROFILE,
  A2A_TASK_PROJECTION_GOLDEN,
} from "../fixtures/a2a-protocol-compatibility.js";
import type { AgentCapabilities } from "./agent-card.js";
import type { WorkerCapabilities } from "../core/types.js";

const BASE_TIME = "2026-05-04T00:00:00.000Z";
const UPDATED_TIME = "2026-05-04T00:00:05.000Z";
const COMPLETED_TIME = "2026-05-04T00:00:10.000Z";

function makeTask(status: TaskStatus, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task-compat-golden",
    exchangeId: "exchange-compat-golden",
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    message: "analyze compatibility",
    assignedWorkerId: "worker-a",
    status,
    targetNodeId: "worker-a",
    payload: {},
    createdAt: BASE_TIME,
    updatedAt: UPDATED_TIME,
    ...overrides,
  };
}

test("A2A compatibility document declares the gated public profile", () => {
  const doc = readFileSync("docs/protocol-compatibility.md", "utf8");

  assert.match(doc, /Current profile: A2A 1\.0-compatible broker alpha profile/);
  assert.match(doc, /protocolVersion: `?"1\.0"`?/);
  assert.match(doc, /push notification capability: `?false`?/i);

  for (const method of A2A_COMPATIBILITY_PROFILE.jsonRpcMethods) {
    assert.match(doc, new RegExp(`\\b${method}\\b`), `${method} must remain documented`);
  }

  for (const state of A2A_COMPATIBILITY_PROFILE.taskStates) {
    assert.match(doc, new RegExp(`\\b${state}\\b`), `${state} must remain documented`);
  }

  assert.match(doc, /A2A 0\.3 compatibility mode/i);
  assert.match(doc, /Full official A2A 1\.0 conformance/i);
});

test("agent card stays aligned with the documented A2A profile", () => {
  const card = createBrokerAgentCard({
    serviceName: "compat-broker",
    publicBaseUrl: "https://broker.example.com/",
    supportsStreaming: true,
    supportsPushNotifications: false,
  });

  assert.deepEqual(
    {
      protocolVersion: card.protocolVersion,
      capabilities: card.capabilities,
      defaultInputModes: card.defaultInputModes,
      defaultOutputModes: card.defaultOutputModes,
    },
    A2A_AGENT_CARD_GOLDEN,
  );
  assert.equal(card.url, "https://broker.example.com/a2a/jsonrpc");
});

test("task projection shape is pinned for A2A compatibility", () => {
  const projection = projectBrokerTask(
    makeTask("succeeded", {
      claimedBy: "worker-a",
      completedAt: COMPLETED_TIME,
      result: {
        summary: "completed golden result",
        artifactIds: ["artifact-1"],
      },
    }),
  );

  assert.deepEqual(Object.keys(projection).sort(), [...A2A_COMPATIBILITY_PROFILE.projectionKeys]);
  assert.deepEqual(Object.keys(projection.metadata).sort(), [...A2A_COMPATIBILITY_PROFILE.metadataKeys]);
  assert.deepEqual(projection, A2A_TASK_PROJECTION_GOLDEN);
});

test("task projection exposes A2A context and reference task lineage without expanding prior task internals", () => {
  const projection = projectBrokerTask(makeTask("queued", {
    id: "follow-up-task",
    exchangeId: "context-123",
    referenceTaskIds: ["prior-terminal-task"],
  }));

  assert.equal(projection.metadata.contextId, "context-123");
  assert.deepEqual(projection.metadata.referenceTaskIds, ["prior-terminal-task"]);
  assert.equal(JSON.stringify(projection).includes("prior task result"), false);
});

test("internal broker task statuses keep their documented A2A state mapping", () => {
  for (const [internalStatus, a2aState] of Object.entries(A2A_COMPATIBILITY_PROFILE.internalStatusToA2AState)) {
    const projection = projectBrokerTask(makeTask(internalStatus as TaskStatus));
    assert.equal(projection.status.state, a2aState, `${internalStatus} should project as ${a2aState}`);
  }
});

test("list projection keeps result details summarized and artifacts stable", () => {
  const projection = projectBrokerTaskForList(
    makeTask("succeeded", {
      completedAt: COMPLETED_TIME,
      result: {
        summary: "completed golden result",
        note: "longer private note",
        artifactIds: ["artifact-1"],
        output: { verbose: true },
      },
    }),
  );

  assert.deepEqual(Object.keys(projection.metadata).sort(), [...A2A_COMPATIBILITY_PROFILE.listMetadataKeys]);
  assert.equal(projection.metadata.resultSummary, "completed golden result");
  assert.equal("result" in projection.metadata, false);
  assert.deepEqual(projection.artifacts, [{ id: "artifact-1" }]);
});

// ---------------------------------------------------------------------------
// AgentCard capabilities vs WorkerCapabilities shape guard (#433)
// ---------------------------------------------------------------------------

test("AgentCard.capabilities and WorkerCapabilities are disjoint public-seam shapes", () => {
  // AgentCard.capabilities carries A2A protocol-level flags.
  const agentCardCapabilityKeys: ReadonlyArray<keyof AgentCapabilities> = ["streaming", "pushNotifications"] as const;

  // WorkerCapabilities carries broker-internal worker runtime abilities.
  const workerCapabilityKeys: ReadonlyArray<keyof WorkerCapabilities> = [
    "canAnalyze", "canBackfill", "canPatchWorkspace", "canPromoteLive",
    "workspaceIds", "environments",
  ] as const;

  // They MUST NOT share any key names. Accidental overlap would mean a
  // public A2A client could interpret worker runtime data or vice versa.
  const agentCardKeys = new Set<string>(agentCardCapabilityKeys);
  for (const key of workerCapabilityKeys) {
    assert.ok(
      !agentCardKeys.has(key),
      `WorkerCapabilities key "${key}" must not appear in AgentCard.capabilities`,
    );
  }

  // AgentCard.capabilities values are booleans; WorkerCapabilities has arrays too.
  // This structural difference guards against accidental shape convergence.
  assert.ok(
    workerCapabilityKeys.some((k) => k === "workspaceIds" || k === "environments"),
    "WorkerCapabilities must contain array-typed fields distinct from AgentCard.capabilities",
  );
});
