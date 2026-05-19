# Terminal Brief sidecar dispatcher preflight seal

This packet is source-only/no-live. It consumes a Terminal Brief sidecar executor dispatch request draft and supplied runtime evidence, then renders a sealed preflight envelope for final broker review before any later separately approved dispatcher path.

It does not collect live evidence, dispatch or invoke an executor, spawn a process, start or stop the sidecar, enable default-on, send providers, ACK/replay terminal rows, mutate GitHub/DB/TaskFlow state, restart/deploy services, replay history, publish releases, or move secrets.

## Input

- `a2a-broker.terminal-brief-sidecar-executor-dispatch-request-draft.packet`
- supplied `runtimeEvidence` object
- optional `dispatcherPreflightSeal` options

Runtime evidence is supplied by an approved external path. The route and CLI do not probe Gateway, Telegram, broker state, terminal outbox, or the filesystem.

## Ready Criteria

The seal can reach `dispatcher_preflight_seal_ready` only when:

- dispatch draft is `dispatch_request_draft_ready`;
- runtime evidence is present and fresh;
- Gateway readiness, event-loop, queue backlog, dry-run-only, cursor persistence, bounded polling, secret boundary, operatorEvents scope, terminal evidence path, and rollback path are all proven;
- sealed envelope integrity matches the current dispatch draft.

## Safety Boundary

The following remain fixed false: approval request dispatch, approval grant, approval grant execution, start executor dispatch, executor invocation, process spawn, sidecar start, default-on, live activation, provider send, terminal ACK, DB mutation, and execution.

## CLI

`npm run terminal_brief_sidecar_dispatcher_preflight_seal -- --input fixtures/terminal-brief/sidecar-dispatcher-preflight-seal.no-live.json --json`

## Route

`POST /terminal-brief/sidecar/dispatcher-preflight-seal`

The route is read-only and returns `cache-control: no-store`.
