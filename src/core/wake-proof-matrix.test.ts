/**
 * S1–S5 durable wake proof matrix tests (issue #92).
 *
 * Tests each wake scenario independently, the full matrix runner,
 * structured error codes, and deterministic artifact production.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  runWakeProofMatrix,
  defaultWakeFixtures,
  WAKE_SCENARIOS,
  type WakeScenarioFixture,
  type WakeDispatcher,
  type WakeProofMatrixResult,
  type WakeAuditEvent,
} from "./wake-proof-matrix.js";

// ---------------------------------------------------------------------------
// Mock dispatcher
// ---------------------------------------------------------------------------

function createMockDispatcher(overrides?: {
  shouldFail?: boolean;
  errorCode?: string;
  peerStatus?: string;
}): WakeDispatcher {
  return {
    async dispatch(_sessionKey: string, _runId: string) {
      const fail = overrides?.shouldFail ?? false;
      const now = new Date().toISOString();

      if (fail) {
        return {
          dispatchedAt: now,
          status: "failed",
          errorCode: (overrides?.errorCode as WakeAuditEvent["errorCode"]) ?? "WAKE_DISPATCH_FAILED",
        };
      }

      return {
        dispatchedAt: now,
        completedAt: new Date(Date.now() + 100).toISOString(),
        status: "completed",
      };
    },
  };
}

// ---------------------------------------------------------------------------
// S1: Cold wake
// ---------------------------------------------------------------------------

describe("S1 cold wake", () => {
  const fixtures = defaultWakeFixtures().filter((f) => f.scenarioId === "S1_cold_wake");

  it("dispatches successfully with no prior wakes", async () => {
    const result = await runWakeProofMatrix(fixtures, createMockDispatcher());
    const cell = result.cells["S1_cold_wake"];
    assert.equal(cell.verdict, "pass", cell.error?.message);
    assert.equal(cell.auditEvent.status, "completed");
    assert.ok(cell.auditEvent.runId);
    assert.ok(cell.auditEvent.dispatchedAt);
    assert.ok(cell.auditEvent.completedAt);
  });

  it("fails when prior wakes exist (precondition)", async () => {
    const fixture: WakeScenarioFixture = {
      ...fixtures[0],
      priorWakes: [
        {
          id: "prior",
          scenarioId: "S1_cold_wake",
          sessionKey: "test",
          wakeKey: "wk",
          idempotencyKey: "idem",
          plannedAt: new Date().toISOString(),
          status: "completed",
          summary: "prior",
          replayCount: 0,
          coalesced: false,
        },
      ],
    };
    const result = await runWakeProofMatrix([fixture], createMockDispatcher());
    const cell = result.cells["S1_cold_wake"];
    assert.equal(cell.verdict, "fail");
    assert.equal(cell.error?.code, "S1_PRECONDITION");
  });

  it("produces deterministic audit event structure", async () => {
    const result = await runWakeProofMatrix(fixtures, createMockDispatcher());
    const ev = result.cells["S1_cold_wake"].auditEvent;
    assert.ok(ev.id);
    assert.equal(ev.scenarioId, "S1_cold_wake");
    assert.ok(ev.sessionKey);
    assert.ok(ev.wakeKey);
    assert.ok(ev.idempotencyKey);
    assert.ok(ev.plannedAt);
    assert.equal(ev.replayCount, 0);
    assert.equal(ev.coalesced, false);
  });
});

// ---------------------------------------------------------------------------
// S2: Duplicate suppression
// ---------------------------------------------------------------------------

describe("S2 duplicate suppression", () => {
  const fixtures = defaultWakeFixtures().filter((f) => f.scenarioId === "S2_duplicate_suppression");

  it("suppresses duplicate wake with matching idempotency key", async () => {
    const result = await runWakeProofMatrix(fixtures, createMockDispatcher());
    const cell = result.cells["S2_duplicate_suppression"];
    assert.equal(cell.verdict, "pass", cell.error?.message);
    assert.equal(cell.auditEvent.status, "suppressed");
    assert.equal(cell.auditEvent.errorCode, "WAKE_DUPLICATE_SUPPRESSED");
    assert.equal(cell.auditEvent.replayCount, 1);
  });

  it("fails when no prior wakes exist", async () => {
    const fixture: WakeScenarioFixture = {
      ...fixtures[0],
      priorWakes: [],
    };
    const result = await runWakeProofMatrix([fixture], createMockDispatcher());
    assert.equal(result.cells["S2_duplicate_suppression"].verdict, "fail");
  });

  it("fails when prior wake has different idempotency key", async () => {
    const fixture: WakeScenarioFixture = {
      ...fixtures[0],
      priorWakes: [
        {
          ...fixtures[0].priorWakes[0],
          idempotencyKey: "different-key",
        },
      ],
    };
    const result = await runWakeProofMatrix([fixture], createMockDispatcher());
    assert.equal(result.cells["S2_duplicate_suppression"].error?.code, "S2_KEY_MISMATCH");
  });
});

// ---------------------------------------------------------------------------
// S3: Warm / coalesced wake
// ---------------------------------------------------------------------------

describe("S3 warm coalesced", () => {
  const fixtures = defaultWakeFixtures().filter((f) => f.scenarioId === "S3_warm_coalesced");

  it("coalesces with in-flight prior wake", async () => {
    const result = await runWakeProofMatrix(fixtures, createMockDispatcher());
    const cell = result.cells["S3_warm_coalesced"];
    assert.equal(cell.verdict, "pass", cell.error?.message);
    assert.equal(cell.auditEvent.status, "coalesced");
    assert.equal(cell.auditEvent.errorCode, "WAKE_COALESCED");
    assert.equal(cell.auditEvent.coalesced, true);
    assert.equal(cell.auditEvent.replayCount, 1);
  });

  it("fails when prior wake is completed (not in-flight)", async () => {
    const fixture: WakeScenarioFixture = {
      ...fixtures[0],
      priorWakes: [
        {
          ...fixtures[0].priorWakes[0],
          status: "completed" as const,
        },
      ],
    };
    const result = await runWakeProofMatrix([fixture], createMockDispatcher());
    assert.equal(result.cells["S3_warm_coalesced"].error?.code, "S3_NOT_INFLIGHT");
  });
});

// ---------------------------------------------------------------------------
// S4: Failure fallback
// ---------------------------------------------------------------------------

describe("S4 failure fallback", () => {
  const fixtures = defaultWakeFixtures().filter((f) => f.scenarioId === "S4_failure_fallback");

  it("fails with structured error code when dispatch fails", async () => {
    const result = await runWakeProofMatrix(fixtures, createMockDispatcher({ shouldFail: true }));
    const cell = result.cells["S4_failure_fallback"];
    assert.equal(cell.verdict, "pass", cell.error?.message);
    assert.equal(cell.auditEvent.status, "failed");
    assert.equal(cell.auditEvent.errorCode, "WAKE_DISPATCH_FAILED");
  });

  it("rejects wrong error code", async () => {
    const fixture: WakeScenarioFixture = {
      ...fixtures[0],
      expectedErrorCode: "WAKE_TARGET_UNREACHABLE" as const,
    };
    const result = await runWakeProofMatrix(
      [fixture],
      createMockDispatcher({ shouldFail: true, errorCode: "WAKE_DISPATCH_FAILED" }),
    );
    assert.equal(result.cells["S4_failure_fallback"].error?.code, "S4_ERROR_CODE_MISMATCH");
  });
});

// ---------------------------------------------------------------------------
// S5: Unreachable / degraded peer
// ---------------------------------------------------------------------------

describe("S5 unreachable degraded", () => {
  const fixtures = defaultWakeFixtures().filter((f) => f.scenarioId === "S5_unreachable_degraded");

  it("produces WAKE_TARGET_UNREACHABLE for offline peer", async () => {
    const result = await runWakeProofMatrix(
      fixtures,
      createMockDispatcher({ shouldFail: true, errorCode: "WAKE_TARGET_UNREACHABLE" }),
    );
    const cell = result.cells["S5_unreachable_degraded"];
    assert.equal(cell.verdict, "pass", cell.error?.message);
    assert.equal(cell.auditEvent.status, "failed");
    assert.equal(cell.auditEvent.errorCode, "WAKE_TARGET_UNREACHABLE");
  });

  it("rejects invalid peer status", async () => {
    const fixture: WakeScenarioFixture = {
      ...fixtures[0],
      peerStatus: "online" as const,
    };
    const result = await runWakeProofMatrix([fixture], createMockDispatcher());
    assert.equal(result.cells["S5_unreachable_degraded"].error?.code, "S5_PRECONDITION");
  });

  it("accepts WAKE_PEER_DEGRADED for stale peer", async () => {
    const fixture: WakeScenarioFixture = {
      ...fixtures[0],
      peerStatus: "stale" as const,
      expectedErrorCode: "WAKE_PEER_DEGRADED" as const,
    };
    const result = await runWakeProofMatrix(
      [fixture],
      createMockDispatcher({ shouldFail: true, errorCode: "WAKE_PEER_DEGRADED" }),
    );
    assert.equal(result.cells["S5_unreachable_degraded"].verdict, "pass");
  });
});

// ---------------------------------------------------------------------------
// Full matrix
// ---------------------------------------------------------------------------

describe("Full S1–S5 proof matrix", () => {
  it("all scenarios pass with default fixtures", async () => {
    const dispatcher = createMockDispatcher();
    // S4 and S5 need failure simulation
    const fixtures = defaultWakeFixtures();
    const result = await runWakeProofMatrix(fixtures, {
      async dispatch(sessionKey: string, runId: string) {
        const fixture = fixtures.find(
          (f) => f.sessionKey === sessionKey,
        );
        const now = new Date().toISOString();

        if (fixture?.dispatchShouldFail) {
          return {
            dispatchedAt: now,
            status: "failed",
            errorCode: (fixture.expectedErrorCode as WakeAuditEvent["errorCode"]) ?? "WAKE_DISPATCH_FAILED",
          };
        }
        return {
          dispatchedAt: now,
          completedAt: new Date(Date.now() + 100).toISOString(),
          status: "completed",
        };
      },
    });

    assert.equal(result.overallVerdict, "pass");
    assert.equal(result.totalScenarios, 5);
    assert.equal(result.passedScenarios, 5);
    assert.equal(result.failedScenarios, 0);
  });

  it("produces deterministic runAt timestamp", async () => {
    const result = await runWakeProofMatrix(defaultWakeFixtures(), createMockDispatcher());
    assert.ok(result.runAt);
    assert.ok(!isNaN(Date.parse(result.runAt)));
  });

  it("each cell has required evidence fields", async () => {
    const result = await runWakeProofMatrix(defaultWakeFixtures(), createMockDispatcher());
    for (const scenarioId of WAKE_SCENARIOS) {
      const cell = result.cells[scenarioId];
      const ev = cell.auditEvent;
      assert.ok(ev.id, `${scenarioId}: missing id`);
      assert.ok(ev.sessionKey, `${scenarioId}: missing sessionKey`);
      assert.ok(ev.wakeKey, `${scenarioId}: missing wakeKey`);
      assert.ok(ev.idempotencyKey, `${scenarioId}: missing idempotencyKey`);
      assert.ok(ev.plannedAt, `${scenarioId}: missing plannedAt`);
      assert.ok(ev.summary, `${scenarioId}: missing summary`);
      assert.equal(typeof ev.replayCount, "number", `${scenarioId}: replayCount not number`);
      assert.equal(typeof ev.coalesced, "boolean", `${scenarioId}: coalesced not boolean`);
    }
  });

  it("failure cells produce structured codes not free-form text", async () => {
    const badFixture: WakeScenarioFixture = {
      scenarioId: "S1_cold_wake",
      sessionKey: "session:bad",
      idempotencyKey: "idem:bad",
      priorWakes: [{ id: "x", scenarioId: "S1_cold_wake", sessionKey: "session:bad", wakeKey: "w", idempotencyKey: "idem:bad", plannedAt: new Date().toISOString(), status: "completed", summary: "", replayCount: 0, coalesced: false }],
    };
    const result = await runWakeProofMatrix([badFixture], createMockDispatcher());
    const cell = result.cells["S1_cold_wake"];
    assert.equal(cell.verdict, "fail");
    assert.ok(cell.error?.code, "Failure must have structured code");
    assert.ok(cell.auditEvent.errorCode, "Audit event must have error code");
  });

  it("matrix result is serializable (JSON-safe)", async () => {
    const result = await runWakeProofMatrix(defaultWakeFixtures(), createMockDispatcher());
    assert.doesNotThrow(() => JSON.stringify(result));
    const parsed = JSON.parse(JSON.stringify(result));
    assert.equal(parsed.totalScenarios, 5);
  });
});
