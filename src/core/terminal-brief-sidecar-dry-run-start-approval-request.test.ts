import assert from "node:assert/strict";
import test from "node:test";

import type { TerminalBriefSidecarPreflightChainReviewPacket } from "./terminal-brief-sidecar-preflight-chain-review.js";
import {
  buildTerminalBriefSidecarDryRunStartApprovalRequest,
  extractTerminalBriefSidecarDryRunStartApprovalRequestChainReview,
  extractTerminalBriefSidecarDryRunStartApprovalRequestOptions,
  renderTerminalBriefSidecarDryRunStartApprovalRequestMarkdown,
} from "./terminal-brief-sidecar-dry-run-start-approval-request.js";

const NOW = "2026-05-19T00:20:00.000Z";

function chainReview(
  overrides: Partial<TerminalBriefSidecarPreflightChainReviewPacket> = {},
): TerminalBriefSidecarPreflightChainReviewPacket {
  const base = {
    kind: "a2a-broker.terminal-brief-sidecar-preflight-chain-review.packet",
    version: 1,
    generatedAt: NOW,
    mode: "read-only/no-live",
    parentRoundId: "round-731",
    state: "ready_for_supervised_dry_run_chain_review",
    dryRunOnly: true,
    sourceOnlyNoLive: true,
    idempotencyKey: "tb-sidecar-preflight-chain-review:fixture-731",
    source: {
      preflightCollectorState: "ready_for_supervised_dry_run_preflight_review",
      preflightCollectorIdempotencyKey: "tb-sidecar-preflight-evidence:fixture-729",
      dryRunStartCanaryPlanState: "ready_for_dry_run_start_approval_request",
      dryRunStartCanaryPlanIdempotencyKey: "tb-sidecar-dry-run-start-canary-plan:fixture-726",
      requestedAction: "approve_supervised_terminal_brief_sidecar_dry_run_start_canary",
      operatorTarget: "operator-a",
      executorName: "gongyung-sidecar-dry-run-executor",
      adapterName: "gongyung",
      finalizer: "seoseo",
    },
    chain: {
      readyPacketIds: [
        "tb-sidecar-dry-run-start-canary-plan:fixture-726",
        "tb-sidecar-preflight-evidence:fixture-729",
      ],
      sourceRowsReady: 6,
      sourceRowsRequired: 6,
      collectorRequiredRowsReady: 10,
      collectorRequiredRows: 10,
      collectorMissingEvidence: [],
    },
    table: {
      rows: [],
      requiredRowsReady: 6,
      requiredRows: 6,
      readyRows: 6,
      totalRows: 7,
    },
    readiness: {
      sourceCriteriaMet: true,
      chainReviewReady: true,
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
        "chain review does not permit approval dispatch, executor invocation, process spawn, sidecar start, default-on, provider send, terminal ACK, DB mutation, restart/deploy, or historical replay",
        "supervised dry-run start requires a separate explicit operator approval and executor runtime",
      ],
      nextAction: "broker finalizer can use this chain review to prepare a separate explicit supervised dry-run start approval request",
    },
    blockers: [],
    nextActions: [],
    approvalSensitiveActionsExcluded: [],
    integrationContract: {
      transport: "json",
      chainReviewVersion: 1,
      harnessNeutral: true,
      openclawMessageSendRequired: false,
      hermesAdapterCompatible: true,
      gongyungAdapterCompatible: true,
      consumesPreflightEvidenceCollectorPacket: true,
      collectsLiveEvidence: false,
      probesGateway: false,
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
      preflightChainReviewOnly: true,
      sourceOnlyNoLive: true,
      suppliedPacketOnly: true,
      chainReviewDoesNotMutateState: true,
      routeIsReadOnly: true,
      brokerFinalizerRequired: true,
      dryRunStartRequiresSeparateApproval: true,
      providerAcceptedIsVisibilityProof: false,
      terminalAckEligibleDoesNotPermitAck: true,
      executionNotPermitted: true,
      processSpawnNotPermitted: true,
      sidecarStartNotPermitted: true,
      defaultOnNotEnabledByThisPacket: true,
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
  return { ...base, ...overrides } as TerminalBriefSidecarPreflightChainReviewPacket;
}

test("builds approval request draft without permitting dispatch or runtime actions", () => {
  const packet = buildTerminalBriefSidecarDryRunStartApprovalRequest(chainReview(), { now: NOW });

  assert.equal(packet.kind, "a2a-broker.terminal-brief-sidecar-dry-run-start-approval-request.packet");
  assert.equal(packet.state, "approval_request_draft_ready");
  assert.equal(packet.readiness.sourceCriteriaMet, true);
  assert.equal(packet.readiness.approvalRequestDraftReady, true);
  assert.equal(packet.approvalRequestDraft.status, "draft_not_sent");
  assert.equal(packet.approvalRequestDraft.dispatchPermitted, false);
  assert.equal(packet.approvalRequestDraft.approvalGrantPermitted, false);
  assert.equal(packet.approvalRequestDraft.executionPermitted, false);
  assert.equal(packet.readiness.approvalRequestDispatchPermitted, false);
  assert.equal(packet.readiness.startExecutorDispatchPermitted, false);
  assert.equal(packet.readiness.executorInvocationPermitted, false);
  assert.equal(packet.readiness.processSpawnPermitted, false);
  assert.equal(packet.readiness.sidecarStartPermitted, false);
  assert.equal(packet.readiness.defaultOnPermitted, false);
  assert.equal(packet.readiness.providerSendPermitted, false);
  assert.equal(packet.readiness.terminalAckPermitted, false);
  assert.equal(packet.readiness.dbMutationPermitted, false);
  assert.equal(packet.integrationContract.openclawMessageSendRequired, false);
  assert.equal(packet.integrationContract.hermesAdapterCompatible, true);
  assert.equal(packet.integrationContract.gongyungAdapterCompatible, true);
  assert.equal(packet.integrationContract.sendsApprovalRequest, false);
  assert.equal(packet.integrationContract.startsSidecar, false);
  assert.equal(packet.supervisedDryRunBoundary.separateOperatorApprovalRequired, true);
  assert.equal(packet.supervisedDryRunBoundary.defaultOnCandidate, false);
  assert.equal(packet.semantics.requestDraftIsNotSend, true);
  assert.equal(packet.semantics.performsProviderSend, false);
  assert.equal(packet.semantics.performsTerminalAck, false);
  assert.equal(packet.semantics.performsRuntimeRestartOrDeploy, false);
  assert.equal(packet.semantics.performsDbMutation, false);
});

test("waits when chain review is incomplete", () => {
  const source = chainReview({
    state: "waiting_for_preflight_review",
    table: { rows: [], requiredRowsReady: 5, requiredRows: 6, readyRows: 5, totalRows: 7 },
    readiness: {
      ...chainReview().readiness,
      sourceCriteriaMet: false,
      chainReviewReady: false,
      missingEvidence: ["evidence_table"],
    },
  });
  const packet = buildTerminalBriefSidecarDryRunStartApprovalRequest(source, { now: NOW });

  assert.equal(packet.state, "waiting_for_chain_review");
  assert.equal(packet.readiness.sourceCriteriaMet, false);
  assert.equal(packet.approvalRequestDraft.status, "not_ready");
  assert.ok(packet.readiness.missingEvidence.includes("ready_preflight_chain_review"));
  assert.ok(packet.readiness.missingEvidence.includes("required_rows"));
});

test("propagates stale degraded and conflicting states", () => {
  assert.equal(
    buildTerminalBriefSidecarDryRunStartApprovalRequest(chainReview({ state: "stale" }), { now: NOW }).state,
    "stale",
  );
  assert.equal(
    buildTerminalBriefSidecarDryRunStartApprovalRequest(chainReview({ state: "degraded" }), { now: NOW }).state,
    "degraded",
  );
  assert.equal(
    buildTerminalBriefSidecarDryRunStartApprovalRequest(chainReview({ state: "conflicting" }), { now: NOW }).state,
    "conflicting",
  );
});

test("blocks unsafe permission drift", () => {
  const unsafe = chainReview();
  unsafe.readiness.executorInvocationPermitted = true as never;
  const packet = buildTerminalBriefSidecarDryRunStartApprovalRequest(unsafe, { now: NOW });

  assert.equal(packet.state, "blocked");
  assert.ok(packet.blockers.some((blocker) => blocker.includes("unsafe live-action")));
  assert.equal(packet.readiness.executorInvocationPermitted, false);
});

test("extractors accept aliases and markdown keeps separate approval boundary", () => {
  const input = {
    preflightChainReviewPacket: chainReview(),
    dryRunStartApprovalRequest: {
      now: NOW,
      requestedBy: "seoseo",
      operatorTarget: "jinwon",
      approvalWindowMinutes: 20,
    },
  };
  const packet = buildTerminalBriefSidecarDryRunStartApprovalRequest(
    extractTerminalBriefSidecarDryRunStartApprovalRequestChainReview(input),
    extractTerminalBriefSidecarDryRunStartApprovalRequestOptions(input),
  );
  const markdown = renderTerminalBriefSidecarDryRunStartApprovalRequestMarkdown(packet);

  assert.equal(packet.state, "approval_request_draft_ready");
  assert.equal(packet.approvalRequestDraft.operatorTarget, "jinwon");
  assert.equal(packet.approvalRequestDraft.approvalExpiresAt, "2026-05-19T00:40:00.000Z");
  assert.match(markdown, /approval request draft only/);
  assert.match(markdown, /separateOperatorApprovalRequired=true/);
  assert.throws(
    () => extractTerminalBriefSidecarDryRunStartApprovalRequestChainReview({ packet: { kind: "not-it" } }),
    /expected/,
  );
});
