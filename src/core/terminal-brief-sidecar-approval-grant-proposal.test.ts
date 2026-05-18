import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildTerminalBriefSidecarReviewDecisionIngestor,
  extractTerminalBriefSidecarReviewDecisionEvidence,
  extractTerminalBriefSidecarReviewDecisionIngestorOptions,
  extractTerminalBriefSidecarReviewDecisionIngestorTable,
  type TerminalBriefSidecarReviewDecisionIngestorPacket,
} from "./terminal-brief-sidecar-review-decision-ingestor.js";
import {
  buildTerminalBriefSidecarApprovalGrantProposal,
  extractTerminalBriefSidecarApprovalGrantProposalOptions,
  extractTerminalBriefSidecarApprovalGrantProposalReviewDecision,
  renderTerminalBriefSidecarApprovalGrantProposalMarkdown,
} from "./terminal-brief-sidecar-approval-grant-proposal.js";

const NOW = "2026-05-19T02:10:00.000Z";

function acceptedReviewDecision(
  overrides: Partial<TerminalBriefSidecarReviewDecisionIngestorPacket> = {},
): TerminalBriefSidecarReviewDecisionIngestorPacket {
  const fixture = JSON.parse(readFileSync("fixtures/terminal-brief/sidecar-review-decision-ingestor.no-live.json", "utf8"));
  const packet = buildTerminalBriefSidecarReviewDecisionIngestor(
    extractTerminalBriefSidecarReviewDecisionIngestorTable(fixture),
    extractTerminalBriefSidecarReviewDecisionEvidence(fixture),
    { ...extractTerminalBriefSidecarReviewDecisionIngestorOptions(fixture), now: NOW },
  );
  return { ...packet, ...overrides } as TerminalBriefSidecarReviewDecisionIngestorPacket;
}

test("approval grant proposal prepares grant metadata without granting approval", () => {
  const packet = buildTerminalBriefSidecarApprovalGrantProposal(acceptedReviewDecision(), {
    now: NOW,
    grantOwner: "seoseo",
    grantReference: "grant-proposal-747",
  });

  assert.equal(packet.kind, "a2a-broker.terminal-brief-sidecar-approval-grant-proposal.packet");
  assert.equal(packet.state, "ready_for_grant_proposal_review");
  assert.equal(packet.readiness.grantProposalReady, true);
  assert.equal(packet.grantProposal.proposalOnly, true);
  assert.equal(packet.grantProposal.grantWouldRemainSeparateAction, true);
  assert.equal(packet.readiness.approvalRequestDispatchPermitted, false);
  assert.equal(packet.readiness.approvalGrantPermitted, false);
  assert.equal(packet.readiness.approvalGrantExecutionPermitted, false);
  assert.equal(packet.readiness.startExecutorDispatchPermitted, false);
  assert.equal(packet.readiness.executorInvocationPermitted, false);
  assert.equal(packet.readiness.processSpawnPermitted, false);
  assert.equal(packet.readiness.sidecarStartPermitted, false);
  assert.equal(packet.readiness.providerSendPermitted, false);
  assert.equal(packet.readiness.terminalAckPermitted, false);
  assert.equal(packet.readiness.executionPermitted, false);
  assert.equal(packet.readiness.dbMutationPermitted, false);
  assert.equal(packet.integrationContract.preparesGrantProposal, true);
  assert.equal(packet.integrationContract.grantsApproval, false);
  assert.equal(packet.integrationContract.executesApprovalGrant, false);
  assert.equal(packet.integrationContract.invokesExecutor, false);
  assert.equal(packet.integrationContract.startsSidecar, false);
  assert.equal(packet.semantics.proposalDoesNotGrantApproval, true);
  assert.equal(packet.semantics.approvalGrantRequiresSeparateOperatorAction, true);
});

test("approval grant proposal waits on rejected missing stale and conflicting review decisions", () => {
  const base = acceptedReviewDecision();
  const rejected = buildTerminalBriefSidecarApprovalGrantProposal({
    ...base,
    state: "rejected",
    readiness: { ...base.readiness, reviewDecisionEvidenceAccepted: false },
  }, { now: NOW });
  const more = buildTerminalBriefSidecarApprovalGrantProposal({
    ...base,
    state: "more_evidence_requested",
    readiness: { ...base.readiness, reviewDecisionEvidenceAccepted: false },
  }, { now: NOW });
  const stale = buildTerminalBriefSidecarApprovalGrantProposal({
    ...base,
    state: "stale",
    readiness: { ...base.readiness, reviewDecisionEvidenceAccepted: false },
  }, { now: NOW });
  const conflict = buildTerminalBriefSidecarApprovalGrantProposal({
    ...base,
    state: "conflicting",
    readiness: { ...base.readiness, reviewDecisionEvidenceAccepted: false },
  }, { now: NOW });
  const waiting = buildTerminalBriefSidecarApprovalGrantProposal({
    ...base,
    state: "insufficient",
    readiness: { ...base.readiness, reviewDecisionEvidenceAccepted: false },
  }, { now: NOW });

  assert.equal(rejected.state, "rejected");
  assert.equal(more.state, "more_evidence_requested");
  assert.equal(stale.state, "stale");
  assert.equal(conflict.state, "conflicting");
  assert.equal(waiting.state, "waiting_for_review_decision");
  assert.equal(waiting.readiness.missingEvidence.includes("accepted_review_decision"), true);
  assert.equal(rejected.readiness.approvalGrantPermitted, false);
  assert.equal(more.readiness.providerSendPermitted, false);
  assert.equal(stale.readiness.terminalAckPermitted, false);
  assert.equal(conflict.readiness.executionPermitted, false);
});

test("approval grant proposal blocks unsafe source drift", () => {
  const unsafe = acceptedReviewDecision();
  unsafe.readiness.approvalGrantPermitted = true as false;
  const packet = buildTerminalBriefSidecarApprovalGrantProposal(unsafe, { now: NOW });

  assert.equal(packet.state, "blocked");
  assert.equal(packet.blockers.some((blocker) => blocker.includes("approval grant")), true);
  assert.equal(packet.readiness.approvalGrantExecutionPermitted, false);
});

test("approval grant proposal extractors and markdown preserve no-live boundary", () => {
  const reviewDecision = acceptedReviewDecision();
  const input = {
    reviewDecisionIngestorPacket: reviewDecision,
    approvalGrantProposal: {
      grant_owner: "seoseo",
      grant_reference: "grant-proposal-747",
    },
  };

  assert.equal(extractTerminalBriefSidecarApprovalGrantProposalReviewDecision(input).idempotencyKey, reviewDecision.idempotencyKey);
  assert.equal(extractTerminalBriefSidecarApprovalGrantProposalOptions(input).grant_reference, "grant-proposal-747");

  const packet = buildTerminalBriefSidecarApprovalGrantProposal(
    extractTerminalBriefSidecarApprovalGrantProposalReviewDecision(input),
    { ...extractTerminalBriefSidecarApprovalGrantProposalOptions(input), now: NOW },
  );
  const markdown = renderTerminalBriefSidecarApprovalGrantProposalMarkdown(packet);

  assert.equal(markdown.includes("does not send approval"), true);
  assert.equal(markdown.includes("approvalGrantPermitted=false"), true);
  assert.equal(packet.readiness.approvalGrantPermitted, false);
});
