import assert from "node:assert/strict";
import test from "node:test";

import type { TerminalBriefSidecarStartExecutorGatePacket } from "./terminal-brief-sidecar-start-executor-gate.js";
import {
  buildTerminalBriefSidecarExecutorInvocationRehearsal,
  extractTerminalBriefSidecarExecutorInvocationRehearsalGate,
  extractTerminalBriefSidecarExecutorInvocationRehearsalOptions,
  renderTerminalBriefSidecarExecutorInvocationRehearsalMarkdown,
} from "./terminal-brief-sidecar-executor-invocation-rehearsal.js";

const NOW = "2026-05-18T18:00:00.000Z";

function gate(overrides: Partial<TerminalBriefSidecarStartExecutorGatePacket> = {}): TerminalBriefSidecarStartExecutorGatePacket {
  const base = {
    kind: "a2a-broker.terminal-brief-sidecar-start-executor-gate.packet",
    version: 1,
    generatedAt: NOW,
    mode: "read-only/no-live",
    parentRoundId: "round-720",
    state: "ready_for_start_executor_review",
    dryRunOnly: true,
    sourceOnlyNoLive: true,
    idempotencyKey: "tb-sidecar-start-executor-gate:fixture-720",
    source: {
      receiptKind: "a2a-broker.terminal-brief-sidecar-activation-receipt-ingestor.packet",
      receiptState: "accepted",
      receiptIdempotencyKey: "tb-sidecar-activation-receipt:fixture-720",
      receiptEvidenceAccepted: true,
      approvalEvidenceAccepted: true,
      terminalAckEligible: true,
      requestedAction: "approve_supervised_terminal_brief_sidecar_dry_run_start",
      operatorTarget: "operator-a",
    },
    startPlan: {
      supervisedDryRunOnly: true,
      requestedExecutor: "gongyung-sidecar-dry-run-executor",
      operatorApprovalReference: "operator-visible-approval-720",
      dryRunReason: "sidecar-gongyung-spool-dry-run",
      commandShape: {
        kind: "metadata_only",
        commandName: "terminal-brief-sidecar",
        commandArgs: ["--dry-run", "--poll-ms", "15000"],
        envKeys: ["EDGE_SECRET"],
        commandExecutionPermitted: false,
        secretsIncluded: false,
      },
      abortQueueBacklog: 1000,
      abortConditions: ["Gateway readiness is false"],
      rollbackInstructions: ["do not start the sidecar from this gate packet"],
    },
    readiness: {
      sourceCriteriaMet: true,
      startExecutorReviewReady: true,
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
      nextAction: "request explicit operator approval for a separate supervised dry-run start executor invocation",
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
      consumesActivationReceiptIngestorPacket: true,
      consumesDryRunStartApprovalReceiptIngestorPacket: false,
      dispatchesStartExecutor: false,
      invokesExecutor: false,
      spawnsProcess: false,
      grantsApproval: false,
      startsSidecar: false,
      enablesDefaultOn: false,
      executesAction: false,
    },
    semantics: {
      startExecutorGateOnly: true,
      sourceOnlyNoLive: true,
      gateDoesNotMutateState: true,
      commandShapeIsMetadataOnly: true,
      providerAcceptedIsVisibilityProof: false,
      terminalAckEligibleDoesNotPermitAck: true,
      approvalGrantEvidenceDoesNotGrantApproval: true,
      sidecarStartRequiresSeparateApprovedExecutor: true,
      defaultOnNotEnabledByThisPacket: true,
      executionNotPermitted: true,
      executorInvocationNotPermitted: true,
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
  } satisfies TerminalBriefSidecarStartExecutorGatePacket;
  return { ...base, ...overrides } as TerminalBriefSidecarStartExecutorGatePacket;
}

test("sidecar executor invocation rehearsal becomes ready without invoking executor", () => {
  const packet = buildTerminalBriefSidecarExecutorInvocationRehearsal(gate(), {
    now: NOW,
    adapterName: "gongyung",
    executorRuntime: "supervised-dry-run",
    supervisor: "terminal-brief-sidecar-worker",
    healthCheckTarget: "/readyz",
    maxRuntimeSeconds: 300,
  });

  assert.equal(packet.kind, "a2a-broker.terminal-brief-sidecar-executor-invocation-rehearsal.packet");
  assert.equal(packet.state, "ready_for_executor_invocation_rehearsal");
  assert.equal(packet.invocationPlan.executorName, "gongyung-sidecar-dry-run-executor");
  assert.equal(packet.invocationPlan.adapterName, "gongyung");
  assert.equal(packet.readiness.executorInvocationRehearsalReady, true);
  assert.equal(packet.readiness.startExecutorDispatchPermitted, false);
  assert.equal(packet.readiness.executorInvocationPermitted, false);
  assert.equal(packet.readiness.processSpawnPermitted, false);
  assert.equal(packet.readiness.sidecarStartPermitted, false);
  assert.equal(packet.readiness.defaultOnPermitted, false);
  assert.equal(packet.readiness.providerSendPermitted, false);
  assert.equal(packet.readiness.terminalAckPermitted, false);
  assert.equal(packet.readiness.executionPermitted, false);
  assert.equal(packet.invocationPlan.commandShape.commandExecutionPermitted, false);
  assert.equal(packet.invocationPlan.commandShape.processSpawnPermitted, false);
  assert.equal(packet.invocationPlan.commandShape.secretsIncluded, false);
  assert.deepEqual(packet.invocationPlan.commandShape.commandArgs, ["--dry-run", "--poll-ms", "15000"]);
  assert.equal(packet.integrationContract.invokesExecutor, false);
  assert.equal(packet.integrationContract.spawnsProcess, false);
  assert.equal(packet.integrationContract.startsSidecar, false);
  assert.equal(packet.semantics.processSpawnNotPermitted, true);
});

test("sidecar executor invocation rehearsal waits for an unready start gate", () => {
  const packet = buildTerminalBriefSidecarExecutorInvocationRehearsal(gate({
    state: "waiting_for_accepted_evidence",
    readiness: {
      ...gate().readiness,
      sourceCriteriaMet: false,
      startExecutorReviewReady: false,
      missingEvidence: ["receipt_evidence"],
    },
  }), { now: NOW });

  assert.equal(packet.state, "waiting_for_start_executor_review");
  assert.deepEqual(packet.readiness.missingEvidence, ["ready_start_executor_gate", "source_criteria", "start_executor_review"]);
  assert.equal(packet.readiness.executorInvocationPermitted, false);
});

test("sidecar executor invocation rehearsal preserves stale conflicting and rejected states", () => {
  const stale = buildTerminalBriefSidecarExecutorInvocationRehearsal(gate({ state: "stale" }), { now: NOW });
  const conflicting = buildTerminalBriefSidecarExecutorInvocationRehearsal(gate({ state: "conflicting" }), { now: NOW });
  const rejected = buildTerminalBriefSidecarExecutorInvocationRehearsal(gate({ state: "rejected" }), { now: NOW });

  assert.equal(stale.state, "stale");
  assert.equal(conflicting.state, "conflicting");
  assert.equal(rejected.state, "rejected");
  assert.equal(stale.readiness.processSpawnPermitted, false);
  assert.equal(conflicting.readiness.processSpawnPermitted, false);
  assert.equal(rejected.readiness.processSpawnPermitted, false);
});

test("sidecar executor invocation rehearsal blocks unsafe no-live violations", () => {
  const packet = buildTerminalBriefSidecarExecutorInvocationRehearsal(gate({
    readiness: {
      ...gate().readiness,
      startExecutorDispatchPermitted: true as false,
    },
  }), { now: NOW });

  assert.equal(packet.state, "blocked");
  assert.equal(packet.blockers.some((blocker) => blocker.includes("permits dispatch")), true);
  assert.equal(packet.readiness.executorInvocationPermitted, false);
});

test("sidecar executor invocation rehearsal extractors and markdown preserve no-live boundary", () => {
  const input = {
    startExecutorGate: gate(),
    executorInvocationRehearsal: {
      adapter_name: "hermes",
      executor_runtime: "metadata-only",
      command_args: ["--dry-run", "--once"],
      env_keys: ["EDGE_SECRET"],
    },
  };

  assert.equal(extractTerminalBriefSidecarExecutorInvocationRehearsalGate(input).idempotencyKey, "tb-sidecar-start-executor-gate:fixture-720");
  assert.equal(extractTerminalBriefSidecarExecutorInvocationRehearsalOptions(input).adapter_name, "hermes");

  const packet = buildTerminalBriefSidecarExecutorInvocationRehearsal(
    extractTerminalBriefSidecarExecutorInvocationRehearsalGate(input),
    { ...extractTerminalBriefSidecarExecutorInvocationRehearsalOptions(input), now: NOW },
  );
  const markdown = renderTerminalBriefSidecarExecutorInvocationRehearsalMarkdown(packet);
  assert.match(markdown, /executor invocation rehearsal only/);
  assert.match(markdown, /executorInvocationPermitted=false/);
  assert.match(markdown, /executionPermitted=false/);
});
