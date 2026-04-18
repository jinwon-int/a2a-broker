# Docker Compose example for trading partners

This example shows the intended isolation model for:

- `seoseo` or another host running the broker service
- `bangtong` as the live-trading worker
- `dengae` as the research and backfill worker

Reference file:

- `examples/docker-compose.trading-partners.yml`

## Design intent

The compose example encodes the main operating rules:

- each worker runs in its own container
- each worker gets its own workspace mount
- `bangtong` gets a live workspace mount only
- `dengae` gets a research workspace mount and read-only datasets
- broker storage stays separate from worker storage
- broker persistence is written to `/var/lib/a2a-broker/state.json` by default
- no worker receives direct writable mounts into another worker's local workspace

## Mount rationale

### `bangtong-worker`

Writable:

- `/workspace/live`
- `/artifacts`

Read-only:

- `/config`

This keeps live logic editable only inside the `bangtong` context.

### `dengae-worker`

Writable:

- `/workspace/research`
- `/artifacts`

Read-only:

- `/datasets`

This supports aggressive experimentation while avoiding accidental dataset corruption.

## What to change before real use

Replace these placeholders with your real paths or volume strategy:

- `/srv/trading/bangtong/live`
- `/srv/trading/bangtong/config`
- `/srv/trading/bangtong/artifacts`
- `/srv/trading/dengae/research`
- `/srv/trading/dengae/datasets`
- `/srv/trading/dengae/artifacts`

## Operator smoke status

This compose file is not a turnkey smoke stack.

Current breakpoints:

- `bangtong-worker` uses a placeholder command and does not start `npm run start:worker`
- `dengae-worker` also uses a placeholder command
- the compose file does not seed a task lifecycle by itself
- the `/srv/trading/...` mounts are placeholders that must be replaced before real use

For the operator path that is currently runnable, use `docs/restart-recovery-smoke.md`.

## Important guardrails

Do not change the example into any of the following:

- a shared writable volume for both `bangtong` and `dengae`
- a writable mount of `bangtong` live workspace into `dengae`
- one combined config volume used by all workers
- one combined artifacts volume without node separation

## Recommended next step after compose

Once you have real worker startup commands and local mounts in place, validate the broker separately first:

```bash
cd a2a-broker
npm install
npm run build
npm start
```

Then run the recovery drill from `docs/restart-recovery-smoke.md`.

Once worker runtimes exist, each worker should expose only structured actions such as:

- create proposal
- attach artifacts
- run validation
- apply approved proposal locally

Do not expose a generic remote file-write endpoint just because the container has local write access.
