# Release Gate — Pre-cut Verification

One command to prove the broker is ready for the next release cut.

For public/stable release decisions or repository visibility changes, pair this
technical gate with the operator checklist in
[`public-stable-readiness.md`](public-stable-readiness.md). The checklist adds
license, secret/history scan, documentation, rollback, cross-repo boundary, and
explicit approval gates that this script cannot prove by itself.

## Quick Start

```bash
cd a2a-broker

# CI-safe check of production Docker Compose runtime invariants (no Docker daemon required)
npm run docker_runtime_preflight -- --dry-run

# Live host preflight for the Compose-managed broker runtime
npm run docker_runtime_preflight

# Run the default gate (compose smoke; recovery is marked non-blocking unless BROKER_URL is set)
npm run release_gate

# Render the consolidated read-only closeout report from sanitized evidence
npm run closeout_release_report -- --input closeout-evidence.json --markdown

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

### Consolidated Read-only Closeout Report

`npm run closeout_release_report -- --input closeout-evidence.json --markdown`
renders the operator-facing closeout for #342/#294 from a sanitized evidence
bundle. The renderer is intentionally read-only: it does not query production by
itself, deploy, restart Gateway, send Telegram, mutate SQLite, or ACK terminal
outbox rows. It fails closed instead of producing a false Done when any required
proof is missing.

The evidence bundle should contain:

1. edge-secret presence proof as a boolean only (`edgeSecret.present: true`),
   never the secret value
2. health revision evidence (`ok/status` plus `build`, `revision`, or `version`)
3. worker capacity matrix with all expected workers online:
   `bangtong,dungae,sogyo,nosuk,yukson`
4. queue/stale closeout counts: `queued=0`, `claimed=0`, `running=0`, `stale=0`
5. migration health gate output (`npm run migration_health_gate -- --json`)
6. live-readiness canary output (`npm run live_readiness_canary -- --no-live --json`
   for this release-dryrun lane, or read-only GET output when approved)
7. canonical PR/Done/Block terminal evidence using HTTPS URLs only
8. receipt no-live matrix output (`npm run receipt_gate_canary -- --json`)

Focused fail-closed coverage lives in `scripts/closeout-release-report.test.mjs`
and proves missing edge-secret proof, non-zero queue/stale counts, and receipt
evidence gaps all render Block evidence.

#### Current-vs-legacy residue lifecycle

For the May 2026 stabilization gate, run the read-only migration gate with:

```bash
npm run migration_health_gate -- \
  --db <sqlite-state-file> \
  --legacy-residue-cutoff 2026-05-04T07:10:00.000Z \
  --json
```

The cutoff is a bounded quarantine, not a greenwash:

- rows **before** `2026-05-04T07:10:00.000Z` are reported as legacy residue and
  never converted into ACK/tombstone proof by the gate
- rows **at or after** the cutoff are current regressions and block release
- terminal-outbox legacy residue remains unacknowledged unless independent
  operator-visible/provider-delivery evidence is later recorded through the
  normal ACK path
- the default quarantine expires seven days after the cutoff
  (`2026-05-11T07:10:00.000Z` for this policy); after expiry, remaining legacy
  residue makes the migration gate fail until cleaned up or the cutoff is removed
- operators may set `--legacy-residue-expires <iso>` only to shorten or explicitly
  document the bounded exception window

### Docker Runtime Preflight

`npm run docker_runtime_preflight -- --dry-run` validates the repo-local Compose file before a release. It fails if the production service no longer defines:

1. `services.a2a-broker`
2. a default container name that resolves to `a2a-broker`
3. loopback-only publish `127.0.0.1:8787:8787`
4. container `HOST=0.0.0.0`
5. bind mount `/var/lib/a2a-broker:/var/lib/a2a-broker`

On a live VPS, run `npm run docker_runtime_preflight` from the Compose project directory. The live check also verifies the `a2a-broker` container is healthy with the expected env, port binding, and state bind mount, and confirms the legacy `a2a-broker.service` is inactive/disabled or absent. The check prints only invariant names and sanitized states; it does not dump environment secrets or session data.

### Phase 1 — Compose Smoke (happy path)

Brings up a fresh docker-compose stack with the echo worker and verifies:

1. Broker image builds
2. `GET /health` returns `ok`
3. Echo worker registers and reports `online`
4. `POST /tasks` is accepted (`status: queued`)
5. Task transitions to `succeeded` with result
6. Audit trail contains: `task.created`, `task.claimed`, `task.started`, `task.succeeded`
7. Optional SQLite/WAL persistence mode can be exercised by setting `BROKER_PERSISTENCE_BACKEND=sqlite`. In SQLite mode, the compose gate also runs the runtime-image JSON export script, verifies the exported snapshot contains the seeded task, executes runtime-image SQLite task/audit/worker retention planning plus hot-table pruning proofs, confirms hinted writes cover all 9 mirrored hot tables, proves diagnostics read hot task/tombstone/worker/audit context through `/tasks/:id/diagnostics` and `/tasks/diagnostics`, and checks Round 35 task/worker/audit/tombstone runtime repository writes can be read back from reopened SQLite hot tables.
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

SQLite mode should include these human-readable summary lines:

```text
sqlite hinted writes: 9/9 tables covered
sqlite diagnostics: hot task/tombstone/worker/audit covered (4/4 tables)
sqlite runtime repositories: task/worker/audit/tombstone write/read covered
```

## Expected Artifacts

| Gate | Artifact |
|------|----------|
| Compose smoke | Clean base audit trail plus approval lifecycle proof in JSON output |
| Restart recovery | Audit trail including `task.requeued`, status progression |

## When to Stop vs Escalate

**Stop at the gate (green):**
- Both gates pass → broker is technically ready for a normal release cut
- Compose smoke passes but recovery is skipped → acceptable for non-production cuts where restart behavior hasn't changed
- Public/stable readiness still requires `docs/public-stable-readiness.md`; do not treat a green script alone as approval to change visibility, publish, deploy production, restart Gateway, send live Telegram traffic, mutate DB rows, or ACK terminal outbox rows

**Escalate to fuller tests:**
- Either gate fails → do not merge, investigate using the failure triage in [smoke-compose.md](smoke-compose.md) and [restart-recovery-smoke.md](restart-recovery-smoke.md)
- Audit trail has unexpected events → check broker logs for state-machine regressions
- Flaky timing failures → increase `SMOKE_TIMEOUT_MS` or check system load

## Relationship to Existing Docs

This gate is the **operator-facing entry point**. The underlying details remain in:
- `docs/smoke-compose.md` — compose smoke reference
- `docs/restart-recovery-smoke.md` — recovery drill reference
- `docs/terminal-notifications-release-smoke.md` — terminal notification release smoke, Telegram-safe dry-run, auth/rate-limit checks, and rollback steps
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
