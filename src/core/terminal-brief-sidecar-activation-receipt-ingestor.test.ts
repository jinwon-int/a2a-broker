import assert from "node:assert/strict";
import test from "node:test";

import type { TerminalBriefSidecarActivationApprovalPacket } from "./terminal-brief-sidecar-activation-approval.js";
import {
  buildTerminalBriefSidecarActivationReceiptIngestor,
  extractTerminalBriefSidecarActivationApprovalPacket,
  extractTerminalBriefSidecarActivationReceiptEvidence,
  renderTerminalBriefSidecarActivationReceiptIngestorMarkdown,
} from "./terminal-brief-sidecar-activation-receipt-ingestor.js";

const NOW = "2026-05-18T15:00:00.000Z";
const FRESH = "2026-05-18T14:59:30.000Z";
const OLD = "2026-05-18T14:00:00.000Z";

function approval(overrides: Partial<TerminalBriefSidecarActivationApprovalPacket> = {}): TerminalBriefSidecarActivationApprovalPacket {
  const base = {
    kind: "a2a-broker.terminal-brief-sidecar-activation-approval.packet",
    version: 1,
    generatedAt: NOW,
    mode: "read-only/no-live",
    parentRoundId: "round-716",
    state: "approval_request_draft_ready",
    dryRunOnly: true,
    sourceOnlyNoLive: true,
    idempotencyKey: "tb-sidecar-activation-approval:fixture-716",
    source: {
      gateState: "ready_for_operator_approval",
      gateIdempotencyKey: "tb-sidecar-dry-run-gate:fixture-716",
      sourceCriteriaMet: true,
      alwaysOnDryRunCandidate: true,
      requiredRowsReady: 5,
      requiredRows: 5,
      sidecarDecision: "candidate",
      finalizerStatus: "ready_for_finalizer_review",
    },
    requestDraft: {
      status: "draft_not_sent",
      requestedAction: "approve_supervised_terminal_brief_sidecar_dry_run_start",
      requestedBy: "broker-finalizer",
      operatorTarget: "operator-a",
      approvalExpiresAt: "2026-05-18T15:30:00.000Z",
      dispatchRequired: true,
      dispatchPermitted: false,
      transcriptDraft: "Request: approve supervised Terminal Brief sidecar dry-run start.",
    },
    activationPlan: {
      supervisedDryRunOnly: true,
      cursorPersisted: true,
      boundedPolling: true,
      pollIntervalMs: 15000,
      maxBatch: 20,
      gatewayReady: true,
      eventLoopDegraded: false,
      queueBacklog: 0,
      abortQueueBacklog: 1000,
      abortConditions: [],
      rollbackInstructions: [],
    },
    readiness: {
      approvalRequestDraftReady: true,
      sidecarStartPermitted: false,
      defaultOnPermitted: false,
      liveActivationPermitted: false,
      approvalGrantPermitted: false,
      providerSendPermitted: false,
      terminalAckPermitted: false,
      executionPermitted: false,
      missingEvidence: [],
      blockers: [],
      nextAction: "dispatch this draft through the selected harness adapter and ingest explicit operator approval evidence before any sidecar start",
    },
    blockers: [],
    nextActions: [],
    approvalSensitiveActionsExcluded: [],
    integrationContract: {
      transport: "json",
      approvalPacketVersion: 1,
      harnessNeutral: true,
      openclawMessageSendRequired: false,
      hermesAdapterCompatible: true,
      gongyungAdapterCompatible: true,
      consumesSidecarDryRunGate: true,
      producesApprovalRequestDraft: true,
      sendsApprovalRequest: false,
      grantsApproval: false,
      startsSidecar: false,
      enablesDefaultOn: false,
      executesAction: false,
    },
    semantics: {
      approvalRequestDraftOnly: true,
      sourceOnlyNoLive: true,
      requestDraftIsNotSend: true,
      approvalRequestIsNotApprovalGrant: true,
      sidecarStartRequiresSeparateApprovedExecutor: true,
      defaultOnNotEnabledByThisPacket: true,
      providerAcceptedIsVisibilityProof: false,
      terminalAckEligibleDoesNotPermitAck: true,
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
  } satisfies TerminalBriefSidecarActivationApprovalPacket;
  return { ...base, ...overrides } as TerminalBriefSidecarActivationApprovalPacket;
}

test("sidecar activation receipt ingestor accepts visibility/manual proof plus matching approval grant without granting execution", () => {
  const packet = buildTerminalBriefSidecarActivationReceiptIngestor(approval(), [
    { kind: "provider_accepted", observedAt: FRESH, providerMessageId: "msg-1" },
    { kind: "current_session_visible", observedAt: FRESH, currentSessionId: "session-1" },
    {
      kind: "approval_grant",
      observedAt: FRESH,
      approvedAction: "approve_supervised_terminal_brief_sidecar_dry_run_start",
      approvedTarget: "round-716",
      operatorId: "operator-a",
    },
  ], { now: NOW });

  assert.equal(packet.kind, "a2a-broker.terminal-brief-sidecar-activation-receipt-ingestor.packet");
  assert.equal(packet.state, "accepted");
  assert.equal(packet.receiptEvidenceAccepted, true);
  assert.equal(packet.approvalEvidenceAccepted, true);
  assert.equal(packet.classification.providerAcceptedIsVisibilityProof, false);
  assert.equal(packet.classification.terminalAckEligible, true);
  assert.equal(packet.readiness.sidecarStartPermitted, false);
  assert.equal(packet.readiness.defaultOnPermitted, false);
  assert.equal(packet.readiness.approvalGrantPermitted, false);
  assert.equal(packet.readiness.providerSendPermitted, false);
  assert.equal(packet.readiness.terminalAckPermitted, false);
  assert.equal(packet.readiness.executionPermitted, false);
  assert.equal(packet.integrationContract.grantsApproval, false);
  assert.equal(packet.integrationContract.startsSidecar, false);
});

test("sidecar activation receipt ingestor keeps provider accepted evidence insufficient", () => {
  const packet = buildTerminalBriefSidecarActivationReceiptIngestor(approval(), [
    { kind: "provider_accepted", observedAt: FRESH, providerMessageId: "msg-1" },
  ], { now: NOW });

  assert.equal(packet.state, "insufficient");
  assert.equal(packet.classification.providerAccepted, true);
  assert.equal(packet.classification.currentSessionVisible, false);
  assert.equal(packet.classification.approvalGrantAccepted, false);
  assert.equal(packet.receiptEvidenceAccepted, false);
  assert.equal(packet.approvalEvidenceAccepted, false);
});

test("sidecar activation receipt ingestor requires both receipt proof and approval grant", () => {
  const receiptOnly = buildTerminalBriefSidecarActivationReceiptIngestor(approval(), [
    { kind: "manual_operator_confirmation", observedAt: FRESH },
  ], { now: NOW });
  const grantOnly = buildTerminalBriefSidecarActivationReceiptIngestor(approval(), [
    {
      kind: "approval_grant",
      observedAt: FRESH,
      approvedAction: "approve_supervised_terminal_brief_sidecar_dry_run_start",
      approvedTarget: "round-716",
    },
  ], { now: NOW });

  assert.equal(receiptOnly.state, "insufficient");
  assert.equal(grantOnly.state, "insufficient");
});

test("sidecar activation receipt ingestor fails closed for rejected stale and conflicting evidence", () => {
  const rejected = buildTerminalBriefSidecarActivationReceiptIngestor(approval(), [
    { kind: "rejected", observedAt: FRESH },
  ], { now: NOW });
  const stale = buildTerminalBriefSidecarActivationReceiptIngestor(approval(), [
    { kind: "manual_operator_confirmation", observedAt: OLD },
  ], { now: NOW, maxAgeMs: 60_000 });
  const conflicting = buildTerminalBriefSidecarActivationReceiptIngestor(approval(), [
    {
      kind: "approval_grant",
      observedAt: FRESH,
      approvedAction: "different_action",
      approvedTarget: "round-716",
    },
  ], { now: NOW });

  assert.equal(rejected.state, "rejected");
  assert.equal(stale.state, "stale");
  assert.equal(conflicting.state, "conflicting");
  assert.equal(rejected.readiness.sidecarStartPermitted, false);
  assert.equal(stale.readiness.sidecarStartPermitted, false);
  assert.equal(conflicting.readiness.sidecarStartPermitted, false);
});

test("sidecar activation receipt ingestor blocks unsafe activation source", () => {
  const packet = buildTerminalBriefSidecarActivationReceiptIngestor(approval({
    readiness: {
      ...approval().readiness,
      sidecarStartPermitted: true as false,
    },
  }), [
    { kind: "current_session_visible", observedAt: FRESH },
    {
      kind: "approval_grant",
      observedAt: FRESH,
      approvedAction: "approve_supervised_terminal_brief_sidecar_dry_run_start",
      approvedTarget: "round-716",
    },
  ], { now: NOW });

  assert.equal(packet.state, "blocked");
  assert.equal(packet.blockers.some((blocker) => blocker.includes("permits sidecar start")), true);
  assert.equal(packet.readiness.sidecarStartPermitted, false);
});

test("sidecar activation receipt ingestor extractors and markdown preserve no-live boundary", () => {
  const input = {
    sidecarActivationApproval: approval(),
    activationReceiptEvidence: [
      { kind: "current_session_visible", observedAt: FRESH },
      {
        kind: "approval_grant",
        observedAt: FRESH,
        approvedAction: "approve_supervised_terminal_brief_sidecar_dry_run_start",
        approvedTarget: "round-716",
      },
    ],
  };

  assert.equal(extractTerminalBriefSidecarActivationApprovalPacket(input).idempotencyKey, "tb-sidecar-activation-approval:fixture-716");
  assert.equal(extractTerminalBriefSidecarActivationReceiptEvidence(input).length, 2);

  const packet = buildTerminalBriefSidecarActivationReceiptIngestor(
    extractTerminalBriefSidecarActivationApprovalPacket(input),
    extractTerminalBriefSidecarActivationReceiptEvidence(input),
    { now: NOW },
  );
  const markdown = renderTerminalBriefSidecarActivationReceiptIngestorMarkdown(packet);
  assert.match(markdown, /receipt ingestor only/);
  assert.match(markdown, /terminalAckPermitted=false/);
  assert.match(markdown, /startsSidecar=false/);
});
