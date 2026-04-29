# A2A production stabilization closeout — 2026-04-29

This note records the live production stabilization pass for the Seoyoon A2A
broker and active OpenClaw worker fleet. It is intentionally operational: keep
secrets, private keys, tokens, and raw SSH details out of this file.

## Scope

Active A2A full-handler workers:

- `bangtong`
- `dungae`
- `sogyo`

Explicitly excluded from active all-worker operations:

- `yukson` — old VPS2 / legacy echo-worker remnant. Do not treat it as a
  current full-handler worker unless Seo Jin On makes a new explicit decision.

## Stabilized production shape

### Broker persistence

The production broker now runs on SQLite hot tables rather than JSON-file-only
runtime state:

```bash
BROKER_PERSISTENCE_BACKEND=sqlite
BROKER_SQLITE_FILE=/var/lib/a2a-broker/state.sqlite
BROKER_SQLITE_LOAD_SOURCE=hot-tables
```

Observed public health after the cutover:

- `persistence.kind=sqlite`
- `schemaVersion=8`
- `journalMode=wal`
- `loadSource=hot-tables`
- hot-table coverage: `9/9`, `missingTables=[]`
- hot-table mirror: `ok=true`, `mismatches=[]`

Before the migration, the large JSON audit stream was compacted to the newest
5,000 audit events so the broker could restart and import cleanly. SQLite remains
the live operational backend; the JSON file is a compatibility/import artifact,
not the preferred hot runtime read path.

### Stale reaper threshold

The production stale reaper threshold was raised so long-running worker handler
runs do not get requeued while still inside their expected OpenClaw execution
window:

```bash
STALE_REAPER_OLDER_THAN_SEC=1200
```

Operational intent:

- worker handler timeout window: about `900s`
- broker stale reaper threshold: `1200s`
- reaper interval: `60s`
- max requeue attempts: `5`

This avoids the failure mode where a valid long worker run is requeued and later
collides with a terminal update, producing `409 invalid_transition`-style noise.

### Worker session isolation

The active workers were patched to run A2A tasks in task-scoped ephemeral
OpenClaw sessions instead of reusing a long-lived shared session.

Required behavior for full-handler workers:

- derive an execution session id from the A2A task id, for example
  `a2a-<node>-<task-id>`;
- invoke OpenClaw with that task-specific session id, e.g.
  `openclaw agent --session-id "$SESSION_ID" ...`;
- never process unrelated A2A tasks in the Telegram/direct `main` session;
- avoid appending repeated diagnostics to the same worker session after stale
  requeues or retries.

This is a safety boundary: it prevents session-history leakage across tasks and
reduces the chance of self-reinforcing diagnostic loops after broker retries.

### Reverse proxy / 502 mitigation

During the deployment window, workers saw transient public-route `502 Bad
Gateway` errors while completing or retrying tasks through the public broker
host. The production mitigation was to avoid keepalive amplification on the
broker upstream in the reverse proxy path and then verify public `/health` again.

Operator signal to watch:

```bash
curl -fsS https://broker.seoyoon-family.com/health
```

A healthy post-mitigation broker should return `ok=true` and SQLite hot-table
health, not intermittent 502s.

## Verification evidence

Production health probe on 2026-04-29 KST showed:

```json
{
  "ok": true,
  "service": "a2a-broker",
  "persistence": {
    "kind": "sqlite",
    "loadSource": "hot-tables",
    "schemaVersion": 8,
    "journalMode": "wal",
    "hotEntityHintCoverage": {
      "ok": true,
      "supportedCount": 9,
      "totalCount": 9,
      "missingTables": []
    },
    "hotEntityMirror": {
      "ok": true,
      "mismatches": []
    }
  },
  "staleReaper": {
    "enabled": true,
    "intervalSec": 60,
    "olderThanSec": 1200,
    "maxRequeueAttempts": 5
  }
}
```

Related artifacts from the stabilization pass:

- broker deploy: PR #161 / commit `4156b58`
- latest-broker deploy report: `a2a-broker-pr161-deploy-20260429.json`
- three-node smoke: `a2a-3node-smoke-20260429-final-report.json`
- worker reinstall smoke: `a2a-latest-worker-reinstall-smoke-20260429.json`
- update sweep: `openclaw-update-all-final-20260429.json`

Do not commit those raw local artifact files unless they have been reviewed for
secrets and host-specific noise. This document is the sanitized GitHub record.

## Known remaining issues

- `openclaw status` can still hang or time out on active worker nodes. Treat that
  as an OpenClaw/Gateway status-path issue, not as proof that the A2A broker is
  down.
- `bangtong` previously showed high gateway CPU while status checks hung; keep
  it under observation during long worker runs.
- Old `yukson` broker records may remain visible until they age out or are
  explicitly cleaned. They must not be selected by active all-worker dispatch.
- The worker session-isolation patch is currently an operational runtime
  standard. If the full-handler runtime is promoted into a shared source repo,
  this behavior must become a tested source-level invariant.

## Operator checklist

Before dispatching a broad A2A operation:

1. Confirm active targets are exactly `bangtong`, `dungae`, and `sogyo` unless a
   newer operator decision says otherwise.
2. Confirm broker health:

   ```bash
   curl -fsS https://broker.seoyoon-family.com/health | jq '{ok,persistence,staleReaper}'
   ```

3. Confirm SQLite health shows hot-table coverage `9/9` and no mirror
   mismatches.
4. Confirm `staleReaper.olderThanSec >= 1200` while worker handler timeout stays
   around `900s`.
5. Confirm worker handlers use task-scoped OpenClaw `--session-id` values.
6. Exclude `yukson` from active A2A all-worker operations.
