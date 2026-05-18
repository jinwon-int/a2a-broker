import assert from "node:assert/strict";
import test from "node:test";

import type { TerminalBriefSidecarDryRunGatePacket } from "./terminal-brief-sidecar-dry-run-gate.js";
import {
  buildTerminalBriefSidecarActivationApproval,
  extractTerminalBriefSidecarActivationApprovalGate,
  extractTerminalBriefSidecarActivationApprovalOptions,
  renderTerminalBriefSidecarActivationApprovalMarkdown,
} from "./terminal-brief-sidecar-activation-approval.js";

const NOW = "2026-05-18T14:00:00.000Z";

function gate(overrides: Partial<TerminalBriefSidecarDryRunGatePacket> = {}): TerminalBriefSidecarDryRunGatePacket {
  const base = {
    kind: "a2a-broker.terminal-brief-sidecar-dry-run-gate.packet",
    version: 1,
    generatedAt: NOW,
    mode: "read-only/no-live",
    parentRoundId: "round-714",
    state: "ready_for_operator_approval",
    dryRunOnly: true,
    sourceOnlyNoLive: true,
    idempotencyKey: "tb-sidecar-dry-run-gate:fixture-714",
    source: {
      sidecarDecision: "candidate",
      sidecarSpoolRecords: 3,
      sidecarReceiptDecisions: 1,
      sidecarDryRunOnly: true,
      providerSendAttempted: false,
      terminalAckAttempted: false,
      finalCountDecision: "candidate",
      finalizerStatus: "ready_for_finalizer_review",
      finalizerStatusIdempotencyKey: "tb-finalizer-approval-status:fixture-714",
    },
    operatingEvidence: {
      observedAt: NOW,
      stale: false,
      cursorPersisted: true,
      boundedPolling: true,
      pollIntervalMs: 15000,
      maxBatch: 20,
      gatewayReady: true,
      eventLoopDegraded: false,
      queueBacklog: 0,
      dryRunOnly: true,
      operatorEventsCrossBrokersEnabled: false,
      supervisedSidecar: true,
    },
    table: {
      rows: [],
      requiredRowsReady: 5,
      requiredRows: 5,
      readyRows: 5,
      totalRows: 6,
    },
    readiness: {
      sourceCriteriaMet: true,
      alwaysOnDryRunCandidate: true,
      alwaysOnDryRunStartPermitted: false,
      defaultOnPermitted: false,
      liveActivationPermitted: false,
      missingEvidence: [],
      blockers: [
        "starting always-on dry-run sidecar still requires separate operator approval",
      ],
      nextAction: "request explicit operator approval for dry-run sidecar supervision/canary",
    },
    blockers: [],
    nextActions: [],
    approvalSensitiveActionsExcluded: [],
    integrationContract: {
      transport: "json",
      gateVersion: 1,
      harnessNeutral: true,
      openclawMessageSendRequired: false,
      hermesAdapterCompatible: true,
      gongyungAdapterCompatible: true,
      consumesSidecarIntegrationRehearsal: true,
      consumesFinalizerApprovalStatus: true,
      grantsApproval: false,
      startsSidecar: false,
      enablesDefaultOn: false,
      executesAction: false,
    },
    semantics: {
      operatingGateOnly: true,
      sourceOnlyNoLive: true,
      gateDoesNotMutateState: true,
      sidecarDryRunCandidateDoesNotStartSidecar: true,
      providerAcceptedIsVisibilityProof: false,
      terminalAckEligibleDoesNotPermitAck: true,
      approvalGrantEvidenceDoesNotGrantApproval: true,
      defaultOnNotEnabledByThisPacket: true,
      executionNotPermitted: true,
      routeIsReadOnly: true,
      brokerFinalizerRequired: true,
      performsGitHubMutation: false,
      performsProviderSend: false,
      performsTerminalAck: false,
      performsRuntimeRestartOrDeploy: false,
      performsDbMutation: false,
      createsTaskFlowRecords: false,
      performsHistoricalReplay: false,
      performsReleaseOrPublish: false,
      movesSecretsOrCredentials: false,
    },
  } as TerminalBriefSidecarDryRunGatePacket;
  return { ...base, ...overrides } as TerminalBriefSidecarDryRunGatePacket;
}

test("sidecar activation approval emits draft from ready dry-run gate without granting execution", () => {
  const packet = buildTerminalBriefSidecarActivationApproval(gate(), {
    now: NOW,
    requestedBy: "broker-finalizer",
    operatorTarget: "operator-a",
    approvalWindowMinutes: 30,
  });

  assert.equal(packet.kind, "a2a-broker.terminal-brief-sidecar-activation-approval.packet");
  assert.equal(packet.state, "approval_request_draft_ready");
  assert.equal(packet.requestDraft.status, "draft_not_sent");
  assert.equal(packet.requestDraft.dispatchPermitted, false);
  assert.equal(packet.readiness.approvalRequestDraftReady, true);
  assert.equal(packet.readiness.sidecarStartPermitted, false);
  assert.equal(packet.readiness.defaultOnPermitted, false);
  assert.equal(packet.readiness.approvalGrantPermitted, false);
  assert.equal(packet.readiness.providerSendPermitted, false);
  assert.equal(packet.readiness.terminalAckPermitted, false);
  assert.equal(packet.integrationContract.sendsApprovalRequest, false);
  assert.equal(packet.integrationContract.startsSidecar, false);
  assert.equal(packet.semantics.requestDraftIsNotSend, true);
  assert.equal(packet.semantics.performsRuntimeRestartOrDeploy, false);
});

test("sidecar activation approval waits when dry-run gate is not ready", () => {
  const waitingGate = gate({
    state: "waiting_for_operating_evidence",
    readiness: {
      ...gate().readiness,
      sourceCriteriaMet: false,
      alwaysOnDryRunCandidate: false,
      missingEvidence: ["gateway_load"],
    },
  });
  const packet = buildTerminalBriefSidecarActivationApproval(waitingGate, { now: NOW });

  assert.equal(packet.state, "waiting_for_gate");
  assert.equal(packet.requestDraft.status, "not_ready");
  assert.deepEqual(packet.readiness.missingEvidence, ["gateway_load"]);
  assert.equal(packet.readiness.sidecarStartPermitted, false);
});

test("sidecar activation approval preserves stale and blocked gate states", () => {
  const stale = buildTerminalBriefSidecarActivationApproval(gate({ state: "stale" }), { now: NOW });
  const blocked = buildTerminalBriefSidecarActivationApproval(gate({ state: "blocked" }), { now: NOW });

  assert.equal(stale.state, "stale");
  assert.equal(blocked.state, "blocked");
  assert.equal(stale.readiness.approvalRequestDraftReady, false);
  assert.equal(blocked.readiness.approvalRequestDraftReady, false);
});

test("sidecar activation approval blocks unsafe no-live violations", () => {
  const base = gate();
  const packet = buildTerminalBriefSidecarActivationApproval(gate({
    readiness: {
      ...base.readiness,
      alwaysOnDryRunStartPermitted: true as false,
    },
  }), { now: NOW });

  assert.equal(packet.state, "blocked");
  assert.equal(packet.blockers.some((blocker) => blocker.includes("permits sidecar start")), true);
  assert.equal(packet.readiness.sidecarStartPermitted, false);
});

test("sidecar activation approval extractors and markdown preserve no-live boundary", () => {
  const input = {
    sidecarDryRunGate: gate(),
    activationApproval: {
      requested_by: "broker",
      operator_target: "operator",
      approval_window_minutes: 15,
    },
  };

  assert.equal(extractTerminalBriefSidecarActivationApprovalGate(input).idempotencyKey, "tb-sidecar-dry-run-gate:fixture-714");
  assert.equal(extractTerminalBriefSidecarActivationApprovalOptions(input).operator_target, "operator");

  const packet = buildTerminalBriefSidecarActivationApproval(
    extractTerminalBriefSidecarActivationApprovalGate(input),
    { ...extractTerminalBriefSidecarActivationApprovalOptions(input), now: NOW },
  );
  const markdown = renderTerminalBriefSidecarActivationApprovalMarkdown(packet);
  assert.match(markdown, /approval request draft only/);
  assert.match(markdown, /sidecarStartPermitted=false/);
  assert.match(markdown, /terminalAckPermitted=false/);
});
