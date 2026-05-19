import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildTerminalBriefSidecarExecutorDispatchRequestDraft,
  extractTerminalBriefSidecarExecutorDispatchRequestDraftFinalReview,
  extractTerminalBriefSidecarExecutorDispatchRequestDraftOptions,
  renderTerminalBriefSidecarExecutorDispatchRequestDraftMarkdown,
} from "./terminal-brief-sidecar-executor-dispatch-request-draft.js";

const NOW = "2026-05-19T03:25:00.000Z";

function fixtureInput() {
  return JSON.parse(readFileSync("fixtures/terminal-brief/sidecar-executor-dispatch-request-draft.no-live.json", "utf8"));
}

test("executor dispatch request draft renders metadata without dispatching executor", () => {
  const input = fixtureInput();
  const packet = buildTerminalBriefSidecarExecutorDispatchRequestDraft(
    extractTerminalBriefSidecarExecutorDispatchRequestDraftFinalReview(input),
    { ...extractTerminalBriefSidecarExecutorDispatchRequestDraftOptions(input), now: NOW },
  );

  assert.equal(packet.kind, "a2a-broker.terminal-brief-sidecar-executor-dispatch-request-draft.packet");
  assert.equal(packet.state, "dispatch_request_draft_ready");
  assert.equal(packet.readiness.dispatchRequestDraftReady, true);
  assert.equal(packet.dispatchRequestDraft.draftOnly, true);
  assert.equal(packet.dispatchRequestDraft.commandMetadata.transport, "json-stdin-stdout");
  assert.equal(packet.dispatchRequestDraft.commandMetadata.secretValuesIncluded, false);
  assert.equal(packet.dispatchRequestDraft.commandMetadata.writesRuntimeState, false);
  assert.equal(packet.readiness.startExecutorDispatchPermitted, false);
  assert.equal(packet.readiness.executorInvocationPermitted, false);
  assert.equal(packet.readiness.processSpawnPermitted, false);
  assert.equal(packet.readiness.sidecarStartPermitted, false);
  assert.equal(packet.readiness.defaultOnPermitted, false);
  assert.equal(packet.readiness.providerSendPermitted, false);
  assert.equal(packet.readiness.terminalAckPermitted, false);
  assert.equal(packet.readiness.executionPermitted, false);
  assert.equal(packet.readiness.dbMutationPermitted, false);
  assert.equal(packet.integrationContract.rendersExecutorDispatchRequestDraft, true);
  assert.equal(packet.integrationContract.dispatchesStartExecutor, false);
  assert.equal(packet.integrationContract.invokesExecutor, false);
  assert.equal(packet.integrationContract.startsSidecar, false);
  assert.equal(packet.semantics.draftDoesNotDispatchExecutor, true);
  assert.equal(packet.semantics.finalReviewDoesNotAuthorizeRuntime, true);
});

test("executor dispatch request draft maps non-ready final review states", () => {
  const base = extractTerminalBriefSidecarExecutorDispatchRequestDraftFinalReview(fixtureInput());
  const stale = buildTerminalBriefSidecarExecutorDispatchRequestDraft({ ...base, state: "stale", readiness: { ...base.readiness, finalReviewReady: false } }, { now: NOW });
  const conflict = buildTerminalBriefSidecarExecutorDispatchRequestDraft({ ...base, state: "conflicting", readiness: { ...base.readiness, finalReviewReady: false } }, { now: NOW });
  const blocked = buildTerminalBriefSidecarExecutorDispatchRequestDraft({ ...base, state: "blocked", readiness: { ...base.readiness, finalReviewReady: false } }, { now: NOW });
  const waiting = buildTerminalBriefSidecarExecutorDispatchRequestDraft({ ...base, state: "waiting_for_grant_evidence", readiness: { ...base.readiness, finalReviewReady: false } }, { now: NOW });

  assert.equal(stale.state, "stale");
  assert.equal(conflict.state, "conflicting");
  assert.equal(blocked.state, "final_review_blocked");
  assert.equal(waiting.state, "waiting_for_execution_gate_final_review");
  assert.equal(waiting.readiness.missingEvidence.includes("ready_execution_gate_final_review"), true);
  assert.equal(stale.readiness.startExecutorDispatchPermitted, false);
  assert.equal(conflict.readiness.providerSendPermitted, false);
  assert.equal(blocked.readiness.terminalAckPermitted, false);
  assert.equal(waiting.readiness.executionPermitted, false);
});

test("executor dispatch request draft blocks unsafe final review drift", () => {
  const unsafe = structuredClone(extractTerminalBriefSidecarExecutorDispatchRequestDraftFinalReview(fixtureInput()));
  unsafe.readiness.startExecutorDispatchPermitted = true as false;
  const packet = buildTerminalBriefSidecarExecutorDispatchRequestDraft(unsafe, { now: NOW });

  assert.equal(packet.state, "blocked");
  assert.equal(packet.blockers.some((blocker) => blocker.includes("executor dispatch")), true);
  assert.equal(packet.readiness.startExecutorDispatchPermitted, false);
});

test("executor dispatch request draft extractors and markdown preserve no-live boundary", () => {
  const input = fixtureInput();
  assert.equal(extractTerminalBriefSidecarExecutorDispatchRequestDraftFinalReview(input).finalReview.executionGateReference, "execution-gate-751");
  assert.equal(extractTerminalBriefSidecarExecutorDispatchRequestDraftOptions(input).dispatchRequestReference, "dispatch-request-753");

  const packet = buildTerminalBriefSidecarExecutorDispatchRequestDraft(
    extractTerminalBriefSidecarExecutorDispatchRequestDraftFinalReview(input),
    { ...extractTerminalBriefSidecarExecutorDispatchRequestDraftOptions(input), now: NOW },
  );
  const markdown = renderTerminalBriefSidecarExecutorDispatchRequestDraftMarkdown(packet);

  assert.equal(markdown.includes("does not dispatch/invoke executor"), true);
  assert.equal(markdown.includes("executorInvocationPermitted=false"), true);
  assert.equal(packet.readiness.executionPermitted, false);
});
