import { createHash } from "node:crypto";

import type { TerminalBriefSidecarExecutorInvocationRehearsalPacket } from "./terminal-brief-sidecar-executor-invocation-rehearsal.js";

export type TerminalBriefSidecarRuntimePreflightApprovalState =
  | "approval_packet_ready"
  | "waiting_for_invocation_rehearsal"
  | "stale"
  | "conflicting"
  | "rejected"
  | "blocked";

export interface TerminalBriefSidecarRuntimePreflightApprovalOptions {
  now?: string;
  mode?: string;
  requestedAction?: string;
  requested_action?: string;
  requestedBy?: string;
  requested_by?: string;
  operatorTarget?: string;
  operator_target?: string;
  approvalReference?: string;
  approval_reference?: string;
  runtimeWindowMinutes?: number;
  runtime_window_minutes?: number;
  maxRuntimeSeconds?: number;
  max_runtime_seconds?: number;
  maxQueueBacklog?: number;
  max_queue_backlog?: number;
  requiredAbortEvidence?: string[];
  required_abort_evidence?: string[];
  rollbackChecklist?: string[];
  rollback_checklist?: string[];
}

export interface TerminalBriefSidecarRuntimePreflightApprovalPacket {
  kind: "a2a-broker.terminal-brief-sidecar-runtime-preflight-approval.packet";
  version: 1;
  generatedAt: string;
  mode: string;
  parentRoundId?: string;
  state: TerminalBriefSidecarRuntimePreflightApprovalState;
  dryRunOnly: true;
  sourceOnlyNoLive: true;
  idempotencyKey: string;
  source: {
    invocationRehearsalState: TerminalBriefSidecarExecutorInvocationRehearsalPacket["state"];
    invocationRehearsalIdempotencyKey: string;
    executorInvocationRehearsalReady: boolean;
    adapterContractReady: boolean;
    adapterContractVersion: number;
    executorName: string;
    adapterName: string;
    runtime: string;
  };
  approvalPacket: {
    draftOnly: true;
    requestedAction: string;
    requestedBy: string;
    operatorTarget: string;
    approvalReference?: string;
    dispatchRequired: true;
    dispatchPermitted: false;
    approvalGrantPermitted: false;
    runtimeExecutionPermitted: false;
  };
  runtimePreflight: {
    packetOnly: true;
    supervisedDryRunOnly: true;
    runtimeWindowMinutes: number;
    maxRuntimeSeconds: number;
    maxQueueBacklog: number;
    adapterContract: TerminalBriefSidecarExecutorInvocationRehearsalPacket["invocationPlan"]["adapterContract"];
    requiredAbortEvidence: string[];
    preflightChecks: string[];
    rollbackChecklist: string[];
    expectedRuntimeEvidence: string[];
  };
  readiness: {
    sourceCriteriaMet: boolean;
    approvalPacketReady: boolean;
    approvalRequestDispatchPermitted: false;
    approvalGrantPermitted: false;
    startExecutorDispatchPermitted: false;
    executorInvocationPermitted: false;
    processSpawnPermitted: false;
    sidecarStartPermitted: false;
    defaultOnPermitted: false;
    liveActivationPermitted: false;
    providerSendPermitted: false;
    terminalAckPermitted: false;
    executionPermitted: false;
    dbMutationPermitted: false;
    missingEvidence: string[];
    blockers: string[];
    nextAction: string;
  };
  blockers: string[];
  nextActions: string[];
  approvalSensitiveActionsExcluded: string[];
  integrationContract: {
    transport: "json";
    runtimePreflightApprovalVersion: 1;
    harnessNeutral: true;
    openclawMessageSendRequired: false;
    hermesAdapterCompatible: true;
    gongyungAdapterCompatible: true;
    consumesExecutorInvocationRehearsalPacket: true;
    consumesAdapterContractVersion: number;
    sendsApprovalRequest: false;
    grantsApproval: false;
    dispatchesStartExecutor: false;
    invokesExecutor: false;
    spawnsProcess: false;
    startsSidecar: false;
    enablesDefaultOn: false;
    executesAction: false;
  };
  semantics: {
    runtimePreflightApprovalPacketOnly: true;
    sourceOnlyNoLive: true;
    approvalPacketIsDraftOnly: true;
    preflightDoesNotMutateState: true;
    adapterContractOnly: true;
    adapterOutputDoesNotImplyReceiptProof: true;
    providerAcceptedIsVisibilityProof: false;
    terminalAckEligibleDoesNotPermitAck: true;
    approvalGrantEvidenceDoesNotGrantApproval: true;
    executionNotPermitted: true;
    processSpawnNotPermitted: true;
    sidecarStartNotPermitted: true;
    defaultOnNotEnabledByThisPacket: true;
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

export function buildTerminalBriefSidecarRuntimePreflightApproval(
  rehearsal: TerminalBriefSidecarExecutorInvocationRehearsalPacket,
  options: TerminalBriefSidecarRuntimePreflightApprovalOptions = {},
): TerminalBriefSidecarRuntimePreflightApprovalPacket {
  const generatedAt = options.now ?? new Date().toISOString();
  const blockers = buildBlockers(rehearsal);
  const state = stateFor(rehearsal, blockers);
  const sourceCriteriaMet = state === "approval_packet_ready";
  const runtimeWindowMinutes = numberValue(options.runtimeWindowMinutes ?? options.runtime_window_minutes) ?? 10;
  const maxRuntimeSeconds = numberValue(options.maxRuntimeSeconds ?? options.max_runtime_seconds)
    ?? rehearsal.invocationPlan.maxRuntimeSeconds
    ?? 300;
  const maxQueueBacklog = numberValue(options.maxQueueBacklog ?? options.max_queue_backlog) ?? 1000;
  const requiredAbortEvidence = requiredAbortEvidenceFor(rehearsal, options);
  return {
    kind: "a2a-broker.terminal-brief-sidecar-runtime-preflight-approval.packet",
    version: 1,
    generatedAt,
    mode: options.mode ?? rehearsal.mode,
    parentRoundId: rehearsal.parentRoundId,
    state,
    dryRunOnly: true,
    sourceOnlyNoLive: true,
    idempotencyKey: buildRuntimePreflightApprovalIdempotencyKey(rehearsal, generatedAt, state, options),
    source: {
      invocationRehearsalState: rehearsal.state,
      invocationRehearsalIdempotencyKey: rehearsal.idempotencyKey,
      executorInvocationRehearsalReady: rehearsal.readiness.executorInvocationRehearsalReady,
      adapterContractReady: rehearsal.readiness.adapterContractReady,
      adapterContractVersion: rehearsal.invocationPlan.adapterContract.version,
      executorName: rehearsal.invocationPlan.executorName,
      adapterName: rehearsal.invocationPlan.adapterName,
      runtime: rehearsal.invocationPlan.executorRuntime,
    },
    approvalPacket: {
      draftOnly: true,
      requestedAction: optionalString(options.requestedAction ?? options.requested_action)
        ?? "approve_terminal_brief_sidecar_supervised_runtime_preflight",
      requestedBy: optionalString(options.requestedBy ?? options.requested_by) ?? "broker-finalizer",
      operatorTarget: optionalString(options.operatorTarget ?? options.operator_target) ?? "operator",
      approvalReference: optionalString(options.approvalReference ?? options.approval_reference),
      dispatchRequired: true,
      dispatchPermitted: false,
      approvalGrantPermitted: false,
      runtimeExecutionPermitted: false,
    },
    runtimePreflight: {
      packetOnly: true,
      supervisedDryRunOnly: true,
      runtimeWindowMinutes,
      maxRuntimeSeconds,
      maxQueueBacklog,
      adapterContract: rehearsal.invocationPlan.adapterContract,
      requiredAbortEvidence,
      preflightChecks: preflightChecks(rehearsal, maxQueueBacklog),
      rollbackChecklist: rollbackChecklist(options),
      expectedRuntimeEvidence: expectedRuntimeEvidence(rehearsal),
    },
    readiness: {
      sourceCriteriaMet,
      approvalPacketReady: sourceCriteriaMet,
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
      missingEvidence: missingEvidenceFor(rehearsal),
      blockers: [
        ...blockers,
        "approval request dispatch is not permitted by this runtime preflight approval packet",
        "approval grant evidence does not grant approval in this packet",
        "executor runtime action requires a later separate approved runtime path",
      ],
      nextAction: sourceCriteriaMet
        ? "review the runtime preflight approval packet and request explicit operator approval before any runtime action"
        : "resolve executor invocation rehearsal and adapter contract readiness before runtime preflight approval",
    },
    blockers,
    nextActions: nextActionsFor(state),
    approvalSensitiveActionsExcluded: [
      "sending the approval request",
      "granting approval or executing an approval grant",
      "dispatching or invoking a start executor",
      "spawning a process or starting/stopping the sidecar",
      "Terminal Brief default-on enablement",
      "live provider/Hermes/Gongyung/Telegram/OpenClaw send",
      "terminal ACK/replay or terminal receipt DB mutation",
      "GitHub PR merge, issue close, or comment post from the packet/route",
      "TaskFlow record creation or broker DB mutation",
      "production deploy/restart, historical replay, release, publish, or secret movement",
    ],
    integrationContract: {
      transport: "json",
      runtimePreflightApprovalVersion: 1,
      harnessNeutral: true,
      openclawMessageSendRequired: false,
      hermesAdapterCompatible: true,
      gongyungAdapterCompatible: true,
      consumesExecutorInvocationRehearsalPacket: true,
      consumesAdapterContractVersion: rehearsal.invocationPlan.adapterContract.version,
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
      runtimePreflightApprovalPacketOnly: true,
      sourceOnlyNoLive: true,
      approvalPacketIsDraftOnly: true,
      preflightDoesNotMutateState: true,
      adapterContractOnly: true,
      adapterOutputDoesNotImplyReceiptProof: true,
      providerAcceptedIsVisibilityProof: false,
      terminalAckEligibleDoesNotPermitAck: true,
      approvalGrantEvidenceDoesNotGrantApproval: true,
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
}

export function extractTerminalBriefSidecarRuntimePreflightApprovalRehearsal(
  input: unknown,
): TerminalBriefSidecarExecutorInvocationRehearsalPacket {
  const envelope = isRecord(input) ? input : {};
  const candidates = [
    input,
    envelope.executorInvocationRehearsal,
    envelope.executorInvocationRehearsalPacket,
    envelope.sidecarExecutorInvocationRehearsal,
    envelope.sidecarExecutorInvocationRehearsalPacket,
    envelope.rehearsal,
    envelope.packet,
  ];
  const packet = candidates.find(isTerminalBriefSidecarExecutorInvocationRehearsalPacket);
  if (!packet) {
    throw new Error("expected a Terminal Brief sidecar executor invocation rehearsal packet");
  }
  return packet;
}

export function extractTerminalBriefSidecarRuntimePreflightApprovalOptions(
  input: unknown,
): TerminalBriefSidecarRuntimePreflightApprovalOptions {
  const envelope = isRecord(input) ? input : {};
  const candidate = envelope.runtimePreflightApproval
    ?? envelope.runtimePreflightApprovalOptions
    ?? envelope.runtimeApproval
    ?? envelope.options;
  return isRecord(candidate) ? candidate as TerminalBriefSidecarRuntimePreflightApprovalOptions : {};
}

export function renderTerminalBriefSidecarRuntimePreflightApprovalMarkdown(
  packet: TerminalBriefSidecarRuntimePreflightApprovalPacket,
): string {
  return [
    titleForState(packet.state),
    "Mode: " + packet.mode,
    "Parent round: " + (packet.parentRoundId ?? "unknown"),
    "State: " + packet.state + " dryRunOnly=" + packet.dryRunOnly + " sourceOnlyNoLive=" + packet.sourceOnlyNoLive,
    "Idempotency: " + packet.idempotencyKey,
    "Source rehearsal: state=" + packet.source.invocationRehearsalState
      + " ready=" + packet.source.executorInvocationRehearsalReady
      + " adapterContractReady=" + packet.source.adapterContractReady
      + " adapter=" + packet.source.adapterName,
    "Approval packet: requestedAction=" + packet.approvalPacket.requestedAction
      + " dispatchPermitted=" + packet.approvalPacket.dispatchPermitted
      + " runtimeExecutionPermitted=" + packet.approvalPacket.runtimeExecutionPermitted,
    "Runtime preflight: adapterContractVersion=" + packet.runtimePreflight.adapterContract.version
      + " maxRuntimeSeconds=" + packet.runtimePreflight.maxRuntimeSeconds
      + " requiredAbortEvidence=" + packet.runtimePreflight.requiredAbortEvidence.length,
    "",
    "Readiness: sourceCriteriaMet=" + packet.readiness.sourceCriteriaMet
      + " approvalPacketReady=" + packet.readiness.approvalPacketReady
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
    "Safety: runtime preflight approval packet only; does not send approval, grant approval, dispatch/invoke executor, spawn a process, start sidecar, enable default-on, send providers, ACK/replay terminal rows, mutate GitHub/DB/TaskFlow state, restart/deploy, replay history, release, publish, or move secrets.",
  ].join("\n");
}

function buildBlockers(rehearsal: TerminalBriefSidecarExecutorInvocationRehearsalPacket): string[] {
  return unique([
    ...rehearsal.blockers,
    ...(rehearsal.state !== "ready_for_executor_invocation_rehearsal" ? ["executor invocation rehearsal is " + rehearsal.state] : []),
    ...(!rehearsal.readiness.sourceCriteriaMet ? ["executor invocation rehearsal source criteria are not met"] : []),
    ...(!rehearsal.readiness.executorInvocationRehearsalReady ? ["executor invocation rehearsal is not ready"] : []),
    ...(!rehearsal.readiness.adapterContractReady ? ["adapter contract is not ready"] : []),
    ...(rehearsal.invocationPlan.adapterContract.version !== 1 ? ["unsupported adapter contract version"] : []),
    ...(rehearsal.invocationPlan.adapterContract.input.commandExecutionPermitted !== false ? ["adapter contract unexpectedly permits command execution"] : []),
    ...(rehearsal.invocationPlan.adapterContract.input.processSpawnPermitted !== false ? ["adapter contract unexpectedly permits process spawn"] : []),
    ...(rehearsal.invocationPlan.adapterContract.output.terminalAckPermitted !== false ? ["adapter contract unexpectedly permits terminal ACK"] : []),
    ...(rehearsal.invocationPlan.adapterContract.output.providerAcceptedIsReceiptProof !== false ? ["adapter contract treats provider accepted as receipt proof"] : []),
    ...(rehearsal.readiness.startExecutorDispatchPermitted !== false ? ["rehearsal unexpectedly permits start executor dispatch"] : []),
    ...(rehearsal.readiness.executorInvocationPermitted !== false ? ["rehearsal unexpectedly permits executor invocation"] : []),
    ...(rehearsal.readiness.processSpawnPermitted !== false ? ["rehearsal unexpectedly permits process spawn"] : []),
    ...(rehearsal.readiness.sidecarStartPermitted !== false ? ["rehearsal unexpectedly permits sidecar start"] : []),
    ...(rehearsal.readiness.providerSendPermitted !== false ? ["rehearsal unexpectedly permits provider send"] : []),
    ...(rehearsal.readiness.terminalAckPermitted !== false ? ["rehearsal unexpectedly permits terminal ACK"] : []),
    ...(rehearsal.readiness.executionPermitted !== false ? ["rehearsal unexpectedly permits execution"] : []),
    ...(rehearsal.integrationContract.invokesExecutor ? ["rehearsal unexpectedly invokes executor"] : []),
    ...(rehearsal.integrationContract.spawnsProcess ? ["rehearsal unexpectedly spawns process"] : []),
    ...(rehearsal.integrationContract.startsSidecar ? ["rehearsal unexpectedly starts sidecar"] : []),
    ...(rehearsal.integrationContract.executesAction ? ["rehearsal unexpectedly executes action"] : []),
    ...(rehearsal.semantics.performsProviderSend ? ["rehearsal unexpectedly performs provider send"] : []),
    ...(rehearsal.semantics.performsTerminalAck ? ["rehearsal unexpectedly performs terminal ACK"] : []),
    ...(rehearsal.semantics.performsRuntimeRestartOrDeploy ? ["rehearsal unexpectedly performs restart/deploy"] : []),
    ...(rehearsal.semantics.performsDbMutation ? ["rehearsal unexpectedly performs DB mutation"] : []),
    ...(rehearsal.semantics.performsHistoricalReplay ? ["rehearsal unexpectedly performs historical replay"] : []),
    ...(rehearsal.semantics.performsReleaseOrPublish ? ["rehearsal unexpectedly performs release/publish"] : []),
    ...(rehearsal.semantics.movesSecretsOrCredentials ? ["rehearsal unexpectedly moves secrets/credentials"] : []),
  ].filter(Boolean));
}

function stateFor(
  rehearsal: TerminalBriefSidecarExecutorInvocationRehearsalPacket,
  blockers: string[],
): TerminalBriefSidecarRuntimePreflightApprovalState {
  if (rehearsal.state === "stale") return "stale";
  if (rehearsal.state === "conflicting") return "conflicting";
  if (rehearsal.state === "rejected") return "rejected";
  if (rehearsal.state === "blocked" || hasUnsafeNoLiveViolation(rehearsal)) return "blocked";
  if (rehearsal.state !== "ready_for_executor_invocation_rehearsal") return "waiting_for_invocation_rehearsal";
  return blockers.length ? "blocked" : "approval_packet_ready";
}

function hasUnsafeNoLiveViolation(rehearsal: TerminalBriefSidecarExecutorInvocationRehearsalPacket): boolean {
  return rehearsal.readiness.startExecutorDispatchPermitted !== false
    || rehearsal.readiness.executorInvocationPermitted !== false
    || rehearsal.readiness.processSpawnPermitted !== false
    || rehearsal.readiness.sidecarStartPermitted !== false
    || rehearsal.readiness.providerSendPermitted !== false
    || rehearsal.readiness.terminalAckPermitted !== false
    || rehearsal.readiness.executionPermitted !== false
    || rehearsal.invocationPlan.adapterContract.input.commandExecutionPermitted !== false
    || rehearsal.invocationPlan.adapterContract.input.processSpawnPermitted !== false
    || rehearsal.invocationPlan.adapterContract.output.terminalAckPermitted !== false
    || rehearsal.invocationPlan.adapterContract.output.providerAcceptedIsReceiptProof !== false
    || rehearsal.integrationContract.invokesExecutor
    || rehearsal.integrationContract.spawnsProcess
    || rehearsal.integrationContract.startsSidecar
    || rehearsal.integrationContract.executesAction
    || rehearsal.semantics.performsProviderSend
    || rehearsal.semantics.performsTerminalAck
    || rehearsal.semantics.performsRuntimeRestartOrDeploy
    || rehearsal.semantics.performsDbMutation
    || rehearsal.semantics.performsHistoricalReplay
    || rehearsal.semantics.performsReleaseOrPublish
    || rehearsal.semantics.movesSecretsOrCredentials;
}

function missingEvidenceFor(rehearsal: TerminalBriefSidecarExecutorInvocationRehearsalPacket): string[] {
  const missing: string[] = [];
  if (rehearsal.state !== "ready_for_executor_invocation_rehearsal") missing.push("ready_executor_invocation_rehearsal");
  if (!rehearsal.readiness.sourceCriteriaMet) missing.push("source_criteria");
  if (!rehearsal.readiness.executorInvocationRehearsalReady) missing.push("executor_invocation_rehearsal");
  if (!rehearsal.readiness.adapterContractReady) missing.push("adapter_contract");
  return missing;
}

function requiredAbortEvidenceFor(
  rehearsal: TerminalBriefSidecarExecutorInvocationRehearsalPacket,
  options: TerminalBriefSidecarRuntimePreflightApprovalOptions,
): string[] {
  const configured = stringArray(options.requiredAbortEvidence ?? options.required_abort_evidence);
  return unique([
    ...(configured.length ? configured : rehearsal.invocationPlan.adapterContract.abortEvidenceRequirements),
    "rollback checklist reviewed before runtime approval",
    "no provider send, terminal ACK/replay, DB mutation, restart/deploy, or secret movement attempted",
  ]);
}

function preflightChecks(rehearsal: TerminalBriefSidecarExecutorInvocationRehearsalPacket, maxQueueBacklog: number): string[] {
  return [
    "executor invocation rehearsal is ready_for_executor_invocation_rehearsal",
    "adapter contract version " + rehearsal.invocationPlan.adapterContract.version + " is ready",
    "command input remains metadata-only with env key names only",
    "abort evidence requirements are present before runtime approval",
    "queue backlog is below " + maxQueueBacklog + " before any later runtime action",
    "operator approval is collected separately before executor dispatch or process spawn",
  ];
}

function rollbackChecklist(options: TerminalBriefSidecarRuntimePreflightApprovalOptions): string[] {
  const configured = stringArray(options.rollbackChecklist ?? options.rollback_checklist);
  if (configured.length) return configured;
  return [
    "do not start the sidecar from this packet",
    "discard runtime approval if adapter contract or source evidence changes",
    "keep provider send, terminal ACK/replay, DB mutation, restart/deploy, and default-on disabled",
    "rerun rehearsal and runtime preflight approval after any source evidence refresh",
  ];
}

function expectedRuntimeEvidence(rehearsal: TerminalBriefSidecarExecutorInvocationRehearsalPacket): string[] {
  return [
    "separate operator approval reference for runtime action",
    "adapter output status ready/aborted/blocked using " + rehearsal.invocationPlan.adapterContract.transport,
    "abort evidence satisfying the adapter contract if runtime is not ready",
    "no terminal ACK/replay evidence from this packet",
  ];
}

function nextActionsFor(state: TerminalBriefSidecarRuntimePreflightApprovalState): string[] {
  if (state === "approval_packet_ready") {
    return [
      "review the runtime preflight approval packet",
      "request explicit operator approval before any separate executor dispatch, process spawn, or sidecar dry-run start",
    ];
  }
  if (state === "waiting_for_invocation_rehearsal") {
    return [
      "resolve the executor invocation rehearsal first",
      "do not request runtime approval from an unready rehearsal",
    ];
  }
  if (state === "stale") return ["refresh executor invocation rehearsal evidence before runtime approval"];
  if (state === "conflicting") return ["resolve conflicting executor invocation rehearsal evidence before runtime approval"];
  if (state === "rejected") return ["do not request runtime approval unless the operator changes the decision"];
  return [
    "resolve blocked/unsafe rehearsal evidence before runtime preflight approval",
    "do not dispatch executor, spawn a process, start sidecar, send providers, ACK terminal rows, or mutate state from a blocked packet",
  ];
}

function buildRuntimePreflightApprovalIdempotencyKey(
  rehearsal: TerminalBriefSidecarExecutorInvocationRehearsalPacket,
  generatedAt: string,
  state: TerminalBriefSidecarRuntimePreflightApprovalState,
  options: TerminalBriefSidecarRuntimePreflightApprovalOptions,
): string {
  const base = JSON.stringify({
    label: "terminal-brief-sidecar-runtime-preflight-approval",
    parentRoundId: rehearsal.parentRoundId ?? "unknown",
    rehearsal: rehearsal.idempotencyKey,
    generatedAt,
    state,
    requestedAction: options.requestedAction ?? options.requested_action,
    approvalReference: options.approvalReference ?? options.approval_reference,
  });
  return "tb-sidecar-runtime-preflight-approval:" + createHash("sha256").update(base).digest("hex").slice(0, 24);
}

function titleForState(state: TerminalBriefSidecarRuntimePreflightApprovalState): string {
  if (state === "approval_packet_ready") return "Ready: Terminal Brief sidecar runtime preflight approval";
  if (state === "waiting_for_invocation_rehearsal") return "Waiting: Terminal Brief sidecar executor invocation rehearsal";
  if (state === "stale") return "Stale: Terminal Brief sidecar runtime preflight approval source";
  if (state === "conflicting") return "Conflicting: Terminal Brief sidecar runtime preflight approval source";
  if (state === "rejected") return "Rejected: Terminal Brief sidecar runtime preflight approval source";
  return "Blocked: Terminal Brief sidecar runtime preflight approval";
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

function isTerminalBriefSidecarExecutorInvocationRehearsalPacket(
  value: unknown,
): value is TerminalBriefSidecarExecutorInvocationRehearsalPacket {
  return isRecord(value) && value.kind === "a2a-broker.terminal-brief-sidecar-executor-invocation-rehearsal.packet";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
