import { createHash } from "node:crypto";

import type { TerminalBriefSidecarDryRunStartCanaryPlanPacket } from "./terminal-brief-sidecar-dry-run-start-canary-plan.js";

export type TerminalBriefSidecarPreflightEvidenceCollectorState =
  | "ready_for_supervised_dry_run_preflight_review"
  | "waiting_for_preflight_evidence"
  | "stale"
  | "degraded"
  | "conflicting"
  | "blocked";

export type TerminalBriefSidecarPreflightEvidenceRowName =
  | "dry_run_start_canary_plan"
  | "gateway_readiness"
  | "queue_backlog"
  | "telegram_liveness"
  | "cursor_persistence"
  | "polling_boundary"
  | "sidecar_process_ownership"
  | "operator_events_scope"
  | "dry_run_safety"
  | "secret_boundary"
  | "live_activation";

export interface TerminalBriefSidecarPreflightEvidenceInput {
  observedAt?: string;
  observed_at?: string;
  expiresAt?: string;
  expires_at?: string;
  gatewayReady?: boolean;
  gateway_ready?: boolean;
  gatewayReadyAt?: string;
  gateway_ready_at?: string;
  eventLoopDegraded?: boolean;
  event_loop_degraded?: boolean;
  queueBacklog?: number;
  queue_backlog?: number;
  queueObservedAt?: string;
  queue_observed_at?: string;
  telegramLivenessOk?: boolean;
  telegram_liveness_ok?: boolean;
  telegramLastSeenAt?: string;
  telegram_last_seen_at?: string;
  cursorPersisted?: boolean;
  cursor_persisted?: boolean;
  cursorValue?: string;
  cursor_value?: string;
  cursorObservedAt?: string;
  cursor_observed_at?: string;
  boundedPolling?: boolean;
  bounded_polling?: boolean;
  pollIntervalMs?: number;
  poll_interval_ms?: number;
  maxBatch?: number;
  max_batch?: number;
  sidecarProcessCount?: number;
  sidecar_process_count?: number;
  pollingOwner?: string;
  polling_owner?: string;
  duplicatePollingOwner?: boolean;
  duplicate_polling_owner?: boolean;
  dryRunOnly?: boolean;
  dry_run_only?: boolean;
  operatorEventsCrossBrokersEnabled?: boolean;
  operator_events_cross_brokers_enabled?: boolean;
  secretLeakageObserved?: boolean;
  secret_leakage_observed?: boolean;
  liveProviderSendObserved?: boolean;
  live_provider_send_observed?: boolean;
  terminalAckObserved?: boolean;
  terminal_ack_observed?: boolean;
  dbMutationObserved?: boolean;
  db_mutation_observed?: boolean;
  runtimeRestartObserved?: boolean;
  runtime_restart_observed?: boolean;
  defaultOnEnabled?: boolean;
  default_on_enabled?: boolean;
  note?: string;
}

export interface TerminalBriefSidecarPreflightEvidenceCollectorOptions {
  now?: string;
  mode?: string;
  maxAgeMs?: number;
  max_age_ms?: number;
  maxQueueBacklog?: number;
  max_queue_backlog?: number;
  minPollIntervalMs?: number;
  min_poll_interval_ms?: number;
  maxBatchLimit?: number;
  max_batch_limit?: number;
}

export interface TerminalBriefSidecarPreflightEvidenceRow {
  name: TerminalBriefSidecarPreflightEvidenceRowName;
  label: string;
  state: string;
  required: boolean;
  ready: boolean;
  detail: string;
  blockers: string[];
  nextAction: string;
}

export interface TerminalBriefSidecarPreflightEvidenceCollectorPacket {
  kind: "a2a-broker.terminal-brief-sidecar-preflight-evidence-collector.packet";
  version: 1;
  generatedAt: string;
  mode: string;
  parentRoundId?: string;
  state: TerminalBriefSidecarPreflightEvidenceCollectorState;
  dryRunOnly: true;
  sourceOnlyNoLive: true;
  idempotencyKey: string;
  source: {
    dryRunStartCanaryPlanState: TerminalBriefSidecarDryRunStartCanaryPlanPacket["state"];
    dryRunStartCanaryPlanIdempotencyKey: string;
    dryRunStartCanaryPlanReady: boolean;
    requestedAction: string;
    operatorTarget: string;
    executorName: string;
    adapterName: string;
    monitorIntervalSeconds: number;
    maxQueueBacklog: number;
  };
  preflightEvidence: {
    observedAt?: string;
    expiresAt?: string;
    stale: boolean;
    gatewayReady?: boolean;
    gatewayReadyAt?: string;
    eventLoopDegraded?: boolean;
    queueBacklog?: number;
    queueObservedAt?: string;
    telegramLivenessOk?: boolean;
    telegramLastSeenAt?: string;
    cursorPersisted?: boolean;
    cursorValue?: string;
    cursorObservedAt?: string;
    boundedPolling?: boolean;
    pollIntervalMs?: number;
    maxBatch?: number;
    sidecarProcessCount?: number;
    pollingOwner?: string;
    duplicatePollingOwner?: boolean;
    dryRunOnly?: boolean;
    operatorEventsCrossBrokersEnabled?: boolean;
    secretLeakageObserved?: boolean;
    liveProviderSendObserved?: boolean;
    terminalAckObserved?: boolean;
    dbMutationObserved?: boolean;
    runtimeRestartObserved?: boolean;
    defaultOnEnabled?: boolean;
    note?: string;
  };
  table: {
    rows: TerminalBriefSidecarPreflightEvidenceRow[];
    requiredRowsReady: number;
    requiredRows: number;
    readyRows: number;
    totalRows: number;
  };
  readiness: {
    sourceCriteriaMet: boolean;
    preflightReviewReady: boolean;
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
    collectorVersion: 1;
    harnessNeutral: true;
    openclawMessageSendRequired: false;
    hermesAdapterCompatible: true;
    gongyungAdapterCompatible: true;
    consumesDryRunStartCanaryPlanPacket: true;
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
    preflightEvidenceCollectorOnly: true;
    sourceOnlyNoLive: true;
    suppliedEvidenceOnly: true;
    evidenceDoesNotMutateState: true;
    routeIsReadOnly: true;
    dryRunStartCanaryPlanDoesNotPermitStart: true;
    providerAcceptedIsVisibilityProof: false;
    terminalAckEligibleDoesNotPermitAck: true;
    executionNotPermitted: true;
    processSpawnNotPermitted: true;
    sidecarStartNotPermitted: true;
    defaultOnNotEnabledByThisPacket: true;
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

export function buildTerminalBriefSidecarPreflightEvidenceCollector(
  canaryPlan: TerminalBriefSidecarDryRunStartCanaryPlanPacket,
  evidenceInput: TerminalBriefSidecarPreflightEvidenceInput = {},
  options: TerminalBriefSidecarPreflightEvidenceCollectorOptions = {},
): TerminalBriefSidecarPreflightEvidenceCollectorPacket {
  const generatedAt = options.now ?? new Date().toISOString();
  const evidence = normalizeEvidence(evidenceInput, generatedAt, options);
  const rows = buildRows(canaryPlan, evidence, options);
  const blockers = buildBlockers(canaryPlan, evidence, rows);
  const state = stateFor(canaryPlan, evidence, rows, blockers);
  const readiness = buildReadiness(state, rows, blockers);
  return {
    kind: "a2a-broker.terminal-brief-sidecar-preflight-evidence-collector.packet",
    version: 1,
    generatedAt,
    mode: options.mode ?? canaryPlan.mode,
    parentRoundId: canaryPlan.parentRoundId,
    state,
    dryRunOnly: true,
    sourceOnlyNoLive: true,
    idempotencyKey: buildCollectorIdempotencyKey(canaryPlan, evidence, state),
    source: {
      dryRunStartCanaryPlanState: canaryPlan.state,
      dryRunStartCanaryPlanIdempotencyKey: canaryPlan.idempotencyKey,
      dryRunStartCanaryPlanReady: isCanaryPlanReady(canaryPlan),
      requestedAction: canaryPlan.approvalRequestDraft.requestedAction,
      operatorTarget: canaryPlan.approvalRequestDraft.operatorTarget,
      executorName: canaryPlan.source.executorName,
      adapterName: canaryPlan.source.adapterName,
      monitorIntervalSeconds: canaryPlan.canaryPlan.monitorIntervalSeconds,
      maxQueueBacklog: canaryPlan.canaryPlan.maxQueueBacklog,
    },
    preflightEvidence: evidence,
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
      "sending or dispatching an operator approval request",
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
      collectorVersion: 1,
      harnessNeutral: true,
      openclawMessageSendRequired: false,
      hermesAdapterCompatible: true,
      gongyungAdapterCompatible: true,
      consumesDryRunStartCanaryPlanPacket: true,
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
      preflightEvidenceCollectorOnly: true,
      sourceOnlyNoLive: true,
      suppliedEvidenceOnly: true,
      evidenceDoesNotMutateState: true,
      routeIsReadOnly: true,
      dryRunStartCanaryPlanDoesNotPermitStart: true,
      providerAcceptedIsVisibilityProof: false,
      terminalAckEligibleDoesNotPermitAck: true,
      executionNotPermitted: true,
      processSpawnNotPermitted: true,
      sidecarStartNotPermitted: true,
      defaultOnNotEnabledByThisPacket: true,
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

export function extractTerminalBriefSidecarPreflightEvidenceCollectorCanaryPlan(
  input: unknown,
): TerminalBriefSidecarDryRunStartCanaryPlanPacket {
  const envelope = isRecord(input) ? input : {};
  const candidates = [
    input,
    envelope.dryRunStartCanaryPlanPacket,
    envelope.dryRunStartCanaryPlan,
    envelope.sidecarDryRunStartCanaryPlan,
    envelope.canaryPlanPacket,
    envelope.packet,
  ];
  const packet = candidates.find(isTerminalBriefSidecarDryRunStartCanaryPlanPacket);
  if (!packet) {
    throw new Error("expected a Terminal Brief sidecar dry-run start canary plan packet");
  }
  return packet;
}

export function extractTerminalBriefSidecarPreflightEvidence(
  input: unknown,
): TerminalBriefSidecarPreflightEvidenceInput {
  const envelope = isRecord(input) ? input : {};
  const candidate = envelope.preflightEvidence
    ?? envelope.preflight_evidence
    ?? envelope.evidence
    ?? envelope.terminalBriefPreflightEvidence
    ?? envelope.terminal_brief_preflight_evidence;
  return isRecord(candidate) ? candidate as TerminalBriefSidecarPreflightEvidenceInput : {};
}

export function extractTerminalBriefSidecarPreflightEvidenceCollectorOptions(
  input: unknown,
): TerminalBriefSidecarPreflightEvidenceCollectorOptions {
  const envelope = isRecord(input) ? input : {};
  const candidate = envelope.preflightEvidenceCollector
    ?? envelope.preflight_evidence_collector
    ?? envelope.preflightEvidenceCollectorOptions
    ?? envelope.options;
  return isRecord(candidate) ? candidate as TerminalBriefSidecarPreflightEvidenceCollectorOptions : {};
}

export function renderTerminalBriefSidecarPreflightEvidenceCollectorMarkdown(
  packet: TerminalBriefSidecarPreflightEvidenceCollectorPacket,
): string {
  return [
    titleForState(packet.state),
    "Mode: " + packet.mode,
    "Parent round: " + (packet.parentRoundId ?? "unknown"),
    "State: " + packet.state + " dryRunOnly=" + packet.dryRunOnly + " sourceOnlyNoLive=" + packet.sourceOnlyNoLive,
    "Idempotency: " + packet.idempotencyKey,
    "Source canary plan: state=" + packet.source.dryRunStartCanaryPlanState
      + " ready=" + packet.source.dryRunStartCanaryPlanReady
      + " executor=" + packet.source.executorName
      + " adapter=" + packet.source.adapterName,
    "Evidence freshness: observedAt=" + (packet.preflightEvidence.observedAt ?? "missing")
      + " expiresAt=" + (packet.preflightEvidence.expiresAt ?? "missing")
      + " stale=" + packet.preflightEvidence.stale,
    "",
    "Rows:",
    ...packet.table.rows.map((row) => "- " + row.name + ": ready=" + row.ready + " state=" + row.state + " detail=" + row.detail),
    "",
    "Readiness: sourceCriteriaMet=" + packet.readiness.sourceCriteriaMet
      + " preflightReviewReady=" + packet.readiness.preflightReviewReady
      + " startExecutorDispatchPermitted=" + packet.readiness.startExecutorDispatchPermitted
      + " executorInvocationPermitted=" + packet.readiness.executorInvocationPermitted
      + " sidecarStartPermitted=" + packet.readiness.sidecarStartPermitted
      + " defaultOnPermitted=" + packet.readiness.defaultOnPermitted
      + " terminalAckPermitted=" + packet.readiness.terminalAckPermitted
      + " executionPermitted=" + packet.readiness.executionPermitted,
    ...(packet.blockers.length ? ["", "Blockers:", ...packet.blockers.map((blocker) => "- " + blocker)] : []),
    "",
    "Next actions:",
    ...packet.nextActions.map((action) => "- " + action),
    "",
    "Safety: supplied evidence only; does not probe Gateway/Telegram/broker runtime, send approvals, grant approval, dispatch/invoke executors, spawn processes, start sidecar, enable default-on, send providers, ACK/replay terminal rows, mutate GitHub/DB/TaskFlow state, restart/deploy, replay history, release, publish, or move secrets.",
  ].join("\n");
}

function normalizeEvidence(
  input: TerminalBriefSidecarPreflightEvidenceInput,
  generatedAt: string,
  options: TerminalBriefSidecarPreflightEvidenceCollectorOptions,
): TerminalBriefSidecarPreflightEvidenceCollectorPacket["preflightEvidence"] {
  const observedAt = optionalString(input.observedAt ?? input.observed_at);
  const expiresAt = optionalString(input.expiresAt ?? input.expires_at);
  const maxAgeMs = numberValue(options.maxAgeMs ?? options.max_age_ms) ?? 5 * 60 * 1000;
  return {
    observedAt,
    expiresAt,
    stale: isStale(observedAt, expiresAt, generatedAt, maxAgeMs),
    gatewayReady: optionalBoolean(input.gatewayReady ?? input.gateway_ready),
    gatewayReadyAt: optionalString(input.gatewayReadyAt ?? input.gateway_ready_at),
    eventLoopDegraded: optionalBoolean(input.eventLoopDegraded ?? input.event_loop_degraded),
    queueBacklog: numberValue(input.queueBacklog ?? input.queue_backlog),
    queueObservedAt: optionalString(input.queueObservedAt ?? input.queue_observed_at),
    telegramLivenessOk: optionalBoolean(input.telegramLivenessOk ?? input.telegram_liveness_ok),
    telegramLastSeenAt: optionalString(input.telegramLastSeenAt ?? input.telegram_last_seen_at),
    cursorPersisted: optionalBoolean(input.cursorPersisted ?? input.cursor_persisted),
    cursorValue: optionalString(input.cursorValue ?? input.cursor_value),
    cursorObservedAt: optionalString(input.cursorObservedAt ?? input.cursor_observed_at),
    boundedPolling: optionalBoolean(input.boundedPolling ?? input.bounded_polling),
    pollIntervalMs: numberValue(input.pollIntervalMs ?? input.poll_interval_ms),
    maxBatch: numberValue(input.maxBatch ?? input.max_batch),
    sidecarProcessCount: numberValue(input.sidecarProcessCount ?? input.sidecar_process_count),
    pollingOwner: optionalString(input.pollingOwner ?? input.polling_owner),
    duplicatePollingOwner: optionalBoolean(input.duplicatePollingOwner ?? input.duplicate_polling_owner),
    dryRunOnly: optionalBoolean(input.dryRunOnly ?? input.dry_run_only),
    operatorEventsCrossBrokersEnabled: optionalBoolean(
      input.operatorEventsCrossBrokersEnabled ?? input.operator_events_cross_brokers_enabled,
    ),
    secretLeakageObserved: optionalBoolean(input.secretLeakageObserved ?? input.secret_leakage_observed),
    liveProviderSendObserved: optionalBoolean(input.liveProviderSendObserved ?? input.live_provider_send_observed),
    terminalAckObserved: optionalBoolean(input.terminalAckObserved ?? input.terminal_ack_observed),
    dbMutationObserved: optionalBoolean(input.dbMutationObserved ?? input.db_mutation_observed),
    runtimeRestartObserved: optionalBoolean(input.runtimeRestartObserved ?? input.runtime_restart_observed),
    defaultOnEnabled: optionalBoolean(input.defaultOnEnabled ?? input.default_on_enabled),
    note: optionalString(input.note),
  };
}

function buildRows(
  canaryPlan: TerminalBriefSidecarDryRunStartCanaryPlanPacket,
  evidence: TerminalBriefSidecarPreflightEvidenceCollectorPacket["preflightEvidence"],
  options: TerminalBriefSidecarPreflightEvidenceCollectorOptions,
): TerminalBriefSidecarPreflightEvidenceRow[] {
  const sourceReady = isCanaryPlanReady(canaryPlan);
  const maxQueueBacklog = numberValue(options.maxQueueBacklog ?? options.max_queue_backlog)
    ?? canaryPlan.canaryPlan.maxQueueBacklog
    ?? 1000;
  const minPollIntervalMs = numberValue(options.minPollIntervalMs ?? options.min_poll_interval_ms)
    ?? Math.max(canaryPlan.canaryPlan.monitorIntervalSeconds * 1000, 10_000);
  const maxBatchLimit = numberValue(options.maxBatchLimit ?? options.max_batch_limit) ?? 100;
  const gatewayReady = evidence.gatewayReady === true
    && evidence.eventLoopDegraded === false
    && evidence.gatewayReadyAt !== undefined
    && !evidence.stale;
  const queueReady = typeof evidence.queueBacklog === "number"
    && evidence.queueBacklog >= 0
    && evidence.queueBacklog <= maxQueueBacklog
    && evidence.queueObservedAt !== undefined
    && !evidence.stale;
  const telegramReady = evidence.telegramLivenessOk === true
    && evidence.telegramLastSeenAt !== undefined
    && !evidence.stale;
  const cursorReady = evidence.cursorPersisted === true
    && evidence.cursorValue !== undefined
    && evidence.cursorObservedAt !== undefined
    && !evidence.stale;
  const pollingReady = evidence.boundedPolling === true
    && typeof evidence.pollIntervalMs === "number"
    && evidence.pollIntervalMs >= minPollIntervalMs
    && typeof evidence.maxBatch === "number"
    && evidence.maxBatch > 0
    && evidence.maxBatch <= maxBatchLimit;
  const processReady = typeof evidence.sidecarProcessCount === "number"
    && evidence.sidecarProcessCount >= 0
    && evidence.sidecarProcessCount <= 1
    && evidence.duplicatePollingOwner === false
    && evidence.pollingOwner !== undefined;
  const operatorEventsReady = evidence.operatorEventsCrossBrokersEnabled === false;
  const dryRunReady = evidence.dryRunOnly === true
    && evidence.liveProviderSendObserved === false
    && evidence.terminalAckObserved === false
    && evidence.dbMutationObserved === false
    && evidence.runtimeRestartObserved === false
    && evidence.defaultOnEnabled === false;
  const secretReady = evidence.secretLeakageObserved === false;
  return [
    {
      name: "dry_run_start_canary_plan",
      label: "Dry-run start canary plan",
      state: canaryPlan.state,
      required: true,
      ready: sourceReady,
      detail: sourceReady
        ? "source canary plan is ready and source-only"
        : "source canary plan is not ready or has unsafe runtime flags",
      blockers: sourceReady ? [] : canaryPlanBlockers(canaryPlan),
      nextAction: sourceReady ? "verify supplied Gateway/queue/liveness/cursor evidence" : "refresh the source canary plan first",
    },
    {
      name: "gateway_readiness",
      label: "Gateway readiness",
      state: gatewayReady ? "healthy" : evidence.stale ? "stale" : "missing_or_degraded",
      required: true,
      ready: gatewayReady,
      detail: "gatewayReady=" + (evidence.gatewayReady ?? "missing")
        + " gatewayReadyAt=" + (evidence.gatewayReadyAt ?? "missing")
        + " eventLoopDegraded=" + (evidence.eventLoopDegraded ?? "missing"),
      blockers: gatewayReady ? [] : ["fresh Gateway ready/event-loop evidence is missing, stale, or degraded"],
      nextAction: gatewayReady ? "verify queue backlog" : "supply fresh Gateway readiness evidence",
    },
    {
      name: "queue_backlog",
      label: "Queue backlog",
      state: queueReady ? "within_limit" : evidence.stale ? "stale" : "missing_or_over_limit",
      required: true,
      ready: queueReady,
      detail: "queueBacklog=" + (evidence.queueBacklog ?? "missing")
        + " maxQueueBacklog=" + maxQueueBacklog
        + " queueObservedAt=" + (evidence.queueObservedAt ?? "missing"),
      blockers: queueReady ? [] : ["fresh queue backlog evidence is missing, stale, negative, or above limit"],
      nextAction: queueReady ? "verify Telegram liveness evidence" : "supply fresh queue backlog evidence",
    },
    {
      name: "telegram_liveness",
      label: "Telegram liveness",
      state: telegramReady ? "live" : evidence.stale ? "stale" : "missing_or_unhealthy",
      required: true,
      ready: telegramReady,
      detail: "telegramLivenessOk=" + (evidence.telegramLivenessOk ?? "missing")
        + " telegramLastSeenAt=" + (evidence.telegramLastSeenAt ?? "missing"),
      blockers: telegramReady ? [] : ["fresh Telegram liveness evidence is missing, stale, or unhealthy"],
      nextAction: telegramReady ? "verify cursor persistence" : "supply fresh Telegram liveness evidence",
    },
    {
      name: "cursor_persistence",
      label: "Cursor persistence",
      state: cursorReady ? "persisted" : evidence.stale ? "stale" : "missing",
      required: true,
      ready: cursorReady,
      detail: "cursorPersisted=" + (evidence.cursorPersisted ?? "missing")
        + " cursorValue=" + (evidence.cursorValue ?? "missing")
        + " cursorObservedAt=" + (evidence.cursorObservedAt ?? "missing"),
      blockers: cursorReady ? [] : ["fresh cursor persistence evidence is missing or stale"],
      nextAction: cursorReady ? "verify polling boundary" : "supply cursor value and persistence evidence",
    },
    {
      name: "polling_boundary",
      label: "Polling boundary",
      state: pollingReady ? "bounded" : "missing_or_unbounded",
      required: true,
      ready: pollingReady,
      detail: "boundedPolling=" + (evidence.boundedPolling ?? "missing")
        + " pollIntervalMs=" + (evidence.pollIntervalMs ?? "missing")
        + " minPollIntervalMs=" + minPollIntervalMs
        + " maxBatch=" + (evidence.maxBatch ?? "missing")
        + " maxBatchLimit=" + maxBatchLimit,
      blockers: pollingReady ? [] : ["bounded polling evidence is missing or outside limits"],
      nextAction: pollingReady ? "verify sidecar process ownership" : "supply bounded polling interval and max-batch evidence",
    },
    {
      name: "sidecar_process_ownership",
      label: "Sidecar process ownership",
      state: processReady ? "single_owner" : "missing_or_conflicting",
      required: true,
      ready: processReady,
      detail: "sidecarProcessCount=" + (evidence.sidecarProcessCount ?? "missing")
        + " pollingOwner=" + (evidence.pollingOwner ?? "missing")
        + " duplicatePollingOwner=" + (evidence.duplicatePollingOwner ?? "missing"),
      blockers: processReady ? [] : ["sidecar process/owner evidence is missing or indicates duplicate polling"],
      nextAction: processReady ? "verify operatorEvents scope" : "supply single polling owner and duplicate-process evidence",
    },
    {
      name: "operator_events_scope",
      label: "operatorEvents scope",
      state: operatorEventsReady ? "cross_broker_disabled" : "missing_or_enabled",
      required: true,
      ready: operatorEventsReady,
      detail: "operatorEventsCrossBrokersEnabled=" + (evidence.operatorEventsCrossBrokersEnabled ?? "missing"),
      blockers: operatorEventsReady ? [] : ["cross-broker operatorEvents evidence is missing or enabled"],
      nextAction: operatorEventsReady ? "verify dry-run safety" : "supply evidence that cross-broker operatorEvents is disabled",
    },
    {
      name: "dry_run_safety",
      label: "Dry-run safety",
      state: dryRunReady ? "dry_run_only_no_live_actions" : "unsafe_or_missing",
      required: true,
      ready: dryRunReady,
      detail: "dryRunOnly=" + (evidence.dryRunOnly ?? "missing")
        + " liveProviderSendObserved=" + (evidence.liveProviderSendObserved ?? "missing")
        + " terminalAckObserved=" + (evidence.terminalAckObserved ?? "missing")
        + " dbMutationObserved=" + (evidence.dbMutationObserved ?? "missing")
        + " runtimeRestartObserved=" + (evidence.runtimeRestartObserved ?? "missing")
        + " defaultOnEnabled=" + (evidence.defaultOnEnabled ?? "missing"),
      blockers: dryRunReady ? [] : ["dry-run-only proof is missing or live/runtime mutation evidence is present"],
      nextAction: dryRunReady ? "verify secret boundary" : "supply dry-run-only and no-live-action evidence",
    },
    {
      name: "secret_boundary",
      label: "Secret boundary",
      state: secretReady ? "no_secret_leakage_observed" : "missing_or_leaked",
      required: true,
      ready: secretReady,
      detail: "secretLeakageObserved=" + (evidence.secretLeakageObserved ?? "missing"),
      blockers: secretReady ? [] : ["secret leakage evidence is missing or leakage was observed"],
      nextAction: secretReady ? "broker finalizer may review the preflight packet" : "supply sanitized no-secret-leakage evidence",
    },
    {
      name: "live_activation",
      label: "Live/default-on activation",
      state: "not_permitted_source_only",
      required: false,
      ready: false,
      detail: "this collector never starts sidecar or enables live/default-on behavior",
      blockers: ["live/default-on activation requires a separate explicit approval, executor, canary, and deployment step"],
      nextAction: "keep live/default-on activation outside this source-only evidence collector",
    },
  ];
}

function buildBlockers(
  canaryPlan: TerminalBriefSidecarDryRunStartCanaryPlanPacket,
  evidence: TerminalBriefSidecarPreflightEvidenceCollectorPacket["preflightEvidence"],
  rows: TerminalBriefSidecarPreflightEvidenceRow[],
): string[] {
  const blockers = [
    ...canaryPlan.blockers,
    ...canaryPlanBlockers(canaryPlan),
    ...rows.filter((row) => row.required && !row.ready).flatMap((row) => row.blockers),
  ];
  if (evidence.stale) blockers.push("preflight evidence is stale or expired");
  return unique(blockers.filter(Boolean));
}

function stateFor(
  canaryPlan: TerminalBriefSidecarDryRunStartCanaryPlanPacket,
  evidence: TerminalBriefSidecarPreflightEvidenceCollectorPacket["preflightEvidence"],
  rows: TerminalBriefSidecarPreflightEvidenceRow[],
  blockers: string[],
): TerminalBriefSidecarPreflightEvidenceCollectorState {
  if (canaryPlan.state === "stale") return "stale";
  if (canaryPlan.state === "conflicting") return "conflicting";
  if (canaryPlan.state === "blocked" || hasUnsafeNoLiveViolation(canaryPlan)) return "blocked";
  if (evidence.stale) return "stale";
  if (hasObservedUnsafeLiveAction(evidence)) return "blocked";
  if (evidence.gatewayReady === false || evidence.eventLoopDegraded === true || evidence.telegramLivenessOk === false) return "degraded";
  const queueRow = rows.find((row) => row.name === "queue_backlog");
  if (queueRow && !queueRow.ready && typeof evidence.queueBacklog === "number") return "degraded";
  if (rows.some((row) => row.required && !row.ready)) return "waiting_for_preflight_evidence";
  if (blockers.length > 0) return "blocked";
  return "ready_for_supervised_dry_run_preflight_review";
}

function buildReadiness(
  state: TerminalBriefSidecarPreflightEvidenceCollectorState,
  rows: TerminalBriefSidecarPreflightEvidenceRow[],
  blockers: string[],
): TerminalBriefSidecarPreflightEvidenceCollectorPacket["readiness"] {
  const missingEvidence = rows.filter((row) => row.required && !row.ready).map((row) => row.name);
  const sourceCriteriaMet = state === "ready_for_supervised_dry_run_preflight_review"
    && missingEvidence.length === 0
    && blockers.length === 0;
  return {
    sourceCriteriaMet,
    preflightReviewReady: sourceCriteriaMet,
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
      "preflight evidence review does not permit approval dispatch, executor invocation, process spawn, sidecar start, default-on, provider send, terminal ACK, DB mutation, restart/deploy, or historical replay",
      "supervised dry-run start requires a separate explicit operator approval and executor runtime",
    ],
    nextAction: sourceCriteriaMet
      ? "broker finalizer can review the preflight packet before requesting any explicit supervised dry-run start approval"
      : "supply fresh source evidence and resolve blockers before any approval or runtime action",
  };
}

function isCanaryPlanReady(canaryPlan: TerminalBriefSidecarDryRunStartCanaryPlanPacket): boolean {
  return canaryPlan.state === "ready_for_dry_run_start_approval_request"
    && canaryPlan.dryRunOnly === true
    && canaryPlan.sourceOnlyNoLive === true
    && canaryPlan.readiness.sourceCriteriaMet === true
    && canaryPlan.readiness.approvalRequestDispatchPermitted === false
    && canaryPlan.readiness.approvalGrantPermitted === false
    && canaryPlan.readiness.startExecutorDispatchPermitted === false
    && canaryPlan.readiness.executorInvocationPermitted === false
    && canaryPlan.readiness.processSpawnPermitted === false
    && canaryPlan.readiness.sidecarStartPermitted === false
    && canaryPlan.readiness.defaultOnPermitted === false
    && canaryPlan.readiness.liveActivationPermitted === false
    && canaryPlan.readiness.providerSendPermitted === false
    && canaryPlan.readiness.terminalAckPermitted === false
    && canaryPlan.readiness.executionPermitted === false
    && canaryPlan.integrationContract.sendsApprovalRequest === false
    && canaryPlan.integrationContract.dispatchesStartExecutor === false
    && canaryPlan.integrationContract.invokesExecutor === false
    && canaryPlan.integrationContract.spawnsProcess === false
    && canaryPlan.integrationContract.startsSidecar === false
    && canaryPlan.integrationContract.enablesDefaultOn === false
    && canaryPlan.integrationContract.executesAction === false
    && canaryPlan.semantics.planDoesNotMutateState === true
    && canaryPlan.semantics.performsProviderSend === false
    && canaryPlan.semantics.performsTerminalAck === false
    && canaryPlan.semantics.performsRuntimeRestartOrDeploy === false
    && canaryPlan.semantics.performsDbMutation === false
    && canaryPlan.semantics.performsHistoricalReplay === false
    && canaryPlan.semantics.performsReleaseOrPublish === false
    && canaryPlan.semantics.movesSecretsOrCredentials === false
    && canaryPlan.blockers.length === 0;
}

function canaryPlanBlockers(canaryPlan: TerminalBriefSidecarDryRunStartCanaryPlanPacket): string[] {
  return [
    ...canaryPlan.blockers,
    ...(canaryPlan.state !== "ready_for_dry_run_start_approval_request" ? ["dry-run start canary plan is " + canaryPlan.state] : []),
    ...(!canaryPlan.readiness.sourceCriteriaMet ? ["dry-run start canary plan source criteria are not met"] : []),
    ...(hasUnsafeNoLiveViolation(canaryPlan) ? ["dry-run start canary plan contains unsafe live-action permission or semantic flag"] : []),
  ];
}

function hasUnsafeNoLiveViolation(canaryPlan: TerminalBriefSidecarDryRunStartCanaryPlanPacket): boolean {
  return canaryPlan.readiness.approvalRequestDispatchPermitted !== false
    || canaryPlan.readiness.approvalGrantPermitted !== false
    || canaryPlan.readiness.startExecutorDispatchPermitted !== false
    || canaryPlan.readiness.executorInvocationPermitted !== false
    || canaryPlan.readiness.processSpawnPermitted !== false
    || canaryPlan.readiness.sidecarStartPermitted !== false
    || canaryPlan.readiness.defaultOnPermitted !== false
    || canaryPlan.readiness.liveActivationPermitted !== false
    || canaryPlan.readiness.providerSendPermitted !== false
    || canaryPlan.readiness.terminalAckPermitted !== false
    || canaryPlan.readiness.executionPermitted !== false
    || canaryPlan.approvalRequestDraft.dispatchPermitted !== false
    || canaryPlan.approvalRequestDraft.sendsApprovalRequest !== false
    || canaryPlan.approvalRequestDraft.approvalGrantPermitted !== false
    || canaryPlan.approvalRequestDraft.executionPermitted !== false
    || canaryPlan.integrationContract.sendsApprovalRequest !== false
    || canaryPlan.integrationContract.grantsApproval !== false
    || canaryPlan.integrationContract.dispatchesStartExecutor !== false
    || canaryPlan.integrationContract.invokesExecutor !== false
    || canaryPlan.integrationContract.spawnsProcess !== false
    || canaryPlan.integrationContract.startsSidecar !== false
    || canaryPlan.integrationContract.enablesDefaultOn !== false
    || canaryPlan.integrationContract.executesAction !== false
    || canaryPlan.semantics.performsProviderSend !== false
    || canaryPlan.semantics.performsTerminalAck !== false
    || canaryPlan.semantics.performsRuntimeRestartOrDeploy !== false
    || canaryPlan.semantics.performsDbMutation !== false
    || canaryPlan.semantics.performsHistoricalReplay !== false
    || canaryPlan.semantics.performsReleaseOrPublish !== false
    || canaryPlan.semantics.movesSecretsOrCredentials !== false;
}

function hasObservedUnsafeLiveAction(
  evidence: TerminalBriefSidecarPreflightEvidenceCollectorPacket["preflightEvidence"],
): boolean {
  return evidence.liveProviderSendObserved === true
    || evidence.terminalAckObserved === true
    || evidence.dbMutationObserved === true
    || evidence.runtimeRestartObserved === true
    || evidence.defaultOnEnabled === true
    || evidence.secretLeakageObserved === true;
}

function nextActionsFor(state: TerminalBriefSidecarPreflightEvidenceCollectorState): string[] {
  if (state === "ready_for_supervised_dry_run_preflight_review") {
    return [
      "broker finalizer can review this normalized preflight packet",
      "request separate explicit operator approval before any executor dispatch, process spawn, sidecar start, provider send, terminal ACK, DB mutation, restart/deploy, default-on, or historical replay",
    ];
  }
  if (state === "waiting_for_preflight_evidence") {
    return [
      "supply missing Gateway/queue/Telegram/cursor/polling/process/operatorEvents/dry-run/secret evidence",
      "keep the sidecar disabled and default-on off until preflight evidence is complete",
    ];
  }
  if (state === "stale") {
    return [
      "refresh preflight evidence before any operator approval request or runtime action",
      "do not rely on stale Gateway, queue, liveness, or cursor evidence",
    ];
  }
  if (state === "degraded") {
    return [
      "resolve Gateway/event-loop/queue/Telegram degradation before requesting a supervised dry-run start",
      "capture fresh evidence after the degraded signal clears",
    ];
  }
  if (state === "conflicting") {
    return [
      "resolve conflicting source canary plan evidence first",
      "rerun source-only planning with one coherent packet",
    ];
  }
  return [
    "resolve blocked or unsafe evidence before any operator approval or runtime action",
    "do not send approvals, dispatch executor, spawn processes, start sidecar, send providers, ACK terminal rows, mutate state, restart/deploy, replay history, release, publish, or move secrets from a blocked packet",
  ];
}

function buildCollectorIdempotencyKey(
  canaryPlan: TerminalBriefSidecarDryRunStartCanaryPlanPacket,
  evidence: TerminalBriefSidecarPreflightEvidenceCollectorPacket["preflightEvidence"],
  state: TerminalBriefSidecarPreflightEvidenceCollectorState,
): string {
  const base = JSON.stringify({
    label: "terminal-brief-sidecar-preflight-evidence-collector",
    parentRoundId: canaryPlan.parentRoundId ?? "unknown",
    canaryPlan: canaryPlan.idempotencyKey,
    evidence,
    state,
  });
  return "tb-sidecar-preflight-evidence:" + createHash("sha256").update(base).digest("hex").slice(0, 24);
}

function titleForState(state: TerminalBriefSidecarPreflightEvidenceCollectorState): string {
  if (state === "ready_for_supervised_dry_run_preflight_review") return "Ready: Terminal Brief sidecar preflight evidence review";
  if (state === "waiting_for_preflight_evidence") return "Waiting: Terminal Brief sidecar preflight evidence";
  if (state === "stale") return "Stale: Terminal Brief sidecar preflight evidence";
  if (state === "degraded") return "Degraded: Terminal Brief sidecar preflight evidence";
  if (state === "conflicting") return "Conflicting: Terminal Brief sidecar preflight source";
  return "Blocked: Terminal Brief sidecar preflight evidence";
}

function isStale(observedAt: string | undefined, expiresAt: string | undefined, now: string, maxAgeMs: number): boolean {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) return false;
  if (expiresAt) {
    const expiresMs = Date.parse(expiresAt);
    if (Number.isFinite(expiresMs) && expiresMs <= nowMs) return true;
  }
  if (!observedAt) return false;
  const observedMs = Date.parse(observedAt);
  if (!Number.isFinite(observedMs)) return true;
  return nowMs - observedMs > maxAgeMs || observedMs - nowMs > maxAgeMs;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function isTerminalBriefSidecarDryRunStartCanaryPlanPacket(
  value: unknown,
): value is TerminalBriefSidecarDryRunStartCanaryPlanPacket {
  return isRecord(value) && value.kind === "a2a-broker.terminal-brief-sidecar-dry-run-start-canary-plan.packet";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
