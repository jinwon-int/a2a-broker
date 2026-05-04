# Next-round no-live receipt/canary validation matrix

Issue: [#356](https://github.com/jinwon-int/a2a-broker/issues/356)  
Parent: [#353](https://github.com/jinwon-int/a2a-broker/issues/353)  
Roadmap: [#294](https://github.com/jinwon-int/a2a-broker/issues/294)  
Worker: `yukson` libero validation lane

This is the no-live validation plan for the operator receipt bridge / canary gate round. It is safe to attach to the #356 PR or issue before all implementation PRs exist, then re-run as each linked lane reaches PR/Done evidence.

## Safety boundary

Default validation is read-only or synthetic-fixture only.

Never do these without explicit operator approval:

- production deploys
- Gateway restarts
- live Telegram/provider sends
- terminal-outbox ACKs
- terminal-outbox record mutation or cleanup
- terminal-outbox ACKs inferred from provider-send-only evidence

Read-only live checks may inspect health, queue, worker fleet, and terminal-outbox summaries, but must not call notifier send endpoints or ACK endpoints. If the read-only broker endpoint/secret is unavailable, record `Block` evidence instead of substituting a mutation or a live send.

## Linked lane inputs

| Lane | Repo issue | Required validation input | If unavailable |
| --- | --- | --- | --- |
| Plugin bridge/status | `openclaw-plugin-a2a#213` | PR/Done evidence showing notification-disabled status, stale target handling, and receipt-gated ACK projection without live Telegram sends. | Mark plugin bridge checks `blocked: waiting on #213 PR/Done/Block evidence`. |
| Broker receipt vocabulary / ACK gate | `a2a-broker#354` | PR/Done evidence and focused tests proving provider-send-only states cannot satisfy ACK evidence. | Mark broker ACK gate checks `blocked: waiting on #354 PR/Done/Block evidence`. |
| Queue hygiene / closeout checklist | `a2a-broker#355` | PR/Done evidence with compact queue/worker/closeout reporting and stale/active counts. | Mark queue hygiene checks `blocked: waiting on #355 PR/Done/Block evidence`. |
| Runner task-report evidence | `a2a-docker-runner#135` | PR/Done evidence showing compact canonical PR/Done/Block task-report fields and no per-worker Telegram dependency. | Mark runner evidence checks `blocked: waiting on #135 PR/Done/Block evidence`. |
| Libero validation | `a2a-broker#356` | This matrix plus local no-live command output and before/after queue/fleet read-only snapshots when available. | Post Block with missing command/output and next owner. |

## Matrix

| ID | Surface | No-live proof | Required commands/evidence | Expected result | Blocker condition |
| --- | --- | --- | --- | --- | --- |
| S1 | Broker terminal-outbox receipt vocabulary | Synthetic/unit fixtures plus #354 PR evidence | `npm test`; `npm run receipt_gate_canary`; `npm run terminal_receipt_gap_matrix`; #354 PR/Done link | `accepted`, `sent`/provider-send-only, `timed_out`, `stale`, and `failed` remain distinct from operator-visible/receipt-confirmed ACK; current gaps stay visible/replayable/unacked. | Any provider-send-only path is accepted as ACK evidence, or #354 lacks PR/Done/Block evidence. |
| S2 | Plugin operator bridge status | #213 PR/Done evidence only; no live Telegram send | Plugin lane evidence must show stream/bridge state, disabled notification target state, stale target handling, and receipt-gated ACK eligibility. | Operator can tell what is connected, disabled, pending, stale, and ACK-eligible; notification disabled is safe/fail-closed. | #213 is blocked/missing, or evidence depends on a live Telegram send. |
| S3 | Runner task-report evidence | #135 PR/Done evidence only; no per-worker live notifications | Runner lane evidence must include repo, issue/URL, node/task id, PR/Done/Block marker, compact test summary, and secret-safe diagnostics. | Broker/operator summaries can consume runner evidence without raw logs or live worker Telegram notifications. | #135 is blocked/missing, evidence lacks canonical PR/Done/Block URL, or raw logs/secrets are required. |
| S4 | Queue hygiene and closeout | Read-only summary plus #355 PR/Done evidence | #355 evidence; optional read-only broker queue/fleet snapshot before and after validation. | queued/claimed/running/stale counts are reported before and after; stale/retry/closeout output is compact and secret-safe. | Queue/fleet cannot be read, counts are non-zero without owner/action, or #355 lacks PR/Done/Block evidence. |
| S5 | Live-readiness canary | Local no-live canary | `npm run live_readiness_canary -- --no-live --json`; optionally `npm run terminal_outbox_preflight -- --no-live --json` | JSON reports no provider call, no broker HTTP request for synthetic proof, no DB mutation, and no terminal ACK attempt. | Any no-live report attempts provider send, DB mutation, broker write, or terminal ACK. |
| S6 | Round closeout / #294 advance decision | Aggregate evidence from S1-S5 | Parent #353 lane table; PR/Done/Block links for #213/#354/#355/#135/#356; before/after queue/fleet snapshots if read-only access exists. | #294 may advance only if every lane has PR/Done evidence or an explicit Block with next owner, no live safety boundary was crossed, and post-validation queue/fleet state is understood. | Any lane has no marker evidence, safety boundary is crossed, or remaining blockers are unnamed. |

## Focused local validation commands

Run from the broker repository after applying candidate changes:

```sh
npm test
npm run receipt_gate_canary
npm run terminal_receipt_gap_matrix
npm run live_readiness_canary -- --no-live --json
npm run terminal_outbox_preflight -- --no-live --json
```

Expected safety flags in no-live outputs:

- `providerCalled: false`
- `dbMutationAttempted: false` when present
- `terminalAckAttempted: false` or `productionAckAttempted: false`
- `brokerHttpRequested: false` for synthetic no-live proofs

## Read-only before/after snapshots

When an operator provides read-only broker access, capture these before and after S1-S5:

1. broker `/health` status and persistence/schema summary
2. worker fleet count and enabled/heartbeat state
3. queued/claimed/running/stale task counts
4. terminal-outbox summary buckets only, with no raw payloads or secrets
5. open PR/issue queue for the five lanes under #353

If read-only live access is absent in the runner, do not improvise with writes. Report the local no-live outputs and mark the live snapshot as blocked with the missing endpoint/credential.

## Issue/PR evidence template

Use these concise markers on #356:

```md
Start: validating #353 no-live receipt/canary matrix.
Planned local checks: npm test; receipt_gate_canary; terminal_receipt_gap_matrix; live_readiness_canary --no-live; terminal_outbox_preflight --no-live.
Waiting on linked lane PR/Done/Block evidence: #213, #354, #355, #135.
Safety: no live Telegram send, Gateway restart, production deploy, DB mutation, or terminal ACK.
```

```md
PR: <pr-url>
Tests/smokes: <commands and pass/fail summary>
Lane evidence: <#213/#354/#355/#135 status>
Safety: providerCalled=false; terminalAckAttempted=false; no live sends/restarts/deploys.
Remaining blockers: <none or exact owner/issue>.
```

```md
Block: <exact blocked command/evidence>
Next owner: <repo#issue or operator>
Safety: no live Telegram send, Gateway restart, production deploy, DB mutation, or terminal ACK was performed.
```

```md
Done: no further #356 work remains.
Evidence: <matrix doc/PR + local no-live checks + before/after read-only queue/fleet snapshot or explicit snapshot blocker>
#294 advance: <yes/no, with remaining blockers>.
```
