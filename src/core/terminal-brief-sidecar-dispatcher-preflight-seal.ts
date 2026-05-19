import { createHash } from "node:crypto";

import type { TerminalBriefSidecarExecutorDispatchRequestDraftPacket } from "./terminal-brief-sidecar-executor-dispatch-request-draft.js";

export type TerminalBriefSidecarDispatcherPreflightSealState =
  | "dispatcher_preflight_seal_ready"
  | "waiting_for_dispatch_request_draft"
  | "runtime_evidence_missing"
  | "runtime_evidence_stale"
  | "integrity_failed"
  | "blocked";

export interface TerminalBriefSidecarDispatcherRuntimeEvidence {
  observedAt?: string;
  maxAgeMs?: number;
  gatewayReady?: boolean;
  eventLoopDegraded?: boolean;
  queueBacklogOk?: boolean;
  dryRunOnlyProven?: boolean;
  cursorPersistenceProven?: boolean;
  boundedPollingProven?: boolean;
  secretBoundaryProven?: boolean;
  operatorEventsScopeProven?: boolean;
  terminalEvidencePathProven?: boolean;
  rollbackPathProven?: boolean;
  envelopeHash?: string;
}

export interface TerminalBriefSidecarDispatcherPreflightSealOptions {
  now?: string;
  mode?: string;
  sealOwner?: string;
  seal_owner?: string;
  sealReference?: string;
  seal_reference?: string;
  envelopeExpiresAt?: string;
  envelope_expires_at?: string;
}

export interface TerminalBriefSidecarDispatcherPreflightSealPacket {
  kind: "a2a-broker.terminal-brief-sidecar-dispatcher-preflight-seal.packet";
  version: 1;
  generatedAt: string;
  mode: string;
  parentRoundId?: string;
  state: TerminalBriefSidecarDispatcherPreflightSealState;
  dryRunOnly: true;
  sourceOnlyNoLive: true;
  idempotencyKey: string;
  source: {
    dispatchDraftState: TerminalBriefSidecarExecutorDispatchRequestDraftPacket["state"];
    dispatchDraftIdempotencyKey: string;
    dispatchRequestReference: string;
    executorAdapterId: string;
    executionGateReference: string;
    operatorTarget: string;
  };
  runtimeEvidence: {
    suppliedOnly: true;
    observedAt?: string;
    maxAgeMs: number;
    fresh: boolean;
    rows: Array<{
      id: string;
      label: string;
      status: "ready" | "missing" | "stale" | "blocked";
      evidence: string[];
    }>;
  };
  sealedEnvelope: {
    sealOnly: true;
    sealOwner: string;
    sealReference: string;
    envelopeHash: string;
    expiresAt: string;
    integrityVerified: boolean;
    commandIntent: string;
    transport: "json-stdin-stdout";
    metadataOnly: true;
    secretValuesIncluded: false;
    writesRuntimeState: false;
  };
  readiness: {
    sourceCriteriaMet: boolean;
    dispatcherPreflightSealReady: boolean;
    approvalRequestDispatchPermitted: false;
    approvalGrantPermitted: false;
    approvalGrantExecutionPermitted: false;
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
    dispatcherPreflightSealVersion: 1;
    harnessNeutral: true;
    openclawMessageSendRequired: false;
    hermesAdapterCompatible: true;
    gongyungAdapterCompatible: true;
    externalHarnessCompatible: true;
    consumesExecutorDispatchRequestDraftPacket: true;
    rendersDispatcherPreflightSeal: true;
    collectsLiveEvidence: false;
    sendsApprovalRequest: false;
    grantsApproval: false;
    executesApprovalGrant: false;
    dispatchesStartExecutor: false;
    invokesExecutor: false;
    spawnsProcess: false;
    startsSidecar: false;
    enablesDefaultOn: false;
    executesAction: false;
  };
  semantics: {
    dispatcherPreflightSealOnly: true;
    sourceOnlyNoLive: true;
    suppliedEvidenceOnly: true;
    sealDoesNotDispatchExecutor: true;
    sealDoesNotAuthorizeRuntime: true;
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

export function buildTerminalBriefSidecarDispatcherPreflightSeal(
  dispatchDraft: TerminalBriefSidecarExecutorDispatchRequestDraftPacket,
  evidence: TerminalBriefSidecarDispatcherRuntimeEvidence = {},
  options: TerminalBriefSidecarDispatcherPreflightSealOptions = {},
): TerminalBriefSidecarDispatcherPreflightSealPacket {
  const generatedAt = options.now ?? new Date().toISOString();
  const sealReference = options.sealReference ?? options.seal_reference ?? buildSealReference(dispatchDraft);
  const envelopeHash = buildEnvelopeHash(dispatchDraft, sealReference);
  const expectedEnvelopeHash = evidence.envelopeHash ?? envelopeHash;
  const integrityVerified = expectedEnvelopeHash === envelopeHash;
  const runtimeRows = buildRuntimeRows(evidence, generatedAt);
  const sourceBlockers = buildSourceBlockers(dispatchDraft);
  const runtimeBlockers = runtimeRows.filter((row) => row.status !== "ready").map((row) => row.label + " is " + row.status);
  const blockers = unique([
    ...sourceBlockers,
    ...runtimeBlockers,
    ...(!integrityVerified ? ["sealed envelope integrity failed"] : []),
  ]);
  const state = stateFor(dispatchDraft, runtimeRows, integrityVerified, blockers);
  const expiresAt = options.envelopeExpiresAt ?? options.envelope_expires_at ?? new Date(Date.parse(generatedAt) + 10 * 60 * 1000).toISOString();

  return {
    kind: "a2a-broker.terminal-brief-sidecar-dispatcher-preflight-seal.packet",
    version: 1,
    generatedAt,
    mode: options.mode ?? dispatchDraft.mode,
    parentRoundId: dispatchDraft.parentRoundId,
    state,
    dryRunOnly: true,
    sourceOnlyNoLive: true,
    idempotencyKey: buildSealIdempotencyKey(dispatchDraft, sealReference, generatedAt, state),
    source: {
      dispatchDraftState: dispatchDraft.state,
      dispatchDraftIdempotencyKey: dispatchDraft.idempotencyKey,
      dispatchRequestReference: dispatchDraft.dispatchRequestDraft.dispatchRequestReference,
      executorAdapterId: dispatchDraft.dispatchRequestDraft.executorAdapterId,
      executionGateReference: dispatchDraft.source.executionGateReference,
      operatorTarget: dispatchDraft.source.operatorTarget,
    },
    runtimeEvidence: {
      suppliedOnly: true,
      observedAt: evidence.observedAt,
      maxAgeMs: evidence.maxAgeMs ?? 5 * 60 * 1000,
      fresh: runtimeRows.every((row) => row.status === "ready"),
      rows: runtimeRows,
    },
    sealedEnvelope: {
      sealOnly: true,
      sealOwner: options.sealOwner ?? options.seal_owner ?? "broker-finalizer",
      sealReference,
      envelopeHash,
      expiresAt,
      integrityVerified,
      commandIntent: dispatchDraft.dispatchRequestDraft.commandMetadata.commandIntent,
      transport: dispatchDraft.dispatchRequestDraft.commandMetadata.transport,
      metadataOnly: true,
      secretValuesIncluded: false,
      writesRuntimeState: false,
    },
    readiness: {
      sourceCriteriaMet: state === "dispatcher_preflight_seal_ready",
      dispatcherPreflightSealReady: state === "dispatcher_preflight_seal_ready",
      approvalRequestDispatchPermitted: false,
      approvalGrantPermitted: false,
      approvalGrantExecutionPermitted: false,
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
      missingEvidence: missingEvidenceFor(runtimeRows),
      blockers: [
        ...blockers,
        "dispatcher preflight seal is not executor dispatch",
        "runtime execution requires later separate approved dispatcher path",
      ],
      nextAction: nextActionFor(state),
    },
    blockers,
    nextActions: nextActionsFor(state),
    approvalSensitiveActionsExcluded: approvalSensitiveActionsExcluded(),
    integrationContract: {
      transport: "json",
      dispatcherPreflightSealVersion: 1,
      harnessNeutral: true,
      openclawMessageSendRequired: false,
      hermesAdapterCompatible: true,
      gongyungAdapterCompatible: true,
      externalHarnessCompatible: true,
      consumesExecutorDispatchRequestDraftPacket: true,
      rendersDispatcherPreflightSeal: true,
      collectsLiveEvidence: false,
      sendsApprovalRequest: false,
      grantsApproval: false,
      executesApprovalGrant: false,
      dispatchesStartExecutor: false,
      invokesExecutor: false,
      spawnsProcess: false,
      startsSidecar: false,
      enablesDefaultOn: false,
      executesAction: false,
    },
    semantics: {
      dispatcherPreflightSealOnly: true,
      sourceOnlyNoLive: true,
      suppliedEvidenceOnly: true,
      sealDoesNotDispatchExecutor: true,
      sealDoesNotAuthorizeRuntime: true,
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

export function extractTerminalBriefSidecarDispatcherPreflightSealDraft(input: unknown): TerminalBriefSidecarExecutorDispatchRequestDraftPacket {
  const envelope = isRecord(input) ? input : {};
  const candidates = [input, envelope.executorDispatchRequestDraftPacket, envelope.dispatchRequestDraftPacket, envelope.sidecarExecutorDispatchRequestDraftPacket, envelope.packet];
  const packet = candidates.find(isTerminalBriefSidecarExecutorDispatchRequestDraftPacket);
  if (!packet) throw new Error("expected a Terminal Brief sidecar executor dispatch request draft packet");
  return packet;
}

export function extractTerminalBriefSidecarDispatcherRuntimeEvidence(input: unknown): TerminalBriefSidecarDispatcherRuntimeEvidence {
  const envelope = isRecord(input) ? input : {};
  const candidate = envelope.runtimeEvidence ?? envelope.dispatcherRuntimeEvidence ?? envelope.preflightEvidence ?? envelope.evidence;
  return isRecord(candidate) ? candidate as TerminalBriefSidecarDispatcherRuntimeEvidence : {};
}

export function extractTerminalBriefSidecarDispatcherPreflightSealOptions(input: unknown): TerminalBriefSidecarDispatcherPreflightSealOptions {
  const envelope = isRecord(input) ? input : {};
  const candidate = envelope.dispatcherPreflightSeal ?? envelope.dispatcherPreflightSealOptions ?? envelope.options;
  return isRecord(candidate) ? candidate as TerminalBriefSidecarDispatcherPreflightSealOptions : {};
}

export function renderTerminalBriefSidecarDispatcherPreflightSealMarkdown(packet: TerminalBriefSidecarDispatcherPreflightSealPacket): string {
  return [
    titleForState(packet.state),
    "Mode: " + packet.mode,
    "Parent round: " + (packet.parentRoundId ?? "unknown"),
    "State: " + packet.state + " dryRunOnly=" + packet.dryRunOnly + " sourceOnlyNoLive=" + packet.sourceOnlyNoLive,
    "Idempotency: " + packet.idempotencyKey,
    "Source dispatch draft: state=" + packet.source.dispatchDraftState + " reference=" + packet.source.dispatchRequestReference,
    "Seal: reference=" + packet.sealedEnvelope.sealReference + " integrityVerified=" + packet.sealedEnvelope.integrityVerified + " expiresAt=" + packet.sealedEnvelope.expiresAt,
    "Readiness: dispatcherPreflightSealReady=" + packet.readiness.dispatcherPreflightSealReady
      + " startExecutorDispatchPermitted=" + packet.readiness.startExecutorDispatchPermitted
      + " executorInvocationPermitted=" + packet.readiness.executorInvocationPermitted
      + " processSpawnPermitted=" + packet.readiness.processSpawnPermitted
      + " sidecarStartPermitted=" + packet.readiness.sidecarStartPermitted
      + " executionPermitted=" + packet.readiness.executionPermitted,
    ...(packet.blockers.length ? ["", "Blockers:", ...packet.blockers.map((blocker) => "- " + blocker)] : []),
    "",
    "Next actions:",
    ...packet.nextActions.map((action) => "- " + action),
    "",
    "Safety: dispatcher preflight seal only; does not dispatch/invoke executor, spawn a process, start sidecar, enable default-on, send providers, ACK/replay terminal rows, mutate GitHub/DB/TaskFlow state, restart/deploy, replay history, release, publish, or move secrets.",
  ].join("\n");
}

function buildRuntimeRows(evidence: TerminalBriefSidecarDispatcherRuntimeEvidence, now: string): TerminalBriefSidecarDispatcherPreflightSealPacket["runtimeEvidence"]["rows"] {
  const fresh = isFresh(evidence.observedAt, now, evidence.maxAgeMs ?? 5 * 60 * 1000);
  const row = (id: string, label: string, ok?: boolean, detail?: string) => ({
    id,
    label,
    status: !evidence.observedAt ? "missing" as const : !fresh ? "stale" as const : ok ? "ready" as const : "blocked" as const,
    evidence: [detail ?? String(ok ?? false)],
  });
  return [
    row("gateway_ready", "Gateway readiness", evidence.gatewayReady),
    row("event_loop", "Event loop not degraded", evidence.eventLoopDegraded === false),
    row("queue_backlog", "Queue backlog within approved limit", evidence.queueBacklogOk),
    row("dry_run_only", "Dry-run-only mode proven", evidence.dryRunOnlyProven),
    row("cursor_persistence", "Cursor persistence proven", evidence.cursorPersistenceProven),
    row("bounded_polling", "Bounded polling proven", evidence.boundedPollingProven),
    row("secret_boundary", "Secret boundary proven", evidence.secretBoundaryProven),
    row("operator_events_scope", "operatorEvents scope proven", evidence.operatorEventsScopeProven),
    row("terminal_evidence_path", "Terminal evidence path proven", evidence.terminalEvidencePathProven),
    row("rollback_path", "Rollback path proven", evidence.rollbackPathProven),
  ];
}

function buildSourceBlockers(draft: TerminalBriefSidecarExecutorDispatchRequestDraftPacket): string[] {
  return unique([
    ...draft.blockers,
    ...(draft.state !== "dispatch_request_draft_ready" ? ["dispatch request draft state is " + draft.state] : []),
    ...(!draft.readiness.dispatchRequestDraftReady ? ["dispatch request draft is not ready"] : []),
    ...(draft.readiness.startExecutorDispatchPermitted !== false ? ["draft unexpectedly permits executor dispatch"] : []),
    ...(draft.readiness.executorInvocationPermitted !== false ? ["draft unexpectedly permits executor invocation"] : []),
    ...(draft.readiness.processSpawnPermitted !== false ? ["draft unexpectedly permits process spawn"] : []),
    ...(draft.readiness.sidecarStartPermitted !== false ? ["draft unexpectedly permits sidecar start"] : []),
    ...(draft.readiness.providerSendPermitted !== false ? ["draft unexpectedly permits provider send"] : []),
    ...(draft.readiness.terminalAckPermitted !== false ? ["draft unexpectedly permits terminal ACK"] : []),
    ...(draft.readiness.executionPermitted !== false ? ["draft unexpectedly permits execution"] : []),
    ...(draft.readiness.dbMutationPermitted !== false ? ["draft unexpectedly permits DB mutation"] : []),
    ...(draft.dispatchRequestDraft.commandMetadata.secretValuesIncluded ? ["draft unexpectedly includes secret values"] : []),
    ...(draft.dispatchRequestDraft.commandMetadata.writesRuntimeState ? ["draft unexpectedly writes runtime state"] : []),
    ...(draft.integrationContract.dispatchesStartExecutor ? ["draft unexpectedly dispatches start executor"] : []),
    ...(draft.integrationContract.invokesExecutor ? ["draft unexpectedly invokes executor"] : []),
    ...(draft.integrationContract.spawnsProcess ? ["draft unexpectedly spawns process"] : []),
    ...(draft.integrationContract.startsSidecar ? ["draft unexpectedly starts sidecar"] : []),
    ...(draft.integrationContract.executesAction ? ["draft unexpectedly executes action"] : []),
    ...(draft.semantics.performsProviderSend ? ["draft unexpectedly performs provider send"] : []),
    ...(draft.semantics.performsTerminalAck ? ["draft unexpectedly performs terminal ACK"] : []),
    ...(draft.semantics.performsRuntimeRestartOrDeploy ? ["draft unexpectedly performs restart/deploy"] : []),
    ...(draft.semantics.performsDbMutation ? ["draft unexpectedly performs DB mutation"] : []),
    ...(draft.semantics.movesSecretsOrCredentials ? ["draft unexpectedly moves secrets/credentials"] : []),
  ].filter(Boolean));
}

function stateFor(
  draft: TerminalBriefSidecarExecutorDispatchRequestDraftPacket,
  rows: TerminalBriefSidecarDispatcherPreflightSealPacket["runtimeEvidence"]["rows"],
  integrityVerified: boolean,
  blockers: string[],
): TerminalBriefSidecarDispatcherPreflightSealState {
  if (draft.state !== "dispatch_request_draft_ready") return "waiting_for_dispatch_request_draft";
  if (!integrityVerified) return "integrity_failed";
  if (rows.some((row) => row.status === "missing")) return "runtime_evidence_missing";
  if (rows.some((row) => row.status === "stale")) return "runtime_evidence_stale";
  if (blockers.length) return "blocked";
  return "dispatcher_preflight_seal_ready";
}

function missingEvidenceFor(rows: TerminalBriefSidecarDispatcherPreflightSealPacket["runtimeEvidence"]["rows"]): string[] {
  return rows.filter((row) => row.status !== "ready").map((row) => row.id);
}

function nextActionFor(state: TerminalBriefSidecarDispatcherPreflightSealState): string {
  if (state === "dispatcher_preflight_seal_ready") return "broker finalizer may review the sealed preflight before any later separately approved dispatcher path; this packet dispatches nothing";
  if (state === "waiting_for_dispatch_request_draft") return "wait for ready executor dispatch request draft";
  if (state === "runtime_evidence_missing") return "supply runtime preflight evidence from an approved source";
  if (state === "runtime_evidence_stale") return "refresh runtime preflight evidence";
  if (state === "integrity_failed") return "rebuild sealed envelope from the current dispatch request draft";
  return "resolve blocked dispatcher preflight seal evidence";
}

function nextActionsFor(state: TerminalBriefSidecarDispatcherPreflightSealState): string[] {
  return [nextActionFor(state), "do not dispatch executor, invoke executor, spawn process, start sidecar, ACK terminal rows, or mutate state from this packet"];
}

function isFresh(observedAt: string | undefined, now: string, maxAgeMs: number): boolean {
  if (!observedAt) return false;
  return Date.parse(now) - Date.parse(observedAt) <= maxAgeMs;
}

function buildSealReference(draft: TerminalBriefSidecarExecutorDispatchRequestDraftPacket): string {
  return "dispatcher-preflight-seal:" + createHash("sha256").update(draft.idempotencyKey).digest("hex").slice(0, 16);
}

function buildEnvelopeHash(draft: TerminalBriefSidecarExecutorDispatchRequestDraftPacket, sealReference: string): string {
  const base = JSON.stringify({
    sealReference,
    draft: draft.idempotencyKey,
    dispatchRequestReference: draft.dispatchRequestDraft.dispatchRequestReference,
    executorAdapterId: draft.dispatchRequestDraft.executorAdapterId,
    commandMetadata: draft.dispatchRequestDraft.commandMetadata,
    evidenceReferences: draft.dispatchRequestDraft.evidenceReferences,
  });
  return "sha256:" + createHash("sha256").update(base).digest("hex");
}

function buildSealIdempotencyKey(
  draft: TerminalBriefSidecarExecutorDispatchRequestDraftPacket,
  sealReference: string,
  generatedAt: string,
  state: TerminalBriefSidecarDispatcherPreflightSealState,
): string {
  const base = JSON.stringify({ label: "terminal-brief-sidecar-dispatcher-preflight-seal", draft: draft.idempotencyKey, sealReference, generatedAt, state });
  return "tb-sidecar-dispatcher-preflight-seal:" + createHash("sha256").update(base).digest("hex").slice(0, 24);
}

function titleForState(state: TerminalBriefSidecarDispatcherPreflightSealState): string {
  if (state === "dispatcher_preflight_seal_ready") return "Ready: Terminal Brief sidecar dispatcher preflight seal";
  if (state === "waiting_for_dispatch_request_draft") return "Waiting: Terminal Brief sidecar dispatch request draft";
  if (state === "runtime_evidence_missing") return "Missing evidence: Terminal Brief sidecar dispatcher preflight seal";
  if (state === "runtime_evidence_stale") return "Stale evidence: Terminal Brief sidecar dispatcher preflight seal";
  if (state === "integrity_failed") return "Integrity failed: Terminal Brief sidecar dispatcher preflight seal";
  return "Blocked: Terminal Brief sidecar dispatcher preflight seal";
}

function approvalSensitiveActionsExcluded(): string[] {
  return [
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
  ];
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function isTerminalBriefSidecarExecutorDispatchRequestDraftPacket(value: unknown): value is TerminalBriefSidecarExecutorDispatchRequestDraftPacket {
  return isRecord(value) && value.kind === "a2a-broker.terminal-brief-sidecar-executor-dispatch-request-draft.packet";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
