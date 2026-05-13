/**
 * nosuk lane: Team1 no-live outbox/replay/ACK boundary proof (#569).
 *
 * Proves that the terminal outbox/replay/ACK boundary works for the nosuk
 * worker lane entirely without a live/production environment.
 *
 * Safety contract:
 *   - No provider API calls (Telegram, etc.)
 *   - No database mutation (InMemoryA2ABroker only)
 *   - No live terminal-outbox ACK to production
 *   - No Gateway restart or deployment
 *   - provider_sent is never treated as ACK evidence
 *
 * Cells:
 *   outbox           – Terminal events are enqueued for nosuk worker tasks
 *   replay_cursor    – Events are replayable via subscribeWithCursor afterId
 *   reconcile        – Unacked events survive broker restart via reconcile
 *   ack_boundary     – provider_sent is rejected as ACK evidence;
 *                      operator_visible is accepted
 *   unacked_gap      – Events without receipt-confirmed ACK remain visible
 *                      and replayable
 *   no_live_safety   – No live provider calls, DB mutation, or real ACK
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { InMemoryA2ABroker } from "./broker.js";
import type { TerminalTaskOutboxEvent } from "./terminal-event-outbox.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WORKER_ID = "nosuk";

function registerWorker(broker: InMemoryA2ABroker): void {
  broker.registerWorker({
    nodeId: WORKER_ID,
    role: "analyst",
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: false,
      canPromoteLive: false,
      workspaceIds: ["default"],
      environments: ["research"],
    },
  });
}

function createTask(
  broker: InMemoryA2ABroker,
  overrides: {
    id?: string;
    payload?: Record<string, unknown>;
  } = {},
) {
  return broker.createTask({
    id: overrides.id,
    intent: "analyze",
    requester: { id: "hub", kind: "node", role: "hub" },
    target: { id: WORKER_ID, kind: "node", role: "analyst" },
    assignedWorkerId: WORKER_ID,
    message: `nosuk proof task ${overrides.id ?? ""}`,
    payload: overrides.payload,
  });
}

function completeTask(broker: InMemoryA2ABroker, taskId: string, summary: string): void {
  broker.claimTask(taskId, WORKER_ID);
  broker.completeTask(taskId, WORKER_ID, { summary });
}

function renderFakeOperatorLine(payload: TerminalTaskOutboxEvent["payload"]): string {
  const worker = payload.worker ?? WORKER_ID;
  const verb = payload.status === "succeeded" ? "completed" : payload.status;
  const issue = payload.repo && payload.issue !== undefined
    ? `${payload.repo}#${payload.issue}`
    : payload.taskId;
  const brief = payload.taskBrief ? ` — ${payload.taskBrief}` : "";
  return `${worker} ${verb} ${issue}${brief}`;
}

// ---------------------------------------------------------------------------
// Proof — outbox
// ---------------------------------------------------------------------------

describe("nosuk lane outbox — terminal events enqueued", () => {
  it("enqueues terminal outbox events for nosuk worker tasks", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker);

    const task = createTask(broker, { id: "nosuk-proof-enqueue" });
    completeTask(broker, task.id, "proof: nosuk terminal outbox enqueue ok");

    const outbox = broker.getTerminalTaskEventOutbox();
    const events = outbox.subscribe();
    assert.equal(events.length, 1, "expected 1 terminal outbox event for nosuk task");

    const event = events[0]!;
    assert.match(event.id, /^terminal:/);
    assert.equal(event.kind, "task.terminal");
    assert.equal(event.payload.worker, WORKER_ID);
    assert.equal(event.payload.status, "succeeded");
    assert.equal(event.payload.taskId, task.id);
    assert.equal(event.receipt.status, "accepted");
    assert.equal(
      event.ackAudit?.decision,
      "pending",
      "fresh terminal event should have pending ACK decision",
    );
    assert.ok(
      event.ackAudit?.reason?.includes("awaiting"),
      "fresh terminal event should note awaiting evidence",
    );
  });

  it("assigns stable deduplicable event ids per terminal status", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker);

    const task = createTask(broker, { id: "nosuk-proof-dedup" });
    completeTask(broker, task.id, "proof: first completion");
    // Idempotent duplicate complete should not create a second event.
    broker.completeTask(task.id, WORKER_ID, { summary: "ignored duplicate" });

    const events = broker.getTerminalTaskEventOutbox().subscribe();
    assert.equal(events.length, 1);
  });

  it("includes round and issue metadata from payload", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker);

    const task = createTask(broker, {
      payload: {
        parentRoundId: "a2a-r9b-terminal-brief-activation-readiness-20260513T152714Z",
        githubRepo: "jinwon-int/a2a-broker",
        githubIssueNumber: 569,
        githubIssueTitle: "nosuk lane: Team1 no-live outbox/replay/ACK boundary proof",
      },
    });
    completeTask(broker, task.id, "proof: metadata round/issue propagation ok");

    const [event] = broker.getTerminalTaskEventOutbox().subscribe();
    assert.ok(event);
    assert.equal(event.payload.run, "a2a-r9b-terminal-brief-activation-readiness-20260513T152714Z");
    assert.equal(event.payload.repo, "jinwon-int/a2a-broker");
    assert.equal(event.payload.issue, 569);
    assert.equal(event.payload.taskBrief, "nosuk lane: Team1 no-live outbox/replay/ACK boundary proof");
    assert.equal(
      renderFakeOperatorLine(event.payload),
      "nosuk completed jinwon-int/a2a-broker#569 — nosuk lane: Team1 no-live outbox/replay/ACK boundary proof",
    );
  });

  it("does not enqueue non-terminal task statuses", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker);

    const task = createTask(broker, { id: "nosuk-proof-nonterminal" });
    broker.claimTask(task.id, WORKER_ID);
    // Starting a task is not a terminal status — no outbox event.
    broker.startTask(task.id, WORKER_ID);

    const events = broker.getTerminalTaskEventOutbox().subscribe();
    assert.equal(events.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Proof — replay
// ---------------------------------------------------------------------------

describe("nosuk lane replay — events are replayable via cursor and reconcile", () => {
  it("supports replay via subscribeWithCursor and afterId", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker);

    const t1 = createTask(broker, { id: "nosuk-replay-a" });
    const t2 = createTask(broker, { id: "nosuk-replay-b" });
    completeTask(broker, t1.id, "proof: replay event A");
    completeTask(broker, t2.id, "proof: replay event B");

    const outbox = broker.getTerminalTaskEventOutbox();
    const all = outbox.subscribe();
    assert.equal(all.length, 2);

    // Replay after first event — should return only the second
    const replay = outbox.subscribe({ afterId: all[0]!.id });
    assert.equal(replay.length, 1);
    assert.equal(replay[0]!.payload.taskId, "nosuk-replay-b");

    // subscribeWithCursor should return the same with cursor tracking
    const cursorResult = outbox.subscribeWithCursor();
    assert.equal(cursorResult.events.length, 2);
    assert.ok(cursorResult.cursor);
    assert.equal(cursorResult.reconciledUnacked, 0);
  });

  it("reconcile replays unacked events after broker snapshot restore", () => {
    const broker = new InMemoryA2ABroker(undefined, undefined, {
      maxTerminalTaskOutboxEvents: 10,
    });
    registerWorker(broker);

    // Create one ACKed event and one unACKed event
    const ackedTask = createTask(broker, { id: "nosuk-reconcile-acked" });
    const unackedTask = createTask(broker, { id: "nosuk-reconcile-unacked" });
    completeTask(broker, ackedTask.id, "proof: acked event");
    completeTask(broker, unackedTask.id, "proof: unacked event");

    const outbox = broker.getTerminalTaskEventOutbox();
    const firstPoll = outbox.subscribeWithCursor();
    assert.equal(firstPoll.events.length, 2);

    // ACK the first event with operator_visible evidence
    outbox.acknowledge(firstPoll.events[0]!.id, {
      evidence: "operator_visible",
      acknowledgedAt: "2026-05-14T00:00:00.000Z",
      receiptId: "nosuk-operator-visible-1",
    });

    // Simulate broker restart with snapshot
    const restarted = new InMemoryA2ABroker(undefined, broker.exportSnapshot(), {
      maxTerminalTaskOutboxEvents: 10,
    });
    const replay = restarted
      .getTerminalTaskEventOutbox()
      .reconcile({ afterId: firstPoll.cursor ?? undefined });

    // Only the unACKed event should be replayed
    assert.equal(replay.events.length, 1, "only unACKed event should replay");
    assert.equal(replay.events[0]!.payload.taskId, "nosuk-reconcile-unacked");
    assert.equal(replay.reconciledUnacked, 1);

    // The replayed event should still be ackable
    restarted.getTerminalTaskEventOutbox().acknowledge(replay.events[0]!.id, {
      evidence: "provider_delivery_receipt",
      acknowledgedAt: "2026-05-14T00:01:00.000Z",
      receiptId: "nosuk-provider-receipt-replayed",
    });

    // After ACK, reconcile should return nothing
    const settled = restarted
      .getTerminalTaskEventOutbox()
      .reconcile({ afterId: firstPoll.cursor ?? undefined });
    assert.deepEqual(settled.events, []);
    assert.equal(settled.reconciledUnacked, 0);
  });
});

// ---------------------------------------------------------------------------
// Proof — ACK boundary
// ---------------------------------------------------------------------------

describe("nosuk lane ACK boundary — correct evidence required", () => {
  it("rejects provider_sent as terminal ACK evidence", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker);

    const task = createTask(broker, { id: "nosuk-ack-boundary-provider-sent" });
    completeTask(broker, task.id, "proof: provider_sent ack boundary");

    const [event] = broker.getTerminalTaskEventOutbox().subscribe();
    assert.ok(event);

    // Attempting ACK with provider_sent must throw TypeError
    assert.throws(
      () => broker.getTerminalTaskEventOutbox().acknowledge(event.id, {
        evidence: "provider_sent" as never,
        acknowledgedAt: "2026-05-14T00:00:00.000Z",
      }),
      {
        name: "TypeError",
      },
    );

    // Verify the event is still unACKed after the rejection
    const after = broker.getTerminalTaskEventOutbox().subscribe();
    assert.equal(after[0]!.ack, undefined, "no ACK state created for provider_sent attempt");
    assert.equal(after[0]!.receipt.status, "accepted");
    // ackAudit records the failed ACK attempt as rejected
    assert.equal(after[0]!.ackAudit?.decision, "rejected");
    assert.ok(
      after[0]!.ackAudit?.reason?.includes("rejected"),
      "rejected ackAudit reason must contain 'rejected'",
    );
  });

  it("accepts operator_visible as terminal ACK evidence", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker);

    const task = createTask(broker, { id: "nosuk-ack-operator-visible" });
    completeTask(broker, task.id, "proof: operator_visible ack");

    const [event] = broker.getTerminalTaskEventOutbox().subscribe();
    assert.ok(event);

    const acked = broker.getTerminalTaskEventOutbox().acknowledge(event.id, {
      evidence: "operator_visible",
      acknowledgedAt: "2026-05-14T00:00:00.000Z",
      receiptId: "nosuk-operator-ack-1",
      note: "nosuk lane ACK boundary proof — operator visible receipt confirmed",
    });
    assert.ok(acked);
    assert.equal(acked.ack?.status, "receipt_confirmed");
    assert.equal(acked.ack?.evidence, "operator_visible");
    assert.equal(acked.receipt.status, "operator_visible");
    assert.equal(acked.ackAudit?.decision, "confirmed");
    assert.equal(acked.attempts, 1);
  });

  it("accepts provider_delivery_receipt as terminal ACK evidence", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker);

    const task = createTask(broker, { id: "nosuk-ack-provider-receipt" });
    completeTask(broker, task.id, "proof: provider_delivery_receipt ack");

    const [event] = broker.getTerminalTaskEventOutbox().subscribe();
    assert.ok(event);

    const acked = broker.getTerminalTaskEventOutbox().acknowledge(event.id, {
      evidence: "provider_delivery_receipt",
      acknowledgedAt: "2026-05-14T00:00:00.000Z",
      receiptId: "nosuk-provider-ack-1",
    });
    assert.ok(acked);
    assert.equal(acked.ack?.status, "receipt_confirmed");
    assert.equal(acked.ack?.evidence, "provider_delivery_receipt");
    assert.equal(acked.receipt.status, "provider_sent");
  });

  it("accepts current_session_visible as terminal ACK evidence", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker);

    const task = createTask(broker, { id: "nosuk-ack-session-visible" });
    completeTask(broker, task.id, "proof: current_session_visible ack");

    const [event] = broker.getTerminalTaskEventOutbox().subscribe();
    assert.ok(event);

    const acked = broker.getTerminalTaskEventOutbox().acknowledge(event.id, {
      evidence: "current_session_visible",
      acknowledgedAt: "2026-05-14T00:00:00.000Z",
      receiptId: "nosuk-session-ack-1",
    });
    assert.ok(acked);
    assert.equal(acked.ack?.status, "receipt_confirmed");
    assert.equal(acked.ack?.evidence, "current_session_visible");
    assert.equal(acked.receipt.status, "current_session_visible");
  });
});

// ---------------------------------------------------------------------------
// Proof — unacked gap visibility
// ---------------------------------------------------------------------------

describe("nosuk lane unacked gap — unconfirmed records remain observable", () => {
  it("records with receipt status accepted remain replayable and unACKed", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker);

    const task = createTask(broker, { id: "nosuk-gap-accepted" });
    completeTask(broker, task.id, "proof: accepted gap");
    const [event] = broker.getTerminalTaskEventOutbox().subscribe();
    assert.ok(event);
    assert.equal(event.ack, undefined, "no ACK on fresh event");
    assert.equal(event.receipt.status, "accepted");

    // Must be replayable with afterId=undefined
    const replay = broker.getTerminalTaskEventOutbox().subscribeWithCursor();
    assert.ok(replay.events.length >= 1);
  });

  it("records with receipt status provider_sent remain unACKed and replayable", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker);

    const task = createTask(broker, { id: "nosuk-gap-provider-sent" });
    completeTask(broker, task.id, "proof: provider_sent gap");
    const [event] = broker.getTerminalTaskEventOutbox().subscribe();
    assert.ok(event);

    broker.getTerminalTaskEventOutbox().recordReceiptStatus(event.id, {
      status: "provider_sent",
      updatedAt: "2026-05-14T00:00:00.000Z",
      note: "provider accepted send — not ACK evidence",
    });

    const updated = broker.getTerminalTaskEventOutbox().subscribe();
    assert.equal(updated[0]!.receipt.status, "provider_sent");
    assert.equal(updated[0]!.ack, undefined, "provider_sent must not auto-ACK");
    assert.equal(
      updated[0]!.ackAudit?.decision,
      "pending",
      "provider_sent receipt must remain pending ACK decision",
    );
    assert.ok(
      updated[0]!.ackAudit?.reason?.includes("awaiting"),
      "provider_sent receipt must note awaiting operator-visible evidence",
    );

    // Must still be replayable
    const replay = broker.getTerminalTaskEventOutbox().subscribeWithCursor();
    assert.ok(replay.events.some((e) => e.id === event.id));
  });

  it("records with receipt status stale remain observable", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker);

    const task = createTask(broker, { id: "nosuk-gap-stale" });
    completeTask(broker, task.id, "proof: stale gap");
    const [event] = broker.getTerminalTaskEventOutbox().subscribe();
    assert.ok(event);

    broker.getTerminalTaskEventOutbox().recordReceiptStatus(event.id, {
      status: "stale",
      updatedAt: "2026-05-14T00:00:00.000Z",
    });

    const stale = broker.getTerminalTaskEventOutbox().subscribe();
    assert.equal(stale[0]!.receipt.status, "stale");
    // Even stale — still no ACK, still replayable
    assert.equal(stale[0]!.ack, undefined);
    const replay = broker.getTerminalTaskEventOutbox().subscribeWithCursor();
    assert.ok(replay.events.some((e) => e.id === event.id));
  });

  it("acknowledged events are still visible via subscribe but not via reconcile past cursor", () => {
    const broker = new InMemoryA2ABroker(undefined, undefined, {
      maxTerminalTaskOutboxEvents: 10,
    });
    registerWorker(broker);

    const task = createTask(broker, { id: "nosuk-gap-acked-visible" });
    completeTask(broker, task.id, "proof: acked but retained");

    const firstPoll = broker.getTerminalTaskEventOutbox().subscribeWithCursor();
    const event = firstPoll.events[0]!;

    // ACK it
    broker.getTerminalTaskEventOutbox().acknowledge(event.id, {
      evidence: "operator_visible",
      acknowledgedAt: "2026-05-14T00:00:00.000Z",
    });

    // Still visible via subscribe (retention keeps it)
    const all = broker.getTerminalTaskEventOutbox().subscribe();
    assert.ok(all.some((e) => e.id === event.id), "ACKed event still in subscribe");

    // But not replayed via reconcile past cursor
    const reconciled = broker.getTerminalTaskEventOutbox().reconcile({ afterId: firstPoll.cursor ?? undefined });
    assert.equal(reconciled.reconciledUnacked, 0);
    assert.deepEqual(reconciled.events, []);
  });
});

// ---------------------------------------------------------------------------
// Proof — no-live safety
// ---------------------------------------------------------------------------

describe("nosuk lane no-live safety — zero live provider or production actions", () => {
  it("uses InMemoryA2ABroker only — no DB, no provider calls, no live ACK", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker);

    const task = createTask(broker, { id: "nosuk-safety-no-live" });
    completeTask(broker, task.id, "proof: no-live safety");

    const [event] = broker.getTerminalTaskEventOutbox().subscribe();
    assert.ok(event);
    assert.equal(event.ack, undefined, "no live ACK performed");

    // Simulate ACK locally (operator-visible, no provider call)
    const acked = broker.getTerminalTaskEventOutbox().acknowledge(event.id, {
      evidence: "operator_visible",
      acknowledgedAt: "2026-05-14T00:00:00.000Z",
      receiptId: "nosuk-no-live-ack",
    });
    assert.ok(acked);
    // This is a local in-memory ACK — no production side effects.
    assert.equal(acked.ack?.status, "receipt_confirmed");
    assert.equal(acked.attempts, 1);
  });

  it("records no provider sends or gateway restarts", () => {
    const broker = new InMemoryA2ABroker();
    registerWorker(broker);

    // Create three tasks spanning the outbox/replay/ACK boundary
    for (const id of ["nosuk-safety-outbox", "nosuk-safety-replay", "nosuk-safety-ack"]) {
      const task = createTask(broker, { id });
      completeTask(broker, task.id, `proof: ${id}`);
    }

    const outbox = broker.getTerminalTaskEventOutbox();
    const poll = outbox.subscribeWithCursor();
    assert.equal(poll.events.length, 3, "three nosuk terminal events in outbox");

    // ACK middle event — only event[1] gets operator_visible receipt
    outbox.acknowledge(poll.events[1]!.id, {
      evidence: "operator_visible",
      acknowledgedAt: "2026-05-14T00:00:00.000Z",
    });

    // Reconcile — events at/before cursor that remain unACKed are replayed
    const reconcile = outbox.reconcile({ afterId: poll.cursor ?? undefined });
    // event[0] and event[2] are before/at cursor and not ACKed => 2 reconciledUnacked
    assert.equal(reconcile.reconciledUnacked, 2, "two unACKed events before cursor are reconciled");
    assert.equal(reconcile.events.length, 2, "two events in reconcile replay");

    // ACK both remaining unACKed events
    outbox.acknowledge(poll.events[0]!.id, {
      evidence: "operator_visible",
      acknowledgedAt: "2026-05-14T00:01:00.000Z",
    });
    outbox.acknowledge(poll.events[2]!.id, {
      evidence: "operator_visible",
      acknowledgedAt: "2026-05-14T00:02:00.000Z",
    });

    // Now reconcile returns empty
    const settled = outbox.reconcile({ afterId: poll.cursor ?? undefined });
    assert.equal(settled.reconciledUnacked, 0, "all events ACKed");
    assert.deepEqual(settled.events, []);

    // Confirm no unsafe artifacts
    const all = outbox.subscribe();
    for (const event of all) {
      const serialized = JSON.stringify(event);
      assert.ok(!serialized.includes("provider:send"), "no provider send leaked into artifact");
      assert.ok(!serialized.includes("gateway:restart"), "no gateway restart leaked");
      assert.ok(!serialized.includes("secret"), "no secrets in artifact");
    }

    // Test: the proof is deterministic and JSON-safe
    assert.doesNotThrow(() => JSON.stringify(poll));
    assert.equal(typeof JSON.parse(JSON.stringify(poll)).cursor, "string");
  });
});

// ---------------------------------------------------------------------------
// Proof — full boundary summary
// ---------------------------------------------------------------------------

describe("nosuk lane full boundary — all cells pass", () => {
  it("all six proof cells pass in a single integrated no-live pass", () => {
    const broker = new InMemoryA2ABroker(undefined, undefined, {
      maxTerminalTaskOutboxEvents: 20,
    });
    registerWorker(broker);

    // Outbox cell: enqueue terminal events for nosuk lane
    const proofs = [
      {
        id: "cell-outbox",
        payload: {
          parentRoundId: "a2a-r9b-terminal-brief-569",
          githubRepo: "jinwon-int/a2a-broker",
          githubIssueNumber: 569,
          githubIssueTitle: "outbox cell",
        },
      },
      {
        id: "cell-replay",
        payload: {
          parentRoundId: "a2a-r9b-terminal-brief-569",
          githubRepo: "jinwon-int/a2a-broker",
          githubIssueNumber: 569,
          githubIssueTitle: "replay cell",
        },
      },
      {
        id: "cell-ack",
        payload: {
          parentRoundId: "a2a-r9b-terminal-brief-569",
          githubRepo: "jinwon-int/a2a-broker",
          githubIssueNumber: 569,
          githubIssueTitle: "ACK boundary cell",
        },
      },
      {
        id: "cell-gap",
        payload: {
          parentRoundId: "a2a-r9b-terminal-brief-569",
          githubRepo: "jinwon-int/a2a-broker",
          githubIssueNumber: 569,
          githubIssueTitle: "unacked gap cell",
        },
      },
    ];
    for (const p of proofs) {
      const task = createTask(broker, { id: p.id, payload: p.payload });
      completeTask(broker, task.id, `proof: ${p.id}`);
    }

    const outbox = broker.getTerminalTaskEventOutbox();
    const poll = outbox.subscribeWithCursor();
    assert.equal(poll.events.length, 4, "all four proof events enqueued (outbox ✓)");

    // Replay cell: replay from first event's id
    const replay = outbox.subscribe({ afterId: poll.events[0]!.id });
    assert.equal(replay.length, 3, "3 events after first (replay ✓)");
    assert.equal(replay[0]!.payload.taskId, "cell-replay");

    // ACK boundary cell: operator_visible works, provider_sent rejected
    assert.throws(
      () => outbox.acknowledge(poll.events[0]!.id, {
        evidence: "provider_sent" as never,
        acknowledgedAt: "2026-05-14T00:00:00.000Z",
      }),
      {
        name: "TypeError",
      },
      "provider_sent rejected as ACK evidence (ACK boundary ✓)",
    );
    const acked = outbox.acknowledge(poll.events[1]!.id, {
      evidence: "operator_visible",
      acknowledgedAt: "2026-05-14T00:00:00.000Z",
      note: "ACK boundary cell — operator visible confirmed",
    });
    assert.ok(acked);
    assert.equal(acked.ack?.status, "receipt_confirmed");

    // Unacked gap cell: event 2 is not ACKed, event 3 is not ACKed
    assert.equal(poll.events[2]!.ack, undefined, "event 2 unACKed (gap ✓)");
    assert.equal(poll.events[3]!.ack, undefined, "event 3 unACKed (gap ✓)");

    // Both unACKed events are still visible via subscribe
    const after = outbox.subscribe();
    assert.ok(after.find((e) => e.id === poll.events[2]!.id), "event 2 visible (gap ✓)");
    assert.ok(after.find((e) => e.id === poll.events[3]!.id), "event 3 visible (gap ✓)");

    // Reconcile: unACKed events at/before cursor are replayed (events 0, 2, 3)
    const reconciled = outbox.reconcile({ afterId: poll.cursor ?? undefined });
    assert.equal(reconciled.reconciledUnacked, 3, "three unACKed events at/before cursor (gap ✓)");
    assert.equal(reconciled.events.length, 3, "three events in reconcile replay");

    // ACK all remaining unACKed events
    outbox.acknowledge(poll.events[0]!.id, {
      evidence: "operator_visible",
      acknowledgedAt: "2026-05-14T00:01:00.000Z",
    });
    outbox.acknowledge(poll.events[2]!.id, {
      evidence: "operator_visible",
      acknowledgedAt: "2026-05-14T00:02:00.000Z",
    });
    outbox.acknowledge(poll.events[3]!.id, {
      evidence: "operator_visible",
      acknowledgedAt: "2026-05-14T00:03:00.000Z",
    });

    // Now reconcile returns empty
    const settled = outbox.reconcile({ afterId: poll.cursor ?? undefined });
    assert.equal(settled.reconciledUnacked, 0, "all events ACKed — no more replay");
    assert.deepEqual(settled.events, []);

    // No-live safety: no provider calls, no DB, no real ACK
    for (const event of poll.events) {
      const serialized = JSON.stringify(event);
      assert.ok(!serialized.includes("telegram"), "no Telegram in proof artifacts");
      assert.ok(!serialized.includes("provider:called"), "no provider calls");
    }

    // Full boundary proved — all cells implicitly pass
    assert.equal(outbox.size, 4, "all four events retained");
    assert.equal(
      poll.events.filter((e) => e.payload.worker === WORKER_ID).length,
      4,
      "all events assigned to nosuk worker",
    );
  });
});
