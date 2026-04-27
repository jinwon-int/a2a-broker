# Persistence next step proposal

Drafted for `jinon86/a2a-broker#9`.

## Current baseline

The broker already has a better-than-trivial phase-1 store:

- single JSON snapshot file
- atomic temp-file write + rename
- schema validation on load
- max snapshot size guard
- retention before save
- restart survival on a single node

That means the current gap is not "persistence exists or not". The real gap is that the current store is still a **single-writer JSON snapshot strategy** with limited concurrency and recovery ergonomics.

## What guarantees matter first

The next milestone does **not** need distributed storage. It does need stronger operator-grade guarantees than the current file snapshot gives us.

Priority order:

1. **Crash safety**
   - committed writes survive restart
   - partial write or malformed snapshot does not silently load
2. **Concurrent writer discipline**
   - one process or request path cannot accidentally stomp another writer's state
   - future multi-process deployment should fail clearly or serialize safely
3. **Schema versioning + migration**
   - state version is authoritative
   - upgrades have an explicit migration path instead of ad hoc parser tolerance
4. **Partial recovery / inspection**
   - operators can inspect tasks, workers, audit rows, and recent events without loading one giant snapshot blob
5. **Audit retention**
   - audit/event history can age separately from hot lifecycle state
6. **Export / import**
   - snapshot export remains possible for backup, debugging, or migration

## Option comparison

| Option | Pros | Cons | Verdict |
| --- | --- | --- | --- |
| Improved JSON file strategy | Lowest implementation churn, preserves current mental model, easy backup story | Still awkward for concurrent writers, migration stays coarse-grained, inspection remains blob-centric, partial recovery weak | Good only as a short extension, not the next real milestone |
| SQLite + transactional metadata store | Single-file operational model, ACID transactions, better crash safety, clear schema migrations, easy local inspection, natural step before any larger DB | Requires schema design and migration code, artifact strategy still needs boundaries | **Recommended next step** |
| Separate server DB first (Postgres etc.) | Strong multi-process path, future horizontal scale | Overkill for current deployment shape, higher operator burden, harder local smoke path, pushes too much complexity into first durability upgrade | Defer |

## Recommendation

Adopt **SQLite as the next persistence milestone**, with a deliberate split:

- **SQLite owns metadata and lifecycle state**
  - exchanges
  - exchange messages
  - tasks
  - proposals
  - validations
  - artifacts metadata
  - audit events
  - workers
- **Filesystem keeps large artifacts / bundles / reports as files**
  - broker stores URI + metadata, not all blob content inline

This matches the current operator shape better than jumping to a network DB and solves the real blocker called out in `docs/v1-acceptance-handoff.md`: the JSON file store is durable enough for phase 1, but not a robust next-step store for externally operated split deployments.

## Why SQLite is the right next step

### 1. It preserves the good parts of today's operator model

Operators still get a local single-file state store, backup is still simple, and smoke paths stay easy.

### 2. It upgrades the exact weak spots we have now

- transactional commit semantics
- multiple logical tables instead of one opaque blob
- migration-friendly schema evolution
- better recovery and inspection with SQL queries

### 3. It avoids premature distributed-DB complexity

Nothing in the current broker acceptance gate says we need cross-region writes, replicas, or shared hosted DB infrastructure yet.

## Proposed persistence shape

### Tables

Suggested initial tables:

- `broker_meta`
  - schema version
  - created_at
  - migrated_at
- `exchanges`
- `exchange_messages`
- `tasks`
- `proposals`
- `validations`
- `artifacts`
- `audit_events`
- `workers`

### Artifact handling

Keep artifact payloads out of the main relational hot path when they can grow large.

- DB stores metadata and URI
- file/object path stores heavy content
- broker remains responsible for referential integrity checks at write time where practical

### Retention

Current retention knobs can remain conceptually unchanged, but enforcement moves from "trim giant snapshot before save" to table-aware cleanup jobs or write-path cleanup.

## Snapshot schema versioning and migration

## Versioning rules

1. `stateVersion` remains authoritative.
2. Broker startup must refuse unknown future schema versions.
3. Backward-incompatible storage changes require an explicit migration step, not silent coercion.
4. Exported snapshots should carry both:
   - storage engine kind (`json-file` or `sqlite`)
   - schema version

## Migration path from current schema v5

### Step 1. Freeze the JSON snapshot contract as the migration source

Treat the current snapshot structure in `src/core/store.ts` as the source schema for import.

### Step 2. Add one-shot importer

On first boot with SQLite enabled:

- read JSON snapshot v5
- validate exactly as today
- import rows transactionally
- mark imported schema version in `broker_meta`
- keep original JSON file untouched until import succeeds

### Step 3. Keep explicit backup / export

Provide either:

- `broker export-state --format json`
- or a documented maintenance script

so operators can still produce a portable snapshot from SQLite-backed state.

### Step 4. Fail safe on partial import

If import fails:

- rollback transaction
- preserve original JSON file
- fail startup with a precise error

## Acceptance criteria for the next persistence milestone

Round 32 starts with an explicit opt-in SQLite/WAL snapshot backend. See `docs/sqlite-persistence.md` for the operator-facing configuration and import behavior. This first slice preserves the current snapshot-store contract so the public broker API remains stable while later slices can normalize hot entities into tables.

The next persistence milestone should count as done only when all of these are true:

### Functional

- broker can boot against SQLite with no JSON snapshot required after migration
- broker can import existing JSON snapshot v5 into SQLite
- broker reports persistence kind and schema version in `/health`
- broker preserves all current lifecycle entities and payload round-trip expectations

### Safety

- writes are transactional
- malformed or partial DB state fails fast, not silently
- concurrent access expectations are documented clearly
- migration is all-or-nothing from a broker startup perspective

### Operability

- operators have a documented backup/export path
- operators can inspect active tasks and recent audit events without decoding a monolithic blob
- retention policy remains configurable and documented

### Verification

- migration test: JSON v5 -> SQLite import preserves representative broker state
- restart recovery smoke passes on SQLite-backed state
- failure test: interrupted import or corrupt DB produces a bounded, actionable startup error

## Explicit non-goals for this milestone

- clustered multi-writer deployment
- hosted external DB requirement
- artifact blob storage redesign
- historical analytics warehouse

## Suggested follow-up issue split

After agreement, implementation can break into:

1. storage schema + migrations
2. JSON v5 importer
3. `/health` persistence metadata update
4. retention rewrite for table-backed state
5. export / backup path
6. restart-recovery smoke for SQLite mode
