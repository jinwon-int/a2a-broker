import { createHash } from "node:crypto";

import type {
  TerminalBriefApprovalRequestPacket,
  TerminalBriefApprovalRequestedAction,
} from "./terminal-brief-approval-request.js";

export type TerminalBriefApprovalExecutorState =
  | "dispatch_pending"
  | "approval_granted_dry_run"
  | "execute_blocked"
  | "blocked";

export type TerminalBriefApprovalExecutionState = "not_attempted" | "execute_blocked";

export interface TerminalBriefApprovalExecutorOptions {
  now?: string;
  mode?: string;
  selectedAction?: string;
  selectedTarget?: string;
  attemptExecute?: boolean;
}

export interface TerminalBriefApprovalExecutorPacket {
  kind: "a2a-broker.terminal-brief-approval-executor.packet";
  version: 1;
  generatedAt: string;
  mode: string;
  parentRoundId?: string;
  state: TerminalBriefApprovalExecutorState;
  dryRunOnly: true;
  dispatchPermitted: false;
  approvalGrantPermitted: false;
  executionPermitted: false;
  idempotencyKey: string;
  finalizer: TerminalBriefApprovalRequestPacket["finalizer"];
  source: {
    approvalRequestDecision: TerminalBriefApprovalRequestPacket["decision"];
    approvalRequestIdempotencyKey: string;
    targetIssueUrl?: string;
    targetPrUrl?: string;
    requestedActions: number;
    nonRequestableActions: number;
  };
  dispatch: {
    state: "dispatch_pending" | "blocked";
    transport: "none";
    requestDispatchPermitted: false;
    requestDispatched: false;
    requestSendPermitted: false;
    reason: string;
  };
  approval: {
    state: "none" | "simulated_granted_dry_run" | "blocked";
    selectedAction?: TerminalBriefApprovalRequestedAction;
    requestedActionValue?: string;
    realApprovalGranted: false;
    simulatedApprovalOnly: boolean;
    reason: string;
  };
  execution: {
    state: TerminalBriefApprovalExecutionState;
    selectedAction?: TerminalBriefApprovalRequestedAction;
    executePermitted: false;
    executed: false;
    reason: string;
  };
  blockers: string[];
  nextActions: string[];
  integrationContract: {
    transport: "json";
    harnessNeutral: true;
    openclawMessageSendRequired: false;
    hermesAdapterCompatible: true;
    sendsApprovalRequest: false;
    grantsApproval: false;
    executesAction: false;
  };
  semantics: {
    approvalExecutorShellOnly: true;
    dispatchNotPerformed: true;
    approvalNotReallyGranted: true;
    simulatedApprovalOnly: boolean;
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

export function buildTerminalBriefApprovalExecutor(
  approvalRequest: TerminalBriefApprovalRequestPacket,
  options: TerminalBriefApprovalExecutorOptions = {},
): TerminalBriefApprovalExecutorPacket {
  const selectedAction = findSelectedAction(approvalRequest, options.selectedAction, options.selectedTarget);
  const blockers = buildBlockers(approvalRequest, options, selectedAction);
  const state = stateForRequest(approvalRequest, options, selectedAction, blockers);
  const generatedAt = options.now ?? new Date().toISOString();
  const simulatedApprovalOnly = state === "approval_granted_dry_run" || state === "execute_blocked";
  const executionState: TerminalBriefApprovalExecutionState = state === "execute_blocked" ? "execute_blocked" : "not_attempted";
  return {
    kind: "a2a-broker.terminal-brief-approval-executor.packet",
    version: 1,
    generatedAt,
    mode: options.mode ?? approvalRequest.mode,
    parentRoundId: approvalRequest.parentRoundId,
    state,
    dryRunOnly: true,
    dispatchPermitted: false,
    approvalGrantPermitted: false,
    executionPermitted: false,
    idempotencyKey: buildExecutorIdempotencyKey(approvalRequest, state, options, selectedAction),
    finalizer: approvalRequest.finalizer,
    source: {
      approvalRequestDecision: approvalRequest.decision,
      approvalRequestIdempotencyKey: approvalRequest.idempotencyKey,
      targetIssueUrl: approvalRequest.source.targetIssueUrl,
      targetPrUrl: approvalRequest.source.targetPrUrl,
      requestedActions: approvalRequest.request.requestedActions.length,
      nonRequestableActions: approvalRequest.request.nonRequestableActions.length,
    },
    dispatch: {
      state: state === "blocked" ? "blocked" : "dispatch_pending",
      transport: "none",
      requestDispatchPermitted: false,
      requestDispatched: false,
      requestSendPermitted: false,
      reason: state === "blocked"
        ? "approval request cannot be dispatched from this shell"
        : "dispatch is intentionally held; no harness message was sent",
    },
    approval: {
      state: simulatedApprovalOnly ? "simulated_granted_dry_run" : state === "blocked" ? "blocked" : "none",
      selectedAction,
      requestedActionValue: selectedAction ? actionValue(approvalRequest.idempotencyKey, selectedAction) : undefined,
      realApprovalGranted: false,
      simulatedApprovalOnly,
      reason: simulatedApprovalOnly
        ? "selected action is marked as simulated approval only; no real approval was granted"
        : state === "blocked"
          ? "approval shell is blocked"
          : "no approval selection was supplied",
    },
    execution: {
      state: executionState,
      selectedAction,
      executePermitted: false,
      executed: false,
      reason: state === "execute_blocked"
        ? "execution attempt is blocked by no-live executor shell"
        : "execution was not attempted and remains forbidden",
    },
    blockers,
    nextActions: nextActionsForState(state),
    integrationContract: {
      transport: "json",
      harnessNeutral: true,
      openclawMessageSendRequired: false,
      hermesAdapterCompatible: true,
      sendsApprovalRequest: false,
      grantsApproval: false,
      executesAction: false,
    },
    semantics: {
      approvalExecutorShellOnly: true,
      dispatchNotPerformed: true,
      approvalNotReallyGranted: true,
      simulatedApprovalOnly,
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

export function extractTerminalBriefApprovalRequestPacket(input: unknown): TerminalBriefApprovalRequestPacket {
  const envelope = isRecord(input) ? input : {};
  const candidates = [
    input,
    envelope.approvalRequest,
    envelope.approvalRequestPacket,
    envelope.requestPacket,
    envelope.packet,
  ];
  const packet = candidates.find(isTerminalBriefApprovalRequestPacket);
  if (!packet) {
    throw new Error("expected a Terminal Brief approval request packet");
  }
  return packet;
}

export function renderTerminalBriefApprovalExecutorMarkdown(packet: TerminalBriefApprovalExecutorPacket): string {
  return [
    titleForState(packet.state),
    "Mode: " + packet.mode,
    "Parent round: " + (packet.parentRoundId ?? "unknown"),
    "State: " + packet.state + " dryRunOnly=" + packet.dryRunOnly,
    "Dispatch permitted: " + packet.dispatchPermitted,
    "Approval grant permitted: " + packet.approvalGrantPermitted,
    "Execution permitted: " + packet.executionPermitted,
    "Idempotency: " + packet.idempotencyKey,
    "Finalizer: broker=" + packet.finalizer.brokerOfRecordId
      + " owner=" + packet.finalizer.owner
      + " singleFinalizerRequired=" + packet.finalizer.singleFinalizerRequired,
    "Source approval request: decision=" + packet.source.approvalRequestDecision
      + " idempotency=" + packet.source.approvalRequestIdempotencyKey
      + " requestedActions=" + packet.source.requestedActions
      + " nonRequestableActions=" + packet.source.nonRequestableActions,
    "Targets: issue=" + (packet.source.targetIssueUrl ?? "none") + " pr=" + (packet.source.targetPrUrl ?? "none"),
    "Harness: JSON transport; OpenClaw message send required=false; Hermes adapter compatible=true; sendsApprovalRequest=false; grantsApproval=false; executesAction=false.",
    "",
    "Dispatch:",
    "- state=" + packet.dispatch.state
      + " transport=" + packet.dispatch.transport
      + " requestDispatched=" + packet.dispatch.requestDispatched
      + " reason=" + packet.dispatch.reason,
    "",
    "Approval:",
    "- state=" + packet.approval.state
      + " realApprovalGranted=" + packet.approval.realApprovalGranted
      + " simulatedApprovalOnly=" + packet.approval.simulatedApprovalOnly
      + " selectedAction=" + (packet.approval.selectedAction?.action ?? "none")
      + " reason=" + packet.approval.reason,
    "",
    "Execution:",
    "- state=" + packet.execution.state
      + " executePermitted=" + packet.execution.executePermitted
      + " executed=" + packet.execution.executed
      + " selectedAction=" + (packet.execution.selectedAction?.action ?? "none")
      + " reason=" + packet.execution.reason,
    ...(packet.blockers.length ? ["", "Blockers:", ...packet.blockers.map((blocker) => "- " + blocker)] : []),
    "",
    "Next actions:",
    ...packet.nextActions.map((action) => "- " + action),
    "",
    "Safety: approval executor shell only; request not dispatched; approval not really granted; execution not permitted; no comment post, merge, issue close, live send, terminal ACK/replay, restart/deploy, DB mutation, TaskFlow record creation, historical replay, release, or secret movement.",
  ].join("\n");
}

function findSelectedAction(
  request: TerminalBriefApprovalRequestPacket,
  selectedAction?: string,
  selectedTarget?: string,
): TerminalBriefApprovalRequestedAction | undefined {
  if (!selectedAction) return undefined;
  return request.request.requestedActions.find((action) => {
    if (action.action !== selectedAction) return false;
    return selectedTarget ? action.target === selectedTarget : true;
  });
}

function stateForRequest(
  request: TerminalBriefApprovalRequestPacket,
  options: TerminalBriefApprovalExecutorOptions,
  selectedAction: TerminalBriefApprovalRequestedAction | undefined,
  blockers: string[],
): TerminalBriefApprovalExecutorState {
  if (blockers.length > 0 || request.decision !== "request_ready") return "blocked";
  if (!options.selectedAction) return "dispatch_pending";
  if (!selectedAction) return "blocked";
  if (options.attemptExecute) return "execute_blocked";
  return "approval_granted_dry_run";
}

function buildBlockers(
  request: TerminalBriefApprovalRequestPacket,
  options: TerminalBriefApprovalExecutorOptions,
  selectedAction: TerminalBriefApprovalRequestedAction | undefined,
): string[] {
  const blockers = [...request.blockers];
  if (request.decision !== "request_ready") {
    blockers.push("approval request is not ready; executor shell cannot continue");
  }
  if (options.selectedAction && !selectedAction) {
    blockers.push("selected action is not present in request.requestedActions");
  }
  return [...new Set(blockers)];
}

function actionValue(requestIdempotencyKey: string, action: TerminalBriefApprovalRequestedAction): string {
  return "approval-executor:" + requestIdempotencyKey + ":" + action.action + ":" + (action.target ?? "none");
}

function buildExecutorIdempotencyKey(
  request: TerminalBriefApprovalRequestPacket,
  state: TerminalBriefApprovalExecutorState,
  options: TerminalBriefApprovalExecutorOptions,
  selectedAction?: TerminalBriefApprovalRequestedAction,
): string {
  const base = [
    "terminal-brief-approval-executor",
    request.parentRoundId ?? "unknown",
    request.idempotencyKey,
    state,
    selectedAction?.action ?? options.selectedAction ?? "",
    selectedAction?.target ?? options.selectedTarget ?? "",
    options.attemptExecute ? "attempt-execute" : "no-execute",
  ].join(":");
  return "tb-approval-executor:" + createHash("sha256").update(base).digest("hex").slice(0, 24);
}

function nextActionsForState(state: TerminalBriefApprovalExecutorState): string[] {
  if (state === "dispatch_pending") {
    return [
      "choose a harness-specific approval transport in a separately approved implementation",
      "do not dispatch the request from this shell",
    ];
  }
  if (state === "approval_granted_dry_run") {
    return [
      "treat simulated approval as validation evidence only",
      "keep real execution in a separate approval-gated executor",
    ];
  }
  if (state === "execute_blocked") {
    return [
      "record that execution remains blocked after simulated approval",
      "request explicit operator approval before any future real executor can act",
    ];
  }
  return [
    "recover approval request blockers or selected action mismatch",
    "rerun approval request planner and executor shell after recovery",
  ];
}

function titleForState(state: TerminalBriefApprovalExecutorState): string {
  if (state === "dispatch_pending") return "Pending dispatch: Terminal Brief approval executor shell";
  if (state === "approval_granted_dry_run") return "Dry-run approval: Terminal Brief approval executor shell";
  if (state === "execute_blocked") return "Execution blocked: Terminal Brief approval executor shell";
  return "Blocked: Terminal Brief approval executor shell";
}

function isTerminalBriefApprovalRequestPacket(value: unknown): value is TerminalBriefApprovalRequestPacket {
  return isRecord(value) && value.kind === "a2a-broker.terminal-brief-approval-request.packet";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
