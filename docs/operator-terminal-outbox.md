# Operator Terminal Outbox Contract

The broker projects terminal task lifecycle events into a compact `task.terminal` outbox for an external notifier such as `<notifier-host>/OpenClaw` `plugin-notifier`.

The broker does **not** call Telegram, OpenClaw main-session delivery, or any other operator transport directly. It only exposes replayable, operator-safe records; the notifier owns polling/SSE consumption, dedupe, acknowledgement, and Telegram/main-session push.

## Record shape

Each outbox record contains only:

- stable `id` for notifier dedupe and replay cursors
- `kind: "task.terminal"`
- source `taskEventId`
- `createdAt`, explicit notification `receipt`, optional receipt-confirmed `ack`, legacy `deliveredAt` only from older snapshots, and `attempts`
- `payload` with `taskId`, terminal `status`, optional `worker`, timestamps, optional GitHub `repo`/`issue`, safe HTTP evidence URLs (`prUrl`, `doneUrl`, `blockUrl`), and a short redacted summary

Records must not include raw logs, secrets, prompts, session transcripts, arbitrary payload fields, or private local paths.

## HTTP adapter for plugin/OpenClaw notifiers

A notifier can consume the broker-owned outbox without subscribing to raw task state:

- `GET /a2a/tasks/terminal-outbox?after_id=<cursor>&limit=<n>` returns `{ kind, count, cursor, events }`.
- Save the response `cursor` (or the last event `id`) and pass it as `after_id` on the next poll.
- Add `reconcile_unacked=true` after restart or when the notifier suspects a send/ack gap. The broker prepends retained records at/before `after_id` that still lack receipt-confirmed `ack`, then appends newer records. The returned cursor only advances for newer records; retrying an old unacknowledged record never marks the cursor complete by itself.
- `POST /a2a/tasks/terminal-outbox/ack` requires receipt evidence, for example `{ "id": "...", "receipt": { "evidence": "operator_visible", "acknowledgedAt": "...", "receiptId": "message-id" } }`.
- Valid receipt evidence values are `operator_visible`, `operator_confirmed`, and `provider_delivery_receipt`. Gateway/provider send success alone is not terminal ack evidence.
- Receipt status is deliberately separate from task terminal status and provider send status. Broker records use the small vocabulary `accepted`, `started`, `produced`, `provider_sent`, `operator_visible`, `timed_out`, `stale`, and `failed`. A succeeded task with any receipt status other than `operator_visible` still has an operator-visible receipt gap; provider/API send success is recorded as `provider_sent`, not ACKed receipt.
- One-shot live eligibility is stricter than send success: the dry-run projection remains `oneShotLiveEligible=false` until every retained terminal outbox row has manual receipt confirmation (`ack.status=receipt_confirmed`, `receipt.status=operator_visible`, and `ack.evidence`/receipt evidence of `operator_visible` or `operator_confirmed`). Provider send success, `provider_sent`, or `provider_delivery_receipt` alone are blocked evidence and must not be counted as live-send/ACK approval.
- Both routes require an authenticated hub/operator requester when edge identity enforcement is enabled.

## Operator read model

`GET /operator/task-report` includes the same terminal-outbox state in each matching terminal task as `terminalBrief` so operators/plugins do not need to join raw task payloads with outbox rows themselves. The compact brief includes the stable outbox `cursor`, `receiptStatus`, `ackStatus`, optional `ackDecision`/reason, worker/repo/issue/task brief metadata, and the first safe PR/Done/Block evidence URL. The report's top-level `receiptStatus` is derived from the broker outbox when present, so a provider-send-only notification remains visible as `provider_sent` / receipt gap until an operator-visible or provider-delivery receipt ACK is recorded.

Worker assignment SSE (`GET /a2a/workers/{workerId}/assignment-events`) remains a wake hint for queued work only. It is useful for reducing worker polling, but it is not operator-visible receipt evidence and must never be used to ACK terminal-outbox records.

## Broker main vs live container deploy-readiness note

The broker code on `origin/main` can be considered deploy-ready for Terminal Brief only after the local candidate passes build/tests plus the no-live outbox preflight, and the live container image/revision is confirmed to include that same broker commit. If the live container is behind `origin/main`, plugin/operator consumers may see older surfaces even though `main` is ready; close the gap by scheduling a normal broker rollout with operator approval, not by restarting or deploying from this readiness check.

Safe pre-deploy commands:

```sh
npm run build
npm run terminal_outbox_preflight -- --no-live --json
npm run smoke:docker-broker -- --dry-run
```

Rollback plan: keep the previous broker image/tag and SQLite snapshot backup available, stop at the first failed health/outbox/read-model check, and revert to the last known-good broker container through the approved deployment runbook. This note is documentation only; it does not authorize production deploys, Gateway restarts, live provider sends, DB mutation, worker restarts, or terminal-outbox ACKs.

## Release/deploy readiness smoke

Before any live deploy, run the broker-side dry-run smoke first; it does not send Telegram messages or deploy services:

```sh
npm run smoke:docker-broker -- --dry-run
```

For a post-approval live validation, operators can use `npm run smoke:docker-broker -- --live` or the fleet variant from `docs/docker-broker-live-smoke.md`. Do not run live smokes or deploy without explicit operator approval.

For the #241/#168 duplicate Telegram flood closeout, use the receipt-gated canary smoke runbook in [receipt-gated-ack-canary-runbook.md](receipt-gated-ack-canary-runbook.md). It keeps dry-run/manual receipt ACK as the default path and treats any staged live Telegram send as an explicit command-center approval gate.

For the R4 move from manual ACK to automatic current-session-visible receipt ACK, use [terminal-brief-r4-automatic-receipt-ack-runbook.md](terminal-brief-r4-automatic-receipt-ack-runbook.md). It records the backlog drain, one-shot fuse, Gateway restart caveat, manual receipt fallback, automatic receipt contract, supplemental post-dispatch verifier, and go/no-go gates.

For release-gate closeout comments or pre-remediation evidence, generate the read-only terminal receipt report directly from the SQLite hot table:

```sh
npm run terminal_receipt_closeout_report -- --db "$BROKER_SQLITE_FILE" --legacy-residue-cutoff 2026-05-04T07:10:00.000Z
```

The report groups current post-cutoff gaps separately from cutoff-quarantined legacy residue and maps each gap to terminal event id, task event id, task id, terminal status, age, receipt state, and remediation hint. It intentionally excludes raw payloads, secrets, local paths, and evidence bodies; it never sends notifications, mutates SQLite, or writes terminal ACKs.

## Replay, ack, and retention

- Consumers replay with `subscribe({ afterId })`; HTTP consumers pass the same stable cursor as `after_id`.
- Records after the stable cursor are returned in insertion order; unknown/stale cursors replay retained records from the beginning.
- `subscribeWithCursor({ afterId })` / `reconcile({ afterId })` / `reconcile_unacked=true` overlays retained unacknowledged records at or before the cursor, so cursor advancement alone cannot hide an unreceipted terminal notification.
- Manual `acknowledge(id, receipt)` calls are per stable event id. A later reconcile at the saved cursor replays only retained records that still lack receipt-confirmed ack evidence; already acked ids are not replayed, and no response should contain the same id twice.
- Once every id at/before the cursor is receipt-confirmed, reconciling that cursor returns no old records. The cursor remains stable instead of moving backward, preventing notifier ACK/replay loops from generating duplicate Telegram/operator pushes.
- Retained outbox records are included in broker state version 8 snapshots as `terminalOutbox`, so replay cursors, acknowledgements, and dedupe IDs survive JSON/SQLite snapshot restart.
- `POST /a2a/tasks/terminal-outbox/receipt` records non-ACK receipt progress such as `{ "status": "provider_sent" }`, timeouts, staleness, or failures without implying operator visibility.
- `acknowledge(id, receipt)` stores receipt metadata in `ack`, updates the separate `receipt` projection, increments attempts, removes legacy `deliveredAt`, and leaves the record replayable until retention evicts it. `provider_delivery_receipt` maps to `receipt.status=provider_sent`; only `operator_visible` / `operator_confirmed` map to `receipt.status=operator_visible`.
- Older snapshots with `deliveredAt` but no `ack` are migrated to receipt-confirmed ack state on restore.
- Duplicate enqueue of the same terminal task state returns the retained record or is suppressed if recently seen.
- Retention is bounded by `maxTerminalTaskOutboxEvents` (default `1000`), evicting oldest records FIFO.

## Noise exclusion

Only terminal task lifecycle transitions (`task.succeeded`, `task.failed`, `task.canceled`) enter the outbox. `worker.heartbeat`, `task.heartbeat`, approval-blocked task creation, and other non-terminal audit noise are excluded.
