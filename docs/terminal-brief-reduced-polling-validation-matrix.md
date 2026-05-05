# Terminal Brief reduced-polling validation matrix

Issue: [#379](https://github.com/jinwon-int/a2a-broker/issues/379)  
Parent: [#376](https://github.com/jinwon-int/a2a-broker/issues/376)  
Run: `terminal-brief-stabilization-20260505T122527Z`  
Worker: `yukson` libero validation lane

This matrix is the no-live validation boundary for **A2A Terminal Brief** and reduced worker polling. It is intentionally conservative: when an implementation lane has only Start/queued evidence, the row stays `Interim Block / waiting` instead of being counted as a pass.

## Safety boundary

This validation lane may use local builds, synthetic fixtures, read-only GitHub issue/PR evidence, and no-live broker scripts. It must not do any of the following without explicit operator approval:

- production deploys
- Gateway restarts
- live Telegram/provider sends
- terminal-outbox ACKs
- broker/SQLite production DB mutation
- treating provider send success as operator receipt or terminal ACK evidence

Secret values, host-specific private paths, raw task logs, and raw session dumps are not validation artifacts.

## Current linked-lane evidence snapshot

Snapshot time: `2026-05-05T12:35Z` from GitHub issue evidence only.

| Lane | Required output | Current evidence | Validation state |
| --- | --- | --- | --- |
| Plugin Terminal Brief guard | `jinwon-int/openclaw-plugin-a2a#218` PR/Done/Block proving notification target guard semantics without live sends | Rerun started and literal `Start` posted: <https://github.com/jinwon-int/openclaw-plugin-a2a/issues/218#issuecomment-4379197923> | Interim Block / waiting |
| Broker reduced-polling assignment | `jinwon-int/a2a-broker#377` PR/Done/Block for event-backed assignment, long-poll/SSE, or equivalent reduced polling design | Rerun started and literal `Start` posted: <https://github.com/jinwon-int/a2a-broker/issues/377#issuecomment-4379201653> | Interim Block / waiting |
| Broker audit/health burn-down | `jinwon-int/a2a-broker#378` PR/Done/Block for warning policy, heartbeat ratio, retention, and cleanup posture | Rerun started and literal `Start` posted: <https://github.com/jinwon-int/a2a-broker/issues/378#issuecomment-4379197463> | Interim Block / waiting |
| Runner reduced-polling compatibility | `jinwon-int/a2a-docker-runner#146` PR/Done/Block proving worker-side compatibility and bounded artifact evidence | Rerun started and literal `Start` posted: <https://github.com/jinwon-int/a2a-docker-runner/issues/146#issuecomment-4379207536> | Interim Block / waiting |
| Runner unblockers | Merged runner fixes needed before this rerun | `#147` merged, `#148` rolled out to `bangtong/sogyo/dungae/nosuk/yukson` per parent dispatch: <https://github.com/jinwon-int/a2a-broker/issues/376#issuecomment-4379180016> | Pass as prerequisite only |

## S1-S5 matrix

| ID | Surface | Required proof | Current proof | Verdict | Block / pass condition |
| --- | --- | --- | --- | --- | --- |
| S1 | Broker Terminal Brief output contract | Terminal states `succeeded`, `failed`, `blocked`, and `cancelled` produce concise operator-facing Terminal Brief records with canonical GitHub PR/Done/Block evidence. | Local no-live broker scripts prove canonical terminal evidence handling, but `#377` has not posted PR/Done/Block output for the reduced-polling broker lane. | Interim Block / waiting on `#377` | Pass only after broker lane evidence exists and still preserves canonical evidence URLs without raw logs or secrets. |
| S2 | Plugin guard and notification target safety | Plugin path suppresses idle polling when notification is disabled or no target exists, does not leak notification targets, and does not treat provider send success as operator receipt. | `openclaw-plugin-a2a#218` rerun is Start-only at this snapshot. No plugin PR/Done/Block proof is available for this rerun. | Interim Block / waiting on `openclaw-plugin-a2a#218` | Pass only with plugin evidence showing disabled/no-target behavior and receipt-safe Terminal Brief projection without a live provider send. |
| S3 | Runner output compatibility | Runner task reports remain bounded and canonical while supporting reduced-polling assignment output; no per-worker live notification contract is introduced. | Runner unblockers are rolled out, but `a2a-docker-runner#146` rerun is Start-only at this snapshot. | Interim Block / waiting on `a2a-docker-runner#146` | Pass only with runner PR/Done/Block evidence showing bounded artifacts, canonical task report fields, and no raw secrets/logs/session dumps. |
| S4 | Reduced-polling CPU/syscall acceptance | CPU/syscall evidence must not regress the `#375` mitigation: unchanged heartbeat persistence stays throttled, worker hot-poll query plans avoid SQLite temp b-tree writes, and full hot-task snapshot reads avoid `USE TEMP B-TREE`. | Prior `#375` evidence added task hot-read indexes and schemaVersion 10 after live profiling found `/var/tmp/etilqs_*` writes under polling load. Current `#377/#378/#146` rerun outputs needed to prove the new reduced-polling lane do not reintroduce churn. | Interim Block / waiting on `#377`, `#378`, and `a2a-docker-runner#146` | Pass only when implementation lanes include local test output plus read-only or synthetic CPU/syscall acceptance evidence. If live resampling is required, it remains operator-approval-gated and cannot be substituted with provider send success. |
| S5 | No-live safety gate across broker/plugin/runner | Validation commands must show no live sends, no broker writes, no DB mutation, no Gateway restart/deploy, and no terminal ACK attempt. | Local broker no-live checks pass after `npm run build`: `terminal_receipt_gap_matrix`, `live_readiness_canary -- --no-live --json`, and `terminal_outbox_preflight -- --no-live --json`. Plugin/runner S5 remains pending their rerun evidence. | Broker local pass; cross-stack Interim Block / waiting | Pass only when all lanes report the same safety boundary. Any live provider send, terminal ACK, deploy/restart, DB mutation, secret disclosure, or provider-send-as-receipt claim is a Block. |

## Focused local validation output

Commands run from this broker checkout after `npm ci`:

```sh
npm run build
npm run terminal_receipt_gap_matrix
npm run live_readiness_canary -- --no-live --json
npm run terminal_outbox_preflight -- --no-live --json
npm test
```

Observed local no-live safety flags:

- `terminal_receipt_gap_matrix`: pass; six post-cutoff gaps remain operator-visible, replayable, and unacked; `providerCalled=false`; `productionAckAttempted=false` for every scenario.
- `live_readiness_canary -- --no-live --json`: pass; `brokerHttpRequested=false`; `providerCalled=false`; `dbMutationAttempted=false`; `terminalAckAttempted=false`; synthetic queue counts `queued=0, claimed=0, running=0, stale=0`.
- `terminal_outbox_preflight -- --no-live --json`: pass; `providerCalled=false`; `productionAckAttempted=false`; `brokerHttpRequested=false`; synthetic event remains `ackStatus=unacknowledged`.
- `npm test`: pass; 996 tests passed, 0 failed.

## Finalization rule

This lane must not post a final Done for S1-S5 until `#218`, `#377`, `#378`, and `a2a-docker-runner#146` each have PR/Done/Block evidence. Until then, the correct evidence is an interim Block/waiting report with the local broker no-live results above.
