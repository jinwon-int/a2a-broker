import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InMemoryA2ABroker, type BrokerProfilingSample, type TaskUpdate, type BufferedTaskEvent } from "./broker.js";
import {
  CURRENT_BROKER_STATE_VERSION,
  SqliteArtifactRuntimeRepository,
  SqliteAuditRuntimeRepository,
  SqliteBrokerStateStore,
  SqliteExchangeMessageRuntimeRepository,
  SqliteExchangeRuntimeRepository,
  SqliteProposalRuntimeRepository,
  SqliteTaskRuntimeRepository,
  SqliteTombstoneRuntimeRepository,
  SqliteValidationRuntimeRepository,
  SqliteWorkerRuntimeRepository,
  emptySnapshot,
  type BrokerSnapshot,
  type BrokerStateSaveHints,
  type BrokerStateStore,
} from "./store.js";
import type { ArtifactRecord, AuditEvent, ChangeProposal, TaskTombstone, ValidationResult, WorkerRecord } from "./types.js";

function registerWorker(broker: InMemoryA2ABroker, nodeId: string): void {
  broker.registerWorker({
    nodeId,
    role: "analyst",
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: false,
      canPromoteLive: false,
      workspaceIds: ["test"],
      environments: ["research"],
    },
  });
}

function createWorkerTask(broker: InMemoryA2ABroker, id: string, workerId: string) {
  return broker.createTask({
    id,
    intent: "chat",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: workerId, kind: "node", role: "analyst" },
    assignedWorkerId: workerId,
    message: `task ${id}`,
    payload: { secretLikeLargePayload: "must not appear in capacity summary" },
  });
}

test("broker returns compact worker capacity counts for queued claimed and running tasks", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-capacity");

  createWorkerTask(broker, "task-capacity-queued", "worker-capacity");
  const claimed = createWorkerTask(broker, "task-capacity-claimed", "worker-capacity");
  broker.claimTask(claimed.id, "worker-capacity");
  const running = createWorkerTask(broker, "task-capacity-running", "worker-capacity");
  broker.claimTask(running.id, "worker-capacity");
  broker.startTask(running.id, "worker-capacity");

  const summary = broker.getWorkerCapacitySummary({ workerOfflineAfterMs: 120_000, taskStaleAfterMs: 120_000 });

  assert.equal(summary.totals.workers, 1);
  assert.equal(summary.totals.queued, 1);
  assert.equal(summary.totals.claimed, 1);
  assert.equal(summary.totals.running, 1);
  assert.equal(summary.totals.active, 3);
  assert.equal(summary.totals.staleTasks, 0);
  assert.equal(summary.items.length, 1);
  assert.deepEqual(summary.items[0].counts, {
    queued: 1,
    claimed: 1,
    running: 1,
    stale: 0,
    active: 3,
  });
  assert.ok(summary.items[0].latestTaskUpdatedAt);
  assert.equal(JSON.stringify(summary).includes("secretLikeLargePayload"), false);
});

test("broker marks claimed and running capacity stale after the configured threshold", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-stale-capacity");
  const claimed = createWorkerTask(broker, "task-stale-capacity-claimed", "worker-stale-capacity");
  broker.claimTask(claimed.id, "worker-stale-capacity");
  const running = createWorkerTask(broker, "task-stale-capacity-running", "worker-stale-capacity");
  broker.claimTask(running.id, "worker-stale-capacity");
  broker.startTask(running.id, "worker-stale-capacity");

  const summary = broker.getWorkerCapacitySummary({
    nowMs: Date.now() + 300_000,
    workerOfflineAfterMs: 120_000,
    taskStaleAfterMs: 120_000,
  });

  assert.equal(summary.totals.online, 0);
  assert.equal(summary.totals.staleWorkers, 1);
  assert.equal(summary.totals.staleTasks, 2);
  assert.equal(summary.items[0].status, "stale");
  assert.equal(summary.items[0].counts.stale, 2);
});

test("broker worker capacity summary handles an empty fleet", () => {
  const broker = new InMemoryA2ABroker();
  const summary = broker.getWorkerCapacitySummary({ nowMs: 0 });

  assert.deepEqual(summary.totals, {
    workers: 0,
    online: 0,
    staleWorkers: 0,
    queued: 0,
    claimed: 0,
    running: 0,
    staleTasks: 0,
    active: 0,
  });
  assert.deepEqual(summary.items, []);
});

test("broker exposes compact diagnostics without task payload expansion", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-diag");
  const task = broker.createTask({
    id: "task-compact-diag",
    intent: "chat",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-diag", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-diag",
    message: "compact diagnostic payload should stay small",
  });
  broker.claimTask(task.id, "worker-diag");

  const diagnostics = broker.getCompactDiagnostics({
    staleAfterMs: 120_000,
    workerOfflineAfterMs: 60_000,
    nowMs: Date.now() + 300_000,
  });

  assert.equal(diagnostics.tasks.total, 1);
  assert.equal(diagnostics.tasks.byStatus.claimed, 1);
  assert.equal(diagnostics.tasks.stale, 1);
  assert.equal(diagnostics.workers.total, 1);
  assert.equal(diagnostics.workers.stale, 1);
  assert.equal(diagnostics.audit.total, 3);
  assert.equal(diagnostics.runtimeRepositories.tasks, false);
  assert.equal(Object.hasOwn(diagnostics, "task"), false);
  assert.equal(Object.hasOwn(diagnostics, "tasksById"), false);
});

test("broker profiling hooks receive compact persistence samples", () => {
  const samples: BrokerProfilingSample[] = [];
  const broker = new InMemoryA2ABroker(undefined, undefined, {
    profilingListener: (sample) => samples.push(sample),
  });
  registerWorker(broker, "worker-profile");
  samples.length = 0;

  const unsubscribe = broker.subscribeToProfiling((sample) => samples.push(sample));
  broker.createTask({
    id: "task-profile-hook",
    intent: "chat",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-profile", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-profile",
    message: "profile compact persistence hooks",
  });
  unsubscribe();

  assert.equal(samples.length, 2);
  for (const sample of samples) {
    assert.equal(sample.operation, "persistState");
    assert.ok(sample.durationMs >= 0);
    assert.match(sample.startedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(sample.saveHints, {
      hotExchanges: 0,
      hotExchangeMessages: 0,
      hotProposals: 0,
      hotArtifacts: 0,
      hotValidations: 0,
      hotTasks: 1,
      hotTombstones: 0,
      hotAuditEvents: 1,
      hotWorkers: 0,
    });
  }
});

test("broker passes dirty task, audit, and worker hints to state store saves", () => {
  const saveHints: Array<BrokerStateSaveHints | undefined> = [];
  const store: BrokerStateStore = {
    load: () => emptySnapshot(),
    save: (_snapshot, hints) => {
      saveHints.push(hints);
    },
  };
  const broker = new InMemoryA2ABroker(store, store.load());
  registerWorker(broker, "worker-a");
  const registerHints = saveHints.at(-1);
  assert.deepEqual(registerHints?.hotWorkers?.map((item) => item.nodeId), ["worker-a"]);
  assert.deepEqual(registerHints?.hotAuditEvents?.map((item) => item.action), ["worker.registered"]);

  broker.heartbeatWorker("worker-a", { metadata: { check: "alive" } });
  const heartbeatHints = saveHints.at(-1);
  assert.deepEqual(heartbeatHints?.hotWorkers?.map((item) => [item.nodeId, item.metadata]), [["worker-a", { check: "alive" }]]);
  assert.deepEqual(heartbeatHints?.hotAuditEvents?.map((item) => item.action), ["worker.heartbeat"]);

  const exchange = broker.startExchange({
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    message: "prove exchange hot write hints",
    intent: "chat",
  });
  const exchangeHints = saveHints.at(-1);
  assert.deepEqual(exchangeHints?.hotExchanges?.map((item) => item.id), [exchange.id]);
  assert.deepEqual(exchangeHints?.hotExchangeMessages?.map((item) => [item.exchangeId, item.kind]), [[exchange.id, "root"]]);

  const saveCountBeforeMessage = saveHints.length;
  broker.addExchangeMessage(exchange.id, {
    actor: { id: "hub-a", kind: "node", role: "hub" },
    message: "thread message",
  });
  const messageSaveHints = saveHints.slice(saveCountBeforeMessage);
  assert.ok(messageSaveHints.some((hints) => hints?.hotExchanges?.some((item) => item.id === exchange.id && item.messageCount === 2)));
  assert.ok(messageSaveHints.some((hints) => hints?.hotExchangeMessages?.some((item) => item.exchangeId === exchange.id && item.kind === "thread")));
  assert.ok(messageSaveHints.some((hints) => hints?.hotAuditEvents?.some((item) => item.action === "exchange.message.added")));

  const proposal = broker.createProposal({
    source: { id: "worker-a", kind: "node", role: "analyst" },
    target: { id: "operator-a", kind: "service", role: "operator" },
    kind: "patch",
    summary: "prove proposal hot write hints",
    workspace: { nodeId: "worker-a", workspaceId: "test" },
    patchText: "diff --git a/file b/file",
  });
  const proposalHints = saveHints.at(-1);
  assert.deepEqual(proposalHints?.hotProposals?.map((item) => [item.id, item.status]), [[proposal.id, "submitted"]]);
  assert.deepEqual(proposalHints?.hotAuditEvents?.map((item) => item.action), ["proposal.created"]);

  const artifact = broker.attachArtifact(proposal.id, {
    kind: "report",
    uri: "memory://proposal-artifact",
    summary: "proposal artifact",
  });
  const artifactHints = saveHints.at(-1);
  assert.deepEqual(artifactHints?.hotArtifacts?.map((item) => item.id), [artifact.id]);
  assert.deepEqual(artifactHints?.hotProposals?.map((item) => item.artifactIds), [[artifact.id]]);
  assert.deepEqual(artifactHints?.hotAuditEvents?.map((item) => item.action), ["artifact.attached"]);

  const validation = broker.submitValidationResult(proposal.id, {
    nodeId: "operator-a",
    kind: "smoke",
    verdict: "pass",
    artifactIds: [artifact.id],
  });
  const validationHints = saveHints.at(-1);
  assert.deepEqual(validationHints?.hotValidations?.map((item) => item.id), [validation.id]);
  assert.deepEqual(validationHints?.hotProposals?.map((item) => item.status), ["validated"]);
  assert.deepEqual(validationHints?.hotAuditEvents?.map((item) => item.action), ["validation.submitted"]);

  const task = broker.createTask({
    id: "task-hot-hints",
    intent: "chat",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "prove hot write hints",
  });

  const createHints = saveHints.at(-1);
  assert.deepEqual(createHints?.hotTasks?.map((item) => item.id), [task.id]);
  assert.deepEqual(createHints?.hotAuditEvents?.map((item) => item.action), ["task.created"]);

  broker.claimTask(task.id, "worker-a");
  const claimHints = saveHints.at(-1);
  assert.deepEqual(claimHints?.hotTasks?.map((item) => [item.id, item.status]), [[task.id, "claimed"]]);
  assert.deepEqual(claimHints?.hotAuditEvents?.map((item) => item.action), ["task.claimed"]);
});

test("broker task lifecycle mutations can use the SQLite runtime repository without JSON hot hints", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-task-repo-"));
  const sqliteStore = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  const snapshots: BrokerSnapshot[] = [];
  const noopStore: BrokerStateStore = {
    load: () => emptySnapshot(),
    save: (snapshot) => snapshots.push(snapshot),
  };

  try {
    const broker = new InMemoryA2ABroker(noopStore, noopStore.load(), {
      taskRepository: new SqliteTaskRuntimeRepository(sqliteStore),
    });
    registerWorker(broker, "worker-sqlite");

    const completed = broker.createTask({
      id: "task-sqlite-complete",
      intent: "chat",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-sqlite", kind: "node", role: "analyst" },
      assignedWorkerId: "worker-sqlite",
      message: "complete through runtime repo",
      taskOrigin: "api",
    });
    assert.equal(sqliteStore.readHotTasks({ id: completed.id })[0]?.status, "queued");
    assert.deepEqual(sqliteStore.load().tasks, []);

    broker.claimTask(completed.id, "worker-sqlite");
    assert.equal(sqliteStore.readHotTasks({ id: completed.id })[0]?.status, "claimed");
    assert.equal(sqliteStore.readHotTasks({ id: completed.id })[0]?.claimedBy, "worker-sqlite");
    broker.startTask(completed.id, "worker-sqlite");
    assert.equal(sqliteStore.readHotTasks({ id: completed.id })[0]?.status, "running");
    broker.completeTask(completed.id, "worker-sqlite", { summary: "done" });
    const completedRow = sqliteStore.readHotTasks({ id: completed.id })[0]!;
    assert.equal(completedRow.status, "succeeded");
    assert.equal(completedRow.result?.summary, "done");
    assert.equal(broker.getTask(completed.id)?.status, completedRow.status);
    assert.equal(broker.getTask(completed.id)?.result?.summary, completedRow.result?.summary);

    const failed = broker.createTask({
      id: "task-sqlite-fail",
      intent: "chat",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-sqlite", kind: "node", role: "analyst" },
      assignedWorkerId: "worker-sqlite",
      message: "fail through runtime repo",
    });
    broker.claimTask(failed.id, "worker-sqlite");
    broker.failTask(failed.id, "worker-sqlite", { code: "boom", message: "failed" });
    assert.equal(sqliteStore.readHotTasks({ id: failed.id })[0]?.status, "failed");
    assert.equal(sqliteStore.readHotTasks({ id: failed.id })[0]?.error?.code, "boom");

    const requeued = broker.createTask({
      id: "task-sqlite-requeue",
      intent: "chat",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-sqlite", kind: "node", role: "analyst" },
      assignedWorkerId: "worker-sqlite",
      message: "requeue through runtime repo",
    });
    broker.claimTask(requeued.id, "worker-sqlite");
    const requeueResult = broker.requeueStaleTasksDetailed(0, { nowMs: Date.now() + 1_000 });
    assert.deepEqual(requeueResult.requeued.map((task) => task.id), [requeued.id]);
    const requeuedRow = sqliteStore.readHotTasks({ id: requeued.id })[0]!;
    assert.equal(requeuedRow.status, "queued");
    assert.equal(requeuedRow.requeueCount, 1);
    assert.equal(requeuedRow.claimedBy, undefined);

    assert.deepEqual(
      broker.listTasks({ assignedWorkerId: "worker-sqlite" }).map((task) => task.id).sort(),
      [completed.id, failed.id, requeued.id].sort(),
    );
    assert.equal(snapshots.at(-1)?.tasks.find((task) => task.id === requeued.id)?.status, "queued");
  } finally {
    sqliteStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("broker task lifecycle keeps the JSON/default state path without a runtime repository", () => {
  const saveHints: Array<BrokerStateSaveHints | undefined> = [];
  const snapshots: BrokerSnapshot[] = [];
  const store: BrokerStateStore = {
    load: () => emptySnapshot(),
    save: (snapshot, hints) => {
      snapshots.push(snapshot);
      saveHints.push(hints);
    },
  };
  const broker = new InMemoryA2ABroker(store, store.load());
  registerWorker(broker, "worker-json");

  const task = broker.createTask({
    id: "task-json-default",
    intent: "chat",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-json", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-json",
    message: "json default path",
  });
  broker.claimTask(task.id, "worker-json");
  broker.completeTask(task.id, "worker-json", { summary: "json done" });

  assert.equal(broker.getTask(task.id)?.status, "succeeded");
  assert.equal(broker.listTasks({ status: "succeeded" })[0]?.id, task.id);
  assert.equal(snapshots.at(-1)?.tasks.find((item) => item.id === task.id)?.status, "succeeded");
  assert.deepEqual(saveHints.at(-1)?.hotTasks?.map((item) => [item.id, item.status]), [[task.id, "succeeded"]]);
});

test("broker proposal lifecycle can use the SQLite runtime repository without JSON hot hints", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-proposal-repo-"));
  const sqliteStore = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  const snapshots: BrokerSnapshot[] = [];
  const noopStore: BrokerStateStore = {
    load: () => emptySnapshot(),
    save: (snapshot) => snapshots.push(snapshot),
  };

  try {
    const broker = new InMemoryA2ABroker(noopStore, noopStore.load(), {
      proposalRepository: new SqliteProposalRuntimeRepository(sqliteStore),
    });

    const created = broker.createProposal({
      source: { id: "research-a", kind: "node", role: "researcher" },
      target: { id: "live-a", kind: "node", role: "live-trader" },
      kind: "patch",
      summary: "create through runtime repo",
      workspace: { nodeId: "live-a", workspaceId: "repo" },
      patchText: "diff --git a/file b/file",
    });
    assert.equal(sqliteStore.readHotProposals({ id: created.id })[0]?.status, "submitted");
    assert.deepEqual(sqliteStore.load().proposals, []);

    broker.submitValidationResult(created.id, {
      nodeId: "live-a",
      kind: "smoke",
      verdict: "pass",
    });
    assert.equal(sqliteStore.readHotProposals({ id: created.id })[0]?.status, "validated");
    broker.approveProposal(created.id, { actor: { id: "live-a", kind: "node", role: "live-trader" } });
    assert.equal(sqliteStore.readHotProposals({ id: created.id })[0]?.status, "approved");
    broker.applyProposalLocally(created.id, {
      actor: { id: "live-a", kind: "node", role: "live-trader" },
      workspace: { nodeId: "live-a", workspaceId: "repo" },
    });
    assert.equal(sqliteStore.readHotProposals({ id: created.id })[0]?.status, "applied");

    const externalProposal: ChangeProposal = {
      id: "proposal-external-hot",
      source: { id: "operator-a", kind: "service", role: "operator" },
      target: { id: "worker-hot", kind: "node", role: "analyst" },
      sourceNodeId: "operator-a",
      targetNodeId: "worker-hot",
      kind: "params",
      summary: "external proposal from runtime repo",
      workspace: { nodeId: "worker-hot", workspaceId: "repo" },
      parameterPayload: { threshold: 2 },
      artifactIds: [],
      status: "submitted",
      createdAt: "2026-04-27T00:00:00.000Z",
      updatedAt: "2026-04-27T00:00:00.000Z",
    };
    sqliteStore.upsertHotProposals([externalProposal]);

    assert.equal(broker.getProposal("proposal-external-hot")?.kind, "params");
    assert.deepEqual(
      broker.listProposals({ status: "submitted", targetNodeId: "worker-hot", kind: "params" }).map((proposal) => proposal.id),
      ["proposal-external-hot"],
    );
    const approved = broker.approveProposal("proposal-external-hot", {
      actor: { id: "worker-hot", kind: "node", role: "analyst" },
    });
    assert.equal(approved.status, "approved");
    assert.equal(sqliteStore.readHotProposals({ id: "proposal-external-hot" })[0]?.status, "approved");
    assert.equal(snapshots.at(-1)?.proposals.find((proposal) => proposal.id === created.id)?.status, "applied");
  } finally {
    sqliteStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("broker proposal artifacts can use the SQLite runtime repository without JSON hot hints", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-artifact-repo-"));
  const sqliteStore = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  const snapshots: BrokerSnapshot[] = [];
  const noopStore: BrokerStateStore = {
    load: () => emptySnapshot(),
    save: (snapshot) => snapshots.push(snapshot),
  };

  try {
    const broker = new InMemoryA2ABroker(noopStore, noopStore.load(), {
      proposalRepository: new SqliteProposalRuntimeRepository(sqliteStore),
      artifactRepository: new SqliteArtifactRuntimeRepository(sqliteStore),
    });

    const proposal = broker.createProposal({
      source: { id: "research-a", kind: "node", role: "researcher" },
      target: { id: "live-a", kind: "node", role: "live-trader" },
      kind: "patch",
      summary: "artifact through runtime repo",
      workspace: { nodeId: "live-a", workspaceId: "repo" },
      patchText: "diff --git a/file b/file",
    });

    const attached = broker.attachArtifact(proposal.id, {
      kind: "report",
      uri: "memory://artifact-runtime-attached",
      summary: "attached through runtime repo",
    });

    assert.equal(sqliteStore.readHotArtifacts({ id: attached.id })[0]?.summary, "attached through runtime repo");
    assert.equal(broker.getArtifact(attached.id)?.summary, "attached through runtime repo");
    assert.deepEqual(sqliteStore.load().artifacts, []);
    assert.deepEqual(
      broker.getProposalDetails(proposal.id)?.artifacts.map((artifact) => artifact.id),
      [attached.id],
    );

    const externalArtifact: ArtifactRecord = {
      id: "artifact-external-hot",
      proposalId: proposal.id,
      kind: "report",
      uri: "memory://artifact-external-hot",
      summary: "external artifact from runtime repo",
      createdAt: "2026-04-27T00:00:00.000Z",
    };
    sqliteStore.upsertHotArtifacts([externalArtifact]);

    assert.deepEqual(
      broker.listArtifactsForProposal(proposal.id).map((artifact) => artifact.id),
      [attached.id, "artifact-external-hot"],
    );
    assert.equal(snapshots.at(-1)?.artifacts.find((artifact) => artifact.id === attached.id)?.summary, "attached through runtime repo");
  } finally {
    sqliteStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("broker proposal validations can use the SQLite runtime repository without JSON hot hints", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-validation-repo-"));
  const sqliteStore = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  const snapshots: BrokerSnapshot[] = [];
  const noopStore: BrokerStateStore = {
    load: () => emptySnapshot(),
    save: (snapshot) => snapshots.push(snapshot),
  };

  try {
    const broker = new InMemoryA2ABroker(noopStore, noopStore.load(), {
      proposalRepository: new SqliteProposalRuntimeRepository(sqliteStore),
      validationRepository: new SqliteValidationRuntimeRepository(sqliteStore),
    });

    const proposal = broker.createProposal({
      source: { id: "research-a", kind: "node", role: "researcher" },
      target: { id: "live-a", kind: "node", role: "live-trader" },
      kind: "patch",
      summary: "validation through runtime repo",
      workspace: { nodeId: "live-a", workspaceId: "repo" },
      patchText: "diff --git a/file b/file",
    });

    const submitted = broker.submitValidationResult(proposal.id, {
      nodeId: "live-a",
      kind: "smoke",
      verdict: "pass",
      metrics: { checked: true },
      note: "submitted through runtime repo",
    });

    assert.equal(sqliteStore.readHotValidations({ id: submitted.id })[0]?.note, "submitted through runtime repo");
    assert.deepEqual(sqliteStore.load().validations, []);
    assert.deepEqual(
      broker.getProposalDetails(proposal.id)?.validations.map((validation) => validation.id),
      [submitted.id],
    );

    const externalValidation: ValidationResult = {
      id: "validation-external-hot",
      proposalId: proposal.id,
      nodeId: "live-a",
      kind: "paper",
      verdict: "pass",
      metrics: { confidence: "high" },
      artifactIds: [],
      note: "external validation from runtime repo",
      createdAt: "2026-04-27T00:00:00.000Z",
    };
    sqliteStore.upsertHotValidations([externalValidation]);

    assert.deepEqual(
      broker.listValidationsForProposal(proposal.id).map((validation) => validation.id),
      [submitted.id, "validation-external-hot"],
    );
    assert.equal(snapshots.at(-1)?.validations.find((validation) => validation.id === submitted.id)?.note, "submitted through runtime repo");
  } finally {
    sqliteStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("broker worker mutations can use the SQLite runtime repository without JSON hot hints", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-worker-repo-"));
  const sqliteStore = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  const snapshots: BrokerSnapshot[] = [];
  const noopStore: BrokerStateStore = {
    load: () => emptySnapshot(),
    save: (snapshot) => snapshots.push(snapshot),
  };

  try {
    const broker = new InMemoryA2ABroker(noopStore, noopStore.load(), {
      workerRepository: new SqliteWorkerRuntimeRepository(sqliteStore),
    });

    broker.registerWorker({
      nodeId: "worker-sqlite",
      role: "analyst",
      capabilities: {
        canAnalyze: true,
        canBackfill: false,
        canPatchWorkspace: false,
        canPromoteLive: false,
        workspaceIds: ["repo-seam"],
        environments: ["research"],
      },
    });

    assert.equal(sqliteStore.readHotWorkers({ nodeId: "worker-sqlite" })[0]?.nodeId, "worker-sqlite");

    const heartbeat = broker.heartbeatWorker("worker-sqlite", { metadata: { check: "alive" } });
    const row = sqliteStore.readHotWorkers({ nodeId: "worker-sqlite" })[0]!;

    assert.equal(row.lastSeenAt, heartbeat.lastSeenAt);
    assert.deepEqual(row.metadata, { check: "alive" });
    assert.deepEqual(broker.getWorker("worker-sqlite"), row);
    assert.deepEqual(
      broker.listWorkers({ role: "analyst", environment: "research", workspaceId: "repo-seam" }).map((worker) => worker.nodeId),
      ["worker-sqlite"],
    );
    assert.equal(snapshots.at(-1)?.workers[0]?.nodeId, row.nodeId);
    assert.equal(snapshots.at(-1)?.workers[0]?.lastSeenAt, row.lastSeenAt);
    assert.deepEqual(snapshots.at(-1)?.workers[0]?.metadata, row.metadata);
  } finally {
    sqliteStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("broker normalizes minimal legacy and full worker capabilities before SQLite hot persistence", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-worker-capabilities-"));
  const sqliteStore = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  const noopStore: BrokerStateStore = {
    load: () => emptySnapshot(),
    save: () => undefined,
  };

  try {
    const broker = new InMemoryA2ABroker(noopStore, noopStore.load(), {
      workerRepository: new SqliteWorkerRuntimeRepository(sqliteStore),
    });

    broker.registerWorker({
      nodeId: "worker-minimal-capabilities",
      role: "analyst",
      capabilities: { canAnalyze: "yes" } as any,
    });
    assert.deepEqual(sqliteStore.readHotWorkers({ nodeId: "worker-minimal-capabilities" })[0]?.capabilities, {
      canAnalyze: false,
      canBackfill: false,
      canPatchWorkspace: false,
      canPromoteLive: false,
      workspaceIds: [],
      environments: [],
    });

    broker.registerWorker({
      nodeId: "worker-legacy-array-capabilities",
      role: "analyst",
      capabilities: ["canAnalyze", "canPatchWorkspace"] as any,
    });
    assert.deepEqual(sqliteStore.readHotWorkers({ nodeId: "worker-legacy-array-capabilities" })[0]?.capabilities, {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: true,
      canPromoteLive: false,
      workspaceIds: [],
      environments: [],
    });

    broker.heartbeatWorker("worker-legacy-array-capabilities", {
      capabilities: {
        canAnalyze: true,
        canBackfill: true,
        canPatchWorkspace: false,
        canPromoteLive: true,
        workspaceIds: ["repo-seam", "repo-seam"],
        environments: ["research", "staging"],
      },
    });
    assert.deepEqual(sqliteStore.readHotWorkers({ nodeId: "worker-legacy-array-capabilities" })[0]?.capabilities, {
      canAnalyze: true,
      canBackfill: true,
      canPatchWorkspace: false,
      canPromoteLive: true,
      workspaceIds: ["repo-seam"],
      environments: ["research", "staging"],
    });
  } finally {
    sqliteStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("broker audit and tombstone diagnostics can use SQLite runtime repositories", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-audit-tombstone-repo-"));
  const sqliteStore = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  const snapshots: BrokerSnapshot[] = [];
  const noopStore: BrokerStateStore = {
    load: () => emptySnapshot(),
    save: (snapshot) => snapshots.push(snapshot),
  };

  try {
    const broker = new InMemoryA2ABroker(noopStore, noopStore.load(), {
      auditRepository: new SqliteAuditRuntimeRepository(sqliteStore),
      tombstoneRepository: new SqliteTombstoneRuntimeRepository(sqliteStore),
    });
    registerWorker(broker, "worker-sqlite");

    const task = broker.createTask({
      id: "task-sqlite-audit-tombstone",
      intent: "chat",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-sqlite", kind: "node", role: "analyst" },
      assignedWorkerId: "worker-sqlite",
      message: "fail through audit/tombstone repo",
    });
    broker.claimTask(task.id, "worker-sqlite");
    broker.failTask(task.id, "worker-sqlite", { code: "boom", message: "failed through repo" });

    assert.deepEqual(
      sqliteStore.readHotAuditEvents({ targetId: task.id, action: "task.failed" }).map((event) => event.note),
      ["failed through repo"],
    );
    assert.equal(sqliteStore.readHotTombstones({ taskId: task.id })[0]?.error?.code, "boom");
    assert.deepEqual(sqliteStore.load().auditEvents, []);
    assert.deepEqual(sqliteStore.load().tombstones, []);
    assert.equal(snapshots.at(-1)?.tasks.find((item) => item.id === task.id)?.status, "failed");

    const externalAudit: AuditEvent = {
      id: "audit-external-hot",
      actorId: "operator-hot",
      action: "task.requeued",
      targetType: "task",
      targetId: "task-external-hot",
      createdAt: "2026-04-27T00:00:00.000Z",
    };
    const externalTombstone: TaskTombstone = {
      taskId: "task-external-hot",
      terminalStatus: "failed",
      tombstoneReason: "dead_lettered",
      durationMs: 10,
      requeueCount: 2,
      error: { code: "exceeded_requeue_limit", message: "hot tombstone" },
      tombstonedAt: "2026-04-27T00:00:01.000Z",
    };
    sqliteStore.upsertHotAuditEvents([externalAudit]);
    sqliteStore.upsertHotTombstones([externalTombstone]);

    assert.deepEqual(
      broker.listAuditEvents({ targetId: "task-external-hot", action: "task.requeued" }).map((event) => event.id),
      ["audit-external-hot"],
    );
    assert.equal(broker.getTombstone("task-external-hot")?.tombstoneReason, "dead_lettered");
    assert.deepEqual(
      broker.listTombstones({ tombstoneReason: "dead_lettered" }).map((tombstone) => tombstone.taskId),
      ["task-external-hot"],
    );
  } finally {
    sqliteStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("broker exchange threads can use SQLite runtime repositories without JSON hot hints", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-exchange-repo-"));
  const sqliteStore = new SqliteBrokerStateStore(join(dir, "state.sqlite"));
  const snapshots: BrokerSnapshot[] = [];
  const noopStore: BrokerStateStore = {
    load: () => emptySnapshot(),
    save: (snapshot) => snapshots.push(snapshot),
  };

  try {
    const broker = new InMemoryA2ABroker(noopStore, noopStore.load(), {
      exchangeRepository: new SqliteExchangeRuntimeRepository(sqliteStore),
      exchangeMessageRepository: new SqliteExchangeMessageRuntimeRepository(sqliteStore),
    });
    registerWorker(broker, "worker-sqlite");

    const exchange = broker.startExchange({
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-sqlite", kind: "node", role: "analyst" },
      message: "exchange through runtime repo",
      intent: "chat",
    });

    assert.equal(sqliteStore.readHotExchanges({ id: exchange.id })[0]?.id, exchange.id);
    assert.equal(sqliteStore.readHotExchangeMessages({ exchangeId: exchange.id })[0]?.id, exchange.rootMessageId);
    assert.deepEqual(sqliteStore.load().exchanges, []);
    assert.deepEqual(sqliteStore.load().exchangeMessages, []);

    const message = broker.addExchangeMessage(exchange.id, {
      actor: { id: "hub-a", kind: "node", role: "hub" },
      message: "need more context",
      parentMessageId: exchange.rootMessageId,
    });

    const row = sqliteStore.readHotExchanges({ id: exchange.id })[0]!;
    assert.equal(row.messageCount, 2);
    assert.equal(row.latestMessageId, message.id);
    assert.equal(broker.getExchange(exchange.id)?.latestMessageId, message.id);
    assert.deepEqual(
      broker.listExchanges().map((item) => item.id),
      [exchange.id],
    );
    assert.deepEqual(
      broker.listExchangeMessages(exchange.id).map((item) => item.id),
      [exchange.rootMessageId, message.id],
    );
    assert.deepEqual(
      broker.listExchangeMessages(exchange.id, { parentMessageId: exchange.rootMessageId }).map((item) => item.id),
      [message.id],
    );
    assert.equal(snapshots.at(-1)?.exchanges.find((item) => item.id === exchange.id)?.latestMessageId, message.id);
    assert.equal(snapshots.at(-1)?.exchangeMessages.find((item) => item.id === message.id)?.message, "need more context");
  } finally {
    sqliteStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("broker exchange threads keep the JSON/default state path without runtime repositories", () => {
  const saveHints: Array<BrokerStateSaveHints | undefined> = [];
  const snapshots: BrokerSnapshot[] = [];
  const store: BrokerStateStore = {
    load: () => emptySnapshot(),
    save: (snapshot, hints) => {
      snapshots.push(snapshot);
      saveHints.push(hints);
    },
  };
  const broker = new InMemoryA2ABroker(store, store.load());
  registerWorker(broker, "worker-json");

  const exchange = broker.startExchange({
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-json", kind: "node", role: "analyst" },
    message: "json exchange path",
    intent: "chat",
  });
  const message = broker.addExchangeMessage(exchange.id, {
    actor: { id: "hub-a", kind: "node", role: "hub" },
    message: "json thread reply",
  });

  assert.equal(broker.getExchange(exchange.id)?.latestMessageId, message.id);
  assert.deepEqual(broker.listExchangeMessages(exchange.id).map((item) => item.id), [exchange.rootMessageId, message.id]);
  assert.equal(snapshots.at(-1)?.exchanges.find((item) => item.id === exchange.id)?.latestMessageId, message.id);
  assert.ok(saveHints.some((hints) => hints?.hotExchanges?.some((item) => item.id === exchange.id)));
  assert.ok(saveHints.some((hints) => hints?.hotExchangeMessages?.some((item) => item.id === message.id)));
});

test("accepted exchange thread creates and links an exchange task", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const exchange = broker.startExchange({
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    message: "run analysis",
    intent: "analyze",
  });

  const threadMessage = broker.addExchangeMessage(exchange.id, {
    actor: { id: "hub-a", kind: "node", role: "hub" },
    message: "accepted for worker-a",
    decision: "accepted",
    targetNodeId: "worker-a",
    assignedWorkerId: "worker-a",
  });

  const refreshedExchange = broker.getExchange(exchange.id);
  assert.ok(refreshedExchange);
  assert.equal(refreshedExchange.status, "running");
  assert.equal(refreshedExchange.currentDecision, "accepted");
  assert.equal(refreshedExchange.assignedWorkerId, "worker-a");
  assert.equal(refreshedExchange.latestMessageId, threadMessage.id);
  assert.ok(refreshedExchange.activeTaskId);

  const linkedTask = broker.getTask(refreshedExchange.activeTaskId);
  assert.ok(linkedTask);
  assert.equal(linkedTask.exchangeId, exchange.id);
  assert.equal(linkedTask.assignedWorkerId, "worker-a");
  assert.equal(linkedTask.status, "queued");
});

test("live-impact task creation by a non-operator is blocked until approval", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const task = broker.createTask({
    intent: "apply_local_change",
    requester: { id: "analyst-a", kind: "node", role: "analyst" },
    target: { id: "worker-a", kind: "node", role: "live-trader" },
    workspace: { nodeId: "worker-a", workspaceId: "test" },
    message: "apply live patch",
  });

  assert.equal(task.status, "blocked");
  assert.equal(task.policyContext?.requiresApproval, true);
  assert.throws(() => broker.claimTask(task.id, "worker-a"), {
    name: "BrokerError",
    code: "policy_denied",
    message: "task requires operator or hub approval before claim",
  });
});

test("dangerous task creation records explicit human-gate policy context and waits blocked", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const task = broker.createTask({
    intent: "promote_to_live",
    requester: { id: "operator-a", kind: "node", role: "operator" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    message: "promote after review",
  });

  assert.deepEqual(task.policyContext, {
    requiresApproval: true,
    liveImpact: true,
    targetEnvironment: "live",
  });
  assert.equal(task.status, "blocked");
});

test("operator approval resumes blocked approval-gated task and records audit metadata", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const task = broker.createTask({
    intent: "promote_to_live",
    requester: { id: "analyst-a", kind: "node", role: "analyst" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    message: "promote after review",
  });

  assert.throws(
    () => broker.approveTask(task.id, {
      actor: { id: "researcher-a", kind: "node", role: "researcher" },
      reason: "not authorized",
    }),
    {
      name: "BrokerError",
      code: "policy_denied",
      message: "task approval requires a hub or operator actor",
    },
  );

  const approved = broker.approveTask(task.id, {
    actor: { id: "operator-a", kind: "node", role: "operator" },
    approvalId: "approval-123",
    reason: "change ticket CHG-123 reviewed",
  });

  assert.equal(approved.status, "queued");
  assert.deepEqual(approved.approval, {
    approvalId: "approval-123",
    approvedAt: approved.approval?.approvedAt,
    approvedBy: "operator-a",
    actorRole: "operator",
    requesterRole: "analyst",
    reason: "change ticket CHG-123 reviewed",
  });
  assert.ok(approved.approval?.approvedAt);
  const audit = broker.listAuditEvents({ targetId: task.id, action: "task.approved" });
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actorId, "operator-a");
  assert.equal(audit[0].note, "change ticket CHG-123 reviewed");

  const claimed = broker.claimTask(task.id, "worker-a");
  assert.equal(claimed.status, "claimed");
});

test("repeat approval is idempotent and preserves first approval record", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const task = broker.createTask({
    intent: "rollback_live",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    message: "rollback",
  });
  const first = broker.approveTask(task.id, {
    actor: { id: "hub-a", kind: "node", role: "hub" },
    approvalId: "approval-first",
    reason: "first reason",
  });
  const auditCount = broker.listAuditEvents({ targetId: task.id, action: "task.approved" }).length;
  const second = broker.approveTask(task.id, {
    actor: { id: "operator-b", kind: "node", role: "operator" },
    approvalId: "approval-second",
    reason: "second reason",
  });

  assert.deepEqual(second.approval, first.approval);
  assert.equal(second.approval?.approvalId, "approval-first");
  assert.equal(second.approvalOutcome?.status, "approved");
  assert.equal(second.approvalOutcome?.approvalId, "approval-first");
  assert.equal(broker.listAuditEvents({ targetId: task.id, action: "task.approved" }).length, auditCount);
});

test("operator rejection records terminal approval outcome and leaves task unclaimable", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const task = broker.createTask({
    intent: "promote_to_live",
    requester: { id: "analyst-a", kind: "node", role: "analyst" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "promote after review",
  });
  const updates: TaskUpdate[] = [];
  broker.subscribeToTask(task.id, (update) => updates.push(update));

  const rejected = broker.rejectTaskApproval(task.id, {
    actor: { id: "operator-a", kind: "node", role: "operator" },
    approvalId: "chg-rejected-1",
    status: "rejected",
    reason: "change ticket rejected",
  });
  const repeated = broker.rejectTaskApproval(task.id, {
    actor: { id: "operator-b", kind: "node", role: "operator" },
    approvalId: "chg-rejected-2",
    status: "expired",
    reason: "late duplicate",
  });

  assert.equal(rejected.status, "canceled");
  assert.deepEqual(repeated.approvalOutcome, rejected.approvalOutcome);
  assert.deepEqual(rejected.approvalOutcome, {
    status: "rejected",
    approvalId: "chg-rejected-1",
    decidedAt: rejected.approvalOutcome?.decidedAt,
    decidedBy: "operator-a",
    actorRole: "operator",
    requesterRole: "analyst",
    reason: "change ticket rejected",
  });
  assert.ok(rejected.approvalOutcome?.decidedAt);
  assert.equal(rejected.cancellation?.reason, "change ticket rejected");
  assert.equal(broker.listAuditEvents({ targetId: task.id, action: "task.approval_rejected" }).length, 1);
  assert.deepEqual(
    updates.map((update) => [update.reason, update.final, update.task.approvalOutcome?.status]),
    [["canceled", true, "rejected"]],
  );
  assert.throws(() => broker.claimTask(task.id, "worker-a"), {
    name: "BrokerError",
    code: "policy_denied",
  });
});

test("needs_clarification cancels active exchange task and returns exchange to queued", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const exchange = broker.startExchange({
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    message: "run analysis",
    intent: "analyze",
  });

  broker.addExchangeMessage(exchange.id, {
    actor: { id: "hub-a", kind: "node", role: "hub" },
    message: "accepted",
    decision: "accepted",
    targetNodeId: "worker-a",
    assignedWorkerId: "worker-a",
  });

  broker.addExchangeMessage(exchange.id, {
    actor: { id: "worker-a", kind: "node", role: "analyst" },
    message: "need more detail",
    decision: "needs_clarification",
  });

  const refreshedExchange = broker.getExchange(exchange.id);
  assert.ok(refreshedExchange);
  assert.equal(refreshedExchange.status, "queued");
  assert.equal(refreshedExchange.currentDecision, "needs_clarification");
  assert.ok(refreshedExchange.activeTaskId);

  const linkedTask = broker.getTask(refreshedExchange.activeTaskId);
  assert.ok(linkedTask);
  assert.equal(linkedTask.status, "canceled");
});

test("partially_accepted keeps exchange running with an active task", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const exchange = broker.startExchange({
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    message: "run analysis",
    intent: "analyze",
  });

  broker.addExchangeMessage(exchange.id, {
    actor: { id: "hub-a", kind: "node", role: "hub" },
    message: "partial accept",
    decision: "partially_accepted",
    targetNodeId: "worker-a",
    assignedWorkerId: "worker-a",
  });

  const refreshedExchange = broker.getExchange(exchange.id);
  assert.ok(refreshedExchange);
  assert.equal(refreshedExchange.status, "running");
  assert.equal(refreshedExchange.currentDecision, "partially_accepted");
  assert.ok(refreshedExchange.activeTaskId);
});

test("declined marks exchange failed and cancels any active task", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const exchange = broker.startExchange({
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    message: "run analysis",
    intent: "analyze",
  });

  broker.addExchangeMessage(exchange.id, {
    actor: { id: "hub-a", kind: "node", role: "hub" },
    message: "accepted",
    decision: "accepted",
    targetNodeId: "worker-a",
    assignedWorkerId: "worker-a",
  });

  broker.addExchangeMessage(exchange.id, {
    actor: { id: "hub-a", kind: "node", role: "hub" },
    message: "declined",
    decision: "declined",
  });

  const refreshedExchange = broker.getExchange(exchange.id);
  assert.ok(refreshedExchange);
  assert.equal(refreshedExchange.status, "failed");
  assert.equal(refreshedExchange.currentDecision, "declined");
  assert.ok(refreshedExchange.activeTaskId);

  const linkedTask = broker.getTask(refreshedExchange.activeTaskId);
  assert.ok(linkedTask);
  assert.equal(linkedTask.status, "canceled");
});

test("canceling a parent task fans out to child tasks recursively", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");
  registerWorker(broker, "worker-b");
  registerWorker(broker, "worker-c");

  const parent = broker.createTask({
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "parent",
  });
  const child = broker.createTask({
    parentTaskId: parent.id,
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-b", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-b",
    message: "child",
  });
  const grandchild = broker.createTask({
    parentTaskId: child.id,
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-c", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-c",
    message: "grandchild",
  });

  broker.claimTask(child.id, "worker-b");

  broker.cancelTask(parent.id, {
    actor: { id: "hub-a", kind: "node", role: "hub" },
    reason: "operator stop",
  });

  assert.equal(broker.getTask(parent.id)?.status, "canceled");
  assert.equal(broker.getTask(child.id)?.status, "canceled");
  assert.equal(broker.getTask(grandchild.id)?.status, "canceled");
  assert.equal(broker.getTask(child.id)?.cancellation?.sourceTaskId, parent.id);
  assert.equal(broker.getTask(grandchild.id)?.cancellation?.sourceTaskId, child.id);
  assert.deepEqual(
    broker.listAuditEvents({ action: "task.canceled" }).map((event) => event.targetId).sort(),
    [child.id, grandchild.id, parent.id].sort(),
  );
});

test("repeat cancel is idempotent and preserves the first cancellation record", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "run analysis",
  });

  const first = broker.cancelTask(task.id, {
    actor: { id: "hub-a", kind: "node", role: "hub" },
    reason: "first stop",
  });
  const auditCount = broker.listAuditEvents({ targetId: task.id, action: "task.canceled" }).length;

  const second = broker.cancelTask(task.id, {
    actor: { id: "hub-a", kind: "node", role: "hub" },
    reason: "second stop",
  });

  assert.equal(second.status, "canceled");
  assert.equal(second.completedAt, first.completedAt);
  assert.deepEqual(second.cancellation, first.cancellation);
  assert.equal(second.cancellation?.reason, "first stop");
  assert.equal(broker.listAuditEvents({ targetId: task.id, action: "task.canceled" }).length, auditCount);
});

test("stale requeue keeps assignedWorkerId unchanged", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const exchange = broker.startExchange({
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    message: "run analysis",
    intent: "analyze",
  });

  broker.addExchangeMessage(exchange.id, {
    actor: { id: "hub-a", kind: "node", role: "hub" },
    message: "accepted",
    decision: "accepted",
    targetNodeId: "worker-a",
    assignedWorkerId: "worker-a",
  });

  const taskId = broker.getExchange(exchange.id)?.activeTaskId;
  assert.ok(taskId);
  const task = broker.getTask(taskId);
  assert.ok(task);
  broker.claimTask(task.id, "worker-a");
  const requeued = broker.requeueStaleTasks(0, { nowMs: Date.now() });
  assert.equal(requeued.length, 1);
  assert.equal(requeued[0].assignedWorkerId, "worker-a");
  assert.equal(requeued[0].status, "queued");
});

test("requeueStaleTasks caps requeues and dead-letters the task to failed", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { maxRequeueAttempts: 2 });
  registerWorker(broker, "worker-a");

  const exchange = broker.startExchange({
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    message: "run analysis",
    intent: "analyze",
  });
  broker.addExchangeMessage(exchange.id, {
    actor: { id: "hub-a", kind: "node", role: "hub" },
    message: "accepted",
    decision: "accepted",
    targetNodeId: "worker-a",
    assignedWorkerId: "worker-a",
  });
  const taskId = broker.getExchange(exchange.id)?.activeTaskId;
  assert.ok(taskId);

  // Drive three consecutive claim → stale-requeue cycles. The first two should succeed as
  // requeues; the third must dead-letter because the task has already been requeued twice.
  broker.claimTask(taskId, "worker-a");
  let result = broker.requeueStaleTasksDetailed(0);
  assert.equal(result.requeued.length, 1);
  assert.equal(result.deadLettered.length, 0);
  assert.equal(result.requeued[0].requeueCount, 1);

  broker.claimTask(taskId, "worker-a");
  result = broker.requeueStaleTasksDetailed(0);
  assert.equal(result.requeued.length, 1);
  assert.equal(result.deadLettered.length, 0);
  assert.equal(result.requeued[0].requeueCount, 2);

  broker.claimTask(taskId, "worker-a");
  result = broker.requeueStaleTasksDetailed(0);
  assert.equal(result.requeued.length, 0);
  assert.equal(result.deadLettered.length, 1);

  const deadLettered = result.deadLettered[0];
  assert.equal(deadLettered.status, "failed");
  assert.equal(deadLettered.error?.code, "exceeded_requeue_limit");
  assert.equal(deadLettered.requeueCount, 2);
  assert.ok(deadLettered.completedAt);

  const finalTask = broker.getTask(taskId);
  assert.ok(finalTask);
  assert.equal(finalTask.status, "failed");
  assert.equal(finalTask.error?.code, "exceeded_requeue_limit");

  // Dead-lettering should also close the linked exchange so operator dashboards do not keep
  // it pinned as running forever.
  const finalExchange = broker.getExchange(exchange.id);
  assert.ok(finalExchange);
  assert.equal(finalExchange.status, "failed");
});

test("maxRequeueAttempts=0 disables the cap and allows unlimited requeues", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { maxRequeueAttempts: 0 });
  registerWorker(broker, "worker-a");

  const exchange = broker.startExchange({
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    message: "run analysis",
    intent: "analyze",
  });
  broker.addExchangeMessage(exchange.id, {
    actor: { id: "hub-a", kind: "node", role: "hub" },
    message: "accepted",
    decision: "accepted",
    targetNodeId: "worker-a",
    assignedWorkerId: "worker-a",
  });
  const taskId = broker.getExchange(exchange.id)?.activeTaskId;
  assert.ok(taskId);

  for (let i = 0; i < 10; i++) {
    broker.claimTask(taskId, "worker-a");
    const { requeued, deadLettered } = broker.requeueStaleTasksDetailed(0);
    assert.equal(requeued.length, 1, `iteration ${i} should requeue`);
    assert.equal(deadLettered.length, 0, `iteration ${i} should not dead-letter`);
  }

  const finalTask = broker.getTask(taskId);
  assert.ok(finalTask);
  assert.equal(finalTask.status, "queued");
  assert.equal(finalTask.requeueCount, 10);
});

test("reassignTask resets requeueCount so the new target gets a fresh attempt budget", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { maxRequeueAttempts: 1 });
  registerWorker(broker, "worker-a");
  registerWorker(broker, "worker-b");

  const exchange = broker.startExchange({
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    message: "run analysis",
    intent: "analyze",
  });
  broker.addExchangeMessage(exchange.id, {
    actor: { id: "hub-a", kind: "node", role: "hub" },
    message: "accepted",
    decision: "accepted",
    targetNodeId: "worker-a",
    assignedWorkerId: "worker-a",
  });
  const taskId = broker.getExchange(exchange.id)?.activeTaskId;
  assert.ok(taskId);

  // Burn the single requeue attempt worker-a gets.
  broker.claimTask(taskId, "worker-a");
  let result = broker.requeueStaleTasksDetailed(0);
  assert.equal(result.requeued[0].requeueCount, 1);

  // Operator reassigns to worker-b; the fresh target should not inherit the dead-letter
  // pressure from worker-a's flap.
  const reassigned = broker.reassignTask(taskId, {
    actor: { id: "ops", kind: "node", role: "operator" },
    targetNodeId: "worker-b",
    assignedWorkerId: "worker-b",
  });
  assert.equal(reassigned.requeueCount, 0);

  broker.claimTask(taskId, "worker-b");
  result = broker.requeueStaleTasksDetailed(0);
  assert.equal(result.requeued.length, 1, "reassigned task should be requeuable again");
  assert.equal(result.deadLettered.length, 0);
  assert.equal(result.requeued[0].requeueCount, 1);
});

test("completing an accepted exchange task marks the exchange completed", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const exchange = broker.startExchange({
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    message: "run analysis",
    intent: "analyze",
  });

  broker.addExchangeMessage(exchange.id, {
    actor: { id: "hub-a", kind: "node", role: "hub" },
    message: "accepted",
    decision: "accepted",
    targetNodeId: "worker-a",
    assignedWorkerId: "worker-a",
  });

  const taskId = broker.getExchange(exchange.id)?.activeTaskId;
  assert.ok(taskId);

  broker.claimTask(taskId, "worker-a");
  broker.startTask(taskId, "worker-a");
  const completedTask = broker.completeTask(taskId, "worker-a", {
    summary: "analysis complete",
    artifactIds: ["artifact-1"],
  });

  assert.equal(completedTask.status, "succeeded");
  assert.deepEqual(completedTask.artifactIds, ["artifact-1"]);

  const refreshedExchange = broker.getExchange(exchange.id);
  assert.ok(refreshedExchange);
  assert.equal(refreshedExchange.status, "completed");
  assert.equal(refreshedExchange.activeTaskId, taskId);
  assert.equal(refreshedExchange.assignedWorkerId, "worker-a");
  assert.equal(refreshedExchange.currentDecision, "accepted");
});

test("routing update reassigns the active exchange task instead of creating a new one", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");
  registerWorker(broker, "worker-b");

  const exchange = broker.startExchange({
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    message: "run analysis",
    intent: "analyze",
  });

  broker.addExchangeMessage(exchange.id, {
    actor: { id: "hub-a", kind: "node", role: "hub" },
    message: "accepted",
    decision: "accepted",
    targetNodeId: "worker-a",
    assignedWorkerId: "worker-a",
  });

  const originalTaskId = broker.getExchange(exchange.id)?.activeTaskId;
  assert.ok(originalTaskId);

  const rerouteMessage = broker.addExchangeMessage(exchange.id, {
    actor: { id: "hub-a", kind: "node", role: "hub" },
    message: "route this to worker-b",
    targetNodeId: "worker-b",
    assignedWorkerId: "worker-b",
  });

  const refreshedExchange = broker.getExchange(exchange.id);
  assert.ok(refreshedExchange);
  assert.equal(refreshedExchange.status, "queued");
  assert.equal(refreshedExchange.latestMessageId, rerouteMessage.id);
  assert.equal(refreshedExchange.activeTaskId, originalTaskId);
  assert.equal(refreshedExchange.targetNodeId, "worker-b");
  assert.equal(refreshedExchange.assignedWorkerId, "worker-b");

  const task = broker.getTask(originalTaskId);
  assert.ok(task);
  assert.equal(task.status, "queued");
  assert.equal(task.targetNodeId, "worker-b");
  assert.equal(task.assignedWorkerId, "worker-b");
  assert.equal(task.claimedBy, undefined);
  assert.equal(broker.listTasks({ exchangeId: exchange.id }).length, 1);
});

test("getDashboard returns aggregated queue, history, proposals, and workers", () => {
  const nowMs = Date.now();
  const broker = new InMemoryA2ABroker();

  // Register workers
  broker.registerWorker({
    nodeId: "w-online",
    role: "analyst",
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: false,
      canPromoteLive: false,
      workspaceIds: ["ws1"],
      environments: ["research"],
    },
    metadata: {},
  });

  broker.registerWorker({
    nodeId: "w-stale",
    role: "researcher",
    capabilities: {
      canAnalyze: true,
      canBackfill: true,
      canPatchWorkspace: false,
      canPromoteLive: false,
      workspaceIds: ["ws1"],
      environments: ["research"],
    },
    metadata: {},
  });

  // Create tasks in various states
  broker.createTask({
    intent: "analyze",
    requester: { id: "hub-1", kind: "node", role: "hub" },
    target: { id: "w-online", kind: "node", role: "analyst" },
    assignedWorkerId: "w-online",
    message: "task-queued-1",
  });
  broker.createTask({
    intent: "backfill",
    requester: { id: "hub-1", kind: "node", role: "hub" },
    target: { id: "w-online", kind: "node", role: "analyst" },
    assignedWorkerId: "w-online",
    message: "task-queued-2",
  });

  const dashboard = broker.getDashboard({
    nowMs,
    offlineAfterMs: 90_000,
    recentHistoryLimit: 5,
    oldestPendingLimit: 3,
    pendingActionLimit: 5,
  });

  // Queue
  assert.equal(dashboard.queue.total, 2);
  assert.equal(dashboard.queue.byStatus["queued"], 2);
  assert.equal(dashboard.queue.oldestPending.length, 2);

  // History (no completed tasks yet)
  assert.equal(dashboard.history.totalCompleted, 0);
  assert.equal(dashboard.history.totalFailed, 0);
  assert.equal(dashboard.history.recent.length, 0);

  // Proposals (none yet)
  assert.equal(dashboard.proposals.total, 0);

  // Workers (both registerWorker calls use isoNow(), so both have same lastSeenAt → both online)
  assert.equal(dashboard.workers.total, 2);
  assert.equal(dashboard.workers.online, 2);
  assert.equal(dashboard.workers.stale, 0);
  assert.ok(dashboard.workers.byNode.find((w) => w.nodeId === "w-online")!.status === "online");
  assert.ok(dashboard.workers.byNode.find((w) => w.nodeId === "w-stale")!.status === "online");

  // Timestamp
  assert.ok(new Date(dashboard.generatedAt).getTime() > 0);
});

test("getDashboard history tracks completed and failed tasks", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "w1");

  const task1 = broker.createTask({
    intent: "analyze",
    requester: { id: "hub-1", kind: "node", role: "hub" },
    target: { id: "w1", kind: "node", role: "analyst" },
    assignedWorkerId: "w1",
    message: "success-task",
  });
  broker.claimTask(task1.id, "w1");
  broker.completeTask(task1.id, "w1", { summary: "done" });

  const task2 = broker.createTask({
    intent: "backfill",
    requester: { id: "hub-1", kind: "node", role: "hub" },
    target: { id: "w1", kind: "node", role: "analyst" },
    assignedWorkerId: "w1",
    message: "fail-task",
  });
  broker.claimTask(task2.id, "w1");
  broker.failTask(task2.id, "w1", { code: "timeout", message: "took too long" });

  const dashboard = broker.getDashboard({ nowMs: Date.now() });

  assert.equal(dashboard.history.totalCompleted, 1);
  assert.equal(dashboard.history.totalFailed, 1);
  assert.equal(dashboard.history.recent.length, 2);
  const statuses = new Set(dashboard.history.recent.map((r) => r.status));
  assert.ok(statuses.has("succeeded") && statuses.has("failed"));
  const succeeded = dashboard.history.recent.find((r) => r.status === "succeeded")!;
  const failed = dashboard.history.recent.find((r) => r.status === "failed")!;
  assert.ok(succeeded.result?.summary === "done");
  assert.ok(failed.error?.code === "timeout");
});

test("getDashboard proposals shows pending action items", () => {
  const broker = new InMemoryA2ABroker();
  broker.registerWorker({
    nodeId: "w1",
    role: "analyst",
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: false,
      canPromoteLive: false,
      workspaceIds: ["ws1"],
      environments: ["research"],
    },
  });
  broker.registerWorker({
    nodeId: "w2",
    role: "live-trader",
    capabilities: {
      canAnalyze: false,
      canBackfill: false,
      canPatchWorkspace: true,
      canPromoteLive: true,
      workspaceIds: ["ws1"],
      environments: ["live"],
    },
  });

  // submitted proposal (needs validation)
  broker.createProposal({
    source: { id: "w1", kind: "node", role: "analyst" },
    target: { id: "w2", kind: "node", role: "live-trader" },
    kind: "patch",
    summary: "fix signal threshold",
    workspace: { nodeId: "w2", workspaceId: "ws1" },
    patchText: "diff --git a/config.ts ...",
  });

  const dashboard = broker.getDashboard({ nowMs: Date.now() });

  assert.equal(dashboard.proposals.total, 1);
  assert.equal(dashboard.proposals.byStatus["submitted"], 1);
  assert.equal(dashboard.proposals.pendingAction.length, 1);
  assert.equal(dashboard.proposals.pendingAction[0].status, "submitted");
});

test("getDashboard workers shows active task counts", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "w1");

  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub-1", kind: "node", role: "hub" },
    target: { id: "w1", kind: "node", role: "analyst" },
    assignedWorkerId: "w1",
    message: "active-task",
  });
  broker.claimTask(task.id, "w1");

  const dashboard = broker.getDashboard({ nowMs: Date.now() });

  const w1 = dashboard.workers.byNode.find((w) => w.nodeId === "w1")!;
  assert.equal(w1.activeTaskCount, 1);
  assert.equal(w1.role, "analyst");
  assert.ok(typeof w1.lastSeenAgeSec === "number");
});

test("getDashboard exposes broker-owned age fields for pending work and stale workers", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "w1");

  const claimedTask = broker.createTask({
    intent: "analyze",
    requester: { id: "hub-1", kind: "node", role: "hub" },
    target: { id: "w1", kind: "node", role: "analyst" },
    assignedWorkerId: "w1",
    message: "claimed-task",
  });
  const claimed = broker.claimTask(claimedTask.id, "w1");

  const runningTask = broker.createTask({
    intent: "backfill",
    requester: { id: "hub-1", kind: "node", role: "hub" },
    target: { id: "w1", kind: "node", role: "analyst" },
    assignedWorkerId: "w1",
    message: "running-task",
  });
  broker.claimTask(runningTask.id, "w1");
  const running = broker.startTask(runningTask.id, "w1");

  const nowMs = Math.max(
    Date.parse(claimed.claimedAt ?? claimed.createdAt),
    Date.parse(running.updatedAt),
    Date.parse(broker.listWorkers()[0]!.lastSeenAt),
  ) + 30_000;

  const dashboard = broker.getDashboard({ nowMs, offlineAfterMs: 10_000 });
  const pendingClaimed = dashboard.queue.oldestPending.find((task) => task.id === claimed.id)!;
  const oldestClaimed = dashboard.observability.queuePressure.oldestClaimed!;
  const oldestRunning = dashboard.observability.queuePressure.oldestRunning!;
  const staleWorker = dashboard.observability.workerHealth.staleWorkersWithActiveTasks[0]!;
  const worker = dashboard.workers.byNode.find((entry) => entry.nodeId === "w1")!;

  assert.equal(pendingClaimed.statusSinceAt, claimed.claimedAt);
  assert.ok(pendingClaimed.statusAgeSec >= 30);
  assert.equal(oldestClaimed.statusSinceAt, claimed.claimedAt);
  assert.ok(oldestClaimed.statusAgeSec >= 30);
  assert.equal(oldestRunning.statusSinceAt, running.updatedAt);
  assert.ok(oldestRunning.statusAgeSec >= 30);
  assert.equal(worker.status, "stale");
  assert.ok(worker.lastSeenAgeSec >= 30);
  assert.equal(staleWorker.nodeId, "w1");
  assert.ok(staleWorker.lastSeenAgeSec >= 30);
});

test("retention prunes stale terminal state but preserves the newest referenced graph", () => {
  const oldIso = "2020-01-01T00:00:00.000Z";
  const newerOldIso = "2020-01-02T00:00:00.000Z";
  const workerCapabilities: WorkerRecord["capabilities"] = {
    canAnalyze: true,
    canBackfill: false,
    canPatchWorkspace: false,
    canPromoteLive: false,
    workspaceIds: ["test"],
    environments: ["research"],
  };
  const hub = { id: "hub-a", kind: "node" as const, role: "hub" as const };
  const retainedWorker = {
    id: "worker-ref",
    kind: "node" as const,
    role: "analyst" as const,
  };
  const prunedWorker = {
    id: "worker-pruned",
    kind: "node" as const,
    role: "analyst" as const,
  };

  const snapshot: BrokerSnapshot = {
    version: CURRENT_BROKER_STATE_VERSION,
    exchanges: [
      {
        id: "exchange-retained",
        requester: hub,
        target: retainedWorker,
        targetNodeId: retainedWorker.id,
        assignedWorkerId: retainedWorker.id,
        message: "keep me",
        maxTurns: 1,
        intent: "analyze",
        status: "completed",
        rootMessageId: "message-retained",
        latestMessageId: "message-retained",
        messageCount: 1,
        lastMessageAt: newerOldIso,
        activeTaskId: "task-retained",
        createdAt: oldIso,
        updatedAt: newerOldIso,
      },
      {
        id: "exchange-pruned",
        requester: hub,
        target: prunedWorker,
        targetNodeId: prunedWorker.id,
        assignedWorkerId: prunedWorker.id,
        message: "prune me",
        maxTurns: 1,
        intent: "analyze",
        status: "completed",
        rootMessageId: "message-pruned",
        latestMessageId: "message-pruned",
        messageCount: 1,
        lastMessageAt: oldIso,
        activeTaskId: "task-pruned",
        createdAt: oldIso,
        updatedAt: oldIso,
      },
    ],
    exchangeMessages: [
      {
        id: "message-retained",
        exchangeId: "exchange-retained",
        kind: "root",
        message: "keep me",
        requester: hub,
        targetNodeId: retainedWorker.id,
        createdAt: newerOldIso,
        updatedAt: newerOldIso,
      },
      {
        id: "message-pruned",
        exchangeId: "exchange-pruned",
        kind: "root",
        message: "prune me",
        requester: hub,
        targetNodeId: prunedWorker.id,
        createdAt: oldIso,
        updatedAt: oldIso,
      },
    ],
    proposals: [
      {
        id: "proposal-retained",
        source: retainedWorker,
        target: retainedWorker,
        sourceNodeId: retainedWorker.id,
        targetNodeId: retainedWorker.id,
        kind: "patch",
        summary: "keep me",
        workspace: { nodeId: retainedWorker.id, workspaceId: "ws-1" },
        artifactIds: ["artifact-retained"],
        status: "applied",
        createdAt: oldIso,
        updatedAt: oldIso,
      },
      {
        id: "proposal-pruned",
        source: prunedWorker,
        target: prunedWorker,
        sourceNodeId: prunedWorker.id,
        targetNodeId: prunedWorker.id,
        kind: "patch",
        summary: "prune me",
        workspace: { nodeId: prunedWorker.id, workspaceId: "ws-2" },
        artifactIds: ["artifact-pruned"],
        status: "applied",
        createdAt: oldIso,
        updatedAt: oldIso,
      },
    ],
    artifacts: [
      {
        id: "artifact-retained",
        proposalId: "proposal-retained",
        kind: "diff",
        uri: "file:///retained.patch",
        createdAt: oldIso,
      },
      {
        id: "artifact-pruned",
        proposalId: "proposal-pruned",
        kind: "diff",
        uri: "file:///pruned.patch",
        createdAt: oldIso,
      },
    ],
    validations: [
      {
        id: "validation-retained",
        proposalId: "proposal-retained",
        nodeId: retainedWorker.id,
        kind: "smoke",
        verdict: "pass",
        metrics: {},
        artifactIds: ["artifact-retained"],
        createdAt: oldIso,
      },
      {
        id: "validation-pruned",
        proposalId: "proposal-pruned",
        nodeId: prunedWorker.id,
        kind: "smoke",
        verdict: "pass",
        metrics: {},
        artifactIds: ["artifact-pruned"],
        createdAt: oldIso,
      },
    ],
    auditEvents: [
      {
        id: "audit-retained",
        actorId: retainedWorker.id,
        action: "task.succeeded",
        targetType: "task",
        targetId: "task-retained",
        proposalId: "proposal-retained",
        createdAt: oldIso,
      },
      {
        id: "audit-pruned",
        actorId: prunedWorker.id,
        action: "task.succeeded",
        targetType: "task",
        targetId: "task-pruned",
        proposalId: "proposal-pruned",
        createdAt: oldIso,
      },
    ],
    workers: [
      {
        nodeId: retainedWorker.id,
        role: retainedWorker.role,
        capabilities: workerCapabilities,
        createdAt: oldIso,
        updatedAt: oldIso,
        lastSeenAt: oldIso,
      },
      {
        nodeId: prunedWorker.id,
        role: prunedWorker.role,
        capabilities: workerCapabilities,
        createdAt: oldIso,
        updatedAt: oldIso,
        lastSeenAt: oldIso,
      },
    ],
    tasks: [
      {
        id: "task-retained",
        exchangeId: "exchange-retained",
        intent: "analyze",
        requester: hub,
        target: retainedWorker,
        message: "keep me",
        proposalId: "proposal-retained",
        artifactIds: ["artifact-retained"],
        assignedWorkerId: retainedWorker.id,
        createdAt: oldIso,
        status: "succeeded",
        targetNodeId: retainedWorker.id,
        payload: {},
        updatedAt: newerOldIso,
        completedAt: newerOldIso,
        claimedBy: retainedWorker.id,
        result: {
          summary: "done",
          artifactIds: ["artifact-retained"],
        },
      },
      {
        id: "task-pruned",
        exchangeId: "exchange-pruned",
        intent: "analyze",
        requester: hub,
        target: prunedWorker,
        message: "prune me",
        proposalId: "proposal-pruned",
        artifactIds: ["artifact-pruned"],
        assignedWorkerId: prunedWorker.id,
        createdAt: oldIso,
        status: "succeeded",
        targetNodeId: prunedWorker.id,
        payload: {},
        updatedAt: oldIso,
        completedAt: oldIso,
        claimedBy: prunedWorker.id,
      },
    ],
  };

  const broker = new InMemoryA2ABroker(undefined, snapshot, {
    retention: {
      terminalRetentionMs: 0,
      maxTerminalExchanges: 0,
      maxTerminalTasks: 1,
      maxTerminalProposals: 0,
      inactiveWorkerRetentionMs: 0,
      maxInactiveWorkers: 0,
      auditRetentionMs: 0,
      maxAuditEvents: 0,
    },
  });

  const retained = broker.exportSnapshot();

  assert.deepEqual(retained.exchanges.map((exchange) => exchange.id), ["exchange-retained"]);
  assert.deepEqual(retained.exchangeMessages.map((message) => message.id), ["message-retained"]);
  assert.deepEqual(retained.tasks.map((task) => task.id), ["task-retained"]);
  assert.deepEqual(retained.proposals.map((proposal) => proposal.id), ["proposal-retained"]);
  assert.deepEqual(retained.artifacts.map((artifact) => artifact.id), ["artifact-retained"]);
  assert.deepEqual(retained.validations.map((validation) => validation.id), ["validation-retained"]);
  assert.deepEqual(retained.auditEvents.map((event) => event.id), ["audit-retained"]);
  assert.deepEqual(retained.workers.map((worker) => worker.nodeId), [retainedWorker.id]);
});

test("broker retention coalesces worker heartbeat audit rows without pruning worker registration proof", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, {
    retention: {
      auditRetentionMs: 60 * 60 * 1000,
      maxAuditEvents: 2,
    },
  });

  registerWorker(broker, "worker-heartbeat-cap");
  broker.heartbeatWorker("worker-heartbeat-cap");
  broker.heartbeatWorker("worker-heartbeat-cap");
  broker.heartbeatWorker("worker-heartbeat-cap");

  const auditActions = broker.exportSnapshot().auditEvents.map((event) => event.action);

  assert.equal(auditActions.filter((action) => action === "worker.registered").length, 1);
  assert.equal(auditActions.filter((action) => action === "worker.heartbeat").length, 1);
});

test("subscribeToTask streams lifecycle updates and marks terminal events final", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "run analysis",
  });

  const updates: TaskUpdate[] = [];
  const unsubscribe = broker.subscribeToTask(task.id, (update) => {
    updates.push(update);
  });

  broker.claimTask(task.id, "worker-a");
  broker.startTask(task.id, "worker-a");
  broker.completeTask(task.id, "worker-a", { summary: "done" });

  unsubscribe();

  assert.deepEqual(
    updates.map((u) => u.reason),
    ["claimed", "started", "succeeded"],
  );
  assert.deepEqual(
    updates.map((u) => u.task.status),
    ["claimed", "running", "succeeded"],
  );
  assert.deepEqual(
    updates.map((u) => u.final),
    [false, false, true],
  );
  // Snapshot safety: mutating the delivered task should not affect broker state.
  updates[0].task.status = "canceled";
  assert.equal(broker.getTask(task.id)?.status, "succeeded");
});

test("subscribeToTask emits approval updates with approval metadata", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const task = broker.createTask({
    intent: "promote_to_live",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "live-trader" },
    assignedWorkerId: "worker-a",
    message: "promote after review",
  });

  const updates: TaskUpdate[] = [];
  const unsubscribe = broker.subscribeToTask(task.id, (update) => {
    updates.push(update);
  });

  broker.approveTask(task.id, {
    actor: { id: "operator-a", kind: "user", role: "operator" },
    approvalId: "chg-28",
    reason: "operator reviewed live promotion",
  });

  unsubscribe();

  assert.deepEqual(
    updates.map((u) => u.reason),
    ["approved"],
  );
  assert.equal(updates[0].task.status, "queued");
  assert.equal(updates[0].final, false);
  assert.equal(updates[0].task.approval?.approvalId, "chg-28");
  assert.equal(updates[0].task.policyContext?.requiresApproval, true);
});

test("subscribeToTask emits dead_lettered and requeued updates during stale recovery", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, { maxRequeueAttempts: 1 });
  registerWorker(broker, "worker-a");

  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "run analysis",
  });
  broker.claimTask(task.id, "worker-a");

  const updates: TaskUpdate[] = [];
  const unsubscribe = broker.subscribeToTask(task.id, (update) => {
    updates.push(update);
  });

  // First sweep requeues (within cap).
  broker.requeueStaleTasksDetailed(0, { nowMs: Date.now() + 60_000 });
  // Second sweep dead-letters because requeueCount already matches maxRequeueAttempts=1.
  broker.claimTask(task.id, "worker-a");
  broker.requeueStaleTasksDetailed(0, { nowMs: Date.now() + 120_000 });

  unsubscribe();

  const reasons = updates.map((u) => u.reason);
  assert.ok(reasons.includes("requeued"), `expected requeued in ${reasons.join(",")}`);
  assert.ok(reasons.includes("dead_lettered"), `expected dead_lettered in ${reasons.join(",")}`);
  const terminal = updates.find((u) => u.reason === "dead_lettered");
  assert.ok(terminal);
  assert.equal(terminal.final, true);
  assert.equal(terminal.task.status, "failed");
});

test("subscribeToTask unsubscribe stops further deliveries", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");
  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "run analysis",
  });

  const updates: TaskUpdate[] = [];
  const unsubscribe = broker.subscribeToTask(task.id, (update) => {
    updates.push(update);
  });

  broker.claimTask(task.id, "worker-a");
  unsubscribe();
  broker.startTask(task.id, "worker-a");

  assert.deepEqual(
    updates.map((u) => u.reason),
    ["claimed"],
  );
});

test("subscribeToTask includes monotonically increasing seq numbers", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "run analysis",
  });

  const updates: TaskUpdate[] = [];
  const unsubscribe = broker.subscribeToTask(task.id, (update) => {
    updates.push(update);
  });

  broker.claimTask(task.id, "worker-a");
  broker.startTask(task.id, "worker-a");
  broker.completeTask(task.id, "worker-a", { summary: "done" });

  unsubscribe();

  assert.ok(updates.length === 3);
  assert.ok(updates[0].seq < updates[1].seq);
  assert.ok(updates[1].seq < updates[2].seq);
});

test("replayTaskEvents returns events buffered after the given seq", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "run analysis",
  });

  // Subscribe to trigger buffering.
  const updates: TaskUpdate[] = [];
  const unsubscribe = broker.subscribeToTask(task.id, (update) => {
    updates.push(update);
  });

  broker.claimTask(task.id, "worker-a");
  broker.startTask(task.id, "worker-a");
  broker.completeTask(task.id, "worker-a", { summary: "done" });

  unsubscribe();

  // Replay from seq 0 should return events with seq > 0.
  const replayed = broker.replayTaskEvents(task.id, 0);
  assert.ok(replayed.length >= 2);
  for (const event of replayed) {
    assert.ok(event.seq > 0);
  }
});

test("replayTaskEvents returns empty for unknown task", () => {
  const broker = new InMemoryA2ABroker();
  const replayed = broker.replayTaskEvents("nonexistent", 0);
  assert.deepEqual(replayed, []);
});

test("formatSseEventId and parseSseEventId round-trip", () => {
  const broker = new InMemoryA2ABroker();
  const id = broker.formatSseEventId("task-abc", 42);
  assert.equal(id, "task-abc:42");
  const parsed = broker.parseSseEventId(id);
  assert.deepEqual(parsed, { taskId: "task-abc", seq: 42 });
});

test("parseSseEventId returns null for malformed values", () => {
  const broker = new InMemoryA2ABroker();
  assert.equal(broker.parseSseEventId(""), null);
  assert.equal(broker.parseSseEventId("no-colon"), null);
  assert.equal(broker.parseSseEventId(":123"), null);
  assert.equal(broker.parseSseEventId("task:notanumber"), null);
});

test("event buffer respects maxBufferedEventsPerTask limit", () => {
  const broker = new InMemoryA2ABroker(undefined, undefined, {
    maxBufferedEventsPerTask: 3,
  });
  registerWorker(broker, "worker-a");

  // Create multiple tasks and drive lifecycle to generate events.
  for (let i = 0; i < 5; i++) {
    const task = broker.createTask({
      intent: "analyze",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-a", kind: "node", role: "analyst" },
      assignedWorkerId: "worker-a",
      message: `run analysis ${i}`,
    });
    broker.claimTask(task.id, "worker-a");
    broker.startTask(task.id, "worker-a");
    broker.completeTask(task.id, "worker-a", { summary: `done ${i}` });
  }

  // Pick the first task and verify buffer is capped at 3.
  const allTasks = broker.listTasks({});
  const firstTask = allTasks[0];
  const allEvents = broker.replayTaskEvents(firstTask.id, -1);
  assert.ok(allEvents.length <= 3, `expected <= 3 events, got ${allEvents.length}`);
});

// ---------------------------------------------------------------------------
// Durable task/attempt identity and idempotent create semantics
// ---------------------------------------------------------------------------

test("idempotent create returns existing task for same id", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const task1 = broker.createTask({
    id: "dup-1",
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    message: "run analysis",
  });

  const auditBefore = broker.listAuditEvents({ targetId: "dup-1" });

  const task2 = broker.createTask({
    id: "dup-1",
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    message: "run analysis again",
  });

  assert.equal(task1, task2);

  const auditAfter = broker.listAuditEvents({ targetId: "dup-1" });
  assert.equal(auditAfter.length, auditBefore.length, "no duplicate audit events");
});

test("idempotent create does not revalidate", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const task = broker.createTask({
    id: "dup-noval",
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    message: "run analysis",
  });

  // Second create with a non-existent worker should NOT throw — it returns the existing task.
  const task2 = broker.createTask({
    id: "dup-noval",
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "no-such-worker", kind: "node", role: "analyst" },
    assignedWorkerId: "no-such-worker",
    message: "invalid worker",
  });

  assert.equal(task, task2);
});

test("claimTask generates attemptId", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "run analysis",
  });

  const claimed = broker.claimTask(task.id, "worker-a");
  assert.equal(typeof claimed.attemptId, "string");
  const firstAttemptId = claimed.attemptId;

  // Requeue and claim again — should get a new attemptId
  broker.requeueStaleTasks(0, { nowMs: Date.now() + 999_999 });
  const reclaimedTask = broker.getTask(task.id)!;
  assert.equal(reclaimedTask.attemptId, undefined);

  const claimed2 = broker.claimTask(task.id, "worker-a");
  assert.equal(typeof claimed2.attemptId, "string");
  assert.notEqual(claimed2.attemptId, firstAttemptId);
});

test("reassign clears attemptId", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");
  registerWorker(broker, "worker-b");

  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "run analysis",
  });

  broker.claimTask(task.id, "worker-a");
  const claimed = broker.getTask(task.id)!;
  assert.ok(claimed.attemptId);

  broker.reassignTask(task.id, {
    actor: { id: "hub-a", kind: "node", role: "operator" },
    targetNodeId: "worker-b",
  });

  const reassigned = broker.getTask(task.id)!;
  assert.equal(reassigned.attemptId, undefined);
});

test("completeTask is idempotent on already-succeeded", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "run analysis",
  });

  broker.claimTask(task.id, "worker-a");
  const completed1 = broker.completeTask(task.id, "worker-a", { summary: "done" });
  const completed2 = broker.completeTask(task.id, "worker-a", { summary: "done again" });

  assert.equal(completed1.completedAt, completed2.completedAt);
  assert.deepEqual(completed1.result, completed2.result);
  assert.equal(completed2.status, "succeeded");
});

test("failTask is idempotent on already-failed", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "run analysis",
  });

  broker.claimTask(task.id, "worker-a");
  const failed1 = broker.failTask(task.id, "worker-a", { message: "boom" });
  const failed2 = broker.failTask(task.id, "worker-a", { message: "boom again" });

  assert.equal(failed1.completedAt, failed2.completedAt);
  assert.deepEqual(failed1.error, failed2.error);
  assert.equal(failed2.status, "failed");
});

test("completeTask on already-canceled returns task without mutation", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "run analysis",
  });

  broker.claimTask(task.id, "worker-a");
  broker.cancelTask(task.id, {
    actor: { id: "hub-a", kind: "node", role: "hub" },
    reason: "no longer needed",
  });

  const result = broker.completeTask(task.id, "worker-a", { summary: "done" });
  assert.equal(result.status, "canceled");
});

test("failTask on already-succeeded returns task without mutation", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const task = broker.createTask({
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "run analysis",
  });

  broker.claimTask(task.id, "worker-a");
  broker.completeTask(task.id, "worker-a", { summary: "done" });

  const result = broker.failTask(task.id, "worker-a", { message: "boom" });
  assert.equal(result.status, "succeeded");
});

test("accepted-task wake planning is durable and duplicate-safe", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const task = broker.createTask({
    id: "task-wake-1",
    intent: "chat",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "wake target",
    payload: {
      waitRunId: "wait-1",
      correlationId: "corr-1",
      parentRunId: "parent-1",
    },
  });

  const firstPlan = broker.planAcceptedTaskWake(task.id, {
    targetSessionKey: "agent:worker-a",
    targetNodeId: "worker-a",
    waitRunId: "wait-1",
    correlationId: "corr-1",
    parentRunId: "parent-1",
  });
  assert.equal(firstPlan.shouldDispatch, true);
  assert.equal(firstPlan.replayed, false);
  assert.equal(firstPlan.wake.status, "planned");
  assert.equal(firstPlan.wake.wakeKey, "corr-1:wait-1");
  assert.equal(firstPlan.wake.idempotencyKey, "a2a-wake:corr-1:wait-1");

  const scheduled = broker.recordTaskWakeDecision(task.id, {
    status: "scheduled",
    runtimeRunId: "run-1",
    coalesced: false,
    message: "queued for target wake",
  });
  assert.equal(scheduled.wake?.status, "scheduled");
  assert.equal(scheduled.wake?.runtimeRunId, "run-1");

  const replay = broker.planAcceptedTaskWake(task.id, {
    targetSessionKey: "agent:worker-a",
    targetNodeId: "worker-a",
    waitRunId: "wait-1",
    correlationId: "corr-1",
    parentRunId: "parent-1",
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.shouldDispatch, false);
  assert.equal(replay.wake.status, "scheduled");
  assert.equal(replay.wake.replayCount, 1);

  assert.equal(
    broker.listAuditEvents({ targetId: task.id, action: "task.wake.planned" }).length,
    1,
  );
  assert.equal(
    broker.listAuditEvents({ targetId: task.id, action: "task.wake.scheduled" }).length,
    1,
  );
});

test("accepted-task wake replay after restart preserves pending and decided state", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const task = broker.createTask({
    id: "task-wake-restart",
    intent: "chat",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "wake target",
  });
  broker.planAcceptedTaskWake(task.id, {
    targetSessionKey: "agent:worker-a",
    targetNodeId: "worker-a",
    waitRunId: "wait-restart",
    correlationId: "corr-restart",
  });

  const restarted = new InMemoryA2ABroker(undefined, broker.exportSnapshot());
  const replayPlan = restarted.planAcceptedTaskWake(task.id, {
    targetSessionKey: "agent:worker-a",
    targetNodeId: "worker-a",
    waitRunId: "wait-restart",
    correlationId: "corr-restart",
  });
  assert.equal(replayPlan.replayed, true);
  assert.equal(replayPlan.shouldDispatch, true);
  assert.equal(replayPlan.wake.status, "planned");
  assert.equal(replayPlan.wake.replayCount, 1);

  restarted.recordTaskWakeDecision(task.id, {
    status: "skipped",
    code: "wake_disabled",
    message: "Wake-on-Task disabled by default",
  });
  const secondRestart = new InMemoryA2ABroker(undefined, restarted.exportSnapshot());
  const persisted = secondRestart.getTask(task.id);
  assert.equal(persisted?.wake?.status, "skipped");
  assert.equal(persisted?.wake?.code, "wake_disabled");

  const replayAfterDecision = secondRestart.planAcceptedTaskWake(task.id, {
    targetSessionKey: "agent:worker-a",
    targetNodeId: "worker-a",
    waitRunId: "wait-restart",
    correlationId: "corr-restart",
  });
  assert.equal(replayAfterDecision.replayed, true);
  assert.equal(replayAfterDecision.shouldDispatch, false);
  assert.equal(replayAfterDecision.wake.status, "skipped");
});

test("accepted-task wake failure is durable and operator-visible", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-a");

  const task = broker.createTask({
    id: "task-wake-failure",
    intent: "chat",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    assignedWorkerId: "worker-a",
    message: "wake target",
  });
  broker.planAcceptedTaskWake(task.id, {
    targetSessionKey: "agent:worker-a",
    targetNodeId: "worker-a",
    waitRunId: "wait-fail",
    correlationId: "corr-fail",
  });
  broker.recordTaskWakeDecision(task.id, {
    status: "failed",
    code: "wake_dispatch_failed",
    message: "runtime unavailable",
  });

  const restarted = new InMemoryA2ABroker(undefined, broker.exportSnapshot());
  const persisted = restarted.getTask(task.id);
  assert.equal(persisted?.wake?.status, "failed");
  assert.equal(persisted?.wake?.code, "wake_dispatch_failed");
  assert.equal(persisted?.wake?.message, "runtime unavailable");

  const failures = restarted.listAuditEvents({
    targetId: task.id,
    action: "task.wake.failed",
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0].note ?? "", /runtime unavailable/);
});

test("broker accepts canonical GitHub patch dispatch and stamps taskOrigin", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-github-canonical");

  const task = broker.createTask({
    intent: "propose_patch",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-github-canonical", kind: "node", role: "analyst" },
    message: "fix issue",
    payload: {
      mode: "github-propose-patch",
      repo: "acme/platform",
      issueNumber: 291,
      issueUrl: "https://github.com/acme/platform/issues/291",
    },
  });

  assert.equal(task.taskOrigin, "github");
  assert.equal(task.payload.mode, "github-propose-patch");
  assert.equal(task.payload.repo, "acme/platform");
  assert.equal(task.payload.issue, "#291");
  assert.equal(task.payload.issueNumber, 291);
  assert.equal(task.payload.issueUrl, "https://github.com/acme/platform/issues/291");
  assert.equal(task.payload.githubDispatchCompatibility, undefined);
});

test("broker normalizes legacy GitHub dispatch fields with compatibility marker", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-github-legacy");

  const task = broker.createTask({
    intent: "propose_patch",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-github-legacy", kind: "node", role: "analyst" },
    message: "fix issue",
    payload: {
      githubRepo: "acme/platform",
      githubIssueNumber: 292,
      workMode: "github",
    },
  });

  assert.equal(task.taskOrigin, "github");
  assert.equal(task.payload.mode, "github-propose-patch");
  assert.equal(task.payload.repo, "acme/platform");
  assert.equal(task.payload.issue, "#292");
  assert.equal(task.payload.issueNumber, 292);
  assert.equal(task.payload.issueUrl, "https://github.com/acme/platform/issues/292");
  assert.deepEqual(task.payload.githubDispatchCompatibility, {
    normalizedFromLegacyPayload: true,
    legacyFields: ["githubRepo", "githubIssueNumber", "workMode"],
  });
});

test("broker rejects non-canonical GitHub dispatch with wrong taskOrigin", () => {
  const broker = new InMemoryA2ABroker();
  registerWorker(broker, "worker-github-reject");

  assert.throws(
    () => broker.createTask({
      intent: "propose_patch",
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-github-reject", kind: "node", role: "analyst" },
      taskOrigin: "api",
      message: "fix issue",
      payload: {
        mode: "github-propose-patch",
        repo: "acme/platform",
        issueNumber: 293,
      },
    }),
    /taskOrigin=github/,
  );
});
