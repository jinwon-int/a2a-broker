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
    /**
     * Adaptive load limits computed by the heap budget guard.
     * Present when `processMemory` was supplied.
     * These show what the guard recommends to keep hot-table loads within budget.
     */
    adaptiveLoadLimits?: AdaptiveLoadLimits;
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

/**
 * Default heap budget guard: when heap pressure is active, load limits are
 * reduced below original caps by dividing by this factor.
 * E.g. 2 → terminal task limit halved.
 */
export const DEFAULT_HEAP_BUDGET_REDUCTION_FACTOR = 2;

/**
 * Default heap budget guard: minimum fraction of the original limit to retain
 * even under extreme heap pressure. Prevents starvation.
 * E.g. 0.25 → never reduce below 25% of the original limit.
 */
export const DEFAULT_HEAP_BUDGET_MINIMUM_FRACTION = 0.25;

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
  /**
   * Heap budget guard configuration. When omitted, defaults are used.
   * The guard computes adaptive runtime load limits from process memory
   * state and the configured reduction factor.
   */
  heapBudgetGuard?: {
    /** Reduction factor applied to limits under heap pressure. Default: 2. */
    reductionFactor?: number;
    /** Minimum fraction of the original limit to retain. Default: 0.25 (25%). */
    minimumFraction?: number;
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
// Adaptive load limits (heap budget guard)
// ---------------------------------------------------------------------------

/**
 * Adaptive load limits computed by the heap budget guard.
 *
 * These are recommendations for what the runtime load limits
 * should be reduced to under heap/memory pressure so that
 * hot-table hydration stays within the process heap budget.
 */
export interface AdaptiveLoadLimits {
  /** Original terminal task limit before reduction. */
  originalTerminalTaskLimit: number;
  /** Recommended terminal task limit after reduction. */
  adaptiveTerminalTaskLimit: number;
  /** Original audit event limit before reduction. */
  originalAuditEventLimit: number;
  /** Recommended audit event limit after reduction. */
  adaptiveAuditEventLimit: number;
  /** Original terminal outbox limit before reduction. */
  originalOutboxLimit: number;
  /** Recommended terminal outbox limit after reduction. */
  adaptiveOutboxLimit: number;
  /** Whether the guard was triggered (any limit changed). */
  guardTriggered: boolean;
  /** Why the guard reduced limits, if triggered. */
  guardReason: string | null;
  /** Reduction factor that was applied. */
  reductionFactor: number;
}

/**
 * Compute adaptive runtime load limits from process memory state and
 * the configured runtime load limits.
 *
 * Pure function: same inputs → same outputs, no side effects.
 *
 * Design:
 *   - If heap usage > 80% (heapPressure), divide all hot-table load limits
 *     by `reductionFactor` (default 2), subject to a minimum fraction of the
 *     original (default 25%).
 *   - If heap usage is safe but hot-table memory > 50% of heap limit
 *     (memoryPressure), apply the same reduction.
 *   - If neither pressure source is active, return the original limits unchanged
 *     (guard not triggered).
 *   - The guard never reduces a limit below `Math.max(1, Math.floor(original * minFraction))`.
 */
export function computeAdaptiveLoadLimits(
  processMemory: {
    heapUsedBytes: number;
    heapLimitBytes: number;
  },
  totalEstimatedMemoryBytes: number,
  runtimeLoadLimits: BrokerHotTableRuntimeLoadLimits,
  options?: {
    reductionFactor?: number;
    minimumFraction?: number;
  },
): AdaptiveLoadLimits {
  const reductionFactor = options?.reductionFactor ?? DEFAULT_HEAP_BUDGET_REDUCTION_FACTOR;
  const minimumFraction = options?.minimumFraction ?? DEFAULT_HEAP_BUDGET_MINIMUM_FRACTION;
  const heapUsedRatio =
    processMemory.heapLimitBytes > 0
      ? processMemory.heapUsedBytes / processMemory.heapLimitBytes
      : 0;

  const heapPressure = heapUsedRatio > DEFAULT_HEAP_PRESSURE_RATIO;
  const memoryPressure =
    processMemory.heapLimitBytes > 0 &&
    totalEstimatedMemoryBytes / processMemory.heapLimitBytes > DEFAULT_MEMORY_PRESSURE_RATIO;

  const guardTriggered = heapPressure || memoryPressure;

  const reduce = (original: number): number => {
    if (!guardTriggered || original <= 0) return original;
    const reduced = Math.floor(original / reductionFactor);
    const floor = Math.max(1, Math.floor(original * minimumFraction));
    return Math.max(reduced, floor);
  };

  const originalTerminalTaskLimit = runtimeLoadLimits.terminalTasks;
  const originalAuditEventLimit = runtimeLoadLimits.auditEvents;
  const originalOutboxLimit = runtimeLoadLimits.terminalOutboxEvents;

  const adaptiveTerminalTaskLimit = reduce(originalTerminalTaskLimit);
  const adaptiveAuditEventLimit = reduce(originalAuditEventLimit);
  const adaptiveOutboxLimit = reduce(originalOutboxLimit);

  const reasons: string[] = [];
  if (heapPressure) reasons.push(`heap at ${(heapUsedRatio * 100).toFixed(0)}% (threshold 80%)`);
  if (memoryPressure) reasons.push(`hot-table memory at ${((totalEstimatedMemoryBytes / processMemory.heapLimitBytes) * 100).toFixed(0)}% of heap (threshold 50%)`);

  return {
    originalTerminalTaskLimit,
    adaptiveTerminalTaskLimit,
    originalAuditEventLimit,
    adaptiveAuditEventLimit,
    originalOutboxLimit,
    adaptiveOutboxLimit,
    guardTriggered,
    guardReason: guardTriggered ? `Reduction factor ${reductionFactor}: ${reasons.join("; ")}` : null,
    reductionFactor,
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
    ? computeReadinessDegradation(
        tables,
        totalEstimatedMemoryBytes,
        processMemory,
        runtimeLoadLimits ?? {
          terminalTasks: 0,
          auditEvents: 0,
          terminalOutboxEvents: 0,
        },
        options.heapBudgetGuard,
      )
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
  runtimeLoadLimits: BrokerHotTableRuntimeLoadLimits,
  heapBudgetGuard?: { reductionFactor?: number; minimumFraction?: number },
): {
  heapPressure: boolean;
  memoryPressure: boolean;
  hydrationPressure: boolean;
  overallRisky: boolean;
  adaptiveLoadLimits?: AdaptiveLoadLimits;
} {
  const heapPressure = processMemory.heapUsedRatio > DEFAULT_HEAP_PRESSURE_RATIO;
  const memoryPressure =
    processMemory.heapLimitBytes > 0 &&
    totalEstimatedMemoryBytes / processMemory.heapLimitBytes > DEFAULT_MEMORY_PRESSURE_RATIO;
  const hydrationPressure = tables.some((t) => t.severity === "critical" && t.runtimeSkipped > 0);

  const adaptiveLoadLimits = computeAdaptiveLoadLimits(
    { heapUsedBytes: processMemory.heapUsedBytes, heapLimitBytes: processMemory.heapLimitBytes },
    totalEstimatedMemoryBytes,
    runtimeLoadLimits,
    heapBudgetGuard,
  );

  return {
    heapPressure,
    memoryPressure,
    hydrationPressure,
    overallRisky: heapPressure || memoryPressure || hydrationPressure,
    adaptiveLoadLimits: adaptiveLoadLimits.guardTriggered ? adaptiveLoadLimits : undefined,
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
