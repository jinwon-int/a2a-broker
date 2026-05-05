# Terminal Brief R3 end-to-end go/no-go matrix

Issue: [#392](https://github.com/jinwon-int/a2a-broker/issues/392)
Parent: [#383](https://github.com/jinwon-int/a2a-broker/issues/383)
Run: `terminal-brief-r3-20260505T224116Z`
Worker: `yukson` validation/doc lane
Snapshot: bounded GitHub issue/PR metadata and local no-live broker checks from the R3 assignment window.

This matrix is intentionally conservative. It records only proof that is visible through bounded PR/issue evidence. Provider send success is not counted as operator receipt, receipt is not counted as manual ACK, and ACK is not counted as final no-live restoration.

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
| R3 dispatch | Parent `#383` dispatched R3 lanes for plugin `openclaw-plugin-a2a#225`, broker `#390/#391`, runner `a2a-docker-runner#152`, and this validation lane `#392`. The corrected dispatch records all task IDs as queued and explicitly says live proof/ACK are not authorized. | Dispatch exists, but it is not activation proof. |
| R3 peer lanes | `#225/#390/#391/#152/#392` were Start-only at the snapshot. | Required R3 implementation/evidence lanes are incomplete. |
| Prior broker R2 code | Broker PRs `#387` and `#388` are merged. | Useful prerequisite baseline, but not sufficient for the R3 final gate. |
| Prior plugin code and incident fixes | Plugin PRs `#221/#222/#223/#224` are merged. `#224` adds stale-row suppression, explicit allowlist hook, and a one-shot fuse after the Stage 3 duplicate-send incident. | Important safety prerequisite, but the merged revision still needs an approval-gated canary/live-proof pass. |
| Prior runner code | Runner PR `a2a-docker-runner#151` is merged. | Useful prerequisite baseline, but R3 runner evidence contract `#152` is incomplete. |
| Stage 3 incident evidence | Parent `#383` records that the prior live attempt sent duplicate Telegram Terminal Brief messages from a retained Stage 2 row, was stopped, and was ACKed only after operator-visible confirmation. | Confirms why the final gate must require a fresh/allowlisted one-shot task and separate receipt/ACK/restoration proof. |
| Post-incident safety | Parent `#383` records post-merge safety state after plugin `#224`: `operatorEvents.enabled=false`, notification disabled, and bridge disabled. | Supports no-live restoration after the incident, but not a successful R3 proof. |

## Final activation gate matrix

| ID | Gate | Required proof for GO | Current proof | Verdict | Missing proof / next unblocker |
| --- | --- | --- | --- | --- | --- |
| G1 | Code merged across broker/plugin/runner | Bounded PR/Done evidence shows the required broker, plugin, and runner R3 changes are merged. | Prior prerequisite PRs are merged (`a2a-broker#387/#388`, `openclaw-plugin-a2a#221/#222/#223/#224`, `a2a-docker-runner#151`), but R3 lanes `#225/#390/#391/#152` are Start-only. | **NO-GO** | Complete and merge the R3 plugin/broker/runner lanes or post Block evidence that no code change is needed. |
| G2 | Canary deployed | The merged candidate revision is deployed to the bounded canary/live-proof lane with no production deploy/Gateway restart hidden in this validation lane. | Parent evidence says the plugin canary checkout fast-forwarded to `#224` merge commit and no-live remained off, but no R3 canary deployment/reload proof exists. | **NO-GO** | Operator-approved canary deployment/reload evidence after R3 code is merged. |
| G3 | Operator bridge enabled | Operator explicitly approves and bounded evidence shows the operator bridge/notification path enabled only for the proof window. | Current R3 dispatch explicitly says live proof is not authorized; post-incident state is disabled. | **NO-GO** | Separate operator approval plus bridge-enabled evidence for the proof window. |
| G4 | One-shot fresh task sent | A fresh post-enable task or exact allowlisted outbox/task ID is sent once under the one-shot fuse; retained backlog is blocked. | Prior Stage 3 failed because it reused a retained Stage 2 row. No R3 fresh/allowlisted one-shot send evidence exists. | **NO-GO** | Approval-gated proof using a fresh task or explicit ID allowlist, with max-one-send fuse evidence. |
| G5 | Operator-visible receipt observed | Operator-visible or provider-delivery receipt evidence is recorded independently of send success. | Prior incident had operator-visible confirmation for the duplicate Stage 2 row only. No R3 fresh-task receipt exists. | **NO-GO** | Bounded operator-visible/provider-delivery evidence for the R3 fresh/allowlisted proof task. |
| G6 | Manual ACK recorded | Terminal-outbox ACK is recorded only after G5 receipt evidence and references that evidence. | Prior incident ACKed the duplicate Stage 2 row after operator-visible confirmation. No R3 manual ACK evidence exists and ACK is not authorized in this dispatch. | **NO-GO** | Exact operator approval for the ACK action plus bounded ACK evidence linked to G5. |
| G7 | Final no-live restoration | After proof/ACK, operator bridge and notification delivery are disabled again; no-live state is confirmed. | Post-incident no-live state exists, but it predates a successful R3 proof. | **NO-GO** | Post-R3 proof evidence that bridge/notification delivery returned to disabled/no-live state. |

Overall decision: **NO-GO for final Terminal Brief activation**. The safe output for this lane is this matrix patch plus Block/waiting evidence until R3 peer lanes complete and an operator explicitly approves each live proof/ACK step.

## Approval-gated live-proof checklist

Do not execute these steps from this validation/doc lane. They are the minimum proof sequence for a later operator-approved live gate:

1. Verify R3 broker/plugin/runner PRs are merged and record their PR URLs.
2. With operator approval, deploy/reload the bounded canary candidate; record only a redacted revision/status URL.
3. Confirm terminal-outbox backlog is empty or explicitly blocked unless an exact outbox/task ID is allowlisted.
4. With operator approval, enable the operator bridge/notification path for the proof window.
5. Send exactly one fresh Terminal Brief proof task or one exact allowlisted terminal-outbox item; enforce the one-shot fuse.
6. Record operator-visible/provider-delivery receipt evidence for that same task/item. Do not count provider-send acceptance alone.
7. Only with explicit operator approval for that exact ACK, record terminal-outbox ACK linked to the receipt evidence.
8. Disable bridge/notification delivery again and record final no-live restoration evidence.
9. Re-run the read-only activation report with all seven bounded HTTP evidence URLs.

## Focused validation output

Commands run from this broker checkout for this lane:

```sh
npm run test:terminal_brief_activation_report
npm run terminal_brief_activation_report -- --markdown
```

Expected no-live safety signals:

- The activation report renders `Block` with all seven R3 gates pending when evidence is absent.
- The report safety block states that this report did not deploy, restart Gateway, enable the operator bridge, send a provider notification, mutate production DB state, restart/roll out workers, or ACK terminal-outbox records.
