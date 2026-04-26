/**
 * Wake-to-Work S1–S5 proof matrix tests (issue #97).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  runWakeToWorkMatrix,
  defaultWakeToWorkFixtures,
  WAKE_TO_WORK_SCENARIOS,
  type WakeToWorkFixture,
  type WakeToWorkExecutor,
} from "./wake-to-work-proof-matrix.js";

// ---------------------------------------------------------------------------
// Mock executor
// ---------------------------------------------------------------------------

function createMockExecutor(overrides?: {
  deliveryShouldFail?: boolean;
  executionShouldFail?: boolean;
  executionShouldTimeout?: boolean;
  executionErrorCode?: string;
  deliveryErrorCode?: string;
}): WakeToWorkExecutor {
  return {
    async deliver(_sessionKey: string, _deliveryId: string) {
      const now = new Date().toISOString();
      if (overrides?.deliveryShouldFail) {
        return { status: "failed", errorCode: (overrides.deliveryErrorCode as any) ?? "EXEC_PAYLOAD_DELIVERY_FAILED", deliveredAt: now };
      }
      return { status: "delivered", deliveredAt: now };
    },
    async execute(_sessionKey: string, _executionId: string) {
      const now = new Date().toISOString();
      if (overrides?.executionShouldFail) {
        return { status: "failed", errorCode: (overrides.executionErrorCode as any) ?? "EXEC_RUNTIME_ERROR", startedAt: now, completedAt: now, durationMs: 50 };
      }
      if (overrides?.executionShouldTimeout) {
        return { status: "timed_out", errorCode: (overrides.executionErrorCode as any) ?? "EXEC_TIMEOUT", startedAt: now, completedAt: now, durationMs: 30000 };
      }
      return {
        status: "completed",
        startedAt: now,
        completedAt: new Date(Date.now() + 100).toISOString(),
        durationMs: 100,
        resultId: "result-" + Math.random().toString(36).slice(2),
        resultSummary: "[redacted]",
        resultArtifactIds: ["artifact-1"],
      };
    },
  };
}

function fixtureAwareExecutor(fixtures: WakeToWorkFixture[]): WakeToWorkExecutor {
  return {
    async deliver(sessionKey: string, deliveryId: string) {
      const f = fixtures.find((x) => x.sessionKey === sessionKey);
      const now = new Date().toISOString();
      if (f?.deliveryShouldFail) {
        return { status: "failed", errorCode: f.expectedWakeErrorCode as any ?? "EXEC_TARGET_UNREACHABLE", deliveredAt: now };
      }
      return { status: "delivered", deliveredAt: now };
    },
    async execute(sessionKey: string, executionId: string) {
      const f = fixtures.find((x) => x.sessionKey === sessionKey);
      const now = new Date().toISOString();
      if (f?.executionShouldFail) {
        return { status: "failed", errorCode: f.expectedExecutionErrorCode as any ?? "EXEC_RUNTIME_ERROR", startedAt: now, completedAt: now, durationMs: 50 };
      }
      if (f?.executionShouldTimeout) {
        return { status: "timed_out", errorCode: f.expectedExecutionErrorCode as any ?? "EXEC_TIMEOUT", startedAt: now, completedAt: now, durationMs: 30000 };
      }
      return { status: "completed", startedAt: now, completedAt: new Date(Date.now() + 100).toISOString(), durationMs: 100, resultId: "result-ok", resultSummary: "[redacted]", resultArtifactIds: ["art-1"] };
    },
  };
}

// ---------------------------------------------------------------------------
// S1: Cold wake + execute
// ---------------------------------------------------------------------------

describe("S1 cold wake-to-work", () => {
  const fixtures = defaultWakeToWorkFixtures().filter((f) => f.scenarioId === "S1_cold_wake_execute");

  it("completes full wake→deliver→execute→result pipeline", async () => {
    const result = await runWakeToWorkMatrix(fixtures, createMockExecutor());
    const cell = result.cells["S1_cold_wake_execute"];
    assert.equal(cell.verdict, "pass", cell.error?.message);
    assert.equal(cell.artifact.wakeStatus, "accepted");
    assert.equal(cell.artifact.deliveryStatus, "delivered");
    assert.equal(cell.artifact.executionStatus, "completed");
    assert.ok(cell.artifact.resultId);
    assert.ok(cell.artifact.executionDurationMs);
  });

  it("fails on delivery failure", async () => {
    const result = await runWakeToWorkMatrix(fixtures, createMockExecutor({ deliveryShouldFail: true }));
    const cell = result.cells["S1_cold_wake_execute"];
    assert.equal(cell.verdict, "fail");
    assert.equal(cell.artifact.deliveryStatus, "failed");
    assert.ok(cell.artifact.deliveryErrorCode);
  });

  it("fails on execution failure", async () => {
    const result = await runWakeToWorkMatrix(fixtures, createMockExecutor({ executionShouldFail: true }));
    const cell = result.cells["S1_cold_wake_execute"];
    assert.equal(cell.verdict, "fail");
    assert.equal(cell.artifact.executionStatus, "failed");
    assert.ok(cell.artifact.executionErrorCode);
  });

  it("fails with prior work (precondition)", async () => {
    const fixture: WakeToWorkFixture = {
      ...fixtures[0],
      priorWork: [{ id: "x", scenarioId: "S1_cold_wake_execute", sessionKey: "s", wakeId: "w", deliveryId: "d", executionId: "e", wakeStatus: "completed" as any, deliveryStatus: "delivered", executionStatus: "completed", idempotencyKey: "i", replayCount: 0, coalesced: false, redactionHash: "h", wakePlannedAt: new Date().toISOString(), summary: "" }],
    };
    const result = await runWakeToWorkMatrix([fixture], createMockExecutor());
    assert.equal(result.cells["S1_cold_wake_execute"].error?.code, "S1_PRECONDITION");
  });
});

// ---------------------------------------------------------------------------
// S2: Duplicate delivery suppression
// ---------------------------------------------------------------------------

describe("S2 duplicate delivery suppression", () => {
  const fixtures = defaultWakeToWorkFixtures().filter((f) => f.scenarioId === "S2_duplicate_delivery_suppression");

  it("suppresses duplicate with matching idempotency key", async () => {
    const result = await runWakeToWorkMatrix(fixtures, createMockExecutor());
    const cell = result.cells["S2_duplicate_delivery_suppression"];
    assert.equal(cell.verdict, "pass", cell.error?.message);
    assert.equal(cell.artifact.wakeStatus, "suppressed");
    assert.equal(cell.artifact.deliveryStatus, "suppressed");
    assert.equal(cell.artifact.wakeErrorCode, "EXEC_DUPLICATE_SUPPRESSED");
    assert.equal(cell.artifact.replayCount, 1);
  });

  it("fails without prior work", async () => {
    const fixture: WakeToWorkFixture = { ...fixtures[0], priorWork: [] };
    const result = await runWakeToWorkMatrix([fixture], createMockExecutor());
    assert.equal(result.cells["S2_duplicate_delivery_suppression"].error?.code, "S2_PRECONDITION");
  });

  it("fails with mismatched idempotency key", async () => {
    const fixture: WakeToWorkFixture = {
      ...fixtures[0],
      priorWork: [{ ...fixtures[0].priorWork![0], idempotencyKey: "different" }],
    };
    const result = await runWakeToWorkMatrix([fixture], createMockExecutor());
    assert.equal(result.cells["S2_duplicate_delivery_suppression"].error?.code, "S2_KEY_MISMATCH");
  });
});

// ---------------------------------------------------------------------------
// S3: Warm/coalesced execution
// ---------------------------------------------------------------------------

describe("S3 warm coalesced execution", () => {
  const fixtures = defaultWakeToWorkFixtures().filter((f) => f.scenarioId === "S3_warm_coalesced_execute");

  it("coalesces with in-flight execution", async () => {
    const result = await runWakeToWorkMatrix(fixtures, createMockExecutor());
    const cell = result.cells["S3_warm_coalesced_execute"];
    assert.equal(cell.verdict, "pass", cell.error?.message);
    assert.equal(cell.artifact.wakeStatus, "coalesced");
    assert.equal(cell.artifact.deliveryStatus, "coalesced");
    assert.equal(cell.artifact.coalesced, true);
    assert.equal(cell.artifact.replayCount, 1);
  });

  it("fails when prior execution is completed", async () => {
    const fixture: WakeToWorkFixture = {
      ...fixtures[0],
      priorWork: [{ ...fixtures[0].priorWork![0], executionStatus: "completed" }],
    };
    const result = await runWakeToWorkMatrix([fixture], createMockExecutor());
    assert.equal(result.cells["S3_warm_coalesced_execute"].error?.code, "S3_NOT_INFLIGHT");
  });
});

// ---------------------------------------------------------------------------
// S4: Execution failure / timeout
// ---------------------------------------------------------------------------

describe("S4 execution failure timeout", () => {
  const fixtures = defaultWakeToWorkFixtures().filter((f) => f.scenarioId === "S4_execution_failure_timeout");

  it("handles execution timeout with structured code", async () => {
    const result = await runWakeToWorkMatrix(fixtures, createMockExecutor({ executionShouldTimeout: true }));
    const cell = result.cells["S4_execution_failure_timeout"];
    assert.equal(cell.verdict, "pass", cell.error?.message);
    assert.equal(cell.artifact.executionStatus, "timed_out");
    assert.equal(cell.artifact.executionErrorCode, "EXEC_TIMEOUT");
    assert.equal(cell.artifact.deliveryStatus, "delivered");
  });

  it("rejects wrong error code", async () => {
    const fixture: WakeToWorkFixture = { ...fixtures[0], expectedExecutionErrorCode: "EXEC_RUNTIME_ERROR" as any };
    const result = await runWakeToWorkMatrix([fixture], createMockExecutor({ executionShouldTimeout: true }));
    assert.equal(result.cells["S4_execution_failure_timeout"].error?.code, "S4_CODE_MISMATCH");
  });

  it("fails precondition without execution failure flag", async () => {
    const fixture: WakeToWorkFixture = { ...fixtures[0], executionShouldTimeout: false, executionShouldFail: false };
    const result = await runWakeToWorkMatrix([fixture], createMockExecutor());
    assert.equal(result.cells["S4_execution_failure_timeout"].error?.code, "S4_PRECONDITION");
  });
});

// ---------------------------------------------------------------------------
// S5: Unreachable/degraded during execution
// ---------------------------------------------------------------------------

describe("S5 unreachable degraded", () => {
  const fixtures = defaultWakeToWorkFixtures().filter((f) => f.scenarioId === "S5_unreachable_degraded_during_exec");

  it("produces UNREACHABLE for offline peer", async () => {
    const result = await runWakeToWorkMatrix(fixtures, fixtureAwareExecutor(fixtures));
    const cell = result.cells["S5_unreachable_degraded_during_exec"];
    assert.equal(cell.verdict, "pass", cell.error?.message);
    assert.equal(cell.artifact.wakeStatus, "failed");
    assert.ok(cell.artifact.wakeErrorCode);
  });

  it("rejects online peer status", async () => {
    const fixture: WakeToWorkFixture = { ...fixtures[0], peerStatus: "online" };
    const result = await runWakeToWorkMatrix([fixture], createMockExecutor());
    assert.equal(result.cells["S5_unreachable_degraded_during_exec"].error?.code, "S5_PRECONDITION");
  });

  it("marks delivery as failed for offline peer", async () => {
    const result = await runWakeToWorkMatrix(fixtures, fixtureAwareExecutor(fixtures));
    const cell = result.cells["S5_unreachable_degraded_during_exec"];
    assert.equal(cell.artifact.deliveryStatus, "failed");
    assert.equal(cell.artifact.executionStatus, "failed");
  });
});

// ---------------------------------------------------------------------------
// Full matrix
// ---------------------------------------------------------------------------

describe("Full wake-to-work S1–S5 matrix", () => {
  it("all scenarios pass with default fixtures", async () => {
    const fixtures = defaultWakeToWorkFixtures();
    const result = await runWakeToWorkMatrix(fixtures, fixtureAwareExecutor(fixtures));
    assert.equal(result.overallVerdict, "pass");
    assert.equal(result.totalScenarios, 5);
    assert.equal(result.passedScenarios, 5);
    assert.equal(result.failedScenarios, 0);
  });

  it("each artifact has required evidence fields", async () => {
    const result = await runWakeToWorkMatrix(defaultWakeToWorkFixtures(), fixtureAwareExecutor(defaultWakeToWorkFixtures()));
    for (const id of WAKE_TO_WORK_SCENARIOS) {
      const a = result.cells[id].artifact;
      assert.ok(a.id, `${id}: missing id`);
      assert.ok(a.sessionKey, `${id}: missing sessionKey`);
      assert.ok(a.wakeId, `${id}: missing wakeId`);
      assert.ok(a.deliveryId, `${id}: missing deliveryId`);
      assert.ok(a.executionId, `${id}: missing executionId`);
      assert.ok(a.idempotencyKey, `${id}: missing idempotencyKey`);
      assert.ok(a.wakePlannedAt, `${id}: missing wakePlannedAt`);
      assert.ok(a.redactionHash, `${id}: missing redactionHash`);
      assert.ok(a.summary, `${id}: missing summary`);
      assert.equal(typeof a.replayCount, "number", `${id}: replayCount`);
      assert.equal(typeof a.coalesced, "boolean", `${id}: coalesced`);
    }
  });

  it("failure cells produce structured codes", async () => {
    const bad: WakeToWorkFixture = {
      scenarioId: "S1_cold_wake_execute",
      sessionKey: "s:bad",
      idempotencyKey: "i:bad",
      priorWork: [{ id: "x", scenarioId: "S1_cold_wake_execute", sessionKey: "s:bad", wakeId: "w", deliveryId: "d", executionId: "e", wakeStatus: "accepted", deliveryStatus: "delivered", executionStatus: "completed", idempotencyKey: "i:bad", replayCount: 0, coalesced: false, redactionHash: "h", wakePlannedAt: new Date().toISOString(), summary: "" }],
    };
    const result = await runWakeToWorkMatrix([bad], createMockExecutor());
    const cell = result.cells["S1_cold_wake_execute"];
    assert.equal(cell.verdict, "fail");
    assert.ok(cell.error?.code);
    assert.ok(cell.artifact.executionErrorCode);
  });

  it("result is JSON-serializable", async () => {
    const result = await runWakeToWorkMatrix(defaultWakeToWorkFixtures(), fixtureAwareExecutor(defaultWakeToWorkFixtures()));
    assert.doesNotThrow(() => JSON.stringify(result));
    const parsed = JSON.parse(JSON.stringify(result));
    assert.equal(parsed.totalScenarios, 5);
  });

  it("deterministic runAt timestamp", async () => {
    const result = await runWakeToWorkMatrix(defaultWakeToWorkFixtures(), fixtureAwareExecutor(defaultWakeToWorkFixtures()));
    assert.ok(result.runAt);
    assert.ok(!isNaN(Date.parse(result.runAt)));
  });
});
