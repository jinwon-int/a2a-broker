/**
 * Post-dispatch verifier tests (R12/PR #602).
 *
 * Covers:
 * - valid dispatch verification with all required fields
 * - missing parentRoundId, originBrokerId
 * - mismatched originBrokerId vs receiver
 * - missing/mismatched parentRoundTotal
 * - valid crossBrokerHandoff in payload
 * - missing/mismatched crossBrokerHandoff fields
 * - snapshot capture and check flow
 * - snapshot expiry (beyond 60 s window)
 * - notification ownership guard fields
 * - combined verifyDispatchWithSnapshot convenience
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PostDispatchVerifier,
  InMemorySnapshotStore,
  type ParentMetadataSnapshot,
} from "./post-dispatch-verifier.js";
import type { CrossBrokerTerminalBriefProjectionRequest } from "./cross-broker-terminal-brief.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validRequest(overrides: Partial<CrossBrokerTerminalBriefProjectionRequest> = {}): CrossBrokerTerminalBriefProjectionRequest {
  return {
    parentRoundId: "round-parent",
    originBrokerId: "child-broker-a",
    brokerOfRecordId: "parent-broker",
    childTaskId: "child-task-1",
    parentRoundTotal: 7,
    parentRoundOrder: 1,
    status: "succeeded",
    summary: "child completed safely",
    taskBrief: "minimal safe patch",
    evidenceUrl: "https://github.com/acme/example/issues/1#issuecomment-done",
    completedAt: "2026-05-13T01:00:00.000Z",
    emittedAt: "2026-05-13T01:00:01.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Valid dispatch
// ---------------------------------------------------------------------------

describe("PostDispatchVerifier: valid dispatch", () => {
  it("passes when all required fields are present and match receiver", () => {
    const v = new PostDispatchVerifier();
    const result = v.verifyDispatch(validRequest(), "parent-broker");
    assert.equal(result.passed, true);
    assert.equal(result.fields.length, 0);
    assert.ok(result.summary.includes("verified successfully"));
  });

  it("passes when receiver has no broker id (standalone broker)", () => {
    const v = new PostDispatchVerifier();
    const result = v.verifyDispatch(validRequest({ brokerOfRecordId: undefined }));
    assert.equal(result.passed, true);
  });

  it("passes with parentRoundTotal as number", () => {
    const v = new PostDispatchVerifier();
    const result = v.verifyDispatch(validRequest({ parentRoundTotal: 7 }));
    assert.equal(result.passed, true);
  });

  it("passes with parentRoundTotal as numeric string", () => {
    const v = new PostDispatchVerifier();
    const result = v.verifyDispatch(validRequest({ parentRoundTotal: "12" }));
    assert.equal(result.passed, true);
  });

  it("passes with parentRoundOrder as numeric string", () => {
    const v = new PostDispatchVerifier();
    const result = v.verifyDispatch(validRequest({ parentRoundOrder: "5" }));
    assert.equal(result.passed, true);
  });

  it("reports checkedAt as ISO string", () => {
    const v = new PostDispatchVerifier();
    const result = v.verifyDispatch(validRequest());
    assert.ok(result.checkedAt);
    assert.ok(!isNaN(Date.parse(result.checkedAt)));
  });
});

// ---------------------------------------------------------------------------
// Missing fields
// ---------------------------------------------------------------------------

describe("PostDispatchVerifier: missing fields", () => {
  it("fails when parentRoundId is empty string", () => {
    const v = new PostDispatchVerifier();
    const result = v.verifyDispatch(validRequest({ parentRoundId: "" }));
    assert.equal(result.passed, false);
    const prField = result.fields.find((f) => f.field === "parentRoundId");
    assert.equal(prField?.status, "missing");
  });

  it("fails when parentRoundId is whitespace", () => {
    const v = new PostDispatchVerifier();
    const result = v.verifyDispatch(validRequest({ parentRoundId: "   " }));
    assert.equal(result.passed, false);
  });

  it("fails when originBrokerId is empty", () => {
    const v = new PostDispatchVerifier();
    const result = v.verifyDispatch(validRequest({ originBrokerId: "" }));
    assert.equal(result.passed, false);
    const obField = result.fields.find((f) => f.field === "originBrokerId");
    assert.equal(obField?.status, "missing");
  });

  it("reports two failures when both parentRoundId and originBrokerId are missing", () => {
    const v = new PostDispatchVerifier();
    const result = v.verifyDispatch(validRequest({ parentRoundId: "", originBrokerId: "" }));
    assert.equal(result.passed, false);
    const nonValid = result.fields.filter((f) => f.status !== "valid");
    assert.equal(nonValid.length, 2);
  });
});

// ---------------------------------------------------------------------------
// Mismatched fields
// ---------------------------------------------------------------------------

describe("PostDispatchVerifier: mismatched fields", () => {
  it("fails when originBrokerId equals receiver broker id", () => {
    const v = new PostDispatchVerifier();
    const result = v.verifyDispatch(
      validRequest({ originBrokerId: "parent-broker" }),
      "parent-broker",
    );
    assert.equal(result.passed, false);
    const obField = result.fields.find((f) => f.field === "originBrokerId");
    assert.equal(obField?.status, "mismatched");
    assert.ok(obField?.detail?.includes("must not equal"));
  });

  it("fails when brokerOfRecordId does not match receiver", () => {
    const v = new PostDispatchVerifier();
    const result = v.verifyDispatch(
      validRequest({ brokerOfRecordId: "other-parent" }),
      "parent-broker",
    );
    assert.equal(result.passed, false);
    const borField = result.fields.find((f) => f.field === "brokerOfRecordId");
    assert.equal(borField?.status, "mismatched");
    assert.ok(borField?.detail?.includes("must match the receiving broker"));
  });

  it("fails when parentRoundTotal is missing", () => {
    const v = new PostDispatchVerifier();
    const result = v.verifyDispatch(validRequest({ parentRoundTotal: undefined }));
    assert.equal(result.passed, false);
    const prtField = result.fields.find((f) => f.field === "parentRoundTotal");
    assert.equal(prtField?.status, "missing");
  });

  it("fails when parentRoundTotal is zero", () => {
    const v = new PostDispatchVerifier();
    const result = v.verifyDispatch(validRequest({ parentRoundTotal: 0 }));
    assert.equal(result.passed, false);
    const prtField = result.fields.find((f) => f.field === "parentRoundTotal");
    assert.equal(prtField?.status, "mismatched");
    assert.ok(prtField?.detail?.includes("positive integer"));
  });

  it("fails when parentRoundTotal is negative", () => {
    const v = new PostDispatchVerifier();
    const result = v.verifyDispatch(validRequest({ parentRoundTotal: -5 }));
    assert.equal(result.passed, false);
  });

  it("fails when parentRoundTotal is a non-numeric string", () => {
    const v = new PostDispatchVerifier();
    const result = v.verifyDispatch(validRequest({ parentRoundTotal: "abc" }));
    assert.equal(result.passed, false);
  });

  it("fails when parentRoundOrder is missing", () => {
    const v = new PostDispatchVerifier();
    const result = v.verifyDispatch(validRequest({ parentRoundOrder: undefined }));
    assert.equal(result.passed, false);
    const orderField = result.fields.find((f) => f.field === "parentRoundOrder");
    assert.equal(orderField?.status, "missing");
  });

  it("fails when parentRoundOrder exceeds parentRoundTotal", () => {
    const v = new PostDispatchVerifier();
    const result = v.verifyDispatch(validRequest({ parentRoundTotal: 7, parentRoundOrder: 8 }));
    assert.equal(result.passed, false);
    const orderField = result.fields.find((f) => f.field === "parentRoundOrder");
    assert.equal(orderField?.status, "mismatched");
  });
});

// ---------------------------------------------------------------------------
// CrossBrokerHandoff verification
// ---------------------------------------------------------------------------

describe("PostDispatchVerifier: crossBrokerHandoff", () => {
  it("passes for valid handoff in payload", () => {
    const v = new PostDispatchVerifier();
    const fields = v.verifyCrossBrokerHandoff({
      taskId: "child-task-1",
      status: "succeeded",
      createdAt: "2026-05-13T01:00:00.000Z",
      updatedAt: "2026-05-13T01:00:00.000Z",
      completedAt: "2026-05-13T01:00:00.000Z",
      crossBrokerHandoff: {
        parentRoundId: "round-parent",
        originBrokerId: "parent-broker",
        handoffBrokerId: "child-broker-a",
        originTaskId: "child-task-1",
      },
    });
    const nonValid = fields.filter((f) => f.status !== "valid");
    assert.equal(nonValid.length, 0);
  });

  it("fails when crossBrokerHandoff is absent", () => {
    const v = new PostDispatchVerifier();
    const fields = v.verifyCrossBrokerHandoff({
      taskId: "child-task-1",
      status: "succeeded",
      createdAt: "2026-05-13T01:00:00.000Z",
      updatedAt: "2026-05-13T01:00:00.000Z",
    });
    const missing = fields.find((f) => f.field === "crossBrokerHandoff");
    assert.equal(missing?.status, "missing");
  });

  it("handoff with empty parentRoundId is missing", () => {
    const v = new PostDispatchVerifier();
    const fields = v.verifyCrossBrokerHandoff({
      taskId: "child-task-1",
      status: "succeeded",
      createdAt: "2026-05-13T01:00:00.000Z",
      updatedAt: "2026-05-13T01:00:00.000Z",
      completedAt: "2026-05-13T01:00:00.000Z",
      crossBrokerHandoff: {
        parentRoundId: "",
        originBrokerId: "parent-broker",
      },
    });
    const prField = fields.find((f) => f.field === "crossBrokerHandoff.parentRoundId");
    assert.equal(prField?.status, "missing");
  });

  it("handoff with empty originBrokerId is missing", () => {
    const v = new PostDispatchVerifier();
    const fields = v.verifyCrossBrokerHandoff({
      taskId: "child-task-1",
      status: "succeeded",
      createdAt: "2026-05-13T01:00:00.000Z",
      updatedAt: "2026-05-13T01:00:00.000Z",
      completedAt: "2026-05-13T01:00:00.000Z",
      crossBrokerHandoff: {
        parentRoundId: "round-parent",
        originBrokerId: "",
      },
    });
    const obField = fields.find((f) => f.field === "crossBrokerHandoff.originBrokerId");
    assert.equal(obField?.status, "missing");
  });

  it("detects invalid handoffBrokerId (empty string)", () => {
    const v = new PostDispatchVerifier();
    const fields = v.verifyCrossBrokerHandoff({
      taskId: "child-task-1",
      status: "succeeded",
      createdAt: "2026-05-13T01:00:00.000Z",
      updatedAt: "2026-05-13T01:00:00.000Z",
      completedAt: "2026-05-13T01:00:00.000Z",
      crossBrokerHandoff: {
        parentRoundId: "round-parent",
        originBrokerId: "parent-broker",
        handoffBrokerId: "",
      },
    });
    const hbField = fields.find((f) => f.field === "crossBrokerHandoff.handoffBrokerId");
    assert.equal(hbField?.status, "mismatched");
  });

  it("detects notification ownership violations", () => {
    const v = new PostDispatchVerifier();
    const fields = v.verifyCrossBrokerHandoff({
      taskId: "child-task-1",
      status: "succeeded",
      createdAt: "2026-05-13T01:00:00.000Z",
      updatedAt: "2026-05-13T01:00:00.000Z",
      completedAt: "2026-05-13T01:00:00.000Z",
      crossBrokerHandoff: {
        parentRoundId: "round-parent",
        originBrokerId: "parent-broker",
      },
      notificationOwnership: {
        ownerBrokerId: "parent-broker",
        scope: "parent-broker-only",
        providerSendPermittedByProjection: true as false,
        terminalAckPermittedByProjection: true as false,
        reason: "test violation",
      },
    });
    const sendField = fields.find((f) => f.field === "notificationOwnership.providerSendPermittedByProjection");
    assert.equal(sendField?.status, "mismatched");
    const ackField = fields.find((f) => f.field === "notificationOwnership.terminalAckPermittedByProjection");
    assert.equal(ackField?.status, "mismatched");
  });

  it("handles handoff with childWorkerId", () => {
    const v = new PostDispatchVerifier();
    const fields = v.verifyCrossBrokerHandoff({
      taskId: "child-task-1",
      status: "succeeded",
      createdAt: "2026-05-13T01:00:00.000Z",
      updatedAt: "2026-05-13T01:00:00.000Z",
      completedAt: "2026-05-13T01:00:00.000Z",
      crossBrokerHandoff: {
        parentRoundId: "round-parent",
        originBrokerId: "parent-broker",
        handoffBrokerId: "gwakga",
        originTaskId: "child-task-1",
        childWorkerId: "dungae",
      },
    });
    const nonValid = fields.filter((f) => f.status !== "valid");
    assert.equal(nonValid.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Snapshot/check flow
// ---------------------------------------------------------------------------

describe("PostDispatchVerifier: snapshot/check flow", () => {
  it("captures and checks a valid snapshot as consistent", () => {
    const tick = clockProvider();
    const v = new PostDispatchVerifier(undefined, { now: tick.now });

    v.snapshotParentMetadata("round-parent", "child-broker-a", 7, 1);
    tick.advanceMs(35_000); // 35 s — within the 30–60 s window

    const result = v.checkSnapshot("round-parent", {
      parentRoundId: "round-parent",
      originBrokerId: "child-broker-a",
      parentRoundTotal: 7,
      parentRoundOrder: 1,
    });
    assert.equal(result.verdict, "consistent");
    assert.equal(result.elapsedMs, 35_000);
    assert.equal(result.fields.length, 0);
  });

  it("detects inconsistent snapshot with wrong originBrokerId", () => {
    const tick = clockProvider();
    const v = new PostDispatchVerifier(undefined, { now: tick.now });

    v.snapshotParentMetadata("round-parent", "child-broker-a", 7);
    tick.advanceMs(40_000);

    const result = v.checkSnapshot("round-parent", {
      originBrokerId: "wrong-broker",
    });
    assert.equal(result.verdict, "inconsistent");
    const obField = result.fields.find((f) => f.field === "originBrokerId");
    assert.equal(obField?.status, "mismatched");
    assert.equal(obField?.expected, "wrong-broker");
    assert.equal(obField?.actual, "child-broker-a");
  });

  it("detects inconsistent snapshot with wrong parentRoundTotal", () => {
    const tick = clockProvider();
    const v = new PostDispatchVerifier(undefined, { now: tick.now });

    v.snapshotParentMetadata("round-parent", "child-broker-a", 7);
    tick.advanceMs(45_000);

    const result = v.checkSnapshot("round-parent", {
      parentRoundTotal: 14,
    });
    assert.equal(result.verdict, "inconsistent");
    const prtField = result.fields.find((f) => f.field === "parentRoundTotal");
    assert.equal(prtField?.status, "mismatched");
    assert.equal(prtField?.expected, 14);
    assert.equal(prtField?.actual, 7);
  });

  it("reports missing snapshot as inconsistent", () => {
    const v = new PostDispatchVerifier();
    const result = v.checkSnapshot("non-existent-round", {
      parentRoundId: "non-existent-round",
    });
    assert.equal(result.verdict, "inconsistent");
    const snapField = result.fields.find((f) => f.field === "snapshot");
    assert.equal(snapField?.status, "missing");
  });

  it("reports expired snapshot beyond max window (60 s)", () => {
    const tick = clockProvider();
    const v = new PostDispatchVerifier(undefined, { now: tick.now });

    v.snapshotParentMetadata("round-parent", "child-broker-a", 7);
    tick.advanceMs(61_000); // 61 s — beyond 60 s window

    const result = v.checkSnapshot("round-parent", {
      parentRoundId: "round-parent",
      originBrokerId: "child-broker-a",
    });
    assert.equal(result.verdict, "expired");
    const timingField = result.fields.find((f) => f.field === "snapshot.timing");
    assert.ok(timingField);
    assert.ok(timingField?.detail?.includes("outside"));
  });

  it("passes check right at the max window boundary (60 s)", () => {
    const tick = clockProvider();
    const v = new PostDispatchVerifier(undefined, { now: tick.now });

    v.snapshotParentMetadata("round-parent", "child-broker-a", 7);
    tick.advanceMs(60_000); // exactly 60 s — boundary

    const result = v.checkSnapshot("round-parent", {
      parentRoundId: "round-parent",
      originBrokerId: "child-broker-a",
    });
    assert.equal(result.verdict, "consistent");
  });

  it("snapshot is stored and retrievable from the store", () => {
    const store = new InMemorySnapshotStore();
    const v = new PostDispatchVerifier(store);

    v.snapshotParentMetadata("round-x", "broker-y");
    const retrieved = store.get("round-x");
    assert.ok(retrieved);
    assert.equal(retrieved.parentRoundId, "round-x");
    assert.equal(retrieved.originBrokerId, "broker-y");
  });

  it("snapshot is not retrievable after delete from store", () => {
    const store = new InMemorySnapshotStore();
    const v = new PostDispatchVerifier(store);

    v.snapshotParentMetadata("round-x", "broker-y");
    store.delete("round-x");
    assert.equal(store.get("round-x"), undefined);
  });
});

// ---------------------------------------------------------------------------
// verifyDispatchWithSnapshot convenience
// ---------------------------------------------------------------------------

describe("PostDispatchVerifier: verifyDispatchWithSnapshot", () => {
  it("returns combined dispatch result, snapshot, and handoff fields", () => {
    const v = new PostDispatchVerifier();
    const result = v.verifyDispatchWithSnapshot(
      validRequest(),
      "parent-broker",
      7,
    );

    assert.equal(result.dispatchResult.passed, true);
    assert.equal(result.snapshot.parentRoundId, "round-parent");
    assert.equal(result.snapshot.originBrokerId, "child-broker-a");
    assert.equal(result.snapshot.parentRoundTotal, 7);
    assert.ok(result.snapshot.capturedAt);
    assert.ok(result.snapshot.snapshotWindowMs >= 30000);

    const nonValidHandoff = result.handoffFields.filter((f) => f.status !== "valid");
    assert.equal(nonValidHandoff.length, 0);
  });

  it("captured snapshot is stored and retrievable", () => {
    const store = new InMemorySnapshotStore();
    const v = new PostDispatchVerifier(store);

    v.verifyDispatchWithSnapshot(validRequest(), "parent-broker");
    const retrieved = store.get("round-parent");
    assert.ok(retrieved);
    assert.equal(retrieved?.parentRoundId, "round-parent");
    assert.equal(retrieved?.originBrokerId, "child-broker-a");
  });

  it("handoff fields reflect missing crossBrokerHandoff when task id absent", () => {
    const v = new PostDispatchVerifier();
    const result = v.verifyDispatchWithSnapshot(
      validRequest({ childTaskId: undefined }),
      "parent-broker",
    );
    // The handoff is still built with synthetic task id; fields should still be valid
    const nonValid = result.handoffFields.filter((f) => f.status !== "valid");
    assert.equal(nonValid.length, 0);
  });
});

// ---------------------------------------------------------------------------
// InMemorySnapshotStore
// ---------------------------------------------------------------------------

describe("InMemorySnapshotStore", () => {
  it("stores and retrieves snapshots", () => {
    const store = new InMemorySnapshotStore();
    const snap: ParentMetadataSnapshot = {
      parentRoundId: "round-1",
      originBrokerId: "broker-a",
      capturedAt: "2026-05-13T01:00:00.000Z",
      snapshotWindowMs: 60000,
    };
    store.set(snap);
    assert.equal(store.get("round-1")?.originBrokerId, "broker-a");
    assert.equal(store.get("round-2"), undefined);
  });

  it("overwrites existing snapshot for same parentRoundId", () => {
    const store = new InMemorySnapshotStore();
    store.set({
      parentRoundId: "round-1",
      originBrokerId: "broker-a",
      capturedAt: "2026-05-13T01:00:00.000Z",
      snapshotWindowMs: 60000,
    });
    store.set({
      parentRoundId: "round-1",
      originBrokerId: "broker-b",
      capturedAt: "2026-05-13T02:00:00.000Z",
      snapshotWindowMs: 60000,
    });
    assert.equal(store.get("round-1")?.originBrokerId, "broker-b");
  });

  it("returns all entries", () => {
    const store = new InMemorySnapshotStore();
    store.set({
      parentRoundId: "round-1",
      originBrokerId: "broker-a",
      capturedAt: "2026-05-13T01:00:00.000Z",
      snapshotWindowMs: 60000,
    });
    store.set({
      parentRoundId: "round-2",
      originBrokerId: "broker-b",
      capturedAt: "2026-05-13T02:00:00.000Z",
      snapshotWindowMs: 60000,
    });
    const entries = store.entries();
    assert.equal(entries.length, 2);
    assert.deepEqual(entries.map(([k]) => k).sort(), ["round-1", "round-2"]);
  });
});

// ---------------------------------------------------------------------------
// Clock helper
// ---------------------------------------------------------------------------

function clockProvider(base = "2026-05-13T01:00:00.000Z") {
  let now = new Date(base);
  return {
    now: (): Date => new Date(now),
    advanceMs: (ms: number): void => {
      now = new Date(now.getTime() + ms);
    },
  };
}
