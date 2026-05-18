# Terminal Brief sidecar operator review table

terminal-brief-sidecar-operator-review-table is a source-only/no-live packet
that consumes the adapter handoff approval packet and renders the final
pre-dispatch operator review rows for a future supervised Terminal Brief
sidecar dry-run start approval request.

It does not send the approval request, grant approval, dispatch or invoke an
executor, spawn a process, start or stop the sidecar, enable default-on
behavior, send providers, ACK terminal rows, mutate state, restart services, or
move secrets.

## Input

- a2a-broker.terminal-brief-sidecar-adapter-handoff-approval.packet
- optional operator review metadata:
  - reviewOwner
  - reviewReference
  - requiredDecision
  - reviewRows

## Review rows

The default table includes:

- source_handoff
- adapter
- message_draft
- evidence_bundle
- operator_decision
- approval_boundary
- runtime_boundary
- rollback

Every row is review evidence only. A ready table is still not approval dispatch,
approval grant, provider send, terminal ACK/replay, or runtime execution.

## Output states

- review_table_ready: source adapter handoff is ready. This still does not
  permit approval dispatch or provider send.
- waiting_for_adapter_handoff: the source adapter handoff is not ready.
- stale: the source handoff packet is stale.
- conflicting: the source handoff packet conflicts.
- rejected: the source handoff packet follows a rejected path.
- blocked: the source handoff packet violates no-live invariants.

## Safety boundary

The packet always keeps:

- approvalRequestDispatchPermitted=false
- approvalGrantPermitted=false
- startExecutorDispatchPermitted=false
- executorInvocationPermitted=false
- processSpawnPermitted=false
- sidecarStartPermitted=false
- defaultOnPermitted=false
- liveActivationPermitted=false
- providerSendPermitted=false
- terminalAckPermitted=false
- executionPermitted=false
- dbMutationPermitted=false
- sendsApprovalRequest=false
- grantsApproval=false
- dispatchesStartExecutor=false
- invokesExecutor=false
- spawnsProcess=false
- startsSidecar=false
- enablesDefaultOn=false
- executesAction=false

Provider accepted/send status is not visibility proof, and this packet does not
produce terminal ACK/replay evidence.

## CLI

    npm run terminal_brief_sidecar_operator_review_table -- \
      --input fixtures/terminal-brief/sidecar-operator-review-table.no-live.json \
      --json

The CLI exits 0 only for review_table_ready. Waiting, stale, conflicting,
rejected, and blocked states exit 1. Usage/parsing errors exit 2.

## Broker route

    POST /terminal-brief/sidecar/operator-review-table

Requester roles: hub or operator.

Action role: terminal_brief.sidecar_operator_review_table.read.

The route is read-only and returns cache-control: no-store.
