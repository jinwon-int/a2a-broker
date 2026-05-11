import assert from "node:assert/strict";
import { test } from "node:test";

import {
  WORKER_CAPABILITY_CARD_SCHEMA_VERSION,
  createWorkerCapabilityCard,
  queryWorkerCapabilityCards,
  validateWorkerCapabilityCard,
  type WorkerCapabilityCard,
} from "./worker-capability-card.js";
import type { WorkerView } from "./types.js";

const BASE_WORKER: WorkerView = {
  nodeId: "yukson",
  role: "analyst",
  displayName: "Yukson libero",
  brokerUrl: "http://10.0.0.2:3000",
  capabilities: {
    canAnalyze: true,
    canBackfill: true,
    canPatchWorkspace: false,
    canPromoteLive: false,
    workspaceIds: ["private-workspace"],
    environments: ["research", "staging"],
  },
  workerMode: "mobile",
  metadata: {
    teamId: "team1",
    edgeSecret: "should-not-leak",
  },
  createdAt: "2026-05-08T00:00:00.000Z",
  updatedAt: "2026-05-08T00:01:00.000Z",
  lastSeenAt: "2026-05-08T00:01:00.000Z",
  status: "online",
};

const LIBERO_SKILL = {
  id: "libero-validation",
  name: "Libero validation",
  description: "Independent assignment-safety validation before Team1/Team2 routing changes.",
  tags: ["validation", "safety", "libero"],
};

test("worker capability card projects Team1 libero metadata without leaking private worker fields", () => {
  const card = createWorkerCapabilityCard(BASE_WORKER, {
    teamId: "team1",
    brokerOfRecord: "seoseo",
    assignmentRoles: ["libero"],
    supportedTaskTypes: ["analyze", "validate_change"],
    skills: [LIBERO_SKILL],
    visibility: {
      scope: "public",
      safeForDiscovery: true,
      exposeCapacity: true,
      exposeLiveness: false,
    },
    libero: {
      validatesTeams: ["team1", "team2"],
      authority: "advisory",
      safeToAssignProduction: false,
    },
    maxConcurrentTasks: 1,
    currentAssignedTasks: 0,
  });

  assert.equal(card.schemaVersion, WORKER_CAPABILITY_CARD_SCHEMA_VERSION);
  assert.equal(card.worker.id, "yukson");
  assert.deepEqual(card.team, { teamId: "team1", brokerOfRecord: "seoseo", lane: "team1" });
  assert.deepEqual(card.assignment.roles, ["libero"]);
  assert.deepEqual(card.assignment.libero?.validatesTeams, ["team1", "team2"]);
  assert.equal(card.visibility.scope, "public");
  assert.equal(card.visibility.exposeBrokerUrl, false);
  assert.equal(card.visibility.exposeWorkspaceIds, false);
  assert.deepEqual(card.capabilities.workspaceIds, []);
  assert.equal(card.liveness, undefined);
  assert.equal(JSON.stringify(card).includes("should-not-leak"), false);
  assert.equal(JSON.stringify(card).includes("10.0.0.2"), false);

  assert.deepEqual(validateWorkerCapabilityCard(card), { ok: true, errors: [] });
});

test("worker capability card maps Team2 dungae discovery to public AgentCard-style fields", () => {
  const dungaeWorker: WorkerView = {
    nodeId: "dungae",
    role: "researcher",
    displayName: "Dungae docs/compat",
    brokerUrl: "http://192.0.2.23:3000",
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: false,
      canPromoteLive: false,
      workspaceIds: ["team2-private-workspace"],
      environments: ["research"],
    },
    workerMode: "persistent",
    metadata: {
      teamId: "team2",
      terminalOutboxId: "private-terminal-id",
    },
    createdAt: "2026-05-09T00:00:00.000Z",
    updatedAt: "2026-05-09T00:01:00.000Z",
    lastSeenAt: "2026-05-09T00:01:00.000Z",
    status: "online",
  };

  const card = createWorkerCapabilityCard(dungaeWorker, {
    teamId: "team2",
    lane: "team2",
    brokerOfRecord: "gwakga",
    assignmentRoles: ["docs-compat"],
    supportedTaskTypes: ["analyze", "validate_change"],
    skills: [
      {
        id: "agent-card-public-seam-review",
        name: "AgentCard public seam review",
        description: "Review public-safe AgentCard and capability-registry fields for #432 readiness.",
        tags: ["agent-card", "capability-registry", "public-safe"],
      },
    ],
    visibility: {
      scope: "public",
      safeForDiscovery: true,
      exposeCapacity: true,
      exposeLiveness: false,
    },
    maxConcurrentTasks: 1,
    currentAssignedTasks: 0,
    safetyBoundaries: [
      "broker-owned assignment only",
      "no live provider send",
      "no terminal-outbox ACK",
      "operator approval required for live impact",
    ],
  });

  assert.deepEqual(card.team, { teamId: "team2", brokerOfRecord: "gwakga", lane: "team2" });
  assert.deepEqual(card.assignment.roles, ["docs-compat"]);
  assert.deepEqual(card.assignment.supportedTaskTypes, ["analyze", "validate_change"]);
  assert.deepEqual(card.assignment.environments, ["research"]);
  assert.deepEqual(card.capabilities.workspaceIds, []);
  assert.equal(card.safety.canTouchLive, false);
  assert.equal(card.safety.requiresApprovalForLive, true);
  assert.match(card.safety.boundaries.join("\n"), /broker-owned assignment only/);
  assert.deepEqual(Object.keys(card.agentCard).sort(), [
    "capabilities",
    "defaultInputModes",
    "defaultOutputModes",
    "protocolVersion",
    "skills",
  ]);
  assert.deepEqual(card.agentCard.capabilities, { streaming: true, pushNotifications: false });
  assert.equal(card.visibility.exposeBrokerUrl, false);
  assert.equal(card.visibility.exposeWorkspaceIds, false);
  assert.equal(card.liveness, undefined);

  const serialized = JSON.stringify(card);
  assert.equal(serialized.includes("192.0.2.23"), false);
  assert.equal(serialized.includes("team2-private-workspace"), false);
  assert.equal(serialized.includes("private-terminal-id"), false);

  assert.deepEqual(validateWorkerCapabilityCard(card), { ok: true, errors: [] });
});

test("worker capability card query selects valid workers by team, role, task, environment, and skill", () => {
  const team1Impl = createWorkerCapabilityCard({ ...BASE_WORKER, nodeId: "team1-impl" }, {
    teamId: "team1",
    brokerOfRecord: "seoseo",
    assignmentRoles: ["implementation"],
    supportedTaskTypes: ["propose_patch", "apply_local_change"],
    skills: [{ id: "implementation", name: "Implementation", description: "Patch implementation worker." }],
    visibility: { scope: "team", safeForDiscovery: false },
  });
  const team2Docs = createWorkerCapabilityCard({ ...BASE_WORKER, nodeId: "team2-docs", role: "researcher" }, {
    teamId: "team2",
    lane: "team2",
    brokerOfRecord: "gwakga",
    assignmentRoles: ["docs-compat"],
    supportedTaskTypes: ["analyze", "validate_change"],
    skills: [{ id: "docs-compat", name: "Docs compat", description: "Documentation and compatibility review." }],
    visibility: { scope: "public", safeForDiscovery: true, exposeLiveness: false },
  });
  const unsafe = { ...team2Docs, visibility: { ...team2Docs.visibility, exposeBrokerUrl: true } };

  assert.deepEqual(
    queryWorkerCapabilityCards([team1Impl, team2Docs, unsafe], {
      teamId: "team2",
      assignmentRole: "docs-compat",
      taskType: "validate_change",
      environment: "research",
      skillId: "docs-compat",
      safeForDiscovery: true,
    }).map((card) => card.worker.id),
    ["team2-docs"],
  );
});

test("worker capability card validation fails closed for unsafe public visibility", () => {
  const card = createWorkerCapabilityCard(BASE_WORKER, {
    teamId: "team2",
    brokerOfRecord: "gwakga",
    assignmentRoles: ["implementation"],
    supportedTaskTypes: ["propose_patch"],
    skills: [
      {
        id: "implementation",
        name: "Implementation",
        description: "Patch implementation worker.",
      },
    ],
    visibility: {
      scope: "public",
      safeForDiscovery: false,
      exposeBrokerUrl: true,
      exposeWorkspaceIds: true,
    },
  });

  const result = validateWorkerCapabilityCard(card);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /safeForDiscovery=true/);
  assert.match(result.errors.join("\n"), /must not expose brokerUrl/);
  assert.match(result.errors.join("\n"), /must not expose workspaceIds/);
});

test("worker capability card validation rejects secret-like extension fields", () => {
  const card = createWorkerCapabilityCard(BASE_WORKER, {
    teamId: "team1",
    brokerOfRecord: "seoseo",
    assignmentRoles: ["runner-safety"],
    supportedTaskTypes: ["analyze"],
    skills: [
      {
        id: "runner-safety",
        name: "Runner safety",
        description: "Checks runner evidence and safe boundaries.",
      },
    ],
  }) as WorkerCapabilityCard & { rawMetadata?: Record<string, string> };

  card.rawMetadata = { githubToken: "ghp_exampletoken" };

  const result = validateWorkerCapabilityCard(card);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /rawMetadata\.githubToken/);
});
