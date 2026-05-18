# Terminal Brief sidecar approval grant evidence ingestor

terminal-brief-sidecar-approval-grant-evidence-ingestor is a source-only/no-live
packet that consumes an approval grant proposal and classifies claimed grant
evidence for a later execution gate review.

It does not send the approval request, grant approval, execute an approval
grant, dispatch or invoke an executor, spawn a process, start or stop the
sidecar, enable default-on behavior, send providers, ACK terminal rows, mutate
state, restart services, or move secrets.

## Input

- a2a-broker.terminal-brief-sidecar-approval-grant-proposal.packet
- grant evidence records:
  - grant_approved
  - grant_rejected
  - request_more_evidence
  - provider_accepted
  - conflict
  - expired

Accepted grant evidence requires matching grant reference, matching target and
review reference, finalizer id, and operator-visible confirmation. Provider
accepted/send status alone is not visibility proof and is not approval grant
evidence.

## Output states

- grant_evidence_accepted: operator-visible grant evidence was classified.
- grant_rejected: operator/finalizer rejected the grant path.
- more_evidence_requested: more evidence was requested.
- insufficient: no recognized grant evidence is present.
- conflicting: conflicting grant evidence is present.
- expired: evidence is stale or expired.
- waiting_for_grant_proposal: the source proposal is not ready.
- blocked: source proposal violates no-live invariants.

## Safety boundary

The packet always keeps approval request dispatch, approval grant, approval
grant execution, start executor dispatch, executor invocation, process spawn,
sidecar start, default-on, live activation, provider send, terminal ACK,
execution, and DB mutation as false.

Accepted grant evidence is evidence only. It does not execute a grant or
authorize runtime execution.

## CLI

    npm run terminal_brief_sidecar_approval_grant_evidence_ingestor -- \
      --input fixtures/terminal-brief/sidecar-approval-grant-evidence-ingestor.no-live.json \
      --json

The CLI exits 0 for grant_evidence_accepted, grant_rejected, or
more_evidence_requested. Insufficient, waiting, conflicting, expired, and blocked
states exit 1. Usage/parsing errors exit 2.

## Broker route

    POST /terminal-brief/sidecar/approval-grant-evidence

Requester roles: hub or operator.

Action role: terminal_brief.sidecar_approval_grant_evidence.read.

The route is read-only and returns cache-control: no-store.
