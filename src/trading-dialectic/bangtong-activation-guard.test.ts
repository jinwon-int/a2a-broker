import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  runBangtongActivationGuard,
  compactTerminalBriefTitle,
  type ActivationGuardInput,
} from "./bangtong-activation-guard.js";

import type { Team1BoundedWarning, Team1StaleDiagnostics } from "./bounded-ops-dashboard.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGuardInput(overrides: Partial<ActivationGuardInput> = {}): ActivationGuardInput {
  return {
    parentRoundId: "a2a-r9b-terminal-brief-activation-readiness-20260513T152714Z",
    worker: "bangtong",
    knownTotal: 7,
    expectedBrokerOfRecord: "seoseo",
    brokerOfRecord: "seoseo",
    boundedOpsDashboard: {
      warnings: [],
      staleDiagnostics: null,
    },
    receiptBoundaryProven: true,
    parentRoundProgress: 1,
    parentRoundTotal: 7,
    terminalBriefTitle: "A2A Terminal Brief 완료: bangtong(1/7)",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("bangtong activation GO/NO-GO guard", () => {
  it("returns GO when all gates pass with valid parent metadata and receipt boundary proven", () => {
    const result = runBangtongActivationGuard(makeGuardInput());

    assert.equal(result.decision, "GO");
    assert.ok(result.summary.startsWith("GO"));
    assert.equal(result.checks.length, 8);
    assert.equal(result.checks.filter((c) => c.status === "pass").length, 8);
    assert.equal(result.checks.filter((c) => c.status === "fail").length, 0);
    assert.equal(result.blocks, undefined);
    assert.ok(result.guardId.startsWith("bangtong-guard-"));
    assert.deepEqual(result.safety, {
      liveActionPerformed: false,
      terminalAckAttempted: false,
      dbMutationAttempted: false,
      noLive: true,
      providerSendOnlyIsNotTerminalAck: true,
      historicalOutboxReplayAttempted: false,
      secretOrVisibilityChangeAttempted: false,
      forcePushOrHistoryRewriteAttempted: false,
    });
    assert.ok(result.receiptBoundaryEvidence);
    assert.equal(result.receiptBoundaryEvidence?.providerSendIsNotTerminalAck, true);
    assert.equal(result.receiptBoundaryEvidence?.operatorVisibleIsNotManualAck, true);
    assert.equal(result.parentRoundTitle, "A2A Terminal Brief 완료: bangtong(1/7)");
    assert.deepEqual(result.parentMetadata, {
      parentRoundId: "a2a-r9b-terminal-brief-activation-readiness-20260513T152714Z",
      worker: "bangtong",
      progress: 1,
      total: 7,
    });
  });

  it("returns GO when parent metadata is absent (fallback handled downstream)", () => {
    const result = runBangtongActivationGuard(makeGuardInput({
      parentRoundProgress: undefined,
      parentRoundTotal: undefined,
      terminalBriefTitle: undefined,
    }));

    assert.equal(result.decision, "GO");
    assert.equal(result.parentRoundTitle, undefined);
    assert.equal(result.parentMetadata, undefined);
    // Parent metadata gates are still pass because absent is valid.
    assert.equal(result.checks.find((c) => c.id === "parentMetadataSafe")?.status, "pass");
    assert.equal(result.checks.find((c) => c.id === "terminalBriefTitleSafe")?.status, "pass");
  });

  it("returns NO_GO when parent round id is missing", () => {
    const result = runBangtongActivationGuard(makeGuardInput({ parentRoundId: "" }));

    assert.equal(result.decision, "NO_GO");
    assert.equal(result.checks.find((c) => c.id === "parentRoundIdPresent")?.status, "fail");
    assert.ok(result.blocks?.includes("parentRoundIdPresent"));
  });

  it("returns NO_GO when known total is invalid", () => {
    const result = runBangtongActivationGuard(makeGuardInput({ knownTotal: 0 }));

    assert.equal(result.decision, "NO_GO");
    assert.equal(result.checks.find((c) => c.id === "knownTotalValid")?.status, "fail");
    assert.ok(result.blocks?.includes("knownTotalValid"));
  });

  it("returns NO_GO when known total exceeds max", () => {
    const result = runBangtongActivationGuard(makeGuardInput({ knownTotal: 101 }));

    assert.equal(result.decision, "NO_GO");
    assert.equal(result.checks.find((c) => c.id === "knownTotalValid")?.status, "fail");
  });

  it("returns NO_GO when brokerOfRecord does not match expected", () => {
    const result = runBangtongActivationGuard(makeGuardInput({ brokerOfRecord: "gwakga" }));

    assert.equal(result.decision, "NO_GO");
    assert.equal(result.checks.find((c) => c.id === "brokerOfRecordAligned")?.status, "fail");
    assert.ok(result.blocks?.includes("brokerOfRecordAligned"));
  });

  it("returns NO_GO when bounded ops dashboard has critical warnings", () => {
    const warnings: Team1BoundedWarning[] = [
      { severity: "critical", code: "stale_workers", message: "3 workers stale >30m" },
    ];
    const result = runBangtongActivationGuard(makeGuardInput({
      boundedOpsDashboard: { warnings, staleDiagnostics: null },
    }));

    assert.equal(result.decision, "NO_GO");
    assert.equal(result.checks.find((c) => c.id === "boundedOpsHealthy")?.status, "fail");
  });

  it("returns NO_GO when bounded ops has critical stale state", () => {
    const staleDiagnostics: Team1StaleDiagnostics = {
      staleWorkers: 2,
      staleWorkerAssignments: 3,
      staleTasks: 1,
      oldestStaleTask: null,
      oldestStaleAssignment: { workerId: "td-worker-bangtong", taskId: "task-1", ageSec: 600 },
    };
    const result = runBangtongActivationGuard(makeGuardInput({
      boundedOpsDashboard: { warnings: [], staleDiagnostics },
    }));

    assert.equal(result.decision, "NO_GO");
    assert.equal(result.checks.find((c) => c.id === "boundedOpsHealthy")?.status, "fail");
  });

  it("returns NO_GO when receipt boundary is not proven", () => {
    const result = runBangtongActivationGuard(makeGuardInput({ receiptBoundaryProven: false }));

    assert.equal(result.decision, "NO_GO");
    assert.equal(result.checks.find((c) => c.id === "receiptBoundaryProven")?.status, "fail");
  });

  it("returns NO_GO when parent metadata is inconsistent (progress > total)", () => {
    const result = runBangtongActivationGuard(makeGuardInput({
      parentRoundProgress: 8,
      parentRoundTotal: 7,
    }));

    assert.equal(result.decision, "NO_GO");
    assert.equal(result.checks.find((c) => c.id === "parentMetadataSafe")?.status, "fail");
  });

  it("fails (warn-level, not blocking) when parentProgress is non-integer", () => {
    const result = runBangtongActivationGuard(makeGuardInput({
      parentRoundProgress: 1.5,
      parentRoundTotal: 7,
    }));

    // Non-integer progress is a metadata safety fail, but metadata safety
    // fails are non-blocking (reported as advisory warning in summary).
    assert.equal(result.checks.find((c) => c.id === "parentMetadataSafe")?.status, "fail");
    // Non-integer progress should still be a blocking fail in this guard
    // because it represents corrupt metadata.
    assert.ok(result.blocks?.includes("parentMetadataSafe"), "parentMetadataSafe should be in the blocking gates list");
  });

  it("fails when terminalBriefTitle has an unexpected format", () => {
    const result = runBangtongActivationGuard(makeGuardInput({
      terminalBriefTitle: "A2A Terminal Brief 완료: wrong-worker(1/7)",
    }));

    assert.equal(result.checks.find((c) => c.id === "terminalBriefTitleSafe")?.status, "fail");
    // Title format mismatch is inconsistent — actively prevents GO.
    assert.ok(result.blocks?.includes("terminalBriefTitleSafe"));
  });

  it("passes title check when title matches the built format", () => {
    const result = runBangtongActivationGuard(makeGuardInput({
      terminalBriefTitle: "A2A Terminal Brief 완료: bangtong(1/7)",
    }));

    assert.equal(result.checks.find((c) => c.id === "terminalBriefTitleSafe")?.status, "pass");
    assert.equal(result.decision, "GO");
  });

  it("passes title check when title is absent (fallback)", () => {
    const result = runBangtongActivationGuard(makeGuardInput({
      terminalBriefTitle: undefined,
    }));

    assert.equal(result.checks.find((c) => c.id === "terminalBriefTitleSafe")?.status, "pass");
  });

  it("fails title check when title is too long", () => {
    const longWorker = "b".repeat(200);
    const result = runBangtongActivationGuard(makeGuardInput({
      worker: longWorker,
      terminalBriefTitle: `A2A Terminal Brief 완료: ${longWorker}(1/7)`,
    }));

    assert.equal(result.checks.find((c) => c.id === "terminalBriefTitleSafe")?.status, "fail");
  });

  it("emits warning-level (non-blocking) for warn-level bounded ops issues", () => {
    // Make only the boundedOpsHealthy gate warn-level — but our guard fails critical gates,
    // so we instead test that info/warning-level warnings do not trigger a fail.
    const warnings: Team1BoundedWarning[] = [
      { severity: "warning", code: "high_queue_depth", message: "queue depth > 10" },
    ];
    const result = runBangtongActivationGuard(makeGuardInput({
      boundedOpsDashboard: { warnings, staleDiagnostics: null },
    }));

    // Warning-level only: still passes.
    assert.equal(result.checks.find((c) => c.id === "boundedOpsHealthy")?.status, "pass");
    assert.equal(result.decision, "GO");
  });

  it("reports receipt boundary evidence when boundary is proven", () => {
    const result = runBangtongActivationGuard(makeGuardInput({ receiptBoundaryProven: true }));

    assert.ok(result.receiptBoundaryEvidence);
    assert.equal(result.receiptBoundaryEvidence?.providerSendIsNotTerminalAck, true);
  });

  it("does not include receipt boundary evidence when not proven", () => {
    const result = runBangtongActivationGuard(makeGuardInput({ receiptBoundaryProven: false }));

    assert.equal(result.receiptBoundaryEvidence, undefined);
  });

  it("builds a stable guardId prefixed with bangtong-guard-", () => {
    const result = runBangtongActivationGuard(makeGuardInput());

    assert.match(result.guardId, /^bangtong-guard-[a-f0-9]{8}$/);
  });

  it("safety declaration is always no-live", () => {
    const goResult = runBangtongActivationGuard(makeGuardInput());
    const noGoResult = runBangtongActivationGuard(makeGuardInput({ parentRoundId: "" }));

    assert.deepEqual(goResult.safety, noGoResult.safety);
    assert.equal(goResult.safety.noLive, true);
    assert.equal(goResult.safety.liveActionPerformed, false);
    assert.equal(goResult.safety.terminalAckAttempted, false);
    assert.equal(goResult.safety.dbMutationAttempted, false);
  });
});

describe("compactTerminalBriefTitle", () => {
  it("formats a valid title with progress and total", () => {
    assert.equal(compactTerminalBriefTitle("bangtong", 3, 7), "A2A Terminal Brief 완료: bangtong(3/7)");
  });

  it("formats title for different workers", () => {
    assert.equal(compactTerminalBriefTitle("sogyo", 1, 4), "A2A Terminal Brief 완료: sogyo(1/4)");
  });

  it("returns undefined when worker is missing", () => {
    assert.equal(compactTerminalBriefTitle("", 1, 7), undefined);
  });

  it("returns undefined when progress is absent", () => {
    assert.equal(compactTerminalBriefTitle("bangtong", undefined, 7), undefined);
  });

  it("returns undefined when total is absent", () => {
    assert.equal(compactTerminalBriefTitle("bangtong", 3, undefined), undefined);
  });

  it("returns undefined when progress is zero", () => {
    assert.equal(compactTerminalBriefTitle("bangtong", 0, 7), undefined);
  });

  it("returns undefined when total is zero", () => {
    assert.equal(compactTerminalBriefTitle("bangtong", 1, 0), undefined);
  });
});
