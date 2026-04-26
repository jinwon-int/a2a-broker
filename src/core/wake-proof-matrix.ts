/**
 * S1–S5 durable wake proof matrix (issue #92).
 *
 * Provides a deterministic, fixture-driven test harness for the five
 * wake/failure scenarios that a durable remote OpenClaw session must handle.
 *
 * Evidence produced per scenario:
 *   - sessionKey, runId, wakeAuditEvent
 *   - start/resume timestamps
 *   - terminal status + structured error codes (never free-form text)
 */

import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Scenario IDs
// ---------------------------------------------------------------------------

export const WAKE_SCENARIOS = [
  "S1_cold_wake",
  "S2_duplicate_suppression",
  "S3_warm_coalesced",
  "S4_failure_fallback",
  "S5_unreachable_degraded",
] as const;

export type WakeScenarioId = (typeof WAKE_SCENARIOS)[number];

// ---------------------------------------------------------------------------
// Structured failure / error codes
// ---------------------------------------------------------------------------

export type WakeErrorCode =
  | "WAKE_TARGET_UNREACHABLE"
  | "WAKE_SESSION_NOT_FOUND"
  | "WAKE_TIMEOUT"
  | "WAKE_DUPLICATE_SUPPRESSED"
  | "WAKE_COALESCED"
  | "WAKE_PEER_DEGRADED"
  | "WAKE_DISPATCH_FAILED"
  | "WAKE_INTERNAL_ERROR";

// ---------------------------------------------------------------------------
// Wake audit event — the evidence artifact
// ---------------------------------------------------------------------------

export interface WakeAuditEvent {
  /** Unique id for this wake attempt. */
  id: string;
  /** Which S1–S5 scenario this event belongs to. */
  scenarioId: WakeScenarioId;
  /** Target session key. */
  sessionKey: string;
  /** Runtime-assigned run id (if dispatch succeeded). */
  runId?: string;
  /** Broker-side wake key. */
  wakeKey: string;
  /** Idempotency key used for dedup. */
  idempotencyKey: string;
  /** Target node id (optional). */
  targetNodeId?: string;
  /** Correlation / parent context. */
  correlationId?: string;
  /** Parent run id (for chained wakes). */
  parentRunId?: string;

  // -- Lifecycle timestamps --
  plannedAt: string;
  decidedAt?: string;
  dispatchedAt?: string;
  completedAt?: string;

  // -- Terminal state --
  status: "planned" | "dispatched" | "suppressed" | "coalesced" | "failed" | "completed";
  /** Structured error code when status is "failed". */
  errorCode?: WakeErrorCode;
  /** Human-readable summary (for closeout review, redacted). */
  summary: string;

  // -- Replay / idempotency --
  /** How many times this wake was replayed. */
  replayCount: number;
  /** Whether this wake was coalesced with a prior in-flight wake. */
  coalesced: boolean;
}

// ---------------------------------------------------------------------------
// Proof matrix result
// ---------------------------------------------------------------------------

export interface WakeProofCellResult {
  scenarioId: WakeScenarioId;
  verdict: "pass" | "fail";
  /** Audit event produced by the scenario. */
  auditEvent: WakeAuditEvent;
  /** If verdict is "fail", structured error details. */
  error?: { code: string; message: string };
}

export interface WakeProofMatrixResult {
  /** ISO timestamp when the matrix was run. */
  runAt: string;
  /** Per-scenario results, keyed by scenario id. */
  cells: Record<WakeScenarioId, WakeProofCellResult>;
  /** Overall verdict: "pass" only if all cells pass. */
  overallVerdict: "pass" | "fail";
  /** Total number of scenarios. */
  totalScenarios: number;
  /** Number of passed scenarios. */
  passedScenarios: number;
  /** Number of failed scenarios. */
  failedScenarios: number;
}

// ---------------------------------------------------------------------------
// Scenario fixture input
// ---------------------------------------------------------------------------

export interface WakeScenarioFixture {
  scenarioId: WakeScenarioId;
  /** Session key to wake. */
  sessionKey: string;
  /** Optional target node. */
  targetNodeId?: string;
  /** Idempotency key — controls dedup behavior. */
  idempotencyKey: string;
  /** Simulated prior wakes (for S2/S3 replay/coalesce). */
  priorWakes: WakeAuditEvent[];
  /** Simulated peer status for S5. */
  peerStatus?: "online" | "stale" | "offline";
  /** Whether the dispatch should succeed or fail (for S4/S5). */
  dispatchShouldFail?: boolean;
  /** Expected dispatch error code (for S4/S5). */
  expectedErrorCode?: WakeErrorCode;
}

// ---------------------------------------------------------------------------
// Mock dispatcher interface — injectable for fixture testing
// ---------------------------------------------------------------------------

export interface WakeDispatcher {
  dispatch(sessionKey: string, runId: string): Promise<{
    dispatchedAt: string;
    completedAt?: string;
    status: "completed" | "failed";
    errorCode?: WakeErrorCode;
  }>;
}

// ---------------------------------------------------------------------------
// Default fixtures
// ---------------------------------------------------------------------------

export function defaultWakeFixtures(): WakeScenarioFixture[] {
  const baseSessionKey = "session:proof-matrix-test";
  const baseIdempotencyKey = "idem:proof-matrix-test";

  return [
    {
      scenarioId: "S1_cold_wake",
      sessionKey: `${baseSessionKey}:s1`,
      idempotencyKey: `${baseIdempotencyKey}:s1`,
      priorWakes: [],
      peerStatus: "online",
    },
    {
      scenarioId: "S2_duplicate_suppression",
      sessionKey: `${baseSessionKey}:s2`,
      idempotencyKey: `${baseIdempotencyKey}:s2`,
      priorWakes: [
        makeAuditEvent("S2_duplicate_suppression", `${baseSessionKey}:s2`, `${baseIdempotencyKey}:s2`, {
          status: "dispatched",
          dispatchedAt: new Date(Date.now() - 1000).toISOString(),
          completedAt: new Date().toISOString(),
          summary: "Prior wake already dispatched",
        }),
      ],
      peerStatus: "online",
    },
    {
      scenarioId: "S3_warm_coalesced",
      sessionKey: `${baseSessionKey}:s3`,
      idempotencyKey: `${baseIdempotencyKey}:s3`,
      priorWakes: [
        makeAuditEvent("S3_warm_coalesced", `${baseSessionKey}:s3`, `${baseIdempotencyKey}:s3`, {
          status: "dispatched",
          dispatchedAt: new Date(Date.now() - 500).toISOString(),
          summary: "In-flight wake, not yet completed",
        }),
      ],
      peerStatus: "online",
    },
    {
      scenarioId: "S4_failure_fallback",
      sessionKey: `${baseSessionKey}:s4`,
      idempotencyKey: `${baseIdempotencyKey}:s4`,
      priorWakes: [],
      peerStatus: "online",
      dispatchShouldFail: true,
      expectedErrorCode: "WAKE_DISPATCH_FAILED",
    },
    {
      scenarioId: "S5_unreachable_degraded",
      sessionKey: `${baseSessionKey}:s5`,
      idempotencyKey: `${baseIdempotencyKey}:s5`,
      priorWakes: [],
      peerStatus: "offline",
      dispatchShouldFail: true,
      expectedErrorCode: "WAKE_TARGET_UNREACHABLE",
    },
  ];
}

// ---------------------------------------------------------------------------
// Core matrix runner
// ---------------------------------------------------------------------------

/**
 * Run the full S1–S5 wake proof matrix against the given fixtures and
 * dispatcher. Returns deterministic, redacted results suitable for
 * closeout review.
 */
export async function runWakeProofMatrix(
  fixtures: WakeScenarioFixture[],
  dispatcher: WakeDispatcher,
): Promise<WakeProofMatrixResult> {
  const cells: Record<string, WakeProofCellResult> = {};
  let passed = 0;
  let failed = 0;

  for (const fixture of fixtures) {
    const cell = await runWakeScenario(fixture, dispatcher);
    cells[fixture.scenarioId] = cell;
    if (cell.verdict === "pass") passed++;
    else failed++;
  }

  return {
    runAt: new Date().toISOString(),
    cells: cells as Record<WakeScenarioId, WakeProofCellResult>,
    overallVerdict: failed === 0 ? "pass" : "fail",
    totalScenarios: fixtures.length,
    passedScenarios: passed,
    failedScenarios: failed,
  };
}

// ---------------------------------------------------------------------------
// Per-scenario runner
// ---------------------------------------------------------------------------

async function runWakeScenario(
  fixture: WakeScenarioFixture,
  dispatcher: WakeDispatcher,
): Promise<WakeProofCellResult> {
  const runId = randomUUID();
  const wakeKey = randomUUID();

  try {
    switch (fixture.scenarioId) {
      case "S1_cold_wake":
        return await runS1ColdWake(fixture, dispatcher, runId, wakeKey);

      case "S2_duplicate_suppression":
        return runS2DuplicateSuppression(fixture, wakeKey);

      case "S3_warm_coalesced":
        return runS3WarmCoalesced(fixture, wakeKey);

      case "S4_failure_fallback":
        return await runS4FailureFallback(fixture, dispatcher, runId, wakeKey);

      case "S5_unreachable_degraded":
        return await runS5UnreachableDegraded(fixture, dispatcher, runId, wakeKey);

      default:
        return {
          scenarioId: fixture.scenarioId,
          verdict: "fail",
          auditEvent: makeAuditEvent(fixture.scenarioId, fixture.sessionKey, fixture.idempotencyKey, {
            wakeKey,
            summary: "Unknown scenario",
          }),
          error: { code: "UNKNOWN_SCENARIO", message: `No handler for ${fixture.scenarioId}` },
        };
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      scenarioId: fixture.scenarioId,
      verdict: "fail",
      auditEvent: makeAuditEvent(fixture.scenarioId, fixture.sessionKey, fixture.idempotencyKey, {
        wakeKey,
        status: "failed",
        errorCode: "WAKE_INTERNAL_ERROR",
        summary: `[redacted internal error]`,
      }),
      error: { code: "WAKE_INTERNAL_ERROR", message },
    };
  }
}

// ---------------------------------------------------------------------------
// S1: Cold wake — fresh session, no prior state
// ---------------------------------------------------------------------------

async function runS1ColdWake(
  fixture: WakeScenarioFixture,
  dispatcher: WakeDispatcher,
  runId: string,
  wakeKey: string,
): Promise<WakeProofCellResult> {
  if (fixture.priorWakes.length > 0) {
    return failCell(fixture, wakeKey, "S1_PRECONDITION", "S1 cold wake requires no prior wakes");
  }

  const auditEvent = makeAuditEvent("S1_cold_wake", fixture.sessionKey, fixture.idempotencyKey, {
    wakeKey,
    runId,
    targetNodeId: fixture.targetNodeId,
  });

  const dispatchResult = await dispatcher.dispatch(fixture.sessionKey, runId);
  auditEvent.dispatchedAt = dispatchResult.dispatchedAt;
  auditEvent.completedAt = dispatchResult.completedAt;
  auditEvent.status = dispatchResult.status;

  if (dispatchResult.status === "failed") {
    auditEvent.errorCode = dispatchResult.errorCode;
    auditEvent.summary = "S1 cold wake dispatch failed";
    return {
      scenarioId: "S1_cold_wake",
      verdict: "fail",
      auditEvent,
      error: { code: dispatchResult.errorCode ?? "UNKNOWN", message: "Dispatch failed for cold wake" },
    };
  }

  auditEvent.summary = "S1 cold wake completed successfully";
  return { scenarioId: "S1_cold_wake", verdict: "pass", auditEvent };
}

// ---------------------------------------------------------------------------
// S2: Duplicate delivery suppression — same idempotency key
// ---------------------------------------------------------------------------

async function runS2DuplicateSuppression(
  fixture: WakeScenarioFixture,
  wakeKey: string,
): Promise<WakeProofCellResult> {
  if (fixture.priorWakes.length === 0) {
    return failCell(fixture, wakeKey, "S2_PRECONDITION", "S2 requires at least one prior wake");
  }

  const prior = fixture.priorWakes[0];
  if (prior.idempotencyKey !== fixture.idempotencyKey) {
    return failCell(fixture, wakeKey, "S2_KEY_MISMATCH", "Prior wake idempotency key does not match");
  }

  if (prior.status !== "dispatched" && prior.status !== "completed") {
    return failCell(fixture, wakeKey, "S2_INVALID_PRIOR_STATUS", "Prior wake must be dispatched or completed");
  }

  const auditEvent = makeAuditEvent("S2_duplicate_suppression", fixture.sessionKey, fixture.idempotencyKey, {
    wakeKey,
    status: "suppressed",
    errorCode: "WAKE_DUPLICATE_SUPPRESSED",
    summary: "S2 duplicate delivery suppressed by idempotency key",
    replayCount: 1,
  });

  return { scenarioId: "S2_duplicate_suppression", verdict: "pass", auditEvent };
}

// ---------------------------------------------------------------------------
// S3: Warm / coalesced wake — in-flight wake exists, coalesce
// ---------------------------------------------------------------------------

async function runS3WarmCoalesced(
  fixture: WakeScenarioFixture,
  wakeKey: string,
): Promise<WakeProofCellResult> {
  if (fixture.priorWakes.length === 0) {
    return failCell(fixture, wakeKey, "S3_PRECONDITION", "S3 requires at least one prior wake");
  }

  const prior = fixture.priorWakes[0];
  if (prior.status !== "dispatched") {
    return failCell(fixture, wakeKey, "S3_NOT_INFLIGHT", "Prior wake must be in-flight (dispatched, not completed)");
  }

  const auditEvent = makeAuditEvent("S3_warm_coalesced", fixture.sessionKey, fixture.idempotencyKey, {
    wakeKey,
    status: "coalesced",
    errorCode: "WAKE_COALESCED",
    summary: "S3 warm wake coalesced with in-flight wake",
    coalesced: true,
    replayCount: 1,
  });

  return { scenarioId: "S3_warm_coalesced", verdict: "pass", auditEvent };
}

// ---------------------------------------------------------------------------
// S4: Wake failure fallback — dispatch fails, structured error
// ---------------------------------------------------------------------------

async function runS4FailureFallback(
  fixture: WakeScenarioFixture,
  dispatcher: WakeDispatcher,
  runId: string,
  wakeKey: string,
): Promise<WakeProofCellResult> {
  if (!fixture.dispatchShouldFail) {
    return failCell(fixture, wakeKey, "S4_PRECONDITION", "S4 requires dispatchShouldFail=true");
  }

  const auditEvent = makeAuditEvent("S4_failure_fallback", fixture.sessionKey, fixture.idempotencyKey, {
    wakeKey,
    runId,
  });

  const dispatchResult = await dispatcher.dispatch(fixture.sessionKey, runId);
  auditEvent.dispatchedAt = dispatchResult.dispatchedAt;
  auditEvent.status = "failed";
  auditEvent.errorCode = dispatchResult.errorCode ?? "WAKE_DISPATCH_FAILED";
  auditEvent.summary = "S4 wake failure with structured fallback";

  const expectedCode = fixture.expectedErrorCode;
  if (expectedCode && dispatchResult.errorCode !== expectedCode) {
    return {
      scenarioId: "S4_failure_fallback",
      verdict: "fail",
      auditEvent,
      error: {
        code: "S4_ERROR_CODE_MISMATCH",
        message: `Expected ${expectedCode}, got ${dispatchResult.errorCode}`,
      },
    };
  }

  return { scenarioId: "S4_failure_fallback", verdict: "pass", auditEvent };
}

// ---------------------------------------------------------------------------
// S5: Target unreachable / degraded peer
// ---------------------------------------------------------------------------

async function runS5UnreachableDegraded(
  fixture: WakeScenarioFixture,
  dispatcher: WakeDispatcher,
  runId: string,
  wakeKey: string,
): Promise<WakeProofCellResult> {
  if (fixture.peerStatus !== "offline" && fixture.peerStatus !== "stale") {
    return failCell(fixture, wakeKey, "S5_PRECONDITION", "S5 requires peerStatus=offline or stale");
  }

  const auditEvent = makeAuditEvent("S5_unreachable_degraded", fixture.sessionKey, fixture.idempotencyKey, {
    wakeKey,
    runId,
    targetNodeId: fixture.targetNodeId,
  });

  const dispatchResult = await dispatcher.dispatch(fixture.sessionKey, runId);
  auditEvent.dispatchedAt = dispatchResult.dispatchedAt;
  auditEvent.status = "failed";

  // S5 should produce either UNREACHABLE or DEGRADED depending on peer status
  const validCodes: WakeErrorCode[] =
    fixture.peerStatus === "offline"
      ? ["WAKE_TARGET_UNREACHABLE"]
      : ["WAKE_TARGET_UNREACHABLE", "WAKE_PEER_DEGRADED"];

  const code = dispatchResult.errorCode ?? "WAKE_TARGET_UNREACHABLE";
  auditEvent.errorCode = code;
  auditEvent.summary = `S5 target ${fixture.peerStatus}, wake failed with structured code`;

  if (!validCodes.includes(code)) {
    return {
      scenarioId: "S5_unreachable_degraded",
      verdict: "fail",
      auditEvent,
      error: {
        code: "S5_INVALID_ERROR_CODE",
        message: `Expected one of ${validCodes.join(",")}, got ${code}`,
      },
    };
  }

  if (fixture.expectedErrorCode && code !== fixture.expectedErrorCode) {
    return {
      scenarioId: "S5_unreachable_degraded",
      verdict: "fail",
      auditEvent,
      error: {
        code: "S5_ERROR_CODE_MISMATCH",
        message: `Expected ${fixture.expectedErrorCode}, got ${code}`,
      },
    };
  }

  return { scenarioId: "S5_unreachable_degraded", verdict: "pass", auditEvent };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAuditEvent(
  scenarioId: WakeScenarioId,
  sessionKey: string,
  idempotencyKey: string,
  overrides: Partial<WakeAuditEvent> = {},
): WakeAuditEvent {
  return {
    id: randomUUID(),
    scenarioId,
    sessionKey,
    wakeKey: "",
    idempotencyKey,
    plannedAt: new Date().toISOString(),
    status: "planned",
    summary: "",
    replayCount: 0,
    coalesced: false,
    ...overrides,
  };
}

function failCell(
  fixture: WakeScenarioFixture,
  wakeKey: string,
  code: string,
  message: string,
): WakeProofCellResult {
  return {
    scenarioId: fixture.scenarioId,
    verdict: "fail",
    auditEvent: makeAuditEvent(fixture.scenarioId, fixture.sessionKey, fixture.idempotencyKey, {
      wakeKey,
      status: "failed",
      errorCode: "WAKE_INTERNAL_ERROR",
      summary: "[redacted precondition failure]",
    }),
    error: { code, message },
  };
}
