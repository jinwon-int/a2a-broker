import { randomUUID } from "node:crypto";

import type {
  ConferenceEvent,
  ConferenceEventKind,
  ConferenceParticipant,
  ConferenceParticipantStatus,
  ConferenceRoom,
} from "./conference-types.js";

/** Default cap on retained conference events. Older events are evicted FIFO when exceeded. */
export const DEFAULT_CONFERENCE_EVENT_RETENTION = 500;

export interface ConferenceRoomManagerOptions {
  /**
   * Maximum number of events retained in memory. Older events are evicted FIFO
   * once the cap is reached. Defaults to {@link DEFAULT_CONFERENCE_EVENT_RETENTION}.
   * Values <= 0 fall back to the default.
   */
  maxEvents?: number;
  /** Clock injection point for deterministic tests. Defaults to `() => new Date()`. */
  now?: () => Date;
  /** Id generator injection point for deterministic tests. Defaults to `randomUUID`. */
  idFactory?: () => string;
}

export interface ConferenceSubscribeOptions {
  /**
   * Return only events with `id > afterId`. Omit (or pass any value < the
   * first retained id) to receive every event still in the buffer.
   */
  afterId?: number;
  /** Restrict to events for a single room id. */
  roomId?: string;
  /** Restrict to events anchored to this parent task id. */
  parentTaskId?: string;
  /** Cap the number of events returned (after filtering). */
  limit?: number;
}

export class ConferenceRoomError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConferenceRoomError";
  }
}

/**
 * In-memory manager for {@link ConferenceRoom}s. Each room is anchored to a
 * parent task id and accumulates participant status transitions on a single
 * cursor-based event stream with bounded FIFO retention. The manager is
 * intentionally operator-safe: events carry only node ids, status, and a
 * short reason string — never raw prompts or session text.
 */
export class ConferenceRoomManager {
  private readonly rooms = new Map<string, ConferenceRoom>();
  private readonly events: ConferenceEvent[] = [];
  private readonly maxEvents: number;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private nextId = 0;

  constructor(options: ConferenceRoomManagerOptions = {}) {
    const requested = options.maxEvents;
    this.maxEvents =
      requested !== undefined && requested > 0
        ? requested
        : DEFAULT_CONFERENCE_EVENT_RETENTION;
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  createRoom(parentTaskId: string): ConferenceRoom {
    if (!parentTaskId) {
      throw new ConferenceRoomError("parentTaskId is required");
    }
    const room: ConferenceRoom = {
      id: this.idFactory(),
      parentTaskId,
      createdAt: this.now().toISOString(),
      status: "active",
      participants: new Map(),
    };
    this.rooms.set(room.id, room);
    this.emit(room, "room_created", {});
    return room;
  }

  invite(roomId: string, nodeIds: string[]): ConferenceEvent[] {
    const room = this.requireRoom(roomId);
    const out: ConferenceEvent[] = [];
    for (const nodeId of nodeIds) {
      const existing = room.participants.get(nodeId);
      if (existing) {
        const prior = this.findLatestEvent(roomId, nodeId, "participant_invited");
        if (prior) {
          out.push(prior);
          continue;
        }
      } else {
        room.participants.set(nodeId, {
          nodeId,
          status: "invited",
          updatedAt: this.now().toISOString(),
        });
      }
      out.push(this.emit(room, "participant_invited", { nodeId }));
    }
    return out;
  }

  join(roomId: string, nodeId: string): ConferenceEvent {
    return this.transition(roomId, nodeId, "joined", "participant_joined");
  }

  speak(roomId: string, nodeId: string, _note?: string): ConferenceEvent {
    // `_note` is intentionally discarded: the conference event metadata is an
    // operator-safe allow-list and never carries free-form session text.
    return this.transition(roomId, nodeId, "speaking", "participant_speaking");
  }

  block(roomId: string, nodeId: string, reason?: string): ConferenceEvent {
    return this.transition(roomId, nodeId, "blocked", "participant_blocked", reason);
  }

  leave(roomId: string, nodeId: string): ConferenceEvent {
    return this.transition(roomId, nodeId, "left", "participant_left");
  }

  done(roomId: string, nodeId: string): ConferenceEvent {
    return this.transition(roomId, nodeId, "done", "participant_done");
  }

  closeRoom(roomId: string): ConferenceEvent {
    const room = this.requireRoom(roomId);
    if (room.status === "closed") {
      const prior = this.findLatestEvent(roomId, undefined, "room_closed");
      if (prior) return prior;
    }
    room.status = "closed";
    return this.emit(room, "room_closed", {});
  }

  getRoom(roomId: string): ConferenceRoom | undefined {
    return this.rooms.get(roomId);
  }

  getParticipants(roomId: string): ConferenceParticipant[] {
    const room = this.requireRoom(roomId);
    return Array.from(room.participants.values());
  }

  /**
   * Cursor-based replay over the retained event buffer. With no options,
   * returns every event currently retained in chronological order.
   */
  subscribe(options: ConferenceSubscribeOptions = {}): ConferenceEvent[] {
    const afterId = options.afterId ?? 0;
    const limit = options.limit;
    const result: ConferenceEvent[] = [];
    for (const event of this.events) {
      if (event.id <= afterId) continue;
      if (options.roomId && event.roomId !== options.roomId) continue;
      if (options.parentTaskId && event.parentTaskId !== options.parentTaskId) continue;
      result.push(event);
      if (limit !== undefined && result.length >= limit) break;
    }
    return result;
  }

  /** Largest event id ever assigned. Useful as the initial cursor. */
  get latestId(): number {
    return this.nextId;
  }

  /** Number of events currently retained (post FIFO eviction). */
  get size(): number {
    return this.events.length;
  }

  private transition(
    roomId: string,
    nodeId: string,
    target: ConferenceParticipantStatus,
    kind: ConferenceEventKind,
    reason?: string,
  ): ConferenceEvent {
    const room = this.requireRoom(roomId);
    const participant = room.participants.get(nodeId);
    if (!participant) {
      throw new ConferenceRoomError(
        `participant ${nodeId} is not a member of room ${roomId}`,
      );
    }
    if (participant.status === target) {
      const prior = this.findLatestEvent(roomId, nodeId, kind);
      if (prior) return prior;
    } else {
      participant.status = target;
      participant.updatedAt = this.now().toISOString();
    }
    const metadata: ConferenceEvent["metadata"] = { nodeId };
    if (reason) metadata.reason = reason;
    return this.emit(room, kind, metadata);
  }

  private emit(
    room: ConferenceRoom,
    kind: ConferenceEventKind,
    metadata: ConferenceEvent["metadata"],
  ): ConferenceEvent {
    this.nextId += 1;
    const event: ConferenceEvent = {
      id: this.nextId,
      timestamp: this.now().toISOString(),
      roomId: room.id,
      parentTaskId: room.parentTaskId,
      kind,
      metadata,
    };
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
    return event;
  }

  private requireRoom(roomId: string): ConferenceRoom {
    const room = this.rooms.get(roomId);
    if (!room) {
      throw new ConferenceRoomError(`room ${roomId} not found`);
    }
    return room;
  }

  private findLatestEvent(
    roomId: string,
    nodeId: string | undefined,
    kind: ConferenceEventKind,
  ): ConferenceEvent | undefined {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const ev = this.events[i]!;
      if (ev.roomId !== roomId) continue;
      if (ev.kind !== kind) continue;
      if (nodeId !== undefined && ev.metadata.nodeId !== nodeId) continue;
      return ev;
    }
    return undefined;
  }
}
