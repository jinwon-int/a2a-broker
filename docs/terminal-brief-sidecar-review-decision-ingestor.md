# Terminal Brief sidecar review decision ingestor

terminal-brief-sidecar-review-decision-ingestor is a source-only/no-live packet
that consumes the operator review table and classifies operator decision
evidence for a future supervised Terminal Brief sidecar dry-run start path.

It does not send the approval request, grant approval, dispatch or invoke an
executor, spawn a process, start or stop the sidecar, enable default-on
behavior, send providers, ACK terminal rows, mutate state, restart services, or
move secrets.

## Input

- a2a-broker.terminal-brief-sidecar-operator-review-table.packet
- operator decision evidence records:
  - approve
  - reject
  - request_more_evidence
  - provider_accepted
  - conflict
  - expired

Approved evidence requires matching operator target/review reference and an
operator-visible confirmation. Provider accepted/send status alone is not
visibility proof and is not approval evidence.

## Output states

- approved_evidence: operator-visible approve evidence was classified.
- rejected: operator rejected the review path.
- more_evidence_requested: operator requested more evidence.
- insufficient: no recognized decision evidence is present.
- conflicting: conflicting decision evidence is present.
- expired: decision evidence is stale or expired.
- waiting_for_operator_review_table: the source table is not ready.
- blocked: source review table violates no-live invariants.

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

Accepted decision evidence is evidence only. It does not grant approval or
authorize runtime execution.

## CLI

    npm run terminal_brief_sidecar_review_decision_ingestor -- \
      --input fixtures/terminal-brief/sidecar-review-decision-ingestor.no-live.json \
      --json

The CLI exits 0 for approved_evidence, rejected, or more_evidence_requested.
Insufficient, waiting, stale, conflicting, expired, and blocked states exit 1.
Usage/parsing errors exit 2.

## Broker route

    POST /terminal-brief/sidecar/review-decision

Requester roles: hub or operator.

Action role: terminal_brief.sidecar_review_decision.read.

The route is read-only and returns cache-control: no-store.
