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

test("operator task report exposes terminal receipt gap as first-class status", () => {
  const report = buildOperatorTaskReport([
    task({
      id: "receipt-gap-1",
      status: "succeeded",
      completedAt: "2026-05-01T00:05:00.000Z",
      updatedAt: "2026-05-01T00:05:00.000Z",
      result: {
        summary: "task terminal success",
        output: { prUrl: "https://github.com/o/r/pull/124" },
      },
    }),
  ], { nowMs: Date.parse("2026-05-01T00:06:00.000Z") });

  const item = report.items[0];
  assert.equal(item.status, "succeeded");
  assert.equal(item.receiptStatus, "accepted");
  assert.match(item.reportLine, /receipt gap: accepted/);
});

test("operator task report joins terminal outbox brief state for plugin/operator consumption", () => {
  const report = buildOperatorTaskReport([
    task({
      id: "brief-1",
      status: "succeeded",
      completedAt: "2026-05-01T00:05:00.000Z",
      updatedAt: "2026-05-01T00:05:00.000Z",
      result: {
        summary: "provider send succeeded only",
        output: { receipt: { status: "operator_visible" } },
      },
    }),
  ], {
    nowMs: Date.parse("2026-05-01T00:06:00.000Z"),
    terminalOutbox: [{
      id: "terminal:brief-1:succeeded:2026-05-01T00%3A05%3A00.000Z",
      kind: "task.terminal",
      taskEventId: 17,
      createdAt: "2026-05-01T00:05:00.000Z",
      attempts: 0,
      receipt: { status: "provider_sent", updatedAt: "2026-05-01T00:05:30.000Z" },
      ackAudit: {
        decision: "pending",
        reason: "provider send is not operator-visible ACK evidence",
        updatedAt: "2026-05-01T00:05:30.000Z",
        taskId: "brief-1",
        receiptStatus: "provider_sent",
      },
      payload: {
        taskId: "brief-1",
        status: "succeeded",
        worker: "dungae",
        repo: "jinwon-int/a2a-broker",
        issue: 384,
        taskBrief: "Broker event/outbox deploy-readiness",
        doneUrl: "https://github.com/jinwon-int/a2a-broker/issues/384#issuecomment-done",
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedAt: "2026-05-01T00:05:00.000Z",
        completedAt: "2026-05-01T00:05:00.000Z",
      },
    }],
  });

  const item = report.items[0];
  assert.equal(item.receiptStatus, "provider_sent");
  assert.equal(item.terminalBrief?.cursor, "terminal:brief-1:succeeded:2026-05-01T00%3A05%3A00.000Z");
  assert.equal(item.terminalBrief?.ackStatus, "unacknowledged");
  assert.equal(item.terminalBrief?.ackDecision, "pending");
  assert.equal(item.terminalBrief?.evidenceUrl, "https://github.com/jinwon-int/a2a-broker/issues/384#issuecomment-done");
  assert.match(item.reportLine, /receipt gap: provider_sent/);
});

test("operator task report distinguishes receipt confirmed and failed or stale receipt states", () => {
  const report = buildOperatorTaskReport([
    task({
      id: "receipt-visible-1",
      status: "succeeded",
      completedAt: "2026-05-01T00:05:00.000Z",
      updatedAt: "2026-05-01T00:05:00.000Z",
      result: { output: { receipt: { status: "operator_visible" } } },
    }),
    task({
      id: "receipt-failed-1",
      status: "succeeded",
      completedAt: "2026-05-01T00:06:00.000Z",
      updatedAt: "2026-05-01T00:06:00.000Z",
      result: { output: { receiptStatus: "failed" } },
    }),
    task({
      id: "receipt-timedout-1",
      status: "succeeded",
      completedAt: "2026-05-01T00:07:00.000Z",
      updatedAt: "2026-05-01T00:07:00.000Z",
      result: { output: { receiptStatus: "timed_out" } },
    }),
    task({
      id: "receipt-stale-1",
      status: "succeeded",
      completedAt: "2026-05-01T00:08:00.000Z",
      updatedAt: "2026-05-01T00:08:00.000Z",
      result: { output: { receiptStatus: "stale" } },
    }),
  ], { nowMs: Date.parse("2026-05-01T00:09:00.000Z") });

  const byId = new Map(report.items.map((item) => [item.taskId, item]));
  assert.equal(byId.get("receipt-visible-1")?.receiptStatus, "operator_visible");
  assert.equal(byId.get("receipt-failed-1")?.receiptStatus, "failed");
  assert.equal(byId.get("receipt-timedout-1")?.receiptStatus, "timed_out");
  assert.equal(byId.get("receipt-stale-1")?.receiptStatus, "stale");
  assert.doesNotMatch(byId.get("receipt-visible-1")!.reportLine, /receipt:/);
  assert.match(byId.get("receipt-failed-1")!.reportLine, /receipt gap: failed/);
  assert.match(byId.get("receipt-timedout-1")!.reportLine, /receipt gap: timed_out/);
  assert.match(byId.get("receipt-stale-1")!.reportLine, /receipt gap: stale/);
});

test("extracts enriched docker-runner evidence from result output", () => {
  const report = buildOperatorTaskReport([
    task({
      id: "docker-1",
      status: "succeeded",
      completedAt: "2026-05-01T00:05:00.000Z",
      updatedAt: "2026-05-01T00:05:00.000Z",
      result: {
        summary: "docker runner completed",
        output: {
          repo: "jinwon-int/a2a-broker",
          issue: "#203",
          issueUrl: "https://github.com/jinwon-int/a2a-broker/issues/203",
          nodeId: "dungae",
          taskId: "task-docker-1",
          prUrl: "https://github.com/jinwon-int/a2a-broker/pull/100",
        },
      },
    }),
  ], { nowMs: Date.parse("2026-05-01T00:06:00.000Z") });

  const github = report.items[0].github;
  assert.ok(github);
  assert.equal(github?.repo, "jinwon-int/a2a-broker");
  assert.equal(github?.issue, "#203");
  assert.equal(github?.issueUrl, "https://github.com/jinwon-int/a2a-broker/issues/203");
  assert.equal(github?.nodeId, "dungae");
  assert.equal(github?.taskId, "task-docker-1");
  assert.equal(github?.prUrl, "https://github.com/jinwon-int/a2a-broker/pull/100");
  // report line surfaces the scoped repo+issue label
  assert.match(report.items[0].reportLine, /jinwon-int\/a2a-broker#203/);
});

test("extracts evidence from top-level output fields (bridge path)", () => {
  const report = buildOperatorTaskReport([
    task({
      id: "bridge-1",
      status: "succeeded",
      completedAt: "2026-05-01T00:05:00.000Z",
      updatedAt: "2026-05-01T00:05:00.000Z",
      result: {
        summary: "bridge completed",
        output: {
          repo: "acme/platform",
          issue: "#7",
          issueUrl: "https://github.com/acme/platform/issues/7",
          nodeId: "worker-a",
          taskId: "task-bridge-1",
          doneCommentUrl: "https://github.com/acme/platform/issues/7#issuecomment-999",
        },
      },
    }),
  ], { nowMs: Date.parse("2026-05-01T00:06:00.000Z") });

  const github = report.items[0].github;
  assert.ok(github);
  assert.equal(github?.repo, "acme/platform");
  assert.equal(github?.doneCommentUrl, "https://github.com/acme/platform/issues/7#issuecomment-999");
  assert.match(report.items[0].reportLine, /acme\/platform#7/);
});

test("extracts evidence from nested github sub-object", () => {
  const report = buildOperatorTaskReport([
    task({
      id: "nested-1",
      status: "succeeded",
      completedAt: "2026-05-01T00:05:00.000Z",
      updatedAt: "2026-05-01T00:05:00.000Z",
      result: {
        summary: "done",
        output: {
          github: {
            repo: "acme/platform",
            issue: "#42",
            prUrl: "https://github.com/acme/platform/pull/42",
          },
        },
      },
    }),
  ], { nowMs: Date.parse("2026-05-01T00:06:00.000Z") });

  const github = report.items[0].github;
  assert.ok(github);
  assert.equal(github?.repo, "acme/platform");
  assert.equal(github?.prUrl, "https://github.com/acme/platform/pull/42");
  assert.match(report.items[0].reportLine, /acme\/platform#42/);
});

test("surfaces failed task with block evidence and issue scoping", () => {
  const report = buildOperatorTaskReport([
    task({
      id: "fail-1",
      status: "failed",
      completedAt: "2026-05-01T00:05:00.000Z",
      updatedAt: "2026-05-01T00:05:00.000Z",
      error: { code: "docker_runner_timeout", message: "runner timed out" },
      result: {
        output: {
          repo: "jinwon-int/a2a-broker",
          issue: "#203",
          issueUrl: "https://github.com/jinwon-int/a2a-broker/issues/203",
          nodeId: "dungae",
          blockCommentUrl: "https://github.com/jinwon-int/a2a-broker/issues/203#issuecomment-555",
        },
      },
    }),
  ], { nowMs: Date.parse("2026-05-01T00:06:00.000Z") });

  const github = report.items[0].github;
  assert.ok(github);
  assert.equal(github?.blockCommentUrl, "https://github.com/jinwon-int/a2a-broker/issues/203#issuecomment-555");
  assert.equal(github?.repo, "jinwon-int/a2a-broker");
  assert.match(report.items[0].reportLine, /실패/);
  assert.match(report.items[0].reportLine, /jinwon-int\/a2a-broker#203/);
});

test("projects partial GitHub evidence from failed docker runner details without raw stdout", () => {
  const report = buildOperatorTaskReport([
    task({
      id: "fail-partial-1",
      status: "failed",
      completedAt: "2026-05-01T00:05:00.000Z",
      updatedAt: "2026-05-01T00:05:00.000Z",
      error: {
        code: "docker_runner_failed",
        message: "runner evidence upload failed after agent completed",
        details: {
          runnerTask: {
            repo: "jinwon-int/a2a-broker",
            issue: "#208",
            issueUrl: "https://github.com/jinwon-int/a2a-broker/issues/208",
          },
          runnerResult: {
            ok: false,
            status: "failed",
            error: "github evidence step failed",
            stdout: "opened https://github.com/jinwon-int/a2a-broker/pull/321 from /work/repo and token ghp_should_not_leak",
            branchUrl: "https://github.com/jinwon-int/a2a-broker/tree/a2a-patch-208",
          },
        },
      },
    }),
  ], { nowMs: Date.parse("2026-05-01T00:06:00.000Z") });

  const item = report.items[0];
  assert.equal(item.status, "failed");
  assert.equal(item.github?.partial, true);
  assert.equal(item.github?.repo, "jinwon-int/a2a-broker");
  assert.equal(item.github?.issue, "#208");
  assert.equal(item.github?.prUrl, "https://github.com/jinwon-int/a2a-broker/pull/321");
  assert.equal(item.github?.branchUrl, "https://github.com/jinwon-int/a2a-broker/tree/a2a-patch-208");
  assert.match(item.nextAction ?? "", /review recovered PR evidence/);
  assert.doesNotMatch(JSON.stringify(item), /ghp_should_not_leak|\/work\/repo/);
});

test("returns undefined evidence when output has no GitHub fields", () => {
  const report = buildOperatorTaskReport([
    task({
      id: "no-evidence-1",
      status: "succeeded",
      completedAt: "2026-05-01T00:05:00.000Z",
      updatedAt: "2026-05-01T00:05:00.000Z",
      result: {
        summary: "all good but no github evidence",
        output: { someIrrelevantKey: true },
      },
    }),
  ], { nowMs: Date.parse("2026-05-01T00:06:00.000Z") });

  assert.equal(report.items[0].github, undefined);
  // report line still renders, just without the evidence label
  assert.match(report.items[0].reportLine, /완료/);
  assert.doesNotMatch(report.items[0].reportLine, /\[/);
});

test("extracts evidence with repo but no issue (graceful degredation)", () => {
  const report = buildOperatorTaskReport([
    task({
      id: "partial-1",
      status: "succeeded",
      completedAt: "2026-05-01T00:05:00.000Z",
      updatedAt: "2026-05-01T00:05:00.000Z",
      result: {
        summary: "done",
        output: {
          repo: "acme/platform",
          doneCommentUrl: "https://github.com/acme/platform/issues/7#issuecomment-111",
        },
      },
    }),
  ], { nowMs: Date.parse("2026-05-01T00:06:00.000Z") });

  assert.ok(report.items[0].github);
  assert.equal(report.items[0].github?.repo, "acme/platform");
  assert.equal(report.items[0].github?.issue, undefined);
  // shows repo label without issue number (graceful fallback)
  assert.match(report.items[0].reportLine, /\[acme\/platform\]/);
});

test("extracts issue number from issueUrl when issue field is missing", () => {
  const report = buildOperatorTaskReport([
    task({
      id: "url-1",
      status: "succeeded",
      completedAt: "2026-05-01T00:05:00.000Z",
      updatedAt: "2026-05-01T00:05:00.000Z",
      result: {
        summary: "done",
        output: {
          repo: "acme/platform",
          issueUrl: "https://github.com/acme/platform/issues/7",
          prUrl: "https://github.com/acme/platform/pull/42",
        },
      },
    }),
  ], { nowMs: Date.parse("2026-05-01T00:06:00.000Z") });

  assert.ok(report.items[0].github);
  assert.equal(report.items[0].github?.issue, undefined);
  assert.equal(report.items[0].github?.issueUrl, "https://github.com/acme/platform/issues/7");
  // parsed #7 from issueUrl
  assert.match(report.items[0].reportLine, /acme\/platform#7/);
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

test("operator task report filters by parent GitHub issue metadata", () => {
  const report = buildOperatorTaskReport([
    task({ id: "lane-1", payload: { parentIssue: "jinwon-int/a2a-broker#364", issue: "#367" } }),
    task({ id: "lane-2", payload: { parentIssueUrl: "https://github.com/jinwon-int/a2a-broker/issues/364", issue: "#368" } }),
    task({ id: "lane-3", message: "Parent: jinwon-int/a2a-broker#364\nIssue: #369" }),
    task({ id: "other", payload: { parentIssue: "jinwon-int/a2a-broker#360", issue: "#361" } }),
  ], {
    parentIssue: "https://github.com/jinwon-int/a2a-broker/issues/364",
    nowMs: Date.parse("2026-05-01T00:06:00.000Z"),
  });

  assert.deepEqual(report.items.map((item) => item.taskId), ["lane-1", "lane-2", "lane-3"]);
  assert.equal(report.total, 3);
});

test("operator task report combines explicit task ids with parent issue filter", () => {
  const report = buildOperatorTaskReport([
    task({ id: "wanted-parent", payload: { parentIssue: "jinwon-int/a2a-broker#364" } }),
    task({ id: "wanted-other", payload: { parentIssue: "jinwon-int/a2a-broker#360" } }),
    task({ id: "unlisted-parent", payload: { parentIssue: "jinwon-int/a2a-broker#364" } }),
  ], {
    taskIds: ["wanted-parent", "wanted-other"],
    parentIssue: "jinwon-int/a2a-broker#364",
    nowMs: Date.parse("2026-05-01T00:06:00.000Z"),
  });

  assert.deepEqual(report.items.map((item) => item.taskId), ["wanted-parent"]);
});
