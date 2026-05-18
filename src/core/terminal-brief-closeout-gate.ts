import { createHash } from "node:crypto";

import type { TerminalBriefFinalizerWorkflowPacket } from "./terminal-brief-finalizer-workflow.js";

export type TerminalBriefCloseoutGateDecision = "ready_for_approval" | "blocked" | "waiting";
export type TerminalBriefCloseoutGateState = "approval_required" | "blocked" | "waiting_for_evidence";
export type TerminalBriefCloseoutGateActionStatus = "proposed" | "blocked" | "forbidden";

export interface TerminalBriefCloseoutGateOptions {
  now?: string;
  mode?: string;
  issueUrl?: string;
  prUrl?: string;
}

export interface TerminalBriefCloseoutGateAction {
  action:
    | "post_closeout_comment"
    | "merge_pull_request"
    | "close_issue"
    | "create_taskflow_record"
    | "live_provider_send"
    | "terminal_ack_or_replay"
    | "runtime_restart_or_deploy"
    | "broker_db_mutation"
    | "historical_replay"
    | "release_or_publish"
    | "secret_or_credential_movement";
  status: TerminalBriefCloseoutGateActionStatus;
  requiresApproval: boolean;
  executePermitted: false;
  reason: string;
  target?: string;
  draft?: Record<string, unknown>;
}

export interface TerminalBriefCloseoutGateChecklistItem {
  check: string;
  status: "required" | "blocked" | "waiting" | "not_applicable";
  detail: string;
}

export interface TerminalBriefCloseoutGatePacket {
  kind: "a2a-broker.terminal-brief-closeout-gate.packet";
  version: 1;
  generatedAt: string;
  mode: string;
  parentRoundId?: string;
  decision: TerminalBriefCloseoutGateDecision;
  gateState: TerminalBriefCloseoutGateState;
  dryRunOnly: true;
  executePermitted: false;
  idempotencyKey: string;
  finalizer: TerminalBriefFinalizerWorkflowPacket["finalizer"];
  source: {
    workflowDecision: TerminalBriefFinalizerWorkflowPacket["decision"];
    workflowStep: TerminalBriefFinalizerWorkflowPacket["currentStep"];
    workflowIdempotencyKey: string;
    targetIssueUrl?: string;
    targetPrUrl?: string;
    blockers: number;
    reviewItems: number;
  };
  draftCloseout: {
    title: string;
    body: string;
    postPermitted: false;
    targetIssueUrl?: string;
    targetPrUrl?: string;
  };
  actions: TerminalBriefCloseoutGateAction[];
  approvalChecklist: TerminalBriefCloseoutGateChecklistItem[];
  blockers: string[];
  nextActions: string[];
  integrationContract: {
    transport: "json";
    harnessNeutral: true;
    openclawMessageSendRequired: false;
    hermesAdapterCompatible: true;
  };
  semantics: {
    closeoutGateIsNotFinalAction: true;
    dryRunOnly: true;
    routeIsReadOnly: true;
    brokerFinalizerRequired: true;
    singleFinalizerRequired: true;
    approvalRequiredBeforeGitHubMutation: true;
    approvalRequiredBeforeLiveAction: true;
    providerOrProducedReceiptIsTerminalAck: false;
    performsGitHubMutation: false;
    performsProviderSend: false;
    performsTerminalAck: false;
    performsRuntimeRestartOrDeploy: false;
    performsDbMutation: false;
    createsTaskFlowRecords: false;
    performsReleaseOrPublish: false;
    movesSecretsOrCredentials: false;
  };
}

export function buildTerminalBriefCloseoutGate(
  workflow: TerminalBriefFinalizerWorkflowPacket,
  options: TerminalBriefCloseoutGateOptions = {},
): TerminalBriefCloseoutGatePacket {
  const decision = gateDecisionForWorkflow(workflow);
  const gateState = gateStateForDecision(decision);
  const targetIssueUrl = options.issueUrl ?? workflow.workflow.closeoutComment.targetIssueUrl;
  const targetPrUrl = options.prUrl ?? workflow.workflow.closeoutComment.targetPrUrl;

  return {
    kind: "a2a-broker.terminal-brief-closeout-gate.packet",
    version: 1,
    generatedAt: options.now ?? new Date().toISOString(),
    mode: options.mode ?? workflow.mode,
    parentRoundId: workflow.parentRoundId,
    decision,
    gateState,
    dryRunOnly: true,
    executePermitted: false,
    idempotencyKey: buildGateIdempotencyKey(workflow, targetIssueUrl, targetPrUrl),
    finalizer: workflow.finalizer,
    source: {
      workflowDecision: workflow.decision,
      workflowStep: workflow.currentStep,
      workflowIdempotencyKey: workflow.idempotencyKey,
      targetIssueUrl,
      targetPrUrl,
      blockers: workflow.blockers.length,
      reviewItems: workflow.reviewItems.length,
    },
    draftCloseout: {
      title: workflow.workflow.closeoutComment.title,
      body: workflow.workflow.closeoutComment.body,
      postPermitted: false,
      targetIssueUrl,
      targetPrUrl,
    },
    actions: buildActions(decision, workflow, targetIssueUrl, targetPrUrl),
    approvalChecklist: buildApprovalChecklist(decision, workflow, targetIssueUrl, targetPrUrl),
    blockers: [...workflow.blockers],
    nextActions: nextActionsForGate(decision),
    integrationContract: {
      transport: "json",
      harnessNeutral: true,
      openclawMessageSendRequired: false,
      hermesAdapterCompatible: true,
    },
    semantics: {
      closeoutGateIsNotFinalAction: true,
      dryRunOnly: true,
      routeIsReadOnly: true,
      brokerFinalizerRequired: true,
      singleFinalizerRequired: true,
      approvalRequiredBeforeGitHubMutation: true,
      approvalRequiredBeforeLiveAction: true,
      providerOrProducedReceiptIsTerminalAck: false,
      performsGitHubMutation: false,
      performsProviderSend: false,
      performsTerminalAck: false,
      performsRuntimeRestartOrDeploy: false,
      performsDbMutation: false,
      createsTaskFlowRecords: false,
      performsReleaseOrPublish: false,
      movesSecretsOrCredentials: false,
    },
  };
}

export function extractTerminalBriefFinalizerWorkflowPacket(input: unknown): TerminalBriefFinalizerWorkflowPacket {
  const envelope = isRecord(input) ? input : {};
  const candidates = [
    input,
    envelope.workflowPacket,
    envelope.finalizerWorkflow,
    envelope.packet,
    envelope.workflow,
  ];
  const packet = candidates.find(isTerminalBriefFinalizerWorkflowPacket);
  if (!packet) {
    throw new Error("expected a Terminal Brief finalizer workflow packet");
  }
  return packet;
}

export function renderTerminalBriefCloseoutGateMarkdown(packet: TerminalBriefCloseoutGatePacket): string {
  const title = packet.decision === "ready_for_approval"
    ? "Ready for approval: terminal-brief closeout gate"
    : packet.decision === "waiting"
      ? "Wait: terminal-brief closeout gate"
      : "Block: terminal-brief closeout gate";

  return [
    title,
    "Mode: " + packet.mode,
    "Parent round: " + (packet.parentRoundId ?? "unknown"),
    "Decision: " + packet.decision + " gate=" + packet.gateState + " dryRunOnly=" + packet.dryRunOnly,
    "Execute permitted: " + packet.executePermitted + " idempotency=" + packet.idempotencyKey,
    "Finalizer: broker=" + packet.finalizer.brokerOfRecordId
      + " owner=" + packet.finalizer.owner
      + " singleFinalizerRequired=" + packet.finalizer.singleFinalizerRequired,
    "Source workflow: decision=" + packet.source.workflowDecision
      + " step=" + packet.source.workflowStep
      + " idempotency=" + packet.source.workflowIdempotencyKey
      + " blockers=" + packet.source.blockers
      + " reviewItems=" + packet.source.reviewItems,
    "Targets: issue=" + (packet.source.targetIssueUrl ?? "none") + " pr=" + (packet.source.targetPrUrl ?? "none"),
    "Harness: json transport; OpenClaw message send required=false; Hermes adapter compatible=true.",
    "",
    "Proposed actions:",
    ...packet.actions.map((action) => [
      "- " + action.action,
      "status=" + action.status,
      "approval=" + action.requiresApproval,
      "execute=" + action.executePermitted,
      "target=" + (action.target ?? "none"),
      "reason=" + action.reason,
    ].join(" | ")),
    "",
    "Approval checklist:",
    ...packet.approvalChecklist.map((item) => "- " + item.check + " | " + item.status + " | " + item.detail),
    ...(packet.blockers.length ? ["", "Blockers:", ...packet.blockers.map((blocker) => "- " + blocker)] : []),
    "",
    "Draft closeout comment:",
    "Title: " + packet.draftCloseout.title,
    packet.draftCloseout.body,
    "",
    "Next actions:",
    ...packet.nextActions.map((action) => "- " + action),
    "",
    "Safety: closeout gate only; dry-run only; no comment post, merge, issue close, live send, terminal ACK/replay, restart/deploy, DB mutation, TaskFlow record creation, release, or secret movement.",
  ].join("\n");
}

function gateDecisionForWorkflow(workflow: TerminalBriefFinalizerWorkflowPacket): TerminalBriefCloseoutGateDecision {
  if (workflow.decision === "ready") return "ready_for_approval";
  if (workflow.decision === "waiting") return "waiting";
  return "blocked";
}

function gateStateForDecision(decision: TerminalBriefCloseoutGateDecision): TerminalBriefCloseoutGateState {
  if (decision === "ready_for_approval") return "approval_required";
  if (decision === "waiting") return "waiting_for_evidence";
  return "blocked";
}

function buildActions(
  decision: TerminalBriefCloseoutGateDecision,
  workflow: TerminalBriefFinalizerWorkflowPacket,
  targetIssueUrl?: string,
  targetPrUrl?: string,
): TerminalBriefCloseoutGateAction[] {
  const enabled = decision === "ready_for_approval";
  return [
    {
      action: "post_closeout_comment",
      status: enabled && (targetIssueUrl || targetPrUrl) ? "proposed" : "blocked",
      requiresApproval: true,
      executePermitted: false,
      target: targetIssueUrl ?? targetPrUrl,
      reason: enabled
        ? "draft closeout comment is ready but posting is a separate approved mutation"
        : "closeout comment cannot be proposed until the workflow is ready",
      draft: {
        title: workflow.workflow.closeoutComment.title,
        body: workflow.workflow.closeoutComment.body,
      },
    },
    {
      action: "merge_pull_request",
      status: enabled && targetPrUrl ? "proposed" : "blocked",
      requiresApproval: true,
      executePermitted: false,
      target: targetPrUrl,
      reason: enabled && targetPrUrl
        ? "merge is only a proposed follow-up after finalizer approval"
        : "no merge action until workflow is ready and targetPrUrl is present",
    },
    {
      action: "close_issue",
      status: enabled && targetIssueUrl ? "proposed" : "blocked",
      requiresApproval: true,
      executePermitted: false,
      target: targetIssueUrl,
      reason: enabled && targetIssueUrl
        ? "issue close is only a proposed follow-up after finalizer approval"
        : "no issue close until workflow is ready and targetIssueUrl is present",
    },
    {
      action: "create_taskflow_record",
      status: enabled ? "proposed" : "blocked",
      requiresApproval: true,
      executePermitted: false,
      reason: enabled
        ? "workflow seed is available, but record creation is outside the source-only gate"
        : "TaskFlow record creation waits for ready workflow and separate approval",
      draft: workflow.workflow.taskflowSeed,
    },
    ...forbiddenActions(),
  ];
}

function forbiddenActions(): TerminalBriefCloseoutGateAction[] {
  return [
    ["live_provider_send", "live sends must stay outside the source-only gate"],
    ["terminal_ack_or_replay", "terminal ACK/replay requires a separate explicit operator approval path"],
    ["runtime_restart_or_deploy", "Gateway/broker/worker/sidecar restart or deploy is not part of closeout gate generation"],
    ["broker_db_mutation", "broker DB mutation/prune/migration is forbidden in this read-only gate"],
    ["historical_replay", "historical replay is forbidden in this read-only gate"],
    ["release_or_publish", "release/tag/npm publish is forbidden in this read-only gate"],
    ["secret_or_credential_movement", "secret or credential movement is forbidden in this read-only gate"],
  ].map(([action, reason]) => ({
    action: action as TerminalBriefCloseoutGateAction["action"],
    status: "forbidden",
    requiresApproval: true,
    executePermitted: false,
    reason,
  }));
}

function buildApprovalChecklist(
  decision: TerminalBriefCloseoutGateDecision,
  workflow: TerminalBriefFinalizerWorkflowPacket,
  targetIssueUrl?: string,
  targetPrUrl?: string,
): TerminalBriefCloseoutGateChecklistItem[] {
  if (decision === "waiting") {
    return [
      {
        check: "wait for terminal brief evidence",
        status: "waiting",
        detail: "finalizer workflow is waiting; do not prepare mutation approval yet",
      },
    ];
  }
  if (decision === "blocked") {
    return [
      {
        check: "recover blockers",
        status: "blocked",
        detail: workflow.blockers.length ? workflow.blockers.join("; ") : "workflow is blocked",
      },
    ];
  }
  return [
    {
      check: "single broker finalizer review",
      status: "required",
      detail: workflow.finalizer.owner + " must review evidence, receipt gaps, and draft closeout text",
    },
    {
      check: "GitHub mutation approval",
      status: "required",
      detail: "explicit approval is required before posting, merging, or closing " + [targetIssueUrl, targetPrUrl].filter(Boolean).join(" "),
    },
    {
      check: "live action approval",
      status: "required",
      detail: "separate approval is required for provider sends, terminal ACK/replay, restart/deploy, DB mutation, release, or secret movement",
    },
  ];
}

function nextActionsForGate(decision: TerminalBriefCloseoutGateDecision): string[] {
  if (decision === "ready_for_approval") {
    return [
      "broker finalizer reviews the gate packet and draft closeout comment",
      "request explicit approval for the exact GitHub mutation or TaskFlow record to execute",
      "run a separate execution path after approval; do not execute from this gate packet",
    ];
  }
  if (decision === "waiting") {
    return [
      "wait for final Terminal Brief worker evidence",
      "rerun finalizer workflow and closeout gate after evidence changes",
    ];
  }
  return [
    "resolve workflow blockers",
    "rerun finalizer workflow and closeout gate after blocker recovery",
  ];
}

function buildGateIdempotencyKey(
  workflow: TerminalBriefFinalizerWorkflowPacket,
  targetIssueUrl?: string,
  targetPrUrl?: string,
): string {
  const base = [
    "terminal-brief-closeout-gate",
    workflow.parentRoundId ?? "unknown",
    workflow.idempotencyKey,
    workflow.decision,
    targetIssueUrl ?? "",
    targetPrUrl ?? "",
  ].join(":");
  return "tb-closeout-gate:" + createHash("sha256").update(base).digest("hex").slice(0, 24);
}

function isTerminalBriefFinalizerWorkflowPacket(value: unknown): value is TerminalBriefFinalizerWorkflowPacket {
  return isRecord(value) && value.kind === "a2a-broker.terminal-brief-finalizer-workflow.packet";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
