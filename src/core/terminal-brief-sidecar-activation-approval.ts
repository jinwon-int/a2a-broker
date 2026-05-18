import { createHash } from "node:crypto";

import type { TerminalBriefSidecarDryRunGatePacket } from "./terminal-brief-sidecar-dry-run-gate.js";

export type TerminalBriefSidecarActivationApprovalState =
  | "approval_request_draft_ready"
  | "waiting_for_gate"
  | "stale"
  | "blocked";

export interface TerminalBriefSidecarActivationApprovalOptions {
  now?: string;
  mode?: string;
  requestedBy?: string;
  requested_by?: string;
  operatorTarget?: string;
  operator_target?: string;
  operatorChannel?: string;
  operator_channel?: string;
  approvalWindowMinutes?: number;
  approval_window_minutes?: number;
  abortQueueBacklog?: number;
  abort_queue_backlog?: number;
  note?: string;
}

export interface TerminalBriefSidecarActivationApprovalPacket {
  kind: "a2a-broker.terminal-brief-sidecar-activation-approval.packet";
  version: 1;
  generatedAt: string;
  mode: string;
  parentRoundId?: string;
  state: TerminalBriefSidecarActivationApprovalState;
  dryRunOnly: true;
  sourceOnlyNoLive: true;
  idempotencyKey: string;
  source: {
    gateState: TerminalBriefSidecarDryRunGatePacket["state"];
    gateIdempotencyKey: string;
    sourceCriteriaMet: boolean;
    alwaysOnDryRunCandidate: boolean;
    requiredRowsReady: number;
    requiredRows: number;
    sidecarDecision: string;
    finalizerStatus?: string;
  };
  requestDraft: {
    status: "draft_not_sent" | "not_ready";
    requestedAction: "approve_supervised_terminal_brief_sidecar_dry_run_start";
    requestedBy: string;
    operatorTarget: string;
    operatorChannel?: string;
    approvalExpiresAt?: string;
    dispatchRequired: boolean;
    dispatchPermitted: false;
    transcriptDraft: string;
  };
  activationPlan: {
    supervisedDryRunOnly: true;
    cursorPersisted: boolean;
    boundedPolling: boolean;
    pollIntervalMs?: number;
    maxBatch?: number;
    gatewayReady?: boolean;
    eventLoopDegraded?: boolean;
    queueBacklog?: number;
    abortQueueBacklog?: number;
    abortConditions: string[];
    rollbackInstructions: string[];
  };
  readiness: {
    approvalRequestDraftReady: boolean;
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
    approvalPacketVersion: 1;
    harnessNeutral: true;
    openclawMessageSendRequired: false;
    hermesAdapterCompatible: true;
    gongyungAdapterCompatible: true;
    consumesSidecarDryRunGate: true;
    producesApprovalRequestDraft: true;
    sendsApprovalRequest: false;
    grantsApproval: false;
    startsSidecar: false;
    enablesDefaultOn: false;
    executesAction: false;
  };
  semantics: {
    approvalRequestDraftOnly: true;
    sourceOnlyNoLive: true;
    requestDraftIsNotSend: true;
    approvalRequestIsNotApprovalGrant: true;
    sidecarStartRequiresSeparateApprovedExecutor: true;
    defaultOnNotEnabledByThisPacket: true;
    providerAcceptedIsVisibilityProof: false;
    terminalAckEligibleDoesNotPermitAck: true;
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

export function buildTerminalBriefSidecarActivationApproval(
  gate: TerminalBriefSidecarDryRunGatePacket,
  options: TerminalBriefSidecarActivationApprovalOptions = {},
): TerminalBriefSidecarActivationApprovalPacket {
  const generatedAt = options.now ?? new Date().toISOString();
  const requestedBy = optionalString(options.requestedBy ?? options.requested_by) ?? "broker-finalizer";
  const operatorTarget = optionalString(options.operatorTarget ?? options.operator_target) ?? "operator";
  const operatorChannel = optionalString(options.operatorChannel ?? options.operator_channel);
  const approvalExpiresAt = approvalExpiry(generatedAt, options);
  const blockers = buildBlockers(gate);
  const state = stateFor(gate, blockers);
  const approvalRequestDraftReady = state === "approval_request_draft_ready";
  const transcriptDraft = buildTranscriptDraft(gate, requestedBy, operatorTarget, approvalExpiresAt, approvalRequestDraftReady);
  return {
    kind: "a2a-broker.terminal-brief-sidecar-activation-approval.packet",
    version: 1,
    generatedAt,
    mode: options.mode ?? gate.mode,
    parentRoundId: gate.parentRoundId,
    state,
    dryRunOnly: true,
    sourceOnlyNoLive: true,
    idempotencyKey: buildApprovalIdempotencyKey(gate, generatedAt, requestedBy, operatorTarget, state),
    source: {
      gateState: gate.state,
      gateIdempotencyKey: gate.idempotencyKey,
      sourceCriteriaMet: gate.readiness.sourceCriteriaMet,
      alwaysOnDryRunCandidate: gate.readiness.alwaysOnDryRunCandidate,
      requiredRowsReady: gate.table.requiredRowsReady,
      requiredRows: gate.table.requiredRows,
      sidecarDecision: gate.source.sidecarDecision,
      finalizerStatus: gate.source.finalizerStatus,
    },
    requestDraft: {
      status: approvalRequestDraftReady ? "draft_not_sent" : "not_ready",
      requestedAction: "approve_supervised_terminal_brief_sidecar_dry_run_start",
      requestedBy,
      operatorTarget,
      operatorChannel,
      approvalExpiresAt,
      dispatchRequired: approvalRequestDraftReady,
      dispatchPermitted: false,
      transcriptDraft,
    },
    activationPlan: {
      supervisedDryRunOnly: true,
      cursorPersisted: gate.operatingEvidence.cursorPersisted,
      boundedPolling: gate.operatingEvidence.boundedPolling,
      pollIntervalMs: gate.operatingEvidence.pollIntervalMs,
      maxBatch: gate.operatingEvidence.maxBatch,
      gatewayReady: gate.operatingEvidence.gatewayReady,
      eventLoopDegraded: gate.operatingEvidence.eventLoopDegraded,
      queueBacklog: gate.operatingEvidence.queueBacklog,
      abortQueueBacklog: numberValue(options.abortQueueBacklog ?? options.abort_queue_backlog) ?? gate.operatingEvidence.queueBacklog,
      abortConditions: abortConditions(gate, options),
      rollbackInstructions: [
        "stop the supervised sidecar process before any default-on or live send change",
        "preserve cursor/spool evidence for broker review",
        "keep terminal ACK/replay disabled unless a separate approval path permits it",
      ],
    },
    readiness: {
      approvalRequestDraftReady,
      sidecarStartPermitted: false,
      defaultOnPermitted: false,
      liveActivationPermitted: false,
      approvalGrantPermitted: false,
      providerSendPermitted: false,
      terminalAckPermitted: false,
      executionPermitted: false,
      missingEvidence: gate.readiness.missingEvidence,
      blockers: [
        ...blockers,
        "approval request draft is not an approval grant",
        "sidecar start still requires a separate approved executor path",
      ],
      nextAction: approvalRequestDraftReady
        ? "dispatch this draft through the selected harness adapter and ingest explicit operator approval evidence before any sidecar start"
        : "resolve the sidecar dry-run gate before drafting an activation approval request",
    },
    blockers,
    nextActions: nextActionsFor(state),
    approvalSensitiveActionsExcluded: [
      "starting/enabling always-on sidecar",
      "Terminal Brief default-on enablement",
      "live provider/Hermes/Gongyung/Telegram/OpenClaw send",
      "terminal ACK/replay or terminal receipt DB mutation",
      "operator approval grant or approval evidence mutation",
      "GitHub PR merge, issue close, or comment post from the packet",
      "TaskFlow record creation or broker DB mutation",
      "production deploy/restart, historical replay, release, publish, or secret movement",
    ],
    integrationContract: {
      transport: "json",
      approvalPacketVersion: 1,
      harnessNeutral: true,
      openclawMessageSendRequired: false,
      hermesAdapterCompatible: true,
      gongyungAdapterCompatible: true,
      consumesSidecarDryRunGate: true,
      producesApprovalRequestDraft: true,
      sendsApprovalRequest: false,
      grantsApproval: false,
      startsSidecar: false,
      enablesDefaultOn: false,
      executesAction: false,
    },
    semantics: {
      approvalRequestDraftOnly: true,
      sourceOnlyNoLive: true,
      requestDraftIsNotSend: true,
      approvalRequestIsNotApprovalGrant: true,
      sidecarStartRequiresSeparateApprovedExecutor: true,
      defaultOnNotEnabledByThisPacket: true,
      providerAcceptedIsVisibilityProof: false,
      terminalAckEligibleDoesNotPermitAck: true,
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

export function extractTerminalBriefSidecarActivationApprovalGate(
  input: unknown,
): TerminalBriefSidecarDryRunGatePacket {
  const envelope = isRecord(input) ? input : {};
  const candidates = [
    input,
    envelope.sidecarDryRunGate,
    envelope.sidecarDryRunGatePacket,
    envelope.dryRunGate,
    envelope.gate,
    envelope.packet,
  ];
  const packet = candidates.find(isTerminalBriefSidecarDryRunGatePacket);
  if (!packet) {
    throw new Error("expected a Terminal Brief sidecar dry-run gate packet");
  }
  return packet;
}

export function extractTerminalBriefSidecarActivationApprovalOptions(
  input: unknown,
): TerminalBriefSidecarActivationApprovalOptions {
  const envelope = isRecord(input) ? input : {};
  const candidate = envelope.activationApproval
    ?? envelope.activationApprovalOptions
    ?? envelope.approvalRequest
    ?? envelope.requestOptions
    ?? envelope.options;
  return isRecord(candidate) ? candidate as TerminalBriefSidecarActivationApprovalOptions : {};
}

export function renderTerminalBriefSidecarActivationApprovalMarkdown(
  packet: TerminalBriefSidecarActivationApprovalPacket,
): string {
  return [
    titleForState(packet.state),
    "Mode: " + packet.mode,
    "Parent round: " + (packet.parentRoundId ?? "unknown"),
    "State: " + packet.state + " dryRunOnly=" + packet.dryRunOnly + " sourceOnlyNoLive=" + packet.sourceOnlyNoLive,
    "Idempotency: " + packet.idempotencyKey,
    "Gate: state=" + packet.source.gateState
      + " sourceCriteriaMet=" + packet.source.sourceCriteriaMet
      + " requiredRows=" + packet.source.requiredRowsReady + "/" + packet.source.requiredRows,
    "Request draft: status=" + packet.requestDraft.status
      + " requestedAction=" + packet.requestDraft.requestedAction
      + " dispatchPermitted=" + packet.requestDraft.dispatchPermitted,
    "",
    "Activation plan:",
    "- supervisedDryRunOnly=" + packet.activationPlan.supervisedDryRunOnly,
    "- cursorPersisted=" + packet.activationPlan.cursorPersisted
      + " boundedPolling=" + packet.activationPlan.boundedPolling
      + " pollIntervalMs=" + (packet.activationPlan.pollIntervalMs ?? "missing")
      + " maxBatch=" + (packet.activationPlan.maxBatch ?? "missing"),
    "- gatewayReady=" + (packet.activationPlan.gatewayReady ?? "missing")
      + " eventLoopDegraded=" + (packet.activationPlan.eventLoopDegraded ?? "missing")
      + " queueBacklog=" + (packet.activationPlan.queueBacklog ?? "missing"),
    "",
    "Readiness: approvalRequestDraftReady=" + packet.readiness.approvalRequestDraftReady
      + " sidecarStartPermitted=" + packet.readiness.sidecarStartPermitted
      + " defaultOnPermitted=" + packet.readiness.defaultOnPermitted
      + " providerSendPermitted=" + packet.readiness.providerSendPermitted
      + " terminalAckPermitted=" + packet.readiness.terminalAckPermitted,
    ...(packet.blockers.length ? ["", "Blockers:", ...packet.blockers.map((blocker) => "- " + blocker)] : []),
    "",
    "Next actions:",
    ...packet.nextActions.map((action) => "- " + action),
    "",
    "Safety: approval request draft only; does not send the request, grant approval, start sidecar, enable default-on, send providers, ACK/replay terminal rows, mutate GitHub/DB/TaskFlow state, restart/deploy, replay history, release, publish, or move secrets.",
  ].join("\n");
}

function buildBlockers(gate: TerminalBriefSidecarDryRunGatePacket): string[] {
  return unique([
    ...gate.blockers,
    ...(gate.state !== "ready_for_operator_approval" ? ["sidecar dry-run gate is " + gate.state] : []),
    ...(!gate.readiness.sourceCriteriaMet ? ["sidecar dry-run gate source criteria are not met"] : []),
    ...(!gate.readiness.alwaysOnDryRunCandidate ? ["sidecar dry-run gate is not an always-on dry-run candidate"] : []),
    ...(gate.readiness.alwaysOnDryRunStartPermitted !== false ? ["dry-run gate unexpectedly permits sidecar start"] : []),
    ...(gate.readiness.defaultOnPermitted !== false ? ["dry-run gate unexpectedly permits default-on"] : []),
    ...(gate.readiness.liveActivationPermitted !== false ? ["dry-run gate unexpectedly permits live activation"] : []),
    ...(gate.integrationContract.startsSidecar ? ["dry-run gate integration unexpectedly starts sidecar"] : []),
    ...(gate.integrationContract.enablesDefaultOn ? ["dry-run gate integration unexpectedly enables default-on"] : []),
    ...(gate.integrationContract.grantsApproval ? ["dry-run gate integration unexpectedly grants approval"] : []),
    ...(gate.integrationContract.executesAction ? ["dry-run gate integration unexpectedly executes action"] : []),
    ...(gate.semantics.performsProviderSend ? ["dry-run gate unexpectedly performs provider send"] : []),
    ...(gate.semantics.performsTerminalAck ? ["dry-run gate unexpectedly performs terminal ACK"] : []),
    ...(gate.semantics.performsRuntimeRestartOrDeploy ? ["dry-run gate unexpectedly performs restart/deploy"] : []),
    ...(gate.semantics.performsDbMutation ? ["dry-run gate unexpectedly performs DB mutation"] : []),
    ...(gate.semantics.performsHistoricalReplay ? ["dry-run gate unexpectedly performs historical replay"] : []),
    ...(gate.semantics.performsReleaseOrPublish ? ["dry-run gate unexpectedly performs release/publish"] : []),
    ...(gate.semantics.movesSecretsOrCredentials ? ["dry-run gate unexpectedly moves secrets/credentials"] : []),
  ].filter(Boolean));
}

function stateFor(
  gate: TerminalBriefSidecarDryRunGatePacket,
  blockers: string[],
): TerminalBriefSidecarActivationApprovalState {
  if (gate.state === "stale") return "stale";
  if (gate.state === "blocked" || hasUnsafeNoLiveViolation(gate)) return "blocked";
  if (gate.state !== "ready_for_operator_approval" || !gate.readiness.sourceCriteriaMet) return "waiting_for_gate";
  return blockers.length ? "blocked" : "approval_request_draft_ready";
}

function hasUnsafeNoLiveViolation(gate: TerminalBriefSidecarDryRunGatePacket): boolean {
  return gate.readiness.alwaysOnDryRunStartPermitted !== false
    || gate.readiness.defaultOnPermitted !== false
    || gate.readiness.liveActivationPermitted !== false
    || gate.integrationContract.startsSidecar
    || gate.integrationContract.enablesDefaultOn
    || gate.integrationContract.grantsApproval
    || gate.integrationContract.executesAction
    || gate.semantics.performsProviderSend
    || gate.semantics.performsTerminalAck
    || gate.semantics.performsRuntimeRestartOrDeploy
    || gate.semantics.performsDbMutation
    || gate.semantics.performsHistoricalReplay
    || gate.semantics.performsReleaseOrPublish
    || gate.semantics.movesSecretsOrCredentials;
}

function approvalExpiry(
  generatedAt: string,
  options: TerminalBriefSidecarActivationApprovalOptions,
): string | undefined {
  const minutes = numberValue(options.approvalWindowMinutes ?? options.approval_window_minutes);
  if (!minutes || minutes <= 0) return undefined;
  const generatedAtMs = Date.parse(generatedAt);
  if (!Number.isFinite(generatedAtMs)) return undefined;
  return new Date(generatedAtMs + minutes * 60_000).toISOString();
}

function buildTranscriptDraft(
  gate: TerminalBriefSidecarDryRunGatePacket,
  requestedBy: string,
  operatorTarget: string,
  approvalExpiresAt: string | undefined,
  ready: boolean,
): string {
  const lines = [
    "Request: approve supervised Terminal Brief sidecar dry-run start.",
    "Requester: " + requestedBy + ". Operator target: " + operatorTarget + ".",
    "Gate: " + gate.state + " rows " + gate.table.requiredRowsReady + "/" + gate.table.requiredRows + ".",
    "Plan: dry-run only, supervised sidecar, cursor persisted, bounded polling pollIntervalMs="
      + (gate.operatingEvidence.pollIntervalMs ?? "missing")
      + ", maxBatch=" + (gate.operatingEvidence.maxBatch ?? "missing") + ".",
    "Safety: no default-on, no live provider send, no terminal ACK/replay, no deploy/restart, no DB mutation.",
  ];
  if (approvalExpiresAt) lines.push("Approval draft expires at " + approvalExpiresAt + ".");
  if (!ready) lines.push("This draft is not ready until the sidecar dry-run gate is ready.");
  return lines.join("\n");
}

function abortConditions(
  gate: TerminalBriefSidecarDryRunGatePacket,
  options: TerminalBriefSidecarActivationApprovalOptions,
): string[] {
  const queueLimit = numberValue(options.abortQueueBacklog ?? options.abort_queue_backlog);
  return [
    "Gateway readiness is false or unavailable",
    "Gateway event loop is degraded",
    "queue backlog exceeds " + (queueLimit ?? gate.operatingEvidence.queueBacklog ?? "configured limit"),
    "sidecar dry-run-only mode is false",
    "cross-broker operatorEvents becomes enabled",
    "cursor persistence or bounded polling evidence disappears",
    "provider send or terminal ACK/replay is attempted by this path",
  ];
}

function nextActionsFor(state: TerminalBriefSidecarActivationApprovalState): string[] {
  if (state === "approval_request_draft_ready") {
    return [
      "broker finalizer may dispatch this approval request draft through a selected adapter",
      "ingest explicit operator approval evidence before any supervised sidecar dry-run start executor is allowed",
      "keep default-on/live send/terminal ACK/deploy/DB mutation behind separate approval gates",
    ];
  }
  if (state === "waiting_for_gate") {
    return [
      "resolve the sidecar dry-run operating gate first",
      "do not ask for sidecar activation approval from incomplete gate evidence",
    ];
  }
  if (state === "stale") {
    return [
      "refresh operating evidence and regenerate the sidecar dry-run gate",
      "do not request activation approval from stale Gateway/event-loop evidence",
    ];
  }
  return [
    "resolve blocked/unsafe gate evidence before drafting activation approval",
    "do not start sidecar, send providers, ACK terminal rows, or mutate state from a blocked packet",
  ];
}

function buildApprovalIdempotencyKey(
  gate: TerminalBriefSidecarDryRunGatePacket,
  generatedAt: string,
  requestedBy: string,
  operatorTarget: string,
  state: TerminalBriefSidecarActivationApprovalState,
): string {
  const base = JSON.stringify({
    label: "terminal-brief-sidecar-activation-approval",
    parentRoundId: gate.parentRoundId ?? "unknown",
    gateIdempotencyKey: gate.idempotencyKey,
    requestedBy,
    operatorTarget,
    generatedAt,
    state,
  });
  return "tb-sidecar-activation-approval:" + createHash("sha256").update(base).digest("hex").slice(0, 24);
}

function titleForState(state: TerminalBriefSidecarActivationApprovalState): string {
  if (state === "approval_request_draft_ready") return "Ready: Terminal Brief sidecar activation approval request draft";
  if (state === "waiting_for_gate") return "Waiting: Terminal Brief sidecar dry-run gate";
  if (state === "stale") return "Stale: Terminal Brief sidecar activation approval source";
  return "Blocked: Terminal Brief sidecar activation approval request draft";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function isTerminalBriefSidecarDryRunGatePacket(value: unknown): value is TerminalBriefSidecarDryRunGatePacket {
  return isRecord(value) && value.kind === "a2a-broker.terminal-brief-sidecar-dry-run-gate.packet";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
