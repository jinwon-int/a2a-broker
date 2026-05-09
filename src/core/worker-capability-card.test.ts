import assert from "node:assert/strict";
import { test } from "node:test";

import {
  WORKER_CAPABILITY_CARD_SCHEMA_VERSION,
  createWorkerCapabilityCard,
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
