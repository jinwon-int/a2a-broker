# Terminal Brief activation gate report

Issue: [#385](https://github.com/jinwon-int/a2a-broker/issues/385)  
Parent: [#383](https://github.com/jinwon-int/a2a-broker/issues/383)

This is the repeatable **no-live/read-only** report for Terminal Brief activation. It keeps the activation gates separate so a provider send success cannot be mistaken for an operator-visible receipt or a terminal-outbox ACK.

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
  --code-merged-evidence=https://github.com/jinwon-int/a2a-broker/pull/219
```

Optional evidence flags:

- `--code-merged-evidence=<http-url>`
- `--production-deployed-evidence=<http-url>`
- `--provider-send-evidence=<http-url>`
- `--operator-receipt-evidence=<http-url>`
- `--terminal-ack-evidence=<http-url>`

Expected gate semantics:

| Gate | Meaning | Does not prove |
| --- | --- | --- |
| Code merged | Relevant code landed in the repository. | Production deploy, provider send, receipt, or ACK. |
| Production deployed | The merged code is present on the live production broker/runner lane. | Provider send, operator-visible receipt, or ACK. |
| Live provider send attempted | A live notification/provider send was attempted after explicit approval. | Operator-visible receipt or terminal ACK. |
| Operator-visible receipt proven | A receipt was independently visible to the operator or provider-delivery receipt exists. | Terminal ACK. |
| Terminal ACK performed | The terminal-outbox ACK was performed with allowed receipt evidence. | Earlier gates unless their own evidence is present. |

The report returns `Block` until all five gates have bounded HTTP evidence and no separation warnings are present. It is still a successful no-live validation artifact when it blocks activation because evidence is missing.

Validation:

```bash
npm run test:terminal_brief_activation_report
npm run terminal_brief_activation_report -- --markdown
```
