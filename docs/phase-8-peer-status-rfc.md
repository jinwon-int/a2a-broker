# Phase 8 RFC: `a2a.peer.status` — Read-only peer status RPC

> Status: implemented
> Owner: yukson
> Tracks: jinwon-int/a2a-broker#42, jinwon-int/a2a-broker#180
> Epic: jinwon-int/a2a-broker#39
> Author date: 2026-04-25
> Last revised: 2026-04-30 (#180: busy health, mobile worker mode, mobile-aware thresholds)
> Prereq for rollout: Phase 1–5 baseline green + regression lock held

---

## 1. Motivation

Cross-node coordination currently has no cheap way to ask "are you reachable, busy, stale, or degraded?" without minting a task. This forces two ugly workarounds:

1. Create a throwaway A2A task just to observe the target's liveness — expensive, leaves audit noise.
2. Wait for the next heartbeat — up to 30 min blackout.

Phase 8 introduces a read-only summary RPC so peers can poll each other with minimal overhead. This is a pre-req for the sane operational patterns Phase 6 (Wake-on-Task) and Phase 7 (Live Status Subscribe) want to enable — e.g. a wake sender checking the target is actually reachable before firing.

Non-goals:
- Streaming live status (that is Phase 7).
- Exposing session contents, tool-call detail, or per-task cost (kept out on privacy grounds).

## 2. Shape

### 2.1 Request

```ts
interface PeerStatusRequest {
  target: string;              // canonical node id, e.g. "<worker-a>", "<worker-b>"
  maxCacheAgeMs?: number;      // caller's tolerance for cached answer; default 5000
  verbose?: boolean;           // requires elevated scope; default false
}
```

### 2.2 Response (default summary)

```ts
interface PeerStatusResponse {
  target: string;
  observedAt: number;          // epoch ms when broker computed this view
  cacheAgeMs: number;          // 0 if freshly computed; >0 if served from cache
  gateway: {
    reachable: boolean;
    version?: string;          // e.g. "openclaw 1.x.y"; omitted if unreachable
    mode?: "internal" | "standalone" | "dual";
  };
  worker: {
    registered: boolean;
    lastHeartbeatAt?: number;
    workerMode?: "persistent" | "mobile";
    capacity?: {               // optional, may be null if target does not advertise
      slotsTotal: number;
      slotsBusy: number;
    };
  };
  tasks: {
    active: number;
    queued: number;
    stale: number;             // heartbeat missed past threshold
  };
  health: "ok" | "busy" | "degraded" | "stale" | "unreachable";
  rateLimit?: {
    remaining: number;
    resetAt: number;
  };
}
```

### 2.3 Verbose (behind scope)

When `verbose=true` **and** caller has `a2a.peer.status.verbose` scope, additional fields may be attached:

- `capabilities`: array of plugin ids loaded on the target (no config detail).
- `backpressure`: latest observed queue wait percentiles.

Session text, tool call detail, transcripts, prompts, memory contents, and user identifiers are **never** returned, regardless of scope. Verbose is additive for coarse operational fields only.

### 2.4 Health priority order

The `health` field follows a strict priority (first match wins):

1. `unreachable` – worker not registered at all
2. `stale` – worker heartbeat older than the mode-specific threshold
3. `busy` – all capacity slots occupied (`active + queued >= slotsTotal`)
4. `degraded` – stale tasks exist (claimed/running tasks with missed task heartbeats)
5. `ok` – everything nominal

### 2.5 Worker modes and capacity

Workers declare `workerMode` on registration and heartbeat:

| Mode | Stale threshold (default) | Capacity (slotsTotal) | Use case |
|------|---------------------------|------------------------|----------|
| `persistent` (default) | 90 s | 10 | Always-on VPS / server |
| `mobile` | 30 s | 3 | Battery-powered devices (Android/Termux, laptop) |

Mobile workers use shorter stale thresholds because brief offline windows from device sleep (Doze, network suspend, lid-close) are expected and should not trigger false-positive stale alerts. The reduced capacity (3 slots vs 10) reflects battery and CPU constraints of mobile devices.

A worker with no `workerMode` field is treated as `persistent`.

The broker picks the stale threshold per-worker based on its declared mode at query time.

## 3. Transport

Exposed as a JSON-RPC method on the gateway surface registered by `a2a-broker`:

```
method: a2a.peer.status
params: PeerStatusRequest
result: PeerStatusResponse
```

Registered alongside existing `a2a.task.*` methods in `src/gateway/server-methods/a2a.ts` (OpenClaw side) and served from broker's peer-query module (broker side) depending on `a2a.mode`:

| Mode | Server | Notes |
|------|--------|-------|
| `internal` | OpenClaw gateway directly | aggregates from local `list.ts` + gateway self |
| `standalone` | broker's peer module | aggregates from registered workers + last heartbeats |
| `dual` | broker preferred, fallback to internal | result includes `mode` field so caller can tell |

## 4. Auth & scoping

Two scopes:

| Scope | Grant | Default |
|-------|-------|---------|
| `a2a.peer.status.read` | default summary | auto-granted to any node that already has `a2a.task.request` |
| `a2a.peer.status.verbose` | verbose additive fields | opt-in, must be approved per-peer |

Rationale: peers that can already request tasks can already observe liveness indirectly by making a task round-trip; exposing the summary directly is strictly less expensive and no more revealing. Verbose adds operational metadata (capabilities, backpressure) so it gates separately.

Unauthenticated callers receive `errorCode: "unauthenticated"`. Out-of-scope callers receive `"scope_denied"` with the required scope name.

Compatibility note for the standalone broker rollout:

- requester scopes are currently carried as requester-identity metadata
  (`x-a2a-requester-scopes`, surfaced as `RequesterIdentity.scopes`)
  rather than a separate auth exchange.
- Round 8 enforces `a2a.peer.status.verbose` before honoring
  `verbose=true`.
- The default summary remains the only wire shape emitted today even
  when verbose scope is present; verbose additive fields stay deferred
  until a later contract expansion.

## 5. Caching

Query storms are the primary risk. Policy:

- Broker keeps per-target cache, TTL **5 s** by default (tunable).
- `maxCacheAgeMs` lets caller tighten freshness per call; broker recomputes if cached entry is older than requested.
- `cacheAgeMs` is **always returned** so callers can make their own freshness decisions.
- Cache invalidation is opportunistic: task state mutations on a target bump a `lastKnownMutationAt` that forces recompute on next query.
- Stampede protection: simultaneous recompute requests for the same target coalesce behind a single in-flight computation.

## 6. Rate limiting

Per caller identity (node id):

- Default: **20 req / 10 s window** per (caller, target) pair.
- Burst allowance: up to 5 above window, smoothed.
- Exceeded → `errorCode: "rate_limited"` with `retryAfterMs` and current `rateLimit.resetAt`.
- Global safety cap: no more than 200 recomputes/s across the whole broker; beyond that, all callers served from cache regardless of `maxCacheAgeMs`.

## 7. Privacy

Explicit non-returned fields:

- Session ids, session labels, session transcripts
- Tool call arguments or results
- Prompts, system prompts, memory contents
- User identifiers (telegram ids, usernames)
- Cost figures
- Secrets, tokens, env vars

If a target's own liveness signal would leak any of the above (e.g. via queued task titles), that field is either redacted or omitted. This is enforced in the summary projection, not left to callers.

## 8. Error model

| Code | Meaning |
|------|---------|
| `ok` | healthy response |
| `unauthenticated` | missing or invalid caller identity |
| `scope_denied` | missing required scope |
| `rate_limited` | caller exceeded window |
| `target_unknown` | target node id not registered |
| `target_unreachable` | broker could not reach target within timeout; partial response with `health: "unreachable"` is still returned, not an error, unless broker itself errors |
| `internal` | broker-side failure |

Note: target unreachability is a **data condition**, not an error — callers should treat `health: "unreachable"` as a valid answer. Errors are reserved for "we could not produce a useful answer at all."

## 9. Observability

- Each call emits an audit event `peer.status.query` with: caller, target, cacheHit, cacheAgeMs, durationMs.
- Broker exports counters: `peer_status_requests_total{caller,target,result}`, `peer_status_cache_hit_ratio`, `peer_status_recompute_duration_ms`.
- Dashboard shows query rate per (caller, target) to catch mis-configured pollers.

## 10. Rollout

1. Land this RFC (docs only).
2. Implement in `a2a-broker` standalone first (mode=standalone path).
3. Implement in `openclaw-plugin-a2a` gateway handler for internal mode.
4. Gate behind feature flag `a2a.peerStatus.enabled=false` by default.
5. Phase 1–5 green → enable on one non-critical node pair (<worker-a> ↔ <worker-b>) for canary.
6. Regression lock on bangtong held throughout; bangtong never serves or polls peer.status until final sign-off.

## 11. Open questions

- Should `target` accept lists (batched query)? Leaning no — callers can fan-out; batched opens surprising fairness issues with rate limits.
- Should response carry a `schemaVersion`? Proposing yes, add `schemaVersion: 1` to all responses.
- Cache TTL of 5 s — do we need per-caller or per-target tuning? Leaning keep global for v1, add per-target override if operational data shows asymmetric load.
- Does `dual` mode need a visible preference knob for operators? Leaning yes but out-of-scope for this RFC.

## 12. Acceptance mapping

From `jinwon-int/a2a-broker#42`:

- [x] RPC schema documented → §2
- [x] Auth/rate-limit behavior defined → §4, §6
- [x] Summary response avoids sensitive task/session text → §7
- [x] Cache age returned to callers → §2.2 (`cacheAgeMs` always present)

From `jinon86/a2a-broker#180`:

- [x] `busy` health state when all capacity slots occupied → §2.2, §2.4
- [x] `workerMode` field (`persistent` | `mobile`) in registration/heartbeat/response → §2.2, §2.5
- [x] Mobile-aware stale threshold (30 s vs 90 s) → §2.5
- [x] Mobile capacity (3 slots vs 10) → §2.5
- [x] Stale-over-busy priority documented → §2.4
- [x] Caller semantics in README → README#peer-status-api

Spec-level checklist satisfied; implementation landed via #182.
