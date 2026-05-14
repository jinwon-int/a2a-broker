/**
 * Hot-table growth projection for broker diagnostics.
 *
 * Pure function: takes current hot-table load metrics and an optional prior
 * snapshot to compute growth rates, projected saturation timelines, and
 * structured warnings for operators.
 *
 * Design:
 *   - Stateless: pure function of input metrics, no side effects.
 *   - No production mutation: read-only projection only.
 *   - Deterministic: same inputs → same output.
 *
 * Used by: health endpoint (via store), migration-health-gate, canary gates.
 * Reference: #533 Team1/Bangtong diagnostics for #497/#294 stability gates.
 */
import type { BrokerHotTableLoadMetrics, BrokerHotTableRuntimeLoadLimits } from "./store.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HotTableGrowthSeverity = "ok" | "warning" | "critical";

export interface HotTableGrowthTableProjection {
  table: string;
  currentCount: number;
  maxPayloadBytes: number;
  /** Estimated total in-memory footprint (bytes) for this table. */
  estimatedMemoryBytes: number;
  /** Runtime load cap for this table, if applicable. */
  runtimeLimit: number | null;
  /** Rows loaded into heap under the current cap. */
  runtimeLoaded: number;
  /** Rows skipped from heap hydration. */
  runtimeSkipped: number;
  /** Count at the prior snapshot, if available. */
  priorCount: number | null;
  /** Absolute delta since prior snapshot. */
  growthDelta: number;
  /** Growth rate as a fraction (delta / priorCount). Null if no prior. */
  growthRate: number | null;
  /** Severity of this table's state. */
  severity: HotTableGrowthSeverity;
  /** Human-readable summary of the table's state. */
  summary: string;
}

export interface HotTableGrowthProjection {
  kind: "broker.hot-table-growth.projection";
  generatedAt: string;
  /** Whether this includes a prior comparison. */
  hasPrior: boolean;
  /** Prior snapshot timestamp, if available. */
  priorGeneratedAt: string | null;
  /** Total estimated hot-table memory footprint across all tables. */
  totalEstimatedMemoryBytes: number;
  /** Aggregate severity across all tables. */
  overallSeverity: HotTableGrowthSeverity;
  /** Per-table projections. */
  tables: HotTableGrowthTableProjection[];
  /** Active runtime load limits. */
  runtimeLoadLimits: BrokerHotTableRuntimeLoadLimits;
  /** Aggregate warnings. */
  warnings: string[];
  /** Whether the warnings array was truncated because it exceeded `maxWarnings`. */
  warningsTruncated: boolean;
  /**
   * Process memory snapshot at the time of projection.
   * Present when `processMemory` was supplied in options.
   */
  processMemory?: {
    rssBytes: number;
    heapTotalBytes: number;
    heapUsedBytes: number;
    heapLimitBytes: number;
    heapUsedRatio: number;
  };
  /**
   * Snapshot persistence metrics.
   * Present when `snapshotMetrics` was supplied in options.
   */
  snapshotMetrics?: {
    lastSnapshotBytes: number | null;
    lastPersistDurationMs: number | null;
    lastSnapshotAt: string | null;
  };
  /**
   * Readiness degradation assessment — flags that the broker may be near
   * OOM or unable to hydrate critical table rows into live memory.
   */
  readinessDegradation?: {
    /** True when heap usage exceeds 80% of the heap limit. */
    heapPressure: boolean;
    /** True when hot-table estimated memory exceeds 50% of available heap. */
    memoryPressure: boolean;
    /** True when any table has a critical runtime skipped ratio. */
    hydrationPressure: boolean;
    /** True when any pressure flag is set (overall risky indicator). */
    overallRisky: boolean;
  };
}

// ---------------------------------------------------------------------------
// Default thresholds
// ---------------------------------------------------------------------------

/** Default warning threshold: total hot entities exceed this many rows. */
export const DEFAULT_HOT_TABLE_GROWTH_WARNING_ROWS = 2_000;
/** Default critical threshold: total hot entities exceed this many rows. */
export const DEFAULT_HOT_TABLE_GROWTH_CRITICAL_ROWS = 10_000;
/** Default warning threshold: single table exceeds this many rows. */
export const DEFAULT_SINGLE_TABLE_WARNING_ROWS = 1_000;
/** Default single-table critical row threshold. */
export const DEFAULT_SINGLE_TABLE_CRITICAL_ROWS = 5_000;
/** Default warning: growth rate > 50% between snapshots. */
export const DEFAULT_GROWTH_RATE_WARNING = 0.5;
/** Default warning: estimated memory > 100 MB. */
export const DEFAULT_MEMORY_WARNING_BYTES = 100 * 1024 * 1024;
/** Default critical: estimated memory > 500 MB. */
export const DEFAULT_MEMORY_CRITICAL_BYTES = 500 * 1024 * 1024;
/** Default warning: runtime skipped ratio > 0.3 (30% of rows skipped from heap). */
export const DEFAULT_SKIPPED_RATIO_WARNING = 0.3;
/** Default critical: runtime skipped ratio > 0.7. */
export const DEFAULT_SKIPPED_RATIO_CRITICAL = 0.7;

/** Default maximum number of warnings to include in the projection. */
export const DEFAULT_MAX_WARNINGS = 10;

/** Default heap pressure ratio: warn when heap used > 80% of limit. */
export const DEFAULT_HEAP_PRESSURE_RATIO = 0.8;

/** Default memory pressure ratio: warn when hot-table memory > 50% of available heap. */
export const DEFAULT_MEMORY_PRESSURE_RATIO = 0.5;

export interface HotTableGrowthProjectionOptions {
  /** Current metrics from the broker health endpoint. */
  current: BrokerHotTableLoadMetrics;
  /** Optional prior metrics for growth-rate comparison. */
  prior?: BrokerHotTableLoadMetrics | null;
  /** Prior snapshot timestamp. */
  priorGeneratedAt?: string;
  /** Current runtime load limits. */
  runtimeLoadLimits?: BrokerHotTableRuntimeLoadLimits;
  /** Generated-at timestamp override (for testing). */
  generatedAt?: string;
  /** Maximum number of warnings to include. Extra warnings are dropped and
   *  `warningsTruncated` is set to `true`. Default: {@link DEFAULT_MAX_WARNINGS}. */
  maxWarnings?: number;
  /** Process memory snapshot (from `process.memoryUsage()` + `v8.getHeapStatistics()`).
   *  When supplied, enables `processMemory` and `readinessDegradation` on the projection. */
  processMemory?: {
    rssBytes: number;
    heapTotalBytes: number;
    heapUsedBytes: number;
    heapLimitBytes: number;
  };
  /** Snapshot persistence metrics. When supplied, enables `snapshotMetrics` on the projection. */
  snapshotMetrics?: {
    lastSnapshotBytes?: number | null;
    lastPersistDurationMs?: number | null;
    lastSnapshotAt?: string | null;
  };
  /** Custom thresholds. */
  thresholds?: {
    totalWarningRows?: number;
    totalCriticalRows?: number;
    singleTableWarningRows?: number;
    singleTableCriticalRows?: number;
    growthRateWarning?: number;
    memoryWarningBytes?: number;
    memoryCriticalBytes?: number;
    skippedRatioWarning?: number;
    skippedRatioCritical?: number;
  };
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

export function projectHotTableGrowth(
  options: HotTableGrowthProjectionOptions,
): HotTableGrowthProjection {
  const { current, prior, priorGeneratedAt, runtimeLoadLimits, generatedAt } = options;
  const t = { ...defaultThresholds(), ...options.thresholds };

  const hasPrior = prior !== undefined && prior !== null;
  const tables = Object.entries(current.tables).map(
    ([table, entry]): HotTableGrowthTableProjection => {
      const priorEntry = prior?.tables[table];
      const priorCount = priorEntry?.count ?? null;
      const growthDelta = priorCount !== null ? entry.count - priorCount : 0;
      const growthRate = priorCount !== null && priorCount > 0
        ? growthDelta / priorCount
        : null;
      const estimatedMemoryBytes = entry.count * entry.maxPayloadBytes;
      const runtimeLoad = entry.runtimeLoad;

      const severity = computeTableSeverity(table, entry.count, estimatedMemoryBytes, growthRate, runtimeLoad, t);
      const summary = buildTableSummary(table, entry.count, estimatedMemoryBytes, growthDelta, growthRate, runtimeLoad);

      return {
        table,
        currentCount: entry.count,
        maxPayloadBytes: entry.maxPayloadBytes,
        estimatedMemoryBytes,
        runtimeLimit: runtimeLoad?.limit ?? null,
        runtimeLoaded: runtimeLoad?.loadedCount ?? entry.count,
        runtimeSkipped: runtimeLoad?.skippedCount ?? 0,
        priorCount,
        growthDelta,
        growthRate,
        severity,
        summary,
      };
    },
  );

  const totalEstimatedMemoryBytes = tables.reduce(
    (sum, table) => sum + table.estimatedMemoryBytes,
    0,
  );

  const overallSeverity = computeOverallSeverity(tables, totalEstimatedMemoryBytes, t);
  const maxWarnings = normalizeMaxWarnings(options.maxWarnings);
  const warnings = buildWarnings(tables, totalEstimatedMemoryBytes, hasPrior, t, maxWarnings);

  const processMemory = options.processMemory
    ? {
        rssBytes: options.processMemory.rssBytes,
        heapTotalBytes: options.processMemory.heapTotalBytes,
        heapUsedBytes: options.processMemory.heapUsedBytes,
        heapLimitBytes: options.processMemory.heapLimitBytes,
        heapUsedRatio:
          options.processMemory.heapLimitBytes > 0
            ? Math.round((options.processMemory.heapUsedBytes / options.processMemory.heapLimitBytes) * 1000) / 1000
            : 0,
      }
    : undefined;

  const snapshotMetrics = options.snapshotMetrics
    ? {
        lastSnapshotBytes: options.snapshotMetrics.lastSnapshotBytes ?? null,
        lastPersistDurationMs: options.snapshotMetrics.lastPersistDurationMs ?? null,
        lastSnapshotAt: options.snapshotMetrics.lastSnapshotAt ?? null,
      }
    : undefined;

  const readinessDegradation = processMemory
    ? computeReadinessDegradation(tables, totalEstimatedMemoryBytes, processMemory)
    : undefined;

  return {
    kind: "broker.hot-table-growth.projection",
    generatedAt: generatedAt ?? new Date().toISOString(),
    hasPrior,
    priorGeneratedAt: priorGeneratedAt ?? null,
    totalEstimatedMemoryBytes,
    overallSeverity,
    tables,
    runtimeLoadLimits: runtimeLoadLimits ?? {
      terminalTasks: 0,
      auditEvents: 0,
      terminalOutboxEvents: 0,
    },
    warnings,
    warningsTruncated: warnings.length < countWarnings(tables, totalEstimatedMemoryBytes, hasPrior, t),
    ...(processMemory !== undefined ? { processMemory } : {}),
    ...(snapshotMetrics !== undefined ? { snapshotMetrics } : {}),
    ...(readinessDegradation !== undefined ? { readinessDegradation } : {}),
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function defaultThresholds() {
  return {
    totalWarningRows: DEFAULT_HOT_TABLE_GROWTH_WARNING_ROWS,
    totalCriticalRows: DEFAULT_HOT_TABLE_GROWTH_CRITICAL_ROWS,
    singleTableWarningRows: DEFAULT_SINGLE_TABLE_WARNING_ROWS,
    singleTableCriticalRows: DEFAULT_SINGLE_TABLE_CRITICAL_ROWS,
    growthRateWarning: DEFAULT_GROWTH_RATE_WARNING,
    memoryWarningBytes: DEFAULT_MEMORY_WARNING_BYTES,
    memoryCriticalBytes: DEFAULT_MEMORY_CRITICAL_BYTES,
    skippedRatioWarning: DEFAULT_SKIPPED_RATIO_WARNING,
    skippedRatioCritical: DEFAULT_SKIPPED_RATIO_CRITICAL,
  };
}

function computeTableSeverity(
  table: string,
  count: number,
  estimatedMemoryBytes: number,
  growthRate: number | null,
  runtimeLoad: { limit: number; loadedCount: number; skippedCount: number } | undefined,
  t: ReturnType<typeof defaultThresholds>,
): HotTableGrowthSeverity {
  // Only check meaningful tables
  if (count === 0) return "ok";

  // Critical: single table rows exceed critical threshold
  if (table === "broker_tasks" && count >= t.singleTableCriticalRows) return "critical";
  if (table === "broker_audit_events" && count >= t.singleTableCriticalRows) return "critical";

  // Critical: memory exceeds critical threshold
  if (estimatedMemoryBytes >= t.memoryCriticalBytes) return "critical";

  // Critical: large fraction of rows skipped from heap hydration
  if (runtimeLoad && runtimeLoad.skippedCount > 0) {
    const skippedRatio = runtimeLoad.skippedCount / (runtimeLoad.loadedCount + runtimeLoad.skippedCount);
    if (skippedRatio >= t.skippedRatioCritical) return "critical";
  }

  // Warning: single table rows exceed warning threshold
  if (count >= t.singleTableWarningRows) return "warning";

  // Warning: growth rate is high
  if (growthRate !== null && growthRate >= t.growthRateWarning) return "warning";

  // Warning: memory exceeds warning threshold
  if (estimatedMemoryBytes >= t.memoryWarningBytes) return "warning";

  // Warning: some rows skipped from heap
  if (runtimeLoad && runtimeLoad.skippedCount > 0) {
    const skippedRatio = runtimeLoad.skippedCount / (runtimeLoad.loadedCount + runtimeLoad.skippedCount);
    if (skippedRatio >= t.skippedRatioWarning) return "warning";
  }

  return "ok";
}

function computeOverallSeverity(
  tables: HotTableGrowthTableProjection[],
  totalMemory: number,
  t: ReturnType<typeof defaultThresholds>,
): HotTableGrowthSeverity {
  const totalRows = tables.reduce((sum, table) => sum + table.currentCount, 0);

  if (tables.some((table) => table.severity === "critical")) return "critical";
  if (totalMemory >= t.memoryCriticalBytes) return "critical";
  if (totalRows >= t.totalCriticalRows) return "critical";

  if (tables.some((table) => table.severity === "warning")) return "warning";
  if (totalMemory >= t.memoryWarningBytes) return "warning";
  if (totalRows >= t.totalWarningRows) return "warning";

  return "ok";
}

function buildTableSummary(
  table: string,
  count: number,
  memoryBytes: number,
  growthDelta: number,
  growthRate: number | null,
  runtimeLoad: { limit: number; loadedCount: number; skippedCount: number } | undefined,
): string {
  const parts: string[] = [];
  parts.push(`${table}: ${count} rows`);
  parts.push(`~${formatBytes(memoryBytes)} in-memory`);

  if (growthRate !== null && growthRate !== 0) {
    const direction = growthDelta > 0 ? "+" : "";
    const pct = (growthRate * 100).toFixed(1);
    parts.push(`${direction}${pct}% growth`);
  }

  if (runtimeLoad && runtimeLoad.skippedCount > 0) {
    const skippedRatio = (runtimeLoad.skippedCount / (runtimeLoad.loadedCount + runtimeLoad.skippedCount) * 100).toFixed(0);
    parts.push(`${runtimeLoad.skippedCount} rows (${skippedRatio}%) skipped from heap`);
  }

  return parts.join(", ");
}

function buildWarnings(
  tables: HotTableGrowthTableProjection[],
  totalMemory: number,
  hasPrior: boolean,
  t: ReturnType<typeof defaultThresholds>,
  maxWarnings = DEFAULT_MAX_WARNINGS,
): string[] {
  const warnings: string[] = [];

  for (const table of tables) {
    if (table.severity === "critical") {
      appendBounded(warnings, `CRITICAL: ${table.summary}`, maxWarnings);
    } else if (table.severity === "warning") {
      appendBounded(warnings, `WARNING: ${table.summary}`, maxWarnings);
    }
  }

  if (totalMemory >= t.memoryWarningBytes && warnings.length < maxWarnings) {
    warnings.push(
      `Total hot-table memory ~${formatBytes(totalMemory)} exceeds warning threshold ${formatBytes(t.memoryWarningBytes)}`,
    );
  }

  if (!hasPrior && warnings.length < maxWarnings) {
    warnings.push("No prior snapshot available; growth rate could not be computed. Run again after an interval for differential analysis.");
  }

  return warnings;
}

/**
 * Count the total number of warnings that would be emitted without truncation.
 */
function countWarnings(
  tables: HotTableGrowthTableProjection[],
  totalMemory: number,
  hasPrior: boolean,
  t: ReturnType<typeof defaultThresholds>,
): number {
  let count = 0;
  for (const table of tables) {
    if (table.severity === "critical" || table.severity === "warning") {
      count++;
    }
  }
  if (totalMemory >= t.memoryWarningBytes) count++;
  if (!hasPrior) count++;
  return count;
}

/** Push `item` onto `arr` if the array is shorter than `max`. */
function appendBounded<T>(arr: T[], item: T, max: number): void {
  if (arr.length < max) {
    arr.push(item);
  }
}

function normalizeMaxWarnings(value: number | undefined): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 1) {
    return Math.floor(value);
  }
  return DEFAULT_MAX_WARNINGS;
}

function computeReadinessDegradation(
  tables: HotTableGrowthTableProjection[],
  totalEstimatedMemoryBytes: number,
  processMemory: { heapUsedBytes: number; heapLimitBytes: number; heapUsedRatio: number },
): {
  heapPressure: boolean;
  memoryPressure: boolean;
  hydrationPressure: boolean;
  overallRisky: boolean;
} {
  const heapPressure = processMemory.heapUsedRatio > DEFAULT_HEAP_PRESSURE_RATIO;
  const memoryPressure =
    processMemory.heapLimitBytes > 0 &&
    totalEstimatedMemoryBytes / processMemory.heapLimitBytes > DEFAULT_MEMORY_PRESSURE_RATIO;
  const hydrationPressure = tables.some((t) => t.severity === "critical" && t.runtimeSkipped > 0);
  return {
    heapPressure,
    memoryPressure,
    hydrationPressure,
    overallRisky: heapPressure || memoryPressure || hydrationPressure,
  };
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
