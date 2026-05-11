# Receipt-gate no-live canary matrix

Use this before any production deploy, Gateway restart, live Telegram send, or real terminal-outbox ACK for receipt semantics. It is a deterministic broker-side proof only: it does not call provider APIs and it does not ACK production terminal-outbox rows.

## Run

```sh
npm ci
npm run receipt_gate_canary
npm run receipt_gate_canary -- --json
```

The script is safe to run independently of a pre-existing `dist/` build: it uses the compiled module when present and otherwise falls back to a dependency-free runtime copy of the deterministic matrix. It still remains no-live and deterministic.

For a full pre-deploy check, run the focused test plus the normal CI command:

```sh
npm run build
node --test dist/core/receipt-gate-canary.test.js
node --test scripts/receipt-gate-canary.test.mjs
npm test
```

Attach the command output to the operator/PR evidence comment. A passing matrix reports `Run mode: no-live` and confirms `providerCalled=false` and `productionAckAttempted=false` for every scenario.

## Covered scenarios

- **No notification configured** — hold the terminal event unacked and replayable until a real receipt path exists.
- **Send accepted but no receipt** — send acceptance alone is not ACK evidence; hold unacked.
- **[[#294]] Provider sent, no receipt** — `provider_sent` is send-only success, not delivery receipt evidence. Terminal event remains unacked. `provider_sent ≠ operator-visible ≠ ACK`.
- **[[#294]] Provider accepted, no receipt** — `provider_accepted` is transport ack, not operator-visible confirmation. Terminal event remains unacked. `provider_accepted ≠ operator-visible ≠ ACK`.
- **Receipt confirmed** — only this scenario allows a receipt-confirmed ACK decision in the dry-run model.
- **Send failed** — expose non-delivery evidence and hold unacked.
- **Stale/timed-out** — accepted send exceeded the receipt timeout; keep replayable for reconciliation.
- **[[#294]] Stale receipt blocker** — stale receipt detected without live row mutation; terminal event remains unacked and replayable. No DB mutation performed.
- **[[#294]] Retry/requeue blocker** — retry/requeue candidate detected without receipt evidence; block retry until operator-visible/provider-delivery evidence. No live requeue performed.
- **Duplicate terminal event** — suppress the duplicate notification without a second ACK.

## Receipt vocabulary

| State | Source | ACK decision |
| --- | --- | --- |
| `accepted` | Event accepted by outbox | hold_unacked |
| `provider_sent` | Provider send success | hold_unacked (≠ ACK) |
| `provider_accepted` | Transport-layer ack | hold_unacked (≠ ACK) |
| `operator_visible` | Operator session visibility | eligible → receipt_confirmed |
| `provider_delivery_receipt` | Provider delivery confirmation | receipt_confirmed |

## Broker → Plugin → Worker projection canary

The projection canary models the full broker→plugin→worker→result pipeline:

1. `broker_task_accept` — broker accepts task
2. `plugin_dispatch` — plugin dispatches to worker
3. `worker_claim` — worker claims the task
4. `worker_execute` — worker executes
5. `worker_result` — worker produces result
6. `broker_result_store` — broker stores result
7. `plugin_notify` — plugin prepares notification

Every step is evaluated as a no-live read-only check: no provider calls, no ACK mutations. The `provider_sent`/`provider_accepted` states at any projection step are confirmed non-ACK.

## Safety boundaries

This canary is intentionally pure and deterministic. It must remain safe to run in CI and on an operator laptop without Telegram credentials, broker secrets, database access, service restarts, or live outbox mutation.
