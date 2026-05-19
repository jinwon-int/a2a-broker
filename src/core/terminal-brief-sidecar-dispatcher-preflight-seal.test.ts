import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildTerminalBriefSidecarDispatcherPreflightSeal,
  extractTerminalBriefSidecarDispatcherPreflightSealDraft,
  extractTerminalBriefSidecarDispatcherPreflightSealOptions,
  extractTerminalBriefSidecarDispatcherRuntimeEvidence,
  renderTerminalBriefSidecarDispatcherPreflightSealMarkdown,
} from "./terminal-brief-sidecar-dispatcher-preflight-seal.js";

const NOW = "2026-05-19T03:45:00.000Z";

function fixtureInput() {
  return JSON.parse(readFileSync("fixtures/terminal-brief/sidecar-dispatcher-preflight-seal.no-live.json", "utf8"));
}

test("dispatcher preflight seal validates supplied runtime evidence without dispatching executor", () => {
  const input = fixtureInput();
  const packet = buildTerminalBriefSidecarDispatcherPreflightSeal(
    extractTerminalBriefSidecarDispatcherPreflightSealDraft(input),
    extractTerminalBriefSidecarDispatcherRuntimeEvidence(input),
    { ...extractTerminalBriefSidecarDispatcherPreflightSealOptions(input), now: NOW },
  );

  assert.equal(packet.kind, "a2a-broker.terminal-brief-sidecar-dispatcher-preflight-seal.packet");
  assert.equal(packet.state, "dispatcher_preflight_seal_ready");
  assert.equal(packet.readiness.dispatcherPreflightSealReady, true);
  assert.equal(packet.runtimeEvidence.suppliedOnly, true);
  assert.equal(packet.runtimeEvidence.fresh, true);
  assert.equal(packet.sealedEnvelope.sealOnly, true);
  assert.equal(packet.sealedEnvelope.integrityVerified, true);
  assert.equal(packet.sealedEnvelope.secretValuesIncluded, false);
  assert.equal(packet.sealedEnvelope.writesRuntimeState, false);
  assert.equal(packet.readiness.startExecutorDispatchPermitted, false);
  assert.equal(packet.readiness.executorInvocationPermitted, false);
  assert.equal(packet.readiness.processSpawnPermitted, false);
  assert.equal(packet.readiness.sidecarStartPermitted, false);
  assert.equal(packet.readiness.defaultOnPermitted, false);
  assert.equal(packet.readiness.providerSendPermitted, false);
  assert.equal(packet.readiness.terminalAckPermitted, false);
  assert.equal(packet.readiness.executionPermitted, false);
  assert.equal(packet.readiness.dbMutationPermitted, false);
  assert.equal(packet.integrationContract.collectsLiveEvidence, false);
  assert.equal(packet.integrationContract.dispatchesStartExecutor, false);
  assert.equal(packet.semantics.sealDoesNotDispatchExecutor, true);
  assert.equal(packet.semantics.sealDoesNotAuthorizeRuntime, true);
});

test("dispatcher preflight seal fails closed for missing, stale, and integrity drift", () => {
  const draft = extractTerminalBriefSidecarDispatcherPreflightSealDraft(fixtureInput());
  const missing = buildTerminalBriefSidecarDispatcherPreflightSeal(draft, {}, { now: NOW });
  const stale = buildTerminalBriefSidecarDispatcherPreflightSeal(draft, {
    ...extractTerminalBriefSidecarDispatcherRuntimeEvidence(fixtureInput()),
    observedAt: "2026-05-19T03:00:00.000Z",
    maxAgeMs: 60_000,
  }, { now: NOW });
  const integrity = buildTerminalBriefSidecarDispatcherPreflightSeal(draft, {
    ...extractTerminalBriefSidecarDispatcherRuntimeEvidence(fixtureInput()),
    envelopeHash: "sha256:not-the-envelope",
  }, { now: NOW });

  assert.equal(missing.state, "runtime_evidence_missing");
  assert.equal(stale.state, "runtime_evidence_stale");
  assert.equal(integrity.state, "integrity_failed");
  assert.equal(missing.readiness.startExecutorDispatchPermitted, false);
  assert.equal(stale.readiness.executionPermitted, false);
  assert.equal(integrity.readiness.terminalAckPermitted, false);
});

test("dispatcher preflight seal blocks unsafe dispatch draft drift", () => {
  const unsafe = structuredClone(extractTerminalBriefSidecarDispatcherPreflightSealDraft(fixtureInput()));
  unsafe.readiness.executorInvocationPermitted = true as false;
  const packet = buildTerminalBriefSidecarDispatcherPreflightSeal(
    unsafe,
    extractTerminalBriefSidecarDispatcherRuntimeEvidence(fixtureInput()),
    { now: NOW },
  );

  assert.equal(packet.state, "blocked");
  assert.equal(packet.blockers.some((blocker) => blocker.includes("executor invocation")), true);
  assert.equal(packet.readiness.executorInvocationPermitted, false);
});

test("dispatcher preflight seal extractors and markdown preserve no-live boundary", () => {
  const input = fixtureInput();
  assert.equal(extractTerminalBriefSidecarDispatcherPreflightSealDraft(input).dispatchRequestDraft.dispatchRequestReference, "dispatch-request-753");
  assert.equal(extractTerminalBriefSidecarDispatcherPreflightSealOptions(input).sealReference, "dispatcher-preflight-seal-755");

  const packet = buildTerminalBriefSidecarDispatcherPreflightSeal(
    extractTerminalBriefSidecarDispatcherPreflightSealDraft(input),
    extractTerminalBriefSidecarDispatcherRuntimeEvidence(input),
    { ...extractTerminalBriefSidecarDispatcherPreflightSealOptions(input), now: NOW },
  );
  const markdown = renderTerminalBriefSidecarDispatcherPreflightSealMarkdown(packet);

  assert.equal(markdown.includes("does not dispatch/invoke executor"), true);
  assert.equal(markdown.includes("executorInvocationPermitted=false"), true);
  assert.equal(packet.readiness.executionPermitted, false);
});
