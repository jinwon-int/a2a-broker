# API spec draft

This draft extends the current minimal broker API toward the trading-partner workflow.

It is intentionally phase-oriented:

- keep existing exchange routes for compatibility
- add proposal-first lifecycle routes first
- leave room for worker and OpenClaw adapters later

## Conventions

- request and response bodies are JSON
- timestamps are ISO-8601 strings in UTC
- IDs are opaque strings
- mutating routes should send requester headers when identity enforcement is enabled
- `4xx` errors are caller problems
- `5xx` errors are broker problems

## Requester headers

For mutating routes, the broker can verify caller identity with:

- `x-a2a-requester-id`
- `x-a2a-requester-kind`
- `x-a2a-requester-role`

Phase 1 verification is body and route aware:

- worker register must match `nodeId`
- worker heartbeat must match worker path id
- exchange create must match `requester.id`
- proposal create must match `source.id`
- validation submit must match `nodeId`
- approve, reject, and apply must match `actor.id`

## Existing routes to keep


### `GET /dashboard`

Aggregated operator summary of queue, history, proposals, and workers.
Requires edge secret authentication (same as other non-health routes).

**Query parameters** (all optional):

| Parameter | Default | Description |
|---|---|---|
| `recent_history_limit` | `10` | Max items in `history.recent` |
| `oldest_pending_limit` | `5` | Max items in `queue.oldestPending` |
| `pending_action_limit` | `5` | Max items in `proposals.pendingAction` |

**Response** (`200`):

```json
{
  "generatedAt": "2026-04-15T10:00:00.000Z",
  "queue": {
    "total": 3,
    "byStatus": { "blocked": 0, "queued": 2, "claimed": 1, "running": 0, "succeeded": 0, "failed": 0, "canceled": 0 },
    "byIntent": { "analyze": 2, "backfill": 1 },
    "oldestPending": [
      {
        "id": "...",
        "intent": "analyze",
        "status": "queued",
        "targetNodeId": "dungae",
        "assignedWorkerId": "dungae",
        "createdAt": "...",
        "statusSinceAt": "...",
        "statusAgeSec": 42
      }
    ]
  },
  "history": {
    "completedLastHour": 5,
    "failedLastHour": 1,
    "totalCompleted": 42,
    "totalFailed": 3,
    "recent": [
      { "id": "...", "intent": "validate_change", "status": "succeeded", "targetNodeId": "dungae", "completedAt": "...", "result": { "summary": "..." } }
    ]
  },
  "proposals": {
    "total": 7,
    "byStatus": { "submitted": 2, "validated": 1, "approved": 1, "applied": 3 },
    "pendingAction": [
      { "id": "...", "kind": "patch", "summary": "...", "status": "submitted", "sourceNodeId": "sogyo", "targetNodeId": "bangtong", "updatedAt": "..." }
    ]
  },
  "workers": {
    "total": 3,
    "online": 2,
    "stale": 1,
    "byNode": [
      {
        "nodeId": "bangtong",
        "role": "live-trader",
        "displayName": "방통",
        "status": "online",
        "activeTaskCount": 1,
        "lastSeenAt": "...",
        "lastSeenAgeSec": 8
      }
    ]
  },
  "observability": {
    "queuePressure": {
      "blocked": 0,
      "queued": 2,
      "claimed": 1,
      "running": 0,
      "staleWorkerAssignments": 0,
      "oldestClaimed": {
        "id": "...",
        "intent": "validate_change",
        "targetNodeId": "bangtong",
        "assignedWorkerId": "bangtong",
        "createdAt": "...",
        "statusSinceAt": "...",
        "statusAgeSec": 19
      }
    },
    "recovery": {
      "totalRequeued": 4,
      "totalDeadLettered": 1,
      "recentRequeues": [],
      "recentDeadLetters": []
    },
    "workerHealth": {
      "staleWorkersWithActiveTasks": [
        { "nodeId": "dungae", "activeTaskCount": 2, "lastSeenAt": "...", "lastSeenAgeSec": 137 }
      ]
    }
  },
  "staleReaper": {
    "enabled": true,
    "intervalSec": 60,
    "olderThanSec": 90,
    "maxRequeueAttempts": 5,
    "lastRunAt": "...",
    "lastRequeued": 1,
    "lastDeadLettered": 0,
    "totalDeadLettered": 1,
    "runCount": 12
  },
  "requestPressure": {
    "general": { "limit": 10, "windowMs": 60000, "activeKeys": 1, "allowedRequests": 42, "deniedRequests": 0, "busiest": [] },
    "worker": { "limit": 60, "windowMs": 60000, "activeKeys": 1, "allowedRequests": 8, "deniedRequests": 0, "busiest": [] }
  },
  "attention": {
    "highestSeverity": "warn",
    "items": [
      {
        "code": "dead-lettered-tasks",
        "severity": "warn",
        "count": 1,
        "summary": "1 task(s) were dead-lettered and need operator review"
      },
      {
        "code": "aged-claimed-task",
        "severity": "warn",
        "count": 1,
        "summary": "claimed task task-123 has been waiting 91s since claim"
      }
    ]
  }
}
```

**Design notes:**

- **queue.oldestPending**: sorted by `statusSinceAt` ascending — operators see what has been stuck the longest in its current queued/claimed state first.
- **history.recent**: sorted by `completedAt` descending (newest first) — quick view of recent throughput and failures.
- **proposals.pendingAction**: proposals in `submitted`, `validated`, or `approved` status — these are blocking on the next actor.
- **workers.byNode**: includes `activeTaskCount` and `lastSeenAgeSec` — spot overloading and stale heartbeats without extra client-side time math.
- **observability.queuePressure.oldestClaimed / oldestRunning**: expose `statusSinceAt` and `statusAgeSec` so dashboards can flag stuck work using broker-owned timing, not browser clocks.
- **staleReaper**: mirrors the runtime reaper status from `/health`, letting dashboard/inspector clients render recovery state without a second fetch.
- **requestPressure**: mirrors general vs worker bucket snapshots so operator UIs can detect throttling pressure without polling `/health`.
- **attention**: broker-owned alert projection for dashboard/inspector UIs. Clients can render `highestSeverity` and `items` directly without re-implementing stale-worker, dead-letter, aged claimed/running task, or rate-limit interpretation rules.
- All limits are configurable via query params to keep responses small on constrained clients.
- Computed lazily on each request with no extra persistence.


### `GET /health`

Response:

```json
{
  "ok": true,
  "service": "a2a-broker",
  "brokerId": "broker-primary",
  "version": "0.2.3",
  "build": {
    "component": "a2a-broker",
    "revision": "78b2b42fca6e",
    "source": "github.com/jinwon-int/a2a-broker",
    "builtAt": "2026-05-01T15:03:42Z",
    "runtime": "docker",
    "image": { "tag": "broker:0.2.3", "digest": "sha256:..." }
  },
  "publicBaseUrl": "http://<masked-host>:8787",
  "uptimeSec": 123,
  "persistence": {
    "kind": "json-file",
    "stateFile": "/var/lib/a2a-broker/state.json",
    "stateVersion": 2
  },
  "workers": {
    "offlineAfterSec": 90
  },
  "requestSecurity": {
    "enforceRequesterIdentity": true,
    "rateLimitWindowSec": 60,
    "rateLimitMaxRequests": 10
  }
}
```

`brokerId` is a durable broker identity sourced from `brokerId` server config, `A2A_BROKER_ID`, `BROKER_ID`, or the service name fallback. `version` is always a non-empty package/release version fallback. `build.revision` is sourced from `A2A_BROKER_REVISION`, legacy `BROKER_RELEASE_REVISION` / `RELEASE_REVISION`, or generated build-info metadata; it falls back to `"unknown"` rather than `null`. Unsafe values such as tokenized remotes, host paths, or oversized strings are redacted/omitted before they reach health or dashboard JSON.
The same `version` and `build` fields are also included in `GET /dashboard` for operator status views.

### `GET /exchanges`

Response:

```json
{
  "items": []
}
```

### `POST /exchanges`

Request:

```json
{
  "requester": { "id": "<hub-node>", "kind": "node", "role": "hub" },
  "target": { "id": "dengae", "kind": "node", "role": "researcher" },
  "message": "analyze strategy drift",
  "maxTurns": 8,
  "intent": "analyze"
}
```

## Worker routes

### `GET /workers`

Optional query params:

- `role`
- `environment`
- `workspaceId`

Response:

```json
{
  "items": [
    {
      "nodeId": "dengae",
      "role": "researcher",
      "displayName": "Dengae research worker",
      "brokerUrl": "http://dengae-worker:8787",
      "capabilities": {
        "canAnalyze": true,
        "canBackfill": true,
        "canPatchWorkspace": true,
        "canPromoteLive": false,
        "workspaceIds": ["kr-futures-research"],
        "environments": ["research"]
      },
      "metadata": {
        "host": "dengae"
      },
      "createdAt": "2026-04-12T15:00:00.000Z",
      "updatedAt": "2026-04-12T15:00:00.000Z",
      "lastSeenAt": "2026-04-12T15:00:00.000Z",
      "status": "online"
    }
  ]
}
```

### `POST /workers/register`

Request:

```json
{
  "nodeId": "dengae",
  "role": "researcher",
  "displayName": "Dengae research worker",
  "brokerUrl": "http://dengae-worker:8787",
  "capabilities": {
    "canAnalyze": true,
    "canBackfill": true,
    "canPatchWorkspace": true,
    "canPromoteLive": false,
    "workspaceIds": ["kr-futures-research"],
    "environments": ["research"]
  },
  "metadata": {
    "host": "dengae"
  }
}
```

Response:

```json
{
  "nodeId": "dengae",
  "role": "researcher",
  "displayName": "Dengae research worker",
  "brokerUrl": "http://dengae-worker:8787",
  "capabilities": {
    "canAnalyze": true,
    "canBackfill": true,
    "canPatchWorkspace": true,
    "canPromoteLive": false,
    "workspaceIds": ["kr-futures-research"],
    "environments": ["research"]
  },
  "metadata": {
    "host": "dengae"
  },
  "createdAt": "2026-04-12T15:00:00.000Z",
  "updatedAt": "2026-04-12T15:00:00.000Z",
  "lastSeenAt": "2026-04-12T15:00:00.000Z",
  "status": "online",
  "brokerId": "broker-primary"
}
```

### `GET /workers/:id`

Response:

```json
{
  "nodeId": "dengae",
  "role": "researcher",
  "displayName": "Dengae research worker",
  "brokerUrl": "http://dengae-worker:8787",
  "capabilities": {
    "canAnalyze": true,
    "canBackfill": true,
    "canPatchWorkspace": true,
    "canPromoteLive": false,
    "workspaceIds": ["kr-futures-research"],
    "environments": ["research"]
  },
  "createdAt": "2026-04-12T15:00:00.000Z",
  "updatedAt": "2026-04-12T15:00:00.000Z",
  "lastSeenAt": "2026-04-12T15:00:00.000Z",
  "status": "online"
}
```

### `POST /workers/:id/heartbeat`

Request:

```json
{
  "metadata": {
    "host": "dengae"
  }
}
```

Response:

```json
{
  "nodeId": "dengae",
  "role": "researcher",
  "displayName": "Dengae research worker",
  "brokerUrl": "http://dengae-worker:8787",
  "capabilities": {
    "canAnalyze": true,
    "canBackfill": true,
    "canPatchWorkspace": true,
    "canPromoteLive": false,
    "workspaceIds": ["kr-futures-research"],
    "environments": ["research"]
  },
  "createdAt": "2026-04-12T15:00:00.000Z",
  "updatedAt": "2026-04-12T15:10:00.000Z",
  "lastSeenAt": "2026-04-12T15:10:00.000Z",
  "status": "online"
}
```

## New proposal routes

### `POST /proposals`

Create a patch or parameter proposal.

Request:

```json
{
  "source": { "id": "dengae", "kind": "node", "role": "researcher" },
  "target": { "id": "bangtong", "kind": "node", "role": "live-trader" },
  "kind": "patch",
  "summary": "Tighten entry filter after weak overnight breakouts",
  "rationale": "Backfill shows lower drawdown and fewer low-conviction entries.",
  "workspace": {
    "nodeId": "dengae",
    "workspaceId": "kr-futures-research",
    "branch": "exp/entry-filter-v3",
    "strategyId": "mean-revert-01"
  },
  "patchText": "diff --git a/strategy.py b/strategy.py\n...",
  "artifactIds": []
}
```

Response:

```json
{
  "id": "prop_01",
  "sourceNodeId": "dengae",
  "targetNodeId": "bangtong",
  "kind": "patch",
  "summary": "Tighten entry filter after weak overnight breakouts",
  "status": "submitted",
  "workspace": {
    "nodeId": "dengae",
    "workspaceId": "kr-futures-research",
    "branch": "exp/entry-filter-v3",
    "strategyId": "mean-revert-01"
  },
  "artifactIds": [],
  "createdAt": "2026-04-12T15:00:00.000Z",
  "updatedAt": "2026-04-12T15:00:00.000Z"
}
```

### `GET /proposals`

Optional query params:

- `status`
- `sourceNodeId`
- `targetNodeId`
- `kind`

Response:

```json
{
  "items": [
    {
      "id": "prop_01",
      "sourceNodeId": "dengae",
      "targetNodeId": "bangtong",
      "kind": "patch",
      "summary": "Tighten entry filter after weak overnight breakouts",
      "status": "submitted",
      "updatedAt": "2026-04-12T15:00:00.000Z"
    }
  ]
}
```

### `GET /proposals/:id`

Response:

```json
{
  "id": "prop_01",
  "sourceNodeId": "dengae",
  "targetNodeId": "bangtong",
  "kind": "patch",
  "summary": "Tighten entry filter after weak overnight breakouts",
  "rationale": "Backfill shows lower drawdown and fewer low-conviction entries.",
  "status": "submitted",
  "workspace": {
    "nodeId": "dengae",
    "workspaceId": "kr-futures-research",
    "branch": "exp/entry-filter-v3",
    "strategyId": "mean-revert-01"
  },
  "patchText": "diff --git a/strategy.py b/strategy.py\n...",
  "artifactIds": ["art_01"],
  "createdAt": "2026-04-12T15:00:00.000Z",
  "updatedAt": "2026-04-12T15:30:00.000Z"
}
```

## Artifact routes

### `POST /proposals/:id/artifacts`

Attach metadata for a report, diff bundle, or benchmark output.

Request:

```json
{
  "kind": "backfill-report",
  "uri": "file:///artifacts/reports/backfill-20260412.json",
  "contentType": "application/json",
  "sizeBytes": 48012,
  "summary": "2024-01 to 2026-04 replay with improved Sharpe and lower drawdown"
}
```

Response:

```json
{
  "id": "art_01",
  "proposalId": "prop_01",
  "kind": "backfill-report",
  "uri": "file:///artifacts/reports/backfill-20260412.json",
  "contentType": "application/json",
  "sizeBytes": 48012,
  "summary": "2024-01 to 2026-04 replay with improved Sharpe and lower drawdown",
  "createdAt": "2026-04-12T15:10:00.000Z"
}
```

## Validation routes

### `POST /proposals/:id/validate`

Submit a validation result, usually from `bangtong` or a designated validator.

Request:

```json
{
  "nodeId": "bangtong",
  "kind": "backfill",
  "verdict": "pass",
  "metrics": {
    "netPnl": 1240000,
    "maxDrawdown": 0.082,
    "sharpe": 1.41,
    "tradeCount": 442
  },
  "artifactIds": ["art_01"],
  "note": "Pass on local replay. Live guard still required."
}
```

Response:

```json
{
  "id": "val_01",
  "proposalId": "prop_01",
  "nodeId": "bangtong",
  "kind": "backfill",
  "verdict": "pass",
  "metrics": {
    "netPnl": 1240000,
    "maxDrawdown": 0.082,
    "sharpe": 1.41,
    "tradeCount": 442
  },
  "artifactIds": ["art_01"],
  "createdAt": "2026-04-12T15:20:00.000Z"
}
```

## Approval routes

Task approval-gate decisions are preserved on the task record as
`approvalOutcome`. An approved outcome also keeps the legacy `approval` record
for callers that only need the approval release metadata. Negative terminal
outcomes cancel the task and leave the live-impact work unclaimable.

### `POST /tasks/:id/reject-approval`

Request:

```json
{
  "actor": { "id": "operator-a", "kind": "node", "role": "operator" },
  "approvalId": "chg-rejected-1",
  "status": "rejected",
  "reason": "Rejected after reviewing the exact live-impact step."
}
```

`status` may be `rejected`, `expired`, or `canceled` and defaults to
`rejected`.

Response: the canceled task record, including `approvalOutcome` and
`cancellation` metadata.

### `POST /proposals/:id/approve`

Request:

```json
{
  "actor": { "id": "bangtong", "kind": "node", "role": "live-trader" },
  "note": "Approved for local apply after replay pass."
}
```

Response:

```json
{
  "ok": true,
  "proposalId": "prop_01",
  "status": "approved",
  "updatedAt": "2026-04-12T15:25:00.000Z"
}
```

### `POST /proposals/:id/reject`

Request:

```json
{
  "actor": { "id": "bangtong", "kind": "node", "role": "live-trader" },
  "note": "Rejected because slippage sensitivity worsened in the local replay."
}
```

Response:

```json
{
  "ok": true,
  "proposalId": "prop_01",
  "status": "rejected",
  "updatedAt": "2026-04-12T15:25:00.000Z"
}
```

## Apply routes

### `POST /proposals/:id/apply`

This route marks that the target node applied the change locally.

Request:

```json
{
  "actor": { "id": "bangtong", "kind": "node", "role": "live-trader" },
  "workspace": {
    "nodeId": "bangtong",
    "workspaceId": "kr-futures-live",
    "strategyId": "mean-revert-01"
  },
  "note": "Applied locally to live workspace after validation and approval."
}
```

Response:

```json
{
  "ok": true,
  "proposalId": "prop_01",
  "status": "applied",
  "updatedAt": "2026-04-12T15:30:00.000Z"
}
```

## Promotion routes

### `POST /proposals/:id/promote`

Optional in phase 2 or later.

Request:

```json
{
  "actor": { "id": "bangtong", "kind": "node", "role": "live-trader" },
  "targetEnvironment": "live",
  "note": "Promoted after staged replay and operator review."
}
```

### `POST /proposals/:id/rollback`

Optional in phase 2 or later.

Request:

```json
{
  "actor": { "id": "bangtong", "kind": "node", "role": "live-trader" },
  "reason": "Unexpected drawdown expansion after rollout"
}
```

## Audit routes

### `GET /audit`

Optional filters:

- `proposalId`
- `actorId`
- `targetId`
- `action`

Response:

```json
{
  "items": [
    {
      "id": "aud_01",
      "actorId": "dengae",
      "action": "proposal.created",
      "targetType": "proposal",
      "targetId": "prop_01",
      "note": "Initial patch proposal submitted",
      "createdAt": "2026-04-12T15:00:00.000Z"
    },
    {
      "id": "aud_02",
      "actorId": "dengae",
      "action": "worker.registered",
      "targetType": "worker",
      "targetId": "dengae",
      "note": "Dengae research worker",
      "createdAt": "2026-04-12T15:01:00.000Z"
    }
  ]
}
```

## A2A surface

The broker exposes an A2A-compatible surface alongside the legacy REST routes. See
`docs/protocol-compatibility.md` for the supported A2A profile, compatibility
matrix, and current non-goals.

### `GET /.well-known/agent-card.json`

Returns the agent card describing the broker for A2A clients. `capabilities.streaming`
is `true`; clients discover the SSE subscription route via `SubscribeToTask`.

### `POST /a2a/jsonrpc`

JSON-RPC 2.0 endpoint. Supported methods:

- `SendMessage` — create a task or append to an existing exchange.
- `GetTask` — fetch the current task snapshot by id.
- `ListTasks` — filter tasks by status, target, intent, etc.
- `CancelTask` — cancel a task owned by the caller. If the task has descendants linked by
  `parentTaskId`, the broker fans the cancel out to every non-terminal child task recursively.
  Repeated cancel calls are idempotent and return the original terminal task snapshot unchanged.
  Direct cancel requests accept `{ taskId, actor?, reason? }`. The resulting broker task includes
  `cancellation: { requestedAt, requestedBy, reason?, sourceTaskId? }`; `sourceTaskId` appears only
  on fan-out descendants and points to the immediate parent that caused the child cancel. Terminal
  descendants are not mutated or re-emitted.
- `SubscribeToTask` — return the current snapshot and the SSE URL clients should
  connect to for live updates. The actual stream is served at
  `GET /a2a/tasks/:id/events` because JSON-RPC over a single POST cannot carry a
  multi-event stream.
- `GetExtendedAgentCard` — return the full agent card.

`SubscribeToTask` response shape:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "task": { "id": "task_01", "status": "queued", "...": "..." },
    "subscription": {
      "transport": "sse",
      "url": "https://broker.example.com/a2a/tasks/task_01/events",
      "eventTypes": ["task-snapshot", "task-status-update"]
    }
  }
}
```

### `GET /a2a/tasks/:id/events` (SSE)

Server-Sent Events stream of task lifecycle updates.

**Headers:**

- `content-type: text/event-stream; charset=utf-8`
- `cache-control: no-cache, no-transform`
- `connection: keep-alive`
- `x-accel-buffering: no`

**Events:**

- `task-snapshot` — emitted once at connect with the current task state and
  `reason: "snapshot"`. If the task is already terminal (`succeeded`, `failed`,
  `canceled`) the server closes the connection immediately after this event.
- `task-status-update` — emitted on each lifecycle transition. `reason` is one of
  `created`, `approved`, `claimed`, `started`, `succeeded`, `failed`, `canceled`, `reassigned`,
  `requeued`, `dead_lettered`. `final: true` signals a terminal state and the
  server closes the connection.

**Heartbeats:** every `TASK_SUBSCRIBE_HEARTBEAT_SEC` seconds (default `15`) the
server writes a `:heartbeat <iso>` SSE comment to keep intermediaries from
idling the connection. Set to `0` to disable.

**Authorization:** when requester identity enforcement is enabled, subscribers
must present `x-a2a-requester-id` matching one of: the task requester, the
task target node, the assigned worker, or a `hub`/`operator` role.

Example event block:

```
id: 2026-04-17T10:00:02.000Z
event: task-status-update
data: {"task":{"id":"task_01","status":"succeeded","..."},"reason":"succeeded","final":true}
```

## Error shape

Recommended shared error format:

```json
{
  "error": {
    "code": "policy_denied",
    "message": "research nodes cannot apply directly to live workspaces"
  }
}
```

### Suggested error codes

- `bad_request`
- `unauthorized`
- `not_found`
- `policy_denied`
- `invalid_transition`
- `rate_limited`
- `conflict`
- `unsupported`
- `internal_error`

## Minimal worker callback shape for later

This is not required in phase 1, but it helps keep the API future-safe.

### worker capability registration

```json
{
  "nodeId": "dengae",
  "role": "researcher",
  "capabilities": {
    "canAnalyze": true,
    "canBackfill": true,
    "canPatchWorkspace": true,
    "canPromoteLive": false,
    "workspaceIds": ["kr-futures-research"],
    "environments": ["research"]
  }
}
```

Broker state now includes a schema version and worker records so restart recovery preserves:

- worker identity
- worker capabilities
- last heartbeat timestamp
- proposal and audit continuity

## Suggested implementation sequence

1. proposal routes
2. artifact metadata route
3. validation route
4. approve/reject/apply routes
5. audit query route
6. promote and rollback later
