import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  reconcileRoundCloseout,
  reconcileRoundCloseoutFromTerminalOutbox,
  terminalRoundKey,
  type RoundWorkerObservation,
} from "./round-closeout-reconcile.js";

const NOW = Date.parse("2026-05-02T09:00:00.000Z");
const FRESH = "2026-05-02T08:55:00.000Z";
const STALE = "2026-05-02T08:00:00.000Z";
const EXPECTED = ["bangtong", "dungae", "sogyo", "nosuk", "yukson"];
const EXCLUDED = ["yukson"];

function obs(overrides: Partial<RoundWorkerObservation> & { workerId: string }): RoundWorkerObservation {
  return {
    status: "running",
    updatedAt: FRESH,
    ...overrides,
  };
}

function reconcile(observations: RoundWorkerObservation[]) {
  return reconcileRoundCloseout(observations, {
    expectedWorkers: EXPECTED,
    excludedWorkers: EXCLUDED,
    nowMs: NOW,
    staleAfterMs: 30 * 60 * 1000,
  });
}

function terminalEvent(
  worker: string,
  status: "succeeded" | "failed" | "canceled" | "blocked",
  overrides: Record<string, unknown> = {},
) {
  const run = typeof overrides.run === "string" ? overrides.run : "a2a-terminal-push-20260504015650";
  return {
    id: `terminal:${worker}:${status}`,
    kind: "task.terminal",
    taskEventId: 1,
    payload: {
      taskId: `task-${worker}`,
      status,
      worker,
      run,
      traceId: "trace-round-315",
      repo: "jinwon-int/a2a-broker",
      issue: 315,
      createdAt: FRESH,
      updatedAt: FRESH,
      completedAt: FRESH,
      ...overrides,
    },
    createdAt: FRESH,
    receipt: { status: "accepted", updatedAt: FRESH },
    attempts: 0,
  } as const;
}

function reportToPayloadSample() {
  return {
    taskId: "task-bangtong",
    status: "succeeded",
    worker: "bangtong",
    repo: "jinwon-int/a2a-broker",
    issue: 315,
    createdAt: FRESH,
    updatedAt: FRESH,
  } as const;
}

describe("round closeout reconciliation", () => {
  it("is ready when all required workers succeeded with evidence and excluded worker is ignored", () => {
    const report = reconcile([
      obs({ workerId: "bangtong", status: "succeeded", evidence: { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/1" } }),
      obs({ workerId: "dungae", status: "succeeded", evidence: { doneCommentUrl: "https://github.com/jinwon-int/a2a-broker/issues/243#issuecomment-1" } }),
      obs({ workerId: "sogyo", status: "succeeded", evidence: { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/2" } }),
      obs({ workerId: "nosuk", status: "succeeded", evidence: { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/3" } }),
      obs({ workerId: "yukson", status: "running", updatedAt: STALE }),
    ]);

    assert.equal(report.state, "ready");
    assert.equal(report.counts.required, 4);
    assert.equal(report.counts.completed, 4);
    assert.equal(report.counts.excluded, 1);
    assert.equal(report.workers.find((worker) => worker.workerId === "yukson")?.state, "excluded");
  });

  it("prioritizes missing terminal evidence before stuck and blocked states", () => {
    const report = reconcile([
      obs({ workerId: "bangtong", status: "succeeded" }),
      obs({ workerId: "dungae", status: "running", updatedAt: STALE }),
      obs({ workerId: "sogyo", status: "failed", evidence: { blockCommentUrl: "https://github.com/jinwon-int/a2a-broker/issues/243#issuecomment-2" } }),
      obs({ workerId: "nosuk", status: "succeeded", evidence: { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/4" } }),
    ]);

    assert.equal(report.state, "needs-evidence");
    assert.equal(report.counts.missingEvidence, 1);
    assert.equal(report.counts.stuck, 1);
    assert.equal(report.counts.blocked, 1);
    assert.match(report.action, /Recover or post missing evidence/);
    assert.equal(report.workers.find((worker) => worker.workerId === "bangtong")?.state, "missing-evidence");
  });

  it("treats branch-only evidence as recovery evidence only for failed lanes", () => {
    const report = reconcile([
      obs({ workerId: "bangtong", status: "failed", evidence: { branchUrl: "https://github.com/jinwon-int/a2a-broker/tree/a2a-patch-recovered" } }),
      obs({ workerId: "dungae", status: "succeeded", evidence: { branchUrl: "https://github.com/jinwon-int/a2a-broker/tree/a2a-patch-no-pr" } }),
      obs({ workerId: "sogyo", status: "succeeded", evidence: { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/44" } }),
      obs({ workerId: "nosuk", status: "succeeded", evidence: { doneCommentUrl: "https://github.com/jinwon-int/a2a-broker/issues/243#issuecomment-done" } }),
    ]);

    assert.equal(report.state, "needs-evidence");
    assert.equal(report.counts.blocked, 1);
    assert.equal(report.counts.missingEvidence, 1);
    const failed = report.workers.find((worker) => worker.workerId === "bangtong");
    assert.equal(failed?.state, "blocked");
    assert.equal(failed?.evidenceUrl, "https://github.com/jinwon-int/a2a-broker/tree/a2a-patch-recovered");
    assert.match(failed?.action ?? "", /Inspect recovered branch evidence/);
    const succeeded = report.workers.find((worker) => worker.workerId === "dungae");
    assert.equal(succeeded?.state, "missing-evidence");
    assert.match(succeeded?.reason ?? "", /branch-only evidence is not completion evidence/);
  });

  it("marks fresh active or missing observations as waiting", () => {
    const report = reconcile([
      obs({ workerId: "bangtong", status: "running", updatedAt: FRESH }),
      obs({ workerId: "dungae", status: "claimed", updatedAt: FRESH }),
      obs({ workerId: "sogyo", status: "succeeded", evidence: { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/5" } }),
    ]);

    assert.equal(report.state, "waiting");
    assert.equal(report.counts.waiting, 3);
    assert.equal(report.workers.find((worker) => worker.workerId === "nosuk")?.reason, "No task observation found for required worker.");
  });

  it("uses the latest observation per worker", () => {
    const report = reconcile([
      obs({ workerId: "bangtong", status: "running", updatedAt: STALE }),
      obs({ workerId: "bangtong", status: "succeeded", updatedAt: FRESH, evidence: { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/6" } }),
      obs({ workerId: "dungae", status: "succeeded", evidence: { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/7" } }),
      obs({ workerId: "sogyo", status: "succeeded", evidence: { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/8" } }),
      obs({ workerId: "nosuk", status: "succeeded", evidence: { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/9" } }),
    ]);

    assert.equal(report.state, "ready");
    assert.equal(report.workers.find((worker) => worker.workerId === "bangtong")?.state, "completed");
  });

  it("aggregates terminal outbox events into a mixed round closeout without cron", () => {
    const report = reconcileRoundCloseoutFromTerminalOutbox([
      terminalEvent("bangtong", "succeeded", {
        taskDescription: "Patch terminal push projection",
        prUrl: "https://github.com/jinwon-int/a2a-broker/pull/3151",
      }),
      terminalEvent("dungae", "succeeded", {
        taskDescription: "Add operator summary tests",
        doneUrl: "https://github.com/jinwon-int/a2a-broker/issues/315#issuecomment-done",
      }),
      terminalEvent("sogyo", "blocked", {
        taskDescription: "Validate notifier ACK path",
        blockUrl: "https://github.com/jinwon-int/a2a-broker/issues/315#issuecomment-block",
      }),
      terminalEvent("unrelated", "succeeded", { run: "other-round", prUrl: "https://github.com/jinwon-int/a2a-broker/pull/999" }),
    ], {
      expectedWorkers: ["bangtong", "dungae", "sogyo", "nosuk"],
      run: "a2a-terminal-push-20260504015650",
      nowMs: NOW,
      staleAfterMs: 30 * 60 * 1000,
    });

    assert.equal(report.state, "blocked");
    assert.equal(report.counts.completed, 2);
    assert.equal(report.counts.blocked, 1);
    assert.equal(report.counts.waiting, 1);
    assert.deepEqual(report.workerSummaries.map((worker) => `${worker.workerId}:${worker.status}`), [
      "bangtong:completed",
      "dungae:completed",
      "sogyo:blocked",
      "nosuk:pending",
    ]);
    assert.equal(report.workerSummaries.find((worker) => worker.workerId === "sogyo")?.taskDescription, "Validate notifier ACK path");
  });

  it("marks a terminal outbox round ready only when all workers have PR evidence", () => {
    const report = reconcileRoundCloseoutFromTerminalOutbox([
      terminalEvent("bangtong", "succeeded", { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/401", taskDescription: "Fix fan-in" }),
      terminalEvent("dungae", "succeeded", { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/402", taskDescription: "Fix projection" }),
      terminalEvent("sogyo", "succeeded", { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/403", taskDescription: "Fix summary" }),
    ], {
      expectedWorkers: ["bangtong", "dungae", "sogyo"],
      traceId: "trace-round-315",
      nowMs: NOW,
    });

    assert.equal(report.state, "ready");
    assert.equal(report.counts.completed, 3);
    assert.equal(report.counts.waiting, 0);
    assert.deepEqual(report.workerSummaries.map((worker) => worker.status), ["completed", "completed", "completed"]);
    assert.equal(terminalRoundKey(reportToPayloadSample()), "issue:jinwon-int/a2a-broker#315");
  });

  it("scopes observations by task id prefix or issue set", () => {
    const report = reconcileRoundCloseout([
      obs({ workerId: "bangtong", taskId: "r1-bangtong", issueNumber: 241, status: "succeeded", evidence: { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/10" } }),
      obs({ workerId: "dungae", taskId: "other-dungae", issueNumber: 243, status: "succeeded", evidence: { doneCommentUrl: "https://github.com/jinwon-int/a2a-broker/issues/243#issuecomment-10" } }),
      obs({ workerId: "sogyo", taskId: "other-sogyo", issueNumber: 999, status: "succeeded", evidence: { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/11" } }),
    ], {
      expectedWorkers: ["bangtong", "dungae", "sogyo"],
      roundLabel: "a2a-hardening-r1",
      taskIdPrefix: "r1-",
      issueNumbers: [243],
      nowMs: NOW,
      staleAfterMs: 30 * 60 * 1000,
    });

    assert.equal(report.roundLabel, "a2a-hardening-r1");
    assert.deepEqual(report.issueNumbers, [243]);
    assert.equal(report.counts.completed, 2);
    assert.equal(report.counts.waiting, 1);
    assert.equal(report.workers.find((worker) => worker.workerId === "sogyo")?.state, "waiting");
  });
});

describe("broker exit condition classification (issue #471)", () => {
  it("classifies succeeded with prUrl as pr_success", () => {
    const report = reconcile([
      obs({ workerId: "bangtong", status: "succeeded", evidence: { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/100" } }),
      obs({ workerId: "dungae", status: "succeeded", evidence: { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/101" } }),
      obs({ workerId: "sogyo", status: "succeeded", evidence: { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/102" } }),
      obs({ workerId: "nosuk", status: "succeeded", evidence: { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/103" } }),
    ]);

    assert.equal(report.state, "ready");
    for (const worker of report.workers.filter((w) => w.required)) {
      assert.equal(worker.outcomeClass, "pr_success");
    }
  });

  it("classifies succeeded with doneCommentUrl but no prUrl as no_change_done", () => {
    const report = reconcile([
      obs({ workerId: "bangtong", status: "succeeded", evidence: { doneCommentUrl: "https://github.com/jinwon-int/a2a-broker/issues/471#issuecomment-done" } }),
      obs({ workerId: "dungae", status: "succeeded", evidence: { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/200" } }),
      obs({ workerId: "sogyo", status: "succeeded", evidence: { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/201" } }),
      obs({ workerId: "nosuk", status: "succeeded", evidence: { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/202" } }),
    ]);

    assert.equal(report.state, "ready");
    assert.equal(report.workers.find((w) => w.workerId === "bangtong")?.outcomeClass, "no_change_done");
    assert.equal(report.workers.find((w) => w.workerId === "dungae")?.outcomeClass, "pr_success");
  });

  it("classifies failed with blockCommentUrl as no_change_block", () => {
    const report = reconcile([
      obs({ workerId: "bangtong", status: "failed", evidence: { blockCommentUrl: "https://github.com/jinwon-int/a2a-broker/issues/471#issuecomment-block" } }),
      obs({ workerId: "dungae", status: "succeeded", evidence: { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/300" } }),
      obs({ workerId: "sogyo", status: "succeeded", evidence: { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/301" } }),
      obs({ workerId: "nosuk", status: "succeeded", evidence: { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/302" } }),
    ]);

    assert.equal(report.state, "blocked");
    assert.equal(report.workers.find((w) => w.workerId === "bangtong")?.outcomeClass, "no_change_block");
    assert.equal(report.workers.find((w) => w.workerId === "bangtong")?.state, "blocked");
  });

  it("classifies failed with no evidence as infra_failure", () => {
    const report = reconcile([
      obs({ workerId: "bangtong", status: "failed" }),
      obs({ workerId: "dungae", status: "succeeded", evidence: { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/400" } }),
      obs({ workerId: "sogyo", status: "succeeded", evidence: { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/401" } }),
      obs({ workerId: "nosuk", status: "succeeded", evidence: { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/402" } }),
    ]);

    assert.equal(report.state, "needs-evidence");
    assert.equal(report.workers.find((w) => w.workerId === "bangtong")?.outcomeClass, "infra_failure");
    assert.equal(report.workers.find((w) => w.workerId === "bangtong")?.state, "missing-evidence");
  });

  it("classifies canceled with blockCommentUrl as no_change_block", () => {
    const report = reconcile([
      obs({ workerId: "bangtong", status: "canceled", evidence: { blockCommentUrl: "https://github.com/jinwon-int/a2a-broker/issues/471#issuecomment-block" } }),
      obs({ workerId: "dungae", status: "succeeded", evidence: { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/500" } }),
      obs({ workerId: "sogyo", status: "succeeded", evidence: { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/501" } }),
      obs({ workerId: "nosuk", status: "succeeded", evidence: { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/502" } }),
    ]);

    assert.equal(report.state, "blocked");
    assert.equal(report.workers.find((w) => w.workerId === "bangtong")?.outcomeClass, "no_change_block");
  });

  it("leaves outcomeClass undefined for non-terminal workers", () => {
    const report = reconcile([
      obs({ workerId: "bangtong", status: "running", updatedAt: FRESH }),
      obs({ workerId: "dungae", status: "running", updatedAt: FRESH }),
      obs({ workerId: "sogyo", status: "succeeded", evidence: { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/600" } }),
      obs({ workerId: "nosuk", status: "succeeded", evidence: { prUrl: "https://github.com/jinwon-int/a2a-broker/pull/601" } }),
    ]);

    assert.equal(report.state, "waiting");
    assert.equal(report.workers.find((w) => w.workerId === "bangtong")?.outcomeClass, undefined);
    assert.equal(report.workers.find((w) => w.workerId === "sogyo")?.outcomeClass, "pr_success");
  });

  it("classifies terminal outbox events with correct exit conditions", () => {
    const report = reconcileRoundCloseoutFromTerminalOutbox([
      terminalEvent("bangtong", "succeeded", {
        prUrl: "https://github.com/jinwon-int/a2a-broker/pull/700",
        taskDescription: "PR success task",
      }),
      terminalEvent("dungae", "succeeded", {
        doneUrl: "https://github.com/jinwon-int/a2a-broker/issues/471#issuecomment-done",
        taskDescription: "No-change done task",
      }),
      terminalEvent("sogyo", "blocked", {
        blockUrl: "https://github.com/jinwon-int/a2a-broker/issues/471#issuecomment-block",
        taskDescription: "No-change block task",
      }),
      terminalEvent("nosuk", "failed", {
        taskDescription: "Infra failure task",
      }),
    ], {
      expectedWorkers: ["bangtong", "dungae", "sogyo", "nosuk"],
      run: "a2a-terminal-push-20260504015650",
      nowMs: NOW,
      staleAfterMs: 30 * 60 * 1000,
    });

    assert.equal(report.state, "needs-evidence");
    assert.equal(report.workers.find((w) => w.workerId === "bangtong")?.outcomeClass, "pr_success");
    assert.equal(report.workers.find((w) => w.workerId === "dungae")?.outcomeClass, "no_change_done");
    assert.equal(report.workers.find((w) => w.workerId === "sogyo")?.outcomeClass, "no_change_block");
    assert.equal(report.workers.find((w) => w.workerId === "nosuk")?.outcomeClass, "infra_failure");
  });
});
