# Docker broker live no-op smoke

Use `scripts/docker-broker-live-smoke.mjs` to repeat the operator Docker broker no-op smoke against the live broker without printing the edge secret.

The script:

- loads the broker edge secret from a local secret file or environment variable
- selects the first online worker from `bangtong,dungae,sogyo,nosuk`, or uses `--worker <id>`
- creates a safe `analyze` no-op task assigned to that worker
- waits for claim/start evidence and a terminal task status
- prints compact JSON evidence and exits non-zero unless the task succeeds

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
