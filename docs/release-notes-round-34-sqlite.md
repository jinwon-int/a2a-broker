# Round 34 SQLite operator coverage release notes

Round 34 completes the SQLite read/write coverage push for the standalone broker
while keeping the public HTTP and JSON-RPC contract stable.

## Operator-facing changes

- SQLite schema version is now `8`.
- `/health` exposes complete hot-entity hinted-write coverage for all 9 mirrored
  SQLite tables.
- `GET /tasks/:id/diagnostics` and `GET /tasks/diagnostics` read hot SQLite
  context for task, tombstone, worker, and audit data.
- SQLite release-gate output now includes:

  ```text
  sqlite hinted writes: 9/9 tables covered
  sqlite diagnostics: hot task/tombstone/worker/audit covered (4/4 tables)
  ```

## Coverage completed

- Hot write hints cover all mirrored tables:
  - `broker_exchanges`
  - `broker_exchange_messages`
  - `broker_proposals`
  - `broker_artifacts`
  - `broker_validations`
  - `broker_tasks`
  - `broker_tombstones`
  - `broker_workers`
  - `broker_audit_events`
- Release-gate diagnostics coverage directly seeds runtime SQLite rows in:
  - `broker_tasks`
  - `broker_tombstones`
  - `broker_workers`
  - `broker_audit_events`

## Verification bar

Before cutting a release with the Round 34 SQLite baseline, run:

```bash
npm run build
BROKER_PERSISTENCE_BACKEND=sqlite npm run release_gate -- --skip-recovery
npm test
```

Expected signals:

- `schemaVersion=8`
- `hotEntityHintCoverage.ok=true`
- `supportedCount=9`, `totalCount=9`, `missingTables=[]`
- `sqlite hinted writes: 9/9 tables covered`
- `sqlite diagnostics: hot task/tombstone/worker/audit covered (4/4 tables)`

## Follow-up posture

The snapshot remains canonical. Round 34 establishes the SQLite operator and
release-gate proof needed before moving broader runtime paths into dedicated
table-backed repositories.
