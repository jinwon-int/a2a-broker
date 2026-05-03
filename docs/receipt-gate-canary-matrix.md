# Receipt-gate no-live canary matrix

Use this before any production deploy, Gateway restart, live Telegram send, or real terminal-outbox ACK for receipt semantics. It is a deterministic broker-side proof only: it does not call provider APIs and it does not ACK production terminal-outbox rows.

## Run

```sh
npm ci
npm run build
npm run receipt_gate_canary
npm run receipt_gate_canary -- --json
```

For a full pre-deploy check, run the focused test plus the normal CI command:

```sh
npm run build
node --test dist/core/receipt-gate-canary.test.js
npm test
```

Attach the command output to the operator/PR evidence comment. A passing matrix reports `Run mode: no-live` and confirms `providerCalled=false` and `productionAckAttempted=false` for every scenario.

## Covered scenarios

- **No notification configured** — hold the terminal event unacked and replayable until a real receipt path exists.
- **Send accepted but no receipt** — send acceptance alone is not ACK evidence; hold unacked.
- **Receipt confirmed** — only this scenario allows a receipt-confirmed ACK decision in the dry-run model.
- **Send failed** — expose non-delivery evidence and hold unacked.
- **Stale/timed-out** — accepted send exceeded the receipt timeout; keep replayable for reconciliation.
- **Duplicate terminal event** — suppress the duplicate notification without a second ACK.

## Safety boundaries

This canary is intentionally pure and deterministic. It must remain safe to run in CI and on an operator laptop without Telegram credentials, broker secrets, database access, service restarts, or live outbox mutation.
