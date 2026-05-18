import { createHash } from "node:crypto";

import type { TerminalBriefSidecarOperatorReviewTablePacket } from "./terminal-brief-sidecar-operator-review-table.js";

export type TerminalBriefSidecarReviewDecisionEvidenceType =
  | "approve"
  | "reject"
  | "request_more_evidence"
  | "provider_accepted"
  | "conflict"
  | "expired";

export type TerminalBriefSidecarReviewDecisionState =
  | "approved_evidence"
  | "rejected"
  | "more_evidence_requested"
  | "insufficient"
  | "conflicting"
  | "expired"
  | "stale"
  | "waiting_for_operator_review_table"
  | "blocked";

export interface TerminalBriefSidecarReviewDecisionEvidence {
  type: TerminalBriefSidecarReviewDecisionEvidenceType;
  operatorTarget?: string;
  reviewReference?: string;
  approvalReference?: string;
  decision?: string;
  operatorVisibleConfirmation?: boolean;
  operator_visible_confirmation?: boolean;
  observedAt?: string;
  observed_at?: string;
  source?: string;
  notes?: string;
}

export interface TerminalBriefSidecarReviewDecisionIngestorOptions {
  now?: string;
  mode?: string;
  maxEvidenceAgeMinutes?: number;
  max_evidence_age_minutes?: number;
}

export interface TerminalBriefSidecarReviewDecisionIngestorPacket {
  kind: "a2a-broker.terminal-brief-sidecar-review-decision-ingestor.packet";
  version: 1;
  generatedAt: string;
  mode: string;
  parentRoundId?: string;
  state: TerminalBriefSidecarReviewDecisionState;
  dryRunOnly: true;
  sourceOnlyNoLive: true;
  idempotencyKey: string;
  source: {
    operatorReviewTableState: TerminalBriefSidecarOperatorReviewTablePacket["state"];
    operatorReviewTableIdempotencyKey: string;
    operatorReviewTableReady: boolean;
    operatorTarget: string;
    reviewReference?: string;
    requiredDecision: string;
    operatorDecisionFields: string[];
  };
  decisionEvidence: {
    evidenceCount: number;
    acceptedTypes: TerminalBriefSidecarReviewDecisionEvidenceType[];
    normalized: Array<{
      type: TerminalBriefSidecarReviewDecisionEvidenceType;
      operatorTarget?: string;
      reviewReference?: string;
      approvalReference?: string;
      decision?: string;
      operatorVisibleConfirmation: boolean;
      observedAt?: string;
      source?: string;
      classification: "accepted" | "rejected" | "more_evidence" | "insufficient" | "conflict" | "expired";
      reasons: string[];
    }>;
    acceptedApprovalEvidence: boolean;
    rejectedEvidence: boolean;
    moreEvidenceRequested: boolean;
    providerAcceptedOnly: boolean;
    conflictEvidence: boolean;
    expiredEvidence: boolean;
  };
  readiness: {
    sourceCriteriaMet: boolean;
    reviewDecisionEvidenceAccepted: boolean;
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
    reviewDecisionIngestorVersion: 1;
    harnessNeutral: true;
    openclawMessageSendRequired: false;
    hermesAdapterCompatible: true;
    gongyungAdapterCompatible: true;
    externalHarnessCompatible: true;
    consumesOperatorReviewTablePacket: true;
    classifiesOperatorDecisionEvidence: true;
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
    reviewDecisionIngestorOnly: true;
    sourceOnlyNoLive: true;
    evidenceClassificationOnly: true;
    acceptedDecisionEvidenceDoesNotGrantApproval: true;
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

export function buildTerminalBriefSidecarReviewDecisionIngestor(
  table: TerminalBriefSidecarOperatorReviewTablePacket,
  evidence: TerminalBriefSidecarReviewDecisionEvidence[],
  options: TerminalBriefSidecarReviewDecisionIngestorOptions = {},
): TerminalBriefSidecarReviewDecisionIngestorPacket {
  const generatedAt = options.now ?? new Date().toISOString();
  const sourceBlockers = buildSourceBlockers(table);
  const normalized = evidence.map((item) => classifyEvidence(table, item, generatedAt, options));
  const state = stateFor(table, sourceBlockers, normalized);
  const acceptedApprovalEvidence = normalized.some((item) => item.classification === "accepted");
  return {
    kind: "a2a-broker.terminal-brief-sidecar-review-decision-ingestor.packet",
    version: 1,
    generatedAt,
    mode: options.mode ?? table.mode,
    parentRoundId: table.parentRoundId,
    state,
    dryRunOnly: true,
    sourceOnlyNoLive: true,
    idempotencyKey: buildReviewDecisionIngestorIdempotencyKey(table, evidence, generatedAt, state),
    source: {
      operatorReviewTableState: table.state,
      operatorReviewTableIdempotencyKey: table.idempotencyKey,
      operatorReviewTableReady: table.readiness.reviewTableReady,
      operatorTarget: table.source.operatorTarget,
      reviewReference: table.operatorReview.reviewReference,
      requiredDecision: table.operatorReview.requiredDecision,
      operatorDecisionFields: table.source.operatorDecisionFields,
    },
    decisionEvidence: {
      evidenceCount: evidence.length,
      acceptedTypes: ["approve", "reject", "request_more_evidence", "provider_accepted", "conflict", "expired"],
      normalized,
      acceptedApprovalEvidence,
      rejectedEvidence: normalized.some((item) => item.classification === "rejected"),
      moreEvidenceRequested: normalized.some((item) => item.classification === "more_evidence"),
      providerAcceptedOnly: evidence.length > 0 && normalized.every((item) => item.type === "provider_accepted"),
      conflictEvidence: normalized.some((item) => item.classification === "conflict"),
      expiredEvidence: normalized.some((item) => item.classification === "expired"),
    },
    readiness: {
      sourceCriteriaMet: state === "approved_evidence",
      reviewDecisionEvidenceAccepted: acceptedApprovalEvidence && state === "approved_evidence",
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
      missingEvidence: missingEvidenceFor(table, evidence, normalized),
      blockers: [
        ...sourceBlockers,
        "review decision evidence is classification only and does not grant approval",
        "approval request dispatch and runtime execution require later separate approved paths",
      ],
      nextAction: nextActionFor(state),
    },
    blockers: sourceBlockers,
    nextActions: nextActionsFor(state),
    approvalSensitiveActionsExcluded: approvalSensitiveActionsExcluded(),
    integrationContract: {
      transport: "json",
      reviewDecisionIngestorVersion: 1,
      harnessNeutral: true,
      openclawMessageSendRequired: false,
      hermesAdapterCompatible: true,
      gongyungAdapterCompatible: true,
      externalHarnessCompatible: true,
      consumesOperatorReviewTablePacket: true,
      classifiesOperatorDecisionEvidence: true,
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
      reviewDecisionIngestorOnly: true,
      sourceOnlyNoLive: true,
      evidenceClassificationOnly: true,
      acceptedDecisionEvidenceDoesNotGrantApproval: true,
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

export function extractTerminalBriefSidecarReviewDecisionIngestorTable(
  input: unknown,
): TerminalBriefSidecarOperatorReviewTablePacket {
  const envelope = isRecord(input) ? input : {};
  const candidates = [
    input,
    envelope.operatorReviewTablePacket,
    envelope.operatorReviewTable,
    envelope.sidecarOperatorReviewTablePacket,
    envelope.sidecarOperatorReviewTable,
    envelope.tablePacket,
    envelope.packet,
  ];
  const packet = candidates.find(isTerminalBriefSidecarOperatorReviewTablePacket);
  if (!packet) throw new Error("expected a Terminal Brief sidecar operator review table packet");
  return packet;
}

export function extractTerminalBriefSidecarReviewDecisionEvidence(
  input: unknown,
): TerminalBriefSidecarReviewDecisionEvidence[] {
  const envelope = isRecord(input) ? input : {};
  const candidate = envelope.reviewDecisionEvidence
    ?? envelope.operatorDecisionEvidence
    ?? envelope.decisionEvidence
    ?? envelope.evidence
    ?? [];
  if (!Array.isArray(candidate)) return [];
  return candidate.filter(isRecord).map((item) => item as unknown as TerminalBriefSidecarReviewDecisionEvidence);
}

export function extractTerminalBriefSidecarReviewDecisionIngestorOptions(
  input: unknown,
): TerminalBriefSidecarReviewDecisionIngestorOptions {
  const envelope = isRecord(input) ? input : {};
  const candidate = envelope.reviewDecisionIngestor
    ?? envelope.reviewDecisionIngestorOptions
    ?? envelope.options;
  return isRecord(candidate) ? candidate as TerminalBriefSidecarReviewDecisionIngestorOptions : {};
}

export function renderTerminalBriefSidecarReviewDecisionIngestorMarkdown(
  packet: TerminalBriefSidecarReviewDecisionIngestorPacket,
): string {
  return [
    titleForState(packet.state),
    "Mode: " + packet.mode,
    "Parent round: " + (packet.parentRoundId ?? "unknown"),
    "State: " + packet.state + " dryRunOnly=" + packet.dryRunOnly + " sourceOnlyNoLive=" + packet.sourceOnlyNoLive,
    "Idempotency: " + packet.idempotencyKey,
    "Source table: state=" + packet.source.operatorReviewTableState
      + " ready=" + packet.source.operatorReviewTableReady
      + " operatorTarget=" + packet.source.operatorTarget,
    "Evidence: count=" + packet.decisionEvidence.evidenceCount
      + " accepted=" + packet.decisionEvidence.acceptedApprovalEvidence
      + " rejected=" + packet.decisionEvidence.rejectedEvidence
      + " moreEvidence=" + packet.decisionEvidence.moreEvidenceRequested,
    "Readiness: accepted=" + packet.readiness.reviewDecisionEvidenceAccepted
      + " approvalGrantPermitted=" + packet.readiness.approvalGrantPermitted
      + " providerSendPermitted=" + packet.readiness.providerSendPermitted
      + " terminalAckPermitted=" + packet.readiness.terminalAckPermitted
      + " executionPermitted=" + packet.readiness.executionPermitted,
    ...(packet.blockers.length ? ["", "Blockers:", ...packet.blockers.map((blocker) => "- " + blocker)] : []),
    "",
    "Next actions:",
    ...packet.nextActions.map((action) => "- " + action),
    "",
    "Safety: review decision evidence only; does not send approval, grant approval, dispatch/invoke executor, spawn a process, start sidecar, enable default-on, send providers, ACK/replay terminal rows, mutate GitHub/DB/TaskFlow state, restart/deploy, replay history, release, publish, or move secrets.",
  ].join("\n");
}

function classifyEvidence(
  table: TerminalBriefSidecarOperatorReviewTablePacket,
  evidence: TerminalBriefSidecarReviewDecisionEvidence,
  generatedAt: string,
  options: TerminalBriefSidecarReviewDecisionIngestorOptions,
): TerminalBriefSidecarReviewDecisionIngestorPacket["decisionEvidence"]["normalized"][number] {
  const type = evidence.type;
  const reasons: string[] = [];
  const operatorVisibleConfirmation = evidence.operatorVisibleConfirmation ?? evidence.operator_visible_confirmation ?? false;
  const reviewReference = evidence.reviewReference;
  const expectedReference = table.operatorReview.reviewReference;
  if (evidence.operatorTarget && evidence.operatorTarget !== table.source.operatorTarget) reasons.push("operator target mismatch");
  if (expectedReference && reviewReference !== expectedReference) reasons.push("review reference mismatch");
  if (isExpiredEvidence(evidence, generatedAt, options)) reasons.push("evidence is stale or expired");
  if (type === "provider_accepted") reasons.push("provider accepted is not visibility or approval evidence");
  if (type === "approve" && !operatorVisibleConfirmation) reasons.push("approve evidence requires operator-visible confirmation");

  let classification: "accepted" | "rejected" | "more_evidence" | "insufficient" | "conflict" | "expired" = "insufficient";
  if (type === "conflict") classification = "conflict";
  else if (type === "expired" || reasons.includes("evidence is stale or expired")) classification = "expired";
  else if (type === "reject" && reasons.length === 0) classification = "rejected";
  else if (type === "request_more_evidence" && reasons.length === 0) classification = "more_evidence";
  else if (type === "approve" && reasons.length === 0 && operatorVisibleConfirmation) classification = "accepted";

  return {
    type,
    operatorTarget: evidence.operatorTarget,
    reviewReference,
    approvalReference: evidence.approvalReference,
    decision: evidence.decision,
    operatorVisibleConfirmation,
    observedAt: evidence.observedAt ?? evidence.observed_at,
    source: evidence.source,
    classification,
    reasons,
  };
}

function buildSourceBlockers(table: TerminalBriefSidecarOperatorReviewTablePacket): string[] {
  return unique([
    ...table.blockers,
    ...(table.state !== "review_table_ready" ? ["operator review table is " + table.state] : []),
    ...(!table.readiness.reviewTableReady ? ["operator review table is not ready"] : []),
    ...(table.readiness.approvalRequestDispatchPermitted !== false ? ["operator review table unexpectedly permits approval dispatch"] : []),
    ...(table.readiness.approvalGrantPermitted !== false ? ["operator review table unexpectedly permits approval grant"] : []),
    ...(table.readiness.providerSendPermitted !== false ? ["operator review table unexpectedly permits provider send"] : []),
    ...(table.readiness.terminalAckPermitted !== false ? ["operator review table unexpectedly permits terminal ACK"] : []),
    ...(table.readiness.executionPermitted !== false ? ["operator review table unexpectedly permits execution"] : []),
    ...(table.integrationContract.sendsApprovalRequest ? ["operator review table unexpectedly sends approval request"] : []),
    ...(table.integrationContract.grantsApproval ? ["operator review table unexpectedly grants approval"] : []),
    ...(table.integrationContract.executesAction ? ["operator review table unexpectedly executes action"] : []),
    ...(table.semantics.performsProviderSend ? ["operator review table unexpectedly performs provider send"] : []),
    ...(table.semantics.performsTerminalAck ? ["operator review table unexpectedly performs terminal ACK"] : []),
    ...(table.semantics.performsRuntimeRestartOrDeploy ? ["operator review table unexpectedly performs restart/deploy"] : []),
    ...(table.semantics.performsDbMutation ? ["operator review table unexpectedly performs DB mutation"] : []),
    ...(table.semantics.movesSecretsOrCredentials ? ["operator review table unexpectedly moves secrets/credentials"] : []),
  ].filter(Boolean));
}

function stateFor(
  table: TerminalBriefSidecarOperatorReviewTablePacket,
  blockers: string[],
  normalized: TerminalBriefSidecarReviewDecisionIngestorPacket["decisionEvidence"]["normalized"],
): TerminalBriefSidecarReviewDecisionState {
  if (table.state === "stale") return "stale";
  if (table.state === "conflicting") return "conflicting";
  if (table.state === "rejected") return "rejected";
  if (table.state === "blocked") return "blocked";
  if (table.state !== "review_table_ready") return "waiting_for_operator_review_table";
  if (blockers.length) return "blocked";
  if (normalized.some((item) => item.classification === "conflict")) return "conflicting";
  if (normalized.some((item) => item.classification === "expired")) return "expired";
  if (normalized.some((item) => item.classification === "rejected")) return "rejected";
  if (normalized.some((item) => item.classification === "more_evidence")) return "more_evidence_requested";
  if (normalized.some((item) => item.classification === "accepted")) return "approved_evidence";
  return "insufficient";
}

function missingEvidenceFor(
  table: TerminalBriefSidecarOperatorReviewTablePacket,
  evidence: TerminalBriefSidecarReviewDecisionEvidence[],
  normalized: TerminalBriefSidecarReviewDecisionIngestorPacket["decisionEvidence"]["normalized"],
): string[] {
  const missing: string[] = [];
  if (table.state !== "review_table_ready") missing.push("ready_operator_review_table");
  if (!evidence.length) missing.push("operator_decision_evidence");
  if (!normalized.some((item) => item.classification === "accepted" || item.classification === "rejected" || item.classification === "more_evidence")) {
    missing.push("recognized_operator_decision");
  }
  if (normalized.some((item) => item.type === "approve" && !item.operatorVisibleConfirmation)) {
    missing.push("operator_visible_confirmation");
  }
  return unique(missing);
}

function isExpiredEvidence(
  evidence: TerminalBriefSidecarReviewDecisionEvidence,
  generatedAt: string,
  options: TerminalBriefSidecarReviewDecisionIngestorOptions,
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

function nextActionFor(state: TerminalBriefSidecarReviewDecisionState): string {
  if (state === "approved_evidence") return "broker finalizer may prepare a later separate approval-grant/execution proposal, but this packet grants nothing";
  if (state === "rejected") return "stop this approval path unless operator changes the decision";
  if (state === "more_evidence_requested") return "collect the requested additional evidence before continuing";
  if (state === "insufficient") return "wait for operator-visible approve, reject, or request-more-evidence decision";
  if (state === "expired") return "refresh operator decision evidence";
  if (state === "conflicting") return "resolve conflicting operator decision evidence";
  if (state === "waiting_for_operator_review_table") return "resolve operator review table readiness first";
  return "resolve blocked source review table before ingesting decisions";
}

function nextActionsFor(state: TerminalBriefSidecarReviewDecisionState): string[] {
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

function buildReviewDecisionIngestorIdempotencyKey(
  table: TerminalBriefSidecarOperatorReviewTablePacket,
  evidence: TerminalBriefSidecarReviewDecisionEvidence[],
  generatedAt: string,
  state: TerminalBriefSidecarReviewDecisionState,
): string {
  const base = JSON.stringify({ label: "terminal-brief-sidecar-review-decision-ingestor", table: table.idempotencyKey, evidence, generatedAt, state });
  return "tb-sidecar-review-decision-ingestor:" + createHash("sha256").update(base).digest("hex").slice(0, 24);
}

function titleForState(state: TerminalBriefSidecarReviewDecisionState): string {
  if (state === "approved_evidence") return "Accepted: Terminal Brief sidecar operator review decision evidence";
  if (state === "rejected") return "Rejected: Terminal Brief sidecar operator review decision evidence";
  if (state === "more_evidence_requested") return "More evidence requested: Terminal Brief sidecar operator review decision";
  if (state === "insufficient") return "Insufficient: Terminal Brief sidecar operator review decision evidence";
  if (state === "expired") return "Expired: Terminal Brief sidecar operator review decision evidence";
  if (state === "conflicting") return "Conflicting: Terminal Brief sidecar operator review decision evidence";
  if (state === "waiting_for_operator_review_table") return "Waiting: Terminal Brief sidecar operator review table";
  return "Blocked: Terminal Brief sidecar operator review decision ingestor";
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function isTerminalBriefSidecarOperatorReviewTablePacket(
  value: unknown,
): value is TerminalBriefSidecarOperatorReviewTablePacket {
  return isRecord(value) && value.kind === "a2a-broker.terminal-brief-sidecar-operator-review-table.packet";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
