# Operator Terminal Outbox Contract

The broker projects terminal task lifecycle events into a compact `task.terminal` outbox for an external notifier such as `seoseo/OpenClaw` `plugin-notifier`.

The broker does **not** call Telegram, OpenClaw main-session delivery, or any other operator transport directly. It only exposes replayable, operator-safe records; the notifier owns polling/SSE consumption, dedupe, acknowledgement, and Telegram/main-session push.

## Record shape

Each outbox record contains only:

- stable `id` for notifier dedupe and replay cursors
- `kind: "task.terminal"`
- source `taskEventId`
- `createdAt`, optional `deliveredAt`, and `attempts`
- `payload` with `taskId`, terminal `status`, optional `worker`, timestamps, optional GitHub `repo`/`issue`, safe HTTP evidence URLs (`prUrl`, `doneUrl`, `blockUrl`), and a short redacted summary

Records must not include raw logs, secrets, prompts, session transcripts, arbitrary payload fields, or private local paths.

## Replay, ack, and retention

- Consumers replay with `subscribe({ afterId })`; records after the stable cursor are returned in insertion order.
- Retained outbox records are included in broker state version 8 snapshots as `terminalOutbox`, so replay cursors, acknowledgements, and dedupe IDs survive JSON/SQLite snapshot restart.
- `acknowledge(id, deliveredAt)` marks delivery metadata without removing the record, so a notifier can recover after a crash until normal retention evicts it.
- Duplicate enqueue of the same terminal task state returns the retained record or is suppressed if recently seen.
- Retention is bounded by `maxTerminalTaskOutboxEvents` (default `1000`), evicting oldest records FIFO.

## Noise exclusion

Only terminal task lifecycle transitions (`task.succeeded`, `task.failed`, `task.canceled`) enter the outbox. `worker.heartbeat`, `task.heartbeat`, approval-blocked task creation, and other non-terminal audit noise are excluded.
