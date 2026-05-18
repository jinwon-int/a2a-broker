import assert from "node:assert/strict";
import test from "node:test";

import { buildTerminalBriefApprovalDispatchAdapter } from "./terminal-brief-approval-dispatch-adapter.js";
import { buildTerminalBriefApprovalRequest } from "./terminal-brief-approval-request.js";
import { buildTerminalBriefApprovalExecutor } from "./terminal-brief-approval-executor.js";
import {
  buildTerminalBriefApprovalReceiptIngestor,
  extractTerminalBriefApprovalDispatchAdapterPacket,
  extractTerminalBriefApprovalReceiptEvidence,
  renderTerminalBriefApprovalReceiptIngestorMarkdown,
} from "./terminal-brief-approval-receipt-ingestor.js";
import { buildTerminalBriefCloseoutGate } from "./terminal-brief-closeout-gate.js";
import type { TerminalBriefFinalizerWorkflowPacket } from "./terminal-brief-finalizer-workflow.js";

const NOW = "2026-05-18T21:30:00.000Z";
const FRESH = "2026-05-18T21:29:30.000Z";
const OLD = "2026-05-18T21:00:00.000Z";

function workflow(overrides: Partial<TerminalBriefFinalizerWorkflowPacket> = {}): TerminalBriefFinalizerWorkflowPacket {
  const base: TerminalBriefFinalizerWorkflowPacket = {
    kind: "a2a-broker.terminal-brief-finalizer-workflow.packet",
    version: 1,
    generatedAt: NOW,
    mode: "read-only/no-live",
    parentRoundId: "round-708",
    decision: "ready",
    currentStep: "finalizer_review",
    idempotencyKey: "tb-finalizer-workflow:fixture-708",
    finalizer: {
      brokerOfRecordId: "broker-finalizer",
      owner: "broker-finalizer",
      required: true,
      singleFinalizerRequired: true,
    },
    source: {
      handoffDecision: "ready",
      handoffIdempotencyKey: "tb-finalizer-handoff:fixture-708",
      evidenceUrls: 3,
      receiptGaps: 1,
      blockers: 0,
    },
    workflow: {
      closeoutComment: {
        mode: "draft-only",
        title: "Draft: Terminal Brief closeout ready - round-708",
        body: "Draft closeout body. This was not posted automatically.",
        targetIssueUrl: "https://github.com/jinwon-int/a2a-broker/issues/708",
        targetPrUrl: "https://github.com/jinwon-int/a2a-broker/pull/710",
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

test("receipt ingestor treats provider accepted alone as insufficient", () => {
  const packet = buildTerminalBriefApprovalReceiptIngestor(dispatch(), [
    {
      kind: "provider_accepted",
      observedAt: FRESH,
      providerMessageId: "provider-msg-1",
    },
  ], { now: NOW });

  assert.equal(packet.kind, "a2a-broker.terminal-brief-approval-receipt-ingestor.packet");
  assert.equal(packet.state, "insufficient");
  assert.equal(packet.classification.providerAccepted, true);
  assert.equal(packet.classification.currentSessionVisible, false);
  assert.equal(packet.classification.terminalAckEligible, false);
  assert.equal(packet.terminalAckPermitted, false);
  assert.equal(packet.integrationContract.providerAcceptedIsVisibilityProof, false);
  assert.equal(packet.semantics.performsTerminalAck, false);
});

test("receipt ingestor accepts current-session-visible evidence without performing ACK", () => {
  const packet = buildTerminalBriefApprovalReceiptIngestor(dispatch(), [
    {
      kind: "current_session_visible",
      observedAt: FRESH,
      receiptId: "receipt-visible-1",
      currentSessionId: "session-current",
    },
  ], { now: NOW });

  assert.equal(packet.state, "accepted");
  assert.equal(packet.receiptEvidenceAccepted, true);
  assert.equal(packet.classification.currentSessionVisible, true);
  assert.equal(packet.classification.terminalAckEligible, true);
  assert.equal(packet.terminalAckPermitted, false);
  assert.equal(packet.terminalReceiptMutationPermitted, false);
});

test("receipt ingestor accepts matching approval grant as evidence only", () => {
  const packet = buildTerminalBriefApprovalReceiptIngestor(dispatch({
    selectedAction: "post_closeout_comment",
  }), [
    {
      kind: "approval_grant",
      observedAt: FRESH,
      approvedAction: "post_closeout_comment",
      approvedTarget: "https://github.com/jinwon-int/a2a-broker/issues/708",
      operatorId: "operator-a",
    },
  ], { now: NOW });

  assert.equal(packet.state, "accepted");
  assert.equal(packet.classification.approvalGrantAccepted, true);
  assert.equal(packet.approvalGrantPermitted, false);
  assert.equal(packet.executionPermitted, false);
  assert.equal(packet.integrationContract.grantsApproval, false);
  assert.equal(packet.integrationContract.executesAction, false);
});

test("receipt ingestor fails closed on stale or expired evidence", () => {
  const stale = buildTerminalBriefApprovalReceiptIngestor(dispatch(), [
    {
      kind: "current_session_visible",
      observedAt: OLD,
      receiptId: "receipt-old",
    },
  ], { now: NOW, maxAgeMs: 60_000 });
  assert.equal(stale.state, "stale");
  assert.equal(stale.classification.stale, true);

  const expired = buildTerminalBriefApprovalReceiptIngestor(dispatch(), [
    {
      kind: "expired",
      observedAt: FRESH,
      expiresAt: "2026-05-18T21:29:00.000Z",
    },
  ], { now: NOW });
  assert.equal(expired.state, "stale");
  assert.equal(expired.classification.expired, true);
});

test("receipt ingestor detects conflicting receipt and approval evidence", () => {
  const positiveAndRejected = buildTerminalBriefApprovalReceiptIngestor(dispatch(), [
    { kind: "current_session_visible", observedAt: FRESH, receiptId: "receipt-visible-2" },
    { kind: "rejected", observedAt: FRESH, receiptId: "receipt-rejected-2" },
  ], { now: NOW });
  assert.equal(positiveAndRejected.state, "conflicting");

  const wrongAction = buildTerminalBriefApprovalReceiptIngestor(dispatch({
    selectedAction: "post_closeout_comment",
  }), [
    {
      kind: "approval_grant",
      observedAt: FRESH,
      approvedAction: "merge_pull_request",
      operatorId: "operator-a",
    },
  ], { now: NOW });
  assert.equal(wrongAction.state, "conflicting");
  assert.equal(wrongAction.evidence.conflictingKinds.includes("approval_grant"), true);
});

test("receipt ingestor blocks unsupported evidence and blocked dispatch packets", () => {
  const unsupported = buildTerminalBriefApprovalReceiptIngestor(dispatch(), [
    { kind: "unknown-provider-proof", observedAt: FRESH },
  ], { now: NOW });
  assert.equal(unsupported.state, "blocked");
  assert.equal(unsupported.blockers.some((blocker) => blocker.includes("unsupported kind")), true);

  const blockedDispatch = dispatch({
    selectedAction: "merge_pull_request",
    attemptExecute: true,
  });
  const blocked = buildTerminalBriefApprovalReceiptIngestor(blockedDispatch, [
    { kind: "current_session_visible", observedAt: FRESH },
  ], { now: NOW });
  assert.equal(blocked.state, "blocked");
  assert.equal(blocked.blockers.some((blocker) => blocker.includes("dispatch adapter is blocked")), true);
});

test("receipt ingestor extractors and markdown preserve no-live semantics", () => {
  const dispatchPacket = dispatch();
  assert.equal(extractTerminalBriefApprovalDispatchAdapterPacket(dispatchPacket), dispatchPacket);
  assert.equal(extractTerminalBriefApprovalDispatchAdapterPacket({ approvalDispatch: dispatchPacket }), dispatchPacket);
  assert.equal(extractTerminalBriefApprovalDispatchAdapterPacket({ approvalDispatchPacket: dispatchPacket }), dispatchPacket);
  assert.equal(extractTerminalBriefApprovalDispatchAdapterPacket({ dispatchAdapter: dispatchPacket }), dispatchPacket);
  assert.equal(extractTerminalBriefApprovalDispatchAdapterPacket({ packet: dispatchPacket }), dispatchPacket);
  assert.throws(() => extractTerminalBriefApprovalDispatchAdapterPacket({ packet: { kind: "not-it" } }), /expected/);

  assert.deepEqual(extractTerminalBriefApprovalReceiptEvidence({
    receiptEvidence: [{ kind: "provider_accepted" }],
  }), [{ kind: "provider_accepted" }]);
  assert.deepEqual(extractTerminalBriefApprovalReceiptEvidence({
    receipt: { kind: "manual_operator_receipt" },
  }), [{ kind: "manual_operator_receipt" }]);

  const packet = buildTerminalBriefApprovalReceiptIngestor(dispatchPacket, [
    { kind: "manual_operator_confirmation", observedAt: FRESH },
  ], { now: NOW });
  const markdown = renderTerminalBriefApprovalReceiptIngestorMarkdown(packet);
  assert.match(markdown, /^Accepted: Terminal Brief approval receipt evidence/);
  assert.match(markdown, /providerAcceptedIsVisibilityProof=false/);
  assert.match(markdown, /terminalAckEligible never permits ACK/);
  assert.doesNotMatch(markdown, /ghp_|BROKER_EDGE_SECRET=|\/root\/\.openclaw/);
});
