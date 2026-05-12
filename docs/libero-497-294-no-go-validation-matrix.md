# Libero #497/#294 no-go validation matrix

Issue: [#507](https://github.com/jinwon-int/a2a-broker/issues/507)  
Next-round lane: [#514](https://github.com/jinwon-int/a2a-broker/issues/514)  
Parent: [#504](https://github.com/jinwon-int/a2a-broker/issues/504) / [#511](https://github.com/jinwon-int/a2a-broker/issues/511)  
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

## Closure criteria

#497 and #294 should remain open until these criteria are all backed by no-live or explicitly read-only evidence. Passing one criterion does not override a blocker in another row.

| ID | Source | Closure criterion | Required evidence | Closes when |
| --- | --- | --- | --- | --- |
| C1 | #497 | Hot-table persistence no longer depends on full-history heap residency for normal startup, health, or single-row updates. | Bounded no-live fixture or focused test covering representative task/audit/outbox history and heap/readiness diagnostics. | Evidence proves state growth is bounded by active/recent windows or documented caps, not retained historical row count. |
| C2 | #497 | Retention and cleanup policy is explicit for completed tasks, audit events, tombstones, workers, snapshots, WAL, and terminal outbox rows. | Tests or docs for caps/age windows/protected IDs plus read-only reporting; production cleanup remains separately approved. | Operators can distinguish safe retention, pending cleanup approval, and current unbounded-growth blockers without mutating the live DB. |
| C3 | #294 | Receipt semantics keep provider accepted-send, operator-visible/current-session receipt, and terminal ACK as separate states. | `receipt_gate_canary` and `terminal_receipt_gap_matrix` outputs showing provider accepted/sent never implies ACK or human visibility. | Every terminal closeout path requires ACK-safe receipt evidence or stays pending/blocked with compact evidence. |
| C4 | #294 | Replay/canary paths are duplicate-safe and default no-live, with live provider sends and terminal ACKs opt-in only after separate approval. | No-live canary/preflight output with `providerCalled=false`, `terminalAckAttempted=false`, and duplicate/replay suppression proof. | A stale backlog or rerun cannot produce duplicate provider sends, forged ACKs, or false Done evidence. |
| C5 | #497/#294 | Closure evidence is compact, reproducible, and excludes OpenClaw runtime/bootstrap context files and secrets. | Start plus PR/Done/Block evidence, command results, blocker URLs, and candidate diff checks for runtime/bootstrap path leaks. | The branch/artifact set is free of `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, `.openclaw/**`, raw session dumps, and private-host dumps. |

## No-go traps

Treat any of these as fail-closed signals, even if some local tests pass:

| ID | Area | NO-GO trap | Fail-closed response |
| --- | --- | --- | --- |
| T1 | Receipt semantics | Treating provider accepted-send, Telegram message id, GitHub comment projection, or task success as operator-visible receipt. | Keep the row pending, report the receipt gap, and do not ACK or close #294 from provider-only evidence. |
| T2 | Hot-table memory | Masking hot-table OOM risk with a restart, `NODE_OPTIONS` heap increase, or one clean `/health` sample instead of bounded-state proof. | Mark #497 NO-GO until representative no-live history/churn evidence proves bounded heap/readiness behavior. |
| T3 | Terminal-outbox hygiene | Pruning, expiring, or ACKing unacked terminal-outbox rows as cleanup during validation. | Block and request separate DB cleanup/ACK approval; validation may only report compact read-only counts and IDs when safe. |
| T4 | Replay canary | Using a live provider send, real terminal ACK, or duplicate replay to compensate for missing no-live canary proof. | Stop the lane, keep notification/ACK disabled, and require no-live replay evidence before any new live approval request. |
| T5 | Evidence hygiene | Allowing OpenClaw runtime/bootstrap files, raw session dumps, private host paths, or secret-shaped values into branch diff or artifact evidence. | Fail closed before PR creation and report the exact repo-relative offending paths. |

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
Start: validating #497/#294 no-go gates for #514.
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
