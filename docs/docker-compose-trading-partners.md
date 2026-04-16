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

## Important guardrails

Do not change the example into any of the following:

- a shared writable volume for both `bangtong` and `dengae`
- a writable mount of `bangtong` live workspace into `dengae`
- one combined config volume used by all workers
- one combined artifacts volume without node separation

## Recommended next step after compose

Once worker runtimes exist, each worker should expose only structured actions such as:

- create proposal
- attach artifacts
- run validation
- apply approved proposal locally

Do not expose a generic remote file-write endpoint just because the container has local write access.
