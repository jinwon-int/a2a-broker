/**
 * Broker proposal lifecycle manager (issue #88 / Round 19).
 *
 * Manages the full lifecycle of conference-derived proposals:
 *   proposed → blocked/approved/rejected → applying → applied/failed
 *
 * Key properties:
 * - Idempotent transitions (duplicate approve/apply are no-ops).
 * - Cursor-based replay via CursorEventBuffer (same substrate as conference room).
 * - Structured block/failure codes only — no free-form internal leakage.
 * - Retention eviction does not change mutation semantics (idempotency state
 *   is stored per-proposal, outside the replay buffer).
 */

import { randomUUID } from "node:crypto";

import { CursorEventBuffer } from "./event-buffer.js";
import {
  PROPOSAL_BLOCK_REASON_CODES,
  PROPOSAL_TRANSITIONS,
  type Proposal,
  type ProposalArtifact,
  type ProposalBlockReasonCode,
  type ProposalEvent,
  type ProposalEventKind,
  type ProposalParticipantRef,
  type ProposalStatus,
} from "./proposal-types.js";

// ---------------------------------------------------------------------------
// Public options
// ---------------------------------------------------------------------------

export interface ProposalManagerOptions {
  /** Maximum retained events. Defaults to 500. */
  maxEvents?: number;
  /** Clock injection for tests. */
  now?: () => Date;
  /** Id generator injection for tests. */
  idFactory?: () => string;
}

export interface ProposalCreateInput {
  parentTaskId: string;
  conferenceRoomId?: string;
  summary: string;
  participants: ProposalParticipantRef[];
  artifacts?: ProposalArtifact[];
}

export interface ProposalSubscribeOptions {
  afterId?: number;
  parentTaskId?: string;
  conferenceRoomId?: string;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ProposalError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "ProposalError";
  }
}

// ---------------------------------------------------------------------------
// Reason code alias resolution (same pattern as conference-room)
// ---------------------------------------------------------------------------

const BLOCK_REASON_ALIASES: Record<string, ProposalBlockReasonCode> = {
  quorum: "quorum_not_met",
  quorum_not_met: "quorum_not_met",
  veto: "chair_veto",
  chair_veto: "chair_veto",
  conflict: "conflict_detected",
  conflict_detected: "conflict_detected",
  validation: "validation_failed",
  validation_failed: "validation_failed",
  timeout: "apply_timeout",
  apply_timeout: "apply_timeout",
  apply_error: "apply_error",
  error: "apply_error",
  other: "other",
};

const BLOCK_REASON_CODE_SET = new Set<string>(PROPOSAL_BLOCK_REASON_CODES);

function resolveBlockReason(raw: string): ProposalBlockReasonCode {
  const resolved = BLOCK_REASON_ALIASES[raw];
  if (resolved && BLOCK_REASON_CODE_SET.has(resolved)) return resolved;
  if (BLOCK_REASON_CODE_SET.has(raw)) return raw as ProposalBlockReasonCode;
  return "other";
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class ProposalManager {
  private readonly proposals = new Map<string, Proposal>();
  private readonly buffer: CursorEventBuffer<ProposalEvent>;
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  constructor(options: ProposalManagerOptions = {}) {
    this.buffer = new CursorEventBuffer<ProposalEvent>(
      options.maxEvents && options.maxEvents > 0
        ? options.maxEvents
        : 500,
    );
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? (() => randomUUID());
  }

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  getProposal(id: string): Proposal | undefined {
    return this.proposals.get(id);
  }

  getProposalsForTask(parentTaskId: string): Proposal[] {
    return [...this.proposals.values()].filter(
      (p) => p.parentTaskId === parentTaskId,
    );
  }

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  create(input: ProposalCreateInput): Proposal {
    const id = this.idFactory();
    const ts = this.now().toISOString();
    const proposal: Proposal = {
      id,
      parentTaskId: input.parentTaskId,
      conferenceRoomId: input.conferenceRoomId,
      status: "proposed",
      summary: input.summary,
      participants: input.participants,
      artifacts: input.artifacts ?? [],
      createdAt: ts,
      updatedAt: ts,
      applyAttempts: 0,
    };
    this.proposals.set(id, proposal);
    this.emitEvent(id, input.parentTaskId, input.conferenceRoomId, "proposal_created");
    return proposal;
  }

  // -------------------------------------------------------------------------
  // Transitions
  // -------------------------------------------------------------------------

  block(proposalId: string, reason: string): Proposal {
    return this.transition(proposalId, "blocked", resolveBlockReason(reason));
  }

  approve(proposalId: string): Proposal {
    return this.transition(proposalId, "approved");
  }

  reject(proposalId: string): Proposal {
    return this.transition(proposalId, "rejected");
  }

  /**
   * Mark a proposal as applying. Idempotent: if already applying, returns
   * the current proposal without emitting a duplicate event.
   */
  startApply(proposalId: string): Proposal {
    const proposal = this.requireProposal(proposalId);
    if (proposal.status === "applying") return proposal; // idempotent
    const p = this.transition(proposalId, "applying");
    p.applyStartedAt = p.updatedAt;
    return p;
  }

  /**
   * Mark an in-flight apply as successful. Idempotent.
   */
  completeApply(proposalId: string): Proposal {
    const proposal = this.requireProposal(proposalId);
    if (proposal.status === "applied") return proposal; // idempotent
    const p = this.transition(proposalId, "applied");
    p.applyCompletedAt = p.updatedAt;
    return p;
  }

  /**
   * Mark an in-flight apply as failed. Can be retried (failed → approved/rejected).
   * Increments applyAttempts for audit.
   */
  failApply(proposalId: string, reason: string): Proposal {
    const proposal = this.requireProposal(proposalId);
    const p = this.transition(proposalId, "failed", resolveBlockReason(reason));
    p.applyCompletedAt = p.updatedAt;
    p.applyAttempts += 1;
    return p;
  }

  // -------------------------------------------------------------------------
  // Replay
  // -------------------------------------------------------------------------

  subscribe(options: ProposalSubscribeOptions = {}): ProposalEvent[] {
    return this.buffer.subscribe({
      afterId: options.afterId,
      limit: options.limit,
      matches: (e) => {
        if (options.parentTaskId && e.parentTaskId !== options.parentTaskId)
          return false;
        if (
          options.conferenceRoomId &&
          e.conferenceRoomId !== options.conferenceRoomId
        )
          return false;
        return true;
      },
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private requireProposal(id: string): Proposal {
    const p = this.proposals.get(id);
    if (!p) throw new ProposalError(`Proposal not found: ${id}`, "NOT_FOUND");
    return p;
  }

  private transition(
    proposalId: string,
    target: ProposalStatus,
    reasonCode?: ProposalBlockReasonCode,
  ): Proposal {
    const proposal = this.requireProposal(proposalId);
    const allowed = PROPOSAL_TRANSITIONS[proposal.status];
    if (!allowed.has(target)) {
      throw new ProposalError(
        `Cannot transition proposal ${proposalId} from ${proposal.status} to ${target}`,
        "INVALID_TRANSITION",
      );
    }
    const ts = this.now().toISOString();
    proposal.status = target;
    proposal.updatedAt = ts;
    if (reasonCode) proposal.reasonCode = reasonCode;

    const eventKind = statusToEventKind(target);
    const applyAttempt =
      target === "failed" ? proposal.applyAttempts + 1 : undefined;
    this.emitEvent(
      proposalId,
      proposal.parentTaskId,
      proposal.conferenceRoomId,
      eventKind,
      reasonCode,
      applyAttempt,
    );
    return proposal;
  }

  private emitEvent(
    proposalId: string,
    parentTaskId: string,
    conferenceRoomId: string | undefined,
    kind: ProposalEventKind,
    reasonCode?: ProposalBlockReasonCode,
    applyAttempt?: number,
  ): void {
    const id = this.buffer.allocateId();
    this.buffer.push({
      id,
      timestamp: this.now().toISOString(),
      proposalId,
      parentTaskId,
      conferenceRoomId,
      kind,
      metadata: { reasonCode, applyAttempt },
    });
  }
}

function statusToEventKind(status: ProposalStatus): ProposalEventKind {
  const map: Record<ProposalStatus, ProposalEventKind> = {
    proposed: "proposal_created",
    blocked: "proposal_blocked",
    approved: "proposal_approved",
    rejected: "proposal_rejected",
    applying: "proposal_applying",
    applied: "proposal_applied",
    failed: "proposal_failed",
  };
  return map[status];
}
