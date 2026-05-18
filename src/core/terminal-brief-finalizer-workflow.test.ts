import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTerminalBriefFinalizerWorkflow,
  renderTerminalBriefFinalizerWorkflowMarkdown,
} from "./terminal-brief-finalizer-workflow.js";
import type { TerminalBriefFinalizerHandoffPacket } from "./terminal-brief-finalizer-handoff.js";

const NOW = "2026-05-18T12:00:00.000Z";

function handoff(overrides: Partial<TerminalBriefFinalizerHandoffPacket> = {}): TerminalBriefFinalizerHandoffPacket {
  const base: TerminalBriefFinalizerHandoffPacket = {
    kind: "a2a-broker.terminal-brief-finalizer-handoff.packet",
    version: 1,
    generatedAt: NOW,
    mode: "read-only/no-live",
    parentRoundId: "round-698",
    decision: "ready",
    idempotencyKey: "tb-finalizer-handoff:ready",
    finalizer: {
      brokerOfRecordId: "seoseo",
      owner: "seoseo",
      required: true,
      singleFinalizerRequired: true,
    },
    source: {
      integrationDecision: "candidate",
      finalCountDecision: "candidate",
      completionDecision: "ready_for_finalizer",
      finalCount: {
        progress: 3,
        total: 3,
        source: "envelope",
      },
      sidecarDryRunOnly: true,
      sidecarProviderSendAttempted: false,
      sidecarTerminalAckAttempted: false,
    },
    summary: {
      expectedWorkers: 3,
      readyWorkers: 3,
      evidenceUrls: 3,
      receiptGaps: 3,
      blockers: 0,
      missingWorkers: 0,
    },
    lanes: [
      {
        worker: "bangtong",
        taskId: "task-bangtong",
        status: "succeeded",
        state: "ready",
        evidenceUrl: "https://github.com/jinwon-int/a2a-broker/pull/701",
        receiptStatus: "produced",
        receiptProof: "provider_only_not_ack",
        nextAction: "include lane in broker finalizer closeout candidate",
      },
      {
        worker: "sogyo",
        taskId: "task-sogyo",
        status: "succeeded",
        state: "ready",
        evidenceUrl: "https://github.com/jinwon-int/a2a-broker/issues/698#issuecomment-sogyo-done",
        receiptStatus: "produced",
        receiptProof: "provider_only_not_ack",
        nextAction: "include lane in broker finalizer closeout candidate",
      },
      {
        worker: "nosuk",
        taskId: "task-nosuk",
        status: "succeeded",
        state: "ready",
        evidenceUrl: "https://github.com/jinwon-int/a2a-broker/pull/702",
        receiptStatus: "produced",
        receiptProof: "provider_only_not_ack",
        nextAction: "include lane in broker finalizer closeout candidate",
      },
    ],
    evidenceUrls: [
      "https://github.com/jinwon-int/a2a-broker/pull/701",
      "https://github.com/jinwon-int/a2a-broker/issues/698#issuecomment-sogyo-done",
      "https://github.com/jinwon-int/a2a-broker/pull/702",
    ],
    receiptGaps: [
      "bangtong: receipt=produced is not terminal ACK/read/visibility proof",
      "sogyo: receipt=produced is not terminal ACK/read/visibility proof",
      "nosuk: receipt=produced is not terminal ACK/read/visibility proof",
    ],
    blockers: [],
    checklist: [
      { check: "final-count reached", status: "pass", detail: "3/3 from envelope" },
      { check: "receipt gaps acknowledged", status: "review", detail: "3 provider-only/missing receipt gap(s)" },
      { check: "broker finalizer required", status: "review", detail: "single broker finalizer must decide separately" },
    ],
    closeoutDraft: {
      title: "Terminal Brief closeout ready for broker finalizer: round-698",
      body: "Broker finalizer handoff is ready.\n\nSafety: this draft is not a merge/close/comment instruction.",
    },
    nextActions: [
      "broker finalizer reviews the handoff packet and evidence URLs",
    ],
    approvalSensitiveActionsExcluded: [
      "GitHub PR merge, issue close, or comment post",
      "live provider/Hermes/Telegram/OpenClaw send",
      "terminal ACK/replay",
    ],
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
  return { ...base, ...overrides };
}

test("buildTerminalBriefFinalizerWorkflow emits ready draft-only workflow packet", () => {
  const packet = buildTerminalBriefFinalizerWorkflow(handoff(), {
    now: NOW,
    issueUrl: "https://github.com/jinwon-int/a2a-broker/issues/698",
  });

  assert.equal(packet.decision, "ready");
  assert.equal(packet.currentStep, "finalizer_review");
  assert.equal(packet.workflow.closeoutComment.mode, "draft-only");
  assert.equal(packet.workflow.closeoutComment.postPermitted, false);
  assert.equal(packet.workflow.taskflowSeed.createRecords, false);
  assert.equal(packet.workflow.taskflowSeed.waitJson.kind, "broker_finalizer_review");
  assert.equal(packet.semantics.workflowPacketIsNotFinalAction, true);
  assert.equal(packet.semantics.performsGitHubMutation, false);
  assert.match(packet.idempotencyKey, /^tb-finalizer-workflow:/);
  assert.match(packet.workflow.closeoutComment.body, /This draft was not posted automatically/);
});

test("workflow blocks when handoff is blocked", () => {
  const packet = buildTerminalBriefFinalizerWorkflow(handoff({
    decision: "blocked",
    blockers: ["sidecar fixture attempted provider send"],
    summary: {
      expectedWorkers: 3,
      readyWorkers: 3,
      evidenceUrls: 3,
      receiptGaps: 3,
      blockers: 1,
      missingWorkers: 0,
    },
  }), { now: NOW });

  assert.equal(packet.decision, "blocked");
  assert.equal(packet.currentStep, "recover_blockers");
  assert.equal(packet.workflow.taskflowSeed.waitJson.kind, "blocker_resolution");
  assert.match(packet.blockers.join("\n"), /provider send/);
});

test("workflow waits when handoff is waiting", () => {
  const packet = buildTerminalBriefFinalizerWorkflow(handoff({
    decision: "waiting",
    idempotencyKey: "tb-finalizer-handoff:waiting",
  }), { now: NOW });

  assert.equal(packet.decision, "waiting");
  assert.equal(packet.currentStep, "wait_for_evidence");
  assert.equal(packet.workflow.taskflowSeed.waitJson.kind, "terminal_brief_evidence");
  assert.deepEqual(packet.nextActions, [
    "wait for final Terminal Brief evidence",
    "rerun handoff and workflow packet after evidence changes",
  ]);
});

test("renderTerminalBriefFinalizerWorkflowMarkdown states draft-only and safety boundaries", () => {
  const packet = buildTerminalBriefFinalizerWorkflow(handoff(), { now: NOW });
  const markdown = renderTerminalBriefFinalizerWorkflowMarkdown(packet);

  assert.match(markdown, /^Ready: terminal-brief finalizer workflow/);
  assert.match(markdown, /TaskFlow seed: createRecords=false/);
  assert.match(markdown, /Closeout comment: draft-only postPermitted=false/);
  assert.match(markdown, /workflow packet only; closeout comment is draft-only/);
  assert.doesNotMatch(markdown, /ghp_|BROKER_EDGE_SECRET=|\/root\/\.openclaw/);
});
