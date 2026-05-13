/**
 * Queue hygiene snapshot for broker diagnostics.
 *
 * Analyzes task queue depth, age distribution, and anomaly patterns to
 * surface hygiene issues: deep queues, aging tasks, requeue chain depth,
 * and status imbalance — all read-only, no production mutation.
 *
 * Pure function: takes task records and computes structured hygiene reports.
 * Reference: #533 Team1/Bangtong diagnostics for #497/#294 stability gates.
 */
import type { TaskRecord, TaskStatus } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type QueueHygieneSeverity = "ok" | "warning" | "critical";

export interface QueueHygieneStatusBreakdown {
  status: TaskStatus;
  count: number;
  oldestCreatedAt: string | null;
  oldestAgeMs: number | null;
  newestCreatedAt: string | null;
  youngestAgeMs: number | null;
}

export interface QueueHygieneAgeBucket {
  label: string;
  minAgeMs: number;
  maxAgeMs: number | null;
  count: number;
  statuses: Partial<Record<TaskStatus, number>>;
}

export interface QueueHygieneRequeueBreakdown {
  /** Tasks that have been requeued. */
  requeued: number;
  /** Tasks requeued more than once. */
  multiRequeued: number;
  /** Deepest requeue chain observed. */
  maxRequeueDepth: number;
  /** Requeued task ids for operator inspection (capped at 20). */
  sampleTaskIds: string[];
}

export interface QueueHygieneSnapshot {
  kind: "broker.queue-hygiene.snapshot";
  generatedAt: string;
  /** Total task records analyzed. */
  totalTasks: number;
  /** Tasks currently active (not terminal). */
  activeTasks: number;
  /** Tasks in terminal states. */
  terminalTasks: number;
  /** Breakdown by status. */
  byStatus: QueueHygieneStatusBreakdown[];
  /** Age buckets for active tasks only. */
  ageBuckets: QueueHygieneAgeBucket[];
  /** Requeue chain analysis. */
  requeue: QueueHygieneRequeueBreakdown;
  /** Overall hygiene verdict. */
  severity: QueueHygieneSeverity;
  /** Structured warnings for operators. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Default thresholds
// ---------------------------------------------------------------------------

/** Warning: more than this many active tasks queued/claimed/running. */
export const DEFAULT_ACTIVE_TASK_WARNING = 50;
/** Critical: more than this many active tasks. */
export const DEFAULT_ACTIVE_TASK_CRITICAL = 200;
/** Warning: a single task has been requeued more than this many times. */
export const DEFAULT_REQUEUE_DEPTH_WARNING = 3;
/** Critical: a single task has been requeued more than this many times. */
export const DEFAULT_REQUEUE_DEPTH_CRITICAL = 5;
/** Warning: task has been in its current status longer than this (ms). */
export const DEFAULT_STATUS_AGE_WARNING_MS = 30 * 60 * 1000; // 30 min
/** Critical: task has been in its current status longer than this (ms). */
export const DEFAULT_STATUS_AGE_CRITICAL_MS = 4 * 60 * 60 * 1000; // 4 hr
/** Warning: queued-to-claimed ratio exceeds this threshold. */
export const DEFAULT_QUEUE_PRESSURE_RATIO = 3.0;

export interface QueueHygieneSnapshotOptions {
  tasks: TaskRecord[];
  /** Current time override for testing. */
  nowMs?: number;
  /** Generated-at timestamp override. */
  generatedAt?: string;
  thresholds?: {
    activeTaskWarning?: number;
    activeTaskCritical?: number;
    requeueDepthWarning?: number;
    requeueDepthCritical?: number;
    statusAgeWarningMs?: number;
    statusAgeCriticalMs?: number;
    queuePressureRatio?: number;
  };
}

// ---------------------------------------------------------------------------
// Active (non-terminal) task statuses
// ---------------------------------------------------------------------------

const ACTIVE_TASK_STATUSES: TaskStatus[] = ["blocked", "queued", "claimed", "running"];
const TERMINAL_TASK_STATUSES: TaskStatus[] = ["succeeded", "failed", "canceled"];

// ---------------------------------------------------------------------------
// Snapshot builder
// ---------------------------------------------------------------------------

export function buildQueueHygieneSnapshot(
  options: QueueHygieneSnapshotOptions,
): QueueHygieneSnapshot {
  const { tasks } = options;
  const nowMs = options.nowMs ?? Date.now();
  const generatedAt = options.generatedAt ?? new Date(nowMs).toISOString();
  const t = { ...defaultHygieneThresholds(), ...options.thresholds };

  const activeTasks = tasks.filter((task) => !TERMINAL_TASK_STATUSES.includes(task.status as never));
  const terminalTasks = tasks.filter((task) => TERMINAL_TASK_STATUSES.includes(task.status as never));

  const byStatus = buildStatusBreakdown(tasks, nowMs);
  const ageBuckets = buildAgeBuckets(activeTasks, nowMs);
  const requeue = buildRequeueBreakdown(tasks);
  const severity = computeHygieneSeverity(byStatus, ageBuckets, requeue, t);
  const warnings = buildHygieneWarnings(byStatus, ageBuckets, requeue, severity, t);

  return {
    kind: "broker.queue-hygiene.snapshot",
    generatedAt,
    totalTasks: tasks.length,
    activeTasks: activeTasks.length,
    terminalTasks: terminalTasks.length,
    byStatus,
    ageBuckets,
    requeue,
    severity,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function defaultHygieneThresholds() {
  return {
    activeTaskWarning: DEFAULT_ACTIVE_TASK_WARNING,
    activeTaskCritical: DEFAULT_ACTIVE_TASK_CRITICAL,
    requeueDepthWarning: DEFAULT_REQUEUE_DEPTH_WARNING,
    requeueDepthCritical: DEFAULT_REQUEUE_DEPTH_CRITICAL,
    statusAgeWarningMs: DEFAULT_STATUS_AGE_WARNING_MS,
    statusAgeCriticalMs: DEFAULT_STATUS_AGE_CRITICAL_MS,
    queuePressureRatio: DEFAULT_QUEUE_PRESSURE_RATIO,
  };
}

function buildStatusBreakdown(
  tasks: TaskRecord[],
  nowMs: number,
): QueueHygieneStatusBreakdown[] {
  const allStatuses: TaskStatus[] = [...ACTIVE_TASK_STATUSES, ...TERMINAL_TASK_STATUSES];
  return allStatuses.map((status) => {
    const matches = tasks.filter((task) => task.status === status);
    if (matches.length === 0) {
      return {
        status,
        count: 0,
        oldestCreatedAt: null,
        oldestAgeMs: null,
        newestCreatedAt: null,
        youngestAgeMs: null,
      };
    }
    const timestamps = matches
      .map((t) => Date.parse(t.createdAt))
      .filter((ms) => Number.isFinite(ms));
    const oldestMs = timestamps.length > 0 ? Math.min(...timestamps) : null;
    const newestMs = timestamps.length > 0 ? Math.max(...timestamps) : null;
    return {
      status,
      count: matches.length,
      oldestCreatedAt: oldestMs !== null ? new Date(oldestMs).toISOString() : null,
      oldestAgeMs: oldestMs !== null ? nowMs - oldestMs : null,
      newestCreatedAt: newestMs !== null ? new Date(newestMs).toISOString() : null,
      youngestAgeMs: newestMs !== null ? nowMs - newestMs : null,
    };
  });
}

function buildAgeBuckets(
  activeTasks: TaskRecord[],
  nowMs: number,
): QueueHygieneAgeBucket[] {
  const buckets: QueueHygieneAgeBucket[] = [
    { label: "< 15 min", minAgeMs: 0, maxAgeMs: 15 * 60 * 1000, count: 0, statuses: {} },
    { label: "15 min – 1 hr", minAgeMs: 15 * 60 * 1000, maxAgeMs: 60 * 60 * 1000, count: 0, statuses: {} },
    { label: "1 hr – 4 hr", minAgeMs: 60 * 60 * 1000, maxAgeMs: 4 * 60 * 60 * 1000, count: 0, statuses: {} },
    { label: "4 hr – 24 hr", minAgeMs: 4 * 60 * 60 * 1000, maxAgeMs: 24 * 60 * 60 * 1000, count: 0, statuses: {} },
    { label: "> 24 hr", minAgeMs: 24 * 60 * 60 * 1000, maxAgeMs: null, count: 0, statuses: {} },
  ];

  for (const task of activeTasks) {
    const createdAtMs = Date.parse(task.createdAt);
    if (!Number.isFinite(createdAtMs)) continue;
    const ageMs = nowMs - createdAtMs;

    for (const bucket of buckets) {
      if (ageMs >= bucket.minAgeMs && (bucket.maxAgeMs === null || ageMs < bucket.maxAgeMs)) {
        bucket.count++;
        bucket.statuses[task.status] = (bucket.statuses[task.status] ?? 0) + 1;
        break;
      }
    }
  }

  return buckets.filter((bucket) => bucket.count > 0);
}

function buildRequeueBreakdown(
  tasks: TaskRecord[],
): QueueHygieneRequeueBreakdown {
  const requeuedTasks = tasks.filter(
    (task) => typeof task.requeueCount === "number" && task.requeueCount > 0,
  );

  const multiRequeued = requeuedTasks.filter(
    (task) => (task.requeueCount ?? 0) > 1,
  );

  const maxRequeueDepth = requeuedTasks.reduce(
    (max, task) => Math.max(max, task.requeueCount ?? 0),
    0,
  );

  return {
    requeued: requeuedTasks.length,
    multiRequeued: multiRequeued.length,
    maxRequeueDepth,
    sampleTaskIds: requeuedTasks.slice(0, 20).map((task) => task.id),
  };
}

function computeHygieneSeverity(
  byStatus: QueueHygieneStatusBreakdown[],
  _ageBuckets: QueueHygieneAgeBucket[],
  requeue: QueueHygieneRequeueBreakdown,
  t: ReturnType<typeof defaultHygieneThresholds>,
): QueueHygieneSeverity {
  const activeTotal = byStatus
    .filter((s) => ACTIVE_TASK_STATUSES.includes(s.status))
    .reduce((sum, s) => sum + s.count, 0);

  // Critical: active tasks exceed critical threshold
  if (activeTotal >= t.activeTaskCritical) return "critical";

  // Critical: requeue depth exceeds critical threshold
  if (requeue.maxRequeueDepth >= t.requeueDepthCritical) return "critical";

  // Critical: any active task older than critical age
  const oldestActiveAge = byStatus
    .filter((s) => ACTIVE_TASK_STATUSES.includes(s.status))
    .reduce((max, s) => Math.max(max, s.oldestAgeMs ?? 0), 0);
  if (oldestActiveAge >= t.statusAgeCriticalMs) return "critical";

  // Warning: active tasks exceed warning threshold
  if (activeTotal >= t.activeTaskWarning) return "warning";

  // Warning: requeue depth exceeds warning threshold
  if (requeue.maxRequeueDepth >= t.requeueDepthWarning) return "warning";

  // Warning: queue pressure ratio
  const queuedCount = byStatus.find((s) => s.status === "queued")?.count ?? 0;
  const claimedCount = byStatus.find((s) => s.status === "claimed")?.count ?? 0;
  const runningCount = byStatus.find((s) => s.status === "running")?.count ?? 0;
  const claimedRunning = claimedCount + runningCount;
  if (claimedRunning > 0 && queuedCount / claimedRunning >= t.queuePressureRatio) {
    return "warning";
  }

  // Warning: any active task older than warning age
  if (oldestActiveAge >= t.statusAgeWarningMs) return "warning";

  return "ok";
}

function buildHygieneWarnings(
  byStatus: QueueHygieneStatusBreakdown[],
  ageBuckets: QueueHygieneAgeBucket[],
  requeue: QueueHygieneRequeueBreakdown,
  severity: QueueHygieneSeverity,
  _t: ReturnType<typeof defaultHygieneThresholds>,
): string[] {
  const warnings: string[] = [];

  const activeTotal = byStatus
    .filter((s) => ACTIVE_TASK_STATUSES.includes(s.status))
    .reduce((sum, s) => sum + s.count, 0);

  if (activeTotal > 0) {
    warnings.push(`Active tasks: ${activeTotal} (${byStatus.map((s) => `${s.status}=${s.count}`).join(", ")})`);
  }

  const queuedCount = byStatus.find((s) => s.status === "queued")?.count ?? 0;
  if (queuedCount > 20) {
    warnings.push(`Queue depth: ${queuedCount} tasks waiting`);
  }

  if (requeue.requeued > 0) {
    warnings.push(`Requeued tasks: ${requeue.requeued} (${requeue.multiRequeued} multi-requeued, max depth=${requeue.maxRequeueDepth})`);
  }

  // Age bucket warnings
  const oldBuckets = ageBuckets.filter(
    (b) => b.minAgeMs >= 4 * 60 * 60 * 1000,
  );
  if (oldBuckets.length > 0) {
    const oldCount = oldBuckets.reduce((sum, b) => sum + b.count, 0);
    if (oldCount > 0) {
      warnings.push(`${oldCount} active task(s) older than 4 hours`);
    }
  }

  if (severity === "critical") {
    warnings.unshift("Queue hygiene CRITICAL: active tasks or requeue depth exceed safe limits");
  } else if (severity === "warning") {
    warnings.unshift("Queue hygiene WARNING: tasks may need operator attention");
  }

  return warnings;
}
