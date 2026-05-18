# Terminal Brief sidecar activation approval draft

terminal-brief-sidecar-activation-approval is a source-only/no-live packet that
turns a ready sidecar dry-run operating gate into an operator approval request
draft.

It does not send the approval request, grant approval, start the sidecar, enable
default-on behavior, send providers, ACK terminal rows, mutate state, restart
services, or move secrets.

## Input

- a2a-broker.terminal-brief-sidecar-dry-run-gate.packet
- optional approval request options:
  - requestedBy
  - operatorTarget
  - operatorChannel
  - approvalWindowMinutes
  - abortQueueBacklog

## Output states

- approval_request_draft_ready: the dry-run gate is ready and a request draft can
  be dispatched by a separate adapter.
- waiting_for_gate: the dry-run gate is not ready.
- stale: the dry-run gate reports stale operating evidence.
- blocked: the dry-run gate is blocked or violates no-live invariants.

## Safety boundary

The packet always keeps:

- sidecarStartPermitted=false
- defaultOnPermitted=false
- liveActivationPermitted=false
- approvalGrantPermitted=false
- providerSendPermitted=false
- terminalAckPermitted=false
- executionPermitted=false
- sendsApprovalRequest=false
- startsSidecar=false
- enablesDefaultOn=false
- executesAction=false

The packet is a draft only. Explicit operator approval evidence must be ingested
by a separate path before any supervised sidecar dry-run executor can run.

## CLI

    npm run terminal_brief_sidecar_activation_approval -- \
      --input fixtures/terminal-brief/sidecar-activation-approval.no-live.json \
      --json

The CLI exits 0 only for approval_request_draft_ready. Waiting, stale, and
blocked states exit 1. Usage/parsing errors exit 2.

## Broker route

    POST /terminal-brief/sidecar/activation-approval

Requester roles: hub or operator.

Action role: terminal_brief.sidecar_activation_approval.read.

The route is read-only and returns cache-control: no-store.
