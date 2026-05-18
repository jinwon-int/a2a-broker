import assert from "node:assert/strict";
import test from "node:test";

import type { TerminalBriefSidecarExecutorInvocationRehearsalPacket } from "./terminal-brief-sidecar-executor-invocation-rehearsal.js";
import {
  buildTerminalBriefSidecarRuntimePreflightApproval,
  extractTerminalBriefSidecarRuntimePreflightApprovalOptions,
  extractTerminalBriefSidecarRuntimePreflightApprovalRehearsal,
  renderTerminalBriefSidecarRuntimePreflightApprovalMarkdown,
} from "./terminal-brief-sidecar-runtime-preflight-approval.js";

const NOW = "2026-05-19T00:40:00.000Z";

function rehearsal(
  overrides: Partial<TerminalBriefSidecarExecutorInvocationRehearsalPacket> = {},
): TerminalBriefSidecarExecutorInvocationRehearsalPacket {
  const base = {
    kind: "a2a-broker.terminal-brief-sidecar-executor-invocation-rehearsal.packet",
    version: 1,
    generatedAt: NOW,
    mode: "read-only/no-live",
    parentRoundId: "round-739",
    state: "ready_for_executor_invocation_rehearsal",
    dryRunOnly: true,
    sourceOnlyNoLive: true,
    idempotencyKey: "tb-sidecar-executor-invocation-rehearsal:fixture-739",
    source: {
      startExecutorGateState: "ready_for_start_executor_review",
      startExecutorGateIdempotencyKey: "tb-sidecar-start-executor-gate:fixture-739",
      startExecutorReviewReady: true,
      requestedExecutor: "gongyung-sidecar-dry-run-executor",
      operatorApprovalReference: "operator-visible-approval-739",
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
      adapterContract: {
        version: 1,
        adapterName: "gongyung",
        transport: "json-stdin-stdout",
        input: {
          packetKind: "a2a-broker.terminal-brief-sidecar-executor-invocation-rehearsal.packet",
          commandShapeKind: "metadata_only",
          commandExecutionPermitted: false,
          processSpawnPermitted: false,
          envKeysOnly: true,
          secretsIncluded: false,
        },
        output: {
          statusValues: ["ready", "aborted", "blocked"],
          mustReportAbortEvidence: true,
          providerAcceptedIsReceiptProof: false,
          terminalAckPermitted: false,
          sidecarStartProofRequiredForLaterRuntime: true,
        },
        abortEvidenceRequirements: [
          "abort status must include a stable abortCode",
          "abort status must include observedAt timestamp",
        ],
      },
    },
    readiness: {
      sourceCriteriaMet: true,
      executorInvocationRehearsalReady: true,
      adapterContractReady: true,
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
      adapterContractVersion: 1,
      requiresAbortEvidence: true,
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
      adapterContractOnly: true,
      adapterOutputDoesNotImplyReceiptProof: true,
      abortEvidenceRequiredBeforeRuntimeApproval: true,
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

test("runtime preflight approval packet becomes ready without runtime execution", () => {
  const packet = buildTerminalBriefSidecarRuntimePreflightApproval(rehearsal(), {
    now: NOW,
    requestedBy: "seoseo",
    operatorTarget: "round-739",
    approvalReference: "operator-visible-approval-739",
  });

  assert.equal(packet.kind, "a2a-broker.terminal-brief-sidecar-runtime-preflight-approval.packet");
  assert.equal(packet.state, "approval_packet_ready");
  assert.equal(packet.source.adapterContractReady, true);
  assert.equal(packet.runtimePreflight.adapterContract.version, 1);
  assert.equal(packet.runtimePreflight.adapterContract.output.providerAcceptedIsReceiptProof, false);
  assert.equal(packet.runtimePreflight.adapterContract.output.terminalAckPermitted, false);
  assert.equal(packet.runtimePreflight.requiredAbortEvidence.length >= 2, true);
  assert.equal(packet.readiness.approvalPacketReady, true);
  assert.equal(packet.readiness.approvalRequestDispatchPermitted, false);
  assert.equal(packet.readiness.approvalGrantPermitted, false);
  assert.equal(packet.readiness.executorInvocationPermitted, false);
  assert.equal(packet.readiness.processSpawnPermitted, false);
  assert.equal(packet.readiness.sidecarStartPermitted, false);
  assert.equal(packet.readiness.providerSendPermitted, false);
  assert.equal(packet.readiness.terminalAckPermitted, false);
  assert.equal(packet.readiness.executionPermitted, false);
  assert.equal(packet.readiness.dbMutationPermitted, false);
  assert.equal(packet.integrationContract.sendsApprovalRequest, false);
  assert.equal(packet.integrationContract.invokesExecutor, false);
  assert.equal(packet.integrationContract.spawnsProcess, false);
  assert.equal(packet.integrationContract.startsSidecar, false);
  assert.equal(packet.semantics.runtimePreflightApprovalPacketOnly, true);
  assert.equal(packet.semantics.adapterOutputDoesNotImplyReceiptProof, true);
});

test("runtime preflight approval waits for unready invocation rehearsal", () => {
  const packet = buildTerminalBriefSidecarRuntimePreflightApproval(rehearsal({
    state: "waiting_for_start_executor_review",
    readiness: {
      ...rehearsal().readiness,
      sourceCriteriaMet: false,
      executorInvocationRehearsalReady: false,
      adapterContractReady: false,
    },
  }), { now: NOW });

  assert.equal(packet.state, "waiting_for_invocation_rehearsal");
  assert.deepEqual(packet.readiness.missingEvidence, [
    "ready_executor_invocation_rehearsal",
    "source_criteria",
    "executor_invocation_rehearsal",
    "adapter_contract",
  ]);
  assert.equal(packet.readiness.executionPermitted, false);
});

test("runtime preflight approval preserves stale conflicting and rejected states", () => {
  const stale = buildTerminalBriefSidecarRuntimePreflightApproval(rehearsal({ state: "stale" }), { now: NOW });
  const conflicting = buildTerminalBriefSidecarRuntimePreflightApproval(rehearsal({ state: "conflicting" }), { now: NOW });
  const rejected = buildTerminalBriefSidecarRuntimePreflightApproval(rehearsal({ state: "rejected" }), { now: NOW });

  assert.equal(stale.state, "stale");
  assert.equal(conflicting.state, "conflicting");
  assert.equal(rejected.state, "rejected");
  assert.equal(stale.readiness.sidecarStartPermitted, false);
  assert.equal(conflicting.readiness.sidecarStartPermitted, false);
  assert.equal(rejected.readiness.sidecarStartPermitted, false);
});

test("runtime preflight approval blocks unsafe adapter contract drift", () => {
  const unsafe = rehearsal();
  unsafe.invocationPlan.adapterContract.output.terminalAckPermitted = true as false;
  const packet = buildTerminalBriefSidecarRuntimePreflightApproval(unsafe, { now: NOW });

  assert.equal(packet.state, "blocked");
  assert.equal(packet.blockers.some((blocker) => blocker.includes("terminal ACK")), true);
  assert.equal(packet.readiness.terminalAckPermitted, false);
});

test("runtime preflight approval extractors and markdown preserve no-live boundary", () => {
  const input = {
    executorInvocationRehearsalPacket: rehearsal(),
    runtimePreflightApproval: {
      requested_by: "seoseo",
      operator_target: "round-739",
      required_abort_evidence: ["abortCode", "observedAt"],
    },
  };

  assert.equal(extractTerminalBriefSidecarRuntimePreflightApprovalRehearsal(input).idempotencyKey, "tb-sidecar-executor-invocation-rehearsal:fixture-739");
  assert.equal(extractTerminalBriefSidecarRuntimePreflightApprovalOptions(input).requested_by, "seoseo");

  const packet = buildTerminalBriefSidecarRuntimePreflightApproval(
    extractTerminalBriefSidecarRuntimePreflightApprovalRehearsal(input),
    { ...extractTerminalBriefSidecarRuntimePreflightApprovalOptions(input), now: NOW },
  );
  const markdown = renderTerminalBriefSidecarRuntimePreflightApprovalMarkdown(packet);
  assert.match(markdown, /runtime preflight approval packet only/);
  assert.match(markdown, /executorInvocationPermitted=false/);
  assert.match(markdown, /terminalAckPermitted=false/);
  assert.match(markdown, /executionPermitted=false/);
});
