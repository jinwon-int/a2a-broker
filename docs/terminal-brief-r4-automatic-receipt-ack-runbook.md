# Terminal Brief R4 automatic receipt ACK activation runbook

Issue: [#398](https://github.com/jinwon-int/a2a-broker/issues/398)
Parent: [#383](https://github.com/jinwon-int/a2a-broker/issues/383)
Run: `terminal-brief-receipt-r4-canonical-20260506T004710Z`

This runbook turns the seoseo live proof into the checklist for moving from manual terminal-outbox ACK to automatic ACK based on current-session-visible receipt evidence. It is documentation only: it does not authorize a production deploy, Gateway restart, live provider send, production DB mutation, or terminal-outbox ACK.

## Receipt vocabulary

Keep these states separate in every report, PR, and issue comment:

| State | Meaning | ACK eligible? |
| --- | --- | --- |
| Provider send / `provider_accepted` | Telegram/OpenClaw accepted the outbound send request, or the adapter returned send success. | **No.** This is not operator-visible receipt. |
| Current-session visible / `operator_visible` | The Terminal Brief is rendered in the operator's current session or otherwise has bounded operator-visible proof. | **Yes, if linked to the exact outbox/task id.** |
| Manual operator confirmation / `operator_confirmed` | An operator explicitly confirms the same Terminal Brief was visible, for example the seoseo proof receipt `telegram:7360371189:message:47146`. | **Yes, after explicit approval for that ACK.** |
| Terminal ACK / `receipt_confirmed` | The broker terminal-outbox row is acknowledged with receipt evidence. | Final state; must never be inferred from provider send alone. |

## R4 child lanes and dependencies

| Lane | Issue | Dependency for automatic ACK |
| --- | --- | --- |
| Plugin adapter | [openclaw-plugin-a2a#227](https://github.com/jinwon-int/openclaw-plugin-a2a/issues/227) | Normalize Telegram/current-session visibility into ACK-safe receipt state while keeping `provider_accepted` pending/manual. |
| Telegram/core contract | [a2a-broker#396](https://github.com/jinwon-int/a2a-broker/issues/396) | Locate the outbound result contract and define whether core, Telegram extension, or plugin shim should emit current-session-visible receipt. |
| Broker canary | [a2a-broker#397](https://github.com/jinwon-int/a2a-broker/issues/397) | Prove `provider_accepted` remains unACKed and `operator_visible`/`operator_confirmed` can close ACK. |
| Runner smoke harness | [a2a-docker-runner#154](https://github.com/jinwon-int/a2a-docker-runner/issues/154) | Produce repeatable, bounded Terminal Brief proof artifacts without live ACK unless current-session receipt exists. |
| Activation runbook | [a2a-broker#398](https://github.com/jinwon-int/a2a-broker/issues/398) | Maintain this go/no-go checklist and summarize final approval-gated dependencies. |

## Activation sequence

1. **Backlog drain / replay check**
   - Run read-only terminal-outbox preflight and receipt-gap checks.
   - Current post-cutoff rows must be empty, receipt-confirmed, or explicitly selected by exact allowlist.
   - Historical duplicate/replay candidates must stay suppressed; do not advance cursors as ACK evidence.

2. **Fuse behavior**
   - Confirm the one-shot live fuse blocks repeat sends after a proof send that lacks operator-visible/manual receipt.
   - A retained historical row must not be sent merely because it is still replayable.

3. **Gateway restart caveat**
   - A Gateway/plugin reload may change notifier runtime behavior and cursor state. Treat it as approval-gated operational work, not as part of this doc lane.
   - After any approved restart/reload, rerun read-only backlog/replay checks before sending a new proof.

4. **Manual receipt fallback**
   - If the adapter/core result is only `provider_accepted`, leave the outbox row pending and require manual operator confirmation before ACK.
   - The manual receipt must identify the exact proof task/outbox item and should be recorded as bounded evidence only, not raw logs or session dumps.

5. **Automatic receipt contract**
   - Automatic ACK may be enabled only when the notification path returns current-session-visible receipt (`operator_visible`) or an equivalent ACK-safe signal for the exact terminal outbox id.
   - The contract must make provider send success non-ACKable by construction; `provider_accepted`, `provider_sent`, and generic send success remain pending/manual.

6. **Enablement and restoration**
   - Enable automatic ACK for a bounded proof window only after GO criteria pass.
   - After proof, restore no-live/disabled delivery state and rerun read-only checks showing no duplicate historical replay and no pending unexpected gaps.

## Go/no-go checklist

| Gate | GO requires | NO-GO if |
| --- | --- | --- |
| Child lanes | PR/Done/Block evidence exists for all R4 lanes and required code changes are merged/deployed to the proof candidate. | Any required lane is Start-only or has unresolved Block evidence. |
| Backlog safety | Read-only checks show no unsafely replayable historical backlog, or an exact allowlist is documented. | Current gaps could be replayed or ACKed accidentally. |
| Receipt contract | Tests/proof show `provider_accepted` is pending/manual and current-session-visible receipt is ACK-safe. | Provider send success can be converted to ACK evidence. |
| Fuse | One-shot fuse prevents repeat sends until receipt/ACK handling closes the row. | A missing receipt can trigger duplicate Telegram/operator messages. |
| Operator approval | The operator explicitly approves any live send, Gateway restart/reload, production mutation, and terminal ACK action. | Approval is absent, ambiguous, or bundled with unrelated actions. |
| Evidence hygiene | Evidence is bounded to issue/PR URLs, task/outbox ids, statuses, and redacted summaries. | Secrets, raw logs, private paths, raw payloads, or session dumps are required. |
| Rollback | Previous no-live state and rollback path are known before enabling the proof window. | There is no clear way to disable delivery or recover from duplicate replay. |

Overall decision is **NO-GO** until all gates above pass. A successful provider send alone is still Block evidence for automatic ACK.

## Rollback and no-live dry-run notes

- Prefer `--no-live` or dry-run broker/runner checks before every proof attempt.
- If duplicate historical replay appears possible, stop before live send, keep rows unACKed, and investigate cursor/reconcile state.
- If a proof send occurs but current-session receipt is missing, do not retry automatically; use manual receipt fallback or leave the row pending with Block evidence.
- To roll back, disable the operator bridge/notifier path, return to the last known-good candidate, and rerun read-only terminal-outbox preflight. Do not clear or mutate production outbox rows as a shortcut.
