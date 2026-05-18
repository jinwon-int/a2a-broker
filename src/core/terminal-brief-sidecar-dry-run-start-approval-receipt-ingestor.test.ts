import assert from "node:assert/strict";
import test from "node:test";

import type { TerminalBriefSidecarDryRunStartApprovalRequestPacket } from "./terminal-brief-sidecar-dry-run-start-approval-request.js";
import {
  buildTerminalBriefSidecarDryRunStartApprovalReceiptIngestor,
  extractTerminalBriefSidecarDryRunStartApprovalReceiptEvidence,
  extractTerminalBriefSidecarDryRunStartApprovalRequestPacket,
  renderTerminalBriefSidecarDryRunStartApprovalReceiptIngestorMarkdown,
} from "./terminal-brief-sidecar-dry-run-start-approval-receipt-ingestor.js";

const NOW = "2026-05-19T00:35:00.000Z";

function approvalRequest(
  overrides: Partial<TerminalBriefSidecarDryRunStartApprovalRequestPacket> = {},
): TerminalBriefSidecarDryRunStartApprovalRequestPacket {
  const base = {
    kind: "a2a-broker.terminal-brief-sidecar-dry-run-start-approval-request.packet",
    version: 1,
    generatedAt: NOW,
    mode: "read-only/no-live",
    parentRoundId: "round-733",
    state: "approval_request_draft_ready",
    dryRunOnly: true,
    sourceOnlyNoLive: true,
    idempotencyKey: "tb-sidecar-dry-run-start-approval-request:fixture-733",
    source: {
      preflightChainReviewState: "ready_for_supervised_dry_run_chain_review",
      preflightChainReviewIdempotencyKey: "tb-sidecar-preflight-chain-review:fixture-731",
      sourceCriteriaMet: true,
      chainReviewReady: true,
      requiredRowsReady: 6,
      requiredRows: 6,
      preflightCollectorState: "ready_for_supervised_dry_run_preflight_review",
      preflightCollectorIdempotencyKey: "tb-sidecar-preflight-evidence:fixture-729",
      dryRunStartCanaryPlanState: "ready_for_dry_run_start_approval_request",
      dryRunStartCanaryPlanIdempotencyKey: "tb-sidecar-dry-run-start-canary-plan:fixture-726",
      executorName: "gongyung-sidecar-dry-run-executor",
      adapterName: "gongyung",
      finalizer: "seoseo",
    },
    approvalRequestDraft: {
      draftOnly: true,
      status: "draft_not_sent",
      requestedAction: "approve_supervised_terminal_brief_sidecar_dry_run_start",
      requestedBy: "seoseo",
      operatorTarget: "round-733",
      operatorChannel: "telegram",
      approvalExpiresAt: "2026-05-19T00:55:00.000Z",
      dispatchRequired: true,
      dispatchPermitted: false,
      approvalGrantPermitted: false,
      executionPermitted: false,
      transcriptDraft: "Request: approve supervised Terminal Brief sidecar dry-run start.",
    },
    supervisedDryRunBoundary: {
      planOnly: true,
      sourcePacketIds: [
        "tb-sidecar-dry-run-start-canary-plan:fixture-726",
        "tb-sidecar-preflight-evidence:fixture-729",
        "tb-sidecar-preflight-chain-review:fixture-731",
      ],
      finalizerRequired: true,
      separateOperatorApprovalRequired: true,
      separateExecutorRequired: true,
      defaultOnCandidate: false,
      approvalCanBeRequestedBy: "seoseo",
      approvalCanBeDeliveredBy: ["openclaw", "hermes", "gongyung", "external"],
      mustNotTreatProviderAcceptedAsVisibilityProof: true,
      forbiddenBeforeSeparateApproval: ["start sidecar", "send provider", "terminal ACK"],
    },
    readiness: {
      sourceCriteriaMet: true,
      approvalRequestDraftReady: true,
      approvalRequestDispatchPermitted: false,
      approvalGrantPermitted: false,
      startExecutorDispatchPermitted: false,
      executorInvocationPermitted: false,
      processSpawnPermitted: false,
      sidecarStartPermitted: false,
      defaultOnPermitted: false,
      liveActivationPermitted: false,
      providerSendPermitted: false,
      terminalAckPermitted: false,
      executionPermitted: false,
      dbMutationPermitted: false,
      missingEvidence: [],
      blockers: [
        "approval request draft is not a dispatch, approval grant, or runtime executor",
        "supervised dry-run start requires a separate explicit operator approval and executor path",
      ],
      nextAction: "broker finalizer may send this draft through a chosen adapter",
    },
    blockers: [],
    nextActions: [],
    approvalSensitiveActionsExcluded: [],
    integrationContract: {
      transport: "json",
      approvalRequestVersion: 1,
      harnessNeutral: true,
      openclawMessageSendRequired: false,
      hermesAdapterCompatible: true,
      gongyungAdapterCompatible: true,
      consumesPreflightChainReviewPacket: true,
      producesApprovalRequestDraft: true,
      sendsApprovalRequest: false,
      grantsApproval: false,
      dispatchesStartExecutor: false,
      invokesExecutor: false,
      spawnsProcess: false,
      startsSidecar: false,
      enablesDefaultOn: false,
      executesAction: false,
    },
    semantics: {
      approvalRequestDraftOnly: true,
      sourceOnlyNoLive: true,
      requestDraftIsNotSend: true,
      approvalRequestIsNotApprovalGrant: true,
      dryRunStartRequiresSeparateApproval: true,
      dryRunStartRequiresSeparateExecutor: true,
      preflightChainReviewDoesNotPermitStart: true,
      defaultOnRequiresSeparateApprovalAfterObservation: true,
      providerAcceptedIsVisibilityProof: false,
      terminalAckEligibleDoesNotPermitAck: true,
      executionNotPermitted: true,
      processSpawnNotPermitted: true,
      sidecarStartNotPermitted: true,
      defaultOnNotEnabledByThisPacket: true,
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
  };
  return { ...base, ...overrides } as TerminalBriefSidecarDryRunStartApprovalRequestPacket;
}

const acceptedEvidence = [
  { kind: "provider_accepted", observedAt: NOW, providerMessageId: "provider-733", target: "round-733" },
  { kind: "current_session_visible", observedAt: NOW, receiptId: "visible-733", target: "round-733" },
  {
    kind: "approval_grant",
    observedAt: NOW,
    approvedAction: "approve_supervised_terminal_brief_sidecar_dry_run_start",
    approvedTarget: "round-733",
    operatorId: "operator-a",
  },
];

test("accepts visibility/manual receipt plus matching approval grant as no-live evidence only", () => {
  const packet = buildTerminalBriefSidecarDryRunStartApprovalReceiptIngestor(approvalRequest(), acceptedEvidence, { now: NOW });

  assert.equal(packet.kind, "a2a-broker.terminal-brief-sidecar-dry-run-start-approval-receipt-ingestor.packet");
  assert.equal(packet.state, "accepted");
  assert.equal(packet.receiptEvidenceAccepted, true);
  assert.equal(packet.approvalEvidenceAccepted, true);
  assert.equal(packet.classification.providerAccepted, true);
  assert.equal(packet.classification.currentSessionVisible, true);
  assert.equal(packet.classification.approvalGrantAccepted, true);
  assert.equal(packet.classification.terminalAckEligible, true);
  assert.equal(packet.classification.providerAcceptedIsVisibilityProof, false);
  assert.equal(packet.readiness.approvalGrantPermitted, false);
  assert.equal(packet.readiness.startExecutorDispatchPermitted, false);
  assert.equal(packet.readiness.executorInvocationPermitted, false);
  assert.equal(packet.readiness.processSpawnPermitted, false);
  assert.equal(packet.readiness.sidecarStartPermitted, false);
  assert.equal(packet.readiness.defaultOnPermitted, false);
  assert.equal(packet.readiness.providerSendPermitted, false);
  assert.equal(packet.readiness.terminalAckPermitted, false);
  assert.equal(packet.readiness.dbMutationPermitted, false);
  assert.equal(packet.integrationContract.openclawMessageSendRequired, false);
  assert.equal(packet.integrationContract.grantsApproval, false);
  assert.equal(packet.integrationContract.startsSidecar, false);
  assert.equal(packet.semantics.approvalGrantEvidenceDoesNotGrantApproval, true);
  assert.equal(packet.semantics.performsTerminalAck, false);
});

test("provider accepted alone remains insufficient", () => {
  const packet = buildTerminalBriefSidecarDryRunStartApprovalReceiptIngestor(
    approvalRequest(),
    [{ kind: "provider_accepted", observedAt: NOW, providerMessageId: "provider-733" }],
    { now: NOW },
  );

  assert.equal(packet.state, "insufficient");
  assert.equal(packet.classification.providerAccepted, true);
  assert.equal(packet.classification.receiptProofAccepted, false);
  assert.equal(packet.classification.approvalGrantAccepted, false);
  assert.equal(packet.receiptEvidenceAccepted, false);
});

test("conflicting approval grant is rejected as conflicting evidence", () => {
  const packet = buildTerminalBriefSidecarDryRunStartApprovalReceiptIngestor(
    approvalRequest(),
    [
      { kind: "current_session_visible", observedAt: NOW, target: "round-733" },
      {
        kind: "approval_grant",
        observedAt: NOW,
        approvedAction: "approve_wrong_action",
        approvedTarget: "round-733",
      },
    ],
    { now: NOW },
  );

  assert.equal(packet.state, "conflicting");
  assert.equal(packet.classification.approvalGrantAccepted, false);
});

test("blocks unsafe approval request permission drift", () => {
  const unsafe = approvalRequest();
  unsafe.readiness.sidecarStartPermitted = true as never;
  const packet = buildTerminalBriefSidecarDryRunStartApprovalReceiptIngestor(unsafe, acceptedEvidence, { now: NOW });

  assert.equal(packet.state, "blocked");
  assert.ok(packet.blockers.some((blocker) => blocker.includes("sidecar start")));
  assert.equal(packet.readiness.sidecarStartPermitted, false);
});

test("extractors accept aliases and markdown preserves no-live boundary", () => {
  const input = {
    dryRunStartApprovalRequestPacket: approvalRequest(),
    evidence: acceptedEvidence,
  };
  const packet = buildTerminalBriefSidecarDryRunStartApprovalReceiptIngestor(
    extractTerminalBriefSidecarDryRunStartApprovalRequestPacket(input),
    extractTerminalBriefSidecarDryRunStartApprovalReceiptEvidence(input),
    { now: NOW },
  );
  const markdown = renderTerminalBriefSidecarDryRunStartApprovalReceiptIngestorMarkdown(packet);

  assert.equal(packet.state, "accepted");
  assert.match(markdown, /receipt ingestor only/);
  assert.match(markdown, /provider accepted is not visibility proof/);
  assert.throws(
    () => extractTerminalBriefSidecarDryRunStartApprovalRequestPacket({ packet: { kind: "not-it" } }),
    /expected/,
  );
});
