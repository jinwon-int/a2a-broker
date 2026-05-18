# Terminal Brief sidecar runtime preflight approval

terminal-brief-sidecar-runtime-preflight-approval is a source-only/no-live
approval packet before any supervised Terminal Brief sidecar dry-run runtime
action. It consumes the executor invocation rehearsal and packages the adapter
contract, abort evidence requirements, operator approval metadata, and rollback
checklist.

It does not send the approval request, grant approval, dispatch or invoke an
executor, spawn a process, start or stop the sidecar, enable default-on
behavior, send providers, ACK terminal rows, mutate state, restart services, or
move secrets.

## Input

- a2a-broker.terminal-brief-sidecar-executor-invocation-rehearsal.packet
- optional runtime preflight approval metadata:
  - requestedAction
  - requestedBy
  - operatorTarget
  - approvalReference
  - runtimeWindowMinutes
  - maxRuntimeSeconds
  - maxQueueBacklog
  - requiredAbortEvidence
  - rollbackChecklist

## Output states

- approval_packet_ready: source rehearsal and adapter contract are ready. This
  still does not permit approval dispatch or runtime execution.
- waiting_for_invocation_rehearsal: the source rehearsal is not ready.
- stale: the source rehearsal is stale.
- conflicting: the source rehearsal evidence conflicts.
- rejected: the source rehearsal follows a rejected path.
- blocked: the source rehearsal or adapter contract violates no-live invariants.

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

The adapter contract output is not receipt proof. Provider accepted/send status
is not visibility proof, and this packet does not produce terminal ACK/replay
evidence.

## CLI

    npm run terminal_brief_sidecar_runtime_preflight_approval -- \
      --input fixtures/terminal-brief/sidecar-runtime-preflight-approval.no-live.json \
      --json

The CLI exits 0 only for approval_packet_ready. Waiting, stale, conflicting,
rejected, and blocked states exit 1. Usage/parsing errors exit 2.

## Broker route

    POST /terminal-brief/sidecar/runtime-preflight-approval

Requester roles: hub or operator.

Action role: terminal_brief.sidecar_runtime_preflight_approval.read.

The route is read-only and returns cache-control: no-store.
