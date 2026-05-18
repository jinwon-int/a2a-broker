import { createHash } from "node:crypto";

import type { TerminalBriefSidecarPreflightChainReviewPacket } from "./terminal-brief-sidecar-preflight-chain-review.js";

export type TerminalBriefSidecarDryRunStartApprovalRequestState =
  | "approval_request_draft_ready"
  | "waiting_for_chain_review"
  | "stale"
  | "degraded"
  | "conflicting"
  | "blocked";

export interface TerminalBriefSidecarDryRunStartApprovalRequestOptions {
  now?: string;
  mode?: string;
  requestedAction?: string;
  requested_action?: string;
  requestedBy?: string;
  requested_by?: string;
  operatorTarget?: string;
  operator_target?: string;
  operatorChannel?: string;
  operator_channel?: string;
  approvalWindowMinutes?: number;
  approval_window_minutes?: number;
  approvalReference?: string;
  approval_reference?: string;
  finalizer?: string;
  finalizer_id?: string;
}

export interface TerminalBriefSidecarDryRunStartApprovalRequestPacket {
  kind: "a2a-broker.terminal-brief-sidecar-dry-run-start-approval-request.packet";
  version: 1;
  generatedAt: string;
  mode: string;
  parentRoundId?: string;
  state: TerminalBriefSidecarDryRunStartApprovalRequestState;
  dryRunOnly: true;
  sourceOnlyNoLive: true;
  idempotencyKey: string;
  source: {
    preflightChainReviewState: TerminalBriefSidecarPreflightChainReviewPacket["state"];
    preflightChainReviewIdempotencyKey: string;
    sourceCriteriaMet: boolean;
    chainReviewReady: boolean;
    requiredRowsReady: number;
    requiredRows: number;
    preflightCollectorState: TerminalBriefSidecarPreflightChainReviewPacket["source"]["preflightCollectorState"];
    preflightCollectorIdempotencyKey: string;
    dryRunStartCanaryPlanState: TerminalBriefSidecarPreflightChainReviewPacket["source"]["dryRunStartCanaryPlanState"];
    dryRunStartCanaryPlanIdempotencyKey: string;
    executorName: string;
    adapterName: string;
    finalizer: string;
  };
  approvalRequestDraft: {
    draftOnly: true;
    status: "draft_not_sent" | "not_ready";
    requestedAction: string;
    requestedBy: string;
    operatorTarget: string;
    operatorChannel?: string;
    approvalReference?: string;
    approvalExpiresAt?: string;
    dispatchRequired: boolean;
    dispatchPermitted: false;
    approvalGrantPermitted: false;
    executionPermitted: false;
    transcriptDraft: string;
  };
  supervisedDryRunBoundary: {
    planOnly: true;
    sourcePacketIds: string[];
    finalizerRequired: true;
    separateOperatorApprovalRequired: true;
    separateExecutorRequired: true;
    defaultOnCandidate: false;
    approvalCanBeRequestedBy: string;
    approvalCanBeDeliveredBy: Array<"openclaw" | "hermes" | "gongyung" | "external">;
    mustNotTreatProviderAcceptedAsVisibilityProof: true;
    forbiddenBeforeSeparateApproval: string[];
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
    approvalRequestVersion: 1;
    harnessNeutral: true;
    openclawMessageSendRequired: false;
    hermesAdapterCompatible: true;
    gongyungAdapterCompatible: true;
    consumesPreflightChainReviewPacket: true;
    producesApprovalRequestDraft: true;
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
    approvalRequestDraftOnly: true;
    sourceOnlyNoLive: true;
    requestDraftIsNotSend: true;
    approvalRequestIsNotApprovalGrant: true;
    dryRunStartRequiresSeparateApproval: true;
    dryRunStartRequiresSeparateExecutor: true;
    preflightChainReviewDoesNotPermitStart: true;
    defaultOnRequiresSeparateApprovalAfterObservation: true;
    providerAcceptedIsVisibilityProof: false;
    terminalAckEligibleDoesNotPermitAck: true;
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

export function buildTerminalBriefSidecarDryRunStartApprovalRequest(
  chainReview: TerminalBriefSidecarPreflightChainReviewPacket,
  options: TerminalBriefSidecarDryRunStartApprovalRequestOptions = {},
): TerminalBriefSidecarDryRunStartApprovalRequestPacket {
  const generatedAt = options.now ?? new Date().toISOString();
  const requestedBy = optionalString(options.requestedBy ?? options.requested_by)
    ?? optionalString(options.finalizer ?? options.finalizer_id)
    ?? chainReview.source.finalizer
    ?? "broker-finalizer";
  const operatorTarget = optionalString(options.operatorTarget ?? options.operator_target)
    ?? chainReview.source.operatorTarget
    ?? "operator";
  const operatorChannel = optionalString(options.operatorChannel ?? options.operator_channel);
  const requestedAction = optionalString(options.requestedAction ?? options.requested_action)
    ?? "approve_supervised_terminal_brief_sidecar_dry_run_start";
  const approvalReference = optionalString(options.approvalReference ?? options.approval_reference);
  const approvalExpiresAt = approvalExpiry(generatedAt, options);
  const blockers = buildBlockers(chainReview);
  const state = stateFor(chainReview, blockers);
  const approvalRequestDraftReady = state === "approval_request_draft_ready";
  const sourceCriteriaMet = approvalRequestDraftReady && blockers.length === 0;
  const transcriptDraft = buildTranscriptDraft(
    chainReview,
    requestedAction,
    requestedBy,
    operatorTarget,
    approvalReference,
    approvalExpiresAt,
    approvalRequestDraftReady,
  );
  return {
    kind: "a2a-broker.terminal-brief-sidecar-dry-run-start-approval-request.packet",
    version: 1,
    generatedAt,
    mode: options.mode ?? chainReview.mode,
    parentRoundId: chainReview.parentRoundId,
    state,
    dryRunOnly: true,
    sourceOnlyNoLive: true,
    idempotencyKey: buildApprovalRequestIdempotencyKey(
      chainReview,
      generatedAt,
      requestedAction,
      requestedBy,
      operatorTarget,
      state,
    ),
    source: {
      preflightChainReviewState: chainReview.state,
      preflightChainReviewIdempotencyKey: chainReview.idempotencyKey,
      sourceCriteriaMet: chainReview.readiness.sourceCriteriaMet,
      chainReviewReady: chainReview.readiness.chainReviewReady,
      requiredRowsReady: chainReview.table.requiredRowsReady,
      requiredRows: chainReview.table.requiredRows,
      preflightCollectorState: chainReview.source.preflightCollectorState,
      preflightCollectorIdempotencyKey: chainReview.source.preflightCollectorIdempotencyKey,
      dryRunStartCanaryPlanState: chainReview.source.dryRunStartCanaryPlanState,
      dryRunStartCanaryPlanIdempotencyKey: chainReview.source.dryRunStartCanaryPlanIdempotencyKey,
      executorName: chainReview.source.executorName,
      adapterName: chainReview.source.adapterName,
      finalizer: requestedBy,
    },
    approvalRequestDraft: {
      draftOnly: true,
      status: approvalRequestDraftReady ? "draft_not_sent" : "not_ready",
      requestedAction,
      requestedBy,
      operatorTarget,
      operatorChannel,
      approvalReference,
      approvalExpiresAt,
      dispatchRequired: approvalRequestDraftReady,
      dispatchPermitted: false,
      approvalGrantPermitted: false,
      executionPermitted: false,
      transcriptDraft,
    },
    supervisedDryRunBoundary: {
      planOnly: true,
      sourcePacketIds: [
        chainReview.source.dryRunStartCanaryPlanIdempotencyKey,
        chainReview.source.preflightCollectorIdempotencyKey,
        chainReview.idempotencyKey,
      ],
      finalizerRequired: true,
      separateOperatorApprovalRequired: true,
      separateExecutorRequired: true,
      defaultOnCandidate: false,
      approvalCanBeRequestedBy: requestedBy,
      approvalCanBeDeliveredBy: ["openclaw", "hermes", "gongyung", "external"],
      mustNotTreatProviderAcceptedAsVisibilityProof: true,
      forbiddenBeforeSeparateApproval: forbiddenBeforeSeparateApproval(),
    },
    readiness: {
      sourceCriteriaMet,
      approvalRequestDraftReady,
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
      missingEvidence: missingEvidenceFor(chainReview),
      blockers: [
        ...blockers,
        "approval request draft is not a dispatch, approval grant, or runtime executor",
        "supervised dry-run start requires a separate explicit operator approval and executor path",
        "provider accepted evidence is not visibility proof or terminal ACK",
      ],
      nextAction: approvalRequestDraftReady
        ? "broker finalizer may send this draft through a chosen adapter, then ingest explicit approval evidence before any executor dispatch"
        : "resolve the preflight chain review before drafting supervised dry-run start approval",
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
      approvalRequestVersion: 1,
      harnessNeutral: true,
      openclawMessageSendRequired: false,
      hermesAdapterCompatible: true,
      gongyungAdapterCompatible: true,
      consumesPreflightChainReviewPacket: true,
      producesApprovalRequestDraft: true,
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
      approvalRequestDraftOnly: true,
      sourceOnlyNoLive: true,
      requestDraftIsNotSend: true,
      approvalRequestIsNotApprovalGrant: true,
      dryRunStartRequiresSeparateApproval: true,
      dryRunStartRequiresSeparateExecutor: true,
      preflightChainReviewDoesNotPermitStart: true,
      defaultOnRequiresSeparateApprovalAfterObservation: true,
      providerAcceptedIsVisibilityProof: false,
      terminalAckEligibleDoesNotPermitAck: true,
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

export function extractTerminalBriefSidecarDryRunStartApprovalRequestChainReview(
  input: unknown,
): TerminalBriefSidecarPreflightChainReviewPacket {
  const envelope = isRecord(input) ? input : {};
  const candidates = [
    input,
    envelope.preflightChainReviewPacket,
    envelope.preflightChainReview,
    envelope.sidecarPreflightChainReviewPacket,
    envelope.sidecarPreflightChainReview,
    envelope.chainReview,
    envelope.packet,
  ];
  const packet = candidates.find(isTerminalBriefSidecarPreflightChainReviewPacket);
  if (!packet) {
    throw new Error("expected a Terminal Brief sidecar preflight chain review packet");
  }
  return packet;
}

export function extractTerminalBriefSidecarDryRunStartApprovalRequestOptions(
  input: unknown,
): TerminalBriefSidecarDryRunStartApprovalRequestOptions {
  const envelope = isRecord(input) ? input : {};
  const candidate = envelope.dryRunStartApprovalRequest
    ?? envelope.dryRunStartApprovalRequestOptions
    ?? envelope.startApprovalRequest
    ?? envelope.approvalRequest
    ?? envelope.options;
  return isRecord(candidate) ? candidate as TerminalBriefSidecarDryRunStartApprovalRequestOptions : {};
}

export function renderTerminalBriefSidecarDryRunStartApprovalRequestMarkdown(
  packet: TerminalBriefSidecarDryRunStartApprovalRequestPacket,
): string {
  return [
    titleForState(packet.state),
    "Mode: " + packet.mode,
    "Parent round: " + (packet.parentRoundId ?? "unknown"),
    "State: " + packet.state + " dryRunOnly=" + packet.dryRunOnly + " sourceOnlyNoLive=" + packet.sourceOnlyNoLive,
    "Idempotency: " + packet.idempotencyKey,
    "Source chain review: state=" + packet.source.preflightChainReviewState
      + " sourceCriteriaMet=" + packet.source.sourceCriteriaMet
      + " chainReviewReady=" + packet.source.chainReviewReady
      + " rows=" + packet.source.requiredRowsReady + "/" + packet.source.requiredRows,
    "Executor: " + packet.source.executorName + " via " + packet.source.adapterName,
    "Request draft: status=" + packet.approvalRequestDraft.status
      + " requestedAction=" + packet.approvalRequestDraft.requestedAction
      + " dispatchPermitted=" + packet.approvalRequestDraft.dispatchPermitted
      + " approvalGrantPermitted=" + packet.approvalRequestDraft.approvalGrantPermitted
      + " executionPermitted=" + packet.approvalRequestDraft.executionPermitted,
    "",
    "Boundary: separateOperatorApprovalRequired=" + packet.supervisedDryRunBoundary.separateOperatorApprovalRequired
      + " separateExecutorRequired=" + packet.supervisedDryRunBoundary.separateExecutorRequired
      + " defaultOnCandidate=" + packet.supervisedDryRunBoundary.defaultOnCandidate,
    "Adapters: " + packet.supervisedDryRunBoundary.approvalCanBeDeliveredBy.join(", "),
    "",
    "Readiness: sourceCriteriaMet=" + packet.readiness.sourceCriteriaMet
      + " approvalRequestDraftReady=" + packet.readiness.approvalRequestDraftReady
      + " approvalRequestDispatchPermitted=" + packet.readiness.approvalRequestDispatchPermitted
      + " startExecutorDispatchPermitted=" + packet.readiness.startExecutorDispatchPermitted
      + " executorInvocationPermitted=" + packet.readiness.executorInvocationPermitted
      + " sidecarStartPermitted=" + packet.readiness.sidecarStartPermitted
      + " defaultOnPermitted=" + packet.readiness.defaultOnPermitted
      + " terminalAckPermitted=" + packet.readiness.terminalAckPermitted
      + " dbMutationPermitted=" + packet.readiness.dbMutationPermitted,
    ...(packet.blockers.length ? ["", "Blockers:", ...packet.blockers.map((blocker) => "- " + blocker)] : []),
    "",
    "Next actions:",
    ...packet.nextActions.map((action) => "- " + action),
    "",
    "Safety: approval request draft only; does not send approval request, grant approval, dispatch/invoke executor, spawn a process, start sidecar, enable default-on, send providers, ACK/replay terminal rows, mutate GitHub/DB/TaskFlow state, restart/deploy, replay history, release, publish, or move secrets.",
  ].join("\n");
}

function buildBlockers(chainReview: TerminalBriefSidecarPreflightChainReviewPacket): string[] {
  return unique([
    ...chainReview.blockers,
    ...(chainReview.state !== "ready_for_supervised_dry_run_chain_review" ? ["preflight chain review is " + chainReview.state] : []),
    ...(!chainReview.readiness.sourceCriteriaMet ? ["preflight chain review source criteria are not met"] : []),
    ...(!chainReview.readiness.chainReviewReady ? ["preflight chain review is not ready"] : []),
    ...(chainReview.table.requiredRowsReady !== chainReview.table.requiredRows ? ["preflight chain required rows are incomplete"] : []),
    ...(chainReview.integrationContract.openclawMessageSendRequired ? ["chain review unexpectedly requires OpenClaw message send"] : []),
    ...(!chainReview.integrationContract.hermesAdapterCompatible ? ["chain review is not Hermes adapter compatible"] : []),
    ...(!chainReview.integrationContract.gongyungAdapterCompatible ? ["chain review is not Gongyung adapter compatible"] : []),
    ...(hasUnsafeNoLiveViolation(chainReview) ? ["preflight chain review contains unsafe live-action permission or semantic flag"] : []),
  ].filter(Boolean));
}

function stateFor(
  chainReview: TerminalBriefSidecarPreflightChainReviewPacket,
  blockers: string[],
): TerminalBriefSidecarDryRunStartApprovalRequestState {
  if (chainReview.state === "stale") return "stale";
  if (chainReview.state === "degraded") return "degraded";
  if (chainReview.state === "conflicting") return "conflicting";
  if (chainReview.state === "blocked" || hasUnsafeNoLiveViolation(chainReview)) return "blocked";
  if (chainReview.state !== "ready_for_supervised_dry_run_chain_review" || !chainReview.readiness.chainReviewReady) {
    return "waiting_for_chain_review";
  }
  return blockers.length ? "blocked" : "approval_request_draft_ready";
}

function hasUnsafeNoLiveViolation(chainReview: TerminalBriefSidecarPreflightChainReviewPacket): boolean {
  return chainReview.readiness.approvalRequestDispatchPermitted !== false
    || chainReview.readiness.approvalGrantPermitted !== false
    || chainReview.readiness.startExecutorDispatchPermitted !== false
    || chainReview.readiness.executorInvocationPermitted !== false
    || chainReview.readiness.processSpawnPermitted !== false
    || chainReview.readiness.sidecarStartPermitted !== false
    || chainReview.readiness.defaultOnPermitted !== false
    || chainReview.readiness.liveActivationPermitted !== false
    || chainReview.readiness.providerSendPermitted !== false
    || chainReview.readiness.terminalAckPermitted !== false
    || chainReview.readiness.dbMutationPermitted !== false
    || chainReview.readiness.executionPermitted !== false
    || chainReview.integrationContract.collectsLiveEvidence !== false
    || chainReview.integrationContract.probesGateway !== false
    || chainReview.integrationContract.sendsApprovalRequest !== false
    || chainReview.integrationContract.grantsApproval !== false
    || chainReview.integrationContract.dispatchesStartExecutor !== false
    || chainReview.integrationContract.invokesExecutor !== false
    || chainReview.integrationContract.spawnsProcess !== false
    || chainReview.integrationContract.startsSidecar !== false
    || chainReview.integrationContract.enablesDefaultOn !== false
    || chainReview.integrationContract.executesAction !== false
    || chainReview.semantics.performsProviderSend !== false
    || chainReview.semantics.performsTerminalAck !== false
    || chainReview.semantics.performsRuntimeRestartOrDeploy !== false
    || chainReview.semantics.performsDbMutation !== false
    || chainReview.semantics.performsHistoricalReplay !== false
    || chainReview.semantics.performsReleaseOrPublish !== false
    || chainReview.semantics.movesSecretsOrCredentials !== false;
}

function missingEvidenceFor(chainReview: TerminalBriefSidecarPreflightChainReviewPacket): string[] {
  const missing: string[] = [];
  if (chainReview.state !== "ready_for_supervised_dry_run_chain_review") missing.push("ready_preflight_chain_review");
  if (!chainReview.readiness.sourceCriteriaMet) missing.push("source_criteria");
  if (!chainReview.readiness.chainReviewReady) missing.push("chain_review_ready");
  if (chainReview.table.requiredRowsReady !== chainReview.table.requiredRows) missing.push("required_rows");
  return missing;
}

function approvalExpiry(
  generatedAt: string,
  options: TerminalBriefSidecarDryRunStartApprovalRequestOptions,
): string | undefined {
  const minutes = numberValue(options.approvalWindowMinutes ?? options.approval_window_minutes);
  if (!minutes || minutes <= 0) return undefined;
  const generatedAtMs = Date.parse(generatedAt);
  if (!Number.isFinite(generatedAtMs)) return undefined;
  return new Date(generatedAtMs + minutes * 60_000).toISOString();
}

function buildTranscriptDraft(
  chainReview: TerminalBriefSidecarPreflightChainReviewPacket,
  requestedAction: string,
  requestedBy: string,
  operatorTarget: string,
  approvalReference: string | undefined,
  approvalExpiresAt: string | undefined,
  ready: boolean,
): string {
  const lines = [
    "Request: " + requestedAction + ".",
    "Requester: " + requestedBy + ". Operator target: " + operatorTarget + ".",
    "Source: preflight chain review " + chainReview.state + " rows "
      + chainReview.table.requiredRowsReady + "/" + chainReview.table.requiredRows + ".",
    "Executor boundary: " + chainReview.source.executorName + " via " + chainReview.source.adapterName
      + " remains separate and approval-gated.",
    "Safety: draft only; no approval dispatch/grant, no executor invocation, no process spawn, no sidecar start, no default-on, no provider send, no terminal ACK/replay, no DB mutation.",
  ];
  if (approvalReference) lines.push("Approval reference: " + approvalReference + ".");
  if (approvalExpiresAt) lines.push("Approval draft expires at " + approvalExpiresAt + ".");
  if (!ready) lines.push("This draft is not ready until the preflight chain review is ready.");
  return lines.join("\n");
}

function forbiddenBeforeSeparateApproval(): string[] {
  return [
    "send or post this approval request through any provider",
    "grant approval or treat this draft as approval evidence",
    "dispatch or invoke the start executor",
    "spawn a process or start/stop the sidecar",
    "enable Terminal Brief default-on",
    "send via Telegram/OpenClaw/Hermes/Gongyung/provider",
    "ACK/replay terminal rows or mutate terminal receipt state",
    "mutate broker DB, TaskFlow, GitHub issue/PR state, or outbox history",
    "restart/deploy production services",
    "release, publish, tag, or move secrets",
  ];
}

function nextActionsFor(state: TerminalBriefSidecarDryRunStartApprovalRequestState): string[] {
  if (state === "approval_request_draft_ready") {
    return [
      "broker finalizer may choose an adapter to send this draft as a separate approval request",
      "ingest explicit operator approval evidence before any start executor dispatch or sidecar dry-run start",
      "keep default-on/live send/terminal ACK/deploy/DB mutation behind later separate approval gates",
    ];
  }
  if (state === "waiting_for_chain_review") {
    return [
      "complete the preflight chain review first",
      "do not request supervised dry-run start approval from incomplete chain evidence",
    ];
  }
  if (state === "stale") {
    return [
      "refresh preflight evidence and chain review before approval drafting",
      "do not request approval from stale Gateway/event-loop/queue evidence",
    ];
  }
  if (state === "degraded") {
    return [
      "clear degraded Gateway/queue/liveness evidence before approval drafting",
      "rerun the source collector and chain review after degraded evidence clears",
    ];
  }
  if (state === "conflicting") {
    return [
      "resolve conflicting preflight chain evidence first",
      "rerun the source chain review with one coherent evidence set",
    ];
  }
  return [
    "resolve blocked/unsafe chain evidence before approval drafting",
    "do not send approvals, dispatch executor, spawn processes, start sidecar, send providers, ACK terminal rows, or mutate state from a blocked packet",
  ];
}

function buildApprovalRequestIdempotencyKey(
  chainReview: TerminalBriefSidecarPreflightChainReviewPacket,
  generatedAt: string,
  requestedAction: string,
  requestedBy: string,
  operatorTarget: string,
  state: TerminalBriefSidecarDryRunStartApprovalRequestState,
): string {
  const base = JSON.stringify({
    label: "terminal-brief-sidecar-dry-run-start-approval-request",
    parentRoundId: chainReview.parentRoundId ?? "unknown",
    chainReview: chainReview.idempotencyKey,
    requestedAction,
    requestedBy,
    operatorTarget,
    generatedAt,
    state,
  });
  return "tb-sidecar-dry-run-start-approval-request:" + createHash("sha256").update(base).digest("hex").slice(0, 24);
}

function titleForState(state: TerminalBriefSidecarDryRunStartApprovalRequestState): string {
  if (state === "approval_request_draft_ready") return "Ready: Terminal Brief sidecar supervised dry-run start approval request";
  if (state === "waiting_for_chain_review") return "Waiting: Terminal Brief sidecar preflight chain review";
  if (state === "stale") return "Stale: Terminal Brief sidecar supervised dry-run start approval source";
  if (state === "degraded") return "Degraded: Terminal Brief sidecar supervised dry-run start approval source";
  if (state === "conflicting") return "Conflicting: Terminal Brief sidecar supervised dry-run start approval source";
  return "Blocked: Terminal Brief sidecar supervised dry-run start approval request";
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

function isTerminalBriefSidecarPreflightChainReviewPacket(
  value: unknown,
): value is TerminalBriefSidecarPreflightChainReviewPacket {
  return isRecord(value) && value.kind === "a2a-broker.terminal-brief-sidecar-preflight-chain-review.packet";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
