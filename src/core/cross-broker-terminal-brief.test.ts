import test from "node:test";
import assert from "node:assert/strict";

import { InMemoryA2ABroker } from "./broker.js";
import { emptySnapshot, type BrokerSnapshot, type BrokerStateStore } from "./store.js";

function registerWorker(broker: InMemoryA2ABroker, nodeId = "worker-child"): void {
  broker.registerWorker({
    nodeId,
    role: "analyst",
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: false,
      canPromoteLive: false,
      workspaceIds: ["test"],
      environments: ["research"],
    },
  });
}

function createParentRound(broker: InMemoryA2ABroker, id = "round-parent"): void {
  registerWorker(broker);
  broker.createTask({
    id,
    intent: "chat",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: "worker-child", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-child",
    message: `parent ${id}`,
  });
}

function projection(overrides: Partial<Parameters<InMemoryA2ABroker["ingestCrossBrokerTerminalBriefProjection"]>[0]> = {}) {
  return {
    parentRoundId: "round-parent",
    originBrokerId: "child-broker-a",
    brokerOfRecordId: "parent-broker",
    childTaskId: "child-task-1",
    status: "succeeded" as const,
    summary: "child completed safely",
    taskBrief: "minimal safe patch",
    evidenceUrl: "https://github.com/acme/example/issues/1#issuecomment-done",
    completedAt: "2026-05-13T01:00:00.000Z",
    emittedAt: "2026-05-13T01:00:01.000Z",
    ...overrides,
  };
}

test("cross-broker Terminal Brief ingest is idempotent by parentRoundId/originBrokerId", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "parent-broker" });
  createParentRound(broker);

  const first = broker.ingestCrossBrokerTerminalBriefProjection(projection());
  assert.equal(first.accepted, true);
  assert.equal(first.replayed, false);
  assert.equal(first.ack.terminalAck, false);

  const replay = broker.ingestCrossBrokerTerminalBriefProjection(projection());
  assert.equal(replay.accepted, true);
  assert.equal(replay.replayed, true);
  assert.equal(replay.ack.decision, "duplicate_replay");
  assert.equal(replay.record.replayCount, 1);

  const records = broker.listCrossBrokerTerminalBriefProjections({ parentRoundId: "round-parent" });
  assert.equal(records.length, 1);
  assert.equal(records[0]?.originBrokerId, "child-broker-a");

  const terminalEvents = broker.getTerminalTaskEventOutbox().subscribe();
  assert.equal(terminalEvents.length, 1);
  assert.equal(terminalEvents[0]?.payload.taskId, "child-task-1");
  assert.equal(terminalEvents[0]?.payload.worker, "child-broker-a");
  assert.equal(terminalEvents[0]?.payload.run, "round-parent");
  assert.equal(terminalEvents[0]?.payload.status, "succeeded");
  assert.equal(terminalEvents[0]?.payload.testSummary, "child completed safely");
  assert.equal(terminalEvents[0]?.payload.doneUrl, "https://github.com/acme/example/issues/1#issuecomment-done");
  assert.deepEqual(terminalEvents[0]?.payload.crossBrokerHandoff, {
    parentRoundId: "round-parent",
    originBrokerId: "child-broker-a",
    handoffBrokerId: "parent-broker",
    originTaskId: "child-task-1",
  });
  assert.equal(terminalEvents[0]?.ackAudit?.decision, "pending");
  assert.match(terminalEvents[0]?.ackAudit?.reason ?? "", /current-session-visible/);

  broker.ingestCrossBrokerTerminalBriefProjection(projection());
  assert.equal(broker.getTerminalTaskEventOutbox().subscribe().length, 1, "duplicate projection must not duplicate parent Terminal Brief output");
});

test("cross-broker Terminal Brief ingest rejects wrong-origin packets", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "parent-broker" });
  createParentRound(broker);

  const result = broker.ingestCrossBrokerTerminalBriefProjection(projection({ brokerOfRecordId: "other-parent" }));
  assert.equal(result.accepted, false);
  assert.equal(result.ack.code, "wrong_origin");
  assert.equal(result.ack.terminalAck, false);
  assert.equal(broker.listCrossBrokerTerminalBriefProjections().length, 0);
});

test("cross-broker Terminal Brief ingest rejects missing parent rounds", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "parent-broker" });
  registerWorker(broker);

  const result = broker.ingestCrossBrokerTerminalBriefProjection(projection({ parentRoundId: "missing-round" }));
  assert.equal(result.accepted, false);
  assert.equal(result.ack.code, "missing_parent");
  assert.equal(result.ack.terminalAck, false);
});

test("cross-broker Terminal Brief ingest rejects stale replay over a newer aggregate", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "parent-broker" });
  createParentRound(broker);

  const newer = broker.ingestCrossBrokerTerminalBriefProjection(projection({
    summary: "newer child terminal state",
    completedAt: "2026-05-13T02:00:00.000Z",
    emittedAt: "2026-05-13T02:00:01.000Z",
  }));
  assert.equal(newer.accepted, true);

  const stale = broker.ingestCrossBrokerTerminalBriefProjection(projection({
    summary: "stale overwrite attempt",
    completedAt: "2026-05-13T01:30:00.000Z",
    emittedAt: "2026-05-13T01:30:01.000Z",
  }));
  assert.equal(stale.accepted, false);
  assert.equal(stale.ack.code, "stale_replay");

  const stored = broker.getCrossBrokerTerminalBriefProjection("round-parent", "child-broker-a");
  assert.equal(stored?.summary, "newer child terminal state");
});

test("cross-broker Terminal Brief projection carries parent round denominator into outbox progress", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "parent-broker" });
  createParentRound(broker);

  const knownTotal = broker.ingestCrossBrokerTerminalBriefProjection(projection({
    parentRoundTotal: "3",
  }));
  assert.equal(knownTotal.accepted, true);
  assert.equal(knownTotal.record.parentRoundTotal, 3);

  const unknownTotal = broker.ingestCrossBrokerTerminalBriefProjection(projection({
    originBrokerId: "child-broker-b",
    childTaskId: "child-task-2",
    completedAt: "2026-05-13T01:05:00.000Z",
    emittedAt: "2026-05-13T01:05:01.000Z",
  }));
  assert.equal(unknownTotal.accepted, true);
  assert.equal(unknownTotal.record.parentRoundTotal, undefined);

  const terminalEvents = broker.getTerminalTaskEventOutbox().subscribe();
  assert.equal(terminalEvents.length, 2);
  assert.equal(terminalEvents[0]?.payload.run, "round-parent");
  assert.equal(terminalEvents[0]?.payload.parentRoundTotal, 3);
  assert.equal(terminalEvents[0]?.payload.parentRoundProgress, 1);
  assert.equal(terminalEvents[1]?.payload.run, "round-parent");
  assert.equal(terminalEvents[1]?.payload.parentRoundTotal, undefined);
  assert.equal(terminalEvents[1]?.payload.parentRoundProgress, undefined);
});

test("cross-broker Terminal Brief projection redacts unsafe content and fails closed for ACKs", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "parent-broker" });
  createParentRound(broker);

  const result = broker.ingestCrossBrokerTerminalBriefProjection(projection({
    summary: "done token=fake-token-placeholder at /work/repo/raw-session.log",
    taskBrief: "secret=abc123 /home/alice/private",
    evidenceUrl: "file:///work/repo/private.log",
  }));
  assert.equal(result.accepted, true);
  assert.equal(result.ack.terminalAck, false);
  assert.equal(result.record.summary, "done token=[redacted] at [path]");
  assert.equal(result.record.taskBrief, "secret=[redacted] [path]");
  assert.equal(result.record.evidenceUrl, undefined);
  assert.doesNotMatch(JSON.stringify(result.record), /fake-token-placeholder|\/work\/repo|\/home\/alice|file:\/\//);

  const forbiddenAck = broker.ingestCrossBrokerTerminalBriefProjection(projection({
    originBrokerId: "child-broker-b",
    terminalAck: true,
  }));
  assert.equal(forbiddenAck.accepted, false);
  assert.equal(forbiddenAck.ack.code, "terminal_ack_forbidden");
  assert.equal(forbiddenAck.ack.terminalAck, false);
  assert.equal(broker.getCrossBrokerTerminalBriefProjection("round-parent", "child-broker-b"), undefined);
});

test("cross-broker Terminal Brief projections survive broker snapshot persistence", () => {
  let snapshot: BrokerSnapshot = emptySnapshot();
  const store: BrokerStateStore = {
    load: () => snapshot,
    save: (next) => {
      snapshot = structuredClone(next);
    },
  };

  const broker = new InMemoryA2ABroker(store, undefined, { brokerId: "parent-broker" });
  createParentRound(broker);
  broker.ingestCrossBrokerTerminalBriefProjection(projection());

  const restored = new InMemoryA2ABroker(undefined, snapshot, { brokerId: "parent-broker" });
  assert.equal(restored.getCrossBrokerTerminalBriefProjection("round-parent", "child-broker-a")?.summary, "child completed safely");
});
