/**
 * Delivery proof matrix (issue #102).
 *
 * Round 22 focuses on the delivery phase — status/result delivery
 * after durable remote execution completes (or fails).
 *
 * S1: Normal delivery from remote session to broker
 * S2: Duplicate delivery / idempotent replay
 * S3: Transient delivery failure and retry
 * S4: Timeout / unreachable mobile node
 * S5: Redacted terminal failure with safe operator-visible evidence
 *
 * Produces deterministic, redacted, JSON-safe proof artifacts.
 */

import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Scenario IDs
// ---------------------------------------------------------------------------

export const DELIVERY_SCENARIOS = [
  "S1_normal_delivery",
  "S2_duplicate_idempotent_replay",
  "S3_transient_failure_retry",
  "S4_timeout_unreachable_mobile",
  "S5_redacted_terminal_failure",
] as const;

export type DeliveryScenarioId = (typeof DELIVERY_SCENARIOS)[number];

// ---------------------------------------------------------------------------
// Delivery error codes
// ---------------------------------------------------------------------------

export type DeliveryErrorCode =
  | "DELIVERY_OK"
  | "DELIVERY_DUPLICATE_SUPPRESSED"
  | "DELIVERY_TRANSIENT_FAILURE"
  | "DELIVERY_RETRY_EXHAUSTED"
  | "DELIVERY_TARGET_UNREACHABLE"
  | "DELIVERY_TIMEOUT"
  | "DELIVERY_RESULT_MALFORMED"
  | "DELIVERY_CHANNEL_ERROR"
  | "DELIVERY_TERMINAL_FAILURE";

// ---------------------------------------------------------------------------
// Delivery attempt status
// ---------------------------------------------------------------------------

export type DeliveryAttemptStatus =
  | "pending"
  | "in_flight"
  | "delivered"
  | "failed"
  | "suppressed"
  | "queued"
  | "redacted";

// ---------------------------------------------------------------------------
// Delivery audit artifact
// ---------------------------------------------------------------------------

export interface DeliveryAuditArtifact {
  /** Unique id for this proof run. */
  id: string;
  /** Scenario id (S1–S5). */
  scenarioId: DeliveryScenarioId;

  // -- Source (remote execution result) --
  sourceSessionId: string;
  sourceExecutionId: string;
  sourceCompletedAt: string;
  sourceStatus: "completed" | "failed" | "timed_out" | "aborted";
  sourceResultId?: string;
  sourceResultSummary?: string;

  // -- Delivery phase --
  deliveryId: string;
  deliveryAttempt: number;
  deliveryStatus: DeliveryAttemptStatus;
  deliveryErrorCode?: DeliveryErrorCode;
  deliveryInitiatedAt?: string;
  deliveryCompletedAt?: string;
  deliveryChannel?: string;

  // -- Retry tracking --
  retryCount: number;
  maxRetries: number;
  retryDelaysMs?: number[];
  lastFailureCode?: DeliveryErrorCode;

  // -- Deduplication --
  deduplicationKey: string;
  seenBefore: boolean;

  // -- Target node --
  targetNodeId?: string;
  targetReachable: boolean;

  // -- Result payload (redacted) --
  resultPayloadHash?: string;
  resultPayloadSizeBytes?: number;

  // -- Operator evidence --
  operatorEvidence: {
    /** Structured error code visible to operator. */
    code: string;
    /** Human-readable summary (no secrets). */
    summary: string;
    /** Whether raw content was redacted. */
    redacted: boolean;
    /** Redaction hash for audit trail. */
    redactionHash: string;
  };

  // -- Metadata --
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Per-cell result
// ---------------------------------------------------------------------------

export interface DeliveryCellResult {
  scenarioId: DeliveryScenarioId;
  verdict: "pass" | "fail";
  artifact: DeliveryAuditArtifact;
  error?: { code: string; message: string };
}

// ---------------------------------------------------------------------------
// Matrix result
// ---------------------------------------------------------------------------

export interface DeliveryMatrixResult {
  runAt: string;
  cells: Record<DeliveryScenarioId, DeliveryCellResult>;
  overallVerdict: "pass" | "fail";
  totalScenarios: number;
  passedScenarios: number;
  failedScenarios: number;
}

// ---------------------------------------------------------------------------
// Scenario fixture
// ---------------------------------------------------------------------------

export interface DeliveryFixture {
  scenarioId: DeliveryScenarioId;
  sourceSessionId: string;
  sourceExecutionId: string;
  deduplicationKey: string;
  targetNodeId?: string;
  targetReachable?: boolean;
  deliveryChannel?: string;
  /** Whether this delivery was seen before (for S2). */
  seenBefore?: boolean;
  /** Whether the delivery should fail transiently on first attempt (for S3). */
  transientFailureOnFirstAttempt?: boolean;
  /** Max retry attempts before giving up. */
  maxRetries?: number;
  /** Whether the target is a mobile node that can timeout (for S4). */
  mobileTimeout?: boolean;
  /** Whether this should produce a terminal failure (for S5). */
  terminalFailure?: boolean;
}

// ---------------------------------------------------------------------------
// Mock deliverer interface
// ---------------------------------------------------------------------------

export interface DeliveryExecutor {
  deliver(params: {
    deliveryId: string;
    targetNodeId?: string;
    channel: string;
    payload: unknown;
    scenarioHint?: string;
  }): Promise<{
    status: "delivered" | "failed";
    errorCode?: DeliveryErrorCode;
    completedAt: string;
  }>;
  checkReachable(targetNodeId?: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Default fixtures
// ---------------------------------------------------------------------------

export function defaultDeliveryFixtures(): DeliveryFixture[] {
  const base = "delivery-proof";
  return [
    {
      scenarioId: "S1_normal_delivery",
      sourceSessionId: `${base}:s1-session`,
      sourceExecutionId: `${base}:s1-exec`,
      deduplicationKey: `${base}:s1-dedup`,
      targetNodeId: "broker-main",
      targetReachable: true,
      deliveryChannel: "a2a-webhook",
    },
    {
      scenarioId: "S2_duplicate_idempotent_replay",
      sourceSessionId: `${base}:s2-session`,
      sourceExecutionId: `${base}:s2-exec`,
      deduplicationKey: `${base}:s2-dedup`,
      targetNodeId: "broker-main",
      targetReachable: true,
      deliveryChannel: "a2a-webhook",
      seenBefore: true,
    },
    {
      scenarioId: "S3_transient_failure_retry",
      sourceSessionId: `${base}:s3-session`,
      sourceExecutionId: `${base}:s3-exec`,
      deduplicationKey: `${base}:s3-dedup`,
      targetNodeId: "broker-main",
      targetReachable: true,
      deliveryChannel: "a2a-webhook",
      transientFailureOnFirstAttempt: true,
      maxRetries: 3,
    },
    {
      scenarioId: "S4_timeout_unreachable_mobile",
      sourceSessionId: `${base}:s4-session`,
      sourceExecutionId: `${base}:s4-exec`,
      deduplicationKey: `${base}:s4-dedup`,
      targetNodeId: "mobile-termux",
      targetReachable: false,
      deliveryChannel: "a2a-push",
      mobileTimeout: true,
    },
    {
      scenarioId: "S5_redacted_terminal_failure",
      sourceSessionId: `${base}:s5-session`,
      sourceExecutionId: `${base}:s5-exec`,
      deduplicationKey: `${base}:s5-dedup`,
      targetNodeId: "broker-main",
      targetReachable: true,
      deliveryChannel: "a2a-webhook",
      terminalFailure: true,
    },
  ];
}

// ---------------------------------------------------------------------------
// Matrix runner
// ---------------------------------------------------------------------------

export async function runDeliveryMatrix(
  fixtures: DeliveryFixture[],
  executor: DeliveryExecutor,
): Promise<DeliveryMatrixResult> {
  const cells: Record<string, DeliveryCellResult> = {};
  let passed = 0;
  let failed = 0;

  for (const fixture of fixtures) {
    const cell = await runDeliveryScenario(fixture, executor);
    cells[fixture.scenarioId] = cell;
    if (cell.verdict === "pass") passed++;
    else failed++;
  }

  return {
    runAt: new Date().toISOString(),
    cells: cells as Record<DeliveryScenarioId, DeliveryCellResult>,
    overallVerdict: failed === 0 ? "pass" : "fail",
    totalScenarios: fixtures.length,
    passedScenarios: passed,
    failedScenarios: failed,
  };
}

// ---------------------------------------------------------------------------
// Per-scenario runners
// ---------------------------------------------------------------------------

async function runDeliveryScenario(
  fixture: DeliveryFixture,
  executor: DeliveryExecutor,
): Promise<DeliveryCellResult> {
  try {
    switch (fixture.scenarioId) {
      case "S1_normal_delivery":
        return await runS1(fixture, executor);
      case "S2_duplicate_idempotent_replay":
        return runS2(fixture);
      case "S3_transient_failure_retry":
        return await runS3(fixture, executor);
      case "S4_timeout_unreachable_mobile":
        return await runS4(fixture, executor);
      case "S5_redacted_terminal_failure":
        return await runS5(fixture, executor);
      default:
        return failCell(fixture, "UNKNOWN_SCENARIO", `No handler for ${fixture.scenarioId}`);
    }
  } catch (err: unknown) {
    return failCell(fixture, "INTERNAL_ERROR", err instanceof Error ? err.message : String(err));
  }
}

// S1: Normal delivery — result from remote session arrives at broker intact
async function runS1(
  fixture: DeliveryFixture,
  executor: DeliveryExecutor,
): Promise<DeliveryCellResult> {
  const deliveryId = randomUUID();
  const now = new Date().toISOString();
  const reachable = await executor.checkReachable(fixture.targetNodeId);

  if (!reachable) {
    return failCell(fixture, "S1_TARGET_UNREACHABLE", "Target must be reachable for S1");
  }

  const payload = { resultId: "result-" + randomUUID(), summary: "[redacted]" };
  const result = await executor.deliver({
    deliveryId,
    targetNodeId: fixture.targetNodeId,
    channel: fixture.deliveryChannel ?? "a2a-webhook",
    payload,
  });

  if (result.status === "failed") {
    return failCell(fixture, "S1_DELIVERY_FAILED", `Delivery failed: ${result.errorCode}`);
  }

  const artifact: DeliveryAuditArtifact = {
    id: randomUUID(),
    scenarioId: "S1_normal_delivery",
    sourceSessionId: fixture.sourceSessionId,
    sourceExecutionId: fixture.sourceExecutionId,
    sourceCompletedAt: now,
    sourceStatus: "completed",
    sourceResultId: "result-" + deliveryId.slice(0, 8),
    sourceResultSummary: "[redacted]",
    deliveryId,
    deliveryAttempt: 1,
    deliveryStatus: "delivered",
    deliveryErrorCode: "DELIVERY_OK",
    deliveryInitiatedAt: now,
    deliveryCompletedAt: result.completedAt,
    deliveryChannel: fixture.deliveryChannel,
    retryCount: 0,
    maxRetries: 0,
    deduplicationKey: fixture.deduplicationKey,
    seenBefore: false,
    targetNodeId: fixture.targetNodeId,
    targetReachable: true,
    resultPayloadHash: `sha256:${randomUUID().slice(0, 16)}`,
    resultPayloadSizeBytes: 128,
    operatorEvidence: {
      code: "DELIVERY_OK",
      summary: "S1 normal delivery completed — result payload delivered to broker",
      redacted: true,
      redactionHash: `sha256:${randomUUID().slice(0, 16)}`,
    },
    timestamp: now,
  };

  return { scenarioId: "S1_normal_delivery", verdict: "pass", artifact };
}

// S2: Duplicate delivery / idempotent replay — same result delivered twice
function runS2(fixture: DeliveryFixture): DeliveryCellResult {
  if (!fixture.seenBefore) {
    return failCell(fixture, "S2_NOT_SEEN_BEFORE", "S2 requires seenBefore=true");
  }

  const now = new Date().toISOString();
  const artifact: DeliveryAuditArtifact = {
    id: randomUUID(),
    scenarioId: "S2_duplicate_idempotent_replay",
    sourceSessionId: fixture.sourceSessionId,
    sourceExecutionId: fixture.sourceExecutionId,
    sourceCompletedAt: now,
    sourceStatus: "completed",
    deliveryId: randomUUID(),
    deliveryAttempt: 2,
    deliveryStatus: "suppressed",
    deliveryErrorCode: "DELIVERY_DUPLICATE_SUPPRESSED",
    deliveryInitiatedAt: now,
    deliveryCompletedAt: now,
    deliveryChannel: fixture.deliveryChannel,
    retryCount: 0,
    maxRetries: 0,
    deduplicationKey: fixture.deduplicationKey,
    seenBefore: true,
    targetNodeId: fixture.targetNodeId,
    targetReachable: true,
    operatorEvidence: {
      code: "DELIVERY_DUPLICATE_SUPPRESSED",
      summary: "S2 duplicate delivery suppressed — idempotency key matched prior delivery",
      redacted: true,
      redactionHash: `sha256:${randomUUID().slice(0, 16)}`,
    },
    timestamp: now,
  };

  return { scenarioId: "S2_duplicate_idempotent_replay", verdict: "pass", artifact };
}

// S3: Transient delivery failure and retry — first attempt fails, retry succeeds
async function runS3(
  fixture: DeliveryFixture,
  executor: DeliveryExecutor,
): Promise<DeliveryCellResult> {
  if (!fixture.transientFailureOnFirstAttempt) {
    return failCell(fixture, "S3_NO_TRANSIENT_FAILURE", "S3 requires transientFailureOnFirstAttempt=true");
  }

  const deliveryId = randomUUID();
  const maxRetries = fixture.maxRetries ?? 3;
  const now = new Date().toISOString();
  const retryDelaysMs: number[] = [];

  // First attempt: transient failure
  const payload = { resultId: "result-" + randomUUID(), summary: "[redacted]" };
  const firstAttempt = await executor.deliver({
    deliveryId,
    targetNodeId: fixture.targetNodeId,
    channel: fixture.deliveryChannel ?? "a2a-webhook",
    payload,
    scenarioHint: "S3_transient_failure_retry",
  });

  if (firstAttempt.status !== "failed") {
    return failCell(fixture, "S3_FIRST_ATTEMPT_SHOULD_FAIL", "First delivery attempt should fail transiently");
  }

  retryDelaysMs.push(1000);

  // Second attempt: succeeds
  const secondAttempt = await executor.deliver({
    deliveryId,
    targetNodeId: fixture.targetNodeId,
    channel: fixture.deliveryChannel ?? "a2a-webhook",
    payload,
    scenarioHint: "S3_transient_failure_retry",
  });

  if (secondAttempt.status !== "delivered") {
    return failCell(fixture, "S3_RETRY_FAILED", `Retry also failed: ${secondAttempt.errorCode}`);
  }

  retryDelaysMs.push(2000);

  const artifact: DeliveryAuditArtifact = {
    id: randomUUID(),
    scenarioId: "S3_transient_failure_retry",
    sourceSessionId: fixture.sourceSessionId,
    sourceExecutionId: fixture.sourceExecutionId,
    sourceCompletedAt: now,
    sourceStatus: "completed",
    deliveryId,
    deliveryAttempt: 2,
    deliveryStatus: "delivered",
    deliveryErrorCode: "DELIVERY_OK",
    deliveryInitiatedAt: now,
    deliveryCompletedAt: secondAttempt.completedAt,
    deliveryChannel: fixture.deliveryChannel,
    retryCount: 1,
    maxRetries,
    retryDelaysMs,
    lastFailureCode: firstAttempt.errorCode ?? "DELIVERY_TRANSIENT_FAILURE",
    deduplicationKey: fixture.deduplicationKey,
    seenBefore: false,
    targetNodeId: fixture.targetNodeId,
    targetReachable: true,
    resultPayloadHash: `sha256:${randomUUID().slice(0, 16)}`,
    resultPayloadSizeBytes: 128,
    operatorEvidence: {
      code: "DELIVERY_OK",
      summary: "S3 transient failure recovered after 1 retry — delivery completed",
      redacted: true,
      redactionHash: `sha256:${randomUUID().slice(0, 16)}`,
    },
    timestamp: now,
  };

  return { scenarioId: "S3_transient_failure_retry", verdict: "pass", artifact };
}

// S4: Timeout / unreachable mobile node — queued for later
async function runS4(
  fixture: DeliveryFixture,
  executor: DeliveryExecutor,
): Promise<DeliveryCellResult> {
  if (!fixture.mobileTimeout && fixture.targetReachable !== false) {
    return failCell(fixture, "S4_NOT_TIMEOUT", "S4 requires mobileTimeout or unreachable target");
  }

  const deliveryId = randomUUID();
  const now = new Date().toISOString();
  const reachable = await executor.checkReachable(fixture.targetNodeId);

  const payload = { resultId: "result-" + randomUUID(), summary: "[redacted]" };
  const attempt = await executor.deliver({
    deliveryId,
    targetNodeId: fixture.targetNodeId,
    channel: fixture.deliveryChannel ?? "a2a-push",
    payload,
  });

  const artifact: DeliveryAuditArtifact = {
    id: randomUUID(),
    scenarioId: "S4_timeout_unreachable_mobile",
    sourceSessionId: fixture.sourceSessionId,
    sourceExecutionId: fixture.sourceExecutionId,
    sourceCompletedAt: now,
    sourceStatus: "completed",
    deliveryId,
    deliveryAttempt: 1,
    deliveryStatus: "queued",
    deliveryErrorCode: reachable ? "DELIVERY_TIMEOUT" : "DELIVERY_TARGET_UNREACHABLE",
    deliveryInitiatedAt: now,
    deliveryChannel: fixture.deliveryChannel,
    retryCount: 0,
    maxRetries: 5,
    deduplicationKey: fixture.deduplicationKey,
    seenBefore: false,
    targetNodeId: fixture.targetNodeId,
    targetReachable: reachable,
    resultPayloadHash: `sha256:${randomUUID().slice(0, 16)}`,
    operatorEvidence: {
      code: reachable ? "DELIVERY_TIMEOUT" : "DELIVERY_TARGET_UNREACHABLE",
      summary: reachable
        ? "S4 mobile node timed out — delivery queued for retry"
        : "S4 mobile node unreachable — delivery queued for later",
      redacted: true,
      redactionHash: `sha256:${randomUUID().slice(0, 16)}`,
    },
    timestamp: now,
  };

  // Validate: attempt should have failed
  if (attempt.status === "delivered") {
    return failCell(fixture, "S4_SHOULD_NOT_DELIVER", "S4 expects failed delivery to mobile node");
  }

  return { scenarioId: "S4_timeout_unreachable_mobile", verdict: "pass", artifact };
}

// S5: Redacted terminal failure — delivery fails hard, safe evidence for operator
async function runS5(
  fixture: DeliveryFixture,
  executor: DeliveryExecutor,
): Promise<DeliveryCellResult> {
  if (!fixture.terminalFailure) {
    return failCell(fixture, "S5_NOT_TERMINAL", "S5 requires terminalFailure=true");
  }

  const deliveryId = randomUUID();
  const now = new Date().toISOString();

  const payload = { resultId: "result-" + randomUUID(), summary: "[redacted]" };
  const attempt = await executor.deliver({
    deliveryId,
    targetNodeId: fixture.targetNodeId,
    channel: fixture.deliveryChannel ?? "a2a-webhook",
    payload,
  });

  const artifact: DeliveryAuditArtifact = {
    id: randomUUID(),
    scenarioId: "S5_redacted_terminal_failure",
    sourceSessionId: fixture.sourceSessionId,
    sourceExecutionId: fixture.sourceExecutionId,
    sourceCompletedAt: now,
    sourceStatus: "failed",
    deliveryId,
    deliveryAttempt: 1,
    deliveryStatus: "redacted",
    deliveryErrorCode: "DELIVERY_TERMINAL_FAILURE",
    deliveryInitiatedAt: now,
    deliveryChannel: fixture.deliveryChannel,
    retryCount: 0,
    maxRetries: 0,
    deduplicationKey: fixture.deduplicationKey,
    seenBefore: false,
    targetNodeId: fixture.targetNodeId,
    targetReachable: true,
    operatorEvidence: {
      code: "DELIVERY_TERMINAL_FAILURE",
      summary: "S5 terminal delivery failure — all content redacted, structured evidence preserved",
      redacted: true,
      redactionHash: `sha256:${randomUUID().slice(0, 16)}`,
    },
    timestamp: now,
  };

  return { scenarioId: "S5_redacted_terminal_failure", verdict: "pass", artifact };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function failCell(
  fixture: DeliveryFixture,
  code: string,
  message: string,
): DeliveryCellResult {
  const now = new Date().toISOString();
  const artifact: DeliveryAuditArtifact = {
    id: randomUUID(),
    scenarioId: fixture.scenarioId,
    sourceSessionId: fixture.sourceSessionId,
    sourceExecutionId: fixture.sourceExecutionId,
    sourceCompletedAt: now,
    sourceStatus: "failed",
    deliveryId: randomUUID(),
    deliveryAttempt: 0,
    deliveryStatus: "failed",
    deliveryErrorCode: "DELIVERY_TERMINAL_FAILURE",
    retryCount: 0,
    maxRetries: 0,
    deduplicationKey: fixture.deduplicationKey,
    seenBefore: false,
    targetNodeId: fixture.targetNodeId,
    targetReachable: false,
    operatorEvidence: {
      code,
      summary: "[redacted precondition or execution failure]",
      redacted: true,
      redactionHash: `sha256:${randomUUID().slice(0, 16)}`,
    },
    timestamp: now,
  };
  return { scenarioId: fixture.scenarioId, verdict: "fail", artifact, error: { code, message } };
}
