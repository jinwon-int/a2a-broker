# Terminal Brief sidecar activation receipt ingestor

terminal-brief-sidecar-activation-receipt-ingestor is a source-only/no-live
evidence classifier for the supervised sidecar dry-run activation approval
draft.

It does not send providers, grant approval, start the sidecar, enable
default-on behavior, ACK terminal rows, mutate state, restart services, or move
secrets.

## Inputs

- a2a-broker.terminal-brief-sidecar-activation-approval.packet
- receipt/evidence records:
  - provider_accepted
  - current_session_visible
  - manual_operator_confirmation
  - approval_grant
  - rejected
  - expired
  - conflict

## Output states

- accepted: visibility/manual receipt proof and matching approval_grant evidence
  are present. This is still evidence only.
- insufficient: evidence is missing, or provider acceptance appears without
  visibility/manual receipt proof and matching approval grant.
- stale: evidence is expired or older than the accepted window.
- conflicting: evidence conflicts with the requested action/target, or positive
  and rejected evidence are mixed.
- rejected: the operator rejected the activation request.
- blocked: source packet or evidence violates the no-live contract.

## Safety boundary

The packet always keeps:

- sidecarStartPermitted=false
- defaultOnPermitted=false
- liveActivationPermitted=false
- approvalGrantPermitted=false
- providerSendPermitted=false
- terminalAckPermitted=false
- executionPermitted=false
- grantsApproval=false
- startsSidecar=false
- enablesDefaultOn=false
- executesAction=false

Provider acceptance is not visibility proof. Approval grant evidence is recorded
as evidence only and does not grant approval or execute sidecar start.

## CLI

    npm run terminal_brief_sidecar_activation_receipt_ingestor -- \
      --input fixtures/terminal-brief/sidecar-activation-receipt-ingestor.no-live.json \
      --json

The CLI exits 0 only for accepted evidence. Insufficient, stale, conflicting,
rejected, and blocked states exit 1. Usage/parsing errors exit 2.

## Broker route

    POST /terminal-brief/sidecar/activation-receipt

Requester roles: hub or operator.

Action role: terminal_brief.sidecar_activation_receipt.read.

The route is read-only and returns cache-control: no-store.
