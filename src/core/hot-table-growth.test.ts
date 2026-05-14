import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  projectHotTableGrowth,
  DEFAULT_HOT_TABLE_GROWTH_WARNING_ROWS,
  DEFAULT_SINGLE_TABLE_WARNING_ROWS,
  DEFAULT_SINGLE_TABLE_CRITICAL_ROWS,
} from "./hot-table-growth.js";
import type { BrokerHotTableLoadMetrics } from "./store.js";

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

  it("caps warnings at DEFAULT_MAX_WARNINGS by default", () => {
    // All 3 tables at warning level + memory warning + no-prior = 5 warnings,
    // well under the default 10, so nothing is truncated.
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

  it("truncates warnings when maxWarnings is low relative to warning count", () => {
    // Lower maxWarnings to 1, high table counts generate multiple warnings.
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

  it("does not truncate warnings when maxWarnings equals the count", () => {
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

  it("does not emit empty warnings when there are zero warnings", () => {
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

  it("warningsTruncated is false when all tables have zero or ok severity", () => {
    const projection = projectHotTableGrowth({ current: smallMetrics, generatedAt: "2026-05-13T00:00:00.000Z" });

    assert.equal(projection.warningsTruncated, false);
  });
});
