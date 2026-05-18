import { createHash } from "node:crypto";

import type { TerminalBriefSidecarApprovalGrantProposalPacket } from "./terminal-brief-sidecar-approval-grant-proposal.js";

export type TerminalBriefSidecarApprovalGrantEvidenceType =
  | "grant_approved"
  | "grant_rejected"
  | "request_more_evidence"
  | "provider_accepted"
  | "conflict"
  | "expired";

export type TerminalBriefSidecarApprovalGrantEvidenceState =
  | "grant_evidence_accepted"
  | "grant_rejected"
  | "more_evidence_requested"
  | "insufficient"
  | "conflicting"
  | "expired"
  | "waiting_for_grant_proposal"
  | "blocked";

export interface TerminalBriefSidecarApprovalGrantEvidence {
  type: TerminalBriefSidecarApprovalGrantEvidenceType;
  grantReference?: string;
  grant_reference?: string;
  operatorTarget?: string;
  operator_target?: string;
  reviewReference?: string;
  review_reference?: string;
  finalizerId?: string;
  finalizer_id?: string;
  operatorVisibleConfirmation?: boolean;
  operator_visible_confirmation?: boolean;
  observedAt?: string;
  observed_at?: string;
  source?: string;
  notes?: string;
}

export interface TerminalBriefSidecarApprovalGrantEvidenceIngestorOptions {
  now?: string;
  mode?: string;
  maxEvidenceAgeMinutes?: number;
  max_evidence_age_minutes?: number;
}

export interface TerminalBriefSidecarApprovalGrantEvidenceIngestorPacket {
  kind: "a2a-broker.terminal-brief-sidecar-approval-grant-evidence-ingestor.packet";
  version: 1;
  generatedAt: string;
  mode: string;
  parentRoundId?: string;
  state: TerminalBriefSidecarApprovalGrantEvidenceState;
  dryRunOnly: true;
  sourceOnlyNoLive: true;
  idempotencyKey: string;
  source: {
    grantProposalState: TerminalBriefSidecarApprovalGrantProposalPacket["state"];
    grantProposalIdempotencyKey: string;
    grantProposalReady: boolean;
    grantReference: string;
    operatorTarget: string;
    reviewReference?: string;
    requiredGrant: string;
  };
  grantEvidence: {
    evidenceCount: number;
    acceptedTypes: TerminalBriefSidecarApprovalGrantEvidenceType[];
    normalized: Array<{
      type: TerminalBriefSidecarApprovalGrantEvidenceType;
      grantReference?: string;
      operatorTarget?: string;
      reviewReference?: string;
      finalizerId?: string;
      operatorVisibleConfirmation: boolean;
      observedAt?: string;
      source?: string;
      classification: "accepted" | "rejected" | "more_evidence" | "insufficient" | "conflict" | "expired";
      reasons: string[];
    }>;
    acceptedGrantEvidence: boolean;
    rejectedGrantEvidence: boolean;
    moreEvidenceRequested: boolean;
    providerAcceptedOnly: boolean;
    conflictEvidence: boolean;
    expiredEvidence: boolean;
  };
  readiness: {
    sourceCriteriaMet: boolean;
    grantEvidenceAccepted: boolean;
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
    approvalGrantEvidenceIngestorVersion: 1;
    harnessNeutral: true;
    openclawMessageSendRequired: false;
    hermesAdapterCompatible: true;
    gongyungAdapterCompatible: true;
    externalHarnessCompatible: true;
    consumesApprovalGrantProposalPacket: true;
    classifiesGrantEvidence: true;
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
    approvalGrantEvidenceIngestorOnly: true;
    sourceOnlyNoLive: true;
    evidenceClassificationOnly: true;
    acceptedGrantEvidenceDoesNotExecuteGrant: true;
    acceptedGrantEvidenceDoesNotAuthorizeRuntime: true;
    providerAcceptedIsVisibilityProof: false;
    providerAcceptedIsApprovalEvidence: false;
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

export function buildTerminalBriefSidecarApprovalGrantEvidenceIngestor(
  proposal: TerminalBriefSidecarApprovalGrantProposalPacket,
  evidence: TerminalBriefSidecarApprovalGrantEvidence[],
  options: TerminalBriefSidecarApprovalGrantEvidenceIngestorOptions = {},
): TerminalBriefSidecarApprovalGrantEvidenceIngestorPacket {
  const generatedAt = options.now ?? new Date().toISOString();
  const sourceBlockers = buildSourceBlockers(proposal);
  const normalized = evidence.map((item) => classifyEvidence(proposal, item, generatedAt, options));
  const state = stateFor(proposal, sourceBlockers, normalized);
  const acceptedGrantEvidence = normalized.some((item) => item.classification === "accepted");
  return {
    kind: "a2a-broker.terminal-brief-sidecar-approval-grant-evidence-ingestor.packet",
    version: 1,
    generatedAt,
    mode: options.mode ?? proposal.mode,
    parentRoundId: proposal.parentRoundId,
    state,
    dryRunOnly: true,
    sourceOnlyNoLive: true,
    idempotencyKey: buildGrantEvidenceIngestorIdempotencyKey(proposal, evidence, generatedAt, state),
    source: {
      grantProposalState: proposal.state,
      grantProposalIdempotencyKey: proposal.idempotencyKey,
      grantProposalReady: proposal.readiness.grantProposalReady,
      grantReference: proposal.grantProposal.grantReference,
      operatorTarget: proposal.source.operatorTarget,
      reviewReference: proposal.source.reviewReference,
      requiredGrant: proposal.grantProposal.requestedGrant,
    },
    grantEvidence: {
      evidenceCount: evidence.length,
      acceptedTypes: ["grant_approved", "grant_rejected", "request_more_evidence", "provider_accepted", "conflict", "expired"],
      normalized,
      acceptedGrantEvidence,
      rejectedGrantEvidence: normalized.some((item) => item.classification === "rejected"),
      moreEvidenceRequested: normalized.some((item) => item.classification === "more_evidence"),
      providerAcceptedOnly: evidence.length > 0 && normalized.every((item) => item.type === "provider_accepted"),
      conflictEvidence: normalized.some((item) => item.classification === "conflict"),
      expiredEvidence: normalized.some((item) => item.classification === "expired"),
    },
    readiness: {
      sourceCriteriaMet: state === "grant_evidence_accepted",
      grantEvidenceAccepted: acceptedGrantEvidence && state === "grant_evidence_accepted",
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
      missingEvidence: missingEvidenceFor(proposal, evidence, normalized),
      blockers: [
        ...sourceBlockers,
        "approval grant evidence is classification only and does not execute a grant",
        "runtime execution requires later separate approved paths",
      ],
      nextAction: nextActionFor(state),
    },
    blockers: sourceBlockers,
    nextActions: nextActionsFor(state),
    approvalSensitiveActionsExcluded: approvalSensitiveActionsExcluded(),
    integrationContract: {
      transport: "json",
      approvalGrantEvidenceIngestorVersion: 1,
      harnessNeutral: true,
      openclawMessageSendRequired: false,
      hermesAdapterCompatible: true,
      gongyungAdapterCompatible: true,
      externalHarnessCompatible: true,
      consumesApprovalGrantProposalPacket: true,
      classifiesGrantEvidence: true,
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
      approvalGrantEvidenceIngestorOnly: true,
      sourceOnlyNoLive: true,
      evidenceClassificationOnly: true,
      acceptedGrantEvidenceDoesNotExecuteGrant: true,
      acceptedGrantEvidenceDoesNotAuthorizeRuntime: true,
      providerAcceptedIsVisibilityProof: false,
      providerAcceptedIsApprovalEvidence: false,
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

export function extractTerminalBriefSidecarApprovalGrantEvidenceIngestorProposal(
  input: unknown,
): TerminalBriefSidecarApprovalGrantProposalPacket {
  const envelope = isRecord(input) ? input : {};
  const candidates = [input, envelope.approvalGrantProposalPacket, envelope.grantProposalPacket, envelope.sidecarApprovalGrantProposalPacket, envelope.packet];
  const packet = candidates.find(isTerminalBriefSidecarApprovalGrantProposalPacket);
  if (!packet) throw new Error("expected a Terminal Brief sidecar approval grant proposal packet");
  return packet;
}

export function extractTerminalBriefSidecarApprovalGrantEvidence(
  input: unknown,
): TerminalBriefSidecarApprovalGrantEvidence[] {
  const envelope = isRecord(input) ? input : {};
  const candidate = envelope.approvalGrantEvidence ?? envelope.grantEvidence ?? envelope.evidence ?? [];
  if (!Array.isArray(candidate)) return [];
  return candidate.filter(isRecord).map((item) => item as unknown as TerminalBriefSidecarApprovalGrantEvidence);
}

export function extractTerminalBriefSidecarApprovalGrantEvidenceIngestorOptions(
  input: unknown,
): TerminalBriefSidecarApprovalGrantEvidenceIngestorOptions {
  const envelope = isRecord(input) ? input : {};
  const candidate = envelope.approvalGrantEvidenceIngestor ?? envelope.grantEvidenceIngestor ?? envelope.options;
  return isRecord(candidate) ? candidate as TerminalBriefSidecarApprovalGrantEvidenceIngestorOptions : {};
}

export function renderTerminalBriefSidecarApprovalGrantEvidenceIngestorMarkdown(
  packet: TerminalBriefSidecarApprovalGrantEvidenceIngestorPacket,
): string {
  return [
    titleForState(packet.state),
    "Mode: " + packet.mode,
    "Parent round: " + (packet.parentRoundId ?? "unknown"),
    "State: " + packet.state + " dryRunOnly=" + packet.dryRunOnly + " sourceOnlyNoLive=" + packet.sourceOnlyNoLive,
    "Idempotency: " + packet.idempotencyKey,
    "Source proposal: state=" + packet.source.grantProposalState
      + " ready=" + packet.source.grantProposalReady
      + " grantReference=" + packet.source.grantReference,
    "Evidence: count=" + packet.grantEvidence.evidenceCount
      + " accepted=" + packet.grantEvidence.acceptedGrantEvidence
      + " rejected=" + packet.grantEvidence.rejectedGrantEvidence
      + " moreEvidence=" + packet.grantEvidence.moreEvidenceRequested,
    "Readiness: accepted=" + packet.readiness.grantEvidenceAccepted
      + " approvalGrantPermitted=" + packet.readiness.approvalGrantPermitted
      + " grantExecutionPermitted=" + packet.readiness.approvalGrantExecutionPermitted
      + " terminalAckPermitted=" + packet.readiness.terminalAckPermitted
      + " executionPermitted=" + packet.readiness.executionPermitted,
    ...(packet.blockers.length ? ["", "Blockers:", ...packet.blockers.map((blocker) => "- " + blocker)] : []),
    "",
    "Next actions:",
    ...packet.nextActions.map((action) => "- " + action),
    "",
    "Safety: grant evidence classification only; does not send approval, grant approval, execute a grant, dispatch/invoke executor, spawn a process, start sidecar, enable default-on, send providers, ACK/replay terminal rows, mutate GitHub/DB/TaskFlow state, restart/deploy, replay history, release, publish, or move secrets.",
  ].join("\n");
}

function classifyEvidence(
  proposal: TerminalBriefSidecarApprovalGrantProposalPacket,
  evidence: TerminalBriefSidecarApprovalGrantEvidence,
  generatedAt: string,
  options: TerminalBriefSidecarApprovalGrantEvidenceIngestorOptions,
): TerminalBriefSidecarApprovalGrantEvidenceIngestorPacket["grantEvidence"]["normalized"][number] {
  const type = evidence.type;
  const grantReference = evidence.grantReference ?? evidence.grant_reference;
  const operatorTarget = evidence.operatorTarget ?? evidence.operator_target;
  const reviewReference = evidence.reviewReference ?? evidence.review_reference;
  const finalizerId = evidence.finalizerId ?? evidence.finalizer_id;
  const operatorVisibleConfirmation = evidence.operatorVisibleConfirmation ?? evidence.operator_visible_confirmation ?? false;
  const reasons: string[] = [];
  if (grantReference && grantReference !== proposal.grantProposal.grantReference) reasons.push("grant reference mismatch");
  if (operatorTarget && operatorTarget !== proposal.source.operatorTarget) reasons.push("operator target mismatch");
  if (proposal.source.reviewReference && reviewReference !== proposal.source.reviewReference) reasons.push("review reference mismatch");
  if (type === "provider_accepted") reasons.push("provider accepted is not grant or visibility evidence");
  if (type === "grant_approved" && !operatorVisibleConfirmation) reasons.push("grant approval evidence requires operator-visible confirmation");
  if (type === "grant_approved" && !finalizerId) reasons.push("grant approval evidence requires finalizer id");
  if (isExpiredEvidence(evidence, generatedAt, options)) reasons.push("evidence is stale or expired");

  let classification: "accepted" | "rejected" | "more_evidence" | "insufficient" | "conflict" | "expired" = "insufficient";
  if (type === "conflict") classification = "conflict";
  else if (type === "expired" || reasons.includes("evidence is stale or expired")) classification = "expired";
  else if (type === "grant_rejected" && reasons.length === 0) classification = "rejected";
  else if (type === "request_more_evidence" && reasons.length === 0) classification = "more_evidence";
  else if (type === "grant_approved" && reasons.length === 0 && operatorVisibleConfirmation && finalizerId) classification = "accepted";

  return { type, grantReference, operatorTarget, reviewReference, finalizerId, operatorVisibleConfirmation, observedAt: evidence.observedAt ?? evidence.observed_at, source: evidence.source, classification, reasons };
}

function buildSourceBlockers(proposal: TerminalBriefSidecarApprovalGrantProposalPacket): string[] {
  return unique([
    ...proposal.blockers,
    ...(proposal.state !== "ready_for_grant_proposal_review" ? ["grant proposal state is " + proposal.state] : []),
    ...(!proposal.readiness.grantProposalReady ? ["grant proposal is not ready"] : []),
    ...(proposal.readiness.approvalGrantPermitted !== false ? ["grant proposal unexpectedly permits approval grant"] : []),
    ...(proposal.readiness.approvalGrantExecutionPermitted !== false ? ["grant proposal unexpectedly permits grant execution"] : []),
    ...(proposal.readiness.providerSendPermitted !== false ? ["grant proposal unexpectedly permits provider send"] : []),
    ...(proposal.readiness.terminalAckPermitted !== false ? ["grant proposal unexpectedly permits terminal ACK"] : []),
    ...(proposal.readiness.executionPermitted !== false ? ["grant proposal unexpectedly permits execution"] : []),
    ...(proposal.integrationContract.grantsApproval ? ["grant proposal unexpectedly grants approval"] : []),
    ...(proposal.integrationContract.executesApprovalGrant ? ["grant proposal unexpectedly executes approval grant"] : []),
    ...(proposal.integrationContract.executesAction ? ["grant proposal unexpectedly executes action"] : []),
    ...(proposal.semantics.performsProviderSend ? ["grant proposal unexpectedly performs provider send"] : []),
    ...(proposal.semantics.performsTerminalAck ? ["grant proposal unexpectedly performs terminal ACK"] : []),
    ...(proposal.semantics.performsRuntimeRestartOrDeploy ? ["grant proposal unexpectedly performs restart/deploy"] : []),
    ...(proposal.semantics.performsDbMutation ? ["grant proposal unexpectedly performs DB mutation"] : []),
    ...(proposal.semantics.movesSecretsOrCredentials ? ["grant proposal unexpectedly moves secrets/credentials"] : []),
  ].filter(Boolean));
}

function stateFor(
  proposal: TerminalBriefSidecarApprovalGrantProposalPacket,
  blockers: string[],
  normalized: TerminalBriefSidecarApprovalGrantEvidenceIngestorPacket["grantEvidence"]["normalized"],
): TerminalBriefSidecarApprovalGrantEvidenceState {
  if (proposal.state !== "ready_for_grant_proposal_review") return "waiting_for_grant_proposal";
  if (blockers.length) return "blocked";
  if (normalized.some((item) => item.classification === "conflict")) return "conflicting";
  if (normalized.some((item) => item.classification === "expired")) return "expired";
  if (normalized.some((item) => item.classification === "rejected")) return "grant_rejected";
  if (normalized.some((item) => item.classification === "more_evidence")) return "more_evidence_requested";
  if (normalized.some((item) => item.classification === "accepted")) return "grant_evidence_accepted";
  return "insufficient";
}

function missingEvidenceFor(
  proposal: TerminalBriefSidecarApprovalGrantProposalPacket,
  evidence: TerminalBriefSidecarApprovalGrantEvidence[],
  normalized: TerminalBriefSidecarApprovalGrantEvidenceIngestorPacket["grantEvidence"]["normalized"],
): string[] {
  const missing: string[] = [];
  if (proposal.state !== "ready_for_grant_proposal_review") missing.push("ready_grant_proposal");
  if (!evidence.length) missing.push("approval_grant_evidence");
  if (!normalized.some((item) => item.classification === "accepted" || item.classification === "rejected" || item.classification === "more_evidence")) {
    missing.push("recognized_grant_decision");
  }
  if (normalized.some((item) => item.type === "grant_approved" && !item.operatorVisibleConfirmation)) missing.push("operator_visible_confirmation");
  if (normalized.some((item) => item.type === "grant_approved" && !item.finalizerId)) missing.push("finalizer_id");
  return unique(missing);
}

function isExpiredEvidence(
  evidence: TerminalBriefSidecarApprovalGrantEvidence,
  generatedAt: string,
  options: TerminalBriefSidecarApprovalGrantEvidenceIngestorOptions,
): boolean {
  if (evidence.type === "expired") return true;
  const observedAt = evidence.observedAt ?? evidence.observed_at;
  if (!observedAt) return false;
  const maxAgeMinutes = options.maxEvidenceAgeMinutes ?? options.max_evidence_age_minutes ?? 60;
  const observed = Date.parse(observedAt);
  const generated = Date.parse(generatedAt);
  return Number.isFinite(observed) && Number.isFinite(generated)
    ? generated - observed > maxAgeMinutes * 60_000
    : false;
}

function nextActionFor(state: TerminalBriefSidecarApprovalGrantEvidenceState): string {
  if (state === "grant_evidence_accepted") return "broker finalizer may prepare a later execution gate review, but this packet executes nothing";
  if (state === "grant_rejected") return "stop this approval path unless operator changes the grant decision";
  if (state === "more_evidence_requested") return "collect requested evidence before continuing";
  if (state === "expired") return "refresh approval grant evidence";
  if (state === "conflicting") return "resolve conflicting approval grant evidence";
  if (state === "waiting_for_grant_proposal") return "resolve grant proposal readiness first";
  return "wait for operator-visible grant approval, rejection, or request-more-evidence evidence";
}

function nextActionsFor(state: TerminalBriefSidecarApprovalGrantEvidenceState): string[] {
  return [nextActionFor(state), "do not send approval, grant approval, start sidecar, ACK terminal rows, or mutate state from this packet"];
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

function buildGrantEvidenceIngestorIdempotencyKey(
  proposal: TerminalBriefSidecarApprovalGrantProposalPacket,
  evidence: TerminalBriefSidecarApprovalGrantEvidence[],
  generatedAt: string,
  state: TerminalBriefSidecarApprovalGrantEvidenceState,
): string {
  const base = JSON.stringify({ label: "terminal-brief-sidecar-approval-grant-evidence-ingestor", proposal: proposal.idempotencyKey, evidence, generatedAt, state });
  return "tb-sidecar-grant-evidence-ingestor:" + createHash("sha256").update(base).digest("hex").slice(0, 24);
}

function titleForState(state: TerminalBriefSidecarApprovalGrantEvidenceState): string {
  if (state === "grant_evidence_accepted") return "Accepted: Terminal Brief sidecar approval grant evidence";
  if (state === "grant_rejected") return "Rejected: Terminal Brief sidecar approval grant evidence";
  if (state === "more_evidence_requested") return "More evidence requested: Terminal Brief sidecar approval grant evidence";
  if (state === "expired") return "Expired: Terminal Brief sidecar approval grant evidence";
  if (state === "conflicting") return "Conflicting: Terminal Brief sidecar approval grant evidence";
  if (state === "waiting_for_grant_proposal") return "Waiting: Terminal Brief sidecar approval grant proposal";
  return "Insufficient: Terminal Brief sidecar approval grant evidence";
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function isTerminalBriefSidecarApprovalGrantProposalPacket(
  value: unknown,
): value is TerminalBriefSidecarApprovalGrantProposalPacket {
  return isRecord(value) && value.kind === "a2a-broker.terminal-brief-sidecar-approval-grant-proposal.packet";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
