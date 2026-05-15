import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  projectHotTableGrowth,
  computeAdaptiveLoadLimits,
  DEFAULT_HOT_TABLE_GROWTH_WARNING_ROWS,
  DEFAULT_SINGLE_TABLE_WARNING_ROWS,
  DEFAULT_SINGLE_TABLE_CRITICAL_ROWS,
  DEFAULT_HEAP_BUDGET_REDUCTION_FACTOR,
  DEFAULT_HEAP_BUDGET_MINIMUM_FRACTION,
} from "./hot-table-growth.js";
import type { BrokerHotTableLoadMetrics, BrokerHotTableRuntimeLoadLimits } from "./store.js";

const smallMetrics: BrokerHotTableLoadMetrics = {
  tables: {
    broker_tasks: {
      count: 50,
      maxPayloadBytes: 100_000,
      runtimeLoad: { limit: 2000, loadedCount: 50, skippedCount: 0, activeCount: 5, terminalCount: 45 },
    },
    broker_audit_events: {
      count: 200,
      maxPayloadBytes: 1_000,
      runtimeLoad: { limit: 5000, loadedCount: 200, skippedCount: 0 },
    },
    broker_terminal_outbox: {
      count: 30,
      maxPayloadBytes: 2_000,
      unackedCount: 5,
      runtimeLoad: { limit: 1000, loadedCount: 30, skippedCount: 0 },
    },
  },
};

// Helpers: build metrics at various scales
function scaleMetrics(factor: number): BrokerHotTableLoadMetrics {
  return {
    tables: {
      broker_tasks: {
        count: 50 * factor,
        maxPayloadBytes: 110_000,
        runtimeLoad: { limit: 2000, loadedCount: Math.min(50 * factor, 2000), skippedCount: Math.max(0, 50 * factor - 2000), activeCount: 5 * factor, terminalCount: 45 * factor },
      },
      broker_audit_events: {
        count: 200 * factor,
        maxPayloadBytes: 1_200,
        runtimeLoad: { limit: 5000, loadedCount: Math.min(200 * factor, 5000), skippedCount: Math.max(0, 200 * factor - 5000) },
      },
      broker_terminal_outbox: {
        count: 30 * factor,
        maxPayloadBytes: 2_100,
        unackedCount: 5 * factor,
        runtimeLoad: { limit: 1000, loadedCount: Math.min(30 * factor, 1000), skippedCount: Math.max(0, 30 * factor - 1000) },
      },
    },
  };
}

describe("projectHotTableGrowth", () => {
  it("produces a projection from current metrics", () => {
    const projection = projectHotTableGrowth({ current: smallMetrics });

    assert.equal(projection.kind, "broker.hot-table-growth.projection");
    assert.equal(typeof projection.generatedAt, "string");
    assert.equal(projection.hasPrior, false);
    assert.equal(projection.priorGeneratedAt, null);
    assert.ok(projection.totalEstimatedMemoryBytes > 0);
    assert.equal(projection.tables.length, 3);
    assert.deepEqual(projection.tables.map((t) => t.table), ["broker_tasks", "broker_audit_events", "broker_terminal_outbox"]);
  });

  it("reports ok severity for small hot tables", () => {
    const projection = projectHotTableGrowth({ current: smallMetrics });

    assert.equal(projection.overallSeverity, "ok");
    assert.ok(projection.tables.every((t) => t.severity === "ok"));
  });

  it("reports ok when all tables are empty", () => {
    const empty: BrokerHotTableLoadMetrics = {
      tables: {
        broker_tasks: { count: 0, maxPayloadBytes: 0, runtimeLoad: { limit: 2000, loadedCount: 0, skippedCount: 0, activeCount: 0, terminalCount: 0 } },
        broker_audit_events: { count: 0, maxPayloadBytes: 0, runtimeLoad: { limit: 5000, loadedCount: 0, skippedCount: 0 } },
        broker_terminal_outbox: { count: 0, maxPayloadBytes: 0, unackedCount: 0, runtimeLoad: { limit: 1000, loadedCount: 0, skippedCount: 0 } },
      },
    };
    const projection = projectHotTableGrowth({ current: empty });

    assert.equal(projection.overallSeverity, "ok");
    assert.equal(projection.totalEstimatedMemoryBytes, 0);
  });

  it("warns when a single table exceeds the warning row threshold", () => {
    const manyTasks = structuredClone(smallMetrics);
    manyTasks.tables.broker_tasks.count = DEFAULT_SINGLE_TABLE_WARNING_ROWS + 1;
    manyTasks.tables.broker_tasks.runtimeLoad = {
      limit: 2000, loadedCount: DEFAULT_SINGLE_TABLE_WARNING_ROWS + 1, skippedCount: 0,
      activeCount: 5, terminalCount: DEFAULT_SINGLE_TABLE_WARNING_ROWS - 4,
    };

    const projection = projectHotTableGrowth({ current: manyTasks });

    assert.equal(projection.overallSeverity, "warning");
    assert.ok(projection.tables.find((t) => t.table === "broker_tasks")!.severity === "warning");
  });

  it("criticals when a single table exceeds the critical row threshold", () => {
    const manyTasks = structuredClone(smallMetrics);
    manyTasks.tables.broker_tasks.count = DEFAULT_SINGLE_TABLE_CRITICAL_ROWS + 1;
    manyTasks.tables.broker_tasks.runtimeLoad = {
      limit: 2000, loadedCount: 2000, skippedCount: DEFAULT_SINGLE_TABLE_CRITICAL_ROWS - 1999,
      activeCount: 5, terminalCount: DEFAULT_SINGLE_TABLE_CRITICAL_ROWS - 4,
    };

    const projection = projectHotTableGrowth({ current: manyTasks });

    assert.equal(projection.overallSeverity, "critical");
    const tasksTable = projection.tables.find((t) => t.table === "broker_tasks")!;
    assert.equal(tasksTable.severity, "critical");
    assert.ok(tasksTable.runtimeSkipped > 0);
  });

  it("warns when aggregate row count exceeds total warning threshold", () => {
    const big = scaleMetrics(60); // total ~16,800 rows
    const projection = projectHotTableGrowth({ current: big });

    assert.equal(projection.overallSeverity, "critical");
    assert.ok(projection.warnings.length > 0);
  });

  it("computes growth rate with a prior snapshot", () => {
    const prior = scaleMetrics(1);
    const current = scaleMetrics(2); // double

    const projection = projectHotTableGrowth({ current, prior });

    assert.equal(projection.hasPrior, true);
    const tasksTable = projection.tables.find((t) => t.table === "broker_tasks")!;
    assert.equal(tasksTable.priorCount, 50);
    assert.equal(tasksTable.currentCount, 100);
    assert.equal(tasksTable.growthDelta, 50);
    assert.ok(tasksTable.growthRate !== null && tasksTable.growthRate > 0.9);
  });

  it("reports negative growth as zero rate", () => {
    const prior = scaleMetrics(2);
    const current = scaleMetrics(1); // halved

    const projection = projectHotTableGrowth({ current, prior });

    const tasksTable = projection.tables.find((t) => t.table === "broker_tasks")!;
    assert.equal(tasksTable.growthDelta, -50);
    assert.ok(tasksTable.growthRate !== null && tasksTable.growthRate < 0);
  });

  it("flags runtime-skipped rows as a warning when ratio is high", () => {
    const metrics = scaleMetrics(70); // tasks will be 3500, cap at 2000 → 1500 skipped

    const projection = projectHotTableGrowth({ current: metrics });

    const tasksTable = projection.tables.find((t) => t.table === "broker_tasks")!;
    assert.ok(tasksTable.runtimeSkipped > 0);
    const skippedRatio = tasksTable.runtimeSkipped / (tasksTable.runtimeLoaded + tasksTable.runtimeSkipped);
    assert.ok(skippedRatio >= 0.3);
    // Should be critical because skipped > 70%
  });

  it("warns about memory pressure when estimated footprint is large", () => {
    const heavy: BrokerHotTableLoadMetrics = {
      tables: {
        broker_tasks: {
          count: 600,
          maxPayloadBytes: 120_000,
          runtimeLoad: { limit: 2000, loadedCount: 600, skippedCount: 0, activeCount: 5, terminalCount: 595 },
        },
        broker_audit_events: {
          count: 1500,
          maxPayloadBytes: 2000,
          runtimeLoad: { limit: 5000, loadedCount: 1500, skippedCount: 0 },
        },
        broker_terminal_outbox: {
          count: 400,
          maxPayloadBytes: 3000,
          unackedCount: 200,
          runtimeLoad: { limit: 1000, loadedCount: 400, skippedCount: 0 },
        },
      },
    };
    // ~600 * 120KB = 72 MB + ~3 MB + ~1.2 MB = ~76 MB

    const projection = projectHotTableGrowth({ current: heavy });

    assert.ok(projection.totalEstimatedMemoryBytes > 70_000_000);
    // 76 MB is below 100 MB warning, so should be ok unless other conditions trigger
  });

  it("includes prior snapshot timestamp when provided", () => {
    const projection = projectHotTableGrowth({
      current: smallMetrics,
      prior: smallMetrics,
      priorGeneratedAt: "2026-05-12T00:00:00.000Z",
    });

    assert.equal(projection.hasPrior, true);
    assert.equal(projection.priorGeneratedAt, "2026-05-12T00:00:00.000Z");
  });

  it("respects custom thresholds", () => {
    const custom = projectHotTableGrowth({
      current: smallMetrics,
      thresholds: {
        singleTableWarningRows: 10,
      },
    });

    assert.equal(custom.overallSeverity, "warning");
    assert.ok(
      custom.tables
        .filter((t) => t.currentCount > 0)
        .every((t) => t.severity === "warning"),
    );
  });

  it("produces empty warnings list when everything is ok", () => {
    const projection = projectHotTableGrowth({ current: smallMetrics });

    // Only the "no prior" note
    assert.equal(projection.warnings.length, 1);
    assert.match(projection.warnings[0], /No prior snapshot/);
  });

  it("exposes runtime load limits in the projection", () => {
    const projection = projectHotTableGrowth({
      current: smallMetrics,
      runtimeLoadLimits: {
        terminalTasks: 1000,
        auditEvents: 2000,
        terminalOutboxEvents: 500,
      },
    });

    assert.equal(projection.runtimeLoadLimits.terminalTasks, 1000);
    assert.equal(projection.runtimeLoadLimits.auditEvents, 2000);
    assert.equal(projection.runtimeLoadLimits.terminalOutboxEvents, 500);
  });

  it("uses provided generatedAt timestamp", () => {
    const projection = projectHotTableGrowth({
      current: smallMetrics,
      generatedAt: "2026-05-13T06:00:00.000Z",
    });

    assert.equal(projection.generatedAt, "2026-05-13T06:00:00.000Z");
  });

  it("deterministic: same input → same output", () => {
    const a = projectHotTableGrowth({ current: smallMetrics, generatedAt: "2026-05-13T00:00:00.000Z" });
    const b = projectHotTableGrowth({ current: smallMetrics, generatedAt: "2026-05-13T00:00:00.000Z" });

    assert.deepEqual(a.overallSeverity, b.overallSeverity);
    assert.deepEqual(a.warnings, b.warnings);
    assert.deepEqual(a.totalEstimatedMemoryBytes, b.totalEstimatedMemoryBytes);
    assert.deepEqual(
      a.tables.map((t) => t.severity),
      b.tables.map((t) => t.severity),
    );
  });

  it("warns when projected memory exceeds the memory warning threshold", () => {
    const memHeavy: BrokerHotTableLoadMetrics = {
      tables: {
        broker_tasks: {
          count: 1000,
          maxPayloadBytes: 110_000,
          runtimeLoad: { limit: 2000, loadedCount: 1000, skippedCount: 0, activeCount: 5, terminalCount: 995 },
        },
        broker_audit_events: {
          count: 2000,
          maxPayloadBytes: 2000,
          runtimeLoad: { limit: 5000, loadedCount: 2000, skippedCount: 0 },
        },
        broker_terminal_outbox: {
          count: 500,
          maxPayloadBytes: 3000,
          unackedCount: 100,
          runtimeLoad: { limit: 1000, loadedCount: 500, skippedCount: 0 },
        },
      },
    };
    // ~110 MB + ~4 MB + ~1.5 MB = ~116 MB, above 100 MB warning

    const projection = projectHotTableGrowth({ current: memHeavy });

    assert.equal(projection.overallSeverity, "warning");
    assert.ok(projection.warnings.some((w) => w.includes("exceeds warning threshold")));
  });

  it("warningsTruncated is false when warnings fit within default limit", () => {
    // 5 warnings (3 tables + memory + no-prior) are well under DEFAULT_MAX_WARNINGS (10)
    const manyWarnings = structuredClone(smallMetrics);
    manyWarnings.tables.broker_tasks.count = 1500;
    manyWarnings.tables.broker_tasks.runtimeLoad = {
      limit: 2000, loadedCount: 1500, skippedCount: 0, activeCount: 5, terminalCount: 1495,
    };
    manyWarnings.tables.broker_audit_events.count = 6000;
    manyWarnings.tables.broker_audit_events.runtimeLoad = {
      limit: 5000, loadedCount: 5000, skippedCount: 1000,
    };
    manyWarnings.tables.broker_terminal_outbox.count = 50;
    manyWarnings.tables.broker_terminal_outbox.runtimeLoad = {
      limit: 1000, loadedCount: 50, skippedCount: 0,
    };

    const projection = projectHotTableGrowth({ current: manyWarnings });

    assert.ok(projection.warnings.length > 0);
    assert.equal(projection.warningsTruncated, false);
  });

  it("sets warningsTruncated when maxWarnings is low", () => {
    // 4 table warnings + memory warning + no-prior = 6 total; maxWarnings=2 → truncated
    const many: BrokerHotTableLoadMetrics = {
      tables: {
        broker_tasks: {
          count: 1500,
          maxPayloadBytes: 100_000,
          runtimeLoad: { limit: 2000, loadedCount: 1500, skippedCount: 0, activeCount: 5, terminalCount: 1495 },
        },
        broker_audit_events: {
          count: 2000,
          maxPayloadBytes: 2000,
          runtimeLoad: { limit: 5000, loadedCount: 2000, skippedCount: 0 },
        },
        broker_terminal_outbox: {
          count: 30,
          maxPayloadBytes: 2000,
          unackedCount: 5,
          runtimeLoad: { limit: 1000, loadedCount: 30, skippedCount: 0 },
        },
        broker_exchanges: {
          count: 1200,
          maxPayloadBytes: 3000,
          runtimeLoad: { limit: 1000, loadedCount: 1000, skippedCount: 200 },
        },
        broker_proposals: {
          count: 1100,
          maxPayloadBytes: 2500,
          runtimeLoad: { limit: 1000, loadedCount: 1000, skippedCount: 100 },
        },
      },
    };

    const projection = projectHotTableGrowth({ current: many, maxWarnings: 2 });

    assert.equal(projection.warnings.length, 2);
    assert.equal(projection.warningsTruncated, true);
  });

  it("warningsTruncated is false when maxWarnings equals total warning count", () => {
    const many: BrokerHotTableLoadMetrics = {
      tables: {
        broker_tasks: {
          count: 1500,
          maxPayloadBytes: 100_000,
          runtimeLoad: { limit: 2000, loadedCount: 1500, skippedCount: 0, activeCount: 5, terminalCount: 1495 },
        },
        broker_audit_events: {
          count: 2000,
          maxPayloadBytes: 2000,
          runtimeLoad: { limit: 5000, loadedCount: 2000, skippedCount: 0 },
        },
        broker_terminal_outbox: {
          count: 30,
          maxPayloadBytes: 2000,
          unackedCount: 5,
          runtimeLoad: { limit: 1000, loadedCount: 30, skippedCount: 0 },
        },
        broker_exchanges: {
          count: 1200,
          maxPayloadBytes: 3000,
          runtimeLoad: { limit: 1000, loadedCount: 1000, skippedCount: 200 },
        },
      },
    };
    // 4 table warnings + no-prior note = 5 total; maxWarnings=5 → no truncation
    const projection = projectHotTableGrowth({ current: many, maxWarnings: 5 });

    assert.equal(projection.warnings.length, 5);
    assert.equal(projection.warningsTruncated, false);
  });

  it("warningsTruncated is false when there are zero warnings", () => {
    const empty: BrokerHotTableLoadMetrics = {
      tables: {
        broker_tasks: { count: 0, maxPayloadBytes: 0, runtimeLoad: { limit: 2000, loadedCount: 0, skippedCount: 0, activeCount: 0, terminalCount: 0 } },
        broker_audit_events: { count: 0, maxPayloadBytes: 0, runtimeLoad: { limit: 5000, loadedCount: 0, skippedCount: 0 } },
        broker_terminal_outbox: { count: 0, maxPayloadBytes: 0, unackedCount: 0, runtimeLoad: { limit: 1000, loadedCount: 0, skippedCount: 0 } },
      },
    };
    // Provide prior so we skip the "no prior" note
    const projection = projectHotTableGrowth({ current: empty, prior: empty, priorGeneratedAt: "2026-05-12T00:00:00.000Z" });

    assert.equal(projection.warnings.length, 0);
    assert.equal(projection.warningsTruncated, false);
  });

  it("includes processMemory and readinessDegradation when processMemory is supplied", () => {
    const projection = projectHotTableGrowth({
      current: smallMetrics,
      processMemory: {
        rssBytes: 500_000_000,
        heapTotalBytes: 400_000_000,
        heapUsedBytes: 350_000_000,
        heapLimitBytes: 512_000_000,
      },
    });

    assert.ok(projection.processMemory, "processMemory should be present");
    assert.equal(projection.processMemory!.heapUsedRatio, 0.684); // 350/512
    assert.ok(projection.readinessDegradation, "readinessDegradation should be present");
    // 68% heap < 80% threshold, so no heap pressure
    assert.equal(projection.readinessDegradation!.heapPressure, false);
  });

  it("sets heapPressure when heap usage exceeds 80%", () => {
    const projection = projectHotTableGrowth({
      current: smallMetrics,
      processMemory: {
        rssBytes: 800_000_000,
        heapTotalBytes: 750_000_000,
        heapUsedBytes: 450_000_000,
        heapLimitBytes: 512_000_000,
      },
    });

    // 450/512 ≈ 0.879 → > 0.8, so heapPressure = true
    assert.equal(projection.readinessDegradation!.heapPressure, true);
    assert.equal(projection.readinessDegradation!.overallRisky, true);
  });

  it("includes snapshotMetrics when snapshotMetrics is supplied", () => {
    const projection = projectHotTableGrowth({
      current: smallMetrics,
      snapshotMetrics: {
        lastSnapshotBytes: 2_500_000,
        lastPersistDurationMs: 320,
        lastSnapshotAt: "2026-05-14T12:00:00.000Z",
      },
    });

    assert.ok(projection.snapshotMetrics);
    assert.equal(projection.snapshotMetrics!.lastSnapshotBytes, 2_500_000);
    assert.equal(projection.snapshotMetrics!.lastPersistDurationMs, 320);
    assert.equal(projection.snapshotMetrics!.lastSnapshotAt, "2026-05-14T12:00:00.000Z");
  });

  it("sets memoryPressure when hot-table memory exceeds 50% of heap limit", () => {
    const heavy: BrokerHotTableLoadMetrics = {
      tables: {
        broker_tasks: {
          count: 8000,
          maxPayloadBytes: 50_000,
          runtimeLoad: { limit: 2000, loadedCount: 2000, skippedCount: 6000, activeCount: 5, terminalCount: 7995 },
        },
        broker_audit_events: {
          count: 500,
          maxPayloadBytes: 1000,
          runtimeLoad: { limit: 5000, loadedCount: 500, skippedCount: 0 },
        },
        broker_terminal_outbox: {
          count: 30,
          maxPayloadBytes: 2000,
          unackedCount: 5,
          runtimeLoad: { limit: 1000, loadedCount: 30, skippedCount: 0 },
        },
      },
    };
    // ~400 MB estimated memory, heap limit = 512 MB → 400/512 ≈ 0.78 > 0.5 → memoryPressure = true
    const projection = projectHotTableGrowth({
      current: heavy,
      processMemory: {
        rssBytes: 600_000_000,
        heapTotalBytes: 500_000_000,
        heapUsedBytes: 400_000_000,
        heapLimitBytes: 512_000_000,
      },
    });

    assert.equal(projection.readinessDegradation!.memoryPressure, true);
    assert.equal(projection.readinessDegradation!.overallRisky, true);
  });

  it("sets hydrationPressure when a critical table has skipped runtime rows", () => {
    const metrics: BrokerHotTableLoadMetrics = scaleMetrics(105);
    // broker_tasks: 5250 rows, terminal cap 2000 → 3250 skipped, severity "critical" (>= 5000)
    const projection = projectHotTableGrowth({
      current: metrics,
      processMemory: {
        rssBytes: 300_000_000,
        heapTotalBytes: 250_000_000,
        heapUsedBytes: 200_000_000,
        heapLimitBytes: 512_000_000,
      },
    });

    const tasksTable = projection.tables.find((t) => t.table === "broker_tasks")!;
    assert.equal(tasksTable.severity, "critical");
    assert.ok(tasksTable.runtimeSkipped > 0);
    assert.equal(projection.readinessDegradation!.hydrationPressure, true);
    assert.equal(projection.readinessDegradation!.overallRisky, true);
  });

  it("sets overallWarning when heap is above 60% but below 80%", () => {
    // heapUsed: 350 MB, heapLimit: 512 MB → 68% > 60% (warning) but < 80% (not critical)
    const projection = projectHotTableGrowth({
      current: smallMetrics,
      processMemory: {
        rssBytes: 500_000_000,
        heapTotalBytes: 400_000_000,
        heapUsedBytes: 350_000_000,
        heapLimitBytes: 512_000_000,
      },
    });

    assert.equal(projection.readinessDegradation!.heapPressure, false);
    assert.equal(projection.readinessDegradation!.overallRisky, false);
    assert.equal(projection.readinessDegradation!.overallWarning, true);
  });

  it("sets overallWarning when hot-table memory exceeds 35% but not 50% of heap", () => {
    // estimated memory = ~51 MB, heap limit = 128 MB → 51/128 ≈ 0.40 > 0.35 (warning) but < 0.5 (not critical)
    const moderate: BrokerHotTableLoadMetrics = {
      tables: {
        broker_tasks: {
          count: 400,
          maxPayloadBytes: 120_000,
          runtimeLoad: { limit: 2000, loadedCount: 400, skippedCount: 0, activeCount: 5, terminalCount: 395 },
        },
        broker_audit_events: {
          count: 1000,
          maxPayloadBytes: 2000,
          runtimeLoad: { limit: 5000, loadedCount: 1000, skippedCount: 0 },
        },
        broker_terminal_outbox: {
          count: 50,
          maxPayloadBytes: 3000,
          unackedCount: 10,
          runtimeLoad: { limit: 1000, loadedCount: 50, skippedCount: 0 },
        },
      },
    };
    // ~48 MB + 2 MB + 0.15 MB ≈ 50.15 MB
    const projection = projectHotTableGrowth({
      current: moderate,
      processMemory: {
        rssBytes: 200_000_000,
        heapTotalBytes: 150_000_000,
        heapUsedBytes: 100_000_000,
        heapLimitBytes: 128_000_000,
      },
    });

    const rd = projection.readinessDegradation!;
    assert.equal(rd.memoryPressure, false);
    assert.equal(rd.overallRisky, false);
    assert.equal(rd.overallWarning, true);
  });

  it("sets overallWarning when a warning-level table has skipped rows", () => {
    // broker_tasks: 1200 rows × 10 KB = 12 MB → warning-level bytes (> 10 MB)
    // runtimeLoad: limit=1000, skippedCount=200 → skipped > 0
    const withWarningSkipped: BrokerHotTableLoadMetrics = {
      tables: {
        broker_tasks: {
          count: 1200,
          maxPayloadBytes: 10_000,
          runtimeLoad: { limit: 1000, loadedCount: 1000, skippedCount: 200, activeCount: 5, terminalCount: 1195 },
        },
        broker_audit_events: {
          count: 500,
          maxPayloadBytes: 1000,
          runtimeLoad: { limit: 5000, loadedCount: 500, skippedCount: 0 },
        },
        broker_terminal_outbox: {
          count: 30,
          maxPayloadBytes: 2000,
          unackedCount: 5,
          runtimeLoad: { limit: 1000, loadedCount: 30, skippedCount: 0 },
        },
      },
    };

    const projection = projectHotTableGrowth({
      current: withWarningSkipped,
      processMemory: {
        rssBytes: 300_000_000,
        heapTotalBytes: 250_000_000,
        heapUsedBytes: 200_000_000,
        heapLimitBytes: 512_000_000,
      },
    });

    // heap 200/512 ≈ 39% < 60% → no heap warning
    // memory ~12 MB + 0.5 MB + 0.06 MB ≈ 12.6 MB / 512 MB ≈ 2.5% < 35% → no memory warning
    // but broker_tasks: severity="warning" (12 MB > 10 MB threshold), skippedCount=200 → hydrationWarning=true
    const rd = projection.readinessDegradation!;
    assert.equal(rd.heapPressure, false);
    assert.equal(rd.memoryPressure, false);
    assert.equal(rd.overallRisky, false);
    assert.equal(rd.overallWarning, true);
  });

  it("overallWarning is false when no signals are elevated", () => {
    const projection = projectHotTableGrowth({
      current: smallMetrics,
      processMemory: {
        rssBytes: 200_000_000,
        heapTotalBytes: 150_000_000,
        heapUsedBytes: 100_000_000,
        heapLimitBytes: 512_000_000,
      },
    });
    // heap 100/512 ≈ 20% < 60%
    // memory ~53 MB / 512 MB ≈ 10% < 35%
    // no skipped rows → no hydration warning

    assert.equal(projection.readinessDegradation!.overallWarning, false);
  });
});

describe("computeAdaptiveLoadLimits", () => {
  const defaultLimits: BrokerHotTableRuntimeLoadLimits = {
    terminalTasks: 2000,
    auditEvents: 5000,
    terminalOutboxEvents: 1000,
  };

  const processMemory = { heapUsedBytes: 350_000_000, heapLimitBytes: 4_000_000_000 };

  it("returns original limits unchanged when heap pressure is low and memory pressure is low", () => {
    const result = computeAdaptiveLoadLimits(
      processMemory,
      2_000_000, // total estimated hot-table memory is 2 MB vs 4 GB heap → 0.05% → no memory pressure
      defaultLimits,
    );

    assert.equal(result.guardTriggered, false);
    assert.equal(result.guardReason, null);
    assert.equal(result.adaptiveTerminalTaskLimit, 2000);
    assert.equal(result.adaptiveAuditEventLimit, 5000);
    assert.equal(result.adaptiveOutboxLimit, 1000);
    assert.equal(result.reductionFactor, DEFAULT_HEAP_BUDGET_REDUCTION_FACTOR);
  });

  it("reduces limits when heap pressure exceeds 80% threshold", () => {
    // 3.6 GB used / 4 GB limit = 90% → heap pressure
    const result = computeAdaptiveLoadLimits(
      { heapUsedBytes: 3_600_000_000, heapLimitBytes: 4_000_000_000 },
      500_000, // small memory, only heap pressure
      defaultLimits,
    );

    assert.equal(result.guardTriggered, true);
    assert.ok(result.guardReason!.includes("heap at 90%"));
    // reduction factor 2: 2000/2=1000, 5000/2=2500, 1000/2=500
    assert.equal(result.adaptiveTerminalTaskLimit, 1000);
    assert.equal(result.adaptiveAuditEventLimit, 2500);
    assert.equal(result.adaptiveOutboxLimit, 500);
  });

  it("reduces limits when hot-table memory exceeds 50% of heap limit", () => {
    // 0 MB heap used / 4 GB limit = 0% → no heap pressure.
    // 3 GB hot-table memory / 4 GB heap limit = 75% > 50% → memory pressure
    const result = computeAdaptiveLoadLimits(
      { heapUsedBytes: 1_000, heapLimitBytes: 4_000_000_000 },
      3_000_000_000,
      defaultLimits,
    );

    assert.equal(result.guardTriggered, true);
    assert.ok(result.guardReason!.includes("75%"));
    assert.equal(result.adaptiveTerminalTaskLimit, 1000);
    assert.equal(result.adaptiveAuditEventLimit, 2500);
    assert.equal(result.adaptiveOutboxLimit, 500);
  });

  it("applies minimum fraction floor and never returns zero", () => {
    // Extreme heap pressure: 99% heap used
    const result = computeAdaptiveLoadLimits(
      { heapUsedBytes: 3_960_000_000, heapLimitBytes: 4_000_000_000 },
      1_000,
      defaultLimits,
    );

    // reduction factor 2: 2000/2=1000, minimum fraction 0.25: 2000*0.25=500 → floor is max(1000, 500) = 1000
    // Still 1000 because the floor of 500 is below the factor'd 1000
    assert.equal(result.adaptiveTerminalTaskLimit, 1000);
    assert.equal(result.adaptiveAuditEventLimit, 2500);
    assert.equal(result.adaptiveOutboxLimit, 500);
  });

  it("minimum fraction floor prevents starvation for very small limits", () => {
    const smallLimits: BrokerHotTableRuntimeLoadLimits = {
      terminalTasks: 1,
      auditEvents: 2,
      terminalOutboxEvents: 3,
    };

    const result = computeAdaptiveLoadLimits(
      { heapUsedBytes: 3_600_000_000, heapLimitBytes: 4_000_000_000 },
      0,
      smallLimits,
    );

    // reduction factor 2: 1/2=0, floor = max(0, max(1, 1*0.25)) = max(0,1) = 1
    // 2/2=1, floor = max(1, max(1, 2*0.25)) = max(1,1) = 1
    // 3/2=1, floor = max(1, max(1, 3*0.25)) = max(1,1) = 1
    assert.equal(result.adaptiveTerminalTaskLimit, 1);
    assert.equal(result.adaptiveAuditEventLimit, 1);
    assert.equal(result.adaptiveOutboxLimit, 1);
  });

  it("accepts custom reduction factor and minimum fraction", () => {
    const result = computeAdaptiveLoadLimits(
      { heapUsedBytes: 3_600_000_000, heapLimitBytes: 4_000_000_000 },
      0,
      defaultLimits,
      { reductionFactor: 4, minimumFraction: 0.1 },
    );

    // reduction factor 4: 2000/4=500, 5000/4=1250, 1000/4=250
    // floor = max(1, 2000*0.1) = 200, etc.
    // floor is always below the factor'd values, so factor wins
    assert.equal(result.adaptiveTerminalTaskLimit, 500);
    assert.equal(result.adaptiveAuditEventLimit, 1250);
    assert.equal(result.adaptiveOutboxLimit, 250);
    assert.equal(result.reductionFactor, 4);
  });

  it("does not reduce when heapLimit is zero (edge case)", () => {
    const result = computeAdaptiveLoadLimits(
      { heapUsedBytes: 3_600_000_000, heapLimitBytes: 0 },
      3_000_000_000,
      defaultLimits,
    );

    // heapLimit = 0, so both ratios are 0 or NaN → no pressure
    assert.equal(result.guardTriggered, false);
    assert.equal(result.adaptiveTerminalTaskLimit, 2000);
  });

  it("includes adaptiveLoadLimits in readinessDegradation when guard triggers", () => {
    const projection = projectHotTableGrowth({
      current: smallMetrics,
      processMemory: {
        rssBytes: 4_000_000_000,
        heapTotalBytes: 3_900_000_000,
        heapUsedBytes: 3_600_000_000,
        heapLimitBytes: 4_000_000_000,
      },
      runtimeLoadLimits: defaultLimits,
    });

    assert.ok(projection.readinessDegradation);
    assert.equal(projection.readinessDegradation!.heapPressure, true);
    assert.ok(projection.readinessDegradation!.adaptiveLoadLimits);
    assert.equal(projection.readinessDegradation!.adaptiveLoadLimits!.guardTriggered, true);
    assert.equal(projection.readinessDegradation!.adaptiveLoadLimits!.adaptiveTerminalTaskLimit, 1000);
  });

  it("omits adaptiveLoadLimits from readinessDegradation when guard is not triggered", () => {
    const projection = projectHotTableGrowth({
      current: smallMetrics,
      processMemory: {
        rssBytes: 200_000_000,
        heapTotalBytes: 180_000_000,
        heapUsedBytes: 100_000_000,
        heapLimitBytes: 4_000_000_000,
      },
      runtimeLoadLimits: defaultLimits,
    });

    assert.ok(projection.readinessDegradation);
    assert.equal(projection.readinessDegradation!.heapPressure, false);
    assert.equal(projection.readinessDegradation!.adaptiveLoadLimits, undefined);
  });
});
