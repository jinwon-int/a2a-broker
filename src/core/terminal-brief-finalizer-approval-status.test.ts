import assert from "node:assert/strict";
import test from "node:test";

import { buildTerminalBriefApprovalDispatchAdapter } from "./terminal-brief-approval-dispatch-adapter.js";
import { buildTerminalBriefApprovalExecutor } from "./terminal-brief-approval-executor.js";
import { buildTerminalBriefApprovalReceiptIngestor } from "./terminal-brief-approval-receipt-ingestor.js";
import { buildTerminalBriefApprovalRequest } from "./terminal-brief-approval-request.js";
import { buildTerminalBriefCloseoutGate } from "./terminal-brief-closeout-gate.js";
import {
  buildTerminalBriefFinalizerApprovalStatus,
  extractTerminalBriefFinalizerApprovalReceiptStatus,
  extractTerminalBriefFinalizerApprovalStatusDispatch,
  renderTerminalBriefFinalizerApprovalStatusMarkdown,
} from "./terminal-brief-finalizer-approval-status.js";
import type { TerminalBriefFinalizerWorkflowPacket } from "./terminal-brief-finalizer-workflow.js";

const NOW = "2026-05-18T22:30:00.000Z";
const FRESH = "2026-05-18T22:29:30.000Z";

function workflow(overrides: Partial<TerminalBriefFinalizerWorkflowPacket> = {}): TerminalBriefFinalizerWorkflowPacket {
  const base: TerminalBriefFinalizerWorkflowPacket = {
    kind: "a2a-broker.terminal-brief-finalizer-workflow.packet",
    version: 1,
    generatedAt: NOW,
    mode: "read-only/no-live",
    parentRoundId: "round-709",
    decision: "ready",
    currentStep: "finalizer_review",
    idempotencyKey: "tb-finalizer-workflow:fixture-709",
    finalizer: {
      brokerOfRecordId: "broker-finalizer",
      owner: "broker-finalizer",
      required: true,
      singleFinalizerRequired: true,
    },
    source: {
      handoffDecision: "ready",
      handoffIdempotencyKey: "tb-finalizer-handoff:fixture-709",
      evidenceUrls: 3,
      receiptGaps: 1,
      blockers: 0,
    },
    workflow: {
      closeoutComment: {
        mode: "draft-only",
        title: "Draft: Terminal Brief closeout ready - round-709",
        body: "Draft closeout body. This was not posted automatically.",
        targetIssueUrl: "https://github.com/jinwon-int/a2a-broker/issues/709",
        targetPrUrl: "https://github.com/jinwon-int/a2a-broker/pull/711",
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

function dispatch(options: Parameters<typeof buildTerminalBriefApprovalExecutor>[1] = {}) {
  const request = buildTerminalBriefApprovalRequest(
    buildTerminalBriefCloseoutGate(workflow(), { now: NOW }),
    { now: NOW },
  );
  const executor = buildTerminalBriefApprovalExecutor(request, { now: NOW, ...options });
  return buildTerminalBriefApprovalDispatchAdapter(executor, {
    now: NOW,
    adapter: "gongyung",
    target: "hermes://gongyung/approval",
    channel: "operator",
    requestedBy: "broker-finalizer",
  });
}

test("finalizer approval status waits for receipt ingestor evidence when missing", () => {
  const dispatchPacket = dispatch({ selectedAction: "post_closeout_comment" });
  const packet = buildTerminalBriefFinalizerApprovalStatus(dispatchPacket, undefined, { now: NOW });

  assert.equal(packet.kind, "a2a-broker.terminal-brief-finalizer-approval-status.packet");
  assert.equal(packet.state, "waiting_for_receipt_evidence");
  assert.equal(packet.approval.receiptEvidenceAccepted, false);
  assert.equal(packet.approval.terminalAckPermitted, false);
  assert.equal(packet.approval.executionPermitted, false);
  assert.equal(packet.table.rows.some((row) => row.name === "receipt" && row.ready === false), true);
  assert.equal(packet.defaultOnReadiness.sourceCriteriaMet, false);
  assert.equal(packet.defaultOnReadiness.defaultOnPermitted, false);
  assert.equal(packet.defaultOnReadiness.missingEvidence.includes("accepted_receipt_ingestor_packet"), true);
});

test("finalizer approval status treats visibility evidence as ACK-eligible but still waits for approval grant", () => {
  const dispatchPacket = dispatch({ selectedAction: "post_closeout_comment" });
  const receipt = buildTerminalBriefApprovalReceiptIngestor(dispatchPacket, [
    {
      kind: "current_session_visible",
      observedAt: FRESH,
      receiptId: "receipt-visible-709",
      currentSessionId: "session-current",
    },
  ], { now: NOW });
  const packet = buildTerminalBriefFinalizerApprovalStatus(dispatchPacket, receipt, { now: NOW });

  assert.equal(packet.state, "waiting_for_approval_evidence");
  assert.equal(packet.approval.currentSessionVisible, true);
  assert.equal(packet.approval.terminalAckEligible, true);
  assert.equal(packet.approval.terminalAckPermitted, false);
  assert.equal(packet.approval.approvalGrantAccepted, false);
  assert.equal(packet.blockers.includes("matching approval_grant evidence is missing"), true);
});

test("finalizer approval status becomes ready for broker review when visibility and approval evidence are present", () => {
  const dispatchPacket = dispatch({ selectedAction: "post_closeout_comment" });
  const receipt = buildTerminalBriefApprovalReceiptIngestor(dispatchPacket, [
    {
      kind: "current_session_visible",
      observedAt: FRESH,
      receiptId: "receipt-visible-709",
      currentSessionId: "session-current",
    },
    {
      kind: "approval_grant",
      observedAt: FRESH,
      approvedAction: "post_closeout_comment",
      approvedTarget: "https://github.com/jinwon-int/a2a-broker/issues/709",
      operatorId: "operator-a",
    },
  ], { now: NOW });
  const packet = buildTerminalBriefFinalizerApprovalStatus(dispatchPacket, receipt, { now: NOW });

  assert.equal(packet.state, "ready_for_finalizer_review");
  assert.equal(packet.approval.receiptEvidenceAccepted, true);
  assert.equal(packet.approval.currentSessionVisible, true);
  assert.equal(packet.approval.approvalGrantAccepted, true);
  assert.equal(packet.approval.terminalAckPermitted, false);
  assert.equal(packet.approval.approvalGrantPermitted, false);
  assert.equal(packet.approval.executionPermitted, false);
  assert.equal(packet.defaultOnReadiness.sourceCriteriaMet, true);
  assert.equal(packet.defaultOnReadiness.defaultOnPermitted, false);
  assert.equal(packet.defaultOnReadiness.blockers.some((blocker) => blocker.includes("separate live deployment")), true);
  assert.equal(packet.table.requiredRowsReady, 3);
});

test("finalizer approval status fails closed on provider-only, stale, conflicting, and blocked evidence", () => {
  const dispatchPacket = dispatch({ selectedAction: "post_closeout_comment" });
  const providerOnly = buildTerminalBriefFinalizerApprovalStatus(
    dispatchPacket,
    buildTerminalBriefApprovalReceiptIngestor(dispatchPacket, [
      { kind: "provider_accepted", observedAt: FRESH, providerMessageId: "provider-msg" },
    ], { now: NOW }),
    { now: NOW },
  );
  assert.equal(providerOnly.state, "waiting_for_receipt_evidence");
  assert.equal(providerOnly.blockers.includes("receipt evidence is insufficient"), true);

  const stale = buildTerminalBriefFinalizerApprovalStatus(
    dispatchPacket,
    buildTerminalBriefApprovalReceiptIngestor(dispatchPacket, [
      { kind: "expired", observedAt: FRESH },
    ], { now: NOW }),
    { now: NOW },
  );
  assert.equal(stale.state, "stale");

  const conflicting = buildTerminalBriefFinalizerApprovalStatus(
    dispatchPacket,
    buildTerminalBriefApprovalReceiptIngestor(dispatchPacket, [
      { kind: "current_session_visible", observedAt: FRESH },
      { kind: "rejected", observedAt: FRESH },
    ], { now: NOW }),
    { now: NOW },
  );
  assert.equal(conflicting.state, "conflicting");

  const blockedDispatch = dispatch({ selectedAction: "merge_pull_request", attemptExecute: true });
  const blocked = buildTerminalBriefFinalizerApprovalStatus(
    blockedDispatch,
    buildTerminalBriefApprovalReceiptIngestor(blockedDispatch, [
      { kind: "current_session_visible", observedAt: FRESH },
    ], { now: NOW }),
    { now: NOW },
  );
  assert.equal(blocked.state, "blocked");
});

test("finalizer approval status extractors and markdown preserve source-only boundaries", () => {
  const dispatchPacket = dispatch({ selectedAction: "post_closeout_comment" });
  const receipt = buildTerminalBriefApprovalReceiptIngestor(dispatchPacket, [
    { kind: "manual_operator_confirmation", observedAt: FRESH },
    {
      kind: "approval_grant",
      observedAt: FRESH,
      approvedAction: "post_closeout_comment",
      approvedTarget: "https://github.com/jinwon-int/a2a-broker/issues/709",
    },
  ], { now: NOW });
  assert.equal(extractTerminalBriefFinalizerApprovalStatusDispatch(dispatchPacket), dispatchPacket);
  assert.equal(extractTerminalBriefFinalizerApprovalStatusDispatch({ approvalDispatch: dispatchPacket }), dispatchPacket);
  assert.equal(extractTerminalBriefFinalizerApprovalReceiptStatus(receipt), receipt);
  assert.equal(extractTerminalBriefFinalizerApprovalReceiptStatus({ approvalReceipt: receipt }), receipt);
  assert.equal(extractTerminalBriefFinalizerApprovalReceiptStatus({ receiptIngestorPacket: receipt }), receipt);
  assert.equal(extractTerminalBriefFinalizerApprovalReceiptStatus({ packet: { kind: "not-it" } }), undefined);
  assert.throws(() => extractTerminalBriefFinalizerApprovalStatusDispatch({ packet: { kind: "not-it" } }), /expected/);

  const packet = buildTerminalBriefFinalizerApprovalStatus(dispatchPacket, receipt, { now: NOW });
  const markdown = renderTerminalBriefFinalizerApprovalStatusMarkdown(packet);
  assert.match(markdown, /^Ready: Terminal Brief broker finalizer approval status/);
  assert.match(markdown, /Default-on readiness:/);
  assert.match(markdown, /terminalAckPermitted=false/);
  assert.match(markdown, /no provider send, terminal ACK\/replay, approval grant, GitHub mutation/);
  assert.doesNotMatch(markdown, /ghp_|BROKER_EDGE_SECRET=|\/root\/\.openclaw/);
});
