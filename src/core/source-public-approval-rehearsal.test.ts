import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSourcePublicApprovalRehearsalBundle,
  renderSourcePublicApprovalRehearsalMarkdown,
} from "./source-public-approval-rehearsal.js";

test("source-public approval rehearsal produces deterministic no-live approval packets", () => {
  const options = {
    generatedAt: "2026-05-11T01:42:40.000Z",
    runId: "a2a-source-public-approval-rehearsal-20260511T014240Z",
    worker: "dungae",
    evidence: {
      publicReadinessScan: "pass" as const,
      bootstrapContextExcluded: "pass" as const,
      localTests: "pass" as const,
      licenseDecision: "pass" as const,
      externalScannerEvidence: "warn" as const,
      explicitOperatorApproval: "pending" as const,
    },
  };

  const first = buildSourcePublicApprovalRehearsalBundle(options);
  const second = buildSourcePublicApprovalRehearsalBundle(options);

  assert.deepEqual(second.approvalPacket, first.approvalPacket);
  assert.equal(first.kind, "a2a-broker.source-public-approval-rehearsal");
  assert.equal(first.runMode, "read-only-no-live");
  assert.equal(first.worker, "dungae");
  assert.equal(first.sourceIssue.issueNumber, 484);
  assert.equal(first.approvalPacket.status, "rehearsed-not-executed");
  assert.equal(first.approvalPacket.executionAllowed, false);
  assert.equal(first.approvalPacket.operatorApprovalRequired, true);
  assert.equal(first.approvalIntentRehearsalRecord.persistence, "not-written");
  assert.equal(first.approvalIntentRehearsalRecord.mutationAttempted, false);
  assert.equal(first.evidenceBundle.terminalBriefRehearsal.liveProviderSendAttempted, false);
  assert.equal(first.evidenceBundle.terminalBriefRehearsal.terminalAckAttempted, false);
  assert.equal(first.safety.approvalExecution, false);
  assert.equal(first.safety.secretOrVisibilityChange, false);
  assert.equal(first.decision.value, "NEEDS_OPERATOR_APPROVAL");
});

test("source-public approval rehearsal marks replay as duplicate without mutating", () => {
  const first = buildSourcePublicApprovalRehearsalBundle({
    generatedAt: "2026-05-11T01:42:40.000Z",
    approvalIntentId: "intent-source-public-1",
  });
  const replay = buildSourcePublicApprovalRehearsalBundle({
    generatedAt: "2026-05-11T01:42:40.000Z",
    approvalIntentId: "intent-source-public-1",
    priorApprovalIntentIds: ["intent-source-public-1"],
  });

  assert.equal(replay.approvalPacket.intentId, first.approvalPacket.intentId);
  assert.equal(replay.approvalIntentRehearsalRecord.duplicate, true);
  assert.equal(replay.approvalIntentRehearsalRecord.duplicateOf, "intent-source-public-1");
  assert.equal(replay.approvalIntentRehearsalRecord.mutationAttempted, false);
  assert.match(replay.approvalIntentRehearsalRecord.replayProof, /without writing/);
});

test("source-public approval rehearsal decisions fail closed", () => {
  const noGo = buildSourcePublicApprovalRehearsalBundle({
    evidence: {
      bootstrapContextExcluded: "fail",
      explicitOperatorApproval: "pass",
    },
  });
  const goCandidate = buildSourcePublicApprovalRehearsalBundle({
    evidence: {
      publicReadinessScan: "pass",
      bootstrapContextExcluded: "pass",
      localTests: "pass",
      licenseDecision: "pass",
      externalScannerEvidence: "pass",
      explicitOperatorApproval: "pass",
    },
  });

  assert.equal(noGo.decision.value, "NO_GO");
  assert.match(noGo.decision.reasons.join("\n"), /bootstrapContextExcluded/);
  assert.equal(goCandidate.decision.value, "GO_CANDIDATE");
  assert.equal(goCandidate.approvalPacket.executionAllowed, false);
});

test("source-public approval rehearsal markdown is sanitized and operator-readable", () => {
  const bundle = buildSourcePublicApprovalRehearsalBundle({ generatedAt: "2026-05-11T01:42:40.000Z" });
  const markdown = renderSourcePublicApprovalRehearsalMarkdown(bundle);

  assert.match(markdown, /^# Source-public approval rehearsal: NEEDS_OPERATOR_APPROVAL/);
  assert.match(markdown, /liveProviderSendAttempted: false/);
  assert.match(markdown, /terminalAckAttempted: false/);
  assert.match(markdown, /persistence: not-written/);
  assert.match(markdown, /mutationAttempted: false/);
  assert.doesNotMatch(markdown, /rawPrompt|rawLogs|secret value|private path/i);
});
