# SSE Task Subscription Failure-Mode Matrix

**Author:** Gongyung (Android Termux node)
**Issue:** jinwon-int/a2a-broker#10
**Date:** 2026-04-18

## 1. Current Implementation Summary

`GET /a2a/tasks/:id/events` in `src/server.ts` → `handleTaskEventStream()`

| Feature | Status |
|---------|--------|
| SSE headers (`text/event-stream`, `no-cache`, `keep-alive`) | ✅ Present |
| Heartbeat via SSE comments (default 15s) | ✅ Present |
| `x-accel-buffering: no` (nginx proxy) | ✅ Present |
| Initial task snapshot on connect | ✅ Present |
| Real-time updates via `subscribeToTask()` | ✅ Present |
| Auto-close on terminal state | ✅ Present |
| Cleanup on `req.close` / `req.error` | ✅ Present |

## 2. Failure-Mode Matrix

| # | Failure Mode | Trigger | Impact | Severity | Current Mitigation |
|---|-------------|---------|--------|----------|-------------------|
| **F1** | **Idle proxy timeout** | Reverse proxy (nginx, Caddy, Cloudflare) drops connection after N seconds of no data | Client receives no events; subscription dies silently | 🔴 High | `x-accel-buffering: no` (nginx only), heartbeat comments at 15s |
| **F2** | **Mobile network transition** | WiFi ↔ LTE switch, elevator, tunnel | TCP reset; all in-flight events lost | 🔴 High | None — client must poll `GET /tasks/:id` to recover |
| **F3** | **App background / screen off** | Android/iOS kills background TCP after ~30s-5min | Heartbeat stops, proxy eventually times out | 🟡 Medium | Heartbeat timer has `.unref()` — won't keep process alive but connection dies |
| **F4** | **Reconnect with missed events** | Any disconnect + reconnect | Events between disconnect and reconnect are lost permanently | 🔴 High | No `Last-Event-ID` support, no event replay buffer |
| **F5** | **Proxy buffering (non-nginx)** | Cloudflare, ALB, HAProxy default config | Events queued, not delivered until buffer fills | 🟡 Medium | Only `x-accel-buffering` (nginx-specific) |
| **F6** | **Broker restart mid-subscription** | Broker process crash / restart | All active SSE connections drop; in-memory listeners lost | 🟡 Medium | State survives to disk, but no reconnect+replay |
| **F7** | **Long-running task (hours)** | Trading analysis, backfill tasks | Connection must stay alive for hours; probability of F1-F3 approaches 1 | 🔴 High | No reconnect protocol |
| **F8** | **Concurrent subscribers** | Multiple nodes watch same task | Each gets independent SSE stream; no coordination | 🟢 Low | Works correctly per design |
| **F9** | **Slow consumer** | Client processes events slowly, TCP backpressure | Broker `res.write()` buffers grow | 🟢 Low | Node.js handles backpressure; worst case OOM under extreme load |

## 3. Gap Analysis

### 3.1 No `Last-Event-ID` / Event Replay

The SSE spec defines `Last-Event-ID` for reconnection. The broker:
- Does not send `id:` fields with a monotonically increasing value
- Does not read `Last-Event-ID` on reconnect
- Does not buffer recent events for replay

**Impact:** Any disconnect = permanent event loss for the subscriber.

### 3.2 No `retry:` Advisory

SSE allows a `retry:` field to tell the client how long to wait before reconnecting. Currently absent.

**Impact:** Clients use their own heuristics (often too aggressive or too slow).

### 3.3 No CORS Headers

If a browser-based consumer (dashboard, dev tools) connects, CORS will block it unless the proxy adds headers.

**Impact:** Browser-based monitoring not possible without proxy config changes.

### 3.4 Proxy-Specific Buffering Not Fully Covered

- `x-accel-buffering: no` → nginx only
- `Surrogate-Capability` / `X-Cache` → not handled
- Cloudflare → needs `cache-control: no-store` (currently `no-cache`)
- HAProxy → needs `timeout tunnel` config on proxy side

### 3.5 No Reconnection Protocol for Mobile

Mobile clients (Android Termux, iOS) experience frequent brief disconnects. A mobile-friendly SSE subscription needs:
1. Explicit reconnect advisory
2. Event replay or state reconciliation on reconnect
3. Exponential backoff guidance

## 4. Recommended Changes

### Priority 1 — Reconnect + Replay (addresses F2, F4, F7)

**Broker changes:**
1. Add `id:` field to every SSE event (format: `{taskId}:{sequenceNumber}`)
2. Buffer last N events per task (ring buffer, configurable, default 100)
3. On connect, read `Last-Event-ID` header; replay buffered events after that ID
4. Add `retry: 3000` to initial response

### Priority 2 — Mobile Resilience (addresses F1, F3)

**Broker changes:**
1. Change `cache-control` from `no-cache` to `no-cache, no-store`
2. Add `Access-Control-Allow-Origin: *` and related CORS headers for SSE route
3. Document recommended proxy timeouts for common platforms (nginx, Caddy, Cloudflare)

### Priority 3 — Client Guidance (addresses F2, F4, F7)

**Documentation changes:**
1. Document the retry/reconnect contract for plugin callers
2. Recommend `EventSource`-compatible client libraries
3. Provide example reconnect logic with exponential backoff
4. Document expected behavior when subscribing to an already-terminal task

## 5. Smoke Test: Disconnect-and-Recover

A scripted test that:
1. Creates a task
2. Opens SSE subscription
3. Artificially disconnects (kill client)
4. Reconnects with `Last-Event-ID`
5. Verifies missed events are replayed
6. Verifies no duplicate events

This requires the Priority 1 changes to be implemented first.

## 6. Environment-Specific Notes

### Android Termux (Gongyung)
- `EventSource` via `fetch` or `undici` — no browser, so CORS irrelevant
- Tailscale overlay may add latency; heartbeat must account for RTT variance
- Background process may be killed by Android battery optimization
- Network transitions (WiFi ↔ mobile data) are frequent

### Tailscale Reverse Proxy
- Tailscale itself does not buffer; DERP relay may add latency
- If broker is behind nginx on VPS, standard proxy buffering rules apply

### Cloudflare Tunnel
- Cloudflare defaults to 100s timeout for SSE; needs `cache-control: no-store`
- Cloudflare may strip `x-accel-buffering`
