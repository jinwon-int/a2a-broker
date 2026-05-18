import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTerminalBriefFinalizerHandoff,
  renderTerminalBriefFinalizerHandoffMarkdown,
} from "./terminal-brief-finalizer-handoff.js";
import {
  buildTerminalBriefSidecarIntegrationRehearsal,
  type TerminalBriefSidecarSpoolRecord,
} from "./terminal-brief-sidecar-integration-rehearsal.js";
import type {
  TerminalTaskOutboxEvent,
  TerminalTaskStatus,
} from "./terminal-event-outbox.js";

const NOW = "2026-05-18T11:00:00.000Z";

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
      parentRoundId: "round-695",
      originBrokerId: "seoseo",
      brokerOfRecordId: "seoseo",
      worker,
      repo: "jinwon-int/a2a-broker",
      issue: 695,
      taskBrief: "Terminal Brief finalizer handoff",
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
      doneUrl: "https://github.com/jinwon-int/a2a-broker/issues/695#issuecomment-sogyo-done",
    }),
    eventFor("nosuk", "succeeded", {
      progress: 3,
      total: 3,
      prUrl: "https://github.com/jinwon-int/a2a-broker/pull/702",
    }),
  ];
}

function readyRehearsal() {
  return buildTerminalBriefSidecarIntegrationRehearsal({
    parentRoundId: "round-695",
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
}

test("buildTerminalBriefFinalizerHandoff emits ready handoff packet without performing final action", () => {
  const packet = buildTerminalBriefFinalizerHandoff(readyRehearsal(), {
    now: NOW,
    brokerOfRecordId: "seoseo",
    finalizerOwner: "seoseo",
  });

  assert.equal(packet.decision, "ready");
  assert.equal(packet.finalizer.brokerOfRecordId, "seoseo");
  assert.equal(packet.finalizer.singleFinalizerRequired, true);
  assert.equal(packet.summary.expectedWorkers, 3);
  assert.equal(packet.summary.readyWorkers, 3);
  assert.equal(packet.summary.evidenceUrls, 3);
  assert.equal(packet.summary.receiptGaps, 3);
  assert.equal(packet.summary.blockers, 0);
  assert.equal(packet.semantics.handoffPacketIsNotFinalAction, true);
  assert.equal(packet.semantics.performsGitHubMutation, false);
  assert.equal(packet.semantics.performsTerminalAck, false);
  assert.match(packet.idempotencyKey, /^tb-finalizer-handoff:/);
  assert.match(packet.closeoutDraft.body, /Provider-only or produced receipt state is not terminal ACK/);
});

test("handoff blocks when sidecar safety is unsafe", () => {
  const unsafe = spoolRecord("nosuk", 3, 3);
  unsafe.safety = {
    providerSend: true,
    terminalAck: true,
    dryRunOnly: false,
  };
  const rehearsal = buildTerminalBriefSidecarIntegrationRehearsal({
    parentRoundId: "round-695",
    expectedWorkers: ["bangtong", "sogyo", "nosuk"],
    sidecarSpool: [
      spoolRecord("bangtong", 1, 3),
      spoolRecord("sogyo", 2, 3),
      unsafe,
    ],
    events: readyEvents(),
  }, { now: NOW });
  const packet = buildTerminalBriefFinalizerHandoff(rehearsal, { now: NOW });

  assert.equal(packet.decision, "blocked");
  assert.equal(packet.source.sidecarProviderSendAttempted, true);
  assert.equal(packet.source.sidecarTerminalAckAttempted, true);
  assert.match(packet.blockers.join("\n"), /sidecar fixture attempted provider send/);
  assert.match(packet.blockers.join("\n"), /sidecar fixture attempted terminal ACK/);
});

test("handoff blocks when final count is missing or worker evidence is incomplete", () => {
  const rehearsal = buildTerminalBriefSidecarIntegrationRehearsal({
    parentRoundId: "round-695",
    expectedWorkers: ["bangtong", "sogyo", "nosuk"],
    sidecarSpool: [],
    finalCountSignals: [],
    events: readyEvents().slice(0, 2),
  }, { now: NOW });
  const packet = buildTerminalBriefFinalizerHandoff(rehearsal, { now: NOW });

  assert.equal(packet.decision, "blocked");
  assert.match(packet.blockers.join("\n"), /final count not reached: 2\/3/);
  assert.equal(packet.summary.missingWorkers, 1);
});

test("handoff preserves a waiting source rehearsal as wait-only next action", () => {
  const waitingRehearsal = {
    ...readyRehearsal(),
    decision: "waiting" as const,
    blockers: [],
  };
  const packet = buildTerminalBriefFinalizerHandoff(waitingRehearsal, { now: NOW });

  assert.equal(packet.decision, "waiting");
  assert.deepEqual(packet.nextActions, [
    "wait for final Terminal Brief evidence and rerun the handoff packet",
    "do not close out until final count and completion watcher agree",
  ]);
});

test("renderTerminalBriefFinalizerHandoffMarkdown states single-finalizer and no-live safety", () => {
  const packet = buildTerminalBriefFinalizerHandoff(readyRehearsal(), {
    now: NOW,
    brokerOfRecordId: "seoseo",
    finalizerOwner: "seoseo",
  });
  const markdown = renderTerminalBriefFinalizerHandoffMarkdown(packet);

  assert.match(markdown, /^Ready: terminal-brief finalizer handoff/);
  assert.match(markdown, /singleFinalizerRequired=true/);
  assert.match(markdown, /Checklist:/);
  assert.match(markdown, /Safety: handoff packet only; no merge, issue close, comment post/);
  assert.doesNotMatch(markdown, /ghp_|BROKER_EDGE_SECRET=|\/root\/\.openclaw/);
});
