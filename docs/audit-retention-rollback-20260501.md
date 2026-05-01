# Broker audit retention hotfix / rollback proof (2026-05-01)

## Safety invariant

`maxAuditEvents` now caps non-protected audit rows even when the events are recent. Worker registration remains protected while high-churn `worker.heartbeat` rows are eligible for normal audit age/count pruning, so an online worker cannot pin an unbounded heartbeat history in `broker_audit_events`.

Protected audit rows for retained tasks, proposals, exchanges, artifacts, validations, and non-heartbeat worker records are still preserved to avoid breaking operator diagnostics during retention.

## Rollback path

Before deploying a retention change or running a manual prune, copy the SQLite DB and its WAL/SHM sidecars while the service is stopped or quiesced:

```bash
cp "$BROKER_SQLITE_FILE" "$BROKER_SQLITE_FILE.bak.$(date -u +%Y%m%dT%H%M%SZ)"
cp "$BROKER_SQLITE_FILE-wal" "$BROKER_SQLITE_FILE-wal.bak.$(date -u +%Y%m%dT%H%M%SZ)" 2>/dev/null || true
cp "$BROKER_SQLITE_FILE-shm" "$BROKER_SQLITE_FILE-shm.bak.$(date -u +%Y%m%dT%H%M%SZ)" 2>/dev/null || true
```

Rollback is file-level restore: stop the broker, move the current DB files aside, copy the matching `.bak.*` DB/WAL/SHM files back to their original names, then start the broker. This restores the exact pre-prune hot-table contents and canonical snapshot.

## Verification

Focused regression gate:

```bash
npm run build && node --test dist/core/broker.test.js dist/core/store.test.js
```

The regression tests assert both the in-memory broker retention path and the SQLite hot-table planner cap recent `worker.heartbeat` audit rows while preserving `worker.registered` proof.
