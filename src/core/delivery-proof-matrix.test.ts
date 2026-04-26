/**
 * Delivery S1–S5 proof matrix tests (issue #102).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  runDeliveryMatrix,
  defaultDeliveryFixtures,
  DELIVERY_SCENARIOS,
  type DeliveryFixture,
  type DeliveryExecutor,
} from "./delivery-proof-matrix.js";

// ---------------------------------------------------------------------------
// Mock executor
// ---------------------------------------------------------------------------

function createMockExecutor(overrides?: {
  deliveryShouldFail?: boolean;
  deliveryFailsOnFirstAttempt?: boolean;
  unreachableTargets?: string[];
}): DeliveryExecutor {
  let firstAttempt = true;
  return {
    async deliver() {
      const now = new Date().toISOString();
      if (overrides?.deliveryFailsOnFirstAttempt && firstAttempt) {
        firstAttempt = false;
        return { status: "failed", errorCode: "DELIVERY_TRANSIENT_FAILURE", completedAt: now };
      }
      if (overrides?.deliveryShouldFail) {
        return { status: "failed", errorCode: "DELIVERY_CHANNEL_ERROR", completedAt: now };
      }
      firstAttempt = false;
      return { status: "delivered", completedAt: now };
    },
    async checkReachable(targetNodeId?: string) {
      if (overrides?.unreachableTargets?.includes(targetNodeId ?? "")) {
        return false;
      }
      return true;
    },
  };
}

function fixtureAwareExecutor(fixtures: DeliveryFixture[]): DeliveryExecutor {
  // Per-deliveryId attempt counter (S3 retries reuse the same id).
  const attemptByDeliveryId = new Map<string, number>();
  // Per-target ordinal of new delivery ids — disambiguates scenarios that
  // share a target (S1, S3, S5 all hit "broker-main").
  const newIdOrdinalByTarget = new Map<string, number>();
  // Stable mapping from deliveryId → assigned scenario, set on first sight.
  const scenarioByDeliveryId = new Map<string, DeliveryFixture["scenarioId"]>();

  // Scenario order per target derived from fixture order.
  const scenariosByTarget = new Map<string, DeliveryFixture["scenarioId"][]>();
  for (const f of fixtures) {
    const tgt = f.targetNodeId ?? "";
    const list = scenariosByTarget.get(tgt) ?? [];
    list.push(f.scenarioId);
    scenariosByTarget.set(tgt, list);
  }

  return {
    async deliver(params) {
      const now = new Date().toISOString();
      const tgt = params.targetNodeId ?? "";
      const dCount = (attemptByDeliveryId.get(params.deliveryId) ?? 0) + 1;
      attemptByDeliveryId.set(params.deliveryId, dCount);

      // S4: mobile target — queue (fail) every time.
      const s4Fixture = fixtures.find((f) => f.targetNodeId === tgt && f.scenarioId === "S4_timeout_unreachable_mobile");
      if (s4Fixture) {
        return {
          status: "failed",
          errorCode: s4Fixture.targetReachable === false ? "DELIVERY_TARGET_UNREACHABLE" : "DELIVERY_TIMEOUT",
          completedAt: now,
        };
      }

      // Assign each new delivery id to the next scenario in the target's order.
      let scenario = scenarioByDeliveryId.get(params.deliveryId);
      if (!scenario) {
        const list = scenariosByTarget.get(tgt) ?? [];
        const ordinal = (newIdOrdinalByTarget.get(tgt) ?? 0);
        // Skip scenarios that don't call deliver (S2 builds its artifact directly).
        const callsDeliver = (id: DeliveryFixture["scenarioId"]) => id !== "S2_duplicate_idempotent_replay";
        const eligible = list.filter(callsDeliver);
        scenario = eligible[ordinal] ?? eligible[eligible.length - 1] ?? list[0];
        newIdOrdinalByTarget.set(tgt, ordinal + 1);
        if (scenario) scenarioByDeliveryId.set(params.deliveryId, scenario);
      }

      // S3: first attempt fails transiently, retry succeeds.
      if (scenario === "S3_transient_failure_retry" && dCount === 1) {
        return { status: "failed", errorCode: "DELIVERY_TRANSIENT_FAILURE", completedAt: now };
      }

      // S1, S5, default: deliver succeeds.
      return { status: "delivered", completedAt: now };
    },
    async checkReachable(targetNodeId?: string) {
      const f = fixtures.find((x) => x.targetNodeId === targetNodeId);
      if (f?.targetReachable === false) return false;
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// S1: Normal delivery
// ---------------------------------------------------------------------------

describe("S1 normal delivery", () => {
  const fixtures = defaultDeliveryFixtures().filter((f) => f.scenarioId === "S1_normal_delivery");

  it("delivers result payload successfully", async () => {
    const result = await runDeliveryMatrix(fixtures, createMockExecutor());
    const cell = result.cells["S1_normal_delivery"];
    assert.equal(cell.verdict, "pass", cell.error?.message);
    assert.equal(cell.artifact.deliveryStatus, "delivered");
    assert.equal(cell.artifact.deliveryErrorCode, "DELIVERY_OK");
    assert.equal(cell.artifact.deliveryAttempt, 1);
    assert.equal(cell.artifact.retryCount, 0);
    assert.equal(cell.artifact.seenBefore, false);
    assert.ok(cell.artifact.resultPayloadHash);
    assert.ok(cell.artifact.operatorEvidence.summary.includes("S1"));
  });

  it("fails when target is unreachable", async () => {
    const result = await runDeliveryMatrix(fixtures, createMockExecutor({ unreachableTargets: ["broker-main"] }));
    const cell = result.cells["S1_normal_delivery"];
    assert.equal(cell.verdict, "fail");
    assert.equal(cell.error?.code, "S1_TARGET_UNREACHABLE");
  });

  it("fails when executor returns error", async () => {
    const result = await runDeliveryMatrix(fixtures, createMockExecutor({ deliveryShouldFail: true }));
    const cell = result.cells["S1_normal_delivery"];
    assert.equal(cell.verdict, "fail");
    assert.equal(cell.error?.code, "S1_DELIVERY_FAILED");
  });

  it("includes source execution metadata", async () => {
    const result = await runDeliveryMatrix(fixtures, createMockExecutor());
    const a = result.cells["S1_normal_delivery"].artifact;
    assert.ok(a.sourceSessionId);
    assert.ok(a.sourceExecutionId);
    assert.ok(a.sourceCompletedAt);
    assert.equal(a.sourceStatus, "completed");
    assert.ok(a.sourceResultId);
  });
});

// ---------------------------------------------------------------------------
// S2: Duplicate / idempotent replay
// ---------------------------------------------------------------------------

describe("S2 duplicate idempotent replay", () => {
  const fixtures = defaultDeliveryFixtures().filter((f) => f.scenarioId === "S2_duplicate_idempotent_replay");

  it("suppresses duplicate with seenBefore=true", async () => {
    const result = await runDeliveryMatrix(fixtures, createMockExecutor());
    const cell = result.cells["S2_duplicate_idempotent_replay"];
    assert.equal(cell.verdict, "pass", cell.error?.message);
    assert.equal(cell.artifact.deliveryStatus, "suppressed");
    assert.equal(cell.artifact.deliveryErrorCode, "DELIVERY_DUPLICATE_SUPPRESSED");
    assert.equal(cell.artifact.seenBefore, true);
    assert.equal(cell.artifact.deliveryAttempt, 2);
  });

  it("fails when seenBefore is false", async () => {
    const fixture: DeliveryFixture = { ...fixtures[0], seenBefore: false };
    const result = await runDeliveryMatrix([fixture], createMockExecutor());
    assert.equal(result.cells["S2_duplicate_idempotent_replay"].error?.code, "S2_NOT_SEEN_BEFORE");
  });

  it("does not retry on suppression", async () => {
    const result = await runDeliveryMatrix(fixtures, createMockExecutor());
    const a = result.cells["S2_duplicate_idempotent_replay"].artifact;
    assert.equal(a.retryCount, 0);
    assert.equal(a.maxRetries, 0);
  });

  it("preserves deduplication key in artifact", async () => {
    const result = await runDeliveryMatrix(fixtures, createMockExecutor());
    const a = result.cells["S2_duplicate_idempotent_replay"].artifact;
    assert.ok(a.deduplicationKey);
    assert.ok(a.deduplicationKey.includes("s2"));
  });
});

// ---------------------------------------------------------------------------
// S3: Transient failure and retry
// ---------------------------------------------------------------------------

describe("S3 transient failure retry", () => {
  const fixtures = defaultDeliveryFixtures().filter((f) => f.scenarioId === "S3_transient_failure_retry");

  it("recovers after transient failure", async () => {
    const result = await runDeliveryMatrix(fixtures, fixtureAwareExecutor(fixtures));
    const cell = result.cells["S3_transient_failure_retry"];
    assert.equal(cell.verdict, "pass", cell.error?.message);
    assert.equal(cell.artifact.deliveryStatus, "delivered");
    assert.equal(cell.artifact.retryCount, 1);
    assert.ok(cell.artifact.retryDelaysMs);
    assert.ok(cell.artifact.retryDelaysMs!.length >= 1);
    assert.ok(cell.artifact.lastFailureCode);
  });

  it("fails without transientFailureOnFirstAttempt", async () => {
    const fixture: DeliveryFixture = { ...fixtures[0], transientFailureOnFirstAttempt: false };
    const result = await runDeliveryMatrix([fixture], createMockExecutor());
    assert.equal(result.cells["S3_transient_failure_retry"].error?.code, "S3_NO_TRANSIENT_FAILURE");
  });

  it("records maxRetries from fixture", async () => {
    const result = await runDeliveryMatrix(fixtures, fixtureAwareExecutor(fixtures));
    const a = result.cells["S3_transient_failure_retry"].artifact;
    assert.equal(a.maxRetries, 3);
  });

  it("operator evidence mentions retry", async () => {
    const result = await runDeliveryMatrix(fixtures, fixtureAwareExecutor(fixtures));
    const a = result.cells["S3_transient_failure_retry"].artifact;
    assert.ok(a.operatorEvidence.summary.includes("retry"));
  });
});

// ---------------------------------------------------------------------------
// S4: Timeout / unreachable mobile
// ---------------------------------------------------------------------------

describe("S4 timeout unreachable mobile", () => {
  const fixtures = defaultDeliveryFixtures().filter((f) => f.scenarioId === "S4_timeout_unreachable_mobile");

  it("queues delivery for unreachable mobile node", async () => {
    const result = await runDeliveryMatrix(fixtures, fixtureAwareExecutor(fixtures));
    const cell = result.cells["S4_timeout_unreachable_mobile"];
    assert.equal(cell.verdict, "pass", cell.error?.message);
    assert.equal(cell.artifact.deliveryStatus, "queued");
    assert.ok(cell.artifact.deliveryErrorCode === "DELIVERY_TARGET_UNREACHABLE" || cell.artifact.deliveryErrorCode === "DELIVERY_TIMEOUT");
  });

  it("sets targetReachable to false for offline node", async () => {
    const result = await runDeliveryMatrix(fixtures, fixtureAwareExecutor(fixtures));
    const a = result.cells["S4_timeout_unreachable_mobile"].artifact;
    assert.equal(a.targetReachable, false);
  });

  it("fails precondition when target is reachable and not timeout", async () => {
    const fixture: DeliveryFixture = { ...fixtures[0], mobileTimeout: false, targetReachable: true };
    const result = await runDeliveryMatrix([fixture], createMockExecutor());
    assert.equal(result.cells["S4_timeout_unreachable_mobile"].error?.code, "S4_NOT_TIMEOUT");
  });

  it("uses push channel for mobile delivery", async () => {
    const result = await runDeliveryMatrix(fixtures, fixtureAwareExecutor(fixtures));
    const a = result.cells["S4_timeout_unreachable_mobile"].artifact;
    assert.equal(a.deliveryChannel, "a2a-push");
  });
});

// ---------------------------------------------------------------------------
// S5: Redacted terminal failure
// ---------------------------------------------------------------------------

describe("S5 redacted terminal failure", () => {
  const fixtures = defaultDeliveryFixtures().filter((f) => f.scenarioId === "S5_redacted_terminal_failure");

  it("produces redacted artifact with safe evidence", async () => {
    const result = await runDeliveryMatrix(fixtures, createMockExecutor());
    const cell = result.cells["S5_redacted_terminal_failure"];
    assert.equal(cell.verdict, "pass", cell.error?.message);
    assert.equal(cell.artifact.deliveryStatus, "redacted");
    assert.equal(cell.artifact.deliveryErrorCode, "DELIVERY_TERMINAL_FAILURE");
    assert.equal(cell.artifact.operatorEvidence.redacted, true);
    assert.ok(cell.artifact.operatorEvidence.redactionHash);
  });

  it("fails precondition without terminalFailure", async () => {
    const fixture: DeliveryFixture = { ...fixtures[0], terminalFailure: false };
    const result = await runDeliveryMatrix([fixture], createMockExecutor());
    assert.equal(result.cells["S5_redacted_terminal_failure"].error?.code, "S5_NOT_TERMINAL");
  });

  it("has no raw payload in artifact", async () => {
    const result = await runDeliveryMatrix(fixtures, createMockExecutor());
    const a = result.cells["S5_redacted_terminal_failure"].artifact;
    assert.equal(a.resultPayloadHash, undefined);
    assert.equal(a.resultPayloadSizeBytes, undefined);
  });

  it("operator evidence code is structured", async () => {
    const result = await runDeliveryMatrix(fixtures, createMockExecutor());
    const a = result.cells["S5_redacted_terminal_failure"].artifact;
    assert.ok(a.operatorEvidence.code);
    assert.ok(a.operatorEvidence.summary.includes("redacted"));
  });
});

// ---------------------------------------------------------------------------
// Full matrix
// ---------------------------------------------------------------------------

describe("Full delivery S1–S5 matrix", () => {
  it("all scenarios pass with default fixtures", async () => {
    const fixtures = defaultDeliveryFixtures();
    const result = await runDeliveryMatrix(fixtures, fixtureAwareExecutor(fixtures));
    assert.equal(result.overallVerdict, "pass");
    assert.equal(result.totalScenarios, 5);
    assert.equal(result.passedScenarios, 5);
    assert.equal(result.failedScenarios, 0);
  });

  it("each artifact has required fields", async () => {
    const result = await runDeliveryMatrix(defaultDeliveryFixtures(), fixtureAwareExecutor(defaultDeliveryFixtures()));
    for (const id of DELIVERY_SCENARIOS) {
      const a = result.cells[id].artifact;
      assert.ok(a.id, `${id}: missing id`);
      assert.ok(a.sourceSessionId, `${id}: missing sourceSessionId`);
      assert.ok(a.sourceExecutionId, `${id}: missing sourceExecutionId`);
      assert.ok(a.deliveryId, `${id}: missing deliveryId`);
      assert.ok(a.deduplicationKey, `${id}: missing deduplicationKey`);
      assert.ok(a.timestamp, `${id}: missing timestamp`);
      assert.ok(a.operatorEvidence, `${id}: missing operatorEvidence`);
      assert.ok(a.operatorEvidence.code, `${id}: missing evidence code`);
      assert.ok(a.operatorEvidence.summary, `${id}: missing evidence summary`);
      assert.ok(a.operatorEvidence.redactionHash, `${id}: missing redactionHash`);
      assert.equal(typeof a.operatorEvidence.redacted, "boolean", `${id}: redacted`);
      assert.equal(typeof a.deliveryAttempt, "number", `${id}: deliveryAttempt`);
      assert.equal(typeof a.retryCount, "number", `${id}: retryCount`);
      assert.equal(typeof a.targetReachable, "boolean", `${id}: targetReachable`);
    }
  });

  it("result is JSON-serializable", async () => {
    const result = await runDeliveryMatrix(defaultDeliveryFixtures(), fixtureAwareExecutor(defaultDeliveryFixtures()));
    assert.doesNotThrow(() => JSON.stringify(result));
    const parsed = JSON.parse(JSON.stringify(result));
    assert.equal(parsed.totalScenarios, 5);
  });

  it("failure cells produce structured error codes", async () => {
    const bad: DeliveryFixture = {
      scenarioId: "S1_normal_delivery",
      sourceSessionId: "bad",
      sourceExecutionId: "bad",
      deduplicationKey: "bad",
      targetNodeId: "broker-main",
    };
    const result = await runDeliveryMatrix([bad], createMockExecutor({ unreachableTargets: ["broker-main"] }));
    const cell = result.cells["S1_normal_delivery"];
    assert.equal(cell.verdict, "fail");
    assert.ok(cell.error?.code);
    assert.ok(cell.artifact.operatorEvidence.code);
  });

  it("runAt is valid ISO timestamp", async () => {
    const result = await runDeliveryMatrix(defaultDeliveryFixtures(), fixtureAwareExecutor(defaultDeliveryFixtures()));
    assert.ok(!isNaN(Date.parse(result.runAt)));
  });
});
