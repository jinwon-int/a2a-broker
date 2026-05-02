import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { InMemoryA2ABroker } from "./broker.js";
import type { TaskStatusEvent, TerminalTaskEvent } from "./task-events.js";
import type { TerminalTaskOutboxEvent } from "./terminal-event-outbox.js";

function registerWorker(broker: InMemoryA2ABroker, nodeId = "worker-1"): void {
  broker.registerWorker({
    nodeId,
    role: "operator",
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: false,
      canPromoteLive: false,
      workspaceIds: ["default"],
      environments: ["research"],
    },
  });
}

function createTask(
  broker: InMemoryA2ABroker,
  overrides: {
    id?: string;
    parentTaskId?: string;
    targetNodeId?: string;
    payload?: Record<string, unknown>;
    policyContext?: { requiresApproval?: boolean };
  } = {},
) {
  return broker.createTask({
    id: overrides.id,
    parentTaskId: overrides.parentTaskId,
    intent: "analyze",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: overrides.targetNodeId ?? "worker-1", kind: "node", role: "operator" },
    policyContext: overrides.policyContext,
    payload: overrides.payload ?? {},
  });
}

describe("TaskEventStream", () => {
  it("emits a TaskStatusEvent when a task is created", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker);

    const task = createTask(broker);
    const events = broker.getTaskEventStream().subscribe();

    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event.taskId, task.id);
    assert.equal(event.kind, "created");
    assert.equal(event.status, "queued");
    assert.equal(event.id, 1);
    assert.equal(event.metadata.intent, "analyze");
    assert.equal(event.metadata.targetNodeId, "worker-1");
  });

  it("emits events in monotonic order across the task lifecycle", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker);

    const task = createTask(broker);
    broker.claimTask(task.id, "worker-1");
    broker.startTask(task.id, "worker-1");
    broker.completeTask(task.id, "worker-1");

    const events = broker.getTaskEventStream().subscribe();
    assert.equal(events.length, 4);
    assert.deepEqual(
      events.map((e) => e.kind),
      ["created", "claimed", "started", "succeeded"],
    );
    assert.deepEqual(
      events.map((e) => e.id),
      [1, 2, 3, 4],
    );
    assert.deepEqual(
      events.map((e) => e.status),
      ["queued", "claimed", "running", "succeeded"],
    );
  });

  it("subscribe(afterId) returns only events strictly after the cursor", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker);
    const task = createTask(broker);
    broker.claimTask(task.id, "worker-1");
    broker.startTask(task.id, "worker-1");
    broker.completeTask(task.id, "worker-1");

    const stream = broker.getTaskEventStream();
    const afterThree = stream.subscribe({ afterId: 3 });
    assert.equal(afterThree.length, 1);
    assert.equal(afterThree[0]!.id, 4);
    assert.equal(afterThree[0]!.kind, "succeeded");

    const afterFour = stream.subscribe({ afterId: 4 });
    assert.equal(afterFour.length, 0);
  });

  it("subscribe with no cursor or afterId=-1 returns every retained event", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker);
    const task = createTask(broker);
    broker.claimTask(task.id, "worker-1");

    const stream = broker.getTaskEventStream();
    const noCursor = stream.subscribe();
    const negativeCursor = stream.subscribe({ afterId: -1 });

    assert.equal(noCursor.length, 2);
    assert.deepEqual(noCursor, negativeCursor);
  });

  it("events include operator-safe metadata but no raw prompt or payload text", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker);
    const secret = "do-not-leak: highly-sensitive prompt body";
    broker.createTask({
      intent: "analyze",
      requester: { id: "hub", kind: "node", role: "hub" },
      target: { id: "worker-1", kind: "node", role: "operator" },
      message: secret,
      payload: { sessionPrompt: secret, githubRepo: "acme/example", githubIssueNumber: 42 },
      taskOrigin: "github",
    });

    const [event] = broker.getTaskEventStream().subscribe();
    assert.ok(event);
    assert.equal(event.metadata.taskOrigin, "github");
    assert.equal(event.metadata.repoFullName, "acme/example");
    assert.equal(event.metadata.issueNumber, 42);

    const serialized = JSON.stringify(event);
    assert.ok(!serialized.includes("highly-sensitive"), "raw prompt body must not appear in event");
    assert.ok(!serialized.includes("sessionPrompt"), "payload keys must not leak into event");
    assert.equal(Object.prototype.hasOwnProperty.call(event, "message"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(event, "payload"), false);
  });

  it("a parent aggregate can consume child task lifecycle updates via parentTaskId filter", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker, "worker-1");
    registerWorker(broker, "worker-2");

    const parent = createTask(broker, { id: "parent-task", targetNodeId: "worker-1" });
    const childA = createTask(broker, { id: "child-a", parentTaskId: parent.id, targetNodeId: "worker-1" });
    const childB = createTask(broker, { id: "child-b", parentTaskId: parent.id, targetNodeId: "worker-2" });

    broker.claimTask(childA.id, "worker-1");
    broker.startTask(childA.id, "worker-1");
    broker.failTask(childA.id, "worker-1", { code: "boom", message: "blew up" });

    broker.claimTask(childB.id, "worker-2");
    broker.completeTask(childB.id, "worker-2");

    const stream = broker.getTaskEventStream();
    const childEvents = stream.subscribe({ parentTaskId: parent.id });

    assert.deepEqual(
      childEvents.map((e: TaskStatusEvent) => `${e.taskId}:${e.kind}`),
      [
        "child-a:created",
        "child-b:created",
        "child-a:claimed",
        "child-a:started",
        "child-a:failed",
        "child-b:claimed",
        "child-b:succeeded",
      ],
    );
    for (const event of childEvents) {
      assert.equal(event.parentTaskId, parent.id);
    }

    const parentOnly = stream.subscribe({ taskId: parent.id });
    assert.equal(parentOnly.length, 1);
    assert.equal(parentOnly[0]!.kind, "created");
    assert.equal(parentOnly[0]!.parentTaskId, undefined);
  });

  it("bounded replay honors the limit parameter", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker);
    const task = createTask(broker);
    broker.claimTask(task.id, "worker-1");
    broker.startTask(task.id, "worker-1");
    broker.completeTask(task.id, "worker-1");

    const stream = broker.getTaskEventStream();
    const firstTwo = stream.subscribe({ afterId: 0, limit: 2 });
    assert.equal(firstTwo.length, 2);
    assert.deepEqual(
      firstTwo.map((e) => e.id),
      [1, 2],
    );

    const fromCursorWithLimit = stream.subscribe({ afterId: 1, limit: 2 });
    assert.deepEqual(
      fromCursorWithLimit.map((e) => e.id),
      [2, 3],
    );
  });

  it("emits compact terminal events with safe evidence fields and replay ids", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker);
    const task = createTask(broker, {
      payload: {
        githubRepo: "acme/example",
        githubIssueNumber: 217,
        sessionPrompt: "do-not-leak",
      },
    });
    broker.claimTask(task.id, "worker-1");
    broker.startTask(task.id, "worker-1");
    broker.completeTask(task.id, "worker-1", {
      summary: "raw summary should not be used as logs",
      output: {
        prUrl: "https://github.com/acme/example/pull/9",
        doneUrl: "https://github.com/acme/example/issues/217#issuecomment-1",
        privatePath: "/home/alice/secret",
        testSummary: { status: "passed", total: 3, passed: 3, summary: "npm test ok\nno raw logs" },
      },
    });

    const stream = broker.getTaskEventStream();
    const terminalEvents = stream.subscribeTerminal();
    assert.equal(terminalEvents.length, 1);
    assert.deepEqual(terminalEvents[0], {
      id: 1,
      taskId: task.id,
      status: "succeeded",
      worker: "worker-1",
      repo: "acme/example",
      issue: 217,
      prUrl: "https://github.com/acme/example/pull/9",
      doneUrl: "https://github.com/acme/example/issues/217#issuecomment-1",
      testSummary: { status: "passed", total: 3, passed: 3, summary: "npm test ok no raw logs" },
      createdAt: terminalEvents[0]!.createdAt,
      updatedAt: terminalEvents[0]!.updatedAt,
      completedAt: terminalEvents[0]!.completedAt,
    });
    assert.deepEqual(stream.subscribeTerminal({ afterId: 1 }), []);
    const serialized = JSON.stringify(terminalEvents[0]);
    assert.ok(!serialized.includes("sessionPrompt"));
    assert.ok(!serialized.includes("do-not-leak"));
    assert.ok(!serialized.includes("privatePath"));
    assert.ok(!serialized.includes("/home/alice"));
  });
});

describe("TerminalTaskEventOutbox", () => {
  it("enqueues compact idempotent terminal events for webhook replay", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker);
    const task = createTask(broker, {
      payload: { githubRepo: "jinwon-int/a2a-broker", githubIssueNumber: 218 },
    });

    broker.claimTask(task.id, "worker-1");
    broker.startTask(task.id, "worker-1");
    broker.completeTask(task.id, "worker-1", {
      summary: "tests passed from /work/repo/dist/core/task-events.test.js",
      output: {
        prUrl: "https://github.com/jinwon-int/a2a-broker/pull/999",
        doneUrl: "https://github.com/jinwon-int/a2a-broker/issues/218#issuecomment-1",
        blockUrl: "/work/private/block.md",
        rawLog: "secret token should not appear",
      },
    });
    broker.completeTask(task.id, "worker-1");

    const outbox = broker.getTerminalTaskEventOutbox();
    const events = outbox.subscribe();
    assert.equal(events.length, 1);
    const [event] = events;
    assert.ok(event);
    assert.match(event.id, /^terminal:/);
    assert.equal(event.kind, "task.terminal");
    assert.equal(event.payload.taskId, task.id);
    assert.equal(event.payload.status, "succeeded");
    assert.equal(event.payload.worker, "worker-1");
    assert.equal(event.payload.repo, "jinwon-int/a2a-broker");
    assert.equal(event.payload.issue, 218);
    assert.equal(event.payload.prUrl, "https://github.com/jinwon-int/a2a-broker/pull/999");
    assert.equal(event.payload.doneUrl, "https://github.com/jinwon-int/a2a-broker/issues/218#issuecomment-1");
    assert.equal(event.payload.blockUrl, undefined);
    assert.match(event.payload.testSummary ?? "", /tests passed from \[path\]/);

    const serialized = JSON.stringify(event);
    assert.ok(!serialized.includes("rawLog"));
    assert.ok(!serialized.includes("secret token"));
    assert.ok(!serialized.includes("/work/repo"));
    assert.ok(!serialized.includes("sessionPrompt"));
  });

  it("replays terminal outbox events after a stable event id", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker);
    const first = createTask(broker, { id: "task-one" });
    const second = createTask(broker, { id: "task-two" });

    broker.claimTask(first.id, "worker-1");
    broker.failTask(first.id, "worker-1", { message: "tests failed" });
    broker.claimTask(second.id, "worker-1");
    broker.completeTask(second.id, "worker-1", { summary: "tests passed" });

    const all = broker.getTerminalTaskEventOutbox().subscribe();
    assert.equal(all.length, 2);
    const replay = broker.getTerminalTaskEventOutbox().subscribe({ afterId: all[0]!.id });
    assert.equal(replay.length, 1);
    assert.equal(replay[0]!.payload.taskId, "task-two");
    assert.equal(replay[0]!.payload.status, "succeeded");
  });

  it("proves operator terminal push envelopes without direct Telegram delivery", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker);
    const sseEvents: TerminalTaskEvent[] = [];
    broker.getTaskEventStream().onTerminal((event) => sseEvents.push(event));

    const succeeded = createTask(broker, {
      id: "proof-succeeded",
      payload: { githubRepo: "jinwon-int/a2a-broker", githubIssueNumber: 229 },
    });
    broker.claimTask(succeeded.id, "worker-1");
    broker.completeTask(succeeded.id, "worker-1", { summary: "npm test passed" });
    broker.completeTask(succeeded.id, "worker-1", { summary: "duplicate terminal update ignored" });

    const failed = createTask(broker, {
      id: "proof-failed",
      payload: { githubRepo: "jinwon-int/a2a-broker", githubIssueNumber: 229 },
    });
    broker.claimTask(failed.id, "worker-1");
    broker.failTask(failed.id, "worker-1", {
      message: "tests failed token=ghp_secretvalue at /work/private/raw-session.log",
    });
    broker.failTask(failed.id, "worker-1", { message: "duplicate failure ignored" });

    createTask(broker, {
      id: "proof-blocked",
      policyContext: { requiresApproval: true },
      payload: {
        githubRepo: "jinwon-int/a2a-broker",
        githubIssueNumber: 229,
        blockUrl: "https://github.com/jinwon-int/a2a-broker/issues/229#issuecomment-block",
        rawTranscript: "do-not-leak",
      },
    });

    const prOpened = createTask(broker, {
      id: "proof-pr-opened",
      payload: { githubRepo: "jinwon-int/a2a-broker", githubIssueNumber: 229 },
    });
    broker.claimTask(prOpened.id, "worker-1");
    broker.startTask(prOpened.id, "worker-1");
    broker.completeTask(prOpened.id, "worker-1", {
      summary: "PR opened and Done evidence posted from /work/repo/dist/core/task-events.test.js",
      output: {
        prUrl: "https://github.com/jinwon-int/a2a-broker/pull/230",
        doneUrl: "https://github.com/jinwon-int/a2a-broker/issues/229#issuecomment-done",
        testSummary: {
          status: "passed",
          total: 1,
          passed: 1,
          summary: "operator push proof ok password=hunter2 /home/operator/session.txt",
        },
        rawLog: "do-not-leak",
      },
    });

    const outbox = broker.getTerminalTaskEventOutbox();
    const webhookEvents = outbox.subscribe();
    assert.deepEqual(
      webhookEvents.map((event) => event.payload.status),
      ["succeeded", "failed", "succeeded"],
    );
    assert.equal(outbox.size, 3);
    assert.deepEqual(
      sseEvents.map((event) => event.status),
      ["succeeded", "failed", "blocked", "succeeded"],
    );
    assert.equal(
      sseEvents.find((event) => event.taskId === "proof-blocked")?.blockUrl,
      "https://github.com/jinwon-int/a2a-broker/issues/229#issuecomment-block",
    );

    const replay = outbox.subscribe({ afterId: webhookEvents[1]!.id });
    assert.deepEqual(
      replay.map((event) => event.payload.taskId),
      ["proof-pr-opened"],
    );

    const envelopes = webhookEvents.map(toFakeOperatorEnvelope);
    assert.deepEqual(envelopes.map((envelope) => envelope.transportOwner), [
      "seoseo/OpenClaw plugin-notifier",
      "seoseo/OpenClaw plugin-notifier",
      "seoseo/OpenClaw plugin-notifier",
    ]);
    assert.equal(envelopes[2]!.body.prUrl, "https://github.com/jinwon-int/a2a-broker/pull/230");
    assert.equal(envelopes[2]!.body.doneUrl, "https://github.com/jinwon-int/a2a-broker/issues/229#issuecomment-done");

    const serialized = JSON.stringify({ envelopes, sseEvents });
    for (const forbidden of [
      "telegram",
      "rawLog",
      "rawTranscript",
      "do-not-leak",
      "ghp_secretvalue",
      "hunter2",
      "/work/private",
      "/work/repo",
      "/home/operator",
    ]) {
      assert.ok(!serialized.toLowerCase().includes(forbidden.toLowerCase()), forbidden);
    }
  });

  it("persists terminal outbox replay and dedupe state in broker snapshots", () => {
    const broker = new InMemoryA2ABroker(undefined, undefined, { maxTerminalTaskOutboxEvents: 10 });
    registerWorker(broker);
    const task = createTask(broker, {
      id: "persisted-terminal",
      payload: { githubRepo: "jinwon-int/a2a-broker", githubIssueNumber: 247 },
    });

    broker.claimTask(task.id, "worker-1");
    broker.completeTask(task.id, "worker-1", {
      summary: "npm test passed",
      output: { doneUrl: "https://github.com/jinwon-int/a2a-broker/issues/247#issuecomment-done" },
    });

    const [before] = broker.getTerminalTaskEventOutbox().subscribe();
    assert.ok(before);
    broker.getTerminalTaskEventOutbox().acknowledge(before.id, "2026-05-02T00:00:00.000Z");

    const restarted = new InMemoryA2ABroker(undefined, broker.exportSnapshot(), {
      maxTerminalTaskOutboxEvents: 10,
    });
    const replayed = restarted.getTerminalTaskEventOutbox().subscribe();
    assert.equal(replayed.length, 1);
    assert.equal(replayed[0]!.id, before.id);
    assert.equal(replayed[0]!.deliveredAt, "2026-05-02T00:00:00.000Z");
    assert.equal(replayed[0]!.attempts, 1);
    assert.equal(
      restarted.getTerminalTaskEventOutbox().subscribe({ afterId: before.id }).length,
      0,
    );

    // Rehydrating the same snapshot twice must not duplicate records; the stable id
    // remains the durable dedupe key across restart/replay cycles.
    restarted.getTerminalTaskEventOutbox().restoreSnapshot(broker.exportSnapshot().terminalOutbox ?? []);
    assert.equal(restarted.getTerminalTaskEventOutbox().subscribe().length, 1);
  });

  it("reconciles unacknowledged terminal records before a notifier cursor", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker);

    for (const id of ["cursor-one", "cursor-two", "cursor-three"]) {
      const task = createTask(broker, { id });
      broker.claimTask(task.id, "worker-1");
      broker.completeTask(task.id, "worker-1", { summary: `done ${id}` });
    }

    const outbox = broker.getTerminalTaskEventOutbox();
    const [first, second, third] = outbox.subscribe();
    assert.ok(first);
    assert.ok(second);
    assert.ok(third);
    outbox.acknowledge(first.id, "2026-05-02T00:00:00.000Z");

    const reconciled = outbox.reconcile({ afterId: second.id });
    assert.deepEqual(
      reconciled.events.map((event) => event.id),
      [second.id, third.id],
    );
    assert.equal(reconciled.cursor, third.id);
    assert.equal(reconciled.reconciledUnacked, 1);

    const retryOnly = outbox.reconcile({ afterId: second.id, limit: 1 });
    assert.deepEqual(retryOnly.events.map((event) => event.id), [second.id]);
    assert.equal(retryOnly.cursor, second.id);
    assert.equal(retryOnly.reconciledUnacked, 1);
  });

  it("acknowledges delivered terminal records without removing replay state", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker);
    const task = createTask(broker, { id: "ack-task" });

    broker.claimTask(task.id, "worker-1");
    broker.completeTask(task.id, "worker-1", { summary: "done" });

    const outbox = broker.getTerminalTaskEventOutbox();
    const [event] = outbox.subscribe();
    assert.ok(event);

    const deliveredAt = "2026-05-01T00:00:00.000Z";
    const acked = outbox.acknowledge(event.id, deliveredAt);
    assert.ok(acked);
    assert.equal(acked.deliveredAt, deliveredAt);
    assert.equal(acked.attempts, 1);
    assert.equal(outbox.acknowledge("missing"), null);

    const replayed = outbox.subscribe()[0];
    assert.equal(replayed!.id, event.id);
    assert.equal(replayed!.deliveredAt, deliveredAt);
    assert.equal(replayed!.attempts, 1);
  });

  it("keeps terminal outbox retention bounded", () => {
    const broker = new InMemoryA2ABroker(undefined, undefined, { maxTerminalTaskOutboxEvents: 2 });
    registerWorker(broker);

    for (const id of ["retain-1", "retain-2", "retain-3"]) {
      const task = createTask(broker, { id });
      broker.claimTask(task.id, "worker-1");
      broker.completeTask(task.id, "worker-1", { summary: `done ${id}` });
    }

    const retained = broker.getTerminalTaskEventOutbox().subscribe();
    assert.equal(retained.length, 2);
    assert.deepEqual(
      retained.map((event) => event.payload.taskId),
      ["retain-2", "retain-3"],
    );
  });

  it("excludes worker heartbeats and approval-blocked creation noise from the terminal outbox", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker, "worker-a");

    broker.heartbeatWorker("worker-a", { metadata: { check: "alive" } });
    const blocked = broker.createTask({
      intent: "apply_local_change",
      requester: { id: "analyst-a", kind: "node", role: "analyst" },
      target: { id: "worker-a", kind: "node", role: "live-trader" },
      workspace: { nodeId: "worker-a", workspaceId: "test" },
      message: "apply live patch",
    });

    assert.equal(blocked.status, "blocked");
    assert.equal(broker.getTerminalTaskEventOutbox().subscribe().length, 0);
  });
});

function toFakeOperatorEnvelope(event: TerminalTaskOutboxEvent) {
  return {
    envelopeVersion: 1,
    delivery: "operator-terminal-push-proof",
    transportOwner: "seoseo/OpenClaw plugin-notifier",
    brokerTransport: "webhook-or-sse",
    cursor: event.id,
    body: event.payload,
  };
}
