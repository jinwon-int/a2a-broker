import { createHash } from "node:crypto";

import type { TerminalBriefSidecarActivationApprovalPacket } from "./terminal-brief-sidecar-activation-approval.js";

export type TerminalBriefSidecarActivationReceiptEvidenceKind =
  | "provider_accepted"
  | "current_session_visible"
  | "manual_operator_confirmation"
  | "approval_grant"
  | "rejected"
  | "expired"
  | "conflict"
  | "unknown";

export type TerminalBriefSidecarActivationReceiptIngestorState =
  | "accepted"
  | "insufficient"
  | "stale"
  | "conflicting"
  | "rejected"
  | "blocked";

export interface TerminalBriefSidecarActivationReceiptEvidenceInput {
  kind?: string;
  status?: string;
  observedAt?: string;
  observed_at?: string;
  expiresAt?: string;
  expires_at?: string;
  receiptId?: string;
  receipt_id?: string;
  providerMessageId?: string;
  provider_message_id?: string;
  target?: string;
  channel?: string;
  action?: string;
  approvedAction?: string;
  approved_action?: string;
  approvedTarget?: string;
  approved_target?: string;
  operatorId?: string;
  operator_id?: string;
  currentSessionId?: string;
  current_session_id?: string;
  source?: string;
  note?: string;
}

export interface TerminalBriefSidecarActivationReceiptIngestorOptions {
  now?: string;
  mode?: string;
  maxAgeMs?: number;
}

export interface TerminalBriefSidecarActivationReceiptEvidenceRecord {
  kind: TerminalBriefSidecarActivationReceiptEvidenceKind;
  rawKind?: string;
  observedAt?: string;
  expiresAt?: string;
  receiptId?: string;
  providerMessageId?: string;
  target?: string;
  channel?: string;
  action?: string;
  approvedAction?: string;
  approvedTarget?: string;
  operatorId?: string;
  currentSessionId?: string;
  source?: string;
  note?: string;
  stale: boolean;
  conflict: boolean;
  reason: string;
}

export interface TerminalBriefSidecarActivationReceiptIngestorPacket {
  kind: "a2a-broker.terminal-brief-sidecar-activation-receipt-ingestor.packet";
  version: 1;
  generatedAt: string;
  mode: string;
  parentRoundId?: string;
  state: TerminalBriefSidecarActivationReceiptIngestorState;
  dryRunOnly: true;
  sourceOnlyNoLive: true;
  receiptEvidenceAccepted: boolean;
  approvalEvidenceAccepted: boolean;
  idempotencyKey: string;
  source: {
    activationApprovalState: TerminalBriefSidecarActivationApprovalPacket["state"];
    activationApprovalIdempotencyKey: string;
    requestedAction: TerminalBriefSidecarActivationApprovalPacket["requestDraft"]["requestedAction"];
    requestedBy: string;
    operatorTarget: string;
    operatorChannel?: string;
    dispatchRequired: boolean;
    dispatchPermitted: false;
  };
  evidence: {
    received: number;
    acceptedKinds: TerminalBriefSidecarActivationReceiptEvidenceKind[];
    staleKinds: TerminalBriefSidecarActivationReceiptEvidenceKind[];
    conflictingKinds: TerminalBriefSidecarActivationReceiptEvidenceKind[];
    rejectedKinds: TerminalBriefSidecarActivationReceiptEvidenceKind[];
    records: TerminalBriefSidecarActivationReceiptEvidenceRecord[];
  };
  classification: {
    providerAccepted: boolean;
    currentSessionVisible: boolean;
    manualOperatorConfirmed: boolean;
    approvalGrantAccepted: boolean;
    receiptProofAccepted: boolean;
    rejected: boolean;
    expired: boolean;
    stale: boolean;
    terminalAckEligible: boolean;
    providerAcceptedIsVisibilityProof: false;
    reason: string;
  };
  readiness: {
    sourceCriteriaMet: boolean;
    approvalEvidenceAccepted: boolean;
    sidecarStartPermitted: false;
    defaultOnPermitted: false;
    liveActivationPermitted: false;
    approvalGrantPermitted: false;
    providerSendPermitted: false;
    terminalAckPermitted: false;
    executionPermitted: false;
    blockers: string[];
    nextAction: string;
  };
  blockers: string[];
  nextActions: string[];
  approvalSensitiveActionsExcluded: string[];
  integrationContract: {
    transport: "json";
    evidenceSchemaVersion: 1;
    harnessNeutral: true;
    openclawMessageSendRequired: false;
    hermesAdapterCompatible: true;
    gongyungAdapterCompatible: true;
    consumesActivationApprovalPacket: true;
    providerAcceptedIsVisibilityProof: false;
    terminalAckRequiresVisibilityProof: true;
    grantsApproval: false;
    startsSidecar: false;
    enablesDefaultOn: false;
    executesAction: false;
  };
  semantics: {
    receiptIngestorOnly: true;
    sourceOnlyNoLive: true;
    evidenceDoesNotMutateState: true;
    providerAcceptedIsVisibilityProof: false;
    terminalAckEligibleDoesNotPermitAck: true;
    approvalGrantEvidenceDoesNotGrantApproval: true;
    sidecarStartRequiresSeparateApprovedExecutor: true;
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

interface ReceiptClassificationCore {
  providerAccepted: boolean;
  currentSessionVisible: boolean;
  manualOperatorConfirmed: boolean;
  approvalGrantAccepted: boolean;
  receiptProofAccepted: boolean;
  rejected: boolean;
  expired: boolean;
  stale: boolean;
}

export function buildTerminalBriefSidecarActivationReceiptIngestor(
  activationApproval: TerminalBriefSidecarActivationApprovalPacket,
  evidenceInput: TerminalBriefSidecarActivationReceiptEvidenceInput[] = [],
  options: TerminalBriefSidecarActivationReceiptIngestorOptions = {},
): TerminalBriefSidecarActivationReceiptIngestorPacket {
  const generatedAt = options.now ?? new Date().toISOString();
  const nowMs = Date.parse(generatedAt);
  const maxAgeMs = Math.max(0, options.maxAgeMs ?? 5 * 60 * 1000);
  const records = evidenceInput.map((record) => normalizeEvidenceRecord(record, activationApproval, nowMs, maxAgeMs));
  const blockers = buildBlockers(activationApproval, records);
  const classification = classifyEvidence(records);
  const state = stateForClassification(activationApproval, classification, blockers, records);
  const receiptEvidenceAccepted = state === "accepted" && classification.receiptProofAccepted;
  const approvalEvidenceAccepted = state === "accepted" && classification.approvalGrantAccepted;
  const terminalAckEligible = state === "accepted" && classification.receiptProofAccepted;
  return {
    kind: "a2a-broker.terminal-brief-sidecar-activation-receipt-ingestor.packet",
    version: 1,
    generatedAt,
    mode: options.mode ?? activationApproval.mode,
    parentRoundId: activationApproval.parentRoundId,
    state,
    dryRunOnly: true,
    sourceOnlyNoLive: true,
    receiptEvidenceAccepted,
    approvalEvidenceAccepted,
    idempotencyKey: buildReceiptIngestorIdempotencyKey(activationApproval, state, records, maxAgeMs),
    source: {
      activationApprovalState: activationApproval.state,
      activationApprovalIdempotencyKey: activationApproval.idempotencyKey,
      requestedAction: activationApproval.requestDraft.requestedAction,
      requestedBy: activationApproval.requestDraft.requestedBy,
      operatorTarget: activationApproval.requestDraft.operatorTarget,
      operatorChannel: activationApproval.requestDraft.operatorChannel,
      dispatchRequired: activationApproval.requestDraft.dispatchRequired,
      dispatchPermitted: false,
    },
    evidence: {
      received: records.length,
      acceptedKinds: unique(records.filter((record) => !record.stale && !record.conflict && isStrongReceiptKind(record.kind)).map((record) => record.kind)),
      staleKinds: unique(records.filter((record) => record.stale).map((record) => record.kind)),
      conflictingKinds: unique(records.filter((record) => record.conflict || record.kind === "conflict").map((record) => record.kind)),
      rejectedKinds: unique(records.filter((record) => isNegativeKind(record.kind)).map((record) => record.kind)),
      records,
    },
    classification: {
      ...classification,
      terminalAckEligible,
      providerAcceptedIsVisibilityProof: false,
      reason: reasonForState(state, classification, blockers, records),
    },
    readiness: {
      sourceCriteriaMet: state === "accepted",
      approvalEvidenceAccepted,
      sidecarStartPermitted: false,
      defaultOnPermitted: false,
      liveActivationPermitted: false,
      approvalGrantPermitted: false,
      providerSendPermitted: false,
      terminalAckPermitted: false,
      executionPermitted: false,
      blockers: [
        ...blockers,
        "approval grant evidence does not grant approval in this ingestor",
        "sidecar start still requires a separate approved executor path",
      ],
      nextAction: state === "accepted"
        ? "feed accepted no-live approval evidence into the supervised dry-run start executor gate"
        : "collect non-conflicting visibility/manual receipt and matching approval grant evidence",
    },
    blockers,
    nextActions: nextActionsForState(state),
    approvalSensitiveActionsExcluded: [
      "starting/enabling always-on sidecar",
      "Terminal Brief default-on enablement",
      "live provider/Hermes/Gongyung/Telegram/OpenClaw send",
      "terminal ACK/replay or terminal receipt DB mutation",
      "operator approval grant mutation or execution",
      "GitHub PR merge, issue close, or comment post from the ingestor",
      "TaskFlow record creation or broker DB mutation",
      "production deploy/restart, historical replay, release, publish, or secret movement",
    ],
    integrationContract: {
      transport: "json",
      evidenceSchemaVersion: 1,
      harnessNeutral: true,
      openclawMessageSendRequired: false,
      hermesAdapterCompatible: true,
      gongyungAdapterCompatible: true,
      consumesActivationApprovalPacket: true,
      providerAcceptedIsVisibilityProof: false,
      terminalAckRequiresVisibilityProof: true,
      grantsApproval: false,
      startsSidecar: false,
      enablesDefaultOn: false,
      executesAction: false,
    },
    semantics: {
      receiptIngestorOnly: true,
      sourceOnlyNoLive: true,
      evidenceDoesNotMutateState: true,
      providerAcceptedIsVisibilityProof: false,
      terminalAckEligibleDoesNotPermitAck: true,
      approvalGrantEvidenceDoesNotGrantApproval: true,
      sidecarStartRequiresSeparateApprovedExecutor: true,
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

export function extractTerminalBriefSidecarActivationApprovalPacket(
  input: unknown,
): TerminalBriefSidecarActivationApprovalPacket {
  const envelope = isRecord(input) ? input : {};
  const candidates = [
    input,
    envelope.activationApproval,
    envelope.activationApprovalPacket,
    envelope.sidecarActivationApproval,
    envelope.sidecarActivationApprovalPacket,
    envelope.packet,
  ];
  const packet = candidates.find(isTerminalBriefSidecarActivationApprovalPacket);
  if (!packet) {
    throw new Error("expected a Terminal Brief sidecar activation approval packet");
  }
  return packet;
}

export function extractTerminalBriefSidecarActivationReceiptEvidence(
  input: unknown,
): TerminalBriefSidecarActivationReceiptEvidenceInput[] {
  const envelope = isRecord(input) ? input : {};
  const candidate =
    envelope.activationReceiptEvidence
      ?? envelope.receiptEvidence
      ?? envelope.approvalEvidence
      ?? envelope.evidence
      ?? envelope.evidenceRecords
      ?? envelope.records
      ?? envelope.receipt
      ?? envelope.receiptRecord;
  if (Array.isArray(candidate)) return candidate.filter(isRecord).map((record) => record as TerminalBriefSidecarActivationReceiptEvidenceInput);
  if (isRecord(candidate)) return [candidate as TerminalBriefSidecarActivationReceiptEvidenceInput];
  return [];
}

export function renderTerminalBriefSidecarActivationReceiptIngestorMarkdown(
  packet: TerminalBriefSidecarActivationReceiptIngestorPacket,
): string {
  return [
    titleForState(packet.state),
    "Mode: " + packet.mode,
    "Parent round: " + (packet.parentRoundId ?? "unknown"),
    "State: " + packet.state + " dryRunOnly=" + packet.dryRunOnly + " sourceOnlyNoLive=" + packet.sourceOnlyNoLive,
    "Idempotency: " + packet.idempotencyKey,
    "Activation approval: state=" + packet.source.activationApprovalState
      + " requestedAction=" + packet.source.requestedAction
      + " dispatchPermitted=" + packet.source.dispatchPermitted,
    "Evidence: received=" + packet.evidence.received
      + " acceptedKinds=" + list(packet.evidence.acceptedKinds)
      + " staleKinds=" + list(packet.evidence.staleKinds)
      + " conflictingKinds=" + list(packet.evidence.conflictingKinds)
      + " rejectedKinds=" + list(packet.evidence.rejectedKinds),
    "Classification: providerAccepted=" + packet.classification.providerAccepted
      + " currentSessionVisible=" + packet.classification.currentSessionVisible
      + " manualOperatorConfirmed=" + packet.classification.manualOperatorConfirmed
      + " approvalGrantAccepted=" + packet.classification.approvalGrantAccepted
      + " receiptProofAccepted=" + packet.classification.receiptProofAccepted
      + " terminalAckEligible=" + packet.classification.terminalAckEligible
      + " terminalAckPermitted=" + packet.readiness.terminalAckPermitted,
    "Reason: " + packet.classification.reason,
    "Harness contract: JSON transport; providerAcceptedIsVisibilityProof=false; terminalAckRequiresVisibilityProof=true; grantsApproval=false; startsSidecar=false; executesAction=false.",
    ...(packet.blockers.length ? ["", "Blockers:", ...packet.blockers.map((blocker) => "- " + blocker)] : []),
    "",
    "Next actions:",
    ...packet.nextActions.map((action) => "- " + action),
    "",
    "Safety: receipt ingestor only; evidence does not mutate state; provider accepted is not visibility proof; terminalAckEligible never permits ACK here; approval grant evidence does not grant approval; sidecar start is not permitted; no live send, terminal ACK/replay, restart/deploy, DB mutation, TaskFlow record creation, historical replay, release, or secret movement.",
  ].join("\n");
}

function normalizeEvidenceRecord(
  input: TerminalBriefSidecarActivationReceiptEvidenceInput,
  activationApproval: TerminalBriefSidecarActivationApprovalPacket,
  nowMs: number,
  maxAgeMs: number,
): TerminalBriefSidecarActivationReceiptEvidenceRecord {
  const rawKind = optionalString(input.kind ?? input.status);
  const kind = normalizeEvidenceKind(rawKind);
  const observedAt = optionalString(input.observedAt ?? input.observed_at);
  const expiresAt = optionalString(input.expiresAt ?? input.expires_at);
  const action = optionalString(input.action);
  const approvedAction = optionalString(input.approvedAction ?? input.approved_action);
  const target = optionalString(input.target);
  const approvedTarget = optionalString(input.approvedTarget ?? input.approved_target);
  const stale = isStale(kind, observedAt, expiresAt, nowMs, maxAgeMs);
  const conflict = kind === "conflict" || conflictsWithActivationApproval(kind, activationApproval, { action, approvedAction, target, approvedTarget });
  return {
    kind,
    rawKind,
    observedAt,
    expiresAt,
    receiptId: optionalString(input.receiptId ?? input.receipt_id),
    providerMessageId: optionalString(input.providerMessageId ?? input.provider_message_id),
    target,
    channel: optionalString(input.channel),
    action,
    approvedAction,
    approvedTarget,
    operatorId: optionalString(input.operatorId ?? input.operator_id),
    currentSessionId: optionalString(input.currentSessionId ?? input.current_session_id),
    source: optionalString(input.source),
    note: optionalString(input.note),
    stale,
    conflict,
    reason: reasonForRecord(kind, stale, conflict),
  };
}

function normalizeEvidenceKind(value?: string): TerminalBriefSidecarActivationReceiptEvidenceKind {
  const raw = value?.trim().toLowerCase().replace(/[-\s]+/g, "_");
  if (!raw) return "unknown";
  if (["provider_accepted", "provider_sent", "sent", "delivered", "produced"].includes(raw)) return "provider_accepted";
  if (["current_session_visible", "current_session", "visible", "operator_visible", "read_visible"].includes(raw)) return "current_session_visible";
  if (["manual_operator_confirmation", "manual_operator_receipt", "operator_confirmed", "manual_confirmed"].includes(raw)) return "manual_operator_confirmation";
  if (["approval_grant", "approval_granted", "approved"].includes(raw)) return "approval_grant";
  if (["rejected", "denied", "approval_rejected"].includes(raw)) return "rejected";
  if (["expired", "timed_out", "timeout"].includes(raw)) return "expired";
  if (["conflict", "conflicting", "mismatch"].includes(raw)) return "conflict";
  return "unknown";
}

function isStale(
  kind: TerminalBriefSidecarActivationReceiptEvidenceKind,
  observedAt: string | undefined,
  expiresAt: string | undefined,
  nowMs: number,
  maxAgeMs: number,
): boolean {
  if (kind === "expired") return true;
  const expiresAtMs = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  if (Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs) return true;
  const observedAtMs = observedAt ? Date.parse(observedAt) : Number.NaN;
  if (Number.isFinite(observedAtMs) && nowMs - observedAtMs > maxAgeMs) return true;
  return false;
}

function conflictsWithActivationApproval(
  kind: TerminalBriefSidecarActivationReceiptEvidenceKind,
  activationApproval: TerminalBriefSidecarActivationApprovalPacket,
  fields: { action?: string; approvedAction?: string; target?: string; approvedTarget?: string },
): boolean {
  if (kind !== "approval_grant") return false;
  const expectedAction = activationApproval.requestDraft.requestedAction;
  const expectedTarget = activationApproval.parentRoundId ?? activationApproval.requestDraft.operatorTarget;
  const actualAction = fields.approvedAction ?? fields.action;
  const actualTarget = fields.approvedTarget ?? fields.target;
  if (actualAction && actualAction !== expectedAction) return true;
  if (actualTarget && actualTarget !== expectedTarget) return true;
  return false;
}

function buildBlockers(
  activationApproval: TerminalBriefSidecarActivationApprovalPacket,
  records: TerminalBriefSidecarActivationReceiptEvidenceRecord[],
): string[] {
  return unique([
    ...activationApproval.blockers,
    ...(activationApproval.state !== "approval_request_draft_ready" ? ["activation approval packet is " + activationApproval.state] : []),
    ...(activationApproval.requestDraft.status !== "draft_not_sent" ? ["activation approval request draft is not ready"] : []),
    ...(activationApproval.requestDraft.dispatchPermitted !== false ? ["activation approval unexpectedly permits dispatch"] : []),
    ...(activationApproval.readiness.sidecarStartPermitted !== false ? ["activation approval unexpectedly permits sidecar start"] : []),
    ...(activationApproval.readiness.defaultOnPermitted !== false ? ["activation approval unexpectedly permits default-on"] : []),
    ...(activationApproval.readiness.approvalGrantPermitted !== false ? ["activation approval unexpectedly permits approval grant"] : []),
    ...(activationApproval.readiness.providerSendPermitted !== false ? ["activation approval unexpectedly permits provider send"] : []),
    ...(activationApproval.readiness.terminalAckPermitted !== false ? ["activation approval unexpectedly permits terminal ACK"] : []),
    ...(activationApproval.readiness.executionPermitted !== false ? ["activation approval unexpectedly permits execution"] : []),
    ...(activationApproval.integrationContract.sendsApprovalRequest ? ["activation approval unexpectedly sends approval request"] : []),
    ...(activationApproval.integrationContract.startsSidecar ? ["activation approval unexpectedly starts sidecar"] : []),
    ...(activationApproval.integrationContract.enablesDefaultOn ? ["activation approval unexpectedly enables default-on"] : []),
    ...(activationApproval.integrationContract.grantsApproval ? ["activation approval unexpectedly grants approval"] : []),
    ...(activationApproval.integrationContract.executesAction ? ["activation approval unexpectedly executes action"] : []),
    ...(activationApproval.semantics.performsProviderSend ? ["activation approval unexpectedly performs provider send"] : []),
    ...(activationApproval.semantics.performsTerminalAck ? ["activation approval unexpectedly performs terminal ACK"] : []),
    ...(activationApproval.semantics.performsRuntimeRestartOrDeploy ? ["activation approval unexpectedly performs restart/deploy"] : []),
    ...(activationApproval.semantics.performsDbMutation ? ["activation approval unexpectedly performs DB mutation"] : []),
    ...(activationApproval.semantics.performsHistoricalReplay ? ["activation approval unexpectedly performs historical replay"] : []),
    ...(activationApproval.semantics.performsReleaseOrPublish ? ["activation approval unexpectedly performs release/publish"] : []),
    ...(activationApproval.semantics.movesSecretsOrCredentials ? ["activation approval unexpectedly moves secrets/credentials"] : []),
    ...(records.some((record) => record.kind === "unknown") ? ["activation approval receipt evidence contains an unsupported kind"] : []),
  ].filter(Boolean));
}

function classifyEvidence(records: TerminalBriefSidecarActivationReceiptEvidenceRecord[]): ReceiptClassificationCore {
  const fresh = records.filter((record) => !record.stale && !record.conflict);
  const receiptProofAccepted = fresh.some((record) => record.kind === "current_session_visible" || record.kind === "manual_operator_confirmation");
  return {
    providerAccepted: fresh.some((record) => record.kind === "provider_accepted"),
    currentSessionVisible: fresh.some((record) => record.kind === "current_session_visible"),
    manualOperatorConfirmed: fresh.some((record) => record.kind === "manual_operator_confirmation"),
    approvalGrantAccepted: fresh.some((record) => record.kind === "approval_grant"),
    receiptProofAccepted,
    rejected: fresh.some((record) => record.kind === "rejected"),
    expired: records.some((record) => record.kind === "expired"),
    stale: records.some((record) => record.stale),
  };
}

function stateForClassification(
  activationApproval: TerminalBriefSidecarActivationApprovalPacket,
  classification: ReceiptClassificationCore,
  blockers: string[],
  records: TerminalBriefSidecarActivationReceiptEvidenceRecord[],
): TerminalBriefSidecarActivationReceiptIngestorState {
  if (blockers.length > 0) return "blocked";
  if (activationApproval.state === "stale") return "stale";
  if (records.some((record) => record.conflict) || records.some((record) => record.kind === "conflict")) return "conflicting";
  if (hasFreshPositive(records) && classification.rejected) return "conflicting";
  if (classification.rejected) return "rejected";
  if (records.length > 0 && records.every((record) => record.stale)) return "stale";
  if (classification.receiptProofAccepted && classification.approvalGrantAccepted) return "accepted";
  return "insufficient";
}

function reasonForState(
  state: TerminalBriefSidecarActivationReceiptIngestorState,
  classification: ReceiptClassificationCore,
  blockers: string[],
  records: TerminalBriefSidecarActivationReceiptEvidenceRecord[],
): string {
  if (state === "blocked") return blockers[0] ?? "activation approval receipt evidence is blocked";
  if (state === "conflicting") return "receipt or approval evidence conflicts with activation approval request";
  if (state === "rejected") return "operator rejected the sidecar activation approval request";
  if (state === "stale") return "receipt or approval evidence is stale or expired";
  if (state === "accepted") return "visibility/manual receipt evidence and matching approval grant evidence accepted as no-live evidence only";
  if (classification.providerAccepted) return "provider accepted evidence is insufficient without visibility/manual receipt and matching approval grant";
  if (classification.receiptProofAccepted) return "visibility/manual receipt evidence is present but approval grant evidence is missing";
  if (classification.approvalGrantAccepted) return "approval grant evidence is present but visibility/manual receipt evidence is missing";
  if (records.length === 0) return "no activation receipt evidence supplied";
  return "activation receipt evidence is insufficient";
}

function reasonForRecord(
  kind: TerminalBriefSidecarActivationReceiptEvidenceKind,
  stale: boolean,
  conflict: boolean,
): string {
  if (conflict) return "evidence conflicts with activation approval requested action or target";
  if (stale) return "evidence is stale or expired";
  if (kind === "provider_accepted") return "provider accepted is not visibility proof";
  if (kind === "current_session_visible") return "current-session-visible evidence is receipt proof but does not perform ACK";
  if (kind === "manual_operator_confirmation") return "manual operator confirmation is receipt proof but does not perform ACK";
  if (kind === "approval_grant") return "approval grant evidence is recorded but does not grant approval in this ingestor";
  if (kind === "rejected") return "operator rejected the activation approval request";
  if (kind === "expired") return "evidence is expired";
  if (kind === "conflict") return "evidence reports a conflict";
  return "unsupported activation receipt evidence kind";
}

function nextActionsForState(state: TerminalBriefSidecarActivationReceiptIngestorState): string[] {
  if (state === "accepted") {
    return [
      "feed accepted no-live evidence into a separate supervised dry-run start executor gate",
      "keep sidecar start/default-on/live send/terminal ACK/deploy/DB mutation behind separate approval gates",
    ];
  }
  if (state === "insufficient") {
    return [
      "collect current-session-visible or manual operator confirmation plus matching approval grant evidence",
      "do not treat provider accepted evidence as visibility proof or approval grant",
    ];
  }
  if (state === "stale") {
    return [
      "refresh receipt and approval evidence before executor gate review",
      "do not start sidecar from stale approval evidence",
    ];
  }
  if (state === "conflicting") {
    return [
      "resolve conflicting receipt or approval evidence before executor gate review",
      "rerun the ingestor with one coherent evidence set",
    ];
  }
  if (state === "rejected") {
    return [
      "do not start the supervised dry-run sidecar",
      "collect a new approval request if the operator later changes the decision",
    ];
  }
  return [
    "recover blocked activation approval source or unsupported evidence before continuing",
    "do not use blocked evidence as approval or sidecar-start proof",
  ];
}

function buildReceiptIngestorIdempotencyKey(
  activationApproval: TerminalBriefSidecarActivationApprovalPacket,
  state: TerminalBriefSidecarActivationReceiptIngestorState,
  records: TerminalBriefSidecarActivationReceiptEvidenceRecord[],
  maxAgeMs: number,
): string {
  const base = JSON.stringify({
    label: "terminal-brief-sidecar-activation-receipt-ingestor",
    parentRoundId: activationApproval.parentRoundId ?? "unknown",
    activationApproval: activationApproval.idempotencyKey,
    state,
    maxAgeMs,
    records: records.map((record) => ({
      kind: record.kind,
      observedAt: record.observedAt,
      expiresAt: record.expiresAt,
      receiptId: record.receiptId,
      providerMessageId: record.providerMessageId,
      target: record.target,
      action: record.action,
      approvedAction: record.approvedAction,
      approvedTarget: record.approvedTarget,
      stale: record.stale,
      conflict: record.conflict,
    })),
  });
  return "tb-sidecar-activation-receipt:" + createHash("sha256").update(base).digest("hex").slice(0, 24);
}

function hasFreshPositive(records: TerminalBriefSidecarActivationReceiptEvidenceRecord[]): boolean {
  return records.some((record) => !record.stale && !record.conflict && isPositiveKind(record.kind));
}

function isPositiveKind(kind: TerminalBriefSidecarActivationReceiptEvidenceKind): boolean {
  return kind === "provider_accepted"
    || kind === "current_session_visible"
    || kind === "manual_operator_confirmation"
    || kind === "approval_grant";
}

function isStrongReceiptKind(kind: TerminalBriefSidecarActivationReceiptEvidenceKind): boolean {
  return kind === "current_session_visible"
    || kind === "manual_operator_confirmation"
    || kind === "approval_grant";
}

function isNegativeKind(kind: TerminalBriefSidecarActivationReceiptEvidenceKind): boolean {
  return kind === "rejected" || kind === "expired";
}

function titleForState(state: TerminalBriefSidecarActivationReceiptIngestorState): string {
  if (state === "accepted") return "Accepted: Terminal Brief sidecar activation receipt evidence";
  if (state === "insufficient") return "Insufficient: Terminal Brief sidecar activation receipt evidence";
  if (state === "stale") return "Stale: Terminal Brief sidecar activation receipt evidence";
  if (state === "conflicting") return "Conflicting: Terminal Brief sidecar activation receipt evidence";
  if (state === "rejected") return "Rejected: Terminal Brief sidecar activation approval";
  return "Blocked: Terminal Brief sidecar activation receipt evidence";
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function list(items: unknown[]): string {
  return items.length ? items.join(",") : "none";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isTerminalBriefSidecarActivationApprovalPacket(value: unknown): value is TerminalBriefSidecarActivationApprovalPacket {
  return isRecord(value) && value.kind === "a2a-broker.terminal-brief-sidecar-activation-approval.packet";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
