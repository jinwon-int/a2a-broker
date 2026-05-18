import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTerminalBriefFinalCountCloseoutCandidate,
  normalizeFinalCountSignals,
  renderTerminalBriefFinalCountCloseoutMarkdown,
} from "./terminal-brief-final-count-closeout.js";
import type {
  TerminalTaskOutboxEvent,
  TerminalTaskReceiptStatus,
  TerminalTaskStatus,
} from "./terminal-event-outbox.js";

const NOW = "2026-05-18T09:00:00.000Z";

function eventFor(
  worker: string,
  status: TerminalTaskStatus,
  options: {
    taskId?: string;
    receiptStatus?: TerminalTaskReceiptStatus;
    progress?: number;
    total?: number;
    prUrl?: string;
    doneUrl?: string;
    blockUrl?: string;
    parentRoundId?: string;
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
      parentRoundId: options.parentRoundId ?? "round-690",
      originBrokerId: "seoseo",
      brokerOfRecordId: "seoseo",
      worker,
      repo: "jinwon-int/a2a-broker",
      issue: 690,
      taskBrief: "Terminal Brief final-count closeout candidate",
      prUrl: options.prUrl,
      doneUrl: options.doneUrl,
      blockUrl: options.blockUrl,
      parentRoundProgress: options.progress,
      parentRoundTotal: options.total,
      createdAt: NOW,
      updatedAt: NOW,
      completedAt: NOW,
    },
    createdAt: NOW,
    receipt: {
      status: options.receiptStatus ?? "provider_accepted",
      updatedAt: NOW,
      receiptId: "receipt-" + taskId,
    },
    attempts: options.receiptStatus === "produced" ? 0 : 1,
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
      doneUrl: "https://github.com/jinwon-int/a2a-broker/issues/690#issuecomment-sogyo-done",
    }),
    eventFor("nosuk", "succeeded", {
      progress: 3,
      total: 3,
      prUrl: "https://github.com/jinwon-int/a2a-broker/pull/702",
    }),
  ];
}

test("buildTerminalBriefFinalCountCloseoutCandidate emits candidate after final (N/N) and ready worker evidence", () => {
  const candidate = buildTerminalBriefFinalCountCloseoutCandidate({
    parentRoundId: "round-690",
    expectedWorkers: ["bangtong", "sogyo", "nosuk"],
    finalCountSignals: [
      { id: "brief-final", text: "Terminal Brief: nosuk completed (3/3)", createdAt: NOW },
    ],
    events: readyEvents(),
  }, { now: NOW });

  assert.equal(candidate.decision, "candidate");
  assert.equal(candidate.trigger?.progress, 3);
  assert.equal(candidate.trigger?.total, 3);
  assert.equal(candidate.completion.decision, "ready_for_finalizer");
  assert.equal(candidate.semantics.closeoutCandidateIsNotFinalAction, true);
  assert.equal(candidate.semantics.brokerFinalizerRequired, true);
  assert.equal(candidate.semantics.providerAcceptedIsTerminalAck, false);
  assert.match(candidate.idempotencyKey, /^terminal-brief-final-count:[a-f0-9]{24}$/);
  assert.match(candidate.completion.receiptGaps[0] ?? "", /not terminal ACK/);
});

test("buildTerminalBriefFinalCountCloseoutCandidate blocks partial M/N and names missing workers", () => {
  const candidate = buildTerminalBriefFinalCountCloseoutCandidate({
    parentRoundId: "round-690",
    expectedWorkers: ["bangtong", "sogyo", "nosuk"],
    finalCountSignals: [
      { id: "brief-partial", text: "Terminal Brief: sogyo completed (2/3)", createdAt: NOW },
    ],
    events: readyEvents().slice(0, 2),
  }, { now: NOW });

  assert.equal(candidate.decision, "blocked");
  assert.deepEqual(candidate.missingWorkers, ["nosuk"]);
  assert.match(candidate.blockers.join("\n"), /final count not reached: 2\/3/);
  assert.equal(candidate.completion.decision, "blocked");
});

test("duplicate final-count messages are idempotent", () => {
  const input = {
    parentRoundId: "round-690",
    expectedWorkers: ["bangtong", "sogyo", "nosuk"],
    finalCountSignals: [
      { id: "brief-final-a", text: "Terminal Brief complete (3/3)", createdAt: "2026-05-18T09:00:00.000Z" },
      { id: "brief-final-b", title: "Terminal Brief complete (3/3)", createdAt: "2026-05-18T09:01:00.000Z" },
    ],
    events: readyEvents(),
  };

  const duplicate = buildTerminalBriefFinalCountCloseoutCandidate(input, { now: NOW });
  const single = buildTerminalBriefFinalCountCloseoutCandidate({
    ...input,
    finalCountSignals: [input.finalCountSignals[0]],
  }, { now: NOW });

  assert.equal(duplicate.decision, "candidate");
  assert.equal(duplicate.idempotencyKey, single.idempotencyKey);
  assert.equal(duplicate.blockers.length, 0);
});

test("conflicting final totals fail closed", () => {
  const candidate = buildTerminalBriefFinalCountCloseoutCandidate({
    parentRoundId: "round-690",
    expectedWorkers: ["bangtong", "sogyo", "nosuk"],
    finalCountSignals: [
      { id: "brief-final-3", text: "Terminal Brief complete (3/3)", createdAt: NOW },
      { id: "brief-final-4", text: "Terminal Brief complete (4/4)", createdAt: NOW },
    ],
    events: readyEvents(),
  }, { now: NOW });

  assert.equal(candidate.decision, "blocked");
  assert.match(candidate.blockers.join("\n"), /conflicting final-count totals observed: 3, 4/);
  assert.match(candidate.blockers.join("\n"), /conflicting final terminal counts observed: 3, 4/);
});

test("structured and terminal-event count signals are normalized", () => {
  const signals = normalizeFinalCountSignals({
    parentRoundId: "round-690",
    expectedWorkers: ["bangtong", "sogyo", "nosuk"],
    finalCountSignals: [
      { source: "structured", progress: 3, total: 3, createdAt: NOW },
    ],
    events: [
      eventFor("bangtong", "succeeded", {
        progress: 1,
        total: 3,
        prUrl: "https://github.com/jinwon-int/a2a-broker/pull/701",
      }),
    ],
  });

  assert.equal(signals.length, 2);
  assert.equal(signals.some((signal) => signal.source === "structured" && signal.progress === 3 && signal.total === 3), true);
  assert.equal(signals.some((signal) => signal.source === "terminal-event" && signal.worker === "bangtong"), true);
});

test("renderTerminalBriefFinalCountCloseoutMarkdown states candidate-only safety boundary", () => {
  const candidate = buildTerminalBriefFinalCountCloseoutCandidate({
    parentRoundId: "round-690",
    expectedWorkers: ["bangtong", "sogyo", "nosuk"],
    finalCountSignals: [
      { id: "brief-final", text: "Terminal Brief complete (3/3)", createdAt: NOW },
    ],
    events: readyEvents(),
  }, { now: NOW });
  const markdown = renderTerminalBriefFinalCountCloseoutMarkdown(candidate);

  assert.match(markdown, /^Candidate: terminal-brief final-count closeout/);
  assert.match(markdown, /Trigger: 3\/3 source=envelope/);
  assert.match(markdown, /candidate only; no merge, issue close, live send, terminal ACK\/replay/);
});
