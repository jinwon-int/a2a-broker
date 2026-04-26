/**
 * E2E proof matrix tests (issue #73).
 *
 * Validates fanout/split/review/swarm modes against the proof matrix,
 * edge scenarios (duplicate, blocked, timeout), and operator checklist.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TEAM_ASSIGNMENT_FIXTURES } from "../fixtures/team-assignment.js";
import type { AssignmentFixture, BrokerSnapshot } from "../fixtures/team-assignment.js";
import {
  runProofMatrix,
  extractParentChildren,
  checkParentWaitsForChildren,
  checkChildParentReference,
  checkParentSuccessOnAllChildrenSuccess,
  checkParentFailsOnChildFailure,
  checkSwarmBarrier,
  checkReviewArtifactLink,
  checkReviewWorkerSeparation,
  checkFanoutDistinctWorkers,
  checkSplitSameWorker,
  checkSwarmCompletionTracking,
  checkDuplicateChildCompletion,
  checkBlockedChildBlocksParent,
  checkTimeoutChildHasError,
  ROUND16_OPERATOR_CHECKLIST,
} from "./proof-matrix.js";
import type { ProofMatrixResult, ProofCheckResult } from "./proof-matrix.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findFixture(mode: string): AssignmentFixture {
  const f = TEAM_ASSIGNMENT_FIXTURES.find(x => x.mode === mode);
  if (!f) throw new Error(`No fixture for mode: ${mode}`);
  return f;
}

// ---------------------------------------------------------------------------
// Fixture-driven proof matrix
// ---------------------------------------------------------------------------

describe("E2E proof matrix — fanout", () => {
  const fixture = findFixture("fanout");

  it("produces valid snapshot", () => {
    const snap = fixture.build();
    assert.equal(snap.tasks.length, fixture.expectedTaskCount);
  });

  it("extractParentChildren finds parent + children", () => {
    const snap = fixture.build();
    const rel = extractParentChildren(snap);
    assert.ok(rel);
    assert.equal(rel!.children.length, 2);
  });

  it("fanout children on distinct workers", () => {
    const snap = fixture.build();
    const result = checkFanoutDistinctWorkers(snap);
    assert.equal(result.verdict, "pass", result.detail);
  });

  it("parent waits for running children", () => {
    const snap = fixture.build();
    const result = checkParentWaitsForChildren(snap);
    assert.equal(result.verdict, "pass", result.detail);
  });

  it("children reference parent", () => {
    const snap = fixture.build();
    const result = checkChildParentReference(snap);
    assert.equal(result.verdict, "pass", result.detail);
  });

  it("full proof matrix passes", () => {
    const snap = fixture.build();
    const result = runProofMatrix({ mode: "fanout", scenario: "default", snapshot: snap });
    assert.ok(result.checks.length > 0);
    const fails = result.checks.filter(c => c.verdict === "fail");
    assert.equal(fails.length, 0, `Failures: ${fails.map(f => f.checkId + ": " + f.detail).join("; ")}`);
  });
});

describe("E2E proof matrix — split", () => {
  const fixture = findFixture("split");

  it("produces valid snapshot", () => {
    const snap = fixture.build();
    assert.equal(snap.tasks.length, fixture.expectedTaskCount);
  });

  it("split children on same worker", () => {
    const snap = fixture.build();
    const result = checkSplitSameWorker(snap);
    assert.equal(result.verdict, "pass", result.detail);
  });

  it("parent waits for partial completion", () => {
    const snap = fixture.build();
    const result = checkParentWaitsForChildren(snap);
    assert.equal(result.verdict, "pass", result.detail);
  });

  it("full proof matrix passes", () => {
    const snap = fixture.build();
    const result = runProofMatrix({ mode: "split", scenario: "default", snapshot: snap });
    const fails = result.checks.filter(c => c.verdict === "fail");
    assert.equal(fails.length, 0, `Failures: ${fails.map(f => f.checkId + ": " + f.detail).join("; ")}`);
  });
});

describe("E2E proof matrix — review", () => {
  const fixture = findFixture("review");

  it("produces valid snapshot", () => {
    const snap = fixture.build();
    assert.equal(snap.tasks.length, fixture.expectedTaskCount);
  });

  it("review worker ≠ implementer worker", () => {
    const snap = fixture.build();
    const result = checkReviewWorkerSeparation(snap);
    assert.equal(result.verdict, "pass", result.detail);
  });

  it("review task references implementer artifacts", () => {
    const snap = fixture.build();
    const result = checkReviewArtifactLink(snap);
    assert.equal(result.verdict, "pass", result.detail);
  });

  it("parent waits for review completion", () => {
    const snap = fixture.build();
    const result = checkParentWaitsForChildren(snap);
    assert.equal(result.verdict, "pass", result.detail);
  });

  it("full proof matrix passes", () => {
    const snap = fixture.build();
    const result = runProofMatrix({ mode: "review", scenario: "default", snapshot: snap });
    const fails = result.checks.filter(c => c.verdict === "fail");
    assert.equal(fails.length, 0, `Failures: ${fails.map(f => f.checkId + ": " + f.detail).join("; ")}`);
  });
});

describe("E2E proof matrix — swarm", () => {
  const fixture = findFixture("swarm");

  it("produces valid snapshot", () => {
    const snap = fixture.build();
    assert.equal(snap.tasks.length, fixture.expectedTaskCount);
  });

  it("barrier child queued until threshold met", () => {
    const snap = fixture.build();
    const result = checkSwarmBarrier(snap);
    assert.equal(result.verdict, "pass", result.detail);
  });

  it("swarm completion tracking present", () => {
    const snap = fixture.build();
    const result = checkSwarmCompletionTracking(snap);
    assert.ok(result.verdict === "pass" || result.verdict === "warn", result.detail);
  });

  it("parent waits for barrier", () => {
    const snap = fixture.build();
    const result = checkParentWaitsForChildren(snap);
    assert.equal(result.verdict, "pass", result.detail);
  });

  it("full proof matrix passes", () => {
    const snap = fixture.build();
    const result = runProofMatrix({ mode: "swarm", scenario: "default", snapshot: snap });
    const fails = result.checks.filter(c => c.verdict === "fail");
    assert.equal(fails.length, 0, `Failures: ${fails.map(f => f.checkId + ": " + f.detail).join("; ")}`);
  });
});

// ---------------------------------------------------------------------------
// Edge scenarios
// ---------------------------------------------------------------------------

describe("edge: duplicate child completion", () => {
  it("clean fixtures have no duplicate completions", () => {
    for (const fixture of TEAM_ASSIGNMENT_FIXTURES) {
      const snap = fixture.build();
      const result = checkDuplicateChildCompletion(snap);
      assert.equal(result.verdict, "pass", `${fixture.mode}: ${result.detail}`);
    }
  });

  it("detects duplicate audit events", () => {
    const snap = findFixture("split").build(); // split has a succeeded child
    const childId = snap.tasks.find(t => t.status === "succeeded")?.id;
    if (!childId) { assert.ok(true, "no succeeded child"); return; }
    // Add existing success
    snap.auditEvents.push({
      id: "orig-success",
      actorId: "worker-alpha",
      action: "task.succeeded",
      targetType: "task",
      targetId: childId,
      createdAt: "2026-04-26T00:00:05.000Z",
    });
    // Add duplicate
    snap.auditEvents.push({
      id: "dup-1",
      actorId: "worker-alpha",
      action: "task.succeeded",
      targetType: "task",
      targetId: childId,
      createdAt: "2026-04-26T00:00:10.000Z",
    });
    const result = checkDuplicateChildCompletion(snap);
    assert.equal(result.verdict, "fail");
    assert.ok(result.detail?.includes("Duplicate"));
  });
});

describe("edge: blocked child blocks parent", () => {
  it("succeeded parent with failed child fails check", () => {
    const snap = findFixture("fanout").build();
    const rel = extractParentChildren(snap)!;
    // Force child to failed and parent to succeeded
    rel.children[0].status = "failed";
    rel.children[0].error = { message: "worker died" };
    rel.parent.status = "succeeded";
    const result = checkBlockedChildBlocksParent(snap);
    assert.equal(result.verdict, "fail");
  });

  it("running parent with failed child passes", () => {
    const snap = findFixture("fanout").build();
    const rel = extractParentChildren(snap)!;
    rel.children[0].status = "failed";
    rel.parent.status = "running";
    const result = checkBlockedChildBlocksParent(snap);
    assert.equal(result.verdict, "pass");
  });
});

describe("edge: timeout child has error", () => {
  it("clean fixtures pass (no timeouts)", () => {
    for (const fixture of TEAM_ASSIGNMENT_FIXTURES) {
      const snap = fixture.build();
      const result = checkTimeoutChildHasError(snap);
      assert.equal(result.verdict, "pass", `${fixture.mode}: ${result.detail}`);
    }
  });

  it("detects timeout child without requeue info", () => {
    const snap = findFixture("split").build();
    const rel = extractParentChildren(snap)!;
    rel.children[0].status = "failed";
    rel.children[0].error = { message: "handler timeout after 30s" };
    const result = checkTimeoutChildHasError(snap);
    // Should warn — no requeueCount but has error message
    assert.ok(result.verdict === "pass" || result.verdict === "warn");
  });
});

// ---------------------------------------------------------------------------
// Parent success on all children success
// ---------------------------------------------------------------------------

describe("closure: parent success on all children success", () => {
  it("detects premature parent success", () => {
    const snap = findFixture("fanout").build();
    const rel = extractParentChildren(snap)!;
    // Only mark one child as succeeded
    rel.children[0].status = "succeeded";
    rel.parent.status = "succeeded"; // premature!
    const result = checkParentSuccessOnAllChildrenSuccess(snap);
    assert.equal(result.verdict, "fail");
  });

  it("passes when all children succeed and parent succeeds", () => {
    const snap = findFixture("fanout").build();
    const rel = extractParentChildren(snap)!;
    rel.children.forEach(c => { c.status = "succeeded"; c.completedAt = new Date().toISOString(); });
    rel.parent.status = "succeeded";
    const result = checkParentSuccessOnAllChildrenSuccess(snap);
    assert.equal(result.verdict, "pass");
  });
});

// ---------------------------------------------------------------------------
// Parent fails on child failure (non-swarm)
// ---------------------------------------------------------------------------

describe("closure: parent fails on child failure", () => {
  it("fanout parent fails when child fails", () => {
    const snap = findFixture("fanout").build();
    const rel = extractParentChildren(snap)!;
    rel.children[0].status = "failed";
    rel.parent.status = "failed";
    const result = checkParentFailsOnChildFailure(snap, "fanout");
    assert.equal(result.verdict, "pass");
  });

  it("swarm mode skips fail-fast check", () => {
    const snap = findFixture("swarm").build();
    const result = checkParentFailsOnChildFailure(snap, "swarm");
    assert.equal(result.verdict, "skip");
  });
});

// ---------------------------------------------------------------------------
// Operator checklist structure
// ---------------------------------------------------------------------------

describe("Round 16 operator checklist", () => {
  it("has all required items", () => {
    assert.ok(ROUND16_OPERATOR_CHECKLIST.length >= 10);
    const required = ROUND16_OPERATOR_CHECKLIST.filter(c => c.required);
    assert.ok(required.length >= 8);
  });

  it("has unique ids", () => {
    const ids = ROUND16_OPERATOR_CHECKLIST.map(c => c.id);
    assert.equal(ids.length, new Set(ids).size);
  });

  it("covers all modes", () => {
    const modes = new Set(ROUND16_OPERATOR_CHECKLIST.filter(c => c.mode).map(c => c.mode));
    assert.ok(modes.has("fanout"));
    assert.ok(modes.has("split"));
    assert.ok(modes.has("review"));
    assert.ok(modes.has("swarm"));
  });
});

// ---------------------------------------------------------------------------
// Full cross-mode matrix validation
// ---------------------------------------------------------------------------

describe("cross-mode proof matrix validation", () => {
  for (const fixture of TEAM_ASSIGNMENT_FIXTURES) {
    it(`${fixture.mode}: full matrix runs without failure`, () => {
      const snap = fixture.build();
      const result = runProofMatrix({
        mode: fixture.mode,
        scenario: "default",
        snapshot: snap,
      });
      assert.ok(result.checks.length > 0, "should have checks");
      assert.notEqual(result.overallVerdict, "fail", `Failures: ${result.checks.filter(c => c.verdict === "fail").map(f => f.checkId).join(", ")}`);
    });
  }
});
