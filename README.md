# a2a-broker

Minimal standalone A2A broker scaffold.

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
- `docs/v1-acceptance-handoff.md` for the v1 acceptance gate, the plugin-facing contract, and the cross-repo handoff bar for `openclaw-plugin-a2a`
- `docs/trading-partner-refactor-design.md` for the broker evolution plan that supports stateful trading-partner workers such as `bangtong` and `dengae`
- `docs/phase-1-implementation-checklist.md` for the first implementation slice
- `docs/api-spec-draft.md` for proposal, validation, approval, and apply routes
- `docs/smoke-compose.md` plus `examples/docker-compose.smoke.yml` for a runnable single-host smoke stack using the built-in echo worker
- `docs/docker-compose-trading-partners.md` plus `examples/docker-compose.trading-partners.yml` for broker and worker isolation examples (the compose example is not a turnkey smoke stack)
- `docs/restart-recovery-smoke.md` for the operator runbook and automation flow that validates restart recovery
- `docs/durable-persistence-path.md` for the recommended next persistence step beyond the phase-1 JSON snapshot backend

## What is included

- Node 22 + TypeScript service
- JSON file backed persistence for exchanges, workers, proposals, validations, artifacts, and audit events
- health endpoint
- public AgentCard discovery at `GET /.well-known/agent-card.json`
- JSON-RPC facade at `POST /a2a/jsonrpc` with initial `SendMessage`, `GetTask`, `ListTasks`, `CancelTask`, and `GetExtendedAgentCard` methods
- create/list/get exchange endpoints
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
    "requester": { "id": "seoseo", "kind": "node" },
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
