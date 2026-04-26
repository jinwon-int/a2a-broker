# Task Status Event Stream

A cursor-based, in-memory stream of task lifecycle transitions exposed by the
broker. The stream is fed from the existing audit-event pipeline (it does *not*
duplicate state) and projects each task-scoped audit event onto a slim,
operator-safe `TaskStatusEvent` shape suitable for parent aggregates,
operator dashboards, and reconnect replay.

## API

```ts
import type { TaskStatusEvent } from "./core/task-events.js";
import type { TaskEventStream } from "./core/task-event-stream.js";

const stream: TaskEventStream = broker.getTaskEventStream();

// Replay everything still in the buffer.
const everything = stream.subscribe();

// Resume from a saved cursor.
const since = stream.subscribe({ afterId: lastSeenId });

// Per-task or per-aggregate views.
const onlyOne = stream.subscribe({ taskId });
const childUpdates = stream.subscribe({ parentTaskId });

// Bounded page.
const page = stream.subscribe({ afterId: lastSeenId, limit: 50 });
```

### `TaskStatusEvent`

| field          | notes                                                                |
| -------------- | -------------------------------------------------------------------- |
| `id`           | Monotonically increasing across the whole stream. Use as a cursor.   |
| `timestamp`    | ISO timestamp inherited from the source audit event.                 |
| `taskId`       | The task whose status changed.                                       |
| `parentTaskId` | Set only when the task is a child task; omitted otherwise.           |
| `status`       | The task's status at the moment the event was emitted.               |
| `kind`         | Lifecycle kind — see [Event kinds](#event-kinds).                    |
| `metadata`     | Operator-safe metadata only — see [Operator safety](#operator-safety). |

### Cursor semantics

- `subscribe({ afterId })` returns events with **`event.id > afterId`** (strictly
  greater). Save the largest `id` you observed and pass it back to resume.
- Omit `afterId` (or pass any value `< 1`, e.g. `-1`) to receive every event
  currently retained.
- `id`s are unique and monotonically increasing across the whole stream — they
  are *not* per-task. (For a per-task SSE-style sequence, use
  `subscribeToTask` / `replayTaskEvents` on the broker.)

### Retention

- Default cap is **1000 events**, FIFO eviction once exceeded.
- Configurable via `new InMemoryA2ABroker(store, snapshot, { maxTaskStatusEvents: N })`.
- Subscribers should treat the buffer as best-effort replay; if a consumer is
  off for long enough that its cursor predates the oldest retained event, the
  consumer must reconcile from the broker's task list before resuming.

## Operator safety

The stream is designed to be safe to expose to dashboards and parent
aggregates without re-litigating redaction. By construction:

- The event has no `message`, `payload`, `result`, or `error` fields.
- `metadata` is an explicit allow-list:
  - `taskOrigin`, `targetNodeId`, `assignedWorkerId`, `intent`
  - `repoFullName`, `issueNumber` (sourced from the GitHub ingestion payload
    when `taskOrigin === "github"`)
- Audit-event `note` strings (which can contain task messages or error text)
  are **not** projected onto the event.

If you need richer context (the task's message, result, error), look up the
task via `broker.getTask(event.taskId)` and apply your own redaction.

## Event kinds

The stream is intentionally narrower than the audit-action vocabulary. Only
visible task lifecycle transitions are projected; heartbeats, tombstones, and
wake bookkeeping are excluded so subscribers see exactly one event per
state change.

| `kind`       | source audit action |
| ------------ | ------------------- |
| `created`    | `task.created`      |
| `claimed`    | `task.claimed`      |
| `started`    | `task.started`      |
| `succeeded`  | `task.succeeded`    |
| `failed`     | `task.failed`       |
| `canceled`   | `task.canceled`     |
| `requeued`   | `task.requeued`     |
| `reassigned` | `task.reassigned`   |

## Example: parent aggregate consuming child task updates

```ts
const stream = broker.getTaskEventStream();
let cursor = 0;

setInterval(() => {
  const events = stream.subscribe({ parentTaskId: parentId, afterId: cursor });
  for (const event of events) {
    aggregate.apply(event); // fold "created" / "started" / "succeeded" / "failed" into Start/Block/PR/Done
    cursor = event.id;
  }
}, 1000);
```

For server-sent events to a single client, prefer the per-task SSE pipeline
(`subscribeToTask` + `replayTaskEvents`); the task event stream is sized for
small, fan-out aggregation rather than per-task streaming.
