import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildTerminalBriefSidecarExecutionGateFinalReview,
  extractTerminalBriefSidecarExecutionGateFinalReviewGrantEvidence,
  extractTerminalBriefSidecarExecutionGateFinalReviewOptions,
  renderTerminalBriefSidecarExecutionGateFinalReviewMarkdown,
} from "./terminal-brief-sidecar-execution-gate-final-review.js";

const NOW = "2026-05-19T03:05:00.000Z";

function fixtureInput() {
  return JSON.parse(readFileSync("fixtures/terminal-brief/sidecar-execution-gate-final-review.no-live.json", "utf8"));
}

test("execution gate final review renders checklist without dispatching executor", () => {
  const input = fixtureInput();
  const packet = buildTerminalBriefSidecarExecutionGateFinalReview(
    extractTerminalBriefSidecarExecutionGateFinalReviewGrantEvidence(input),
    { ...extractTerminalBriefSidecarExecutionGateFinalReviewOptions(input), now: NOW },
  );

  assert.equal(packet.kind, "a2a-broker.terminal-brief-sidecar-execution-gate-final-review.packet");
  assert.equal(packet.state, "ready_for_execution_gate_final_review");
  assert.equal(packet.readiness.finalReviewReady, true);
  assert.equal(packet.finalReview.reviewOnly, true);
  assert.equal(packet.finalReview.checklist.length, 6);
  assert.equal(packet.readiness.startExecutorDispatchPermitted, false);
  assert.equal(packet.readiness.executorInvocationPermitted, false);
  assert.equal(packet.readiness.processSpawnPermitted, false);
  assert.equal(packet.readiness.sidecarStartPermitted, false);
  assert.equal(packet.readiness.defaultOnPermitted, false);
  assert.equal(packet.readiness.providerSendPermitted, false);
  assert.equal(packet.readiness.terminalAckPermitted, false);
  assert.equal(packet.readiness.executionPermitted, false);
  assert.equal(packet.readiness.dbMutationPermitted, false);
  assert.equal(packet.integrationContract.rendersExecutionGateFinalReview, true);
  assert.equal(packet.integrationContract.dispatchesStartExecutor, false);
  assert.equal(packet.integrationContract.invokesExecutor, false);
  assert.equal(packet.integrationContract.startsSidecar, false);
  assert.equal(packet.semantics.reviewDoesNotDispatchExecutor, true);
  assert.equal(packet.semantics.acceptedGrantEvidenceDoesNotAuthorizeRuntime, true);
});

test("execution gate final review maps non-ready source states", () => {
  const base = extractTerminalBriefSidecarExecutionGateFinalReviewGrantEvidence(fixtureInput());
  const rejected = buildTerminalBriefSidecarExecutionGateFinalReview({ ...base, state: "grant_rejected", readiness: { ...base.readiness, grantEvidenceAccepted: false } }, { now: NOW });
  const more = buildTerminalBriefSidecarExecutionGateFinalReview({ ...base, state: "more_evidence_requested", readiness: { ...base.readiness, grantEvidenceAccepted: false } }, { now: NOW });
  const stale = buildTerminalBriefSidecarExecutionGateFinalReview({ ...base, state: "expired", readiness: { ...base.readiness, grantEvidenceAccepted: false } }, { now: NOW });
  const conflict = buildTerminalBriefSidecarExecutionGateFinalReview({ ...base, state: "conflicting", readiness: { ...base.readiness, grantEvidenceAccepted: false } }, { now: NOW });
  const waiting = buildTerminalBriefSidecarExecutionGateFinalReview({ ...base, state: "insufficient", readiness: { ...base.readiness, grantEvidenceAccepted: false } }, { now: NOW });

  assert.equal(rejected.state, "grant_rejected");
  assert.equal(more.state, "more_evidence_requested");
  assert.equal(stale.state, "stale");
  assert.equal(conflict.state, "conflicting");
  assert.equal(waiting.state, "waiting_for_grant_evidence");
  assert.equal(waiting.readiness.missingEvidence.includes("accepted_grant_evidence"), true);
  assert.equal(rejected.readiness.startExecutorDispatchPermitted, false);
  assert.equal(more.readiness.providerSendPermitted, false);
  assert.equal(stale.readiness.terminalAckPermitted, false);
  assert.equal(conflict.readiness.executionPermitted, false);
});

test("execution gate final review blocks unsafe source drift", () => {
  const unsafe = structuredClone(extractTerminalBriefSidecarExecutionGateFinalReviewGrantEvidence(fixtureInput()));
  unsafe.readiness.executorInvocationPermitted = true as false;
  const packet = buildTerminalBriefSidecarExecutionGateFinalReview(unsafe, { now: NOW });

  assert.equal(packet.state, "blocked");
  assert.equal(packet.blockers.some((blocker) => blocker.includes("executor invocation")), true);
  assert.equal(packet.readiness.executorInvocationPermitted, false);
});

test("execution gate final review extractors and markdown preserve no-live boundary", () => {
  const input = fixtureInput();
  assert.equal(extractTerminalBriefSidecarExecutionGateFinalReviewGrantEvidence(input).source.grantReference, "grant-proposal-747");
  assert.equal(extractTerminalBriefSidecarExecutionGateFinalReviewOptions(input).executionGateReference, "execution-gate-751");

  const packet = buildTerminalBriefSidecarExecutionGateFinalReview(
    extractTerminalBriefSidecarExecutionGateFinalReviewGrantEvidence(input),
    { ...extractTerminalBriefSidecarExecutionGateFinalReviewOptions(input), now: NOW },
  );
  const markdown = renderTerminalBriefSidecarExecutionGateFinalReviewMarkdown(packet);

  assert.equal(markdown.includes("does not dispatch/invoke executor"), true);
  assert.equal(markdown.includes("executorInvocationPermitted=false"), true);
  assert.equal(packet.readiness.executionPermitted, false);
});
