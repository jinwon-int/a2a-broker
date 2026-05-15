# Done — A2A R24 All-Node OpenClaw Latency Optimization Lane

**Run:** a2a-r24-openclaw-latency-optimization-20260515T0655Z  
**Issue:** https://github.com/jinwon-int/a2a-broker/issues/651  
**Parent:** https://github.com/jinwon-int/a2a-plane/issues/343  
**Targets:** gwakga/vps7 (broker), dungae/vps0 (worker)  

## Changes Delivered

### 1. Broker profiling extended to latency-critical operations

`src/core/broker.ts` — The `BrokerProfilingOperation` union now covers:

- **`getDashboard`** — the operator's primary monitoring endpoint build latency
- **`getWorkerCapacitySummary`** — worker fleet health and stale-task detection scan
- **`getTaskDiagnostics`** — per-task diagnostic report generation
- **`discoverCleanupCandidates`** — cleanup planning scan cost

Previously only `persistState` was profiled. Each operation emits a `BrokerProfilingSample` via the existing `subscribeToProfiling` / `profilingListener` infrastructure. Convenience methods (`getWorkerCapacitySummaryWithProfiling`, `getDashboardWithProfiling`, `discoverCleanupCandidatesWithProfiling`) are exposed for diagnostic scripts.

### 2. Event-loop delay on dashboard

`src/server.ts` — The `/dashboard` endpoint now surfaces `runtimeMemory` including `eventLoopDelayMs` and `heapUsedRatio`, giving operators a unified view of broker event-loop health alongside task/worker state in a single request.

### 3. Latency diagnostics runbook

`docs/r24-openclaw-latency-diagnostics.md` — New document covering:

- Health endpoint interpretation (event-loop delay, heap pressure, hot-table growth)
- Dashboard event-loop monitoring
- Broker profiling API usage
- Session-store residue detection (stale workers, orphaned claims, terminal outbox backlog)
- A2A backlog assessment (queue pressure, stale-worker assignments)
- Plugin/provider discovery drift detection workflow
- Latency data collection checklist (10-point checklist)
- Safety constraints

### 4. Test coverage

`src/core/broker.test.ts` — New test `"broker profiling covers latency-critical operations"` verifies:
- All four new operation types appear in profiling samples
- `durationMs >= 0` for each
- `startedAt` is ISO-8601 formatted

**Test results:** 175 tests (101 broker + 74 server), 0 failures.

## Safety Gate Compliance

- ✅ No Gateway/broker/worker restart
- ✅ No production deploy
- ✅ No live provider/Telegram canary
- ✅ No terminal ACK/replay
- ✅ No DB mutation/prune/migration
- ✅ No secret movement
- ✅ No release/tag
- ✅ No destructive cleanup
- ✅ No monorepo cutover
- ✅ No OpenClaw runtime/bootstrap context files in branch

## Files Changed

| File | Change |
|------|--------|
| `src/core/broker.ts` | +70 lines — profiling extension (4 new operation types, 3 convenience methods) |
| `src/core/broker.test.ts` | +39 lines — profiling coverage test |
| `src/server.ts` | +22 lines — event-loop delay on dashboard response |
| `docs/r24-openclaw-latency-diagnostics.md` | +298 lines — new diagnostics runbook |
