import { createHash } from "node:crypto";

import {
  buildTerminalBriefFinalizerHandoff,
  type TerminalBriefFinalizerChecklistItem,
  type TerminalBriefFinalizerHandoffPacket,
  type TerminalBriefFinalizerHandoffOptions,
} from "./terminal-brief-finalizer-handoff.js";
import {
  buildTerminalBriefSidecarIntegrationRehearsal,
  type TerminalBriefSidecarIntegrationInput,
} from "./terminal-brief-sidecar-integration-rehearsal.js";

export type TerminalBriefFinalizerWorkflowDecision = "ready" | "blocked" | "waiting";
export type TerminalBriefFinalizerWorkflowStep = "finalizer_review" | "recover_blockers" | "wait_for_evidence";

export interface TerminalBriefFinalizerWorkflowOptions extends TerminalBriefFinalizerHandoffOptions {
  issueUrl?: string;
  prUrl?: string;
}

export interface TerminalBriefFinalizerWorkflowPacket {
  kind: "a2a-broker.terminal-brief-finalizer-workflow.packet";
  version: 1;
  generatedAt: string;
  mode: string;
  parentRoundId?: string;
  decision: TerminalBriefFinalizerWorkflowDecision;
  currentStep: TerminalBriefFinalizerWorkflowStep;
  idempotencyKey: string;
  finalizer: TerminalBriefFinalizerHandoffPacket["finalizer"];
  source: {
    handoffDecision: TerminalBriefFinalizerHandoffPacket["decision"];
    handoffIdempotencyKey: string;
    evidenceUrls: number;
    receiptGaps: number;
    blockers: number;
  };
  workflow: {
    closeoutComment: {
      mode: "draft-only";
      title: string;
      body: string;
      targetIssueUrl?: string;
      targetPrUrl?: string;
      postPermitted: false;
    };
    taskflowSeed: {
      createRecords: false;
      currentStep: TerminalBriefFinalizerWorkflowStep;
      stateJson: Record<string, unknown>;
      waitJson: Record<string, unknown>;
    };
  };
  checklist: TerminalBriefFinalizerChecklistItem[];
  reviewItems: string[];
  blockers: string[];
  nextActions: string[];
  approvalSensitiveActionsExcluded: string[];
  semantics: {
    workflowPacketIsNotFinalAction: true;
    commentIsDraftOnly: true;
    taskflowSeedCreatesNoRecords: true;
    brokerFinalizerRequired: true;
    singleFinalizerRequired: true;
    providerOrProducedReceiptIsTerminalAck: false;
    performsGitHubMutation: false;
    performsProviderSend: false;
    performsTerminalAck: false;
    performsRuntimeRestartOrDeploy: false;
    performsDbMutation: false;
  };
}

const APPROVAL_SENSITIVE_ACTIONS_EXCLUDED = [
  "GitHub PR merge, issue close, or comment post",
  "live provider/Hermes/Telegram/OpenClaw send",
  "terminal ACK/replay",
  "Gateway/broker/worker/sidecar restart or deploy",
  "broker DB mutation/prune/migration",
  "historical replay",
  "release/tag/npm publish",
  "secret or credential movement",
];

export function buildTerminalBriefFinalizerWorkflowFromInput(
  input: TerminalBriefSidecarIntegrationInput,
  options: TerminalBriefFinalizerWorkflowOptions = {},
): TerminalBriefFinalizerWorkflowPacket {
  const rehearsal = buildTerminalBriefSidecarIntegrationRehearsal(input, options);
  return buildTerminalBriefFinalizerWorkflow(
    buildTerminalBriefFinalizerHandoff(rehearsal, options),
    options,
  );
}

export function buildTerminalBriefFinalizerWorkflow(
  handoff: TerminalBriefFinalizerHandoffPacket,
  options: TerminalBriefFinalizerWorkflowOptions = {},
): TerminalBriefFinalizerWorkflowPacket {
  const decision = handoff.decision;
  const currentStep = stepForDecision(decision);
  const reviewItems = buildReviewItems(handoff);
  const blockers = [...handoff.blockers];
  const title = closeoutCommentTitle(handoff);
  const body = closeoutCommentBody(handoff);

  return {
    kind: "a2a-broker.terminal-brief-finalizer-workflow.packet",
    version: 1,
    generatedAt: options.now ?? new Date().toISOString(),
    mode: options.mode ?? handoff.mode,
    parentRoundId: handoff.parentRoundId,
    decision,
    currentStep,
    idempotencyKey: buildWorkflowIdempotencyKey(handoff),
    finalizer: handoff.finalizer,
    source: {
      handoffDecision: handoff.decision,
      handoffIdempotencyKey: handoff.idempotencyKey,
      evidenceUrls: handoff.evidenceUrls.length,
      receiptGaps: handoff.receiptGaps.length,
      blockers: handoff.blockers.length,
    },
    workflow: {
      closeoutComment: {
        mode: "draft-only",
        title,
        body,
        targetIssueUrl: options.issueUrl,
        targetPrUrl: options.prUrl,
        postPermitted: false,
      },
      taskflowSeed: {
        createRecords: false,
        currentStep,
        stateJson: taskflowState(handoff, decision),
        waitJson: taskflowWait(handoff, decision),
      },
    },
    checklist: handoff.checklist,
    reviewItems,
    blockers,
    nextActions: nextActionsForWorkflow(handoff),
    approvalSensitiveActionsExcluded: APPROVAL_SENSITIVE_ACTIONS_EXCLUDED,
    semantics: {
      workflowPacketIsNotFinalAction: true,
      commentIsDraftOnly: true,
      taskflowSeedCreatesNoRecords: true,
      brokerFinalizerRequired: true,
      singleFinalizerRequired: true,
      providerOrProducedReceiptIsTerminalAck: false,
      performsGitHubMutation: false,
      performsProviderSend: false,
      performsTerminalAck: false,
      performsRuntimeRestartOrDeploy: false,
      performsDbMutation: false,
    },
  };
}

export function renderTerminalBriefFinalizerWorkflowMarkdown(packet: TerminalBriefFinalizerWorkflowPacket): string {
  const title = packet.decision === "ready"
    ? "Ready: terminal-brief finalizer workflow"
    : packet.decision === "blocked"
      ? "Block: terminal-brief finalizer workflow"
      : "Wait: terminal-brief finalizer workflow";

  return [
    title,
    "Mode: " + packet.mode,
    "Parent round: " + (packet.parentRoundId ?? "unknown"),
    "Finalizer: broker=" + packet.finalizer.brokerOfRecordId
      + " owner=" + packet.finalizer.owner
      + " singleFinalizerRequired=" + packet.finalizer.singleFinalizerRequired,
    "Decision: " + packet.decision + " step=" + packet.currentStep + " idempotency=" + packet.idempotencyKey,
    "Source: handoff=" + packet.source.handoffDecision
      + " handoffIdempotency=" + packet.source.handoffIdempotencyKey
      + " evidenceUrls=" + packet.source.evidenceUrls
      + " receiptGaps=" + packet.source.receiptGaps
      + " blockers=" + packet.source.blockers,
    "TaskFlow seed: createRecords=" + packet.workflow.taskflowSeed.createRecords
      + " currentStep=" + packet.workflow.taskflowSeed.currentStep,
    "Closeout comment: " + packet.workflow.closeoutComment.mode + " postPermitted=" + packet.workflow.closeoutComment.postPermitted,
    "Title: " + packet.workflow.closeoutComment.title,
    "",
    "Review items:",
    ...(packet.reviewItems.length ? packet.reviewItems.map((item) => "- " + item) : ["- none"]),
    ...(packet.blockers.length ? ["", "Blockers:", ...packet.blockers.map((blocker) => "- " + blocker)] : []),
    "",
    "Draft comment body:",
    packet.workflow.closeoutComment.body,
    "",
    "Next actions:",
    ...packet.nextActions.map((action) => "- " + action),
    "",
    "Safety: workflow packet only; closeout comment is draft-only; TaskFlow seed creates no records; no merge, issue close, comment post, live send, terminal ACK/replay, restart/deploy, DB mutation, release, or secret movement.",
  ].join("\n");
}

function stepForDecision(decision: TerminalBriefFinalizerWorkflowDecision): TerminalBriefFinalizerWorkflowStep {
  if (decision === "ready") return "finalizer_review";
  if (decision === "waiting") return "wait_for_evidence";
  return "recover_blockers";
}

function buildReviewItems(handoff: TerminalBriefFinalizerHandoffPacket): string[] {
  const items: string[] = [];
  if (handoff.receiptGaps.length > 0) {
    items.push(handoff.receiptGaps.length + " receipt gap(s) are non-ACK/non-read/non-visibility evidence");
  }
  if (handoff.checklist.some((item) => item.status === "review")) {
    items.push("checklist contains finalizer review item(s)");
  }
  if (handoff.decision === "ready") {
    items.push("single broker finalizer must decide whether to use the draft closeout text");
  }
  return items;
}

function closeoutCommentTitle(handoff: TerminalBriefFinalizerHandoffPacket): string {
  if (handoff.decision === "ready") return "Draft: Terminal Brief closeout ready - " + (handoff.parentRoundId ?? "unknown-round");
  if (handoff.decision === "waiting") return "Draft: Terminal Brief closeout waiting - " + (handoff.parentRoundId ?? "unknown-round");
  return "Draft: Terminal Brief closeout blocked - " + (handoff.parentRoundId ?? "unknown-round");
}

function closeoutCommentBody(handoff: TerminalBriefFinalizerHandoffPacket): string {
  return [
    "Draft-only broker finalizer workflow packet.",
    "",
    handoff.closeoutDraft.body,
    "",
    "Workflow decision: " + handoff.decision,
    "Handoff idempotency: " + handoff.idempotencyKey,
    "Finalizer owner: " + handoff.finalizer.owner,
    "",
    "This draft was not posted automatically. A single broker finalizer must review before any GitHub mutation or live operational action.",
  ].join("\n");
}

function taskflowState(
  handoff: TerminalBriefFinalizerHandoffPacket,
  decision: TerminalBriefFinalizerWorkflowDecision,
): Record<string, unknown> {
  return {
    source: "terminal-brief-finalizer-workflow",
    decision,
    parentRoundId: handoff.parentRoundId,
    handoffIdempotencyKey: handoff.idempotencyKey,
    finalizerOwner: handoff.finalizer.owner,
    brokerOfRecordId: handoff.finalizer.brokerOfRecordId,
    evidenceUrls: handoff.evidenceUrls,
    receiptGaps: handoff.receiptGaps,
    blockers: handoff.blockers,
  };
}

function taskflowWait(
  handoff: TerminalBriefFinalizerHandoffPacket,
  decision: TerminalBriefFinalizerWorkflowDecision,
): Record<string, unknown> {
  if (decision === "ready") {
    return {
      kind: "broker_finalizer_review",
      finalizerOwner: handoff.finalizer.owner,
      approvalRequiredForMutation: true,
      approvalRequiredForLiveAction: true,
    };
  }
  if (decision === "waiting") {
    return {
      kind: "terminal_brief_evidence",
      reason: "wait for final Terminal Brief evidence before finalizer review",
    };
  }
  return {
    kind: "blocker_resolution",
    blockers: handoff.blockers,
  };
}

function nextActionsForWorkflow(handoff: TerminalBriefFinalizerHandoffPacket): string[] {
  if (handoff.decision === "ready") {
    return [
      "single broker finalizer reviews draft comment, checklist, evidence URLs, and receipt gaps",
      "post closeout comment, merge, or close issue only as a separate explicit finalizer action",
      "request separate approval before any live send, ACK/replay, restart/deploy, DB mutation, release, or secret movement",
    ];
  }
  if (handoff.decision === "waiting") {
    return [
      "wait for final Terminal Brief evidence",
      "rerun handoff and workflow packet after evidence changes",
    ];
  }
  return [
    "resolve blockers before broker finalizer review",
    "rerun handoff and workflow packet after blocker recovery",
  ];
}

function buildWorkflowIdempotencyKey(handoff: TerminalBriefFinalizerHandoffPacket): string {
  const base = [
    "terminal-brief-finalizer-workflow",
    handoff.parentRoundId ?? "unknown",
    handoff.idempotencyKey,
    handoff.decision,
  ].join(":");
  return "tb-finalizer-workflow:" + createHash("sha256").update(base).digest("hex").slice(0, 24);
}
