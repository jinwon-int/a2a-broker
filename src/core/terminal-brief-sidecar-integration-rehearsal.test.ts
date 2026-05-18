import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTerminalBriefSidecarIntegrationRehearsal,
  renderTerminalBriefSidecarIntegrationRehearsalMarkdown,
  type TerminalBriefSidecarSpoolRecord,
} from "./terminal-brief-sidecar-integration-rehearsal.js";
import type {
  TerminalTaskOutboxEvent,
  TerminalTaskStatus,
} from "./terminal-event-outbox.js";

const NOW = "2026-05-18T10:00:00.000Z";

function eventFor(
  worker: string,
  status: TerminalTaskStatus,
  options: {
    taskId?: string;
    progress?: number;
    total?: number;
    prUrl?: string;
    doneUrl?: string;
  } = {},
): TerminalTaskOutboxEvent {
  const taskId = options.taskId ?? "task-" + worker;
  return {
    id: taskId + "-" + status,
    kind: "task.terminal",
    taskEventId: 1,
    payload: {
      taskId,
      status,
      parentRoundId: "round-693",
      originBrokerId: "seoseo",
      brokerOfRecordId: "seoseo",
      worker,
      repo: "jinwon-int/a2a-broker",
      issue: 693,
      taskBrief: "Terminal Brief sidecar integration rehearsal",
      prUrl: options.prUrl,
      doneUrl: options.doneUrl,
      parentRoundProgress: options.progress,
      parentRoundTotal: options.total,
      createdAt: NOW,
      updatedAt: NOW,
      completedAt: NOW,
    },
    createdAt: NOW,
    receipt: {
      status: "produced",
      updatedAt: NOW,
      receiptId: "hermes-gongyung:gongyung:" + taskId,
    },
    attempts: 0,
  };
}

function spoolRecord(worker: string, progress: number, total: number): TerminalBriefSidecarSpoolRecord {
  return {
    schema: "a2a.terminalBrief.hermesGongyungAdapter.spool.v1",
    writtenAt: NOW,
    operator: "gongyung",
    envelopeId: "terminal-brief-" + worker,
    dedupeKey: "terminal-brief-" + worker,
    taskId: "task-" + worker,
    worker,
    status: "succeeded",
    title: "A2A Terminal Brief 완료: " + worker + "(" + progress + "/" + total + ")",
    text: "A2A Terminal Brief 완료: " + worker + "(" + progress + "/" + total + ")\nRequired receipt proof: current_session_visible",
    safety: {
      providerSend: false,
      terminalAck: false,
      dryRunOnly: true,
    },
  };
}

function readyEvents(): TerminalTaskOutboxEvent[] {
  return [
    eventFor("bangtong", "succeeded", {
      progress: 1,
      total: 3,
      prUrl: "https://github.com/jinwon-int/a2a-broker/pull/701",
    }),
    eventFor("sogyo", "succeeded", {
      progress: 2,
      total: 3,
      doneUrl: "https://github.com/jinwon-int/a2a-broker/issues/693#issuecomment-sogyo-done",
    }),
    eventFor("nosuk", "succeeded", {
      progress: 3,
      total: 3,
      prUrl: "https://github.com/jinwon-int/a2a-broker/pull/702",
    }),
  ];
}

test("sidecar dry-run spool final count produces a closeout candidate without ACK", () => {
  const rehearsal = buildTerminalBriefSidecarIntegrationRehearsal({
    parentRoundId: "round-693",
    expectedWorkers: ["bangtong", "sogyo", "nosuk"],
    sidecarSpool: [
      spoolRecord("bangtong", 1, 3),
      spoolRecord("sogyo", 2, 3),
      spoolRecord("nosuk", 3, 3),
    ],
    sidecarReceipts: [
      {
        ackTerminalEvent: false,
        terminalReceiptStatus: "produced",
        receiptId: "hermes-gongyung:gongyung:task-nosuk",
        reason: "spooled for Gongyung review",
      },
    ],
    events: readyEvents(),
  }, { now: NOW });

  assert.equal(rehearsal.decision, "candidate");
  assert.equal(rehearsal.sidecar.dryRunOnly, true);
  assert.equal(rehearsal.sidecar.providerSendAttempted, false);
  assert.equal(rehearsal.sidecar.terminalAckAttempted, false);
  assert.deepEqual(rehearsal.sidecar.terminalReceiptStatuses, ["produced"]);
  assert.equal(rehearsal.finalCountCandidate.decision, "candidate");
  assert.equal(rehearsal.finalCountCandidate.completion.summary.providerOnly, 3);
  assert.equal(rehearsal.semantics.sidecarProducedReceiptIsTerminalAck, false);
});

test("partial sidecar M/N blocks with missing worker evidence", () => {
  const rehearsal = buildTerminalBriefSidecarIntegrationRehearsal({
    parentRoundId: "round-693",
    expectedWorkers: ["bangtong", "sogyo", "nosuk"],
    sidecarSpool: [
      spoolRecord("bangtong", 1, 3),
      spoolRecord("sogyo", 2, 3),
    ],
    events: readyEvents().slice(0, 2),
  }, { now: NOW });

  assert.equal(rehearsal.decision, "blocked");
  assert.deepEqual(rehearsal.finalCountCandidate.missingWorkers, ["nosuk"]);
  assert.match(rehearsal.blockers.join("\n"), /final count not reached: 2\/3/);
});

test("sidecar safety flags fail closed when provider send or terminal ACK is attempted", () => {
  const unsafe = spoolRecord("nosuk", 3, 3);
  unsafe.safety = {
    providerSend: true,
    terminalAck: true,
    dryRunOnly: false,
  };
  const rehearsal = buildTerminalBriefSidecarIntegrationRehearsal({
    parentRoundId: "round-693",
    expectedWorkers: ["bangtong", "sogyo", "nosuk"],
    sidecarSpool: [
      spoolRecord("bangtong", 1, 3),
      spoolRecord("sogyo", 2, 3),
      unsafe,
    ],
    sidecarReceipts: [{ ackTerminalEvent: true, confirmationSource: "current_session_visible", receiptId: "live-receipt" }],
    events: readyEvents(),
  }, { now: NOW });

  assert.equal(rehearsal.decision, "blocked");
  assert.equal(rehearsal.sidecar.providerSendAttempted, true);
  assert.equal(rehearsal.sidecar.terminalAckAttempted, true);
  assert.match(rehearsal.blockers.join("\n"), /sidecar fixture attempted provider send/);
  assert.match(rehearsal.blockers.join("\n"), /sidecar fixture attempted terminal ACK/);
});

test("conflicting sidecar final counts fail closed", () => {
  const rehearsal = buildTerminalBriefSidecarIntegrationRehearsal({
    parentRoundId: "round-693",
    expectedWorkers: ["bangtong", "sogyo", "nosuk"],
    sidecarSpool: [
      spoolRecord("nosuk", 3, 3),
      spoolRecord("yukson", 4, 4),
    ],
    events: readyEvents(),
  }, { now: NOW });

  assert.equal(rehearsal.decision, "blocked");
  assert.match(rehearsal.blockers.join("\n"), /conflicting final-count totals observed: 3, 4/);
});

test("renderTerminalBriefSidecarIntegrationRehearsalMarkdown states source-only receipt boundary", () => {
  const rehearsal = buildTerminalBriefSidecarIntegrationRehearsal({
    parentRoundId: "round-693",
    expectedWorkers: ["bangtong", "sogyo", "nosuk"],
    sidecarSpool: [
      spoolRecord("bangtong", 1, 3),
      spoolRecord("sogyo", 2, 3),
      spoolRecord("nosuk", 3, 3),
    ],
    events: readyEvents(),
  }, { now: NOW });
  const markdown = renderTerminalBriefSidecarIntegrationRehearsalMarkdown(rehearsal);

  assert.match(markdown, /^Candidate: terminal-brief sidecar integration rehearsal/);
  assert.match(markdown, /Sidecar spool: records=3 signals=3 dryRunOnly=true/);
  assert.match(markdown, /source\/no-live rehearsal only; sidecar spool or produced receipt is not terminal ACK/);
});
