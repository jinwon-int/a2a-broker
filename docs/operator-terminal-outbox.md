# Operator Terminal Outbox Contract

The broker projects terminal task lifecycle events into a compact `task.terminal` outbox for an external notifier such as `seoseo/OpenClaw` `plugin-notifier`.

The broker does **not** call Telegram, OpenClaw main-session delivery, or any other operator transport directly. It only exposes replayable, operator-safe records; the notifier owns polling/SSE consumption, dedupe, acknowledgement, and Telegram/main-session push.

## Record shape

Each outbox record contains only:

- stable `id` for notifier dedupe and replay cursors
- `kind: "task.terminal"`
- source `taskEventId`
- `createdAt`, `ackState` (`pending` or `receipt_confirmed`), optional `deliveredAt`/`receipt`, and `attempts`
- `payload` with `taskId`, terminal `status`, optional `worker`, timestamps, optional GitHub `repo`/`issue`, safe HTTP evidence URLs (`prUrl`, `doneUrl`, `blockUrl`), and a short redacted summary

Records must not include raw logs, secrets, prompts, session transcripts, arbitrary payload fields, or private local paths.

## HTTP adapter for plugin/OpenClaw notifiers

A notifier can consume the broker-owned outbox without subscribing to raw task state:

- `GET /a2a/tasks/terminal-outbox?after_id=<cursor>&limit=<n>` returns `{ kind, count, cursor, events }`.
- Save the response `cursor` (or the last event `id`) and pass it as `after_id` on the next poll.
- `POST /a2a/tasks/terminal-outbox/ack` requires receipt evidence, for example `{ "id": "...", "deliveredAt": "...", "receipt": { "kind": "operator_visible", "at": "...", "channel": "operator-terminal", "ref": "message-id" } }`.
- The broker rejects false terminal acknowledgements based only on Gateway/provider send success. Receipt `kind` must be `operator_visible` or `operator_confirmed`.
- Both routes require an authenticated hub/operator requester when edge identity enforcement is enabled.

## Release/deploy readiness smoke

Before any live deploy, run the broker-side dry-run smoke first; it does not send Telegram messages or deploy services:

```sh
npm run smoke:docker-broker -- --dry-run
```

For a post-approval live validation, operators can use `npm run smoke:docker-broker -- --live` or the fleet variant from `docs/docker-broker-live-smoke.md`. Do not run live smokes or deploy without explicit operator approval.

## Replay, ack, and retention

- Consumers replay with `subscribe({ afterId })`; HTTP consumers pass the same stable cursor as `after_id`.
- Records after the stable cursor are returned in insertion order; unknown/stale cursors replay retained records from the beginning.
- Retained outbox records are included in broker state version 8 snapshots as `terminalOutbox`, so replay cursors, acknowledgements, and dedupe IDs survive JSON/SQLite snapshot restart.
- `acknowledge(id, { deliveredAt, receipt })` moves `ackState` from `pending` to `receipt_confirmed` only when the receipt represents operator-visible evidence; provider/Gateway send-success receipts are rejected and do not advance state.
- Duplicate enqueue of the same terminal task state returns the retained record or is suppressed if recently seen.
- Retention is bounded by `maxTerminalTaskOutboxEvents` (default `1000`), evicting oldest records FIFO.

## Noise exclusion

Only terminal task lifecycle transitions (`task.succeeded`, `task.failed`, `task.canceled`) enter the outbox. `worker.heartbeat`, `task.heartbeat`, approval-blocked task creation, and other non-terminal audit noise are excluded.
