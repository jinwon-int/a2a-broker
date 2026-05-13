/**
 * Tests for queue closeout ambiguity detector (issue #540).
 *
 * Reference: #540 Team1/Bangtong stability gates for #497/#294.
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import {
  detectQueueCloseoutAmbiguity,
  DEFAULT_QUEUE_CLOSEOUT_AMBIGUITY_THRESHOLDS,
  type QueueCloseoutSnapshot,
} from "./queue-closeout-ambiguity.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptySnapshot(): QueueCloseoutSnapshot {
  return {
    counts: { queued: 0, claimed: 0, running: 0, succeeded: 0, failed: 0, canceled: 0, blocked: 0 },
    total: 0,
    terminal: 0,
  };
}

function snap(overrides: Omit<Partial<QueueCloseoutSnapshot>, "counts"> & { counts?: Partial<QueueCloseoutSnapshot["counts"]> }): QueueCloseoutSnapshot {
  const { counts, ...rest } = overrides;
  const base = emptySnapshot();
  if (counts) {
    base.counts = { ...base.counts, ...counts };
  }
  return { ...base, ...rest };
}

// ---------------------------------------------------------------------------
// Empty queue
// ---------------------------------------------------------------------------

describe("detectQueueCloseoutAmbiguity — empty queue", () => {
  it("returns clear for an empty queue", () => {
    const result = detectQueueCloseoutAmbiguity(emptySnapshot());
    assert.strictEqual(result.ambiguity, "clear");
    assert.strictEqual(result.stabilityGatePass, true);
    assert.strictEqual(result.patterns.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Clean closeout
// ---------------------------------------------------------------------------

describe("detectQueueCloseoutAmbiguity — clean closeout", () => {
  it("returns clear when all tasks are terminal and closeout is ready", () => {
    const s = snap({
      counts: { succeeded: 5, failed: 0, canceled: 0, blocked: 0 },
      total: 5, terminal: 5,
      closeoutDecision: "ready",
    });
    const result = detectQueueCloseoutAmbiguity(s);
    assert.strictEqual(result.ambiguity, "clear");
    assert.strictEqual(result.stabilityGatePass, true);
  });

  it("returns clear for a healthy in-progress queue", () => {
    const s = snap({
      counts: { queued: 2, claimed: 1, running: 1, succeeded: 3 },
      total: 7, terminal: 3,
      closeoutDecision: "waiting",
    });
    const result = detectQueueCloseoutAmbiguity(s);
    assert.strictEqual(result.ambiguity, "clear");
  });
});

// ---------------------------------------------------------------------------
// Stale workers
// ---------------------------------------------------------------------------

describe("detectQueueCloseoutAmbiguity — stale workers", () => {
  it("flags stale_with_no_owner when stale workers exceed threshold", () => {
    const s = snap({
      counts: { succeeded: 2, claimed: 1, running: 1 },
      total: 4, terminal: 2,
      staleWorkers: 5,
      closeoutDecision: "waiting",
    });
    const result = detectQueueCloseoutAmbiguity(s);
    const pattern = result.patterns.find((p) => p.kind === "stale_with_no_owner");
    assert.ok(pattern, "should flag stale workers without owner");
    assert.strictEqual(pattern.severity, "warning");
    assert.strictEqual(result.ambiguity, "ambiguous");
  });

  it("does not flag when stale workers are below threshold", () => {
    const s = snap({
      counts: { succeeded: 5 },
      total: 5, terminal: 5,
      staleWorkers: 1,
    });
    const result = detectQueueCloseoutAmbiguity(s);
    assert.strictEqual(result.patterns.find((p) => p.kind === "stale_with_no_owner"), undefined);
  });
});

// ---------------------------------------------------------------------------
// Terminal not acknowledged
// ---------------------------------------------------------------------------

describe("detectQueueCloseoutAmbiguity — terminal not acknowledged", () => {
  it("flags terminal_not_acknowledged for unacked outbox entries", () => {
    const s = snap({
      counts: { succeeded: 5 },
      total: 5, terminal: 5,
      terminalUnackedOutbox: 3,
      closeoutDecision: "ready",
    });
    const result = detectQueueCloseoutAmbiguity(s);
    const pattern = result.patterns.find((p) => p.kind === "terminal_not_acknowledged");
    assert.ok(pattern, "should flag terminal tasks with unacked outbox");
    assert.strictEqual(pattern.severity, "warning");
    assert.strictEqual(result.ambiguity, "ambiguous");
  });

  it("flags terminal_not_acknowledged as critical when >10 unacked", () => {
    const s = snap({
      counts: { succeeded: 15 },
      total: 15, terminal: 15,
      terminalUnackedOutbox: 12,
    });
    const result = detectQueueCloseoutAmbiguity(s);
    const pattern = result.patterns.find((p) => p.kind === "terminal_not_acknowledged");
    assert.ok(pattern);
    assert.strictEqual(pattern.severity, "critical");
    assert.strictEqual(result.ambiguity, "blocked");
    assert.strictEqual(result.stabilityGatePass, false);
  });

  it("does not flag when terminalUnackedOutbox is zero", () => {
    const s = snap({
      counts: { succeeded: 5 },
      total: 5, terminal: 5,
      terminalUnackedOutbox: 0,
    });
    const result = detectQueueCloseoutAmbiguity(s);
    assert.strictEqual(result.patterns.find((p) => p.kind === "terminal_not_acknowledged"), undefined);
  });
});

// ---------------------------------------------------------------------------
// Mixed closeout state
// ---------------------------------------------------------------------------

describe("detectQueueCloseoutAmbiguity — mixed closeout state", () => {
  it("flags mixed_closeout_state when 90% terminal with active tasks remaining", () => {
    const s = snap({
      counts: { succeeded: 18, claimed: 1, running: 1 },
      total: 20, terminal: 18,
    });
    const result = detectQueueCloseoutAmbiguity(s);
    const pattern = result.patterns.find((p) => p.kind === "mixed_closeout_state");
    assert.ok(pattern, "should flag mixed closeout state at 90% terminal");
    assert.strictEqual(pattern.severity, "warning");
  });

  it("does not flag when terminal ratio is below threshold", () => {
    const s = snap({
      counts: { succeeded: 12, claimed: 4, running: 4 },
      total: 20, terminal: 12,
    });
    const result = detectQueueCloseoutAmbiguity(s);
    assert.strictEqual(result.patterns.find((p) => p.kind === "mixed_closeout_state"), undefined);
  });

  it("does not flag when all tasks are terminal", () => {
    const s = snap({
      counts: { succeeded: 20 },
      total: 20, terminal: 20,
    });
    const result = detectQueueCloseoutAmbiguity(s);
    assert.strictEqual(result.patterns.find((p) => p.kind === "mixed_closeout_state"), undefined);
  });

  it("respects custom terminal ratio threshold", () => {
    const s = snap({
      counts: { succeeded: 15, claimed: 5 },
      total: 20, terminal: 15,
    });
    const result = detectQueueCloseoutAmbiguity(s, { terminalRatioThreshold: 0.75 });
    assert.ok(result.patterns.find((p) => p.kind === "mixed_closeout_state"));
  });
});

// ---------------------------------------------------------------------------
// Closeout decision mismatch
// ---------------------------------------------------------------------------

describe("detectQueueCloseoutAmbiguity — closeout decision mismatch", () => {
  it("flags mismatch when closeout is ready but not all terminal", () => {
    const s = snap({
      counts: { succeeded: 8, claimed: 2 },
      total: 10, terminal: 8,
      closeoutDecision: "ready",
    });
    const result = detectQueueCloseoutAmbiguity(s);
    const pattern = result.patterns.find((p) => p.kind === "closeout_decision_mismatch");
    assert.ok(pattern, "should flag decision mismatch");
    assert.strictEqual(pattern.severity, "critical");
    assert.strictEqual(result.ambiguity, "blocked");
    assert.strictEqual(result.stabilityGatePass, false);
  });

  it("flags mismatch when closeout is waiting but all are terminal", () => {
    const s = snap({
      counts: { succeeded: 5 },
      total: 5, terminal: 5,
      closeoutDecision: "waiting",
    });
    const result = detectQueueCloseoutAmbiguity(s);
    const pattern = result.patterns.find((p) => p.kind === "closeout_decision_mismatch");
    assert.ok(pattern, "should flag waiting with all-terminal");
    assert.strictEqual(pattern.severity, "warning");
  });

  it("does not flag when closeout is ready and all terminal", () => {
    const s = snap({
      counts: { succeeded: 5 },
      total: 5, terminal: 5,
      closeoutDecision: "ready",
    });
    const result = detectQueueCloseoutAmbiguity(s);
    assert.strictEqual(result.patterns.find((p) => p.kind === "closeout_decision_mismatch"), undefined);
  });
});

// ---------------------------------------------------------------------------
// Orphaned replay
// ---------------------------------------------------------------------------

describe("detectQueueCloseoutAmbiguity — orphaned replay", () => {
  it("flags orphaned_replay when stale workers have claimed/running tasks", () => {
    const s = snap({
      counts: { succeeded: 3, claimed: 2, running: 1 },
      total: 6, terminal: 3,
      staleWorkers: 2,
    });
    const result = detectQueueCloseoutAmbiguity(s);
    const pattern = result.patterns.find((p) => p.kind === "orphaned_replay");
    assert.ok(pattern, "should flag orphaned replay");
    assert.strictEqual(pattern.severity, "info");
  });

  it("does not flag when no stale workers", () => {
    const s = snap({
      counts: { succeeded: 3, claimed: 1 },
      total: 4, terminal: 3,
    });
    const result = detectQueueCloseoutAmbiguity(s);
    assert.strictEqual(result.patterns.find((p) => p.kind === "orphaned_replay"), undefined);
  });
});

// ---------------------------------------------------------------------------
// Requeue loop
// ---------------------------------------------------------------------------

describe("detectQueueCloseoutAmbiguity — requeue loop", () => {
  it("flags requeue_loop when depth exceeds threshold", () => {
    const s = snap({
      counts: { succeeded: 2, failed: 1, claimed: 1, running: 2 },
      total: 6, terminal: 3,
      requeueDepth: 15,
    });
    const result = detectQueueCloseoutAmbiguity(s);
    const pattern = result.patterns.find((p) => p.kind === "requeue_loop");
    assert.ok(pattern, "should flag requeue loop");
    assert.strictEqual(pattern.severity, "warning");
  });

  it("does not flag when requeue depth is below threshold", () => {
    const s = snap({
      counts: { succeeded: 5 },
      total: 5, terminal: 5,
      requeueDepth: 3,
    });
    const result = detectQueueCloseoutAmbiguity(s);
    assert.strictEqual(result.patterns.find((p) => p.kind === "requeue_loop"), undefined);
  });

  it("does not flag when requeueDepth is zero", () => {
    const s = snap({
      counts: { succeeded: 5 },
      total: 5, terminal: 5,
      requeueDepth: 0,
    });
    const result = detectQueueCloseoutAmbiguity(s);
    assert.strictEqual(result.patterns.find((p) => p.kind === "requeue_loop"), undefined);
  });
});

// ---------------------------------------------------------------------------
// Blocked with no signal
// ---------------------------------------------------------------------------

describe("detectQueueCloseoutAmbiguity — blocked with no signal", () => {
  it("flags blocked_with_no_signal when closeout is blocked but no tasks are blocked", () => {
    const s = snap({
      counts: { succeeded: 5 },
      total: 5, terminal: 5,
      closeoutDecision: "blocked",
    });
    const result = detectQueueCloseoutAmbiguity(s);
    const pattern = result.patterns.find((p) => p.kind === "blocked_with_no_signal");
    assert.ok(pattern, "should flag blocked with no blocked tasks");
    assert.strictEqual(result.ambiguity, "blocked");
  });

  it("does not flag when closeout is blocked with actual blocked tasks", () => {
    const s = snap({
      counts: { failed: 2, blocked: 2 },
      total: 4, terminal: 4,
      closeoutDecision: "blocked",
    });
    const result = detectQueueCloseoutAmbiguity(s);
    assert.strictEqual(result.patterns.find((p) => p.kind === "blocked_with_no_signal"), undefined);
  });
});

// ---------------------------------------------------------------------------
// Ambiguity levels and stability gate
// ---------------------------------------------------------------------------

describe("detectQueueCloseoutAmbiguity — ambiguity levels", () => {
  it("returns blocked with critical pattern", () => {
    const s = snap({
      counts: { succeeded: 8, claimed: 2 },
      total: 10, terminal: 8,
      closeoutDecision: "ready",
    });
    const result = detectQueueCloseoutAmbiguity(s);
    assert.strictEqual(result.ambiguity, "blocked");
    assert.strictEqual(result.stabilityGatePass, false);
  });

  it("returns blocked when closeoutDecision is blocked", () => {
    const s = snap({
      counts: { failed: 3 },
      total: 3, terminal: 3,
      closeoutDecision: "blocked",
    });
    const result = detectQueueCloseoutAmbiguity(s);
    assert.strictEqual(result.ambiguity, "blocked");
    assert.strictEqual(result.stabilityGatePass, false);
  });

  it("returns ambiguous with warning patterns only", () => {
    const s = snap({
      counts: { succeeded: 18, claimed: 1, running: 1 },
      total: 20, terminal: 18,
      staleWorkers: 5,
    });
    const result = detectQueueCloseoutAmbiguity(s);
    assert.strictEqual(result.ambiguity, "ambiguous");
    assert.strictEqual(result.stabilityGatePass, false);
  });

  it("returns clear with no patterns", () => {
    const s = snap({
      counts: { succeeded: 5 },
      total: 5, terminal: 5,
      closeoutDecision: "ready",
    });
    const result = detectQueueCloseoutAmbiguity(s);
    assert.strictEqual(result.ambiguity, "clear");
    assert.strictEqual(result.stabilityGatePass, true);
  });
});

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------

describe("detectQueueCloseoutAmbiguity — recommendations", () => {
  it("provides recommendation for unacked terminal entries", () => {
    const s = snap({
      counts: { succeeded: 15 },
      total: 15, terminal: 15,
      terminalUnackedOutbox: 12,
    });
    const result = detectQueueCloseoutAmbiguity(s);
    assert.ok(result.recommendation);
  });

  it("provides recommendation for closeout decision mismatch", () => {
    const s = snap({
      counts: { succeeded: 8, claimed: 2 },
      total: 10, terminal: 8,
      closeoutDecision: "ready",
    });
    const result = detectQueueCloseoutAmbiguity(s);
    assert.ok(result.recommendation);
  });

  it("returns undefined recommendation for clean state", () => {
    const s = snap({
      counts: { succeeded: 5 },
      total: 5, terminal: 5,
      closeoutDecision: "ready",
    });
    const result = detectQueueCloseoutAmbiguity(s);
    assert.strictEqual(result.recommendation, undefined);
  });
});

// ---------------------------------------------------------------------------
// Threshold defaults
// ---------------------------------------------------------------------------

describe("DEFAULT_QUEUE_CLOSEOUT_AMBIGUITY_THRESHOLDS", () => {
  it("has consistent defaults", () => {
    const t = DEFAULT_QUEUE_CLOSEOUT_AMBIGUITY_THRESHOLDS;
    assert.ok(t.maxStaleWorkersWarning > 0);
    assert.ok(t.terminalRatioThreshold > 0 && t.terminalRatioThreshold < 1);
    assert.ok(t.maxRequeueDepthWarning > 0);
  });
});
