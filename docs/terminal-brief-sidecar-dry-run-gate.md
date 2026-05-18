# Terminal Brief sidecar always-on dry-run gate

terminal-brief-sidecar-dry-run-gate is a source-only/no-live operating gate for
deciding whether Terminal Brief sidecar can be proposed for supervised
always-on dry-run operation.

It does not start the sidecar, enable default-on behavior, send providers, ACK
terminal rows, mutate state, restart services, or move secrets.

## Inputs

- a2a-broker.terminal-brief-sidecar-integration-rehearsal
- optional a2a-broker.terminal-brief-finalizer-approval-status.packet
- operating evidence:
  - cursorPersisted
  - boundedPolling
  - pollIntervalMs
  - maxBatch
  - gatewayReady
  - eventLoopDegraded
  - queueBacklog
  - dryRunOnly
  - operatorEventsCrossBrokersEnabled
  - supervisedSidecar

## Output states

- ready_for_operator_approval: source criteria are met, but start/enable is
  still not performed.
- waiting_for_finalizer_status: the finalizer approval status table is missing
  or not ready.
- waiting_for_operating_evidence: cursor/polling, Gateway load, or supervised
  dry-run evidence is missing or unsafe.
- stale: operating evidence is stale or expired.
- blocked: sidecar rehearsal or finalizer status is blocked.

## Required rows

- sidecar_rehearsal: rehearsal must be candidate, dry-run-only, and no provider
  send or terminal ACK attempt may appear.
- finalizer_status: finalizer approval status must be ready as source-only
  evidence and still keep defaultOnPermitted=false.
- cursor_polling: cursor must be persisted and polling bounded.
- gateway_load: Gateway/event-loop/queue evidence must be fresh and healthy.
- safety_boundary: dry-run-only supervised sidecar mode must be proven and
  cross-broker operatorEvents must remain disabled.

live_activation is always non-ready and non-required because this gate never
enables live/default-on behavior.

## Safety boundary

The packet always keeps:

- alwaysOnDryRunStartPermitted=false
- defaultOnPermitted=false
- liveActivationPermitted=false
- startsSidecar=false
- enablesDefaultOn=false
- grantsApproval=false
- executesAction=false

## CLI

    npm run terminal_brief_sidecar_dry_run_gate -- \
      --input fixtures/terminal-brief/sidecar-dry-run-gate.no-live.json \
      --json

The CLI exits 0 only for ready_for_operator_approval. Waiting, stale, and
blocked states exit 1. Usage/parsing errors exit 2.

## Broker route

    POST /terminal-brief/sidecar/dry-run-gate

Requester roles: hub or operator.

Action role: terminal_brief.sidecar_dry_run_gate.read.

The route is read-only and returns cache-control: no-store.
