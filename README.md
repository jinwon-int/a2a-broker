# a2a-broker

Minimal standalone A2A broker scaffold.

## Design docs

- `docs/trading-partner-refactor-design.md` for the broker evolution plan that supports stateful trading-partner workers such as `bangtong` and `dengae`
- `docs/phase-1-implementation-checklist.md` for the first implementation slice
- `docs/api-spec-draft.md` for proposal, validation, approval, and apply routes
- `docs/docker-compose-trading-partners.md` plus `examples/docker-compose.trading-partners.yml` for broker and worker isolation examples
- `docs/restart-recovery-smoke.md` for the operator runbook and automation flow that validates restart recovery

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

The file store uses atomic temp-file writes plus rename, so it is good enough for phase 1 without bringing in a database yet.

Current state schema version: `2`

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

Related env vars:

```bash
RATE_LIMIT_WINDOW_SEC=60
RATE_LIMIT_MAX_REQUESTS=10
WORKER_RATE_LIMIT_WINDOW_SEC=60
WORKER_RATE_LIMIT_MAX_REQUESTS=60
ENFORCE_REQUESTER_IDENTITY=1
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

## Quick start

```bash
cd a2a-broker
cp .env.example .env
# keep external hostnames and public endpoints masked in .env
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
