import { describe, expect, it } from "vitest";

import {
  ProposalManager,
  type ProposalManagerOptions,
} from "./proposal-lifecycle.js";
import {
  type ProposalParticipantRef,
  PROPOSAL_TRANSITIONS,
} from "./proposal-types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeParticipants(n: number): ProposalParticipantRef[] {
  return Array.from({ length: n }, (_, i) => ({
    nodeId: `node-${i}`,
    role: i === 0 ? "chair" : "reviewer",
  }));
}

let idCounter = 0;
function fixedIdFactory() {
  return () => `proposal-${++idCounter}`;
}

function createManager(opts?: Partial<ProposalManagerOptions>): ProposalManager {
  idCounter = 0;
  return new ProposalManager({
    idFactory: fixedIdFactory(),
    ...opts,
  });
}

// ---------------------------------------------------------------------------
// State machine validation
// ---------------------------------------------------------------------------

describe("proposal state machine", () => {
  it("has no outgoing transitions from terminal states", () => {
    expect(PROPOSAL_TRANSITIONS["applied"].size).toBe(0);
    expect(PROPOSAL_TRANSITIONS["rejected"].size).toBe(0);
  });

  it("failed can transition back to approved or rejected", () => {
    const fromFailed = PROPOSAL_TRANSITIONS["failed"];
    expect(fromFailed.has("approved")).toBe(true);
    expect(fromFailed.has("rejected")).toBe(true);
  });

  it("blocked can transition to approved or rejected", () => {
    const fromBlocked = PROPOSAL_TRANSITIONS["blocked"];
    expect(fromBlocked.has("approved")).toBe(true);
    expect(fromBlocked.has("rejected")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Proposal creation
// ---------------------------------------------------------------------------

describe("proposal creation", () => {
  it("creates a proposal with proposed status", () => {
    const mgr = createManager();
    const p = mgr.create({
      parentTaskId: "task-1",
      summary: "Upgrade database schema",
      participants: makeParticipants(3),
    });
    expect(p.status).toBe("proposed");
    expect(p.parentTaskId).toBe("task-1");
    expect(p.summary).toBe("Upgrade database schema");
    expect(p.participants).toHaveLength(3);
    expect(p.artifacts).toHaveLength(0);
    expect(p.applyAttempts).toBe(0);
  });

  it("creates with conference room id and artifacts", () => {
    const mgr = createManager();
    const p = mgr.create({
      parentTaskId: "task-1",
      conferenceRoomId: "room-abc",
      summary: "Deploy v2",
      participants: makeParticipants(2),
      artifacts: [
        { id: "a1", category: "artifact", summary: "migration.sql" },
      ],
    });
    expect(p.conferenceRoomId).toBe("room-abc");
    expect(p.artifacts).toHaveLength(1);
    expect(p.artifacts[0].category).toBe("artifact");
  });

  it("emits a proposal_created event", () => {
    const mgr = createManager();
    mgr.create({
      parentTaskId: "task-1",
      summary: "Test",
      participants: makeParticipants(2),
    });
    const events = mgr.subscribe();
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("proposal_created");
  });

  it("assigns unique ids", () => {
    const mgr = createManager();
    const p1 = mgr.create({ parentTaskId: "t", summary: "a", participants: [] });
    const p2 = mgr.create({ parentTaskId: "t", summary: "b", participants: [] });
    expect(p1.id).not.toBe(p2.id);
  });
});

// ---------------------------------------------------------------------------
// Full lifecycle
// ---------------------------------------------------------------------------

describe("proposal lifecycle", () => {
  it("proposed → approved → applying → applied", () => {
    const mgr = createManager();
    const p = mgr.create({
      parentTaskId: "task-1",
      summary: "Full lifecycle",
      participants: makeParticipants(3),
    });

    const approved = mgr.approve(p.id);
    expect(approved.status).toBe("approved");

    const applying = mgr.startApply(p.id);
    expect(applying.status).toBe("applying");
    expect(applying.applyStartedAt).toBeDefined();

    const applied = mgr.completeApply(p.id);
    expect(applied.status).toBe("applied");
    expect(applied.applyCompletedAt).toBeDefined();
  });

  it("proposed → blocked → approved → applying → applied", () => {
    const mgr = createManager();
    const p = mgr.create({
      parentTaskId: "task-1",
      summary: "Block then approve",
      participants: makeParticipants(3),
    });

    const blocked = mgr.block(p.id, "quorum");
    expect(blocked.status).toBe("blocked");
    expect(blocked.reasonCode).toBe("quorum_not_met");

    mgr.approve(p.id);
    mgr.startApply(p.id);
    const applied = mgr.completeApply(p.id);
    expect(applied.status).toBe("applied");
  });

  it("proposed → rejected", () => {
    const mgr = createManager();
    const p = mgr.create({
      parentTaskId: "task-1",
      summary: "Reject me",
      participants: makeParticipants(2),
    });
    const rejected = mgr.reject(p.id);
    expect(rejected.status).toBe("rejected");
  });

  it("proposed → approved → applying → failed → approved → applying → applied", () => {
    const mgr = createManager();
    const p = mgr.create({
      parentTaskId: "task-1",
      summary: "Retry path",
      participants: makeParticipants(2),
    });
    mgr.approve(p.id);
    mgr.startApply(p.id);
    const failed = mgr.failApply(p.id, "timeout");
    expect(failed.status).toBe("failed");
    expect(failed.reasonCode).toBe("apply_timeout");
    expect(failed.applyAttempts).toBe(1);

    // Retry
    mgr.approve(p.id);
    mgr.startApply(p.id);
    const applied = mgr.completeApply(p.id);
    expect(applied.status).toBe("applied");
  });

  it("proposed → approved → rejected (cancel after approve)", () => {
    const mgr = createManager();
    const p = mgr.create({
      parentTaskId: "task-1",
      summary: "Cancel",
      participants: makeParticipants(2),
    });
    mgr.approve(p.id);
    const rejected = mgr.reject(p.id);
    expect(rejected.status).toBe("rejected");
  });
});

// ---------------------------------------------------------------------------
// Invalid transitions
// ---------------------------------------------------------------------------

describe("invalid transitions", () => {
  it("throws on proposed → applying", () => {
    const mgr = createManager();
    const p = mgr.create({
      parentTaskId: "t",
      summary: "s",
      participants: [],
    });
    expect(() => mgr.startApply(p.id)).toThrow(/Cannot transition/i);
  });

  it("throws on applied → anything", () => {
    const mgr = createManager();
    const p = mgr.create({
      parentTaskId: "t",
      summary: "s",
      participants: [],
    });
    mgr.approve(p.id);
    mgr.startApply(p.id);
    mgr.completeApply(p.id);
    expect(() => mgr.block(p.id, "other")).toThrow(/Cannot transition/i);
    expect(() => mgr.approve(p.id)).toThrow(/Cannot transition/i);
  });

  it("throws on rejected → anything", () => {
    const mgr = createManager();
    const p = mgr.create({
      parentTaskId: "t",
      summary: "s",
      participants: [],
    });
    mgr.reject(p.id);
    expect(() => mgr.reject(p.id)).toThrow(/Cannot transition/i);
    expect(() => mgr.approve(p.id)).toThrow(/Cannot transition/i);
  });

  it("throws on non-existent proposal", () => {
    const mgr = createManager();
    expect(() => mgr.approve("nope")).toThrow(/not found/i);
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe("idempotency", () => {
  it("startApply is idempotent when already applying", () => {
    const mgr = createManager();
    const p = mgr.create({
      parentTaskId: "t",
      summary: "s",
      participants: [],
    });
    mgr.approve(p.id);
    const first = mgr.startApply(p.id);
    const second = mgr.startApply(p.id);
    expect(second.status).toBe("applying");
    expect(second.id).toBe(first.id);
    // Only one proposal_applying event (no duplicate)
    const events = mgr.subscribe();
    const applyingEvents = events.filter((e) => e.kind === "proposal_applying");
    expect(applyingEvents).toHaveLength(1);
  });

  it("completeApply is idempotent when already applied", () => {
    const mgr = createManager();
    const p = mgr.create({
      parentTaskId: "t",
      summary: "s",
      participants: [],
    });
    mgr.approve(p.id);
    mgr.startApply(p.id);
    const first = mgr.completeApply(p.id);
    const second = mgr.completeApply(p.id);
    expect(second.status).toBe("applied");
    const events = mgr.subscribe();
    const appliedEvents = events.filter((e) => e.kind === "proposal_applied");
    expect(appliedEvents).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Duplicate proposal handling
// ---------------------------------------------------------------------------

describe("duplicate proposals", () => {
  it("allows multiple proposals for the same task", () => {
    const mgr = createManager();
    const p1 = mgr.create({
      parentTaskId: "task-1",
      summary: "Plan A",
      participants: makeParticipants(2),
    });
    const p2 = mgr.create({
      parentTaskId: "task-1",
      summary: "Plan B",
      participants: makeParticipants(2),
    });
    expect(p1.id).not.toBe(p2.id);
    expect(mgr.getProposalsForTask("task-1")).toHaveLength(2);
  });

  it("allows independent lifecycle per proposal", () => {
    const mgr = createManager();
    const p1 = mgr.create({
      parentTaskId: "task-1",
      summary: "Plan A",
      participants: makeParticipants(2),
    });
    const p2 = mgr.create({
      parentTaskId: "task-1",
      summary: "Plan B",
      participants: makeParticipants(2),
    });
    mgr.approve(p1.id);
    mgr.reject(p2.id);
    expect(mgr.getProposal(p1.id)!.status).toBe("approved");
    expect(mgr.getProposal(p2.id)!.status).toBe("rejected");
  });
});

// ---------------------------------------------------------------------------
// Cursor/replay
// ---------------------------------------------------------------------------

describe("cursor replay", () => {
  it("events have monotonically increasing ids", () => {
    const mgr = createManager();
    const p = mgr.create({
      parentTaskId: "t",
      summary: "s",
      participants: [],
    });
    mgr.approve(p.id);
    mgr.startApply(p.id);
    mgr.completeApply(p.id);
    const events = mgr.subscribe();
    const ids = events.map((e) => e.id);
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]).toBeGreaterThan(ids[i - 1]);
    }
  });

  it("subscribe with afterId skips older events", () => {
    const mgr = createManager();
    const p = mgr.create({
      parentTaskId: "t",
      summary: "s",
      participants: [],
    });
    mgr.approve(p.id);
    mgr.startApply(p.id);
    const all = mgr.subscribe();
    expect(all).toHaveLength(3); // created, approved, applying
    const afterFirst = mgr.subscribe({ afterId: all[0].id });
    expect(afterFirst).toHaveLength(2);
    expect(afterFirst[0].kind).toBe("proposal_approved");
  });

  it("filters by parentTaskId", () => {
    const mgr = createManager();
    mgr.create({ parentTaskId: "task-a", summary: "a", participants: [] });
    mgr.create({ parentTaskId: "task-b", summary: "b", participants: [] });
    expect(mgr.subscribe({ parentTaskId: "task-a" })).toHaveLength(1);
    expect(mgr.subscribe({ parentTaskId: "task-b" })).toHaveLength(1);
  });

  it("filters by conferenceRoomId", () => {
    const mgr = createManager();
    mgr.create({
      parentTaskId: "t",
      conferenceRoomId: "room-1",
      summary: "a",
      participants: [],
    });
    mgr.create({
      parentTaskId: "t",
      conferenceRoomId: "room-2",
      summary: "b",
      participants: [],
    });
    expect(mgr.subscribe({ conferenceRoomId: "room-1" })).toHaveLength(1);
  });

  it("respects limit", () => {
    const mgr = createManager();
    mgr.create({ parentTaskId: "t", summary: "a", participants: [] });
    mgr.create({ parentTaskId: "t", summary: "b", participants: [] });
    mgr.create({ parentTaskId: "t", summary: "c", participants: [] });
    expect(mgr.subscribe({ limit: 2 })).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Replay after retention pressure
// ---------------------------------------------------------------------------

describe("replay after retention eviction", () => {
  it("proposal mutation state survives event eviction", () => {
    // Very small buffer to trigger eviction
    const mgr = createManager({ maxEvents: 3 });
    const p = mgr.create({
      parentTaskId: "t",
      summary: "retention test",
      participants: [],
    });
    mgr.approve(p.id);
    mgr.startApply(p.id);

    // Create more proposals to evict earlier events
    mgr.create({ parentTaskId: "t2", summary: "filler-1", participants: [] });
    mgr.create({ parentTaskId: "t3", summary: "filler-2", participants: [] });

    // Proposal domain state is still intact
    const live = mgr.getProposal(p.id)!;
    expect(live.status).toBe("applying");
    expect(live.applyStartedAt).toBeDefined();

    // Can still complete the apply (domain state not affected by eviction)
    const applied = mgr.completeApply(p.id);
    expect(applied.status).toBe("applied");
  });

  it("cursor replay after eviction returns only retained events", () => {
    const mgr = createManager({ maxEvents: 3 });
    mgr.create({ parentTaskId: "t", summary: "a", participants: [] });
    mgr.create({ parentTaskId: "t", summary: "b", participants: [] });
    mgr.create({ parentTaskId: "t", summary: "c", participants: [] });
    // 3 events in buffer, all retained
    expect(mgr.subscribe()).toHaveLength(3);

    // One more → first evicted
    mgr.create({ parentTaskId: "t", summary: "d", participants: [] });
    const events = mgr.subscribe();
    expect(events).toHaveLength(3);
    expect(events[0].kind).toBe("proposal_created");
    // First event was evicted, so remaining start from id 2
    expect(events[0].id).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

describe("audit trail", () => {
  it("event metadata carries reasonCode for blocked/failed", () => {
    const mgr = createManager();
    const p = mgr.create({
      parentTaskId: "t",
      summary: "s",
      participants: [],
    });
    mgr.block(p.id, "veto");
    const events = mgr.subscribe();
    const blocked = events.find((e) => e.kind === "proposal_blocked");
    expect(blocked!.metadata.reasonCode).toBe("chair_veto");
  });

  it("event metadata carries applyAttempt for failed", () => {
    const mgr = createManager();
    const p = mgr.create({
      parentTaskId: "t",
      summary: "s",
      participants: [],
    });
    mgr.approve(p.id);
    mgr.startApply(p.id);
    mgr.failApply(p.id, "error");
    const events = mgr.subscribe();
    const failed = events.find((e) => e.kind === "proposal_failed");
    expect(failed!.metadata.applyAttempt).toBe(1);
  });

  it("proposal artifact references survive full lifecycle", () => {
    const mgr = createManager();
    const p = mgr.create({
      parentTaskId: "t",
      summary: "s",
      participants: makeParticipants(2),
      artifacts: [
        { id: "art-1", category: "artifact", summary: "schema.sql" },
        { id: "art-2", category: "decision", summary: "Use pgcrypto" },
      ],
    });
    mgr.approve(p.id);
    mgr.startApply(p.id);
    const applied = mgr.completeApply(p.id);

    // Final applied proposal references artifacts without raw content
    expect(applied.artifacts).toHaveLength(2);
    expect(applied.artifacts[0].id).toBe("art-1");
    expect(applied.artifacts[1].summary).toBe("Use pgcrypto");
    expect(applied.participants).toHaveLength(2);
    expect(applied.conferenceRoomId).toBeUndefined();
  });

  it("proposal with conference room references room and participants", () => {
    const mgr = createManager();
    const p = mgr.create({
      parentTaskId: "t",
      conferenceRoomId: "room-42",
      summary: "s",
      participants: [
        { nodeId: "sogyo", role: "chair" },
        { nodeId: "dungae", role: "reviewer" },
      ],
    });
    mgr.approve(p.id);
    mgr.startApply(p.id);
    const applied = mgr.completeApply(p.id);

    expect(applied.conferenceRoomId).toBe("room-42");
    expect(applied.participants).toEqual([
      { nodeId: "sogyo", role: "chair" },
      { nodeId: "dungae", role: "reviewer" },
    ]);
    // No raw prompt/session leakage in events
    const events = mgr.subscribe();
    for (const e of events) {
      expect(e).not.toHaveProperty("prompt");
      expect(e).not.toHaveProperty("sessionText");
      expect(e).not.toHaveProperty("rawBody");
    }
  });
});

// ---------------------------------------------------------------------------
// Reason code resolution
// ---------------------------------------------------------------------------

describe("reason code resolution", () => {
  it("resolves aliases", () => {
    const mgr = createManager();
    const p = mgr.create({
      parentTaskId: "t",
      summary: "s",
      participants: [],
    });
    mgr.block(p.id, "quorum");
    expect(p.reasonCode).toBe("quorum_not_met");
  });

  it("falls back to 'other' for unknown codes", () => {
    const mgr = createManager();
    const p = mgr.create({
      parentTaskId: "t",
      summary: "s",
      participants: [],
    });
    mgr.block(p.id, "something_weird");
    expect(p.reasonCode).toBe("other");
  });
});
