# Terminal Brief Sidecar Dry-Run Start Approval Receipt Ingestor

terminal-brief-sidecar-dry-run-start-approval-receipt-ingestor is a
source-only/no-live evidence classifier for the supervised Terminal Brief
sidecar dry-run start approval request draft.

It consumes
a2a-broker.terminal-brief-sidecar-dry-run-start-approval-request.packet plus
receipt/approval evidence records.

## Evidence Kinds

- provider_accepted
- current_session_visible
- manual_operator_confirmation
- approval_grant
- rejected
- expired
- conflict

provider_accepted is not visibility proof. Accepted evidence requires
current_session_visible or manual_operator_confirmation plus a matching
approval_grant record.

## Safety Boundary

The ingestor records evidence only. It does not send approval requests, grant
approval, dispatch or invoke executors, spawn processes, start or stop the
sidecar, enable default-on, send providers, ACK terminal rows, mutate state,
restart services, replay history, publish releases, or move secrets.

The packet always keeps:

- approvalRequestDispatchPermitted=false
- approvalGrantPermitted=false
- startExecutorDispatchPermitted=false
- executorInvocationPermitted=false
- processSpawnPermitted=false
- sidecarStartPermitted=false
- defaultOnPermitted=false
- providerSendPermitted=false
- terminalAckPermitted=false
- dbMutationPermitted=false
- executionPermitted=false

## Output States

- accepted: visibility/manual receipt proof and matching approval_grant evidence
  are present. This is still no-live evidence only.
- insufficient: evidence is missing, or provider acceptance appears without
  visibility/manual receipt proof and matching approval grant.
- stale: evidence is expired or older than the accepted window.
- conflicting: evidence conflicts with the requested action/target, or positive
  and rejected evidence are mixed.
- rejected: the operator rejected the request.
- blocked: source packet or evidence violates the no-live contract.

## CLI

~~~bash
npm run terminal_brief_sidecar_dry_run_start_approval_receipt_ingestor -- \
  --input fixtures/terminal-brief/sidecar-dry-run-start-approval-receipt-ingestor.no-live.json \
  --json
~~~

The CLI exits 0 only for accepted evidence. Insufficient, stale, conflicting,
rejected, and blocked states exit 1. Usage/parsing errors exit 2.

## Broker Route

~~~text
POST /terminal-brief/sidecar/dry-run-start-approval-receipt
~~~

Requester roles: hub or operator.

Action role:

~~~text
terminal_brief.sidecar_dry_run_start_approval_receipt.read
~~~

The route is read-only and returns cache-control: no-store.
