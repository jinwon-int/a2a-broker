# Terminal Brief sidecar approval grant proposal

terminal-brief-sidecar-approval-grant-proposal is a source-only/no-live packet
that consumes accepted review decision evidence and prepares approval grant
proposal metadata for a later separately approved path.

It does not send the approval request, grant approval, execute an approval
grant, dispatch or invoke an executor, spawn a process, start or stop the
sidecar, enable default-on behavior, send providers, ACK terminal rows, mutate
state, restart services, or move secrets.

## Input

- a2a-broker.terminal-brief-sidecar-review-decision-ingestor.packet
- the source packet must be in approved_evidence
- the source packet must have reviewDecisionEvidenceAccepted=true

Accepted review decision evidence is not a grant. It is only the source evidence
required to prepare a grant proposal.

## Output states

- ready_for_grant_proposal_review: grant proposal metadata is ready for broker
  finalizer review.
- waiting_for_review_decision: accepted review decision evidence is missing.
- rejected: the operator rejected the review path.
- more_evidence_requested: the operator requested more evidence.
- stale: review decision evidence is stale or expired.
- conflicting: conflicting review decision evidence is present.
- blocked: source packet violates no-live invariants.

## Safety boundary

The packet always keeps:

- approvalRequestDispatchPermitted=false
- approvalGrantPermitted=false
- approvalGrantExecutionPermitted=false
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
- executesApprovalGrant=false
- dispatchesStartExecutor=false
- invokesExecutor=false
- spawnsProcess=false
- startsSidecar=false
- enablesDefaultOn=false
- executesAction=false

The grant proposal is metadata only. A real approval grant still requires a
separate explicit operator action in a later path.

## CLI

    npm run terminal_brief_sidecar_approval_grant_proposal -- \
      --input fixtures/terminal-brief/sidecar-approval-grant-proposal.no-live.json \
      --json

The CLI exits 0 for ready_for_grant_proposal_review, rejected, or
more_evidence_requested. Waiting, stale, conflicting, and blocked states exit 1.
Usage/parsing errors exit 2.

## Broker route

    POST /terminal-brief/sidecar/approval-grant-proposal

Requester roles: hub or operator.

Action role: terminal_brief.sidecar_approval_grant_proposal.read.

The route is read-only and returns cache-control: no-store.
