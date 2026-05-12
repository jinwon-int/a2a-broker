# Libero #497/#294 no-go validation matrix

Issue: [#507](https://github.com/jinwon-int/a2a-broker/issues/507)  
Parent: [#504](https://github.com/jinwon-int/a2a-broker/issues/504)  
Source lanes: [#497](https://github.com/jinwon-int/a2a-broker/issues/497), [#294](https://github.com/jinwon-int/a2a-broker/issues/294)

This is the Team2/soonwook Libero validation gate for broker hot-table/OOM risk and receipt/canary safety. It is a no-live validation artifact: it can support PR/Done/Block evidence, but it is not approval to deploy, restart, send providers, ACK terminal rows, mutate production SQLite, rotate secrets, release, or force-push.

## Safety boundary

Default decision is **NO-GO** until every required area has passing evidence and the safety flags below are all false:

- production deploy
- Gateway restart
- live provider or Telegram send
- terminal-outbox ACK
- production DB prune/migration/mutation
- secret or edge-secret change/exposure
- release/community post
- force-push/history rewrite

If a check needs live access that is unavailable in the runner, post `Block` with the exact missing read-only endpoint/evidence. Do not substitute a write, live send, DB mutation, or terminal ACK.

## Regression gates

| ID | Area | Source | Gate | Required proof | NO-GO if |
| --- | --- | --- | --- | --- | --- |
| L1 | Hot-table/OOM bound | #497 | SQLite hot-table startup and steady-state behavior remain bounded under representative historical task, audit, worker, and terminal-outbox rows. | Focused store/build tests or no-live fixtures showing bounded hot-table startup, heap/readiness diagnostics, and no all-history materialization regression. | Startup or health proof requires loading unbounded historical rows, hides heap pressure, or uses `NODE_OPTIONS` as the only mitigation. |
| L2 | Retention hygiene | #497 | Completed tasks, audit events, tombstones, workers, and exchange hot tables have explicit retention or protected-id behavior. | Retention-plan tests and read-only table-count diagnostics; no production prune/migration in validation. | Completed/audit/tombstone rows can grow without a bounded plan, or validation performs a live DB prune/migration. |
| L3 | Terminal-outbox hygiene | #497/#294 | Terminal outbox unacked backlog is observable, replay-safe, and not a memory-pressure blind spot. | `npm run terminal_receipt_gap_matrix`; optional `npm run terminal_outbox_preflight -- --no-live --json`; compact unacked/stale counts when read-only broker access exists. | Unacked rows are hidden, blindly ACKed, pruned without receipt evidence, or replay requires a live provider send. |
| L4 | Receipt semantics | #294 | Provider send acceptance is never operator-visible receipt or terminal ACK evidence. | `npm run receipt_gate_canary`; `npm run terminal_receipt_gap_matrix` covering accepted/sent/provider_sent/timed_out/stale/failed/operator-visible states. | Any provider-send-only state allows ACK, Done evidence, or queue closeout without operator-visible/provider-delivery proof. |
| L5 | Replay-safe canary | #294 | Broker → plugin → worker → result projection can be rehearsed without provider delivery or real terminal ACK. | No-live canary/rehearsal output with `providerCalled=false` and `productionAckAttempted=false` for every step. | The canary path sends provider traffic, mutates broker state, ACKs terminal rows, or cannot replay stale/queued evidence. |
| L6 | Observability/readiness | #497/#294 | Operators can see heap/readiness risk, table counts, queued/blocked/stale tasks, and terminal-outbox gaps before OOM or false closeout. | Health/readiness or report evidence with heap/table/outbox/task-status summaries; explicit read-only snapshot blocker if endpoint access is unavailable. | OOM/receipt gaps require raw DB inspection, private host paths, or live mutation to diagnose. |
| L7 | Evidence hygiene | #497/#294 | Start and PR/Done/Block evidence is compact, secret-safe, and excludes OpenClaw runtime/bootstrap context files. | Issue/PR evidence lists commands, pass/fail results, blockers, and safety flags without raw sessions, secrets, private paths, or `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, or `.openclaw/**` artifacts. | Evidence or branch artifacts include secrets, raw sessions, private paths, OpenClaw bootstrap files, or missing final marker URLs. |

## Focused local validation

Run from this repository checkout:

```sh
npm run build
node --test dist/core/libero-validation-matrix.test.js
npm run receipt_gate_canary
npm run terminal_receipt_gap_matrix
npm run live_readiness_canary -- --no-live --json
npm run terminal_outbox_preflight -- --no-live --json
```

Expected no-live signals include:

- `providerCalled: false`
- `productionAckAttempted: false` or `terminalAckAttempted: false`
- `dbMutationAttempted: false` when present
- synthetic no-live broker checks do not perform broker writes or provider sends

## Evidence templates

```md
Start: validating #497/#294 no-go gates for #507.
Planned checks: build; libero-validation-matrix.test; receipt_gate_canary; terminal_receipt_gap_matrix; live_readiness_canary --no-live; terminal_outbox_preflight --no-live.
Safety: no deploy/restart/live provider send/terminal ACK/DB mutation/secret change/release/force-push.
```

```md
PR: <pr-url>
Evidence: <doc/test paths and command results>
Decision: <GO/NO-GO for validation only>
Safety flags: providerCalled=false; terminalAckAttempted=false; no live sends/restarts/deploys/DB mutations.
Remaining blockers: <none or exact owner/evidence>.
```

```md
Block: <exact blocked command/evidence>
Next owner: <repo#issue or operator>
Safety: no deploy/restart/live provider send/terminal ACK/DB mutation/secret change/release/force-push was performed.
```
