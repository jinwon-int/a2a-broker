# Terminal Brief Sidecar Dry-Run Start Approval Request

terminal-brief-sidecar-dry-run-start-approval-request is a source-only
approval request draft packet for a supervised Terminal Brief sidecar dry-run
start.

It consumes an already-built
a2a-broker.terminal-brief-sidecar-preflight-chain-review.packet and only becomes
draft-ready when the chain review is ready_for_supervised_dry_run_chain_review.

## Safety Boundary

The packet is not a send, not an approval grant, and not a runtime executor. It
does not dispatch an approval request, grant approval, invoke an executor, spawn
a process, start or stop the sidecar, enable default-on, send providers, ACK
terminal rows, mutate state, restart services, replay history, publish releases,
or move secrets.

Even in approval_request_draft_ready, the next steps are:

- broker-finalizer chooses the adapter and sends the draft as a separate
  approval request;
- explicit operator approval evidence is ingested through a separate path;
- only then can a separately approved executor path be considered.

Provider accepted evidence remains non-visibility and non-ACK evidence.

## Harness Contract

The packet is JSON-only and harness-neutral:

- OpenClaw message send is not required;
- Hermes/Gongyung adapters can render or relay the draft from the same packet;
- external harnesses can consume the same packet without OpenClaw CLI coupling.

## CLI

~~~bash
npm run terminal_brief_sidecar_dry_run_start_approval_request -- \
  --input fixtures/terminal-brief/sidecar-dry-run-start-approval-request.no-live.json \
  --markdown
~~~

Use --json to emit the packet.

## HTTP

~~~text
POST /terminal-brief/sidecar/dry-run-start-approval-request
~~~

The route requires the read role:

~~~text
terminal_brief.sidecar_dry_run_start_approval_request.read
~~~

The response uses cache-control: no-store.

## Non-Goals

- No approval request dispatch.
- No approval grant.
- No start executor dispatch or invocation.
- No process spawn.
- No sidecar start/stop.
- No default-on enablement.
- No provider send.
- No terminal ACK/replay.
- No GitHub, DB, TaskFlow, or terminal receipt mutation.
- No restart/deploy, historical replay, release/publish, or secret movement.
