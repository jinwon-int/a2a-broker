import { createHash } from "node:crypto";

import type { TerminalBriefSidecarRuntimePreflightApprovalPacket } from "./terminal-brief-sidecar-runtime-preflight-approval.js";

export type TerminalBriefSidecarAdapterHandoffApprovalState =
  | "handoff_packet_ready"
  | "waiting_for_runtime_preflight_approval"
  | "stale"
  | "conflicting"
  | "rejected"
  | "blocked";

export interface TerminalBriefSidecarAdapterHandoffApprovalOptions {
  now?: string;
  mode?: string;
  adapterId?: string;
  adapter_id?: string;
  deliveryTargetClass?: string;
  delivery_target_class?: string;
  operatorTarget?: string;
  operator_target?: string;
  handoffReference?: string;
  handoff_reference?: string;
  messageTemplate?: string;
  message_template?: string;
  evidenceBundleReferences?: string[];
  evidence_bundle_references?: string[];
  operatorDecisionFields?: string[];
  operator_decision_fields?: string[];
}

export interface TerminalBriefSidecarAdapterHandoffApprovalPacket {
  kind: "a2a-broker.terminal-brief-sidecar-adapter-handoff-approval.packet";
  version: 1;
  generatedAt: string;
  mode: string;
  parentRoundId?: string;
  state: TerminalBriefSidecarAdapterHandoffApprovalState;
  dryRunOnly: true;
  sourceOnlyNoLive: true;
  idempotencyKey: string;
  source: {
    runtimePreflightApprovalState: TerminalBriefSidecarRuntimePreflightApprovalPacket["state"];
    runtimePreflightApprovalIdempotencyKey: string;
    runtimePreflightApprovalReady: boolean;
    adapterContractReady: boolean;
    requestedAction: string;
    requestedBy: string;
    operatorTarget: string;
    sourceAdapterName: string;
    sourceRuntime: string;
  };
  adapterHandoff: {
    draftOnly: true;
    adapterId: string;
    adapterKind: "approval_request_renderer";
    deliveryTargetClass: string;
    operatorTarget: string;
    handoffReference?: string;
    messageTemplate: string;
    messageBody: string;
    evidenceBundleReferences: string[];
    operatorDecisionFields: string[];
    dispatchPermitted: false;
    providerSendPermitted: false;
    approvalGrantPermitted: false;
    terminalAckPermitted: false;
    executionPermitted: false;
    secretsIncluded: false;
  };
  readiness: {
    sourceCriteriaMet: boolean;
    handoffPacketReady: boolean;
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
    adapterHandoffApprovalVersion: 1;
    harnessNeutral: true;
    openclawMessageSendRequired: false;
    hermesAdapterCompatible: true;
    gongyungAdapterCompatible: true;
    externalHarnessCompatible: true;
    consumesRuntimePreflightApprovalPacket: true;
    rendersApprovalRequestDraft: true;
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
    adapterHandoffPacketOnly: true;
    sourceOnlyNoLive: true;
    handoffDoesNotMutateState: true;
    handoffDoesNotSendApprovalRequest: true;
    messageBodyIsDraftOnly: true;
    evidenceBundleReferencesOnly: true;
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

export function buildTerminalBriefSidecarAdapterHandoffApproval(
  approval: TerminalBriefSidecarRuntimePreflightApprovalPacket,
  options: TerminalBriefSidecarAdapterHandoffApprovalOptions = {},
): TerminalBriefSidecarAdapterHandoffApprovalPacket {
  const generatedAt = options.now ?? new Date().toISOString();
  const blockers = buildBlockers(approval);
  const state = stateFor(approval, blockers);
  const sourceCriteriaMet = state === "handoff_packet_ready";
  const adapterId = optionalString(options.adapterId ?? options.adapter_id)
    ?? approval.source.adapterName
    ?? "terminal-brief-approval-renderer";
  const deliveryTargetClass = optionalString(options.deliveryTargetClass ?? options.delivery_target_class)
    ?? "operator-visible-approval-channel";
  const operatorTarget = optionalString(options.operatorTarget ?? options.operator_target)
    ?? approval.approvalPacket.operatorTarget;
  const evidenceBundleReferences = evidenceBundleReferencesFor(approval, options);
  const operatorDecisionFields = operatorDecisionFieldsFor(options);
  const messageTemplate = optionalString(options.messageTemplate ?? options.message_template)
    ?? defaultMessageTemplate();
  const messageBody = renderDraftMessageBody(approval, adapterId, deliveryTargetClass, evidenceBundleReferences);
  return {
    kind: "a2a-broker.terminal-brief-sidecar-adapter-handoff-approval.packet",
    version: 1,
    generatedAt,
    mode: options.mode ?? approval.mode,
    parentRoundId: approval.parentRoundId,
    state,
    dryRunOnly: true,
    sourceOnlyNoLive: true,
    idempotencyKey: buildAdapterHandoffApprovalIdempotencyKey(approval, generatedAt, state, options),
    source: {
      runtimePreflightApprovalState: approval.state,
      runtimePreflightApprovalIdempotencyKey: approval.idempotencyKey,
      runtimePreflightApprovalReady: approval.readiness.approvalPacketReady,
      adapterContractReady: approval.source.adapterContractReady,
      requestedAction: approval.approvalPacket.requestedAction,
      requestedBy: approval.approvalPacket.requestedBy,
      operatorTarget: approval.approvalPacket.operatorTarget,
      sourceAdapterName: approval.source.adapterName,
      sourceRuntime: approval.source.runtime,
    },
    adapterHandoff: {
      draftOnly: true,
      adapterId,
      adapterKind: "approval_request_renderer",
      deliveryTargetClass,
      operatorTarget,
      handoffReference: optionalString(options.handoffReference ?? options.handoff_reference),
      messageTemplate,
      messageBody,
      evidenceBundleReferences,
      operatorDecisionFields,
      dispatchPermitted: false,
      providerSendPermitted: false,
      approvalGrantPermitted: false,
      terminalAckPermitted: false,
      executionPermitted: false,
      secretsIncluded: false,
    },
    readiness: {
      sourceCriteriaMet,
      handoffPacketReady: sourceCriteriaMet,
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
      missingEvidence: missingEvidenceFor(approval),
      blockers: [
        ...blockers,
        "approval request dispatch is not permitted by this adapter handoff packet",
        "adapter handoff output is a draft and does not prove visibility or terminal ACK",
        "operator approval and runtime execution require later separate approved paths",
      ],
      nextAction: sourceCriteriaMet
        ? "review the adapter handoff packet and choose a separate approved sender before dispatch"
        : "resolve runtime preflight approval readiness before adapter handoff",
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
      adapterHandoffApprovalVersion: 1,
      harnessNeutral: true,
      openclawMessageSendRequired: false,
      hermesAdapterCompatible: true,
      gongyungAdapterCompatible: true,
      externalHarnessCompatible: true,
      consumesRuntimePreflightApprovalPacket: true,
      rendersApprovalRequestDraft: true,
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
      adapterHandoffPacketOnly: true,
      sourceOnlyNoLive: true,
      handoffDoesNotMutateState: true,
      handoffDoesNotSendApprovalRequest: true,
      messageBodyIsDraftOnly: true,
      evidenceBundleReferencesOnly: true,
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

export function extractTerminalBriefSidecarAdapterHandoffApprovalPacket(
  input: unknown,
): TerminalBriefSidecarRuntimePreflightApprovalPacket {
  const envelope = isRecord(input) ? input : {};
  const candidates = [
    input,
    envelope.runtimePreflightApprovalPacket,
    envelope.runtimePreflightApproval,
    envelope.sidecarRuntimePreflightApprovalPacket,
    envelope.sidecarRuntimePreflightApproval,
    envelope.approvalPacket,
    envelope.packet,
  ];
  const packet = candidates.find(isTerminalBriefSidecarRuntimePreflightApprovalPacket);
  if (!packet) {
    throw new Error("expected a Terminal Brief sidecar runtime preflight approval packet");
  }
  return packet;
}

export function extractTerminalBriefSidecarAdapterHandoffApprovalOptions(
  input: unknown,
): TerminalBriefSidecarAdapterHandoffApprovalOptions {
  const envelope = isRecord(input) ? input : {};
  const candidate = envelope.adapterHandoffApproval
    ?? envelope.adapterHandoffApprovalOptions
    ?? envelope.adapterHandoff
    ?? envelope.options;
  return isRecord(candidate) ? candidate as TerminalBriefSidecarAdapterHandoffApprovalOptions : {};
}

export function renderTerminalBriefSidecarAdapterHandoffApprovalMarkdown(
  packet: TerminalBriefSidecarAdapterHandoffApprovalPacket,
): string {
  return [
    titleForState(packet.state),
    "Mode: " + packet.mode,
    "Parent round: " + (packet.parentRoundId ?? "unknown"),
    "State: " + packet.state + " dryRunOnly=" + packet.dryRunOnly + " sourceOnlyNoLive=" + packet.sourceOnlyNoLive,
    "Idempotency: " + packet.idempotencyKey,
    "Source approval: state=" + packet.source.runtimePreflightApprovalState
      + " ready=" + packet.source.runtimePreflightApprovalReady
      + " adapterContractReady=" + packet.source.adapterContractReady
      + " requestedAction=" + packet.source.requestedAction,
    "Adapter handoff: adapterId=" + packet.adapterHandoff.adapterId
      + " targetClass=" + packet.adapterHandoff.deliveryTargetClass
      + " dispatchPermitted=" + packet.adapterHandoff.dispatchPermitted
      + " providerSendPermitted=" + packet.adapterHandoff.providerSendPermitted,
    "",
    "Readiness: sourceCriteriaMet=" + packet.readiness.sourceCriteriaMet
      + " handoffPacketReady=" + packet.readiness.handoffPacketReady
      + " approvalRequestDispatchPermitted=" + packet.readiness.approvalRequestDispatchPermitted
      + " providerSendPermitted=" + packet.readiness.providerSendPermitted
      + " terminalAckPermitted=" + packet.readiness.terminalAckPermitted
      + " executionPermitted=" + packet.readiness.executionPermitted,
    ...(packet.blockers.length ? ["", "Blockers:", ...packet.blockers.map((blocker) => "- " + blocker)] : []),
    "",
    "Next actions:",
    ...packet.nextActions.map((action) => "- " + action),
    "",
    "Safety: adapter handoff packet only; does not send approval, grant approval, dispatch/invoke executor, spawn a process, start sidecar, enable default-on, send providers, ACK/replay terminal rows, mutate GitHub/DB/TaskFlow state, restart/deploy, replay history, release, publish, or move secrets.",
  ].join("\n");
}

function buildBlockers(approval: TerminalBriefSidecarRuntimePreflightApprovalPacket): string[] {
  return unique([
    ...approval.blockers,
    ...(approval.state !== "approval_packet_ready" ? ["runtime preflight approval is " + approval.state] : []),
    ...(!approval.readiness.sourceCriteriaMet ? ["runtime preflight approval source criteria are not met"] : []),
    ...(!approval.readiness.approvalPacketReady ? ["runtime preflight approval packet is not ready"] : []),
    ...(!approval.source.adapterContractReady ? ["adapter contract is not ready"] : []),
    ...(approval.readiness.approvalRequestDispatchPermitted !== false ? ["runtime preflight unexpectedly permits approval dispatch"] : []),
    ...(approval.readiness.approvalGrantPermitted !== false ? ["runtime preflight unexpectedly permits approval grant"] : []),
    ...(approval.readiness.startExecutorDispatchPermitted !== false ? ["runtime preflight unexpectedly permits start executor dispatch"] : []),
    ...(approval.readiness.executorInvocationPermitted !== false ? ["runtime preflight unexpectedly permits executor invocation"] : []),
    ...(approval.readiness.processSpawnPermitted !== false ? ["runtime preflight unexpectedly permits process spawn"] : []),
    ...(approval.readiness.sidecarStartPermitted !== false ? ["runtime preflight unexpectedly permits sidecar start"] : []),
    ...(approval.readiness.providerSendPermitted !== false ? ["runtime preflight unexpectedly permits provider send"] : []),
    ...(approval.readiness.terminalAckPermitted !== false ? ["runtime preflight unexpectedly permits terminal ACK"] : []),
    ...(approval.readiness.executionPermitted !== false ? ["runtime preflight unexpectedly permits execution"] : []),
    ...(approval.readiness.dbMutationPermitted !== false ? ["runtime preflight unexpectedly permits DB mutation"] : []),
    ...(approval.integrationContract.sendsApprovalRequest ? ["runtime preflight unexpectedly sends approval request"] : []),
    ...(approval.integrationContract.grantsApproval ? ["runtime preflight unexpectedly grants approval"] : []),
    ...(approval.integrationContract.invokesExecutor ? ["runtime preflight unexpectedly invokes executor"] : []),
    ...(approval.integrationContract.spawnsProcess ? ["runtime preflight unexpectedly spawns process"] : []),
    ...(approval.integrationContract.startsSidecar ? ["runtime preflight unexpectedly starts sidecar"] : []),
    ...(approval.integrationContract.executesAction ? ["runtime preflight unexpectedly executes action"] : []),
    ...(approval.semantics.performsProviderSend ? ["runtime preflight unexpectedly performs provider send"] : []),
    ...(approval.semantics.performsTerminalAck ? ["runtime preflight unexpectedly performs terminal ACK"] : []),
    ...(approval.semantics.performsRuntimeRestartOrDeploy ? ["runtime preflight unexpectedly performs restart/deploy"] : []),
    ...(approval.semantics.performsDbMutation ? ["runtime preflight unexpectedly performs DB mutation"] : []),
    ...(approval.semantics.performsHistoricalReplay ? ["runtime preflight unexpectedly performs historical replay"] : []),
    ...(approval.semantics.performsReleaseOrPublish ? ["runtime preflight unexpectedly performs release/publish"] : []),
    ...(approval.semantics.movesSecretsOrCredentials ? ["runtime preflight unexpectedly moves secrets/credentials"] : []),
  ].filter(Boolean));
}

function stateFor(
  approval: TerminalBriefSidecarRuntimePreflightApprovalPacket,
  blockers: string[],
): TerminalBriefSidecarAdapterHandoffApprovalState {
  if (approval.state === "stale") return "stale";
  if (approval.state === "conflicting") return "conflicting";
  if (approval.state === "rejected") return "rejected";
  if (approval.state === "blocked" || hasUnsafeNoLiveViolation(approval)) return "blocked";
  if (approval.state !== "approval_packet_ready") return "waiting_for_runtime_preflight_approval";
  return blockers.length ? "blocked" : "handoff_packet_ready";
}

function hasUnsafeNoLiveViolation(approval: TerminalBriefSidecarRuntimePreflightApprovalPacket): boolean {
  return approval.readiness.approvalRequestDispatchPermitted !== false
    || approval.readiness.approvalGrantPermitted !== false
    || approval.readiness.startExecutorDispatchPermitted !== false
    || approval.readiness.executorInvocationPermitted !== false
    || approval.readiness.processSpawnPermitted !== false
    || approval.readiness.sidecarStartPermitted !== false
    || approval.readiness.providerSendPermitted !== false
    || approval.readiness.terminalAckPermitted !== false
    || approval.readiness.executionPermitted !== false
    || approval.readiness.dbMutationPermitted !== false
    || approval.integrationContract.sendsApprovalRequest
    || approval.integrationContract.grantsApproval
    || approval.integrationContract.invokesExecutor
    || approval.integrationContract.spawnsProcess
    || approval.integrationContract.startsSidecar
    || approval.integrationContract.executesAction
    || approval.semantics.performsProviderSend
    || approval.semantics.performsTerminalAck
    || approval.semantics.performsRuntimeRestartOrDeploy
    || approval.semantics.performsDbMutation
    || approval.semantics.performsHistoricalReplay
    || approval.semantics.performsReleaseOrPublish
    || approval.semantics.movesSecretsOrCredentials;
}

function missingEvidenceFor(approval: TerminalBriefSidecarRuntimePreflightApprovalPacket): string[] {
  const missing: string[] = [];
  if (approval.state !== "approval_packet_ready") missing.push("ready_runtime_preflight_approval");
  if (!approval.readiness.sourceCriteriaMet) missing.push("source_criteria");
  if (!approval.readiness.approvalPacketReady) missing.push("runtime_preflight_approval_packet");
  if (!approval.source.adapterContractReady) missing.push("adapter_contract");
  return missing;
}

function evidenceBundleReferencesFor(
  approval: TerminalBriefSidecarRuntimePreflightApprovalPacket,
  options: TerminalBriefSidecarAdapterHandoffApprovalOptions,
): string[] {
  const configured = stringArray(options.evidenceBundleReferences ?? options.evidence_bundle_references);
  return unique(configured.length ? configured : [
    approval.idempotencyKey,
    approval.source.invocationRehearsalIdempotencyKey,
    "adapter-contract-v" + approval.source.adapterContractVersion,
    "runtime-preflight-checklist",
    "rollback-checklist",
  ]);
}

function operatorDecisionFieldsFor(options: TerminalBriefSidecarAdapterHandoffApprovalOptions): string[] {
  const configured = stringArray(options.operatorDecisionFields ?? options.operator_decision_fields);
  return configured.length ? configured : [
    "approve_supervised_dry_run_start",
    "reject",
    "request_more_evidence",
    "approval_reference",
    "operator_visible_confirmation",
  ];
}

function defaultMessageTemplate(): string {
  return [
    "Terminal Brief sidecar supervised dry-run start approval request",
    "Action: {{requestedAction}}",
    "Adapter: {{adapterId}}",
    "Evidence bundle: {{evidenceBundleReferences}}",
    "Reply with approve/reject/request_more_evidence plus approval_reference.",
  ].join("\n");
}

function renderDraftMessageBody(
  approval: TerminalBriefSidecarRuntimePreflightApprovalPacket,
  adapterId: string,
  deliveryTargetClass: string,
  evidenceBundleReferences: string[],
): string {
  return [
    "Terminal Brief sidecar supervised dry-run start approval request",
    "Action: " + approval.approvalPacket.requestedAction,
    "Requested by: " + approval.approvalPacket.requestedBy,
    "Operator target: " + approval.approvalPacket.operatorTarget,
    "Adapter handoff: " + adapterId + " via " + deliveryTargetClass,
    "Evidence bundle: " + evidenceBundleReferences.join(", "),
    "Safety: this is a draft handoff only. It does not send, grant approval, invoke an executor, spawn a process, start sidecar, enable default-on, send providers, ACK terminal rows, mutate DB/GitHub/TaskFlow, restart/deploy, replay history, release, publish, or move secrets.",
  ].join("\n");
}

function nextActionsFor(state: TerminalBriefSidecarAdapterHandoffApprovalState): string[] {
  if (state === "handoff_packet_ready") {
    return [
      "review the adapter handoff packet",
      "choose a separately approved sender before any approval request dispatch",
    ];
  }
  if (state === "waiting_for_runtime_preflight_approval") {
    return [
      "resolve runtime preflight approval first",
      "do not render an adapter handoff from an unready approval packet",
    ];
  }
  if (state === "stale") return ["refresh runtime preflight approval evidence before adapter handoff"];
  if (state === "conflicting") return ["resolve conflicting runtime preflight approval evidence before adapter handoff"];
  if (state === "rejected") return ["do not render adapter handoff unless the operator changes the decision"];
  return [
    "resolve blocked/unsafe runtime preflight approval evidence before adapter handoff",
    "do not send approval, dispatch executor, spawn a process, start sidecar, send providers, ACK terminal rows, or mutate state from a blocked packet",
  ];
}

function buildAdapterHandoffApprovalIdempotencyKey(
  approval: TerminalBriefSidecarRuntimePreflightApprovalPacket,
  generatedAt: string,
  state: TerminalBriefSidecarAdapterHandoffApprovalState,
  options: TerminalBriefSidecarAdapterHandoffApprovalOptions,
): string {
  const base = JSON.stringify({
    label: "terminal-brief-sidecar-adapter-handoff-approval",
    parentRoundId: approval.parentRoundId ?? "unknown",
    approval: approval.idempotencyKey,
    generatedAt,
    state,
    adapterId: options.adapterId ?? options.adapter_id,
    handoffReference: options.handoffReference ?? options.handoff_reference,
  });
  return "tb-sidecar-adapter-handoff-approval:" + createHash("sha256").update(base).digest("hex").slice(0, 24);
}

function titleForState(state: TerminalBriefSidecarAdapterHandoffApprovalState): string {
  if (state === "handoff_packet_ready") return "Ready: Terminal Brief sidecar adapter handoff approval";
  if (state === "waiting_for_runtime_preflight_approval") return "Waiting: Terminal Brief sidecar runtime preflight approval";
  if (state === "stale") return "Stale: Terminal Brief sidecar adapter handoff approval source";
  if (state === "conflicting") return "Conflicting: Terminal Brief sidecar adapter handoff approval source";
  if (state === "rejected") return "Rejected: Terminal Brief sidecar adapter handoff approval source";
  return "Blocked: Terminal Brief sidecar adapter handoff approval";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function isTerminalBriefSidecarRuntimePreflightApprovalPacket(
  value: unknown,
): value is TerminalBriefSidecarRuntimePreflightApprovalPacket {
  return isRecord(value) && value.kind === "a2a-broker.terminal-brief-sidecar-runtime-preflight-approval.packet";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
