# Terminal Brief Finalizer Workflow

Issue: `#698`

This source-only/no-live layer converts a Terminal Brief finalizer handoff packet into a broker-finalizer workflow packet. It is the bridge between machine-derived closeout evidence and the single human/broker finalizer decision.

The workflow packet does not post comments, merge PRs, close issues, send providers, ACK terminal rows, create TaskFlow records, restart/deploy services, mutate DB state, publish releases, or touch secrets.

## Inputs

- A Terminal Brief finalizer handoff packet from `terminal_brief_finalizer_handoff`.
- Or the same no-live sidecar integration fixture used to build a handoff packet.

## Output

`npm run terminal_brief_finalizer_workflow -- --input fixtures/terminal-brief/finalizer-workflow.no-live.json --issue-url https://github.com/owner/repo/issues/698 --markdown`

The output includes:

- workflow decision: `ready`, `blocked`, or `waiting`
- current step: `finalizer_review`, `recover_blockers`, or `wait_for_evidence`
- stable workflow idempotency key
- draft-only closeout comment body
- TaskFlow-style state/wait seed with `createRecords=false`
- review items, blockers, and next actions
- explicit approval-sensitive actions excluded

## Safety Semantics

- The closeout comment is draft-only and `postPermitted=false`.
- The TaskFlow seed is a seed only and `createRecords=false`.
- Provider/spool/`produced` receipt state is not terminal ACK, read receipt, or visibility proof.
- Exactly one broker finalizer must decide any GitHub mutation or live operational action.
- Live provider send, terminal ACK/replay, restart/deploy, DB mutation, historical replay, release/tag/publish, and secret movement remain separately approval-gated.

## Example

```text
Ready: terminal-brief finalizer workflow
Mode: read-only/no-live
Parent round: round-698-no-live
Decision: ready step=finalizer_review idempotency=tb-finalizer-workflow:...
TaskFlow seed: createRecords=false currentStep=finalizer_review
Closeout comment: draft-only postPermitted=false
```
