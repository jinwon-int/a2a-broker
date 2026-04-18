# Durable persistence path beyond the single JSON snapshot store

This document defines the recommended next persistence step after the current
single-file JSON snapshot backend.

It is intentionally scoped to the broker's actual near-term operating model:

- single broker process
- single host
- bounded recovery expectations
- operator-visible inspection and backup needs

This is a persistence-direction document, not a full implementation spec.

## 1. What guarantees are needed first

The next persistence step should optimize for the following guarantees in this
order.

### 1.1 Crash-safe local durability

The current JSON snapshot store uses atomic temp-file writes plus rename, which
is adequate for the phase-1 single-process baseline. The next step should still
assume a single local writer, but it should reduce the risk of partial writes,
poisoned snapshots, or opaque recovery after a crash.

### 1.2 Bounded recovery and inspectability

Operators need to understand what state survived, what migration ran, and what
retention policy was applied. Recovery should be explainable without reverse
engineering a giant rewritten snapshot.

### 1.3 Explicit schema migration discipline

The broker already publishes `stateVersion = 5` in docs and health surfaces. The
next store should make migration steps explicit instead of relying on ad hoc
upgrade logic hidden inside runtime code.

### 1.4 Export / import path

The broker needs a practical export/import story for:

- backups
- incident reproduction
- fixture creation for tests
- moving from the current file backend to the next store

### 1.5 Multi-writer safety is not the first requirement

Multi-writer safety matters, but it should not distort the next milestone.
Today the broker is still designed around a single active process. The first
step should harden that model instead of prematurely jumping to a distributed or
externally managed database.

### 1.6 Long-retention audit archive is separate from the hot path

Long-lived audit retention matters, but it should be treated separately from the
hot operational persistence path. The next store should make retention easier,
not force the first persistence upgrade to solve all archival strategy at once.

## 2. Storage options comparison

### 2.1 Improved JSON-file strategy

This means keeping the single-file snapshot as the source of truth and adding
more validation, locks, journaling, or helper files around it.

#### Pros

- lowest migration cost
- current retention and schema shape can stay mostly intact
- export/import stays simple because the source of truth is already a file

#### Cons

- whole-state rewrite model causes write amplification
- corruption handling and partial recovery remain awkward
- inspectability gets worse as state volume grows
- migration discipline tends to stay implicit
- audit-heavy growth remains uncomfortable in one snapshot blob

#### Verdict

A stronger file strategy is reasonable as an interim extension, but it is a weak
answer to the explicit “next durable step” question.

### 2.2 SQLite with WAL mode

This is the recommended next step.

#### Pros

- matches the broker's current single-host, single-process operating model
- gives crash recovery and atomicity without requiring a separate managed DB
- supports explicit schema migrations
- makes table-by-table retention and inspection practical
- keeps operator workflows simple
- still allows JSON export for fixtures and backups

#### Cons

- requires schema design and migration work
- pushes the broker toward a clearer storage/repository layer instead of a
  single in-memory object graph
- requires a one-time import path from `state.json`

#### Verdict

SQLite with WAL is the most realistic next persistence step for the broker.

### 2.3 Other embedded stores

Examples include LMDB- or Level-style embedded stores.

#### Pros

- can be fast for specific workloads

#### Cons

- weaker operator familiarity than SQLite
- less obvious migration and inspection tooling for this team
- increases explanation and maintenance cost without solving a clear broker pain
  better than SQLite

#### Verdict

Not recommended as the default next step.

## 3. Recommendation

Use **SQLite as the new source of truth**, with rollout split into two phases.

### Phase A: snapshot-compatible SQLite adoption

- add a SQLite backend as the runtime source of truth
- keep the current `state.json` reader so existing installations can import
- perform a one-shot import when SQLite is empty and a valid JSON snapshot is
  present
- preserve an export path back to a canonical JSON form for debugging, fixtures,
  and archives

### Phase B: retention and recovery aligned to the DB backend

- move retention logic from in-memory “prune before save” to backend-driven
  pruning rules
- expose backend, schema, and migration status through health and ops docs
- document backup, restore, and export workflows for operators

This keeps the migration bounded while still moving the broker to a materially
better persistence model.

## 4. Migration outline from current state schema

Current documented snapshot schema version: `5`

Recommended migration outline:

1. keep the `stateVersion = 5` JSON snapshot reader available during migration
2. introduce an explicit SQLite schema / migration version for the DB backend
3. import JSON entities into normalized or semi-normalized tables
4. make SQLite authoritative once import succeeds
5. retain JSON export for operational portability and test fixtures

### 4.1 Suggested entity split

The first SQLite schema should separate at least:

- `exchanges`
- `exchange_messages`
- `tasks`
- `workers`
- `proposals`
- `audit_events`
- `broker_meta`
- `retention_meta` (or equivalent broker metadata table)

The exact column split can evolve, but the key decision is to stop treating the
entire runtime state as one rewritten persistence blob.

### 4.2 First-boot behavior

Recommended boot behavior:

- if SQLite is empty and `state.json` exists: run one-shot import
- if both SQLite and `state.json` exist: prefer SQLite, treat JSON as backup or
  export material
- if import fails: fail loudly and preserve the original JSON snapshot

### 4.3 Rollback posture

Before import:

- preserve the original JSON snapshot as a backup

After import:

- surface storage backend and schema/migration status via `/health`
- keep a documented JSON export path so operators can inspect or archive state

## 5. Acceptance criteria for the next persistence milestone

The milestone is complete when all of the following are true.

### 5.1 Backend and import

- the broker can boot with a SQLite backend enabled
- the broker can import an existing `state.json` with schema version `5`
- import is lossless for exchanges, messages, tasks, workers, proposals, and
  audit events that the current store preserves

### 5.2 Recovery

- crash/restart preserves task, exchange, proposal, worker, and audit visibility
- malformed or incomplete import states fail safely instead of silently drifting
- operators can tell which backend is active and whether migration ran

### 5.3 Retention parity

- existing retention intent can be expressed against the DB backend
- terminal tasks, proposals, exchanges, audit events, and inactive workers still
  remain bounded by documented policy

### 5.4 Operational visibility

- `/health` exposes persistence backend and schema / migration status
- backup, restore, and export steps are documented and reproducible

### 5.5 No broker-contract break

- existing public HTTP routes do not require a wire-contract change
- existing JSON-RPC surface does not require a breaking change just because the
  backend changed

## 6. Follow-up implementation issue buckets

Once this direction is accepted, implementation work can be split into:

1. SQLite schema design
2. JSON v5 to SQLite import tool
3. storage/repository layer abstraction
4. DB-backed retention and pruning
5. health / observability updates for backend and migration state
6. backup / restore / export documentation and tooling

## 7. Why not jump straight to a managed or multi-writer DB

The broker does not yet need a networked database to solve its most immediate
persistence risks. Moving straight to a managed or multi-writer database would
increase operational and migration cost before the single-process durability and
migration discipline problems are cleanly solved.

The better next move is to harden the current operating model first.
