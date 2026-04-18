# v1 acceptance and cross-repo handoff

This doc fixes the acceptance gate for the standalone `a2a-broker` v1
and the contract it publishes to `openclaw-plugin-a2a` and any other
plugin that connects an OpenClaw node to the broker.

It is intentionally a checklist, not a spec. Use it when deciding whether
this repo and the plugin can be cut and released independently.

Closes issue #1.

## 1. Plugin-facing contract

The broker exposes a stable HTTP surface. A plugin that speaks to that
surface should not need broker internals.

### Stable endpoints

The following routes are in scope for v1 and will not change shape
without a schema bump:

- `GET /health` — always unauthenticated. Exposes `stateVersion`,
  `staleReaper`, `persistence`, and boot config.
- `GET /.well-known/agent-card.json` — A2A discovery, public.
- `POST /a2a/jsonrpc` — JSON-RPC facade with
  `SendMessage`, `GetTask`, `ListTasks`, `CancelTask`,
  `GetExtendedAgentCard`.
- `POST /workers/register`, `POST /workers/:id/heartbeat`,
  `GET /workers/:id`.
- `POST /tasks`, `GET /tasks`, `GET /tasks/:id`,
  `POST /tasks/:id/claim|start|complete|fail|reassign|cancel`,
  `POST /tasks/requeue_stale`.
- `POST /exchanges`, `GET /exchanges`, `GET /exchanges/:id`,
  `GET /exchanges/:id/messages`, `POST /exchanges/:id/messages`.
- `POST /proposals`, `GET /proposals`, `GET /proposals/:id`,
  `POST /proposals/:id/artifacts|validate|approve|reject|apply`.
- `GET /audit`.
- `GET /dashboard`.

### State schema version

Snapshot schema version is `5`. A plugin that inspects snapshot exports
must treat the schema version as authoritative and refuse to parse an
older file.

### Task shape the plugin should produce

A delegated task created by the plugin must set:

- `intent` — one of the values in `A2AExchangeIntent`.
- `requester` with `id` and `kind`. `role` should match the caller.
- `target` with `id` (the node id) and `kind: "node"`.
- `assignedWorkerId` when the plugin knows the exact worker id.
- `message` for free-text prompts.
- `payload` for structured fields.

The broker owns `id`, `createdAt`, `status`, and the lifecycle
transitions. The plugin must not try to author those fields beyond
passing an idempotency id.

## 2. Required headers and auth assumptions

The plugin must send these headers on every mutating request:

- `x-a2a-requester-id`
- `x-a2a-requester-kind`
- `x-a2a-requester-role`
- `x-a2a-edge-secret` (when `EDGE_SECRET` is configured on the broker)
- `content-type: application/json` when a body is present

Enforcement rules the plugin must assume:

- `ENFORCE_REQUESTER_IDENTITY=1` is the default in production. The
  requester id in the headers must match the declared requester,
  worker, or actor in the body or URL path. See
  `docs/api-spec-draft.md` for the exact match rules per route.
- `GET /health` is the only route that works without the edge secret.
- Maintenance routes (`POST /tasks/requeue_stale`,
  `POST /tasks/:id/reassign`) require requester role `hub` or
  `operator`.

Do not trust `x-forwarded-for` from plugin callers. The broker only
honors it when `TRUSTED_PROXY=1`, and only for rate-limit keying.

## 3. Rate-limit and recovery assumptions

### Rate limits

Two separate buckets, both token-counted per window:

- general bucket — default `10` requests per `60s`,
  keyed by requester id (falls back to client IP). Covers task,
  proposal, exchange, and audit traffic.
- worker lifecycle bucket — default `60` requests per `60s`.
  Covers register, heartbeat, claim, start, complete, fail.

A plugin that drives tasks on behalf of many users must keep its own
fan-out below the general bucket, or request a raised limit via
`RATE_LIMIT_MAX_REQUESTS`.

### Recovery

The plugin must assume the broker will self-heal a stuck task:

- a periodic stale-task reaper requeues tasks whose worker has gone
  offline longer than `STALE_REAPER_OLDER_THAN_SEC` (or
  `WORKER_OFFLINE_AFTER_SEC`).
- recovery is `requeue_only`. `assignedWorkerId` is not rewritten.
- after `BROKER_MAX_REQUEUE_ATTEMPTS` (default `5`), the next sweep
  dead-letters the task to `failed` with
  `error.code = "exceeded_requeue_limit"`.
- `POST /tasks/:id/reassign` by an operator or hub resets the
  requeue counter to `0`.

The plugin should not retry `POST /tasks` on transient
`5xx` responses without an idempotent id, because a duplicate task
will be seeded if the original actually landed.

## 4. Minimum end-to-end success path

v1 is accepted when this path runs end to end, without operator edits
mid-run:

1. Broker boots with `PUBLIC_BASE_URL` set to a reachable absolute URL
   and `GET /health` returns `status: "ok"`.
2. An OpenClaw node with `openclaw-plugin-a2a` connects, registers a
   worker, and the broker shows it under `GET /workers`.
3. The plugin (or an operator) creates a task pinned to that worker
   via `POST /tasks`.
4. The worker claims, starts, and completes the task.
5. `GET /tasks/:id` reports `status: "succeeded"` and a non-empty
   `result`.
6. `GET /audit?targetId=<taskId>` shows
   `task.created`, `task.claimed`, `task.started`, `task.succeeded`.

There are two ways to exercise this path today without an OpenClaw node:

- `examples/docker-compose.smoke.yml` plus
  `docs/smoke-compose.md` — a self-contained compose stack using the
  built-in echo worker, end-to-end in one shell.
- `docs/restart-recovery-smoke.md` — the restart-recovery drill that
  also proves the succeeded transition after a reaper requeue.

A successful run of the smoke compose, the restart-recovery smoke, and
a real OpenClaw plugin connection against the same broker build is the
v1 acceptance bar.

## 5. Compatibility expectations for `openclaw-plugin-a2a`

Until the plugin is split into its own release:

- the plugin targets broker state schema `5`.
- the plugin must tolerate new, additive optional fields on task,
  proposal, exchange, and worker responses.
- the plugin must treat unknown `AuditAction` values as informational,
  not fatal.
- the plugin must not depend on any private type exported from `src/core`.
  Stable shapes live on `A2ATaskRequest`, `TaskRecord`, `WorkerView`,
  `ChangeProposal`, `ProposalDetails`, and the A2A JSON-RPC envelopes.
- the plugin must resolve the edge secret via env in this order:
  `BROKER_EDGE_SECRET`, `A2A_BROKER_EDGE_SECRET`, `EDGE_SECRET`,
  `A2A_EDGE_SECRET` — the same order used by the bundled worker client.

Breaking changes to any of the above require a snapshot schema bump
and a plugin-side release note.

## 6. Blockers before split production-ready

The broker can be cut as a standalone release today. Before the plugin
is cut on its own release cadence, these items should be landed or
explicitly accepted as deferred:

1. Durable persistence. The JSON file store is sufficient for phase 1
   and survives restarts, but it is still not a multi-writer store.
2. SSE task subscription hardening. `GET /a2a/tasks/:id/events` is
   implemented behind `TASK_SUBSCRIBE_HEARTBEAT_SEC`, but a plugin
   must assume a reverse proxy may still cut idle connections.
3. Observability gaps flagged in the 2026-04-17 audit remediation
   follow-up (issue #3). The current behavior is correct but metrics
   and structured logs are thin. The plugin should treat long-tail
   latency as opaque until that lands.
4. Signed-header or mTLS auth as a stronger upgrade path from the
   shared edge secret. See
   `docs/a2a-broker-ops-handoff-20260413.md` section
   "Auth alternatives".

None of these block v1 cut of the broker itself. They do block
de-risked split release of `openclaw-plugin-a2a` against an
externally operated broker.

## 7. Related docs and issues

- `docs/api-spec-draft.md` — route-by-route contract, requester
  match rules, and request examples.
- `docs/smoke-compose.md` plus `examples/docker-compose.smoke.yml`
  — runnable broker + built-in echo worker smoke path.
- `docs/docker-compose-trading-partners.md` plus
  `examples/docker-compose.trading-partners.yml` — isolation-only
  reference for `bangtong` and `dengae`. Not a smoke path.
- `docs/restart-recovery-smoke.md` — restart recovery runbook and
  automation.
- `docs/a2a-broker-ops-handoff-20260413.md` — deploy and edge-auth
  operational notes.
- `docs/a2a-broker-audit-remediation-20260417.md` — completed audit
  fixes and the follow-up list that feeds issue #3.
- Issue #1 — this acceptance gate.
- Issue #3 — observability follow-up; does not block v1.
- Issue #4 — runnable smoke profile, landed as
  `examples/docker-compose.smoke.yml`.
- PR #5 — clarified that the trading-partners compose is isolation
  only.
