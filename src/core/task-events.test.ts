import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { InMemoryA2ABroker } from "./broker.js";
import type { TaskStatusEvent } from "./task-events.js";

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
  overrides: { id?: string; parentTaskId?: string; targetNodeId?: string; payload?: Record<string, unknown> } = {},
) {
  return broker.createTask({
    id: overrides.id,
    parentTaskId: overrides.parentTaskId,
    intent: "analyze",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: overrides.targetNodeId ?? "worker-1", kind: "node", role: "operator" },
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
});
