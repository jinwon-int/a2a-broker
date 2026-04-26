/**
 * Handoff scenario matrix tests (issue #69).
 *
 * Covers:
 *   - S1–S5 classification correctness
 *   - Phase transition state machine
 *   - Recovery ledger sealing + summary
 *   - Duplicate detection (idempotency)
 *   - Recovery chain tracking
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyHandoff,
  expectedOutcome,
  shouldAutoRetry,
  shouldEscalate,
  createHandoffRecord,
  transitionPhase,
  RecoveryLedger,
} from "./handoff-scenarios.js";
import type { HandoffContext, HandoffScenarioId, HandoffOutcome } from "./handoff-types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function baseCtx(overrides?: Partial<HandoffContext>): HandoffContext {
  return {
    senderNodeId: "node-a",
    receiverNodeId: "node-b",
    idempotencyKey: "h-001",
    receiverReachable: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// S1: Normal handoff classification
// ---------------------------------------------------------------------------

describe("S1 normal handoff", () => {
  it("classifies default context as S1", () => {
    assert.equal(classifyHandoff(baseCtx()), "S1_normal");
  });

  it("expected outcome is delivered", () => {
    assert.equal(expectedOutcome("S1_normal"), "delivered");
  });

  it("should not auto-retry", () => {
    assert.equal(shouldAutoRetry("S1_normal"), false);
  });

  it("should not escalate", () => {
    assert.equal(shouldEscalate("S1_normal"), false);
  });
});

// ---------------------------------------------------------------------------
// S2: Receiver unavailable
// ---------------------------------------------------------------------------

describe("S2 receiver unavailable", () => {
  it("classifies when receiver is unreachable", () => {
    assert.equal(classifyHandoff(baseCtx({ receiverReachable: false })), "S2_receiver_unavailable");
  });

  it("classifies on receiver_rejected previous failure", () => {
    assert.equal(
      classifyHandoff(baseCtx({ previousFailureKind: "receiver_rejected" })),
      "S2_receiver_unavailable",
    );
  });

  it("classifies on receiver_unreachable previous failure", () => {
    assert.equal(
      classifyHandoff(baseCtx({ previousFailureKind: "receiver_unreachable" })),
      "S2_receiver_unavailable",
    );
  });

  it("expected outcome is rejected", () => {
    assert.equal(expectedOutcome("S2_receiver_unavailable"), "rejected");
  });

  it("should auto-retry", () => {
    assert.equal(shouldAutoRetry("S2_receiver_unavailable"), true);
  });

  it("should escalate", () => {
    assert.equal(shouldEscalate("S2_receiver_unavailable"), true);
  });
});

// ---------------------------------------------------------------------------
// S3: Sender crash
// ---------------------------------------------------------------------------

describe("S3 sender crash", () => {
  it("classifies when sender crashed", () => {
    assert.equal(classifyHandoff(baseCtx({ senderCrashed: true })), "S3_sender_crash");
  });

  it("classifies on sender_crash previous failure", () => {
    assert.equal(
      classifyHandoff(baseCtx({ previousFailureKind: "sender_crash" })),
      "S3_sender_crash",
    );
  });

  it("expected outcome is partial", () => {
    assert.equal(expectedOutcome("S3_sender_crash"), "partial");
  });

  it("should auto-retry", () => {
    assert.equal(shouldAutoRetry("S3_sender_crash"), true);
  });

  it("creates partial snapshot on crash", () => {
    const record = createHandoffRecord(baseCtx({ senderCrashed: true }));
    assert.ok(record.partialSnapshot);
    assert.ok(record.partialSnapshot!.includes("crashed"));
  });

  it("should escalate", () => {
    assert.equal(shouldEscalate("S3_sender_crash"), true);
  });
});

// ---------------------------------------------------------------------------
// S4: Duplicate detection
// ---------------------------------------------------------------------------

describe("S4 duplicate handoff", () => {
  it("classifies when duplicateOf is set", () => {
    assert.equal(classifyHandoff(baseCtx({ duplicateOf: "existing-id" })), "S4_duplicate");
  });

  it("takes priority over receiver unavailability", () => {
    assert.equal(
      classifyHandoff(baseCtx({ duplicateOf: "x", receiverReachable: false })),
      "S4_duplicate",
    );
  });

  it("expected outcome is deduplicated", () => {
    assert.equal(expectedOutcome("S4_duplicate"), "deduplicated");
  });

  it("should not auto-retry", () => {
    assert.equal(shouldAutoRetry("S4_duplicate"), false);
  });

  it("should escalate", () => {
    assert.equal(shouldEscalate("S4_duplicate"), true);
  });
});

// ---------------------------------------------------------------------------
// S5: Recovery handoff
// ---------------------------------------------------------------------------

describe("S5 recovery handoff", () => {
  it("classifies when recoveryOf is set", () => {
    assert.equal(classifyHandoff(baseCtx({ recoveryOf: "failed-id" })), "S5_recovery");
  });

  it("takes priority over receiver unavailability", () => {
    assert.equal(
      classifyHandoff(baseCtx({ recoveryOf: "x", receiverReachable: false })),
      "S5_recovery",
    );
  });

  it("expected outcome is retried", () => {
    assert.equal(expectedOutcome("S5_recovery"), "retried");
  });

  it("should not auto-retry (already a retry)", () => {
    assert.equal(shouldAutoRetry("S5_recovery"), false);
  });

  it("should escalate", () => {
    assert.equal(shouldEscalate("S5_recovery"), true);
  });
});

// ---------------------------------------------------------------------------
// Priority ordering: S4 > S5 > S2 > S3 > S1
// ---------------------------------------------------------------------------

describe("classification priority", () => {
  it("S4 beats S5", () => {
    assert.equal(
      classifyHandoff(baseCtx({ duplicateOf: "x", recoveryOf: "y" })),
      "S4_duplicate",
    );
  });

  it("S5 beats S2", () => {
    assert.equal(
      classifyHandoff(baseCtx({ recoveryOf: "x", receiverReachable: false })),
      "S5_recovery",
    );
  });

  it("S2 beats S3", () => {
    assert.equal(
      classifyHandoff(baseCtx({ receiverReachable: false, senderCrashed: true })),
      "S2_receiver_unavailable",
    );
  });
});

// ---------------------------------------------------------------------------
// Phase transitions
// ---------------------------------------------------------------------------

describe("phase transitions", () => {
  it("initiated → dispatched → acknowledged → completed", () => {
    const r = createHandoffRecord(baseCtx());
    transitionPhase(r, "dispatched");
    assert.equal(r.phase, "dispatched");
    assert.ok(r.dispatchedAt);
    transitionPhase(r, "acknowledged");
    assert.equal(r.phase, "acknowledged");
    assert.ok(r.acknowledgedAt);
    transitionPhase(r, "completed");
    assert.equal(r.phase, "completed");
    assert.ok(r.completedAt);
  });

  it("rejects invalid transitions", () => {
    const r = createHandoffRecord(baseCtx());
    assert.throws(() => transitionPhase(r, "completed"));
  });

  it("dispatched → failed with details", () => {
    const r = createHandoffRecord(baseCtx());
    transitionPhase(r, "dispatched");
    transitionPhase(r, "failed", {
      failureKind: "receiver_unreachable",
      failureMessage: "Connection refused",
    });
    assert.equal(r.phase, "failed");
    assert.equal(r.failureKind, "receiver_unreachable");
    assert.equal(r.failureMessage, "Connection refused");
    assert.ok(r.failedAt);
  });

  it("dispatched → timed_out", () => {
    const r = createHandoffRecord(baseCtx());
    transitionPhase(r, "dispatched");
    transitionPhase(r, "timed_out");
    assert.equal(r.phase, "timed_out");
    assert.equal(r.failureKind, "timeout");
  });

  it("terminal phases reject further transitions", () => {
    for (const terminal of ["completed", "failed", "timed_out", "canceled"] as const) {
      const r = createHandoffRecord(baseCtx());
      transitionPhase(r, "dispatched");
      transitionPhase(r, terminal);
      assert.throws(() => transitionPhase(r, "dispatched"));
    }
  });

  it("seq increments on each transition", () => {
    const r = createHandoffRecord(baseCtx());
    assert.equal(r.seq, 0);
    transitionPhase(r, "dispatched");
    assert.equal(r.seq, 1);
    transitionPhase(r, "acknowledged");
    assert.equal(r.seq, 2);
    transitionPhase(r, "completed");
    assert.equal(r.seq, 3);
  });
});

// ---------------------------------------------------------------------------
// Recovery ledger
// ---------------------------------------------------------------------------

describe("RecoveryLedger", () => {
  it("records and retrieves handoffs", () => {
    const ledger = new RecoveryLedger();
    const r = createHandoffRecord(baseCtx());
    ledger.record(r);
    assert.equal(ledger.getHandoff(r.id)?.id, r.id);
  });

  it("detects duplicates via idempotency key", () => {
    const ledger = new RecoveryLedger();
    const r1 = createHandoffRecord(baseCtx({ idempotencyKey: "key-1" }));
    ledger.record(r1);
    assert.equal(ledger.findDuplicate("key-1"), r1.id);
    assert.equal(ledger.findDuplicate("key-2"), undefined);
  });

  it("seals S1 normal handoff as delivered", () => {
    const ledger = new RecoveryLedger();
    const r = createHandoffRecord(baseCtx());
    ledger.record(r);
    transitionPhase(r, "dispatched");
    transitionPhase(r, "acknowledged");
    transitionPhase(r, "completed");
    const entry = ledger.seal(r.id);
    assert.equal(entry.outcome, "delivered");
    assert.equal(entry.scenarioId, "S1_normal");
    assert.ok(entry.durationMs >= 0);
  });

  it("seals S2 failure as rejected", () => {
    const ledger = new RecoveryLedger();
    const r = createHandoffRecord(baseCtx({ receiverReachable: false }));
    ledger.record(r);
    transitionPhase(r, "dispatched");
    transitionPhase(r, "failed", { failureKind: "receiver_unreachable" });
    const entry = ledger.seal(r.id);
    assert.equal(entry.outcome, "rejected");
    assert.equal(entry.scenarioId, "S2_receiver_unavailable");
  });

  it("seals S3 crash as partial", () => {
    const ledger = new RecoveryLedger();
    const r = createHandoffRecord(baseCtx({ senderCrashed: true }));
    ledger.record(r);
    transitionPhase(r, "dispatched");
    transitionPhase(r, "failed", { failureKind: "sender_crash" });
    const entry = ledger.seal(r.id);
    assert.equal(entry.outcome, "partial");
  });

  it("seals S4 duplicate as deduplicated", () => {
    const ledger = new RecoveryLedger();
    const r = createHandoffRecord(baseCtx({ duplicateOf: "original" }));
    ledger.record(r);
    transitionPhase(r, "dispatched");
    transitionPhase(r, "acknowledged");
    transitionPhase(r, "completed");
    const entry = ledger.seal(r.id);
    assert.equal(entry.outcome, "deduplicated");
  });

  it("seals S5 recovery as retried", () => {
    const ledger = new RecoveryLedger();
    const r = createHandoffRecord(baseCtx({ recoveryOf: "failed-1" }));
    ledger.record(r);
    transitionPhase(r, "dispatched");
    transitionPhase(r, "acknowledged");
    transitionPhase(r, "completed");
    const entry = ledger.seal(r.id);
    assert.equal(entry.outcome, "retried");
  });

  it("summary aggregates correctly", () => {
    const ledger = new RecoveryLedger();

    // S1 success
    const r1 = createHandoffRecord(baseCtx({ idempotencyKey: "s1" }));
    ledger.record(r1);
    transitionPhase(r1, "dispatched");
    transitionPhase(r1, "acknowledged");
    transitionPhase(r1, "completed");
    ledger.seal(r1.id);

    // S2 failure
    const r2 = createHandoffRecord(baseCtx({ idempotencyKey: "s2", receiverReachable: false }));
    ledger.record(r2);
    transitionPhase(r2, "dispatched");
    transitionPhase(r2, "failed", { failureKind: "receiver_unreachable" });
    ledger.seal(r2.id);

    const summary = ledger.summary();
    assert.equal(summary.totalAttempts, 2);
    assert.equal(summary.byScenario.S1_normal, 1);
    assert.equal(summary.byScenario.S2_receiver_unavailable, 1);
    assert.equal(summary.byOutcome.delivered, 1);
    assert.equal(summary.byOutcome.rejected, 1);
    assert.equal(summary.activeCount, 0);
    assert.equal(summary.recoveryCount, 0);
  });

  it("tracks recovery chain by idempotency key", () => {
    const ledger = new RecoveryLedger();

    // Original attempt fails
    const r1 = createHandoffRecord(baseCtx({ idempotencyKey: "chain-1" }));
    ledger.record(r1);
    transitionPhase(r1, "dispatched");
    transitionPhase(r1, "failed", { failureKind: "receiver_unreachable" });
    ledger.seal(r1.id);

    // Retry
    const r2 = createHandoffRecord(baseCtx({
      idempotencyKey: "chain-1",
      recoveryOf: r1.id,
    }));
    ledger.record(r2);
    transitionPhase(r2, "dispatched");
    transitionPhase(r2, "acknowledged");
    transitionPhase(r2, "completed");
    ledger.seal(r2.id);

    const chain = ledger.getByIdempotencyKey("chain-1");
    assert.ok(chain.length >= 1, "chain should contain original");
    assert.equal(chain[0].id, r1.id);

    const summary = ledger.summary();
    assert.equal(summary.recoveryCount, 1);
    assert.ok(summary.avgRecoveryDurationMs >= 0);
  });

  it("getByTask filters correctly", () => {
    const ledger = new RecoveryLedger();
    const r1 = createHandoffRecord(baseCtx({ taskId: "t-1" }));
    const r2 = createHandoffRecord(baseCtx({ taskId: "t-2" }));
    ledger.record(r1);
    ledger.record(r2);
    assert.equal(ledger.getByTask("t-1").length, 1);
    assert.equal(ledger.getByTask("t-2").length, 1);
    assert.equal(ledger.getByTask("t-3").length, 0);
  });

  it("throws on sealing unknown handoff", () => {
    const ledger = new RecoveryLedger();
    assert.throws(() => ledger.seal("nonexistent"));
  });
});

// ---------------------------------------------------------------------------
// Full scenario matrix validation
// ---------------------------------------------------------------------------

describe("handoff scenario matrix", () => {
  const scenarios: Array<{
    id: HandoffScenarioId;
    ctx: HandoffContext;
    outcome: HandoffOutcome;
    autoRetry: boolean;
    escalate: boolean;
  }> = [
    {
      id: "S1_normal",
      ctx: baseCtx(),
      outcome: "delivered",
      autoRetry: false,
      escalate: false,
    },
    {
      id: "S2_receiver_unavailable",
      ctx: baseCtx({ receiverReachable: false }),
      outcome: "rejected",
      autoRetry: true,
      escalate: true,
    },
    {
      id: "S3_sender_crash",
      ctx: baseCtx({ senderCrashed: true }),
      outcome: "partial",
      autoRetry: true,
      escalate: true,
    },
    {
      id: "S4_duplicate",
      ctx: baseCtx({ duplicateOf: "orig" }),
      outcome: "deduplicated",
      autoRetry: false,
      escalate: true,
    },
    {
      id: "S5_recovery",
      ctx: baseCtx({ recoveryOf: "failed" }),
      outcome: "retried",
      autoRetry: false,
      escalate: true,
    },
  ];

  for (const s of scenarios) {
    it(`${s.id}: classify → expectedOutcome → autoRetry → escalate`, () => {
      assert.equal(classifyHandoff(s.ctx), s.id);
      assert.equal(expectedOutcome(s.id), s.outcome);
      assert.equal(shouldAutoRetry(s.id), s.autoRetry);
      assert.equal(shouldEscalate(s.id), s.escalate);
    });
  }
});
