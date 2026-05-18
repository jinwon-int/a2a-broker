import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTerminalBriefCloseoutGate,
  type TerminalBriefCloseoutGatePacket,
} from "./terminal-brief-closeout-gate.js";
import {
  buildTerminalBriefApprovalRequest,
  extractTerminalBriefCloseoutGatePacket,
  renderTerminalBriefApprovalRequestMarkdown,
} from "./terminal-brief-approval-request.js";
import type { TerminalBriefFinalizerWorkflowPacket } from "./terminal-brief-finalizer-workflow.js";

const NOW = "2026-05-18T16:00:00.000Z";

function workflow(overrides: Partial<TerminalBriefFinalizerWorkflowPacket> = {}): TerminalBriefFinalizerWorkflowPacket {
  const base: TerminalBriefFinalizerWorkflowPacket = {
    kind: "a2a-broker.terminal-brief-finalizer-workflow.packet",
    version: 1,
    generatedAt: NOW,
    mode: "read-only/no-live",
    parentRoundId: "round-702",
    decision: "ready",
    currentStep: "finalizer_review",
    idempotencyKey: "tb-finalizer-workflow:fixture-702",
    finalizer: {
      brokerOfRecordId: "seoseo",
      owner: "seoseo",
      required: true,
      singleFinalizerRequired: true,
    },
    source: {
      handoffDecision: "ready",
      handoffIdempotencyKey: "tb-finalizer-handoff:fixture-702",
      evidenceUrls: 3,
      receiptGaps: 1,
      blockers: 0,
    },
    workflow: {
      closeoutComment: {
        mode: "draft-only",
        title: "Draft: Terminal Brief closeout ready - round-702",
        body: "Draft closeout body. This was not posted automatically.",
        targetIssueUrl: "https://github.com/jinwon-int/a2a-broker/issues/702",
        targetPrUrl: "https://github.com/jinwon-int/a2a-broker/pull/703",
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

function gate(overrides: Partial<TerminalBriefFinalizerWorkflowPacket> = {}): TerminalBriefCloseoutGatePacket {
  return buildTerminalBriefCloseoutGate(workflow(overrides), { now: NOW });
}

test("buildTerminalBriefApprovalRequest emits draft-only request for proposed gate actions", () => {
  const packet = buildTerminalBriefApprovalRequest(gate(), { now: NOW });

  assert.equal(packet.kind, "a2a-broker.terminal-brief-approval-request.packet");
  assert.equal(packet.decision, "request_ready");
  assert.equal(packet.dryRunOnly, true);
  assert.equal(packet.requestDispatchPermitted, false);
  assert.equal(packet.approvalGrantPermitted, false);
  assert.equal(packet.executionPermitted, false);
  assert.equal(packet.request.sendPermitted, false);
  assert.equal(packet.request.presentationPlan.sendPermitted, false);
  assert.equal(packet.request.presentationPlan.buttonsEnabled, false);
  assert.equal(packet.request.presentationPlan.buttons.every((button) => button.enabled === false), true);
  assert.equal(packet.request.requestedActions.length, 4);
  assert.equal(packet.request.requestedActions.every((action) => action.sourceGateStatus === "proposed"), true);
  assert.equal(packet.request.requestedActions.every((action) => action.executePermitted === false), true);
  assert.equal(packet.integrationContract.harnessNeutral, true);
  assert.equal(packet.integrationContract.openclawMessageSendRequired, false);
  assert.equal(packet.integrationContract.sendsApprovalRequest, false);
  assert.equal(packet.semantics.performsGitHubMutation, false);
  assert.equal(packet.semantics.performsProviderSend, false);
  assert.equal(packet.semantics.createsTaskFlowRecords, false);
  assert.match(packet.idempotencyKey, /^tb-approval-request:/);
});

test("approval request planner waits when closeout gate is waiting", () => {
  const packet = buildTerminalBriefApprovalRequest(gate({
    decision: "waiting",
    currentStep: "wait_for_evidence",
  }), { now: NOW });

  assert.equal(packet.decision, "waiting");
  assert.equal(packet.request.requestedActions.length, 0);
  assert.equal(packet.request.nonRequestableActions.some((action) => action.status === "blocked"), true);
  assert.equal(packet.blockers.some((blocker) => blocker.includes("waiting for evidence")), true);
  assert.equal(packet.requestDispatchPermitted, false);
});

test("approval request planner blocks forbidden live actions and carries gate blockers", () => {
  const packet = buildTerminalBriefApprovalRequest(gate({
    decision: "blocked",
    currentStep: "recover_blockers",
    blockers: ["missing terminal evidence"],
  }), { now: NOW });

  assert.equal(packet.decision, "blocked");
  assert.equal(packet.request.requestedActions.length, 0);
  assert.equal(packet.blockers.includes("missing terminal evidence"), true);
  assert.equal(packet.request.nonRequestableActions.find((action) => action.action === "live_provider_send")?.status, "forbidden");
  assert.equal(packet.request.nonRequestableActions.find((action) => action.action === "terminal_ack_or_replay")?.executePermitted, false);
});

test("extractTerminalBriefCloseoutGatePacket accepts direct and envelope inputs", () => {
  const packet = gate();

  assert.equal(extractTerminalBriefCloseoutGatePacket(packet), packet);
  assert.equal(extractTerminalBriefCloseoutGatePacket({ gatePacket: packet }), packet);
  assert.equal(extractTerminalBriefCloseoutGatePacket({ closeoutGate: packet }), packet);
  assert.equal(extractTerminalBriefCloseoutGatePacket({ gate: packet }), packet);
  assert.equal(extractTerminalBriefCloseoutGatePacket({ packet }), packet);
  assert.throws(() => extractTerminalBriefCloseoutGatePacket({ packet: { kind: "not-it" } }), /expected/);
});

test("renderTerminalBriefApprovalRequestMarkdown states draft-only safety boundaries", () => {
  const packet = buildTerminalBriefApprovalRequest(gate(), { now: NOW });
  const markdown = renderTerminalBriefApprovalRequestMarkdown(packet);

  assert.match(markdown, /^Draft approval request: Terminal Brief closeout - round-702/);
  assert.match(markdown, /Request dispatch permitted: false/);
  assert.match(markdown, /OpenClaw message send required=false/);
  assert.match(markdown, /sendsApprovalRequest=false/);
  assert.match(markdown, /approval request planner only; request not sent; approval not granted/);
  assert.doesNotMatch(markdown, /ghp_|BROKER_EDGE_SECRET=|\/root\/\.openclaw/);
});
