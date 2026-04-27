# Round 35 SQLite runtime repository closeout

Round 35 completes the SQLite runtime repository seam pass across the mirrored
hot tables introduced in the earlier SQLite persistence rounds. The public HTTP
and JSON-RPC contracts stay stable, and JSON-file mode continues to use the
existing in-memory maps and canonical snapshot store.

## Runtime repository coverage completed

The Round 35 PR series added SQLite-backed runtime repository seams for all 9
mirrored hot tables:

- `broker_workers` — worker register, heartbeat, last-seen, and online/stale
  list state (#150)
- `broker_tasks` — task lifecycle reads and mutation writes (#151)
- `broker_audit_events` — append-only audit diagnostics state (#152)
- `broker_tombstones` — terminal task tombstone diagnostics state (#152)
- `broker_exchanges` — exchange lifecycle reads and mutation writes (#154)
- `broker_exchange_messages` — exchange thread message reads and writes (#154)
- `broker_proposals` — proposal lifecycle reads and mutation writes (#155)
- `broker_artifacts` — proposal artifact metadata reads and writes (#156)
- `broker_validations` — proposal validation reads and writes (#157)

Round 35 also kept the SQLite release-gate proof aligned with the runtime seam
work (#153), building on the Round 34 hot-table diagnostics baseline.

## What changed for operators

- SQLite mode now binds the broker to table-backed repositories for the current
  high-churn runtime entities above.
- JSON mode remains unchanged and does not instantiate the SQLite repositories.
- The canonical snapshot format, export path, and public API contracts remain
  compatible with the earlier SQLite persistence rounds.

## Verification bar

Before cutting a release with the Round 35 SQLite runtime baseline, run:

```bash
npm run build
BROKER_PERSISTENCE_BACKEND=sqlite npm run release_gate -- --skip-recovery
npm test
```

Expected Round 34 baseline signals still apply:

- `schemaVersion=8`
- `hotEntityHintCoverage.ok=true`
- `supportedCount=9`, `totalCount=9`, `missingTables=[]`
- `sqlite hinted writes: 9/9 tables covered`
- `sqlite diagnostics: hot task/tombstone/worker/audit covered (4/4 tables)`

## Remaining Round 36-oriented limitations

Round 35 is a runtime repository seam closeout, not a full source-of-truth
cutover:

- The canonical snapshot is still written and loaded for broker runtime state.
- Retention remains snapshot-owned except for the existing hot-table planning and
  pruning helpers documented in `docs/sqlite-persistence.md`.
- JSON export and first-boot JSON import still operate through the canonical
  snapshot contract.
- Cold-start runtime hydration still comes from the loaded snapshot before the
  broker resumes normal runtime operation.

The next persistence step is reducing this snapshot ownership for retention,
export/import, and cold-start hydration while preserving the same public HTTP and
JSON-RPC behavior.
