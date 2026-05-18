# Terminal Brief sidecar dry-run start canary plan

terminal-brief-sidecar-dry-run-start-canary-plan is a source-only/no-live
approval and canary planning layer after the executor invocation rehearsal.

It renders a draft approval request and a supervised dry-run canary observation
plan. It does not send the approval request, grant approval, dispatch or invoke
an executor, spawn a process, start or stop the sidecar, enable default-on,
send providers, ACK terminal rows, mutate state, restart services, or move
secrets.

## Input

- a2a-broker.terminal-brief-sidecar-executor-invocation-rehearsal.packet
- optional canary planning metadata:
  - requestedAction
  - requestedBy
  - operatorTarget
  - approvalReference
  - canaryWindowMinutes
  - monitorIntervalSeconds
  - maxQueueBacklog
  - evidenceChecklist
  - rollbackChecklist

## Output states

- ready_for_dry_run_start_approval_request: source rehearsal is ready and no
  no-live invariant is violated. This still does not dispatch approval or start
  the sidecar.
- waiting_for_executor_invocation_rehearsal: source rehearsal is not ready.
- stale: source rehearsal is stale.
- conflicting: source rehearsal evidence conflicts.
- rejected: source rehearsal follows a rejected activation path.
- blocked: source rehearsal violates no-live invariants or is blocked.

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
- sendsApprovalRequest=false
- grantsApproval=false
- dispatchesStartExecutor=false
- invokesExecutor=false
- spawnsProcess=false
- startsSidecar=false
- enablesDefaultOn=false
- executesAction=false

## Approval split

This packet can prepare a draft approval request, but it cannot send it. A later
supervised dry-run start canary still requires explicit operator approval.
Default-on promotion requires another approval after observation evidence is
reviewed.

## CLI

    npm run terminal_brief_sidecar_dry_run_start_canary_plan -- \
      --input fixtures/terminal-brief/sidecar-dry-run-start-canary-plan.no-live.json \
      --json

The CLI exits 0 only for ready_for_dry_run_start_approval_request. Waiting,
stale, conflicting, rejected, and blocked states exit 1. Usage/parsing errors
exit 2.

## Broker route

    POST /terminal-brief/sidecar/dry-run-start-canary-plan

Requester roles: hub or operator.

Action role: terminal_brief.sidecar_dry_run_start_canary_plan.read.

The route is read-only and returns cache-control: no-store.
