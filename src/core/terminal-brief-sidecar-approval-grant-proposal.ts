import { createHash } from "node:crypto";

import type { TerminalBriefSidecarReviewDecisionIngestorPacket } from "./terminal-brief-sidecar-review-decision-ingestor.js";

export type TerminalBriefSidecarApprovalGrantProposalState =
  | "ready_for_grant_proposal_review"
  | "waiting_for_review_decision"
  | "rejected"
  | "more_evidence_requested"
  | "stale"
  | "conflicting"
  | "blocked";

export interface TerminalBriefSidecarApprovalGrantProposalOptions {
  now?: string;
  mode?: string;
  grantReference?: string;
  grant_reference?: string;
  grantOwner?: string;
  grant_owner?: string;
}

export interface TerminalBriefSidecarApprovalGrantProposalPacket {
  kind: "a2a-broker.terminal-brief-sidecar-approval-grant-proposal.packet";
  version: 1;
  generatedAt: string;
  mode: string;
  parentRoundId?: string;
  state: TerminalBriefSidecarApprovalGrantProposalState;
  dryRunOnly: true;
  sourceOnlyNoLive: true;
  idempotencyKey: string;
  source: {
    reviewDecisionState: TerminalBriefSidecarReviewDecisionIngestorPacket["state"];
    reviewDecisionIdempotencyKey: string;
    reviewDecisionEvidenceAccepted: boolean;
    operatorTarget: string;
    reviewReference?: string;
    approvalReference?: string;
    normalizedAcceptedEvidenceCount: number;
  };
  grantProposal: {
    proposalOnly: true;
    grantOwner: string;
    grantReference: string;
    requestedGrant: "approve_supervised_terminal_brief_sidecar_dry_run_start";
    requiredEvidence: string[];
    grantRecordFields: string[];
    operatorVisibleDecisionRequired: true;
    finalizerReviewRequired: true;
    grantWouldRemainSeparateAction: true;
  };
  readiness: {
    sourceCriteriaMet: boolean;
    grantProposalReady: boolean;
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
    approvalGrantProposalVersion: 1;
    harnessNeutral: true;
    openclawMessageSendRequired: false;
    hermesAdapterCompatible: true;
    gongyungAdapterCompatible: true;
    externalHarnessCompatible: true;
    consumesReviewDecisionIngestorPacket: true;
    preparesGrantProposal: true;
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
    approvalGrantProposalOnly: true;
    sourceOnlyNoLive: true;
    proposalDoesNotGrantApproval: true;
    acceptedDecisionEvidenceDoesNotGrantApproval: true;
    approvalGrantRequiresSeparateOperatorAction: true;
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

export function buildTerminalBriefSidecarApprovalGrantProposal(
  reviewDecision: TerminalBriefSidecarReviewDecisionIngestorPacket,
  options: TerminalBriefSidecarApprovalGrantProposalOptions = {},
): TerminalBriefSidecarApprovalGrantProposalPacket {
  const generatedAt = options.now ?? new Date().toISOString();
  const blockers = buildSourceBlockers(reviewDecision);
  const state = stateFor(reviewDecision, blockers);
  const acceptedEvidence = reviewDecision.decisionEvidence.normalized.filter((item) => item.classification === "accepted");
  const grantReference = options.grantReference ?? options.grant_reference ?? buildGrantReference(reviewDecision);
  return {
    kind: "a2a-broker.terminal-brief-sidecar-approval-grant-proposal.packet",
    version: 1,
    generatedAt,
    mode: options.mode ?? reviewDecision.mode,
    parentRoundId: reviewDecision.parentRoundId,
    state,
    dryRunOnly: true,
    sourceOnlyNoLive: true,
    idempotencyKey: buildApprovalGrantProposalIdempotencyKey(reviewDecision, grantReference, generatedAt, state),
    source: {
      reviewDecisionState: reviewDecision.state,
      reviewDecisionIdempotencyKey: reviewDecision.idempotencyKey,
      reviewDecisionEvidenceAccepted: reviewDecision.readiness.reviewDecisionEvidenceAccepted,
      operatorTarget: reviewDecision.source.operatorTarget,
      reviewReference: reviewDecision.source.reviewReference,
      approvalReference: acceptedEvidence[0]?.approvalReference,
      normalizedAcceptedEvidenceCount: acceptedEvidence.length,
    },
    grantProposal: {
      proposalOnly: true,
      grantOwner: options.grantOwner ?? options.grant_owner ?? "broker-finalizer",
      grantReference,
      requestedGrant: "approve_supervised_terminal_brief_sidecar_dry_run_start",
      requiredEvidence: [
        "accepted_review_decision_evidence",
        "matching_operator_target",
        "matching_review_reference",
        "operator_visible_confirmation",
        "fresh_finalizer_review",
        "separate_operator_grant_action",
      ],
      grantRecordFields: [
        "grant_reference",
        "operator_target",
        "review_reference",
        "approval_reference",
        "operator_visible_confirmation",
        "finalizer_id",
        "decision_timestamp",
      ],
      operatorVisibleDecisionRequired: true,
      finalizerReviewRequired: true,
      grantWouldRemainSeparateAction: true,
    },
    readiness: {
      sourceCriteriaMet: state === "ready_for_grant_proposal_review",
      grantProposalReady: state === "ready_for_grant_proposal_review",
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
      missingEvidence: missingEvidenceFor(reviewDecision),
      blockers: [
        ...blockers,
        "approval grant proposal is not an approval grant",
        "grant execution and runtime start require later separate approved paths",
      ],
      nextAction: nextActionFor(state),
    },
    blockers,
    nextActions: nextActionsFor(state),
    approvalSensitiveActionsExcluded: approvalSensitiveActionsExcluded(),
    integrationContract: {
      transport: "json",
      approvalGrantProposalVersion: 1,
      harnessNeutral: true,
      openclawMessageSendRequired: false,
      hermesAdapterCompatible: true,
      gongyungAdapterCompatible: true,
      externalHarnessCompatible: true,
      consumesReviewDecisionIngestorPacket: true,
      preparesGrantProposal: true,
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
      approvalGrantProposalOnly: true,
      sourceOnlyNoLive: true,
      proposalDoesNotGrantApproval: true,
      acceptedDecisionEvidenceDoesNotGrantApproval: true,
      approvalGrantRequiresSeparateOperatorAction: true,
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

export function extractTerminalBriefSidecarApprovalGrantProposalReviewDecision(
  input: unknown,
): TerminalBriefSidecarReviewDecisionIngestorPacket {
  const envelope = isRecord(input) ? input : {};
  const candidates = [
    input,
    envelope.reviewDecisionIngestorPacket,
    envelope.reviewDecisionPacket,
    envelope.sidecarReviewDecisionIngestorPacket,
    envelope.sidecarReviewDecision,
    envelope.packet,
  ];
  const packet = candidates.find(isTerminalBriefSidecarReviewDecisionIngestorPacket);
  if (!packet) throw new Error("expected a Terminal Brief sidecar review decision ingestor packet");
  return packet;
}

export function extractTerminalBriefSidecarApprovalGrantProposalOptions(
  input: unknown,
): TerminalBriefSidecarApprovalGrantProposalOptions {
  const envelope = isRecord(input) ? input : {};
  const candidate = envelope.approvalGrantProposal
    ?? envelope.approvalGrantProposalOptions
    ?? envelope.options;
  return isRecord(candidate) ? candidate as TerminalBriefSidecarApprovalGrantProposalOptions : {};
}

export function renderTerminalBriefSidecarApprovalGrantProposalMarkdown(
  packet: TerminalBriefSidecarApprovalGrantProposalPacket,
): string {
  return [
    titleForState(packet.state),
    "Mode: " + packet.mode,
    "Parent round: " + (packet.parentRoundId ?? "unknown"),
    "State: " + packet.state + " dryRunOnly=" + packet.dryRunOnly + " sourceOnlyNoLive=" + packet.sourceOnlyNoLive,
    "Idempotency: " + packet.idempotencyKey,
    "Source decision: state=" + packet.source.reviewDecisionState
      + " accepted=" + packet.source.reviewDecisionEvidenceAccepted
      + " operatorTarget=" + packet.source.operatorTarget,
    "Grant proposal: reference=" + packet.grantProposal.grantReference
      + " proposalOnly=" + packet.grantProposal.proposalOnly
      + " separateGrantRequired=" + packet.grantProposal.grantWouldRemainSeparateAction,
    "Readiness: proposalReady=" + packet.readiness.grantProposalReady
      + " approvalGrantPermitted=" + packet.readiness.approvalGrantPermitted
      + " providerSendPermitted=" + packet.readiness.providerSendPermitted
      + " terminalAckPermitted=" + packet.readiness.terminalAckPermitted
      + " executionPermitted=" + packet.readiness.executionPermitted,
    ...(packet.blockers.length ? ["", "Blockers:", ...packet.blockers.map((blocker) => "- " + blocker)] : []),
    "",
    "Next actions:",
    ...packet.nextActions.map((action) => "- " + action),
    "",
    "Safety: grant proposal only; does not send approval, grant approval, execute a grant, dispatch/invoke executor, spawn a process, start sidecar, enable default-on, send providers, ACK/replay terminal rows, mutate GitHub/DB/TaskFlow state, restart/deploy, replay history, release, publish, or move secrets.",
  ].join("\n");
}

function buildSourceBlockers(reviewDecision: TerminalBriefSidecarReviewDecisionIngestorPacket): string[] {
  return unique([
    ...reviewDecision.blockers,
    ...(reviewDecision.state !== "approved_evidence" ? ["review decision state is " + reviewDecision.state] : []),
    ...(!reviewDecision.readiness.reviewDecisionEvidenceAccepted ? ["review decision evidence is not accepted"] : []),
    ...(reviewDecision.readiness.approvalGrantPermitted !== false ? ["review decision unexpectedly permits approval grant"] : []),
    ...(reviewDecision.readiness.providerSendPermitted !== false ? ["review decision unexpectedly permits provider send"] : []),
    ...(reviewDecision.readiness.terminalAckPermitted !== false ? ["review decision unexpectedly permits terminal ACK"] : []),
    ...(reviewDecision.readiness.executionPermitted !== false ? ["review decision unexpectedly permits execution"] : []),
    ...(reviewDecision.integrationContract.sendsApprovalRequest ? ["review decision unexpectedly sends approval request"] : []),
    ...(reviewDecision.integrationContract.grantsApproval ? ["review decision unexpectedly grants approval"] : []),
    ...(reviewDecision.integrationContract.executesAction ? ["review decision unexpectedly executes action"] : []),
    ...(reviewDecision.semantics.performsProviderSend ? ["review decision unexpectedly performs provider send"] : []),
    ...(reviewDecision.semantics.performsTerminalAck ? ["review decision unexpectedly performs terminal ACK"] : []),
    ...(reviewDecision.semantics.performsRuntimeRestartOrDeploy ? ["review decision unexpectedly performs restart/deploy"] : []),
    ...(reviewDecision.semantics.performsDbMutation ? ["review decision unexpectedly performs DB mutation"] : []),
    ...(reviewDecision.semantics.movesSecretsOrCredentials ? ["review decision unexpectedly moves secrets/credentials"] : []),
  ].filter(Boolean));
}

function stateFor(
  reviewDecision: TerminalBriefSidecarReviewDecisionIngestorPacket,
  blockers: string[],
): TerminalBriefSidecarApprovalGrantProposalState {
  if (reviewDecision.state === "stale" || reviewDecision.state === "expired") return "stale";
  if (reviewDecision.state === "conflicting") return "conflicting";
  if (reviewDecision.state === "rejected") return "rejected";
  if (reviewDecision.state === "more_evidence_requested") return "more_evidence_requested";
  if (reviewDecision.state !== "approved_evidence") return "waiting_for_review_decision";
  if (blockers.length) return "blocked";
  return "ready_for_grant_proposal_review";
}

function missingEvidenceFor(reviewDecision: TerminalBriefSidecarReviewDecisionIngestorPacket): string[] {
  const missing: string[] = [];
  if (reviewDecision.state !== "approved_evidence") missing.push("accepted_review_decision");
  if (!reviewDecision.readiness.reviewDecisionEvidenceAccepted) missing.push("review_decision_evidence_accepted");
  if (!reviewDecision.decisionEvidence.normalized.some((item) => item.classification === "accepted")) {
    missing.push("operator_visible_approval_evidence");
  }
  return unique(missing);
}

function nextActionFor(state: TerminalBriefSidecarApprovalGrantProposalState): string {
  if (state === "ready_for_grant_proposal_review") return "broker finalizer may review this proposal before a later separate approval-grant path; this packet grants nothing";
  if (state === "rejected") return "stop this approval path unless operator changes the decision";
  if (state === "more_evidence_requested") return "collect requested evidence before proposing grant metadata";
  if (state === "stale") return "refresh review decision evidence before proposing grant metadata";
  if (state === "conflicting") return "resolve conflicting review decision evidence";
  if (state === "waiting_for_review_decision") return "wait for accepted operator review decision evidence";
  return "resolve blocked source review decision before proposing grant metadata";
}

function nextActionsFor(state: TerminalBriefSidecarApprovalGrantProposalState): string[] {
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

function buildGrantReference(reviewDecision: TerminalBriefSidecarReviewDecisionIngestorPacket): string {
  return "grant-proposal:" + createHash("sha256").update(reviewDecision.idempotencyKey).digest("hex").slice(0, 16);
}

function buildApprovalGrantProposalIdempotencyKey(
  reviewDecision: TerminalBriefSidecarReviewDecisionIngestorPacket,
  grantReference: string,
  generatedAt: string,
  state: TerminalBriefSidecarApprovalGrantProposalState,
): string {
  const base = JSON.stringify({ label: "terminal-brief-sidecar-approval-grant-proposal", reviewDecision: reviewDecision.idempotencyKey, grantReference, generatedAt, state });
  return "tb-sidecar-approval-grant-proposal:" + createHash("sha256").update(base).digest("hex").slice(0, 24);
}

function titleForState(state: TerminalBriefSidecarApprovalGrantProposalState): string {
  if (state === "ready_for_grant_proposal_review") return "Ready: Terminal Brief sidecar approval grant proposal";
  if (state === "rejected") return "Rejected: Terminal Brief sidecar approval grant proposal";
  if (state === "more_evidence_requested") return "More evidence requested: Terminal Brief sidecar approval grant proposal";
  if (state === "stale") return "Stale: Terminal Brief sidecar approval grant proposal";
  if (state === "conflicting") return "Conflicting: Terminal Brief sidecar approval grant proposal";
  if (state === "waiting_for_review_decision") return "Waiting: Terminal Brief sidecar review decision evidence";
  return "Blocked: Terminal Brief sidecar approval grant proposal";
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function isTerminalBriefSidecarReviewDecisionIngestorPacket(
  value: unknown,
): value is TerminalBriefSidecarReviewDecisionIngestorPacket {
  return isRecord(value) && value.kind === "a2a-broker.terminal-brief-sidecar-review-decision-ingestor.packet";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
