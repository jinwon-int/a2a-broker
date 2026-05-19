import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildA2AWorkerSelfAssessmentCapacity,
  extractA2AWorkerSelfAssessmentCapacityInput,
  renderA2AWorkerSelfAssessmentCapacityMarkdown,
} from "./worker-self-assessment-capacity.js";

const NOW = "2026-05-19T01:55:00.000Z";

test("worker self-assessment emits planner-ready supplied snapshot packet", () => {
  const fixture = JSON.parse(readFileSync("fixtures/worker-subagent-orchestration/self-assessment-healthy.json", "utf8"));
  const packet = buildA2AWorkerSelfAssessmentCapacity({ ...fixture, now: NOW });

  assert.equal(packet.kind, "a2a-broker.worker-self-assessment-capacity.packet");
  assert.equal(packet.generatedAt, NOW);
  assert.equal(packet.workerId, "bangtong");
  assert.equal(packet.sourceOnly, true);
  assert.equal(packet.source.suppliedSnapshotOnly, true);
  assert.equal(packet.source.probesHost, false);
  assert.equal(packet.source.probesGateway, false);
  assert.equal(packet.readiness.plannerInputReady, true);
  assert.deepEqual(packet.readiness.missing, []);
  assert.equal(packet.plannerInput?.host.workerId, "bangtong");
  assert.equal(packet.plannerInput?.task.taskId, "task-large-independent");
  assert.equal(packet.boundaries.actualSubagentSpawn, false);
  assert.equal(packet.boundaries.brokerDispatch, false);
  assert.equal(packet.boundaries.taskFlowMutation, false);
  assert.equal(packet.boundaries.dbMutation, false);
});

test("missing capacity fields block planner input without probing live state", () => {
  const packet = buildA2AWorkerSelfAssessmentCapacity({
    now: NOW,
    workerId: "worker-low-context",
    host: { cpuLoadPct: 20 },
  });

  assert.equal(packet.readiness.plannerInputReady, false);
  assert.equal(packet.plannerInput, undefined);
  assert.deepEqual(packet.readiness.missing, [
    "task",
    "host.memoryUsedPct",
    "host.activeSubagents",
    "host.workerSubagentCap",
    "host.brokerActiveSubagents",
    "host.brokerSubagentCap",
  ]);
  assert.equal(packet.boundaries.liveHostProbe, false);
});

test("extractor accepts route-style envelopes and snake_case fields", () => {
  const input = extractA2AWorkerSelfAssessmentCapacityInput({
    workerSelfAssessment: {
      now: NOW,
      worker_id: "worker-snake",
      task: {
        task_id: "task-snake",
        size: "medium",
        coupling: "low",
        has_independent_subtasks: true,
      },
      host: {
        cpu_load_pct: 33,
        memory_used_pct: 44,
        io_pressure: "medium",
        event_loop_degraded: false,
        gateway_pressure: "low",
        active_subagents: 1,
        worker_subagent_cap: 3,
        broker_active_subagents: 2,
        broker_subagent_cap: 12,
      },
      source: {
        collector: "worker-runtime",
        observed_at: NOW,
      },
    },
  });
  const packet = buildA2AWorkerSelfAssessmentCapacity(input);

  assert.equal(packet.workerId, "worker-snake");
  assert.equal(packet.task?.taskId, "task-snake");
  assert.equal(packet.host.memoryUsedPct, 44);
  assert.equal(packet.host.ioPressure, "medium");
  assert.equal(packet.source.collector, "worker-runtime");
  assert.equal(packet.readiness.plannerInputReady, true);
});

test("markdown states source-only no-runtime boundary", () => {
  const packet = buildA2AWorkerSelfAssessmentCapacity({
    now: NOW,
    workerId: "worker-a",
    task: { taskId: "task-a", size: "small", coupling: "medium" },
    host: {
      cpuLoadPct: 10,
      memoryUsedPct: 20,
      activeSubagents: 0,
      workerSubagentCap: 2,
      brokerActiveSubagents: 1,
      brokerSubagentCap: 12,
    },
  });
  const markdown = renderA2AWorkerSelfAssessmentCapacityMarkdown(packet);

  assert.equal(markdown.includes("source-only supplied snapshot"), true);
  assert.equal(markdown.includes("no live host probe"), true);
  assert.equal(markdown.includes("subagent spawn"), true);
});
