import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTerminalBriefCompletionPacket,
  renderTerminalBriefCompletionPacketMarkdown,
} from "./terminal-brief-completion-watcher.js";
import type {
  TerminalTaskOutboxEvent,
  TerminalTaskReceiptStatus,
  TerminalTaskStatus,
} from "./terminal-event-outbox.js";

const NOW = "2026-05-18T08:30:00.000Z";

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
    ack?: boolean;
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
      parentRoundId: options.parentRoundId ?? "round-689",
      worker,
      repo: "jinwon-int/a2a-broker",
      issue: 689,
      prUrl: options.prUrl,
      doneUrl: options.doneUrl,
      blockUrl: options.blockUrl,
      parentRoundProgress: options.progress,
      parentRoundTotal: options.total,
      taskBrief: "Terminal Brief completion watcher",
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
    ack: options.ack ? {
      status: "receipt_confirmed",
      evidence: "operator_visible",
      acknowledgedAt: NOW,
      receiptId: "receipt-" + taskId,
    } : undefined,
    attempts: options.receiptStatus === "produced" ? 0 : 1,
  };
}

test("buildTerminalBriefCompletionPacket prepares ready closeout candidate without treating provider receipt as ACK", () => {
  const packet = buildTerminalBriefCompletionPacket({
    parentRoundId: "round-689",
    expectedWorkers: ["bangtong", "sogyo", "nosuk"],
    events: [
      eventFor("bangtong", "succeeded", { progress: 1, total: 3, prUrl: "https://github.com/jinwon-int/a2a-broker/pull/701" }),
      eventFor("sogyo", "succeeded", { progress: 2, total: 3, doneUrl: "https://github.com/jinwon-int/a2a-broker/issues/689#issuecomment-sogyo" }),
      eventFor("nosuk", "succeeded", { progress: 3, total: 3, prUrl: "https://github.com/jinwon-int/a2a-broker/pull/702" }),
    ],
  }, { now: NOW });

  assert.equal(packet.decision, "ready_for_finalizer");
  assert.equal(packet.closeoutCandidate.status, "candidate");
  assert.equal(packet.summary.finalCount?.reached, true);
  assert.equal(packet.summary.providerOnly, 3);
  assert.equal(packet.summary.operatorVisible, 0);
  assert.equal(packet.semantics.providerAcceptedIsTerminalAck, false);
  assert.equal(packet.semantics.providerAcceptedIsReadReceipt, false);
  assert.equal(packet.semantics.providerAcceptedIsVisibilityProof, false);
  assert.match(packet.receiptGaps[0] ?? "", /not terminal ACK/);
});

test("buildTerminalBriefCompletionPacket blocks when expected worker evidence is missing", () => {
  const packet = buildTerminalBriefCompletionPacket({
    parentRoundId: "round-689",
    expectedWorkers: ["bangtong", "sogyo"],
    events: [
      eventFor("bangtong", "succeeded", { progress: 1, total: 2, prUrl: "https://github.com/jinwon-int/a2a-broker/pull/701" }),
    ],
  }, { now: NOW });

  assert.equal(packet.decision, "blocked");
  assert.deepEqual(packet.missingWorkers, ["sogyo"]);
  assert.match(packet.closeoutCandidate.reason, /no terminal event observed/);
  assert.equal(packet.closeoutCandidate.status, "blocked");
});

test("buildTerminalBriefCompletionPacket blocks succeeded lanes without PR or Done evidence", () => {
  const packet = buildTerminalBriefCompletionPacket({
    parentRoundId: "round-689",
    expectedWorkers: ["bangtong"],
    events: [
      eventFor("bangtong", "succeeded", { progress: 1, total: 1 }),
    ],
  }, { now: NOW });

  assert.equal(packet.decision, "blocked");
  assert.deepEqual(packet.missingEvidence, ["bangtong: succeeded lacks PR/Done/Block evidence"]);
  assert.equal(packet.lanes[0]?.state, "needs_evidence");
});

test("buildTerminalBriefCompletionPacket blocks conflicting duplicate worker terminal events", () => {
  const packet = buildTerminalBriefCompletionPacket({
    parentRoundId: "round-689",
    expectedWorkers: ["bangtong"],
    events: [
      eventFor("bangtong", "succeeded", {
        taskId: "task-bangtong-a",
        progress: 1,
        total: 1,
        prUrl: "https://github.com/jinwon-int/a2a-broker/pull/701",
      }),
      eventFor("bangtong", "failed", {
        taskId: "task-bangtong-b",
        progress: 1,
        total: 1,
        blockUrl: "https://github.com/jinwon-int/a2a-broker/issues/689#issuecomment-block",
      }),
    ],
  }, { now: NOW });

  assert.equal(packet.decision, "blocked");
  assert.equal(packet.lanes[0]?.state, "conflict");
  assert.match(packet.conflicts[0] ?? "", /conflicting duplicate/);
});

test("buildTerminalBriefCompletionPacket treats failed and blocked lanes as closeout blockers with follow-up", () => {
  const packet = buildTerminalBriefCompletionPacket({
    parentRoundId: "round-689",
    expectedWorkers: ["bangtong"],
    events: [
      eventFor("bangtong", "blocked", {
        progress: 1,
        total: 1,
        receiptStatus: "operator_visible",
        blockUrl: "https://github.com/jinwon-int/a2a-broker/issues/689#issuecomment-block",
      }),
    ],
  }, { now: NOW });

  assert.equal(packet.decision, "blocked");
  assert.equal(packet.summary.operatorVisible, 1);
  assert.equal(packet.receiptGaps.length, 0);
  assert.match(packet.followUpTaskCandidates.join("\n"), /inspect Block evidence/);
});

test("renderTerminalBriefCompletionPacketMarkdown includes safety and lane evidence", () => {
  const packet = buildTerminalBriefCompletionPacket({
    parentRoundId: "round-689",
    expectedWorkers: ["bangtong"],
    events: [
      eventFor("bangtong", "succeeded", { progress: 1, total: 1, doneUrl: "https://github.com/jinwon-int/a2a-broker/issues/689#issuecomment-done" }),
    ],
  }, { now: NOW });
  const markdown = renderTerminalBriefCompletionPacketMarkdown(packet);

  assert.match(markdown, /^Ready: terminal-brief completion watcher/);
  assert.match(markdown, /bangtong \(1\/1\)/);
  assert.match(markdown, /provider accepted\/message-id is not terminal ACK/);
});
