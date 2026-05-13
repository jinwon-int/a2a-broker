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
  const warnings = buildWarnings(tables, totalEstimatedMemoryBytes, hasPrior, t);

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
): string[] {
  const warnings: string[] = [];

  for (const table of tables) {
    if (table.severity === "critical") {
      warnings.push(`CRITICAL: ${table.summary}`);
    } else if (table.severity === "warning") {
      warnings.push(`WARNING: ${table.summary}`);
    }
  }

  if (totalMemory >= t.memoryWarningBytes) {
    warnings.push(
      `Total hot-table memory ~${formatBytes(totalMemory)} exceeds warning threshold ${formatBytes(t.memoryWarningBytes)}`,
    );
  }

  if (!hasPrior) {
    warnings.push("No prior snapshot available; growth rate could not be computed. Run again after an interval for differential analysis.");
  }

  return warnings;
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
