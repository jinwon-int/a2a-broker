# Broker Hot-Table Health: RCA and Mitigation Guide

**Issue:** [#497](https://github.com/jinwon-int/a2a-broker/issues/497)  
**Date:** 2026-05-12  
**Author:** bangtong (Team1)

## 1. Root Cause Analysis

### 1.1 Architecture

The SQLite broker persistence layer supports two load modes via `SqliteBrokerStateStore`:

- **`loadSource: "snapshot"`** — Reads a single canonical snapshot row from `broker_snapshots` (one JSON blob), then hydrates hot entity tables from it. The snapshot JSON is the single large in-memory object.

- **`loadSource: "hot-tables"`** — Reconstructs the runtime `BrokerSnapshot` from SQLite hot entity tables. Current code hydrates active tasks plus a capped window of terminal tasks, audit rows, and terminal outbox rows; the full rows remain queryable from SQLite hot-table read APIs.

### 1.2 Memory Pressure Vector

Historically, the `readHotRuntimeSnapshot()` method (in `src/core/store.ts`) performed unbounded `SELECT payload FROM ...` queries across the hot tables. The current runtime load path keeps active state hydrated and caps the largest historical streams:

| Table | Observed Count (seoseo) | Approx. per-row payload |
|---|---|---|
| `broker_tasks` | 660 | 100–120 KB |
| `broker_audit_events` | 1,986 | ~1 KB |
| `broker_terminal_outbox` | 389 | ~2 KB |
| `broker_tombstones` | 177 | ~1 KB |
| `broker_workers` | 21 | ~1 KB |
| `broker_exchanges` | 15 | ~2 KB |
| `broker_exchange_messages` | 31 | ~2 KB |
| `broker_proposals` | 13 | ~3 KB |
| `broker_artifacts` | 0 | — |
| `broker_validations` | 0 | — |

**Estimated pre-cap in-memory snapshot:** 660 × 110 KB ≈ **72 MB** for tasks alone, plus audit events (~2 MB), outbox (~0.8 MB), etc. Total: ~75 MB for the hot-table loaded snapshot. Runtime caps now expose how many rows hydrate vs. remain SQLite-only so operators can see when historical rows are intentionally skipped from live heap.

This is not inherently fatal, but:

1. **Every broker save** calls `writeHotEntityTables()` which writes ALL hot entities, then on the next load path, re-reads everything. This creates a sawtooth memory pattern.

2. **The canonical snapshot JSON** is also loaded by `readHotEntityMirrorStatus()` for diffing — duplicating the in-memory representation.

3. **Node.js heap OOM** was observed at ~3.5 GB (of 22.9 GB total). The broker itself loads ~75 MB, but GC pressure from repeated hot-table materialization, combined with:
   - Co-located OpenClaw Gateway memory
   - SQLite WAL accumulation (44 MB WAL file)
   - Retained request/worker state
   
   ...pushes the heap toward the default ~4 GB limit.

### 1.3 Health Latency Contributors

The `/health` endpoint (in `src/server.ts`) calls:

1. `stateStore.getPersistenceInfo()` → `readHotEntityMirrorStatus()` — loads full snapshot, diffs against all 10 tables (**O(n) in snapshot size**)
2. `readHotAuditDiagnostics()` — runs 3 COUNT queries + ratio computation
3. `readHotEntityDiagnostics()` — scans `broker_workers` for invalid rows

The `HealthDiagnosticsCache` (5-second TTL) prevents per-request churn, but the initial miss latency is dominated by `readHotEntityMirrorStatus()`.

### 1.4 p95/p99 Regression Risk

As table sizes grow linearly with broker usage:

| Scale | Tasks | Est. Hot-Snapshot | Est. Mirror-Status Time | Risk |
|---|---|---|---|---|
| Current | 660 | ~75 MB | ~50 ms | Low (cached) |
| 2× | 1,320 | ~150 MB | ~100 ms | Medium |
| 10× | 6,600 | ~750 MB | ~500 ms | **High — OOM risk** |
| 100× | 66,000 | ~7.5 GB | ~5 s | **Critical — guaranteed OOM** |

The p95 health latency is already elevated by mirror-status comparison. At 10× scale, p99 latency exceeds 500 ms and the heap approaches exhaustion.

## 2. Mitigation Recommendations

### 2.1 Already in Place

- **`HealthDiagnosticsCache`** (5s TTL) — prevents per-request DB churn for `/health`
- **`SqliteAuditRuntimeRepository`** — limits audit events to `maxHotAuditEvents` (default 5,000) on each append via `pruneHotAuditEventsToMax()`
- **SQLite hot runtime hydration caps** — active tasks always hydrate, while terminal tasks, audit events, and terminal outbox events use configurable runtime caps (defaults: 2,000 terminal tasks, 5,000 audit events, 1,000 terminal outbox events)
- **`SqliteTaskHotRetentionPlanOptions`** — retention planning framework exists for tasks, audit events, and workers

### 2.2 Low-Risk Immediately Available

1. **Enable audit retention** — Set `maxAuditEvents` in the broker retention policy. The default is 5,000 but the seoseo broker likely has this at default. Lower to 2,000 to reduce hot-table load.

2. **Monitor hot-table counts and runtime caps** — Use `persistence.hotTableLoadMetrics` and `persistence.hotTableRuntimeLoadLimits` on `/health` to track per-table growth, unacked terminal outbox rows, and rows skipped from live heap hydration.

3. **Compact WAL** — SQLite auto-checkpoint triggers at 1,000 pages. Consider `PRAGMA wal_autocheckpoint=100` (non-breaking, affects only new transactions).

### 2.3 Medium-Term (Requires Design Review)

1. **Lazy hot-table loading** — Instead of loading all 10 tables at once, load only tables referenced by current operations. The `readHotRuntimeSnapshot()` is only needed at startup and on save. Individual hot reads already filter by ID.

2. **Paged/batched loading** — Add LIMIT/OFFSET to hot-table queries for large tables, loading only recent windows.

3. **Retention auto-pruning** — Run retention planning on a schedule (not just on-demand), proactively pruning old terminal tasks and audit events.

### 2.4 Long-Term

1. **Separate SQLite from Gateway** — Run the broker on a dedicated instance to avoid co-located memory pressure.
2. **Streaming JSON snapshot** — Instead of loading the full canonical snapshot into memory for mirror status, stream-compare.

## 3. Monitoring

### 3.1 Health Endpoint Fields (extended in this PR)

```json
{
  "persistence": {
    "hotTableRuntimeLoadLimits": {
      "terminalTasks": 2000,
      "auditEvents": 5000,
      "terminalOutboxEvents": 1000
    },
    "hotTableLoadMetrics": {
      "tables": {
        "broker_tasks": {
          "count": 660,
          "maxPayloadBytes": 118234,
          "runtimeLoad": {
            "limit": 2000,
            "loadedCount": 660,
            "skippedCount": 0,
            "activeCount": 5,
            "terminalCount": 655
          }
        },
        "broker_audit_events": { "count": 1986, "maxPayloadBytes": 2341, "runtimeLoad": { "limit": 5000, "loadedCount": 1986, "skippedCount": 0 } },
        "broker_terminal_outbox": {
          "count": 389,
          "maxPayloadBytes": 3120,
          "unackedCount": 234,
          "runtimeLoad": { "limit": 1000, "loadedCount": 389, "skippedCount": 0 }
        }
      }
    }
  }
}
```

Runtime cap environment variables:

- `BROKER_HOT_RUNTIME_MAX_TERMINAL_TASKS` — completed/failed/canceled task rows hydrated at startup; active rows always hydrate.
- `BROKER_HOT_RUNTIME_MAX_AUDIT_EVENTS` — audit rows hydrated at startup.
- `BROKER_HOT_RUNTIME_MAX_TERMINAL_OUTBOX_EVENTS` — terminal outbox rows hydrated at startup.

### 3.2 Alert Thresholds

| Metric | Warning | Critical |
|---|---|---|
| `broker_tasks.count` | > 1,000 | > 5,000 |
| `broker_terminal_outbox.unackedCount` | > 100 | > 500 |
| `broker_audit_events.count` | > 5,000 | > 20,000 |
| `/health` total duration | > 200 ms | > 1,000 ms |

## 4. References

- [sqlite-persistence.md](./sqlite-persistence.md) — SQLite persistence design
- [durable-persistence-path.md](./durable-persistence-path.md) — Durable persistence path
- [terminal-brief-audit-heartbeat-stability.md](./terminal-brief-audit-heartbeat-stability.md) — Audit heartbeat stability
- [production-stabilization-20260429.md](./production-stabilization-20260429.md) — Production stabilization notes
