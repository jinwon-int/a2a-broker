import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSourcePublicExecutionPlanBundle,
  renderSourcePublicExecutionPlanMarkdown,
} from "./source-public-execution-orchestrator.js";

const approvedEvidencePacket = {
  packetId: "approval-packet-abc123",
  intentId: "approval-intent-abc123",
  idempotencyKey: "source-public-approval-abc123",
  evidenceBundleId: "evidence-bundle-abc123",
  decision: "GO_CANDIDATE" as const,
  approvedBy: "operator-required",
  approvedAt: "2026-05-11T02:32:07.000Z",
};

const scannerHistory = {
  scannerRunId: "public-readiness-scan-20260511T023207Z",
  scannerDigest: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  historyCursor: "history-cursor-486",
  historyDigest: "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
};

const passingPreflights = {
  evidencePacketApproved: "pass" as const,
  scannerHistoryBound: "pass" as const,
  bootstrapContextExcluded: "pass" as const,
  rollbackAbortRunbookPresent: "pass" as const,
  explicitOperatorGatePresent: "pass" as const,
};

test("source-public execution plan is deterministic, dry-run only, and operator gated", () => {
  const options = {
    generatedAt: "2026-05-11T02:32:07.000Z",
    runId: "a2a-source-public-execution-orchestrator-20260511T023207Z",
    worker: "dungae",
    approvedEvidencePacket,
    scannerHistory,
    preflights: passingPreflights,
  };

  const first = buildSourcePublicExecutionPlanBundle(options);
  const second = buildSourcePublicExecutionPlanBundle(options);

  assert.deepEqual(second.finalApprovalPacket, first.finalApprovalPacket);
  assert.deepEqual(second.ledgerEntry, first.ledgerEntry);
  assert.equal(first.kind, "a2a-broker.source-public-final-approval-execution-plan");
  assert.equal(first.runMode, "dry-run");
  assert.equal(first.finalApprovalPacket.status, "approval-ready-not-executed");
  assert.equal(first.finalApprovalPacket.operatorApprovalRequired, true);
  assert.equal(first.finalApprovalPacket.explicitOperatorGate, true);
  assert.equal(first.finalApprovalPacket.executionAllowed, false);
  assert.equal(first.finalApprovalPacket.mutationAllowed, false);
  assert.equal(first.ledgerEntry.persistence, "not-written");
  assert.equal(first.ledgerEntry.mutationAttempted, false);
  assert.equal(first.goNoGoGateLedger.length, Object.keys(passingPreflights).length);
  assert.deepEqual(first.goNoGoGateLedger.map((entry) => entry.effect), [
    "allow-review",
    "allow-review",
    "allow-review",
    "allow-review",
    "allow-review",
  ]);
  assert.equal(first.approvalIntentRecord.approvalIntentId, first.finalApprovalPacket.executionIntentId);
  assert.equal(first.approvalIntentRecord.approvalIdempotencyKey, first.finalApprovalPacket.executionIdempotencyKey);
  assert.equal(first.approvalIntentRecord.explicitOperatorApprovalPresent, true);
  assert.equal(first.approvalIntentRecord.persistence, "not-written");
  assert.equal(first.approvalIntentRecord.mutationAttempted, false);
  assert.equal(first.scannerHistoryBinding.bound, true);
  assert.equal(first.preflight.ok, true);
  assert.equal(first.safety.liveActionAllowed, false);
  assert.equal(first.decision.value, "READY_FOR_OPERATOR_APPROVAL");
});

test("source-public execution plan fails closed on preflight failures and missing scanner history", () => {
  const blocked = buildSourcePublicExecutionPlanBundle({
    generatedAt: "2026-05-11T02:32:07.000Z",
    approvedEvidencePacket,
    scannerHistory: { ...scannerHistory, scannerDigest: undefined },
    preflights: {
      ...passingPreflights,
      bootstrapContextExcluded: "fail",
    },
  });

  assert.equal(blocked.preflight.ok, false);
  assert.equal(blocked.finalApprovalPacket.status, "blocked-not-executed");
  assert.equal(blocked.scannerHistoryBinding.bound, false);
  assert.deepEqual(blocked.preflight.failures, ["bootstrapContextExcluded", "scannerHistoryBound"]);
  assert.equal(blocked.decision.value, "PREFLIGHT_BLOCKED");
  assert.match(blocked.preflight.semantics, /fail-closed/);
  assert.equal(blocked.goNoGoGateLedger.find((entry) => entry.gate === "bootstrapContextExcluded")?.effect, "block-execution");
  assert.equal(blocked.goNoGoGateLedger.find((entry) => entry.gate === "scannerHistoryBound")?.effect, "block-execution");
  assert.equal(blocked.approvalIntentRecord.decision, "PREFLIGHT_BLOCKED");
  assert.equal(blocked.finalApprovalPacket.executionAllowed, false);
});

test("source-public execution plan suppresses replay without writing duplicate ledger entries", () => {
  const first = buildSourcePublicExecutionPlanBundle({
    generatedAt: "2026-05-11T02:32:07.000Z",
    approvedEvidencePacket,
    scannerHistory,
    preflights: passingPreflights,
  });
  const replay = buildSourcePublicExecutionPlanBundle({
    generatedAt: "2026-05-11T02:32:07.000Z",
    approvedEvidencePacket,
    scannerHistory,
    preflights: passingPreflights,
    priorExecutionKeys: [first.finalApprovalPacket.executionIdempotencyKey],
  });

  assert.equal(replay.finalApprovalPacket.executionIdempotencyKey, first.finalApprovalPacket.executionIdempotencyKey);
  assert.equal(replay.finalApprovalPacket.status, "replay-suppressed-not-executed");
  assert.equal(replay.ledgerEntry.replay, true);
  assert.equal(replay.ledgerEntry.persistence, "not-written");
  assert.equal(replay.ledgerEntry.mutationAttempted, false);
  assert.equal(replay.decision.value, "REPLAY_SUPPRESSED");
});

test("source-public execution plan markdown is sanitized and names abort semantics", () => {
  const bundle = buildSourcePublicExecutionPlanBundle({
    generatedAt: "2026-05-11T02:32:07.000Z",
    approvedEvidencePacket,
    scannerHistory,
    preflights: passingPreflights,
    runMode: "simulate",
  });
  const markdown = renderSourcePublicExecutionPlanMarkdown(bundle);

  assert.match(markdown, /^# Source-public final approval execution plan: READY_FOR_OPERATOR_APPROVAL/);
  assert.match(markdown, /Mode: simulate/);
  assert.match(markdown, /executionAllowed: false/);
  assert.match(markdown, /mutationAllowed: false/);
  assert.match(markdown, /Abort immediately/);
  assert.match(markdown, /scannerDigest: sha256:/);
  assert.match(markdown, /Final go\/no-go gate ledger/);
  assert.match(markdown, /Approval intent record/);
  assert.match(markdown, /explicitOperatorApprovalPresent: true/);
  assert.doesNotMatch(markdown, /rawPrompt|rawLogs|secret value|private path|AGENTS\.md|SOUL\.md|USER\.md|TOOLS\.md|HEARTBEAT\.md|IDENTITY\.md|\.openclaw/i);
});
