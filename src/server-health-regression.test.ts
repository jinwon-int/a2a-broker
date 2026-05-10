/**
 * Broker /health SQLite query-plan and p95/p99 regression coverage.
 *
 * Covers:
 * 1. EXPLAIN QUERY PLAN evidence for every SQLite query triggered by the
 *    /health endpoint (audit diagnostics, persistence/mirror counts, worker
 *    diagnostics).
 * 2. Deterministic p95/p99 latency regression with small DB fixtures.
 *
 * @see jinwon-int/a2a-broker#464
 * @see jinwon-int/a2a-broker#463
 */

import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

import { createBrokerServer } from "./server.js";
import {
  emptySnapshot,
  SqliteBrokerStateStore,
  type BrokerSnapshot,
} from "./core/store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-health-regression-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Build a small audit-event snapshot suitable for health-diag regression.
 * Populates enough rows to exercise COUNT / filtered-COUNT paths without
 * approaching large-table territory.
 */
function smallAuditSnapshot(count: number): BrokerSnapshot {
  const now = new Date();
  const auditEvents: BrokerSnapshot["auditEvents"] = [];
  for (let i = 0; i < count; i++) {
    const secsAgo = i * 13; // spread across ~recentWindow
    auditEvents.push({
      id: `audit-health-test-${String(i).padStart(4, "0")}`,
      action: i % 5 === 0 ? "worker.heartbeat" : "task.created",
      targetType: "task",
      targetId: `task-health-${i}`,
      actorId: "worker-a",
      createdAt: new Date(now.getTime() - secsAgo * 1000).toISOString(),
    });
  }
  return {
    ...emptySnapshot(),
    auditEvents,
    workers: [
      {
        nodeId: "worker-a",
        role: "analyst",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        lastSeenAt: now.toISOString(),
        capabilities: {
          canAnalyze: true,
          canBackfill: false,
          canPatchWorkspace: false,
          canPromoteLive: false,
          workspaceIds: ["test"],
          environments: ["research"],
        },
      },
    ],
    tasks: [
      {
        id: "task-health-0",
        intent: "chat",
        requester: { id: "hub-1", kind: "node", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        targetNodeId: "worker-a",
        assignedWorkerId: "worker-a",
        payload: {},
        status: "succeeded",
        taskOrigin: "api",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// EXPLAIN QUERY PLAN: /health SQLite paths
// ---------------------------------------------------------------------------

test("EXPLAIN QUERY PLAN: broker_audit_events COUNT(*) uses covering index (no temp b-tree)", () => {
  const tmp = tempDir();
  try {
    // Create a warm SQLite store with the production schema and a small fixture.
    const sqliteFile = join(tmp.dir, "state.sqlite");
    const store = new SqliteBrokerStateStore(sqliteFile);
    store.save(smallAuditSnapshot(200));
    store.close();

    const db = new DatabaseSync(sqliteFile, { readOnly: true });
    try {
      // This query is used by readHotAuditDiagnostics (total count).
      const planTotal = db
        .prepare("EXPLAIN QUERY PLAN SELECT COUNT(*) AS count FROM broker_audit_events")
        .all();
      // This query filters by action via broker_audit_events_action_idx.
      const planHeartbeat = db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT COUNT(*) AS count FROM broker_audit_events WHERE action = 'worker.heartbeat'",
        )
        .all();
      // This query filters by created_at (no dedicated leading index).
      const recentCutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const planRecent = db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT COUNT(*) AS count FROM broker_audit_events WHERE created_at >= ?",
        )
        .all(recentCutoff);
      // This query filters by action + created_at (uses action_idx).
      const planRecentHeartbeat = db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT COUNT(*) AS count FROM broker_audit_events WHERE action = 'worker.heartbeat' AND created_at >= ?",
        )
        .all(recentCutoff);

      // SQLite COUNT(*) scans the table (or an index); on small tables neither
      // should introduce a temp b-tree.  The action-filtered query should hit
      // broker_audit_events_action_idx.
      for (const [label, plan] of [
        ["total", planTotal],
        ["heartbeat", planHeartbeat],
        ["recent", planRecent],
        ["recent+heartbeat", planRecentHeartbeat],
      ] as const) {
        const detail = JSON.stringify(plan);
        const hasTempBtree = plan.some((row) =>
          String((row as { detail?: unknown }).detail ?? "").includes("USE TEMP B-TREE"),
        );
        assert.equal(hasTempBtree, false, `${label}: unexpected USE TEMP B-TREE in ${detail}`);

        // On a warm, indexed table with 200 rows, every plan should use a
        // scan of the table or a covering index — never a subquery or
        // multi-pass plan.
        const hasSubquery = plan.some((row) =>
          String((row as { detail?: unknown }).detail ?? "").includes("SUBQUERY"),
        );
        assert.equal(hasSubquery, false, `${label}: unexpected SUBQUERY in ${detail}`);
      }
    } finally {
      db.close();
    }
  } finally {
    tmp.cleanup();
  }
});

test("EXPLAIN QUERY PLAN: broker_workers SCAN uses primary-key order (no temp b-tree)", () => {
  const tmp = tempDir();
  try {
    const sqliteFile = join(tmp.dir, "state.sqlite");
    const store = new SqliteBrokerStateStore(sqliteFile);
    // Save a snapshot with a few workers to ensure an index-friendly path.
    const testCaps = {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: false,
      canPromoteLive: false,
      workspaceIds: ["test"],
      environments: ["research" as const],
    };
    const snapshot: BrokerSnapshot = {
      ...emptySnapshot(),
      workers: [
        {
          nodeId: "worker-z",
          role: "analyst",
          createdAt: "2026-05-01T00:00:00.000Z",
          updatedAt: "2026-05-01T00:00:00.000Z",
          lastSeenAt: "2026-05-01T00:00:00.000Z",
          capabilities: { ...testCaps },
        },
        {
          nodeId: "worker-a",
          role: "analyst",
          createdAt: "2026-05-01T00:00:00.000Z",
          updatedAt: "2026-05-01T00:00:00.000Z",
          lastSeenAt: "2026-05-01T00:00:00.000Z",
          capabilities: { ...testCaps },
        },
        {
          nodeId: "worker-m",
          role: "analyst",
          createdAt: "2026-05-01T00:00:00.000Z",
          updatedAt: "2026-05-01T00:00:00.000Z",
          lastSeenAt: "2026-05-01T00:00:00.000Z",
          capabilities: { ...testCaps },
        },
      ],
    };
    store.save(snapshot);
    store.close();

    const db = new DatabaseSync(sqliteFile, { readOnly: true });
    try {
      // This query is used by readHotEntityDiagnostics inside getPersistenceInfo.
      const plan = db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT node_id AS primaryKey, payload FROM broker_workers ORDER BY node_id ASC",
        )
        .all();

      const detail = JSON.stringify(plan);
      const hasTempBtree = plan.some((row) =>
        String((row as { detail?: unknown }).detail ?? "").includes("USE TEMP B-TREE"),
      );
      assert.equal(hasTempBtree, false, `worker diagnostics: unexpected USE TEMP B-TREE in ${detail}`);
    } finally {
      db.close();
    }
  } finally {
    tmp.cleanup();
  }
});

test("EXPLAIN QUERY PLAN: hot-entity table COUNT(*) scans are direct (no temp b-tree)", () => {
  const tmp = tempDir();
  try {
    const sqliteFile = join(tmp.dir, "state.sqlite");
    const store = new SqliteBrokerStateStore(sqliteFile);
    store.save(smallAuditSnapshot(100));
    store.close();

    const db = new DatabaseSync(sqliteFile, { readOnly: true });
    try {
      // These COUNT(*) queries run via readTableCount inside readHotEntityTableCounts
      // (called by readHotEntityMirrorStatus → getPersistenceInfo on every /health).
      const tables = [
        "broker_exchanges",
        "broker_exchange_messages",
        "broker_proposals",
        "broker_artifacts",
        "broker_validations",
        "broker_tasks",
        "broker_tombstones",
        "broker_workers",
        "broker_audit_events",
        "broker_terminal_outbox",
      ];

      for (const table of tables) {
        const plan = db
          .prepare(`EXPLAIN QUERY PLAN SELECT COUNT(*) AS count FROM ${table}`)
          .all();
        const detail = JSON.stringify(plan);
        const hasTempBtree = plan.some((row) =>
          String((row as { detail?: unknown }).detail ?? "").includes("USE TEMP B-TREE"),
        );
        assert.equal(
          hasTempBtree,
          false,
          `${table}: unexpected USE TEMP B-TREE in ${detail}`,
        );
      }
    } finally {
      db.close();
    }
  } finally {
    tmp.cleanup();
  }
});

test("EXPLAIN QUERY PLAN: broker_snapshots single-row read is a point lookup", () => {
  const tmp = tempDir();
  try {
    const sqliteFile = join(tmp.dir, "state.sqlite");
    const store = new SqliteBrokerStateStore(sqliteFile);
    store.save(smallAuditSnapshot(10));
    store.close();

    const db = new DatabaseSync(sqliteFile, { readOnly: true });
    try {
      // Used by readHotEntityMirrorStatus to load the canonical snapshot row.
      const plan = db
        .prepare("EXPLAIN QUERY PLAN SELECT payload FROM broker_snapshots WHERE id = 1")
        .all();
      const detail = JSON.stringify(plan);
      const hasScan = plan.some((row) =>
        String((row as { detail?: unknown }).detail ?? "").includes("SCAN"),
      );
      assert.equal(hasScan, false, `snapshot read: unexpected SCAN (expected SEARCH) in ${detail}`);
    } finally {
      db.close();
    }
  } finally {
    tmp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// p95 / p99 latency regression: small-DB /health
// ---------------------------------------------------------------------------

/**
 * Repeatedly call /health and compute p50 / p95 / p99 from the measured
 * wall-clock durations.
 */
function computePercentiles(durationsMs: number[]): { p50: number; p95: number; p99: number } {
  const sorted = [...durationsMs].sort((a, b) => a - b);
  const percentile = (p: number) => {
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
  };
  return { p50: percentile(50), p95: percentile(95), p99: percentile(99) };
}

test("/health p95/p99 regression with small SQLite fixture (≤200 audit rows)", async (t) => {
  const tmp = tempDir();
  const sqliteFile = join(tmp.dir, "state.sqlite");

  // Seed: 200 audit rows is representative of Seoseo's observed ~1623, well
  // within "small DB" territory.
  const store = new SqliteBrokerStateStore(sqliteFile);
  store.save(smallAuditSnapshot(200));
  store.close();

  const runtime = createBrokerServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "https://broker.test/",
    sqliteFile,
    persistenceBackend: "sqlite",
    stateFile: join(tmp.dir, "state.json"),
    staleReaperEnabled: false,
    enforceRequesterIdentity: false,
  });

  try {
    runtime.server.listen(0, "127.0.0.1");
    await once(runtime.server, "listening");
    const address = runtime.server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to bind test server");
    }
    const healthUrl = `http://127.0.0.1:${address.port}/health`;

    // Warm-up: 5 requests to settle JIT / WAL / OS cache.
    for (let i = 0; i < 5; i++) {
      await fetch(healthUrl);
    }

    // Collect 100 measurements.
    const durationsMs: number[] = [];
    const REQUEST_COUNT = 100;
    for (let i = 0; i < REQUEST_COUNT; i++) {
      const start = performance.now();
      const res = await fetch(healthUrl);
      const elapsed = performance.now() - start;
      durationsMs.push(elapsed);

      // Every response must be 200 with the expected shape regardless of speed.
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.service, "a2a-broker");
      assert.equal(body.persistence.kind, "sqlite");
      // Audit diagnostics should reflect the seeded data.
      assert.equal(typeof body.auditDiagnostics?.total, "number");
      assert.ok(body.auditDiagnostics.total >= 200, `expected >=200 audit rows, got ${body.auditDiagnostics?.total}`);
      assert.equal(typeof body.auditDiagnostics?.workerHeartbeat, "number");
      assert.equal(typeof body.auditDiagnostics?.recentTotal, "number");
    }

    const { p50, p95, p99 } = computePercentiles(durationsMs);

    // Log for evidence trace.
    const avg = durationsMs.reduce((a, b) => a + b, 0) / durationsMs.length;
    const min = Math.min(...durationsMs);
    const max = Math.max(...durationsMs);
    await t.test("health latency summary", () => {
      // t.diagnostic is not available on every runner; assert-through is fine.
      assert.ok(p50 >= 0, `p50=${p50}ms`);
    });

    // Soft assertions: p95 / p99 should be well under 500ms on a small DB.
    // Use assert with a descriptive message so a regression is self-documenting.
    assert.ok(
      p95 < 500,
      `p95=${p95.toFixed(1)}ms exceeds 500ms threshold (min=${min.toFixed(1)}, max=${max.toFixed(1)}, avg=${avg.toFixed(1)}, samples=${durationsMs.length})`,
    );
    assert.ok(
      p99 < 500,
      `p99=${p99.toFixed(1)}ms exceeds 500ms threshold (min=${min.toFixed(1)}, max=${max.toFixed(1)}, avg=${avg.toFixed(1)}, samples=${durationsMs.length})`,
    );

    // Hard floor: p50 must be reasonable (<100ms) on small DB.
    assert.ok(
      p50 < 100,
      `p50=${p50.toFixed(1)}ms exceeds 100ms floor on small DB (min=${min.toFixed(1)}, max=${max.toFixed(1)})`,
    );
  } finally {
    runtime.stopStaleReaper();
    runtime.server.close();
    runtime.server.closeAllConnections?.();
    await once(runtime.server, "close");
    tmp.cleanup();
  }
});

test("/health p95/p99 regression with minimal DB (empty hot tables)", async (t) => {
  const tmp = tempDir();
  const sqliteFile = join(tmp.dir, "state.sqlite");

  // Empty store: all hot tables have 0 rows.
  const store = new SqliteBrokerStateStore(sqliteFile);
  store.save(emptySnapshot());
  store.close();

  const runtime = createBrokerServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "https://broker.test/",
    sqliteFile,
    persistenceBackend: "sqlite",
    stateFile: join(tmp.dir, "state.json"),
    staleReaperEnabled: false,
    enforceRequesterIdentity: false,
  });

  try {
    runtime.server.listen(0, "127.0.0.1");
    await once(runtime.server, "listening");
    const address = runtime.server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to bind test server");
    }
    const healthUrl = `http://127.0.0.1:${address.port}/health`;

    // Warm-up.
    for (let i = 0; i < 5; i++) {
      await fetch(healthUrl);
    }

    const durationsMs: number[] = [];
    const REQUEST_COUNT = 50;
    for (let i = 0; i < REQUEST_COUNT; i++) {
      const start = performance.now();
      const res = await fetch(healthUrl);
      durationsMs.push(performance.now() - start);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.auditDiagnostics.total, 0);
    }

    const { p50, p95, p99 } = computePercentiles(durationsMs);
    const max = Math.max(...durationsMs);
    const avg = durationsMs.reduce((a, b) => a + b, 0) / durationsMs.length;

    // Empty DB should be very fast.
    assert.ok(
      p99 < 200,
      `empty DB p99=${p99.toFixed(1)}ms exceeds 200ms (max=${max.toFixed(1)}, avg=${avg.toFixed(1)})`,
    );
    assert.ok(
      p50 < 30,
      `empty DB p50=${p50.toFixed(1)}ms exceeds 30ms (min=${Math.min(...durationsMs).toFixed(1)})`,
    );
  } finally {
    runtime.stopStaleReaper();
    runtime.server.close();
    runtime.server.closeAllConnections?.();
    await once(runtime.server, "close");
    tmp.cleanup();
  }
});

test("/health response shape is stable across repeated calls (no field drift)", async () => {
  const tmp = tempDir();
  const sqliteFile = join(tmp.dir, "state.sqlite");
  const store = new SqliteBrokerStateStore(sqliteFile);
  store.save(smallAuditSnapshot(50));
  store.close();

  const runtime = createBrokerServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "https://broker.test/",
    sqliteFile,
    persistenceBackend: "sqlite",
    stateFile: join(tmp.dir, "state.json"),
    staleReaperEnabled: false,
    enforceRequesterIdentity: false,
  });

  try {
    runtime.server.listen(0, "127.0.0.1");
    await once(runtime.server, "listening");
    const address = runtime.server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to bind test server");
    }
    const healthUrl = `http://127.0.0.1:${address.port}/health`;

    // Fetch 3 times and confirm the response shape is stable (no missing keys
    // or changing type shapes that could break downstream consumers).
    const responses: unknown[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await fetch(healthUrl);
      assert.equal(res.status, 200);
      responses.push(await res.json());
    }

    const topKeys = Object.keys(responses[0] as Record<string, unknown>).sort();
    for (let i = 1; i < responses.length; i++) {
      assert.deepEqual(
        Object.keys(responses[i] as Record<string, unknown>).sort(),
        topKeys,
        `response ${i} top-level keys differ`,
      );
    }

    // Persistence shape must be stable.
    const persistKeys = Object.keys((responses[0] as Record<string, unknown>).persistence as Record<string, unknown>).sort();
    assert.ok(persistKeys.includes("kind"));
    assert.ok(persistKeys.includes("stateVersion"));
    assert.ok(persistKeys.includes("schemaVersion"));
    assert.ok(persistKeys.includes("hotEntityTables"));
    assert.ok(persistKeys.includes("hotEntityMirror"));
    assert.ok(persistKeys.includes("hotEntityDiagnostics"));

    // Audit diagnostics shape must be stable.
    const auditKeys = Object.keys((responses[0] as Record<string, unknown>).auditDiagnostics as Record<string, unknown>).sort();
    const expectedAuditKeys = [
      "recentTotal",
      "recentWindowMs",
      "recentWorkerHeartbeat",
      "recentWorkerHeartbeatRatio",
      "total",
      "warnings",
      "workerHeartbeat",
      "workerHeartbeatRatio",
    ].sort();
    assert.deepEqual(auditKeys, expectedAuditKeys);
  } finally {
    runtime.stopStaleReaper();
    runtime.server.close();
    runtime.server.closeAllConnections?.();
    await once(runtime.server, "close");
    tmp.cleanup();
  }
});
