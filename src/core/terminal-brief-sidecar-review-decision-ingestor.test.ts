import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildTerminalBriefSidecarOperatorReviewTable,
  extractTerminalBriefSidecarOperatorReviewTableHandoff,
  type TerminalBriefSidecarOperatorReviewTablePacket,
} from "./terminal-brief-sidecar-operator-review-table.js";
import {
  buildTerminalBriefSidecarReviewDecisionIngestor,
  extractTerminalBriefSidecarReviewDecisionEvidence,
  extractTerminalBriefSidecarReviewDecisionIngestorOptions,
  extractTerminalBriefSidecarReviewDecisionIngestorTable,
  renderTerminalBriefSidecarReviewDecisionIngestorMarkdown,
} from "./terminal-brief-sidecar-review-decision-ingestor.js";

const NOW = "2026-05-19T01:40:00.000Z";

function readyTable(
  overrides: Partial<TerminalBriefSidecarOperatorReviewTablePacket> = {},
): TerminalBriefSidecarOperatorReviewTablePacket {
  const fixture = JSON.parse(readFileSync("fixtures/terminal-brief/sidecar-operator-review-table.no-live.json", "utf8"));
  const packet = buildTerminalBriefSidecarOperatorReviewTable(
    extractTerminalBriefSidecarOperatorReviewTableHandoff(fixture),
    {
      now: NOW,
      reviewOwner: "seoseo",
      reviewReference: "operator-review-745",
    },
  );
  return { ...packet, ...overrides } as TerminalBriefSidecarOperatorReviewTablePacket;
}

test("review decision ingestor accepts operator-visible approval evidence without granting approval", () => {
  const packet = buildTerminalBriefSidecarReviewDecisionIngestor(readyTable(), [{
    type: "approve",
    operatorTarget: "round-739",
    reviewReference: "operator-review-745",
    approvalReference: "approval-visible-745",
    operatorVisibleConfirmation: true,
    observedAt: NOW,
  }], { now: NOW });

  assert.equal(packet.kind, "a2a-broker.terminal-brief-sidecar-review-decision-ingestor.packet");
  assert.equal(packet.state, "approved_evidence");
  assert.equal(packet.decisionEvidence.acceptedApprovalEvidence, true);
  assert.equal(packet.readiness.reviewDecisionEvidenceAccepted, true);
  assert.equal(packet.readiness.approvalRequestDispatchPermitted, false);
  assert.equal(packet.readiness.approvalGrantPermitted, false);
  assert.equal(packet.readiness.executorInvocationPermitted, false);
  assert.equal(packet.readiness.processSpawnPermitted, false);
  assert.equal(packet.readiness.sidecarStartPermitted, false);
  assert.equal(packet.readiness.providerSendPermitted, false);
  assert.equal(packet.readiness.terminalAckPermitted, false);
  assert.equal(packet.readiness.executionPermitted, false);
  assert.equal(packet.readiness.dbMutationPermitted, false);
  assert.equal(packet.integrationContract.classifiesOperatorDecisionEvidence, true);
  assert.equal(packet.integrationContract.grantsApproval, false);
  assert.equal(packet.integrationContract.sendsApprovalRequest, false);
  assert.equal(packet.integrationContract.invokesExecutor, false);
  assert.equal(packet.integrationContract.startsSidecar, false);
  assert.equal(packet.semantics.acceptedDecisionEvidenceDoesNotGrantApproval, true);
});

test("review decision ingestor rejects provider accepted as approval evidence", () => {
  const packet = buildTerminalBriefSidecarReviewDecisionIngestor(readyTable(), [{
    type: "provider_accepted",
    operatorTarget: "round-739",
    reviewReference: "operator-review-745",
    observedAt: NOW,
  }], { now: NOW });

  assert.equal(packet.state, "insufficient");
  assert.equal(packet.decisionEvidence.providerAcceptedOnly, true);
  assert.equal(packet.decisionEvidence.acceptedApprovalEvidence, false);
  assert.equal(packet.decisionEvidence.normalized[0].classification, "insufficient");
  assert.equal(packet.semantics.providerAcceptedIsApprovalEvidence, false);
});

test("review decision ingestor classifies reject request-more-evidence conflict and expired", () => {
  const rejected = buildTerminalBriefSidecarReviewDecisionIngestor(readyTable(), [{
    type: "reject",
    operatorTarget: "round-739",
    reviewReference: "operator-review-745",
  }], { now: NOW });
  const more = buildTerminalBriefSidecarReviewDecisionIngestor(readyTable(), [{
    type: "request_more_evidence",
    operatorTarget: "round-739",
    reviewReference: "operator-review-745",
  }], { now: NOW });
  const conflict = buildTerminalBriefSidecarReviewDecisionIngestor(readyTable(), [{ type: "conflict" }], { now: NOW });
  const expired = buildTerminalBriefSidecarReviewDecisionIngestor(readyTable(), [{ type: "expired" }], { now: NOW });

  assert.equal(rejected.state, "rejected");
  assert.equal(more.state, "more_evidence_requested");
  assert.equal(conflict.state, "conflicting");
  assert.equal(expired.state, "expired");
  assert.equal(rejected.readiness.executionPermitted, false);
  assert.equal(more.readiness.providerSendPermitted, false);
  assert.equal(conflict.readiness.terminalAckPermitted, false);
  assert.equal(expired.readiness.approvalGrantPermitted, false);
});

test("review decision ingestor waits for unready review table and blocks unsafe drift", () => {
  const waiting = buildTerminalBriefSidecarReviewDecisionIngestor(readyTable({
    state: "waiting_for_adapter_handoff",
    readiness: {
      ...readyTable().readiness,
      reviewTableReady: false,
    },
  }), [], { now: NOW });
  const unsafe = readyTable();
  unsafe.readiness.approvalGrantPermitted = true as false;
  const blocked = buildTerminalBriefSidecarReviewDecisionIngestor(unsafe, [], { now: NOW });

  assert.equal(waiting.state, "waiting_for_operator_review_table");
  assert.equal(waiting.readiness.missingEvidence.includes("ready_operator_review_table"), true);
  assert.equal(blocked.state, "blocked");
  assert.equal(blocked.blockers.some((blocker) => blocker.includes("approval grant")), true);
});

test("review decision ingestor extractors and markdown preserve no-live boundary", () => {
  const table = readyTable();
  const input = {
    operatorReviewTablePacket: table,
    reviewDecisionEvidence: [{
      type: "approve",
      operatorTarget: "round-739",
      reviewReference: "operator-review-745",
      operator_visible_confirmation: true,
    }],
    reviewDecisionIngestor: { max_evidence_age_minutes: 30 },
  };

  assert.equal(extractTerminalBriefSidecarReviewDecisionIngestorTable(input).idempotencyKey, table.idempotencyKey);
  assert.equal(extractTerminalBriefSidecarReviewDecisionEvidence(input).length, 1);
  assert.equal(extractTerminalBriefSidecarReviewDecisionIngestorOptions(input).max_evidence_age_minutes, 30);

  const packet = buildTerminalBriefSidecarReviewDecisionIngestor(
    extractTerminalBriefSidecarReviewDecisionIngestorTable(input),
    extractTerminalBriefSidecarReviewDecisionEvidence(input),
    { ...extractTerminalBriefSidecarReviewDecisionIngestorOptions(input), now: NOW },
  );
  const markdown = renderTerminalBriefSidecarReviewDecisionIngestorMarkdown(packet);

  assert.equal(markdown.includes("does not send approval"), true);
  assert.equal(markdown.includes("terminalAckPermitted=false"), true);
  assert.equal(packet.readiness.approvalGrantPermitted, false);
});
