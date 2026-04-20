/**
 * Alert projection for monitoring-friendly status.
 *
 * Scans task diagnostic reports and produces structured alerts for downstream
 * consumers (dashboard UI, notification channels, gateway RPC surface).
 *
 * Design principles:
 *   - Stateless: pure function of diagnostic reports, no side effects.
 *   - Deterministic: same input always produces same alerts.
 *   - Composable: alerts are plain data, easy to filter/route.
 */
import type {
  TaskDiagnosticReport,
  TaskDiagnosticStatus,
  TaskTombstone,
  TaskStatus,
} from "./types.js";

// ---------------------------------------------------------------------------
// Alert types
// ---------------------------------------------------------------------------

export type AlertSeverity = "info" | "warning" | "critical";

export type AlertKind =
  | "task_stale"
  | "task_long_running"
  | "task_dead_lettered"
  | "task_worker_lost"
  | "task_timeout"
  | "task_failed"
  | "task_canceled"
  | "queue_pressure";

export interface Alert {
  /** Unique alert id (deterministic: `${kind}:${taskId}`). */
  id: string;
  kind: AlertKind;
  severity: AlertSeverity;
  /** The task this alert is about. */
  taskId: string;
  /** Human-readable summary. */
  summary: string;
  /** ISO timestamp when the condition was detected. */
  detectedAt: string;
  /** Relevant timing in milliseconds. */
  durationMs?: number;
  /** Additional context. */
  metadata: Record<string, unknown>;
}

export interface AlertScanResult {
  /** When this scan was computed. */
  scannedAt: string;
  /** Total number of tasks scanned. */
  totalScanned: number;
  /** Alerts grouped by severity. */
  alerts: Alert[];
  /** Quick counts by severity. */
  counts: Record<AlertSeverity, number>;
  /** Quick counts by kind. */
  countsByKind: Record<AlertKind, number>;
}

// ---------------------------------------------------------------------------
// Alert projection — pure function
// ---------------------------------------------------------------------------

export interface AlertProjectionOptions {
  /** Staleness threshold for "critical" (default: 10 min). */
  staleCriticalMs?: number;
  /** Staleness threshold for "warning" (default: 2 min). */
  staleWarningMs?: number;
  /** Long-running threshold for "warning" (default: 1 hr). */
  longRunningWarningMs?: number;
  /** Long-running threshold for "critical" (default: 4 hr). */
  longRunningCriticalMs?: number;
  /** Queue pressure: number of queued tasks for warning. */
  queuePressureWarning?: number;
  /** Queue pressure: number of queued tasks for critical. */
  queuePressureCritical?: number;
  /** Current time override (for testing). */
  nowMs?: number;
}

export function projectAlerts(
  reports: TaskDiagnosticReport[],
  options?: AlertProjectionOptions,
): AlertScanResult {
  const nowMs = options?.nowMs ?? Date.now();
  const now = new Date(nowMs).toISOString();
  const staleWarningMs = options?.staleWarningMs ?? 120_000;
  const staleCriticalMs = options?.staleCriticalMs ?? 600_000;
  const longRunningWarningMs = options?.longRunningWarningMs ?? 3_600_000;
  const longRunningCriticalMs = options?.longRunningCriticalMs ?? 14_400_000;

  const alerts: Alert[] = [];

  for (const report of reports) {
    // Stale tasks
    if (report.diagnosticStatus === "stale") {
      const stalenessMs = report.stalenessMs ?? report.currentStatusDurationMs;
      const severity: AlertSeverity =
        stalenessMs >= staleCriticalMs ? "critical" : "warning";
      alerts.push(
        makeAlert("task_stale", severity, report, now, {
          summary: `Task ${report.taskId} is stale (no heartbeat for ${Math.round(stalenessMs / 1000)}s)`,
          durationMs: stalenessMs,
          extra: {
            stalenessMs,
            intent: report.task.intent,
            targetNodeId: report.task.targetNodeId,
            assignedWorkerId: report.task.assignedWorkerId,
          },
        }),
      );
    }

    // Long-running tasks
    if (report.diagnosticStatus === "long_running") {
      const durationMs = report.currentStatusDurationMs;
      const severity: AlertSeverity =
        durationMs >= longRunningCriticalMs ? "critical" : "warning";
      alerts.push(
        makeAlert("task_long_running", severity, report, now, {
          summary: `Task ${report.taskId} has been running for ${Math.round(durationMs / 60000)}m`,
          durationMs,
          extra: {
            intent: report.task.intent,
            targetNodeId: report.task.targetNodeId,
          },
        }),
      );
    }

    // Terminal alerts from tombstones
    if (report.diagnosticStatus === "terminal" && report.tombstone) {
      const ts = report.tombstone;
      const terminalAlert = projectTerminalAlert(report, ts, now);
      if (terminalAlert) {
        alerts.push(terminalAlert);
      }
    }
  }

  // Sort: critical first, then warning, then info
  const severityOrder: Record<AlertSeverity, number> = {
    critical: 0,
    warning: 1,
    info: 2,
  };
  alerts.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  const counts = { critical: 0, warning: 0, info: 0 };
  const countsByKind = {} as Record<AlertKind, number>;
  for (const alert of alerts) {
    counts[alert.severity]++;
    countsByKind[alert.kind] = (countsByKind[alert.kind] ?? 0) + 1;
  }

  return {
    scannedAt: now,
    totalScanned: reports.length,
    alerts,
    counts,
    countsByKind,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function projectTerminalAlert(
  report: TaskDiagnosticReport,
  tombstone: TaskTombstone,
  now: string,
): Alert | null {
  const base = {
    taskId: report.taskId,
    detectedAt: now,
    durationMs: tombstone.durationMs,
  };

  switch (tombstone.tombstoneReason) {
    case "dead_lettered":
      return makeAlert("task_dead_lettered", "critical", report, now, {
        summary: `Task ${report.taskId} dead-lettered after ${tombstone.requeueCount} requeues`,
        durationMs: tombstone.durationMs,
        extra: {
          requeueCount: tombstone.requeueCount,
          error: tombstone.error,
        },
      });
    case "worker_lost":
      return makeAlert("task_worker_lost", "warning", report, now, {
        summary: `Task ${report.taskId} terminated: assigned worker went offline`,
        durationMs: tombstone.durationMs,
        extra: {
          assignedWorkerId: report.task.assignedWorkerId,
        },
      });
    case "timeout":
      return makeAlert("task_timeout", "warning", report, now, {
        summary: `Task ${report.taskId} timed out after ${Math.round(tombstone.durationMs / 1000)}s`,
        durationMs: tombstone.durationMs,
      });
    case "failed":
      return makeAlert("task_failed", "info", report, now, {
        summary: `Task ${report.taskId} failed: ${tombstone.error?.message ?? "unknown error"}`,
        durationMs: tombstone.durationMs,
        extra: { error: tombstone.error },
      });
    case "canceled":
      return makeAlert("task_canceled", "info", report, now, {
        summary: `Task ${report.taskId} was canceled`,
        durationMs: tombstone.durationMs,
      });
    default:
      return null;
  }
}

function makeAlert(
  kind: AlertKind,
  severity: AlertSeverity,
  report: TaskDiagnosticReport,
  detectedAt: string,
  opts: {
    summary: string;
    durationMs?: number;
    extra?: Record<string, unknown>;
  },
): Alert {
  return {
    id: `${kind}:${report.taskId}`,
    kind,
    severity,
    taskId: report.taskId,
    summary: opts.summary,
    detectedAt,
    durationMs: opts.durationMs,
    metadata: {
      intent: report.task.intent,
      targetNodeId: report.task.targetNodeId,
      assignedWorkerId: report.task.assignedWorkerId,
      diagnosticStatus: report.diagnosticStatus,
      ...opts.extra,
    },
  };
}
