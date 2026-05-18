import { createHash } from "node:crypto";

import type { TerminalBriefSidecarActivationReceiptIngestorPacket } from "./terminal-brief-sidecar-activation-receipt-ingestor.js";
import type { TerminalBriefSidecarDryRunStartApprovalReceiptIngestorPacket } from "./terminal-brief-sidecar-dry-run-start-approval-receipt-ingestor.js";

type TerminalBriefSidecarStartExecutorGateReceipt =
  | TerminalBriefSidecarActivationReceiptIngestorPacket
  | TerminalBriefSidecarDryRunStartApprovalReceiptIngestorPacket;

export type TerminalBriefSidecarStartExecutorGateState =
  | "ready_for_start_executor_review"
  | "waiting_for_accepted_evidence"
  | "stale"
  | "conflicting"
  | "rejected"
  | "blocked";

export interface TerminalBriefSidecarStartExecutorGateOptions {
  now?: string;
  mode?: string;
  requestedExecutor?: string;
  requested_executor?: string;
  operatorApprovalReference?: string;
  operator_approval_reference?: string;
  dryRunReason?: string;
  dry_run_reason?: string;
  commandName?: string;
  command_name?: string;
  commandArgs?: string[];
  command_args?: string[];
  envKeys?: string[];
  env_keys?: string[];
  abortQueueBacklog?: number;
  abort_queue_backlog?: number;
}

export interface TerminalBriefSidecarStartExecutorGatePacket {
  kind: "a2a-broker.terminal-brief-sidecar-start-executor-gate.packet";
  version: 1;
  generatedAt: string;
  mode: string;
  parentRoundId?: string;
  state: TerminalBriefSidecarStartExecutorGateState;
  dryRunOnly: true;
  sourceOnlyNoLive: true;
  idempotencyKey: string;
  source: {
    receiptKind: TerminalBriefSidecarStartExecutorGateReceipt["kind"];
    receiptState: TerminalBriefSidecarStartExecutorGateReceipt["state"];
    receiptIdempotencyKey: string;
    receiptEvidenceAccepted: boolean;
    approvalEvidenceAccepted: boolean;
    terminalAckEligible: boolean;
    requestedAction: string;
    operatorTarget: string;
  };
  startPlan: {
    supervisedDryRunOnly: true;
    requestedExecutor: string;
    operatorApprovalReference?: string;
    dryRunReason: string;
    commandShape: {
      kind: "metadata_only";
      commandName: string;
      commandArgs: string[];
      envKeys: string[];
      commandExecutionPermitted: false;
      secretsIncluded: false;
    };
    abortQueueBacklog?: number;
    abortConditions: string[];
    rollbackInstructions: string[];
  };
  readiness: {
    sourceCriteriaMet: boolean;
    startExecutorReviewReady: boolean;
    startExecutorDispatchPermitted: false;
    executorInvocationPermitted: false;
    processSpawnPermitted: false;
    sidecarStartPermitted: false;
    defaultOnPermitted: false;
    liveActivationPermitted: false;
    approvalGrantPermitted: false;
    providerSendPermitted: false;
    terminalAckPermitted: false;
    executionPermitted: false;
    missingEvidence: string[];
    blockers: string[];
    nextAction: string;
  };
  blockers: string[];
  nextActions: string[];
  approvalSensitiveActionsExcluded: string[];
  integrationContract: {
    transport: "json";
    gateVersion: 1;
    harnessNeutral: true;
    openclawMessageSendRequired: false;
    hermesAdapterCompatible: true;
    gongyungAdapterCompatible: true;
    consumesActivationReceiptIngestorPacket: boolean;
    consumesDryRunStartApprovalReceiptIngestorPacket: boolean;
    dispatchesStartExecutor: false;
    invokesExecutor: false;
    spawnsProcess: false;
    grantsApproval: false;
    startsSidecar: false;
    enablesDefaultOn: false;
    executesAction: false;
  };
  semantics: {
    startExecutorGateOnly: true;
    sourceOnlyNoLive: true;
    gateDoesNotMutateState: true;
    commandShapeIsMetadataOnly: true;
    providerAcceptedIsVisibilityProof: false;
    terminalAckEligibleDoesNotPermitAck: true;
    approvalGrantEvidenceDoesNotGrantApproval: true;
    sidecarStartRequiresSeparateApprovedExecutor: true;
    defaultOnNotEnabledByThisPacket: true;
    executionNotPermitted: true;
    executorInvocationNotPermitted: true;
    processSpawnNotPermitted: true;
    routeIsReadOnly: true;
    brokerFinalizerRequired: true;
    performsGitHubMutation: false;
    performsProviderSend: false;
    performsTerminalAck: false;
    performsRuntimeRestartOrDeploy: false;
    performsDbMutation: false;
    createsTaskFlowRecords: false;
    performsHistoricalReplay: false;
    performsReleaseOrPublish: false;
    movesSecretsOrCredentials: false;
  };
}

export function buildTerminalBriefSidecarStartExecutorGate(
  receipt: TerminalBriefSidecarStartExecutorGateReceipt,
  options: TerminalBriefSidecarStartExecutorGateOptions = {},
): TerminalBriefSidecarStartExecutorGatePacket {
  const generatedAt = options.now ?? new Date().toISOString();
  const blockers = buildBlockers(receipt);
  const state = stateFor(receipt, blockers);
  const sourceCriteriaMet = state === "ready_for_start_executor_review";
  const missingEvidence = missingEvidenceFor(receipt);
  return {
    kind: "a2a-broker.terminal-brief-sidecar-start-executor-gate.packet",
    version: 1,
    generatedAt,
    mode: options.mode ?? receipt.mode,
    parentRoundId: receipt.parentRoundId,
    state,
    dryRunOnly: true,
    sourceOnlyNoLive: true,
    idempotencyKey: buildGateIdempotencyKey(receipt, generatedAt, state, options),
    source: {
      receiptKind: receipt.kind,
      receiptState: receipt.state,
      receiptIdempotencyKey: receipt.idempotencyKey,
      receiptEvidenceAccepted: receipt.receiptEvidenceAccepted,
      approvalEvidenceAccepted: receipt.approvalEvidenceAccepted,
      terminalAckEligible: receipt.classification.terminalAckEligible,
      requestedAction: receipt.source.requestedAction,
      operatorTarget: receipt.source.operatorTarget,
    },
    startPlan: {
      supervisedDryRunOnly: true,
      requestedExecutor: optionalString(options.requestedExecutor ?? options.requested_executor) ?? "supervised-sidecar-dry-run-executor",
      operatorApprovalReference: optionalString(options.operatorApprovalReference ?? options.operator_approval_reference),
      dryRunReason: optionalString(options.dryRunReason ?? options.dry_run_reason) ?? "terminal-brief-supervised-sidecar-dry-run",
      commandShape: {
        kind: "metadata_only",
        commandName: optionalString(options.commandName ?? options.command_name) ?? "terminal-brief-sidecar",
        commandArgs: stringArray(options.commandArgs ?? options.command_args),
        envKeys: stringArray(options.envKeys ?? options.env_keys),
        commandExecutionPermitted: false,
        secretsIncluded: false,
      },
      abortQueueBacklog: numberValue(options.abortQueueBacklog ?? options.abort_queue_backlog),
      abortConditions: abortConditions(options),
      rollbackInstructions: [
        "do not start the sidecar from this gate packet",
        "preserve receipt and approval evidence before any separate executor review",
        "keep terminal ACK/replay, default-on, live send, deploy, and DB mutation disabled",
      ],
    },
    readiness: {
      sourceCriteriaMet,
      startExecutorReviewReady: sourceCriteriaMet,
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
      missingEvidence,
      blockers: [
        ...blockers,
        "start executor dispatch is not permitted by this gate",
        "sidecar start still requires a separate approved executor invocation",
      ],
      nextAction: sourceCriteriaMet
        ? "request explicit operator approval for a separate supervised dry-run start executor invocation"
        : "resolve accepted receipt and approval evidence before start-executor review",
    },
    blockers,
    nextActions: nextActionsFor(state),
    approvalSensitiveActionsExcluded: [
      "starting/enabling always-on sidecar",
      "Terminal Brief default-on enablement",
      "live provider/Hermes/Gongyung/Telegram/OpenClaw send",
      "terminal ACK/replay or terminal receipt DB mutation",
      "operator approval grant mutation or execution",
      "GitHub PR merge, issue close, or comment post from the gate",
      "TaskFlow record creation or broker DB mutation",
      "production deploy/restart, historical replay, release, publish, or secret movement",
    ],
    integrationContract: {
      transport: "json",
      gateVersion: 1,
      harnessNeutral: true,
      openclawMessageSendRequired: false,
      hermesAdapterCompatible: true,
      gongyungAdapterCompatible: true,
      consumesActivationReceiptIngestorPacket: receipt.kind === "a2a-broker.terminal-brief-sidecar-activation-receipt-ingestor.packet",
      consumesDryRunStartApprovalReceiptIngestorPacket: receipt.kind === "a2a-broker.terminal-brief-sidecar-dry-run-start-approval-receipt-ingestor.packet",
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
  };
}

export function extractTerminalBriefSidecarStartExecutorGateReceipt(
  input: unknown,
): TerminalBriefSidecarStartExecutorGateReceipt {
  const envelope = isRecord(input) ? input : {};
  const candidates = [
    input,
    envelope.activationReceipt,
    envelope.activationReceiptPacket,
    envelope.sidecarActivationReceipt,
    envelope.sidecarActivationReceiptPacket,
    envelope.dryRunStartApprovalReceipt,
    envelope.dryRunStartApprovalReceiptPacket,
    envelope.sidecarDryRunStartApprovalReceipt,
    envelope.sidecarDryRunStartApprovalReceiptPacket,
    envelope.receiptIngestor,
    envelope.receiptIngestorPacket,
    envelope.packet,
  ];
  const packet = candidates.find(isTerminalBriefSidecarStartExecutorGateReceipt);
  if (!packet) {
    throw new Error("expected a Terminal Brief sidecar activation or dry-run start approval receipt ingestor packet");
  }
  return packet;
}

export function extractTerminalBriefSidecarStartExecutorGateOptions(
  input: unknown,
): TerminalBriefSidecarStartExecutorGateOptions {
  const envelope = isRecord(input) ? input : {};
  const candidate = envelope.startExecutorGate
    ?? envelope.startExecutorGateOptions
    ?? envelope.startPlan
    ?? envelope.executorOptions
    ?? envelope.options;
  return isRecord(candidate) ? candidate as TerminalBriefSidecarStartExecutorGateOptions : {};
}

export function renderTerminalBriefSidecarStartExecutorGateMarkdown(
  packet: TerminalBriefSidecarStartExecutorGatePacket,
): string {
  return [
    titleForState(packet.state),
    "Mode: " + packet.mode,
    "Parent round: " + (packet.parentRoundId ?? "unknown"),
    "State: " + packet.state + " dryRunOnly=" + packet.dryRunOnly + " sourceOnlyNoLive=" + packet.sourceOnlyNoLive,
    "Idempotency: " + packet.idempotencyKey,
    "Receipt: state=" + packet.source.receiptState
      + " receiptEvidenceAccepted=" + packet.source.receiptEvidenceAccepted
      + " approvalEvidenceAccepted=" + packet.source.approvalEvidenceAccepted
      + " terminalAckEligible=" + packet.source.terminalAckEligible,
    "Start plan: executor=" + packet.startPlan.requestedExecutor
      + " dryRunReason=" + packet.startPlan.dryRunReason
      + " commandExecutionPermitted=" + packet.startPlan.commandShape.commandExecutionPermitted,
    "",
    "Readiness: sourceCriteriaMet=" + packet.readiness.sourceCriteriaMet
      + " startExecutorReviewReady=" + packet.readiness.startExecutorReviewReady
      + " startExecutorDispatchPermitted=" + packet.readiness.startExecutorDispatchPermitted
      + " executorInvocationPermitted=" + packet.readiness.executorInvocationPermitted
      + " processSpawnPermitted=" + packet.readiness.processSpawnPermitted
      + " sidecarStartPermitted=" + packet.readiness.sidecarStartPermitted
      + " terminalAckPermitted=" + packet.readiness.terminalAckPermitted
      + " executionPermitted=" + packet.readiness.executionPermitted,
    ...(packet.blockers.length ? ["", "Blockers:", ...packet.blockers.map((blocker) => "- " + blocker)] : []),
    "",
    "Next actions:",
    ...packet.nextActions.map((action) => "- " + action),
    "",
    "Safety: start executor gate only; command shape is metadata only; does not dispatch or invoke executor, spawn a process, start sidecar, enable default-on, send providers, ACK/replay terminal rows, mutate GitHub/DB/TaskFlow state, restart/deploy, replay history, release, publish, or move secrets.",
  ].join("\n");
}

function buildBlockers(receipt: TerminalBriefSidecarStartExecutorGateReceipt): string[] {
  return unique([
    ...receipt.blockers,
    ...(receipt.state !== "accepted" ? ["receipt ingestor is " + receipt.state] : []),
    ...(!receipt.receiptEvidenceAccepted ? ["receipt proof evidence is not accepted"] : []),
    ...(!receipt.approvalEvidenceAccepted ? ["approval evidence is not accepted"] : []),
    ...(!receipt.readiness.sourceCriteriaMet ? ["activation receipt source criteria are not met"] : []),
    ...(receipt.readiness.sidecarStartPermitted !== false ? ["receipt ingestor unexpectedly permits sidecar start"] : []),
    ...(receipt.readiness.defaultOnPermitted !== false ? ["receipt ingestor unexpectedly permits default-on"] : []),
    ...(receipt.readiness.approvalGrantPermitted !== false ? ["receipt ingestor unexpectedly permits approval grant"] : []),
    ...("startExecutorDispatchPermitted" in receipt.readiness && receipt.readiness.startExecutorDispatchPermitted !== false ? ["receipt ingestor unexpectedly permits start executor dispatch"] : []),
    ...("executorInvocationPermitted" in receipt.readiness && receipt.readiness.executorInvocationPermitted !== false ? ["receipt ingestor unexpectedly permits executor invocation"] : []),
    ...("processSpawnPermitted" in receipt.readiness && receipt.readiness.processSpawnPermitted !== false ? ["receipt ingestor unexpectedly permits process spawn"] : []),
    ...(receipt.readiness.providerSendPermitted !== false ? ["receipt ingestor unexpectedly permits provider send"] : []),
    ...(receipt.readiness.terminalAckPermitted !== false ? ["receipt ingestor unexpectedly permits terminal ACK"] : []),
    ...(receipt.readiness.executionPermitted !== false ? ["receipt ingestor unexpectedly permits execution"] : []),
    ...(receipt.integrationContract.grantsApproval ? ["receipt ingestor unexpectedly grants approval"] : []),
    ...("dispatchesStartExecutor" in receipt.integrationContract && receipt.integrationContract.dispatchesStartExecutor ? ["receipt ingestor unexpectedly dispatches start executor"] : []),
    ...("invokesExecutor" in receipt.integrationContract && receipt.integrationContract.invokesExecutor ? ["receipt ingestor unexpectedly invokes executor"] : []),
    ...("spawnsProcess" in receipt.integrationContract && receipt.integrationContract.spawnsProcess ? ["receipt ingestor unexpectedly spawns process"] : []),
    ...(receipt.integrationContract.startsSidecar ? ["receipt ingestor unexpectedly starts sidecar"] : []),
    ...(receipt.integrationContract.enablesDefaultOn ? ["receipt ingestor unexpectedly enables default-on"] : []),
    ...(receipt.integrationContract.executesAction ? ["receipt ingestor unexpectedly executes action"] : []),
    ...(receipt.semantics.performsProviderSend ? ["receipt ingestor unexpectedly performs provider send"] : []),
    ...(receipt.semantics.performsTerminalAck ? ["receipt ingestor unexpectedly performs terminal ACK"] : []),
    ...(receipt.semantics.performsRuntimeRestartOrDeploy ? ["receipt ingestor unexpectedly performs restart/deploy"] : []),
    ...(receipt.semantics.performsDbMutation ? ["receipt ingestor unexpectedly performs DB mutation"] : []),
    ...(receipt.semantics.performsHistoricalReplay ? ["receipt ingestor unexpectedly performs historical replay"] : []),
    ...(receipt.semantics.performsReleaseOrPublish ? ["receipt ingestor unexpectedly performs release/publish"] : []),
    ...(receipt.semantics.movesSecretsOrCredentials ? ["receipt ingestor unexpectedly moves secrets/credentials"] : []),
  ].filter(Boolean));
}

function stateFor(
  receipt: TerminalBriefSidecarStartExecutorGateReceipt,
  blockers: string[],
): TerminalBriefSidecarStartExecutorGateState {
  if (receipt.state === "stale") return "stale";
  if (receipt.state === "conflicting") return "conflicting";
  if (receipt.state === "rejected") return "rejected";
  if (receipt.state === "blocked" || hasUnsafeNoLiveViolation(receipt)) return "blocked";
  if (receipt.state !== "accepted") return "waiting_for_accepted_evidence";
  return blockers.length ? "blocked" : "ready_for_start_executor_review";
}

function hasUnsafeNoLiveViolation(receipt: TerminalBriefSidecarStartExecutorGateReceipt): boolean {
  return receipt.readiness.sidecarStartPermitted !== false
    || receipt.readiness.defaultOnPermitted !== false
    || receipt.readiness.approvalGrantPermitted !== false
    || ("startExecutorDispatchPermitted" in receipt.readiness && receipt.readiness.startExecutorDispatchPermitted !== false)
    || ("executorInvocationPermitted" in receipt.readiness && receipt.readiness.executorInvocationPermitted !== false)
    || ("processSpawnPermitted" in receipt.readiness && receipt.readiness.processSpawnPermitted !== false)
    || receipt.readiness.providerSendPermitted !== false
    || receipt.readiness.terminalAckPermitted !== false
    || receipt.readiness.executionPermitted !== false
    || receipt.integrationContract.grantsApproval
    || ("dispatchesStartExecutor" in receipt.integrationContract && receipt.integrationContract.dispatchesStartExecutor)
    || ("invokesExecutor" in receipt.integrationContract && receipt.integrationContract.invokesExecutor)
    || ("spawnsProcess" in receipt.integrationContract && receipt.integrationContract.spawnsProcess)
    || receipt.integrationContract.startsSidecar
    || receipt.integrationContract.enablesDefaultOn
    || receipt.integrationContract.executesAction
    || receipt.semantics.performsProviderSend
    || receipt.semantics.performsTerminalAck
    || receipt.semantics.performsRuntimeRestartOrDeploy
    || receipt.semantics.performsDbMutation
    || receipt.semantics.performsHistoricalReplay
    || receipt.semantics.performsReleaseOrPublish
    || receipt.semantics.movesSecretsOrCredentials;
}

function missingEvidenceFor(receipt: TerminalBriefSidecarStartExecutorGateReceipt): string[] {
  const missing: string[] = [];
  if (!receipt.receiptEvidenceAccepted) missing.push("receipt_evidence");
  if (!receipt.approvalEvidenceAccepted) missing.push("approval_evidence");
  if (!receipt.readiness.sourceCriteriaMet) missing.push("source_criteria");
  return missing;
}

function abortConditions(options: TerminalBriefSidecarStartExecutorGateOptions): string[] {
  const queueLimit = numberValue(options.abortQueueBacklog ?? options.abort_queue_backlog);
  return [
    "Gateway readiness is false or unavailable before the separate executor invocation",
    "Gateway event loop is degraded before or during supervised dry-run",
    "queue backlog exceeds " + (queueLimit ?? "configured limit"),
    "sidecar dry-run-only mode is false",
    "cross-broker operatorEvents becomes enabled",
    "cursor persistence or bounded polling evidence disappears",
    "provider send or terminal ACK/replay is attempted by this path",
  ];
}

function nextActionsFor(state: TerminalBriefSidecarStartExecutorGateState): string[] {
  if (state === "ready_for_start_executor_review") {
    return [
      "request explicit operator approval for a separate supervised dry-run start executor invocation",
      "keep this gate read-only and do not dispatch or execute the start command from it",
    ];
  }
  if (state === "waiting_for_accepted_evidence") {
    return [
      "collect accepted activation receipt and approval evidence first",
      "do not review start executor readiness from insufficient evidence",
    ];
  }
  if (state === "stale") {
    return [
      "refresh activation receipt and approval evidence before start-executor review",
      "do not rely on stale approval evidence for sidecar start",
    ];
  }
  if (state === "conflicting") {
    return [
      "resolve conflicting activation receipt evidence before start-executor review",
      "rerun the ingestor with one coherent evidence set",
    ];
  }
  if (state === "rejected") {
    return [
      "do not start the supervised dry-run sidecar",
      "create a new approval request only if the operator changes the decision",
    ];
  }
  return [
    "resolve blocked/unsafe activation evidence before start-executor review",
    "do not dispatch executor, start sidecar, send providers, ACK terminal rows, or mutate state from a blocked gate",
  ];
}

function buildGateIdempotencyKey(
  receipt: TerminalBriefSidecarStartExecutorGateReceipt,
  generatedAt: string,
  state: TerminalBriefSidecarStartExecutorGateState,
  options: TerminalBriefSidecarStartExecutorGateOptions,
): string {
  const base = JSON.stringify({
    label: "terminal-brief-sidecar-start-executor-gate",
    parentRoundId: receipt.parentRoundId ?? "unknown",
    receiptKind: receipt.kind,
    receipt: receipt.idempotencyKey,
    generatedAt,
    state,
    requestedExecutor: options.requestedExecutor ?? options.requested_executor,
    operatorApprovalReference: options.operatorApprovalReference ?? options.operator_approval_reference,
  });
  return "tb-sidecar-start-executor-gate:" + createHash("sha256").update(base).digest("hex").slice(0, 24);
}

function titleForState(state: TerminalBriefSidecarStartExecutorGateState): string {
  if (state === "ready_for_start_executor_review") return "Ready: Terminal Brief sidecar start executor gate";
  if (state === "waiting_for_accepted_evidence") return "Waiting: Terminal Brief sidecar accepted activation evidence";
  if (state === "stale") return "Stale: Terminal Brief sidecar start executor gate source";
  if (state === "conflicting") return "Conflicting: Terminal Brief sidecar start executor gate source";
  if (state === "rejected") return "Rejected: Terminal Brief sidecar start executor gate source";
  return "Blocked: Terminal Brief sidecar start executor gate";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function isTerminalBriefSidecarActivationReceiptIngestorPacket(value: unknown): value is TerminalBriefSidecarActivationReceiptIngestorPacket {
  return isRecord(value) && value.kind === "a2a-broker.terminal-brief-sidecar-activation-receipt-ingestor.packet";
}

function isTerminalBriefSidecarDryRunStartApprovalReceiptIngestorPacket(
  value: unknown,
): value is TerminalBriefSidecarDryRunStartApprovalReceiptIngestorPacket {
  return isRecord(value) && value.kind === "a2a-broker.terminal-brief-sidecar-dry-run-start-approval-receipt-ingestor.packet";
}

function isTerminalBriefSidecarStartExecutorGateReceipt(
  value: unknown,
): value is TerminalBriefSidecarStartExecutorGateReceipt {
  return isTerminalBriefSidecarActivationReceiptIngestorPacket(value)
    || isTerminalBriefSidecarDryRunStartApprovalReceiptIngestorPacket(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
