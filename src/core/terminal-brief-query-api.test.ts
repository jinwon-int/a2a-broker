/**
 * Tests for the Terminal Brief bounded query and export API.
 *
 * Covers filtering, cursor pagination, exports (JSON, compact-round-up,
 * markdown-summary), round summaries, worker listing, and safety bounds.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  TerminalTaskEventOutbox,
  type TerminalTaskOutboxEvent,
} from "./terminal-event-outbox.js";
import {
  queryTerminalBriefEvents,
  countTerminalBriefEvents,
  getTerminalBriefEvent,
  exportTerminalBriefEvents,
  summarizeTerminalBriefRounds,
  listTerminalBriefWorkers,
} from "./terminal-brief-query-api.js";
import type { TaskRecord, TaskStatus } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<TaskRecord> & { id: string; status: TaskStatus }): TaskRecord {
  const now = new Date().toISOString();
  return {
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    completedAt: overrides.completedAt ?? now,
    payload: overrides.payload ?? {},
    result: overrides.result ?? {},
    ...overrides,
  } as TaskRecord;
}

function makeTerminalEvent(
  id: string,
  overrides: Partial<TerminalTaskOutboxEvent> = {},
): TerminalTaskOutboxEvent {
  const now = new Date().toISOString();
  return {
    id,
    kind: "task.terminal",
    taskEventId: 0,
    payload: {
      taskId: id,
      status: "succeeded",
      createdAt: now,
      updatedAt: now,
      completedAt: now,
      ...overrides.payload,
    },
    createdAt: now,
    receipt: {
      status: "accepted",
      updatedAt: now,
    },
    attempts: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Seeds for query tests
// ---------------------------------------------------------------------------

function seedOutbox(): TerminalTaskEventOutbox {
  const outbox = new TerminalTaskEventOutbox();
  const tasks: TaskRecord[] = [
    makeTask({ id: "task-1", status: "succeeded", payload: { worker: "seoseo", parentRoundId: "round-a", parentRoundTotal: 3, parentRoundOrder: 1, run: "round-a" } }),
    makeTask({ id: "task-2", status: "succeeded", payload: { worker: "dungae", parentRoundId: "round-a", parentRoundTotal: 3, parentRoundOrder: 2, run: "round-a" } }),
    makeTask({ id: "task-3", status: "failed", payload: { worker: "bangtong", parentRoundId: "round-a", parentRoundTotal: 3, parentRoundOrder: 3, run: "round-a" } }),
    makeTask({ id: "task-4", status: "succeeded", payload: { worker: "gwakga", parentRoundId: "round-b", parentRoundTotal: 1, parentRoundOrder: 1, run: "round-b" } }),
    makeTask({ id: "task-5", status: "canceled", payload: { worker: "seoseo", parentRoundId: "round-c", parentRoundTotal: 2, parentRoundOrder: 1, run: "round-c" } }),
  ];

  for (const task of tasks) {
    outbox.enqueue(
      { id: 1, kind: task.status, taskId: task.id, timestamp: new Date().toISOString(), status: task.status } as any,
      task,
    );
  }

  // ACK task-1
  const event1 = outbox.snapshot().find((eventTarget) => eventTarget.payload.taskId === "task-1");
  if (event1) {
    outbox.acknowledge(event1.id, {
      evidence: "operator_visible",
      acknowledgedAt: new Date().toISOString(),
      note: "operator confirmed",
    });
  }

  return outbox;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("queryTerminalBriefEvents returns all events when no filter is applied", () => {
  const outbox = seedOutbox();
  const result = queryTerminalBriefEvents(outbox);
  assert.equal(result.events.length, 5);
  assert.ok(result.totalMatching >= 5);
});

test("queryTerminalBriefEvents paginates with cursor", () => {
  const outbox = seedOutbox();
  const page1 = queryTerminalBriefEvents(outbox, {}, {}, 2);
  assert.equal(page1.events.length, 2);
  assert.ok(page1.nextCursor);

  const page2 = queryTerminalBriefEvents(outbox, {}, { afterId: page1.nextCursor! }, 2);
  assert.equal(page2.events.length, 2);
  assert.ok(page2.nextCursor);

  const page3 = queryTerminalBriefEvents(outbox, {}, { afterId: page2.nextCursor! }, 2);
  assert.equal(page3.events.length, 1);
});

test("queryTerminalBriefEvents filters by parentRoundId", () => {
  const outbox = seedOutbox();
  const result = queryTerminalBriefEvents(outbox, { parentRoundId: "round-a" });
  assert.equal(result.events.length, 3);
  for (const event of result.events) {
    assert.equal(event.parentRoundId, "round-a");
  }
});

test("queryTerminalBriefEvents filters by worker", () => {
  const outbox = seedOutbox();
  const result = queryTerminalBriefEvents(outbox, { worker: "seoseo" });
  assert.equal(result.events.length, 2);
  for (const event of result.events) {
    assert.equal(event.worker, "seoseo");
  }
});

test("queryTerminalBriefEvents filters by acked status", () => {
  const outbox = seedOutbox();
  const acked = queryTerminalBriefEvents(outbox, { acked: true });
  assert.equal(acked.events.length, 1);
  assert.equal(acked.events[0]!.taskId, "task-1");
  assert.ok(acked.events[0]!.receiptConfirmed);

  const unacked = queryTerminalBriefEvents(outbox, { unacked: true });
  assert.equal(unacked.events.length, 4);
  for (const event of unacked.events) {
    assert.equal(event.receiptConfirmed, false);
  }
});

test("queryTerminalBriefEvents filters by errored status", () => {
  const outbox = seedOutbox();
  const result = queryTerminalBriefEvents(outbox, { errored: true });
  // task-3 (failed) and task-5 (canceled) — errors include failed/timed_out/stale
  assert.equal(result.events.length, 2);
});

test("queryTerminalBriefEvents filters by task status", () => {
  const outbox = seedOutbox();
  const succeeded = queryTerminalBriefEvents(outbox, { taskStatus: "succeeded" });
  assert.equal(succeeded.events.length, 3);

  const failed = queryTerminalBriefEvents(outbox, { taskStatus: "failed" });
  assert.equal(failed.events.length, 1);
});

test("queryTerminalBriefEvents enforces limit bounds", () => {
  const outbox = seedOutbox();
  const result = queryTerminalBriefEvents(outbox, {}, {}, 300);
  // Should be capped at TERMINAL_BRIEF_QUERY_MAX_LIMIT (200), but since we
  // only have 5 events, all fit.
  assert.equal(result.events.length, 5);
  // Ensure negative limit defaults to 50
  const negResult = queryTerminalBriefEvents(outbox, {}, {}, -1);
  assert.ok(negResult.events.length <= 50);
});

test("countTerminalBriefEvents returns correct counts", () => {
  const outbox = seedOutbox();
  assert.equal(countTerminalBriefEvents(outbox), 5);
  assert.equal(countTerminalBriefEvents(outbox, { parentRoundId: "round-a" }), 3);
  assert.equal(countTerminalBriefEvents(outbox, { worker: "gwakga" }), 1);
});

test("getTerminalBriefEvent returns event by id", () => {
  const outbox = seedOutbox();
  const snapshot = outbox.snapshot();
  const target = snapshot[0]!;
  const result = getTerminalBriefEvent(outbox, target.id);
  assert.ok(result);
  assert.equal(result!.id, target.id);
});

test("getTerminalBriefEvent returns null for unknown id", () => {
  const outbox = seedOutbox();
  const result = getTerminalBriefEvent(outbox, "nonexistent");
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// Export tests
// ---------------------------------------------------------------------------

test("exportTerminalBriefEvents produces valid JSON", () => {
  const outbox = seedOutbox();
  const json = exportTerminalBriefEvents(outbox, {}, "json");
  const parsed = JSON.parse(json);
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed.length, 5);
  assert.ok(parsed[0]!.id);
  assert.ok(parsed[0]!.parentRoundId);
});

test("exportTerminalBriefEvents produces compact-round-up format", () => {
  const outbox = seedOutbox();
  const output = exportTerminalBriefEvents(outbox, {}, "compact-round-up");
  assert.ok(output.includes("✅"));
  assert.ok(output.includes("❌"));
  assert.ok(output.includes("○")); // unacked
  assert.ok(output.includes("seoseo") || output.includes("dungae") || output.includes("bangtong"));
});

test("exportTerminalBriefEvents produces markdown-summary format", () => {
  const outbox = seedOutbox();
  const output = exportTerminalBriefEvents(outbox, {}, "markdown-summary");
  assert.ok(output.includes("|"));
  assert.ok(output.includes("Worker"));
  assert.ok(output.includes("Status"));
  assert.ok(output.includes("ACK"));
});

test("exportTerminalBriefEvents respects filter and limit", () => {
  const outbox = seedOutbox();
  const output = exportTerminalBriefEvents(outbox, { parentRoundId: "round-a" }, "json", 2);
  const parsed = JSON.parse(output);
  assert.equal(parsed.length, 2);
});

test("exportTerminalBriefEvents returns empty indicator for no matches", () => {
  const outbox = seedOutbox();
  const markdown = exportTerminalBriefEvents(outbox, { parentRoundId: "round-nonexistent" }, "markdown-summary");
  assert.ok(markdown.includes("No terminal brief events"));
});

// ---------------------------------------------------------------------------
// Round summary tests
// ---------------------------------------------------------------------------

test("summarizeTerminalBriefRounds groups by parentRoundId", () => {
  const outbox = seedOutbox();
  const summaries = summarizeTerminalBriefRounds(outbox);
  // round-a (3 events), round-b (1), round-c (1)
  assert.equal(summaries.length, 3);

  const roundA = summaries.find((s) => s.parentRoundId === "round-a");
  assert.ok(roundA);
  assert.equal(roundA!.workerCount, 3);
  assert.equal(roundA!.completedCount, 2); // 2 succeeded
  assert.equal(roundA!.ackedCount, 1); // task-1 acked
  assert.equal(roundA!.failedCount, 1); // task-3 failed
  assert.equal(roundA!.pendingCount, 0); // task-3 is failed — errored/non-canonical workers are filtered from pending
  assert.equal(roundA!.isComplete, true); // no canonical pending tasks remain
});

test("summarizeTerminalBriefRounds respects maxRounds", () => {
  const outbox = seedOutbox();
  const summaries = summarizeTerminalBriefRounds(outbox, 1);
  assert.equal(summaries.length, 1);
});

// ---------------------------------------------------------------------------
// Worker list tests
// ---------------------------------------------------------------------------

test("listTerminalBriefWorkers returns unique workers", () => {
  const outbox = seedOutbox();
  const workers = listTerminalBriefWorkers(outbox);
  assert.ok(workers.includes("seoseo"));
  assert.ok(workers.includes("dungae"));
  assert.ok(workers.includes("bangtong"));
  assert.ok(workers.includes("gwakga"));
  assert.equal(workers.length, 4);
});

test("listTerminalBriefWorkers filters by parentRoundId", () => {
  const outbox = seedOutbox();
  const workers = listTerminalBriefWorkers(outbox, { parentRoundId: "round-a" });
  assert.equal(workers.length, 3);
  assert.ok(workers.includes("seoseo"));
  assert.ok(workers.includes("dungae"));
  assert.ok(workers.includes("bangtong"));
  assert.equal(workers.includes("gwakga"), false);
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test("empty outbox returns empty results", () => {
  const outbox = new TerminalTaskEventOutbox();
  const result = queryTerminalBriefEvents(outbox);
  assert.equal(result.events.length, 0);
  assert.equal(result.nextCursor, null);
  assert.equal(result.totalMatching, 0);

  const count = countTerminalBriefEvents(outbox);
  assert.equal(count, 0);
});

test("filters with no matches return empty", () => {
  const outbox = seedOutbox();
  const result = queryTerminalBriefEvents(outbox, { worker: "nonexistent" });
  assert.equal(result.events.length, 0);
  assert.equal(result.totalMatching, 0);
});

test("getTerminalBriefEvent fields are populated", () => {
  const outbox = seedOutbox();
  const snapshot = outbox.snapshot();
  const target = snapshot.find((eventTarget) => eventTarget.payload.taskId === "task-1");
  assert.ok(target);
  const result = getTerminalBriefEvent(outbox, target!.id);
  assert.ok(result);
  assert.equal(result!.status, "succeeded");
  assert.equal(result!.receiptConfirmed, true);
  assert.equal(result!.worker, "seoseo");
  assert.equal(result!.parentRoundId, "round-a");
});

test("compact-round-up on empty outbox returns fallback", () => {
  const outbox = new TerminalTaskEventOutbox();
  const output = exportTerminalBriefEvents(outbox, {}, "compact-round-up");
  assert.equal(output, "(no events)");
});

test("markdown-summary on empty outbox returns fallback", () => {
  const outbox = new TerminalTaskEventOutbox();
  const output = exportTerminalBriefEvents(outbox, {}, "markdown-summary");
  assert.ok(output.includes("No terminal brief events"));
});
