# Agent Teleconference Room

A bounded, operator-safe coordination primitive for multi-node task work. Each
room is anchored to a single parent task id; multiple worker nodes participate
and emit status transitions on a cursor-based event stream. The stream uses
FIFO retention and is independent from `TaskEventStream`.

## API

```ts
import type { ConferenceEvent } from "./core/conference-types.js";
import type { ConferenceRoomManager } from "./core/conference-room.js";

const manager: ConferenceRoomManager = broker.getConferenceManager();

const room = manager.createRoom(parentTaskId);
manager.invite(room.id, ["worker-a", "worker-b"]);

manager.join(room.id, "worker-a");
manager.speak(room.id, "worker-a");
manager.block(room.id, "worker-b", "rate-limit");
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
                              |       \-> block -> (leave | done)
                              \-> leave
              ...
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

## Participant state machine

| Status     | Reachable transitions          | Emits                   |
| ---------- | ------------------------------ | ----------------------- |
| `invited`  | join, block, leave, done       | `participant_invited`   |
| `joined`   | speak, block, leave, done      | `participant_joined`    |
| `speaking` | block, leave, done             | `participant_speaking`  |
| `blocked`  | leave, done                    | `participant_blocked`   |
| `left`     | (terminal)                     | `participant_left`      |
| `done`     | (terminal)                     | `participant_done`      |

`block`, `leave`, and `done` accept a participant in any prior state. Calling a
transition method when the participant is already in the target state is a
no-op: the prior matching event is returned and no new event is buffered.

## Cursor-based replay

- `subscribe({ afterId })` returns events with `event.id > afterId` (strictly
  greater). Save the largest id you observed and pass it back to resume.
- Omit `afterId` (or pass any value `< 1`) to receive every event currently
  retained.
- Filter by `roomId` for a single room or by `parentTaskId` to fan in across
  every room anchored to one task.
- Ids are unique and monotonically increasing across the whole manager — they
  are *not* per-room.

### Retention

- Default cap is **500 events**, FIFO eviction once exceeded. Configurable via
  `new ConferenceRoomManager({ maxEvents: N })`.
- Subscribers should treat the buffer as best-effort replay; if a consumer is
  off long enough that its cursor predates the oldest retained event, the
  consumer must reconcile via `getRoom` / `getParticipants` before resuming.

## Operator safety

The room is designed to be safe to expose to dashboards and parent aggregates
without re-litigating redaction. By construction:

- Events have no `message`, `payload`, `result`, or free-form text fields.
- `metadata` is an explicit allow-list: `nodeId`, `reason`.
- `speak(..., note)` accepts a note parameter for ergonomic call-site
  signatures, but the note is **never** projected onto the event. If you need
  to log session text, use a separate channel.
- `block(..., reason)` propagates the reason so operators can correlate to a
  blocker without reading the worker's state.

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

// Once all participants are done or left, close the room.
manager.closeRoom(room.id);
```
