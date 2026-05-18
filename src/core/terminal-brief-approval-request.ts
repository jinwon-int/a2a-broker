import { createHash } from "node:crypto";

import type {
  TerminalBriefCloseoutGateAction,
  TerminalBriefCloseoutGateActionStatus,
  TerminalBriefCloseoutGatePacket,
} from "./terminal-brief-closeout-gate.js";

export type TerminalBriefApprovalRequestDecision = "request_ready" | "waiting" | "blocked";

export interface TerminalBriefApprovalRequestOptions {
  now?: string;
  mode?: string;
  expiresAt?: string;
}

export interface TerminalBriefApprovalRequestedAction {
  action: TerminalBriefCloseoutGateAction["action"];
  status: "requested";
  sourceGateStatus: "proposed";
  requiresApproval: true;
  executePermitted: false;
  target?: string;
  reason: string;
  draft?: Record<string, unknown>;
}

export interface TerminalBriefApprovalNonRequestableAction {
  action: TerminalBriefCloseoutGateAction["action"];
  status: TerminalBriefCloseoutGateActionStatus;
  requiresApproval: boolean;
  executePermitted: false;
  target?: string;
  reason: string;
}

export interface TerminalBriefApprovalRequestPacket {
  kind: "a2a-broker.terminal-brief-approval-request.packet";
  version: 1;
  generatedAt: string;
  mode: string;
  parentRoundId?: string;
  decision: TerminalBriefApprovalRequestDecision;
  dryRunOnly: true;
  requestDispatchPermitted: false;
  approvalGrantPermitted: false;
  executionPermitted: false;
  idempotencyKey: string;
  finalizer: TerminalBriefCloseoutGatePacket["finalizer"];
  source: {
    closeoutGateDecision: TerminalBriefCloseoutGatePacket["decision"];
    closeoutGateState: TerminalBriefCloseoutGatePacket["gateState"];
    closeoutGateIdempotencyKey: string;
    targetIssueUrl?: string;
    targetPrUrl?: string;
    proposedActions: number;
    blockedActions: number;
    forbiddenActions: number;
  };
  request: {
    mode: "draft-only";
    title: string;
    body: string;
    sendPermitted: false;
    requestedActions: TerminalBriefApprovalRequestedAction[];
    nonRequestableActions: TerminalBriefApprovalNonRequestableAction[];
    presentationPlan: {
      kind: "approval_buttons";
      sendPermitted: false;
      buttonsEnabled: false;
      buttons: Array<{
        label: string;
        value: string;
        style: "primary" | "secondary" | "danger";
        enabled: false;
        executePermitted: false;
      }>;
    };
    cliPlan: {
      mode: "plan-only";
      command: string;
      executePermitted: false;
      requiredHumanApproval: true;
    };
  };
  blockers: string[];
  nextActions: string[];
  integrationContract: {
    transport: "json";
    harnessNeutral: true;
    openclawMessageSendRequired: false;
    hermesAdapterCompatible: true;
    sendsApprovalRequest: false;
  };
  semantics: {
    approvalRequestPlannerOnly: true;
    requestNotSent: true;
    approvalNotGranted: true;
    executionNotPermitted: true;
    routeIsReadOnly: true;
    brokerFinalizerRequired: true;
    singleFinalizerRequired: true;
    idempotentRequestDraft: true;
    expiresAt?: string;
    replayRequiresSameIdempotencyKey: true;
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

export function buildTerminalBriefApprovalRequest(
  gate: TerminalBriefCloseoutGatePacket,
  options: TerminalBriefApprovalRequestOptions = {},
): TerminalBriefApprovalRequestPacket {
  const requestedActions = buildRequestedActions(gate.actions);
  const nonRequestableActions = buildNonRequestableActions(gate.actions);
  const decision = decisionForGate(gate, requestedActions);
  const blockers = blockersForDecision(decision, gate, requestedActions);
  const idempotencyKey = buildApprovalRequestIdempotencyKey(gate, decision, requestedActions);
  const generatedAt = options.now ?? new Date().toISOString();
  const title = titleForDecision(decision, gate);
  const buttons = buildButtons(idempotencyKey, requestedActions);
  const cliPlan = {
    mode: "plan-only" as const,
    command: "terminal_brief_approval_request --input closeout-gate.json --json",
    executePermitted: false as const,
    requiredHumanApproval: true as const,
  };
  const packet: TerminalBriefApprovalRequestPacket = {
    kind: "a2a-broker.terminal-brief-approval-request.packet",
    version: 1,
    generatedAt,
    mode: options.mode ?? gate.mode,
    parentRoundId: gate.parentRoundId,
    decision,
    dryRunOnly: true,
    requestDispatchPermitted: false,
    approvalGrantPermitted: false,
    executionPermitted: false,
    idempotencyKey,
    finalizer: gate.finalizer,
    source: {
      closeoutGateDecision: gate.decision,
      closeoutGateState: gate.gateState,
      closeoutGateIdempotencyKey: gate.idempotencyKey,
      targetIssueUrl: gate.source.targetIssueUrl,
      targetPrUrl: gate.source.targetPrUrl,
      proposedActions: requestedActions.length,
      blockedActions: gate.actions.filter((action) => action.status === "blocked").length,
      forbiddenActions: gate.actions.filter((action) => action.status === "forbidden").length,
    },
    request: {
      mode: "draft-only",
      title,
      body: "",
      sendPermitted: false,
      requestedActions,
      nonRequestableActions,
      presentationPlan: {
        kind: "approval_buttons",
        sendPermitted: false,
        buttonsEnabled: false,
        buttons,
      },
      cliPlan,
    },
    blockers,
    nextActions: nextActionsForDecision(decision),
    integrationContract: {
      transport: "json",
      harnessNeutral: true,
      openclawMessageSendRequired: false,
      hermesAdapterCompatible: true,
      sendsApprovalRequest: false,
    },
    semantics: {
      approvalRequestPlannerOnly: true,
      requestNotSent: true,
      approvalNotGranted: true,
      executionNotPermitted: true,
      routeIsReadOnly: true,
      brokerFinalizerRequired: true,
      singleFinalizerRequired: true,
      idempotentRequestDraft: true,
      expiresAt: options.expiresAt,
      replayRequiresSameIdempotencyKey: true,
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
  packet.request.body = renderTerminalBriefApprovalRequestMarkdown(packet);
  return packet;
}

export function extractTerminalBriefCloseoutGatePacket(input: unknown): TerminalBriefCloseoutGatePacket {
  const envelope = isRecord(input) ? input : {};
  const candidates = [
    input,
    envelope.gatePacket,
    envelope.closeoutGate,
    envelope.gate,
    envelope.packet,
  ];
  const packet = candidates.find(isTerminalBriefCloseoutGatePacket);
  if (!packet) {
    throw new Error("expected a Terminal Brief closeout gate packet");
  }
  return packet;
}

export function renderTerminalBriefApprovalRequestMarkdown(packet: TerminalBriefApprovalRequestPacket): string {
  return [
    packet.request.title,
    "Mode: " + packet.mode,
    "Parent round: " + (packet.parentRoundId ?? "unknown"),
    "Decision: " + packet.decision + " dryRunOnly=" + packet.dryRunOnly,
    "Request dispatch permitted: " + packet.requestDispatchPermitted,
    "Approval grant permitted: " + packet.approvalGrantPermitted,
    "Execution permitted: " + packet.executionPermitted,
    "Idempotency: " + packet.idempotencyKey,
    "Finalizer: broker=" + packet.finalizer.brokerOfRecordId
      + " owner=" + packet.finalizer.owner
      + " singleFinalizerRequired=" + packet.finalizer.singleFinalizerRequired,
    "Source gate: decision=" + packet.source.closeoutGateDecision
      + " state=" + packet.source.closeoutGateState
      + " idempotency=" + packet.source.closeoutGateIdempotencyKey,
    "Targets: issue=" + (packet.source.targetIssueUrl ?? "none") + " pr=" + (packet.source.targetPrUrl ?? "none"),
    "Harness: JSON transport; OpenClaw message send required=false; Hermes adapter compatible=true; sendsApprovalRequest=false.",
    "",
    "Requested actions:",
    ...(packet.request.requestedActions.length
      ? packet.request.requestedActions.map((action) => [
        "- " + action.action,
        "status=" + action.status,
        "sourceGateStatus=" + action.sourceGateStatus,
        "approval=" + action.requiresApproval,
        "execute=" + action.executePermitted,
        "target=" + (action.target ?? "none"),
        "reason=" + action.reason,
      ].join(" | "))
      : ["- none"]),
    "",
    "Non-requestable actions:",
    ...(packet.request.nonRequestableActions.length
      ? packet.request.nonRequestableActions.map((action) => [
        "- " + action.action,
        "status=" + action.status,
        "approval=" + action.requiresApproval,
        "execute=" + action.executePermitted,
        "target=" + (action.target ?? "none"),
        "reason=" + action.reason,
      ].join(" | "))
      : ["- none"]),
    "",
    "Presentation plan: kind=" + packet.request.presentationPlan.kind
      + " sendPermitted=" + packet.request.presentationPlan.sendPermitted
      + " buttonsEnabled=" + packet.request.presentationPlan.buttonsEnabled,
    ...packet.request.presentationPlan.buttons.map((button) => "- " + button.label
      + " | enabled=" + button.enabled
      + " | execute=" + button.executePermitted
      + " | value=" + button.value),
    "CLI plan: " + packet.request.cliPlan.command
      + " executePermitted=" + packet.request.cliPlan.executePermitted
      + " requiredHumanApproval=" + packet.request.cliPlan.requiredHumanApproval,
    ...(packet.blockers.length ? ["", "Blockers:", ...packet.blockers.map((blocker) => "- " + blocker)] : []),
    "",
    "Next actions:",
    ...packet.nextActions.map((action) => "- " + action),
    "",
    "Safety: approval request planner only; request not sent; approval not granted; no comment post, merge, issue close, live send, terminal ACK/replay, restart/deploy, DB mutation, TaskFlow record creation, historical replay, release, or secret movement.",
  ].join("\n");
}

function decisionForGate(
  gate: TerminalBriefCloseoutGatePacket,
  requestedActions: TerminalBriefApprovalRequestedAction[],
): TerminalBriefApprovalRequestDecision {
  if (gate.decision === "ready_for_approval" && requestedActions.length > 0) return "request_ready";
  if (gate.decision === "waiting") return "waiting";
  return "blocked";
}

function buildRequestedActions(actions: TerminalBriefCloseoutGateAction[]): TerminalBriefApprovalRequestedAction[] {
  return actions
    .filter((action) => action.status === "proposed")
    .map((action) => ({
      action: action.action,
      status: "requested" as const,
      sourceGateStatus: "proposed" as const,
      requiresApproval: true as const,
      executePermitted: false as const,
      target: action.target,
      reason: action.reason,
      draft: action.draft,
    }));
}

function buildNonRequestableActions(actions: TerminalBriefCloseoutGateAction[]): TerminalBriefApprovalNonRequestableAction[] {
  return actions
    .filter((action) => action.status !== "proposed")
    .map((action) => ({
      action: action.action,
      status: action.status,
      requiresApproval: action.requiresApproval,
      executePermitted: false as const,
      target: action.target,
      reason: action.reason,
    }));
}

function blockersForDecision(
  decision: TerminalBriefApprovalRequestDecision,
  gate: TerminalBriefCloseoutGatePacket,
  requestedActions: TerminalBriefApprovalRequestedAction[],
): string[] {
  if (decision === "request_ready") return [];
  const blockers = [...gate.blockers];
  if (decision === "waiting") {
    blockers.push("closeout gate is still waiting for evidence; approval request draft is not ready");
  }
  if (decision === "blocked") {
    if (requestedActions.length === 0) {
      blockers.push("no proposed closeout gate actions are requestable");
    }
    if (gate.gateState === "blocked") {
      blockers.push("closeout gate is blocked; recover gate blockers before requesting approval");
    }
  }
  return [...new Set(blockers)];
}

function titleForDecision(
  decision: TerminalBriefApprovalRequestDecision,
  gate: TerminalBriefCloseoutGatePacket,
): string {
  if (decision === "request_ready") return "Draft approval request: Terminal Brief closeout - " + (gate.parentRoundId ?? "unknown-round");
  if (decision === "waiting") return "Wait: Terminal Brief approval request - " + (gate.parentRoundId ?? "unknown-round");
  return "Blocked: Terminal Brief approval request - " + (gate.parentRoundId ?? "unknown-round");
}

function buildButtons(
  idempotencyKey: string,
  requestedActions: TerminalBriefApprovalRequestedAction[],
): TerminalBriefApprovalRequestPacket["request"]["presentationPlan"]["buttons"] {
  const approveButtons = requestedActions.map((action) => ({
    label: labelForAction(action.action),
    value: "approval-request:" + idempotencyKey + ":" + action.action,
    style: styleForAction(action.action),
    enabled: false as const,
    executePermitted: false as const,
  }));
  if (approveButtons.length === 0) return [];
  return [
    ...approveButtons,
    {
      label: "Hold / decline",
      value: "approval-request:" + idempotencyKey + ":hold",
      style: "secondary" as const,
      enabled: false as const,
      executePermitted: false as const,
    },
  ];
}

function labelForAction(action: TerminalBriefCloseoutGateAction["action"]): string {
  if (action === "post_closeout_comment") return "Approve comment draft";
  if (action === "merge_pull_request") return "Approve PR merge";
  if (action === "close_issue") return "Approve issue close";
  if (action === "create_taskflow_record") return "Approve TaskFlow record";
  return "Approve " + action;
}

function styleForAction(action: TerminalBriefCloseoutGateAction["action"]): "primary" | "secondary" | "danger" {
  if (action === "merge_pull_request" || action === "close_issue") return "danger";
  if (action === "create_taskflow_record") return "secondary";
  return "primary";
}

function nextActionsForDecision(decision: TerminalBriefApprovalRequestDecision): string[] {
  if (decision === "request_ready") {
    return [
      "broker finalizer reviews this draft approval request and requested action set",
      "choose an external harness adapter or operator channel in a separate approved executor path",
      "after explicit operator approval, run a separate executor for the exact approved action only",
    ];
  }
  if (decision === "waiting") {
    return [
      "wait for Terminal Brief evidence to satisfy the closeout gate",
      "rerun closeout gate and approval request planner after evidence changes",
    ];
  }
  return [
    "recover closeout gate blockers",
    "rerun closeout gate and approval request planner after blocker recovery",
  ];
}

function buildApprovalRequestIdempotencyKey(
  gate: TerminalBriefCloseoutGatePacket,
  decision: TerminalBriefApprovalRequestDecision,
  requestedActions: TerminalBriefApprovalRequestedAction[],
): string {
  const actionPart = requestedActions
    .map((action) => action.action + ":" + (action.target ?? ""))
    .sort()
    .join("|");
  const base = [
    "terminal-brief-approval-request",
    gate.parentRoundId ?? "unknown",
    gate.idempotencyKey,
    decision,
    actionPart,
  ].join(":");
  return "tb-approval-request:" + createHash("sha256").update(base).digest("hex").slice(0, 24);
}

function isTerminalBriefCloseoutGatePacket(value: unknown): value is TerminalBriefCloseoutGatePacket {
  return isRecord(value) && value.kind === "a2a-broker.terminal-brief-closeout-gate.packet";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
