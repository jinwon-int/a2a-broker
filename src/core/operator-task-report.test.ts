import assert from "node:assert/strict";
import test from "node:test";

import { buildOperatorTaskReport } from "./operator-task-report.js";
import type { TaskRecord } from "./types.js";

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  const now = "2026-05-01T00:00:00.000Z";
  return {
    id: "task-1",
    intent: "propose_patch",
    requester: { id: "seoseo", role: "hub" },
    target: { id: "bangtong", role: "analyst" },
    message: "assignment",
    payload: { pullRequest: "#1", lane: "primary" },
    artifactIds: [],
    targetNodeId: "bangtong",
    assignedWorkerId: "bangtong",
    status: "queued",
    createdAt: now,
    updatedAt: now,
    taskOrigin: "github",
    ...overrides,
  };
}

test("operator task report marks stale active tasks as reportable", () => {
  const report = buildOperatorTaskReport([
    task({ id: "running-1", status: "running", updatedAt: "2026-05-01T00:00:00.000Z" }),
  ], {
    nowMs: Date.parse("2026-05-01T00:20:00.000Z"),
    staleAfterMs: 15 * 60 * 1000,
  });

  assert.equal(report.total, 1);
  assert.equal(report.active, 1);
  assert.equal(report.terminal, 0);
  assert.equal(report.stale, 1);
  assert.equal(report.reportable, 1);
  assert.equal(report.allTerminal, false);
  assert.equal(report.items[0].kind, "stale");
  assert.equal(report.items[0].reportable, true);
  assert.match(report.items[0].reportLine, /중간보고 필요/);
});

test("operator task report surfaces terminal GitHub evidence as result report", () => {
  const report = buildOperatorTaskReport([
    task({
      id: "done-1",
      status: "succeeded",
      completedAt: "2026-05-01T00:05:00.000Z",
      updatedAt: "2026-05-01T00:05:00.000Z",
      result: {
        summary: "opened PR",
        output: { github: { prUrl: "https://github.com/o/r/pull/123" } },
      },
    }),
  ], { nowMs: Date.parse("2026-05-01T00:06:00.000Z") });

  assert.equal(report.active, 0);
  assert.equal(report.terminal, 1);
  assert.equal(report.allTerminal, true);
  assert.equal(report.items[0].kind, "result");
  assert.equal(report.items[0].github?.prUrl, "https://github.com/o/r/pull/123");
  assert.match(report.items[0].reportLine, /완료/);
  assert.match(report.items[0].reportLine, /pull\/123/);
});

test("operator task report filters watched task ids and updatedAfter reportability", () => {
  const report = buildOperatorTaskReport([
    task({ id: "old", updatedAt: "2026-05-01T00:00:00.000Z" }),
    task({ id: "new", updatedAt: "2026-05-01T00:10:00.000Z" }),
    task({ id: "ignored", updatedAt: "2026-05-01T00:20:00.000Z" }),
  ], {
    taskIds: ["old", "new"],
    updatedAfter: "2026-05-01T00:05:00.000Z",
    nowMs: Date.parse("2026-05-01T00:11:00.000Z"),
    staleAfterMs: 60 * 60 * 1000,
  });

  assert.deepEqual(report.items.map((item) => item.taskId), ["new", "old"]);
  assert.equal(report.items.find((item) => item.taskId === "old")?.reportable, false);
  assert.equal(report.items.find((item) => item.taskId === "new")?.reportable, true);
  assert.equal(report.reportable, 1);
});
