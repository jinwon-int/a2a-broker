/**
 * Alert projection tests — Node built-in test runner.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { projectAlerts } from "./alert-projection.js";
import type {
  TaskDiagnosticReport,
  TaskRecord,
  TaskTombstone,
  WorkerRecord,
} from "./types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task-1",
    exchangeId: undefined,
    intent: "chat",
    requester: { id: "seoseo", kind: "node", role: "hub" },
    target: { id: "bangtong", kind: "node", role: "live-trader" },
    workspace: undefined,
    message: "test",
    proposalId: undefined,
    artifactIds: [],
    assignedWorkerId: "bangtong",
    via: undefined,
    policyContext: undefined,
    targetNodeId: "bangtong",
    payload: {},
    status: "running",
    claimedAt: new Date(Date.now() - 300_000).toISOString(),
    completedAt: undefined,
    claimedBy: "bangtong",
    result: undefined,
    error: undefined,
    requeueCount: 0,
    lastHeartbeatAt: new Date(Date.now() - 60_000).toISOString(),
    createdAt: new Date(Date.now() - 600_000).toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeReport(
  overrides: Partial<TaskDiagnosticReport> = {},
  taskOverrides: Partial<TaskRecord> = {},
): TaskDiagnosticReport {
  const task = makeTask(taskOverrides);
  return {
    taskId: task.id,
    diagnosticStatus: "active",
    brokerState: "healthy",
    reconcileNeeded: false,
    interruption: undefined,
    task,
    currentStatusDurationMs: 60_000,
    stalenessMs: undefined,
    brokerHints: {
      staleLease: false,
      staleWorker: false,
      cancellationRequested: false,
      requeued: false,
      lastRequeueAt: undefined,
      lastRequeueReason: undefined,
      workerLastSeenAt: undefined,
      tombstoneReason: undefined,
    },
    tombstone: undefined,
    lifecycle: {
      createdAt: task.createdAt,
      claimedAt: task.claimedAt,
      lastHeartbeatAt: task.lastHeartbeatAt,
    },
    ...overrides,
  };
}

function makeWorker(overrides: Partial<WorkerRecord> = {}): WorkerRecord {
  return {
    nodeId: "worker-a",
    role: "analyst",
    displayName: "Worker A",
    brokerUrl: undefined,
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: false,
      canPromoteLive: false,
      workspaceIds: ["test"],
      environments: ["research"],
    },
    metadata: undefined,
    createdAt: new Date(Date.now() - 600_000).toISOString(),
    updatedAt: new Date(Date.now() - 600_000).toISOString(),
    lastSeenAt: new Date(Date.now() - 60_000).toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("projectAlerts", () => {
  const nowMs = 1_000_000_000;

  it("returns empty alerts when all tasks are active", () => {
    const reports = [makeReport({ diagnosticStatus: "active" })];
    const result = projectAlerts(reports, { nowMs });
    assert.equal(result.alerts.length, 0);
    assert.equal(result.totalScanned, 1);
    assert.equal(result.counts.critical, 0);
    assert.equal(result.counts.warning, 0);
  });

  it("produces a warning alert for stale tasks under critical threshold", () => {
    const reports = [
      makeReport({
        diagnosticStatus: "stale",
        stalenessMs: 180_000,
        currentStatusDurationMs: 180_000,
      }),
    ];
    const result = projectAlerts(reports, { nowMs });
    assert.equal(result.alerts.length, 1);
    assert.equal(result.alerts[0]!.kind, "task_stale");
    assert.equal(result.alerts[0]!.severity, "warning");
    assert.equal(result.alerts[0]!.taskId, "task-1");
    assert.equal(result.counts.warning, 1);
  });

  it("produces a critical alert for stale tasks over critical threshold", () => {
    const reports = [
      makeReport({
        diagnosticStatus: "stale",
        stalenessMs: 700_000,
        currentStatusDurationMs: 700_000,
      }),
    ];
    const result = projectAlerts(reports, { nowMs });
    assert.equal(result.alerts.length, 1);
    assert.equal(result.alerts[0]!.severity, "critical");
  });

  it("produces a warning for long-running tasks", () => {
    const reports = [
      makeReport({
        diagnosticStatus: "long_running",
        currentStatusDurationMs: 5_400_000,
      }),
    ];
    const result = projectAlerts(reports, { nowMs });
    assert.equal(result.alerts.length, 1);
    assert.equal(result.alerts[0]!.kind, "task_long_running");
    assert.equal(result.alerts[0]!.severity, "warning");
  });

  it("produces a critical alert for very long-running tasks", () => {
    const reports = [
      makeReport({
        diagnosticStatus: "long_running",
        currentStatusDurationMs: 18_000_000,
      }),
    ];
    const result = projectAlerts(reports, { nowMs });
    assert.equal(result.alerts.length, 1);
    assert.equal(result.alerts[0]!.severity, "critical");
  });

  it("produces alert for dead-lettered tombstone", () => {
    const reports = [
      makeReport(
        {
          diagnosticStatus: "terminal",
          tombstone: {
            taskId: "task-1",
            terminalStatus: "failed",
            tombstoneReason: "dead_lettered",
            durationMs: 300_000,
            requeueCount: 5,
            tombstonedAt: new Date(1_000_000_000).toISOString(),
          } satisfies TaskTombstone,
        },
        { status: "failed" },
      ),
    ];
    const result = projectAlerts(reports, { nowMs });
    assert.equal(result.alerts.length, 1);
    assert.equal(result.alerts[0]!.kind, "task_dead_lettered");
    assert.equal(result.alerts[0]!.severity, "critical");
  });

  it("produces alert for worker_lost tombstone", () => {
    const reports = [
      makeReport(
        {
          diagnosticStatus: "terminal",
          tombstone: {
            taskId: "task-1",
            terminalStatus: "failed",
            tombstoneReason: "worker_lost",
            durationMs: 200_000,
            requeueCount: 0,
            tombstonedAt: new Date(1_000_000_000).toISOString(),
          } satisfies TaskTombstone,
        },
        { status: "failed" },
      ),
    ];
    const result = projectAlerts(reports, { nowMs });
    assert.equal(result.alerts.length, 1);
    assert.equal(result.alerts[0]!.kind, "task_worker_lost");
    assert.equal(result.alerts[0]!.severity, "warning");
  });

  it("produces alert for timeout tombstone", () => {
    const reports = [
      makeReport(
        {
          diagnosticStatus: "terminal",
          tombstone: {
            taskId: "task-1",
            terminalStatus: "failed",
            tombstoneReason: "timeout",
            durationMs: 600_000,
            requeueCount: 0,
            tombstonedAt: new Date(1_000_000_000).toISOString(),
          } satisfies TaskTombstone,
        },
        { status: "failed" },
      ),
    ];
    const result = projectAlerts(reports, { nowMs });
    assert.equal(result.alerts.length, 1);
    assert.equal(result.alerts[0]!.kind, "task_timeout");
  });

  it("compacts failed tombstone error metadata so alert scans stay bounded", () => {
    const largeDetails = { output: "x".repeat(200_000) };
    const reports = [
      makeReport(
        {
          diagnosticStatus: "terminal",
          tombstone: {
            taskId: "task-1",
            terminalStatus: "failed",
            tombstoneReason: "failed",
            durationMs: 100_000,
            requeueCount: 0,
            tombstonedAt: new Date(1_000_000_000).toISOString(),
            error: {
              code: "worker_failed",
              message: "failure " + "m".repeat(5_000),
              details: largeDetails,
            },
          },
        },
        { id: "task-1", status: "failed" },
      ),
    ];

    const result = projectAlerts(reports, { nowMs });
    const error = result.alerts[0]!.metadata.error as Record<string, unknown>;
    assert.equal(error.code, "worker_failed");
    assert.equal(error.messageTruncated, true);
    assert.equal(error.detailsOmitted, true);
    assert.equal(typeof error.detailsBytes, "number");
    assert.ok(JSON.stringify(result.alerts[0]).length < 2_000);
    assert.doesNotMatch(JSON.stringify(result.alerts[0]), /xxxxxxxx/);
  });

  it("produces alerts for failed and canceled tombstones at info severity", () => {
    const reports = [
      makeReport(
        {
          diagnosticStatus: "terminal",
          tombstone: {
            taskId: "task-1",
            terminalStatus: "failed",
            tombstoneReason: "failed",
            durationMs: 100_000,
            requeueCount: 0,
            tombstonedAt: new Date(1_000_000_000).toISOString(),
          },
        },
        { id: "task-1", status: "failed" },
      ),
      makeReport(
        {
          diagnosticStatus: "terminal",
          tombstone: {
            taskId: "task-2",
            terminalStatus: "canceled",
            tombstoneReason: "canceled",
            durationMs: 50_000,
            requeueCount: 0,
            tombstonedAt: new Date(1_000_000_000).toISOString(),
          },
        },
        { id: "task-2", status: "canceled" },
      ),
    ];
    const result = projectAlerts(reports, { nowMs });
    assert.equal(result.alerts.length, 2);
    assert.ok(result.alerts.every((a) => a.severity === "info"));
    assert.equal(result.counts.info, 2);
  });

  it("sorts alerts by severity (critical > warning > info)", () => {
    const reports = [
      makeReport(
        {
          diagnosticStatus: "terminal",
          tombstone: {
            taskId: "task-1",
            terminalStatus: "failed",
            tombstoneReason: "failed",
            durationMs: 100_000,
            requeueCount: 0,
            tombstonedAt: new Date(1_000_000_000).toISOString(),
          },
        },
        { status: "failed" },
      ),
      makeReport({
        diagnosticStatus: "stale",
        stalenessMs: 180_000,
        currentStatusDurationMs: 180_000,
      }),
    ];
    const result = projectAlerts(reports, { nowMs });
    assert.equal(result.alerts[0]!.severity, "warning");
    assert.equal(result.alerts[1]!.severity, "info");
  });

  it("generates deterministic alert ids", () => {
    const reports = [
      makeReport({
        diagnosticStatus: "stale",
        stalenessMs: 180_000,
        currentStatusDurationMs: 180_000,
      }),
    ];
    const r1 = projectAlerts(reports, { nowMs });
    const r2 = projectAlerts(reports, { nowMs });
    assert.equal(r1.alerts[0]!.id, r2.alerts[0]!.id);
    assert.equal(r1.alerts[0]!.id, "task_stale:task-1");
  });

  it("projects worker heartbeat_missed alerts from worker.lastSeenAt", () => {
    const result = projectAlerts([], {
      nowMs,
      workers: [
        makeWorker({
          nodeId: "worker-stale",
          lastSeenAt: new Date(nowMs - 180_000).toISOString(),
        }),
      ],
      workerHeartbeatMissedAfterMs: 120_000,
    });

    assert.equal(result.alerts.length, 1);
    assert.equal(result.alerts[0]!.kind, "worker.heartbeat_missed");
    assert.equal(result.alerts[0]!.severity, "warning");
    assert.equal(result.alerts[0]!.subject.kind, "worker");
    assert.equal(result.alerts[0]!.subject.id, "worker-stale");
    assert.equal(result.alerts[0]!.workerId, "worker-stale");
    assert.equal(result.alerts[0]!.taskId, undefined);
    assert.equal(result.countsByKind["worker.heartbeat_missed"], 1);
  });
});
