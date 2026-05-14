# Broker Hot-Table Retention & Safe Prune Runbook

**Issues:** [#497](https://github.com/jinwon-int/a2a-broker/issues/497) —
[#617](https://github.com/jinwon-int/a2a-broker/issues/617)  
**Date:** 2026-05-14  
**Author:** nosuk (Team1)

## 1. Problem

The broker hot tables (`broker_tasks`, `broker_audit_events`, `broker_terminal_outbox`,
`broker_workers`, etc.) accumulate rows over time. Without intervention:

- **Memory pressure**: Loading rows into the live heap at startup can exceed the Node.js
  default ~4 GB limit when hot tables grow beyond ~10× current scale (see
  [hot-table-health](./hot-table-health.md) §1.4).
- **Health latency**: The `/health` endpoint calls `readHotEntityMirrorStatus()` which
  scans all hot tables; latency grows with table size.
- **Stale worker records**: Workers that have been offline for >14 days remain in
  `broker_workers`, potentially masking operator diagnostics.

## 2. Design: Retention Policy

Retention is defined in `BrokerRetentionPolicy` (`src/core/broker.ts`):

```typescript
export interface BrokerRetentionPolicy {
  terminalRetentionMs: number;       // 7 days  (tasks, exchanges, proposals)
  maxTerminalExchanges: number;      // 1,000
  maxTerminalTasks: number;          // 2,000
  maxTerminalProposals: number;      // 1,000
  inactiveWorkerRetentionMs: number; // 14 days
  maxInactiveWorkers: number;        // 500
  auditRetentionMs: number;          // 7 days
  maxAuditEvents: number;            // 5,000
}
```

The **in-memory broker** (`InMemoryA2ABroker`) applies these during `save()` and startup –
terminal task/audit rows beyond the cap are evicted before snapshotting.

The **SQLite hot-table store** (`SqliteBrokerStateStore`) does _not_ auto-prune on save.
Retention is an explicit operator action through the cleanup pipeline.

## 3. Cleanup Pipeline

### 3.1 Dry-Run Discovery (`buildBrokerCleanupPlan`)

Pure-function discovery of prune candidates. **No rows are mutated.** The planner:

1. Reads a bounded set (max 2000) of current task records to discover active worker IDs.
2. Calls `store.planHotTaskRetention()` — identifies terminal tasks past
   `terminalRetentionMs` or exceeding `maxTerminalTasks`.
3. Calls `store.planHotWorkerRetention()` — identifies workers inactive past
   `inactiveWorkerRetentionMs` and exceeding `maxInactiveWorkers`, protected by
   active/assigned tasks.
4. Calls `store.planHotAuditRetention()` — identifies audit rows past
   `auditRetentionMs` or exceeding `maxAuditEvents`, protected by retained task/worker IDs.
5. Calls `store.planHotTerminalOutboxRetention()` — identifies acknowledged outbox
   events past retention.

**Safety gates** (defined in `validateCleanupExecution`):
- `approvalToken` must match `planId` (hash of plan contents)
- `confirmation` must equal `APPLY_BROKER_CLEANUP_PLAN`
- `backupProof` (checkpoint/backup reference) is required before execution
- Worker prune requires explicit `allowWorkerPrune=true`
- Terminal outbox prune is **always dry-run-only** pending a separate ACK path

### 3.2 Script Entry Point: `broker-cleanup-safe-prune.mjs`

```bash
# Dry-run: view prune candidates
npm run broker_cleanup_safe_prune -- --base-url http://broker:8787

# Execute with safety gates
npm run broker_cleanup_safe_prune -- \
  --base-url http://broker:8787 \
  --approve \
  --backup-proof s3://backups/broker-20260514T120000Z.sqlite
```

## 4. Health/Readiness Warnings

The `/health` endpoint surfaces hot-table growth warnings through the
`projectHotTableGrowth` projection (`src/core/hot-table-growth.ts`):

| Severity | Condition | Health Effect |
|---|---|---|
| `ok` | All metrics below thresholds | Normal |
| `warning` | Single table >1,000 rows, or growth >50%, or >100 MB | `body.warning` |
| `critical` | Single table >5,000 rows, or >500 MB, or >70% heap skipped | `body.ok=false`, `body.error` |

**Warning bounding**: The projection caps warnings to `DEFAULT_MAX_WARNINGS` (10) to
prevent unbounded growth in the health response. When truncated, `warningsTruncated: true`
is included in the projection. The health endpoint also truncates the error/warning
message strings to 500 characters.

To check current hot-table state:

```bash
curl -s http://broker:8787/health | jq '.hotTableGrowth'
```

## 5. Safe Prune Checklist

Before any prune execution:

- [ ] **Backup**: Copy the SQLite DB + WAL/SHM sidecars while the broker is quiesced.
  ```bash
  cp "$BROKER_SQLITE_FILE" "$BROKER_SQLITE_FILE.bak.$(date -u +%Y%m%dT%H%M%SZ)"
  ```
- [ ] **Dry-run**: Run the cleanup planner and review candidate counts.
- [ ] **Check active workers**: Ensure no online worker is about to have its rows pruned.
- [ ] **Monitor health**: Run `broker-live-readiness-canary` before and after.
- [ ] **Rollback plan**: Restoration from backup is the standard rollback path.

## 6. Rollback

**Prune operations are irreversible** — the standard rollback is file-level restore:

1. Stop broker writes (drain connections or stop the process).
2. Move the current SQLite file aside.
3. Copy the `.bak.*` file back to the original `BROKER_SQLITE_FILE` path.
4. Restore matching WAL/SHM sidecar files if they were backed up.
5. Restart the broker.

After rollback, run the cleanup planner in dry-run mode to confirm the pre-prune state
is restored before resuming normal operation.

## 7. References

- [hot-table-health.md](./hot-table-health.md) — RCA, mitigation guide, alert thresholds
- [audit-retention-rollback-20260501.md](./audit-retention-rollback-20260501.md) —
  Audit retention hotfix & rollback proof
- `src/core/hot-table-growth.ts` — Projection logic
- `src/core/broker-cleanup.ts` — Dry-run planning & execution
- `src/core/store.ts` — SQLite hot-table retention planners
- `src/core/broker.ts` — `BrokerRetentionPolicy` defaults
- `scripts/broker-cleanup-safe-prune.mjs` — CLI entry point
- `scripts/broker-live-readiness-canary.mjs` — Pre/post prune canary
