import { createHash } from "node:crypto";

import type { TerminalBriefSidecarAdapterHandoffApprovalPacket } from "./terminal-brief-sidecar-adapter-handoff-approval.js";

export type TerminalBriefSidecarOperatorReviewTableState =
  | "review_table_ready"
  | "waiting_for_adapter_handoff"
  | "stale"
  | "conflicting"
  | "rejected"
  | "blocked";

export interface TerminalBriefSidecarOperatorReviewTableOptions {
  now?: string;
  mode?: string;
  reviewOwner?: string;
  review_owner?: string;
  reviewReference?: string;
  review_reference?: string;
  requiredDecision?: string;
  required_decision?: string;
  reviewRows?: string[];
  review_rows?: string[];
}

export interface TerminalBriefSidecarOperatorReviewRow {
  id: string;
  label: string;
  status: "ready" | "waiting" | "blocked";
  evidence: string[];
  decisionRequired: boolean;
  permitted: false;
  notes: string[];
}

export interface TerminalBriefSidecarOperatorReviewTablePacket {
  kind: "a2a-broker.terminal-brief-sidecar-operator-review-table.packet";
  version: 1;
  generatedAt: string;
  mode: string;
  parentRoundId?: string;
  state: TerminalBriefSidecarOperatorReviewTableState;
  dryRunOnly: true;
  sourceOnlyNoLive: true;
  idempotencyKey: string;
  source: {
    adapterHandoffState: TerminalBriefSidecarAdapterHandoffApprovalPacket["state"];
    adapterHandoffIdempotencyKey: string;
    adapterHandoffReady: boolean;
    adapterId: string;
    deliveryTargetClass: string;
    operatorTarget: string;
    evidenceBundleReferences: string[];
    operatorDecisionFields: string[];
  };
  operatorReview: {
    tableOnly: true;
    reviewOwner: string;
    reviewReference?: string;
    requiredDecision: string;
    rows: TerminalBriefSidecarOperatorReviewRow[];
    readyRowCount: number;
    blockedRowCount: number;
    waitingRowCount: number;
    dispatchPermitted: false;
    providerSendPermitted: false;
    approvalGrantPermitted: false;
    terminalAckPermitted: false;
    executionPermitted: false;
  };
  readiness: {
    sourceCriteriaMet: boolean;
    reviewTableReady: boolean;
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
    operatorReviewTableVersion: 1;
    harnessNeutral: true;
    openclawMessageSendRequired: false;
    hermesAdapterCompatible: true;
    gongyungAdapterCompatible: true;
    externalHarnessCompatible: true;
    consumesAdapterHandoffApprovalPacket: true;
    rendersOperatorReviewTable: true;
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
    operatorReviewTableOnly: true;
    sourceOnlyNoLive: true;
    reviewDoesNotMutateState: true;
    reviewDoesNotSendApprovalRequest: true;
    reviewDoesNotGrantApproval: true;
    messageBodyIsDraftOnly: true;
    evidenceBundleReferencesOnly: true;
    adapterOutputDoesNotImplyReceiptProof: true;
    providerAcceptedIsVisibilityProof: false;
    terminalAckEligibleDoesNotPermitAck: true;
    approvalGrantEvidenceDoesNotGrantApproval: true;
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

export function buildTerminalBriefSidecarOperatorReviewTable(
  handoff: TerminalBriefSidecarAdapterHandoffApprovalPacket,
  options: TerminalBriefSidecarOperatorReviewTableOptions = {},
): TerminalBriefSidecarOperatorReviewTablePacket {
  const generatedAt = options.now ?? new Date().toISOString();
  const blockers = buildBlockers(handoff);
  const state = stateFor(handoff, blockers);
  const sourceCriteriaMet = state === "review_table_ready";
  const rows = buildReviewRows(handoff, state, options);
  return {
    kind: "a2a-broker.terminal-brief-sidecar-operator-review-table.packet",
    version: 1,
    generatedAt,
    mode: options.mode ?? handoff.mode,
    parentRoundId: handoff.parentRoundId,
    state,
    dryRunOnly: true,
    sourceOnlyNoLive: true,
    idempotencyKey: buildOperatorReviewTableIdempotencyKey(handoff, generatedAt, state, options),
    source: {
      adapterHandoffState: handoff.state,
      adapterHandoffIdempotencyKey: handoff.idempotencyKey,
      adapterHandoffReady: handoff.readiness.handoffPacketReady,
      adapterId: handoff.adapterHandoff.adapterId,
      deliveryTargetClass: handoff.adapterHandoff.deliveryTargetClass,
      operatorTarget: handoff.adapterHandoff.operatorTarget,
      evidenceBundleReferences: handoff.adapterHandoff.evidenceBundleReferences,
      operatorDecisionFields: handoff.adapterHandoff.operatorDecisionFields,
    },
    operatorReview: {
      tableOnly: true,
      reviewOwner: optionalString(options.reviewOwner ?? options.review_owner) ?? "broker-finalizer",
      reviewReference: optionalString(options.reviewReference ?? options.review_reference),
      requiredDecision: optionalString(options.requiredDecision ?? options.required_decision)
        ?? "explicit operator approval before any dispatch",
      rows,
      readyRowCount: rows.filter((row) => row.status === "ready").length,
      blockedRowCount: rows.filter((row) => row.status === "blocked").length,
      waitingRowCount: rows.filter((row) => row.status === "waiting").length,
      dispatchPermitted: false,
      providerSendPermitted: false,
      approvalGrantPermitted: false,
      terminalAckPermitted: false,
      executionPermitted: false,
    },
    readiness: {
      sourceCriteriaMet,
      reviewTableReady: sourceCriteriaMet,
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
      missingEvidence: missingEvidenceFor(handoff),
      blockers: [
        ...blockers,
        "operator review table is not an approval request dispatch",
        "operator review table does not grant approval or prove visibility",
        "runtime execution requires later separate approved paths",
      ],
      nextAction: sourceCriteriaMet
        ? "operator reviews the table and explicitly approves or rejects in a separate action"
        : "resolve adapter handoff readiness before operator review",
    },
    blockers,
    nextActions: nextActionsFor(state),
    approvalSensitiveActionsExcluded: approvalSensitiveActionsExcluded(),
    integrationContract: {
      transport: "json",
      operatorReviewTableVersion: 1,
      harnessNeutral: true,
      openclawMessageSendRequired: false,
      hermesAdapterCompatible: true,
      gongyungAdapterCompatible: true,
      externalHarnessCompatible: true,
      consumesAdapterHandoffApprovalPacket: true,
      rendersOperatorReviewTable: true,
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
      operatorReviewTableOnly: true,
      sourceOnlyNoLive: true,
      reviewDoesNotMutateState: true,
      reviewDoesNotSendApprovalRequest: true,
      reviewDoesNotGrantApproval: true,
      messageBodyIsDraftOnly: true,
      evidenceBundleReferencesOnly: true,
      adapterOutputDoesNotImplyReceiptProof: true,
      providerAcceptedIsVisibilityProof: false,
      terminalAckEligibleDoesNotPermitAck: true,
      approvalGrantEvidenceDoesNotGrantApproval: true,
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

export function extractTerminalBriefSidecarOperatorReviewTableHandoff(
  input: unknown,
): TerminalBriefSidecarAdapterHandoffApprovalPacket {
  const envelope = isRecord(input) ? input : {};
  const candidates = [
    input,
    envelope.adapterHandoffApprovalPacket,
    envelope.adapterHandoffApproval,
    envelope.sidecarAdapterHandoffApprovalPacket,
    envelope.sidecarAdapterHandoffApproval,
    envelope.handoffPacket,
    envelope.packet,
  ];
  const packet = candidates.find(isTerminalBriefSidecarAdapterHandoffApprovalPacket);
  if (!packet) {
    throw new Error("expected a Terminal Brief sidecar adapter handoff approval packet");
  }
  return packet;
}

export function extractTerminalBriefSidecarOperatorReviewTableOptions(
  input: unknown,
): TerminalBriefSidecarOperatorReviewTableOptions {
  const envelope = isRecord(input) ? input : {};
  const candidate = envelope.operatorReviewTable
    ?? envelope.operatorReviewTableOptions
    ?? envelope.operatorReview
    ?? envelope.options;
  return isRecord(candidate) ? candidate as TerminalBriefSidecarOperatorReviewTableOptions : {};
}

export function renderTerminalBriefSidecarOperatorReviewTableMarkdown(
  packet: TerminalBriefSidecarOperatorReviewTablePacket,
): string {
  return [
    titleForState(packet.state),
    "Mode: " + packet.mode,
    "Parent round: " + (packet.parentRoundId ?? "unknown"),
    "State: " + packet.state + " dryRunOnly=" + packet.dryRunOnly + " sourceOnlyNoLive=" + packet.sourceOnlyNoLive,
    "Idempotency: " + packet.idempotencyKey,
    "Source handoff: state=" + packet.source.adapterHandoffState
      + " ready=" + packet.source.adapterHandoffReady
      + " adapter=" + packet.source.adapterId
      + " targetClass=" + packet.source.deliveryTargetClass,
    "Review table: readyRows=" + packet.operatorReview.readyRowCount
      + " waitingRows=" + packet.operatorReview.waitingRowCount
      + " blockedRows=" + packet.operatorReview.blockedRowCount
      + " dispatchPermitted=" + packet.operatorReview.dispatchPermitted,
    "",
    "Rows:",
    ...packet.operatorReview.rows.map((row) => "- " + row.id + " [" + row.status + "] " + row.label),
    "",
    "Readiness: sourceCriteriaMet=" + packet.readiness.sourceCriteriaMet
      + " reviewTableReady=" + packet.readiness.reviewTableReady
      + " approvalRequestDispatchPermitted=" + packet.readiness.approvalRequestDispatchPermitted
      + " providerSendPermitted=" + packet.readiness.providerSendPermitted
      + " terminalAckPermitted=" + packet.readiness.terminalAckPermitted
      + " executionPermitted=" + packet.readiness.executionPermitted,
    ...(packet.blockers.length ? ["", "Blockers:", ...packet.blockers.map((blocker) => "- " + blocker)] : []),
    "",
    "Next actions:",
    ...packet.nextActions.map((action) => "- " + action),
    "",
    "Safety: operator review table only; does not send approval, grant approval, dispatch/invoke executor, spawn a process, start sidecar, enable default-on, send providers, ACK/replay terminal rows, mutate GitHub/DB/TaskFlow state, restart/deploy, replay history, release, publish, or move secrets.",
  ].join("\n");
}

function buildBlockers(handoff: TerminalBriefSidecarAdapterHandoffApprovalPacket): string[] {
  return unique([
    ...handoff.blockers,
    ...(handoff.state !== "handoff_packet_ready" ? ["adapter handoff approval is " + handoff.state] : []),
    ...(!handoff.readiness.sourceCriteriaMet ? ["adapter handoff source criteria are not met"] : []),
    ...(!handoff.readiness.handoffPacketReady ? ["adapter handoff packet is not ready"] : []),
    ...(handoff.adapterHandoff.draftOnly !== true ? ["adapter handoff message is not draft-only"] : []),
    ...(handoff.adapterHandoff.secretsIncluded !== false ? ["adapter handoff unexpectedly includes secrets"] : []),
    ...(handoff.readiness.approvalRequestDispatchPermitted !== false ? ["adapter handoff unexpectedly permits approval dispatch"] : []),
    ...(handoff.readiness.approvalGrantPermitted !== false ? ["adapter handoff unexpectedly permits approval grant"] : []),
    ...(handoff.readiness.startExecutorDispatchPermitted !== false ? ["adapter handoff unexpectedly permits start executor dispatch"] : []),
    ...(handoff.readiness.executorInvocationPermitted !== false ? ["adapter handoff unexpectedly permits executor invocation"] : []),
    ...(handoff.readiness.processSpawnPermitted !== false ? ["adapter handoff unexpectedly permits process spawn"] : []),
    ...(handoff.readiness.sidecarStartPermitted !== false ? ["adapter handoff unexpectedly permits sidecar start"] : []),
    ...(handoff.readiness.providerSendPermitted !== false ? ["adapter handoff unexpectedly permits provider send"] : []),
    ...(handoff.readiness.terminalAckPermitted !== false ? ["adapter handoff unexpectedly permits terminal ACK"] : []),
    ...(handoff.readiness.executionPermitted !== false ? ["adapter handoff unexpectedly permits execution"] : []),
    ...(handoff.readiness.dbMutationPermitted !== false ? ["adapter handoff unexpectedly permits DB mutation"] : []),
    ...(handoff.integrationContract.sendsApprovalRequest ? ["adapter handoff unexpectedly sends approval request"] : []),
    ...(handoff.integrationContract.grantsApproval ? ["adapter handoff unexpectedly grants approval"] : []),
    ...(handoff.integrationContract.invokesExecutor ? ["adapter handoff unexpectedly invokes executor"] : []),
    ...(handoff.integrationContract.spawnsProcess ? ["adapter handoff unexpectedly spawns process"] : []),
    ...(handoff.integrationContract.startsSidecar ? ["adapter handoff unexpectedly starts sidecar"] : []),
    ...(handoff.integrationContract.executesAction ? ["adapter handoff unexpectedly executes action"] : []),
    ...(handoff.semantics.performsProviderSend ? ["adapter handoff unexpectedly performs provider send"] : []),
    ...(handoff.semantics.performsTerminalAck ? ["adapter handoff unexpectedly performs terminal ACK"] : []),
    ...(handoff.semantics.performsRuntimeRestartOrDeploy ? ["adapter handoff unexpectedly performs restart/deploy"] : []),
    ...(handoff.semantics.performsDbMutation ? ["adapter handoff unexpectedly performs DB mutation"] : []),
    ...(handoff.semantics.performsHistoricalReplay ? ["adapter handoff unexpectedly performs historical replay"] : []),
    ...(handoff.semantics.performsReleaseOrPublish ? ["adapter handoff unexpectedly performs release/publish"] : []),
    ...(handoff.semantics.movesSecretsOrCredentials ? ["adapter handoff unexpectedly moves secrets/credentials"] : []),
  ].filter(Boolean));
}

function stateFor(
  handoff: TerminalBriefSidecarAdapterHandoffApprovalPacket,
  blockers: string[],
): TerminalBriefSidecarOperatorReviewTableState {
  if (handoff.state === "stale") return "stale";
  if (handoff.state === "conflicting") return "conflicting";
  if (handoff.state === "rejected") return "rejected";
  if (handoff.state === "blocked" || hasUnsafeNoLiveViolation(handoff)) return "blocked";
  if (handoff.state !== "handoff_packet_ready") return "waiting_for_adapter_handoff";
  return blockers.length ? "blocked" : "review_table_ready";
}

function hasUnsafeNoLiveViolation(handoff: TerminalBriefSidecarAdapterHandoffApprovalPacket): boolean {
  return handoff.readiness.approvalRequestDispatchPermitted !== false
    || handoff.readiness.approvalGrantPermitted !== false
    || handoff.readiness.startExecutorDispatchPermitted !== false
    || handoff.readiness.executorInvocationPermitted !== false
    || handoff.readiness.processSpawnPermitted !== false
    || handoff.readiness.sidecarStartPermitted !== false
    || handoff.readiness.providerSendPermitted !== false
    || handoff.readiness.terminalAckPermitted !== false
    || handoff.readiness.executionPermitted !== false
    || handoff.readiness.dbMutationPermitted !== false
    || handoff.integrationContract.sendsApprovalRequest
    || handoff.integrationContract.grantsApproval
    || handoff.integrationContract.invokesExecutor
    || handoff.integrationContract.spawnsProcess
    || handoff.integrationContract.startsSidecar
    || handoff.integrationContract.executesAction
    || handoff.semantics.performsProviderSend
    || handoff.semantics.performsTerminalAck
    || handoff.semantics.performsRuntimeRestartOrDeploy
    || handoff.semantics.performsDbMutation
    || handoff.semantics.performsHistoricalReplay
    || handoff.semantics.performsReleaseOrPublish
    || handoff.semantics.movesSecretsOrCredentials;
}

function buildReviewRows(
  handoff: TerminalBriefSidecarAdapterHandoffApprovalPacket,
  state: TerminalBriefSidecarOperatorReviewTableState,
  options: TerminalBriefSidecarOperatorReviewTableOptions,
): TerminalBriefSidecarOperatorReviewRow[] {
  const rowFilter = stringArray(options.reviewRows ?? options.review_rows);
  const sourceReady = state === "review_table_ready";
  const rows: TerminalBriefSidecarOperatorReviewRow[] = [
    row("source_handoff", "Source adapter handoff packet", sourceReady, [handoff.idempotencyKey], false, [
      "handoff packet must be handoff_packet_ready",
    ]),
    row("adapter", "Adapter and delivery target", sourceReady, [
      handoff.adapterHandoff.adapterId,
      handoff.adapterHandoff.deliveryTargetClass,
      handoff.adapterHandoff.operatorTarget,
    ], true, [
      "operator must choose a separate approved sender before dispatch",
    ]),
    row("message_draft", "Approval request message draft", sourceReady, [handoff.adapterHandoff.messageTemplate], true, [
      "message body is draft-only and must not be treated as sent",
    ]),
    row("evidence_bundle", "Evidence bundle references", sourceReady, handoff.adapterHandoff.evidenceBundleReferences, true, [
      "references only; raw secrets and private logs are not included",
    ]),
    row("operator_decision", "Operator decision fields", sourceReady, handoff.adapterHandoff.operatorDecisionFields, true, [
      "approval, rejection, or more-evidence request must happen outside this packet",
    ]),
    row("approval_boundary", "Approval dispatch and grant boundary", sourceReady, [
      "approvalRequestDispatchPermitted=false",
      "approvalGrantPermitted=false",
      "providerSendPermitted=false",
    ], true, [
      "provider accepted/send status is not visibility proof",
    ]),
    row("runtime_boundary", "Runtime and terminal boundary", sourceReady, [
      "executorInvocationPermitted=false",
      "processSpawnPermitted=false",
      "sidecarStartPermitted=false",
      "terminalAckPermitted=false",
      "executionPermitted=false",
    ], true, [
      "terminal ACK/replay and runtime execution require later separate approval",
    ]),
    row("rollback", "Rollback and abort evidence", sourceReady, handoff.approvalSensitiveActionsExcluded, true, [
      "rollback remains procedural only; no state mutation is performed",
    ]),
  ];
  return rowFilter.length ? rows.filter((item) => rowFilter.includes(item.id)) : rows;
}

function row(
  id: string,
  label: string,
  ready: boolean,
  evidence: string[],
  decisionRequired: boolean,
  notes: string[],
): TerminalBriefSidecarOperatorReviewRow {
  return {
    id,
    label,
    status: ready ? "ready" : "waiting",
    evidence,
    decisionRequired,
    permitted: false,
    notes,
  };
}

function missingEvidenceFor(handoff: TerminalBriefSidecarAdapterHandoffApprovalPacket): string[] {
  const missing: string[] = [];
  if (handoff.state !== "handoff_packet_ready") missing.push("ready_adapter_handoff");
  if (!handoff.readiness.sourceCriteriaMet) missing.push("source_criteria");
  if (!handoff.readiness.handoffPacketReady) missing.push("adapter_handoff_packet");
  if (!handoff.adapterHandoff.evidenceBundleReferences.length) missing.push("evidence_bundle_references");
  if (!handoff.adapterHandoff.operatorDecisionFields.length) missing.push("operator_decision_fields");
  return missing;
}

function nextActionsFor(state: TerminalBriefSidecarOperatorReviewTableState): string[] {
  if (state === "review_table_ready") {
    return [
      "operator reviews table rows and explicitly approves, rejects, or requests more evidence in a separate action",
      "do not dispatch approval request until a separate sender path is approved",
    ];
  }
  if (state === "waiting_for_adapter_handoff") {
    return ["resolve adapter handoff packet first", "do not present review table as dispatch-ready"];
  }
  if (state === "stale") return ["refresh adapter handoff evidence before operator review"];
  if (state === "conflicting") return ["resolve conflicting adapter handoff evidence before operator review"];
  if (state === "rejected") return ["do not continue operator review unless the operator changes the decision"];
  return [
    "resolve blocked/unsafe adapter handoff evidence before operator review",
    "do not send approval, dispatch executor, spawn a process, start sidecar, send providers, ACK terminal rows, or mutate state from a blocked table",
  ];
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

function buildOperatorReviewTableIdempotencyKey(
  handoff: TerminalBriefSidecarAdapterHandoffApprovalPacket,
  generatedAt: string,
  state: TerminalBriefSidecarOperatorReviewTableState,
  options: TerminalBriefSidecarOperatorReviewTableOptions,
): string {
  const base = JSON.stringify({
    label: "terminal-brief-sidecar-operator-review-table",
    parentRoundId: handoff.parentRoundId ?? "unknown",
    handoff: handoff.idempotencyKey,
    generatedAt,
    state,
    reviewOwner: options.reviewOwner ?? options.review_owner,
    reviewReference: options.reviewReference ?? options.review_reference,
  });
  return "tb-sidecar-operator-review-table:" + createHash("sha256").update(base).digest("hex").slice(0, 24);
}

function titleForState(state: TerminalBriefSidecarOperatorReviewTableState): string {
  if (state === "review_table_ready") return "Ready: Terminal Brief sidecar operator review table";
  if (state === "waiting_for_adapter_handoff") return "Waiting: Terminal Brief sidecar adapter handoff";
  if (state === "stale") return "Stale: Terminal Brief sidecar operator review source";
  if (state === "conflicting") return "Conflicting: Terminal Brief sidecar operator review source";
  if (state === "rejected") return "Rejected: Terminal Brief sidecar operator review source";
  return "Blocked: Terminal Brief sidecar operator review table";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function isTerminalBriefSidecarAdapterHandoffApprovalPacket(
  value: unknown,
): value is TerminalBriefSidecarAdapterHandoffApprovalPacket {
  return isRecord(value) && value.kind === "a2a-broker.terminal-brief-sidecar-adapter-handoff-approval.packet";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
