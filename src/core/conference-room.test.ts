import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ConferenceRoomManager } from "./conference-room.js";

describe("ConferenceRoomManager", () => {
  it("creates a room anchored to a parent task id", () => {
    const manager = new ConferenceRoomManager();
    const room = manager.createRoom("parent-task-1");

    assert.equal(room.parentTaskId, "parent-task-1");
    assert.equal(room.status, "active");
    assert.ok(room.id);
    assert.equal(room.participants.size, 0);

    const events = manager.subscribe();
    assert.equal(events.length, 1);
    assert.equal(events[0]!.kind, "room_created");
    assert.equal(events[0]!.roomId, room.id);
    assert.equal(events[0]!.parentTaskId, "parent-task-1");
    assert.equal(events[0]!.id, 1);
  });

  it("invites multiple participants and emits invited events", () => {
    const manager = new ConferenceRoomManager();
    const room = manager.createRoom("parent-1");

    const invited = manager.invite(room.id, ["worker-a", "worker-b", "worker-c"]);

    assert.equal(invited.length, 3);
    assert.deepEqual(
      invited.map((e) => e.metadata.nodeId),
      ["worker-a", "worker-b", "worker-c"],
    );
    for (const event of invited) {
      assert.equal(event.kind, "participant_invited");
      assert.equal(event.roomId, room.id);
      assert.equal(event.parentTaskId, "parent-1");
    }

    const participants = manager.getParticipants(room.id);
    assert.equal(participants.length, 3);
    for (const p of participants) {
      assert.equal(p.status, "invited");
    }
  });

  it("participant transitions invited -> joined -> speaking -> done", () => {
    const manager = new ConferenceRoomManager();
    const room = manager.createRoom("parent-1");
    manager.invite(room.id, ["worker-a"]);

    const joined = manager.join(room.id, "worker-a");
    const speaking = manager.speak(room.id, "worker-a");
    const done = manager.done(room.id, "worker-a");

    assert.equal(joined.kind, "participant_joined");
    assert.equal(speaking.kind, "participant_speaking");
    assert.equal(done.kind, "participant_done");

    const participant = manager.getParticipants(room.id)[0]!;
    assert.equal(participant.status, "done");

    const kinds = manager.subscribe().map((e) => e.kind);
    assert.deepEqual(kinds, [
      "room_created",
      "participant_invited",
      "participant_joined",
      "participant_speaking",
      "participant_done",
    ]);
  });

  it("duplicate join is idempotent — no extra event", () => {
    const manager = new ConferenceRoomManager();
    const room = manager.createRoom("parent-1");
    manager.invite(room.id, ["worker-a"]);
    const first = manager.join(room.id, "worker-a");
    const before = manager.subscribe().length;

    const second = manager.join(room.id, "worker-a");
    const after = manager.subscribe().length;

    assert.equal(after, before);
    assert.equal(second.id, first.id);
    assert.equal(manager.getParticipants(room.id)[0]!.status, "joined");
  });

  it("duplicate invite is idempotent — no extra event", () => {
    const manager = new ConferenceRoomManager();
    const room = manager.createRoom("parent-1");
    const [first] = manager.invite(room.id, ["worker-a"]);
    const before = manager.subscribe().length;

    const [second] = manager.invite(room.id, ["worker-a"]);
    const after = manager.subscribe().length;

    assert.equal(after, before);
    assert.equal(second!.id, first!.id);
  });

  it("block transitions any status to blocked", () => {
    const manager = new ConferenceRoomManager();
    const room = manager.createRoom("parent-1");
    manager.invite(room.id, ["worker-a", "worker-b"]);
    manager.join(room.id, "worker-b");

    const blockedFromInvited = manager.block(room.id, "worker-a", "auth-failed");
    const blockedFromJoined = manager.block(room.id, "worker-b", "rate-limit");

    assert.equal(blockedFromInvited.kind, "participant_blocked");
    assert.equal(blockedFromInvited.metadata.reason, "auth-failed");
    assert.equal(blockedFromJoined.kind, "participant_blocked");
    assert.equal(blockedFromJoined.metadata.reason, "rate-limit");

    const byNode = new Map(manager.getParticipants(room.id).map((p) => [p.nodeId, p]));
    assert.equal(byNode.get("worker-a")!.status, "blocked");
    assert.equal(byNode.get("worker-b")!.status, "blocked");
  });

  it("leave transitions any status to left", () => {
    const manager = new ConferenceRoomManager();
    const room = manager.createRoom("parent-1");
    manager.invite(room.id, ["worker-a", "worker-b"]);
    manager.join(room.id, "worker-b");
    manager.speak(room.id, "worker-b");

    const leftFromInvited = manager.leave(room.id, "worker-a");
    const leftFromSpeaking = manager.leave(room.id, "worker-b");

    assert.equal(leftFromInvited.kind, "participant_left");
    assert.equal(leftFromSpeaking.kind, "participant_left");

    const byNode = new Map(manager.getParticipants(room.id).map((p) => [p.nodeId, p]));
    assert.equal(byNode.get("worker-a")!.status, "left");
    assert.equal(byNode.get("worker-b")!.status, "left");
  });

  it("closeRoom closes the room and emits room_closed", () => {
    const manager = new ConferenceRoomManager();
    const room = manager.createRoom("parent-1");
    manager.invite(room.id, ["worker-a"]);

    const closed = manager.closeRoom(room.id);

    assert.equal(closed.kind, "room_closed");
    assert.equal(closed.roomId, room.id);
    assert.equal(manager.getRoom(room.id)!.status, "closed");

    const second = manager.closeRoom(room.id);
    assert.equal(second.id, closed.id, "closing an already-closed room is idempotent");
  });

  it("subscribe returns only events after the cursor", () => {
    const manager = new ConferenceRoomManager();
    const room = manager.createRoom("parent-1");
    manager.invite(room.id, ["worker-a"]);
    manager.join(room.id, "worker-a");
    manager.done(room.id, "worker-a");

    const all = manager.subscribe();
    assert.equal(all.length, 4);

    const afterTwo = manager.subscribe({ afterId: 2 });
    assert.equal(afterTwo.length, 2);
    assert.deepEqual(
      afterTwo.map((e) => e.id),
      [3, 4],
    );

    const afterAll = manager.subscribe({ afterId: 4 });
    assert.equal(afterAll.length, 0);
  });

  it("subscribe with no cursor returns all events", () => {
    const manager = new ConferenceRoomManager();
    const room = manager.createRoom("parent-1");
    manager.invite(room.id, ["worker-a"]);
    manager.join(room.id, "worker-a");

    const all = manager.subscribe();
    assert.equal(all.length, 3);
    assert.deepEqual(
      all.map((e) => e.kind),
      ["room_created", "participant_invited", "participant_joined"],
    );
  });

  it("subscribe with limit caps the result", () => {
    const manager = new ConferenceRoomManager();
    const room = manager.createRoom("parent-1");
    manager.invite(room.id, ["worker-a", "worker-b", "worker-c"]);
    manager.join(room.id, "worker-a");

    const firstTwo = manager.subscribe({ limit: 2 });
    assert.equal(firstTwo.length, 2);
    assert.deepEqual(
      firstTwo.map((e) => e.id),
      [1, 2],
    );

    const fromCursor = manager.subscribe({ afterId: 2, limit: 2 });
    assert.deepEqual(
      fromCursor.map((e) => e.id),
      [3, 4],
    );
  });

  it("subscribe filters by roomId and parentTaskId", () => {
    const manager = new ConferenceRoomManager();
    const roomA = manager.createRoom("parent-a");
    const roomB = manager.createRoom("parent-b");
    manager.invite(roomA.id, ["worker-a"]);
    manager.invite(roomB.id, ["worker-b"]);

    const onlyA = manager.subscribe({ roomId: roomA.id });
    assert.equal(onlyA.length, 2);
    for (const event of onlyA) assert.equal(event.roomId, roomA.id);

    const onlyParentB = manager.subscribe({ parentTaskId: "parent-b" });
    assert.equal(onlyParentB.length, 2);
    for (const event of onlyParentB) assert.equal(event.parentTaskId, "parent-b");
  });

  it("FIFO eviction drops oldest events when buffer is exceeded", () => {
    const manager = new ConferenceRoomManager({ maxEvents: 3 });
    const room = manager.createRoom("parent-1");
    manager.invite(room.id, ["worker-a", "worker-b"]);
    manager.join(room.id, "worker-a");

    const retained = manager.subscribe();
    assert.equal(retained.length, 3);
    assert.deepEqual(
      retained.map((e) => e.id),
      [2, 3, 4],
      "oldest event (room_created, id=1) should have been evicted",
    );
    assert.equal(manager.size, 3);
    assert.equal(manager.latestId, 4);
  });

  it("payloads contain no raw prompt or session text", () => {
    const manager = new ConferenceRoomManager();
    const room = manager.createRoom("parent-1");
    manager.invite(room.id, ["worker-a"]);
    manager.join(room.id, "worker-a");

    const secret = "do-not-leak: highly-sensitive prompt body";
    manager.speak(room.id, "worker-a", secret);
    manager.block(room.id, "worker-a", "rate-limit");

    const events = manager.subscribe();
    const serialized = JSON.stringify(events);
    assert.ok(
      !serialized.includes("highly-sensitive"),
      "raw prompt body must not appear in any event",
    );
    assert.ok(!serialized.includes("do-not-leak"));

    for (const event of events) {
      const allowed = new Set(["id", "timestamp", "roomId", "parentTaskId", "kind", "metadata"]);
      for (const key of Object.keys(event)) {
        assert.ok(allowed.has(key), `unexpected event key: ${key}`);
      }
      const metaAllowed = new Set(["nodeId", "reason"]);
      for (const key of Object.keys(event.metadata)) {
        assert.ok(metaAllowed.has(key), `unexpected metadata key: ${key}`);
      }
    }

    const blockEvent = events.find((e) => e.kind === "participant_blocked")!;
    assert.equal(blockEvent.metadata.reason, "rate-limit");
  });
});
