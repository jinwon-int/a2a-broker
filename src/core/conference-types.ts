/**
 * Type definitions for the agent teleconference room primitive — a bounded,
 * operator-safe coordination channel anchored to a parent task. Multiple
 * worker nodes participate in one room and emit status events (joined,
 * speaking, blocked, left, done) that aggregate alongside the parent task's
 * lifecycle. By design these types carry no raw message body or session text.
 */

export type ConferenceParticipantStatus =
  | "invited"
  | "joined"
  | "speaking"
  | "blocked"
  | "left"
  | "done";

export interface ConferenceParticipant {
  /** Node id of the participant. */
  nodeId: string;
  /** Current status in the conference. */
  status: ConferenceParticipantStatus;
  /** ISO timestamp of last status change. */
  updatedAt: string;
}

export interface ConferenceRoom {
  /** Unique room id. */
  id: string;
  /** Parent task id this room is anchored to. */
  parentTaskId: string;
  /** ISO timestamp when the room was created. */
  createdAt: string;
  /** Current status of the conference. */
  status: "active" | "closed";
  /** Participants by node id. */
  participants: Map<string, ConferenceParticipant>;
}

export type ConferenceEventKind =
  | "room_created"
  | "participant_invited"
  | "participant_joined"
  | "participant_speaking"
  | "participant_blocked"
  | "participant_left"
  | "participant_done"
  | "room_closed";

export interface ConferenceEvent {
  /** Monotonically increasing id within this room. */
  id: number;
  /** ISO timestamp. */
  timestamp: string;
  /** Room id. */
  roomId: string;
  /** Parent task id. */
  parentTaskId: string;
  /** Event kind. */
  kind: ConferenceEventKind;
  /** Operator-safe metadata. */
  metadata: {
    nodeId?: string;
    reason?: string;
  };
}
