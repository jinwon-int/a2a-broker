import assert from "node:assert/strict";
import test from "node:test";

import { buildTerminalBriefApprovalRequest } from "./terminal-brief-approval-request.js";
import { buildTerminalBriefApprovalExecutor } from "./terminal-brief-approval-executor.js";
import {
  buildTerminalBriefApprovalDispatchAdapter,
  extractTerminalBriefApprovalExecutorPacket,
  renderTerminalBriefApprovalDispatchAdapterMarkdown,
} from "./terminal-brief-approval-dispatch-adapter.js";
import { buildTerminalBriefCloseoutGate } from "./terminal-brief-closeout-gate.js";
import type { TerminalBriefFinalizerWorkflowPacket } from "./terminal-brief-finalizer-workflow.js";

const NOW = "2026-05-18T21:00:00.000Z";

function workflow(overrides: Partial<TerminalBriefFinalizerWorkflowPacket> = {}): TerminalBriefFinalizerWorkflowPacket {
  const base: TerminalBriefFinalizerWorkflowPacket = {
    kind: "a2a-broker.terminal-brief-finalizer-workflow.packet",
    version: 1,
    generatedAt: NOW,
    mode: "read-only/no-live",
    parentRoundId: "round-706",
    decision: "ready",
    currentStep: "finalizer_review",
    idempotencyKey: "tb-finalizer-workflow:fixture-706",
    finalizer: {
      brokerOfRecordId: "seoseo",
      owner: "seoseo",
      required: true,
      singleFinalizerRequired: true,
    },
    source: {
      handoffDecision: "ready",
      handoffIdempotencyKey: "tb-finalizer-handoff:fixture-706",
      evidenceUrls: 3,
      receiptGaps: 1,
      blockers: 0,
    },
    workflow: {
      closeoutComment: {
        mode: "draft-only",
        title: "Draft: Terminal Brief closeout ready - round-706",
        body: "Draft closeout body. This was not posted automatically.",
        targetIssueUrl: "https://github.com/jinwon-int/a2a-broker/issues/706",
        targetPrUrl: "https://github.com/jinwon-int/a2a-broker/pull/707",
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
    reviewItems: [],
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

function executor(options: Parameters<typeof buildTerminalBriefApprovalExecutor>[1] = {}) {
  const request = buildTerminalBriefApprovalRequest(
    buildTerminalBriefCloseoutGate(workflow(), { now: NOW }),
    { now: NOW },
  );
  return buildTerminalBriefApprovalExecutor(request, { now: NOW, ...options });
}

test("approval dispatch adapter emits Hermes transcript draft without provider send", () => {
  const packet = buildTerminalBriefApprovalDispatchAdapter(executor(), {
    now: NOW,
    adapter: "hermes",
    target: "hermes://gongyung/approval",
    channel: "operator",
    requestedBy: "seoseo",
  });

  assert.equal(packet.kind, "a2a-broker.terminal-brief-approval-dispatch-adapter.packet");
  assert.equal(packet.state, "dispatch_draft_ready");
  assert.equal(packet.adapter.type, "hermes");
  assert.equal(packet.adapter.requiresOpenClawMessageSend, false);
  assert.equal(packet.dispatchPermitted, false);
  assert.equal(packet.providerSendPermitted, false);
  assert.equal(packet.approvalGrantPermitted, false);
  assert.equal(packet.executionPermitted, false);
  assert.equal(packet.transcript.sent, false);
  assert.equal(packet.transcript.sendPermitted, false);
  assert.equal(packet.receiptDraft.providerAccepted, false);
  assert.equal(packet.receiptDraft.terminalAck, false);
  assert.equal(packet.integrationContract.openclawMessageSendRequired, false);
  assert.equal(packet.integrationContract.hermesAdapterCompatible, true);
  assert.equal(packet.integrationContract.gongyungAdapterCompatible, true);
  assert.equal(packet.integrationContract.sendsApprovalRequest, false);
  assert.equal(packet.semantics.performsProviderSend, false);
});

test("approval dispatch adapter can draft Gongyung approval receipt without granting approval", () => {
  const packet = buildTerminalBriefApprovalDispatchAdapter(executor({
    selectedAction: "post_closeout_comment",
  }), {
    now: NOW,
    adapter: "gongyung",
  });

  assert.equal(packet.state, "approval_receipt_draft_ready");
  assert.equal(packet.adapter.type, "gongyung");
  assert.equal(packet.source.selectedAction, "post_closeout_comment");
  assert.equal(packet.receiptDraft.approvalGranted, false);
  assert.equal(packet.receiptDraft.actionExecuted, false);
  assert.match(packet.receiptDraft.reason, /dry-run receipt draft/);
});

test("approval dispatch adapter blocks execute-blocked executor and unsupported adapters", () => {
  const executeBlocked = buildTerminalBriefApprovalDispatchAdapter(executor({
    selectedAction: "merge_pull_request",
    attemptExecute: true,
  }), { now: NOW, adapter: "openclaw" });
  assert.equal(executeBlocked.state, "dispatch_blocked");
  assert.equal(executeBlocked.blockers.some((blocker) => blocker.includes("execute_blocked")), true);

  const unsupported = buildTerminalBriefApprovalDispatchAdapter(executor(), {
    now: NOW,
    adapter: "custom-live-provider",
  });
  assert.equal(unsupported.state, "dispatch_blocked");
  assert.equal(unsupported.blockers.some((blocker) => blocker.includes("unsupported adapter")), true);
});

test("extractTerminalBriefApprovalExecutorPacket accepts direct and envelope inputs", () => {
  const packet = executor();

  assert.equal(extractTerminalBriefApprovalExecutorPacket(packet), packet);
  assert.equal(extractTerminalBriefApprovalExecutorPacket({ approvalExecutor: packet }), packet);
  assert.equal(extractTerminalBriefApprovalExecutorPacket({ approvalExecutorPacket: packet }), packet);
  assert.equal(extractTerminalBriefApprovalExecutorPacket({ executorPacket: packet }), packet);
  assert.equal(extractTerminalBriefApprovalExecutorPacket({ packet }), packet);
  assert.throws(() => extractTerminalBriefApprovalExecutorPacket({ packet: { kind: "not-it" } }), /expected/);
});

test("renderTerminalBriefApprovalDispatchAdapterMarkdown states adapter neutrality and no-live safety", () => {
  const packet = buildTerminalBriefApprovalDispatchAdapter(executor(), {
    now: NOW,
    adapter: "openclaw",
  });
  const markdown = renderTerminalBriefApprovalDispatchAdapterMarkdown(packet);

  assert.match(markdown, /^Dispatch draft ready: Terminal Brief approval adapter/);
  assert.match(markdown, /OpenClaw message send required=false; Hermes compatible=true; Gongyung compatible=true/);
  assert.match(markdown, /request not sent; receipt is not visibility proof/);
  assert.match(markdown, /execution not permitted/);
  assert.doesNotMatch(markdown, /ghp_|BROKER_EDGE_SECRET=|\/root\/\.openclaw/);
});
