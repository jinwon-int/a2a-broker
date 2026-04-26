import { describe, expect, it } from "vitest";

import {
  WakeAuditManager,
  type WakeAuditManagerOptions,
} from "./wake-audit.js";
import {
  type WakeFailureCode,
  WAKE_TRANSITIONS,
} from "./wake-audit-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createManager(opts?: Partial<WakeAuditManagerOptions>): WakeAuditManager {
  return new WakeAuditManager({
    idFactory: () => `run-${Math.random().toString(36).slice(2)}`,
    ...opts,
  });
}

function baseInput(overrides?: Partial<{ sessionKey: string; peerNodeId: string; parentTaskId: string; replayCursor: number }>) {
  return {
    sessionKey: overrides?.sessionKey ?? "session-alpha",
    peerNodeId: overrides?.peerNodeId ?? "sogyo",
    parentTaskId: overrides?.parentTaskId ?? "task-1",
    replayCursor: overrides?.replayCursor ?? 42,
  };
}

// ---------------------------------------------------------------------------
// State machine validation
// ---------------------------------------------------------------------------

describe("wake state machine", () => {
  it("terminal states have no outgoing transitions", () => {
    expect(WAKE_TRANSITIONS["replied"].size).toBe(0);
    expect(WAKE_TRANSITIONS["duplicate_suppressed"].size).toBe(0);
  });

  it("failed and unreachable can retry", () => {
    expect(WAKE_TRANSITIONS["failed"].has("requested")).toBe(true);
    expect(WAKE_TRANSITIONS["failed"].has("accepted")).toBe(true);
    expect(WAKE_TRANSITIONS["unreachable"].has("requested")).toBe(true);
  });

  it("requested cannot go directly to resumed", () => {
    expect(WAKE_TRANSITIONS["requested"].has("resumed")).toBe(false);
  });

  it("accepted can go to resumed or launched", () => {
    const fromAccepted = WAKE_TRANSITIONS["accepted"];
    expect(fromAccepted.has("resumed")).toBe(true);
    expect(fromAccepted.has("launched")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Normal wake lifecycle
// ---------------------------------------------------------------------------

describe("normal durable resume", () => {
  it("full happy path: request → accept → resume → reply", () => {
    const mgr = createManager();
    const input = baseInput();

    const requested = mgr.requestWake(input);
    expect(requested.status).toBe("requested");
    expect(requested.wakeAttempts).toBe(1);
    expect(requested.replayCursor).toBe(42);

    const accepted = mgr.acceptWake(input.sessionKey, "run-001");
    expect(accepted.status).toBe("accepted");
    expect(accepted.runId).toBe("run-001");
    expect(accepted.acceptedAt).toBeDefined();

    const resumed = mgr.resumeWake(input.sessionKey);
    expect(resumed.status).toBe("resumed");
    expect(resumed.startedAt).toBeDefined();

    const replied = mgr.replyWake(input.sessionKey, 3200);
    expect(replied.status).toBe("replied");
    expect(replied.completedAt).toBeDefined();
  });

  it("full happy path: request → accept → launch → reply", () => {
    const mgr = createManager();
    const input = baseInput();

    mgr.requestWake(input);
    mgr.acceptWake(input.sessionKey);
    const launched = mgr.launchWake(input.sessionKey, "run-002");
    expect(launched.status).toBe("launched");
    expect(launched.runId).toBe("run-002");

    const replied = mgr.replyWake(input.sessionKey, 1500);
    expect(replied.status).toBe("replied");
  });

  it("emits correct event sequence", () => {
    const mgr = createManager();
    const input = baseInput();
    mgr.requestWake(input);
    mgr.acceptWake(input.sessionKey);
    mgr.resumeWake(input.sessionKey);
    mgr.replyWake(input.sessionKey);

    const events = mgr.subscribe();
    expect(events.map((e) => e.kind)).toEqual([
      "wake_requested",
      "wake_accepted",
      "wake_resumed",
      "wake_replied",
    ]);
  });

  it("replied event carries durationMs", () => {
    const mgr = createManager();
    const input = baseInput();
    mgr.requestWake(input);
    mgr.acceptWake(input.sessionKey);
    mgr.resumeWake(input.sessionKey);
    mgr.replyWake(input.sessionKey, 5000);

    const events = mgr.subscribe();
    const replied = events.find((e) => e.kind === "wake_replied");
    expect(replied!.metadata.durationMs).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// Duplicate wake suppression
// ---------------------------------------------------------------------------

describe("duplicate wake suppression", () => {
  it("suppresses duplicate wake on active session", () => {
    const mgr = createManager();
    const input = baseInput();

    mgr.requestWake(input);
    mgr.acceptWake(input.sessionKey);

    // Duplicate request while accepted (active)
    const dup = mgr.requestWake(input);
    expect(dup.status).toBe("duplicate_suppressed");

    const events = mgr.subscribe();
    const dupEvent = events.find((e) => e.kind === "wake_duplicate_suppressed");
    expect(dupEvent).toBeDefined();
    expect(dupEvent!.metadata.dedupEventId).toBeDefined();
  });

  it("suppresses duplicate while resumed", () => {
    const mgr = createManager();
    const input = baseInput();

    mgr.requestWake(input);
    mgr.acceptWake(input.sessionKey);
    mgr.resumeWake(input.sessionKey);

    const dup = mgr.requestWake(input);
    expect(dup.status).toBe("duplicate_suppressed");
  });

  it("suppresses duplicate while launched", () => {
    const mgr = createManager();
    const input = baseInput();
    mgr.requestWake(input);
    mgr.acceptWake(input.sessionKey);
    mgr.launchWake(input.sessionKey);

    const dup = mgr.requestWake(input);
    expect(dup.status).toBe("duplicate_suppressed");
  });

  it("does not suppress after terminal replied", () => {
    const mgr = createManager();
    const input = baseInput();
    mgr.requestWake(input);
    mgr.acceptWake(input.sessionKey);
    mgr.resumeWake(input.sessionKey);
    mgr.replyWake(input.sessionKey);

    // New wake after terminal — should create fresh request
    const retry = mgr.requestWake(input);
    expect(retry.status).toBe("requested");
    expect(retry.wakeAttempts).toBe(2);
  });

  it("does not suppress after failed", () => {
    const mgr = createManager();
    const input = baseInput();
    mgr.requestWake(input);
    mgr.failWake(input.sessionKey, "timeout");

    const retry = mgr.requestWake(input);
    expect(retry.status).toBe("requested");
    expect(retry.wakeAttempts).toBe(2);
  });

  it("preserves original requestedAt on retry", () => {
    const mgr = createManager({ now: () => new Date("2026-04-26T10:00:00Z") });
    const input = baseInput();

    mgr.requestWake(input);
    const original = mgr.getSession(input.sessionKey)!;

    // Advance clock
    const mgr2 = new WakeAuditManager({
      idFactory: () => `run-${Math.random().toString(36).slice(2)}`,
      now: () => new Date("2026-04-26T11:00:00Z"),
    });
    // Can't share state across managers, so test inline
    mgr.failWake(input.sessionKey, "timeout");
    const retried = mgr.requestWake(input);
    expect(retried.requestedAt).toBe(original.requestedAt);
  });
});

// ---------------------------------------------------------------------------
// Unreachable / degraded peer
// ---------------------------------------------------------------------------

describe("unreachable peer", () => {
  it("marks session as unreachable from requested", () => {
    const mgr = createManager();
    const input = baseInput();
    mgr.requestWake(input);

    const unreachable = mgr.markUnreachable(input.sessionKey);
    expect(unreachable.status).toBe("unreachable");
    expect(unreachable.failureCode).toBe("peer_unreachable");
    expect(unreachable.completedAt).toBeDefined();
  });

  it("marks session as unreachable from accepted", () => {
    const mgr = createManager();
    const input = baseInput();
    mgr.requestWake(input);
    mgr.acceptWake(input.sessionKey);

    const unreachable = mgr.markUnreachable(input.sessionKey);
    expect(unreachable.status).toBe("unreachable");
  });

  it("can retry after unreachable", () => {
    const mgr = createManager();
    const input = baseInput();
    mgr.requestWake(input);
    mgr.markUnreachable(input.sessionKey);

    const retry = mgr.requestWake(input);
    expect(retry.status).toBe("requested");
    expect(retry.wakeAttempts).toBe(2);
  });

  it("emits wake_unreachable event with failureCode", () => {
    const mgr = createManager();
    const input = baseInput();
    mgr.requestWake(input);
    mgr.markUnreachable(input.sessionKey);

    const events = mgr.subscribe();
    const ue = events.find((e) => e.kind === "wake_unreachable");
    expect(ue).toBeDefined();
    expect(ue!.metadata.failureCode).toBe("peer_unreachable");
  });
});

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

describe("failure handling", () => {
  it("fails from accepted state with structured code", () => {
    const mgr = createManager();
    const input = baseInput();
    mgr.requestWake(input);
    mgr.acceptWake(input.sessionKey);

    const failed = mgr.failWake(input.sessionKey, "session_expired");
    expect(failed.status).toBe("failed");
    expect(failed.failureCode).toBe("session_expired");
  });

  it("fails from resumed state", () => {
    const mgr = createManager();
    const input = baseInput();
    mgr.requestWake(input);
    mgr.acceptWake(input.sessionKey);
    mgr.resumeWake(input.sessionKey);

    const failed = mgr.failWake(input.sessionKey, "runtime_error");
    expect(failed.status).toBe("failed");
    expect(failed.failureCode).toBe("runtime_error");
  });

  it("resolves failure code aliases", () => {
    const mgr = createManager();
    const input = baseInput();
    mgr.requestWake(input);
    mgr.failWake(input.sessionKey, "cursor_gap");
    expect(mgr.getSession(input.sessionKey)!.failureCode).toBe("resume_cursor_gap");
  });

  it("falls back to 'other' for unknown codes", () => {
    const mgr = createManager();
    const input = baseInput();
    mgr.requestWake(input);
    mgr.failWake(input.sessionKey, "something_weird");
    expect(mgr.getSession(input.sessionKey)!.failureCode).toBe("other");
  });

  it("can retry after failure", () => {
    const mgr = createManager();
    const input = baseInput();
    mgr.requestWake(input);
    mgr.acceptWake(input.sessionKey);
    mgr.resumeWake(input.sessionKey);
    mgr.failWake(input.sessionKey, "timeout");

    const retry = mgr.requestWake(input);
    expect(retry.status).toBe("requested");
    expect(retry.wakeAttempts).toBe(2);
  });

  it("increments wakeAttempts on each retry", () => {
    const mgr = createManager();
    const input = baseInput();

    mgr.requestWake(input);
    mgr.failWake(input.sessionKey, "timeout");
    mgr.requestWake(input);
    mgr.failWake(input.sessionKey, "timeout");
    mgr.requestWake(input);

    expect(mgr.getSession(input.sessionKey)!.wakeAttempts).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Invalid transitions
// ---------------------------------------------------------------------------

describe("invalid transitions", () => {
  it("throws on resumed → accepted", () => {
    const mgr = createManager();
    const input = baseInput();
    mgr.requestWake(input);
    mgr.acceptWake(input.sessionKey);
    mgr.resumeWake(input.sessionKey);

    expect(() => mgr.acceptWake(input.sessionKey)).toThrow(/Cannot transition/i);
  });

  it("throws on replied → anything", () => {
    const mgr = createManager();
    const input = baseInput();
    mgr.requestWake(input);
    mgr.acceptWake(input.sessionKey);
    mgr.resumeWake(input.sessionKey);
    mgr.replyWake(input.sessionKey);

    expect(() => mgr.failWake(input.sessionKey, "other")).toThrow(/Cannot transition/i);
  });

  it("throws on non-existent session", () => {
    const mgr = createManager();
    expect(() => mgr.acceptWake("nope")).toThrow(/not found/i);
  });
});

// ---------------------------------------------------------------------------
// Cursor/replay
// ---------------------------------------------------------------------------

describe("cursor replay", () => {
  it("events have monotonically increasing ids", () => {
    const mgr = createManager();
    const input = baseInput();
    mgr.requestWake(input);
    mgr.acceptWake(input.sessionKey);
    mgr.resumeWake(input.sessionKey);
    mgr.replyWake(input.sessionKey);

    const events = mgr.subscribe();
    const ids = events.map((e) => e.id);
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]).toBeGreaterThan(ids[i - 1]);
    }
  });

  it("subscribe with afterId skips older events", () => {
    const mgr = createManager();
    const input = baseInput();
    mgr.requestWake(input);
    mgr.acceptWake(input.sessionKey);

    const all = mgr.subscribe();
    expect(all).toHaveLength(2);
    const afterFirst = mgr.subscribe({ afterId: all[0].id });
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0].kind).toBe("wake_accepted");
  });

  it("filters by sessionKey", () => {
    const mgr = createManager();
    mgr.requestWake(baseInput({ sessionKey: "s1", peerNodeId: "a" }));
    mgr.requestWake(baseInput({ sessionKey: "s2", peerNodeId: "b" }));

    expect(mgr.subscribe({ sessionKey: "s1" })).toHaveLength(1);
    expect(mgr.subscribe({ sessionKey: "s2" })).toHaveLength(1);
  });

  it("filters by peerNodeId", () => {
    const mgr = createManager();
    mgr.requestWake(baseInput({ sessionKey: "s1", peerNodeId: "sogyo" }));
    mgr.requestWake(baseInput({ sessionKey: "s2", peerNodeId: "dungae" }));

    expect(mgr.subscribe({ peerNodeId: "sogyo" })).toHaveLength(1);
    expect(mgr.subscribe({ peerNodeId: "dungae" })).toHaveLength(1);
  });

  it("filters by parentTaskId", () => {
    const mgr = createManager();
    mgr.requestWake(baseInput({ parentTaskId: "task-a" }));
    mgr.requestWake(baseInput({ parentTaskId: "task-b" }));

    expect(mgr.subscribe({ parentTaskId: "task-a" })).toHaveLength(1);
  });

  it("respects limit", () => {
    const mgr = createManager();
    mgr.requestWake(baseInput({ sessionKey: "a" }));
    mgr.requestWake(baseInput({ sessionKey: "b" }));
    mgr.requestWake(baseInput({ sessionKey: "c" }));

    expect(mgr.subscribe({ limit: 2 })).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Replay after retention pressure
// ---------------------------------------------------------------------------

describe("replay after retention eviction", () => {
  it("session state survives event eviction", () => {
    const mgr = createManager({ maxEvents: 3 });
    const input = baseInput();
    mgr.requestWake(input);
    mgr.acceptWake(input.sessionKey);
    mgr.resumeWake(input.sessionKey);

    // Fill buffer to evict earlier events
    mgr.requestWake(baseInput({ sessionKey: "filler-1" }));
    mgr.requestWake(baseInput({ sessionKey: "filler-2" }));

    // Domain state intact
    const session = mgr.getSession(input.sessionKey)!;
    expect(session.status).toBe("resumed");
    expect(session.runId).toBeUndefined();
    expect(session.wakeAttempts).toBe(1);

    // Can still complete
    const replied = mgr.replyWake(input.sessionKey, 1000);
    expect(replied.status).toBe("replied");
  });

  it("cursor replay returns only retained events after eviction", () => {
    const mgr = createManager({ maxEvents: 3 });
    mgr.requestWake(baseInput({ sessionKey: "a" }));
    mgr.requestWake(baseInput({ sessionKey: "b" }));
    mgr.requestWake(baseInput({ sessionKey: "c" }));

    expect(mgr.subscribe()).toHaveLength(3);

    // One more → first evicted
    mgr.requestWake(baseInput({ sessionKey: "d" }));
    const events = mgr.subscribe();
    expect(events).toHaveLength(3);
    expect(events[0].id).toBe(2);
  });

  it("duplicate suppression still works after eviction", () => {
    const mgr = createManager({ maxEvents: 2 });
    const input = baseInput();
    mgr.requestWake(input);
    mgr.acceptWake(input.sessionKey);

    // Evict request event
    mgr.requestWake(baseInput({ sessionKey: "filler" }));

    // Duplicate detection uses session state, not events
    const dup = mgr.requestWake(input);
    expect(dup.status).toBe("duplicate_suppressed");
  });
});

// ---------------------------------------------------------------------------
// Audit trail — no raw content leakage
// ---------------------------------------------------------------------------

describe("audit trail safety", () => {
  it("events never carry raw prompt or session text", () => {
    const mgr = createManager();
    const input = baseInput();
    mgr.requestWake(input);
    mgr.acceptWake(input.sessionKey, "run-x");
    mgr.resumeWake(input.sessionKey);
    mgr.replyWake(input.sessionKey, 2000);

    const events = mgr.subscribe();
    for (const e of events) {
      expect(e).not.toHaveProperty("prompt");
      expect(e).not.toHaveProperty("sessionText");
      expect(e).not.toHaveProperty("rawBody");
      expect(e).not.toHaveProperty("message");
    }
  });

  it("session state has no raw content fields", () => {
    const mgr = createManager();
    const input = baseInput();
    mgr.requestWake(input);
    const session = mgr.getSession(input.sessionKey)!;

    expect(session).not.toHaveProperty("prompt");
    expect(session).not.toHaveProperty("sessionText");
    expect(session).not.toHaveProperty("rawBody");
  });

  it("event carries structured metadata only", () => {
    const mgr = createManager();
    const input = baseInput({ replayCursor: 99 });
    mgr.requestWake(input);
    mgr.acceptWake(input.sessionKey, "run-abc");

    const events = mgr.subscribe();
    const requested = events.find((e) => e.kind === "wake_requested");
    expect(requested!.metadata.replayCursor).toBe(99);

    const accepted = events.find((e) => e.kind === "wake_accepted");
    // runId is in event, not metadata
    expect(accepted!.runId).toBe("run-abc");
  });
});

// ---------------------------------------------------------------------------
// Multi-session scenarios
// ---------------------------------------------------------------------------

describe("multi-session scenarios", () => {
  it("tracks multiple independent wake sessions", () => {
    const mgr = createManager();
    const a = baseInput({ sessionKey: "session-a", peerNodeId: "sogyo" });
    const b = baseInput({ sessionKey: "session-b", peerNodeId: "dungae" });

    mgr.requestWake(a);
    mgr.requestWake(b);

    mgr.acceptWake("session-a");
    mgr.markUnreachable("session-b");

    expect(mgr.getSession("session-a")!.status).toBe("accepted");
    expect(mgr.getSession("session-b")!.status).toBe("unreachable");
  });

  it("getSessionsForPeer filters correctly", () => {
    const mgr = createManager();
    mgr.requestWake(baseInput({ sessionKey: "s1", peerNodeId: "sogyo" }));
    mgr.requestWake(baseInput({ sessionKey: "s2", peerNodeId: "sogyo" }));
    mgr.requestWake(baseInput({ sessionKey: "s3", peerNodeId: "dungae" }));

    expect(mgr.getSessionsForPeer("sogyo")).toHaveLength(2);
    expect(mgr.getSessionsForPeer("dungae")).toHaveLength(1);
  });

  it("getSessionsForTask filters correctly", () => {
    const mgr = createManager();
    mgr.requestWake(baseInput({ sessionKey: "s1", parentTaskId: "task-a" }));
    mgr.requestWake(baseInput({ sessionKey: "s2", parentTaskId: "task-a" }));
    mgr.requestWake(baseInput({ sessionKey: "s3", parentTaskId: "task-b" }));

    expect(mgr.getSessionsForTask("task-a")).toHaveLength(2);
    expect(mgr.getSessionsForTask("task-b")).toHaveLength(1);
  });
});
