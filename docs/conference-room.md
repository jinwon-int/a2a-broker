# Agent Teleconference Room

A bounded, operator-safe coordination primitive for multi-node task work. Each
room is anchored to a single parent task id; multiple worker nodes participate
and emit status transitions on the shared cursor/replay substrate used by the
Round 17 task status stream. Room events are not task lifecycle events, so they
remain a separate read model, but replay semantics, manager-wide ids, filtering,
retention, and operator-safety rules intentionally match `TaskEventStream`.

## API

```ts
import type { ConferenceEvent } from "./core/conference-types.js";
import type { ConferenceRoomManager } from "./core/conference-room.js";

const manager: ConferenceRoomManager = broker.getConferenceManager();

const room = manager.createRoom(parentTaskId);
manager.invite(room.id, ["worker-a", "worker-b"]);

manager.join(room.id, "worker-a");
manager.speak(room.id, "worker-a");
manager.block(room.id, "worker-b", "rate_limited");
manager.leave(room.id, "worker-b");
manager.done(room.id, "worker-a");
manager.closeRoom(room.id);

// Cursor-based replay.
const all = manager.subscribe();
const since = manager.subscribe({ afterId: lastSeenId });
const onlyOne = manager.subscribe({ roomId: room.id });
const allRoomsForParent = manager.subscribe({ parentTaskId });
const page = manager.subscribe({ afterId: lastSeenId, limit: 50 });
```

## Room lifecycle

```
createRoom -> invite -> join -> speak -> done
                    \      \       \-> block
                     \      \-> block | leave | done
                      \-> block | leave
              closeRoom
```

- `createRoom(parentTaskId)` allocates a fresh room id, sets `status = "active"`,
  and emits one `room_created` event.
- `invite(roomId, nodeIds)` adds participants in the `invited` state, emitting
  one `participant_invited` event per node id. Idempotent: re-inviting an
  existing participant returns the prior invite event without modifying state.
- `closeRoom(roomId)` flips the room to `status = "closed"` and emits
  `room_closed`. Idempotent: closing an already-closed room returns the
  original close event.
- Once a room is closed, `invite`, `join`, `speak`, `block`, `leave`, and `done`
  are rejected and emit no events.

## Participant state machine

| Status     | Reachable transitions     | Emits                  |
| ---------- | ------------------------- | ---------------------- |
| `invited`  | join, block, leave        | `participant_invited`  |
| `joined`   | speak, block, leave, done | `participant_joined`   |
| `speaking` | block, leave, done        | `participant_speaking` |
| `blocked`  | (terminal)                | `participant_blocked`  |
| `left`     | (terminal)                | `participant_left`     |
| `done`     | (terminal)                | `participant_done`     |

Calling a transition method when the participant is already in the target state
is a no-op: the prior matching event is returned and no new event is buffered.
Other mutations from terminal states are rejected.

## Idempotency boundary

Duplicate suppression does not depend on retained replay events. The manager
keeps per-room operation keys for lifecycle events (`participant_joined:<node>`,
`room_closed`, etc.) outside the FIFO replay buffer. If the original event has
already been evicted, repeating the same idempotent operation still returns the
original event object and does not append a duplicate.

## Cursor-based replay

- `subscribe({ afterId })` returns events with `event.id > afterId` (strictly
  greater). Save the largest id you observed and pass it back to resume.
- Omit `afterId` (or pass any value `< 1`) to receive every event currently
  retained.
- Filter by `roomId` for a single room or by `parentTaskId` to fan in across
  every room anchored to one task.
- Ids are unique and monotonically increasing across the whole manager, matching
  `TaskEventStream`; they are *not* per-room.

### Retention

- Default cap is **500 events**, FIFO eviction once exceeded. Configurable via
  `new ConferenceRoomManager({ maxEvents: N })`.
- Subscribers should treat the buffer as best-effort replay; if a consumer is
  off long enough that its cursor predates the oldest retained event, the
  consumer must reconcile via `getRoom` / `getParticipants` before resuming.

## Alignment with `TaskEventStream`

Issue #82 asked to reuse Round 17 task status streaming where possible rather
than inventing an unrelated event bus. Conference events use the same internal
bounded cursor buffer and the same public replay contract as `TaskEventStream`:
manager-wide monotonic ids, `afterId` cursor semantics, `limit`, parent-task
filtering, FIFO retention, and operator-safe metadata.

They intentionally remain a separate read model because a participant saying
"joined" or "speaking" is not a task status transition and should not be
projected as `TaskStatusEvent.kind`. Parent aggregators that need both views can
consume `broker.getTaskEventStream().subscribe({ parentTaskId })` for child task
lifecycle and `broker.getConferenceManager().subscribe({ parentTaskId })` for
room participant telemetry using the same cursor rules.

## Operator safety

The room is designed to be safe to expose to dashboards and parent aggregates
without re-litigating redaction. By construction:

- Events have no `message`, `payload`, `result`, or free-form text fields.
- `metadata` is an explicit allow-list: `nodeId`, `reasonCode`.
- `speak(..., note)` accepts a note parameter for ergonomic call-site
  signatures, but the note is **never** projected onto the event. If you need
  to log session text, use a separate channel.
- `block(..., reason)` emits a structured `reasonCode`; unknown, free-form, or
  malicious values are reduced to `"other"` by default.

Supported block reason codes:

- `auth_failed`
- `rate_limited`
- `unreachable`
- `policy_denied`
- `timeout`
- `worker_failed`
- `other`

## Example: parent task opens a room, child nodes join and report status

```ts
const manager = broker.getConferenceManager();

const room = manager.createRoom(parentTask.id);
manager.invite(room.id, childNodeIds);

// Child nodes call join/speak/done as they make progress.
manager.join(room.id, "worker-a");
manager.speak(room.id, "worker-a");
manager.done(room.id, "worker-a");

// Parent aggregate folds the stream into its own state.
let cursor = 0;
setInterval(() => {
  const events = manager.subscribe({ parentTaskId: parentTask.id, afterId: cursor });
  for (const event of events) {
    aggregate.apply(event);
    cursor = event.id;
  }
}, 1000);

// Once all participants are done, left, or blocked, close the room.
manager.closeRoom(room.id);
```
