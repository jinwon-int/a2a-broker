import test from "node:test";
import assert from "node:assert/strict";

import type { CreateTaskRequest, TaskRecord, TaskResult, TaskError } from "./types.js";
import {
  DelegatedRunRuntime,
  type BrokerTaskBridge,
  type DelegatedRunState,
} from "./delegated-runtime.js";

// ---------------------------------------------------------------------------
// Helpers: fake bridge
// ---------------------------------------------------------------------------

interface FakeBridgeTask {
  record: TaskRecord;
  listeners: Set<(update: { task: TaskRecord; final: boolean }) => void>;
}

function createFakeBridge(): BrokerTaskBridge & {
  tasks: Map<string, FakeBridgeTask>;
  /** Simulate broker emitting a task update. */
  emitUpdate(taskId: string, status: TaskRecord["status"], extra?: { result?: TaskResult; error?: TaskError }): void;
  /** Track cancel calls. */
  cancelCalls: Array<{ taskId: string }>;
} {
  const tasks = new Map<string, FakeBridgeTask>();
  const cancelCalls: Array<{ taskId: string }> = [];
  let nextTaskSeq = 1;

  return {
    tasks,
    cancelCalls,

    createTask(request: CreateTaskRequest): TaskRecord {
      const id = request.id ?? `task-${nextTaskSeq++}`;
      const record: TaskRecord = {
        id,
        intent: request.intent,
        status: "queued",
        targetNodeId: request.target.id,
        payload: request.payload ?? {},
        updatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        requester: request.requester,
        target: request.target,
      };
      tasks.set(id, { record, listeners: new Set() });
      return record;
    },

    subscribeToTask(taskId, listener) {
      const entry = tasks.get(taskId);
      if (!entry) throw new Error(`Task ${taskId} not found`);
      entry.listeners.add(listener);
      return () => {
        entry.listeners.delete(listener);
      };
    },

    cancelTask(taskId, _request) {
      cancelCalls.push({ taskId });
      const entry = tasks.get(taskId);
      if (!entry) throw new Error(`Task ${taskId} not found`);
      entry.record.status = "canceled";
      entry.record.completedAt = new Date().toISOString();
      // Emit the canceled update to all listeners
      const update = { task: { ...entry.record }, final: true };
      for (const l of entry.listeners) l(update);
      return entry.record;
    },

    emitUpdate(taskId, status, extra) {
      const entry = tasks.get(taskId);
      if (!entry) throw new Error(`Task ${taskId} not found`);
      entry.record.status = status;
      if (extra?.result) entry.record.result = extra.result;
      if (extra?.error) entry.record.error = extra.error;
      const final = status === "succeeded" || status === "failed" || status === "canceled";
      if (final) entry.record.completedAt = new Date().toISOString();
      const update = { task: { ...entry.record }, final };
      for (const l of entry.listeners) l(update);
    },
  };
}

function makeTaskRequest(overrides?: Partial<CreateTaskRequest>): CreateTaskRequest {
  return {
    intent: "analyze",
    requester: { id: "hub-1", kind: "node", role: "hub" },
    target: { id: "worker-1", kind: "node", role: "analyst" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("successful completion path", async () => {
  const bridge = createFakeBridge();
  const runtime = new DelegatedRunRuntime(bridge);
  const handle = await runtime.start(makeTaskRequest());

  assert.equal(handle.getState(), "waiting");

  // Worker claims and starts
  bridge.emitUpdate(handle.taskId, "claimed");
  assert.equal(handle.getState(), "running");

  bridge.emitUpdate(handle.taskId, "running");
  assert.equal(handle.getState(), "running");

  // Worker completes
  const result: TaskResult = { summary: "done", output: { foo: 42 } };
  bridge.emitUpdate(handle.taskId, "succeeded", { result });

  const run = await handle.wait();
  assert.equal(run.state, "completed");
  assert.deepEqual(run.result, result);
  assert.equal(run.error, undefined);
  assert.ok(run.completedAt);
});

test("timeout path", async () => {
  const bridge = createFakeBridge();
  const runtime = new DelegatedRunRuntime(bridge);
  const handle = await runtime.start(makeTaskRequest(), { timeoutMs: 50 });

  assert.equal(handle.getState(), "waiting");

  const run = await handle.wait();
  assert.equal(run.state, "timed_out");
  assert.equal(run.error?.code, "timeout");
  assert.ok(run.completedAt);
});

test("cancel path via handle", async () => {
  const bridge = createFakeBridge();
  const runtime = new DelegatedRunRuntime(bridge);
  const handle = await runtime.start(makeTaskRequest());

  bridge.emitUpdate(handle.taskId, "running");
  assert.equal(handle.getState(), "running");

  handle.cancel();

  const run = await handle.wait();
  assert.equal(run.state, "canceled");
  assert.equal(bridge.cancelCalls.length, 1);
  assert.equal(bridge.cancelCalls[0].taskId, handle.taskId);
});

test("cancel via AbortSignal", async () => {
  const bridge = createFakeBridge();
  const runtime = new DelegatedRunRuntime(bridge);
  const ac = new AbortController();
  const handle = await runtime.start(makeTaskRequest(), { abortSignal: ac.signal });

  bridge.emitUpdate(handle.taskId, "running");
  ac.abort();

  const run = await handle.wait();
  assert.equal(run.state, "canceled");
  assert.equal(run.error?.code, "aborted");
});

test("cancel with already-aborted signal settles immediately", async () => {
  const bridge = createFakeBridge();
  const runtime = new DelegatedRunRuntime(bridge);
  const ac = new AbortController();
  ac.abort();
  const handle = await runtime.start(makeTaskRequest(), { abortSignal: ac.signal });

  const run = await handle.wait();
  assert.equal(run.state, "canceled");
  assert.equal(run.error?.code, "aborted");
});

test("failed task path", async () => {
  const bridge = createFakeBridge();
  const runtime = new DelegatedRunRuntime(bridge);
  const handle = await runtime.start(makeTaskRequest());

  const error: TaskError = { code: "handler_error", message: "something broke" };
  bridge.emitUpdate(handle.taskId, "failed", { error });

  const run = await handle.wait();
  assert.equal(run.state, "failed");
  assert.deepEqual(run.error, error);
  assert.equal(run.result, undefined);
});

test("failed task without explicit error gets default error", async () => {
  const bridge = createFakeBridge();
  const runtime = new DelegatedRunRuntime(bridge);
  const handle = await runtime.start(makeTaskRequest());

  bridge.emitUpdate(handle.taskId, "failed");

  const run = await handle.wait();
  assert.equal(run.state, "failed");
  assert.equal(run.error?.message, "Task failed");
});

test("multiple concurrent runs", async () => {
  const bridge = createFakeBridge();
  const runtime = new DelegatedRunRuntime(bridge);

  const h1 = await runtime.start(makeTaskRequest({ id: "t1" }));
  const h2 = await runtime.start(makeTaskRequest({ id: "t2" }));
  const h3 = await runtime.start(makeTaskRequest({ id: "t3" }));

  assert.equal(runtime.activeCount, 3);

  bridge.emitUpdate("t1", "succeeded", { result: { summary: "r1" } });
  assert.equal(runtime.activeCount, 2);

  bridge.emitUpdate("t2", "failed", { error: { message: "boom" } });
  assert.equal(runtime.activeCount, 1);

  bridge.emitUpdate("t3", "succeeded", { result: { summary: "r3" } });
  assert.equal(runtime.activeCount, 0);

  const [r1, r2, r3] = await Promise.all([h1.wait(), h2.wait(), h3.wait()]);
  assert.equal(r1.state, "completed");
  assert.equal(r2.state, "failed");
  assert.equal(r3.state, "completed");
});

test("cancel after complete is a no-op", async () => {
  const bridge = createFakeBridge();
  const runtime = new DelegatedRunRuntime(bridge);
  const handle = await runtime.start(makeTaskRequest());

  bridge.emitUpdate(handle.taskId, "succeeded", { result: { summary: "done" } });
  const run = await handle.wait();
  assert.equal(run.state, "completed");

  // Cancel after completion — should be a no-op
  handle.cancel();
  assert.equal(handle.getState(), "completed");
  assert.equal(bridge.cancelCalls.length, 0);
});

test("timeout race: completion before timeout wins", async () => {
  const bridge = createFakeBridge();
  const runtime = new DelegatedRunRuntime(bridge);
  const handle = await runtime.start(makeTaskRequest(), { timeoutMs: 200 });

  bridge.emitUpdate(handle.taskId, "succeeded", { result: { summary: "fast" } });

  const run = await handle.wait();
  assert.equal(run.state, "completed");
  assert.equal(run.result?.summary, "fast");
});

test("timeout race: timeout before completion wins", async () => {
  const bridge = createFakeBridge();
  const runtime = new DelegatedRunRuntime(bridge);
  const handle = await runtime.start(makeTaskRequest(), { timeoutMs: 30 });

  // Wait for timeout to fire
  const run = await handle.wait();
  assert.equal(run.state, "timed_out");

  // Late completion is ignored
  bridge.emitUpdate(handle.taskId, "succeeded", { result: { summary: "late" } });
  assert.equal(handle.getState(), "timed_out");
});

test("getRun returns snapshot from runtime", async () => {
  const bridge = createFakeBridge();
  const runtime = new DelegatedRunRuntime(bridge);
  const handle = await runtime.start(makeTaskRequest());

  const run = runtime.getRun(handle.id);
  assert.ok(run);
  assert.equal(run.id, handle.id);
  assert.equal(run.taskId, handle.taskId);
  assert.equal(run.state, "waiting");
  assert.ok(run.createdAt);
});

test("getRun returns undefined for unknown id", () => {
  const bridge = createFakeBridge();
  const runtime = new DelegatedRunRuntime(bridge);
  assert.equal(runtime.getRun("nonexistent"), undefined);
});

test("handle.getRun returns current snapshot", async () => {
  const bridge = createFakeBridge();
  const runtime = new DelegatedRunRuntime(bridge);
  const handle = await runtime.start(makeTaskRequest());

  const snap1 = handle.getRun();
  assert.equal(snap1.state, "waiting");

  bridge.emitUpdate(handle.taskId, "running");
  const snap2 = handle.getRun();
  assert.equal(snap2.state, "running");
});

test("bridge cancel failure settles run locally", async () => {
  const bridge = createFakeBridge();
  // Override cancelTask to throw
  bridge.cancelTask = () => {
    throw new Error("bridge down");
  };
  const runtime = new DelegatedRunRuntime(bridge);
  const handle = await runtime.start(makeTaskRequest());

  handle.cancel();

  const run = await handle.wait();
  assert.equal(run.state, "canceled");
  assert.equal(run.error?.message, "Canceled locally (bridge cancel failed)");
});

test("duplicate updates after terminal state are ignored", async () => {
  const bridge = createFakeBridge();
  const runtime = new DelegatedRunRuntime(bridge);
  const handle = await runtime.start(makeTaskRequest());

  bridge.emitUpdate(handle.taskId, "succeeded", { result: { summary: "first" } });
  const run = await handle.wait();
  assert.equal(run.state, "completed");
  assert.equal(run.result?.summary, "first");

  // These should all be ignored
  bridge.emitUpdate(handle.taskId, "failed", { error: { message: "late fail" } });
  bridge.emitUpdate(handle.taskId, "canceled");
  assert.equal(handle.getState(), "completed");
  assert.equal(handle.getRun().result?.summary, "first");
});
