import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildQueueHygieneSnapshot,
  DEFAULT_ACTIVE_TASK_WARNING,
  DEFAULT_ACTIVE_TASK_CRITICAL,
  DEFAULT_REQUEUE_DEPTH_WARNING,
} from "./queue-hygiene-snapshot.js";
import type { TaskRecord } from "./types.js";

const NOW_MS = Date.parse("2026-05-13T06:00:00.000Z");

function makeTask(overrides: Partial<TaskRecord> & { status?: TaskRecord["status"] } = {}): TaskRecord {
  return {
    id: `task-${Math.random().toString(36).slice(2, 8)}`,
    intent: "propose_patch",
    status: "queued",
    targetNodeId: "node-1",
    payload: {},
    createdAt: "2026-05-13T05:00:00.000Z",
    updatedAt: "2026-05-13T05:00:00.000Z",
    requeueCount: 0,
    requester: { id: "requester-1" },
    target: { id: "target-1", kind: "node" as const },
    ...overrides,
  };
}

describe("buildQueueHygieneSnapshot", () => {
  it("produces a snapshot from an empty task list", () => {
    const snapshot = buildQueueHygieneSnapshot({ tasks: [], nowMs: NOW_MS });

    assert.equal(snapshot.kind, "broker.queue-hygiene.snapshot");
    assert.equal(snapshot.totalTasks, 0);
    assert.equal(snapshot.activeTasks, 0);
    assert.equal(snapshot.terminalTasks, 0);
    assert.equal(snapshot.severity, "ok");
    assert.ok(snapshot.warnings.length >= 0);
  });

  it("classifies active vs terminal tasks correctly", () => {
    const tasks: TaskRecord[] = [
      makeTask({ status: "queued" }),
      makeTask({ status: "claimed" }),
      makeTask({ status: "running" }),
      makeTask({ status: "blocked" }),
      makeTask({ status: "succeeded" }),
      makeTask({ status: "failed" }),
      makeTask({ status: "canceled" }),
    ];

    const snapshot = buildQueueHygieneSnapshot({ tasks, nowMs: NOW_MS });

    assert.equal(snapshot.totalTasks, 7);
    assert.equal(snapshot.activeTasks, 4);
    assert.equal(snapshot.terminalTasks, 3);
  });

  it("reports per-status breakdown with age info", () => {
    const tasks: TaskRecord[] = [
      makeTask({ status: "queued", createdAt: "2026-05-13T04:00:00.000Z" }),
      makeTask({ status: "claimed", createdAt: "2026-05-13T05:30:00.000Z" }),
    ];

    const snapshot = buildQueueHygieneSnapshot({ tasks, nowMs: NOW_MS });

    const queued = snapshot.byStatus.find((s) => s.status === "queued")!;
    assert.equal(queued.count, 1);
    assert.equal(queued.oldestAgeMs, 2 * 60 * 60 * 1000); // 2 hours

    const claimed = snapshot.byStatus.find((s) => s.status === "claimed")!;
    assert.equal(claimed.count, 1);
  });

  it("returns ok severity for a healthy queue", () => {
    const tasks: TaskRecord[] = [
      makeTask({ status: "queued", createdAt: "2026-05-13T05:55:00.000Z" }),
      makeTask({ status: "claimed", createdAt: "2026-05-13T05:56:00.000Z" }),
      makeTask({ status: "running", createdAt: "2026-05-13T05:57:00.000Z" }),
    ];

    const snapshot = buildQueueHygieneSnapshot({ tasks, nowMs: NOW_MS });

    assert.equal(snapshot.severity, "ok");
    assert.ok(snapshot.warnings.length >= 1);
    assert.match(snapshot.warnings[0], /Active tasks: 3/);
  });

  it("warns when active tasks exceed the warning threshold", () => {
    const tasks: TaskRecord[] = Array.from(
      { length: DEFAULT_ACTIVE_TASK_WARNING + 10 },
      () => makeTask({ status: "queued" }),
    );

    const snapshot = buildQueueHygieneSnapshot({ tasks, nowMs: NOW_MS });

    assert.equal(snapshot.severity, "warning");
    assert.ok(snapshot.warnings.some((w) => w.includes("Queue depth")));
  });

  it("critical when active tasks exceed the critical threshold", () => {
    const tasks: TaskRecord[] = Array.from(
      { length: DEFAULT_ACTIVE_TASK_CRITICAL + 1 },
      () => makeTask({ status: "queued" }),
    );

    const snapshot = buildQueueHygieneSnapshot({ tasks, nowMs: NOW_MS });

    assert.equal(snapshot.severity, "critical");
    assert.ok(snapshot.warnings.some((w) => w.includes("CRITICAL")));
  });

  it("detects requeue chain depth", () => {
    const tasks: TaskRecord[] = [
      makeTask({ status: "failed", requeueCount: 0 }),
      makeTask({ status: "queued", requeueCount: 1 }),
      makeTask({ status: "claimed", requeueCount: 2 }),
      makeTask({ status: "failed", requeueCount: 3 }),
    ];

    const snapshot = buildQueueHygieneSnapshot({ tasks, nowMs: NOW_MS });

    assert.equal(snapshot.requeue.requeued, 3);
    assert.equal(snapshot.requeue.multiRequeued, 2);
    assert.equal(snapshot.requeue.maxRequeueDepth, 3);
    assert.equal(snapshot.requeue.sampleTaskIds.length, 3);
  });

  it("warns when requeue depth exceeds warning threshold", () => {
    const tasks: TaskRecord[] = [
      makeTask({ status: "claimed", requeueCount: DEFAULT_REQUEUE_DEPTH_WARNING }),
    ];

    const snapshot = buildQueueHygieneSnapshot({ tasks, nowMs: NOW_MS });

    assert.equal(snapshot.severity, "warning");
    assert.ok(snapshot.warnings.some((w) => w.includes("Requeued")));
  });

  it("builds age buckets for active tasks", () => {
    const tasks: TaskRecord[] = [
      makeTask({ status: "queued", createdAt: "2026-05-13T05:55:00.000Z" }), // 5 min old → < 15 min
      makeTask({ status: "queued", createdAt: "2026-05-13T04:30:00.000Z" }), // 1.5 hr → 1–4 hr
      makeTask({ status: "claimed", createdAt: "2026-05-12T06:00:00.000Z" }), // 24 hr → > 24 hr
    ];

    const snapshot = buildQueueHygieneSnapshot({ tasks, nowMs: NOW_MS });

    assert.ok(snapshot.ageBuckets.length > 0);
    assert.ok(snapshot.ageBuckets.some((b) => b.label === "> 24 hr" && b.count === 1));
  });

  it("handles missing createdAt gracefully and surfaces stale-residue timestamp anomalies", () => {
    const tasks: TaskRecord[] = [
      makeTask({ id: "bad-created-at-1", status: "queued", createdAt: "" }),
      makeTask({ id: "bad-created-at-2", status: "claimed", createdAt: "not-a-date" }),
    ];

    const snapshot = buildQueueHygieneSnapshot({ tasks, nowMs: NOW_MS });

    // Tasks with unparseable dates contribute to counts but not age metrics
    const queued = snapshot.byStatus.find((s) => s.status === "queued")!;
    assert.equal(queued.count, 1);
    assert.equal(queued.oldestAgeMs, null);
    assert.equal(snapshot.severity, "warning");
    assert.deepEqual(snapshot.timestampAnomalies.invalidCreatedAtTaskIds, ["bad-created-at-1", "bad-created-at-2"]);
    assert.ok(snapshot.warnings.some((w) => w.includes("Timestamp anomalies")));
  });

  it("warns when active task timestamps are future-dated", () => {
    const snapshot = buildQueueHygieneSnapshot({
      tasks: [makeTask({ id: "future-task", status: "running", createdAt: "2026-05-13T06:05:00.000Z" })],
      nowMs: NOW_MS,
    });

    assert.equal(snapshot.severity, "warning");
    assert.deepEqual(snapshot.timestampAnomalies.futureCreatedAtTaskIds, ["future-task"]);
    assert.ok(snapshot.warnings.some((w) => w.includes("futureCreatedAt=1")));
  });

  it("produces empty age buckets when no active tasks", () => {
    const tasks: TaskRecord[] = [
      makeTask({ status: "succeeded" }),
      makeTask({ status: "failed" }),
    ];

    const snapshot = buildQueueHygieneSnapshot({ tasks, nowMs: NOW_MS });

    assert.equal(snapshot.ageBuckets.length, 0);
    assert.equal(snapshot.activeTasks, 0);
  });

  it("exposes sample task ids for requeued tasks", () => {
    const tasks: TaskRecord[] = [
      makeTask({ id: "replayable-1", status: "failed", requeueCount: 2 }),
      makeTask({ id: "replayable-2", status: "queued", requeueCount: 1 }),
    ];

    const snapshot = buildQueueHygieneSnapshot({ tasks, nowMs: NOW_MS });

    assert.deepEqual(snapshot.requeue.sampleTaskIds, ["replayable-1", "replayable-2"]);
  });

  it("warns on queue pressure when queued-to-claimed+running ratio is high", () => {
    const tasks: TaskRecord[] = [
      ...Array.from({ length: 40 }, () => makeTask({ status: "queued" })),
      makeTask({ status: "claimed" }),
      makeTask({ status: "running" }),
    ];

    const snapshot = buildQueueHygieneSnapshot({ tasks, nowMs: NOW_MS });

    // 40 queued / 2 claimed+running = 20 > 3.0 default
    assert.equal(snapshot.severity, "warning");
    assert.ok(snapshot.warnings.some((w) => w.includes("Queue depth")));
  });

  it("respects custom thresholds", () => {
    const tasks: TaskRecord[] = Array.from(
      { length: 5 },
      () => makeTask({ status: "queued" }),
    );

    const snapshot = buildQueueHygieneSnapshot({
      tasks,
      nowMs: NOW_MS,
      thresholds: { activeTaskWarning: 3 },
    });

    assert.equal(snapshot.severity, "warning");
  });

  it("deterministic: same input → same output", () => {
    const tasks: TaskRecord[] = [
      makeTask({ id: "t1", status: "queued", createdAt: "2026-05-13T05:00:00.000Z", requeueCount: 0 }),
      makeTask({ id: "t2", status: "claimed", createdAt: "2026-05-13T05:30:00.000Z", requeueCount: 1 }),
      makeTask({ id: "t3", status: "succeeded", createdAt: "2026-05-13T04:00:00.000Z", requeueCount: 0 }),
    ];

    const a = buildQueueHygieneSnapshot({ tasks, nowMs: NOW_MS, generatedAt: "2026-05-13T06:00:00.000Z" });
    const b = buildQueueHygieneSnapshot({ tasks, nowMs: NOW_MS, generatedAt: "2026-05-13T06:00:00.000Z" });

    assert.deepEqual(a.severity, b.severity);
    assert.deepEqual(a.warnings, b.warnings);
    assert.deepEqual(a.activeTasks, b.activeTasks);
    assert.deepEqual(a.requeue, b.requeue);
  });
});
