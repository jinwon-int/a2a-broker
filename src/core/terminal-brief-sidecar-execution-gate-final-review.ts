import { createHash } from "node:crypto";

import type { TerminalBriefSidecarApprovalGrantEvidenceIngestorPacket } from "./terminal-brief-sidecar-approval-grant-evidence-ingestor.js";

export type TerminalBriefSidecarExecutionGateFinalReviewState =
  | "ready_for_execution_gate_final_review"
  | "waiting_for_grant_evidence"
  | "grant_rejected"
  | "more_evidence_requested"
  | "stale"
  | "conflicting"
  | "blocked";

export interface TerminalBriefSidecarExecutionGateFinalReviewOptions {
  now?: string;
  mode?: string;
  reviewOwner?: string;
  review_owner?: string;
  executionGateReference?: string;
  execution_gate_reference?: string;
}

export interface TerminalBriefSidecarExecutionGateFinalReviewPacket {
  kind: "a2a-broker.terminal-brief-sidecar-execution-gate-final-review.packet";
  version: 1;
  generatedAt: string;
  mode: string;
  parentRoundId?: string;
  state: TerminalBriefSidecarExecutionGateFinalReviewState;
  dryRunOnly: true;
  sourceOnlyNoLive: true;
  idempotencyKey: string;
  source: {
    grantEvidenceState: TerminalBriefSidecarApprovalGrantEvidenceIngestorPacket["state"];
    grantEvidenceIdempotencyKey: string;
    grantEvidenceAccepted: boolean;
    grantReference: string;
    operatorTarget: string;
    reviewReference?: string;
    requiredGrant: string;
  };
  finalReview: {
    reviewOnly: true;
    reviewOwner: string;
    executionGateReference: string;
    checklist: Array<{
      id: string;
      label: string;
      status: "ready" | "blocked";
      evidence: string[];
      permitted: false;
    }>;
    abortConditions: string[];
    rollbackChecklist: string[];
  };
  readiness: {
    sourceCriteriaMet: boolean;
    finalReviewReady: boolean;
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
    executionGateFinalReviewVersion: 1;
    harnessNeutral: true;
    openclawMessageSendRequired: false;
    hermesAdapterCompatible: true;
    gongyungAdapterCompatible: true;
    externalHarnessCompatible: true;
    consumesApprovalGrantEvidenceIngestorPacket: true;
    rendersExecutionGateFinalReview: true;
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
    executionGateFinalReviewOnly: true;
    sourceOnlyNoLive: true;
    reviewDoesNotDispatchExecutor: true;
    acceptedGrantEvidenceDoesNotAuthorizeRuntime: true;
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

export function buildTerminalBriefSidecarExecutionGateFinalReview(
  grantEvidence: TerminalBriefSidecarApprovalGrantEvidenceIngestorPacket,
  options: TerminalBriefSidecarExecutionGateFinalReviewOptions = {},
): TerminalBriefSidecarExecutionGateFinalReviewPacket {
  const generatedAt = options.now ?? new Date().toISOString();
  const blockers = buildSourceBlockers(grantEvidence);
  const state = stateFor(grantEvidence, blockers);
  const executionGateReference = options.executionGateReference ?? options.execution_gate_reference ?? buildExecutionGateReference(grantEvidence);
  return {
    kind: "a2a-broker.terminal-brief-sidecar-execution-gate-final-review.packet",
    version: 1,
    generatedAt,
    mode: options.mode ?? grantEvidence.mode,
    parentRoundId: grantEvidence.parentRoundId,
    state,
    dryRunOnly: true,
    sourceOnlyNoLive: true,
    idempotencyKey: buildExecutionGateFinalReviewIdempotencyKey(grantEvidence, executionGateReference, generatedAt, state),
    source: {
      grantEvidenceState: grantEvidence.state,
      grantEvidenceIdempotencyKey: grantEvidence.idempotencyKey,
      grantEvidenceAccepted: grantEvidence.readiness.grantEvidenceAccepted,
      grantReference: grantEvidence.source.grantReference,
      operatorTarget: grantEvidence.source.operatorTarget,
      reviewReference: grantEvidence.source.reviewReference,
      requiredGrant: grantEvidence.source.requiredGrant,
    },
    finalReview: {
      reviewOnly: true,
      reviewOwner: options.reviewOwner ?? options.review_owner ?? "broker-finalizer",
      executionGateReference,
      checklist: buildChecklist(grantEvidence, state),
      abortConditions: [
        "gateway readiness is degraded",
        "event loop is degraded",
        "queue backlog exceeds approved limit",
        "sidecar dry-run-only mode cannot be proven",
        "cursor persistence cannot be proven",
        "secret boundary cannot be proven",
        "operatorEvents scope cannot be proven",
        "terminal evidence path cannot be proven",
        "any live provider send or terminal ACK is requested by this packet",
      ],
      rollbackChecklist: [
        "do not dispatch or invoke executor from this packet",
        "do not spawn a process or start sidecar from this packet",
        "keep default-on disabled",
        "collect fresh finalizer approval before any later runtime path",
        "record sanitized evidence only",
      ],
    },
    readiness: {
      sourceCriteriaMet: state === "ready_for_execution_gate_final_review",
      finalReviewReady: state === "ready_for_execution_gate_final_review",
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
      missingEvidence: missingEvidenceFor(grantEvidence),
      blockers: [
        ...blockers,
        "execution gate final review is not executor dispatch",
        "runtime execution requires later separate approved path",
      ],
      nextAction: nextActionFor(state),
    },
    blockers,
    nextActions: nextActionsFor(state),
    approvalSensitiveActionsExcluded: approvalSensitiveActionsExcluded(),
    integrationContract: {
      transport: "json",
      executionGateFinalReviewVersion: 1,
      harnessNeutral: true,
      openclawMessageSendRequired: false,
      hermesAdapterCompatible: true,
      gongyungAdapterCompatible: true,
      externalHarnessCompatible: true,
      consumesApprovalGrantEvidenceIngestorPacket: true,
      rendersExecutionGateFinalReview: true,
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
      executionGateFinalReviewOnly: true,
      sourceOnlyNoLive: true,
      reviewDoesNotDispatchExecutor: true,
      acceptedGrantEvidenceDoesNotAuthorizeRuntime: true,
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

export function extractTerminalBriefSidecarExecutionGateFinalReviewGrantEvidence(
  input: unknown,
): TerminalBriefSidecarApprovalGrantEvidenceIngestorPacket {
  const envelope = isRecord(input) ? input : {};
  const candidates = [input, envelope.approvalGrantEvidenceIngestorPacket, envelope.grantEvidenceIngestorPacket, envelope.sidecarApprovalGrantEvidencePacket, envelope.packet];
  const packet = candidates.find(isTerminalBriefSidecarApprovalGrantEvidenceIngestorPacket);
  if (!packet) throw new Error("expected a Terminal Brief sidecar approval grant evidence ingestor packet");
  return packet;
}

export function extractTerminalBriefSidecarExecutionGateFinalReviewOptions(
  input: unknown,
): TerminalBriefSidecarExecutionGateFinalReviewOptions {
  const envelope = isRecord(input) ? input : {};
  const candidate = envelope.executionGateFinalReview ?? envelope.executionGateFinalReviewOptions ?? envelope.options;
  return isRecord(candidate) ? candidate as TerminalBriefSidecarExecutionGateFinalReviewOptions : {};
}

export function renderTerminalBriefSidecarExecutionGateFinalReviewMarkdown(
  packet: TerminalBriefSidecarExecutionGateFinalReviewPacket,
): string {
  return [
    titleForState(packet.state),
    "Mode: " + packet.mode,
    "Parent round: " + (packet.parentRoundId ?? "unknown"),
    "State: " + packet.state + " dryRunOnly=" + packet.dryRunOnly + " sourceOnlyNoLive=" + packet.sourceOnlyNoLive,
    "Idempotency: " + packet.idempotencyKey,
    "Source grant evidence: state=" + packet.source.grantEvidenceState
      + " accepted=" + packet.source.grantEvidenceAccepted
      + " grantReference=" + packet.source.grantReference,
    "Final review: reference=" + packet.finalReview.executionGateReference
      + " reviewOnly=" + packet.finalReview.reviewOnly
      + " checklistRows=" + packet.finalReview.checklist.length,
    "Readiness: finalReviewReady=" + packet.readiness.finalReviewReady
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
    "Safety: final review only; does not dispatch/invoke executor, spawn a process, start sidecar, enable default-on, send providers, ACK/replay terminal rows, mutate GitHub/DB/TaskFlow state, restart/deploy, replay history, release, publish, or move secrets.",
  ].join("\n");
}

function buildChecklist(
  grantEvidence: TerminalBriefSidecarApprovalGrantEvidenceIngestorPacket,
  state: TerminalBriefSidecarExecutionGateFinalReviewState,
): TerminalBriefSidecarExecutionGateFinalReviewPacket["finalReview"]["checklist"] {
  const ready = state === "ready_for_execution_gate_final_review";
  const row = (id: string, label: string, evidence: string[]) => ({ id, label, status: ready ? "ready" as const : "blocked" as const, evidence, permitted: false as const });
  return [
    row("grant_evidence", "Accepted grant evidence", [grantEvidence.idempotencyKey, "grantEvidenceAccepted=" + grantEvidence.readiness.grantEvidenceAccepted]),
    row("runtime_preflight", "Runtime preflight evidence required before any later executor path", ["gateway readiness", "event loop", "queue backlog", "dry-run-only"]),
    row("executor_boundary", "Executor dispatch boundary", ["startExecutorDispatchPermitted=false", "executorInvocationPermitted=false", "processSpawnPermitted=false"]),
    row("sidecar_boundary", "Sidecar and default-on boundary", ["sidecarStartPermitted=false", "defaultOnPermitted=false"]),
    row("terminal_boundary", "Provider and terminal boundary", ["providerSendPermitted=false", "terminalAckPermitted=false"]),
    row("state_boundary", "State mutation boundary", ["dbMutationPermitted=false", "executionPermitted=false"]),
  ];
}

function buildSourceBlockers(grantEvidence: TerminalBriefSidecarApprovalGrantEvidenceIngestorPacket): string[] {
  return unique([
    ...grantEvidence.blockers,
    ...(grantEvidence.state !== "grant_evidence_accepted" ? ["grant evidence state is " + grantEvidence.state] : []),
    ...(!grantEvidence.readiness.grantEvidenceAccepted ? ["grant evidence is not accepted"] : []),
    ...(grantEvidence.readiness.approvalGrantExecutionPermitted !== false ? ["grant evidence unexpectedly permits grant execution"] : []),
    ...(grantEvidence.readiness.startExecutorDispatchPermitted !== false ? ["grant evidence unexpectedly permits executor dispatch"] : []),
    ...(grantEvidence.readiness.executorInvocationPermitted !== false ? ["grant evidence unexpectedly permits executor invocation"] : []),
    ...(grantEvidence.readiness.processSpawnPermitted !== false ? ["grant evidence unexpectedly permits process spawn"] : []),
    ...(grantEvidence.readiness.sidecarStartPermitted !== false ? ["grant evidence unexpectedly permits sidecar start"] : []),
    ...(grantEvidence.readiness.providerSendPermitted !== false ? ["grant evidence unexpectedly permits provider send"] : []),
    ...(grantEvidence.readiness.terminalAckPermitted !== false ? ["grant evidence unexpectedly permits terminal ACK"] : []),
    ...(grantEvidence.readiness.executionPermitted !== false ? ["grant evidence unexpectedly permits execution"] : []),
    ...(grantEvidence.integrationContract.dispatchesStartExecutor ? ["grant evidence unexpectedly dispatches start executor"] : []),
    ...(grantEvidence.integrationContract.invokesExecutor ? ["grant evidence unexpectedly invokes executor"] : []),
    ...(grantEvidence.integrationContract.spawnsProcess ? ["grant evidence unexpectedly spawns process"] : []),
    ...(grantEvidence.integrationContract.startsSidecar ? ["grant evidence unexpectedly starts sidecar"] : []),
    ...(grantEvidence.integrationContract.executesAction ? ["grant evidence unexpectedly executes action"] : []),
    ...(grantEvidence.semantics.performsProviderSend ? ["grant evidence unexpectedly performs provider send"] : []),
    ...(grantEvidence.semantics.performsTerminalAck ? ["grant evidence unexpectedly performs terminal ACK"] : []),
    ...(grantEvidence.semantics.performsRuntimeRestartOrDeploy ? ["grant evidence unexpectedly performs restart/deploy"] : []),
    ...(grantEvidence.semantics.performsDbMutation ? ["grant evidence unexpectedly performs DB mutation"] : []),
    ...(grantEvidence.semantics.movesSecretsOrCredentials ? ["grant evidence unexpectedly moves secrets/credentials"] : []),
  ].filter(Boolean));
}

function stateFor(
  grantEvidence: TerminalBriefSidecarApprovalGrantEvidenceIngestorPacket,
  blockers: string[],
): TerminalBriefSidecarExecutionGateFinalReviewState {
  if (grantEvidence.state === "expired") return "stale";
  if (grantEvidence.state === "conflicting") return "conflicting";
  if (grantEvidence.state === "grant_rejected") return "grant_rejected";
  if (grantEvidence.state === "more_evidence_requested") return "more_evidence_requested";
  if (grantEvidence.state !== "grant_evidence_accepted") return "waiting_for_grant_evidence";
  if (blockers.length) return "blocked";
  return "ready_for_execution_gate_final_review";
}

function missingEvidenceFor(grantEvidence: TerminalBriefSidecarApprovalGrantEvidenceIngestorPacket): string[] {
  const missing: string[] = [];
  if (grantEvidence.state !== "grant_evidence_accepted") missing.push("accepted_grant_evidence");
  if (!grantEvidence.readiness.grantEvidenceAccepted) missing.push("grant_evidence_accepted");
  return unique(missing);
}

function nextActionFor(state: TerminalBriefSidecarExecutionGateFinalReviewState): string {
  if (state === "ready_for_execution_gate_final_review") return "broker finalizer may review this final gate before any later separately approved executor path; this packet dispatches nothing";
  if (state === "grant_rejected") return "stop this execution path unless operator changes the grant decision";
  if (state === "more_evidence_requested") return "collect requested evidence before execution gate review";
  if (state === "stale") return "refresh grant evidence before execution gate review";
  if (state === "conflicting") return "resolve conflicting grant evidence";
  if (state === "waiting_for_grant_evidence") return "wait for accepted approval grant evidence";
  return "resolve blocked source grant evidence before final execution gate review";
}

function nextActionsFor(state: TerminalBriefSidecarExecutionGateFinalReviewState): string[] {
  return [nextActionFor(state), "do not dispatch executor, invoke executor, spawn process, start sidecar, ACK terminal rows, or mutate state from this packet"];
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

function buildExecutionGateReference(grantEvidence: TerminalBriefSidecarApprovalGrantEvidenceIngestorPacket): string {
  return "execution-gate:" + createHash("sha256").update(grantEvidence.idempotencyKey).digest("hex").slice(0, 16);
}

function buildExecutionGateFinalReviewIdempotencyKey(
  grantEvidence: TerminalBriefSidecarApprovalGrantEvidenceIngestorPacket,
  executionGateReference: string,
  generatedAt: string,
  state: TerminalBriefSidecarExecutionGateFinalReviewState,
): string {
  const base = JSON.stringify({ label: "terminal-brief-sidecar-execution-gate-final-review", grantEvidence: grantEvidence.idempotencyKey, executionGateReference, generatedAt, state });
  return "tb-sidecar-execution-gate-final-review:" + createHash("sha256").update(base).digest("hex").slice(0, 24);
}

function titleForState(state: TerminalBriefSidecarExecutionGateFinalReviewState): string {
  if (state === "ready_for_execution_gate_final_review") return "Ready: Terminal Brief sidecar execution gate final review";
  if (state === "grant_rejected") return "Rejected: Terminal Brief sidecar execution gate final review";
  if (state === "more_evidence_requested") return "More evidence requested: Terminal Brief sidecar execution gate final review";
  if (state === "stale") return "Stale: Terminal Brief sidecar execution gate final review";
  if (state === "conflicting") return "Conflicting: Terminal Brief sidecar execution gate final review";
  if (state === "waiting_for_grant_evidence") return "Waiting: Terminal Brief sidecar grant evidence";
  return "Blocked: Terminal Brief sidecar execution gate final review";
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function isTerminalBriefSidecarApprovalGrantEvidenceIngestorPacket(
  value: unknown,
): value is TerminalBriefSidecarApprovalGrantEvidenceIngestorPacket {
  return isRecord(value) && value.kind === "a2a-broker.terminal-brief-sidecar-approval-grant-evidence-ingestor.packet";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
