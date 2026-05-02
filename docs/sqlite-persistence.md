# SQLite Persistence Mode

Round 32 introduces an explicit opt-in SQLite persistence backend while keeping the existing JSON snapshot store as the default.

This first slice intentionally preserves the existing `BrokerStateStore` snapshot contract. The broker still reads and writes a validated broker snapshot, but the snapshot is stored inside SQLite with WAL enabled. This gives operators a safer durable backend and a migration foothold before the broker is split into table/repository-level writes.

## Enable

```bash
BROKER_PERSISTENCE_BACKEND=sqlite \
BROKER_SQLITE_FILE=/var/lib/a2a-broker/state.sqlite \
STATE_FILE=/var/lib/a2a-broker/state.json \
npm start
```

Environment:

- `BROKER_PERSISTENCE_BACKEND=sqlite` — enable SQLite mode.
- `BROKER_SQLITE_FILE` or `SQLITE_STATE_FILE` — SQLite DB path. If omitted, the broker uses `${STATE_FILE}.sqlite`.
- `BROKER_SQLITE_LOAD_SOURCE=hot-tables` — optional Round 36 cold-start mode that hydrates broker runtime state from mirrored hot tables instead of the canonical snapshot row. Default: `snapshot`.
- `STATE_FILE` — remains meaningful as the optional JSON import source.

## Import and load behavior

Default SQLite load source is `snapshot`:

1. If the SQLite DB already contains a broker snapshot, the broker loads it.
2. If no SQLite snapshot exists and `STATE_FILE` exists, the broker validates and imports that JSON snapshot transactionally.
3. If neither exists, the broker starts with an empty snapshot.

With `BROKER_SQLITE_LOAD_SOURCE=hot-tables`, startup reconstructs the broker snapshot shape from the 9 mirrored hot tables. If the DB has no canonical snapshot and the hot tables are empty, the first-load JSON import path still runs so existing JSON deployments can migrate without a separate bootstrap step.

Malformed JSON import fails startup/load with the same bounded validation errors as the JSON store. The original JSON file is not modified by import.

## Health metadata

`GET /health` reports the active backend, hot tables, and hot table mirror status:

```json
{
  "persistence": {
    "kind": "sqlite",
    "dbFile": "/var/lib/a2a-broker/state.sqlite",
    "stateVersion": 8,
    "loadSource": "snapshot",
    "schemaVersion": 8,
    "journalMode": "wal",
    "hotEntityTables": [
      "broker_exchanges",
      "broker_exchange_messages",
      "broker_proposals",
      "broker_artifacts",
      "broker_validations",
      "broker_tasks",
      "broker_tombstones",
      "broker_workers",
      "broker_audit_events"
    ],
    "hotEntityHintTables": [
      "broker_exchanges",
      "broker_exchange_messages",
      "broker_proposals",
      "broker_artifacts",
      "broker_validations",
      "broker_tasks",
      "broker_tombstones",
      "broker_workers",
      "broker_audit_events"
    ],
    "hotEntityHintCoverage": {
      "ok": true,
      "supportedTables": [
        "broker_exchanges",
        "broker_exchange_messages",
        "broker_proposals",
        "broker_artifacts",
        "broker_validations",
        "broker_tasks",
        "broker_tombstones",
        "broker_workers",
        "broker_audit_events"
      ],
      "missingTables": [],
      "supportedCount": 9,
      "totalCount": 9
    },
    "hotEntityMirror": {
      "ok": true,
      "tableCounts": {
        "broker_tasks": 12,
        "broker_audit_events": 5000
      },
      "snapshotCounts": {
        "tasks": 12,
        "auditEvents": 7421
      },
      "mismatches": [],
      "retentionWindows": [
        {
          "table": "broker_audit_events",
          "snapshotKey": "auditEvents",
          "tableCount": 5000,
          "snapshotCount": 7421,
          "reason": "audit_hot_retention",
          "prunedCount": 2421
        }
      ]
    },
    "importedFromJsonFile": "/var/lib/a2a-broker/state.json",
    "lastImportAt": "2026-04-27T00:00:00.000Z"
  }
}
```

Operator check:

- `persistence.hotEntityHintCoverage.ok` should be `true`.
- `persistence.hotEntityHintCoverage.missingTables` should be empty.
- `persistence.hotEntityHintCoverage.supportedCount` should equal `persistence.hotEntityHintCoverage.totalCount`.
- `persistence.hotEntityHintTables` should match the mirrored `persistence.hotEntityTables` set.
- `persistence.hotEntityMirror.ok` should be `true` and `persistence.hotEntityMirror.mismatches` should be empty before treating the SQLite hot mirror as healthy.
- `persistence.hotEntityMirror.retentionWindows` may list `broker_audit_events` with `reason: "audit_hot_retention"` when hot audit retention has intentionally pruned older audit rows from the mirror. This is not a drift failure as long as `mismatches` is empty; the retained hot audit row ids are still checked against the canonical snapshot so rogue audit rows or non-audit count drift continue to fail health.

If `hotEntityHintCoverage.ok=false`, at least one mirrored SQLite hot table is missing dirty hinted-write support. Treat that as a schema/write-path drift signal before relying on hot-table read performance for that deployment. If `hotEntityMirror.ok=false`, inspect `mismatches` and take a backup before repairing or rebuilding the live SQLite DB.

## Schema v8 and diagnostics hot reads

SQLite schema version `8` is the Round 34 operator-read baseline. It keeps the
canonical snapshot contract intact while making all mirrored hot-table coverage
visible to operators:

- `broker_tasks`
- `broker_tombstones`
- `broker_workers`
- `broker_audit_events`
- `broker_exchanges`
- `broker_exchange_messages`
- `broker_proposals`
- `broker_artifacts`
- `broker_validations`

Task diagnostics now read hot SQLite context for task, tombstone, worker, and
audit data through the HTTP diagnostics endpoints:

- `GET /tasks/:id/diagnostics`
- `GET /tasks/diagnostics`

The release gate seeds runtime SQLite rows directly into the hot task,
tombstone, worker, and audit tables, then verifies the diagnostics endpoints use
those rows. This proves the diagnostics read path is not only reporting broker
memory state.

Expected SQLite release-gate summary lines:

```text
sqlite hinted writes: 9/9 tables covered
sqlite diagnostics: hot task/tombstone/worker/audit covered (4/4 tables)
```

For a healthy Round 34 SQLite deployment, operators should see
`schemaVersion=8`, `hotEntityHintCoverage.ok=true`, `supportedCount=9`,
`totalCount=9`, and `missingTables=[]`.

## Round 35 runtime repository seams

Round 35 completes the table-native runtime repository seam pass for the
mirrored hot tables. See
[`release-notes-round-35-sqlite-runtime.md`](./release-notes-round-35-sqlite-runtime.md)
for the closeout summary and remaining Round 36-oriented limitations. When
SQLite mode is active, the broker binds these high-churn runtime reads and
writes to hot-table repositories while still hydrating the in-memory broker maps
for existing lifecycle code. Canonical snapshot writes, JSON export, rollback
inspection, and public HTTP/JSON-RPC contracts remain unchanged.

The current repository seams cover:

- `POST /workers/register`
- `POST /workers/:id/heartbeat`
- broker `getWorker` / `listWorkers` state used for last-seen and online/stale
  views
- task lifecycle `getTask` / `listTasks` reads and task mutation writes backed
  by `broker_tasks`
- exchange lifecycle `getExchange` / `listExchanges` reads and exchange mutation
  writes backed by `broker_exchanges`
- exchange-message thread reads and writes backed by
  `broker_exchange_messages`
- proposal lifecycle `getProposal` / `listProposals` reads and proposal
  mutation writes backed by `broker_proposals`
- proposal artifact metadata reads and writes backed by `broker_artifacts`
- proposal validation reads and writes backed by `broker_validations`
- audit-event diagnostics reads and append writes backed by `broker_audit_events`
- terminal task tombstone diagnostics reads and writes backed by
  `broker_tombstones`

JSON mode remains unchanged and does not instantiate the SQLite repositories.
The focused tests prove direct repository upserts separately from snapshot
hot-write hints; the broader SQLite release gate still validates the existing
hot-table, diagnostics, retention, and export guarantees.

JSON mode continues to report:

```json
{
  "persistence": {
    "kind": "json-file",
    "stateFile": "/var/lib/a2a-broker/state.json",
    "stateVersion": 8
  }
}
```

## JSON export

SQLite mode can export the canonical broker snapshot JSON for inspection, archive, or rollback planning:

```bash
npm run build
npm run export:sqlite -- --db /var/lib/a2a-broker/state.sqlite --out /tmp/a2a-broker-state.json
```

If `--out` is omitted, the command writes the JSON snapshot to stdout. The export validates and serializes through the same broker snapshot schema/version used by the runtime store.

Environment fallbacks:

- `BROKER_SQLITE_FILE` or `SQLITE_STATE_FILE` can provide `--db`.
- `STATE_FILE_MAX_BYTES` can provide `--max-bytes`.

## Backup / restore

SQLite mode uses WAL. For an online backup, copy the DB using SQLite's backup tooling or stop the broker and copy the DB, WAL, and SHM files together:

- `state.sqlite`
- `state.sqlite-wal`
- `state.sqlite-shm`

For restore, stop the broker, place those files back under the configured path, then restart with the same `BROKER_PERSISTENCE_BACKEND=sqlite` and `BROKER_SQLITE_FILE` values.

## Runtime hot rows and retention planning

This slice is still snapshot-compatible for broker runtime load, but SQLite also maintains normalized hot-entity inspection tables for public read paths in the same transaction as the snapshot write. Runtime exchange, exchange-message, proposal, artifact, validation, task, tombstone, audit, and worker mutations now pass dirty hot-entity hints into state saves, and the SQLite store uses those hints to upsert changed hot rows while preserving retained rows and pruning rows absent from the canonical snapshot. Worker, task, audit, tombstone, exchange, exchange-message, proposal, proposal artifact metadata, and proposal validation state additionally have the Round 35 runtime repository seams described above. SQLite `/health` exposes `hotEntityHintCoverage` so operators can verify hinted-write support covers every mirrored hot table.

The SQLite store also exposes task/audit/worker hot-table retention planning helpers. These compute retained/prunable row ids from the hot tables with the same cutoff/newest-cap/protected-target shape used by broker retention. Verified plans can be applied to prune task/audit/worker hot rows directly in SQLite; canonical snapshot retention remains the source of truth until broader runtime paths move fully into dedicated repositories.

## Round 36 hot runtime load source

SQLite now has a tested hot-table runtime snapshot projection primitive that can
reconstruct a `BrokerSnapshot`-shaped view from the 9 mirrored hot tables. Round
36 also adds the opt-in `BROKER_SQLITE_LOAD_SOURCE=hot-tables` cold-start source
so operators can hydrate runtime broker maps from table-native rows while the
default remains canonical-snapshot compatible.

## Current limitation

The snapshot remains export-compatible and is still the default load source. All
mirrored hot tables now have Round 35 SQLite runtime repository seams, but
retention and export/import remain snapshot-owned unless covered by the existing
hot-table planning/pruning helpers above. The next dependency is reducing that
snapshot ownership while keeping the public HTTP and JSON-RPC contract stable.
