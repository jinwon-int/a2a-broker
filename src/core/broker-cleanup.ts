import { createHash } from "node:crypto";

import { DEFAULT_BROKER_RETENTION_POLICY } from "./broker.js";
import { DEFAULT_TERMINAL_TASK_OUTBOX_RETENTION } from "./terminal-event-outbox.js";
import type {
  SqliteBrokerStateStore,
  SqliteHotRetentionApplyResult,
  SqliteHotRetentionPlan,
} from "./store.js";
import type { AuditEvent, TaskRecord } from "./types.js";

export type BrokerCleanupRiskClass = "low" | "medium" | "high";

export interface BrokerCleanupPlanOptions {
  nowMs?: number;
  taskRetentionMs?: number;
  maxTerminalTasks?: number;
  auditRetentionMs?: number;
  maxAuditEvents?: number;
  workerRetentionMs?: number;
  maxInactiveWorkers?: number;
  terminalOutboxRetentionMs?: number;
  maxAcknowledgedTerminalOutboxEvents?: number;
  protectedTaskIds?: string[];
  protectedWorkerIds?: string[];
}

export interface BrokerCleanupTablePlan extends SqliteHotRetentionPlan {
  stableId: string;
  pruneCount: number;
  retainedCount: number;
  reason: string;
  riskClass: BrokerCleanupRiskClass;
  executionBlockedByDefault?: boolean;
}

export interface BrokerCleanupPlan {
  kind: "broker.cleanup.plan";
  mode: "dry-run";
  planId: string;
  generatedAt: string;
  options: Required<BrokerCleanupPlanOptions>;
  tableCounts: Record<string, number>;
  summary: {
    candidateTables: number;
    totalPruneCandidates: number;
    highestRisk: BrokerCleanupRiskClass;
    executionRequires: string[];
  };
  tables: BrokerCleanupTablePlan[];
  notes: string[];
}

export interface BrokerCleanupExecutionOptions {
  approvalToken?: string;
  confirmation?: string;
  backupProof?: string;
  allowWorkerPrune?: boolean;
  actorId?: string;
}

export interface BrokerCleanupExecutionResult {
  kind: "broker.cleanup.execution";
  planId: string;
  appliedAt: string;
  results: SqliteHotRetentionApplyResult[];
  auditEvent: AuditEvent;
  rollbackNotes: string[];
}

export const BROKER_CLEANUP_CONFIRMATION = "APPLY_BROKER_CLEANUP_PLAN";

const DEFAULT_CLEANUP_OPTIONS: Required<Omit<BrokerCleanupPlanOptions, "nowMs" | "protectedTaskIds" | "protectedWorkerIds">> = {
  taskRetentionMs: DEFAULT_BROKER_RETENTION_POLICY.terminalRetentionMs,
  maxTerminalTasks: DEFAULT_BROKER_RETENTION_POLICY.maxTerminalTasks,
  auditRetentionMs: DEFAULT_BROKER_RETENTION_POLICY.auditRetentionMs,
  maxAuditEvents: DEFAULT_BROKER_RETENTION_POLICY.maxAuditEvents,
  workerRetentionMs: DEFAULT_BROKER_RETENTION_POLICY.inactiveWorkerRetentionMs,
  maxInactiveWorkers: DEFAULT_BROKER_RETENTION_POLICY.maxInactiveWorkers,
  terminalOutboxRetentionMs: DEFAULT_BROKER_RETENTION_POLICY.terminalRetentionMs,
  maxAcknowledgedTerminalOutboxEvents: DEFAULT_TERMINAL_TASK_OUTBOX_RETENTION,
};

const RISK_ORDER: BrokerCleanupRiskClass[] = ["low", "medium", "high"];
const TERMINAL_TASK_STATUSES = new Set<TaskRecord["status"]>(["succeeded", "failed", "canceled"]);

export function buildBrokerCleanupPlan(
  store: SqliteBrokerStateStore,
  input: BrokerCleanupPlanOptions = {},
): BrokerCleanupPlan {
  const nowMs = input.nowMs ?? Date.now();
  const normalized = normalizeCleanupOptions(input, nowMs);
  // Use a bounded read for active-worker discovery; 2000 rows covers typical non-terminal task sets
  // without unbounded heap materialization. Cleanup planning uses dedicated planHot*Retention methods
  // that evaluate every row for retention decisions.
  const tasks = store.readHotTasks({ maxRows: 2000 });
  const activeWorkerIds = new Set(
    tasks
      .filter((task) => !TERMINAL_TASK_STATUSES.has(task.status))
      .flatMap((task) => [task.assignedWorkerId, task.claimedBy].filter((value): value is string => Boolean(value))),
  );
  const protectedWorkerIds = [...new Set([...normalized.protectedWorkerIds, ...activeWorkerIds])].sort();

  const taskPlan = store.planHotTaskRetention({
    nowMs,
    retentionMs: normalized.taskRetentionMs,
    maxTerminalRecords: normalized.maxTerminalTasks,
    protectedTaskIds: normalized.protectedTaskIds,
  });
  const workerPlan = store.planHotWorkerRetention({
    nowMs,
    retentionMs: normalized.workerRetentionMs,
    maxInactiveWorkers: normalized.maxInactiveWorkers,
    protectedWorkerIds,
  });
  const auditPlan = store.planHotAuditRetention({
    nowMs,
    retentionMs: normalized.auditRetentionMs,
    maxRecords: normalized.maxAuditEvents,
    protectedIds: {
      taskIds: taskPlan.retainedIds,
      workerIds: workerPlan.retainedIds,
    },
  });
  const terminalOutboxPlan = store.planHotTerminalOutboxRetention({
    nowMs,
    retentionMs: normalized.terminalOutboxRetentionMs,
    maxAcknowledgedRecords: normalized.maxAcknowledgedTerminalOutboxEvents,
  });

  const tables = [
    decoratePlan(taskPlan, "terminal task rows older than retention/cap window", "medium"),
    decoratePlan(auditPlan, "audit rows outside retention/cap window after protected target coverage", "low"),
    decoratePlan(workerPlan, "inactive worker rows outside retention/cap window", "high", true),
    decoratePlan(
      terminalOutboxPlan,
      "acknowledged terminal outbox rows older than retention/cap window; unacked rows are always retained",
      "high",
      true,
    ),
  ];
  const tableCounts = store.readHotEntityTableCounts();
  const candidateTables = tables.filter((plan) => plan.pruneCount > 0).length;
  const totalPruneCandidates = tables.reduce((sum, plan) => sum + plan.pruneCount, 0);
  const highestRisk = tables.reduce<BrokerCleanupRiskClass>(
    (highest, plan) => plan.pruneCount > 0 && RISK_ORDER.indexOf(plan.riskClass) > RISK_ORDER.indexOf(highest)
      ? plan.riskClass
      : highest,
    "low",
  );
  const generatedAt = new Date(nowMs).toISOString();
  const planId = stableHash({
    generatedAt,
    options: normalized,
    tables: tables.map(({ table, cutoffMs, retainedIds, pruneIds, riskClass }) => ({
      table,
      cutoffMs,
      retainedIds,
      pruneIds,
      riskClass,
    })),
  });

  return {
    kind: "broker.cleanup.plan",
    mode: "dry-run",
    planId,
    generatedAt,
    options: normalized,
    tableCounts,
    summary: {
      candidateTables,
      totalPruneCandidates,
      highestRisk: totalPruneCandidates === 0 ? "low" : highestRisk,
      executionRequires: [
        "matching approvalToken equal to planId",
        `confirmation string ${BROKER_CLEANUP_CONFIRMATION}`,
        "non-empty backupProof/checkpoint evidence",
        "separate allowWorkerPrune=true when worker rows are candidates",
      ],
    },
    tables,
    notes: [
      "This is a dry-run discovery/plan only; no rows are mutated by buildBrokerCleanupPlan.",
      "Worker-row pruning is fail-closed by default because stale rows may still be valid home-broker records.",
      "Terminal outbox pruning is dry-run-only here; unacked rows remain protected until a separate operator ACK/prune approval path exists.",
      "Execution appends a broker.cleanup.applied audit row after pruning; rollback is restore from the backup/checkpoint named in backupProof.",
      "Provider accepted-send receipts are not terminal ACK evidence and are not used as cleanup proof.",
    ],
  };
}

export function executeBrokerCleanupPlan(
  store: SqliteBrokerStateStore,
  plan: BrokerCleanupPlan,
  options: BrokerCleanupExecutionOptions,
): BrokerCleanupExecutionResult {
  const blockers = validateCleanupExecution(plan, options);
  if (blockers.length > 0) {
    throw new Error(`broker cleanup execution blocked: ${blockers.join("; ")}`);
  }
  const appliedAt = new Date().toISOString();
  const results = store.applyHotRetentionPlans(plan.tables);
  const auditEvent: AuditEvent = {
    id: `broker-cleanup-${plan.planId}-${Date.parse(appliedAt)}`,
    actorId: options.actorId?.trim() || "operator.cleanup",
    action: "broker.cleanup.applied",
    targetType: "broker",
    targetId: plan.planId,
    note: JSON.stringify({
      backupProof: options.backupProof,
      rollback: "restore the broker SQLite file from the referenced backup/checkpoint, then restart/reload under operator control",
      results,
    }),
    createdAt: appliedAt,
  };
  store.upsertHotAuditEvents([auditEvent]);
  return {
    kind: "broker.cleanup.execution",
    planId: plan.planId,
    appliedAt,
    results,
    auditEvent,
    rollbackNotes: [
      "Stop broker writes before rollback.",
      "Restore the SQLite state file from backupProof/checkpoint evidence.",
      "Run cleanup plan again in dry-run mode to confirm candidate counts before resuming normal operation.",
    ],
  };
}

export function validateCleanupExecution(
  plan: BrokerCleanupPlan,
  options: BrokerCleanupExecutionOptions,
): string[] {
  const blockers: string[] = [];
  if (options.approvalToken !== plan.planId) {
    blockers.push("approvalToken does not match planId");
  }
  if (options.confirmation !== BROKER_CLEANUP_CONFIRMATION) {
    blockers.push(`confirmation must equal ${BROKER_CLEANUP_CONFIRMATION}`);
  }
  if (typeof options.backupProof !== "string" || options.backupProof.trim().length === 0) {
    blockers.push("backupProof is required before cleanup execution");
  }
  const workerPlan = plan.tables.find((table) => table.table === "broker_workers");
  if ((workerPlan?.pruneCount ?? 0) > 0 && options.allowWorkerPrune !== true) {
    blockers.push("worker prune candidates require allowWorkerPrune=true because stale workers may still be valid home-broker records");
  }
  const terminalOutboxPlan = plan.tables.find((table) => table.table === "broker_terminal_outbox");
  if ((terminalOutboxPlan?.pruneCount ?? 0) > 0) {
    blockers.push("terminal outbox prune candidates are dry-run-only; require separate operator ACK/prune approval path");
  }
  return blockers;
}

function normalizeCleanupOptions(
  input: BrokerCleanupPlanOptions,
  nowMs: number,
): Required<BrokerCleanupPlanOptions> {
  return {
    nowMs,
    taskRetentionMs: normalizeNonNegativeInteger(input.taskRetentionMs, DEFAULT_CLEANUP_OPTIONS.taskRetentionMs),
    maxTerminalTasks: normalizeNonNegativeInteger(input.maxTerminalTasks, DEFAULT_CLEANUP_OPTIONS.maxTerminalTasks),
    auditRetentionMs: normalizeNonNegativeInteger(input.auditRetentionMs, DEFAULT_CLEANUP_OPTIONS.auditRetentionMs),
    maxAuditEvents: normalizeNonNegativeInteger(input.maxAuditEvents, DEFAULT_CLEANUP_OPTIONS.maxAuditEvents),
    workerRetentionMs: normalizeNonNegativeInteger(input.workerRetentionMs, DEFAULT_CLEANUP_OPTIONS.workerRetentionMs),
    maxInactiveWorkers: normalizeNonNegativeInteger(input.maxInactiveWorkers, DEFAULT_CLEANUP_OPTIONS.maxInactiveWorkers),
    terminalOutboxRetentionMs: normalizeNonNegativeInteger(input.terminalOutboxRetentionMs, DEFAULT_CLEANUP_OPTIONS.terminalOutboxRetentionMs),
    maxAcknowledgedTerminalOutboxEvents: normalizeNonNegativeInteger(
      input.maxAcknowledgedTerminalOutboxEvents,
      DEFAULT_CLEANUP_OPTIONS.maxAcknowledgedTerminalOutboxEvents,
    ),
    protectedTaskIds: normalizeStringArray(input.protectedTaskIds),
    protectedWorkerIds: normalizeStringArray(input.protectedWorkerIds),
  };
}

function decoratePlan(
  plan: SqliteHotRetentionPlan,
  reason: string,
  riskClass: BrokerCleanupRiskClass,
  executionBlockedByDefault = false,
): BrokerCleanupTablePlan {
  return {
    ...plan,
    stableId: stableHash({ table: plan.table, cutoffMs: plan.cutoffMs, pruneIds: plan.pruneIds }),
    pruneCount: plan.pruneIds.length,
    retainedCount: plan.retainedIds.length,
    reason,
    riskClass,
    ...(executionBlockedByDefault ? { executionBlockedByDefault } : {}),
  };
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function normalizeStringArray(value: string[] | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()))].sort();
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}
