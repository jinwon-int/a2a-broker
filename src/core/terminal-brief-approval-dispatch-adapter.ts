import { createHash } from "node:crypto";

import type {
  TerminalBriefApprovalExecutorPacket,
  TerminalBriefApprovalExecutorState,
} from "./terminal-brief-approval-executor.js";

export type TerminalBriefApprovalDispatchAdapterType = "generic" | "openclaw" | "hermes" | "gongyung";

export type TerminalBriefApprovalDispatchAdapterState =
  | "dispatch_draft_ready"
  | "approval_receipt_draft_ready"
  | "dispatch_blocked";

export interface TerminalBriefApprovalDispatchAdapterOptions {
  now?: string;
  mode?: string;
  adapter?: string;
  target?: string;
  channel?: string;
  requestedBy?: string;
  receiptId?: string;
}

export interface TerminalBriefApprovalDispatchAdapterPacket {
  kind: "a2a-broker.terminal-brief-approval-dispatch-adapter.packet";
  version: 1;
  generatedAt: string;
  mode: string;
  parentRoundId?: string;
  state: TerminalBriefApprovalDispatchAdapterState;
  dryRunOnly: true;
  dispatchPermitted: false;
  providerSendPermitted: false;
  approvalGrantPermitted: false;
  executionPermitted: false;
  terminalReceiptMutationPermitted: false;
  idempotencyKey: string;
  finalizer: TerminalBriefApprovalExecutorPacket["finalizer"];
  adapter: {
    id: string;
    type: TerminalBriefApprovalDispatchAdapterType;
    harnessNeutral: true;
    protocol: "json-transcript";
    requiresOpenClawMessageSend: false;
    supportsExternalHarnesses: true;
    liveSendPermitted: false;
  };
  source: {
    executorState: TerminalBriefApprovalExecutorState;
    executorIdempotencyKey: string;
    approvalRequestIdempotencyKey: string;
    targetIssueUrl?: string;
    targetPrUrl?: string;
    selectedAction?: string;
    selectedTarget?: string;
    requestedActions: number;
    nonRequestableActions: number;
  };
  transcript: {
    mode: "draft-only";
    target?: string;
    channel?: string;
    requestedBy?: string;
    title: string;
    body: string;
    sendPermitted: false;
    sent: false;
    providerMessageId?: never;
  };
  receiptDraft: {
    mode: "draft-only";
    id: string;
    providerAccepted: false;
    currentSessionVisible: false;
    terminalAck: false;
    approvalGranted: false;
    actionExecuted: false;
    reason: string;
  };
  blockers: string[];
  nextActions: string[];
  integrationContract: {
    transport: "json";
    adapterInterfaceVersion: 1;
    harnessNeutral: true;
    openclawMessageSendRequired: false;
    hermesAdapterCompatible: true;
    gongyungAdapterCompatible: true;
    sendsApprovalRequest: false;
    producesLiveReceipt: false;
    grantsApproval: false;
    executesAction: false;
  };
  semantics: {
    adapterShellOnly: true;
    transcriptDraftOnly: true;
    dispatchNotPerformed: true;
    receiptIsDraftOnly: true;
    providerAcceptedIsVisibilityProof: false;
    approvalNotReallyGranted: true;
    executionNotPermitted: true;
    routeIsReadOnly: true;
    brokerFinalizerRequired: true;
    singleFinalizerRequired: true;
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

export function buildTerminalBriefApprovalDispatchAdapter(
  executor: TerminalBriefApprovalExecutorPacket,
  options: TerminalBriefApprovalDispatchAdapterOptions = {},
): TerminalBriefApprovalDispatchAdapterPacket {
  const adapterType = normalizeAdapter(options.adapter);
  const blockers = buildBlockers(executor, adapterType, options);
  const state = stateForExecutor(executor, blockers);
  const generatedAt = options.now ?? new Date().toISOString();
  const selectedAction = executor.approval.selectedAction ?? executor.execution.selectedAction;
  const idempotencyKey = buildDispatchIdempotencyKey(executor, state, adapterType, options);
  return {
    kind: "a2a-broker.terminal-brief-approval-dispatch-adapter.packet",
    version: 1,
    generatedAt,
    mode: options.mode ?? executor.mode,
    parentRoundId: executor.parentRoundId,
    state,
    dryRunOnly: true,
    dispatchPermitted: false,
    providerSendPermitted: false,
    approvalGrantPermitted: false,
    executionPermitted: false,
    terminalReceiptMutationPermitted: false,
    idempotencyKey,
    finalizer: executor.finalizer,
    adapter: {
      id: adapterType,
      type: adapterType,
      harnessNeutral: true,
      protocol: "json-transcript",
      requiresOpenClawMessageSend: false,
      supportsExternalHarnesses: true,
      liveSendPermitted: false,
    },
    source: {
      executorState: executor.state,
      executorIdempotencyKey: executor.idempotencyKey,
      approvalRequestIdempotencyKey: executor.source.approvalRequestIdempotencyKey,
      targetIssueUrl: executor.source.targetIssueUrl,
      targetPrUrl: executor.source.targetPrUrl,
      selectedAction: selectedAction?.action,
      selectedTarget: selectedAction?.target,
      requestedActions: executor.source.requestedActions,
      nonRequestableActions: executor.source.nonRequestableActions,
    },
    transcript: buildTranscript(executor, state, adapterType, options),
    receiptDraft: {
      mode: "draft-only",
      id: options.receiptId ?? idempotencyKey.replace(/^tb-approval-dispatch:/, "tb-approval-dispatch-receipt:"),
      providerAccepted: false,
      currentSessionVisible: false,
      terminalAck: false,
      approvalGranted: false,
      actionExecuted: false,
      reason: receiptReasonForState(state, adapterType),
    },
    blockers,
    nextActions: nextActionsForState(state, adapterType),
    integrationContract: {
      transport: "json",
      adapterInterfaceVersion: 1,
      harnessNeutral: true,
      openclawMessageSendRequired: false,
      hermesAdapterCompatible: true,
      gongyungAdapterCompatible: true,
      sendsApprovalRequest: false,
      producesLiveReceipt: false,
      grantsApproval: false,
      executesAction: false,
    },
    semantics: {
      adapterShellOnly: true,
      transcriptDraftOnly: true,
      dispatchNotPerformed: true,
      receiptIsDraftOnly: true,
      providerAcceptedIsVisibilityProof: false,
      approvalNotReallyGranted: true,
      executionNotPermitted: true,
      routeIsReadOnly: true,
      brokerFinalizerRequired: true,
      singleFinalizerRequired: true,
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

export function extractTerminalBriefApprovalExecutorPacket(input: unknown): TerminalBriefApprovalExecutorPacket {
  const envelope = isRecord(input) ? input : {};
  const candidates = [
    input,
    envelope.approvalExecutor,
    envelope.approvalExecutorPacket,
    envelope.executorPacket,
    envelope.packet,
  ];
  const packet = candidates.find(isTerminalBriefApprovalExecutorPacket);
  if (!packet) {
    throw new Error("expected a Terminal Brief approval executor packet");
  }
  return packet;
}

export function renderTerminalBriefApprovalDispatchAdapterMarkdown(
  packet: TerminalBriefApprovalDispatchAdapterPacket,
): string {
  return [
    titleForState(packet.state),
    "Mode: " + packet.mode,
    "Parent round: " + (packet.parentRoundId ?? "unknown"),
    "State: " + packet.state + " dryRunOnly=" + packet.dryRunOnly,
    "Adapter: " + packet.adapter.type
      + " protocol=" + packet.adapter.protocol
      + " requiresOpenClawMessageSend=" + packet.adapter.requiresOpenClawMessageSend
      + " liveSendPermitted=" + packet.adapter.liveSendPermitted,
    "Dispatch permitted: " + packet.dispatchPermitted,
    "Provider send permitted: " + packet.providerSendPermitted,
    "Approval grant permitted: " + packet.approvalGrantPermitted,
    "Execution permitted: " + packet.executionPermitted,
    "Terminal receipt mutation permitted: " + packet.terminalReceiptMutationPermitted,
    "Idempotency: " + packet.idempotencyKey,
    "Finalizer: broker=" + packet.finalizer.brokerOfRecordId
      + " owner=" + packet.finalizer.owner
      + " singleFinalizerRequired=" + packet.finalizer.singleFinalizerRequired,
    "Source executor: state=" + packet.source.executorState
      + " idempotency=" + packet.source.executorIdempotencyKey
      + " approvalRequest=" + packet.source.approvalRequestIdempotencyKey,
    "Targets: issue=" + (packet.source.targetIssueUrl ?? "none") + " pr=" + (packet.source.targetPrUrl ?? "none"),
    "Selected action: " + (packet.source.selectedAction ?? "none")
      + " target=" + (packet.source.selectedTarget ?? "none"),
    "Harness contract: JSON transport; OpenClaw message send required=false; Hermes compatible=true; Gongyung compatible=true; sendsApprovalRequest=false; grantsApproval=false; executesAction=false.",
    "",
    "Transcript draft:",
    "- target=" + (packet.transcript.target ?? "none")
      + " channel=" + (packet.transcript.channel ?? "none")
      + " sendPermitted=" + packet.transcript.sendPermitted
      + " sent=" + packet.transcript.sent,
    "- title=" + packet.transcript.title,
    "",
    "Receipt draft:",
    "- id=" + packet.receiptDraft.id
      + " providerAccepted=" + packet.receiptDraft.providerAccepted
      + " currentSessionVisible=" + packet.receiptDraft.currentSessionVisible
      + " terminalAck=" + packet.receiptDraft.terminalAck
      + " reason=" + packet.receiptDraft.reason,
    ...(packet.blockers.length ? ["", "Blockers:", ...packet.blockers.map((blocker) => "- " + blocker)] : []),
    "",
    "Next actions:",
    ...packet.nextActions.map((action) => "- " + action),
    "",
    "Safety: adapter shell only; transcript draft only; request not sent; receipt is not visibility proof; approval not really granted; execution not permitted; no comment post, merge, issue close, live send, terminal ACK/replay, restart/deploy, DB mutation, TaskFlow record creation, historical replay, release, or secret movement.",
  ].join("\n");
}

function normalizeAdapter(adapter?: string): TerminalBriefApprovalDispatchAdapterType {
  if (!adapter) return "generic";
  const value = adapter.toLowerCase();
  if (isSupportedAdapter(value)) return value;
  return "generic";
}

function isSupportedAdapter(adapter: string): adapter is TerminalBriefApprovalDispatchAdapterType {
  const value = adapter.toLowerCase();
  return value === "openclaw" || value === "hermes" || value === "gongyung" || value === "generic";
}

function buildBlockers(
  executor: TerminalBriefApprovalExecutorPacket,
  adapterType: TerminalBriefApprovalDispatchAdapterType,
  options: TerminalBriefApprovalDispatchAdapterOptions,
): string[] {
  const blockers = [...executor.blockers];
  if (options.adapter && !isSupportedAdapter(options.adapter)) {
    blockers.push("unsupported adapter; expected generic, openclaw, hermes, or gongyung");
  }
  if (executor.state === "blocked") {
    blockers.push("approval executor is blocked; dispatch adapter cannot prepare a transcript");
  }
  if (executor.state === "execute_blocked") {
    blockers.push("executor already reached execute_blocked; dispatch adapter must not proceed after an execution attempt");
  }
  if (adapterType === "openclaw" && executor.integrationContract.openclawMessageSendRequired) {
    blockers.push("executor contract unexpectedly requires OpenClaw message send");
  }
  return [...new Set(blockers)];
}

function stateForExecutor(
  executor: TerminalBriefApprovalExecutorPacket,
  blockers: string[],
): TerminalBriefApprovalDispatchAdapterState {
  if (blockers.length > 0) return "dispatch_blocked";
  if (executor.state === "approval_granted_dry_run") return "approval_receipt_draft_ready";
  if (executor.state === "dispatch_pending") return "dispatch_draft_ready";
  return "dispatch_blocked";
}

function buildTranscript(
  executor: TerminalBriefApprovalExecutorPacket,
  state: TerminalBriefApprovalDispatchAdapterState,
  adapterType: TerminalBriefApprovalDispatchAdapterType,
  options: TerminalBriefApprovalDispatchAdapterOptions,
): TerminalBriefApprovalDispatchAdapterPacket["transcript"] {
  const selectedAction = executor.approval.selectedAction ?? executor.execution.selectedAction;
  const title = state === "approval_receipt_draft_ready"
    ? "Dry-run approval receipt draft: Terminal Brief closeout - " + (executor.parentRoundId ?? "unknown")
    : "Draft approval dispatch: Terminal Brief closeout - " + (executor.parentRoundId ?? "unknown");
  const lines = [
    "Terminal Brief approval adapter transcript (dry-run).",
    "Adapter: " + adapterType + ".",
    "Finalizer: broker=" + executor.finalizer.brokerOfRecordId + " owner=" + executor.finalizer.owner + ".",
    "Executor state: " + executor.state + ".",
    "Approval request idempotency: " + executor.source.approvalRequestIdempotencyKey + ".",
    "Issue: " + (executor.source.targetIssueUrl ?? "none") + ".",
    "PR: " + (executor.source.targetPrUrl ?? "none") + ".",
    "Selected action: " + (selectedAction?.action ?? "none") + ".",
    "Selected target: " + (selectedAction?.target ?? "none") + ".",
    "This transcript was not sent. It is not an approval, visibility receipt, terminal ACK, or action execution.",
  ];
  return {
    mode: "draft-only",
    target: options.target,
    channel: options.channel,
    requestedBy: options.requestedBy,
    title,
    body: lines.join("\n"),
    sendPermitted: false,
    sent: false,
  };
}

function receiptReasonForState(
  state: TerminalBriefApprovalDispatchAdapterState,
  adapterType: TerminalBriefApprovalDispatchAdapterType,
): string {
  if (state === "approval_receipt_draft_ready") {
    return "dry-run receipt draft only for " + adapterType + "; no provider send or real approval exists";
  }
  if (state === "dispatch_draft_ready") {
    return "dispatch transcript draft only for " + adapterType + "; no provider send exists";
  }
  return "dispatch adapter is blocked; no receipt can be produced";
}

function nextActionsForState(
  state: TerminalBriefApprovalDispatchAdapterState,
  adapterType: TerminalBriefApprovalDispatchAdapterType,
): string[] {
  if (state === "dispatch_draft_ready") {
    return [
      "review the " + adapterType + " transcript draft with the broker finalizer",
      "request explicit operator approval before any future live provider send",
    ];
  }
  if (state === "approval_receipt_draft_ready") {
    return [
      "treat the dry-run receipt as adapter validation evidence only",
      "keep real approval capture and action execution in separate approval-gated implementations",
    ];
  }
  return [
    "recover executor blockers or rerun the executor before preparing an adapter dispatch",
    "do not use a blocked packet as live send or approval evidence",
  ];
}

function buildDispatchIdempotencyKey(
  executor: TerminalBriefApprovalExecutorPacket,
  state: TerminalBriefApprovalDispatchAdapterState,
  adapterType: TerminalBriefApprovalDispatchAdapterType,
  options: TerminalBriefApprovalDispatchAdapterOptions,
): string {
  const base = [
    "terminal-brief-approval-dispatch",
    executor.parentRoundId ?? "unknown",
    executor.idempotencyKey,
    state,
    adapterType,
    options.target ?? "",
    options.channel ?? "",
  ].join(":");
  return "tb-approval-dispatch:" + createHash("sha256").update(base).digest("hex").slice(0, 24);
}

function titleForState(state: TerminalBriefApprovalDispatchAdapterState): string {
  if (state === "dispatch_draft_ready") return "Dispatch draft ready: Terminal Brief approval adapter";
  if (state === "approval_receipt_draft_ready") return "Receipt draft ready: Terminal Brief approval adapter";
  return "Dispatch blocked: Terminal Brief approval adapter";
}

function isTerminalBriefApprovalExecutorPacket(value: unknown): value is TerminalBriefApprovalExecutorPacket {
  return isRecord(value) && value.kind === "a2a-broker.terminal-brief-approval-executor.packet";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
