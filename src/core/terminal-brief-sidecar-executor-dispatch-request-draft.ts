import { createHash } from "node:crypto";

import type { TerminalBriefSidecarExecutionGateFinalReviewPacket } from "./terminal-brief-sidecar-execution-gate-final-review.js";

export type TerminalBriefSidecarExecutorDispatchRequestDraftState =
  | "dispatch_request_draft_ready"
  | "waiting_for_execution_gate_final_review"
  | "final_review_blocked"
  | "stale"
  | "conflicting"
  | "blocked";

export interface TerminalBriefSidecarExecutorDispatchRequestDraftOptions {
  now?: string;
  mode?: string;
  draftOwner?: string;
  draft_owner?: string;
  dispatchRequestReference?: string;
  dispatch_request_reference?: string;
  executorAdapterId?: string;
  executor_adapter_id?: string;
}

export interface TerminalBriefSidecarExecutorDispatchRequestDraftPacket {
  kind: "a2a-broker.terminal-brief-sidecar-executor-dispatch-request-draft.packet";
  version: 1;
  generatedAt: string;
  mode: string;
  parentRoundId?: string;
  state: TerminalBriefSidecarExecutorDispatchRequestDraftState;
  dryRunOnly: true;
  sourceOnlyNoLive: true;
  idempotencyKey: string;
  source: {
    executionGateState: TerminalBriefSidecarExecutionGateFinalReviewPacket["state"];
    executionGateIdempotencyKey: string;
    finalReviewReady: boolean;
    executionGateReference: string;
    grantReference: string;
    operatorTarget: string;
    reviewReference?: string;
    requiredGrant: string;
  };
  dispatchRequestDraft: {
    draftOnly: true;
    draftOwner: string;
    dispatchRequestReference: string;
    executorAdapterId: string;
    idempotencySeed: string;
    commandMetadata: {
      transport: "json-stdin-stdout";
      commandIntent: "supervised_terminal_brief_sidecar_dry_run_start";
      stdinShape: "metadata-only";
      envKeysOnly: string[];
      secretValuesIncluded: false;
      writesRuntimeState: false;
    };
    evidenceReferences: Array<{
      id: string;
      label: string;
      reference: string;
      requiredBeforeDispatch: true;
    }>;
    abortConditions: string[];
    rollbackChecklist: string[];
  };
  readiness: {
    sourceCriteriaMet: boolean;
    dispatchRequestDraftReady: boolean;
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
    executorDispatchRequestDraftVersion: 1;
    harnessNeutral: true;
    openclawMessageSendRequired: false;
    hermesAdapterCompatible: true;
    gongyungAdapterCompatible: true;
    externalHarnessCompatible: true;
    consumesExecutionGateFinalReviewPacket: true;
    rendersExecutorDispatchRequestDraft: true;
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
    executorDispatchRequestDraftOnly: true;
    sourceOnlyNoLive: true;
    draftDoesNotDispatchExecutor: true;
    finalReviewDoesNotAuthorizeRuntime: true;
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

export function buildTerminalBriefSidecarExecutorDispatchRequestDraft(
  finalReview: TerminalBriefSidecarExecutionGateFinalReviewPacket,
  options: TerminalBriefSidecarExecutorDispatchRequestDraftOptions = {},
): TerminalBriefSidecarExecutorDispatchRequestDraftPacket {
  const generatedAt = options.now ?? new Date().toISOString();
  const blockers = buildSourceBlockers(finalReview);
  const state = stateFor(finalReview, blockers);
  const dispatchRequestReference = options.dispatchRequestReference ?? options.dispatch_request_reference ?? buildDispatchRequestReference(finalReview);
  const executorAdapterId = options.executorAdapterId ?? options.executor_adapter_id ?? "terminal-brief-sidecar-supervised-dry-run-start";
  return {
    kind: "a2a-broker.terminal-brief-sidecar-executor-dispatch-request-draft.packet",
    version: 1,
    generatedAt,
    mode: options.mode ?? finalReview.mode,
    parentRoundId: finalReview.parentRoundId,
    state,
    dryRunOnly: true,
    sourceOnlyNoLive: true,
    idempotencyKey: buildDispatchDraftIdempotencyKey(finalReview, dispatchRequestReference, generatedAt, state),
    source: {
      executionGateState: finalReview.state,
      executionGateIdempotencyKey: finalReview.idempotencyKey,
      finalReviewReady: finalReview.readiness.finalReviewReady,
      executionGateReference: finalReview.finalReview.executionGateReference,
      grantReference: finalReview.source.grantReference,
      operatorTarget: finalReview.source.operatorTarget,
      reviewReference: finalReview.source.reviewReference,
      requiredGrant: finalReview.source.requiredGrant,
    },
    dispatchRequestDraft: {
      draftOnly: true,
      draftOwner: options.draftOwner ?? options.draft_owner ?? "broker-finalizer",
      dispatchRequestReference,
      executorAdapterId,
      idempotencySeed: finalReview.idempotencyKey + ":" + dispatchRequestReference,
      commandMetadata: {
        transport: "json-stdin-stdout",
        commandIntent: "supervised_terminal_brief_sidecar_dry_run_start",
        stdinShape: "metadata-only",
        envKeysOnly: ["A2A_BROKER_URL", "A2A_BROKER_ID", "TERMINAL_BRIEF_SIDECAR_MODE", "TERMINAL_BRIEF_SIDECAR_DRY_RUN_ONLY"],
        secretValuesIncluded: false,
        writesRuntimeState: false,
      },
      evidenceReferences: [
        { id: "execution_gate_final_review", label: "Execution gate final review packet", reference: finalReview.idempotencyKey, requiredBeforeDispatch: true },
        { id: "grant_evidence", label: "Accepted grant evidence reference", reference: finalReview.source.grantReference, requiredBeforeDispatch: true },
        { id: "runtime_preflight", label: "Runtime preflight evidence", reference: finalReview.finalReview.executionGateReference + ":runtime-preflight", requiredBeforeDispatch: true },
        { id: "rollback", label: "Rollback checklist", reference: dispatchRequestReference + ":rollback", requiredBeforeDispatch: true },
      ],
      abortConditions: [
        ...finalReview.finalReview.abortConditions,
        "dispatch request draft is treated as executable command input",
        "executor adapter requires secret values in packet input",
        "executor adapter output claims provider send or terminal ACK",
      ],
      rollbackChecklist: [
        ...finalReview.finalReview.rollbackChecklist,
        "discard draft without runtime side effects",
        "create a fresh dispatch draft if any final review evidence changes",
      ],
    },
    readiness: {
      sourceCriteriaMet: state === "dispatch_request_draft_ready",
      dispatchRequestDraftReady: state === "dispatch_request_draft_ready",
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
      missingEvidence: missingEvidenceFor(finalReview),
      blockers: [
        ...blockers,
        "dispatch request draft is not executor dispatch",
        "runtime execution requires later separate approved dispatcher path",
      ],
      nextAction: nextActionFor(state),
    },
    blockers,
    nextActions: nextActionsFor(state),
    approvalSensitiveActionsExcluded: approvalSensitiveActionsExcluded(),
    integrationContract: {
      transport: "json",
      executorDispatchRequestDraftVersion: 1,
      harnessNeutral: true,
      openclawMessageSendRequired: false,
      hermesAdapterCompatible: true,
      gongyungAdapterCompatible: true,
      externalHarnessCompatible: true,
      consumesExecutionGateFinalReviewPacket: true,
      rendersExecutorDispatchRequestDraft: true,
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
      executorDispatchRequestDraftOnly: true,
      sourceOnlyNoLive: true,
      draftDoesNotDispatchExecutor: true,
      finalReviewDoesNotAuthorizeRuntime: true,
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

export function extractTerminalBriefSidecarExecutorDispatchRequestDraftFinalReview(
  input: unknown,
): TerminalBriefSidecarExecutionGateFinalReviewPacket {
  const envelope = isRecord(input) ? input : {};
  const candidates = [input, envelope.executionGateFinalReviewPacket, envelope.finalReviewPacket, envelope.sidecarExecutionGateFinalReviewPacket, envelope.packet];
  const packet = candidates.find(isTerminalBriefSidecarExecutionGateFinalReviewPacket);
  if (!packet) throw new Error("expected a Terminal Brief sidecar execution gate final review packet");
  return packet;
}

export function extractTerminalBriefSidecarExecutorDispatchRequestDraftOptions(
  input: unknown,
): TerminalBriefSidecarExecutorDispatchRequestDraftOptions {
  const envelope = isRecord(input) ? input : {};
  const candidate = envelope.executorDispatchRequestDraft ?? envelope.executorDispatchRequestDraftOptions ?? envelope.options;
  return isRecord(candidate) ? candidate as TerminalBriefSidecarExecutorDispatchRequestDraftOptions : {};
}

export function renderTerminalBriefSidecarExecutorDispatchRequestDraftMarkdown(
  packet: TerminalBriefSidecarExecutorDispatchRequestDraftPacket,
): string {
  return [
    titleForState(packet.state),
    "Mode: " + packet.mode,
    "Parent round: " + (packet.parentRoundId ?? "unknown"),
    "State: " + packet.state + " dryRunOnly=" + packet.dryRunOnly + " sourceOnlyNoLive=" + packet.sourceOnlyNoLive,
    "Idempotency: " + packet.idempotencyKey,
    "Source final review: state=" + packet.source.executionGateState
      + " ready=" + packet.source.finalReviewReady
      + " reference=" + packet.source.executionGateReference,
    "Dispatch draft: reference=" + packet.dispatchRequestDraft.dispatchRequestReference
      + " draftOnly=" + packet.dispatchRequestDraft.draftOnly
      + " adapter=" + packet.dispatchRequestDraft.executorAdapterId,
    "Readiness: dispatchRequestDraftReady=" + packet.readiness.dispatchRequestDraftReady
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
    "Safety: dispatch request draft only; does not dispatch/invoke executor, spawn a process, start sidecar, enable default-on, send providers, ACK/replay terminal rows, mutate GitHub/DB/TaskFlow state, restart/deploy, replay history, release, publish, or move secrets.",
  ].join("\n");
}

function buildSourceBlockers(finalReview: TerminalBriefSidecarExecutionGateFinalReviewPacket): string[] {
  return unique([
    ...finalReview.blockers,
    ...(finalReview.state !== "ready_for_execution_gate_final_review" ? ["execution gate final review state is " + finalReview.state] : []),
    ...(!finalReview.readiness.finalReviewReady ? ["execution gate final review is not ready"] : []),
    ...(finalReview.readiness.startExecutorDispatchPermitted !== false ? ["final review unexpectedly permits executor dispatch"] : []),
    ...(finalReview.readiness.executorInvocationPermitted !== false ? ["final review unexpectedly permits executor invocation"] : []),
    ...(finalReview.readiness.processSpawnPermitted !== false ? ["final review unexpectedly permits process spawn"] : []),
    ...(finalReview.readiness.sidecarStartPermitted !== false ? ["final review unexpectedly permits sidecar start"] : []),
    ...(finalReview.readiness.defaultOnPermitted !== false ? ["final review unexpectedly permits default-on"] : []),
    ...(finalReview.readiness.providerSendPermitted !== false ? ["final review unexpectedly permits provider send"] : []),
    ...(finalReview.readiness.terminalAckPermitted !== false ? ["final review unexpectedly permits terminal ACK"] : []),
    ...(finalReview.readiness.executionPermitted !== false ? ["final review unexpectedly permits execution"] : []),
    ...(finalReview.readiness.dbMutationPermitted !== false ? ["final review unexpectedly permits DB mutation"] : []),
    ...(finalReview.integrationContract.dispatchesStartExecutor ? ["final review unexpectedly dispatches start executor"] : []),
    ...(finalReview.integrationContract.invokesExecutor ? ["final review unexpectedly invokes executor"] : []),
    ...(finalReview.integrationContract.spawnsProcess ? ["final review unexpectedly spawns process"] : []),
    ...(finalReview.integrationContract.startsSidecar ? ["final review unexpectedly starts sidecar"] : []),
    ...(finalReview.integrationContract.executesAction ? ["final review unexpectedly executes action"] : []),
    ...(finalReview.semantics.performsProviderSend ? ["final review unexpectedly performs provider send"] : []),
    ...(finalReview.semantics.performsTerminalAck ? ["final review unexpectedly performs terminal ACK"] : []),
    ...(finalReview.semantics.performsRuntimeRestartOrDeploy ? ["final review unexpectedly performs restart/deploy"] : []),
    ...(finalReview.semantics.performsDbMutation ? ["final review unexpectedly performs DB mutation"] : []),
    ...(finalReview.semantics.movesSecretsOrCredentials ? ["final review unexpectedly moves secrets/credentials"] : []),
  ].filter(Boolean));
}

function stateFor(
  finalReview: TerminalBriefSidecarExecutionGateFinalReviewPacket,
  blockers: string[],
): TerminalBriefSidecarExecutorDispatchRequestDraftState {
  if (finalReview.state === "stale") return "stale";
  if (finalReview.state === "conflicting") return "conflicting";
  if (finalReview.state !== "ready_for_execution_gate_final_review") return finalReview.state === "blocked" ? "final_review_blocked" : "waiting_for_execution_gate_final_review";
  if (blockers.length) return "blocked";
  return "dispatch_request_draft_ready";
}

function missingEvidenceFor(finalReview: TerminalBriefSidecarExecutionGateFinalReviewPacket): string[] {
  const missing: string[] = [];
  if (finalReview.state !== "ready_for_execution_gate_final_review") missing.push("ready_execution_gate_final_review");
  if (!finalReview.readiness.finalReviewReady) missing.push("final_review_ready");
  return unique(missing);
}

function nextActionFor(state: TerminalBriefSidecarExecutorDispatchRequestDraftState): string {
  if (state === "dispatch_request_draft_ready") return "broker finalizer may review the dispatch request draft before any later separately approved dispatcher path; this packet dispatches nothing";
  if (state === "stale") return "refresh execution gate final review before drafting dispatch request";
  if (state === "conflicting") return "resolve conflicting execution gate final review evidence";
  if (state === "final_review_blocked") return "resolve blocked execution gate final review before dispatch request draft";
  if (state === "waiting_for_execution_gate_final_review") return "wait for ready execution gate final review";
  return "resolve blocked source final review before dispatch request draft";
}

function nextActionsFor(state: TerminalBriefSidecarExecutorDispatchRequestDraftState): string[] {
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

function buildDispatchRequestReference(finalReview: TerminalBriefSidecarExecutionGateFinalReviewPacket): string {
  return "executor-dispatch-request:" + createHash("sha256").update(finalReview.idempotencyKey).digest("hex").slice(0, 16);
}

function buildDispatchDraftIdempotencyKey(
  finalReview: TerminalBriefSidecarExecutionGateFinalReviewPacket,
  dispatchRequestReference: string,
  generatedAt: string,
  state: TerminalBriefSidecarExecutorDispatchRequestDraftState,
): string {
  const base = JSON.stringify({ label: "terminal-brief-sidecar-executor-dispatch-request-draft", finalReview: finalReview.idempotencyKey, dispatchRequestReference, generatedAt, state });
  return "tb-sidecar-executor-dispatch-request-draft:" + createHash("sha256").update(base).digest("hex").slice(0, 24);
}

function titleForState(state: TerminalBriefSidecarExecutorDispatchRequestDraftState): string {
  if (state === "dispatch_request_draft_ready") return "Ready: Terminal Brief sidecar executor dispatch request draft";
  if (state === "stale") return "Stale: Terminal Brief sidecar executor dispatch request draft";
  if (state === "conflicting") return "Conflicting: Terminal Brief sidecar executor dispatch request draft";
  if (state === "final_review_blocked") return "Blocked: Terminal Brief sidecar execution gate final review";
  if (state === "waiting_for_execution_gate_final_review") return "Waiting: Terminal Brief sidecar execution gate final review";
  return "Blocked: Terminal Brief sidecar executor dispatch request draft";
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function isTerminalBriefSidecarExecutionGateFinalReviewPacket(
  value: unknown,
): value is TerminalBriefSidecarExecutionGateFinalReviewPacket {
  return isRecord(value) && value.kind === "a2a-broker.terminal-brief-sidecar-execution-gate-final-review.packet";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
