# Terminal Brief sidecar adapter handoff approval

terminal-brief-sidecar-adapter-handoff-approval is a source-only/no-live handoff
packet that consumes the runtime preflight approval packet and renders the
adapter-facing approval request draft for a future supervised Terminal Brief
sidecar dry-run start.

It does not send the approval request, grant approval, dispatch or invoke an
executor, spawn a process, start or stop the sidecar, enable default-on
behavior, send providers, ACK terminal rows, mutate state, restart services, or
move secrets.

## Input

- a2a-broker.terminal-brief-sidecar-runtime-preflight-approval.packet
- optional adapter handoff metadata:
  - adapterId
  - deliveryTargetClass
  - operatorTarget
  - handoffReference
  - messageTemplate
  - evidenceBundleReferences
  - operatorDecisionFields

## Output states

- handoff_packet_ready: source runtime preflight approval is ready. This still
  does not permit approval dispatch or provider send.
- waiting_for_runtime_preflight_approval: the source runtime preflight approval
  is not ready.
- stale: the source approval packet is stale.
- conflicting: the source approval packet conflicts.
- rejected: the source approval packet follows a rejected path.
- blocked: the source approval packet violates no-live invariants.

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

The message body is a draft. Adapter output is not receipt proof. Provider
accepted/send status is not visibility proof, and this packet does not produce
terminal ACK/replay evidence.

## CLI

    npm run terminal_brief_sidecar_adapter_handoff_approval -- \
      --input fixtures/terminal-brief/sidecar-adapter-handoff-approval.no-live.json \
      --json

The CLI exits 0 only for handoff_packet_ready. Waiting, stale, conflicting,
rejected, and blocked states exit 1. Usage/parsing errors exit 2.

## Broker route

    POST /terminal-brief/sidecar/adapter-handoff-approval

Requester roles: hub or operator.

Action role: terminal_brief.sidecar_adapter_handoff_approval.read.

The route is read-only and returns cache-control: no-store.
