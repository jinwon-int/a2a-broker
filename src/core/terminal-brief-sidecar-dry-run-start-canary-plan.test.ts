import assert from "node:assert/strict";
import test from "node:test";

import type { TerminalBriefSidecarExecutorInvocationRehearsalPacket } from "./terminal-brief-sidecar-executor-invocation-rehearsal.js";
import {
  buildTerminalBriefSidecarDryRunStartCanaryPlan,
  extractTerminalBriefSidecarDryRunStartCanaryPlanOptions,
  extractTerminalBriefSidecarDryRunStartCanaryPlanRehearsal,
  renderTerminalBriefSidecarDryRunStartCanaryPlanMarkdown,
} from "./terminal-brief-sidecar-dry-run-start-canary-plan.js";

const NOW = "2026-05-18T20:00:00.000Z";

function rehearsal(
  overrides: Partial<TerminalBriefSidecarExecutorInvocationRehearsalPacket> = {},
): TerminalBriefSidecarExecutorInvocationRehearsalPacket {
  const base = {
    kind: "a2a-broker.terminal-brief-sidecar-executor-invocation-rehearsal.packet",
    version: 1,
    generatedAt: NOW,
    mode: "read-only/no-live",
    parentRoundId: "round-724",
    state: "ready_for_executor_invocation_rehearsal",
    dryRunOnly: true,
    sourceOnlyNoLive: true,
    idempotencyKey: "tb-sidecar-executor-invocation-rehearsal:fixture-724",
    source: {
      startExecutorGateState: "ready_for_start_executor_review",
      startExecutorGateIdempotencyKey: "tb-sidecar-start-executor-gate:fixture-724",
      startExecutorReviewReady: true,
      requestedExecutor: "gongyung-sidecar-dry-run-executor",
      operatorApprovalReference: "operator-visible-approval-724",
      commandShapeKind: "metadata_only",
    },
    invocationPlan: {
      rehearsalOnly: true,
      supervisedDryRunOnly: true,
      executorName: "gongyung-sidecar-dry-run-executor",
      adapterName: "gongyung",
      executorRuntime: "metadata-only",
      supervisor: "terminal-brief-sidecar-worker",
      healthCheckTarget: "/readyz",
      maxRuntimeSeconds: 300,
      commandShape: {
        kind: "metadata_only",
        commandName: "terminal-brief-sidecar",
        commandArgs: ["--dry-run", "--poll-ms", "15000"],
        envKeys: ["EDGE_SECRET"],
        inheritedFromStartGate: true,
        commandExecutionPermitted: false,
        processSpawnPermitted: false,
        secretsIncluded: false,
      },
      preflightChecks: ["source start executor gate is ready_for_start_executor_review"],
      abortConditions: ["Gateway readiness is false"],
      rollbackInstructions: ["discard this rehearsal packet if source gate evidence changes"],
      expectedEvidence: ["operator-reviewed metadata-only invocation plan"],
    },
    readiness: {
      sourceCriteriaMet: true,
      executorInvocationRehearsalReady: true,
      startExecutorDispatchPermitted: false,
      executorInvocationPermitted: false,
      processSpawnPermitted: false,
      sidecarStartPermitted: false,
      defaultOnPermitted: false,
      liveActivationPermitted: false,
      approvalGrantPermitted: false,
      providerSendPermitted: false,
      terminalAckPermitted: false,
      executionPermitted: false,
      missingEvidence: [],
      blockers: [],
      nextAction: "review the metadata-only invocation rehearsal",
    },
    blockers: [],
    nextActions: [],
    approvalSensitiveActionsExcluded: [],
    integrationContract: {
      transport: "json",
      rehearsalVersion: 1,
      harnessNeutral: true,
      openclawMessageSendRequired: false,
      hermesAdapterCompatible: true,
      gongyungAdapterCompatible: true,
      consumesStartExecutorGatePacket: true,
      dispatchesStartExecutor: false,
      invokesExecutor: false,
      spawnsProcess: false,
      startsSidecar: false,
      enablesDefaultOn: false,
      executesAction: false,
    },
    semantics: {
      executorInvocationRehearsalOnly: true,
      sourceOnlyNoLive: true,
      rehearsalDoesNotMutateState: true,
      commandShapeIsMetadataOnly: true,
      commandShapeDoesNotContainSecretValues: true,
      startExecutorGateDoesNotPermitInvocation: true,
      providerAcceptedIsVisibilityProof: false,
      terminalAckEligibleDoesNotPermitAck: true,
      sidecarStartRequiresSeparateApprovedExecutor: true,
      defaultOnNotEnabledByThisPacket: true,
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
  } satisfies TerminalBriefSidecarExecutorInvocationRehearsalPacket;
  return { ...base, ...overrides } as TerminalBriefSidecarExecutorInvocationRehearsalPacket;
}

test("sidecar dry-run start canary plan becomes ready without sending approval or starting sidecar", () => {
  const packet = buildTerminalBriefSidecarDryRunStartCanaryPlan(rehearsal(), {
    now: NOW,
    requestedBy: "broker-finalizer",
    operatorTarget: "operator-a",
    canaryWindowMinutes: 45,
    monitorIntervalSeconds: 30,
    maxQueueBacklog: 500,
  });

  assert.equal(packet.kind, "a2a-broker.terminal-brief-sidecar-dry-run-start-canary-plan.packet");
  assert.equal(packet.state, "ready_for_dry_run_start_approval_request");
  assert.equal(packet.readiness.approvalRequestDraftReady, true);
  assert.equal(packet.approvalRequestDraft.dispatchPermitted, false);
  assert.equal(packet.approvalRequestDraft.sendsApprovalRequest, false);
  assert.equal(packet.readiness.approvalRequestDispatchPermitted, false);
  assert.equal(packet.readiness.approvalGrantPermitted, false);
  assert.equal(packet.readiness.startExecutorDispatchPermitted, false);
  assert.equal(packet.readiness.executorInvocationPermitted, false);
  assert.equal(packet.readiness.processSpawnPermitted, false);
  assert.equal(packet.readiness.sidecarStartPermitted, false);
  assert.equal(packet.readiness.defaultOnPermitted, false);
  assert.equal(packet.readiness.providerSendPermitted, false);
  assert.equal(packet.readiness.terminalAckPermitted, false);
  assert.equal(packet.readiness.executionPermitted, false);
  assert.equal(packet.canaryPlan.observationWindowMinutes, 45);
  assert.equal(packet.canaryPlan.maxQueueBacklog, 500);
  assert.equal(packet.integrationContract.sendsApprovalRequest, false);
  assert.equal(packet.integrationContract.invokesExecutor, false);
  assert.equal(packet.integrationContract.startsSidecar, false);
  assert.equal(packet.semantics.defaultOnRequiresSeparateApprovalAfterObservation, true);
});

test("sidecar dry-run start canary plan waits for an unready invocation rehearsal", () => {
  const packet = buildTerminalBriefSidecarDryRunStartCanaryPlan(rehearsal({
    state: "waiting_for_start_executor_review",
    readiness: {
      ...rehearsal().readiness,
      sourceCriteriaMet: false,
      executorInvocationRehearsalReady: false,
      missingEvidence: ["ready_start_executor_gate"],
    },
  }), { now: NOW });

  assert.equal(packet.state, "waiting_for_executor_invocation_rehearsal");
  assert.deepEqual(packet.readiness.missingEvidence, [
    "ready_executor_invocation_rehearsal",
    "source_criteria",
    "executor_invocation_rehearsal",
  ]);
  assert.equal(packet.readiness.sidecarStartPermitted, false);
});

test("sidecar dry-run start canary plan preserves stale conflicting and rejected states", () => {
  const stale = buildTerminalBriefSidecarDryRunStartCanaryPlan(rehearsal({ state: "stale" }), { now: NOW });
  const conflicting = buildTerminalBriefSidecarDryRunStartCanaryPlan(rehearsal({ state: "conflicting" }), { now: NOW });
  const rejected = buildTerminalBriefSidecarDryRunStartCanaryPlan(rehearsal({ state: "rejected" }), { now: NOW });

  assert.equal(stale.state, "stale");
  assert.equal(conflicting.state, "conflicting");
  assert.equal(rejected.state, "rejected");
  assert.equal(stale.readiness.executionPermitted, false);
  assert.equal(conflicting.readiness.executionPermitted, false);
  assert.equal(rejected.readiness.executionPermitted, false);
});

test("sidecar dry-run start canary plan blocks unsafe no-live violations", () => {
  const packet = buildTerminalBriefSidecarDryRunStartCanaryPlan(rehearsal({
    readiness: {
      ...rehearsal().readiness,
      processSpawnPermitted: true as false,
    },
  }), { now: NOW });

  assert.equal(packet.state, "blocked");
  assert.equal(packet.blockers.some((blocker) => blocker.includes("process spawn")), true);
  assert.equal(packet.readiness.processSpawnPermitted, false);
});

test("sidecar dry-run start canary plan extractors and markdown preserve draft-only boundary", () => {
  const input = {
    executorInvocationRehearsal: rehearsal(),
    dryRunStartCanaryPlan: {
      operator_target: "operator-a",
      canary_window_minutes: 15,
      monitor_interval_seconds: 10,
    },
  };

  assert.equal(
    extractTerminalBriefSidecarDryRunStartCanaryPlanRehearsal(input).idempotencyKey,
    "tb-sidecar-executor-invocation-rehearsal:fixture-724",
  );
  assert.equal(extractTerminalBriefSidecarDryRunStartCanaryPlanOptions(input).operator_target, "operator-a");

  const packet = buildTerminalBriefSidecarDryRunStartCanaryPlan(
    extractTerminalBriefSidecarDryRunStartCanaryPlanRehearsal(input),
    { ...extractTerminalBriefSidecarDryRunStartCanaryPlanOptions(input), now: NOW },
  );
  const markdown = renderTerminalBriefSidecarDryRunStartCanaryPlanMarkdown(packet);
  assert.match(markdown, /dry-run start canary plan only/);
  assert.match(markdown, /approvalRequestDispatchPermitted=false/);
  assert.match(markdown, /executionPermitted=false/);
});
