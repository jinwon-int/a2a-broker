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
    parentRoundTotal: "5",
    parentRoundOrder: "1",
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
    originBrokerId: "parent-broker",
    handoffBrokerId: "child-broker-a",
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
    originBrokerId: "gwakga",
    brokerOfRecordId: "parent-broker",
    childWorkerId: "dungae",
    parentRoundTotal: "7",
    parentRoundOrder: "5",
  }));
  assert.equal(knownTotal.accepted, true);
  assert.equal(knownTotal.record.parentRoundTotal, 7);
  assert.equal(knownTotal.record.childWorkerId, "dungae");

  const secondTotal = broker.ingestCrossBrokerTerminalBriefProjection(projection({
    originBrokerId: "child-broker-b",
    childTaskId: "child-task-2",
    childWorkerId: "sogyo",
    parentRoundTotal: "3",
    parentRoundOrder: "2",
    completedAt: "2026-05-13T01:05:00.000Z",
    emittedAt: "2026-05-13T01:05:01.000Z",
  }));
  assert.equal(secondTotal.accepted, true);
  assert.equal(secondTotal.record.parentRoundTotal, 3);

  const terminalEvents = broker.getTerminalTaskEventOutbox().subscribe();
  assert.equal(terminalEvents.length, 2);
  assert.equal(terminalEvents[0]?.payload.run, "round-parent");
  assert.equal(terminalEvents[0]?.payload.worker, "dungae");
  assert.equal(terminalEvents[0]?.payload.parentRoundTotal, 7);
  assert.equal(terminalEvents[0]?.payload.parentRoundProgress, 5);
  assert.equal(terminalEvents[0]?.payload.terminalBriefTitle, "A2A Terminal Brief 완료: dungae(5/7)");
  assert.deepEqual(terminalEvents[0]?.payload.crossBrokerHandoff, {
    parentRoundId: "round-parent",
    originBrokerId: "parent-broker",
    handoffBrokerId: "gwakga",
    originTaskId: "child-task-1",
    childWorkerId: "dungae",
  });
  assert.deepEqual(terminalEvents[0]?.payload.notificationOwnership, {
    ownerBrokerId: "parent-broker",
    scope: "parent-broker-only",
    providerSendPermittedByProjection: false,
    terminalAckPermittedByProjection: false,
    reason: "cross-broker projections are parent-broker aggregation evidence only; child/handoff brokers do not notify or ACK",
  });
  assert.equal(terminalEvents[1]?.payload.run, "round-parent");
  assert.equal(terminalEvents[1]?.payload.worker, "sogyo");
  assert.equal(terminalEvents[1]?.payload.parentRoundTotal, 3);
  assert.equal(terminalEvents[1]?.payload.parentRoundProgress, 2);
  assert.equal(terminalEvents[1]?.payload.terminalBriefTitle, "A2A Terminal Brief 완료: sogyo(2/3)");
});

test("Seoseo-origin parent keeps distinct Gwakga handoff children and explicit order", () => {
  const parentRoundId = "a2a-r13-terminal-brief-realround-20260514T013556Z";
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "seoseo" });
  createParentRound(broker, parentRoundId);

  const dungae = broker.ingestCrossBrokerTerminalBriefProjection(projection({
    parentRoundId,
    originBrokerId: "gwakga",
    brokerOfRecordId: "seoseo",
    childTaskId: parentRoundId + "-05-dungae",
    childWorkerId: "dungae",
    parentRoundTotal: 7,
    parentRoundOrder: 5,
    summary: "dungae completed Gwakga handoff evidence for Seoseo parent",
  }));
  const jingun = broker.ingestCrossBrokerTerminalBriefProjection(projection({
    parentRoundId,
    originBrokerId: "gwakga",
    brokerOfRecordId: "seoseo",
    childTaskId: parentRoundId + "-06-jingun",
    childWorkerId: "jingun",
    parentRoundTotal: 7,
    parentRoundOrder: 6,
    completedAt: "2026-05-13T01:05:00.000Z",
    emittedAt: "2026-05-13T01:05:01.000Z",
  }));

  assert.equal(dungae.accepted, true);
  assert.equal(jingun.accepted, true);

  const records = broker.listCrossBrokerTerminalBriefProjections({ parentRoundId, originBrokerId: "gwakga" });
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((record) => record.childWorkerId), ["dungae", "jingun"]);

  const terminalEvents = broker.getTerminalTaskEventOutbox().subscribe();
  assert.equal(terminalEvents.length, 2);
  assert.equal(terminalEvents[0]?.payload.run, parentRoundId);
  assert.equal(terminalEvents[0]?.payload.worker, "dungae");
  assert.equal(terminalEvents[0]?.payload.parentRoundProgress, 5);
  assert.equal(terminalEvents[0]?.payload.parentRoundTotal, 7);
  assert.equal(terminalEvents[0]?.payload.terminalBriefTitle, "A2A Terminal Brief 완료: dungae(5/7)");
  assert.deepEqual(terminalEvents[0]?.payload.notificationOwnership, {
    ownerBrokerId: "seoseo",
    scope: "parent-broker-only",
    providerSendPermittedByProjection: false,
    terminalAckPermittedByProjection: false,
    reason: "cross-broker projections are parent-broker aggregation evidence only; child/handoff brokers do not notify or ACK",
  });
  assert.equal(terminalEvents[1]?.payload.worker, "jingun");
  assert.equal(terminalEvents[1]?.payload.parentRoundProgress, 6);
  assert.equal(terminalEvents[1]?.payload.terminalBriefTitle, "A2A Terminal Brief 완료: jingun(6/7)");
});

test("cross-broker Terminal Brief projection is symmetric for Gwakga-owned parent rounds", () => {
  const parentRoundId = "a2a-r12-gwakga-origin-round";
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "gwakga" });
  createParentRound(broker, parentRoundId);

  const result = broker.ingestCrossBrokerTerminalBriefProjection(projection({
    parentRoundId,
    originBrokerId: "seoseo",
    brokerOfRecordId: "gwakga",
    childTaskId: "seoseo-handoff-child",
    childWorkerId: "dungae",
    parentRoundTotal: 7,
    parentRoundOrder: 5,
    summary: "Seoseo handoff child completed for the Gwakga aggregate",
  }));

  assert.equal(result.accepted, true);
  assert.equal(result.record.brokerOfRecordId, "gwakga");
  assert.equal(result.record.originBrokerId, "seoseo");
  assert.equal(result.ack.terminalAck, false);

  const records = broker.listCrossBrokerTerminalBriefProjections({ parentRoundId, originBrokerId: "seoseo" });
  assert.equal(records.length, 1);
  assert.equal(records[0]?.brokerOfRecordId, "gwakga");

  const [terminalEvent] = broker.getTerminalTaskEventOutbox().subscribe();
  assert.equal(terminalEvent?.payload.run, parentRoundId);
  assert.equal(terminalEvent?.payload.worker, "dungae");
  assert.equal(terminalEvent?.payload.parentRoundTotal, 7);
  assert.equal(terminalEvent?.payload.parentRoundProgress, 5);
  assert.equal(terminalEvent?.payload.terminalBriefTitle, "A2A Terminal Brief 완료: dungae(5/7)");
  assert.deepEqual(terminalEvent?.payload.crossBrokerHandoff, {
    parentRoundId,
    originBrokerId: "gwakga",
    handoffBrokerId: "seoseo",
    originTaskId: "seoseo-handoff-child",
    childWorkerId: "dungae",
  });
  assert.deepEqual(terminalEvent?.payload.notificationOwnership, {
    ownerBrokerId: "gwakga",
    scope: "parent-broker-only",
    providerSendPermittedByProjection: false,
    terminalAckPermittedByProjection: false,
    reason: "cross-broker projections are parent-broker aggregation evidence only; child/handoff brokers do not notify or ACK",
  });
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

test("Terminal Brief dispatch guard rejects projection with missing parentRoundId", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "parent-broker" });
  createParentRound(broker);

  // empty parentRoundId is caught by normalizeRequest as bad_request before
  // the dispatch metadata guard runs; this validates the fail-closed path.
  const result = broker.ingestCrossBrokerTerminalBriefProjection(projection({ parentRoundId: "" }));
  assert.equal(result.accepted, false);
  assert.equal(result.ack.code, "bad_request");
  assert.match(result.ack.reason, /parentRoundId/);
});

test("Terminal Brief dispatch guard rejects projection with missing originBrokerId", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "parent-broker" });
  createParentRound(broker);

  // empty originBrokerId is caught by normalizeRequest as bad_request before
  // the dispatch metadata guard runs; this validates the fail-closed path.
  const result = broker.ingestCrossBrokerTerminalBriefProjection(projection({ originBrokerId: "" }));
  assert.equal(result.accepted, false);
  assert.equal(result.ack.code, "bad_request");
  assert.match(result.ack.reason, /originBrokerId/);
});

test("Terminal Brief dispatch guard rejects projection with missing parentRoundTotal", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "parent-broker" });
  createParentRound(broker);

  const result = broker.ingestCrossBrokerTerminalBriefProjection(projection({ parentRoundTotal: undefined }));
  assert.equal(result.accepted, false);
  assert.equal(result.ack.code, "missing_dispatch_metadata");
  assert.match(result.ack.reason, /parentRoundTotal/);
});

test("Terminal Brief dispatch guard rejects projection with non-positive parentRoundTotal", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "parent-broker" });
  createParentRound(broker);

  const result = broker.ingestCrossBrokerTerminalBriefProjection(projection({ parentRoundTotal: "0" }));
  assert.equal(result.accepted, false);
  assert.equal(result.ack.code, "missing_dispatch_metadata");
  assert.match(result.ack.reason, /parentRoundTotal/);
});

test("Terminal Brief dispatch guard rejects projection with missing parentRoundOrder", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "parent-broker" });
  createParentRound(broker);

  const result = broker.ingestCrossBrokerTerminalBriefProjection(projection({ parentRoundOrder: undefined }));
  assert.equal(result.accepted, false);
  assert.equal(result.ack.code, "missing_dispatch_metadata");
  assert.match(result.ack.reason, /parentRoundOrder/);
});

test("Terminal Brief dispatch guard rejects projection with parentRoundOrder beyond total", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "parent-broker" });
  createParentRound(broker);

  const result = broker.ingestCrossBrokerTerminalBriefProjection(projection({ parentRoundTotal: "7", parentRoundOrder: "8" }));
  assert.equal(result.accepted, false);
  assert.equal(result.ack.code, "missing_dispatch_metadata");
  assert.match(result.ack.reason, /parentRoundOrder/);
});

test("Terminal Brief dispatch guard rejects projection lacking brokerOfRecordId for crossBrokerHandoff", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "parent-broker" });
  createParentRound(broker);

  const result = broker.ingestCrossBrokerTerminalBriefProjection(projection({ brokerOfRecordId: undefined }));
  assert.equal(result.accepted, false);
  assert.equal(result.ack.code, "missing_dispatch_metadata");
  assert.match(result.ack.reason, /crossBrokerHandoff/);
});

test("Terminal Brief dispatch guard accepts valid seoseo-origin projection with bangtong compact title", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "parent-broker" });
  createParentRound(broker);

  const result = broker.ingestCrossBrokerTerminalBriefProjection(projection({
    originBrokerId: "seoseo",
    childWorkerId: "bangtong",
    parentRoundTotal: "7",
  }));
  assert.equal(result.accepted, true);
  assert.equal(result.replayed, false);
  assert.equal(result.record.originBrokerId, "seoseo");
  assert.equal(result.record.parentRoundTotal, 7);
  assert.equal(result.record.childWorkerId, "bangtong");

  const events = broker.getTerminalTaskEventOutbox().subscribe();
  assert.equal(events.length, 1);
  assert.equal(events[0]?.payload.run, "round-parent");
  assert.equal(events[0]?.payload.worker, "bangtong");
  assert.equal(events[0]?.payload.parentRoundTotal, 7);
  assert.equal(events[0]?.payload.parentRoundProgress, 1);
  assert.equal(events[0]?.payload.terminalBriefTitle, "A2A Terminal Brief 완료: bangtong(1/7)");
  assert.deepEqual(events[0]?.payload.crossBrokerHandoff, {
    parentRoundId: "round-parent",
    originBrokerId: "parent-broker",
    handoffBrokerId: "seoseo",
    originTaskId: "child-task-1",
    childWorkerId: "bangtong",
  });
  assert.deepEqual(events[0]?.payload.notificationOwnership, {
    ownerBrokerId: "parent-broker",
    scope: "parent-broker-only",
    providerSendPermittedByProjection: false,
    terminalAckPermittedByProjection: false,
    reason: "cross-broker projections are parent-broker aggregation evidence only; child/handoff brokers do not notify or ACK",
  });
});

test("Terminal Brief dispatch guard accepts valid gwakga-origin projection with dungae compact title", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "parent-broker" });
  createParentRound(broker);

  const result = broker.ingestCrossBrokerTerminalBriefProjection(projection({
    originBrokerId: "gwakga",
    childWorkerId: "dungae",
    parentRoundTotal: "10",
  }));
  assert.equal(result.accepted, true);
  assert.equal(result.replayed, false);
  assert.equal(result.record.originBrokerId, "gwakga");
  assert.equal(result.record.parentRoundTotal, 10);
  assert.equal(result.record.childWorkerId, "dungae");

  const events = broker.getTerminalTaskEventOutbox().subscribe();
  assert.equal(events.length, 1);
  assert.equal(events[0]?.payload.run, "round-parent");
  assert.equal(events[0]?.payload.worker, "dungae");
  assert.equal(events[0]?.payload.parentRoundTotal, 10);
  assert.equal(events[0]?.payload.parentRoundProgress, 1);
  assert.equal(events[0]?.payload.terminalBriefTitle, "A2A Terminal Brief 완료: dungae(1/10)");
  assert.deepEqual(events[0]?.payload.crossBrokerHandoff, {
    parentRoundId: "round-parent",
    originBrokerId: "parent-broker",
    handoffBrokerId: "gwakga",
    originTaskId: "child-task-1",
    childWorkerId: "dungae",
  });
  assert.deepEqual(events[0]?.payload.notificationOwnership, {
    ownerBrokerId: "parent-broker",
    scope: "parent-broker-only",
    providerSendPermittedByProjection: false,
    terminalAckPermittedByProjection: false,
    reason: "cross-broker projections are parent-broker aggregation evidence only; child/handoff brokers do not notify or ACK",
  });
});


test("bangtong compact Terminal Brief emitted on every terminal status: succeeded", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "parent-broker" });
  createParentRound(broker);

  const result = broker.ingestCrossBrokerTerminalBriefProjection(projection({
    originBrokerId: "seoseo",
    childTaskId: "bangtong-task-succeeded",
    childWorkerId: "bangtong",
    parentRoundTotal: "7",
    status: "succeeded",
    summary: "bangtong succeeded",
    completedAt: "2026-05-14T01:01:00.000Z",
    emittedAt: "2026-05-14T01:01:01.000Z",
  }));
  assert.equal(result.accepted, true);

  const events = broker.getTerminalTaskEventOutbox().subscribe();
  const event = events.find(e => e.payload.taskId === "bangtong-task-succeeded");
  assert.ok(event, "bangtong succeeded event must exist");
  assert.equal(event.payload.terminalBriefTitle, "A2A Terminal Brief 완료: bangtong(1/7)");
  assert.equal(event.payload.status, "succeeded");
});

test("bangtong compact Terminal Brief emitted on every terminal status: failed", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "parent-broker" });
  createParentRound(broker);

  const result = broker.ingestCrossBrokerTerminalBriefProjection(projection({
    originBrokerId: "seoseo",
    childTaskId: "bangtong-task-failed",
    childWorkerId: "bangtong",
    parentRoundTotal: "7",
    status: "failed",
    summary: "bangtong failed",
    completedAt: "2026-05-14T01:02:00.000Z",
    emittedAt: "2026-05-14T01:02:01.000Z",
  }));
  assert.equal(result.accepted, true);

  const events = broker.getTerminalTaskEventOutbox().subscribe();
  const event = events.find(e => e.payload.taskId === "bangtong-task-failed");
  assert.ok(event, "bangtong failed event must exist");
  assert.equal(event.payload.terminalBriefTitle, "A2A Terminal Brief 완료: bangtong(1/7)");
  assert.equal(event.payload.status, "failed");
});

test("bangtong compact Terminal Brief emitted on every terminal status: canceled", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "parent-broker" });
  createParentRound(broker);

  const result = broker.ingestCrossBrokerTerminalBriefProjection(projection({
    originBrokerId: "seoseo",
    childTaskId: "bangtong-task-canceled",
    childWorkerId: "bangtong",
    parentRoundTotal: "7",
    status: "canceled",
    summary: "bangtong canceled",
    completedAt: "2026-05-14T01:03:00.000Z",
    emittedAt: "2026-05-14T01:03:01.000Z",
  }));
  assert.equal(result.accepted, true);

  const events = broker.getTerminalTaskEventOutbox().subscribe();
  const event = events.find(e => e.payload.taskId === "bangtong-task-canceled");
  assert.ok(event, "bangtong canceled event must exist");
  assert.equal(event.payload.terminalBriefTitle, "A2A Terminal Brief 완료: bangtong(1/7)");
  assert.equal(event.payload.status, "canceled");
});

test("bangtong compact Terminal Brief emitted on every terminal status: blocked", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "parent-broker" });
  createParentRound(broker);

  const result = broker.ingestCrossBrokerTerminalBriefProjection(projection({
    originBrokerId: "seoseo",
    childTaskId: "bangtong-task-blocked",
    childWorkerId: "bangtong",
    parentRoundTotal: "7",
    status: "blocked",
    summary: "bangtong blocked",
    completedAt: "2026-05-14T01:04:00.000Z",
    emittedAt: "2026-05-14T01:04:01.000Z",
  }));
  assert.equal(result.accepted, true);

  const events = broker.getTerminalTaskEventOutbox().subscribe();
  const event = events.find(e => e.payload.taskId === "bangtong-task-blocked");
  assert.ok(event, "bangtong blocked event must exist");
  assert.equal(event.payload.terminalBriefTitle, "A2A Terminal Brief 완료: bangtong(1/7)");
  assert.equal(event.payload.status, "blocked");
});
