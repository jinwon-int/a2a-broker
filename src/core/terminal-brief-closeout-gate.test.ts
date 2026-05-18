import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTerminalBriefCloseoutGate,
  extractTerminalBriefFinalizerWorkflowPacket,
  renderTerminalBriefCloseoutGateMarkdown,
} from "./terminal-brief-closeout-gate.js";
import type { TerminalBriefFinalizerWorkflowPacket } from "./terminal-brief-finalizer-workflow.js";

const NOW = "2026-05-18T15:00:00.000Z";

function workflow(overrides: Partial<TerminalBriefFinalizerWorkflowPacket> = {}): TerminalBriefFinalizerWorkflowPacket {
  const base: TerminalBriefFinalizerWorkflowPacket = {
    kind: "a2a-broker.terminal-brief-finalizer-workflow.packet",
    version: 1,
    generatedAt: NOW,
    mode: "read-only/no-live",
    parentRoundId: "round-700",
    decision: "ready",
    currentStep: "finalizer_review",
    idempotencyKey: "tb-finalizer-workflow:fixture",
    finalizer: {
      brokerOfRecordId: "seoseo",
      owner: "seoseo",
      required: true,
      singleFinalizerRequired: true,
    },
    source: {
      handoffDecision: "ready",
      handoffIdempotencyKey: "tb-finalizer-handoff:fixture",
      evidenceUrls: 3,
      receiptGaps: 3,
      blockers: 0,
    },
    workflow: {
      closeoutComment: {
        mode: "draft-only",
        title: "Draft: Terminal Brief closeout ready - round-700",
        body: "Draft closeout body. This was not posted automatically.",
        targetIssueUrl: "https://github.com/jinwon-int/a2a-broker/issues/700",
        targetPrUrl: "https://github.com/jinwon-int/a2a-broker/pull/701",
        postPermitted: false,
      },
      taskflowSeed: {
        createRecords: false,
        currentStep: "finalizer_review",
        stateJson: {
          source: "terminal-brief-finalizer-workflow",
          decision: "ready",
        },
        waitJson: {
          kind: "broker_finalizer_review",
          approvalRequiredForMutation: true,
        },
      },
    },
    checklist: [
      { check: "final-count reached", status: "pass", detail: "3/3 from envelope" },
      { check: "broker finalizer required", status: "review", detail: "single finalizer" },
    ],
    reviewItems: [
      "single broker finalizer must decide whether to use the draft closeout text",
    ],
    blockers: [],
    nextActions: [
      "single broker finalizer reviews draft comment, checklist, evidence URLs, and receipt gaps",
    ],
    approvalSensitiveActionsExcluded: [
      "GitHub PR merge, issue close, or comment post",
      "live provider/Hermes/Telegram/OpenClaw send",
      "terminal ACK/replay",
    ],
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
  return { ...base, ...overrides };
}

test("buildTerminalBriefCloseoutGate emits ready approval-required dry-run plan", () => {
  const packet = buildTerminalBriefCloseoutGate(workflow(), { now: NOW });

  assert.equal(packet.decision, "ready_for_approval");
  assert.equal(packet.gateState, "approval_required");
  assert.equal(packet.dryRunOnly, true);
  assert.equal(packet.executePermitted, false);
  assert.equal(packet.integrationContract.harnessNeutral, true);
  assert.equal(packet.integrationContract.openclawMessageSendRequired, false);
  assert.equal(packet.semantics.performsGitHubMutation, false);
  assert.equal(packet.semantics.createsTaskFlowRecords, false);
  assert.match(packet.idempotencyKey, /^tb-closeout-gate:/);

  const commentAction = packet.actions.find((action) => action.action === "post_closeout_comment");
  assert.equal(commentAction?.status, "proposed");
  assert.equal(commentAction?.requiresApproval, true);
  assert.equal(commentAction?.executePermitted, false);

  const taskflowAction = packet.actions.find((action) => action.action === "create_taskflow_record");
  assert.equal(taskflowAction?.status, "proposed");
  assert.equal(taskflowAction?.executePermitted, false);

  assert.equal(packet.actions.every((action) => action.executePermitted === false), true);
});

test("closeout gate blocks actions when workflow is waiting", () => {
  const packet = buildTerminalBriefCloseoutGate(workflow({
    decision: "waiting",
    currentStep: "wait_for_evidence",
    blockers: [],
  }), { now: NOW });

  assert.equal(packet.decision, "waiting");
  assert.equal(packet.gateState, "waiting_for_evidence");
  assert.equal(packet.actions.find((action) => action.action === "post_closeout_comment")?.status, "blocked");
  assert.equal(packet.approvalChecklist[0]?.status, "waiting");
});

test("closeout gate carries blockers and forbids live operations", () => {
  const packet = buildTerminalBriefCloseoutGate(workflow({
    decision: "blocked",
    currentStep: "recover_blockers",
    blockers: ["missing PR evidence"],
  }), { now: NOW });

  assert.equal(packet.decision, "blocked");
  assert.equal(packet.gateState, "blocked");
  assert.deepEqual(packet.blockers, ["missing PR evidence"]);
  assert.equal(packet.actions.find((action) => action.action === "live_provider_send")?.status, "forbidden");
  assert.equal(packet.actions.find((action) => action.action === "terminal_ack_or_replay")?.executePermitted, false);
});

test("extractTerminalBriefFinalizerWorkflowPacket accepts direct and envelope inputs", () => {
  const packet = workflow();

  assert.equal(extractTerminalBriefFinalizerWorkflowPacket(packet), packet);
  assert.equal(extractTerminalBriefFinalizerWorkflowPacket({ workflowPacket: packet }), packet);
  assert.equal(extractTerminalBriefFinalizerWorkflowPacket({ finalizerWorkflow: packet }), packet);
  assert.throws(() => extractTerminalBriefFinalizerWorkflowPacket({ workflow: { kind: "not-it" } }), /expected/);
});

test("renderTerminalBriefCloseoutGateMarkdown states approval gate and safety boundaries", () => {
  const packet = buildTerminalBriefCloseoutGate(workflow(), { now: NOW });
  const markdown = renderTerminalBriefCloseoutGateMarkdown(packet);

  assert.match(markdown, /^Ready for approval: terminal-brief closeout gate/);
  assert.match(markdown, /OpenClaw message send required=false/);
  assert.match(markdown, /post_closeout_comment \| status=proposed \| approval=true \| execute=false/);
  assert.match(markdown, /dry-run only; no comment post, merge, issue close/);
  assert.doesNotMatch(markdown, /ghp_|BROKER_EDGE_SECRET=|\/root\/\.openclaw/);
});
