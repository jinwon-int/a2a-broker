import assert from "node:assert/strict";
import test from "node:test";

import { buildA2AWorkerSelfAssessmentCapacity } from "./worker-self-assessment-capacity.js";
import { buildA2AWorkerSubagentOrchestrationPolicy } from "./worker-subagent-orchestration-policy.js";
import {
  buildA2AWorkerSubagentPlannerHandoff,
  extractA2AWorkerSubagentPlannerHandoffInput,
  renderA2AWorkerSubagentPlannerHandoffMarkdown,
} from "./worker-subagent-planner-handoff.js";

const NOW = "2026-05-19T02:05:00.000Z";

function selfAssessment() {
  return buildA2AWorkerSelfAssessmentCapacity({
    now: NOW,
    workerId: "bangtong",
    task: {
      taskId: "task-large-independent",
      size: "large",
      coupling: "low",
      hasIndependentSubtasks: true,
      writeSets: ["src/core/planner.ts", "docs/planner.md", "test/planner.test.ts"],
    },
    host: {
      cpuLoadPct: 42,
      memoryUsedPct: 55,
      ioPressure: "low",
      eventLoopDegraded: false,
      gatewayPressure: "low",
      activeSubagents: 0,
      workerSubagentCap: 3,
      brokerActiveSubagents: 4,
      brokerSubagentCap: 12,
    },
  });
}

test("planner handoff becomes ready when self-assessment and planner policy align", () => {
  const assessment = selfAssessment();
  assert.ok(assessment.plannerInput);
  const plannerPolicy = buildA2AWorkerSubagentOrchestrationPolicy(assessment.plannerInput);
  const packet = buildA2AWorkerSubagentPlannerHandoff({
    now: NOW,
    finalizer: "seoseo",
    selfAssessment: assessment,
    plannerPolicy,
  });

  assert.equal(packet.kind, "a2a-broker.worker-subagent-planner-handoff.packet");
  assert.equal(packet.state, "ready_for_finalizer_review");
  assert.equal(packet.finalizer, "seoseo");
  assert.equal(packet.workerId, "bangtong");
  assert.equal(packet.source.plannerParallelismHint, 3);
  assert.deepEqual(packet.source.recommendedRoles, ["explorer", "implementer", "verifier"]);
  assert.deepEqual(packet.review.blockers, []);
  assert.equal(packet.review.finalizerRequired, true);
  assert.equal(packet.review.evidenceOnlySubagents, true);
  assert.equal(packet.boundaries.actualSubagentSpawn, false);
  assert.equal(packet.boundaries.brokerDispatch, false);
  assert.equal(packet.boundaries.dbMutation, false);
});

test("planner handoff blocks mismatched worker or task evidence", () => {
  const assessment = selfAssessment();
  assert.ok(assessment.plannerInput);
  const plannerPolicy = buildA2AWorkerSubagentOrchestrationPolicy({
    ...assessment.plannerInput,
    host: { ...assessment.plannerInput.host, workerId: "other-worker" },
  });
  const packet = buildA2AWorkerSubagentPlannerHandoff({
    now: NOW,
    selfAssessment: assessment,
    plannerPolicy,
  });

  assert.equal(packet.state, "blocked");
  assert.equal(packet.review.workerMatches, false);
  assert.equal(packet.review.blockers.includes("planner policy worker does not match self-assessment worker"), true);
  assert.equal(packet.boundaries.actualSubagentSpawn, false);
});

test("extractor accepts handoff envelopes", () => {
  const assessment = selfAssessment();
  assert.ok(assessment.plannerInput);
  const plannerPolicy = buildA2AWorkerSubagentOrchestrationPolicy(assessment.plannerInput);
  const input = extractA2AWorkerSubagentPlannerHandoffInput({
    plannerHandoff: {
      now: NOW,
      finalizer: "seoseo",
      selfAssessment: assessment,
      plannerPolicy,
    },
  });
  const packet = buildA2AWorkerSubagentPlannerHandoff(input);

  assert.equal(packet.generatedAt, NOW);
  assert.equal(packet.finalizer, "seoseo");
  assert.equal(packet.state, "ready_for_finalizer_review");
});

test("markdown renders no-runtime safety boundary", () => {
  const assessment = selfAssessment();
  assert.ok(assessment.plannerInput);
  const plannerPolicy = buildA2AWorkerSubagentOrchestrationPolicy(assessment.plannerInput);
  const packet = buildA2AWorkerSubagentPlannerHandoff({ now: NOW, selfAssessment: assessment, plannerPolicy });
  const markdown = renderA2AWorkerSubagentPlannerHandoffMarkdown(packet);

  assert.equal(markdown.includes("source-only handoff"), true);
  assert.equal(markdown.includes("no live probe"), true);
  assert.equal(markdown.includes("subagent spawn"), true);
});
