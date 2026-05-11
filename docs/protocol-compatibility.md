# A2A protocol compatibility matrix

This matrix is the public compatibility statement for `a2a-broker` before the
repository is presented as an open A2A implementation.

## Current supported profile

**Current profile: A2A 1.0-compatible broker alpha profile.**

The broker exposes A2A 1.0-style discovery and JSON-RPC task operations while
keeping broker-owned task lifecycle, worker routing, policy gates, and evidence
semantics as its source of truth. The surface is compatible enough for clients
that can use the documented methods and tolerate broker metadata, but it is not
yet a claim of full conformance to every official A2A 1.0 operation or optional
binding.

The agent card currently advertises:

- `protocolVersion: "1.0"`
- JSON-RPC endpoint: `/a2a/jsonrpc`
- public discovery: `/.well-known/agent-card.json`
- streaming capability: `true`, implemented as SSE discovered via
  `SubscribeToTask`
- push notification capability: `false`
- default input/output modes: `text`
- public projected task states: `submitted`, `working`, `completed`, `failed`, `canceled`

## Compatibility matrix

| Area | Current support | Compatibility notes | Conformance gate |
|---|---|---|---|
| Protocol version | A2A 1.0-compatible broker alpha profile. | The broker uses 1.0-style agent cards and JSON-RPC method names, but still documents broker-specific metadata and lifecycle. No 0.3 compatibility mode is implemented. | `src/a2a/protocol-compatibility.test.ts` asserts the advertised agent-card protocol version and capability flags. |
| Message send | `SendMessage` creates a new exchange + task when `metadata.targetNodeId` is present and no context exists; appends to an existing exchange when `metadata.exchangeId` or `metadata.contextId` is present. Text input is accepted as a string, `{ text }`, or text `parts`. | New-context sends require an already registered target worker. Supported metadata includes `intent`, `targetNodeId`, `assignedWorkerId`, `exchangeId`/`contextId`, `parentMessageId`, transport/channel/node/session/trace fields. Task projections expose `metadata.contextId` and `metadata.referenceTaskIds` so follow-up/refinement tasks can stay in the same context while pointing back to prior immutable work. | Existing server JSON-RPC tests cover create/follow-up behavior; the compatibility gate pins the public task projection shape returned by these calls. |
| Streaming | `SubscribeToTask` returns the current task snapshot and an SSE URL. Live events are served by `GET /a2a/tasks/:id/events`. | JSON-RPC POST does not carry the event stream itself. SSE events are `task-snapshot` and `task-status-update`; terminal updates set `final: true` and close the stream. | Existing SSE tests cover snapshot, update, terminal close, heartbeat, replay, and auth behavior. |
| Task get/list | `GetTask` returns `{ task: A2ATaskProjection }`. `ListTasks` returns `{ tasks: A2ATaskListProjection[] }`. | Filters are broker-oriented: `exchangeId`/`contextId`, internal `status`, `targetNodeId`, `proposalId`, `intent`, `claimedBy`, `assignedWorkerId`. Pagination and history-length controls are not implemented yet. | The compatibility gate pins the task projection keys, list projection summary behavior, and internal-status to A2A-state mapping. |
| Cancel | `CancelTask` cancels a task and fans out to non-terminal descendants linked by `parentTaskId`. Repeated cancel is idempotent. | Requester identity enforcement can require `x-a2a-requester-id` to match the explicit actor. Broker cancellation metadata is exposed under `metadata.cancellation`. Terminal tasks (`succeeded`, `failed`, `canceled`) are immutable: reassign, complete, fail, and cancel all no-op or reject for terminal tasks. | Existing JSON-RPC/server tests cover cancel state mapping and idempotent fan-out semantics. |
| Push notifications | Not supported. Agent card advertises `capabilities.pushNotifications: false`. | Push config, auth, retries, replay protection, receipt semantics, and push receipts are deferred. Terminal outbox APIs are broker/operator integration surfaces, not A2A push notification conformance. | The compatibility gate asserts the agent card continues to advertise push notifications as disabled until this matrix is updated. |
| Agent card/discovery | `GET /.well-known/agent-card.json` exposes the broker card, endpoint URL, provider metadata if configured, capabilities, and broker skills. `GetExtendedAgentCard` returns the same card over JSON-RPC. Worker capability cards provide a separate AgentCard-compatible registry subset for assignment-safety queries. | Public discovery exposes broker-level capabilities, not individual worker private state. Worker capability cards are validated before query results are usable and public-safe cards must omit broker URLs, workspace ids, secrets, and raw metadata. Worker capacity/health APIs remain separate broker/operator surfaces. | Agent-card server tests, worker capability-card tests, and the compatibility gate pin the advertised profile. |
| Artifacts | Task projections expose `artifacts: [{ id }]` from `task.result.artifactIds` or request `artifactIds`. | The broker preserves richer runner evidence and artifacts in internal result/evidence records; the A2A projection intentionally exposes only stable artifact ids today. Full A2A `Artifact`/`Part` expansion is deferred. | The compatibility gate pins artifact id projection behavior. |
| Tenant/context IDs | Exchanges map to A2A-style contexts. `SendMessage` accepts `metadata.contextId` as an alias for `exchangeId`; task projections expose both `metadata.exchangeId` and `metadata.contextId`. | There is no separate tenant isolation claim in the A2A profile. Multi-tenant context grouping beyond broker requester/target metadata is a non-goal for this profile. Follow-up task records may carry `referenceTaskIds` identifiers for lineage without exposing prior task internals. | Existing JSON-RPC tests cover `contextId` alias behavior; compatibility tests pin `contextId`/`referenceTaskIds` projection. |
| Authentication | Edge-secret protection and requester identity headers protect the broker facade. | Official A2A auth-flow guidance is not fully modeled. OAuth/OIDC discovery and dynamic client auth are deferred. | Request-security and SSE auth tests cover current fail-closed behavior. |
| Peer status extension | `a2a.peer.status` / `PeerStatus` is broker-specific. | This method is outside the A2A 1.0 compatibility claim and must be treated as an OpenClaw/broker extension. | Peer-status tests cover extension semantics separately. |

## Non-goals for the current profile

- Full official A2A 1.0 conformance across every optional operation and binding.
- A2A 0.3 compatibility mode.
- Push notification configuration, delivery, retries, replay protection, and receipt
  semantics as an A2A push implementation.
- Pagination/filtering/history-length parity beyond the current broker task filters.
- Rich official `Artifact`/`Part` projection beyond stable artifact ids.
- OAuth/OIDC or other dynamic public auth-flow discovery.
- Treating broker-specific extension methods such as `a2a.peer.status` as part of
  the A2A compatibility claim.

## Broker-status to A2A 1.0 task-state mapping

The broker maintains its own internal task lifecycle with precision states
(`blocked`, `queued`, `claimed`, `running`, `succeeded`, `failed`, `canceled`).
Public A2A 1.0 projections collapse these into five standard states:

| Broker internal status | A2A 1.0 projected state | Terminal? |
|------------------------|------------------------|----------|
| `blocked`              | `submitted`            | no        |
| `queued`               | `submitted`            | no        |
| `claimed`              | `working`              | no        |
| `running`              | `working`              | no        |
| `succeeded`            | `completed`            | **yes**   |
| `failed`               | `failed`               | **yes**   |
| `canceled`             | `canceled`             | **yes**   |

**Terminal immutability:** Once a task reaches `succeeded`, `failed`, or
`canceled`, the broker rejects further lifecycle mutations. The projected A2A
state cannot transition out of the corresponding terminal state.

This mapping is the source of truth implemented in `src/a2a/task-projection.ts`
and verified by `src/a2a/protocol-compatibility.test.ts` and the terminal
immutability tests in `src/core/broker.test.ts`.

## Compatibility change process

Any change to the public A2A shape must update this document and the compatibility
gate in the same pull request. In particular, update both before changing:

- agent-card `protocolVersion`, capability flags, endpoint URL, or input/output
  modes;
- JSON-RPC method names or parameter aliases;
- `A2ATaskProjection` / `A2ATaskListProjection` keys;
- internal task-status to A2A task-state mapping;
- artifact projection behavior;
- the stated support/non-goal status of push notifications, pagination, auth, or
  0.3 compatibility.

See also:

- `docs/a2a-protocol.md` for canonical broker protocol semantics.
- `docs/api-spec-draft.md` for route-level request/response examples.
- `docs/v1-acceptance-handoff.md` for the publication and handoff gate.
