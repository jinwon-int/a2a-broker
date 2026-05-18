# Terminal Brief sidecar start executor gate

terminal-brief-sidecar-start-executor-gate is a source-only/no-live final safety
gate before any supervised Terminal Brief sidecar dry-run start executor could
be invoked.

It does not dispatch the executor, start the sidecar, enable default-on
behavior, send providers, ACK terminal rows, mutate state, restart services, or
move secrets.

## Input

- a2a-broker.terminal-brief-sidecar-activation-receipt-ingestor.packet
- optional start executor metadata:
  - requestedExecutor
  - operatorApprovalReference
  - dryRunReason
  - commandName
  - commandArgs
  - envKeys
  - abortQueueBacklog

## Output states

- ready_for_start_executor_review: receipt and approval evidence are accepted,
  but executor dispatch and sidecar start are still not permitted.
- waiting_for_accepted_evidence: accepted receipt/approval evidence is missing.
- stale: receipt evidence is stale.
- conflicting: receipt evidence conflicts.
- rejected: the operator rejected activation.
- blocked: source packet violates no-live invariants or is blocked.

## Safety boundary

The packet always keeps:

- startExecutorDispatchPermitted=false
- sidecarStartPermitted=false
- defaultOnPermitted=false
- liveActivationPermitted=false
- approvalGrantPermitted=false
- providerSendPermitted=false
- terminalAckPermitted=false
- executionPermitted=false
- dispatchesStartExecutor=false
- startsSidecar=false
- enablesDefaultOn=false
- executesAction=false

The command shape is metadata only. It may describe an intended executor command
shape, but it must not contain secret values and it never executes that command.

## CLI

    npm run terminal_brief_sidecar_start_executor_gate -- \
      --input fixtures/terminal-brief/sidecar-start-executor-gate.no-live.json \
      --json

The CLI exits 0 only for ready_for_start_executor_review. Waiting, stale,
conflicting, rejected, and blocked states exit 1. Usage/parsing errors exit 2.

## Broker route

    POST /terminal-brief/sidecar/start-executor-gate

Requester roles: hub or operator.

Action role: terminal_brief.sidecar_start_executor_gate.read.

The route is read-only and returns cache-control: no-store.
