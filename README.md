# a2a-broker

Minimal standalone A2A broker scaffold.


## Repository role in the A2A layout

`a2a-broker` is the control-plane repository for the current A2A stack.

It owns:

- broker HTTP/JSON-RPC APIs, task lifecycle, status/read models, SSE streams, cancel/reconcile, stale reaper, and persistence
- worker registration, heartbeat, queue polling, and task evidence validation
- the deployable worker handler artifact at `scripts/openclaw-a2a-task-handler.mjs`
- OpenClaw bridge failure semantics for host fallback paths, including watchdog/final-evidence safeguards

It does **not** own isolated task execution. Generic GitHub patch execution runs through [`jinwon-int/a2a-docker-runner`](https://github.com/jinwon-int/a2a-docker-runner). OpenClaw-facing task request/status/cancel mapping lives in [`jinwon-int/openclaw-plugin-a2a`](https://github.com/jinwon-int/openclaw-plugin-a2a).

Current production baseline as of 2026-04-30:

- active workers: `bangtong`, `sogyo`, `dungae`, `nosuk`
- worker handler artifact: `0.2.2`
- GitHub patch tasks: Docker-first via `A2A_EXECUTOR_MODE=auto`, `A2A_DOCKER_RUNNER_SCOPE=all-github`, `A2A_DOCKER_RUNNER_ALL_GITHUB=1`
This repo is the canonical home for the A2A task protocol. The
in-process library entrypoints from the archived legacy `a2a` repo
(`runA2ATaskRequest`, `runA2ABrokerExchange`,
`applyA2ATaskProtocolUpdate`, `applyA2ATaskProtocolCancel`,
`loadA2ATaskProtocolStatusById`, plus event constructors and reducer
helpers) are **retired**. Consumers reach the same protocol behavior
over HTTP and JSON-RPC against this broker — see
`docs/a2a-protocol.md` for the canonical reference and the migration
map.

## Design docs

- `docs/a2a-protocol.md` for the canonical A2A task protocol: envelope shape, lifecycle, cancel semantics, event/state model, and the migration map from the retired legacy library entrypoints
- `docs/protocol-compatibility.md` for the public A2A compatibility matrix, current supported profile, non-goals, and conformance/golden gate
- `docs/public-stable-readiness.md` for the public/stable release decision checklist, license/secret/history gates, and broker/plugin/runner responsibility boundaries
- `docs/source-public-risk-audit-20260510.md` for the Team2 independent broker source-public risk audit and parity evidence for the 2026-05-10 gate
- `SECURITY.md` and `CONTRIBUTING.md` for vulnerability-reporting, contribution, and release-safety boundaries
- `docs/v1-acceptance-handoff.md` for the v1 acceptance gate, the plugin-facing contract, and the cross-repo handoff bar for `openclaw-plugin-a2a`
- `docs/trading-partner-refactor-design.md` for the broker evolution plan that supports stateful trading-partner workers such as `bangtong` and `dengae`
- `docs/phase-1-implementation-checklist.md` for the first implementation slice
- `docs/api-spec-draft.md` for proposal, validation, approval, and apply routes
- `docs/smoke-compose.md` plus `examples/docker-compose.smoke.yml` for a runnable single-host smoke stack using the built-in echo worker
- `docs/public-stable-readiness.md` plus `npm run scan:public-readiness` for redacted public-readiness scanning and local dummy-worker smoke evidence
- `docs/docker-compose-trading-partners.md` plus `examples/docker-compose.trading-partners.yml` for broker and worker isolation examples (the compose example is not a turnkey smoke stack)
- `docs/restart-recovery-smoke.md` for the operator runbook and automation flow that validates restart recovery
- `docs/operator-dashboard-snapshot.md` for the `GET /dashboard` operator snapshot JSON projection: workers, task status counters, stale/retry/dead-letter summary, and attention items
- `docs/wake-on-task-live-canary-runbook.md` for the live Wake-on-Task canary proof, resource-warning classification, and rollback/reset checklist
- `docs/docker-runner-rollout-runbook.md` for the A2A docker-runner worker rollout and rollback procedure: canary smoke, node expansion, feature flags, and failure rollback
- `docs/team2-gwakga-worker-onboarding-retargeting.md` plus `examples/team2-gwakga.worker.env.example` for the Team2/Gwakga worker onboarding and Seoseo→Gwakga retarget safety runbook
- `docs/docker-broker-live-smoke.md` for the repeatable live Docker broker no-op smoke script and <broker-host> run command
- `docs/edge-secret-rotation-runbook.md` for the no-secret-values rotation checklist after an edge secret exposure
- `docs/durable-persistence-path.md` for the recommended next persistence step beyond the phase-1 JSON snapshot backend
- `docs/sqlite-persistence.md` and `docs/release-notes-round-34-sqlite.md` for the SQLite schema v8 operator baseline, hot-table coverage, and diagnostics hot-read release notes
- `docs/production-stabilization-20260429.md` for the live production closeout: SQLite hot-table cutover, stale-reaper threshold, worker session isolation, active-worker scope, and 502 mitigation notes
- `docs/phase-8-peer-status-rfc.md` for the `a2a.peer.status` RPC design contract: health semantics, mobile-aware thresholding, busy detection, rate limiting, privacy summary-mode output, and caller guidance

## Peer status API (`a2a.peer.status`)

A lightweight JSON-RPC method for cheap, read-only worker health queries. Designed for routing, load-shedding, and operator dashboards.

### Quick reference

**Request**
```json
{
  "jsonrpc": "2.0",
  "method": "a2a.peer.status",
  "params": { "target": "<nodeId>", "maxCacheAgeMs": 5000 },
  "id": 1
}
```

**Response** (summary mode, default)
```json
{
  "schemaVersion": 1,
  "target": "<nodeId>",
  "observedAt": 1716000000000,
  "cacheAgeMs": 0,
  "gateway": { "reachable": true, "version": "...", "mode": "standalone" },
  "worker": {
    "registered": true,
    "lastHeartbeatAt": 1716000000000,
    "workerMode": "persistent",
    "capacity": { "slotsTotal": 10, "slotsBusy": 3 }
  },
  "tasks": { "active": 2, "queued": 1, "stale": 0 },
  "health": "ok"
}
```

### Health semantics (priority order)

| Health       | Meaning |
|-------------|---------|
| `ok`        | Worker registered, heartbeat fresh, free capacity |
| `busy`      | Worker registered, heartbeat fresh, all capacity slots occupied (`active + queued >= slotsTotal`) |
| `degraded`  | Worker registered, heartbeat fresh, but has stale tasks (claimed/running tasks with missed task heartbeats) |
| `stale`     | Worker registered but last heartbeat exceeds the mode-specific threshold |
| `unreachable` | Worker not registered at all |

### Worker modes

Workers declare `workerMode` on registration/heartbeat:

| Mode         | Stale threshold | Capacity |
|-------------|----------------|----------|
| `persistent` (default) | 90 s | 10 slots |
| `mobile`    | 30 s | 3 slots |

Mobile workers (Android/Termux, laptops) use shorter stale thresholds because brief offline windows from Doze, network suspend, or lid-close are expected. The reduced capacity reflects battery/CPU constraints.

### Caller contract

- **Rate limit**: per `(caller, target)` pair, 20 req/min + 5 burst
- **Cache**: default TTL 5 s; use `maxCacheAgeMs: 0` to force recompute
- **Privacy**: summary mode excludes task messages, session transcripts, and sensitive fields. Verbose mode requires explicit scope `"a2a.peer.status.verbose"` in the JSON-RPC `scope` parameter
- **Authentication**: caller must provide a `caller` identity; unauthenticated queries return `unauthenticated`
- **Unknown target**: returns `target_unknown` error code (not a peer health)

### Usage patterns

```typescript
// Hub routing: skip busy workers
const status = await rpc("a2a.peer.status", { target: "worker-a" });
if (status.health === "busy" || status.health === "stale") {
  // Route to next available worker
}

// Operator dashboard: query all peers
for (const worker of workers) {
  const s = await rpc("a2a.peer.status", { target: worker.nodeId });
  console.log(`${worker.displayName}: ${s.health} (${s.worker.capacity?.slotsBusy}/${s.worker.capacity?.slotsTotal})`);
}
```

## Worker capacity preflight

`GET /workers/capacity` returns a compact pre-dispatch view for repeated A2A rounds. It omits task payloads/messages and reports per-worker `queued`, `claimed`, `running`, `stale`, and `active` counts plus `latestTaskUpdatedAt`.

Before a seoseo → gwakga broker cutover, run the read-only two-broker guard to fail closed if the same worker id is online in both broker worker lists:

```bash
SEOSEO_BROKER_URL=http://127.0.0.1:8787 \
GWAKGA_BROKER_URL=http://127.0.0.1:8788 \
npm run two_broker_worker_preflight
```

The guard only calls `GET /workers` on each broker. It exits `0` when no duplicate online worker ids are found, `1` when duplicates are found, and `2` for setup/fetch errors.

Example gate before assigning another round:

```bash
curl -s "$BROKER_URL/workers/capacity?stale_after_ms=120000" \
  | jq -e '.totals.staleTasks == 0 and all(.items[]; .status == "online" and .counts.active < 2)'
```

If the command exits non-zero, pause dispatch and inspect the compact response instead of repeatedly fetching large `/tasks?detail=full` snapshots.

## What is included

Release note: this repository currently has no root `LICENSE` file. Treat public/stable release or visibility changes as blocked until the license decision is approved and recorded in `docs/public-stable-readiness.md`.

- Node 22 + TypeScript service
- JSON file backed persistence for exchanges, workers, proposals, validations, artifacts, and audit events
- health endpoint
- public AgentCard discovery at `GET /.well-known/agent-card.json`
- JSON-RPC facade at `POST /a2a/jsonrpc` with initial `SendMessage`, `GetTask`, `ListTasks`, `CancelTask`, and `GetExtendedAgentCard` methods
- create/list/get exchange endpoints
- operator read model for trading dialectic tasks at `GET /tasks/:id/trading-dialectic` (returns stage rail, decision card, and summary projection of a `trading.dialectic` v1 task payload)
- Dockerfile
- docker-compose.yml

## State persistence

By default, broker state is stored at:

```bash
/var/lib/a2a-broker/state.json
```

Override with:

```bash
STATE_FILE=/your/path/state.json
```

`PUBLIC_BASE_URL` is now required at boot and must be a real absolute `http` or
`https` URL. Leaving the masked placeholder in place will fail fast during
startup so the broker does not publish unusable discovery metadata.

The file store uses atomic temp-file writes plus rename, so it is good enough for phase 1 without bringing in a database yet.

Current state schema version: `5`

The broker now also applies in-memory retention before each snapshot save so
terminal exchanges, tasks, proposals, audit events, and long-stale workers do
not grow without bound.

Default retention policy:

- terminal exchanges: newest `1000` plus anything newer than `7d`
- terminal tasks: newest `2000` plus anything newer than `7d`
- terminal proposals: newest `1000` plus anything newer than `7d`
- audit events: newest `5000` plus anything newer than `7d`
- inactive workers: newest `500` plus anything seen within `14d`

Snapshot loads now reject malformed JSON and files larger than `50 MiB` by
default instead of accepting partial or poisoned state.

Retention / snapshot env vars:

```bash
BROKER_TERMINAL_RETENTION_MS=
BROKER_MAX_TERMINAL_EXCHANGES=
BROKER_MAX_TERMINAL_TASKS=
BROKER_MAX_TERMINAL_PROPOSALS=
BROKER_INACTIVE_WORKER_RETENTION_MS=
BROKER_MAX_INACTIVE_WORKERS=
BROKER_AUDIT_RETENTION_MS=
BROKER_MAX_AUDIT_EVENTS=
STATE_FILE_MAX_BYTES=
```

## Request identity and rate limits

Mutating routes now support broker-side requester verification using headers:

- `x-a2a-requester-id`
- `x-a2a-requester-kind`
- `x-a2a-requester-role`

With `ENFORCE_REQUESTER_IDENTITY=1`, `POST` routes verify that the requester header matches the node or actor declared in the route body or path.

Default rate limit:

- `10` requests
- per `60` seconds
- keyed by requester id when present, otherwise by client IP

Worker lifecycle traffic uses a separate bucket by default so register,
heartbeat, and claim/start/complete/fail requests do not consume the same limit
as general exchange, proposal, and audit traffic.

`x-forwarded-for` is ignored by default. Set `TRUSTED_PROXY=1` only when the
broker sits behind a reverse proxy you control and want rate limiting keyed off
the forwarded client IP instead of the direct socket peer.

Related env vars:

```bash
RATE_LIMIT_WINDOW_SEC=60
RATE_LIMIT_MAX_REQUESTS=10
WORKER_RATE_LIMIT_WINDOW_SEC=60
WORKER_RATE_LIMIT_MAX_REQUESTS=60
ENFORCE_REQUESTER_IDENTITY=1
TRUSTED_PROXY=0
EDGE_SECRET=
```

When `EDGE_SECRET` is set, every route except `GET /health` also requires the
`x-a2a-edge-secret` header. This lets trusted callers use the public broker
domain directly instead of relying on host-local tunnels alone. The bundled
worker client resolves secrets in this order: `BROKER_EDGE_SECRET`,
`A2A_BROKER_EDGE_SECRET`, `EDGE_SECRET`, then `A2A_EDGE_SECRET`.

Operational note:

- `POST /tasks/requeue_stale` is a privileged maintenance route.
- It still requires requester identity headers, and the requester role must be `hub` or `operator`.
- It stays on the general rate-limit bucket, so worker lifecycle traffic keeps its own headroom.
- Phase 1 proposal auth is intentionally narrow: artifact updates are limited to the proposal source, target, or an operator.
- Validation is limited to the proposal source or target node.
- Local apply remains target-node or operator only, even after approval.
- Task lineage uses optional `parentTaskId`. Canceling a parent task now fans out to every non-terminal descendant.
- Repeated `CancelTask` / `POST /tasks/:id/cancel` calls are idempotent. The broker returns the existing terminal task unchanged and keeps the original cancellation record.
- Cancel terminal metadata is stored on `TaskRecord.cancellation` as `requestedAt`, `requestedBy`, optional `reason`, and optional `sourceTaskId`. `sourceTaskId` is set only for fan-out descendants and points to the immediate parent task that caused the child cancel.

## Stale-task reaper

The broker runs a periodic in-process stale-task reaper so that restart recovery
is self-healing after node, worker, or broker restarts. Without it, claimed or
running tasks pointing at a dead worker stayed stuck until an operator manually
hit `POST /tasks/requeue_stale`.

Defaults:

- enabled
- sweep interval: 60s
- stale threshold (`olderThan`): falls back to `WORKER_OFFLINE_AFTER_SEC`

Env vars:

```bash
STALE_REAPER_ENABLED=1
STALE_REAPER_INTERVAL_SEC=60
STALE_REAPER_OLDER_THAN_SEC=90
BROKER_MAX_REQUEUE_ATTEMPTS=5
```

Each sweep calls the same `requeue_only` code path as the manual endpoint and
keeps `assignedWorkerId` untouched. `GET /health` exposes `staleReaper` with the
current config, `runCount`, `lastRunAt`, `lastRequeued`, `lastDeadLettered`,
`totalDeadLettered`, `maxRequeueAttempts`, and the most recent `lastError` (if
any) so operators can verify the loop is alive. Set `STALE_REAPER_ENABLED=0` if
you prefer to drive recovery manually.

### Requeue cap and dead-letter

To stop a flapping worker or a poisoned payload from thrashing the queue forever,
each task tracks a `requeueCount` and the broker caps how many automatic recoveries
it will do. When a task has already been requeued `BROKER_MAX_REQUEUE_ATTEMPTS`
times (default `5`), the next stale-recovery pass moves it to `failed` with
`error.code = "exceeded_requeue_limit"` instead of requeuing it again. Operator
reassignment through `POST /tasks/:id/reassign` resets `requeueCount` back to `0`
so the fresh target gets a clean attempt budget. Set
`BROKER_MAX_REQUEUE_ATTEMPTS=0` to disable the cap (unlimited requeues, legacy
behavior).

`POST /tasks/requeue_stale` now also returns `deadLettered` and
`deadLetteredItems` (with the final `requeueCount`, `error`, and updated
timestamp) alongside the usual `requeued` list, so operators can see the full
outcome of a sweep without a follow-up `/audit` query.

## Quick start

```bash
cd a2a-broker
cp .env.example .env
# replace PUBLIC_BASE_URL with the real reverse-proxy or public broker URL
npm install
npm run build
npm start
```

Health check:

```bash
curl http://127.0.0.1:8787/health
```

Start a worker daemon against the broker:

```bash
BROKER_URL=http://127.0.0.1:8787 \
WORKER_ID=worker-a \
WORKER_ROLE=analyst \
WORKER_HANDLER_BUILTIN=echo \
npm run start:worker
```

The worker registers itself, sends heartbeats, polls queued tasks assigned to `WORKER_ID`, claims and starts them, then completes or fails them.

For two-broker deployments, set a stable broker id on the broker and pin workers to it:

```bash
A2A_BROKER_ID=team2-broker npm start
A2A_HOME_BROKER_ID=team2-broker \
A2A_HOME_BROKER_LEASE_FILE=/var/lib/a2a-broker-worker/home-broker.json \
npm run start:worker
```

When `A2A_HOME_BROKER_ID` is set, the worker verifies `/health.brokerId` before any broker API request. If the broker id is missing, mismatched, or the local lease file was created for another broker id, startup fails closed.

Run the end-to-end smoke stack (broker plus built-in echo worker in Docker):

```bash
docker compose -f examples/docker-compose.smoke.yml up --build -d
```

Follow `docs/smoke-compose.md` to seed a task from the shell and
verify it reaches `succeeded`.

Run the restart recovery smoke:

```bash
BROKER_URL=http://127.0.0.1:8787 \
BROKER_EDGE_SECRET=YOUR_EDGE_SECRET \
npm run smoke:restart-recovery
```

Override `BROKER_RESTART_CMD` when the broker is not managed by `systemd`.

For an external task handler, point the worker at a command plus JSON args:

```bash
BROKER_URL=http://127.0.0.1:8787 \
WORKER_ID=worker-a \
WORKER_ROLE=analyst \
WORKER_HANDLER_COMMAND=node \
WORKER_HANDLER_ARGS_JSON='["/opt/a2a/handler.mjs"]' \
npm run start:worker
```

The external handler receives the task JSON on stdin and must write a JSON object to stdout. It may return either a task result object directly, or an envelope like `{ "result": { ... } }` or `{ "error": { "message": "..." } }`.

Create exchange:

```bash
curl -X POST http://127.0.0.1:8787/exchanges \
  -H 'content-type: application/json' \
  -d '{
    "requester": { "id": "<hub-node>", "kind": "node" },
    "target": { "id": "gongyung", "kind": "node" },
    "message": "ping",
    "maxTurns": 8
  }'
```


## Worker Runtime

The broker ships a built-in worker client (`A2ABrokerWorker`) that handles
registration, heartbeats, task polling, claim/start/complete/fail lifecycle,
and proposal APIs.

### Intent Router

Workers use an **intent router** to dispatch tasks to the correct handler
based on `task.intent`.  Middleware can be layered via `beforeHandle` hooks.

```ts
import { createIntentRouter, withProposalContext } from "./workers/intent-router.js";
import { createValidateProposalHandler, createApplyProposalHandler,
         createProposePatchHandler, createProposeParamsHandler } from "./workers/proposal-handlers.js";

const router = createIntentRouter({
  beforeHandle: [withProposalContext(apiWorker)],
  handlers: [
    { intent: "validate_change", handler: createValidateProposalHandler(apiWorker, myValidator) },
    { intent: "apply_local_change", handler: createApplyProposalHandler(myApplier) },
    { intent: "propose_patch", handler: createProposePatchHandler(apiWorker) },
    { intent: "propose_params", handler: createProposeParamsHandler(apiWorker) },
  ],
});
```

### Proposal Handler Plugins

Each handler accepts a plugin interface so teams can inject custom logic:

| Handler | Plugin Interface | Description |
|---------|-----------------|-------------|
| `createValidateProposalHandler` | `ProposalValidator` | Runs validation, returns verdict + kind |
| `createApplyProposalHandler` | `ProposalApplier` | Applies the change locally |
| `createProposePatchHandler` | — (uses `apiWorker`) | Creates a patch proposal on broker |
| `createProposeParamsHandler` | — (uses `apiWorker`) | Creates a params proposal on broker |

The broker's `completeTask` flow automatically handles proposal state
transitions based on the handler's return value — validate handlers return
a `validation` field, apply handlers return an `apply` field.  **Handlers
must not call `submitValidation` or `applyProposal` APIs directly**, as that
would cause double-invocation.

### Task Assertions

Handlers use assertion helpers from `intent-router.ts` to validate task
payloads.  Failed assertions throw `TaskAssertionError` which carries a
structured `WorkerHandlerOutcome` with an error code.  Handlers should
catch `TaskAssertionError` and return its `.outcome` to ensure the task
gets the correct error code.

```ts
assertProposalTask(task, "validate_change");   // checks intent + proposalId
assertWorkspaceTask(task);                     // checks workspace field
assertPayloadField(task, "targetNodeId");      // checks payload field exists
```

### Proposal Context Middleware

`withProposalContext(worker)` preloads `task.payload.__proposalDetails` for
tasks that have a `proposalId`, so handlers can access proposal metadata
without an extra round-trip.

### Tests

Run all tests (no build required):

```bash
npx tsx --test src/core/broker.test.ts src/server.test.ts   src/workers/intent-router.test.ts src/workers/proposal-handlers.test.ts   src/worker.test.ts
```

Current: **51 tests, 0 failures**.
## Docker

```bash
cd a2a-broker
cp .env.example .env
# set PUBLIC_BASE_URL to a masked placeholder or your reverse-proxy name
# example: PUBLIC_BASE_URL=https://<masked-a2a-endpoint>
docker compose up --build -d
docker compose logs -f
```

## Masking rule

- inside Docker and service-to-service traffic, use the stable service name `a2a-broker`
- outside Docker, do not hardcode host IPs or machine names in docs, configs, or logs
- use placeholders like `<masked-host>` or a public alias variable such as `PUBLIC_BASE_URL`

## Next likely steps

1. swap in-memory store for durable persistence
2. add exchange state transitions
3. add OpenClaw adapter
4. add transport auth if needed beyond requester verification
