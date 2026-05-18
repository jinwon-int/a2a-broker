import { createHash } from "node:crypto";

import type { TerminalBriefSidecarStartExecutorGatePacket } from "./terminal-brief-sidecar-start-executor-gate.js";

export type TerminalBriefSidecarExecutorInvocationRehearsalState =
  | "ready_for_executor_invocation_rehearsal"
  | "waiting_for_start_executor_review"
  | "stale"
  | "conflicting"
  | "rejected"
  | "blocked";

export interface TerminalBriefSidecarExecutorInvocationRehearsalOptions {
  now?: string;
  mode?: string;
  adapterName?: string;
  adapter_name?: string;
  executorName?: string;
  executor_name?: string;
  executorRuntime?: string;
  executor_runtime?: string;
  supervisor?: string;
  commandName?: string;
  command_name?: string;
  commandArgs?: string[];
  command_args?: string[];
  envKeys?: string[];
  env_keys?: string[];
  healthCheckTarget?: string;
  health_check_target?: string;
  maxRuntimeSeconds?: number;
  max_runtime_seconds?: number;
  expectedEvidence?: string[];
  expected_evidence?: string[];
}

export interface TerminalBriefSidecarExecutorInvocationRehearsalPacket {
  kind: "a2a-broker.terminal-brief-sidecar-executor-invocation-rehearsal.packet";
  version: 1;
  generatedAt: string;
  mode: string;
  parentRoundId?: string;
  state: TerminalBriefSidecarExecutorInvocationRehearsalState;
  dryRunOnly: true;
  sourceOnlyNoLive: true;
  idempotencyKey: string;
  source: {
    startExecutorGateState: TerminalBriefSidecarStartExecutorGatePacket["state"];
    startExecutorGateIdempotencyKey: string;
    startExecutorReviewReady: boolean;
    requestedExecutor: string;
    operatorApprovalReference?: string;
    commandShapeKind: "metadata_only";
  };
  invocationPlan: {
    rehearsalOnly: true;
    supervisedDryRunOnly: true;
    executorName: string;
    adapterName: string;
    executorRuntime: string;
    supervisor: string;
    healthCheckTarget?: string;
    maxRuntimeSeconds?: number;
    commandShape: {
      kind: "metadata_only";
      commandName: string;
      commandArgs: string[];
      envKeys: string[];
      inheritedFromStartGate: boolean;
      commandExecutionPermitted: false;
      processSpawnPermitted: false;
      secretsIncluded: false;
    };
    preflightChecks: string[];
    abortConditions: string[];
    rollbackInstructions: string[];
    expectedEvidence: string[];
  };
  readiness: {
    sourceCriteriaMet: boolean;
    executorInvocationRehearsalReady: boolean;
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
    rehearsalVersion: 1;
    harnessNeutral: true;
    openclawMessageSendRequired: false;
    hermesAdapterCompatible: true;
    gongyungAdapterCompatible: true;
    consumesStartExecutorGatePacket: true;
    dispatchesStartExecutor: false;
    invokesExecutor: false;
    spawnsProcess: false;
    startsSidecar: false;
    enablesDefaultOn: false;
    executesAction: false;
  };
  semantics: {
    executorInvocationRehearsalOnly: true;
    sourceOnlyNoLive: true;
    rehearsalDoesNotMutateState: true;
    commandShapeIsMetadataOnly: true;
    commandShapeDoesNotContainSecretValues: true;
    startExecutorGateDoesNotPermitInvocation: true;
    providerAcceptedIsVisibilityProof: false;
    terminalAckEligibleDoesNotPermitAck: true;
    sidecarStartRequiresSeparateApprovedExecutor: true;
    defaultOnNotEnabledByThisPacket: true;
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

export function buildTerminalBriefSidecarExecutorInvocationRehearsal(
  gate: TerminalBriefSidecarStartExecutorGatePacket,
  options: TerminalBriefSidecarExecutorInvocationRehearsalOptions = {},
): TerminalBriefSidecarExecutorInvocationRehearsalPacket {
  const generatedAt = options.now ?? new Date().toISOString();
  const blockers = buildBlockers(gate);
  const state = stateFor(gate, blockers);
  const sourceCriteriaMet = state === "ready_for_executor_invocation_rehearsal";
  const commandShape = buildCommandShape(gate, options);
  const missingEvidence = missingEvidenceFor(gate);
  return {
    kind: "a2a-broker.terminal-brief-sidecar-executor-invocation-rehearsal.packet",
    version: 1,
    generatedAt,
    mode: options.mode ?? gate.mode,
    parentRoundId: gate.parentRoundId,
    state,
    dryRunOnly: true,
    sourceOnlyNoLive: true,
    idempotencyKey: buildRehearsalIdempotencyKey(gate, generatedAt, state, options),
    source: {
      startExecutorGateState: gate.state,
      startExecutorGateIdempotencyKey: gate.idempotencyKey,
      startExecutorReviewReady: gate.readiness.startExecutorReviewReady,
      requestedExecutor: gate.startPlan.requestedExecutor,
      operatorApprovalReference: gate.startPlan.operatorApprovalReference,
      commandShapeKind: gate.startPlan.commandShape.kind,
    },
    invocationPlan: {
      rehearsalOnly: true,
      supervisedDryRunOnly: true,
      executorName: optionalString(options.executorName ?? options.executor_name) ?? gate.startPlan.requestedExecutor,
      adapterName: optionalString(options.adapterName ?? options.adapter_name) ?? "harness-neutral",
      executorRuntime: optionalString(options.executorRuntime ?? options.executor_runtime) ?? "metadata-only",
      supervisor: optionalString(options.supervisor) ?? "broker-finalizer-review",
      healthCheckTarget: optionalString(options.healthCheckTarget ?? options.health_check_target),
      maxRuntimeSeconds: numberValue(options.maxRuntimeSeconds ?? options.max_runtime_seconds),
      commandShape,
      preflightChecks: [
        "source start executor gate is ready_for_start_executor_review",
        "dryRunOnly and sourceOnlyNoLive are true",
        "command shape is metadata only and contains env key names only",
        "Gateway readiness, event loop health, and queue backlog are checked outside this packet before any separate executor run",
        "operator approval for actual executor invocation is collected separately before runtime execution",
      ],
      abortConditions: unique([
        ...gate.startPlan.abortConditions,
        "this rehearsal is asked to spawn a process or dispatch an executor",
        "sidecar dry-run-only mode cannot be proven before separate execution",
        "provider send or terminal ACK/replay is attempted by this path",
        "a secret value, token, or credential value appears in command args or evidence",
      ]),
      rollbackInstructions: [
        "discard this rehearsal packet if source gate evidence changes",
        "do not infer sidecar running state from this rehearsal",
        "keep default-on, provider send, terminal ACK/replay, deploy/restart, and DB mutation disabled",
        "rerun the start executor gate and rehearsal after any source evidence refresh",
      ],
      expectedEvidence: expectedEvidence(options),
    },
    readiness: {
      sourceCriteriaMet,
      executorInvocationRehearsalReady: sourceCriteriaMet,
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
        "executor invocation is not permitted by this rehearsal packet",
        "process spawn and sidecar start require a separate approved executor runtime",
      ],
      nextAction: sourceCriteriaMet
        ? "review the metadata-only invocation rehearsal, then request separate approval before any executor runtime action"
        : "resolve start executor gate readiness before invocation rehearsal review",
    },
    blockers,
    nextActions: nextActionsFor(state),
    approvalSensitiveActionsExcluded: [
      "dispatching or invoking a start executor",
      "spawning a process or starting/stopping the sidecar",
      "Terminal Brief default-on enablement",
      "live provider/Hermes/Gongyung/Telegram/OpenClaw send",
      "terminal ACK/replay or terminal receipt DB mutation",
      "operator approval grant mutation or execution",
      "GitHub PR merge, issue close, or comment post from the packet/route",
      "TaskFlow record creation or broker DB mutation",
      "production deploy/restart, historical replay, release, publish, or secret movement",
    ],
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
  };
}

export function extractTerminalBriefSidecarExecutorInvocationRehearsalGate(
  input: unknown,
): TerminalBriefSidecarStartExecutorGatePacket {
  const envelope = isRecord(input) ? input : {};
  const candidates = [
    input,
    envelope.startExecutorGate,
    envelope.startExecutorGatePacket,
    envelope.sidecarStartExecutorGate,
    envelope.sidecarStartExecutorGatePacket,
    envelope.gate,
    envelope.packet,
  ];
  const packet = candidates.find(isTerminalBriefSidecarStartExecutorGatePacket);
  if (!packet) {
    throw new Error("expected a Terminal Brief sidecar start executor gate packet");
  }
  return packet;
}

export function extractTerminalBriefSidecarExecutorInvocationRehearsalOptions(
  input: unknown,
): TerminalBriefSidecarExecutorInvocationRehearsalOptions {
  const envelope = isRecord(input) ? input : {};
  const candidate = envelope.executorInvocationRehearsal
    ?? envelope.executorInvocationRehearsalOptions
    ?? envelope.invocationRehearsal
    ?? envelope.invocationOptions
    ?? envelope.options;
  return isRecord(candidate) ? candidate as TerminalBriefSidecarExecutorInvocationRehearsalOptions : {};
}

export function renderTerminalBriefSidecarExecutorInvocationRehearsalMarkdown(
  packet: TerminalBriefSidecarExecutorInvocationRehearsalPacket,
): string {
  return [
    titleForState(packet.state),
    "Mode: " + packet.mode,
    "Parent round: " + (packet.parentRoundId ?? "unknown"),
    "State: " + packet.state + " dryRunOnly=" + packet.dryRunOnly + " sourceOnlyNoLive=" + packet.sourceOnlyNoLive,
    "Idempotency: " + packet.idempotencyKey,
    "Source gate: state=" + packet.source.startExecutorGateState
      + " startExecutorReviewReady=" + packet.source.startExecutorReviewReady
      + " requestedExecutor=" + packet.source.requestedExecutor,
    "Invocation rehearsal: adapter=" + packet.invocationPlan.adapterName
      + " runtime=" + packet.invocationPlan.executorRuntime
      + " commandExecutionPermitted=" + packet.invocationPlan.commandShape.commandExecutionPermitted
      + " processSpawnPermitted=" + packet.invocationPlan.commandShape.processSpawnPermitted,
    "",
    "Readiness: sourceCriteriaMet=" + packet.readiness.sourceCriteriaMet
      + " executorInvocationRehearsalReady=" + packet.readiness.executorInvocationRehearsalReady
      + " startExecutorDispatchPermitted=" + packet.readiness.startExecutorDispatchPermitted
      + " executorInvocationPermitted=" + packet.readiness.executorInvocationPermitted
      + " sidecarStartPermitted=" + packet.readiness.sidecarStartPermitted
      + " terminalAckPermitted=" + packet.readiness.terminalAckPermitted
      + " executionPermitted=" + packet.readiness.executionPermitted,
    ...(packet.blockers.length ? ["", "Blockers:", ...packet.blockers.map((blocker) => "- " + blocker)] : []),
    "",
    "Next actions:",
    ...packet.nextActions.map((action) => "- " + action),
    "",
    "Safety: executor invocation rehearsal only; command shape is metadata only; does not dispatch executor, spawn a process, start sidecar, enable default-on, send providers, ACK/replay terminal rows, mutate GitHub/DB/TaskFlow state, restart/deploy, replay history, release, publish, or move secrets.",
  ].join("\n");
}

function buildCommandShape(
  gate: TerminalBriefSidecarStartExecutorGatePacket,
  options: TerminalBriefSidecarExecutorInvocationRehearsalOptions,
): TerminalBriefSidecarExecutorInvocationRehearsalPacket["invocationPlan"]["commandShape"] {
  const inherited = gate.startPlan.commandShape;
  const commandArgs = stringArray(options.commandArgs ?? options.command_args);
  const envKeys = stringArray(options.envKeys ?? options.env_keys);
  return {
    kind: "metadata_only",
    commandName: optionalString(options.commandName ?? options.command_name) ?? inherited.commandName,
    commandArgs: commandArgs.length ? commandArgs : inherited.commandArgs,
    envKeys: envKeys.length ? envKeys : inherited.envKeys,
    inheritedFromStartGate: commandArgs.length === 0
      && envKeys.length === 0
      && !optionalString(options.commandName ?? options.command_name),
    commandExecutionPermitted: false,
    processSpawnPermitted: false,
    secretsIncluded: false,
  };
}

function buildBlockers(gate: TerminalBriefSidecarStartExecutorGatePacket): string[] {
  return unique([
    ...gate.blockers,
    ...(gate.state !== "ready_for_start_executor_review" ? ["start executor gate is " + gate.state] : []),
    ...(!gate.readiness.sourceCriteriaMet ? ["start executor gate source criteria are not met"] : []),
    ...(!gate.readiness.startExecutorReviewReady ? ["start executor review is not ready"] : []),
    ...(gate.readiness.startExecutorDispatchPermitted !== false ? ["start executor gate unexpectedly permits dispatch"] : []),
    ...(gate.readiness.sidecarStartPermitted !== false ? ["start executor gate unexpectedly permits sidecar start"] : []),
    ...(gate.readiness.defaultOnPermitted !== false ? ["start executor gate unexpectedly permits default-on"] : []),
    ...(gate.readiness.approvalGrantPermitted !== false ? ["start executor gate unexpectedly permits approval grant"] : []),
    ...(gate.readiness.providerSendPermitted !== false ? ["start executor gate unexpectedly permits provider send"] : []),
    ...(gate.readiness.terminalAckPermitted !== false ? ["start executor gate unexpectedly permits terminal ACK"] : []),
    ...(gate.readiness.executionPermitted !== false ? ["start executor gate unexpectedly permits execution"] : []),
    ...(gate.startPlan.commandShape.kind !== "metadata_only" ? ["start executor gate command shape is not metadata only"] : []),
    ...(gate.startPlan.commandShape.commandExecutionPermitted !== false ? ["start executor gate command shape unexpectedly permits execution"] : []),
    ...(gate.startPlan.commandShape.secretsIncluded !== false ? ["start executor gate command shape unexpectedly includes secrets"] : []),
    ...(gate.integrationContract.dispatchesStartExecutor ? ["start executor gate unexpectedly dispatches executor"] : []),
    ...(gate.integrationContract.startsSidecar ? ["start executor gate unexpectedly starts sidecar"] : []),
    ...(gate.integrationContract.enablesDefaultOn ? ["start executor gate unexpectedly enables default-on"] : []),
    ...(gate.integrationContract.executesAction ? ["start executor gate unexpectedly executes action"] : []),
    ...(gate.semantics.performsProviderSend ? ["start executor gate unexpectedly performs provider send"] : []),
    ...(gate.semantics.performsTerminalAck ? ["start executor gate unexpectedly performs terminal ACK"] : []),
    ...(gate.semantics.performsRuntimeRestartOrDeploy ? ["start executor gate unexpectedly performs restart/deploy"] : []),
    ...(gate.semantics.performsDbMutation ? ["start executor gate unexpectedly performs DB mutation"] : []),
    ...(gate.semantics.performsHistoricalReplay ? ["start executor gate unexpectedly performs historical replay"] : []),
    ...(gate.semantics.performsReleaseOrPublish ? ["start executor gate unexpectedly performs release/publish"] : []),
    ...(gate.semantics.movesSecretsOrCredentials ? ["start executor gate unexpectedly moves secrets/credentials"] : []),
  ].filter(Boolean));
}

function stateFor(
  gate: TerminalBriefSidecarStartExecutorGatePacket,
  blockers: string[],
): TerminalBriefSidecarExecutorInvocationRehearsalState {
  if (gate.state === "stale") return "stale";
  if (gate.state === "conflicting") return "conflicting";
  if (gate.state === "rejected") return "rejected";
  if (gate.state === "blocked" || hasUnsafeNoLiveViolation(gate)) return "blocked";
  if (gate.state !== "ready_for_start_executor_review") return "waiting_for_start_executor_review";
  return blockers.length ? "blocked" : "ready_for_executor_invocation_rehearsal";
}

function hasUnsafeNoLiveViolation(gate: TerminalBriefSidecarStartExecutorGatePacket): boolean {
  return gate.readiness.startExecutorDispatchPermitted !== false
    || gate.readiness.sidecarStartPermitted !== false
    || gate.readiness.defaultOnPermitted !== false
    || gate.readiness.approvalGrantPermitted !== false
    || gate.readiness.providerSendPermitted !== false
    || gate.readiness.terminalAckPermitted !== false
    || gate.readiness.executionPermitted !== false
    || gate.startPlan.commandShape.commandExecutionPermitted !== false
    || gate.startPlan.commandShape.secretsIncluded !== false
    || gate.integrationContract.dispatchesStartExecutor
    || gate.integrationContract.startsSidecar
    || gate.integrationContract.enablesDefaultOn
    || gate.integrationContract.executesAction
    || gate.semantics.performsProviderSend
    || gate.semantics.performsTerminalAck
    || gate.semantics.performsRuntimeRestartOrDeploy
    || gate.semantics.performsDbMutation
    || gate.semantics.performsHistoricalReplay
    || gate.semantics.performsReleaseOrPublish
    || gate.semantics.movesSecretsOrCredentials;
}

function missingEvidenceFor(gate: TerminalBriefSidecarStartExecutorGatePacket): string[] {
  const missing: string[] = [];
  if (gate.state !== "ready_for_start_executor_review") missing.push("ready_start_executor_gate");
  if (!gate.readiness.sourceCriteriaMet) missing.push("source_criteria");
  if (!gate.readiness.startExecutorReviewReady) missing.push("start_executor_review");
  return missing;
}

function expectedEvidence(options: TerminalBriefSidecarExecutorInvocationRehearsalOptions): string[] {
  const configured = stringArray(options.expectedEvidence ?? options.expected_evidence);
  if (configured.length) return configured;
  return [
    "operator-reviewed metadata-only invocation plan",
    "separate executor runtime evidence if a later approved dry-run start is performed",
    "no provider send, terminal ACK/replay, default-on enablement, deploy/restart, or DB mutation evidence from this rehearsal",
  ];
}

function nextActionsFor(state: TerminalBriefSidecarExecutorInvocationRehearsalState): string[] {
  if (state === "ready_for_executor_invocation_rehearsal") {
    return [
      "review the metadata-only executor invocation rehearsal",
      "request explicit approval before any separate executor dispatch or process spawn",
    ];
  }
  if (state === "waiting_for_start_executor_review") {
    return [
      "resolve the start executor gate to ready_for_start_executor_review first",
      "do not rehearse invocation from an unready source gate",
    ];
  }
  if (state === "stale") {
    return [
      "refresh the start executor gate before invocation rehearsal",
      "do not rely on stale sidecar startup evidence",
    ];
  }
  if (state === "conflicting") {
    return [
      "resolve conflicting start executor gate evidence first",
      "rerun the gate with one coherent evidence set",
    ];
  }
  if (state === "rejected") {
    return [
      "do not rehearse or run sidecar startup",
      "create a new approval path only if the operator changes the decision",
    ];
  }
  return [
    "resolve blocked/unsafe gate evidence before invocation rehearsal",
    "do not dispatch executor, spawn a process, start sidecar, send providers, ACK terminal rows, or mutate state from a blocked rehearsal",
  ];
}

function buildRehearsalIdempotencyKey(
  gate: TerminalBriefSidecarStartExecutorGatePacket,
  generatedAt: string,
  state: TerminalBriefSidecarExecutorInvocationRehearsalState,
  options: TerminalBriefSidecarExecutorInvocationRehearsalOptions,
): string {
  const base = JSON.stringify({
    label: "terminal-brief-sidecar-executor-invocation-rehearsal",
    parentRoundId: gate.parentRoundId ?? "unknown",
    gate: gate.idempotencyKey,
    generatedAt,
    state,
    adapterName: options.adapterName ?? options.adapter_name,
    executorName: options.executorName ?? options.executor_name,
    executorRuntime: options.executorRuntime ?? options.executor_runtime,
  });
  return "tb-sidecar-executor-invocation-rehearsal:" + createHash("sha256").update(base).digest("hex").slice(0, 24);
}

function titleForState(state: TerminalBriefSidecarExecutorInvocationRehearsalState): string {
  if (state === "ready_for_executor_invocation_rehearsal") return "Ready: Terminal Brief sidecar executor invocation rehearsal";
  if (state === "waiting_for_start_executor_review") return "Waiting: Terminal Brief sidecar start executor gate review";
  if (state === "stale") return "Stale: Terminal Brief sidecar executor invocation rehearsal source";
  if (state === "conflicting") return "Conflicting: Terminal Brief sidecar executor invocation rehearsal source";
  if (state === "rejected") return "Rejected: Terminal Brief sidecar executor invocation rehearsal source";
  return "Blocked: Terminal Brief sidecar executor invocation rehearsal";
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

function isTerminalBriefSidecarStartExecutorGatePacket(value: unknown): value is TerminalBriefSidecarStartExecutorGatePacket {
  return isRecord(value) && value.kind === "a2a-broker.terminal-brief-sidecar-start-executor-gate.packet";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
