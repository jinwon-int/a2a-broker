# Terminal Brief R2 live-readiness go/no-go matrix

Issue: [#386](https://github.com/jinwon-int/a2a-broker/issues/386)
Parent: [#383](https://github.com/jinwon-int/a2a-broker/issues/383)
Run: `terminal-brief-live-readiness-20260505130545`
Worker: `yukson` libero validation lane
Snapshot: `2026-05-05T13:18Z` from bounded GitHub issue/PR metadata plus local no-live broker checks.

This is a conservative validation matrix for A2A Terminal Brief live readiness. It records what is safe to conclude from the R2 evidence available at the snapshot. Open PRs are not counted as merged code, provider send success is not counted as operator-visible receipt proof, and no production/live action is counted without explicit operator approval.

## Safety boundary

This lane did not perform, request, or simulate approval for any of the following:

- production deploy or Gateway restart
- live Telegram/provider send
- production broker/SQLite mutation
- worker service restart or runner rollout
- terminal-outbox ACK

Validation evidence must stay bounded: no secret values, notification targets, raw session dumps, raw task payloads, private paths, or raw logs.

## Evidence snapshot

| Surface | Evidence available at snapshot | Validation impact |
| --- | --- | --- |
| R2 parent dispatch | Parent `#383` dispatched plugin `#220`, broker `#384/#385`, runner `#150`, and this validation lane `#386` under the approval-gated safety boundary. | Dispatch exists, but does not prove readiness. |
| R2 plugin lane | `openclaw-plugin-a2a#220` posted Done plus PR `#221`: <https://github.com/jinwon-int/openclaw-plugin-a2a/issues/220#issuecomment-4379586996>, <https://github.com/jinwon-int/openclaw-plugin-a2a/pull/221>. The Done evidence says no live provider send, DB mutation, Gateway restart, worker rollout, or terminal ACK was performed. | Useful no-live plugin evidence, but PR is open/unmerged and includes workspace context files in addition to code/tests, so code readiness is not go. |
| R2 broker deploy-readiness lane | `a2a-broker#384` posted Done plus PR `#387`: <https://github.com/jinwon-int/a2a-broker/issues/384#issuecomment-4379583957>, <https://github.com/jinwon-int/a2a-broker/pull/387>. Evidence reports build/focused tests/no-live terminal-outbox preflight pass and no live/production action. | Useful no-live broker evidence, but PR is open/unmerged and includes workspace context files in addition to code/docs/tests, so deploy readiness is not go. |
| R2 read-only activation gate lane | `a2a-broker#385` posted Done plus PR `#388`: <https://github.com/jinwon-int/a2a-broker/issues/385#issuecomment-4379590565>, <https://github.com/jinwon-int/a2a-broker/pull/388>. Evidence reports a new no-live activation report that renders Block with live gates pending. | Confirms live gates remain blocked; PR is open/unmerged and includes workspace context files in addition to package/docs/scripts/tests. |
| R2 runner lane | `a2a-docker-runner#150` posted PR `#151`: <https://github.com/jinwon-int/a2a-docker-runner/issues/150#issuecomment-4379588747>, <https://github.com/jinwon-int/a2a-docker-runner/pull/151>. No Done/Block comment was present at the snapshot. | Runner R2 evidence is incomplete. |
| Prior merged plugin/broker/runner prerequisites | Prior `#219/#380/#381/#382/#147/#148/#149` are merged. Current broker checkout `57591f2` matches broker `origin/main`; runner `#149` is merged at runner `main` `bea6afe`. | Useful prerequisite baseline only. Context still reports active worker runner revs at `aa4a227`, so runner `#149` is not proven rolled out. |

## S1-S5 cross-stack validation matrix

| ID | Scenario / surface | Required proof for go | Current proof | Verdict | Next unblocker |
| --- | --- | --- | --- | --- | --- |
| S1 | Broker Terminal Brief event/outbox contract | Merged broker code proves terminal states produce concise PR/Done/Block operator evidence, joins terminal-outbox receipt state, and keeps raw logs/secrets out. | R2 broker PR `#387` and Done evidence exist, but the PR is open/unmerged and includes workspace context files. Local checkout does not contain `#387`. | **NO-GO** | Clean `#387` file set, merge it, then rerun no-live broker gates from updated main. |
| S2 | Plugin notifier live-readiness guard | Merged plugin code proves notification-disabled/no-target/no-route paths fail closed, do not leak targets, and do not treat provider success as receipt. | R2 plugin PR `#221` and Done evidence exist, but the PR is open/unmerged and includes workspace context files. | **NO-GO** | Clean `#221` file set, merge it, then rerun plugin no-live tests. |
| S3 | Runner rollout and Terminal Brief task-report compatibility | Runner PR/Done/Block evidence plus active-fleet rollout proof show bounded task reports, bootstrap-leak guard, and compatibility with broker Terminal Brief fields. | R2 runner PR `#151` exists, but no Done/Block was present. Prior runner `#149` is merged but active workers are still reported at `aa4a227`, not `bea6afe`. | **NO-GO** | Wait for `#150` Done/Block, merge needed runner code, then obtain explicit rollout proof if operator approves. |
| S4 | Production deploy / activation readiness | Read-only activation gate proves deploy prerequisites, queue/fleet state, rollback posture, and live action approval status without mutating production. | R2 activation PR `#388` exists and its Done evidence says the activation report renders Block with all live gates pending. PR is open/unmerged and includes workspace context files. | **NO-GO** | Clean/merge `#388`; keep deploy/Gateway restart approval-gated. |
| S5 | Operator-visible receipt proof and terminal ACK readiness | Evidence proves operator-visible receipt and terminal ACK eligibility. Provider-send-only is rejected as proof; ACK requires receipt-visible or explicit operator proof. | R2 and local evidence consistently report no live send and no terminal ACK. Synthetic/local outbox events remain unacknowledged by design. | **NO-GO** | Require explicit operator approval plus bounded receipt-visible proof before any live send/ACK can be counted. |

## Go/no-go summary by readiness dimension

| Dimension | Decision | Reason |
| --- | --- | --- |
| Code readiness | **NO-GO for cross-stack release** | R2 PRs `#221/#387/#388/#151` are open/unmerged. `#221/#387/#388` also include unintended workspace context files, so they require cleanup before merge/readiness. |
| Production deploy readiness | **NO-GO** | R2 activation evidence explicitly renders Block with live gates pending; no production deploy or Gateway restart was approved or performed. |
| Live provider send readiness | **NO-GO** | Plugin R2 evidence is no-live and route/preflight guarded; no live provider send was approved or attempted. Provider-send success would still not prove receipt. |
| Operator-visible receipt proof | **NO-GO** | Broker/plugin evidence improves receipt-safe projection, but no operator-visible receipt proof exists in R2. |
| Terminal ACK readiness | **NO-GO** | No terminal-outbox ACK was approved or attempted; synthetic events remain unacknowledged. |

Overall decision: **NO-GO for live/production activation**. The safe output for this lane is a Block/waiting evidence report plus this matrix patch, not a final Done claiming readiness.

## Focused local validation output

Commands run from this broker checkout for this lane:

```sh
npm ci
npm run build
npm run terminal_receipt_gap_matrix
npm run live_readiness_canary -- --no-live --json
npm run terminal_outbox_preflight -- --no-live --json
npm test
```

Observed no-live safety signals:

- Initial `npm run build` failed before dependency install because `tsc` was unavailable; `npm ci` installed the declared dependencies and the focused gates were rerun.
- Final `npm run build`: pass.
- Final `npm run terminal_receipt_gap_matrix`: pass; post-cutoff receipt gaps remain operator-visible, replayable, and unacknowledged in the synthetic matrix.
- Final `npm run live_readiness_canary -- --no-live --json`: pass with `brokerHttpRequested=false`, `providerCalled=false`, `dbMutationAttempted=false`, and `terminalAckAttempted=false`.
- Final `npm run terminal_outbox_preflight -- --no-live --json`: pass with `providerCalled=false`, `productionAckAttempted=false`, `brokerHttpRequested=false`, and the synthetic event `ackStatus=unacknowledged`.
- Final `npm test`: pass; 998 tests passed, 0 failed.

## Finalization rule

Do not advance this R2 parent to live send, deploy, operator-visible receipt proof, or terminal ACK until the R2 PRs are cleaned/merged where appropriate, runner rollout is explicitly approved and proven, and an operator explicitly approves any live/production action.
