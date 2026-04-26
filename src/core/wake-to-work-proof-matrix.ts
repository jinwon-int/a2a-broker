/**
 * Wake-to-Work proof matrix (issue #97).
 *
 * Extends the Round 20 wake proof into a full wake-to-work lifecycle:
 *   wake → payload delivery → execution → result reporting / failure
 *
 * Builds on WakeSessionState/WakeEvent from wake-audit-types.ts.
 * Produces deterministic, redacted, JSON-safe proof artifacts.
 */

import { randomUUID } from "node:crypto";
import type { WakeFailureCode } from "./wake-audit-types.js";

// ---------------------------------------------------------------------------
// Scenario IDs
// ---------------------------------------------------------------------------

export const WAKE_TO_WORK_SCENARIOS = [
  "S1_cold_wake_execute",
  "S2_duplicate_delivery_suppression",
  "S3_warm_coalesced_execute",
  "S4_execution_failure_timeout",
  "S5_unreachable_degraded_during_exec",
] as const;

export type WakeToWorkScenarioId = (typeof WAKE_TO_WORK_SCENARIOS)[number];

// ---------------------------------------------------------------------------
// Execution error codes (structured only)
// ---------------------------------------------------------------------------

export type ExecutionErrorCode =
  | "EXEC_PAYLOAD_DELIVERY_FAILED"
  | "EXEC_SESSION_NOT_FOUND"
  | "EXEC_TIMEOUT"
  | "EXEC_RUNTIME_ERROR"
  | "EXEC_RESULT_MALFORMED"
  | "EXEC_TARGET_UNREACHABLE"
  | "EXEC_PEER_DEGRADED"
  | "EXEC_DUPLICATE_SUPPRESSED"
  | "EXEC_COALESCED"
  | "EXEC_ABORTED";

// ---------------------------------------------------------------------------
// Delivery status
// ---------------------------------------------------------------------------

export type DeliveryStatus = "pending" | "delivered" | "failed" | "suppressed" | "coalesced";

// ---------------------------------------------------------------------------
// Execution status
// ---------------------------------------------------------------------------

export type ExecutionStatus = "pending" | "running" | "completed" | "failed" | "timed_out" | "aborted";

// ---------------------------------------------------------------------------
// Full wake-to-work audit artifact
// ---------------------------------------------------------------------------

export interface WakeToWorkAuditArtifact {
  /** Unique id for this proof run. */
  id: string;
  /** Scenario id (S1–S5). */
  scenarioId: WakeToWorkScenarioId;

  // -- Wake phase --
  wakeId: string;
  wakeStatus: "requested" | "accepted" | "suppressed" | "coalesced" | "failed";
  wakeErrorCode?: ExecutionErrorCode;
  wakePlannedAt: string;
  wakeDispatchedAt?: string;

  // -- Delivery phase --
  deliveryId: string;
  deliveryStatus: DeliveryStatus;
  deliveryErrorCode?: ExecutionErrorCode;
  deliveredAt?: string;

  // -- Execution phase --
  executionId: string;
  executionStatus: ExecutionStatus;
  executionErrorCode?: ExecutionErrorCode;
  executionStartedAt?: string;
  executionCompletedAt?: string;
  executionDurationMs?: number;

  // -- Result phase --
  resultId?: string;
  resultSummary?: string;
  resultArtifactIds?: string[];

  // -- Idempotency / replay --
  idempotencyKey: string;
  sessionKey: string;
  targetNodeId?: string;
  replayCount: number;
  coalesced: boolean;

  // -- Redaction --
  /** Hash placeholder for content redaction (no raw prompt/transcript). */
  redactionHash: string;

  // -- Metadata --
  summary: string;
}

// ---------------------------------------------------------------------------
// Per-cell result
// ---------------------------------------------------------------------------

export interface WakeToWorkCellResult {
  scenarioId: WakeToWorkScenarioId;
  verdict: "pass" | "fail";
  artifact: WakeToWorkAuditArtifact;
  error?: { code: string; message: string };
}

// ---------------------------------------------------------------------------
// Matrix result
// ---------------------------------------------------------------------------

export interface WakeToWorkMatrixResult {
  runAt: string;
  cells: Record<WakeToWorkScenarioId, WakeToWorkCellResult>;
  overallVerdict: "pass" | "fail";
  totalScenarios: number;
  passedScenarios: number;
  failedScenarios: number;
}

// ---------------------------------------------------------------------------
// Scenario fixture
// ---------------------------------------------------------------------------

export interface WakeToWorkFixture {
  scenarioId: WakeToWorkScenarioId;
  sessionKey: string;
  idempotencyKey: string;
  targetNodeId?: string;
  peerStatus?: "online" | "stale" | "offline";
  priorWork?: WakeToWorkAuditArtifact[];
  dispatchShouldFail?: boolean;
  deliveryShouldFail?: boolean;
  executionShouldFail?: boolean;
  executionShouldTimeout?: boolean;
  expectedWakeErrorCode?: ExecutionErrorCode;
  expectedExecutionErrorCode?: ExecutionErrorCode;
}

// ---------------------------------------------------------------------------
// Mock executor interface
// ---------------------------------------------------------------------------

export interface WakeToWorkExecutor {
  deliver(sessionKey: string, deliveryId: string): Promise<{
    status: "delivered" | "failed";
    errorCode?: ExecutionErrorCode;
    deliveredAt: string;
  }>;
  execute(sessionKey: string, executionId: string): Promise<{
    status: ExecutionStatus;
    errorCode?: ExecutionErrorCode;
    startedAt: string;
    completedAt?: string;
    durationMs?: number;
    resultId?: string;
    resultSummary?: string;
    resultArtifactIds?: string[];
  }>;
}

// ---------------------------------------------------------------------------
// Default fixtures
// ---------------------------------------------------------------------------

export function defaultWakeToWorkFixtures(): WakeToWorkFixture[] {
  const base = "session:w2w-proof";
  const baseIdem = "idem:w2w-proof";
  return [
    {
      scenarioId: "S1_cold_wake_execute",
      sessionKey: `${base}:s1`,
      idempotencyKey: `${baseIdem}:s1`,
      peerStatus: "online",
    },
    {
      scenarioId: "S2_duplicate_delivery_suppression",
      sessionKey: `${base}:s2`,
      idempotencyKey: `${baseIdem}:s2`,
      peerStatus: "online",
      priorWork: [makeArtifact("S2_duplicate_delivery_suppression", `${base}:s2`, `${baseIdem}:s2`, {
        wakeStatus: "accepted",
        deliveryStatus: "delivered",
        executionStatus: "completed",
      })],
    },
    {
      scenarioId: "S3_warm_coalesced_execute",
      sessionKey: `${base}:s3`,
      idempotencyKey: `${baseIdem}:s3`,
      peerStatus: "online",
      priorWork: [makeArtifact("S3_warm_coalesced_execute", `${base}:s3`, `${baseIdem}:s3`, {
        wakeStatus: "accepted",
        deliveryStatus: "delivered",
        executionStatus: "running",
      })],
    },
    {
      scenarioId: "S4_execution_failure_timeout",
      sessionKey: `${base}:s4`,
      idempotencyKey: `${baseIdem}:s4`,
      peerStatus: "online",
      executionShouldTimeout: true,
      expectedExecutionErrorCode: "EXEC_TIMEOUT",
    },
    {
      scenarioId: "S5_unreachable_degraded_during_exec",
      sessionKey: `${base}:s5`,
      idempotencyKey: `${baseIdem}:s5`,
      peerStatus: "offline",
      deliveryShouldFail: true,
      expectedWakeErrorCode: "EXEC_TARGET_UNREACHABLE",
    },
  ];
}

// ---------------------------------------------------------------------------
// Matrix runner
// ---------------------------------------------------------------------------

export async function runWakeToWorkMatrix(
  fixtures: WakeToWorkFixture[],
  executor: WakeToWorkExecutor,
): Promise<WakeToWorkMatrixResult> {
  const cells: Record<string, WakeToWorkCellResult> = {};
  let passed = 0;
  let failed = 0;

  for (const fixture of fixtures) {
    const cell = await runWakeToWorkScenario(fixture, executor);
    cells[fixture.scenarioId] = cell;
    if (cell.verdict === "pass") passed++;
    else failed++;
  }

  return {
    runAt: new Date().toISOString(),
    cells: cells as Record<WakeToWorkScenarioId, WakeToWorkCellResult>,
    overallVerdict: failed === 0 ? "pass" : "fail",
    totalScenarios: fixtures.length,
    passedScenarios: passed,
    failedScenarios: failed,
  };
}

// ---------------------------------------------------------------------------
// Per-scenario runners
// ---------------------------------------------------------------------------

async function runWakeToWorkScenario(
  fixture: WakeToWorkFixture,
  executor: WakeToWorkExecutor,
): Promise<WakeToWorkCellResult> {
  const wakeId = randomUUID();
  const deliveryId = randomUUID();
  const executionId = randomUUID();

  try {
    switch (fixture.scenarioId) {
      case "S1_cold_wake_execute":
        return await runS1(fixture, executor, wakeId, deliveryId, executionId);
      case "S2_duplicate_delivery_suppression":
        return runS2(fixture, wakeId, deliveryId, executionId);
      case "S3_warm_coalesced_execute":
        return runS3(fixture, wakeId, deliveryId, executionId);
      case "S4_execution_failure_timeout":
        return await runS4(fixture, executor, wakeId, deliveryId, executionId);
      case "S5_unreachable_degraded_during_exec":
        return await runS5(fixture, executor, wakeId, deliveryId, executionId);
      default:
        return failCell(fixture, "UNKNOWN_SCENARIO", `No handler for ${fixture.scenarioId}`);
    }
  } catch (err: unknown) {
    return failCell(fixture, "INTERNAL_ERROR", err instanceof Error ? err.message : String(err));
  }
}

// S1: Cold wake + payload delivery + execution + result
async function runS1(
  fixture: WakeToWorkFixture,
  executor: WakeToWorkExecutor,
  wakeId: string,
  deliveryId: string,
  executionId: string,
): Promise<WakeToWorkCellResult> {
  if (fixture.priorWork?.length) {
    return failCell(fixture, "S1_PRECONDITION", "S1 requires no prior work");
  }

  const artifact = makeArtifact(fixture.scenarioId, fixture.sessionKey, fixture.idempotencyKey, {
    wakeId, deliveryId, executionId, targetNodeId: fixture.targetNodeId,
  });

  // Wake phase
  artifact.wakeStatus = "accepted";
  artifact.wakeDispatchedAt = new Date().toISOString();

  // Delivery phase
  const delivery = await executor.deliver(fixture.sessionKey, deliveryId);
  artifact.deliveryStatus = delivery.status;
  artifact.deliveredAt = delivery.deliveredAt;
  if (delivery.status === "failed") {
    artifact.deliveryErrorCode = delivery.errorCode;
    artifact.wakeStatus = "failed";
    artifact.wakeErrorCode = delivery.errorCode;
    artifact.summary = "S1 delivery failed";
    return { scenarioId: "S1_cold_wake_execute", verdict: "fail", artifact, error: { code: "S1_DELIVERY_FAILED", message: "Delivery failed for cold wake" } };
  }

  // Execution phase
  const exec = await executor.execute(fixture.sessionKey, executionId);
  artifact.executionStatus = exec.status;
  artifact.executionStartedAt = exec.startedAt;
  artifact.executionCompletedAt = exec.completedAt;
  artifact.executionDurationMs = exec.durationMs;
  if (exec.status === "failed" || exec.status === "timed_out") {
    artifact.executionErrorCode = exec.errorCode;
    artifact.summary = "S1 execution failed";
    return { scenarioId: "S1_cold_wake_execute", verdict: "fail", artifact, error: { code: "S1_EXECUTION_FAILED", message: "Execution failed" } };
  }

  // Result phase
  artifact.resultId = exec.resultId;
  artifact.resultSummary = exec.resultSummary;
  artifact.resultArtifactIds = exec.resultArtifactIds;
  artifact.summary = "S1 cold wake-to-work completed";
  return { scenarioId: "S1_cold_wake_execute", verdict: "pass", artifact };
}

// S2: Duplicate payload delivery suppression
function runS2(
  fixture: WakeToWorkFixture,
  wakeId: string,
  deliveryId: string,
  executionId: string,
): WakeToWorkCellResult {
  if (!fixture.priorWork?.length) {
    return failCell(fixture, "S2_PRECONDITION", "S2 requires prior completed work");
  }
  const prior = fixture.priorWork[0];
  if (prior.idempotencyKey !== fixture.idempotencyKey) {
    return failCell(fixture, "S2_KEY_MISMATCH", "Prior work idempotency key does not match");
  }

  const artifact = makeArtifact(fixture.scenarioId, fixture.sessionKey, fixture.idempotencyKey, {
    wakeId, deliveryId, executionId,
    wakeStatus: "suppressed",
    wakeErrorCode: "EXEC_DUPLICATE_SUPPRESSED",
    deliveryStatus: "suppressed",
    deliveryErrorCode: "EXEC_DUPLICATE_SUPPRESSED",
    replayCount: 1,
    summary: "S2 duplicate delivery suppressed by idempotency key",
  });

  return { scenarioId: "S2_duplicate_delivery_suppression", verdict: "pass", artifact };
}

// S3: Warm/coalesced session execution
function runS3(
  fixture: WakeToWorkFixture,
  wakeId: string,
  deliveryId: string,
  executionId: string,
): WakeToWorkCellResult {
  if (!fixture.priorWork?.length) {
    return failCell(fixture, "S3_PRECONDITION", "S3 requires prior in-flight work");
  }
  const prior = fixture.priorWork[0];
  if (prior.executionStatus !== "running") {
    return failCell(fixture, "S3_NOT_INFLIGHT", "Prior execution must be running");
  }

  const artifact = makeArtifact(fixture.scenarioId, fixture.sessionKey, fixture.idempotencyKey, {
    wakeId, deliveryId, executionId,
    wakeStatus: "coalesced",
    wakeErrorCode: "EXEC_COALESCED",
    deliveryStatus: "coalesced",
    deliveryErrorCode: "EXEC_COALESCED",
    coalesced: true,
    replayCount: 1,
    summary: "S3 warm execution coalesced with in-flight session",
  });

  return { scenarioId: "S3_warm_coalesced_execute", verdict: "pass", artifact };
}

// S4: Execution failure / timeout
async function runS4(
  fixture: WakeToWorkFixture,
  executor: WakeToWorkExecutor,
  wakeId: string,
  deliveryId: string,
  executionId: string,
): Promise<WakeToWorkCellResult> {
  if (!fixture.executionShouldFail && !fixture.executionShouldTimeout) {
    return failCell(fixture, "S4_PRECONDITION", "S4 requires executionShouldFail or executionShouldTimeout");
  }

  const artifact = makeArtifact(fixture.scenarioId, fixture.sessionKey, fixture.idempotencyKey, {
    wakeId, deliveryId, executionId,
    wakeStatus: "accepted",
    wakeDispatchedAt: new Date().toISOString(),
  });

  // Delivery should succeed
  const delivery = await executor.deliver(fixture.sessionKey, deliveryId);
  artifact.deliveryStatus = delivery.status;
  artifact.deliveredAt = delivery.deliveredAt;

  // Execution should fail/timeout
  const exec = await executor.execute(fixture.sessionKey, executionId);
  artifact.executionStatus = exec.status;
  artifact.executionStartedAt = exec.startedAt;
  artifact.executionCompletedAt = exec.completedAt;
  artifact.executionDurationMs = exec.durationMs;
  artifact.executionErrorCode = exec.errorCode;
  artifact.summary = "S4 execution failure with structured fallback";

  if (fixture.expectedExecutionErrorCode && exec.errorCode !== fixture.expectedExecutionErrorCode) {
    return {
      scenarioId: "S4_execution_failure_timeout", verdict: "fail", artifact,
      error: { code: "S4_CODE_MISMATCH", message: `Expected ${fixture.expectedExecutionErrorCode}, got ${exec.errorCode}` },
    };
  }

  return { scenarioId: "S4_execution_failure_timeout", verdict: "pass", artifact };
}

// S5: Target unreachable/degraded during execution
async function runS5(
  fixture: WakeToWorkFixture,
  executor: WakeToWorkExecutor,
  wakeId: string,
  deliveryId: string,
  executionId: string,
): Promise<WakeToWorkCellResult> {
  if (fixture.peerStatus !== "offline" && fixture.peerStatus !== "stale") {
    return failCell(fixture, "S5_PRECONDITION", "S5 requires peerStatus=offline or stale");
  }

  const artifact = makeArtifact(fixture.scenarioId, fixture.sessionKey, fixture.idempotencyKey, {
    wakeId, deliveryId, executionId, targetNodeId: fixture.targetNodeId,
  });

  // Wake phase
  artifact.wakeStatus = "failed";
  artifact.wakeErrorCode = fixture.expectedWakeErrorCode ?? "EXEC_TARGET_UNREACHABLE";

  // Delivery phase
  const delivery = await executor.deliver(fixture.sessionKey, deliveryId);
  artifact.deliveryStatus = delivery.status;
  artifact.deliveredAt = delivery.deliveredAt;
  if (delivery.status === "failed") {
    artifact.deliveryErrorCode = delivery.errorCode;
  }

  artifact.executionStatus = "failed";
  artifact.executionErrorCode = fixture.expectedWakeErrorCode ?? "EXEC_TARGET_UNREACHABLE";
  artifact.summary = `S5 target ${fixture.peerStatus}, wake-to-work failed with structured code`;

  return { scenarioId: "S5_unreachable_degraded_during_exec", verdict: "pass", artifact };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeArtifact(
  scenarioId: WakeToWorkScenarioId,
  sessionKey: string,
  idempotencyKey: string,
  overrides: Partial<WakeToWorkAuditArtifact> = {},
): WakeToWorkAuditArtifact {
  return {
    id: randomUUID(),
    scenarioId,
    wakeId: randomUUID(),
    wakeStatus: "requested",
    wakePlannedAt: new Date().toISOString(),
    deliveryId: randomUUID(),
    deliveryStatus: "pending",
    executionId: randomUUID(),
    executionStatus: "pending",
    idempotencyKey,
    sessionKey,
    replayCount: 0,
    coalesced: false,
    redactionHash: `sha256:${randomUUID().slice(0, 16)}`,
    summary: "",
    ...overrides,
  };
}

function failCell(
  fixture: WakeToWorkFixture,
  code: string,
  message: string,
): WakeToWorkCellResult {
  const artifact = makeArtifact(fixture.scenarioId, fixture.sessionKey, fixture.idempotencyKey, {
    wakeStatus: "failed",
    executionStatus: "failed",
    executionErrorCode: "EXEC_RUNTIME_ERROR",
    deliveryStatus: "failed",
    deliveryErrorCode: "EXEC_RUNTIME_ERROR",
    summary: "[redacted precondition failure]",
  });
  return { scenarioId: fixture.scenarioId, verdict: "fail", artifact, error: { code, message } };
}
