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
- `STATE_FILE` — remains meaningful as the optional JSON import source.

## Import behavior

On first SQLite load:

1. If the SQLite DB already contains a broker snapshot, the broker loads it.
2. If no SQLite snapshot exists and `STATE_FILE` exists, the broker validates and imports that JSON snapshot transactionally.
3. If neither exists, the broker starts with an empty snapshot.

Malformed JSON import fails startup/load with the same bounded validation errors as the JSON store. The original JSON file is not modified by import.

## Health metadata

`GET /health` reports the active backend:

```json
{
  "persistence": {
    "kind": "sqlite",
    "dbFile": "/var/lib/a2a-broker/state.sqlite",
    "stateVersion": 7,
    "schemaVersion": 5,
    "journalMode": "wal",
    "hotEntityTables": [
      "broker_exchanges",
      "broker_exchange_messages",
      "broker_tasks",
      "broker_workers",
      "broker_audit_events"
    ],
    "importedFromJsonFile": "/var/lib/a2a-broker/state.json",
    "lastImportAt": "2026-04-27T00:00:00.000Z"
  }
}
```

JSON mode continues to report:

```json
{
  "persistence": {
    "kind": "json-file",
    "stateFile": "/var/lib/a2a-broker/state.json",
    "stateVersion": 7
  }
}
```

## Backup / restore

SQLite mode uses WAL. For an online backup, copy the DB using SQLite's backup tooling or stop the broker and copy the DB, WAL, and SHM files together:

- `state.sqlite`
- `state.sqlite-wal`
- `state.sqlite-shm`

For restore, stop the broker, place those files back under the configured path, then restart with the same `BROKER_PERSISTENCE_BACKEND=sqlite` and `BROKER_SQLITE_FILE` values.

## Current limitation

This slice is still snapshot-first for broker runtime load, but SQLite also maintains normalized hot-entity inspection tables for tasks, workers, and audit events in the same transaction as the snapshot write. The next slices should move runtime reads/writes for tasks, workers, audit events, exchanges, proposals, and tombstones into dedicated repositories while keeping the public HTTP and JSON-RPC contract stable.
