/**
 * Durable Runtime — Regression Fixture Factories
 *
 * Contract-first fixtures for the durable execution layer.
 * These factories create broker state and input payloads that exercise
 * idempotency, lease/heartbeat, concurrency control, structured progress,
 * retry/reconcile, and cancel fan-out paths.
 *
 * Used by both broker-level unit tests and E2E HTTP integration tests.
 */

import type {
  A2AExchangeRequest,
  CreateTaskRequest,
  RegisterWorkerRequest,
  TaskRecord,
  TaskStatus,
  WorkerCapabilities,
  WorkerRecord,
} from "./types.js";

// ---------------------------------------------------------------------------
// Worker fixture factory
// ---------------------------------------------------------------------------

export interface WorkerFixtureOverrides {
  nodeId?: string;
  role?: WorkerRecord["role"];
  displayName?: string;
  capabilities?: Partial<WorkerCapabilities>;
  metadata?: Record<string, string>;
}

const DEFAULT_CAPABILITIES: WorkerCapabilities = {
  canAnalyze: true,
  canBackfill: true,
  canPatchWorkspace: true,
  canPromoteLive: false,
  workspaceIds: ["ws-default"],
  environments: ["research"],
};

export function createWorkerFixture(overrides: WorkerFixtureOverrides = {}): RegisterWorkerRequest {
  const nodeId = overrides.nodeId ?? "worker-a";
  return {
    nodeId,
    role: overrides.role ?? "analyst",
    displayName: overrides.displayName ?? `${nodeId} display`,
    capabilities: {
      ...DEFAULT_CAPABILITIES,
      ...overrides.capabilities,
    },
    metadata: overrides.metadata,
  };
}

export function createWorkerRecord(fixture: RegisterWorkerRequest, lastSeenAt?: string): WorkerRecord {
  const now = lastSeenAt ?? new Date().toISOString();
  return {
    nodeId: fixture.nodeId,
    role: fixture.role,
    displayName: fixture.displayName,
    brokerUrl: undefined,
    capabilities: fixture.capabilities,
    metadata: fixture.metadata ?? {},
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
  };
}

// ---------------------------------------------------------------------------
// Task fixture factory
// ---------------------------------------------------------------------------

export interface TaskFixtureOverrides {
  id?: string;
  intent?: CreateTaskRequest["intent"];
  requesterId?: string;
  targetId?: string;
  assignedWorkerId?: string;
  message?: string;
  payload?: Record<string, unknown>;
  status?: TaskStatus;
  /** For snapshot-based tests where the task already has lifecycle history. */
  exchangeId?: string;
  proposalId?: string;
  claimedAt?: string;
  completedAt?: string;
  claimedBy?: string;
  requeueCount?: number;
  /** Idempotency key (durable-runtime extension). */
  idempotencyKey?: string;
  /** Lease deadline ISO string (durable-runtime extension). */
  leaseDeadline?: string;
  /** Structured progress (durable-runtime extension). */
  progress?: TaskProgress;
}

export function createTaskFixture(overrides: TaskFixtureOverrides = {}): CreateTaskRequest {
  const requesterId = overrides.requesterId ?? "hub-1";
  const targetId = overrides.targetId ?? "worker-a";
  return {
    id: overrides.id,
    intent: overrides.intent ?? "analyze",
    requester: { id: requesterId, kind: "node", role: "hub" },
    target: { id: targetId, kind: "node", role: "analyst" },
    assignedWorkerId: overrides.assignedWorkerId ?? targetId,
    message: overrides.message ?? "test task",
    payload: overrides.payload,
  };
}

/**
 * Create a full TaskRecord with optional lifecycle state for snapshot tests.
 */
export function createTaskRecordFixture(overrides: TaskFixtureOverrides = {}): TaskRecord {
  const now = new Date().toISOString();
  const requesterId = overrides.requesterId ?? "hub-1";
  const targetId = overrides.targetId ?? "worker-a";
  const task = createTaskFixture(overrides);
  return {
    id: task.id ?? "task-test-1",
    intent: task.intent,
    requester: task.requester,
    target: task.target,
    targetNodeId: targetId,
    assignedWorkerId: task.assignedWorkerId ?? targetId,
    workspace: undefined,
    message: task.message,
    proposalId: overrides.proposalId,
    artifactIds: [],
    via: undefined,
    policyContext: undefined,
    payload: task.payload ?? {},
    status: overrides.status ?? "queued",
    createdAt: now,
    updatedAt: now,
    claimedAt: overrides.claimedAt,
    completedAt: overrides.completedAt,
    claimedBy: overrides.claimedBy,
    requeueCount: overrides.requeueCount,
  } as TaskRecord;
}

// ---------------------------------------------------------------------------
// Exchange fixture factory
// ---------------------------------------------------------------------------

export interface ExchangeFixtureOverrides {
  requesterId?: string;
  targetId?: string;
  message?: string;
  intent?: A2AExchangeRequest["intent"];
  maxTurns?: number;
}

export function createExchangeFixture(overrides: ExchangeFixtureOverrides = {}): A2AExchangeRequest {
  return {
    requester: { id: overrides.requesterId ?? "hub-1", kind: "node", role: "hub" },
    target: { id: overrides.targetId ?? "worker-a", kind: "node", role: "analyst" },
    message: overrides.message ?? "test exchange",
    intent: overrides.intent ?? "chat",
    maxTurns: overrides.maxTurns,
  };
}

// ---------------------------------------------------------------------------
// Structured Progress (durable-runtime contract)
// ---------------------------------------------------------------------------

export interface TaskProgress {
  phase: string;
  percent: number;
  message?: string;
  updatedAt: string;
}

export interface TaskProgressUpdate {
  phase?: string;
  percent?: number;
  message?: string;
}

export function createProgressFixture(
  phase: string,
  percent: number,
  message?: string,
): TaskProgress {
  return {
    phase,
    percent: Math.max(0, Math.min(100, percent)),
    message,
    updatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Lease fixture helpers
// ---------------------------------------------------------------------------

export interface LeaseConfig {
  /** Default lease duration in ms. Tasks must heartbeat within this window. */
  defaultLeaseMs: number;
  /** Maximum total lease extensions per task. */
  maxExtensions: number;
}

export const DEFAULT_LEASE_CONFIG: LeaseConfig = {
  defaultLeaseMs: 60_000,
  maxExtensions: 10,
};

/**
 * Create a lease deadline ISO string offset from now.
 */
export function leaseDeadlineFromNow(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

/**
 * Create an expired lease deadline.
 */
export function expiredLeaseDeadline(): string {
  return new Date(Date.now() - 1000).toISOString();
}

// ---------------------------------------------------------------------------
// Retry policy fixture helpers
// ---------------------------------------------------------------------------

export interface RetryPolicy {
  /** Maximum automatic retries. 0 = no retry. */
  maxRetries: number;
  /** Base delay in ms for exponential backoff. */
  baseDelayMs: number;
  /** Multiplier for each retry level. */
  backoffMultiplier: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  baseDelayMs: 1_000,
  backoffMultiplier: 2,
};

/**
 * Calculate the delay for a given retry attempt (0-indexed).
 */
export function retryDelayMs(policy: RetryPolicy, attempt: number): number {
  return policy.baseDelayMs * Math.pow(policy.backoffMultiplier, attempt);
}

// ---------------------------------------------------------------------------
// Concurrency control fixture helpers
// ---------------------------------------------------------------------------

export interface ConcurrencyConfig {
  /** Max concurrent claimed+running tasks per worker. */
  maxPerWorker: number;
  /** Max concurrent claimed+running tasks across all workers for a given target node. */
  maxPerTargetNode: number;
}

export const DEFAULT_CONCURRENCY_CONFIG: ConcurrencyConfig = {
  maxPerWorker: 5,
  maxPerTargetNode: 20,
};

// ---------------------------------------------------------------------------
// Idempotency fixture helpers
// ---------------------------------------------------------------------------

/**
 * Generate a deterministic idempotency key from request context.
 * In production this would come from the caller; here we generate predictable keys for tests.
 */
export function idempotencyKey(scope: string, ...parts: string[]): string {
  return `${scope}:${parts.join(":")}`;
}

// ---------------------------------------------------------------------------
// Batch fixture factories for integration tests
// ---------------------------------------------------------------------------

/**
 * Create N worker fixtures with sequential IDs.
 */
export function createWorkerFixtures(count: number, prefix = "worker"): RegisterWorkerRequest[] {
  return Array.from({ length: count }, (_, i) =>
    createWorkerFixture({ nodeId: `${prefix}-${i + 1}` }),
  );
}

/**
 * Create N task fixtures targeting the same worker.
 */
export function createTaskFixtures(
  count: number,
  targetId = "worker-a",
  intent: CreateTaskRequest["intent"] = "analyze",
): CreateTaskRequest[] {
  return Array.from({ length: count }, (_, i) =>
    createTaskFixture({
      targetId,
      intent,
      message: `batch task ${i + 1}`,
    }),
  );
}
