# Terminal Brief Sidecar Preflight Evidence Collector

`terminal-brief-sidecar-preflight-evidence-collector` is a source-only/no-live
packet builder for the Terminal Brief sidecar dry-run path. It consumes the
existing dry-run start canary plan packet and normalizes supplied preflight
evidence for broker-finalizer review.

It does not collect live evidence itself. Callers must supply sanitized
Gateway, queue, Telegram liveness, cursor, polling, sidecar owner,
operatorEvents, dry-run, and secret-boundary evidence.

## Purpose

The collector creates a harness-neutral review packet before any supervised
dry-run sidecar start is requested. This lets OpenClaw, Hermes/Gongyung, or an
external harness present the same evidence shape without binding A2A to
`openclaw message send`.

## Input Evidence

Required supplied evidence:

- Gateway ready timestamp and event-loop degraded flag.
- Queue backlog and observation timestamp.
- Telegram liveness status and last-seen timestamp.
- Cursor persisted flag, cursor value, and cursor observation timestamp.
- Bounded polling settings, including poll interval and max batch.
- Sidecar process count, polling owner, and duplicate-owner flag.
- `operatorEventsCrossBrokersEnabled=false`.
- `dryRunOnly=true` plus no provider send, terminal ACK, DB mutation,
  restart/deploy, or default-on evidence.
- `secretLeakageObserved=false`.

Freshness is evaluated from `observedAt`/`expiresAt` and the collector options.
Missing evidence produces `waiting_for_preflight_evidence`; stale supplied
evidence produces `stale`; degraded Gateway/queue/liveness evidence produces
`degraded`.

## Safety Boundary

This packet always leaves the following false:

- Approval dispatch/grant.
- Start-executor dispatch and executor invocation.
- Process spawn and sidecar start.
- Terminal Brief default-on and live activation.
- Provider send and terminal ACK.
- DB mutation and execution.

It also records that the route is read-only and performs no GitHub mutation,
provider send, terminal ACK, runtime restart/deploy, DB mutation, TaskFlow
record creation, historical replay, release/publish, or secret movement.

## CLI

```bash
npm run terminal_brief_sidecar_preflight_evidence_collector -- \
  --input fixtures/terminal-brief/sidecar-preflight-evidence-collector.no-live.json \
  --markdown
```

Use `--json` to emit the packet.

## HTTP

```text
POST /terminal-brief/sidecar/preflight-evidence-collector
```

The route requires the read role:

```text
terminal_brief.sidecar_preflight_evidence_collector.read
```

The response uses `cache-control: no-store`.

## Non-Goals

- No Gateway, Telegram, broker, queue, or sidecar probing.
- No sidecar process start/stop.
- No Gateway or broker deploy/restart.
- No live provider send.
- No terminal ACK or historical replay.
- No production DB mutation.
- No OpenClaw-specific delivery dependency.
