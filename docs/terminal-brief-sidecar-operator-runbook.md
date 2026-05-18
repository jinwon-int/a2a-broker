# Terminal Brief sidecar operator runbook

This runbook is the operator checklist for moving from source-only Terminal
Brief sidecar readiness toward a future supervised dry-run start and, later, a
separate default-on decision.

It is documentation only. It does not authorize or perform sidecar start,
default-on enablement, provider sends, terminal ACK/replay, runtime restart,
database mutation, historical replay, release, publish, or secret movement.

## Approval boundaries

Treat these as separate approvals:

1. Source-only review of gates and rehearsal packets.
2. Supervised dry-run start executor invocation.
3. Observation-period acceptance.
4. Default-on promotion.

Approval for one stage never implies approval for the next stage. In
particular, a ready terminal_brief_sidecar_executor_invocation_rehearsal packet
is not permission to spawn a process or start sidecar.

## Required source evidence

Before requesting a supervised dry-run start, collect and attach sanitized
evidence for:

- terminal_brief_sidecar_dry_run_gate: ready_for_operator_approval with cursor
  persistence, bounded polling, healthy Gateway load, dry-run-only mode, and
  cross-broker operatorEvents disabled.
- terminal_brief_sidecar_activation_approval: approval request draft for
  approve_supervised_terminal_brief_sidecar_dry_run_start.
- terminal_brief_sidecar_activation_receipt_ingestor: accepted receipt and
  approval evidence. Provider accepted alone is not visibility proof.
- terminal_brief_sidecar_start_executor_gate: ready_for_start_executor_review.
- terminal_brief_sidecar_executor_invocation_rehearsal:
  ready_for_executor_invocation_rehearsal.

All packet paths must keep the no-live fields false, including
startExecutorDispatchPermitted, executorInvocationPermitted,
processSpawnPermitted, sidecarStartPermitted, defaultOnPermitted,
providerSendPermitted, terminalAckPermitted, and executionPermitted.

## Preflight checklist

Run this before any separate approved executor runtime action:

- Confirm the exact Git commit or image digest that would be used.
- Confirm the operator approval reference and approved action.
- Confirm the command shape contains env key names only, never secret values.
- Confirm secrets are loaded only from the approved runtime secret store.
- Confirm Gateway /readyz is healthy.
- Confirm event-loop degradation is false or absent.
- Confirm Telegram liveness is acceptable before and during the run.
- Confirm queue backlog is below the approved limit.
- Confirm sidecar mode is dry-run-only.
- Confirm polling is bounded and cursor persistence is enabled.
- Confirm cross-broker operatorEvents remains disabled unless a separate canary
  explicitly approves it.
- Confirm rollback command/procedure is known before starting.

Abort instead of starting if any check is unknown, stale, or conflicting.

## Supervised dry-run start procedure

This section is a template for a later approved runtime action. Do not run it
from this runbook alone.

1. Announce the approved action and approval reference.
2. Capture current Gateway readiness, event-loop, CPU, queue, and Telegram
   liveness evidence.
3. Start only the supervised dry-run sidecar process/container described by the
   approved metadata-only command shape.
4. Capture process/container id, sanitized command metadata, and dry-run-only
   confirmation.
5. Watch first polling cycle for bounded cursor advance.
6. Verify no provider send, terminal ACK/replay, default-on enablement, DB
   mutation, or historical replay occurs.
7. Stop immediately on any abort condition below.

## Observation window

A dry-run start is not a default-on decision. Observe at least one approved
window before proposing default-on:

- Gateway stays ready.
- Event loop stays non-degraded.
- Queue/backlog does not grow beyond the approved limit.
- Telegram liveness stays acceptable.
- Sidecar remains dry-run-only.
- Cursor persistence survives restart or controlled stop/start.
- No duplicate briefs, provider sends, terminal ACK/replay, or historical
  replay attempts appear.
- Logs and evidence are sanitized and contain no secret values.

## Default-on promotion gate

Default-on requires a fresh approval after the observation window. The approval
request must include:

- dry-run start approval reference;
- observation window start/end;
- Gateway/event-loop/queue/liveness evidence;
- sidecar dry-run-only proof and cursor proof;
- no-send/no-ACK/no-replay evidence;
- rollback rehearsal result;
- operator who will monitor the first default-on interval.

Do not combine dry-run start approval and default-on approval into one step.

## Abort conditions

Stop or do not start when any of these appear:

- Gateway /readyz is unhealthy.
- Event loop is degraded.
- Telegram liveness is delayed or missing beyond the approved threshold.
- Queue backlog exceeds the approved limit.
- Sidecar dry-run-only mode cannot be proven.
- A provider send, terminal ACK/replay, or historical replay is attempted.
- Cursor persistence is missing or resets unexpectedly.
- Cross-broker operatorEvents becomes enabled without a separate canary.
- Secret values appear in logs, command args, packet evidence, or issue/PR
  comments.
- Duplicate sidecar processes or duplicate polling owners are detected.

## Rollback checklist

For supervised dry-run rollback:

1. Stop the sidecar process/container through the approved service/container
   procedure.
2. Preserve sanitized logs, packet ids, cursor values, and observed state.
3. Confirm no provider send happened.
4. Confirm no terminal ACK/replay happened.
5. Confirm no DB migration/prune/replay happened.
6. Confirm Gateway /readyz and event-loop health after stop.
7. Confirm Telegram liveness after stop.
8. Leave default-on disabled.
9. Do not replay historical outbox rows.
10. Open a follow-up issue if rollback found duplicate polling, cursor drift,
    event-loop degradation, or secret leakage.

For default-on rollback, also disable the default-on config flag and restart
only the sidecar component approved for that rollback. Do not restart Gateway
or broker unless separately approved.

## Evidence template

Use sanitized values only.

~~~text
approvalReference:
sourceCommitOrImage:
dryRunGatePacket:
activationApprovalPacket:
activationReceiptPacket:
startExecutorGatePacket:
invocationRehearsalPacket:
gatewayReadyBefore:
eventLoopBefore:
queueBacklogBefore:
sidecarRuntimeId:
dryRunOnlyProof:
cursorBefore:
cursorAfter:
providerSendObserved: false
terminalAckObserved: false
historicalReplayObserved: false
rollbackProcedureVerified:
operator:
notes:
~~~

## Non-actions

This runbook does not grant approval, start sidecar, enable default-on, send
providers, ACK terminal rows, mutate DB/GitHub/TaskFlow state, restart/deploy,
replay history, publish releases, or move secrets.
