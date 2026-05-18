import { createHash } from "node:crypto";

import {
  buildTerminalBriefSidecarIntegrationRehearsal,
  type TerminalBriefSidecarIntegrationInput,
  type TerminalBriefSidecarIntegrationRehearsal,
} from "./terminal-brief-sidecar-integration-rehearsal.js";
import type { TerminalBriefCompletionLane } from "./terminal-brief-completion-watcher.js";

export type TerminalBriefFinalizerHandoffDecision = "ready" | "blocked" | "waiting";
export type TerminalBriefFinalizerChecklistStatus = "pass" | "fail" | "review";

export interface TerminalBriefFinalizerHandoffOptions {
  now?: string;
  mode?: string;
  brokerOfRecordId?: string;
  finalizerOwner?: string;
}

export interface TerminalBriefFinalizerChecklistItem {
  check: string;
  status: TerminalBriefFinalizerChecklistStatus;
  detail: string;
}

export interface TerminalBriefFinalizerHandoffLane {
  worker: string;
  taskId?: string;
  status?: string;
  state: string;
  evidenceUrl?: string;
  receiptStatus?: string;
  receiptProof: string;
  nextAction: string;
}

export interface TerminalBriefFinalizerHandoffPacket {
  kind: "a2a-broker.terminal-brief-finalizer-handoff.packet";
  version: 1;
  generatedAt: string;
  mode: string;
  parentRoundId?: string;
  decision: TerminalBriefFinalizerHandoffDecision;
  idempotencyKey: string;
  finalizer: {
    brokerOfRecordId: string;
    owner: string;
    required: true;
    singleFinalizerRequired: true;
  };
  source: {
    integrationDecision: string;
    finalCountDecision: string;
    completionDecision: string;
    finalCount?: {
      progress: number;
      total: number;
      source: string;
    };
    sidecarDryRunOnly: boolean;
    sidecarProviderSendAttempted: boolean;
    sidecarTerminalAckAttempted: boolean;
  };
  summary: {
    expectedWorkers: number;
    readyWorkers: number;
    evidenceUrls: number;
    receiptGaps: number;
    blockers: number;
    missingWorkers: number;
  };
  lanes: TerminalBriefFinalizerHandoffLane[];
  evidenceUrls: string[];
  receiptGaps: string[];
  blockers: string[];
  checklist: TerminalBriefFinalizerChecklistItem[];
  closeoutDraft: {
    title: string;
    body: string;
  };
  nextActions: string[];
  approvalSensitiveActionsExcluded: string[];
  semantics: {
    handoffPacketIsNotFinalAction: true;
    brokerFinalizerRequired: true;
    singleFinalizerRequired: true;
    finalCountIsCloseoutTriggerOnly: true;
    sidecarSpoolIsReceiptProof: false;
    sidecarProducedReceiptIsTerminalAck: false;
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

export function buildTerminalBriefFinalizerHandoffFromInput(
  input: TerminalBriefSidecarIntegrationInput,
  options: TerminalBriefFinalizerHandoffOptions = {},
): TerminalBriefFinalizerHandoffPacket {
  return buildTerminalBriefFinalizerHandoff(
    buildTerminalBriefSidecarIntegrationRehearsal(input, options),
    options,
  );
}

export function buildTerminalBriefFinalizerHandoff(
  rehearsal: TerminalBriefSidecarIntegrationRehearsal,
  options: TerminalBriefFinalizerHandoffOptions = {},
): TerminalBriefFinalizerHandoffPacket {
  const finalCount = rehearsal.finalCountCandidate;
  const completion = finalCount.completion;
  const evidenceUrls = completion.closeoutCandidate.evidenceUrls;
  const receiptGaps = completion.receiptGaps;
  const blockers = [...rehearsal.blockers];
  const decision = decide(rehearsal);
  const checklist = buildChecklist(rehearsal);
  const brokerOfRecordId = options.brokerOfRecordId ?? "broker-of-record";
  const finalizerOwner = options.finalizerOwner ?? brokerOfRecordId;
  const nextActions = nextActionsForDecision(decision);
  const title = closeoutDraftTitle(decision, rehearsal.parentRoundId);
  const body = closeoutDraftBody(rehearsal, decision, checklist, evidenceUrls, receiptGaps, blockers);

  return {
    kind: "a2a-broker.terminal-brief-finalizer-handoff.packet",
    version: 1,
    generatedAt: options.now ?? new Date().toISOString(),
    mode: options.mode ?? rehearsal.mode,
    parentRoundId: rehearsal.parentRoundId,
    decision,
    idempotencyKey: buildIdempotencyKey(rehearsal),
    finalizer: {
      brokerOfRecordId,
      owner: finalizerOwner,
      required: true,
      singleFinalizerRequired: true,
    },
    source: {
      integrationDecision: rehearsal.decision,
      finalCountDecision: finalCount.decision,
      completionDecision: completion.decision,
      finalCount: finalCount.trigger
        ? {
          progress: finalCount.trigger.progress,
          total: finalCount.trigger.total,
          source: finalCount.trigger.source,
        }
        : undefined,
      sidecarDryRunOnly: rehearsal.sidecar.dryRunOnly,
      sidecarProviderSendAttempted: rehearsal.sidecar.providerSendAttempted,
      sidecarTerminalAckAttempted: rehearsal.sidecar.terminalAckAttempted,
    },
    summary: {
      expectedWorkers: completion.summary.expectedTotal,
      readyWorkers: completion.summary.ready,
      evidenceUrls: evidenceUrls.length,
      receiptGaps: receiptGaps.length,
      blockers: blockers.length,
      missingWorkers: finalCount.missingWorkers.length,
    },
    lanes: completion.lanes.map(toHandoffLane),
    evidenceUrls,
    receiptGaps,
    blockers,
    checklist,
    closeoutDraft: {
      title,
      body,
    },
    nextActions,
    approvalSensitiveActionsExcluded: APPROVAL_SENSITIVE_ACTIONS_EXCLUDED,
    semantics: {
      handoffPacketIsNotFinalAction: true,
      brokerFinalizerRequired: true,
      singleFinalizerRequired: true,
      finalCountIsCloseoutTriggerOnly: true,
      sidecarSpoolIsReceiptProof: false,
      sidecarProducedReceiptIsTerminalAck: false,
      performsGitHubMutation: false,
      performsProviderSend: false,
      performsTerminalAck: false,
      performsRuntimeRestartOrDeploy: false,
      performsDbMutation: false,
    },
  };
}

export function renderTerminalBriefFinalizerHandoffMarkdown(packet: TerminalBriefFinalizerHandoffPacket): string {
  const title = packet.decision === "ready"
    ? "Ready: terminal-brief finalizer handoff"
    : packet.decision === "blocked"
      ? "Block: terminal-brief finalizer handoff"
      : "Wait: terminal-brief finalizer handoff";

  return [
    title,
    "Mode: " + packet.mode,
    "Parent round: " + (packet.parentRoundId ?? "unknown"),
    "Finalizer: broker=" + packet.finalizer.brokerOfRecordId
      + " owner=" + packet.finalizer.owner
      + " singleFinalizerRequired=" + packet.finalizer.singleFinalizerRequired,
    "Decision: " + packet.decision + " idempotency=" + packet.idempotencyKey,
    "Source: integration=" + packet.source.integrationDecision
      + " finalCount=" + packet.source.finalCountDecision
      + " completion=" + packet.source.completionDecision,
    "Workers: expected=" + packet.summary.expectedWorkers
      + " ready=" + packet.summary.readyWorkers
      + " missing=" + packet.summary.missingWorkers
      + " evidenceUrls=" + packet.summary.evidenceUrls
      + " receiptGaps=" + packet.summary.receiptGaps
      + " blockers=" + packet.summary.blockers,
    "Sidecar safety: dryRunOnly=" + packet.source.sidecarDryRunOnly
      + " providerSendAttempted=" + packet.source.sidecarProviderSendAttempted
      + " terminalAckAttempted=" + packet.source.sidecarTerminalAckAttempted,
    "",
    "Checklist:",
    ...packet.checklist.map((item) => "- " + item.status.toUpperCase() + " " + item.check + ": " + item.detail),
    "",
    "Lanes:",
    ...packet.lanes.map((lane) => "- " + lane.worker
      + " | " + (lane.status ?? "missing")
      + " | " + lane.state
      + " | " + (lane.evidenceUrl ?? "missing-evidence")
      + " | receipt=" + (lane.receiptStatus ?? "missing")
      + " | next: " + lane.nextAction),
    ...(packet.receiptGaps.length ? ["", "Receipt gaps:", ...packet.receiptGaps.map((gap) => "- " + gap)] : []),
    ...(packet.blockers.length ? ["", "Blockers:", ...packet.blockers.map((blocker) => "- " + blocker)] : []),
    "",
    "Closeout draft:",
    "Title: " + packet.closeoutDraft.title,
    packet.closeoutDraft.body,
    "",
    "Next actions:",
    ...packet.nextActions.map((action) => "- " + action),
    "",
    "Safety: handoff packet only; no merge, issue close, comment post, live send, terminal ACK/replay, restart/deploy, DB mutation, release, or secret movement.",
  ].join("\n");
}

function decide(rehearsal: TerminalBriefSidecarIntegrationRehearsal): TerminalBriefFinalizerHandoffDecision {
  if (rehearsal.decision === "candidate") return "ready";
  if (rehearsal.decision === "waiting") return "waiting";
  return "blocked";
}

function buildChecklist(rehearsal: TerminalBriefSidecarIntegrationRehearsal): TerminalBriefFinalizerChecklistItem[] {
  const finalCount = rehearsal.finalCountCandidate;
  const completion = finalCount.completion;
  const trigger = finalCount.trigger;
  return [
    {
      check: "final-count reached",
      status: trigger && trigger.progress === trigger.total ? "pass" : "fail",
      detail: trigger ? trigger.progress + "/" + trigger.total + " from " + trigger.source : "missing final-count signal",
    },
    {
      check: "completion watcher ready",
      status: completion.decision === "ready_for_finalizer" ? "pass" : "fail",
      detail: completion.decision + " / " + completion.closeoutCandidate.reason,
    },
    {
      check: "sidecar dry-run only",
      status: rehearsal.sidecar.dryRunOnly ? "pass" : "fail",
      detail: "spoolRecords=" + rehearsal.sidecar.spoolRecords + " unsafe=" + rehearsal.sidecar.unsafeSpoolRecords.length,
    },
    {
      check: "no provider send attempted",
      status: rehearsal.sidecar.providerSendAttempted ? "fail" : "pass",
      detail: String(rehearsal.sidecar.providerSendAttempted),
    },
    {
      check: "no terminal ACK attempted",
      status: rehearsal.sidecar.terminalAckAttempted ? "fail" : "pass",
      detail: String(rehearsal.sidecar.terminalAckAttempted),
    },
    {
      check: "receipt gaps acknowledged",
      status: completion.receiptGaps.length ? "review" : "pass",
      detail: completion.receiptGaps.length + " provider-only/missing receipt gap(s)",
    },
    {
      check: "worker evidence present",
      status: completion.closeoutCandidate.evidenceUrls.length >= completion.summary.expectedTotal ? "pass" : "review",
      detail: completion.closeoutCandidate.evidenceUrls.length + "/" + completion.summary.expectedTotal + " evidence URL(s)",
    },
    {
      check: "broker finalizer required",
      status: "review",
      detail: "single broker finalizer must decide any GitHub closeout or live action separately",
    },
  ];
}

function toHandoffLane(lane: TerminalBriefCompletionLane): TerminalBriefFinalizerHandoffLane {
  return {
    worker: lane.worker,
    taskId: lane.taskId,
    status: lane.status,
    state: lane.state,
    evidenceUrl: lane.evidenceUrl,
    receiptStatus: lane.receiptStatus,
    receiptProof: lane.receiptProof,
    nextAction: lane.nextAction,
  };
}

function closeoutDraftTitle(decision: TerminalBriefFinalizerHandoffDecision, parentRoundId?: string): string {
  const round = parentRoundId ?? "unknown-round";
  if (decision === "ready") return "Terminal Brief closeout ready for broker finalizer: " + round;
  if (decision === "waiting") return "Terminal Brief closeout waiting for more evidence: " + round;
  return "Terminal Brief closeout blocked: " + round;
}

function closeoutDraftBody(
  rehearsal: TerminalBriefSidecarIntegrationRehearsal,
  decision: TerminalBriefFinalizerHandoffDecision,
  checklist: TerminalBriefFinalizerChecklistItem[],
  evidenceUrls: string[],
  receiptGaps: string[],
  blockers: string[],
): string {
  const finalCount = rehearsal.finalCountCandidate.trigger
    ? rehearsal.finalCountCandidate.trigger.progress + "/" + rehearsal.finalCountCandidate.trigger.total
    : "missing";
  return [
    "Broker finalizer handoff is " + decision + ".",
    "",
    "Evidence summary:",
    "- parentRoundId: " + (rehearsal.parentRoundId ?? "unknown"),
    "- finalCount: " + finalCount,
    "- completionWatcher: " + rehearsal.finalCountCandidate.completion.decision,
    "- sidecarDryRunOnly: " + rehearsal.sidecar.dryRunOnly,
    "- evidenceUrls: " + evidenceUrls.length,
    "- receiptGaps: " + receiptGaps.length,
    "- blockers: " + blockers.length,
    "",
    "Checklist:",
    ...checklist.map((item) => "- [" + item.status + "] " + item.check + " — " + item.detail),
    "",
    "Evidence URLs:",
    ...(evidenceUrls.length ? evidenceUrls.map((url) => "- " + url) : ["- missing"]),
    ...(receiptGaps.length ? ["", "Receipt gaps:", ...receiptGaps.map((gap) => "- " + gap)] : []),
    ...(blockers.length ? ["", "Blockers:", ...blockers.map((blocker) => "- " + blocker)] : []),
    "",
    "Safety: this draft is not a merge/close/comment instruction. Provider-only or produced receipt state is not terminal ACK, read receipt, or visibility proof.",
  ].join("\n");
}

function nextActionsForDecision(decision: TerminalBriefFinalizerHandoffDecision): string[] {
  if (decision === "ready") {
    return [
      "broker finalizer reviews the handoff packet and evidence URLs",
      "prepare any GitHub closeout comment/merge/issue-close as a separate explicit finalizer action",
      "request separate approval before live send, terminal ACK/replay, restart/deploy, DB mutation, release, or secret movement",
    ];
  }
  if (decision === "waiting") {
    return [
      "wait for final Terminal Brief evidence and rerun the handoff packet",
      "do not close out until final count and completion watcher agree",
    ];
  }
  return [
    "resolve blockers before broker finalizer review",
    "rerun the no-live handoff packet after blocker evidence changes",
  ];
}

function buildIdempotencyKey(rehearsal: TerminalBriefSidecarIntegrationRehearsal): string {
  const base = [
    "terminal-brief-finalizer-handoff",
    rehearsal.parentRoundId ?? "unknown",
    rehearsal.finalCountCandidate.idempotencyKey,
    rehearsal.decision,
  ].join(":");
  return "tb-finalizer-handoff:" + createHash("sha256").update(base).digest("hex").slice(0, 24);
}
