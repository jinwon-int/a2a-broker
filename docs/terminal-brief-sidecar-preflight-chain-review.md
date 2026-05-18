# Terminal Brief Sidecar Preflight Chain Review

`terminal-brief-sidecar-preflight-chain-review` is the final source-only
review packet before a separately approved Terminal Brief sidecar supervised
dry-run start request.

It consumes an already-built
`a2a-broker.terminal-brief-sidecar-preflight-evidence-collector.packet` and
checks that the no-live packet chain is coherent:

- dry-run start canary plan source is ready;
- preflight collector state is ready;
- collector evidence rows are complete;
- harness contract is neutral and does not require OpenClaw message send;
- approval dispatch/grant remains blocked;
- executor dispatch, process spawn, sidecar start, default-on, provider send,
  terminal ACK, DB mutation, restart/deploy, replay, release, and secret
  movement remain blocked.

## Safety Boundary

The chain review is not an approval request and not a runtime action. It does
not probe Gateway, Telegram, broker queues, or sidecar processes. It only
reviews a supplied collector packet.

Even when the review reaches `ready_for_supervised_dry_run_chain_review`, the
next step is broker-finalizer review followed by a separate explicit operator
approval before any executor dispatch or sidecar dry-run start.

## CLI

```bash
npm run terminal_brief_sidecar_preflight_chain_review -- \
  --input fixtures/terminal-brief/sidecar-preflight-chain-review.no-live.json \
  --markdown
```

Use `--json` to emit the packet.

## HTTP

```text
POST /terminal-brief/sidecar/preflight-chain-review
```

The route requires the read role:

```text
terminal_brief.sidecar_preflight_chain_review.read
```

The response uses `cache-control: no-store`.

## Non-Goals

- No approval request dispatch.
- No approval grant.
- No executor dispatch/invocation.
- No process spawn.
- No sidecar start/stop.
- No default-on enablement.
- No provider send.
- No terminal ACK/replay.
- No DB mutation, restart/deploy, historical replay, release/publish, or secret
  movement.
