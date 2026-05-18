import { createHash } from "node:crypto";

import type { TerminalBriefSidecarActivationApprovalPacket } from "./terminal-brief-sidecar-activation-approval.js";
import {
  buildTerminalBriefSidecarActivationReceiptIngestor,
  extractTerminalBriefSidecarActivationReceiptEvidence,
  type TerminalBriefSidecarActivationReceiptEvidenceInput,
  type TerminalBriefSidecarActivationReceiptEvidenceKind,
  type TerminalBriefSidecarActivationReceiptEvidenceRecord,
  type TerminalBriefSidecarActivationReceiptIngestorState,
} from "./terminal-brief-sidecar-activation-receipt-ingestor.js";
import type { TerminalBriefSidecarDryRunStartApprovalRequestPacket } from "./terminal-brief-sidecar-dry-run-start-approval-request.js";

export type TerminalBriefSidecarDryRunStartApprovalReceiptIngestorState =
  TerminalBriefSidecarActivationReceiptIngestorState;

export type TerminalBriefSidecarDryRunStartApprovalReceiptEvidenceKind =
  TerminalBriefSidecarActivationReceiptEvidenceKind;

export type TerminalBriefSidecarDryRunStartApprovalReceiptEvidenceInput =
  TerminalBriefSidecarActivationReceiptEvidenceInput;

export type TerminalBriefSidecarDryRunStartApprovalReceiptEvidenceRecord =
  TerminalBriefSidecarActivationReceiptEvidenceRecord;

export interface TerminalBriefSidecarDryRunStartApprovalReceiptIngestorOptions {
  now?: string;
  mode?: string;
  maxAgeMs?: number;
}

export interface TerminalBriefSidecarDryRunStartApprovalReceiptIngestorPacket {
  kind: "a2a-broker.terminal-brief-sidecar-dry-run-start-approval-receipt-ingestor.packet";
  version: 1;
  generatedAt: string;
  mode: string;
  parentRoundId?: string;
  state: TerminalBriefSidecarDryRunStartApprovalReceiptIngestorState;
  dryRunOnly: true;
  sourceOnlyNoLive: true;
  receiptEvidenceAccepted: boolean;
  approvalEvidenceAccepted: boolean;
  idempotencyKey: string;
  source: {
    dryRunStartApprovalRequestState: TerminalBriefSidecarDryRunStartApprovalRequestPacket["state"];
    dryRunStartApprovalRequestIdempotencyKey: string;
    requestedAction: string;
    requestedBy: string;
    operatorTarget: string;
    operatorChannel?: string;
    dispatchRequired: boolean;
    dispatchPermitted: false;
  };
  evidence: {
    received: number;
    acceptedKinds: TerminalBriefSidecarDryRunStartApprovalReceiptEvidenceKind[];
    staleKinds: TerminalBriefSidecarDryRunStartApprovalReceiptEvidenceKind[];
    conflictingKinds: TerminalBriefSidecarDryRunStartApprovalReceiptEvidenceKind[];
    rejectedKinds: TerminalBriefSidecarDryRunStartApprovalReceiptEvidenceKind[];
    records: TerminalBriefSidecarDryRunStartApprovalReceiptEvidenceRecord[];
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
    receiptEvidenceAccepted: boolean;
    approvalEvidenceAccepted: boolean;
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
    consumesDryRunStartApprovalRequestPacket: true;
    providerAcceptedIsVisibilityProof: false;
    terminalAckRequiresVisibilityProof: true;
    grantsApproval: false;
    dispatchesStartExecutor: false;
    invokesExecutor: false;
    spawnsProcess: false;
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
    dryRunStartRequiresSeparateApprovedExecutor: true;
    defaultOnNotEnabledByThisPacket: true;
    executionNotPermitted: true;
    processSpawnNotPermitted: true;
    sidecarStartNotPermitted: true;
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

export function buildTerminalBriefSidecarDryRunStartApprovalReceiptIngestor(
  request: TerminalBriefSidecarDryRunStartApprovalRequestPacket,
  evidenceInput: TerminalBriefSidecarDryRunStartApprovalReceiptEvidenceInput[] = [],
  options: TerminalBriefSidecarDryRunStartApprovalReceiptIngestorOptions = {},
): TerminalBriefSidecarDryRunStartApprovalReceiptIngestorPacket {
  const activationApproval = toActivationApprovalPacket(request);
  const base = buildTerminalBriefSidecarActivationReceiptIngestor(activationApproval, evidenceInput, options);
  const sourceBlockers = buildSourceBlockers(request);
  const state = stateFor(request, base.state, sourceBlockers);
  const receiptEvidenceAccepted = state === "accepted" && base.receiptEvidenceAccepted;
  const approvalEvidenceAccepted = state === "accepted" && base.approvalEvidenceAccepted;
  const blockers = [
    ...sourceBlockers,
    ...(state === base.state ? base.blockers : []),
  ];
  return {
    kind: "a2a-broker.terminal-brief-sidecar-dry-run-start-approval-receipt-ingestor.packet",
    version: 1,
    generatedAt: base.generatedAt,
    mode: options.mode ?? request.mode,
    parentRoundId: request.parentRoundId,
    state,
    dryRunOnly: true,
    sourceOnlyNoLive: true,
    receiptEvidenceAccepted,
    approvalEvidenceAccepted,
    idempotencyKey: buildReceiptIngestorIdempotencyKey(request, state, base.idempotencyKey),
    source: {
      dryRunStartApprovalRequestState: request.state,
      dryRunStartApprovalRequestIdempotencyKey: request.idempotencyKey,
      requestedAction: request.approvalRequestDraft.requestedAction,
      requestedBy: request.approvalRequestDraft.requestedBy,
      operatorTarget: request.approvalRequestDraft.operatorTarget,
      operatorChannel: request.approvalRequestDraft.operatorChannel,
      dispatchRequired: request.approvalRequestDraft.dispatchRequired,
      dispatchPermitted: false,
    },
    evidence: base.evidence,
    classification: {
      ...base.classification,
      reason: reasonForState(state, base.classification.reason, sourceBlockers),
    },
    readiness: {
      sourceCriteriaMet: state === "accepted",
      receiptEvidenceAccepted,
      approvalEvidenceAccepted,
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
      blockers: [
        ...blockers,
        "approval grant evidence does not grant approval in this ingestor",
        "supervised dry-run start still requires a separate approved executor path",
      ],
      nextAction: state === "accepted"
        ? "feed accepted no-live approval evidence into a separate supervised dry-run start executor gate"
        : "collect non-conflicting visibility/manual receipt and matching approval grant evidence",
    },
    blockers,
    nextActions: nextActionsForState(state),
    approvalSensitiveActionsExcluded: [
      "sending the approval request",
      "granting approval or executing an approval grant",
      "dispatching or invoking a start executor",
      "spawning a process or starting/stopping the sidecar",
      "Terminal Brief default-on enablement",
      "live provider/Hermes/Gongyung/Telegram/OpenClaw send",
      "terminal ACK/replay or terminal receipt DB mutation",
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
      consumesDryRunStartApprovalRequestPacket: true,
      providerAcceptedIsVisibilityProof: false,
      terminalAckRequiresVisibilityProof: true,
      grantsApproval: false,
      dispatchesStartExecutor: false,
      invokesExecutor: false,
      spawnsProcess: false,
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
      dryRunStartRequiresSeparateApprovedExecutor: true,
      defaultOnNotEnabledByThisPacket: true,
      executionNotPermitted: true,
      processSpawnNotPermitted: true,
      sidecarStartNotPermitted: true,
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

export function extractTerminalBriefSidecarDryRunStartApprovalRequestPacket(
  input: unknown,
): TerminalBriefSidecarDryRunStartApprovalRequestPacket {
  const envelope = isRecord(input) ? input : {};
  const candidates = [
    input,
    envelope.dryRunStartApprovalRequest,
    envelope.dryRunStartApprovalRequestPacket,
    envelope.sidecarDryRunStartApprovalRequest,
    envelope.sidecarDryRunStartApprovalRequestPacket,
    envelope.approvalRequest,
    envelope.packet,
  ];
  const packet = candidates.find(isTerminalBriefSidecarDryRunStartApprovalRequestPacket);
  if (!packet) {
    throw new Error("expected a Terminal Brief sidecar dry-run start approval request packet");
  }
  return packet;
}

export const extractTerminalBriefSidecarDryRunStartApprovalReceiptEvidence =
  extractTerminalBriefSidecarActivationReceiptEvidence;

export function renderTerminalBriefSidecarDryRunStartApprovalReceiptIngestorMarkdown(
  packet: TerminalBriefSidecarDryRunStartApprovalReceiptIngestorPacket,
): string {
  return [
    titleForState(packet.state),
    "Mode: " + packet.mode,
    "Parent round: " + (packet.parentRoundId ?? "unknown"),
    "State: " + packet.state + " dryRunOnly=" + packet.dryRunOnly + " sourceOnlyNoLive=" + packet.sourceOnlyNoLive,
    "Idempotency: " + packet.idempotencyKey,
    "Approval request: state=" + packet.source.dryRunStartApprovalRequestState
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
    "Safety: receipt ingestor only; evidence does not mutate state; provider accepted is not visibility proof; terminalAckEligible never permits ACK here; approval grant evidence does not grant approval; start executor and sidecar start are not permitted; no live send, terminal ACK/replay, restart/deploy, DB mutation, TaskFlow record creation, historical replay, release, or secret movement.",
  ].join("\n");
}

function toActivationApprovalPacket(
  request: TerminalBriefSidecarDryRunStartApprovalRequestPacket,
): TerminalBriefSidecarActivationApprovalPacket {
  return {
    kind: "a2a-broker.terminal-brief-sidecar-activation-approval.packet",
    version: 1,
    generatedAt: request.generatedAt,
    mode: request.mode,
    parentRoundId: request.parentRoundId,
    state: request.state === "approval_request_draft_ready" ? "approval_request_draft_ready"
      : request.state === "stale" ? "stale"
        : request.state === "blocked" ? "blocked"
          : "waiting_for_gate",
    dryRunOnly: true,
    sourceOnlyNoLive: true,
    idempotencyKey: request.idempotencyKey,
    source: {
      gateState: request.state === "approval_request_draft_ready" ? "ready_for_operator_approval" : "blocked",
      gateIdempotencyKey: request.source.preflightChainReviewIdempotencyKey,
      sourceCriteriaMet: request.readiness.sourceCriteriaMet,
      alwaysOnDryRunCandidate: false,
      requiredRowsReady: request.source.requiredRowsReady,
      requiredRows: request.source.requiredRows,
      sidecarDecision: "supervised_dry_run_start_approval_request",
      finalizerStatus: request.source.finalizer,
    },
    requestDraft: {
      status: request.approvalRequestDraft.status,
      requestedAction: "approve_supervised_terminal_brief_sidecar_dry_run_start",
      requestedBy: request.approvalRequestDraft.requestedBy,
      operatorTarget: request.approvalRequestDraft.operatorTarget,
      operatorChannel: request.approvalRequestDraft.operatorChannel,
      approvalExpiresAt: request.approvalRequestDraft.approvalExpiresAt,
      dispatchRequired: request.approvalRequestDraft.dispatchRequired,
      dispatchPermitted: false,
      transcriptDraft: request.approvalRequestDraft.transcriptDraft,
    },
    activationPlan: {
      supervisedDryRunOnly: true,
      cursorPersisted: true,
      boundedPolling: true,
      abortConditions: request.supervisedDryRunBoundary.forbiddenBeforeSeparateApproval,
      rollbackInstructions: [
        "do not start sidecar from receipt evidence alone",
        "preserve approval evidence for broker finalizer review",
        "keep terminal ACK/replay disabled unless a later approved path permits it",
      ],
    },
    readiness: {
      approvalRequestDraftReady: request.readiness.approvalRequestDraftReady,
      sidecarStartPermitted: false,
      defaultOnPermitted: false,
      liveActivationPermitted: false,
      approvalGrantPermitted: false,
      providerSendPermitted: false,
      terminalAckPermitted: false,
      executionPermitted: false,
      missingEvidence: [],
      blockers: request.readiness.blockers,
      nextAction: request.readiness.nextAction,
    },
    blockers: request.blockers,
    nextActions: request.nextActions,
    approvalSensitiveActionsExcluded: request.approvalSensitiveActionsExcluded,
    integrationContract: {
      transport: "json",
      approvalPacketVersion: 1,
      harnessNeutral: true,
      openclawMessageSendRequired: false,
      hermesAdapterCompatible: true,
      gongyungAdapterCompatible: true,
      consumesSidecarDryRunGate: true,
      producesApprovalRequestDraft: true,
      sendsApprovalRequest: false,
      grantsApproval: false,
      startsSidecar: false,
      enablesDefaultOn: false,
      executesAction: false,
    },
    semantics: {
      approvalRequestDraftOnly: true,
      sourceOnlyNoLive: true,
      requestDraftIsNotSend: true,
      approvalRequestIsNotApprovalGrant: true,
      sidecarStartRequiresSeparateApprovedExecutor: true,
      defaultOnNotEnabledByThisPacket: true,
      providerAcceptedIsVisibilityProof: false,
      terminalAckEligibleDoesNotPermitAck: true,
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

function buildSourceBlockers(request: TerminalBriefSidecarDryRunStartApprovalRequestPacket): string[] {
  return unique([
    ...request.blockers,
    ...(request.state === "blocked" ? ["dry-run start approval request packet is blocked"] : []),
    ...(request.readiness.approvalRequestDispatchPermitted !== false ? ["request unexpectedly permits approval dispatch"] : []),
    ...(request.readiness.approvalGrantPermitted !== false ? ["request unexpectedly permits approval grant"] : []),
    ...(request.readiness.startExecutorDispatchPermitted !== false ? ["request unexpectedly permits start executor dispatch"] : []),
    ...(request.readiness.executorInvocationPermitted !== false ? ["request unexpectedly permits executor invocation"] : []),
    ...(request.readiness.processSpawnPermitted !== false ? ["request unexpectedly permits process spawn"] : []),
    ...(request.readiness.sidecarStartPermitted !== false ? ["request unexpectedly permits sidecar start"] : []),
    ...(request.readiness.defaultOnPermitted !== false ? ["request unexpectedly permits default-on"] : []),
    ...(request.readiness.providerSendPermitted !== false ? ["request unexpectedly permits provider send"] : []),
    ...(request.readiness.terminalAckPermitted !== false ? ["request unexpectedly permits terminal ACK"] : []),
    ...(request.readiness.dbMutationPermitted !== false ? ["request unexpectedly permits DB mutation"] : []),
    ...(request.readiness.executionPermitted !== false ? ["request unexpectedly permits execution"] : []),
    ...(request.integrationContract.sendsApprovalRequest ? ["request unexpectedly sends approval request"] : []),
    ...(request.integrationContract.grantsApproval ? ["request unexpectedly grants approval"] : []),
    ...(request.integrationContract.dispatchesStartExecutor ? ["request unexpectedly dispatches executor"] : []),
    ...(request.integrationContract.invokesExecutor ? ["request unexpectedly invokes executor"] : []),
    ...(request.integrationContract.spawnsProcess ? ["request unexpectedly spawns process"] : []),
    ...(request.integrationContract.startsSidecar ? ["request unexpectedly starts sidecar"] : []),
    ...(request.integrationContract.enablesDefaultOn ? ["request unexpectedly enables default-on"] : []),
    ...(request.integrationContract.executesAction ? ["request unexpectedly executes action"] : []),
    ...(request.semantics.performsProviderSend ? ["request unexpectedly performs provider send"] : []),
    ...(request.semantics.performsTerminalAck ? ["request unexpectedly performs terminal ACK"] : []),
    ...(request.semantics.performsRuntimeRestartOrDeploy ? ["request unexpectedly performs restart/deploy"] : []),
    ...(request.semantics.performsDbMutation ? ["request unexpectedly performs DB mutation"] : []),
    ...(request.semantics.performsHistoricalReplay ? ["request unexpectedly performs historical replay"] : []),
    ...(request.semantics.performsReleaseOrPublish ? ["request unexpectedly performs release/publish"] : []),
    ...(request.semantics.movesSecretsOrCredentials ? ["request unexpectedly moves secrets/credentials"] : []),
  ].filter(Boolean));
}

function stateFor(
  request: TerminalBriefSidecarDryRunStartApprovalRequestPacket,
  evidenceState: TerminalBriefSidecarActivationReceiptIngestorState,
  sourceBlockers: string[],
): TerminalBriefSidecarDryRunStartApprovalReceiptIngestorState {
  if (sourceBlockers.length > 0) return "blocked";
  if (request.state === "stale") return "stale";
  if (request.state === "conflicting") return "conflicting";
  if (request.state === "blocked" || request.state === "degraded") return "blocked";
  if (request.state !== "approval_request_draft_ready") return "insufficient";
  return evidenceState;
}

function reasonForState(
  state: TerminalBriefSidecarDryRunStartApprovalReceiptIngestorState,
  evidenceReason: string,
  sourceBlockers: string[],
): string {
  if (state === "blocked" && sourceBlockers.length) return sourceBlockers[0];
  if (state === "stale" && sourceBlockers.length) return "dry-run start approval request source is stale";
  if (state === "conflicting" && sourceBlockers.length) return "dry-run start approval request source is conflicting";
  return evidenceReason;
}

function nextActionsForState(state: TerminalBriefSidecarDryRunStartApprovalReceiptIngestorState): string[] {
  if (state === "accepted") {
    return [
      "feed accepted no-live evidence into a separate supervised dry-run start executor gate",
      "keep start executor, sidecar start, default-on, live send, terminal ACK, deploy, and DB mutation behind separate approval gates",
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
    "recover blocked approval request source or unsupported evidence before continuing",
    "do not use blocked evidence as approval or sidecar-start proof",
  ];
}

function buildReceiptIngestorIdempotencyKey(
  request: TerminalBriefSidecarDryRunStartApprovalRequestPacket,
  state: TerminalBriefSidecarDryRunStartApprovalReceiptIngestorState,
  evidenceKey: string,
): string {
  const base = JSON.stringify({
    label: "terminal-brief-sidecar-dry-run-start-approval-receipt-ingestor",
    parentRoundId: request.parentRoundId ?? "unknown",
    approvalRequest: request.idempotencyKey,
    evidenceKey,
    state,
  });
  return "tb-sidecar-dry-run-start-approval-receipt:" + createHash("sha256").update(base).digest("hex").slice(0, 24);
}

function titleForState(state: TerminalBriefSidecarDryRunStartApprovalReceiptIngestorState): string {
  if (state === "accepted") return "Accepted: Terminal Brief sidecar dry-run start approval evidence";
  if (state === "insufficient") return "Insufficient: Terminal Brief sidecar dry-run start approval evidence";
  if (state === "stale") return "Stale: Terminal Brief sidecar dry-run start approval evidence";
  if (state === "conflicting") return "Conflicting: Terminal Brief sidecar dry-run start approval evidence";
  if (state === "rejected") return "Rejected: Terminal Brief sidecar dry-run start approval";
  return "Blocked: Terminal Brief sidecar dry-run start approval evidence";
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function list(items: unknown[]): string {
  return items.length ? items.join(",") : "none";
}

function isTerminalBriefSidecarDryRunStartApprovalRequestPacket(
  value: unknown,
): value is TerminalBriefSidecarDryRunStartApprovalRequestPacket {
  return isRecord(value) && value.kind === "a2a-broker.terminal-brief-sidecar-dry-run-start-approval-request.packet";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
