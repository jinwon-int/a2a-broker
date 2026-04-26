/**
 * Type definitions for the broker proposal lifecycle — a deterministic,
 * operator-safe proposal state machine anchored to a conference room and
 * parent task.
 *
 * Proposals carry no raw prompt or session text. Only structured metadata,
 * participant references, and decision outcomes are retained.
 */

// ---------------------------------------------------------------------------
// Proposal state machine
// ---------------------------------------------------------------------------

export type ProposalStatus =
  | "proposed"
  | "blocked"
  | "approved"
  | "rejected"
  | "applying"
  | "applied"
  | "failed";

export type ProposalBlockReasonCode =
  | "quorum_not_met"
  | "chair_veto"
  | "conflict_detected"
  | "validation_failed"
  | "apply_timeout"
  | "apply_error"
  | "other";

export const PROPOSAL_BLOCK_REASON_CODES = [
  "quorum_not_met",
  "chair_veto",
  "conflict_detected",
  "validation_failed",
  "apply_timeout",
  "apply_error",
  "other",
] as const satisfies readonly ProposalBlockReasonCode[];

/** Allowed state transitions. Terminal states have no outgoing edges. */
export const PROPOSAL_TRANSITIONS: Record<
  ProposalStatus,
  ReadonlySet<ProposalStatus>
> = {
  proposed: new Set(["blocked", "approved", "rejected"]),
  blocked: new Set(["approved", "rejected"]),
  approved: new Set(["applying", "rejected"]),
  rejected: new Set(),
  applying: new Set(["applied", "failed"]),
  applied: new Set(),
  failed: new Set(["approved", "rejected"]),
};

// ---------------------------------------------------------------------------
// Proposal domain types
// ---------------------------------------------------------------------------

export interface ProposalParticipantRef {
  nodeId: string;
  displayName?: string;
  role: string;
}

export interface ProposalArtifact {
  id: string;
  category: "analysis" | "decision" | "artifact" | "correction";
  summary: string;
}

export interface Proposal {
  /** Unique proposal id. */
  id: string;
  /** Parent task id this proposal is anchored to. */
  parentTaskId: string;
  /** Conference room id that produced this proposal (if any). */
  conferenceRoomId?: string;
  /** Current status in the lifecycle. */
  status: ProposalStatus;
  /** Operator-safe summary of the proposal. */
  summary: string;
  /** Participant references at time of proposal creation. */
  participants: ProposalParticipantRef[];
  /** Artifact IDs produced during the conference. */
  artifacts: ProposalArtifact[];
  /** Structured block/failure reason code (when status is blocked or failed). */
  reasonCode?: ProposalBlockReasonCode;
  /** ISO timestamp of creation. */
  createdAt: string;
  /** ISO timestamp of last status change. */
  updatedAt: string;
  /** ISO timestamp when apply started (if applying/applied/failed). */
  applyStartedAt?: string;
  /** ISO timestamp when apply completed or failed. */
  applyCompletedAt?: string;
  /** Number of times apply has been attempted (for idempotent retry). */
  applyAttempts: number;
}

// ---------------------------------------------------------------------------
// Proposal event types (for cursor/replay)
// ---------------------------------------------------------------------------

export type ProposalEventKind =
  | "proposal_created"
  | "proposal_blocked"
  | "proposal_approved"
  | "proposal_rejected"
  | "proposal_applying"
  | "proposal_applied"
  | "proposal_failed";

export interface ProposalEvent {
  /** Monotonically increasing event id across the manager-wide stream. */
  id: number;
  /** ISO timestamp. */
  timestamp: string;
  /** Proposal id. */
  proposalId: string;
  /** Parent task id. */
  parentTaskId: string;
  /** Conference room id (if applicable). */
  conferenceRoomId?: string;
  /** Event kind. */
  kind: ProposalEventKind;
  /** Operator-safe metadata. */
  metadata: {
    reasonCode?: ProposalBlockReasonCode;
    applyAttempt?: number;
  };
}
