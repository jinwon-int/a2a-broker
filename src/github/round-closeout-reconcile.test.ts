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
