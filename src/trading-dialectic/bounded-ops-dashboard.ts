/**
 * Team1 bounded ops dashboard / capacity read model (#554).
 *
 * Provides a bounded-context view of trading-dialectic tasks and workers
 * for Team1 operators. This is NOT a full broker dashboard — it is scoped
 * ("bounded") to Team1's domain: thesis/antithesis/rebuttal/synthesis/outcome
 * tasks handled by bangtong, dengae, and seoseo agents.
 *
 * Two-broker awareness: when tasks carry a brokerOfRecord, the bounded
 * dashboard distinguishes tasks belonging to each broker so operators can
 * assess cross-broker load distribution before cutover or preflight.
 *
 * Pure functions only — no DB mutation, no provider calls, no side effects.
 *
 * Reference: #497/#539/#294 stability gates.
 */
import type { TaskRecord, TaskStatus, WorkerCapacitySummary, WorkerCapacitySummaryItem } from "../core/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Team1BoundedHealthSeverity = "ok" | "warning" | "critical";

/** Per-phase task counts for trading-dialectic lane analysis. */
export interface Team1PhaseBreakdown {
  thesis: number;
  antithesis: number;
  rebuttal: number;
  synthesis: number;
  outcome: number;
}

/** Two-broker load distribution for Team1 tasks. */
export interface Team1BrokerOfRecordBreakdown {
  /** Total tasks with a brokerOfRecord set. */
  total: number;
  /** Per-broker counts. */
  byBroker: Record<string, number>;
  /** Tasks without any brokerOfRecord (legacy). */
  noBrokerOfRecord: number;
}

/** Stale-worker and stale-task diagnostics scoped to Team1. */
export interface Team1StaleDiagnostics {
  /** Workers registered for Team1 lanes that are stale (missed heartbeat). */
  staleWorkers: number;
  /** Active Team1 tasks assigned to a stale worker. */
  staleWorkerAssignments: number;
  /** Active Team1 tasks whose current-status duration exceeds the stale threshold. */
  staleTasks: number;
  /** Oldest stale task, if any, for operator triage. */
  oldestStaleTask: {
    taskId: string;
    phase: string;
    status: TaskStatus;
    ageSec: number;
  } | null;
  /** Oldest stale worker assignment, if any. */
  oldestStaleAssignment: {
    workerId: string;
    taskId: string;
    ageSec: number;
  } | null;
}

/** Structured warnings for the bounded-health assessment. */
export interface Team1BoundedWarning {
  severity: "info" | "warning" | "critical";
  code: string;
  message: string;
}

/**
 * Team1 bounded ops dashboard — the bounded read model for Team1 operators.
 *
 * This is a scoped ("bounded") view of broker state covering only Team1's
 * trading-dialectic domain. It is explicitly NOT a full broker dashboard:
 * general-queue tasks, non-Team1 workers, and cross-cutting infrastructure
 * metrics are excluded so operators can focus on lane health and worker
 * capacity without noise.
 */
export interface Team1BoundedOpsDashboard {
  kind: "team1.bounded-ops.dashboard";
  version: 1;
  generatedAt: string;

  /** Broker identity context for two-broker awareness. */
  broker: {
    /** This broker's identity, if configured. */
    brokerId?: string;
    /** This broker's team, if configured. */
    teamId?: string;
  };

  /** Bounded task summary — only trading-dialectic tasks. */
  tasks: {
    total: number;
    /** Tasks whose dialectic state is non-terminal. */
    active: number;
    /** Tasks whose dialectic state is terminal. */
    terminal: number;
    /** Distribution across terminal/live states. */
    byStatus: Record<TaskStatus, number>;
    /** Distribution across trading-dialectic phases. */
    byPhase: Team1PhaseBreakdown;
    /** Two-broker load distribution (brokerOfRecord awareness). */
    byBrokerOfRecord: Team1BrokerOfRecordBreakdown;
    /** Tasks with stale-requeue or dead-letter count > 0. */
    requeuedOrDeadLettered: number;
  };

  /** Bounded worker capacity — only Team1 lane workers. */
  workers: {
    total: number;
    online: number;
    stale: number;
    /** Per-worker capacity items for Team1 lanes. */
    items: WorkerCapacitySummaryItem[];
  };

  /** Stale-worker and stale-task diagnostics scoped to Team1. */
  staleDiagnostics: Team1StaleDiagnostics;

  /** Overall bounded-health assessment for Team1. */
  health: {
    severity: Team1BoundedHealthSeverity;
    warnings: Team1BoundedWarning[];
  };
}

// ---------------------------------------------------------------------------
// Default thresholds
// ---------------------------------------------------------------------------

export const DEFAULT_TEAM1_STALE_AFTER_MS = 90_000; // 90 seconds
export const DEFAULT_TEAM1_LONG_RUNNING_MS = 30 * 60 * 1000; // 30 minutes

// ---------------------------------------------------------------------------
// Builder input
// ---------------------------------------------------------------------------

export interface BoundedOpsDashboardInput {
  /** All tasks from the broker. The builder filters to Team1 (trading-dialectic) tasks. */
  tasks: TaskRecord[];
  /** All workers from the broker. The builder filters to Team1 lane workers. */
  workers: {
    nodeId: string;
    role: string;
    displayName?: string;
    lastSeenAt: string;
  }[];
  /** Worker capacity summary pre-computed by the broker. */
  workerCapacity: WorkerCapacitySummary;
  /** This broker's identity, if configured. */
  brokerId?: string;
  /** This broker's team, if configured. */
  teamId?: string;
  /** Threshold overrides. */
  thresholds?: {
    staleAfterMs?: number;
    longRunningAfterMs?: number;
  };
  /** Timestamp override for testing. */
  nowMs?: number;
  /** Generated-at override for testing. */
  generatedAt?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Team1 lane roles that indicate a worker belongs to Team1. */
const TEAM1_LANE_ROLES = new Set(["analyst", "researcher", "trader"]);
const TEAM1_LANE_PREFIXES = ["td-", "trading-", "bangtong-", "dengae-", "seoseo-"];

/**
 * Determine whether a task is a Team1 trading-dialectic task.
 *
 * A task is considered Team1-scoped when:
 * 1. Its intent is `analyze` or `verify` (common trading-dialectic intents), OR
 * 2. Its payload contains a non-null trading-dialectic contract, OR
 * 3. Its targetNodeId or assignedWorkerId matches a Team1 node prefix
 */
function isTeam1Task(task: TaskRecord): boolean {
  const tradingIntents = new Set(["analyze", "verify", "backfill"]);
  if (tradingIntents.has(task.intent)) return true;

  if (task.payload && typeof task.payload === "object") {
    const kind: unknown = (task.payload as Record<string, unknown>).kind;
    if (kind === "trading.dialectic" || kind === "tradingDialectic") return true;

    const contract: unknown = (task.payload as Record<string, unknown>).contract;
    if (contract && typeof contract === "object") {
      const cKind: unknown = (contract as Record<string, unknown>).kind;
      if (cKind === "trading.dialectic") return true;
    }
  }

  const nodeId = task.targetNodeId ?? task.assignedWorkerId ?? "";
  const lowered = nodeId.toLowerCase();
  for (const prefix of TEAM1_LANE_PREFIXES) {
    if (lowered.startsWith(prefix)) return true;
  }

  return false;
}

/**
 * Determine whether a worker belongs to Team1.
 *
 * We match on role and node-id prefix to stay bounded — a generic "hub"
 * or "operator" worker is excluded from the Team1 capacity view.
 */
function isTeam1Worker(nodeId: string, role?: string): boolean {
  if (role && TEAM1_LANE_ROLES.has(role)) return true;
  const lowered = nodeId.toLowerCase();
  for (const prefix of TEAM1_LANE_PREFIXES) {
    if (lowered.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Extract trading-dialectic phase from a task record's payload or intent.
 */
function extractPhase(task: TaskRecord): string {
  if (task.payload && typeof task.payload === "object") {
    const contract: unknown = (task.payload as Record<string, unknown>).contract;
    if (contract && typeof contract === "object") {
      const phase: unknown = (contract as Record<string, unknown>).phase;
      if (typeof phase === "string" && isDialecticPhase(phase)) return phase;
    }
  }

  const id = task.id.toLowerCase();
  if (id.startsWith("td-thesis-") || id.startsWith("thesis-")) return "thesis";
  if (id.startsWith("td-antithesis-") || id.startsWith("antithesis-")) return "antithesis";
  if (id.startsWith("td-rebuttal-") || id.startsWith("rebuttal-")) return "rebuttal";
  if (id.startsWith("td-synthesis-") || id.startsWith("synthesis-")) return "synthesis";
  if (id.startsWith("td-outcome-") || id.startsWith("outcome-")) return "outcome";

  return "thesis"; // default
}

function isDialecticPhase(value: string): value is keyof Team1PhaseBreakdown {
  return value === "thesis" || value === "antithesis" || value === "rebuttal" || value === "synthesis" || value === "outcome";
}

const ACTIVE_STATUSES = new Set<TaskStatus>(["blocked", "queued", "claimed", "running"]);

function extractBrokerOfRecord(task: TaskRecord): string | undefined {
  return (task as unknown as Record<string, unknown>).brokerOfRecord as string | undefined;
}

function ageSecFromIso(iso: string, nowMs: number): number {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor((nowMs - parsed) / 1000));
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Build a Team1-bounded ops dashboard from broker task/worker records.
 *
 * Pure function: reads broker state, filters to Team1 domain, and returns a
 * structured bounded read model. No side effects, no DB mutation, no provider
 * calls.
 */
export function buildTeam1BoundedOpsDashboard(
  input: BoundedOpsDashboardInput,
): Team1BoundedOpsDashboard {
  const nowMs = input.nowMs ?? Date.now();
  const generatedAt = input.generatedAt ?? new Date(nowMs).toISOString();
  const staleAfterMs = input.thresholds?.staleAfterMs ?? DEFAULT_TEAM1_STALE_AFTER_MS;

  // --- Filter tasks to Team1 (trading dialectic) ---
  const team1Tasks = input.tasks.filter(isTeam1Task);

  // --- Bounded task summary ---
  const byStatus: Record<TaskStatus, number> = {
    blocked: 0, queued: 0, claimed: 0, running: 0,
    succeeded: 0, failed: 0, canceled: 0,
  };
  const byPhase: Team1PhaseBreakdown = {
    thesis: 0, antithesis: 0, rebuttal: 0, synthesis: 0, outcome: 0,
  };
  const byBrokerOfRecord = new Map<string, number>();
  let noBrokerOfRecord = 0;
  let requeuedOrDeadLettered = 0;

  for (const task of team1Tasks) {
    byStatus[task.status] = (byStatus[task.status] ?? 0) + 1;

    const phase = extractPhase(task);
    if (isDialecticPhase(phase)) {
      byPhase[phase] += 1;
    }

    const bor = extractBrokerOfRecord(task);
    if (bor) {
      byBrokerOfRecord.set(bor, (byBrokerOfRecord.get(bor) ?? 0) + 1);
    } else {
      noBrokerOfRecord += 1;
    }

    if ((task.requeueCount ?? 0) > 0) {
      requeuedOrDeadLettered += 1;
    }
  }

  const brokerOfRecordBreakdown: Team1BrokerOfRecordBreakdown = {
    total: team1Tasks.length - noBrokerOfRecord,
    byBroker: Object.fromEntries(byBrokerOfRecord),
    noBrokerOfRecord,
  };

  const activeCount = team1Tasks.filter((t) => ACTIVE_STATUSES.has(t.status)).length;
  const terminalCount = team1Tasks.length - activeCount;

  // --- Filter workers to Team1 ---
  const team1Workers = input.workers.filter((w) => isTeam1Worker(w.nodeId, w.role));
  const team1WorkerIds = new Set(team1Workers.map((w) => w.nodeId));

  // --- Bounded worker capacity ---
  let staleWorkerCount = 0;
  let onlineWorkerCount = 0;
  for (const worker of team1Workers) {
    const ageSec = ageSecFromIso(worker.lastSeenAt, nowMs);
    if (ageSec * 1000 >= staleAfterMs) {
      staleWorkerCount += 1;
    } else {
      onlineWorkerCount += 1;
    }
  }

  const boundedWorkerItems: WorkerCapacitySummaryItem[] = input.workerCapacity.items
    .filter((item) => team1WorkerIds.has(item.nodeId))
    .map((item) => ({
      ...item,
      status: (ageSecFromIso(item.lastSeenAt, nowMs) * 1000 >= staleAfterMs ? "stale" : "online") as "online" | "stale",
    }));

  // --- Stale diagnostics ---
  let staleWorkerAssignments = 0;
  let staleTasks = 0;
  let oldestStaleTask: Team1StaleDiagnostics["oldestStaleTask"] = null;
  let oldestStaleAssignment: Team1StaleDiagnostics["oldestStaleAssignment"] = null;

  for (const task of team1Tasks) {
    if (!ACTIVE_STATUSES.has(task.status)) continue;

    const assigneeId = task.assignedWorkerId ?? task.claimedBy;
    const isStaleWorker = Boolean(
      assigneeId && !team1Workers.some(
        (w) => w.nodeId === assigneeId && ageSecFromIso(w.lastSeenAt, nowMs) * 1000 < staleAfterMs,
      ),
    );

    if (isStaleWorker) {
      staleWorkerAssignments += 1;
      const ageSec = ageSecFromIso(task.lastHeartbeatAt ?? task.updatedAt, nowMs);
      if (
        !oldestStaleAssignment || ageSec > oldestStaleAssignment.ageSec
      ) {
        oldestStaleAssignment = {
          workerId: assigneeId!,
          taskId: task.id,
          ageSec,
        };
      }
    }

    // For active tasks, check staleness using the most recent timestamp
    // available: prefer lastHeartbeatAt (for claimed/running tasks),
    // fall back to updatedAt, then createdAt.
    const stalenessTimestamp = task.lastHeartbeatAt ?? task.updatedAt ?? task.createdAt;
    const stalenessAgeMs = nowMs - Date.parse(stalenessTimestamp);
    const isStaleTask = Number.isFinite(stalenessAgeMs) && stalenessAgeMs >= staleAfterMs;
    if (isStaleTask) {
      staleTasks += 1;
      const ageSec = Math.floor(stalenessAgeMs / 1000);
      if (
        !oldestStaleTask || ageSec > oldestStaleTask.ageSec
      ) {
        oldestStaleTask = {
          taskId: task.id,
          phase: extractPhase(task),
          status: task.status,
          ageSec,
        };
      }
    }
  }

  // --- Bounded health assessment ---
  const warnings: Team1BoundedWarning[] = [];

  if (staleWorkerCount > 0) {
    warnings.push({
      severity: staleWorkerCount >= 3 ? "critical" : "warning",
      code: "stale_workers",
      message: `${staleWorkerCount} Team1 lane worker(s) are stale — check worker processes`,
    });
  }

  if (staleTasks > 0) {
    warnings.push({
      severity: staleTasks >= 5 ? "critical" : "warning",
      code: "stale_tasks",
      message: `${staleTasks} Team1 task(s) are stale — operator attention recommended`,
    });
  }

  if (staleWorkerAssignments > 0) {
    warnings.push({
      severity: staleWorkerAssignments >= 3 ? "critical" : "warning",
      code: "stale_worker_assignments",
      message: `${staleWorkerAssignments} Team1 task(s) assigned to stale workers`,
    });
  }

  if (requeuedOrDeadLettered > 0) {
    warnings.push({
      severity: requeuedOrDeadLettered >= 5 ? "warning" : "info",
      code: "requeued_tasks",
      message: `${requeuedOrDeadLettered} Team1 task(s) have been requeued or dead-lettered`,
    });
  }

  if (brokerOfRecordBreakdown.total > 0 && Object.keys(brokerOfRecordBreakdown.byBroker).length > 1) {
    warnings.push({
      severity: "info",
      code: "multi_broker_load",
      message: `Team1 tasks span ${Object.keys(brokerOfRecordBreakdown.byBroker).length} broker(s) — verify cutover readiness per two-broker safety matrix`,
    });
  }

  const severity = computeBoundedHealthSeverity(warnings);

  // --- Assemble dashboard ---
  return {
    kind: "team1.bounded-ops.dashboard",
    version: 1,
    generatedAt,
    broker: {
      brokerId: input.brokerId,
      teamId: input.teamId,
    },
    tasks: {
      total: team1Tasks.length,
      active: activeCount,
      terminal: terminalCount,
      byStatus,
      byPhase,
      byBrokerOfRecord: brokerOfRecordBreakdown,
      requeuedOrDeadLettered,
    },
    workers: {
      total: team1Workers.length,
      online: onlineWorkerCount,
      stale: staleWorkerCount,
      items: boundedWorkerItems,
    },
    staleDiagnostics: {
      staleWorkers: staleWorkerCount,
      staleWorkerAssignments,
      staleTasks,
      oldestStaleTask,
      oldestStaleAssignment,
    },
    health: {
      severity,
      warnings,
    },
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function computeBoundedHealthSeverity(
  warnings: Team1BoundedWarning[],
): Team1BoundedHealthSeverity {
  if (warnings.some((w) => w.severity === "critical")) return "critical";
  if (warnings.some((w) => w.severity === "warning")) return "warning";
  return "ok";
}
