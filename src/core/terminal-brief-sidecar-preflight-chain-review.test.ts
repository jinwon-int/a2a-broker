import assert from "node:assert/strict";
import test from "node:test";

import type { TerminalBriefSidecarPreflightEvidenceCollectorPacket } from "./terminal-brief-sidecar-preflight-evidence-collector.js";
import {
  buildTerminalBriefSidecarPreflightChainReview,
  extractTerminalBriefSidecarPreflightChainReviewCollector,
  extractTerminalBriefSidecarPreflightChainReviewOptions,
  renderTerminalBriefSidecarPreflightChainReviewMarkdown,
} from "./terminal-brief-sidecar-preflight-chain-review.js";

const NOW = "2026-05-19T00:05:00.000Z";

function collector(
  overrides: Partial<TerminalBriefSidecarPreflightEvidenceCollectorPacket> = {},
): TerminalBriefSidecarPreflightEvidenceCollectorPacket {
  const base = {
    kind: "a2a-broker.terminal-brief-sidecar-preflight-evidence-collector.packet",
    version: 1,
    generatedAt: NOW,
    mode: "read-only/no-live",
    parentRoundId: "round-729",
    state: "ready_for_supervised_dry_run_preflight_review",
    dryRunOnly: true,
    sourceOnlyNoLive: true,
    idempotencyKey: "tb-sidecar-preflight-evidence:fixture-729",
    source: {
      dryRunStartCanaryPlanState: "ready_for_dry_run_start_approval_request",
      dryRunStartCanaryPlanIdempotencyKey: "tb-sidecar-dry-run-start-canary-plan:fixture-726",
      dryRunStartCanaryPlanReady: true,
      requestedAction: "approve_supervised_terminal_brief_sidecar_dry_run_start_canary",
      operatorTarget: "operator-a",
      executorName: "gongyung-sidecar-dry-run-executor",
      adapterName: "gongyung",
      monitorIntervalSeconds: 60,
      maxQueueBacklog: 1000,
    },
    preflightEvidence: {
      observedAt: NOW,
      expiresAt: "2026-05-19T00:10:00.000Z",
      stale: false,
      gatewayReady: true,
      gatewayReadyAt: NOW,
      eventLoopDegraded: false,
      queueBacklog: 3,
      queueObservedAt: NOW,
      telegramLivenessOk: true,
      telegramLastSeenAt: NOW,
      cursorPersisted: true,
      cursorValue: "cursor-729",
      cursorObservedAt: NOW,
      boundedPolling: true,
      pollIntervalMs: 60_000,
      maxBatch: 20,
      sidecarProcessCount: 0,
      pollingOwner: "terminal-brief-sidecar-worker",
      duplicatePollingOwner: false,
      dryRunOnly: true,
      operatorEventsCrossBrokersEnabled: false,
      secretLeakageObserved: false,
      liveProviderSendObserved: false,
      terminalAckObserved: false,
      dbMutationObserved: false,
      runtimeRestartObserved: false,
      defaultOnEnabled: false,
    },
    table: {
      rows: [],
      requiredRowsReady: 10,
      requiredRows: 10,
      readyRows: 10,
      totalRows: 11,
    },
    readiness: {
      sourceCriteriaMet: true,
      preflightReviewReady: true,
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
      blockers: [],
      nextAction: "broker finalizer can review the preflight packet",
    },
    blockers: [],
    nextActions: [],
    approvalSensitiveActionsExcluded: [],
    integrationContract: {
      transport: "json",
      collectorVersion: 1,
      harnessNeutral: true,
      openclawMessageSendRequired: false,
      hermesAdapterCompatible: true,
      gongyungAdapterCompatible: true,
      consumesDryRunStartCanaryPlanPacket: true,
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
      preflightEvidenceCollectorOnly: true,
      sourceOnlyNoLive: true,
      suppliedEvidenceOnly: true,
      evidenceDoesNotMutateState: true,
      routeIsReadOnly: true,
      dryRunStartCanaryPlanDoesNotPermitStart: true,
      providerAcceptedIsVisibilityProof: false,
      terminalAckEligibleDoesNotPermitAck: true,
      executionNotPermitted: true,
      processSpawnNotPermitted: true,
      sidecarStartNotPermitted: true,
      defaultOnNotEnabledByThisPacket: true,
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
  return { ...base, ...overrides } as TerminalBriefSidecarPreflightEvidenceCollectorPacket;
}

test("builds ready chain review without permitting approval or runtime actions", () => {
  const packet = buildTerminalBriefSidecarPreflightChainReview(collector(), { now: NOW });

  assert.equal(packet.kind, "a2a-broker.terminal-brief-sidecar-preflight-chain-review.packet");
  assert.equal(packet.state, "ready_for_supervised_dry_run_chain_review");
  assert.equal(packet.readiness.sourceCriteriaMet, true);
  assert.equal(packet.readiness.chainReviewReady, true);
  assert.equal(packet.readiness.approvalRequestDispatchPermitted, false);
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
  assert.equal(packet.integrationContract.hermesAdapterCompatible, true);
  assert.equal(packet.integrationContract.gongyungAdapterCompatible, true);
  assert.equal(packet.integrationContract.probesGateway, false);
  assert.equal(packet.integrationContract.startsSidecar, false);
  assert.equal(packet.semantics.preflightChainReviewOnly, true);
  assert.equal(packet.semantics.performsProviderSend, false);
  assert.equal(packet.semantics.performsTerminalAck, false);
  assert.equal(packet.semantics.performsRuntimeRestartOrDeploy, false);
  assert.equal(packet.semantics.performsDbMutation, false);
});

test("waits when collector evidence is incomplete", () => {
  const packet = buildTerminalBriefSidecarPreflightChainReview(collector({
    state: "waiting_for_preflight_evidence",
    table: { rows: [], requiredRowsReady: 8, requiredRows: 10, readyRows: 8, totalRows: 11 },
    readiness: {
      ...collector().readiness,
      sourceCriteriaMet: false,
      preflightReviewReady: false,
      missingEvidence: ["gateway_readiness"],
    },
  }), { now: NOW });

  assert.equal(packet.state, "waiting_for_preflight_review");
  assert.equal(packet.readiness.sourceCriteriaMet, false);
  assert.ok(packet.readiness.missingEvidence.includes("preflight_collector"));
  assert.ok(packet.readiness.missingEvidence.includes("evidence_table"));
});

test("propagates stale and degraded collector states", () => {
  assert.equal(
    buildTerminalBriefSidecarPreflightChainReview(collector({ state: "stale" }), { now: NOW }).state,
    "stale",
  );
  assert.equal(
    buildTerminalBriefSidecarPreflightChainReview(collector({ state: "degraded" }), { now: NOW }).state,
    "degraded",
  );
});

test("blocks unsafe collector permission drift", () => {
  const unsafe = collector();
  unsafe.readiness.sidecarStartPermitted = true as never;
  const packet = buildTerminalBriefSidecarPreflightChainReview(unsafe, { now: NOW });

  assert.equal(packet.state, "blocked");
  assert.ok(packet.blockers.some((blocker) => blocker.includes("unsafe live-action")));
  assert.equal(packet.readiness.sidecarStartPermitted, false);
});

test("extractors accept aliases and markdown preserves separate approval boundary", () => {
  const input = {
    preflightEvidenceCollectorPacket: collector(),
    preflightChainReview: { now: NOW, finalizer: "seoseo" },
  };
  const packet = buildTerminalBriefSidecarPreflightChainReview(
    extractTerminalBriefSidecarPreflightChainReviewCollector(input),
    extractTerminalBriefSidecarPreflightChainReviewOptions(input),
  );
  const markdown = renderTerminalBriefSidecarPreflightChainReviewMarkdown(packet);

  assert.equal(packet.state, "ready_for_supervised_dry_run_chain_review");
  assert.match(markdown, /separate explicit approval/);
  assert.match(markdown, /final no-live chain review only/);
  assert.throws(
    () => extractTerminalBriefSidecarPreflightChainReviewCollector({ packet: { kind: "not-it" } }),
    /expected/,
  );
});
