import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildA2AWorkerSubagentOrchestrationPolicy,
  renderA2AWorkerSubagentOrchestrationPolicyMarkdown,
} from "./worker-subagent-orchestration-policy.js";

const NOW = "2026-05-19T01:10:00.000Z";

test("large independent task can recommend three evidence-only subagents", () => {
  const fixture = JSON.parse(readFileSync("fixtures/worker-subagent-orchestration/large-healthy.json", "utf8"));
  const packet = buildA2AWorkerSubagentOrchestrationPolicy({ ...fixture, now: NOW });

  assert.equal(packet.kind, "a2a-broker.worker-subagent-orchestration-policy.packet");
  assert.equal(packet.decision.parallelismHint, 3);
  assert.deepEqual(packet.decision.recommendedSubagents.map((agent) => agent.role), ["explorer", "implementer", "verifier"]);
  assert.equal(packet.decision.oneFinalizerRequired, true);
  assert.equal(packet.decision.evidenceOnlySubagents, true);
  assert.equal(packet.boundaries.runtimeBehaviorChanged, false);
  assert.equal(packet.boundaries.mandatoryProductionSpawn, false);
  assert.equal(packet.boundaries.brokerDispatchSemanticsChanged, false);
  assert.equal(packet.boundaries.dbMutation, false);
});

test("memory pressure and event loop degradation reduce to direct execution", () => {
  const packet = buildA2AWorkerSubagentOrchestrationPolicy({
    now: NOW,
    task: { taskId: "task-1", size: "large", coupling: "low", hasIndependentSubtasks: true, writeSets: ["src/a.ts", "src/b.ts"] },
    host: { workerId: "worker-a", cpuLoadPct: 40, memoryUsedPct: 91, eventLoopDegraded: true, activeSubagents: 0, workerSubagentCap: 3 },
  });

  assert.equal(packet.decision.parallelismHint, 0);
  assert.equal(packet.resourceGate.memoryOk, false);
  assert.equal(packet.resourceGate.eventLoopOk, false);
  assert.equal(packet.nextAction, "run direct or wait for host capacity before spawning subagents");
});

test("small or tightly coupled tasks avoid excess subagent overhead", () => {
  const small = buildA2AWorkerSubagentOrchestrationPolicy({
    now: NOW,
    task: { taskId: "task-small", size: "small", coupling: "medium", hasIndependentSubtasks: false },
    host: { workerId: "worker-a", cpuLoadPct: 20, memoryUsedPct: 30, workerSubagentCap: 3 },
  });
  const sensitive = buildA2AWorkerSubagentOrchestrationPolicy({
    now: NOW,
    task: { taskId: "task-sensitive", size: "large", coupling: "low", sensitive: true, hasIndependentSubtasks: true },
    host: { workerId: "worker-a", cpuLoadPct: 20, memoryUsedPct: 30, workerSubagentCap: 3 },
  });

  assert.equal(small.decision.parallelismHint, 1);
  assert.equal(sensitive.decision.parallelismHint, 0);
  assert.equal(sensitive.decision.escapeHatchAllowed, true);
});

test("markdown renders policy without implying runtime rollout", () => {
  const packet = buildA2AWorkerSubagentOrchestrationPolicy({
    now: NOW,
    task: { taskId: "task-2", size: "medium", coupling: "low", hasIndependentSubtasks: true },
    host: { workerId: "worker-b", cpuLoadPct: 25, memoryUsedPct: 40, activeSubagents: 0, workerSubagentCap: 2 },
  });
  const markdown = renderA2AWorkerSubagentOrchestrationPolicyMarkdown(packet);

  assert.equal(packet.decision.parallelismHint, 2);
  assert.equal(markdown.includes("source-only policy"), true);
  assert.equal(markdown.includes("no mandatory production spawn"), true);
});
