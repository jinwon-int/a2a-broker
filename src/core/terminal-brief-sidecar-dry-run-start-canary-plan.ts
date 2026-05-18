import { createHash } from "node:crypto";

import type { TerminalBriefSidecarExecutorInvocationRehearsalPacket } from "./terminal-brief-sidecar-executor-invocation-rehearsal.js";

export type TerminalBriefSidecarDryRunStartCanaryPlanState =
  | "ready_for_dry_run_start_approval_request"
  | "waiting_for_executor_invocation_rehearsal"
  | "stale"
  | "conflicting"
  | "rejected"
  | "blocked";

export interface TerminalBriefSidecarDryRunStartCanaryPlanOptions {
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
  canaryWindowMinutes?: number;
  canary_window_minutes?: number;
  monitorIntervalSeconds?: number;
  monitor_interval_seconds?: number;
  maxQueueBacklog?: number;
  max_queue_backlog?: number;
  evidenceChecklist?: string[];
  evidence_checklist?: string[];
  rollbackChecklist?: string[];
  rollback_checklist?: string[];
}

export interface TerminalBriefSidecarDryRunStartCanaryPlanPacket {
  kind: "a2a-broker.terminal-brief-sidecar-dry-run-start-canary-plan.packet";
  version: 1;
  generatedAt: string;
  mode: string;
  parentRoundId?: string;
  state: TerminalBriefSidecarDryRunStartCanaryPlanState;
  dryRunOnly: true;
  sourceOnlyNoLive: true;
  idempotencyKey: string;
  source: {
    invocationRehearsalState: TerminalBriefSidecarExecutorInvocationRehearsalPacket["state"];
    invocationRehearsalIdempotencyKey: string;
    executorInvocationRehearsalReady: boolean;
    executorName: string;
    adapterName: string;
    commandShapeKind: "metadata_only";
  };
  approvalRequestDraft: {
    draftOnly: true;
    requestedAction: string;
    requestedBy: string;
    operatorTarget: string;
    approvalReference?: string;
    dispatchRequired: true;
    dispatchPermitted: false;
    sendsApprovalRequest: false;
    approvalGrantPermitted: false;
    executionPermitted: false;
  };
  canaryPlan: {
    planOnly: true;
    supervisedDryRunOnly: true;
    defaultOnCandidate: false;
    observationWindowMinutes: number;
    monitorIntervalSeconds: number;
    maxQueueBacklog: number;
    preflightChecks: string[];
    evidenceChecklist: string[];
    abortConditions: string[];
    rollbackChecklist: string[];
  };
  readiness: {
    sourceCriteriaMet: boolean;
    approvalRequestDraftReady: boolean;
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
    missingEvidence: string[];
    blockers: string[];
    nextAction: string;
  };
  blockers: string[];
  nextActions: string[];
  approvalSensitiveActionsExcluded: string[];
  integrationContract: {
    transport: "json";
    canaryPlanVersion: 1;
    harnessNeutral: true;
    openclawMessageSendRequired: false;
    hermesAdapterCompatible: true;
    gongyungAdapterCompatible: true;
    consumesExecutorInvocationRehearsalPacket: true;
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
    dryRunStartCanaryPlanOnly: true;
    sourceOnlyNoLive: true;
    planDoesNotMutateState: true;
    approvalRequestIsDraftOnly: true;
    canaryPlanDoesNotStartSidecar: true;
    commandShapeIsMetadataOnly: true;
    commandShapeDoesNotContainSecretValues: true;
    providerAcceptedIsVisibilityProof: false;
    terminalAckEligibleDoesNotPermitAck: true;
    defaultOnRequiresSeparateApprovalAfterObservation: true;
    executionNotPermitted: true;
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

export function buildTerminalBriefSidecarDryRunStartCanaryPlan(
  rehearsal: TerminalBriefSidecarExecutorInvocationRehearsalPacket,
  options: TerminalBriefSidecarDryRunStartCanaryPlanOptions = {},
): TerminalBriefSidecarDryRunStartCanaryPlanPacket {
  const generatedAt = options.now ?? new Date().toISOString();
  const blockers = buildBlockers(rehearsal);
  const state = stateFor(rehearsal, blockers);
  const sourceCriteriaMet = state === "ready_for_dry_run_start_approval_request";
  const observationWindowMinutes = numberValue(options.canaryWindowMinutes ?? options.canary_window_minutes) ?? 30;
  const monitorIntervalSeconds = numberValue(options.monitorIntervalSeconds ?? options.monitor_interval_seconds) ?? 60;
  const maxQueueBacklog = numberValue(options.maxQueueBacklog ?? options.max_queue_backlog) ?? 1000;
  return {
    kind: "a2a-broker.terminal-brief-sidecar-dry-run-start-canary-plan.packet",
    version: 1,
    generatedAt,
    mode: options.mode ?? rehearsal.mode,
    parentRoundId: rehearsal.parentRoundId,
    state,
    dryRunOnly: true,
    sourceOnlyNoLive: true,
    idempotencyKey: buildPlanIdempotencyKey(rehearsal, generatedAt, state, options),
    source: {
      invocationRehearsalState: rehearsal.state,
      invocationRehearsalIdempotencyKey: rehearsal.idempotencyKey,
      executorInvocationRehearsalReady: rehearsal.readiness.executorInvocationRehearsalReady,
      executorName: rehearsal.invocationPlan.executorName,
      adapterName: rehearsal.invocationPlan.adapterName,
      commandShapeKind: rehearsal.invocationPlan.commandShape.kind,
    },
    approvalRequestDraft: {
      draftOnly: true,
      requestedAction: optionalString(options.requestedAction ?? options.requested_action)
        ?? "approve_supervised_terminal_brief_sidecar_dry_run_start_canary",
      requestedBy: optionalString(options.requestedBy ?? options.requested_by) ?? "broker-finalizer",
      operatorTarget: optionalString(options.operatorTarget ?? options.operator_target) ?? "operator",
      approvalReference: optionalString(options.approvalReference ?? options.approval_reference),
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
      observationWindowMinutes,
      monitorIntervalSeconds,
      maxQueueBacklog,
      preflightChecks: preflightChecks(rehearsal, maxQueueBacklog),
      evidenceChecklist: evidenceChecklist(options),
      abortConditions: abortConditions(rehearsal, maxQueueBacklog),
      rollbackChecklist: rollbackChecklist(options),
    },
    readiness: {
      sourceCriteriaMet,
      approvalRequestDraftReady: sourceCriteriaMet,
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
      missingEvidence: missingEvidenceFor(rehearsal),
      blockers: [
        ...blockers,
        "approval request dispatch is not permitted by this canary plan packet",
        "dry-run start canary requires a separate explicit operator approval and executor runtime",
        "default-on promotion requires a later approval after observation",
      ],
      nextAction: sourceCriteriaMet
        ? "review the draft approval and canary plan, then request explicit approval before any runtime action"
        : "resolve executor invocation rehearsal readiness before drafting dry-run start approval",
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
}

export function extractTerminalBriefSidecarDryRunStartCanaryPlanRehearsal(
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

export function extractTerminalBriefSidecarDryRunStartCanaryPlanOptions(
  input: unknown,
): TerminalBriefSidecarDryRunStartCanaryPlanOptions {
  const envelope = isRecord(input) ? input : {};
  const candidate = envelope.dryRunStartCanaryPlan
    ?? envelope.dryRunStartCanaryPlanOptions
    ?? envelope.canaryPlan
    ?? envelope.approvalCanaryPlan
    ?? envelope.options;
  return isRecord(candidate) ? candidate as TerminalBriefSidecarDryRunStartCanaryPlanOptions : {};
}

export function renderTerminalBriefSidecarDryRunStartCanaryPlanMarkdown(
  packet: TerminalBriefSidecarDryRunStartCanaryPlanPacket,
): string {
  return [
    titleForState(packet.state),
    "Mode: " + packet.mode,
    "Parent round: " + (packet.parentRoundId ?? "unknown"),
    "State: " + packet.state + " dryRunOnly=" + packet.dryRunOnly + " sourceOnlyNoLive=" + packet.sourceOnlyNoLive,
    "Idempotency: " + packet.idempotencyKey,
    "Source rehearsal: state=" + packet.source.invocationRehearsalState
      + " ready=" + packet.source.executorInvocationRehearsalReady
      + " executor=" + packet.source.executorName
      + " adapter=" + packet.source.adapterName,
    "Approval draft: action=" + packet.approvalRequestDraft.requestedAction
      + " dispatchPermitted=" + packet.approvalRequestDraft.dispatchPermitted
      + " sendsApprovalRequest=" + packet.approvalRequestDraft.sendsApprovalRequest,
    "Canary plan: observationWindowMinutes=" + packet.canaryPlan.observationWindowMinutes
      + " monitorIntervalSeconds=" + packet.canaryPlan.monitorIntervalSeconds
      + " defaultOnCandidate=" + packet.canaryPlan.defaultOnCandidate,
    "",
    "Readiness: sourceCriteriaMet=" + packet.readiness.sourceCriteriaMet
      + " approvalRequestDraftReady=" + packet.readiness.approvalRequestDraftReady
      + " approvalRequestDispatchPermitted=" + packet.readiness.approvalRequestDispatchPermitted
      + " executorInvocationPermitted=" + packet.readiness.executorInvocationPermitted
      + " sidecarStartPermitted=" + packet.readiness.sidecarStartPermitted
      + " terminalAckPermitted=" + packet.readiness.terminalAckPermitted
      + " executionPermitted=" + packet.readiness.executionPermitted,
    ...(packet.blockers.length ? ["", "Blockers:", ...packet.blockers.map((blocker) => "- " + blocker)] : []),
    "",
    "Next actions:",
    ...packet.nextActions.map((action) => "- " + action),
    "",
    "Safety: dry-run start canary plan only; approval request is draft only; does not send approval request, grant approval, dispatch/invoke executor, spawn a process, start sidecar, enable default-on, send providers, ACK/replay terminal rows, mutate GitHub/DB/TaskFlow state, restart/deploy, replay history, release, publish, or move secrets.",
  ].join("\n");
}

function buildBlockers(rehearsal: TerminalBriefSidecarExecutorInvocationRehearsalPacket): string[] {
  return unique([
    ...rehearsal.blockers,
    ...(rehearsal.state !== "ready_for_executor_invocation_rehearsal" ? ["executor invocation rehearsal is " + rehearsal.state] : []),
    ...(!rehearsal.readiness.sourceCriteriaMet ? ["executor invocation rehearsal source criteria are not met"] : []),
    ...(!rehearsal.readiness.executorInvocationRehearsalReady ? ["executor invocation rehearsal is not ready"] : []),
    ...(rehearsal.readiness.startExecutorDispatchPermitted !== false ? ["rehearsal unexpectedly permits start executor dispatch"] : []),
    ...(rehearsal.readiness.executorInvocationPermitted !== false ? ["rehearsal unexpectedly permits executor invocation"] : []),
    ...(rehearsal.readiness.processSpawnPermitted !== false ? ["rehearsal unexpectedly permits process spawn"] : []),
    ...(rehearsal.readiness.sidecarStartPermitted !== false ? ["rehearsal unexpectedly permits sidecar start"] : []),
    ...(rehearsal.readiness.defaultOnPermitted !== false ? ["rehearsal unexpectedly permits default-on"] : []),
    ...(rehearsal.readiness.approvalGrantPermitted !== false ? ["rehearsal unexpectedly permits approval grant"] : []),
    ...(rehearsal.readiness.providerSendPermitted !== false ? ["rehearsal unexpectedly permits provider send"] : []),
    ...(rehearsal.readiness.terminalAckPermitted !== false ? ["rehearsal unexpectedly permits terminal ACK"] : []),
    ...(rehearsal.readiness.executionPermitted !== false ? ["rehearsal unexpectedly permits execution"] : []),
    ...(rehearsal.invocationPlan.commandShape.kind !== "metadata_only" ? ["rehearsal command shape is not metadata only"] : []),
    ...(rehearsal.invocationPlan.commandShape.commandExecutionPermitted !== false ? ["rehearsal command shape unexpectedly permits execution"] : []),
    ...(rehearsal.invocationPlan.commandShape.processSpawnPermitted !== false ? ["rehearsal command shape unexpectedly permits process spawn"] : []),
    ...(rehearsal.invocationPlan.commandShape.secretsIncluded !== false ? ["rehearsal command shape unexpectedly includes secrets"] : []),
    ...(rehearsal.integrationContract.dispatchesStartExecutor ? ["rehearsal unexpectedly dispatches executor"] : []),
    ...(rehearsal.integrationContract.invokesExecutor ? ["rehearsal unexpectedly invokes executor"] : []),
    ...(rehearsal.integrationContract.spawnsProcess ? ["rehearsal unexpectedly spawns process"] : []),
    ...(rehearsal.integrationContract.startsSidecar ? ["rehearsal unexpectedly starts sidecar"] : []),
    ...(rehearsal.integrationContract.enablesDefaultOn ? ["rehearsal unexpectedly enables default-on"] : []),
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
): TerminalBriefSidecarDryRunStartCanaryPlanState {
  if (rehearsal.state === "stale") return "stale";
  if (rehearsal.state === "conflicting") return "conflicting";
  if (rehearsal.state === "rejected") return "rejected";
  if (rehearsal.state === "blocked" || hasUnsafeNoLiveViolation(rehearsal)) return "blocked";
  if (rehearsal.state !== "ready_for_executor_invocation_rehearsal") return "waiting_for_executor_invocation_rehearsal";
  return blockers.length ? "blocked" : "ready_for_dry_run_start_approval_request";
}

function hasUnsafeNoLiveViolation(rehearsal: TerminalBriefSidecarExecutorInvocationRehearsalPacket): boolean {
  return rehearsal.readiness.startExecutorDispatchPermitted !== false
    || rehearsal.readiness.executorInvocationPermitted !== false
    || rehearsal.readiness.processSpawnPermitted !== false
    || rehearsal.readiness.sidecarStartPermitted !== false
    || rehearsal.readiness.defaultOnPermitted !== false
    || rehearsal.readiness.approvalGrantPermitted !== false
    || rehearsal.readiness.providerSendPermitted !== false
    || rehearsal.readiness.terminalAckPermitted !== false
    || rehearsal.readiness.executionPermitted !== false
    || rehearsal.invocationPlan.commandShape.commandExecutionPermitted !== false
    || rehearsal.invocationPlan.commandShape.processSpawnPermitted !== false
    || rehearsal.invocationPlan.commandShape.secretsIncluded !== false
    || rehearsal.integrationContract.dispatchesStartExecutor
    || rehearsal.integrationContract.invokesExecutor
    || rehearsal.integrationContract.spawnsProcess
    || rehearsal.integrationContract.startsSidecar
    || rehearsal.integrationContract.enablesDefaultOn
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
  return missing;
}

function preflightChecks(
  rehearsal: TerminalBriefSidecarExecutorInvocationRehearsalPacket,
  maxQueueBacklog: number,
): string[] {
  return [
    "executor invocation rehearsal is ready_for_executor_invocation_rehearsal",
    "operator approval reference will be collected separately before runtime execution",
    "command shape is metadata only and contains env key names only",
    "secrets are loaded only from the approved runtime secret store",
    "Gateway /readyz is healthy before the approved runtime action",
    "event-loop degradation is false before the approved runtime action",
    "queue backlog is below " + maxQueueBacklog,
    "sidecar dry-run-only mode is provable before start",
    "cursor persistence and bounded polling are configured",
    "cross-broker operatorEvents remains disabled unless separately approved",
    "rollback procedure is known before start",
    "source executor is " + rehearsal.invocationPlan.executorName + " via " + rehearsal.invocationPlan.adapterName,
  ];
}

function evidenceChecklist(options: TerminalBriefSidecarDryRunStartCanaryPlanOptions): string[] {
  const configured = stringArray(options.evidenceChecklist ?? options.evidence_checklist);
  if (configured.length) return configured;
  return [
    "source packet ids for dry-run gate, activation approval, receipt ingestor, start executor gate, and invocation rehearsal",
    "operator approval reference for supervised dry-run start canary",
    "Gateway ready/event-loop/queue evidence before start",
    "dry-run-only sidecar proof if a later approved runtime action is performed",
    "cursor before/after evidence if a later approved runtime action is performed",
    "no provider send, terminal ACK/replay, default-on, DB mutation, historical replay, or secret leakage evidence",
  ];
}

function abortConditions(
  rehearsal: TerminalBriefSidecarExecutorInvocationRehearsalPacket,
  maxQueueBacklog: number,
): string[] {
  return unique([
    ...rehearsal.invocationPlan.abortConditions,
    "approval request dispatch is attempted by this packet",
    "executor dispatch, process spawn, or sidecar start is attempted by this packet",
    "Gateway /readyz is unhealthy",
    "event-loop degradation is detected",
    "queue backlog exceeds " + maxQueueBacklog,
    "sidecar dry-run-only mode cannot be proven",
    "provider send or terminal ACK/replay is attempted",
    "historical outbox replay is attempted",
    "secret values appear in command args, logs, evidence, issue comments, or PR comments",
  ]);
}

function rollbackChecklist(options: TerminalBriefSidecarDryRunStartCanaryPlanOptions): string[] {
  const configured = stringArray(options.rollbackChecklist ?? options.rollback_checklist);
  if (configured.length) return configured;
  return [
    "stop the sidecar process/container only through the separately approved procedure",
    "preserve sanitized logs, packet ids, cursor values, and observed state",
    "confirm no provider send happened",
    "confirm no terminal ACK/replay happened",
    "confirm no DB migration, prune, mutation, or historical replay happened",
    "confirm Gateway /readyz and Telegram liveness after stop",
    "leave default-on disabled",
    "open a follow-up issue for duplicate polling, cursor drift, event-loop degradation, or secret leakage",
  ];
}

function nextActionsFor(state: TerminalBriefSidecarDryRunStartCanaryPlanState): string[] {
  if (state === "ready_for_dry_run_start_approval_request") {
    return [
      "review the draft approval and canary evidence checklist",
      "request explicit operator approval before dispatching any approval request or running any executor",
    ];
  }
  if (state === "waiting_for_executor_invocation_rehearsal") {
    return [
      "resolve executor invocation rehearsal readiness first",
      "do not draft dry-run start canary approval from an unready source",
    ];
  }
  if (state === "stale") {
    return [
      "refresh executor invocation rehearsal evidence before canary planning",
      "do not use stale sidecar start evidence for approval",
    ];
  }
  if (state === "conflicting") {
    return [
      "resolve conflicting executor invocation rehearsal evidence first",
      "rerun the source rehearsal with one coherent evidence set",
    ];
  }
  if (state === "rejected") {
    return [
      "do not request dry-run start approval",
      "create a new approval path only if the operator changes the decision",
    ];
  }
  return [
    "resolve blocked/unsafe rehearsal evidence before canary planning",
    "do not send approval requests, dispatch executor, spawn processes, start sidecar, send providers, ACK terminal rows, or mutate state from a blocked plan",
  ];
}

function buildPlanIdempotencyKey(
  rehearsal: TerminalBriefSidecarExecutorInvocationRehearsalPacket,
  generatedAt: string,
  state: TerminalBriefSidecarDryRunStartCanaryPlanState,
  options: TerminalBriefSidecarDryRunStartCanaryPlanOptions,
): string {
  const base = JSON.stringify({
    label: "terminal-brief-sidecar-dry-run-start-canary-plan",
    parentRoundId: rehearsal.parentRoundId ?? "unknown",
    rehearsal: rehearsal.idempotencyKey,
    generatedAt,
    state,
    requestedAction: options.requestedAction ?? options.requested_action,
    operatorTarget: options.operatorTarget ?? options.operator_target,
  });
  return "tb-sidecar-dry-run-start-canary-plan:" + createHash("sha256").update(base).digest("hex").slice(0, 24);
}

function titleForState(state: TerminalBriefSidecarDryRunStartCanaryPlanState): string {
  if (state === "ready_for_dry_run_start_approval_request") return "Ready: Terminal Brief sidecar dry-run start canary approval plan";
  if (state === "waiting_for_executor_invocation_rehearsal") return "Waiting: Terminal Brief sidecar executor invocation rehearsal";
  if (state === "stale") return "Stale: Terminal Brief sidecar dry-run start canary plan source";
  if (state === "conflicting") return "Conflicting: Terminal Brief sidecar dry-run start canary plan source";
  if (state === "rejected") return "Rejected: Terminal Brief sidecar dry-run start canary plan source";
  return "Blocked: Terminal Brief sidecar dry-run start canary plan";
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
