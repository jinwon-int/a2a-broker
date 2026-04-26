/**
 * Conference fan-in proof tests (issue #83).
 *
 * Covers: quorum, chair requirement, participant lifecycle, duplicate/idle/
 * timeout/blocked/partial cases, transcript artifact, comment formatting.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ConferenceFanIn,
  formatConferenceComment,
} from "./conference-fan-in.js";
import type { Contribution, ConferenceVerdict } from "./conference-fan-in.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let idCounter = 0;
function nextId(): string { return `c-${++idCounter}`; }
function resetIds(): void { idCounter = 0; }

function contrib(overrides: Partial<Contribution> & { participantId: string }): Contribution {
  return {
    id: nextId(),
    summary: "test contribution",
    category: "analysis",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Quorum basics
// ---------------------------------------------------------------------------

describe("conference: quorum", () => {
  it("waiting with no participants", () => {
    resetIds();
    const f = new ConferenceFanIn({ minQuorum: 2 });
    const v = f.currentVerdict();
    assert.equal(v.decision, "waiting");
    assert.equal(v.participantCounts.total, 0);
  });

  it("waiting with 1 participant (need 2)", () => {
    resetIds();
    const f = new ConferenceFanIn({ minQuorum: 2, requireChairContribution: false });
    f.joinParticipant({ nodeId: "alpha", role: "presenter" });
    const v = f.currentVerdict();
    assert.equal(v.decision, "waiting");
    assert.ok(v.reason.includes("1/2"));
  });

  it("waiting when quorum met but no contributions", () => {
    resetIds();
    const f = new ConferenceFanIn({ minQuorum: 2, requireChairContribution: false });
    f.joinParticipant({ nodeId: "alpha", role: "presenter" });
    f.joinParticipant({ nodeId: "beta", role: "reviewer" });
    const v = f.currentVerdict();
    assert.equal(v.decision, "waiting");
    assert.ok(v.reason.includes("no contributions"));
  });

  it("waiting when quorum met and one contributing", () => {
    resetIds();
    const f = new ConferenceFanIn({ minQuorum: 2, requireChairContribution: false });
    f.joinParticipant({ nodeId: "alpha", role: "presenter" });
    f.joinParticipant({ nodeId: "beta", role: "reviewer" });
    f.addContribution(contrib({ participantId: "alpha" }));
    const v = f.currentVerdict();
    assert.equal(v.decision, "waiting");
    assert.ok(v.reason.includes("still contributing"));
  });

  it("ready when quorum met and all contributed", () => {
    resetIds();
    const f = new ConferenceFanIn({ minQuorum: 2, requireChairContribution: false });
    f.joinParticipant({ nodeId: "alpha", role: "presenter" });
    f.joinParticipant({ nodeId: "beta", role: "reviewer" });
    f.addContribution(contrib({ participantId: "alpha" }));
    // Mark alpha as idle (done contributing)
    f.updateParticipant("alpha", "idle");
    f.addContribution(contrib({ participantId: "beta" }));
    f.updateParticipant("beta", "idle");
    const v = f.currentVerdict();
    assert.equal(v.decision, "ready");
  });
});

// ---------------------------------------------------------------------------
// Chair requirement
// ---------------------------------------------------------------------------

describe("conference: chair requirement", () => {
  it("blocked when no chair present", () => {
    resetIds();
    const f = new ConferenceFanIn({ requireChairContribution: true });
    f.joinParticipant({ nodeId: "alpha", role: "presenter" });
    const v = f.currentVerdict();
    assert.equal(v.decision, "blocked");
    assert.ok(v.reason.includes("Chair"));
  });

  it("waiting when chair present but no contribution", () => {
    resetIds();
    const f = new ConferenceFanIn({ minQuorum: 2 });
    f.joinParticipant({ nodeId: "chair-1", role: "chair" });
    f.joinParticipant({ nodeId: "alpha", role: "presenter" });
    f.addContribution(contrib({ participantId: "alpha" }));
    const v = f.currentVerdict();
    assert.equal(v.decision, "waiting");
    assert.ok(v.reason.includes("chair"));
  });

  it("ready when chair contributes", () => {
    resetIds();
    const f = new ConferenceFanIn({ minQuorum: 2 });
    f.joinParticipant({ nodeId: "chair-1", role: "chair" });
    f.joinParticipant({ nodeId: "alpha", role: "presenter" });
    f.addContribution(contrib({ participantId: "chair-1" }));
    f.updateParticipant("chair-1", "idle");
    f.addContribution(contrib({ participantId: "alpha" }));
    f.updateParticipant("alpha", "idle");
    const v = f.currentVerdict();
    assert.equal(v.decision, "ready");
  });
});

// ---------------------------------------------------------------------------
// Participant lifecycle
// ---------------------------------------------------------------------------

describe("conference: participant lifecycle", () => {
  it("participant joins with correct status", () => {
    resetIds();
    const f = new ConferenceFanIn({ requireChairContribution: false });
    f.joinParticipant({ nodeId: "alpha", role: "presenter", displayName: "Alpha" });
    const p = f.getParticipant("alpha");
    assert.equal(p?.status, "joined");
    assert.equal(p?.role, "presenter");
    assert.equal(p?.displayName, "Alpha");
  });

  it("participant status transitions", () => {
    resetIds();
    const f = new ConferenceFanIn({ requireChairContribution: false });
    f.joinParticipant({ nodeId: "alpha", role: "presenter" });
    assert.equal(f.getParticipant("alpha")?.status, "joined");
    f.markContributing("alpha");
    assert.equal(f.getParticipant("alpha")?.status, "contributing");
    f.updateParticipant("alpha", "idle");
    assert.equal(f.getParticipant("alpha")?.status, "idle");
  });

  it("participant left is tracked", () => {
    resetIds();
    const f = new ConferenceFanIn({ requireChairContribution: false, minQuorum: 3 });
    f.joinParticipant({ nodeId: "alpha", role: "presenter" });
    f.joinParticipant({ nodeId: "beta", role: "presenter" });
    f.updateParticipant("beta", "left");
    const v = f.currentVerdict();
    assert.equal(v.participantCounts.left, 1);
  });
});

// ---------------------------------------------------------------------------
// Timeout
// ---------------------------------------------------------------------------

describe("conference: timeout", () => {
  it("blocked when participant times out", () => {
    resetIds();
    const f = new ConferenceFanIn({ minQuorum: 2, requireChairContribution: false });
    f.joinParticipant({ nodeId: "alpha", role: "presenter" });
    f.joinParticipant({ nodeId: "beta", role: "presenter" });
    f.updateParticipant("beta", "timed_out");
    const v = f.currentVerdict();
    assert.equal(v.decision, "blocked");
    assert.ok(v.reason.includes("timed out"));
    assert.ok(v.signals.some(s => s.includes("timeout:beta")));
  });

  it("failed when quorum unreachable after departure", () => {
    resetIds();
    const f = new ConferenceFanIn({ minQuorum: 3, requireChairContribution: false });
    f.joinParticipant({ nodeId: "alpha", role: "presenter" });
    f.joinParticipant({ nodeId: "beta", role: "presenter" });
    f.joinParticipant({ nodeId: "gamma", role: "presenter" });
    f.updateParticipant("gamma", "left");
    f.updateParticipant("beta", "left");
    const v = f.currentVerdict();
    assert.equal(v.decision, "failed");
    assert.ok(v.reason.includes("unreachable"));
  });
});

// ---------------------------------------------------------------------------
// Duplicate contributions
// ---------------------------------------------------------------------------

describe("conference: duplicate contributions", () => {
  it("duplicate contribution rejected", () => {
    resetIds();
    const f = new ConferenceFanIn({ minQuorum: 1, requireChairContribution: false });
    f.joinParticipant({ nodeId: "alpha", role: "presenter" });
    const c = contrib({ participantId: "alpha", id: "dup-1" });
    const r1 = f.addContribution(c);
    assert.equal(r1.accepted, true);
    const r2 = f.addContribution(c);
    assert.equal(r2.accepted, false);
    assert.equal(r2.reason, "duplicate");
    assert.equal(f.getContributions().length, 1);
  });

  it("contribution from unknown participant rejected", () => {
    resetIds();
    const f = new ConferenceFanIn({ minQuorum: 1, requireChairContribution: false });
    const r = f.addContribution(contrib({ participantId: "ghost" }));
    assert.equal(r.accepted, false);
    assert.equal(r.reason, "unknown_participant");
  });

  it("max contributions per participant enforced", () => {
    resetIds();
    const f = new ConferenceFanIn({ minQuorum: 1, requireChairContribution: false, maxContributionsPerParticipant: 2 });
    f.joinParticipant({ nodeId: "alpha", role: "presenter" });
    f.addContribution(contrib({ participantId: "alpha" }));
    f.addContribution(contrib({ participantId: "alpha" }));
    const r = f.addContribution(contrib({ participantId: "alpha" }));
    assert.equal(r.accepted, false);
    assert.equal(r.reason, "max_contributions");
    assert.equal(f.getContributions().length, 2);
  });
});

// ---------------------------------------------------------------------------
// Transcript artifact
// ---------------------------------------------------------------------------

describe("conference: transcript artifact", () => {
  it("produces deterministic transcript", () => {
    resetIds();
    const f = new ConferenceFanIn({ minQuorum: 2, requireChairContribution: false });
    f.joinParticipant({ nodeId: "alpha", role: "presenter", displayName: "Alpha" });
    f.joinParticipant({ nodeId: "beta", role: "reviewer", displayName: "Beta" });
    f.addContribution(contrib({ participantId: "alpha", summary: "Analysis complete", category: "analysis", artifactIds: ["a1"] }));
    f.addContribution(contrib({ participantId: "beta", summary: "Looks good", category: "decision", replyTo: "c-1" }));

    const artifact = f.buildTranscriptArtifact();
    assert.equal(artifact.type, "teleconference-transcript");
    assert.equal(artifact.participants.length, 2);
    assert.equal(artifact.contributions.length, 2);
    assert.equal(artifact.threadCount, 1);
    assert.deepEqual(artifact.uniqueArtifacts, ["a1"]);
    assert.equal(artifact.decisionCategories.analysis, 1);
    assert.equal(artifact.decisionCategories.decision, 1);
  });

  it("contributions sorted by time", () => {
    resetIds();
    const f = new ConferenceFanIn({ minQuorum: 1, requireChairContribution: false });
    f.joinParticipant({ nodeId: "alpha", role: "presenter" });
    f.addContribution(contrib({ participantId: "alpha", createdAt: "2026-04-26T10:00:00Z" }));
    f.addContribution(contrib({ participantId: "alpha", createdAt: "2026-04-26T09:00:00Z" }));
    const artifact = f.buildTranscriptArtifact();
    assert.ok(new Date(artifact.contributions[0].createdAt).getTime() < new Date(artifact.contributions[1].createdAt).getTime());
  });

  it("no raw text in transcript", () => {
    resetIds();
    const f = new ConferenceFanIn({ minQuorum: 1, requireChairContribution: false });
    f.joinParticipant({ nodeId: "alpha", role: "presenter" });
    f.addContribution(contrib({ participantId: "alpha", summary: "Redacted summary" }));
    const artifact = f.buildTranscriptArtifact();
    // Only structured data, no raw session text
    for (const c of artifact.contributions) {
      assert.ok(typeof c.summary === "string");
      assert.ok(c.summary.length < 500);
    }
  });
});

// ---------------------------------------------------------------------------
// Comment formatting
// ---------------------------------------------------------------------------

describe("conference: comment formatting", () => {
  it("formats ready comment", () => {
    resetIds();
    const f = new ConferenceFanIn({ minQuorum: 2, requireChairContribution: false });
    f.joinParticipant({ nodeId: "alpha", role: "presenter" });
    f.joinParticipant({ nodeId: "beta", role: "reviewer" });
    f.addContribution(contrib({ participantId: "alpha" }));
    f.updateParticipant("alpha", "idle");
    f.addContribution(contrib({ participantId: "beta" }));
    f.updateParticipant("beta", "idle");
    const comment = formatConferenceComment(f.currentVerdict(), f.buildTranscriptArtifact());
    assert.ok(comment.includes("✅"));
    assert.ok(comment.includes("READY"));
  });

  it("formats blocked comment", () => {
    resetIds();
    const f = new ConferenceFanIn({ minQuorum: 2, requireChairContribution: true });
    f.joinParticipant({ nodeId: "alpha", role: "presenter" });
    const comment = formatConferenceComment(f.currentVerdict());
    assert.ok(comment.includes("🚫"));
    assert.ok(comment.includes("BLOCKED"));
  });

  it("formats waiting comment", () => {
    resetIds();
    const f = new ConferenceFanIn({ minQuorum: 2, requireChairContribution: false });
    f.joinParticipant({ nodeId: "alpha", role: "presenter" });
    const comment = formatConferenceComment(f.currentVerdict());
    assert.ok(comment.includes("⏳"));
    assert.ok(comment.includes("WAITING"));
  });

  it("formats failed comment", () => {
    resetIds();
    const f = new ConferenceFanIn({ minQuorum: 3, requireChairContribution: false });
    f.joinParticipant({ nodeId: "alpha", role: "presenter" });
    f.joinParticipant({ nodeId: "beta", role: "presenter" });
    f.updateParticipant("beta", "left");
    const comment = formatConferenceComment(f.currentVerdict());
    assert.ok(comment.includes("❌"));
    assert.ok(comment.includes("FAILED"));
  });

  it("includes contribution category breakdown", () => {
    resetIds();
    const f = new ConferenceFanIn({ minQuorum: 1, requireChairContribution: false });
    f.joinParticipant({ nodeId: "alpha", role: "presenter" });
    f.addContribution(contrib({ participantId: "alpha", category: "analysis" }));
    f.addContribution(contrib({ participantId: "alpha", category: "question" }));
    const comment = formatConferenceComment(f.currentVerdict(), f.buildTranscriptArtifact());
    assert.ok(comment.includes("1 analysis"));
    assert.ok(comment.includes("1 questions"));
  });
});

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

describe("conference: reset", () => {
  it("clears all state", () => {
    resetIds();
    const f = new ConferenceFanIn({ requireChairContribution: false });
    f.joinParticipant({ nodeId: "alpha", role: "presenter" });
    f.addContribution(contrib({ participantId: "alpha" }));
    assert.equal(f.getParticipantCount(), 1);
    f.reset();
    assert.equal(f.getParticipantCount(), 0);
    assert.equal(f.getContributions().length, 0);
    assert.equal(f.currentVerdict().seq, 0);
  });
});

// ---------------------------------------------------------------------------
// Cross-scenario matrix
// ---------------------------------------------------------------------------

describe("conference: cross-scenario matrix", () => {
  const scenarios: Array<{
    name: string;
    config?: ConferenceConfig;
    steps: (f: ConferenceFanIn) => void;
    expected: string;
  }> = [
    {
      name: "simple success",
      config: { minQuorum: 2, requireChairContribution: false },
      steps: (f) => {
        f.joinParticipant({ nodeId: "a", role: "presenter" });
        f.joinParticipant({ nodeId: "b", role: "reviewer" });
        f.addContribution(contrib({ participantId: "a" }));
        f.updateParticipant("a", "idle");
        f.addContribution(contrib({ participantId: "b" }));
        f.updateParticipant("b", "idle");
      },
      expected: "ready",
    },
    {
      name: "no quorum",
      config: { minQuorum: 3, requireChairContribution: false },
      steps: (f) => {
        f.joinParticipant({ nodeId: "a", role: "presenter" });
        f.joinParticipant({ nodeId: "b", role: "reviewer" });
      },
      expected: "waiting",
    },
    {
      name: "no chair",
      config: { requireChairContribution: true },
      steps: (f) => {
        f.joinParticipant({ nodeId: "a", role: "presenter" });
        f.joinParticipant({ nodeId: "b", role: "reviewer" });
      },
      expected: "blocked",
    },
    {
      name: "timeout blocks",
      config: { minQuorum: 2, requireChairContribution: false },
      steps: (f) => {
        f.joinParticipant({ nodeId: "a", role: "presenter" });
        f.joinParticipant({ nodeId: "b", role: "reviewer" });
        f.updateParticipant("b", "timed_out");
      },
      expected: "blocked",
    },
    {
      name: "quorum unreachable",
      config: { minQuorum: 3, requireChairContribution: false },
      steps: (f) => {
        f.joinParticipant({ nodeId: "a", role: "presenter" });
        f.joinParticipant({ nodeId: "b", role: "reviewer" });
        f.joinParticipant({ nodeId: "c", role: "observer" });
        f.updateParticipant("c", "left");
      },
      expected: "failed",
    },
    {
      name: "duplicate contribution idempotent",
      config: { minQuorum: 1, requireChairContribution: false },
      steps: (f) => {
        f.joinParticipant({ nodeId: "a", role: "presenter" });
        const c = contrib({ participantId: "a", id: "x1" });
        f.addContribution(c);
        f.addContribution(c);
      },
      expected: "waiting",
    },
  ];

  for (const s of scenarios) {
    it(`${s.name} → ${s.expected}`, () => {
      resetIds();
      const f = new ConferenceFanIn(s.config);
      s.steps(f);
      assert.equal(f.currentVerdict().decision, s.expected);
    });
  }
});
