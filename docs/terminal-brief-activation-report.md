# Terminal Brief R3 activation gate report

Issue: [#392](https://github.com/jinwon-int/a2a-broker/issues/392)
Parent: [#383](https://github.com/jinwon-int/a2a-broker/issues/383)

This is the repeatable **no-live/read-only** report for the final Terminal Brief activation gate. It keeps the broker/plugin/runner gates separate so a one-shot task or provider-send success cannot be mistaken for operator-visible receipt, manual terminal-outbox ACK, or final restoration to no-live mode.

Safety contract:

- no production deploy
- no Gateway restart
- no live Telegram/provider send
- no production DB mutation
- no worker service restart or runner rollout
- no terminal-outbox ACK
- no raw payloads, raw logs, notification targets, secrets, private paths, or full task bodies

Run:

```bash
npm run terminal_brief_activation_report -- --markdown \
  --code-merged-evidence=https://github.com/jinwon-int/a2a-broker/issues/392#code-merged
```

Optional evidence flags:

- `--code-merged-evidence=<http-url>`
- `--canary-deployed-evidence=<http-url>`
- `--operator-bridge-evidence=<http-url>`
- `--fresh-task-evidence=<http-url>`
- `--operator-receipt-evidence=<http-url>`
- `--manual-ack-evidence=<http-url>`
- `--final-no-live-restoration-evidence=<http-url>`

Backward-compatible aliases are accepted for older callers:

- `--production-deployed-evidence=<http-url>` maps to canary deployment evidence.
- `--provider-send-evidence=<http-url>` maps to one-shot fresh task/send evidence.
- `--terminal-ack-evidence=<http-url>` maps to manual ACK evidence.

Expected gate semantics:

| Gate | Meaning | Does not prove |
| --- | --- | --- |
| Code merged | Required broker/plugin/runner code landed and is linked by bounded PR/Done evidence. | Canary deploy, bridge enablement, task send, receipt, ACK, or restoration. |
| Canary deployed | The merged candidate revision is present on the bounded canary/live-proof lane. | Bridge enablement, task send, receipt, ACK, or restoration. |
| Operator bridge enabled | The operator bridge was explicitly enabled for the proof window. | A fresh task was sent, receipt was observed, or ACK was recorded. |
| One-shot fresh task sent | A fresh/explicitly allowlisted Terminal Brief proof task was sent under the one-shot safety procedure. | Operator-visible receipt or ACK. Provider-send success alone is insufficient. |
| Operator-visible receipt proven | The operator independently observed the Terminal Brief or provider-delivery receipt evidence exists. | Manual terminal-outbox ACK. |
| Manual ACK recorded | A terminal-outbox ACK was manually recorded after receipt evidence. | Final restoration to no-live mode. |
| Final no-live restoration | Operator bridge/provider delivery was disabled again and no-live status was confirmed after the proof. | Earlier gates unless their own evidence is present. |

The report returns `Block` until all seven gates have bounded HTTP evidence and no separation warnings are present. It is still a successful no-live validation artifact when it blocks activation because evidence is missing.

## R9 parent-round projection parity addendum

For Seoseo-owned parent rounds receiving Gwakga handoff child Terminal Briefs, no-live activation evidence must prove:

- projected records preserve `brokerOfRecordId=seoseo`, `originBrokerId=gwakga`, the child worker id, and the parent-round total;
- parent-broker outbox records render compact titles as `A2A Terminal Brief 완료: <worker>(n/7)` only when both numerator and denominator are known;
- notification ownership stays parent-only: the broker exposes replayable outbox/evidence records but does not send providers or ACK terminal rows;
- activation remains blocked until the no-live report links bounded PR/Done/Block evidence and excludes OpenClaw runtime/bootstrap context paths.

Validation:

```bash
npm run test:terminal_brief_activation_report
npm run terminal_brief_activation_report -- --markdown
```
