import { randomUUID } from "node:crypto";

import { CursorEventBuffer } from "./event-buffer.js";
import {
  CONFERENCE_BLOCK_REASON_CODES,
  type ConferenceBlockReasonCode,
  type ConferenceEvent,
  type ConferenceEventKind,
  type ConferenceParticipant,
  type ConferenceParticipantStatus,
  type ConferenceRoom,
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

type ParticipantEventKind = Exclude<ConferenceEventKind, "room_created" | "room_closed">;

const TERMINAL_PARTICIPANT_STATUSES = new Set<ConferenceParticipantStatus>([
  "blocked",
  "left",
  "done",
]);

const ALLOWED_TRANSITIONS: Record<
  ConferenceParticipantStatus,
  ReadonlySet<ConferenceParticipantStatus>
> = {
  invited: new Set(["joined", "blocked", "left"]),
  joined: new Set(["speaking", "blocked", "left", "done"]),
  speaking: new Set(["blocked", "left", "done"]),
  blocked: new Set(),
  left: new Set(),
  done: new Set(),
};

const BLOCK_REASON_ALIASES: Record<string, ConferenceBlockReasonCode> = {
  auth: "auth_failed",
  auth_failed: "auth_failed",
  auth_failure: "auth_failed",
  rate_limit: "rate_limited",
  rate_limited: "rate_limited",
  ratelimited: "rate_limited",
  unreachable: "unreachable",
  network_unreachable: "unreachable",
  policy: "policy_denied",
  policy_denied: "policy_denied",
  denied: "policy_denied",
  timeout: "timeout",
  timed_out: "timeout",
  worker_failed: "worker_failed",
  worker_failure: "worker_failed",
  failed: "worker_failed",
  other: "other",
};

const BLOCK_REASON_CODE_SET = new Set<string>(CONFERENCE_BLOCK_REASON_CODES);

/**
 * In-memory manager for {@link ConferenceRoom}s. Each room is anchored to a
 * parent task id and accumulates participant status transitions on the same
 * cursor-based replay substrate used by the task status stream: manager-wide
 * monotonically increasing ids plus bounded FIFO retention. Domain idempotency
 * is stored per room outside the replay buffer, so retention eviction cannot
 * create duplicate lifecycle events.
 */
export class ConferenceRoomManager {
  private readonly rooms = new Map<string, ConferenceRoom>();
  private readonly roomEventIndex = new Map<string, Map<string, ConferenceEvent>>();
  private readonly buffer: CursorEventBuffer<ConferenceEvent>;
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  constructor(options: ConferenceRoomManagerOptions = {}) {
    const requested = options.maxEvents;
    const maxEvents =
      requested !== undefined && requested > 0
        ? requested
        : DEFAULT_CONFERENCE_EVENT_RETENTION;
    this.buffer = new CursorEventBuffer<ConferenceEvent>(maxEvents);
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
    this.roomEventIndex.set(room.id, new Map());
    this.emit(room, "room_created", {});
    return room;
  }

  invite(roomId: string, nodeIds: string[]): ConferenceEvent[] {
    const room = this.requireActiveRoom(roomId);
    const out: ConferenceEvent[] = [];
    for (const nodeId of nodeIds) {
      const existing = room.participants.get(nodeId);
      if (existing) {
        const prior = this.findIndexedEvent(roomId, eventKey("participant_invited", nodeId));
        if (prior) {
          out.push(prior);
          continue;
        }
        throw new ConferenceRoomError(
          `participant ${nodeId} already exists in room ${roomId}`,
        );
      }

      room.participants.set(nodeId, {
        nodeId,
        status: "invited",
        updatedAt: this.now().toISOString(),
      });
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

  block(
    roomId: string,
    nodeId: string,
    reason?: ConferenceBlockReasonCode | string,
  ): ConferenceEvent {
    return this.transition(roomId, nodeId, "blocked", "participant_blocked", {
      reasonCode: normalizeBlockReasonCode(reason),
    });
  }

  leave(roomId: string, nodeId: string): ConferenceEvent {
    return this.transition(roomId, nodeId, "left", "participant_left");
  }

  done(roomId: string, nodeId: string): ConferenceEvent {
    return this.transition(roomId, nodeId, "done", "participant_done");
  }

  closeRoom(roomId: string): ConferenceEvent {
    const room = this.requireRoom(roomId);
    const key = eventKey("room_closed");
    if (room.status === "closed") {
      const prior = this.findIndexedEvent(roomId, key);
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
    return this.buffer.subscribe({
      afterId: options.afterId,
      limit: options.limit,
      matches: (event) => {
        if (options.roomId && event.roomId !== options.roomId) return false;
        if (options.parentTaskId && event.parentTaskId !== options.parentTaskId) {
          return false;
        }
        return true;
      },
    });
  }

  /** Largest event id ever assigned. Useful as the initial cursor. */
  get latestId(): number {
    return this.buffer.latestId;
  }

  /** Number of events currently retained (post FIFO eviction). */
  get size(): number {
    return this.buffer.size;
  }

  private transition(
    roomId: string,
    nodeId: string,
    target: ConferenceParticipantStatus,
    kind: ParticipantEventKind,
    metadata: Partial<ConferenceEvent["metadata"]> = {},
  ): ConferenceEvent {
    const room = this.requireActiveRoom(roomId);
    const participant = room.participants.get(nodeId);
    if (!participant) {
      throw new ConferenceRoomError(
        `participant ${nodeId} is not a member of room ${roomId}`,
      );
    }

    const key = eventKey(kind, nodeId);
    if (participant.status === target) {
      const prior = this.findIndexedEvent(roomId, key);
      if (prior) return prior;
      throw new ConferenceRoomError(
        `missing idempotency record for participant ${nodeId} ${target} in room ${roomId}`,
      );
    }

    if (TERMINAL_PARTICIPANT_STATUSES.has(participant.status)) {
      throw new ConferenceRoomError(
        `participant ${nodeId} is terminal (${participant.status}) in room ${roomId}`,
      );
    }

    if (!ALLOWED_TRANSITIONS[participant.status].has(target)) {
      throw new ConferenceRoomError(
        `invalid participant transition ${participant.status} -> ${target} for ${nodeId} in room ${roomId}`,
      );
    }

    participant.status = target;
    participant.updatedAt = this.now().toISOString();
    return this.emit(room, kind, { nodeId, ...metadata });
  }

  private emit(
    room: ConferenceRoom,
    kind: ConferenceEventKind,
    metadata: ConferenceEvent["metadata"],
  ): ConferenceEvent {
    const event: ConferenceEvent = {
      id: this.buffer.allocateId(),
      timestamp: this.now().toISOString(),
      roomId: room.id,
      parentTaskId: room.parentTaskId,
      kind,
      metadata,
    };
    this.indexEvent(event);
    return this.buffer.push(event);
  }

  private requireRoom(roomId: string): ConferenceRoom {
    const room = this.rooms.get(roomId);
    if (!room) {
      throw new ConferenceRoomError(`room ${roomId} not found`);
    }
    return room;
  }

  private requireActiveRoom(roomId: string): ConferenceRoom {
    const room = this.requireRoom(roomId);
    if (room.status === "closed") {
      throw new ConferenceRoomError(`room ${roomId} is closed`);
    }
    return room;
  }

  private indexEvent(event: ConferenceEvent): void {
    let roomIndex = this.roomEventIndex.get(event.roomId);
    if (!roomIndex) {
      roomIndex = new Map();
      this.roomEventIndex.set(event.roomId, roomIndex);
    }
    roomIndex.set(eventKey(event.kind, event.metadata.nodeId), event);
  }

  private findIndexedEvent(roomId: string, key: string): ConferenceEvent | undefined {
    return this.roomEventIndex.get(roomId)?.get(key);
  }
}

function eventKey(kind: ConferenceEventKind, nodeId?: string): string {
  return nodeId ? `${kind}:${nodeId}` : kind;
}

function normalizeBlockReasonCode(
  reason?: ConferenceBlockReasonCode | string,
): ConferenceBlockReasonCode {
  if (typeof reason !== "string") return "other";
  const normalized = reason
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (BLOCK_REASON_CODE_SET.has(normalized)) return normalized as ConferenceBlockReasonCode;
  return BLOCK_REASON_ALIASES[normalized] ?? "other";
}
