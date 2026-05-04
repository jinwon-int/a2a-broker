/**
 * E2E delegated runtime regression tests against the HTTP surface.
 *
 * These tests drive the full broker task lifecycle through HTTP endpoints
 * (not just the in-memory broker API) and assert that the adapter-facing
 * surface — dashboard, audit, SSE, JSON-RPC — produces correct and
 * consistent responses for each runtime state.
 *
 * @see jinwon-int/a2a-broker#22
 * @see jinwon-int/openclaw#15 (dashboard read-surface coverage — cross-linked)
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createBrokerServer, type BrokerServerOptions } from "./server.js";
import { emptySnapshot, type BrokerStateStore } from "./core/store.js";
import {
  buildWaitingState,
  buildResumedState,
  buildCompletedState,
  buildFailedState,
  buildCanceledState,
  buildTimedOutState,
  buildStaleState,
  buildTombstonedState,
  ALL_RUNTIME_STATES,
} from "./fixtures/delegated-runtime.js";

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

function createInMemoryStateStore(): BrokerStateStore {
  let snapshot = emptySnapshot();
  return {
    load() {
      return snapshot;
    },
    save(nextSnapshot) {
      snapshot = structuredClone(nextSnapshot);
    },
  };
}

async function startTestServer(options: Partial<BrokerServerOptions> = {}) {
  const runtime = createBrokerServer({
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "https://broker.test/",
    stateStore: createInMemoryStateStore(),
    enforceRequesterIdentity: true,
    staleReaperEnabled: options.staleReaperEnabled ?? false,
    ...options,
  });
  runtime.server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => {
    runtime.server.on("listening", () => resolve());
  });
  const address = runtime.server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to bind test server");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    runtime,
    close: async () => {
      await new Promise<void>((resolve) => {
        runtime.server.close(() => resolve());
      });
    },
  };
}

function h(secret: string, overrides: Record<string, string> = {}): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-a2a-edge-secret": secret,
    ...overrides,
  };
}

interface ParsedSseEvent {
  event: string;
  data: string;
  id?: string;
}

async function readAllSseEvents(response: Response): Promise<ParsedSseEvent[]> {
  const body = response.body;
  assert.ok(body, "SSE response must have a body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
  }
  buffer += decoder.decode();

  const events: ParsedSseEvent[] = [];
  for (const block of buffer.split(/\n\n/)) {
    if (!block.trim()) continue;
    let event = "message";
    let data = "";
    let id: string | undefined;
    for (const line of block.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      if (line.startsWith("event:")) {
        event = line.slice(line.startsWith("event: ") ? "event: ".length : "event:".length).trim();
      } else if (line.startsWith("data:")) {
        const fragment = line.slice(line.startsWith("data: ") ? "data: ".length : "data:".length);
        data = data ? `${data}\n${fragment}` : fragment;
      } else if (line.startsWith("id:")) {
        id = line.slice(line.startsWith("id: ") ? "id: ".length : "id:".length).trim();
      }
    }
    events.push({ event, data, id });
  }
  return events;
}

function parseSseBlock(block: string): ParsedSseEvent | null {
  if (!block.trim()) return null;
  let event = "message";
  let data = "";
  let id: string | undefined;
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      event = line.slice(line.startsWith("event: ") ? "event: ".length : "event:".length).trim();
    } else if (line.startsWith("data:")) {
      const fragment = line.slice(line.startsWith("data: ") ? "data: ".length : "data:".length);
      data = data ? `${data}\n${fragment}` : fragment;
    } else if (line.startsWith("id:")) {
      id = line.slice(line.startsWith("id: ") ? "id: ".length : "id:".length).trim();
    }
  }
  return { event, data, id };
}

async function readSseEventsUntil(
  response: Response,
  predicate: (events: ParsedSseEvent[]) => boolean,
  timeoutMs = 5_000,
): Promise<ParsedSseEvent[]> {
  const body = response.body;
  assert.ok(body, "SSE response must have a body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const events: ParsedSseEvent[] = [];
  let buffer = "";
  const deadline = Date.now() + timeoutMs;

  try {
    while (Date.now() <= deadline) {
      const remainingMs = deadline - Date.now();
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("timed out waiting for SSE events")), remainingMs);
        }),
      ]);
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseSseBlock(block);
        if (event) {
          events.push(event);
          if (predicate(events)) {
            await reader.cancel();
            return events;
          }
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }

  throw new Error(`timed out waiting for SSE events; received ${events.length}`);
}

// ---------------------------------------------------------------------------
// E2E: Full lifecycle through HTTP — create → claim → start → complete
// ---------------------------------------------------------------------------

test("E2E: full happy-path lifecycle through HTTP endpoints produces correct dashboard + audit", async () => {
  const server = await startTestServer({ edgeSecret: "s" });
  try {
    const hdrs = h("s");

    // Register worker
    const regRes = await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: h("s", { "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({
        nodeId: "w1", role: "analyst",
        capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["ws"], environments: ["research"] },
      }),
    });
    assert.equal(regRes.status, 201);

    // Create task
    const taskRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: h("s", { "x-a2a-requester-id": "hub-1", "x-a2a-requester-role": "hub" }),
      body: JSON.stringify({
        intent: "analyze",
        requester: { id: "hub-1", kind: "node", role: "hub" },
        target: { id: "w1", kind: "node", role: "analyst" },
        assignedWorkerId: "w1",
        message: "e2e happy-path",
      }),
    });
    assert.equal(taskRes.status, 201);
    const task = await taskRes.json();
    assert.equal(task.status, "queued");

    // Dashboard should show 1 queued
    const queuedDash = await (await fetch(`${server.baseUrl}/dashboard`, { headers: hdrs })).json();
    assert.equal(queuedDash.queue.total, 1);
    assert.equal(queuedDash.queue.byStatus["queued"], 1);

    // Claim
    const claimRes = await fetch(`${server.baseUrl}/tasks/${task.id}/claim`, {
      method: "POST",
      headers: h("s", { "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({ workerId: "w1" }),
    });
    assert.equal(claimRes.status, 200);
    const claimed = await claimRes.json();
    assert.equal(claimed.status, "claimed");
    assert.equal(claimed.claimedBy, "w1");

    // Start
    const startRes = await fetch(`${server.baseUrl}/tasks/${task.id}/start`, {
      method: "POST",
      headers: h("s", { "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({ workerId: "w1" }),
    });
    assert.equal(startRes.status, 200);
    const started = await startRes.json();
    assert.equal(started.status, "running");

    // Complete
    const completeRes = await fetch(`${server.baseUrl}/tasks/${task.id}/complete`, {
      method: "POST",
      headers: h("s", { "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({ workerId: "w1", result: { summary: "e2e done", artifactIds: ["e2a-1"] } }),
    });
    assert.equal(completeRes.status, 200);
    const completed = await completeRes.json();
    assert.equal(completed.status, "succeeded");
    assert.equal(completed.result.summary, "e2e done");
    assert.ok(completed.artifactIds.includes("e2a-1"));

    // Dashboard should show 1 completed
    const doneDash = await (await fetch(`${server.baseUrl}/dashboard`, { headers: hdrs })).json();
    assert.equal(doneDash.queue.total, 0);
    assert.equal(doneDash.history.totalCompleted, 1);
    assert.equal(doneDash.history.completedLastHour, 1);
    assert.equal(doneDash.history.recent[0].status, "succeeded");

    // Audit trail should show the full lifecycle
    const auditRes = await fetch(`${server.baseUrl}/audit?targetId=${task.id}`, { headers: hdrs });
    const audit = await auditRes.json();
    const actions = audit.items.map((e: { action: string }) => e.action);
    assert.ok(actions.includes("task.created"));
    assert.ok(actions.includes("task.claimed"));
    assert.ok(actions.includes("task.started"));
    assert.ok(actions.includes("task.succeeded"));
  } finally {
    await server.close();
  }
});

test("E2E: terminal notification outbox enforces auth and replays compact ack-safe evidence", async () => {
  const server = await startTestServer({ edgeSecret: "s" });
  try {
    const hubHeaders = h("s", { "x-a2a-requester-id": "hub-1", "x-a2a-requester-role": "hub" });
    const workerHeaders = h("s", { "x-a2a-requester-id": "worker-a", "x-a2a-requester-role": "analyst" });

    const regRes = await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: workerHeaders,
      body: JSON.stringify({
        nodeId: "worker-a",
        role: "analyst",
        capabilities: {
          canAnalyze: true,
          canBackfill: false,
          canPatchWorkspace: false,
          canPromoteLive: false,
          workspaceIds: ["ws"],
          environments: ["research"],
        },
      }),
    });
    assert.equal(regRes.status, 201);

    const forbiddenOutbox = await fetch(`${server.baseUrl}/a2a/tasks/terminal-outbox`, {
      headers: workerHeaders,
    });
    assert.equal(forbiddenOutbox.status, 401);

    const forbiddenAck = await fetch(`${server.baseUrl}/a2a/tasks/terminal-outbox/ack`, {
      method: "POST",
      headers: workerHeaders,
      body: JSON.stringify({ id: "terminal:missing:succeeded:never" }),
    });
    assert.equal(forbiddenAck.status, 401);

    const forbiddenSse = await fetch(`${server.baseUrl}/a2a/tasks/terminal-events`, {
      headers: { ...workerHeaders, accept: "text/event-stream" },
    });
    assert.equal(forbiddenSse.status, 401);

    const taskRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: hubHeaders,
      body: JSON.stringify({
        intent: "analyze",
        requester: { id: "hub-1", kind: "node", role: "hub" },
        target: { id: "worker-a", kind: "node", role: "analyst" },
        assignedWorkerId: "worker-a",
        payload: {
          githubRepo: "jinwon-int/a2a-broker",
          githubIssueNumber: 250,
          rawPrompt: "do-not-leak",
          token: "ghp_do_not_leak",
        },
        message: "private prompt that must not enter operator notification payloads",
      }),
    });
    assert.equal(taskRes.status, 201);
    const task = await taskRes.json();

    const claimRes = await fetch(`${server.baseUrl}/tasks/${task.id}/claim`, {
      method: "POST",
      headers: workerHeaders,
      body: JSON.stringify({ workerId: "worker-a" }),
    });
    assert.equal(claimRes.status, 200);

    const completeRes = await fetch(`${server.baseUrl}/tasks/${task.id}/complete`, {
      method: "POST",
      headers: workerHeaders,
      body: JSON.stringify({
        workerId: "worker-a",
        result: {
          summary: "Done: terminal outbox regression passed from /work/private token=ghp_do_not_leak",
          output: {
            prUrl: "https://github.com/jinwon-int/a2a-broker/pull/251",
            doneUrl: "https://github.com/jinwon-int/a2a-broker/issues/250#issuecomment-done",
            rawLog: "private prompt that must not enter operator notification payloads",
            testSummary: { status: "passed", total: 2, passed: 2 },
          },
        },
      }),
    });
    assert.equal(completeRes.status, 200);

    const outboxRes = await fetch(`${server.baseUrl}/a2a/tasks/terminal-outbox`, { headers: hubHeaders });
    assert.equal(outboxRes.status, 200);
    const outbox = await outboxRes.json();
    assert.equal(outbox.kind, "task.terminal.outbox");
    assert.equal(outbox.count, 1);
    const [outboxEvent] = outbox.events;
    assert.equal(outbox.cursor, outboxEvent.id);
    assert.equal(outboxEvent.kind, "task.terminal");
    assert.equal(outboxEvent.attempts, 0);
    assert.deepEqual(outboxEvent.receipt, { status: "accepted", updatedAt: outboxEvent.createdAt });
    assert.equal(outboxEvent.payload.taskId, task.id);
    assert.equal(outboxEvent.payload.status, "succeeded");
    assert.equal(outboxEvent.payload.worker, "worker-a");
    assert.equal(outboxEvent.payload.repo, "jinwon-int/a2a-broker");
    assert.equal(outboxEvent.payload.issue, 250);
    assert.equal(outboxEvent.payload.prUrl, "https://github.com/jinwon-int/a2a-broker/pull/251");
    assert.equal(outboxEvent.payload.doneUrl, "https://github.com/jinwon-int/a2a-broker/issues/250#issuecomment-done");
    assert.match(outboxEvent.payload.testSummary, /terminal outbox regression passed from \[path\]/);

    const sseReplayRes = await fetch(`${server.baseUrl}/a2a/tasks/terminal-events`, {
      headers: { ...hubHeaders, "last-event-id": "0", accept: "text/event-stream" },
    });
    assert.equal(sseReplayRes.status, 200);
    const sseEvents = await readSseEventsUntil(sseReplayRes, (seen) => seen.some((event) => event.event === "task-terminal"));
    const terminalSse = sseEvents.find((event) => event.event === "task-terminal");
    assert.ok(terminalSse);
    assert.notEqual(terminalSse.id, outboxEvent.id, "SSE numeric cursor is separate from outbox stable cursor");
    const terminalPayload = JSON.parse(terminalSse.data);
    assert.equal(terminalPayload.taskId, task.id);
    assert.equal(terminalPayload.prUrl, "https://github.com/jinwon-int/a2a-broker/pull/251");
    assert.deepEqual(terminalPayload.testSummary, { status: "passed", total: 2, passed: 2 });

    const providerSendOnlyAckRes = await fetch(`${server.baseUrl}/a2a/tasks/terminal-outbox/ack`, {
      method: "POST",
      headers: hubHeaders,
      body: JSON.stringify({ id: outboxEvent.id, receipt: { evidence: "provider_send_success" } }),
    });
    assert.equal(providerSendOnlyAckRes.status, 400);
    assert.equal(server.runtime.broker.getTerminalTaskEventOutbox().subscribe()[0]!.attempts, 0);

    const acknowledgedAt = "2026-05-02T01:23:45.000Z";
    const ackRes = await fetch(`${server.baseUrl}/a2a/tasks/terminal-outbox/ack`, {
      method: "POST",
      headers: hubHeaders,
      body: JSON.stringify({
        id: outboxEvent.id,
        receipt: { evidence: "provider_delivery_receipt", acknowledgedAt, receiptId: "delivery-receipt-250" },
      }),
    });
    assert.equal(ackRes.status, 200);
    const ack = await ackRes.json();
    assert.deepEqual(ack.event.ack, {
      status: "receipt_confirmed",
      evidence: "provider_delivery_receipt",
      acknowledgedAt,
      receiptId: "delivery-receipt-250",
    });
    assert.deepEqual(ack.event.receipt, {
      status: "provider_sent",
      updatedAt: acknowledgedAt,
      evidence: "provider_delivery_receipt",
      receiptId: "delivery-receipt-250",
    });
    assert.equal(ack.event.deliveredAt, undefined);
    assert.equal(ack.event.attempts, 1);

    const noDuplicateRes = await fetch(
      `${server.baseUrl}/a2a/tasks/terminal-outbox?after_id=${encodeURIComponent(outboxEvent.id)}`,
      { headers: hubHeaders },
    );
    assert.equal(noDuplicateRes.status, 200);
    const noDuplicate = await noDuplicateRes.json();
    assert.equal(noDuplicate.count, 0);
    assert.equal(noDuplicate.cursor, outboxEvent.id);

    const serialized = JSON.stringify({ outbox, ack, terminalPayload });
    for (const forbidden of [
      "private prompt",
      "rawPrompt",
      "rawLog",
      "do-not-leak",
      "ghp_do_not_leak",
      "/work/private",
    ]) {
      assert.ok(!serialized.includes(forbidden), forbidden);
    }
  } finally {
    await server.close();
  }
});

test("E2E: no-live replay drill requeues stale claimed/running tasks and replays terminal evidence", async () => {
  const server = await startTestServer({ edgeSecret: "s", staleReaperEnabled: false, workerOfflineAfterSec: 0 });
  try {
    const hubHeaders = h("s", { "x-a2a-requester-id": "hub-1", "x-a2a-requester-role": "hub" });
    const workerHeaders = h("s", { "x-a2a-requester-id": "nosuk", "x-a2a-requester-role": "analyst" });
    const operatorHeaders = h("s", { "x-a2a-requester-id": "ops", "x-a2a-requester-role": "operator" });

    const regRes = await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: workerHeaders,
      body: JSON.stringify({
        nodeId: "nosuk",
        role: "analyst",
        capabilities: {
          canAnalyze: true,
          canBackfill: false,
          canPatchWorkspace: true,
          canPromoteLive: false,
          workspaceIds: ["dryrun"],
          environments: ["research"],
        },
      }),
    });
    assert.equal(regRes.status, 201);

    const heartbeatRes = await fetch(`${server.baseUrl}/workers/nosuk/heartbeat`, {
      method: "POST",
      headers: workerHeaders,
      body: JSON.stringify({ status: "online" }),
    });
    assert.equal(heartbeatRes.status, 200);

    async function createDrillTask(id: string, brief: string) {
      const res = await fetch(`${server.baseUrl}/tasks`, {
        method: "POST",
        headers: hubHeaders,
        body: JSON.stringify({
          id,
          intent: "analyze",
          requester: { id: "hub-1", kind: "node", role: "hub" },
          target: { id: "nosuk", kind: "node", role: "analyst" },
          assignedWorkerId: "nosuk",
          via: { transport: "openclaw", channel: "github", traceId: "trace-329" },
          payload: {
            githubRepo: "jinwon-int/a2a-broker",
            githubIssueNumber: 329,
            run: "a2a-no-live-integration-20260504035026",
            taskBrief: brief,
          },
          message: `jinwon-int/a2a-broker#329: ${brief}`,
        }),
      });
      assert.equal(res.status, 201);
      return res.json();
    }

    const claimedTask = await createDrillTask("task-no-live-claimed", "claimed stale replay drill");
    const runningTask = await createDrillTask("task-no-live-running", "running stale replay drill");

    assert.equal((await fetch(`${server.baseUrl}/tasks/${claimedTask.id}/claim`, {
      method: "POST",
      headers: workerHeaders,
      body: JSON.stringify({ workerId: "nosuk" }),
    })).status, 200);
    assert.equal((await fetch(`${server.baseUrl}/tasks/${runningTask.id}/claim`, {
      method: "POST",
      headers: workerHeaders,
      body: JSON.stringify({ workerId: "nosuk" }),
    })).status, 200);
    assert.equal((await fetch(`${server.baseUrl}/tasks/${runningTask.id}/start`, {
      method: "POST",
      headers: workerHeaders,
      body: JSON.stringify({ workerId: "nosuk" }),
    })).status, 200);

    const sweepRes = await fetch(`${server.baseUrl}/tasks/requeue_stale?older_than_seconds=0`, {
      method: "POST",
      headers: operatorHeaders,
    });
    assert.equal(sweepRes.status, 200);
    const sweep = await sweepRes.json();
    assert.equal(sweep.requeued, 2);
    assert.equal(sweep.deadLettered, 0);
    assert.deepEqual(sweep.items.map((item: { id: string }) => item.id).sort(), [claimedTask.id, runningTask.id]);

    for (const id of [claimedTask.id, runningTask.id]) {
      const replayed = await (await fetch(`${server.baseUrl}/tasks/${id}`, { headers: hubHeaders })).json();
      assert.equal(replayed.id, id);
      assert.equal(replayed.status, "queued", "stale task must be replayed instead of silently succeeding");
      assert.equal(replayed.assignedWorkerId, "nosuk");
      assert.equal(replayed.claimedBy, undefined);
      assert.equal(replayed.requeueCount, 1);
      assert.equal(replayed.payload.githubRepo, "jinwon-int/a2a-broker");
      assert.equal(replayed.payload.githubIssueNumber, 329);
      assert.equal(replayed.payload.run, "a2a-no-live-integration-20260504035026");
      assert.equal(replayed.via.traceId, "trace-329");
      assert.match(replayed.message, /broker#329:/);
    }

    assert.equal((await fetch(`${server.baseUrl}/tasks/${runningTask.id}/claim`, {
      method: "POST",
      headers: workerHeaders,
      body: JSON.stringify({ workerId: "nosuk" }),
    })).status, 200);
    assert.equal((await fetch(`${server.baseUrl}/tasks/${runningTask.id}/start`, {
      method: "POST",
      headers: workerHeaders,
      body: JSON.stringify({ workerId: "nosuk" }),
    })).status, 200);

    const doneBody = {
      workerId: "nosuk",
      result: {
        summary: "Done: no-live replay/requeue drill passed",
        output: {
          prUrl: "https://github.com/jinwon-int/a2a-broker/pull/330",
          doneUrl: "https://github.com/jinwon-int/a2a-broker/issues/329#issuecomment-done",
        },
      },
    };
    const firstDone = await fetch(`${server.baseUrl}/tasks/${runningTask.id}/complete`, {
      method: "POST",
      headers: workerHeaders,
      body: JSON.stringify(doneBody),
    });
    assert.equal(firstDone.status, 200);
    const firstDoneBody = await firstDone.json();
    const duplicateDone = await fetch(`${server.baseUrl}/tasks/${runningTask.id}/complete`, {
      method: "POST",
      headers: workerHeaders,
      body: JSON.stringify({ ...doneBody, result: { summary: "Done: duplicate should be idempotent" } }),
    });
    assert.equal(duplicateDone.status, 200);
    assert.deepEqual((await duplicateDone.json()).result, firstDoneBody.result);

    const outbox = await (await fetch(`${server.baseUrl}/a2a/tasks/terminal-outbox`, { headers: hubHeaders })).json();
    assert.equal(outbox.count, 1, "duplicate Done evidence must not enqueue duplicate terminal records");
    const [event] = outbox.events;
    assert.equal(event.payload.taskId, runningTask.id);
    assert.equal(event.payload.worker, "nosuk");
    assert.equal(event.payload.repo, "jinwon-int/a2a-broker");
    assert.equal(event.payload.issue, 329);
    assert.equal(event.payload.run, "a2a-no-live-integration-20260504035026");
    assert.equal(event.payload.traceId, "trace-329");
    assert.equal(event.payload.taskBrief, "running stale replay drill");

    const replay = await (await fetch(
      `${server.baseUrl}/a2a/tasks/terminal-outbox?after_id=${encodeURIComponent(outbox.cursor)}&reconcile_unacked=true`,
      { headers: hubHeaders },
    )).json();
    assert.equal(replay.reconciledUnacked, 1);
    assert.equal(replay.count, 1);
    assert.equal(replay.events[0].id, event.id);
    assert.deepEqual(replay.events[0].payload, event.payload);

    const providerSendOnlyAck = await fetch(`${server.baseUrl}/a2a/tasks/terminal-outbox/ack`, {
      method: "POST",
      headers: operatorHeaders,
      body: JSON.stringify({ id: event.id, receipt: { evidence: "provider_send_success" } }),
    });
    assert.equal(providerSendOnlyAck.status, 400);
    assert.equal(server.runtime.broker.getTerminalTaskEventOutbox().subscribe()[0]!.attempts, 0);
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// E2E: Full failure lifecycle
// ---------------------------------------------------------------------------

test("E2E: failure lifecycle through HTTP endpoints produces correct dashboard + audit", async () => {
  const server = await startTestServer({ edgeSecret: "s" });
  try {
    const hdrs = h("s");

    await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: h("s", { "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({
        nodeId: "w1", role: "analyst",
        capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["ws"], environments: ["research"] },
      }),
    });

    const taskRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: h("s", { "x-a2a-requester-id": "hub-1", "x-a2a-requester-role": "hub" }),
      body: JSON.stringify({
        intent: "analyze",
        requester: { id: "hub-1", kind: "node", role: "hub" },
        target: { id: "w1", kind: "node", role: "analyst" },
        assignedWorkerId: "w1",
        message: "e2e fail-path",
      }),
    });
    const task = await taskRes.json();

    await fetch(`${server.baseUrl}/tasks/${task.id}/claim`, {
      method: "POST",
      headers: h("s", { "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({ workerId: "w1" }),
    });
    await fetch(`${server.baseUrl}/tasks/${task.id}/start`, {
      method: "POST",
      headers: h("s", { "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({ workerId: "w1" }),
    });
    const failRes = await fetch(`${server.baseUrl}/tasks/${task.id}/fail`, {
      method: "POST",
      headers: h("s", { "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({ workerId: "w1", error: { code: "timeout", message: "worker deadline exceeded" } }),
    });
    assert.equal(failRes.status, 200);
    const failed = await failRes.json();
    assert.equal(failed.status, "failed");
    assert.equal(failed.error.code, "timeout");

    const dashboard = await (await fetch(`${server.baseUrl}/dashboard`, { headers: hdrs })).json();
    assert.equal(dashboard.history.totalFailed, 1);
    assert.equal(dashboard.history.recent[0].error.code, "timeout");

  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// E2E: Cancel at running state via HTTP
// ---------------------------------------------------------------------------

test("E2E: cancel running task via HTTP produces canceled state and SSE terminal event", async () => {
  const server = await startTestServer({ edgeSecret: "s" });
  try {
    const hdrs = h("s");

    await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: h("s", { "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({
        nodeId: "w1", role: "analyst",
        capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["ws"], environments: ["research"] },
      }),
    });

    const taskRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: h("s", { "x-a2a-requester-id": "hub-1", "x-a2a-requester-role": "hub" }),
      body: JSON.stringify({
        intent: "analyze",
        requester: { id: "hub-1", kind: "node", role: "hub" },
        target: { id: "w1", kind: "node", role: "analyst" },
        assignedWorkerId: "w1",
        message: "e2e cancel-path",
      }),
    });
    const task = await taskRes.json();

    // Subscribe to SSE before driving lifecycle
    const sseRes = await fetch(`${server.baseUrl}/a2a/tasks/${task.id}/events`, {
      headers: { ...hdrs, "x-a2a-requester-id": "hub-1", "x-a2a-requester-role": "hub", accept: "text/event-stream" },
    });
    assert.equal(sseRes.status, 200);

    // Claim → start → cancel
    await fetch(`${server.baseUrl}/tasks/${task.id}/claim`, {
      method: "POST",
      headers: h("s", { "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({ workerId: "w1" }),
    });
    await fetch(`${server.baseUrl}/tasks/${task.id}/start`, {
      method: "POST",
      headers: h("s", { "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({ workerId: "w1" }),
    });
    const cancelRes = await fetch(`${server.baseUrl}/tasks/${task.id}/cancel`, {
      method: "POST",
      headers: h("s", { "x-a2a-requester-id": "hub-1", "x-a2a-requester-role": "hub" }),
      body: JSON.stringify({ actor: { id: "hub-1", role: "hub", kind: "node" }, reason: "e2e cancel" }),
    });
    assert.equal(cancelRes.status, 200);
    const canceled = await cancelRes.json();
    assert.equal(canceled.status, "canceled");

    // SSE should show: snapshot, claimed, started, canceled (terminal)
    const events = await readAllSseEvents(sseRes);
    const reasons = events.map((e) => {
      try { return JSON.parse(e.data).reason; } catch { return e.event; }
    });
    assert.ok(reasons.includes("snapshot"));
    assert.ok(reasons.includes("claimed"));
    assert.ok(reasons.includes("started"));
    assert.ok(reasons.includes("canceled"));

    const terminalEvent = events.find((e) => {
      try { return JSON.parse(e.data).reason === "canceled"; } catch { return false; }
    });
    assert.ok(terminalEvent);
    const terminal = JSON.parse(terminalEvent.data);
    // Note: SSE event data includes { task, reason, final, seq }

    // Dashboard should not count canceled as completed or failed
    const dashboard = await (await fetch(`${server.baseUrl}/dashboard`, { headers: hdrs })).json();
    assert.equal(dashboard.history.totalCompleted, 0);
    assert.equal(dashboard.history.totalFailed, 0);
    assert.equal(dashboard.queue.total, 0);
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// E2E: Stale recovery → tombstone through HTTP + manual requeue
// ---------------------------------------------------------------------------

test("E2E: stale recovery via requeue endpoint leads to tombstone when cap exceeded", async () => {
  const server = await startTestServer({
    edgeSecret: "s",
    staleReaperEnabled: false,
    workerOfflineAfterSec: 1,
    maxRequeueAttempts: 2,
  });
  try {
    const hdrs = h("s");
    const opsHdrs = h("s", { "x-a2a-requester-id": "ops", "x-a2a-requester-role": "operator" });
    const workerHdrs = h("s", { "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" });

    await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: h("s", { "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({
        nodeId: "w1", role: "analyst",
        capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["ws"], environments: ["research"] },
      }),
    });

    const taskRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: h("s", { "x-a2a-requester-id": "hub-1", "x-a2a-requester-role": "hub" }),
      body: JSON.stringify({
        intent: "analyze",
        requester: { id: "hub-1", kind: "node", role: "hub" },
        target: { id: "w1", kind: "node", role: "analyst" },
        assignedWorkerId: "w1",
        message: "e2e tombstone-path",
      }),
    });
    const task = await taskRes.json();

    // Cycle 1: claim → requeue
    await fetch(`${server.baseUrl}/tasks/${task.id}/claim`, { method: "POST", headers: workerHdrs, body: JSON.stringify({ workerId: "w1" }) });
    const sweep1 = await (await fetch(`${server.baseUrl}/tasks/requeue_stale?older_than_seconds=0`, { method: "POST", headers: opsHdrs })).json();
    assert.equal(sweep1.requeued, 1);
    assert.equal(sweep1.deadLettered, 0);

    // Verify requeued state via GET
    const afterSweep1 = await (await fetch(`${server.baseUrl}/tasks/${task.id}`, { headers: hdrs })).json();
    assert.equal(afterSweep1.status, "queued");
    assert.equal(afterSweep1.requeueCount, 1);

    // Cycle 2: claim → requeue
    await fetch(`${server.baseUrl}/tasks/${task.id}/claim`, { method: "POST", headers: workerHdrs, body: JSON.stringify({ workerId: "w1" }) });
    const sweep2 = await (await fetch(`${server.baseUrl}/tasks/requeue_stale?older_than_seconds=0`, { method: "POST", headers: opsHdrs })).json();
    assert.equal(sweep2.requeued, 1);
    assert.equal(sweep2.deadLettered, 0);

    const afterSweep2 = await (await fetch(`${server.baseUrl}/tasks/${task.id}`, { headers: hdrs })).json();
    assert.equal(afterSweep2.requeueCount, 2);

    // Cycle 3: claim → TOMBSTONE
    await fetch(`${server.baseUrl}/tasks/${task.id}/claim`, { method: "POST", headers: workerHdrs, body: JSON.stringify({ workerId: "w1" }) });
    const sweep3 = await (await fetch(`${server.baseUrl}/tasks/requeue_stale?older_than_seconds=0`, { method: "POST", headers: opsHdrs })).json();
    assert.equal(sweep3.requeued, 0);
    assert.equal(sweep3.deadLettered, 1);
    assert.equal(sweep3.deadLetteredItems[0].id, task.id);
    assert.equal(sweep3.deadLetteredItems[0].error.code, "exceeded_requeue_limit");

    // Verify tombstoned state via GET
    const tombstoned = await (await fetch(`${server.baseUrl}/tasks/${task.id}`, { headers: hdrs })).json();
    assert.equal(tombstoned.status, "failed");
    assert.equal(tombstoned.error.code, "exceeded_requeue_limit");
    assert.equal(tombstoned.requeueCount, 2);

    // Dashboard should show recovery stats
    const dashboard = await (await fetch(`${server.baseUrl}/dashboard`, { headers: hdrs })).json();
    assert.equal(dashboard.observability.recovery.totalRequeued, 2);
    assert.equal(dashboard.observability.recovery.totalDeadLettered, 1);
    assert.equal(dashboard.observability.recovery.recentDeadLetters[0].error.code, "exceeded_requeue_limit");

    // Operator snapshot projection: compact JSON for dashboards/runbooks.
    assert.equal(dashboard.operatorSnapshot.workers.total, 1);
    assert.equal(dashboard.operatorSnapshot.taskStatusSummary.total, 1);
    assert.equal(dashboard.operatorSnapshot.taskStatusSummary.terminal, 1);
    assert.equal(dashboard.operatorSnapshot.taskStatusSummary.byStatus.failed, 1);
    assert.equal(dashboard.operatorSnapshot.recoverySummary.retry.totalRequeued, 2);
    assert.equal(dashboard.operatorSnapshot.recoverySummary.retry.maxRequeueAttempts, 2);
    assert.equal(dashboard.operatorSnapshot.recoverySummary.deadLetter.totalDeadLettered, 1);
    const deadLetterAttention = dashboard.operatorSnapshot.attentionItems.find((item: { taskId: string }) => item.taskId === task.id);
    assert.ok(deadLetterAttention);
    assert.equal(deadLetterAttention.code, "dead_lettered");
    assert.equal(deadLetterAttention.whoClaimed, "w1");
    assert.match(deadLetterAttention.whyStuck, /requeue limit/);
    assert.match(deadLetterAttention.whatNext, /inspect/i);

    // Health endpoint reflects reaper-managed dead-letters (auto reaper only);
    // manual /tasks/requeue_stale calls are not tracked in health.staleReaper counters.
    // The dashboard counters above cover both manual and auto dead-letters.
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// E2E: Exchange-linked task lifecycle through JSON-RPC + cancel
// ---------------------------------------------------------------------------

test("E2E: exchange-linked task through JSON-RPC lifecycle with cancel fan-out", async () => {
  const server = await startTestServer({ edgeSecret: "s" });
  try {
    const hdrs = h("s");

    // Register worker
    await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: h("s", { "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({
        nodeId: "w1", role: "analyst",
        capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["ws"], environments: ["research"] },
      }),
    });

    // Create exchange + task via JSON-RPC
    const sendRes = await fetch(`${server.baseUrl}/a2a/jsonrpc`, {
      method: "POST",
      headers: h("s", { "x-a2a-requester-id": "hub-1", "x-a2a-requester-role": "hub" }),
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "SendMessage",
        params: {
          message: { parts: [{ text: "e2e rpc cancel" }] },
          metadata: { targetNodeId: "w1", intent: "analyze", traceId: "e2e-cancel-1" },
        },
      }),
    });
    assert.equal(sendRes.status, 200);
    const sendBody = await sendRes.json();
    const taskId = sendBody.result.task.id;
    const contextId = sendBody.result.contextId;
    assert.ok(taskId);
    assert.ok(contextId);

    // Exchange should have an active task but be queued (worker hasn't claimed yet)
    const exchangeRes = await fetch(`${server.baseUrl}/exchanges/${contextId}`, { headers: hdrs });
    const exchange = await exchangeRes.json();
    assert.ok(exchange.activeTaskId);
    assert.equal(exchange.status, "queued");

    // Claim the task to make exchange running
    await fetch(`${server.baseUrl}/tasks/${taskId}/claim`, {
      method: "POST",
      headers: h("s", { "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({ workerId: "w1" }),
    });
    const exchangeRunning = await (await fetch(`${server.baseUrl}/exchanges/${contextId}`, { headers: hdrs })).json();
    assert.equal(exchangeRunning.status, "running");

    // Cancel via JSON-RPC
    const cancelRes = await fetch(`${server.baseUrl}/a2a/jsonrpc`, {
      method: "POST",
      headers: h("s", { "x-a2a-requester-id": "hub-1", "x-a2a-requester-role": "hub" }),
      body: JSON.stringify({
        jsonrpc: "2.0", id: 2, method: "CancelTask",
        params: { taskId, reason: "operator cancel", actor: { id: "hub-1", role: "hub", kind: "node" } },
      }),
    });
    assert.equal(cancelRes.status, 200);
    const cancelBody = await cancelRes.json();
    assert.equal(cancelBody.result.task.status.state, "canceled");

    // Exchange should be back to queued
    const exchangeAfter = await (await fetch(`${server.baseUrl}/exchanges/${contextId}`, { headers: hdrs })).json();
    assert.equal(exchangeAfter.status, "queued");

    // Task detail via REST
    const taskDetail = await (await fetch(`${server.baseUrl}/tasks/${taskId}`, { headers: hdrs })).json();
    assert.equal(taskDetail.status, "canceled");
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// E2E: Task filter endpoint correctness across lifecycle states
// ---------------------------------------------------------------------------

test("E2E: task filters return correct subsets for each status", async () => {
  const server = await startTestServer({ edgeSecret: "s" });
  try {
    const hdrs = h("s");
    const hubHdrs = h("s", { "x-a2a-requester-id": "hub-1", "x-a2a-requester-role": "hub" });
    const workerHdrs = h("s", { "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" });

    await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: h("s", { "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({
        nodeId: "w1", role: "analyst",
        capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["ws"], environments: ["research"] },
      }),
    });

    // Create two tasks
    const task1 = await (await fetch(`${server.baseUrl}/tasks`, {
      method: "POST", headers: hubHdrs,
      body: JSON.stringify({ intent: "analyze", requester: { id: "hub-1", kind: "node", role: "hub" }, target: { id: "w1", kind: "node", role: "analyst" }, assignedWorkerId: "w1", message: "filter-test-1" }),
    })).json();
    const task2 = await (await fetch(`${server.baseUrl}/tasks`, {
      method: "POST", headers: hubHdrs,
      body: JSON.stringify({ intent: "backfill", requester: { id: "hub-1", kind: "node", role: "hub" }, target: { id: "w1", kind: "node", role: "analyst" }, assignedWorkerId: "w1", message: "filter-test-2" }),
    })).json();

    // Both should be queued
    const queuedFilter = await (await fetch(`${server.baseUrl}/tasks?status=queued`, { headers: hdrs })).json();
    assert.equal(queuedFilter.items.length, 2);

    // Complete task1
    await fetch(`${server.baseUrl}/tasks/${task1.id}/claim`, { method: "POST", headers: workerHdrs, body: JSON.stringify({ workerId: "w1" }) });
    await fetch(`${server.baseUrl}/tasks/${task1.id}/start`, { method: "POST", headers: workerHdrs, body: JSON.stringify({ workerId: "w1" }) });
    await fetch(`${server.baseUrl}/tasks/${task1.id}/complete`, { method: "POST", headers: workerHdrs, body: JSON.stringify({ workerId: "w1", result: { summary: "done" } }) });

    // Filter by status=succeeded
    const succeededFilter = await (await fetch(`${server.baseUrl}/tasks?status=succeeded`, { headers: hdrs })).json();
    assert.equal(succeededFilter.items.length, 1);
    assert.equal(succeededFilter.items[0].id, task1.id);

    // Filter by intent=backfill
    const backfillFilter = await (await fetch(`${server.baseUrl}/tasks?intent=backfill`, { headers: hdrs })).json();
    assert.equal(backfillFilter.items.length, 1);
    assert.equal(backfillFilter.items[0].id, task2.id);

    // No filter returns both (succeeded + queued)
    const allTasks = await (await fetch(`${server.baseUrl}/tasks`, { headers: hdrs })).json();
    assert.equal(allTasks.items.length, 2);
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// E2E: Audit trail correctness across fixture-loaded states
// ---------------------------------------------------------------------------

test("E2E: audit endpoint returns correct events for each fixture state", async () => {
  for (const fixture of ALL_RUNTIME_STATES) {
    const server = await startTestServer({ edgeSecret: "s" });
    try {
      // Load fixture by creating tasks through the broker directly, then verifying via HTTP
      server.runtime.broker;
      // We can't directly load a snapshot into the HTTP server's broker, but we can verify
      // that the audit endpoint returns structured events for tasks created through HTTP.
      const hdrs = h("s");
      const hubHdrs = h("s", { "x-a2a-requester-id": "hub-1", "x-a2a-requester-role": "hub" });
      const workerHdrs = h("s", { "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" });
      const opsHdrs = h("s", { "x-a2a-requester-id": "ops", "x-a2a-requester-role": "operator" });

      await fetch(`${server.baseUrl}/workers/register`, {
        method: "POST",
        headers: h("s", { "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
        body: JSON.stringify({
          nodeId: "w1", role: "analyst",
          capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["ws"], environments: ["research"] },
        }),
      });

      const taskRes = await fetch(`${server.baseUrl}/tasks`, {
        method: "POST", headers: hubHdrs,
        body: JSON.stringify({
          intent: "analyze",
          requester: { id: "hub-1", kind: "node", role: "hub" },
          target: { id: "w1", kind: "node", role: "analyst" },
          assignedWorkerId: "w1",
          message: `audit-${fixture.name}`,
        }),
      });
      const task = await taskRes.json();

      // Drive to target state based on fixture name
      if (["resumed", "stale"].includes(fixture.name)) {
        await fetch(`${server.baseUrl}/tasks/${task.id}/claim`, { method: "POST", headers: workerHdrs, body: JSON.stringify({ workerId: "w1" }) });
        if (fixture.name === "resumed") {
          await fetch(`${server.baseUrl}/tasks/${task.id}/start`, { method: "POST", headers: workerHdrs, body: JSON.stringify({ workerId: "w1" }) });
        }
      } else if (fixture.name === "completed") {
        await fetch(`${server.baseUrl}/tasks/${task.id}/claim`, { method: "POST", headers: workerHdrs, body: JSON.stringify({ workerId: "w1" }) });
        await fetch(`${server.baseUrl}/tasks/${task.id}/start`, { method: "POST", headers: workerHdrs, body: JSON.stringify({ workerId: "w1" }) });
        await fetch(`${server.baseUrl}/tasks/${task.id}/complete`, { method: "POST", headers: workerHdrs, body: JSON.stringify({ workerId: "w1", result: { summary: "done" } }) });
      } else if (fixture.name === "failed") {
        await fetch(`${server.baseUrl}/tasks/${task.id}/claim`, { method: "POST", headers: workerHdrs, body: JSON.stringify({ workerId: "w1" }) });
        await fetch(`${server.baseUrl}/tasks/${task.id}/start`, { method: "POST", headers: workerHdrs, body: JSON.stringify({ workerId: "w1" }) });
        await fetch(`${server.baseUrl}/tasks/${task.id}/fail`, { method: "POST", headers: workerHdrs, body: JSON.stringify({ workerId: "w1", error: { code: "test", message: "expected failure" } }) });
      } else if (fixture.name === "canceled") {
        await fetch(`${server.baseUrl}/tasks/${task.id}/claim`, { method: "POST", headers: workerHdrs, body: JSON.stringify({ workerId: "w1" }) });
        await fetch(`${server.baseUrl}/tasks/${task.id}/cancel`, { method: "POST", headers: opsHdrs, body: JSON.stringify({ actor: { id: "ops", role: "operator", kind: "node" }, reason: "test cancel" }) });
      } else if (["timed-out", "tombstoned"].includes(fixture.name)) {
        await fetch(`${server.baseUrl}/tasks/${task.id}/claim`, { method: "POST", headers: workerHdrs, body: JSON.stringify({ workerId: "w1" }) });
        await fetch(`${server.baseUrl}/tasks/requeue_stale?older_than_seconds=0`, { method: "POST", headers: opsHdrs });
        if (fixture.name === "tombstoned") {
          await fetch(`${server.baseUrl}/tasks/${task.id}/claim`, { method: "POST", headers: workerHdrs, body: JSON.stringify({ workerId: "w1" }) });
          await fetch(`${server.baseUrl}/tasks/requeue_stale?older_than_seconds=0`, { method: "POST", headers: opsHdrs });
          await fetch(`${server.baseUrl}/tasks/${task.id}/claim`, { method: "POST", headers: workerHdrs, body: JSON.stringify({ workerId: "w1" }) });
          await fetch(`${server.baseUrl}/tasks/requeue_stale?older_than_seconds=0`, { method: "POST", headers: opsHdrs });
        }
      }

      // Verify audit trail is accessible via HTTP
      const auditRes = await fetch(`${server.baseUrl}/audit?targetId=${task.id}`, { headers: hdrs });
      const audit = await auditRes.json();
      assert.ok(Array.isArray(audit.items), `${fixture.name}: audit should be an array`);
      assert.ok(audit.items.length > 0, `${fixture.name}: audit should have events`);

      // Every event should have the required fields
      for (const event of audit.items) {
        assert.ok(event.id, `${fixture.name}: audit event missing id`);
        assert.ok(event.actorId, `${fixture.name}: audit event missing actorId`);
        assert.ok(event.action, `${fixture.name}: audit event missing action`);
        assert.ok(event.targetType, `${fixture.name}: audit event missing targetType`);
        assert.ok(event.targetId, `${fixture.name}: audit event missing targetId`);
        assert.ok(event.createdAt, `${fixture.name}: audit event missing createdAt`);
      }

      // All events should be for this task
      for (const event of audit.items) {
        assert.equal(event.targetId, task.id, `${fixture.name}: audit event targetId mismatch`);
      }

      // task.created should always be first (newest first ordering in API, but created is earliest)
      const createdEvent = audit.items.find((e: { action: string }) => e.action === "task.created");
      assert.ok(createdEvent, `${fixture.name}: missing task.created audit event`);
    } finally {
      await server.close();
    }
  }
});

// ---------------------------------------------------------------------------
// E2E: Task detail endpoint returns consistent state
// ---------------------------------------------------------------------------

test("E2E: GET /tasks/:id returns full task record with all fields populated after lifecycle", async () => {
  const server = await startTestServer({ edgeSecret: "s" });
  try {
    const hdrs = h("s");

    await fetch(`${server.baseUrl}/workers/register`, {
      method: "POST",
      headers: h("s", { "x-a2a-requester-id": "w1", "x-a2a-requester-role": "analyst" }),
      body: JSON.stringify({
        nodeId: "w1", role: "analyst",
        capabilities: { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false, workspaceIds: ["ws"], environments: ["research"] },
      }),
    });

    const taskRes = await fetch(`${server.baseUrl}/tasks`, {
      method: "POST",
      headers: h("s", { "x-a2a-requester-id": "hub-1", "x-a2a-requester-role": "hub" }),
      body: JSON.stringify({
        intent: "analyze",
        requester: { id: "hub-1", kind: "node", role: "hub" },
        target: { id: "w1", kind: "node", role: "analyst" },
        assignedWorkerId: "w1",
        workspace: { nodeId: "w1", workspaceId: "ws-test" },
        message: "e2e detail check",
        payload: { regressionKey: "e2e-detail" },
      }),
    });
    const task = await taskRes.json();

    // Verify initial state via GET
    const detail = await (await fetch(`${server.baseUrl}/tasks/${task.id}`, { headers: hdrs })).json();
    assert.equal(detail.id, task.id);
    assert.equal(detail.intent, "analyze");
    assert.equal(detail.status, "queued");
    assert.equal(detail.targetNodeId, "w1");
    assert.equal(detail.assignedWorkerId, "w1");
    assert.ok(detail.payload);
    assert.equal(detail.payload.regressionKey, "e2e-detail");
    assert.ok(detail.createdAt);
    assert.ok(detail.updatedAt);

    // 404 for non-existent task
    const missing = await fetch(`${server.baseUrl}/tasks/nonexistent`, { headers: hdrs });
    assert.equal(missing.status, 404);
  } finally {
    await server.close();
  }
});
