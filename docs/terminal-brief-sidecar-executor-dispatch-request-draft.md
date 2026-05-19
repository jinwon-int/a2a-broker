# Terminal Brief sidecar executor dispatch request draft

This packet is source-only/no-live. It consumes a Terminal Brief sidecar execution-gate final review packet and renders the metadata a broker finalizer would review before any later, separately approved executor dispatcher path.

It does not dispatch or invoke an executor, spawn a process, start or stop the sidecar, enable default-on, send providers, ACK/replay terminal rows, mutate GitHub/DB/TaskFlow state, restart/deploy services, replay history, publish releases, or move secrets.

## Input

- `a2a-broker.terminal-brief-sidecar-execution-gate-final-review.packet`
- optional `executorDispatchRequestDraft` options:
  - `draftOwner`
  - `dispatchRequestReference`
  - `executorAdapterId`

The source packet must be `ready_for_execution_gate_final_review` and must keep all runtime permissions false.

## Output

The output kind is `a2a-broker.terminal-brief-sidecar-executor-dispatch-request-draft.packet`.

Ready state is `dispatch_request_draft_ready`.

The draft includes stable idempotency, dispatch request reference, executor adapter id, metadata-only command shape, env key names only, evidence references, abort conditions, and rollback checklist.

## Safety boundary

The following remain fixed false: approval request dispatch, approval grant, approval grant execution, start executor dispatch, executor invocation, process spawn, sidecar start, default-on, live activation, provider send, terminal ACK, DB mutation, and execution.

Accepted final review evidence is input for a draft only. It is not runtime authorization.

## CLI

`npm run terminal_brief_sidecar_executor_dispatch_request_draft -- --input fixtures/terminal-brief/sidecar-executor-dispatch-request-draft.no-live.json --json`

## Route

`POST /terminal-brief/sidecar/executor-dispatch-request-draft`

The route is read-only and returns `cache-control: no-store`.
