import assert from "node:assert/strict";
import test from "node:test";

import type { TerminalBriefSidecarActivationReceiptIngestorPacket } from "./terminal-brief-sidecar-activation-receipt-ingestor.js";
import type { TerminalBriefSidecarDryRunStartApprovalReceiptIngestorPacket } from "./terminal-brief-sidecar-dry-run-start-approval-receipt-ingestor.js";
import {
  buildTerminalBriefSidecarStartExecutorGate,
  extractTerminalBriefSidecarStartExecutorGateOptions,
  extractTerminalBriefSidecarStartExecutorGateReceipt,
  renderTerminalBriefSidecarStartExecutorGateMarkdown,
} from "./terminal-brief-sidecar-start-executor-gate.js";

const NOW = "2026-05-18T16:00:00.000Z";

function receipt(overrides: Partial<TerminalBriefSidecarActivationReceiptIngestorPacket> = {}): TerminalBriefSidecarActivationReceiptIngestorPacket {
  const base = {
    kind: "a2a-broker.terminal-brief-sidecar-activation-receipt-ingestor.packet",
    version: 1,
    generatedAt: NOW,
    mode: "read-only/no-live",
    parentRoundId: "round-718",
    state: "accepted",
    dryRunOnly: true,
    sourceOnlyNoLive: true,
    receiptEvidenceAccepted: true,
    approvalEvidenceAccepted: true,
    idempotencyKey: "tb-sidecar-activation-receipt:fixture-718",
    source: {
      activationApprovalState: "approval_request_draft_ready",
      activationApprovalIdempotencyKey: "tb-sidecar-activation-approval:fixture-718",
      requestedAction: "approve_supervised_terminal_brief_sidecar_dry_run_start",
      requestedBy: "broker-finalizer",
      operatorTarget: "operator-a",
      dispatchRequired: true,
      dispatchPermitted: false,
    },
    evidence: {
      received: 3,
      acceptedKinds: ["current_session_visible", "approval_grant"],
      staleKinds: [],
      conflictingKinds: [],
      rejectedKinds: [],
      records: [],
    },
    classification: {
      providerAccepted: true,
      currentSessionVisible: true,
      manualOperatorConfirmed: false,
      approvalGrantAccepted: true,
      receiptProofAccepted: true,
      rejected: false,
      expired: false,
      stale: false,
      terminalAckEligible: true,
      providerAcceptedIsVisibilityProof: false,
      reason: "visibility/manual receipt evidence and matching approval grant evidence accepted as no-live evidence only",
    },
    readiness: {
      sourceCriteriaMet: true,
      approvalEvidenceAccepted: true,
      sidecarStartPermitted: false,
      defaultOnPermitted: false,
      liveActivationPermitted: false,
      approvalGrantPermitted: false,
      providerSendPermitted: false,
      terminalAckPermitted: false,
      executionPermitted: false,
      blockers: [
        "approval grant evidence does not grant approval in this ingestor",
        "sidecar start still requires a separate approved executor path",
      ],
      nextAction: "feed accepted no-live approval evidence into the supervised dry-run start executor gate",
    },
    blockers: [],
    nextActions: [],
    approvalSensitiveActionsExcluded: [],
    integrationContract: {
      transport: "json",
      evidenceSchemaVersion: 1,
      harnessNeutral: true,
      openclawMessageSendRequired: false,
      hermesAdapterCompatible: true,
      gongyungAdapterCompatible: true,
      consumesActivationApprovalPacket: true,
      providerAcceptedIsVisibilityProof: false,
      terminalAckRequiresVisibilityProof: true,
      grantsApproval: false,
      startsSidecar: false,
      enablesDefaultOn: false,
      executesAction: false,
    },
    semantics: {
      receiptIngestorOnly: true,
      sourceOnlyNoLive: true,
      evidenceDoesNotMutateState: true,
      providerAcceptedIsVisibilityProof: false,
      terminalAckEligibleDoesNotPermitAck: true,
      approvalGrantEvidenceDoesNotGrantApproval: true,
      sidecarStartRequiresSeparateApprovedExecutor: true,
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
  } satisfies TerminalBriefSidecarActivationReceiptIngestorPacket;
  return { ...base, ...overrides } as TerminalBriefSidecarActivationReceiptIngestorPacket;
}

function dryRunStartReceipt(
  overrides: Partial<TerminalBriefSidecarDryRunStartApprovalReceiptIngestorPacket> = {},
): TerminalBriefSidecarDryRunStartApprovalReceiptIngestorPacket {
  const base = {
    kind: "a2a-broker.terminal-brief-sidecar-dry-run-start-approval-receipt-ingestor.packet",
    version: 1,
    generatedAt: NOW,
    mode: "read-only/no-live",
    parentRoundId: "round-733",
    state: "accepted",
    dryRunOnly: true,
    sourceOnlyNoLive: true,
    receiptEvidenceAccepted: true,
    approvalEvidenceAccepted: true,
    idempotencyKey: "tb-sidecar-dry-run-start-approval-receipt:fixture-733",
    source: {
      dryRunStartApprovalRequestState: "approval_request_draft_ready",
      dryRunStartApprovalRequestIdempotencyKey: "tb-sidecar-dry-run-start-approval-request:fixture-733",
      requestedAction: "approve_supervised_terminal_brief_sidecar_dry_run_start",
      requestedBy: "seoseo",
      operatorTarget: "round-733",
      operatorChannel: "telegram",
      dispatchRequired: true,
      dispatchPermitted: false,
    },
    evidence: {
      received: 3,
      acceptedKinds: ["current_session_visible", "approval_grant"],
      staleKinds: [],
      conflictingKinds: [],
      rejectedKinds: [],
      records: [],
    },
    classification: {
      providerAccepted: true,
      currentSessionVisible: true,
      manualOperatorConfirmed: false,
      approvalGrantAccepted: true,
      receiptProofAccepted: true,
      rejected: false,
      expired: false,
      stale: false,
      terminalAckEligible: true,
      providerAcceptedIsVisibilityProof: false,
      reason: "visibility/manual receipt evidence and matching approval grant evidence accepted as no-live evidence only",
    },
    readiness: {
      sourceCriteriaMet: true,
      receiptEvidenceAccepted: true,
      approvalEvidenceAccepted: true,
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
      blockers: [
        "approval grant evidence does not grant approval in this ingestor",
        "supervised dry-run start still requires a separate approved executor path",
      ],
      nextAction: "feed accepted no-live approval evidence into a separate supervised dry-run start executor gate",
    },
    blockers: [],
    nextActions: [],
    approvalSensitiveActionsExcluded: [],
    integrationContract: {
      transport: "json",
      evidenceSchemaVersion: 1,
      harnessNeutral: true,
      openclawMessageSendRequired: false,
      hermesAdapterCompatible: true,
      gongyungAdapterCompatible: true,
      consumesDryRunStartApprovalRequestPacket: true,
      providerAcceptedIsVisibilityProof: false,
      terminalAckRequiresVisibilityProof: true,
      grantsApproval: false,
      dispatchesStartExecutor: false,
      invokesExecutor: false,
      spawnsProcess: false,
      startsSidecar: false,
      enablesDefaultOn: false,
      executesAction: false,
    },
    semantics: {
      receiptIngestorOnly: true,
      sourceOnlyNoLive: true,
      evidenceDoesNotMutateState: true,
      providerAcceptedIsVisibilityProof: false,
      terminalAckEligibleDoesNotPermitAck: true,
      approvalGrantEvidenceDoesNotGrantApproval: true,
      dryRunStartRequiresSeparateApprovedExecutor: true,
      defaultOnNotEnabledByThisPacket: true,
      executionNotPermitted: true,
      processSpawnNotPermitted: true,
      sidecarStartNotPermitted: true,
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
  } satisfies TerminalBriefSidecarDryRunStartApprovalReceiptIngestorPacket;
  return { ...base, ...overrides } as TerminalBriefSidecarDryRunStartApprovalReceiptIngestorPacket;
}

test("sidecar start executor gate becomes ready from accepted receipt evidence without dispatching start", () => {
  const packet = buildTerminalBriefSidecarStartExecutorGate(receipt(), {
    now: NOW,
    requestedExecutor: "gongyung-sidecar-dry-run-executor",
    operatorApprovalReference: "operator-visible-approval-1",
    commandName: "terminal-brief-sidecar",
    commandArgs: ["--dry-run", "--poll-ms", "15000"],
    envKeys: ["EDGE_SECRET"],
    abortQueueBacklog: 1000,
  });

  assert.equal(packet.kind, "a2a-broker.terminal-brief-sidecar-start-executor-gate.packet");
  assert.equal(packet.state, "ready_for_start_executor_review");
  assert.equal(packet.readiness.sourceCriteriaMet, true);
  assert.equal(packet.readiness.startExecutorReviewReady, true);
  assert.equal(packet.readiness.startExecutorDispatchPermitted, false);
  assert.equal(packet.readiness.executorInvocationPermitted, false);
  assert.equal(packet.readiness.processSpawnPermitted, false);
  assert.equal(packet.readiness.sidecarStartPermitted, false);
  assert.equal(packet.readiness.defaultOnPermitted, false);
  assert.equal(packet.readiness.providerSendPermitted, false);
  assert.equal(packet.readiness.terminalAckPermitted, false);
  assert.equal(packet.readiness.executionPermitted, false);
  assert.equal(packet.startPlan.commandShape.commandExecutionPermitted, false);
  assert.equal(packet.startPlan.commandShape.secretsIncluded, false);
  assert.deepEqual(packet.startPlan.commandShape.envKeys, ["EDGE_SECRET"]);
  assert.equal(packet.integrationContract.dispatchesStartExecutor, false);
  assert.equal(packet.integrationContract.invokesExecutor, false);
  assert.equal(packet.integrationContract.spawnsProcess, false);
  assert.equal(packet.integrationContract.startsSidecar, false);
});

test("sidecar start executor gate consumes dry-run start approval receipt evidence", () => {
  const packet = buildTerminalBriefSidecarStartExecutorGate(dryRunStartReceipt(), {
    now: NOW,
    requestedExecutor: "gongyung-sidecar-dry-run-executor",
    operatorApprovalReference: "operator-visible-approval-733",
    commandName: "terminal-brief-sidecar",
    commandArgs: ["--dry-run", "--poll-ms", "15000"],
    envKeys: ["EDGE_SECRET"],
  });

  assert.equal(packet.state, "ready_for_start_executor_review");
  assert.equal(packet.source.receiptKind, "a2a-broker.terminal-brief-sidecar-dry-run-start-approval-receipt-ingestor.packet");
  assert.equal(packet.source.requestedAction, "approve_supervised_terminal_brief_sidecar_dry_run_start");
  assert.equal(packet.integrationContract.consumesActivationReceiptIngestorPacket, false);
  assert.equal(packet.integrationContract.consumesDryRunStartApprovalReceiptIngestorPacket, true);
  assert.equal(packet.readiness.startExecutorDispatchPermitted, false);
  assert.equal(packet.readiness.executorInvocationPermitted, false);
  assert.equal(packet.readiness.processSpawnPermitted, false);
  assert.equal(packet.readiness.executionPermitted, false);
  assert.equal(packet.startPlan.commandShape.commandExecutionPermitted, false);
  assert.equal(packet.integrationContract.invokesExecutor, false);
  assert.equal(packet.integrationContract.spawnsProcess, false);
  assert.equal(packet.semantics.performsTerminalAck, false);
});

test("sidecar start executor gate waits for non-accepted receipt evidence", () => {
  const packet = buildTerminalBriefSidecarStartExecutorGate(receipt({
    state: "insufficient",
    receiptEvidenceAccepted: false,
    approvalEvidenceAccepted: false,
    readiness: {
      ...receipt().readiness,
      sourceCriteriaMet: false,
      approvalEvidenceAccepted: false,
    },
  }), { now: NOW });

  assert.equal(packet.state, "waiting_for_accepted_evidence");
  assert.deepEqual(packet.readiness.missingEvidence, ["receipt_evidence", "approval_evidence", "source_criteria"]);
  assert.equal(packet.readiness.sidecarStartPermitted, false);
});

test("sidecar start executor gate preserves stale conflicting and rejected states", () => {
  const stale = buildTerminalBriefSidecarStartExecutorGate(receipt({ state: "stale" }), { now: NOW });
  const conflicting = buildTerminalBriefSidecarStartExecutorGate(receipt({ state: "conflicting" }), { now: NOW });
  const rejected = buildTerminalBriefSidecarStartExecutorGate(receipt({ state: "rejected" }), { now: NOW });

  assert.equal(stale.state, "stale");
  assert.equal(conflicting.state, "conflicting");
  assert.equal(rejected.state, "rejected");
  assert.equal(stale.readiness.sidecarStartPermitted, false);
  assert.equal(conflicting.readiness.sidecarStartPermitted, false);
  assert.equal(rejected.readiness.sidecarStartPermitted, false);
});

test("sidecar start executor gate blocks unsafe no-live violations", () => {
  const packet = buildTerminalBriefSidecarStartExecutorGate(receipt({
    readiness: {
      ...receipt().readiness,
      sidecarStartPermitted: true as false,
    },
  }), { now: NOW });

  assert.equal(packet.state, "blocked");
  assert.equal(packet.blockers.some((blocker) => blocker.includes("permits sidecar start")), true);
  assert.equal(packet.readiness.sidecarStartPermitted, false);
});

test("sidecar start executor gate extractors and markdown preserve metadata-only boundary", () => {
  const input = {
    sidecarActivationReceipt: receipt(),
    startExecutorGate: {
      requestedExecutor: "dry-run-executor",
      command_name: "terminal-brief-sidecar",
      command_args: ["--dry-run"],
      env_keys: ["EDGE_SECRET"],
    },
  };

  assert.equal(extractTerminalBriefSidecarStartExecutorGateReceipt(input).idempotencyKey, "tb-sidecar-activation-receipt:fixture-718");
  assert.equal(extractTerminalBriefSidecarStartExecutorGateOptions(input).command_name, "terminal-brief-sidecar");

  const packet = buildTerminalBriefSidecarStartExecutorGate(
    extractTerminalBriefSidecarStartExecutorGateReceipt(input),
    { ...extractTerminalBriefSidecarStartExecutorGateOptions(input), now: NOW },
  );
  const markdown = renderTerminalBriefSidecarStartExecutorGateMarkdown(packet);
  assert.match(markdown, /start executor gate only/);
  assert.match(markdown, /sidecarStartPermitted=false/);
  assert.match(markdown, /executorInvocationPermitted=false/);
  assert.match(markdown, /executionPermitted=false/);

  assert.equal(
    extractTerminalBriefSidecarStartExecutorGateReceipt({
      sidecarDryRunStartApprovalReceiptPacket: dryRunStartReceipt(),
    }).idempotencyKey,
    "tb-sidecar-dry-run-start-approval-receipt:fixture-733",
  );
});
