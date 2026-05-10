import test from "node:test";
import assert from "node:assert/strict";

import { buildReleaseEvidenceExport, renderReleaseEvidenceMarkdown } from "./release-evidence.js";
import type { TaskRecord, TaskStatus } from "./types.js";

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task-1",
    intent: "propose_patch",
    requester: { id: "operator", kind: "user", role: "operator" },
    target: { id: "dungae", kind: "node", role: "analyst" },
    targetNodeId: "dungae",
    assignedWorkerId: "dungae",
    payload: { issue: 479, issueUrl: "https://github.com/jinwon-int/a2a-broker/issues/479" },
    status: "queued",
    createdAt: "2026-05-10T13:30:00.000Z",
    updatedAt: "2026-05-10T13:31:00.000Z",
    taskOrigin: "github",
    ...overrides,
  };
}

function terminal(id: string, status: TaskStatus, output: Record<string, unknown>): TaskRecord {
  return task({
    id,
    status,
    claimedBy: "dungae",
    completedAt: "2026-05-10T13:35:00.000Z",
    updatedAt: "2026-05-10T13:35:00.000Z",
    result: { output },
  });
}

test("release evidence export summarizes PR, Done, Block, and missing terminal evidence", () => {
  const report = buildReleaseEvidenceExport([
    terminal("task-pr", "succeeded", { github: { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/501" } }),
    terminal("task-done", "succeeded", { doneCommentUrl: "https://github.com/jinwon-int/a2a-broker/issues/479#issuecomment-4415413329" }),
    terminal("task-block", "failed", { github: { blockCommentUrl: "https://github.com/jinwon-int/a2a-broker/issues/479#issuecomment-4415413330" } }),
    task({ id: "task-active", status: "running" }),
    task({ id: "task-missing", status: "failed", error: { message: "runner exited" } }),
  ], {
    generatedAt: "2026-05-10T13:40:00.000Z",
    repo: "jinwon-int/a2a-broker",
    issue: "#479",
    parentIssue: "jinwon-int/a2a-plane#197",
    runId: "a2a-source-dryrun-orchestrator-20260510T133022Z",
  });

  assert.equal(report.kind, "broker.release-evidence.export");
  assert.equal(report.mode, "dry-run/read-only");
  assert.equal(report.readOnly, true);
  assert.equal(report.gates.liveActionAllowed, false);
  assert.equal(report.gates.mutationAllowed, false);
  assert.equal(report.gates.ok, false, "missing terminal evidence should block closeout");
  assert.deepEqual(report.taskSummary, {
    total: 5,
    active: 1,
    terminal: 4,
    byStatus: {
      blocked: 0,
      queued: 0,
      claimed: 0,
      running: 1,
      succeeded: 2,
      failed: 2,
      canceled: 0,
    },
  });
  assert.equal(report.evidenceSummary.pr, 1);
  assert.equal(report.evidenceSummary.done, 1);
  assert.equal(report.evidenceSummary.block, 1);
  assert.equal(report.evidenceSummary.missing, 1);
  assert.deepEqual(report.links.pullRequests, ["https://github.com/jinwon-int/a2a-broker/pull/501"]);
  assert.deepEqual(report.links.doneComments, ["https://github.com/jinwon-int/a2a-broker/issues/479#issuecomment-4415413329"]);
  assert.deepEqual(report.links.blockComments, ["https://github.com/jinwon-int/a2a-broker/issues/479#issuecomment-4415413330"]);

  const markdown = renderReleaseEvidenceMarkdown(report);
  assert.match(markdown, /^Block: broker read-only release evidence export/);
  assert.match(markdown, /liveActionAllowed=false mutationAllowed=false/);
});

test("release evidence export redacts unsafe local paths and secret-like values", () => {
  const report = buildReleaseEvidenceExport([
    terminal("/work/repo/token-task", "succeeded", {
      github: {
        prUrl: "file:///work/repo/private-token.log",
        doneCommentUrl: "https://github.com/jinwon-int/a2a-broker/issues/479#issuecomment-4415413329",
        branchUrl: "https://github.com/jinwon-int/a2a-broker/tree/BROKER_EDGE_SECRET=oops",
      },
    }),
  ], { runId: "safe-run" });

  assert.equal(report.items[0]?.taskId, "<redacted>");
  assert.equal(report.items[0]?.evidenceKind, "done");
  assert.equal(report.items[0]?.prUrl, undefined);
  assert.equal(report.items[0]?.branchUrl, undefined);

  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /\/work\/repo|private-token|BROKER_EDGE_SECRET|oops/i);
});

test("release evidence export blocks when observed no-live safety flags are set", () => {
  const report = buildReleaseEvidenceExport([
    terminal("task-done", "succeeded", { doneCommentUrl: "https://github.com/jinwon-int/a2a-broker/issues/479#issuecomment-4415413329" }),
  ], { observedActions: { providerCalled: true } });

  assert.equal(report.gates.ok, false);
  assert.equal(report.gates.observedActions.providerCalled, true);
});
