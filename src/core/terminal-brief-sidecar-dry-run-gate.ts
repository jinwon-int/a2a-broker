import { createHash } from "node:crypto";

import type { TerminalBriefFinalizerApprovalStatusPacket } from "./terminal-brief-finalizer-approval-status.js";
import type { TerminalBriefSidecarIntegrationRehearsal } from "./terminal-brief-sidecar-integration-rehearsal.js";

export type TerminalBriefSidecarDryRunGateState =
  | "ready_for_operator_approval"
  | "waiting_for_finalizer_status"
  | "waiting_for_operating_evidence"
  | "stale"
  | "blocked";

export type TerminalBriefSidecarDryRunGateRowName =
  | "sidecar_rehearsal"
  | "finalizer_status"
  | "cursor_polling"
  | "gateway_load"
  | "safety_boundary"
  | "live_activation";

export interface TerminalBriefSidecarDryRunOperatingEvidenceInput {
  observedAt?: string;
  observed_at?: string;
  expiresAt?: string;
  expires_at?: string;
  cursorPersisted?: boolean;
  cursor_persisted?: boolean;
  boundedPolling?: boolean;
  bounded_polling?: boolean;
  pollIntervalMs?: number;
  poll_interval_ms?: number;
  maxBatch?: number;
  max_batch?: number;
  gatewayReady?: boolean;
  gateway_ready?: boolean;
  eventLoopDegraded?: boolean;
  event_loop_degraded?: boolean;
  queueBacklog?: number;
  queue_backlog?: number;
  dryRunOnly?: boolean;
  dry_run_only?: boolean;
  operatorEventsCrossBrokersEnabled?: boolean;
  operator_events_cross_brokers_enabled?: boolean;
  supervisedSidecar?: boolean;
  supervised_sidecar?: boolean;
  note?: string;
}

export interface TerminalBriefSidecarDryRunGateOptions {
  now?: string;
  mode?: string;
  maxAgeMs?: number;
  minPollIntervalMs?: number;
  maxBatchLimit?: number;
  maxQueueBacklog?: number;
}

export interface TerminalBriefSidecarDryRunGateRow {
  name: TerminalBriefSidecarDryRunGateRowName;
  label: string;
  state: string;
  required: boolean;
  ready: boolean;
  detail: string;
  blockers: string[];
  nextAction: string;
}

export interface TerminalBriefSidecarDryRunGatePacket {
  kind: "a2a-broker.terminal-brief-sidecar-dry-run-gate.packet";
  version: 1;
  generatedAt: string;
  mode: string;
  parentRoundId?: string;
  state: TerminalBriefSidecarDryRunGateState;
  dryRunOnly: true;
  sourceOnlyNoLive: true;
  idempotencyKey: string;
  source: {
    sidecarDecision: TerminalBriefSidecarIntegrationRehearsal["decision"];
    sidecarSpoolRecords: number;
    sidecarReceiptDecisions: number;
    sidecarDryRunOnly: boolean;
    providerSendAttempted: boolean;
    terminalAckAttempted: boolean;
    finalCountDecision?: string;
    finalizerStatus?: TerminalBriefFinalizerApprovalStatusPacket["state"];
    finalizerStatusIdempotencyKey?: string;
  };
  operatingEvidence: {
    observedAt?: string;
    expiresAt?: string;
    stale: boolean;
    cursorPersisted: boolean;
    boundedPolling: boolean;
    pollIntervalMs?: number;
    maxBatch?: number;
    gatewayReady?: boolean;
    eventLoopDegraded?: boolean;
    queueBacklog?: number;
    dryRunOnly: boolean;
    operatorEventsCrossBrokersEnabled: boolean;
    supervisedSidecar: boolean;
  };
  table: {
    rows: TerminalBriefSidecarDryRunGateRow[];
    requiredRowsReady: number;
    requiredRows: number;
    readyRows: number;
    totalRows: number;
  };
  readiness: {
    sourceCriteriaMet: boolean;
    alwaysOnDryRunCandidate: boolean;
    alwaysOnDryRunStartPermitted: false;
    defaultOnPermitted: false;
    liveActivationPermitted: false;
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
    consumesSidecarIntegrationRehearsal: true;
    consumesFinalizerApprovalStatus: true;
    grantsApproval: false;
    startsSidecar: false;
    enablesDefaultOn: false;
    executesAction: false;
  };
  semantics: {
    operatingGateOnly: true;
    sourceOnlyNoLive: true;
    gateDoesNotMutateState: true;
    sidecarDryRunCandidateDoesNotStartSidecar: true;
    providerAcceptedIsVisibilityProof: false;
    terminalAckEligibleDoesNotPermitAck: true;
    approvalGrantEvidenceDoesNotGrantApproval: true;
    defaultOnNotEnabledByThisPacket: true;
    executionNotPermitted: true;
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

export function buildTerminalBriefSidecarDryRunGate(
  sidecarRehearsal: TerminalBriefSidecarIntegrationRehearsal,
  finalizerStatus?: TerminalBriefFinalizerApprovalStatusPacket,
  evidenceInput: TerminalBriefSidecarDryRunOperatingEvidenceInput = {},
  options: TerminalBriefSidecarDryRunGateOptions = {},
): TerminalBriefSidecarDryRunGatePacket {
  const generatedAt = options.now ?? new Date().toISOString();
  const evidence = normalizeOperatingEvidence(evidenceInput, generatedAt, options);
  const rows = buildRows(sidecarRehearsal, finalizerStatus, evidence, options);
  const blockers = buildBlockers(sidecarRehearsal, finalizerStatus, evidence, rows);
  const state = stateFor(sidecarRehearsal, finalizerStatus, evidence, blockers, rows);
  const readiness = buildReadiness(state, rows, blockers);
  return {
    kind: "a2a-broker.terminal-brief-sidecar-dry-run-gate.packet",
    version: 1,
    generatedAt,
    mode: options.mode ?? finalizerStatus?.mode ?? sidecarRehearsal.mode,
    parentRoundId: finalizerStatus?.parentRoundId ?? sidecarRehearsal.parentRoundId,
    state,
    dryRunOnly: true,
    sourceOnlyNoLive: true,
    idempotencyKey: buildGateIdempotencyKey(sidecarRehearsal, finalizerStatus, evidence, state),
    source: {
      sidecarDecision: sidecarRehearsal.decision,
      sidecarSpoolRecords: sidecarRehearsal.sidecar.spoolRecords,
      sidecarReceiptDecisions: sidecarRehearsal.sidecar.receiptDecisions,
      sidecarDryRunOnly: sidecarRehearsal.sidecar.dryRunOnly,
      providerSendAttempted: sidecarRehearsal.sidecar.providerSendAttempted,
      terminalAckAttempted: sidecarRehearsal.sidecar.terminalAckAttempted,
      finalCountDecision: sidecarRehearsal.finalCountCandidate?.decision,
      finalizerStatus: finalizerStatus?.state,
      finalizerStatusIdempotencyKey: finalizerStatus?.idempotencyKey,
    },
    operatingEvidence: evidence,
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
      "starting/enabling always-on sidecar",
      "Terminal Brief default-on enablement",
      "live provider/Hermes/Gongyung/Telegram/OpenClaw send",
      "terminal ACK/replay or terminal receipt DB mutation",
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
      consumesSidecarIntegrationRehearsal: true,
      consumesFinalizerApprovalStatus: true,
      grantsApproval: false,
      startsSidecar: false,
      enablesDefaultOn: false,
      executesAction: false,
    },
    semantics: {
      operatingGateOnly: true,
      sourceOnlyNoLive: true,
      gateDoesNotMutateState: true,
      sidecarDryRunCandidateDoesNotStartSidecar: true,
      providerAcceptedIsVisibilityProof: false,
      terminalAckEligibleDoesNotPermitAck: true,
      approvalGrantEvidenceDoesNotGrantApproval: true,
      defaultOnNotEnabledByThisPacket: true,
      executionNotPermitted: true,
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

export function extractTerminalBriefSidecarDryRunGateRehearsal(
  input: unknown,
): TerminalBriefSidecarIntegrationRehearsal {
  const envelope = isRecord(input) ? input : {};
  const candidates = [
    input,
    envelope.sidecarIntegration,
    envelope.sidecarIntegrationPacket,
    envelope.sidecarRehearsal,
    envelope.rehearsal,
    envelope.packet,
  ];
  const packet = candidates.find(isTerminalBriefSidecarIntegrationRehearsal);
  if (!packet) {
    throw new Error("expected a Terminal Brief sidecar integration rehearsal packet");
  }
  return packet;
}

export function extractTerminalBriefSidecarDryRunGateFinalizerStatus(
  input: unknown,
): TerminalBriefFinalizerApprovalStatusPacket | undefined {
  const envelope = isRecord(input) ? input : {};
  const candidates = [
    input,
    envelope.finalizerApprovalStatus,
    envelope.finalizerApprovalStatusPacket,
    envelope.finalizerStatus,
    envelope.statusTable,
    envelope.packet,
  ];
  return candidates.find(isTerminalBriefFinalizerApprovalStatusPacket);
}

export function extractTerminalBriefSidecarDryRunOperatingEvidence(
  input: unknown,
): TerminalBriefSidecarDryRunOperatingEvidenceInput {
  const envelope = isRecord(input) ? input : {};
  const candidate = envelope.operatingEvidence ?? envelope.gateEvidence ?? envelope.evidence;
  return isRecord(candidate) ? candidate as TerminalBriefSidecarDryRunOperatingEvidenceInput : {};
}

export function renderTerminalBriefSidecarDryRunGateMarkdown(
  packet: TerminalBriefSidecarDryRunGatePacket,
): string {
  return [
    titleForState(packet.state),
    "Mode: " + packet.mode,
    "Parent round: " + (packet.parentRoundId ?? "unknown"),
    "State: " + packet.state + " dryRunOnly=" + packet.dryRunOnly + " sourceOnlyNoLive=" + packet.sourceOnlyNoLive,
    "Idempotency: " + packet.idempotencyKey,
    "Sidecar: decision=" + packet.source.sidecarDecision
      + " dryRunOnly=" + packet.source.sidecarDryRunOnly
      + " providerSendAttempted=" + packet.source.providerSendAttempted
      + " terminalAckAttempted=" + packet.source.terminalAckAttempted,
    "Finalizer status: " + (packet.source.finalizerStatus ?? "missing"),
    "",
    "| Check | State | Ready | Detail |",
    "|---|---|---:|---|",
    ...packet.table.rows.map((row) => "| " + row.label + " | " + row.state + " | " + (row.ready ? "yes" : "no") + " | " + row.detail + " |"),
    "",
    "Readiness: sourceCriteriaMet=" + packet.readiness.sourceCriteriaMet
      + " alwaysOnDryRunCandidate=" + packet.readiness.alwaysOnDryRunCandidate
      + " alwaysOnDryRunStartPermitted=" + packet.readiness.alwaysOnDryRunStartPermitted
      + " defaultOnPermitted=" + packet.readiness.defaultOnPermitted
      + " liveActivationPermitted=" + packet.readiness.liveActivationPermitted
      + " missingEvidence=" + list(packet.readiness.missingEvidence),
    ...(packet.blockers.length ? ["", "Blockers:", ...packet.blockers.map((blocker) => "- " + blocker)] : []),
    "",
    "Next actions:",
    ...packet.nextActions.map((action) => "- " + action),
    "",
    "Safety: operating gate only; does not start sidecar, enable default-on, send providers, ACK/replay terminal rows, grant approval, mutate GitHub/DB/TaskFlow state, restart/deploy, replay history, release, publish, or move secrets.",
  ].join("\n");
}

function normalizeOperatingEvidence(
  input: TerminalBriefSidecarDryRunOperatingEvidenceInput,
  generatedAt: string,
  options: TerminalBriefSidecarDryRunGateOptions,
): TerminalBriefSidecarDryRunGatePacket["operatingEvidence"] {
  const nowMs = Date.parse(generatedAt);
  const maxAgeMs = Math.max(0, options.maxAgeMs ?? 5 * 60 * 1000);
  const observedAt = optionalString(input.observedAt ?? input.observed_at);
  const expiresAt = optionalString(input.expiresAt ?? input.expires_at);
  const observedAtMs = observedAt ? Date.parse(observedAt) : Number.NaN;
  const expiresAtMs = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  return {
    observedAt,
    expiresAt,
    stale: (Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs)
      || (Number.isFinite(observedAtMs) && nowMs - observedAtMs > maxAgeMs),
    cursorPersisted: booleanValue(input.cursorPersisted ?? input.cursor_persisted),
    boundedPolling: booleanValue(input.boundedPolling ?? input.bounded_polling),
    pollIntervalMs: numberValue(input.pollIntervalMs ?? input.poll_interval_ms),
    maxBatch: numberValue(input.maxBatch ?? input.max_batch),
    gatewayReady: optionalBoolean(input.gatewayReady ?? input.gateway_ready),
    eventLoopDegraded: optionalBoolean(input.eventLoopDegraded ?? input.event_loop_degraded),
    queueBacklog: numberValue(input.queueBacklog ?? input.queue_backlog),
    dryRunOnly: (input.dryRunOnly ?? input.dry_run_only) !== false,
    operatorEventsCrossBrokersEnabled: booleanValue(input.operatorEventsCrossBrokersEnabled ?? input.operator_events_cross_brokers_enabled),
    supervisedSidecar: booleanValue(input.supervisedSidecar ?? input.supervised_sidecar),
  };
}

function buildRows(
  sidecarRehearsal: TerminalBriefSidecarIntegrationRehearsal,
  finalizerStatus: TerminalBriefFinalizerApprovalStatusPacket | undefined,
  evidence: TerminalBriefSidecarDryRunGatePacket["operatingEvidence"],
  options: TerminalBriefSidecarDryRunGateOptions,
): TerminalBriefSidecarDryRunGateRow[] {
  const sidecarReady = sidecarRehearsal.decision === "candidate"
    && sidecarRehearsal.sidecar.dryRunOnly
    && !sidecarRehearsal.sidecar.providerSendAttempted
    && !sidecarRehearsal.sidecar.terminalAckAttempted
    && sidecarRehearsal.blockers.length === 0;
  const finalizerReady = finalizerStatus?.state === "ready_for_finalizer_review"
    && finalizerStatus.defaultOnReadiness.sourceCriteriaMet
    && finalizerStatus.defaultOnReadiness.defaultOnPermitted === false
    && finalizerStatus.blockers.length === 0;
  const minPollIntervalMs = options.minPollIntervalMs ?? 10_000;
  const maxBatchLimit = options.maxBatchLimit ?? 100;
  const cursorReady = evidence.cursorPersisted
    && evidence.boundedPolling
    && typeof evidence.pollIntervalMs === "number"
    && evidence.pollIntervalMs >= minPollIntervalMs
    && typeof evidence.maxBatch === "number"
    && evidence.maxBatch > 0
    && evidence.maxBatch <= maxBatchLimit;
  const maxQueueBacklog = options.maxQueueBacklog ?? 1000;
  const gatewayReady = evidence.gatewayReady === true
    && evidence.eventLoopDegraded === false
    && typeof evidence.queueBacklog === "number"
    && evidence.queueBacklog >= 0
    && evidence.queueBacklog <= maxQueueBacklog;
  const safetyReady = evidence.dryRunOnly
    && !evidence.operatorEventsCrossBrokersEnabled
    && evidence.supervisedSidecar;
  return [
    {
      name: "sidecar_rehearsal",
      label: "Sidecar rehearsal",
      state: sidecarRehearsal.decision,
      required: true,
      ready: sidecarReady,
      detail: sidecarReady
        ? "sidecar rehearsal is candidate and dry-run-only"
        : "sidecar rehearsal is missing candidate decision or has unsafe flags",
      blockers: sidecarReady ? [] : sidecarBlockers(sidecarRehearsal),
      nextAction: sidecarReady ? "verify finalizer approval status" : "rerun sidecar rehearsal with safe dry-run evidence",
    },
    {
      name: "finalizer_status",
      label: "Finalizer status",
      state: finalizerStatus?.state ?? "missing",
      required: true,
      ready: finalizerReady,
      detail: finalizerReady
        ? "finalizer approval status is ready as source-only evidence"
        : "finalizer approval status is missing, blocked, waiting, or not source-complete",
      blockers: finalizerReady ? [] : finalizerBlockers(finalizerStatus),
      nextAction: finalizerReady ? "verify cursor/polling controls" : "produce ready finalizer approval status table",
    },
    {
      name: "cursor_polling",
      label: "Cursor and polling",
      state: cursorReady ? "bounded" : "missing_or_unbounded",
      required: true,
      ready: cursorReady,
      detail: "cursorPersisted=" + evidence.cursorPersisted
        + " boundedPolling=" + evidence.boundedPolling
        + " pollIntervalMs=" + (evidence.pollIntervalMs ?? "missing")
        + " maxBatch=" + (evidence.maxBatch ?? "missing"),
      blockers: cursorReady ? [] : ["bounded cursor/polling evidence is missing or outside limits"],
      nextAction: cursorReady ? "verify Gateway load evidence" : "provide cursor persistence and bounded polling evidence",
    },
    {
      name: "gateway_load",
      label: "Gateway load",
      state: gatewayReady ? "healthy" : evidence.stale ? "stale" : "missing_or_degraded",
      required: true,
      ready: gatewayReady && !evidence.stale,
      detail: "gatewayReady=" + (evidence.gatewayReady ?? "missing")
        + " eventLoopDegraded=" + (evidence.eventLoopDegraded ?? "missing")
        + " queueBacklog=" + (evidence.queueBacklog ?? "missing")
        + " stale=" + evidence.stale,
      blockers: gatewayReady && !evidence.stale ? [] : ["fresh Gateway ready/event-loop/queue evidence is missing, stale, or degraded"],
      nextAction: gatewayReady && !evidence.stale ? "verify safety boundary" : "collect fresh Gateway readiness and event-loop evidence",
    },
    {
      name: "safety_boundary",
      label: "Safety boundary",
      state: safetyReady ? "dry_run_supervised" : "unsafe_or_unsupervised",
      required: true,
      ready: safetyReady,
      detail: "dryRunOnly=" + evidence.dryRunOnly
        + " crossBrokers=" + evidence.operatorEventsCrossBrokersEnabled
        + " supervisedSidecar=" + evidence.supervisedSidecar,
      blockers: safetyReady ? [] : ["dry-run-only supervised sidecar boundary is not proven"],
      nextAction: safetyReady ? "request operator approval before starting dry-run sidecar" : "disable cross-broker operator events and prove supervised sidecar mode",
    },
    {
      name: "live_activation",
      label: "Live/default-on activation",
      state: "not_permitted_source_only",
      required: false,
      ready: false,
      detail: "this gate never enables live/default-on behavior",
      blockers: ["live/default-on activation requires separate approval, canary, and deployment step"],
      nextAction: "keep live/default-on activation out of this source-only gate",
    },
  ];
}

function buildBlockers(
  sidecarRehearsal: TerminalBriefSidecarIntegrationRehearsal,
  finalizerStatus: TerminalBriefFinalizerApprovalStatusPacket | undefined,
  evidence: TerminalBriefSidecarDryRunGatePacket["operatingEvidence"],
  rows: TerminalBriefSidecarDryRunGateRow[],
): string[] {
  const blockers = [
    ...sidecarRehearsal.blockers,
    ...(finalizerStatus?.blockers ?? []),
    ...rows.filter((row) => row.required && !row.ready).flatMap((row) => row.blockers),
  ];
  if (evidence.stale) blockers.push("operating evidence is stale or expired");
  return unique(blockers.filter(Boolean));
}

function stateFor(
  sidecarRehearsal: TerminalBriefSidecarIntegrationRehearsal,
  finalizerStatus: TerminalBriefFinalizerApprovalStatusPacket | undefined,
  evidence: TerminalBriefSidecarDryRunGatePacket["operatingEvidence"],
  blockers: string[],
  rows: TerminalBriefSidecarDryRunGateRow[],
): TerminalBriefSidecarDryRunGateState {
  if (sidecarRehearsal.decision === "blocked" || finalizerStatus?.state === "blocked") return "blocked";
  if (evidence.stale) return "stale";
  if (!finalizerStatus || finalizerStatus.state !== "ready_for_finalizer_review") return "waiting_for_finalizer_status";
  if (rows.some((row) => row.required && !row.ready)) return "waiting_for_operating_evidence";
  if (blockers.length > 0) return "blocked";
  return "ready_for_operator_approval";
}

function buildReadiness(
  state: TerminalBriefSidecarDryRunGateState,
  rows: TerminalBriefSidecarDryRunGateRow[],
  blockers: string[],
): TerminalBriefSidecarDryRunGatePacket["readiness"] {
  const missingEvidence = rows
    .filter((row) => row.required && !row.ready)
    .map((row) => row.name);
  const sourceCriteriaMet = state === "ready_for_operator_approval" && missingEvidence.length === 0 && blockers.length === 0;
  return {
    sourceCriteriaMet,
    alwaysOnDryRunCandidate: sourceCriteriaMet,
    alwaysOnDryRunStartPermitted: false,
    defaultOnPermitted: false,
    liveActivationPermitted: false,
    missingEvidence,
    blockers: [
      ...blockers,
      "starting always-on dry-run sidecar still requires separate operator approval",
      "default-on/live activation remains out of scope",
    ],
    nextAction: sourceCriteriaMet
      ? "request explicit operator approval for dry-run sidecar supervision/canary"
      : "resolve missing source evidence before any sidecar dry-run start request",
  };
}

function sidecarBlockers(rehearsal: TerminalBriefSidecarIntegrationRehearsal): string[] {
  return [
    ...rehearsal.blockers,
    ...(rehearsal.decision !== "candidate" ? ["sidecar rehearsal is not a candidate"] : []),
    ...(!rehearsal.sidecar.dryRunOnly ? ["sidecar spool is not dry-run-only"] : []),
    ...(rehearsal.sidecar.providerSendAttempted ? ["sidecar attempted provider send"] : []),
    ...(rehearsal.sidecar.terminalAckAttempted ? ["sidecar attempted terminal ACK"] : []),
  ];
}

function finalizerBlockers(status?: TerminalBriefFinalizerApprovalStatusPacket): string[] {
  if (!status) return ["finalizer approval status packet is missing"];
  return [
    ...status.blockers,
    ...(status.state !== "ready_for_finalizer_review" ? ["finalizer approval status is not ready_for_finalizer_review"] : []),
    ...(!status.defaultOnReadiness.sourceCriteriaMet ? ["finalizer source criteria are not met"] : []),
    ...(status.defaultOnReadiness.defaultOnPermitted !== false ? ["finalizer status unexpectedly permits default-on"] : []),
  ];
}

function nextActionsFor(state: TerminalBriefSidecarDryRunGateState): string[] {
  if (state === "ready_for_operator_approval") {
    return [
      "broker finalizer can request explicit approval for supervised always-on dry-run sidecar operation",
      "keep default-on/live send/terminal ACK/deploy/DB mutation behind separate approval and canary gates",
    ];
  }
  if (state === "waiting_for_finalizer_status") {
    return [
      "produce a ready finalizer approval status table",
      "do not start always-on dry-run sidecar from sidecar rehearsal alone",
    ];
  }
  if (state === "waiting_for_operating_evidence") {
    return [
      "provide bounded cursor/polling, Gateway readiness, event-loop, queue, and supervised dry-run evidence",
      "keep sidecar disabled or one-shot dry-run until operating evidence is complete",
    ];
  }
  if (state === "stale") {
    return [
      "refresh operating evidence before requesting dry-run sidecar operation",
      "do not rely on stale Gateway/event-loop evidence",
    ];
  }
  return [
    "resolve blocked sidecar/finalizer evidence before requesting dry-run operation",
    "do not start sidecar, send providers, ACK terminal rows, or mutate state from a blocked gate",
  ];
}

function buildGateIdempotencyKey(
  sidecarRehearsal: TerminalBriefSidecarIntegrationRehearsal,
  finalizerStatus: TerminalBriefFinalizerApprovalStatusPacket | undefined,
  evidence: TerminalBriefSidecarDryRunGatePacket["operatingEvidence"],
  state: TerminalBriefSidecarDryRunGateState,
): string {
  const base = JSON.stringify({
    label: "terminal-brief-sidecar-dry-run-gate",
    parentRoundId: finalizerStatus?.parentRoundId ?? sidecarRehearsal.parentRoundId ?? "unknown",
    sidecarDecision: sidecarRehearsal.decision,
    sidecarSpoolRecords: sidecarRehearsal.sidecar.spoolRecords,
    finalCountId: sidecarRehearsal.finalCountCandidate?.idempotencyKey,
    finalizerStatus: finalizerStatus?.idempotencyKey ?? "missing",
    evidence,
    state,
  });
  return "tb-sidecar-dry-run-gate:" + createHash("sha256").update(base).digest("hex").slice(0, 24);
}

function titleForState(state: TerminalBriefSidecarDryRunGateState): string {
  if (state === "ready_for_operator_approval") return "Ready: Terminal Brief sidecar always-on dry-run gate";
  if (state === "waiting_for_finalizer_status") return "Waiting: Terminal Brief finalizer status";
  if (state === "waiting_for_operating_evidence") return "Waiting: Terminal Brief sidecar operating evidence";
  if (state === "stale") return "Stale: Terminal Brief sidecar operating evidence";
  return "Blocked: Terminal Brief sidecar always-on dry-run gate";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function list(items: unknown[]): string {
  return items.length ? items.join(",") : "none";
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function isTerminalBriefSidecarIntegrationRehearsal(value: unknown): value is TerminalBriefSidecarIntegrationRehearsal {
  return isRecord(value) && value.kind === "a2a-broker.terminal-brief-sidecar-integration-rehearsal";
}

function isTerminalBriefFinalizerApprovalStatusPacket(value: unknown): value is TerminalBriefFinalizerApprovalStatusPacket {
  return isRecord(value) && value.kind === "a2a-broker.terminal-brief-finalizer-approval-status.packet";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
