# Release Gate — Pre-cut Verification

One command to prove the broker is ready for the next release cut.

## Quick Start

```bash
cd a2a-broker

# Run both gates (compose smoke only — recovery needs a persistent broker)
npm run release_gate

# Run only compose smoke
node scripts/release-gate.mjs --skip-recovery

# Run recovery against a running broker
BROKER_URL=http://127.0.0.1:8787 BROKER_EDGE_SECRET=xxx \
  node scripts/release-gate.mjs --skip-compose

# Run compose smoke on a specific port
PORT=19000 npm run release_gate
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
- `0` — all enabled gates passed
- `1` — one or more gates failed
- `2` — setup error (missing deps, port conflict)

A human-readable summary and a machine-readable JSON block are printed at the end.

## Expected Artifacts

| Gate | Artifact |
|------|----------|
| Compose smoke | Clean audit trail (4 events) in JSON output |
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
