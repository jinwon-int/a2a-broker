import { createHash } from "node:crypto";

import type { TerminalBriefSidecarPreflightEvidenceCollectorPacket } from "./terminal-brief-sidecar-preflight-evidence-collector.js";

export type TerminalBriefSidecarPreflightChainReviewState =
  | "ready_for_supervised_dry_run_chain_review"
  | "waiting_for_preflight_review"
  | "stale"
  | "degraded"
  | "conflicting"
  | "blocked";

export type TerminalBriefSidecarPreflightChainReviewRowName =
  | "preflight_collector"
  | "source_canary_plan"
  | "evidence_table"
  | "harness_contract"
  | "approval_boundary"
  | "runtime_boundary"
  | "finalizer_boundary";

export interface TerminalBriefSidecarPreflightChainReviewOptions {
  now?: string;
  mode?: string;
  finalizer?: string;
  finalizer_id?: string;
}

export interface TerminalBriefSidecarPreflightChainReviewRow {
  name: TerminalBriefSidecarPreflightChainReviewRowName;
  label: string;
  state: string;
  required: boolean;
  ready: boolean;
  detail: string;
  blockers: string[];
  nextAction: string;
}

export interface TerminalBriefSidecarPreflightChainReviewPacket {
  kind: "a2a-broker.terminal-brief-sidecar-preflight-chain-review.packet";
  version: 1;
  generatedAt: string;
  mode: string;
  parentRoundId?: string;
  state: TerminalBriefSidecarPreflightChainReviewState;
  dryRunOnly: true;
  sourceOnlyNoLive: true;
  idempotencyKey: string;
  source: {
    preflightCollectorState: TerminalBriefSidecarPreflightEvidenceCollectorPacket["state"];
    preflightCollectorIdempotencyKey: string;
    dryRunStartCanaryPlanState: TerminalBriefSidecarPreflightEvidenceCollectorPacket["source"]["dryRunStartCanaryPlanState"];
    dryRunStartCanaryPlanIdempotencyKey: string;
    requestedAction: string;
    operatorTarget: string;
    executorName: string;
    adapterName: string;
    finalizer: string;
  };
  chain: {
    readyPacketIds: string[];
    sourceRowsReady: number;
    sourceRowsRequired: number;
    collectorRequiredRowsReady: number;
    collectorRequiredRows: number;
    collectorMissingEvidence: string[];
  };
  table: {
    rows: TerminalBriefSidecarPreflightChainReviewRow[];
    requiredRowsReady: number;
    requiredRows: number;
    readyRows: number;
    totalRows: number;
  };
  readiness: {
    sourceCriteriaMet: boolean;
    chainReviewReady: boolean;
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
    chainReviewVersion: 1;
    harnessNeutral: true;
    openclawMessageSendRequired: false;
    hermesAdapterCompatible: true;
    gongyungAdapterCompatible: true;
    consumesPreflightEvidenceCollectorPacket: true;
    collectsLiveEvidence: false;
    probesGateway: false;
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
    preflightChainReviewOnly: true;
    sourceOnlyNoLive: true;
    suppliedPacketOnly: true;
    chainReviewDoesNotMutateState: true;
    routeIsReadOnly: true;
    brokerFinalizerRequired: true;
    dryRunStartRequiresSeparateApproval: true;
    providerAcceptedIsVisibilityProof: false;
    terminalAckEligibleDoesNotPermitAck: true;
    executionNotPermitted: true;
    processSpawnNotPermitted: true;
    sidecarStartNotPermitted: true;
    defaultOnNotEnabledByThisPacket: true;
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

export function buildTerminalBriefSidecarPreflightChainReview(
  collector: TerminalBriefSidecarPreflightEvidenceCollectorPacket,
  options: TerminalBriefSidecarPreflightChainReviewOptions = {},
): TerminalBriefSidecarPreflightChainReviewPacket {
  const generatedAt = options.now ?? new Date().toISOString();
  const rows = buildRows(collector);
  const blockers = buildBlockers(collector, rows);
  const state = stateFor(collector, rows, blockers);
  const readiness = buildReadiness(state, rows, blockers);
  return {
    kind: "a2a-broker.terminal-brief-sidecar-preflight-chain-review.packet",
    version: 1,
    generatedAt,
    mode: options.mode ?? collector.mode,
    parentRoundId: collector.parentRoundId,
    state,
    dryRunOnly: true,
    sourceOnlyNoLive: true,
    idempotencyKey: buildChainReviewIdempotencyKey(collector, state, options),
    source: {
      preflightCollectorState: collector.state,
      preflightCollectorIdempotencyKey: collector.idempotencyKey,
      dryRunStartCanaryPlanState: collector.source.dryRunStartCanaryPlanState,
      dryRunStartCanaryPlanIdempotencyKey: collector.source.dryRunStartCanaryPlanIdempotencyKey,
      requestedAction: collector.source.requestedAction,
      operatorTarget: collector.source.operatorTarget,
      executorName: collector.source.executorName,
      adapterName: collector.source.adapterName,
      finalizer: optionalString(options.finalizer ?? options.finalizer_id) ?? "broker-finalizer",
    },
    chain: {
      readyPacketIds: [
        collector.source.dryRunStartCanaryPlanIdempotencyKey,
        collector.idempotencyKey,
      ],
      sourceRowsReady: rows.filter((row) => row.required && row.ready).length,
      sourceRowsRequired: rows.filter((row) => row.required).length,
      collectorRequiredRowsReady: collector.table.requiredRowsReady,
      collectorRequiredRows: collector.table.requiredRows,
      collectorMissingEvidence: collector.readiness.missingEvidence,
    },
    table: {
      rows,
      requiredRowsReady: rows.filter((row) => row.required && row.ready).length,
      requiredRows: rows.filter((row) => row.required).length,
      readyRows: rows.filter((row) => row.ready).length,
      totalRows: rows.length,
    },
    readiness,
    blockers,
    nextActions: nextActionsFor(state),
    approvalSensitiveActionsExcluded: [
      "dispatching any operator approval request",
      "granting approval or executing approval grants",
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
      chainReviewVersion: 1,
      harnessNeutral: true,
      openclawMessageSendRequired: false,
      hermesAdapterCompatible: true,
      gongyungAdapterCompatible: true,
      consumesPreflightEvidenceCollectorPacket: true,
      collectsLiveEvidence: false,
      probesGateway: false,
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
      preflightChainReviewOnly: true,
      sourceOnlyNoLive: true,
      suppliedPacketOnly: true,
      chainReviewDoesNotMutateState: true,
      routeIsReadOnly: true,
      brokerFinalizerRequired: true,
      dryRunStartRequiresSeparateApproval: true,
      providerAcceptedIsVisibilityProof: false,
      terminalAckEligibleDoesNotPermitAck: true,
      executionNotPermitted: true,
      processSpawnNotPermitted: true,
      sidecarStartNotPermitted: true,
      defaultOnNotEnabledByThisPacket: true,
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

export function extractTerminalBriefSidecarPreflightChainReviewCollector(
  input: unknown,
): TerminalBriefSidecarPreflightEvidenceCollectorPacket {
  const envelope = isRecord(input) ? input : {};
  const candidates = [
    input,
    envelope.preflightEvidenceCollectorPacket,
    envelope.preflightEvidenceCollector,
    envelope.sidecarPreflightEvidenceCollectorPacket,
    envelope.collector,
    envelope.packet,
  ];
  const packet = candidates.find(isTerminalBriefSidecarPreflightEvidenceCollectorPacket);
  if (!packet) {
    throw new Error("expected a Terminal Brief sidecar preflight evidence collector packet");
  }
  return packet;
}

export function extractTerminalBriefSidecarPreflightChainReviewOptions(
  input: unknown,
): TerminalBriefSidecarPreflightChainReviewOptions {
  const envelope = isRecord(input) ? input : {};
  const candidate = envelope.preflightChainReview
    ?? envelope.preflight_chain_review
    ?? envelope.preflightChainReviewOptions
    ?? envelope.options;
  return isRecord(candidate) ? candidate as TerminalBriefSidecarPreflightChainReviewOptions : {};
}

export function renderTerminalBriefSidecarPreflightChainReviewMarkdown(
  packet: TerminalBriefSidecarPreflightChainReviewPacket,
): string {
  return [
    titleForState(packet.state),
    "Mode: " + packet.mode,
    "Parent round: " + (packet.parentRoundId ?? "unknown"),
    "State: " + packet.state + " dryRunOnly=" + packet.dryRunOnly + " sourceOnlyNoLive=" + packet.sourceOnlyNoLive,
    "Idempotency: " + packet.idempotencyKey,
    "Source collector: state=" + packet.source.preflightCollectorState
      + " collector=" + packet.source.preflightCollectorIdempotencyKey
      + " canaryPlan=" + packet.source.dryRunStartCanaryPlanIdempotencyKey,
    "Executor: " + packet.source.executorName + " via " + packet.source.adapterName,
    "Chain rows: " + packet.table.requiredRowsReady + "/" + packet.table.requiredRows + " required ready",
    "",
    "Rows:",
    ...packet.table.rows.map((row) => "- " + row.name + ": ready=" + row.ready + " state=" + row.state + " detail=" + row.detail),
    "",
    "Readiness: sourceCriteriaMet=" + packet.readiness.sourceCriteriaMet
      + " chainReviewReady=" + packet.readiness.chainReviewReady
      + " startExecutorDispatchPermitted=" + packet.readiness.startExecutorDispatchPermitted
      + " executorInvocationPermitted=" + packet.readiness.executorInvocationPermitted
      + " sidecarStartPermitted=" + packet.readiness.sidecarStartPermitted
      + " defaultOnPermitted=" + packet.readiness.defaultOnPermitted
      + " terminalAckPermitted=" + packet.readiness.terminalAckPermitted
      + " dbMutationPermitted=" + packet.readiness.dbMutationPermitted
      + " executionPermitted=" + packet.readiness.executionPermitted,
    ...(packet.blockers.length ? ["", "Blockers:", ...packet.blockers.map((blocker) => "- " + blocker)] : []),
    "",
    "Next actions:",
    ...packet.nextActions.map((action) => "- " + action),
    "",
    "Safety: final no-live chain review only; a separate explicit approval is still required before any approval dispatch, executor dispatch/invocation, process spawn, sidecar start, default-on, provider send, terminal ACK, DB mutation, restart/deploy, replay, release, publish, or secret movement.",
  ].join("\n");
}

function buildRows(
  collector: TerminalBriefSidecarPreflightEvidenceCollectorPacket,
): TerminalBriefSidecarPreflightChainReviewRow[] {
  const collectorReady = collector.state === "ready_for_supervised_dry_run_preflight_review"
    && collector.readiness.sourceCriteriaMet
    && collector.readiness.preflightReviewReady
    && collector.blockers.length === 0;
  const canaryReady = collector.source.dryRunStartCanaryPlanReady
    && collector.source.dryRunStartCanaryPlanState === "ready_for_dry_run_start_approval_request";
  const evidenceReady = collector.table.requiredRows > 0
    && collector.table.requiredRowsReady === collector.table.requiredRows
    && collector.readiness.missingEvidence.length === 0;
  const harnessReady = collector.integrationContract.harnessNeutral
    && !collector.integrationContract.openclawMessageSendRequired
    && collector.integrationContract.hermesAdapterCompatible
    && collector.integrationContract.gongyungAdapterCompatible
    && !collector.integrationContract.collectsLiveEvidence
    && !collector.integrationContract.probesGateway;
  const approvalBoundaryReady = !collector.readiness.approvalRequestDispatchPermitted
    && !collector.readiness.approvalGrantPermitted
    && !collector.integrationContract.sendsApprovalRequest
    && !collector.integrationContract.grantsApproval;
  const runtimeBoundaryReady = !collector.readiness.startExecutorDispatchPermitted
    && !collector.readiness.executorInvocationPermitted
    && !collector.readiness.processSpawnPermitted
    && !collector.readiness.sidecarStartPermitted
    && !collector.readiness.defaultOnPermitted
    && !collector.readiness.liveActivationPermitted
    && !collector.readiness.providerSendPermitted
    && !collector.readiness.terminalAckPermitted
    && !collector.readiness.dbMutationPermitted
    && !collector.readiness.executionPermitted
    && !collector.integrationContract.dispatchesStartExecutor
    && !collector.integrationContract.invokesExecutor
    && !collector.integrationContract.spawnsProcess
    && !collector.integrationContract.startsSidecar
    && !collector.integrationContract.enablesDefaultOn
    && !collector.integrationContract.executesAction
    && !collector.semantics.performsProviderSend
    && !collector.semantics.performsTerminalAck
    && !collector.semantics.performsRuntimeRestartOrDeploy
    && !collector.semantics.performsDbMutation
    && !collector.semantics.performsHistoricalReplay
    && !collector.semantics.performsReleaseOrPublish
    && !collector.semantics.movesSecretsOrCredentials;
  return [
    {
      name: "preflight_collector",
      label: "Preflight collector packet",
      state: collector.state,
      required: true,
      ready: collectorReady,
      detail: "collectorState=" + collector.state + " sourceCriteriaMet=" + collector.readiness.sourceCriteriaMet,
      blockers: collectorReady ? [] : ["preflight evidence collector is not ready for review"],
      nextAction: collectorReady ? "verify source canary plan linkage" : "resolve collector state before chain review",
    },
    {
      name: "source_canary_plan",
      label: "Source canary plan",
      state: collector.source.dryRunStartCanaryPlanState,
      required: true,
      ready: canaryReady,
      detail: "canaryPlanReady=" + collector.source.dryRunStartCanaryPlanReady
        + " canaryPlan=" + collector.source.dryRunStartCanaryPlanIdempotencyKey,
      blockers: canaryReady ? [] : ["source dry-run start canary plan is not ready"],
      nextAction: canaryReady ? "verify evidence table completeness" : "refresh the dry-run start canary plan first",
    },
    {
      name: "evidence_table",
      label: "Preflight evidence table",
      state: evidenceReady ? "complete" : "incomplete",
      required: true,
      ready: evidenceReady,
      detail: "collectorRequiredRowsReady=" + collector.table.requiredRowsReady
        + "/" + collector.table.requiredRows
        + " missingEvidence=" + list(collector.readiness.missingEvidence),
      blockers: evidenceReady ? [] : ["collector evidence table is incomplete"],
      nextAction: evidenceReady ? "verify harness contract" : "supply missing preflight evidence",
    },
    {
      name: "harness_contract",
      label: "Harness contract",
      state: harnessReady ? "harness_neutral_no_probe" : "unsafe_or_too_specific",
      required: true,
      ready: harnessReady,
      detail: "openclawMessageSendRequired=" + collector.integrationContract.openclawMessageSendRequired
        + " hermes=" + collector.integrationContract.hermesAdapterCompatible
        + " gongyung=" + collector.integrationContract.gongyungAdapterCompatible
        + " probesGateway=" + collector.integrationContract.probesGateway,
      blockers: harnessReady ? [] : ["collector harness contract is not neutral/no-live"],
      nextAction: harnessReady ? "verify approval boundary" : "restore harness-neutral supplied-packet contract",
    },
    {
      name: "approval_boundary",
      label: "Approval boundary",
      state: approvalBoundaryReady ? "dispatch_and_grant_blocked" : "unsafe",
      required: true,
      ready: approvalBoundaryReady,
      detail: "approvalRequestDispatchPermitted=" + collector.readiness.approvalRequestDispatchPermitted
        + " approvalGrantPermitted=" + collector.readiness.approvalGrantPermitted,
      blockers: approvalBoundaryReady ? [] : ["collector unexpectedly permits approval dispatch or grant"],
      nextAction: approvalBoundaryReady ? "verify runtime boundary" : "restore no-approval-dispatch invariant",
    },
    {
      name: "runtime_boundary",
      label: "Runtime boundary",
      state: runtimeBoundaryReady ? "all_runtime_actions_blocked" : "unsafe",
      required: true,
      ready: runtimeBoundaryReady,
      detail: "sidecarStartPermitted=" + collector.readiness.sidecarStartPermitted
        + " providerSendPermitted=" + collector.readiness.providerSendPermitted
        + " terminalAckPermitted=" + collector.readiness.terminalAckPermitted
        + " dbMutationPermitted=" + collector.readiness.dbMutationPermitted,
      blockers: runtimeBoundaryReady ? [] : ["collector unexpectedly permits runtime/live mutation action"],
      nextAction: runtimeBoundaryReady ? "broker finalizer may review the no-live chain" : "restore no-runtime-action invariant",
    },
    {
      name: "finalizer_boundary",
      label: "Broker finalizer boundary",
      state: "manual_review_required",
      required: false,
      ready: false,
      detail: "this chain review still requires a separate broker-finalizer decision and explicit operator approval before runtime",
      blockers: ["this packet is not an approval request, approval grant, executor dispatch, sidecar start, or default-on action"],
      nextAction: "request explicit operator approval only after finalizer review",
    },
  ];
}

function buildBlockers(
  collector: TerminalBriefSidecarPreflightEvidenceCollectorPacket,
  rows: TerminalBriefSidecarPreflightChainReviewRow[],
): string[] {
  return unique([
    ...collector.blockers,
    ...collector.readiness.blockers,
    ...rows.filter((row) => row.required && !row.ready).flatMap((row) => row.blockers),
    ...(hasUnsafeNoLiveViolation(collector) ? ["preflight collector contains unsafe live-action permission or semantic flag"] : []),
  ].filter(Boolean));
}

function stateFor(
  collector: TerminalBriefSidecarPreflightEvidenceCollectorPacket,
  rows: TerminalBriefSidecarPreflightChainReviewRow[],
  blockers: string[],
): TerminalBriefSidecarPreflightChainReviewState {
  if (collector.state === "stale") return "stale";
  if (collector.state === "degraded") return "degraded";
  if (collector.state === "conflicting") return "conflicting";
  if (collector.state === "blocked" || hasUnsafeNoLiveViolation(collector)) return "blocked";
  if (rows.some((row) => row.required && !row.ready)) return "waiting_for_preflight_review";
  if (blockers.length) return "blocked";
  return "ready_for_supervised_dry_run_chain_review";
}

function buildReadiness(
  state: TerminalBriefSidecarPreflightChainReviewState,
  rows: TerminalBriefSidecarPreflightChainReviewRow[],
  blockers: string[],
): TerminalBriefSidecarPreflightChainReviewPacket["readiness"] {
  const missingEvidence = rows.filter((row) => row.required && !row.ready).map((row) => row.name);
  const sourceCriteriaMet = state === "ready_for_supervised_dry_run_chain_review"
    && missingEvidence.length === 0
    && blockers.length === 0;
  return {
    sourceCriteriaMet,
    chainReviewReady: sourceCriteriaMet,
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
    missingEvidence,
    blockers: [
      ...blockers,
      "chain review does not permit approval dispatch, executor invocation, process spawn, sidecar start, default-on, provider send, terminal ACK, DB mutation, restart/deploy, or historical replay",
      "supervised dry-run start requires a separate explicit operator approval and executor runtime",
    ],
    nextAction: sourceCriteriaMet
      ? "broker finalizer can use this chain review to prepare a separate explicit supervised dry-run start approval request"
      : "resolve incomplete chain evidence before any approval or runtime action",
  };
}

function hasUnsafeNoLiveViolation(collector: TerminalBriefSidecarPreflightEvidenceCollectorPacket): boolean {
  return collector.readiness.approvalRequestDispatchPermitted !== false
    || collector.readiness.approvalGrantPermitted !== false
    || collector.readiness.startExecutorDispatchPermitted !== false
    || collector.readiness.executorInvocationPermitted !== false
    || collector.readiness.processSpawnPermitted !== false
    || collector.readiness.sidecarStartPermitted !== false
    || collector.readiness.defaultOnPermitted !== false
    || collector.readiness.liveActivationPermitted !== false
    || collector.readiness.providerSendPermitted !== false
    || collector.readiness.terminalAckPermitted !== false
    || collector.readiness.dbMutationPermitted !== false
    || collector.readiness.executionPermitted !== false
    || collector.integrationContract.collectsLiveEvidence !== false
    || collector.integrationContract.probesGateway !== false
    || collector.integrationContract.sendsApprovalRequest !== false
    || collector.integrationContract.grantsApproval !== false
    || collector.integrationContract.dispatchesStartExecutor !== false
    || collector.integrationContract.invokesExecutor !== false
    || collector.integrationContract.spawnsProcess !== false
    || collector.integrationContract.startsSidecar !== false
    || collector.integrationContract.enablesDefaultOn !== false
    || collector.integrationContract.executesAction !== false
    || collector.semantics.performsProviderSend !== false
    || collector.semantics.performsTerminalAck !== false
    || collector.semantics.performsRuntimeRestartOrDeploy !== false
    || collector.semantics.performsDbMutation !== false
    || collector.semantics.performsHistoricalReplay !== false
    || collector.semantics.performsReleaseOrPublish !== false
    || collector.semantics.movesSecretsOrCredentials !== false;
}

function nextActionsFor(state: TerminalBriefSidecarPreflightChainReviewState): string[] {
  if (state === "ready_for_supervised_dry_run_chain_review") {
    return [
      "broker finalizer can prepare a separate explicit supervised dry-run start approval request from this no-live chain review",
      "do not dispatch approval, invoke executor, start sidecar, send providers, ACK terminal rows, mutate DB, restart/deploy, enable default-on, replay history, release, publish, or move secrets without fresh approval",
    ];
  }
  if (state === "waiting_for_preflight_review") {
    return [
      "complete the source canary plan and preflight collector evidence first",
      "keep sidecar disabled and default-on off until the no-live chain is complete",
    ];
  }
  if (state === "stale") {
    return [
      "refresh the preflight collector packet before chain review",
      "do not use stale preflight evidence for supervised dry-run approval",
    ];
  }
  if (state === "degraded") {
    return [
      "resolve degraded Gateway/queue/liveness evidence before chain review",
      "capture a fresh preflight collector packet after the degraded signal clears",
    ];
  }
  if (state === "conflicting") {
    return [
      "resolve conflicting preflight collector evidence first",
      "rerun the collector with one coherent source packet",
    ];
  }
  return [
    "resolve blocked or unsafe chain evidence before approval or runtime action",
    "do not send approvals, dispatch executor, spawn processes, start sidecar, send providers, ACK terminal rows, mutate state, restart/deploy, replay history, release, publish, or move secrets from a blocked chain review",
  ];
}

function buildChainReviewIdempotencyKey(
  collector: TerminalBriefSidecarPreflightEvidenceCollectorPacket,
  state: TerminalBriefSidecarPreflightChainReviewState,
  options: TerminalBriefSidecarPreflightChainReviewOptions,
): string {
  const base = JSON.stringify({
    label: "terminal-brief-sidecar-preflight-chain-review",
    parentRoundId: collector.parentRoundId ?? "unknown",
    collector: collector.idempotencyKey,
    canaryPlan: collector.source.dryRunStartCanaryPlanIdempotencyKey,
    finalizer: options.finalizer ?? options.finalizer_id,
    state,
  });
  return "tb-sidecar-preflight-chain-review:" + createHash("sha256").update(base).digest("hex").slice(0, 24);
}

function titleForState(state: TerminalBriefSidecarPreflightChainReviewState): string {
  if (state === "ready_for_supervised_dry_run_chain_review") return "Ready: Terminal Brief sidecar supervised dry-run preflight chain";
  if (state === "waiting_for_preflight_review") return "Waiting: Terminal Brief sidecar preflight chain";
  if (state === "stale") return "Stale: Terminal Brief sidecar preflight chain";
  if (state === "degraded") return "Degraded: Terminal Brief sidecar preflight chain";
  if (state === "conflicting") return "Conflicting: Terminal Brief sidecar preflight chain";
  return "Blocked: Terminal Brief sidecar preflight chain";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function list(items: unknown[]): string {
  return items.length ? items.join(",") : "none";
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function isTerminalBriefSidecarPreflightEvidenceCollectorPacket(
  value: unknown,
): value is TerminalBriefSidecarPreflightEvidenceCollectorPacket {
  return isRecord(value) && value.kind === "a2a-broker.terminal-brief-sidecar-preflight-evidence-collector.packet";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
