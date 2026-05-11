# Terminal receipt cross-broker parity runbook

Issue: [#493](https://github.com/jinwon-int/a2a-broker/issues/493)  
Parent: [a2a-plane#241](https://github.com/jinwon-int/a2a-plane/issues/241)

This is the read-only Team2/Gwakga parity checklist for comparing terminal receipt semantics against Team1/Seoseo during Terminal Brief activation. It is intentionally evidence-first: do not deploy, mutate a production DB, send through a live provider, restart Gateway, or ACK terminal-outbox rows unless a current operator approval explicitly authorizes that exact action.

## Safety contract

- Broker deploys, if later approved, are Docker-only. No system service install/change is part of this checklist.
- Gateway changes, if later approved, are plugin-level bridge config only. No core Gateway config change is part of this checklist.
- Live provider send is limited to the first canary task only and only after operator approval.
- Terminal-outbox ACK requires independent operator-visible/current-session/provider-delivery receipt evidence. Provider send success alone is never ACK evidence.
- Evidence must be sanitized: no secrets, private host paths, raw session dumps, raw terminal payloads, or OpenClaw runtime/bootstrap context files.

## Local broker gates

Run these from the checked-out broker repository before comparing brokers:

```sh
npm ci
npm run receipt_gate_canary -- --json
npm run terminal_outbox_preflight -- --no-live --json
npm run test:receipt_gate_canary_script
npm run build
node --test dist/core/receipt-gate-canary.test.js dist/core/terminal-event-outbox.test.js dist/core/store.test.js dist/server.test.js
```

Expected result:

- `receipt_gate_canary` reports `overallVerdict: "pass"` with `providerCalled=false` and `productionAckAttempted=false` for every scenario.
- `terminal_outbox_preflight -- --no-live --json` reports `providerCalled=false`, `productionAckAttempted=false`, `brokerHttpRequested=false`, and an unacknowledged synthetic terminal event.
- Store/server tests cover the `broker_terminal_outbox` hot table, poll/replay behavior, provider-send-only non-ACK states, and receipt-confirmed ACK evidence requirements.

## Read-only live broker evidence, when endpoints are approved

Use the same commands for both sides and keep outputs as bounded artifacts:

```sh
# Seoseo / Team1
BROKER_URL="$SEOSEO_BROKER_URL" BROKER_EDGE_SECRET="$SEOSEO_EDGE_SECRET" \
  npm run terminal_outbox_preflight -- --json > seoseo-terminal-outbox-preflight.json

# Gwakga / Team2
BROKER_URL="$GWAKGA_BROKER_URL" BROKER_EDGE_SECRET="$GWAKGA_EDGE_SECRET" \
  npm run terminal_outbox_preflight -- --json > gwakga-terminal-outbox-preflight.json
```

For SQLite schema/receipt closeout checks, open snapshots read-only and avoid raw payload capture:

```sh
npm run terminal_receipt_closeout_report -- --db "$SEOSEO_SQLITE_SNAPSHOT" --json > seoseo-receipt-closeout.json
npm run terminal_receipt_closeout_report -- --db "$GWAKGA_SQLITE_SNAPSHOT" --json > gwakga-receipt-closeout.json
```

If either endpoint, edge secret, or read-only SQLite snapshot is unavailable, post Block evidence rather than substituting a live send, DB mutation, or ACK.

## Gwakga ↔ Seoseo parity comparison

Compare only sanitized summaries:

| Check | Seoseo expected | Gwakga expected | Block if |
| --- | --- | --- | --- |
| `/health` | HTTP 200, healthy payload | Same | Either broker is unreachable or unhealthy. |
| terminal-outbox poll | `kind=task.terminal.outbox`, stable event ids, HTTP evidence URLs only | Same | Missing ids, missing worker/task brief/evidence for unacked candidates, or non-HTTP evidence URLs. |
| terminal-outbox replay | `reconcile_unacked=true` replays unacked rows before cursor | Same | Unacked rows disappear only because cursor advanced. |
| receipt vocabulary | `accepted`, `provider_sent`, `provider_accepted`, `current_session_visible`, `operator_visible`, `receipt_confirmed` stay distinct | Same | Provider send/accepted is treated as receipt-confirmed ACK. |
| ACK gate | ACK requires `current_session_visible`, `operator_visible`, `operator_confirmed`, or `provider_delivery_receipt` | Same | ACK is accepted from send success, provider acceptance, raw message id alone, or missing receipt evidence. |
| schema closeout | `broker_terminal_outbox` exists; malformed/legacy rows are summarized without raw payloads | Same | Table missing, invalid payloads, unsafe acknowledged rows, or current post-cutoff gaps without remediation. |
| canary | `receipt_gate_canary` pass, no provider call/ACK attempt | Same | Canary cannot run independently, fails, or reports live side effects. |

## Result policy

- **Done/PR evidence** is appropriate only when both brokers produce matching sanitized pass summaries or the patch improves the no-live verification tooling without claiming live activation.
- **Block evidence** is required if broker URLs/snapshots are unavailable, operator approval for the one-shot canary send is absent, receipt evidence is missing, any live action would be needed to continue, or OpenClaw runtime/bootstrap context files would enter branch artifacts.

This runbook does not itself authorize Docker deployment, Gateway bridge enablement, live provider send, terminal-outbox ACK, production DB mutation, or service restart.
