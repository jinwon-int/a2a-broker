import { createHash } from "node:crypto";

import type {
  TerminalBriefApprovalDispatchAdapterPacket,
  TerminalBriefApprovalDispatchAdapterState,
} from "./terminal-brief-approval-dispatch-adapter.js";

export type TerminalBriefApprovalReceiptEvidenceKind =
  | "provider_accepted"
  | "current_session_visible"
  | "manual_operator_confirmation"
  | "approval_grant"
  | "rejected"
  | "expired"
  | "unknown";

export type TerminalBriefApprovalReceiptIngestorState =
  | "accepted"
  | "insufficient"
  | "stale"
  | "conflicting"
  | "blocked";

export interface TerminalBriefApprovalReceiptEvidenceInput {
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

export interface TerminalBriefApprovalReceiptIngestorOptions {
  now?: string;
  mode?: string;
  maxAgeMs?: number;
}

export interface TerminalBriefApprovalReceiptIngestorPacket {
  kind: "a2a-broker.terminal-brief-approval-receipt-ingestor.packet";
  version: 1;
  generatedAt: string;
  mode: string;
  parentRoundId?: string;
  state: TerminalBriefApprovalReceiptIngestorState;
  dryRunOnly: true;
  receiptEvidenceAccepted: boolean;
  providerSendPermitted: false;
  approvalGrantPermitted: false;
  executionPermitted: false;
  terminalAckPermitted: false;
  terminalReceiptMutationPermitted: false;
  idempotencyKey: string;
  finalizer: TerminalBriefApprovalDispatchAdapterPacket["finalizer"];
  source: {
    dispatchState: TerminalBriefApprovalDispatchAdapterState;
    dispatchIdempotencyKey: string;
    adapterType: TerminalBriefApprovalDispatchAdapterPacket["adapter"]["type"];
    transcriptTarget?: string;
    transcriptChannel?: string;
    selectedAction?: string;
    selectedTarget?: string;
  };
  evidence: {
    received: number;
    acceptedKinds: TerminalBriefApprovalReceiptEvidenceKind[];
    staleKinds: TerminalBriefApprovalReceiptEvidenceKind[];
    conflictingKinds: TerminalBriefApprovalReceiptEvidenceKind[];
    rejectedKinds: TerminalBriefApprovalReceiptEvidenceKind[];
    records: TerminalBriefApprovalReceiptEvidenceRecord[];
  };
  classification: {
    providerAccepted: boolean;
    currentSessionVisible: boolean;
    manualOperatorConfirmed: boolean;
    approvalGrantAccepted: boolean;
    rejected: boolean;
    expired: boolean;
    stale: boolean;
    terminalAckEligible: boolean;
    providerAcceptedIsVisibilityProof: false;
    reason: string;
  };
  blockers: string[];
  nextActions: string[];
  integrationContract: {
    transport: "json";
    evidenceSchemaVersion: 1;
    harnessNeutral: true;
    openclawMessageSendRequired: false;
    hermesAdapterCompatible: true;
    gongyungAdapterCompatible: true;
    providerAcceptedIsVisibilityProof: false;
    terminalAckRequiresVisibilityProof: true;
    grantsApproval: false;
    executesAction: false;
  };
  semantics: {
    receiptIngestorOnly: true;
    sourceOnlyNoLive: true;
    evidenceDoesNotMutateState: true;
    providerAcceptedIsVisibilityProof: false;
    terminalAckEligibleDoesNotPermitAck: true;
    approvalGrantEvidenceDoesNotGrantApproval: true;
    executionNotPermitted: true;
    routeIsReadOnly: true;
    brokerFinalizerRequired: true;
    singleFinalizerRequired: true;
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

export interface TerminalBriefApprovalReceiptEvidenceRecord {
  kind: TerminalBriefApprovalReceiptEvidenceKind;
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

interface ReceiptClassificationCore {
  providerAccepted: boolean;
  currentSessionVisible: boolean;
  manualOperatorConfirmed: boolean;
  approvalGrantAccepted: boolean;
  rejected: boolean;
  expired: boolean;
  stale: boolean;
}

export function buildTerminalBriefApprovalReceiptIngestor(
  dispatch: TerminalBriefApprovalDispatchAdapterPacket,
  evidenceInput: TerminalBriefApprovalReceiptEvidenceInput[] = [],
  options: TerminalBriefApprovalReceiptIngestorOptions = {},
): TerminalBriefApprovalReceiptIngestorPacket {
  const generatedAt = options.now ?? new Date().toISOString();
  const nowMs = Date.parse(generatedAt);
  const maxAgeMs = Math.max(0, options.maxAgeMs ?? 5 * 60 * 1000);
  const records = evidenceInput.map((record) => normalizeEvidenceRecord(record, dispatch, nowMs, maxAgeMs));
  const blockers = buildBlockers(dispatch, records);
  const classification = classifyEvidence(records);
  const state = stateForClassification(classification, blockers, records);
  const idempotencyKey = buildReceiptIngestorIdempotencyKey(dispatch, state, records, maxAgeMs);
  const terminalAckEligible = state === "accepted" && (classification.currentSessionVisible || classification.manualOperatorConfirmed);
  return {
    kind: "a2a-broker.terminal-brief-approval-receipt-ingestor.packet",
    version: 1,
    generatedAt,
    mode: options.mode ?? dispatch.mode,
    parentRoundId: dispatch.parentRoundId,
    state,
    dryRunOnly: true,
    receiptEvidenceAccepted: state === "accepted",
    providerSendPermitted: false,
    approvalGrantPermitted: false,
    executionPermitted: false,
    terminalAckPermitted: false,
    terminalReceiptMutationPermitted: false,
    idempotencyKey,
    finalizer: dispatch.finalizer,
    source: {
      dispatchState: dispatch.state,
      dispatchIdempotencyKey: dispatch.idempotencyKey,
      adapterType: dispatch.adapter.type,
      transcriptTarget: dispatch.transcript.target,
      transcriptChannel: dispatch.transcript.channel,
      selectedAction: dispatch.source.selectedAction,
      selectedTarget: dispatch.source.selectedTarget,
    },
    evidence: {
      received: records.length,
      acceptedKinds: unique(records.filter((record) => !record.stale && !record.conflict && isStrongReceiptKind(record.kind)).map((record) => record.kind)),
      staleKinds: unique(records.filter((record) => record.stale).map((record) => record.kind)),
      conflictingKinds: unique(records.filter((record) => record.conflict).map((record) => record.kind)),
      rejectedKinds: unique(records.filter((record) => isNegativeKind(record.kind)).map((record) => record.kind)),
      records,
    },
    classification: {
      ...classification,
      terminalAckEligible,
      providerAcceptedIsVisibilityProof: false,
      reason: reasonForState(state, classification, blockers, records),
    },
    blockers,
    nextActions: nextActionsForState(state),
    integrationContract: {
      transport: "json",
      evidenceSchemaVersion: 1,
      harnessNeutral: true,
      openclawMessageSendRequired: false,
      hermesAdapterCompatible: true,
      gongyungAdapterCompatible: true,
      providerAcceptedIsVisibilityProof: false,
      terminalAckRequiresVisibilityProof: true,
      grantsApproval: false,
      executesAction: false,
    },
    semantics: {
      receiptIngestorOnly: true,
      sourceOnlyNoLive: true,
      evidenceDoesNotMutateState: true,
      providerAcceptedIsVisibilityProof: false,
      terminalAckEligibleDoesNotPermitAck: true,
      approvalGrantEvidenceDoesNotGrantApproval: true,
      executionNotPermitted: true,
      routeIsReadOnly: true,
      brokerFinalizerRequired: true,
      singleFinalizerRequired: true,
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

export function extractTerminalBriefApprovalDispatchAdapterPacket(input: unknown): TerminalBriefApprovalDispatchAdapterPacket {
  const envelope = isRecord(input) ? input : {};
  const candidates = [
    input,
    envelope.approvalDispatch,
    envelope.approvalDispatchPacket,
    envelope.dispatchAdapter,
    envelope.dispatchAdapterPacket,
    envelope.packet,
  ];
  const packet = candidates.find(isTerminalBriefApprovalDispatchAdapterPacket);
  if (!packet) {
    throw new Error("expected a Terminal Brief approval dispatch adapter packet");
  }
  return packet;
}

export function extractTerminalBriefApprovalReceiptEvidence(input: unknown): TerminalBriefApprovalReceiptEvidenceInput[] {
  const envelope = isRecord(input) ? input : {};
  const candidate =
    envelope.receiptEvidence
      ?? envelope.evidence
      ?? envelope.evidenceRecords
      ?? envelope.records
      ?? envelope.receipt
      ?? envelope.receiptRecord;
  if (Array.isArray(candidate)) return candidate.filter(isRecord).map((record) => record as TerminalBriefApprovalReceiptEvidenceInput);
  if (isRecord(candidate)) return [candidate as TerminalBriefApprovalReceiptEvidenceInput];
  return [];
}

export function renderTerminalBriefApprovalReceiptIngestorMarkdown(
  packet: TerminalBriefApprovalReceiptIngestorPacket,
): string {
  return [
    titleForState(packet.state),
    "Mode: " + packet.mode,
    "Parent round: " + (packet.parentRoundId ?? "unknown"),
    "State: " + packet.state + " dryRunOnly=" + packet.dryRunOnly,
    "Idempotency: " + packet.idempotencyKey,
    "Finalizer: broker=" + packet.finalizer.brokerOfRecordId
      + " owner=" + packet.finalizer.owner
      + " singleFinalizerRequired=" + packet.finalizer.singleFinalizerRequired,
    "Source dispatch: state=" + packet.source.dispatchState
      + " adapter=" + packet.source.adapterType
      + " idempotency=" + packet.source.dispatchIdempotencyKey,
    "Selected action: " + (packet.source.selectedAction ?? "none")
      + " target=" + (packet.source.selectedTarget ?? "none"),
    "Evidence: received=" + packet.evidence.received
      + " acceptedKinds=" + list(packet.evidence.acceptedKinds)
      + " staleKinds=" + list(packet.evidence.staleKinds)
      + " conflictingKinds=" + list(packet.evidence.conflictingKinds)
      + " rejectedKinds=" + list(packet.evidence.rejectedKinds),
    "Classification: providerAccepted=" + packet.classification.providerAccepted
      + " currentSessionVisible=" + packet.classification.currentSessionVisible
      + " manualOperatorConfirmed=" + packet.classification.manualOperatorConfirmed
      + " approvalGrantAccepted=" + packet.classification.approvalGrantAccepted
      + " terminalAckEligible=" + packet.classification.terminalAckEligible
      + " terminalAckPermitted=" + packet.terminalAckPermitted,
    "Reason: " + packet.classification.reason,
    "Harness contract: JSON transport; providerAcceptedIsVisibilityProof=false; terminalAckRequiresVisibilityProof=true; grantsApproval=false; executesAction=false.",
    ...(packet.blockers.length ? ["", "Blockers:", ...packet.blockers.map((blocker) => "- " + blocker)] : []),
    "",
    "Next actions:",
    ...packet.nextActions.map((action) => "- " + action),
    "",
    "Safety: receipt ingestor only; evidence does not mutate state; provider accepted is not visibility proof; terminalAckEligible never permits ACK here; approval grant evidence does not grant approval; execution not permitted; no comment post, merge, issue close, live send, terminal ACK/replay, restart/deploy, DB mutation, TaskFlow record creation, historical replay, release, or secret movement.",
  ].join("\n");
}

function normalizeEvidenceRecord(
  input: TerminalBriefApprovalReceiptEvidenceInput,
  dispatch: TerminalBriefApprovalDispatchAdapterPacket,
  nowMs: number,
  maxAgeMs: number,
): TerminalBriefApprovalReceiptEvidenceRecord {
  const rawKind = optionalString(input.kind ?? input.status);
  const kind = normalizeEvidenceKind(rawKind);
  const observedAt = optionalString(input.observedAt ?? input.observed_at);
  const expiresAt = optionalString(input.expiresAt ?? input.expires_at);
  const action = optionalString(input.action);
  const approvedAction = optionalString(input.approvedAction ?? input.approved_action);
  const target = optionalString(input.target);
  const approvedTarget = optionalString(input.approvedTarget ?? input.approved_target);
  const stale = isStale(kind, observedAt, expiresAt, nowMs, maxAgeMs);
  const conflict = conflictsWithDispatch(kind, dispatch, { action, approvedAction, target, approvedTarget });
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

function normalizeEvidenceKind(value?: string): TerminalBriefApprovalReceiptEvidenceKind {
  const raw = value?.trim().toLowerCase().replace(/[-\s]+/g, "_");
  if (!raw) return "unknown";
  if (["provider_accepted", "provider_sent", "sent", "delivered", "produced"].includes(raw)) return "provider_accepted";
  if (["current_session_visible", "current_session", "visible", "operator_visible", "read_visible"].includes(raw)) return "current_session_visible";
  if (["manual_operator_confirmation", "manual_operator_receipt", "operator_confirmed", "manual_confirmed"].includes(raw)) return "manual_operator_confirmation";
  if (["approval_grant", "approval_granted", "approved"].includes(raw)) return "approval_grant";
  if (["rejected", "denied", "approval_rejected"].includes(raw)) return "rejected";
  if (["expired", "timed_out", "timeout"].includes(raw)) return "expired";
  return "unknown";
}

function isStale(
  kind: TerminalBriefApprovalReceiptEvidenceKind,
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

function conflictsWithDispatch(
  kind: TerminalBriefApprovalReceiptEvidenceKind,
  dispatch: TerminalBriefApprovalDispatchAdapterPacket,
  fields: { action?: string; approvedAction?: string; target?: string; approvedTarget?: string },
): boolean {
  if (kind !== "approval_grant") return false;
  const expectedAction = dispatch.source.selectedAction;
  const expectedTarget = dispatch.source.selectedTarget;
  const actualAction = fields.approvedAction ?? fields.action;
  const actualTarget = fields.approvedTarget ?? fields.target;
  if (expectedAction && actualAction && expectedAction !== actualAction) return true;
  if (expectedTarget && actualTarget && expectedTarget !== actualTarget) return true;
  return false;
}

function buildBlockers(
  dispatch: TerminalBriefApprovalDispatchAdapterPacket,
  records: TerminalBriefApprovalReceiptEvidenceRecord[],
): string[] {
  const blockers = [...dispatch.blockers];
  if (dispatch.state === "dispatch_blocked") {
    blockers.push("approval dispatch adapter is blocked; receipt evidence cannot be accepted");
  }
  if (records.some((record) => record.kind === "unknown")) {
    blockers.push("receipt evidence contains an unsupported kind");
  }
  return [...new Set(blockers)];
}

function classifyEvidence(records: TerminalBriefApprovalReceiptEvidenceRecord[]): ReceiptClassificationCore {
  const fresh = records.filter((record) => !record.stale && !record.conflict);
  return {
    providerAccepted: fresh.some((record) => record.kind === "provider_accepted"),
    currentSessionVisible: fresh.some((record) => record.kind === "current_session_visible"),
    manualOperatorConfirmed: fresh.some((record) => record.kind === "manual_operator_confirmation"),
    approvalGrantAccepted: fresh.some((record) => record.kind === "approval_grant"),
    rejected: fresh.some((record) => record.kind === "rejected"),
    expired: records.some((record) => record.kind === "expired"),
    stale: records.some((record) => record.stale),
  };
}

function stateForClassification(
  classification: ReceiptClassificationCore,
  blockers: string[],
  records: TerminalBriefApprovalReceiptEvidenceRecord[],
): TerminalBriefApprovalReceiptIngestorState {
  if (blockers.length > 0) return "blocked";
  if (records.some((record) => record.conflict) || (hasFreshPositive(records) && classification.rejected)) return "conflicting";
  if (records.length > 0 && records.every((record) => record.stale)) return "stale";
  if (classification.rejected) return "blocked";
  if (classification.currentSessionVisible || classification.manualOperatorConfirmed || classification.approvalGrantAccepted) return "accepted";
  if (classification.providerAccepted) return "insufficient";
  return "insufficient";
}

function reasonForState(
  state: TerminalBriefApprovalReceiptIngestorState,
  classification: ReceiptClassificationCore,
  blockers: string[],
  records: TerminalBriefApprovalReceiptEvidenceRecord[],
): string {
  if (state === "blocked") {
    return blockers[0] ?? (classification.rejected ? "receipt evidence was rejected" : "receipt evidence is blocked");
  }
  if (state === "conflicting") return "receipt evidence conflicts with dispatch action/target or contains positive and rejected evidence";
  if (state === "stale") return "all receipt evidence is stale or expired";
  if (state === "accepted") {
    if (classification.currentSessionVisible || classification.manualOperatorConfirmed) {
      return "visibility/manual receipt evidence accepted as no-live evidence only";
    }
    return "approval grant evidence accepted as no-live evidence only";
  }
  if (classification.providerAccepted) return "provider accepted evidence is insufficient without visibility/manual receipt or approval grant";
  if (records.length === 0) return "no receipt evidence supplied";
  return "receipt evidence is insufficient";
}

function reasonForRecord(kind: TerminalBriefApprovalReceiptEvidenceKind, stale: boolean, conflict: boolean): string {
  if (conflict) return "evidence conflicts with selected action or target";
  if (stale) return "evidence is stale or expired";
  if (kind === "provider_accepted") return "provider accepted is not visibility proof";
  if (kind === "current_session_visible") return "current-session-visible evidence can support ACK eligibility but does not perform ACK";
  if (kind === "manual_operator_confirmation") return "manual operator confirmation can support ACK eligibility but does not perform ACK";
  if (kind === "approval_grant") return "approval grant evidence is recorded but does not grant approval in this ingestor";
  if (kind === "rejected") return "evidence rejects the approval or receipt";
  if (kind === "expired") return "evidence is expired";
  return "unsupported receipt evidence kind";
}

function nextActionsForState(state: TerminalBriefApprovalReceiptIngestorState): string[] {
  if (state === "accepted") {
    return [
      "feed accepted no-live receipt evidence into the broker finalizer approval status table",
      "request separate explicit approval before any terminal ACK, GitHub mutation, or live execution",
    ];
  }
  if (state === "insufficient") {
    return [
      "collect current-session-visible, manual operator confirmation, or explicit approval grant evidence",
      "do not treat provider accepted evidence as visibility proof",
    ];
  }
  if (state === "stale") {
    return [
      "refresh receipt evidence before broker finalizer review",
      "do not ACK terminal rows from stale evidence",
    ];
  }
  if (state === "conflicting") {
    return [
      "resolve conflicting receipt or approval evidence before finalizer review",
      "rerun the ingestor with one coherent evidence set",
    ];
  }
  return [
    "recover blocked dispatch or unsupported evidence before continuing",
    "do not use blocked receipt evidence as approval or ACK proof",
  ];
}

function buildReceiptIngestorIdempotencyKey(
  dispatch: TerminalBriefApprovalDispatchAdapterPacket,
  state: TerminalBriefApprovalReceiptIngestorState,
  records: TerminalBriefApprovalReceiptEvidenceRecord[],
  maxAgeMs: number,
): string {
  const base = JSON.stringify({
    label: "terminal-brief-approval-receipt-ingestor",
    parentRoundId: dispatch.parentRoundId ?? "unknown",
    dispatch: dispatch.idempotencyKey,
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
  return "tb-approval-receipt:" + createHash("sha256").update(base).digest("hex").slice(0, 24);
}

function hasFreshPositive(records: TerminalBriefApprovalReceiptEvidenceRecord[]): boolean {
  return records.some((record) => !record.stale && !record.conflict && isPositiveKind(record.kind));
}

function isPositiveKind(kind: TerminalBriefApprovalReceiptEvidenceKind): boolean {
  return kind === "provider_accepted"
    || kind === "current_session_visible"
    || kind === "manual_operator_confirmation"
    || kind === "approval_grant";
}

function isStrongReceiptKind(kind: TerminalBriefApprovalReceiptEvidenceKind): boolean {
  return kind === "current_session_visible"
    || kind === "manual_operator_confirmation"
    || kind === "approval_grant";
}

function isNegativeKind(kind: TerminalBriefApprovalReceiptEvidenceKind): boolean {
  return kind === "rejected" || kind === "expired";
}

function titleForState(state: TerminalBriefApprovalReceiptIngestorState): string {
  if (state === "accepted") return "Accepted: Terminal Brief approval receipt evidence";
  if (state === "insufficient") return "Insufficient: Terminal Brief approval receipt evidence";
  if (state === "stale") return "Stale: Terminal Brief approval receipt evidence";
  if (state === "conflicting") return "Conflicting: Terminal Brief approval receipt evidence";
  return "Blocked: Terminal Brief approval receipt evidence";
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

function isTerminalBriefApprovalDispatchAdapterPacket(value: unknown): value is TerminalBriefApprovalDispatchAdapterPacket {
  return isRecord(value) && value.kind === "a2a-broker.terminal-brief-approval-dispatch-adapter.packet";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
