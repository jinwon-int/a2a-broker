# Terminal Brief sidecar executor invocation rehearsal

terminal-brief-sidecar-executor-invocation-rehearsal is a source-only/no-live
rehearsal step after the start executor gate. It consumes a ready start executor
gate and renders the supervised dry-run executor invocation plan without running
anything.

It does not dispatch an executor, spawn a process, start or stop the sidecar,
enable default-on behavior, send providers, ACK terminal rows, mutate state,
restart services, or move secrets.

## Input

- a2a-broker.terminal-brief-sidecar-start-executor-gate.packet
- optional invocation rehearsal metadata:
  - adapterName
  - executorName
  - executorRuntime
  - supervisor
  - commandName
  - commandArgs
  - envKeys
  - healthCheckTarget
  - maxRuntimeSeconds
  - expectedEvidence

## Output states

- ready_for_executor_invocation_rehearsal: the source gate is ready and no
  no-live invariant is violated. This still does not permit executor dispatch.
- waiting_for_start_executor_review: the source gate is not ready for review.
- stale: the source gate is stale.
- conflicting: the source gate evidence conflicts.
- rejected: the source gate follows a rejected activation path.
- blocked: the source gate violates no-live invariants or is blocked.

## Safety boundary

The packet always keeps:

- startExecutorDispatchPermitted=false
- executorInvocationPermitted=false
- processSpawnPermitted=false
- sidecarStartPermitted=false
- defaultOnPermitted=false
- liveActivationPermitted=false
- approvalGrantPermitted=false
- providerSendPermitted=false
- terminalAckPermitted=false
- executionPermitted=false
- dispatchesStartExecutor=false
- invokesExecutor=false
- spawnsProcess=false
- startsSidecar=false
- enablesDefaultOn=false
- executesAction=false

The command shape is metadata only. It may describe the command a later
approved executor would use, but it must not contain secret values and it never
executes that command.

## CLI

    npm run terminal_brief_sidecar_executor_invocation_rehearsal -- \
      --input fixtures/terminal-brief/sidecar-executor-invocation-rehearsal.no-live.json \
      --json

The CLI exits 0 only for ready_for_executor_invocation_rehearsal. Waiting,
stale, conflicting, rejected, and blocked states exit 1. Usage/parsing errors
exit 2.

## Broker route

    POST /terminal-brief/sidecar/executor-invocation-rehearsal

Requester roles: hub or operator.

Action role: terminal_brief.sidecar_executor_invocation_rehearsal.read.

The route is read-only and returns cache-control: no-store.
