import assert from "node:assert/strict";
import test from "node:test";

import type { TerminalBriefSidecarDryRunStartCanaryPlanPacket } from "./terminal-brief-sidecar-dry-run-start-canary-plan.js";
import {
  buildTerminalBriefSidecarPreflightEvidenceCollector,
  extractTerminalBriefSidecarPreflightEvidence,
  extractTerminalBriefSidecarPreflightEvidenceCollectorCanaryPlan,
  extractTerminalBriefSidecarPreflightEvidenceCollectorOptions,
  renderTerminalBriefSidecarPreflightEvidenceCollectorMarkdown,
} from "./terminal-brief-sidecar-preflight-evidence-collector.js";

const NOW = "2026-05-18T23:40:00.000Z";

function canaryPlan(
  overrides: Record<string, unknown> = {},
): TerminalBriefSidecarDryRunStartCanaryPlanPacket {
  const base = {
    kind: "a2a-broker.terminal-brief-sidecar-dry-run-start-canary-plan.packet",
    version: 1,
    generatedAt: NOW,
    mode: "read-only/no-live",
    parentRoundId: "round-726",
    state: "ready_for_dry_run_start_approval_request",
    dryRunOnly: true,
    sourceOnlyNoLive: true,
    idempotencyKey: "tb-sidecar-dry-run-start-canary-plan:fixture-726",
    source: {
      invocationRehearsalState: "ready_for_executor_invocation_rehearsal",
      invocationRehearsalIdempotencyKey: "tb-sidecar-executor-invocation-rehearsal:fixture-724",
      executorInvocationRehearsalReady: true,
      executorName: "gongyung-sidecar-dry-run-executor",
      adapterName: "gongyung",
      commandShapeKind: "metadata_only",
    },
    approvalRequestDraft: {
      draftOnly: true,
      requestedAction: "approve_supervised_terminal_brief_sidecar_dry_run_start_canary",
      requestedBy: "broker-finalizer",
      operatorTarget: "operator-a",
      dispatchRequired: true,
      dispatchPermitted: false,
      sendsApprovalRequest: false,
      approvalGrantPermitted: false,
      executionPermitted: false,
    },
    canaryPlan: {
      planOnly: true,
      supervisedDryRunOnly: true,
      defaultOnCandidate: false,
      observationWindowMinutes: 30,
      monitorIntervalSeconds: 60,
      maxQueueBacklog: 1000,
      preflightChecks: ["Gateway /readyz is healthy before the approved runtime action"],
      evidenceChecklist: ["Gateway ready/event-loop/queue evidence before start"],
      abortConditions: ["Gateway /readyz is unhealthy"],
      rollbackChecklist: ["leave default-on disabled"],
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
      missingEvidence: [],
      blockers: [],
      nextAction: "review the draft approval and canary plan",
    },
    blockers: [],
    nextActions: [],
    approvalSensitiveActionsExcluded: [],
    integrationContract: {
      transport: "json",
      canaryPlanVersion: 1,
      harnessNeutral: true,
      openclawMessageSendRequired: false,
      hermesAdapterCompatible: true,
      gongyungAdapterCompatible: true,
      consumesExecutorInvocationRehearsalPacket: true,
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
      dryRunStartCanaryPlanOnly: true,
      sourceOnlyNoLive: true,
      planDoesNotMutateState: true,
      approvalRequestIsDraftOnly: true,
      canaryPlanDoesNotStartSidecar: true,
      commandShapeIsMetadataOnly: true,
      commandShapeDoesNotContainSecretValues: true,
      providerAcceptedIsVisibilityProof: false,
      terminalAckEligibleDoesNotPermitAck: true,
      defaultOnRequiresSeparateApprovalAfterObservation: true,
      executionNotPermitted: true,
      processSpawnNotPermitted: true,
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
  return { ...base, ...overrides } as unknown as TerminalBriefSidecarDryRunStartCanaryPlanPacket;
}

function evidence(overrides: Record<string, unknown> = {}) {
  return {
    observedAt: NOW,
    expiresAt: "2026-05-18T23:45:00.000Z",
    gatewayReady: true,
    gatewayReadyAt: NOW,
    eventLoopDegraded: false,
    queueBacklog: 3,
    queueObservedAt: NOW,
    telegramLivenessOk: true,
    telegramLastSeenAt: NOW,
    cursorPersisted: true,
    cursorValue: "cursor-726",
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
    ...overrides,
  };
}

test("builds ready source-only preflight evidence packet without permitting runtime actions", () => {
  const packet = buildTerminalBriefSidecarPreflightEvidenceCollector(canaryPlan(), evidence(), { now: NOW });

  assert.equal(packet.kind, "a2a-broker.terminal-brief-sidecar-preflight-evidence-collector.packet");
  assert.equal(packet.state, "ready_for_supervised_dry_run_preflight_review");
  assert.equal(packet.readiness.sourceCriteriaMet, true);
  assert.equal(packet.readiness.preflightReviewReady, true);
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
  assert.equal(packet.readiness.executionPermitted, false);
  assert.equal(packet.table.requiredRowsReady, packet.table.requiredRows);
  assert.equal(packet.integrationContract.openclawMessageSendRequired, false);
  assert.equal(packet.integrationContract.hermesAdapterCompatible, true);
  assert.equal(packet.integrationContract.gongyungAdapterCompatible, true);
  assert.equal(packet.integrationContract.collectsLiveEvidence, false);
  assert.equal(packet.integrationContract.probesGateway, false);
  assert.equal(packet.integrationContract.startsSidecar, false);
  assert.equal(packet.semantics.suppliedEvidenceOnly, true);
  assert.equal(packet.semantics.performsProviderSend, false);
  assert.equal(packet.semantics.performsTerminalAck, false);
  assert.equal(packet.semantics.performsRuntimeRestartOrDeploy, false);
  assert.equal(packet.semantics.performsDbMutation, false);
});

test("waits when supplied preflight evidence is missing", () => {
  const packet = buildTerminalBriefSidecarPreflightEvidenceCollector(canaryPlan(), {}, { now: NOW });

  assert.equal(packet.state, "waiting_for_preflight_evidence");
  assert.equal(packet.readiness.sourceCriteriaMet, false);
  assert.ok(packet.readiness.missingEvidence.includes("gateway_readiness"));
  assert.ok(packet.readiness.missingEvidence.includes("cursor_persistence"));
  assert.ok(packet.blockers.some((blocker) => blocker.includes("Gateway ready/event-loop evidence")));
});

test("classifies fresh degraded Gateway evidence separately from missing evidence", () => {
  const packet = buildTerminalBriefSidecarPreflightEvidenceCollector(
    canaryPlan(),
    evidence({ eventLoopDegraded: true }),
    { now: NOW },
  );

  assert.equal(packet.state, "degraded");
  assert.equal(packet.readiness.sourceCriteriaMet, false);
  assert.ok(packet.blockers.some((blocker) => blocker.includes("Gateway ready/event-loop evidence")));
});

test("blocks if the source canary plan unexpectedly permits runtime actions", () => {
  const unsafe = canaryPlan();
  (unsafe as unknown as { readiness: { sidecarStartPermitted: boolean } }).readiness.sidecarStartPermitted = true;

  const packet = buildTerminalBriefSidecarPreflightEvidenceCollector(unsafe, evidence(), { now: NOW });

  assert.equal(packet.state, "blocked");
  assert.ok(packet.blockers.some((blocker) => blocker.includes("unsafe live-action")));
  assert.equal(packet.readiness.sidecarStartPermitted, false);
});

test("extractors accept envelope aliases and markdown states safety boundary", () => {
  const input = {
    dryRunStartCanaryPlanPacket: canaryPlan(),
    preflightEvidence: evidence(),
    preflightEvidenceCollector: { now: NOW, maxQueueBacklog: 1000 },
  };

  const packet = buildTerminalBriefSidecarPreflightEvidenceCollector(
    extractTerminalBriefSidecarPreflightEvidenceCollectorCanaryPlan(input),
    extractTerminalBriefSidecarPreflightEvidence(input),
    extractTerminalBriefSidecarPreflightEvidenceCollectorOptions(input),
  );
  const markdown = renderTerminalBriefSidecarPreflightEvidenceCollectorMarkdown(packet);

  assert.equal(packet.state, "ready_for_supervised_dry_run_preflight_review");
  assert.match(markdown, /supplied evidence only/);
  assert.match(markdown, /does not probe Gateway\/Telegram\/broker runtime/);
  assert.throws(
    () => extractTerminalBriefSidecarPreflightEvidenceCollectorCanaryPlan({ packet: { kind: "not-it" } }),
    /expected/,
  );
});
