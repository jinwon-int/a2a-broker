# Docker broker live no-op smoke

Use `scripts/docker-broker-live-smoke.mjs` to repeat the operator Docker broker no-op smoke against the live broker without printing the edge secret.

The script:

- loads the broker edge secret from a local secret file or environment variable
- selects the first online worker from `bangtong,dungae,sogyo,nosuk`, or uses `--worker <id>`
- optionally checks the whole expected worker fleet for registration/status drift with `--fleet` / `--require-workers`
- creates safe `analyze` no-op tasks assigned to selected worker(s)
- waits for claim/start evidence and a terminal task status
- prints compact JSON evidence and exits non-zero unless the required workers are online and all requested smokes succeed

## Dry run

Dry run is the default when `--live` is omitted. It does not contact the broker and does not require a secret.

```bash
npm run smoke:docker-broker -- --dry-run
```

## Live run on seoseo

Run this from the deployed `a2a-broker` checkout on seoseo. Use local deployment values for the broker URL and the local edge-secret file; do not paste the secret itself into the shell history.

```bash
A2A_BROKER_URL="http://127.0.0.1:<broker-port>" \
A2A_EDGE_SECRET_FILE="<local-edge-secret-file>" \
npm run smoke:docker-broker -- --live
```

Optional worker override:

```bash
A2A_BROKER_URL="http://127.0.0.1:<broker-port>" \
A2A_EDGE_SECRET_FILE="<local-edge-secret-file>" \
npm run smoke:docker-broker -- --live --worker bangtong
```

Fleet rollout/drift check:

```bash
A2A_BROKER_URL="http://127.0.0.1:<broker-port>" \
A2A_EDGE_SECRET_FILE="<local-edge-secret-file>" \
npm run smoke:docker-broker:fleet -- --live
```

This verifies `bangtong,dungae,sogyo,nosuk` are all registered online and then runs the no-op smoke once per online worker. Use `--allowed-workers <csv>` to change the smoke target list and `--require-workers <csv>` to make a specific fleet mandatory.

Expected successful output shape:

```json
{
  "mode": "live",
  "ok": true,
  "taskId": "...",
  "workerId": "bangtong",
  "finalStatus": "succeeded",
  "observedStatuses": ["queued", "running", "succeeded"],
  "lifecycle": {
    "claimed": true,
    "started": true,
    "terminal": "succeeded"
  },
  "completedAt": "...",
  "summary": "..."
}
```

`observedStatuses` can skip very short transient states, so the script also checks task audit entries for `task.claimed` and `task.started` before reporting `ok: true`.

Expected fleet output adds drift and per-worker smoke evidence:

```json
{
  "mode": "live-fleet",
  "ok": true,
  "drift": {
    "ok": true,
    "expected": ["bangtong", "dungae", "sogyo", "nosuk"],
    "missing": [],
    "offline": []
  },
  "smokeTargets": ["bangtong", "dungae", "sogyo", "nosuk"],
  "smokes": [
    { "ok": true, "workerId": "bangtong", "taskId": "...", "finalStatus": "succeeded" }
  ]
}
```

Any missing/offline required worker or failed per-worker smoke exits non-zero, giving operators direct Block evidence for live worker drift.
