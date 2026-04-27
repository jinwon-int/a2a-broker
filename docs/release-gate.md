# Release Gate — Pre-cut Verification

One command to prove the broker is ready for the next release cut.

## Quick Start

```bash
cd a2a-broker

# Run the default gate (compose smoke; recovery is marked non-blocking unless BROKER_URL is set)
npm run release_gate

# Run only compose smoke
node scripts/release-gate.mjs --skip-recovery

# Run recovery against a running broker
BROKER_URL=http://127.0.0.1:8787 BROKER_EDGE_SECRET=xxx \
  node scripts/release-gate.mjs --skip-compose

# Run compose smoke on a specific port
PORT=19000 npm run release_gate

# Run compose smoke against SQLite/WAL persistence mode
BROKER_PERSISTENCE_BACKEND=sqlite npm run release_gate -- --skip-recovery
```

## What the Gate Covers

### Phase 1 — Compose Smoke (happy path)

Brings up a fresh docker-compose stack with the echo worker and verifies:

1. Broker image builds
2. `GET /health` returns `ok`
3. Echo worker registers and reports `online`
4. `POST /tasks` is accepted (`status: queued`)
5. Task transitions to `succeeded` with result
6. Audit trail contains: `task.created`, `task.claimed`, `task.started`, `task.succeeded`
7. Optional SQLite/WAL persistence mode can be exercised by setting `BROKER_PERSISTENCE_BACKEND=sqlite`. In SQLite mode, the compose gate also runs the runtime-image JSON export script, verifies the exported snapshot contains the seeded task, and executes runtime-image SQLite task/audit retention planning proofs.
8. Live-impact approval lifecycle is proved:
   - `promote_to_live` task starts as `blocked`
   - `POST /tasks/:id/approve` records an approved outcome and returns the task to `queued`
   - approved task is claimed and succeeds
   - `POST /tasks/:id/reject-approval` records a rejected outcome and cancels without worker execution

The stack is torn down after verification. **This gate is fully self-contained** — no secrets, no external services.

### Phase 2 — Restart Recovery

Requires a **persistent broker instance** (cannot reuse the compose stack since it gets torn down). Verifies:

1. Worker claims a task → `running`
2. Worker killed mid-task
3. Broker restarted
4. Task persisted as `running` after restart
5. Operator forces stale requeue (`POST /tasks/requeue_stale?older_than_seconds=0`)
6. Replacement worker reclaims and completes → `succeeded`
7. Audit trail contains `task.requeued`

**Run with `--skip-compose` and set `BROKER_URL`.** Override the restart command with `BROKER_RESTART_CMD` if not using systemd.

## Pass/Fail Signals

The script exits with:
- `0` — all enabled gates passed, or only non-blocking recovery was skipped after compose smoke passed
- `1` — one or more gates failed
- `2` — setup error (missing deps, port conflict, or missing `BROKER_URL` for an explicit recovery-only run)

A human-readable summary and a machine-readable JSON block are printed at the end. Setup failures include `setupError: true`; non-blocking recovery skips include `nonBlocking: true`.

## Expected Artifacts

| Gate | Artifact |
|------|----------|
| Compose smoke | Clean base audit trail plus approval lifecycle proof in JSON output |
| Restart recovery | Audit trail including `task.requeued`, status progression |

## When to Stop vs Escalate

**Stop at the gate (green):**
- Both gates pass → broker is safe to ship
- Compose smoke passes but recovery is skipped → acceptable for non-production cuts where restart behavior hasn't changed

**Escalate to fuller tests:**
- Either gate fails → do not merge, investigate using the failure triage in [smoke-compose.md](smoke-compose.md) and [restart-recovery-smoke.md](restart-recovery-smoke.md)
- Audit trail has unexpected events → check broker logs for state-machine regressions
- Flaky timing failures → increase `SMOKE_TIMEOUT_MS` or check system load

## Relationship to Existing Docs

This gate is the **operator-facing entry point**. The underlying details remain in:
- `docs/smoke-compose.md` — compose smoke reference
- `docs/restart-recovery-smoke.md` — recovery drill reference
- `scripts/restart-recovery-smoke.mjs` — recovery automation (standalone)

## Phase 7b Gate Checklist

Use this checklist when Phase 7b operator-stream work changes:

1. `GET /alerts` emits `worker.heartbeat_missed` once a worker's
   `lastSeenAt` crosses the offline / missed-heartbeat threshold.
2. `GET /a2a/operator/events` opens with an `operator-snapshot`
   event whose `summary` matches the broker-owned dashboard shape and
   whose `alerts` match the current alert scan.
3. A worker that goes stale, then heartbeats again, produces
   `operator-alert-opened` followed by
   `operator-alert-resolved` for `worker.heartbeat_missed`.
4. Reconnecting `GET /a2a/operator/events` with `Last-Event-ID`
   replays missed operator events before sending a fresh
   `operator-snapshot`.
5. SSE heartbeats still arrive as `: heartbeat ...` comments so idle
   operator streams survive proxy timeouts.
6. `gateway.unhealthy` stays schema-only unless gateway runtime work
   is explicitly in scope; this phase must not add a synthetic gateway
   entity or health loop.
