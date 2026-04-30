# A2A task protocol — canonical reference

This is the broker-owned canonical reference for the A2A task protocol.
It supersedes the equivalent doc that previously lived in the archived
legacy `a2a` repo alongside the in-process `runA2ATaskRequest` /
`runA2ABrokerExchange` library surface.

If a consumer used to read protocol shape, lifecycle, cancel semantics,
or event/state model from the legacy library doc, this file is now the
first stop. The legacy library export surface is **retired** in this
repo (see "Library export surface" below for the migration map).

Closes `jinwon-int/a2a-broker#16`. Delete-gate evidence for parent issue
`#6` is at the end of this file.

## Scope

This doc fixes:

- the canonical task envelope (`A2ATaskEnvelopeV1`) and how it maps to
  the broker's wire shapes
- request, update, cancel, and status protocol behavior
- the event model (SSE) and the state model (broker-owned reducer)
- `runtime.cancelTarget` semantics for `{ kind: "session_run",
  sessionKey, runId? }`
- the migration map from the legacy in-process library entrypoints to
  the broker's HTTP / JSON-RPC surface

For the per-route HTTP request / response shapes, see
`docs/api-spec-draft.md`. For the v1 acceptance bar and plugin-facing
contract, see `docs/v1-acceptance-handoff.md`. This file stays focused
on protocol semantics.

## Authority and shape source of truth

- the broker is authoritative for task `id`, `status`, lifecycle
  transitions, and reducer-applied state. Callers must not author those
  fields.
- the wire shapes the broker actually persists and serves are defined
  in `src/core/types.ts`. The names a consumer should depend on are
  `A2ATaskRequest`, `TaskRecord`, `A2AExchangeIntent`, `WorkerView`,
  `ChangeProposal`, `ProposalDetails`, and the JSON-RPC envelope shapes
  in `src/a2a/json-rpc.ts` plus the public projection in
  `src/a2a/task-projection.ts`.
- snapshot state schema version is `5`. A consumer that inspects
  snapshot exports must treat the schema version as authoritative and
  refuse older files.

## Canonical task envelope: `A2ATaskEnvelopeV1`

The legacy doc named the over-the-wire task shape `A2ATaskEnvelopeV1`.
In this broker the same envelope is realized by two complementary
shapes:

- `A2ATaskRequest` — the immutable request fields (intent, requester,
  target, optional workspace, optional proposal/artifact references,
  optional `assignedWorkerId`, optional `via` trace context). Authored
  by the caller, validated and frozen by the broker on create.
- `TaskRecord` — `A2ATaskRequest` plus broker-owned lifecycle fields:
  `status`, `targetNodeId`, `payload`, `updatedAt`, `claimedAt`,
  `completedAt`, `claimedBy`, `result`, `error`, `requeueCount`.

Equivalence rules a v1 envelope must satisfy:

| `A2ATaskEnvelopeV1` field | Broker field | Notes |
|---|---|---|
| `id` | `TaskRecord.id` | Broker-owned. Caller may pass an idempotency id at create. |
| `intent` | `A2ATaskRequest.intent` | One of `A2AExchangeIntent`. |
| `requester` | `A2ATaskRequest.requester` | `A2APartyRef` (`id`, `kind`, `role`). |
| `target` | `A2ATaskRequest.target` | `A2APartyRef`; `target.id` is the node id. |
| `assignedWorkerId` | `A2ATaskRequest.assignedWorkerId` | Optional pin at create time. |
| `workspace` | `A2ATaskRequest.workspace` | `WorkspaceRef` for proposal / apply intents. |
| `payload` | `TaskRecord.payload` | Structured fields the worker reads. |
| `parentTaskId` | `TaskRecord.parentTaskId` | Optional lineage link. Canceling a parent task fans out to non-terminal descendants. |
| `message` | `A2ATaskRequest.message` | Free-text prompt. |
| `proposalId`, `artifactIds` | `A2ATaskRequest.*` | Set when the task references a proposal lifecycle. |
| `via` | `A2ATaskRequest.via` | Transport / channel / trace context. |
| `policyContext` | `A2ATaskRequest.policyContext` | `requiresApproval`, `liveImpact`, `targetEnvironment`. |
| `status` | `TaskRecord.status` | Broker-owned. See state model below. |
| `result` | `TaskRecord.result` | Worker-supplied on `complete`. |
| `error` | `TaskRecord.error` | Worker-supplied on `fail`, or broker-supplied on dead-letter. |
| `cancellation` | `TaskRecord.cancellation` | Broker-written terminal cancel metadata: `requestedAt`, `requestedBy`, optional `reason`, optional `sourceTaskId`. |

For the read-side projection a JSON-RPC client receives, see
`projectBrokerTask` in `src/a2a/task-projection.ts` — it returns
`A2ATaskProjection` with an `A2A`-style `state` ("submitted",
"working", "completed", "failed", "canceled") plus an internal-status
metadata field, so consumers do not have to handcraft the mapping.

### Live-impact task gate

The broker treats `apply_local_change`, `promote_to_live`, `rollback_live`,
and any task explicitly marked `policyContext.liveImpact` or
`targetEnvironment: "live"` as human-gated live-impact work. Such tasks must
receive explicit operator approval before a worker can claim them. Creation is
accepted but the task enters `blocked` with an explicit
`policyContext.requiresApproval: true` marker; inferred live tasks also carry
`liveImpact: true` / `targetEnvironment: "live"` so workers, dashboards, and
closeout tools can surface the operational risk without re-parsing intent
names.

Operators or hubs resume a gated task with `POST /tasks/:id/approve`:

```json
{
  "actor": { "id": "operator-a", "role": "operator" },
  "approvalId": "chg-123",
  "reason": "change ticket reviewed"
}
```

Approval records `TaskRecord.approval` (`approvalId`, `approvedAt`,
`approvedBy`, `actorRole`, `requesterRole`, optional `reason`) and emits a
`task.approved` audit event. Repeating approval is idempotent and preserves the
first approval record; non-operator/non-hub actors are rejected.

## State model

`TaskStatus` values and the only legal transitions:

```
blocked ──> queued (operator/hub approval)
queued ──┬──> claimed ──> running ──┬──> succeeded
         │                          ├──> failed
         │                          └──> canceled
         ├──> canceled
         └──> failed (broker dead-letter after max requeues)
```

Notes:

- `queued -> claimed` happens on `POST /tasks/:id/claim` with the
  worker id.
- `blocked -> queued` happens on `POST /tasks/:id/approve`; claiming an
  approval-gated task without `TaskRecord.approval` is rejected.
- `claimed -> running` on `POST /tasks/:id/start`.
- `running -> succeeded | failed` on `POST /tasks/:id/complete` or
  `/fail`.
- `* -> canceled` is owned by `POST /tasks/:id/cancel` and the
  JSON-RPC `CancelTask` method (see "Cancel semantics").
- The broker may move a stuck task back from `claimed` or `running`
  to `queued` via the stale-task reaper. After
  `BROKER_MAX_REQUEUE_ATTEMPTS` requeues the next sweep dead-letters
  the task to `failed` with `error.code = "exceeded_requeue_limit"`.
  See `README.md` "Stale-task reaper" and "Requeue cap and
  dead-letter".
- A consumer must treat `succeeded`, `failed`, and `canceled` as
  terminal. The SSE stream marks the final event with `final: true`.
- The JSON-RPC projection (`A2ATaskState`) collapses
  `blocked | queued` into `submitted` and `claimed | running` into `working`.
  Consumers that need the precise
  internal status should read `metadata.internalStatus` from the
  projection.

## Request behavior

A request is one of:

1. **Open a new context (start a new exchange + first task).**
   - HTTP: `POST /exchanges` to create the exchange, then
     `POST /tasks` (or pass the new exchange id when creating the
     task).
   - JSON-RPC: `SendMessage` with no `metadata.exchangeId` and a
     required `metadata.targetNodeId`. The broker creates the
     exchange and the first task in one call and returns
     `{ contextId, messageId, task }`.
2. **Continue an existing context (post a message into an open
   exchange).**
   - HTTP: `POST /exchanges/:id/messages`.
   - JSON-RPC: `SendMessage` with `metadata.exchangeId` (or the
     A2A-style `metadata.contextId`).
3. **Pin a task to a specific worker.**
   - Set `assignedWorkerId` on the create request, or pass
     `metadata.assignedWorkerId` in the JSON-RPC variant.

Idempotency: callers should not retry `POST /tasks` on a transient
`5xx` without an idempotency id, because a duplicate task may be
seeded if the original actually landed.

## Update behavior

Updates split between the worker side and the requester side.

Worker side (lifecycle progression):

- `POST /tasks/:id/claim` — worker takes ownership; transitions
  `queued -> claimed`.
- `POST /tasks/:id/start` — worker begins work; transitions
  `claimed -> running`.
- `POST /tasks/:id/complete` — worker delivers `result`; transitions
  `running -> succeeded`.
- `POST /tasks/:id/fail` — worker reports `error`; transitions
  `running -> failed`.

Requester / hub side (context updates):

- `POST /exchanges/:id/messages` adds a thread message
  (`A2AExchangeMessageRequest`). The broker links it to the parent
  exchange and bumps `messageCount` / `lastMessageAt`.
- `POST /tasks/:id/reassign` (operator/hub only) re-pins the task to
  a different node or worker and resets `requeueCount` to `0` so the
  fresh target gets a clean attempt budget.
- `POST /tasks/:id/approve` (operator/hub only) records approval metadata and
  resumes an approval-gated task from `blocked` to `queued`.

The legacy library exposed an `applyA2ATaskProtocolUpdate` helper that
fanned out into either branch above. There is no in-process
equivalent in this broker; callers reach the same behavior over HTTP
or JSON-RPC.

## Cancel semantics

The legacy library doc fixed `runtime.cancelTarget` for
`{ kind: "session_run", sessionKey, runId? }`. The broker keeps that
semantics intact:

- `sessionKey` corresponds to the broker's `exchangeId` (the long-lived
  session / context handle).
- `runId` corresponds to a specific `TaskRecord.id` within that
  exchange. When `runId` is present, the caller cancels exactly that
  task.
- When `runId` is omitted, the caller is expected to resolve "the
  currently active run of this session" before cancel. The broker
  does **not** publish an exchange-level cancel today: the caller
  reads the active run id via `GET /exchanges/:id`
  (`activeTaskId`) — or from its own stored `contextId -> runId`
  state — and then issues the per-run cancel below. If `activeTaskId`
  is absent, there is no run to cancel; the caller should treat that
  as a no-op.

Wire forms:

- HTTP: `POST /tasks/:id/cancel` with `{ actor, reason? }`. Use this
  once the caller has resolved the `runId`.
- JSON-RPC: `CancelTask` with `{ taskId, actor?, reason? }`. The
  caller resolves `runId` from `GetTask` / `ListTasks` / its stored
  `contextId -> runId` mapping first.

Canonical cancel fields:

| Field | Writer | Meaning |
|---|---|---|
| `actor.id` | caller | Requester, worker, hub, or operator identity asking for cancel. |
| `actor.kind` | caller | Optional `session`, `node`, `user`, or `service` hint. |
| `actor.role` | caller | Optional role; `hub` and `operator` may cancel any non-terminal task. |
| `reason` | caller | Optional human-readable reason. Stored on the terminal `cancellation` record and audit note. |
| `cancellation.requestedAt` | broker | Terminal timestamp for the cancel transition. |
| `cancellation.requestedBy` | broker | The accepted `actor.id`. |
| `cancellation.reason` | broker | The accepted reason, if supplied. |
| `cancellation.sourceTaskId` | broker | Present only on fan-out descendants; points to the immediate parent task whose cancellation caused this task to cancel. |

Fan-out contract:

- Cancel is task-scoped. The top-level task named in the request is
  canceled first, then the broker recursively walks `parentTaskId`
  lineage and cancels every non-terminal descendant.
- Terminal descendants (`succeeded`, `failed`, `canceled`) are left
  unchanged. They do not receive new audit events, tombstones, or SSE
  updates.
- A direct cancel has no `cancellation.sourceTaskId`. For fan-out, each
  child stores the immediate parent task id as `sourceTaskId`; a
  grandchild therefore points to its parent child, not necessarily to
  the original top-level request.
- Repeated cancel on a terminal task is idempotent. The broker returns
  the existing task snapshot and preserves the first `cancellation`
  record, `completedAt`, audit event, tombstone, and final SSE event.
- A successful cancel clears transient execution fields (`claimedBy`,
  `claimedAt`, `result`, `error`), sets `completedAt`, writes a
  `task.canceled` audit event, emits a final task SSE update, writes a
  cancel tombstone, and syncs an exchange-linked task back to a queued
  exchange state so waiters do not remain orphaned.

Timeout and cleanup boundary:

- Broker stale recovery is not a cancel. Stale claimed/running tasks may
  requeue, and tasks that exceed the requeue cap dead-letter to
  `failed` with `error.code = "exceeded_requeue_limit"`.
- A plugin-owned timeout watchdog may call the broker cancel route to
  clean up an in-flight delegated task, while projecting a higher-level
  OpenClaw execution status such as `timed_out`. Broker consumers should
  use the broker terminal status (`canceled`) plus `cancellation.reason`
  for broker state, and should not infer timeout solely from a canceled
  broker task.
- Worker-reported timeout failures remain explicit failures: a worker
  that calls `failTask` with a timeout-flavored error produces broker
  `status = "failed"`, not `"canceled"`.

Authorization:

- `ENFORCE_REQUESTER_IDENTITY=1` (default in production) requires the
  `x-a2a-requester-id` header to match `actor.id`, and a stricter
  check on role when `actor.role` is supplied.
- A canceled task is terminal. Subsequent cancel calls return the
  current snapshot rather than a new state transition.

## Status read behavior

- HTTP: `GET /tasks/:id` returns the full `TaskRecord`. `GET /tasks`
  with the filters in `TaskListFilters` returns a list (intended for
  operator and hub callers, not high-fan-out plugin polling — see
  rate-limit notes in `docs/v1-acceptance-handoff.md`).
- JSON-RPC: `GetTask { taskId }` returns
  `{ task: A2ATaskProjection }`. `ListTasks` accepts the same
  filters.
- Live: `GET /a2a/tasks/:id/events` (SSE) and the JSON-RPC
  `SubscribeToTask` advisory call, plus `GET /a2a/operator/events`
  for operator summary subscribers. See "Event model" and
  "Operator Event Model" below.

The legacy `loadA2ATaskProtocolStatusById` corresponds to either
`GET /tasks/:id` (raw record) or JSON-RPC `GetTask` (A2A projection),
depending on which shape the caller wants.

## Event model

The broker is the authoritative event reducer. Clients do not run
their own reducer; they consume the projected snapshot plus the
delta stream.

Transport: Server-Sent Events at `GET /a2a/tasks/:id/events`.

Event types the stream emits:

- `task-snapshot` — fired once at connect time. Payload:
  `{ task: A2ATaskProjection, reason: "snapshot", final: boolean }`.
  `final: true` means the task is already terminal; the broker closes
  the connection right after the snapshot.
- `task-status-update` — fired on every subsequent state transition.
  Payload: `{ task: A2ATaskProjection, reason: string,
  final: boolean }`.
- `: heartbeat ...` SSE comments — sent every
  `TASK_SUBSCRIBE_HEARTBEAT_SEC` to keep proxies from closing idle
  connections. Comments are not events; clients that follow the SSE
  spec ignore them automatically.

Reconnect / replay:

- Each event carries an SSE `id:` line that encodes
  `(taskId, seq)`. Clients should send `Last-Event-ID` on reconnect.
- The broker buffers recent events per task. On reconnect with a
  valid `Last-Event-ID`, it replays missed events first, then sends
  a fresh `task-snapshot`, then resumes the live stream.
- `retry: 3000` is sent at connect time as a reconnect-delay
  advisory.

Authorization:

- The SSE route is gated by `assertRequesterCanSubscribeToTask`.
  The same `x-a2a-edge-secret` rule as other non-health routes
  applies when `EDGE_SECRET` is configured.

There is no separate event-constructor or reducer-helper API on the
broker. The legacy library exposed one because it ran the reducer
in-process; this broker owns the reducer and only emits projections.
A consumer that needs to fan events into its own UI should consume
the SSE stream and render `A2ATaskProjection` directly.

## Operator Event Model

Operator-facing summary consumers use a separate closed SSE surface at
`GET /a2a/operator/events`.

This stream reuses the task-subscription transport rules:

- `text/event-stream` response with `retry: 3000`
- one opening snapshot event on connect
- `: heartbeat ...` comments every
  `TASK_SUBSCRIBE_HEARTBEAT_SEC`
- `Last-Event-ID` replay with broker-owned monotonic sequence ids,
  then a fresh snapshot before live delivery resumes

Replay boundary note:

- replay only occurs when `Last-Event-ID` is both well-formed and still
  inside the broker's retained operator-event buffer. If the id is too
  old (gap already trimmed) or ahead of the broker's current sequence,
  the stream resets to a fresh `operator-snapshot` without partial
  replay.

The payload shapes are intentionally closed to four schemas:

- `operator-snapshot` — fired once at connect time. Payload:
  `{ summary, alerts }`, where `summary` is the same broker-owned
  shape returned by `GET /dashboard` and `alerts` is the same
  `AlertScanResult` shape returned by `GET /alerts`.
- `operator-summary-update` — fired when the broker-owned operator
  summary changes. Payload: `{ summary, alerts }`, where `summary`
  has the same shape as `GET /dashboard` and `alerts` is the current
  `AlertScanResult`.
- `operator-alert-opened` — fired when an alert newly enters the
  current alert set. Payload: `{ alert }`.
- `operator-alert-resolved` — fired when an alert leaves the current
  alert set. Payload: `{ alert }`, carrying the last broker-owned
  alert snapshot that was open before resolution.

Alert kind notes:

- `worker.heartbeat_missed` is broker-projected from worker
  `lastSeenAt` crossing the configured offline / missed-heartbeat
  threshold. This is based on existing worker state only; consumers do
  not infer it client-side.
- `gateway.unhealthy` is part of the closed operator alert vocabulary
  so gateway operators have a stable schema to target, but this broker
  does **not** synthesize a new gateway entity, health monitor, or
  runtime from it. Treat it as reserved unless an upstream gateway
  publisher is explicitly added.

As with task SSE, clients should treat the broker as authoritative and
apply events in increasing SSE `id:` order. If a single broker state
change affects both the summary and the alert set, the stream may emit
one `operator-summary-update` plus zero or more alert-opened /
alert-resolved events for that revision.

## Library export surface — retired

The archived legacy `a2a` repo published an in-process library
surface from `src/index.ts` with these entrypoints:

- `runA2ATaskRequest`
- `runA2ABrokerExchange`
- `applyA2ATaskProtocolUpdate`
- `applyA2ATaskProtocolCancel`
- `loadA2ATaskProtocolStatusById`
- event constructors and reducer helpers

This broker repo intentionally does **not** ship a `src/index.ts`
library surface. The broker is delivered as a service; protocol
behavior is reached over HTTP and JSON-RPC. Migration map for
existing callers:

| Legacy in-process call | Broker equivalent |
|---|---|
| `runA2ATaskRequest(...)` | `POST /tasks` (raw record), or JSON-RPC `SendMessage` with `metadata.targetNodeId` (creates a fresh exchange + first task in one call). |
| `runA2ABrokerExchange(...)` | `POST /exchanges` followed by `POST /tasks`, or a single JSON-RPC `SendMessage` with no `metadata.exchangeId`. |
| `applyA2ATaskProtocolUpdate(...)` | Worker side: `POST /tasks/:id/{claim,start,complete,fail}`. Operator side: `POST /tasks/:id/approve` and `POST /tasks/:id/reassign`. Requester side: `POST /exchanges/:id/messages`. |
| `applyA2ATaskProtocolCancel(...)` | `POST /tasks/:id/cancel`, or JSON-RPC `CancelTask`. `runtime.cancelTarget` semantics preserved (see "Cancel semantics"). |
| `loadA2ATaskProtocolStatusById(...)` | `GET /tasks/:id` (raw record) or JSON-RPC `GetTask` (A2A projection). |
| event constructors / reducer helpers | None. The broker owns the reducer; consume `GET /a2a/tasks/:id/events` (SSE) and render `A2ATaskProjection` directly. |

### Consumer-facing break

Any consumer that imported from the legacy library `src/index.ts`
must migrate. There is no shim package and no re-export path in this
repo. Concretely:

- import-time failure — code that did
  `import { runA2ATaskRequest } from "a2a"` (or similar) will not
  resolve against this repo.
- in-process reducer expectations — code that built its own task
  state by replaying constructed events must move to consuming the
  broker's SSE stream (snapshot + `task-status-update`), since the
  reducer is no longer published as helpers.
- transport assumptions — direct function calls become network
  calls; callers must add `x-a2a-requester-id` /
  `x-a2a-requester-kind` / `x-a2a-requester-role` headers, and
  `x-a2a-edge-secret` when the broker is configured with one.

These breaks are intentional. The legacy in-process surface is not
preserved in this repo and will not be re-introduced.

## Delete-gate evidence (for parent issue #6)

This section is a checklist that maps each protocol claim from the
archived legacy doc to its broker-owned home in this repo, so the
legacy doc and the legacy library entrypoints can be deleted as part
of `#6` without losing reference material.

| Archived legacy doc claim | Broker-owned replacement |
|---|---|
| `A2ATaskEnvelopeV1` shape | "Canonical task envelope" section above; `A2ATaskRequest` + `TaskRecord` in `src/core/types.ts`. |
| Request behavior | "Request behavior" section above; `POST /exchanges`, `POST /tasks`, JSON-RPC `SendMessage` in `src/a2a/json-rpc.ts`. |
| Update behavior | "Update behavior" section above; `POST /tasks/:id/{approve,claim,start,complete,fail,reassign}`, `POST /exchanges/:id/messages`. |
| Cancel behavior + `runtime.cancelTarget` for `session_run` | "Cancel semantics" section above; `POST /tasks/:id/cancel`, JSON-RPC `CancelTask`. |
| Status read behavior | "Status read behavior" section above; `GET /tasks/:id`, JSON-RPC `GetTask` / `ListTasks`. |
| Event model | "Event model" section above; SSE at `GET /a2a/tasks/:id/events`, projection in `src/a2a/task-projection.ts`. |
| State model | "State model" section above; `TaskStatus` in `src/core/types.ts`. |
| Public entrypoints from legacy `src/index.ts` | "Library export surface — retired" section above; explicit migration table; no shim. |

When `#6` deletes the archived doc and the legacy `src/index.ts`,
this file is the canonical reference consumers should be redirected
to. README.md "Design docs" lists it first so the broker repo is the
first stop.
