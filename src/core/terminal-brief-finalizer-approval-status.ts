import { createHash } from "node:crypto";

import type { TerminalBriefApprovalDispatchAdapterPacket } from "./terminal-brief-approval-dispatch-adapter.js";
import type { TerminalBriefApprovalReceiptIngestorPacket } from "./terminal-brief-approval-receipt-ingestor.js";

export type TerminalBriefFinalizerApprovalStatusState =
  | "ready_for_finalizer_review"
  | "waiting_for_receipt_evidence"
  | "waiting_for_visibility_evidence"
  | "waiting_for_approval_evidence"
  | "stale"
  | "conflicting"
  | "blocked";

export type TerminalBriefFinalizerApprovalStatusRowName =
  | "dispatch"
  | "receipt"
  | "approval"
  | "execution"
  | "default_on";

export interface TerminalBriefFinalizerApprovalStatusOptions {
  now?: string;
  mode?: string;
}

export interface TerminalBriefFinalizerApprovalStatusRow {
  name: TerminalBriefFinalizerApprovalStatusRowName;
  label: string;
  state: string;
  required: boolean;
  ready: boolean;
  detail: string;
  blockers: string[];
  nextAction: string;
}

export interface TerminalBriefFinalizerApprovalStatusPacket {
  kind: "a2a-broker.terminal-brief-finalizer-approval-status.packet";
  version: 1;
  generatedAt: string;
  mode: string;
  parentRoundId?: string;
  state: TerminalBriefFinalizerApprovalStatusState;
  dryRunOnly: true;
  sourceOnlyNoLive: true;
  finalizer: TerminalBriefApprovalDispatchAdapterPacket["finalizer"];
  idempotencyKey: string;
  source: {
    dispatchState: TerminalBriefApprovalDispatchAdapterPacket["state"];
    dispatchIdempotencyKey: string;
    receiptState?: TerminalBriefApprovalReceiptIngestorPacket["state"];
    receiptIngestorIdempotencyKey?: string;
    adapterType: TerminalBriefApprovalDispatchAdapterPacket["adapter"]["type"];
    transcriptTarget?: string;
    transcriptChannel?: string;
    targetIssueUrl?: string;
    targetPrUrl?: string;
  };
  requestedAction: {
    action?: string;
    target?: string;
    requestedActions: number;
    nonRequestableActions: number;
  };
  approval: {
    receiptEvidenceAccepted: boolean;
    providerAccepted: boolean;
    currentSessionVisible: boolean;
    manualOperatorConfirmed: boolean;
    approvalGrantAccepted: boolean;
    terminalAckEligible: boolean;
    terminalAckPermitted: false;
    approvalGrantPermitted: false;
    executionPermitted: false;
  };
  table: {
    rows: TerminalBriefFinalizerApprovalStatusRow[];
    requiredRowsReady: number;
    requiredRows: number;
    readyRows: number;
    totalRows: number;
  };
  defaultOnReadiness: {
    sourceCriteriaMet: boolean;
    defaultOnPermitted: false;
    missingEvidence: string[];
    blockers: string[];
    nextAction: string;
  };
  blockers: string[];
  nextActions: string[];
  approvalSensitiveActionsExcluded: string[];
  integrationContract: {
    transport: "json";
    statusTableVersion: 1;
    harnessNeutral: true;
    openclawMessageSendRequired: false;
    hermesAdapterCompatible: true;
    gongyungAdapterCompatible: true;
    consumesDispatchAdapterPacket: true;
    consumesReceiptIngestorPacket: true;
    grantsApproval: false;
    executesAction: false;
  };
  semantics: {
    statusTableOnly: true;
    sourceOnlyNoLive: true;
    tableDoesNotMutateState: true;
    dispatchDraftIsNotSend: true;
    providerAcceptedIsVisibilityProof: false;
    terminalAckEligibleDoesNotPermitAck: true;
    approvalGrantEvidenceDoesNotGrantApproval: true;
    executionNotPermitted: true;
    defaultOnNotEnabledByThisPacket: true;
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

export function buildTerminalBriefFinalizerApprovalStatus(
  dispatch: TerminalBriefApprovalDispatchAdapterPacket,
  receipt?: TerminalBriefApprovalReceiptIngestorPacket,
  options: TerminalBriefFinalizerApprovalStatusOptions = {},
): TerminalBriefFinalizerApprovalStatusPacket {
  const generatedAt = options.now ?? new Date().toISOString();
  const facts = approvalFacts(receipt);
  const rows = buildRows(dispatch, receipt, facts);
  const blockers = buildBlockers(dispatch, receipt, facts);
  const state = stateFor(dispatch, receipt, facts, blockers);
  const defaultOnReadiness = buildDefaultOnReadiness(dispatch, receipt, facts);
  return {
    kind: "a2a-broker.terminal-brief-finalizer-approval-status.packet",
    version: 1,
    generatedAt,
    mode: options.mode ?? receipt?.mode ?? dispatch.mode,
    parentRoundId: receipt?.parentRoundId ?? dispatch.parentRoundId,
    state,
    dryRunOnly: true,
    sourceOnlyNoLive: true,
    finalizer: dispatch.finalizer,
    idempotencyKey: buildStatusIdempotencyKey(dispatch, receipt, state),
    source: {
      dispatchState: dispatch.state,
      dispatchIdempotencyKey: dispatch.idempotencyKey,
      receiptState: receipt?.state,
      receiptIngestorIdempotencyKey: receipt?.idempotencyKey,
      adapterType: dispatch.adapter.type,
      transcriptTarget: dispatch.transcript.target,
      transcriptChannel: dispatch.transcript.channel,
      targetIssueUrl: dispatch.source.targetIssueUrl,
      targetPrUrl: dispatch.source.targetPrUrl,
    },
    requestedAction: {
      action: dispatch.source.selectedAction,
      target: dispatch.source.selectedTarget,
      requestedActions: dispatch.source.requestedActions,
      nonRequestableActions: dispatch.source.nonRequestableActions,
    },
    approval: {
      ...facts,
      terminalAckPermitted: false,
      approvalGrantPermitted: false,
      executionPermitted: false,
    },
    table: {
      rows,
      requiredRowsReady: rows.filter((row) => row.required && row.ready).length,
      requiredRows: rows.filter((row) => row.required).length,
      readyRows: rows.filter((row) => row.ready).length,
      totalRows: rows.length,
    },
    defaultOnReadiness,
    blockers,
    nextActions: nextActionsFor(state),
    approvalSensitiveActionsExcluded: [
      "GitHub PR merge, issue close, or comment post",
      "live provider/Hermes/Gongyung/Telegram/OpenClaw send",
      "terminal ACK/replay or terminal receipt DB mutation",
      "TaskFlow record creation or broker DB mutation",
      "production deploy/restart, historical replay, release, publish, or secret movement",
    ],
    integrationContract: {
      transport: "json",
      statusTableVersion: 1,
      harnessNeutral: true,
      openclawMessageSendRequired: false,
      hermesAdapterCompatible: true,
      gongyungAdapterCompatible: true,
      consumesDispatchAdapterPacket: true,
      consumesReceiptIngestorPacket: true,
      grantsApproval: false,
      executesAction: false,
    },
    semantics: {
      statusTableOnly: true,
      sourceOnlyNoLive: true,
      tableDoesNotMutateState: true,
      dispatchDraftIsNotSend: true,
      providerAcceptedIsVisibilityProof: false,
      terminalAckEligibleDoesNotPermitAck: true,
      approvalGrantEvidenceDoesNotGrantApproval: true,
      executionNotPermitted: true,
      defaultOnNotEnabledByThisPacket: true,
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

export function extractTerminalBriefFinalizerApprovalStatusDispatch(
  input: unknown,
): TerminalBriefApprovalDispatchAdapterPacket {
  const envelope = isRecord(input) ? input : {};
  const candidates = [
    input,
    envelope.approvalDispatch,
    envelope.approvalDispatchPacket,
    envelope.dispatchAdapter,
    envelope.dispatchAdapterPacket,
    envelope.dispatch,
    envelope.packet,
  ];
  const packet = candidates.find(isTerminalBriefApprovalDispatchAdapterPacket);
  if (!packet) {
    throw new Error("expected a Terminal Brief approval dispatch adapter packet");
  }
  return packet;
}

export function extractTerminalBriefFinalizerApprovalReceiptStatus(
  input: unknown,
): TerminalBriefApprovalReceiptIngestorPacket | undefined {
  const envelope = isRecord(input) ? input : {};
  const candidates = [
    input,
    envelope.approvalReceipt,
    envelope.approvalReceiptPacket,
    envelope.receiptIngestor,
    envelope.receiptIngestorPacket,
    envelope.receiptPacket,
    envelope.receipt,
    envelope.packet,
  ];
  return candidates.find(isTerminalBriefApprovalReceiptIngestorPacket);
}

export function renderTerminalBriefFinalizerApprovalStatusMarkdown(
  packet: TerminalBriefFinalizerApprovalStatusPacket,
): string {
  return [
    titleForState(packet.state),
    "Mode: " + packet.mode,
    "Parent round: " + (packet.parentRoundId ?? "unknown"),
    "State: " + packet.state + " dryRunOnly=" + packet.dryRunOnly + " sourceOnlyNoLive=" + packet.sourceOnlyNoLive,
    "Idempotency: " + packet.idempotencyKey,
    "Finalizer: broker=" + packet.finalizer.brokerOfRecordId
      + " owner=" + packet.finalizer.owner
      + " singleFinalizerRequired=" + packet.finalizer.singleFinalizerRequired,
    "Requested action: " + (packet.requestedAction.action ?? "none")
      + " target=" + (packet.requestedAction.target ?? "none"),
    "",
    "| Check | State | Ready | Detail |",
    "|---|---|---:|---|",
    ...packet.table.rows.map((row) => "| " + row.label + " | " + row.state + " | " + (row.ready ? "yes" : "no") + " | " + row.detail + " |"),
    "",
    "Approval evidence: receiptEvidenceAccepted=" + packet.approval.receiptEvidenceAccepted
      + " providerAccepted=" + packet.approval.providerAccepted
      + " currentSessionVisible=" + packet.approval.currentSessionVisible
      + " manualOperatorConfirmed=" + packet.approval.manualOperatorConfirmed
      + " approvalGrantAccepted=" + packet.approval.approvalGrantAccepted
      + " terminalAckEligible=" + packet.approval.terminalAckEligible
      + " terminalAckPermitted=" + packet.approval.terminalAckPermitted
      + " approvalGrantPermitted=" + packet.approval.approvalGrantPermitted
      + " executionPermitted=" + packet.approval.executionPermitted,
    "Default-on readiness: sourceCriteriaMet=" + packet.defaultOnReadiness.sourceCriteriaMet
      + " defaultOnPermitted=" + packet.defaultOnReadiness.defaultOnPermitted
      + " missingEvidence=" + list(packet.defaultOnReadiness.missingEvidence),
    ...(packet.blockers.length ? ["", "Blockers:", ...packet.blockers.map((blocker) => "- " + blocker)] : []),
    "",
    "Next actions:",
    ...packet.nextActions.map((action) => "- " + action),
    "",
    "Safety: status table only; no provider send, terminal ACK/replay, approval grant, GitHub mutation, TaskFlow record creation, restart/deploy, DB mutation, historical replay, release, publish, or secret movement.",
  ].join("\n");
}

function approvalFacts(receipt?: TerminalBriefApprovalReceiptIngestorPacket) {
  const classification = receipt?.classification;
  return {
    receiptEvidenceAccepted: receipt?.receiptEvidenceAccepted === true,
    providerAccepted: classification?.providerAccepted === true,
    currentSessionVisible: classification?.currentSessionVisible === true,
    manualOperatorConfirmed: classification?.manualOperatorConfirmed === true,
    approvalGrantAccepted: classification?.approvalGrantAccepted === true,
    terminalAckEligible: classification?.terminalAckEligible === true,
  };
}

function buildRows(
  dispatch: TerminalBriefApprovalDispatchAdapterPacket,
  receipt: TerminalBriefApprovalReceiptIngestorPacket | undefined,
  facts: ReturnType<typeof approvalFacts>,
): TerminalBriefFinalizerApprovalStatusRow[] {
  const dispatchReady = dispatch.state !== "dispatch_blocked" && dispatch.blockers.length === 0;
  const receiptReady = receipt?.state === "accepted" && facts.receiptEvidenceAccepted;
  const visibilityReady = facts.currentSessionVisible || facts.manualOperatorConfirmed;
  const approvalReady = facts.approvalGrantAccepted;
  const defaultOn = buildDefaultOnReadiness(dispatch, receipt, facts);
  return [
    {
      name: "dispatch",
      label: "Dispatch adapter",
      state: dispatch.state,
      required: true,
      ready: dispatchReady,
      detail: dispatchReady ? "dispatch adapter packet is available as no-live evidence" : "dispatch adapter is blocked",
      blockers: dispatchReady ? [] : ["dispatch adapter must be unblocked before finalizer review"],
      nextAction: dispatchReady ? "consume receipt ingestor packet" : "resolve dispatch adapter blockers",
    },
    {
      name: "receipt",
      label: "Receipt evidence",
      state: receipt?.state ?? "missing",
      required: true,
      ready: receiptReady && visibilityReady,
      detail: receiptReady
        ? "receipt ingestor accepted evidence; visibility proof=" + visibilityReady
        : "receipt ingestor packet is missing, insufficient, stale, conflicting, or blocked",
      blockers: receiptBlockers(receipt, visibilityReady),
      nextAction: receiptReady && visibilityReady
        ? "verify approval grant evidence"
        : "collect current-session-visible or manual operator confirmation evidence",
    },
    {
      name: "approval",
      label: "Approval grant evidence",
      state: approvalReady ? "approval_grant_evidence_present" : "approval_grant_evidence_missing",
      required: true,
      ready: approvalReady,
      detail: approvalReady
        ? "approval grant is recorded as evidence only; it does not grant approval here"
        : "no approval grant evidence for the requested action/target",
      blockers: approvalReady ? [] : ["matching approval_grant evidence is missing"],
      nextAction: approvalReady ? "broker finalizer may review the source-only table" : "collect explicit approval_grant evidence",
    },
    {
      name: "execution",
      label: "Execution permission",
      state: "not_permitted_source_only",
      required: false,
      ready: false,
      detail: "execution, GitHub mutation, provider send, and terminal ACK remain disabled",
      blockers: ["source-only/no-live status table never executes closeout actions"],
      nextAction: "request separate approval before any live execution path",
    },
    {
      name: "default_on",
      label: "Default-on readiness",
      state: defaultOn.sourceCriteriaMet ? "source_criteria_met_approval_gated" : "blocked_by_missing_evidence",
      required: false,
      ready: defaultOn.sourceCriteriaMet,
      detail: defaultOn.sourceCriteriaMet
        ? "source criteria are met, but default-on is not enabled by this packet"
        : "missing evidence blocks default-on readiness",
      blockers: defaultOn.blockers,
      nextAction: defaultOn.nextAction,
    },
  ];
}

function receiptBlockers(receipt: TerminalBriefApprovalReceiptIngestorPacket | undefined, visibilityReady: boolean): string[] {
  if (!receipt) return ["receipt ingestor packet is missing"];
  if (receipt.state === "stale") return ["receipt evidence is stale or expired"];
  if (receipt.state === "conflicting") return ["receipt evidence is conflicting"];
  if (receipt.state === "blocked") return receipt.blockers.length ? receipt.blockers : ["receipt evidence is blocked"];
  if (receipt.state === "insufficient") return ["receipt evidence is insufficient"];
  if (!visibilityReady) return ["current-session-visible or manual operator confirmation evidence is missing"];
  return [];
}

function buildBlockers(
  dispatch: TerminalBriefApprovalDispatchAdapterPacket,
  receipt: TerminalBriefApprovalReceiptIngestorPacket | undefined,
  facts: ReturnType<typeof approvalFacts>,
): string[] {
  const blockers = [...dispatch.blockers];
  if (dispatch.state === "dispatch_blocked") blockers.push("approval dispatch adapter is blocked");
  if (!dispatch.finalizer.singleFinalizerRequired) blockers.push("single broker finalizer is not required by the dispatch packet");
  if (!receipt) blockers.push("receipt ingestor packet is missing");
  if (receipt?.state === "stale") blockers.push("receipt evidence is stale or expired");
  if (receipt?.state === "conflicting") blockers.push("receipt evidence is conflicting");
  if (receipt?.state === "blocked") blockers.push(...receipt.blockers, "receipt evidence is blocked");
  if (receipt?.state === "insufficient") blockers.push("receipt evidence is insufficient");
  if (receipt?.state === "accepted" && !(facts.currentSessionVisible || facts.manualOperatorConfirmed)) {
    blockers.push("current-session-visible or manual operator confirmation evidence is missing");
  }
  if (receipt?.state === "accepted" && !facts.approvalGrantAccepted) {
    blockers.push("matching approval_grant evidence is missing");
  }
  return unique(blockers.filter(Boolean));
}

function stateFor(
  dispatch: TerminalBriefApprovalDispatchAdapterPacket,
  receipt: TerminalBriefApprovalReceiptIngestorPacket | undefined,
  facts: ReturnType<typeof approvalFacts>,
  blockers: string[],
): TerminalBriefFinalizerApprovalStatusState {
  if (dispatch.state === "dispatch_blocked" || receipt?.state === "blocked") return "blocked";
  if (receipt?.state === "conflicting") return "conflicting";
  if (receipt?.state === "stale") return "stale";
  if (!receipt || receipt.state === "insufficient") return "waiting_for_receipt_evidence";
  if (!(facts.currentSessionVisible || facts.manualOperatorConfirmed)) return "waiting_for_visibility_evidence";
  if (!facts.approvalGrantAccepted) return "waiting_for_approval_evidence";
  if (blockers.length > 0) return "blocked";
  return "ready_for_finalizer_review";
}

function buildDefaultOnReadiness(
  dispatch: TerminalBriefApprovalDispatchAdapterPacket,
  receipt: TerminalBriefApprovalReceiptIngestorPacket | undefined,
  facts: ReturnType<typeof approvalFacts>,
): TerminalBriefFinalizerApprovalStatusPacket["defaultOnReadiness"] {
  const missingEvidence: string[] = [];
  if (dispatch.state === "dispatch_blocked") missingEvidence.push("unblocked_dispatch_adapter_packet");
  if (!receipt || receipt.state !== "accepted") missingEvidence.push("accepted_receipt_ingestor_packet");
  if (!(facts.currentSessionVisible || facts.manualOperatorConfirmed)) {
    missingEvidence.push("current_session_visible_or_manual_operator_confirmation");
  }
  if (!facts.approvalGrantAccepted) missingEvidence.push("matching_approval_grant");
  const sourceCriteriaMet = missingEvidence.length === 0;
  return {
    sourceCriteriaMet,
    defaultOnPermitted: false,
    missingEvidence,
    blockers: [
      ...missingEvidence.map((item) => "missing " + item),
      "default-on enablement still requires separate live deployment/canary approval",
      "terminal ACK/replay and closeout execution remain disabled in this source-only packet",
    ],
    nextAction: sourceCriteriaMet
      ? "request explicit operator approval for any default-on/live canary step"
      : "fill the missing evidence before default-on readiness review",
  };
}

function nextActionsFor(state: TerminalBriefFinalizerApprovalStatusState): string[] {
  if (state === "ready_for_finalizer_review") {
    return [
      "broker finalizer can review the source-only approval status table",
      "request separate explicit approval before any live closeout execution, terminal ACK, provider send, deploy, or DB mutation",
    ];
  }
  if (state === "waiting_for_receipt_evidence") {
    return [
      "run the approval receipt ingestor with fresh current-session-visible/manual receipt evidence",
      "do not use provider accepted evidence as visibility proof",
    ];
  }
  if (state === "waiting_for_visibility_evidence") {
    return [
      "collect current-session-visible or manual operator confirmation evidence",
      "do not ACK terminal rows from approval grant evidence alone",
    ];
  }
  if (state === "waiting_for_approval_evidence") {
    return [
      "collect matching approval_grant evidence for the selected action and target",
      "keep dispatch, approval grant, and execution separated until a live executor is approved",
    ];
  }
  if (state === "stale") {
    return [
      "refresh receipt evidence before broker finalizer review",
      "do not use stale evidence for default-on readiness",
    ];
  }
  if (state === "conflicting") {
    return [
      "resolve conflicting receipt or approval evidence",
      "rerun receipt ingestion with one coherent evidence set",
    ];
  }
  return [
    "recover blocked dispatch or receipt evidence before finalizer review",
    "do not execute closeout actions from a blocked status table",
  ];
}

function buildStatusIdempotencyKey(
  dispatch: TerminalBriefApprovalDispatchAdapterPacket,
  receipt: TerminalBriefApprovalReceiptIngestorPacket | undefined,
  state: TerminalBriefFinalizerApprovalStatusState,
): string {
  const base = JSON.stringify({
    label: "terminal-brief-finalizer-approval-status",
    parentRoundId: receipt?.parentRoundId ?? dispatch.parentRoundId ?? "unknown",
    dispatch: dispatch.idempotencyKey,
    receipt: receipt?.idempotencyKey ?? "missing",
    state,
    selectedAction: dispatch.source.selectedAction,
    selectedTarget: dispatch.source.selectedTarget,
  });
  return "tb-finalizer-approval-status:" + createHash("sha256").update(base).digest("hex").slice(0, 24);
}

function titleForState(state: TerminalBriefFinalizerApprovalStatusState): string {
  if (state === "ready_for_finalizer_review") return "Ready: Terminal Brief broker finalizer approval status";
  if (state === "waiting_for_receipt_evidence") return "Waiting: Terminal Brief receipt evidence";
  if (state === "waiting_for_visibility_evidence") return "Waiting: Terminal Brief visibility evidence";
  if (state === "waiting_for_approval_evidence") return "Waiting: Terminal Brief approval evidence";
  if (state === "stale") return "Stale: Terminal Brief approval status";
  if (state === "conflicting") return "Conflicting: Terminal Brief approval status";
  return "Blocked: Terminal Brief approval status";
}

function list(items: unknown[]): string {
  return items.length ? items.join(",") : "none";
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function isTerminalBriefApprovalDispatchAdapterPacket(value: unknown): value is TerminalBriefApprovalDispatchAdapterPacket {
  return isRecord(value) && value.kind === "a2a-broker.terminal-brief-approval-dispatch-adapter.packet";
}

function isTerminalBriefApprovalReceiptIngestorPacket(value: unknown): value is TerminalBriefApprovalReceiptIngestorPacket {
  return isRecord(value) && value.kind === "a2a-broker.terminal-brief-approval-receipt-ingestor.packet";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
