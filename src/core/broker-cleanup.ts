import { DEFAULT_BROKER_RETENTION_POLICY, type BrokerRetentionPolicy } from "./broker.js";
import {
  SqliteBrokerStateStore,
  type SqliteHotRetentionApplyResult,
  type SqliteHotRetentionPlan,
} from "./store.js";

export const BROKER_CLEANUP_APPROVAL = "APPLY_BROKER_CLEANUP";

export interface BrokerCleanupPlanOptions {
  nowMs?: number;
  taskRetentionMs?: number;
  maxTerminalTasks?: number;
  auditRetentionMs?: number;
  maxAuditEvents?: number;
  workerRetentionMs?: number;
  maxInactiveWorkers?: number;
  protectedTaskIds?: string[];
  protectedWorkerIds?: string[];
}

export interface ResolvedBrokerCleanupPlanOptions {
  nowMs: number;
  taskRetentionMs: number;
  maxTerminalTasks: number;
  auditRetentionMs: number;
  maxAuditEvents: number;
  workerRetentionMs: number;
  maxInactiveWorkers: number;
  protectedTaskIds: string[];
  protectedWorkerIds: string[];
}

export interface BrokerCleanupPlanSummary {
  tables: number;
  retained: number;
  candidates: number;
}

export interface BrokerCleanupPlan {
  kind: "broker.cleanup.plan";
  generatedAt: string;
  dryRun: true;
  options: ResolvedBrokerCleanupPlanOptions;
  plans: SqliteHotRetentionPlan[];
  summary: BrokerCleanupPlanSummary;
}

export interface BrokerCleanupBackupProof {
  /** Stable artifact URL or backup manifest id. Prefer artifact evidence over host-local paths. */
  ref?: string;
  /** Optional checksum of the backup artifact/manifest. */
  sha256?: string;
  createdAt?: string;
}

export interface BrokerCleanupApplyRequest {
  approval?: string;
  backupProof?: BrokerCleanupBackupProof;
}

export interface BrokerCleanupApplyResult {
  kind: "broker.cleanup.apply";
  generatedAt: string;
  approval: typeof BROKER_CLEANUP_APPROVAL;
  backupProof: BrokerCleanupBackupProof;
  plan: BrokerCleanupPlan;
  results: SqliteHotRetentionApplyResult[];
  summary: {
    requestedPruneCount: number;
    prunedCount: number;
  };
}

export function resolveBrokerCleanupPlanOptions(
  input: BrokerCleanupPlanOptions = {},
  retentionPolicy: BrokerRetentionPolicy = DEFAULT_BROKER_RETENTION_POLICY,
): ResolvedBrokerCleanupPlanOptions {
  const nowMs = normalizeNonNegativeNumber(input.nowMs, Date.now(), "nowMs");
  return {
    nowMs,
    taskRetentionMs: normalizeNonNegativeNumber(
      input.taskRetentionMs,
      retentionPolicy.terminalRetentionMs,
      "taskRetentionMs",
    ),
    maxTerminalTasks: normalizeNonNegativeInteger(
      input.maxTerminalTasks,
      retentionPolicy.maxTerminalTasks,
      "maxTerminalTasks",
    ),
    auditRetentionMs: normalizeNonNegativeNumber(input.auditRetentionMs, retentionPolicy.auditRetentionMs, "auditRetentionMs"),
    maxAuditEvents: normalizeNonNegativeInteger(input.maxAuditEvents, retentionPolicy.maxAuditEvents, "maxAuditEvents"),
    workerRetentionMs: normalizeNonNegativeNumber(
      input.workerRetentionMs,
      retentionPolicy.inactiveWorkerRetentionMs,
      "workerRetentionMs",
    ),
    maxInactiveWorkers: normalizeNonNegativeInteger(
      input.maxInactiveWorkers,
      retentionPolicy.maxInactiveWorkers,
      "maxInactiveWorkers",
    ),
    protectedTaskIds: normalizeStringList(input.protectedTaskIds, "protectedTaskIds"),
    protectedWorkerIds: normalizeStringList(input.protectedWorkerIds, "protectedWorkerIds"),
  };
}

export function buildBrokerCleanupPlan(
  store: SqliteBrokerStateStore,
  input: BrokerCleanupPlanOptions = {},
  retentionPolicy: BrokerRetentionPolicy = DEFAULT_BROKER_RETENTION_POLICY,
): BrokerCleanupPlan {
  const options = resolveBrokerCleanupPlanOptions(input, retentionPolicy);
  const taskPlan = store.planHotTaskRetention({
    nowMs: options.nowMs,
    retentionMs: options.taskRetentionMs,
    maxTerminalRecords: options.maxTerminalTasks,
    protectedTaskIds: options.protectedTaskIds,
  });
  const workerPlan = store.planHotWorkerRetention({
    nowMs: options.nowMs,
    retentionMs: options.workerRetentionMs,
    maxInactiveWorkers: options.maxInactiveWorkers,
    protectedWorkerIds: options.protectedWorkerIds,
  });
  const auditPlan = store.planHotAuditRetention({
    nowMs: options.nowMs,
    retentionMs: options.auditRetentionMs,
    maxRecords: options.maxAuditEvents,
    protectedIds: {
      taskIds: [...new Set([...taskPlan.retainedIds, ...options.protectedTaskIds])],
      workerIds: [...new Set([...workerPlan.retainedIds, ...options.protectedWorkerIds])],
    },
  });
  const plans = [taskPlan, auditPlan, workerPlan];
  return {
    kind: "broker.cleanup.plan",
    generatedAt: new Date(options.nowMs).toISOString(),
    dryRun: true,
    options,
    plans,
    summary: summarizeCleanupPlans(plans),
  };
}

export function applyBrokerCleanupPlan(
  store: SqliteBrokerStateStore,
  plan: BrokerCleanupPlan,
  request: BrokerCleanupApplyRequest,
): BrokerCleanupApplyResult {
  assertBrokerCleanupApplyRequest(request);
  const results = store.applyHotRetentionPlans(plan.plans);
  return {
    kind: "broker.cleanup.apply",
    generatedAt: new Date(plan.options.nowMs).toISOString(),
    approval: BROKER_CLEANUP_APPROVAL,
    backupProof: request.backupProof,
    plan,
    results,
    summary: {
      requestedPruneCount: results.reduce((sum, result) => sum + result.requestedPruneCount, 0),
      prunedCount: results.reduce((sum, result) => sum + result.prunedCount, 0),
    },
  };
}

export function assertBrokerCleanupApplyRequest(
  request: BrokerCleanupApplyRequest,
): asserts request is BrokerCleanupApplyRequest & { backupProof: BrokerCleanupBackupProof } {
  if (request.approval !== BROKER_CLEANUP_APPROVAL) {
    throw new Error(`broker cleanup apply requires approval=${BROKER_CLEANUP_APPROVAL}`);
  }
  const ref = request.backupProof?.ref?.trim();
  const sha256 = request.backupProof?.sha256?.trim();
  if (!ref && !sha256) {
    throw new Error("broker cleanup apply requires backupProof.ref or backupProof.sha256");
  }
}

function summarizeCleanupPlans(plans: SqliteHotRetentionPlan[]): BrokerCleanupPlanSummary {
  return {
    tables: plans.length,
    retained: plans.reduce((sum, plan) => sum + plan.retainedIds.length, 0),
    candidates: plans.reduce((sum, plan) => sum + plan.pruneIds.length, 0),
  };
}

function normalizeNonNegativeNumber(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < 0) {
    throw new Error(`${name} must be a non-negative finite number`);
  }
  return resolved;
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = normalizeNonNegativeNumber(value, fallback, name);
  if (!Number.isInteger(resolved)) {
    throw new Error(`${name} must be an integer`);
  }
  return resolved;
}

function normalizeStringList(value: string[] | undefined, name: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`${name} must be a string array`);
  }
  return [...new Set(value.map((entry) => entry.trim()).filter(Boolean))].sort();
}
