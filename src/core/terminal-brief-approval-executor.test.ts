import assert from "node:assert/strict";
import test from "node:test";

import { buildTerminalBriefApprovalRequest } from "./terminal-brief-approval-request.js";
import {
  buildTerminalBriefApprovalExecutor,
  extractTerminalBriefApprovalRequestPacket,
  renderTerminalBriefApprovalExecutorMarkdown,
} from "./terminal-brief-approval-executor.js";
import { buildTerminalBriefCloseoutGate } from "./terminal-brief-closeout-gate.js";
import type { TerminalBriefFinalizerWorkflowPacket } from "./terminal-brief-finalizer-workflow.js";

const NOW = "2026-05-18T20:20:00.000Z";

function workflow(overrides: Partial<TerminalBriefFinalizerWorkflowPacket> = {}): TerminalBriefFinalizerWorkflowPacket {
  const base: TerminalBriefFinalizerWorkflowPacket = {
    kind: "a2a-broker.terminal-brief-finalizer-workflow.packet",
    version: 1,
    generatedAt: NOW,
    mode: "read-only/no-live",
    parentRoundId: "round-704",
    decision: "ready",
    currentStep: "finalizer_review",
    idempotencyKey: "tb-finalizer-workflow:fixture-704",
    finalizer: {
      brokerOfRecordId: "seoseo",
      owner: "seoseo",
      required: true,
      singleFinalizerRequired: true,
    },
    source: {
      handoffDecision: "ready",
      handoffIdempotencyKey: "tb-finalizer-handoff:fixture-704",
      evidenceUrls: 3,
      receiptGaps: 1,
      blockers: 0,
    },
    workflow: {
      closeoutComment: {
        mode: "draft-only",
        title: "Draft: Terminal Brief closeout ready - round-704",
        body: "Draft closeout body. This was not posted automatically.",
        targetIssueUrl: "https://github.com/jinwon-int/a2a-broker/issues/704",
        targetPrUrl: "https://github.com/jinwon-int/a2a-broker/pull/705",
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
    checklist: [],
    reviewItems: [
      "single broker finalizer must decide whether to use the draft closeout text",
    ],
    blockers: [],
    nextActions: [],
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

function approvalRequest(overrides: Partial<TerminalBriefFinalizerWorkflowPacket> = {}) {
  return buildTerminalBriefApprovalRequest(
    buildTerminalBriefCloseoutGate(workflow(overrides), { now: NOW }),
    { now: NOW },
  );
}

test("approval executor shell emits dispatch_pending without dispatching", () => {
  const packet = buildTerminalBriefApprovalExecutor(approvalRequest(), { now: NOW });

  assert.equal(packet.kind, "a2a-broker.terminal-brief-approval-executor.packet");
  assert.equal(packet.state, "dispatch_pending");
  assert.equal(packet.dispatch.state, "dispatch_pending");
  assert.equal(packet.dispatch.requestDispatched, false);
  assert.equal(packet.dispatchPermitted, false);
  assert.equal(packet.approvalGrantPermitted, false);
  assert.equal(packet.executionPermitted, false);
  assert.equal(packet.integrationContract.openclawMessageSendRequired, false);
  assert.equal(packet.integrationContract.sendsApprovalRequest, false);
  assert.equal(packet.integrationContract.grantsApproval, false);
  assert.equal(packet.integrationContract.executesAction, false);
  assert.equal(packet.semantics.performsGitHubMutation, false);
  assert.equal(packet.semantics.createsTaskFlowRecords, false);
});

test("approval executor shell records simulated approval without granting real approval", () => {
  const packet = buildTerminalBriefApprovalExecutor(approvalRequest(), {
    now: NOW,
    selectedAction: "post_closeout_comment",
  });

  assert.equal(packet.state, "approval_granted_dry_run");
  assert.equal(packet.approval.state, "simulated_granted_dry_run");
  assert.equal(packet.approval.selectedAction?.action, "post_closeout_comment");
  assert.equal(packet.approval.realApprovalGranted, false);
  assert.equal(packet.approval.simulatedApprovalOnly, true);
  assert.equal(packet.execution.state, "not_attempted");
  assert.equal(packet.execution.executed, false);
});

test("approval executor shell blocks execution after simulated approval", () => {
  const packet = buildTerminalBriefApprovalExecutor(approvalRequest(), {
    now: NOW,
    selectedAction: "merge_pull_request",
    attemptExecute: true,
  });

  assert.equal(packet.state, "execute_blocked");
  assert.equal(packet.approval.state, "simulated_granted_dry_run");
  assert.equal(packet.execution.state, "execute_blocked");
  assert.equal(packet.execution.selectedAction?.action, "merge_pull_request");
  assert.equal(packet.execution.executePermitted, false);
  assert.equal(packet.execution.executed, false);
});

test("approval executor shell blocks waiting requests and invalid selected actions", () => {
  const waiting = buildTerminalBriefApprovalExecutor(approvalRequest({
    decision: "waiting",
    currentStep: "wait_for_evidence",
  }), { now: NOW });
  assert.equal(waiting.state, "blocked");
  assert.equal(waiting.blockers.some((blocker) => blocker.includes("not ready")), true);

  const invalidSelection = buildTerminalBriefApprovalExecutor(approvalRequest(), {
    now: NOW,
    selectedAction: "live_provider_send",
  });
  assert.equal(invalidSelection.state, "blocked");
  assert.equal(invalidSelection.blockers.some((blocker) => blocker.includes("selected action")), true);
});

test("extractTerminalBriefApprovalRequestPacket accepts direct and envelope inputs", () => {
  const packet = approvalRequest();

  assert.equal(extractTerminalBriefApprovalRequestPacket(packet), packet);
  assert.equal(extractTerminalBriefApprovalRequestPacket({ approvalRequest: packet }), packet);
  assert.equal(extractTerminalBriefApprovalRequestPacket({ approvalRequestPacket: packet }), packet);
  assert.equal(extractTerminalBriefApprovalRequestPacket({ requestPacket: packet }), packet);
  assert.equal(extractTerminalBriefApprovalRequestPacket({ packet }), packet);
  assert.throws(() => extractTerminalBriefApprovalRequestPacket({ packet: { kind: "not-it" } }), /expected/);
});

test("renderTerminalBriefApprovalExecutorMarkdown states no-live safety boundaries", () => {
  const packet = buildTerminalBriefApprovalExecutor(approvalRequest(), {
    now: NOW,
    selectedAction: "close_issue",
    attemptExecute: true,
  });
  const markdown = renderTerminalBriefApprovalExecutorMarkdown(packet);

  assert.match(markdown, /^Execution blocked: Terminal Brief approval executor shell/);
  assert.match(markdown, /sendsApprovalRequest=false; grantsApproval=false; executesAction=false/);
  assert.match(markdown, /approval executor shell only; request not dispatched; approval not really granted/);
  assert.match(markdown, /execution not permitted/);
  assert.doesNotMatch(markdown, /ghp_|BROKER_EDGE_SECRET=|\/root\/\.openclaw/);
});
