/**
 * Autonomous aggregate closeout reconciler tests (issue #78).
 *
 * Covers: success, block, timeout, duplicate completion, stale child,
 * fail-fast vs non-fail-fast, max requeue, comment formatting.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CloseoutReconciler,
  formatCloseoutComment,
} from "./closeout-reconciler.js";
import type { CloseoutVerdict, CloseoutDecision } from "./closeout-reconciler.js";
import type { ChildTaskEvent } from "./closeout-reconciler.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function child(overrides: Partial<ChildTaskEvent> & { childTaskId: string }): ChildTaskEvent {
  return { status: "queued", ...overrides };
}

// ---------------------------------------------------------------------------
// Success path
// ---------------------------------------------------------------------------

describe("closeout: success path", () => {
  it("waiting with no children", () => {
    const r = new CloseoutReconciler();
    const v = r.currentVerdict();
    assert.equal(v.decision, "waiting");
  });

  it("waiting while children are active", () => {
    const r = new CloseoutReconciler();
    r.ingest(child({ childTaskId: "c1", status: "running" }));
    r.ingest(child({ childTaskId: "c2", status: "queued" }));
    const v = r.currentVerdict();
    assert.equal(v.decision, "waiting");
    assert.equal(v.stateCounts.active, 1);
    assert.equal(v.stateCounts.queued, 1);
  });

  it("waiting while partial completion", () => {
    const r = new CloseoutReconciler();
    r.ingest(child({ childTaskId: "c1", status: "succeeded" }));
    r.ingest(child({ childTaskId: "c2", status: "running" }));
    const v = r.currentVerdict();
    assert.equal(v.decision, "waiting");
    assert.equal(v.stateCounts.succeeded, 1);
    assert.equal(v.stateCounts.active, 1);
  });

  it("ready when all children succeed", () => {
    const r = new CloseoutReconciler();
    r.ingest(child({ childTaskId: "c1", status: "succeeded" }));
    r.ingest(child({ childTaskId: "c2", status: "succeeded" }));
    r.ingest(child({ childTaskId: "c3", status: "succeeded" }));
    const v = r.currentVerdict();
    assert.equal(v.decision, "ready");
    assert.equal(v.stateCounts.succeeded, 3);
    assert.equal(v.signals.length, 0);
  });

  it("ready with artifact passthrough", () => {
    const r = new CloseoutReconciler();
    r.ingest(child({ childTaskId: "c1", status: "succeeded", artifactIds: ["a1", "a2"] }));
    r.ingest(child({ childTaskId: "c2", status: "succeeded", artifactIds: ["a3"] }));
    const v = r.currentVerdict();
    assert.equal(v.decision, "ready");
    const allArtifacts = r.getChildren().flatMap(c => c.artifactIds ?? []);
    assert.deepEqual(allArtifacts.sort(), ["a1", "a2", "a3"]);
  });
});

// ---------------------------------------------------------------------------
// Block path (fail-fast)
// ---------------------------------------------------------------------------

describe("closeout: block path (fail-fast)", () => {
  it("blocked when any child fails", () => {
    const r = new CloseoutReconciler({ failFast: true });
    r.ingest(child({ childTaskId: "c1", status: "succeeded" }));
    r.ingest(child({ childTaskId: "c2", status: "failed" }));
    const v = r.currentVerdict();
    assert.equal(v.decision, "blocked");
    assert.ok(v.signals.includes("c2"));
  });

  it("blocked when any child is canceled", () => {
    const r = new CloseoutReconciler({ failFast: true });
    r.ingest(child({ childTaskId: "c1", status: "running" }));
    r.ingest(child({ childTaskId: "c2", status: "canceled" }));
    const v = r.currentVerdict();
    assert.equal(v.decision, "blocked");
    assert.ok(v.signals.includes("c2"));
  });

  it("blocked when child is stale", () => {
    const r = new CloseoutReconciler({ failFast: true, treatStaleAsBlocked: true });
    r.ingest(child({ childTaskId: "c1", status: "running", stale: true }));
    r.ingest(child({ childTaskId: "c2", status: "running" }));
    const v = r.currentVerdict();
    assert.equal(v.decision, "blocked");
    assert.equal(v.stateCounts.stale, 1);
    assert.ok(v.signals.includes("c1"));
  });

  it("not blocked when stale but treatStaleAsBlocked=false", () => {
    const r = new CloseoutReconciler({ treatStaleAsBlocked: false });
    r.ingest(child({ childTaskId: "c1", status: "running", stale: true }));
    const v = r.currentVerdict();
    assert.equal(v.decision, "waiting");
  });
});

// ---------------------------------------------------------------------------
// Non-fail-fast mode
// ---------------------------------------------------------------------------

describe("closeout: non-fail-fast", () => {
  it("ready even when children failed (fail-fast=false)", () => {
    const r = new CloseoutReconciler({ failFast: false });
    r.ingest(child({ childTaskId: "c1", status: "succeeded" }));
    r.ingest(child({ childTaskId: "c2", status: "failed" }));
    const v = r.currentVerdict();
    assert.equal(v.decision, "ready");
    assert.ok(v.reason.includes("fail-fast disabled"));
  });

  it("waiting when stale in non-fail-fast", () => {
    const r = new CloseoutReconciler({ failFast: false });
    r.ingest(child({ childTaskId: "c1", status: "succeeded" }));
    r.ingest(child({ childTaskId: "c2", status: "running", stale: true }));
    const v = r.currentVerdict();
    assert.equal(v.decision, "waiting");
  });
});

// ---------------------------------------------------------------------------
// Timeout / max requeue
// ---------------------------------------------------------------------------

describe("closeout: max requeue", () => {
  it("failed when child exceeds max requeue", () => {
    const r = new CloseoutReconciler({ maxRequeueAttempts: 3 });
    r.ingest(child({ childTaskId: "c1", status: "succeeded" }));
    r.ingest(child({ childTaskId: "c2", status: "queued", requeueCount: 3 }));
    const v = r.currentVerdict();
    assert.equal(v.decision, "failed");
    assert.ok(v.signals.includes("c2"));
    assert.ok(v.reason.includes("max requeue"));
  });

  it("not failed when requeueCount under limit", () => {
    const r = new CloseoutReconciler({ maxRequeueAttempts: 3 });
    r.ingest(child({ childTaskId: "c1", status: "running", requeueCount: 2 }));
    const v = r.currentVerdict();
    assert.equal(v.decision, "waiting");
  });

  it("succeeded child with high requeueCount is fine", () => {
    const r = new CloseoutReconciler({ maxRequeueAttempts: 3 });
    r.ingest(child({ childTaskId: "c1", status: "succeeded", requeueCount: 5 }));
    const v = r.currentVerdict();
    assert.equal(v.decision, "ready");
  });
});

// ---------------------------------------------------------------------------
// Duplicate completion (idempotency)
// ---------------------------------------------------------------------------

describe("closeout: duplicate completion", () => {
  it("same status re-ingest is idempotent", () => {
    const r = new CloseoutReconciler();
    r.ingest(child({ childTaskId: "c1", status: "succeeded" }));
    const v1 = r.currentVerdict();
    r.ingest(child({ childTaskId: "c1", status: "succeeded" }));
    const v2 = r.currentVerdict();
    assert.equal(v2.seq, v1.seq, "seq should not increment on no-op");
  });

  it("stale flag change triggers re-evaluation", () => {
    const r = new CloseoutReconciler({ failFast: true });
    r.ingest(child({ childTaskId: "c1", status: "running", stale: false }));
    const v1 = r.currentVerdict();
    assert.equal(v1.decision, "waiting");
    r.ingest(child({ childTaskId: "c1", status: "running", stale: true }));
    const v2 = r.currentVerdict();
    assert.equal(v2.decision, "blocked");
    assert.equal(v2.seq, v1.seq + 1);
  });

  it("status change triggers re-evaluation", () => {
    const r = new CloseoutReconciler();
    r.ingest(child({ childTaskId: "c1", status: "running" }));
    const v1 = r.currentVerdict();
    r.ingest(child({ childTaskId: "c1", status: "succeeded" }));
    const v2 = r.currentVerdict();
    assert.equal(v1.stateCounts.active, 1);
    assert.equal(v2.stateCounts.succeeded, 1);
    assert.equal(v2.seq, v1.seq + 1);
  });
});

// ---------------------------------------------------------------------------
// Seq and timing
// ---------------------------------------------------------------------------

describe("closeout: seq and timing", () => {
  it("seq increments on each meaningful ingest", () => {
    const r = new CloseoutReconciler();
    assert.equal(r.currentVerdict().seq, 0);
    r.ingest(child({ childTaskId: "c1", status: "queued" }));
    assert.equal(r.currentVerdict().seq, 1);
    r.ingest(child({ childTaskId: "c2", status: "running" }));
    assert.equal(r.currentVerdict().seq, 2);
    r.ingest(child({ childTaskId: "c1", status: "running" }));
    assert.equal(r.currentVerdict().seq, 3);
  });

  it("decidedAt is set", () => {
    const r = new CloseoutReconciler();
    r.ingest(child({ childTaskId: "c1", status: "succeeded" }));
    const v = r.currentVerdict();
    assert.ok(v.decidedAt);
    const d = new Date(v.decidedAt);
    assert.ok(!isNaN(d.getTime()));
  });
});

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

describe("closeout: reset", () => {
  it("clears all state", () => {
    const r = new CloseoutReconciler();
    r.ingest(child({ childTaskId: "c1", status: "succeeded" }));
    r.ingest(child({ childTaskId: "c2", status: "failed" }));
    assert.equal(r.getChildCount(), 2);
    r.reset();
    assert.equal(r.getChildCount(), 0);
    assert.equal(r.currentVerdict().seq, 0);
    assert.equal(r.currentVerdict().decision, "waiting");
  });
});

// ---------------------------------------------------------------------------
// Command-center comment formatting
// ---------------------------------------------------------------------------

describe("closeout comment formatting", () => {
  it("formats ready verdict", () => {
    const r = new CloseoutReconciler();
    r.ingest(child({ childTaskId: "c1", status: "succeeded" }));
    r.ingest(child({ childTaskId: "c2", status: "succeeded" }));
    const comment = formatCloseoutComment(r.currentVerdict(), "parent-123");
    assert.ok(comment.text.includes("✅"));
    assert.ok(comment.text.includes("READY"));
    assert.ok(comment.text.includes("parent-123"));
  });

  it("formats blocked verdict", () => {
    const r = new CloseoutReconciler({ failFast: true });
    r.ingest(child({ childTaskId: "c1", status: "succeeded" }));
    r.ingest(child({ childTaskId: "c2", status: "failed", errorMessage: "OOM" }));
    const comment = formatCloseoutComment(r.currentVerdict());
    assert.ok(comment.text.includes("🚫"));
    assert.ok(comment.text.includes("BLOCKED"));
    assert.ok(comment.text.includes("c2"));
  });

  it("formats waiting verdict", () => {
    const r = new CloseoutReconciler();
    r.ingest(child({ childTaskId: "c1", status: "running" }));
    const comment = formatCloseoutComment(r.currentVerdict());
    assert.ok(comment.text.includes("⏳"));
    assert.ok(comment.text.includes("WAITING"));
  });

  it("formats failed verdict", () => {
    const r = new CloseoutReconciler({ maxRequeueAttempts: 2 });
    r.ingest(child({ childTaskId: "c1", status: "succeeded" }));
    r.ingest(child({ childTaskId: "c2", status: "queued", requeueCount: 2 }));
    const comment = formatCloseoutComment(r.currentVerdict());
    assert.ok(comment.text.includes("❌"));
    assert.ok(comment.text.includes("FAILED"));
  });

  it("includes state count summary line", () => {
    const r = new CloseoutReconciler();
    r.ingest(child({ childTaskId: "c1", status: "succeeded" }));
    r.ingest(child({ childTaskId: "c2", status: "failed" }));
    r.ingest(child({ childTaskId: "c3", status: "running" }));
    r.ingest(child({ childTaskId: "c4", status: "queued" }));
    const comment = formatCloseoutComment(r.currentVerdict());
    assert.ok(comment.text.includes("1✓"));
    assert.ok(comment.text.includes("1✗"));
    assert.ok(comment.text.includes("1⟳"));
    assert.ok(comment.text.includes("1⋯"));
  });
});

// ---------------------------------------------------------------------------
// Multi-child swarm scenario
// ---------------------------------------------------------------------------

describe("closeout: swarm scenario", () => {
  it("swarm: 3 workers, 2 succeed, 1 running → waiting", () => {
    const r = new CloseoutReconciler();
    r.ingest(child({ childTaskId: "swarm-a", status: "succeeded" }));
    r.ingest(child({ childTaskId: "swarm-b", status: "succeeded" }));
    r.ingest(child({ childTaskId: "swarm-c", status: "running" }));
    const v = r.currentVerdict();
    assert.equal(v.decision, "waiting");
    assert.equal(v.stateCounts.succeeded, 2);
    assert.equal(v.stateCounts.active, 1);
  });

  it("swarm: barrier met, all succeed → ready", () => {
    const r = new CloseoutReconciler();
    r.ingest(child({ childTaskId: "swarm-a", status: "succeeded" }));
    r.ingest(child({ childTaskId: "swarm-b", status: "succeeded" }));
    r.ingest(child({ childTaskId: "swarm-c", status: "succeeded" }));
    const v = r.currentVerdict();
    assert.equal(v.decision, "ready");
  });

  it("swarm: one stale → blocked (fail-fast)", () => {
    const r = new CloseoutReconciler({ failFast: true });
    r.ingest(child({ childTaskId: "swarm-a", status: "succeeded" }));
    r.ingest(child({ childTaskId: "swarm-b", status: "running", stale: true }));
    r.ingest(child({ childTaskId: "swarm-c", status: "queued" }));
    const v = r.currentVerdict();
    assert.equal(v.decision, "blocked");
    assert.equal(v.stateCounts.stale, 1);
  });
});

// ---------------------------------------------------------------------------
// Review chain scenario
// ---------------------------------------------------------------------------

describe("closeout: review chain", () => {
  it("review: implementer succeeded, reviewer running → waiting", () => {
    const r = new CloseoutReconciler();
    r.ingest(child({ childTaskId: "impl", status: "succeeded", artifactIds: ["patch-1"] }));
    r.ingest(child({ childTaskId: "review", status: "running" }));
    const v = r.currentVerdict();
    assert.equal(v.decision, "waiting");
  });

  it("review: both succeeded → ready", () => {
    const r = new CloseoutReconciler();
    r.ingest(child({ childTaskId: "impl", status: "succeeded" }));
    r.ingest(child({ childTaskId: "review", status: "succeeded" }));
    const v = r.currentVerdict();
    assert.equal(v.decision, "ready");
  });

  it("review: implementer failed → blocked", () => {
    const r = new CloseoutReconciler({ failFast: true });
    r.ingest(child({ childTaskId: "impl", status: "failed" }));
    r.ingest(child({ childTaskId: "review", status: "queued" }));
    const v = r.currentVerdict();
    assert.equal(v.decision, "blocked");
  });

  it("review: reviewer rejects → blocked", () => {
    const r = new CloseoutReconciler({ failFast: true });
    r.ingest(child({ childTaskId: "impl", status: "succeeded" }));
    r.ingest(child({ childTaskId: "review", status: "failed", errorMessage: "changes requested" }));
    const v = r.currentVerdict();
    assert.equal(v.decision, "blocked");
  });
});

// ---------------------------------------------------------------------------
// Cross-decision matrix
// ---------------------------------------------------------------------------

describe("closeout: cross-decision matrix", () => {
  const scenarios: Array<{
    name: string;
    events: Array<Partial<ChildTaskEvent> & { childTaskId: string }>;
    config?: { failFast?: boolean; maxRequeueAttempts?: number; treatStaleAsBlocked?: boolean };
    expected: CloseoutDecision;
  }> = [
    {
      name: "all succeed",
      events: [
        { childTaskId: "c1", status: "succeeded" },
        { childTaskId: "c2", status: "succeeded" },
      ],
      expected: "ready",
    },
    {
      name: "one failed (fail-fast)",
      events: [
        { childTaskId: "c1", status: "succeeded" },
        { childTaskId: "c2", status: "failed" },
      ],
      config: { failFast: true },
      expected: "blocked",
    },
    {
      name: "one failed (non-fail-fast)",
      events: [
        { childTaskId: "c1", status: "succeeded" },
        { childTaskId: "c2", status: "failed" },
      ],
      config: { failFast: false },
      expected: "ready",
    },
    {
      name: "canceled child",
      events: [
        { childTaskId: "c1", status: "running" },
        { childTaskId: "c2", status: "canceled" },
      ],
      expected: "blocked",
    },
    {
      name: "stale child",
      events: [
        { childTaskId: "c1", status: "running", stale: true },
      ],
      expected: "blocked",
    },
    {
      name: "max requeue exceeded",
      events: [
        { childTaskId: "c1", status: "queued", requeueCount: 3 },
      ],
      config: { maxRequeueAttempts: 3 },
      expected: "failed",
    },
    {
      name: "in progress",
      events: [
        { childTaskId: "c1", status: "running" },
        { childTaskId: "c2", status: "queued" },
      ],
      expected: "waiting",
    },
    {
      name: "empty",
      events: [],
      expected: "waiting",
    },
  ];

  for (const s of scenarios) {
    it(`${s.name} → ${s.expected}`, () => {
      const r = new CloseoutReconciler(s.config);
      for (const e of s.events) {
        r.ingest(child(e));
      }
      assert.equal(r.currentVerdict().decision, s.expected);
    });
  }
});
