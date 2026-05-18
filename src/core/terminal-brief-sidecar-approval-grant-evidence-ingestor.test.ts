import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildTerminalBriefSidecarApprovalGrantEvidenceIngestor,
  extractTerminalBriefSidecarApprovalGrantEvidence,
  extractTerminalBriefSidecarApprovalGrantEvidenceIngestorOptions,
  extractTerminalBriefSidecarApprovalGrantEvidenceIngestorProposal,
  renderTerminalBriefSidecarApprovalGrantEvidenceIngestorMarkdown,
} from "./terminal-brief-sidecar-approval-grant-evidence-ingestor.js";

const NOW = "2026-05-19T02:45:00.000Z";

function fixtureInput() {
  return JSON.parse(readFileSync("fixtures/terminal-brief/sidecar-approval-grant-evidence-ingestor.no-live.json", "utf8"));
}

test("approval grant evidence ingestor accepts operator-visible grant evidence without executing grant", () => {
  const input = fixtureInput();
  const packet = buildTerminalBriefSidecarApprovalGrantEvidenceIngestor(
    extractTerminalBriefSidecarApprovalGrantEvidenceIngestorProposal(input),
    extractTerminalBriefSidecarApprovalGrantEvidence(input),
    { ...extractTerminalBriefSidecarApprovalGrantEvidenceIngestorOptions(input), now: NOW },
  );

  assert.equal(packet.kind, "a2a-broker.terminal-brief-sidecar-approval-grant-evidence-ingestor.packet");
  assert.equal(packet.state, "grant_evidence_accepted");
  assert.equal(packet.grantEvidence.acceptedGrantEvidence, true);
  assert.equal(packet.readiness.grantEvidenceAccepted, true);
  assert.equal(packet.readiness.approvalGrantPermitted, false);
  assert.equal(packet.readiness.approvalGrantExecutionPermitted, false);
  assert.equal(packet.readiness.startExecutorDispatchPermitted, false);
  assert.equal(packet.readiness.executorInvocationPermitted, false);
  assert.equal(packet.readiness.processSpawnPermitted, false);
  assert.equal(packet.readiness.sidecarStartPermitted, false);
  assert.equal(packet.readiness.providerSendPermitted, false);
  assert.equal(packet.readiness.terminalAckPermitted, false);
  assert.equal(packet.readiness.executionPermitted, false);
  assert.equal(packet.integrationContract.classifiesGrantEvidence, true);
  assert.equal(packet.integrationContract.grantsApproval, false);
  assert.equal(packet.integrationContract.executesApprovalGrant, false);
  assert.equal(packet.integrationContract.startsSidecar, false);
  assert.equal(packet.semantics.acceptedGrantEvidenceDoesNotExecuteGrant, true);
  assert.equal(packet.semantics.acceptedGrantEvidenceDoesNotAuthorizeRuntime, true);
});

test("approval grant evidence ingestor rejects provider accepted as grant evidence", () => {
  const input = fixtureInput();
  const proposal = extractTerminalBriefSidecarApprovalGrantEvidenceIngestorProposal(input);
  const packet = buildTerminalBriefSidecarApprovalGrantEvidenceIngestor(proposal, [{
    type: "provider_accepted",
    grantReference: "grant-proposal-747",
    operatorTarget: "round-739",
    reviewReference: "operator-review-745",
    observedAt: NOW,
  }], { now: NOW });

  assert.equal(packet.state, "insufficient");
  assert.equal(packet.grantEvidence.providerAcceptedOnly, true);
  assert.equal(packet.grantEvidence.acceptedGrantEvidence, false);
  assert.equal(packet.grantEvidence.normalized[0].classification, "insufficient");
  assert.equal(packet.semantics.providerAcceptedIsApprovalEvidence, false);
});

test("approval grant evidence ingestor classifies rejection more-evidence conflict and expired", () => {
  const proposal = extractTerminalBriefSidecarApprovalGrantEvidenceIngestorProposal(fixtureInput());
  const rejected = buildTerminalBriefSidecarApprovalGrantEvidenceIngestor(proposal, [{
    type: "grant_rejected",
    grantReference: "grant-proposal-747",
    operatorTarget: "round-739",
    reviewReference: "operator-review-745",
  }], { now: NOW });
  const more = buildTerminalBriefSidecarApprovalGrantEvidenceIngestor(proposal, [{
    type: "request_more_evidence",
    grantReference: "grant-proposal-747",
    operatorTarget: "round-739",
    reviewReference: "operator-review-745",
  }], { now: NOW });
  const conflict = buildTerminalBriefSidecarApprovalGrantEvidenceIngestor(proposal, [{ type: "conflict" }], { now: NOW });
  const expired = buildTerminalBriefSidecarApprovalGrantEvidenceIngestor(proposal, [{ type: "expired" }], { now: NOW });

  assert.equal(rejected.state, "grant_rejected");
  assert.equal(more.state, "more_evidence_requested");
  assert.equal(conflict.state, "conflicting");
  assert.equal(expired.state, "expired");
  assert.equal(rejected.readiness.approvalGrantExecutionPermitted, false);
  assert.equal(more.readiness.providerSendPermitted, false);
  assert.equal(conflict.readiness.terminalAckPermitted, false);
  assert.equal(expired.readiness.executionPermitted, false);
});

test("approval grant evidence ingestor waits for unready proposal and blocks unsafe drift", () => {
  const proposal = extractTerminalBriefSidecarApprovalGrantEvidenceIngestorProposal(fixtureInput());
  const waiting = buildTerminalBriefSidecarApprovalGrantEvidenceIngestor({
    ...proposal,
    state: "waiting_for_review_decision",
    readiness: { ...proposal.readiness, grantProposalReady: false },
  }, [], { now: NOW });
  const unsafe = structuredClone(proposal);
  unsafe.readiness.approvalGrantExecutionPermitted = true as false;
  const blocked = buildTerminalBriefSidecarApprovalGrantEvidenceIngestor(unsafe, [], { now: NOW });

  assert.equal(waiting.state, "waiting_for_grant_proposal");
  assert.equal(waiting.readiness.missingEvidence.includes("ready_grant_proposal"), true);
  assert.equal(blocked.state, "blocked");
  assert.equal(blocked.blockers.some((blocker) => blocker.includes("grant execution")), true);
});

test("approval grant evidence ingestor extractors and markdown preserve no-live boundary", () => {
  const input = fixtureInput();
  assert.equal(extractTerminalBriefSidecarApprovalGrantEvidenceIngestorProposal(input).grantProposal.grantReference, "grant-proposal-747");
  assert.equal(extractTerminalBriefSidecarApprovalGrantEvidence(input).length, 1);
  assert.equal(extractTerminalBriefSidecarApprovalGrantEvidenceIngestorOptions(input).maxEvidenceAgeMinutes, 60);

  const packet = buildTerminalBriefSidecarApprovalGrantEvidenceIngestor(
    extractTerminalBriefSidecarApprovalGrantEvidenceIngestorProposal(input),
    extractTerminalBriefSidecarApprovalGrantEvidence(input),
    { ...extractTerminalBriefSidecarApprovalGrantEvidenceIngestorOptions(input), now: NOW },
  );
  const markdown = renderTerminalBriefSidecarApprovalGrantEvidenceIngestorMarkdown(packet);

  assert.equal(markdown.includes("does not send approval"), true);
  assert.equal(markdown.includes("approvalGrantPermitted=false"), true);
  assert.equal(packet.readiness.approvalGrantPermitted, false);
});
