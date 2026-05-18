# Terminal Brief Finalizer Handoff

Issue: `#695`

This is a source-only/no-live layer after the Terminal Brief sidecar integration rehearsal. It converts a sidecar rehearsal closeout candidate into a compact broker-finalizer handoff packet.

The packet is meant for the single broker finalizer. It is not a merge, issue close, comment post, provider send, terminal ACK, restart, deploy, DB mutation, release, or approval.

## Inputs

- Terminal Brief sidecar dry-run spool records.
- Sidecar receipt decisions such as `terminalReceiptStatus=produced`.
- Broker terminal events for worker lanes.
- Final `(N/N)` signals derived by the sidecar integration rehearsal.

## Output

`npm run terminal_brief_finalizer_handoff -- --input fixtures/terminal-brief/finalizer-handoff.no-live.json --broker broker-of-record --finalizer broker-of-record --markdown`

The output includes:

- broker of record and finalizer owner
- `ready`, `blocked`, or `waiting` decision
- stable idempotency key
- source decisions from sidecar integration, final-count closeout, and completion watcher
- worker lanes, evidence URLs, receipt gaps, blockers, and checklist
- closeout draft text that a finalizer can review
- approval-sensitive actions explicitly excluded

## Safety Semantics

- A handoff packet is not the final action.
- A final `(N/N)` signal is a closeout trigger only.
- `produced`, provider accepted, sidecar spool, or provider message IDs are not terminal ACK, read receipt, or visibility proof.
- Exactly one broker finalizer should decide any GitHub mutation or live operational action.
- Live provider send, terminal ACK/replay, restart/deploy, DB mutation, historical replay, release/tag/publish, and secret movement remain separately approval-gated.

## Example

```text
Ready: terminal-brief finalizer handoff
Mode: read-only/no-live
Parent round: round-695-no-live
Finalizer: broker=broker-of-record owner=broker-of-record singleFinalizerRequired=true
Decision: ready idempotency=tb-finalizer-handoff:...
```

The ready state only means the packet is ready for broker review. It does not close the GitHub issue, merge a PR, ACK terminal rows, or send a provider notification.
