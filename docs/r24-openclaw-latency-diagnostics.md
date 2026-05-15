# R24 All-Node OpenClaw Latency Diagnostics

**Run:** a2a-r24-openclaw-latency-optimization-20260515T0655Z  
**Issue:** https://github.com/jinwon-int/a2a-broker/issues/651  
**Parent:** https://github.com/jinwon-int/a2a-plane/issues/343  
**Targets:** gwakga/vps7 (broker), dungae/vps0 (worker)  

## 1. Health and Event-Loop Status

### 1.1 Health Endpoint

```
GET /health
```

Key fields for latency diagnosis:

| Field | Interpretation | Latency Relevance |
|-------|---------------|-------------------|
| `runtimeMemory.eventLoopDelayMs` | p99/p50 event-loop delay (from `monitorEventLoopDelay`) | High delay → broker event-loop starved → request queuing |
| `runtimeMemory.heapUsedRatio` | Heap fraction used (ok < 0.70, warn 0.70-0.85, critical > 0.85) | High heap → GC pressure → latency spikes |
| `persistence.hotTableLoadMetrics` | Per-table row counts (tasks, audit, workers, outbox) | Linear scan cost in `readHotEntityMirrorStatus` |
| `persistence.mirrorDiffMs` | Time to diff snapshot against hot entity tables | Direct contribution to health endpoint latency |
| `hotTableGrowth.overallSeverity` | Growth trend (ok / warning / critical) | Predicts future latency regression |
| `timing.totalMs` | End-to-end health response time | Baseline for cache effectiveness |
| `timing.fromCache` | Whether diagnostics were served from cache | Cache miss = full scan penalty |

### 1.2 Dashboard Endpoint

```
GET /dashboard
```

The dashboard now includes `runtimeMemory` with the same event-loop delay and heap metrics as `/health`. Use this for real-time monitoring without the full health scan cost.

### 1.3 Event-Loop Monitoring

Event-loop delay is measured via `perf_hooks.monitorEventLoopDelay` with 20ms resolution, reporting p99 and p50. Values are reset after each `/health` read. Use for:

- **Sustained p99 > 50ms:** broker under significant CPU pressure
- **Sustained p99 > 100ms:** investigate GC tuning, hot-table scan reduction, or worker scaling
- **Sustained p99 > 200ms:** likely to cause SSE heartbeat timeouts and HTTP request drops

## 2. Broker Profiling

The broker emits profiling samples for five latency-critical operations:

| Operation | Trigger | Purpose |
|-----------|---------|---------|
| `persistState` | Every state mutation (create/update task, register worker, etc.) | Persistence write-path latency |
| `getDashboard` | `/dashboard` request | Dashboard build latency (task/worker/proposal scans) |
| `getWorkerCapacitySummary` | Capacity scan (health, alert scan) | Worker stale detection and queue depth computation |
| `getTaskDiagnostics` | Per-task diagnostic generation | Individual task health report cost |
| `discoverCleanupCandidates` | `/operator/cleanup/plan` | Cleanup candidate discovery scan cost |

Subscribe to profiling samples via:

```typescript
const unsubscribe = broker.subscribeToProfiling((sample) => {
  console.log(`${sample.operation}: ${sample.durationMs}ms`);
});
// unsubscribe() when done
```

Or use the `profilingListener` option at broker construction for a single listener.

### 2.1 Profiling in the Diagnostics Scripts

Diagnostic scripts that call profiled broker operations should use the `WithProfiling` variants where available:

- `getWorkerCapacitySummaryWithProfiling()` — wraps capacity scan with timing
- `getDashboardWithProfiling()` — wraps dashboard build with timing
- `discoverCleanupCandidatesWithProfiling()` — wraps cleanup discovery with timing

These return the same result as the base method but emit a profiling sample as a side-effect.

## 3. Session-Store Residue

Session-store residue contributes to latency in two ways:

1. **Heap pressure from accumulated state** — stale worker records, old terminal tasks, and unpruned tombstones increase snapshot size, slowing persist and mirror-diff operations
2. **Scan overhead** — `listWorkers()`, `listTasks()`, and `listProposals()` iterate over all in-memory state; residue increases O(n) cost

### 3.1 Cleanup Candidate Discovery

```
GET /operator/cleanup/plan
```

(Requires SQLite persistence and `hub`/`operator` role.)

Candidate categories relevant to session-store residue:

| Class | What | Latency Impact |
|-------|------|----------------|
| `stale_worker` | Workers with no recent heartbeat | Dead records in worker scans |
| `malformed_task` | Queued tasks missing required fields | Poison records that never claim |
| `orphaned_claim` | Claimed/running tasks assigned to stale workers | Stuck tasks blocking queue slots |
| `terminal_outbox_backlog` | Unacknowledged terminal outbox events | Outbox scan growth (check `terminalOutboxDiagnostics`) |
| `historical_terminal_task` | Old terminal (succeeded/failed/canceled) tasks | Largest contributor to heap pressure |

### 3.2 Worker Heartbeat Persistence Interval

Configured via `workerHeartbeatPersistIntervalMs` (default: 60,000ms). In-memory liveness updates on every heartbeat; unchanged heartbeats are persisted at most once per interval. Tune this down for faster stale detection at the cost of more writes.

### 3.3 Stale Reaper

Config:

- `STALE_REAPER_INTERVAL_SEC` (default 60) — how often the reaper scans
- `STALE_REAPER_OLDER_THAN_SEC` (default 90) — stale threshold
- `BROKER_MAX_REQUEUE_ATTEMPTS` (default 5) — dead-letter cap

The stale reaper is the primary mechanism for clearing orphaned claims and requeuing stuck tasks. If the reaper is disabled or its interval is too long, residue accumulates.

## 4. A2A Backlog

### 4.1 Queue Pressure

The dashboard `observability.queuePressure` block reports:

- `blocked`, `queued`, `claimed`, `running` — task counts by status
- `staleWorkerAssignments` — tasks assigned to stale workers
- `oldestClaimed`, `oldestRunning` — age of the oldest active tasks

Use these to identify tasks stuck due to stale workers or slow handlers.

### 4.2 Terminal Outbox Backlog

```
GET /health
```

Includes `terminalOutboxDiagnostics` when running SQLite persistence:

- `hotTerminalOutboxEvents` — current outbox count
- `maxHotTerminalOutboxEvents` — cap (default 1000)
- `unacknowledgedCount` — events not yet confirmed by the notifier

An unacknowledged backlog > 100 indicates the notifier may be falling behind, which contributes to the in-memory heap footprint.

### 4.3 Worker Capacity Summary

```
broker.getWorkerCapacitySummary()
```

Returns per-worker task counts broken down by status (`queued`, `claimed`, `running`, `stale`, `active`). This surface is now profiled (`getWorkerCapacitySummary` operation) so operators can observe scan latency.

## 5. Plugin/Provider Discovery Drift

### 5.1 Worker Capability Registry

The worker capability card (`/a2a/jsonrpc` method `GetExtendedAgentCard` or `GET /.well-known/agent-card.json`) advertises:

- Supported capabilities (`canAnalyze`, `canBackfill`, `canPatchWorkspace`, `canPromoteLive`)
- Workspace and environment scopes
- Display name, role, and public URL

### 5.2 Drift Detection Workflow

1. **Collect expected capabilities** from the worker configuration (env vars or registration request)
2. **Compare against actual** via agent card or worker repository lookup
3. **Check for mismatches**: a worker that advertises `canPatchWorkspace=1` but whose handler lacks patch support will fail at execution time

Signs of drift:

- Worker registers with one capability set but the agent card advertises another
- Worker handler artifact version (`OPENCLAW_A2A_TASK_HANDLER_VERSION`) doesn't match the registered `WORKER_HANDLER_BUILTIN` config
- Worker registered as `role: analyst` but shows up with stale capabilities from a previous deployment

### 5.3 Plugin Discovery Prefix

All plugin tasks use session IDs prefixed with `a2a-`. Verify that:

- Workers use `deriveTaskSessionId` from `workers/session-isolation.ts`
- External handlers accept `--session-id` arguments
- No shared/long-lived sessions (e.g. `main`, `telegram`) are used for A2A task execution

Session-isolation violations cause history leakage and stale retry loops, which can make tasks appear to hang or produce incorrect results — often misdiagnosed as latency issues.

## 6. Latency Data Collection Checklist

| # | Check | Tool/Source | Expected |
|---|-------|-------------|----------|
| 1 | Health endpoint reachable | `curl broker:8787/health` | `ok: true`, no warnings |
| 2 | Event-loop delay | `/health` → `runtimeMemory.eventLoopDelayMs` | < 50ms p99 |
| 3 | Heap pressure | `/health` → `runtimeMemory.heapUsedRatio` | < 0.70 |
| 4 | Hot-table growth | `/health` → `hotTableGrowth.overallSeverity` | `"ok"` |
| 5 | Profiling samples | Subscribe via `subscribeToProfiling` | All operations < 100ms |
| 6 | Session-store residue | `GET /operator/cleanup/plan` | Total candidates < 100 |
| 7 | Queue pressure | `/dashboard` → `observability.queuePressure` | No stale worker assignments |
| 8 | Terminal outbox backlog | `/health` → `terminalOutboxDiagnostics` | Unacknowledged < 50 |
| 9 | Worker heartbeat freshness | `/dashboard` → `workers.byNode[*].lastSeenAgeSec` | All < 90s |
| 10 | Plugin drift | Compare agent card against registration | No capability mismatches |

## 7. Safety Constraints

No Gateway/broker/worker restart, production deploy, live provider/Telegram canary, terminal ACK/replay, DB mutation/prune/migration, secret movement, release/tag, destructive cleanup, or monorepo cutover is performed by this diagnostic lane. All data collection is read-only.

Provider send success is not ACK evidence. Do not expose secrets in diagnostic output.
