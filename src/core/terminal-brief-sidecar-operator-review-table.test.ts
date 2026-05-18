import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildTerminalBriefSidecarAdapterHandoffApproval,
  extractTerminalBriefSidecarAdapterHandoffApprovalOptions,
  extractTerminalBriefSidecarAdapterHandoffApprovalPacket,
  type TerminalBriefSidecarAdapterHandoffApprovalPacket,
} from "./terminal-brief-sidecar-adapter-handoff-approval.js";
import {
  buildTerminalBriefSidecarOperatorReviewTable,
  extractTerminalBriefSidecarOperatorReviewTableHandoff,
  extractTerminalBriefSidecarOperatorReviewTableOptions,
  renderTerminalBriefSidecarOperatorReviewTableMarkdown,
} from "./terminal-brief-sidecar-operator-review-table.js";

const NOW = "2026-05-19T01:20:00.000Z";

function readyHandoff(
  overrides: Partial<TerminalBriefSidecarAdapterHandoffApprovalPacket> = {},
): TerminalBriefSidecarAdapterHandoffApprovalPacket {
  const fixture = JSON.parse(readFileSync("fixtures/terminal-brief/sidecar-adapter-handoff-approval.no-live.json", "utf8"));
  const packet = buildTerminalBriefSidecarAdapterHandoffApproval(
    extractTerminalBriefSidecarAdapterHandoffApprovalPacket(fixture),
    {
      ...extractTerminalBriefSidecarAdapterHandoffApprovalOptions(fixture),
      now: NOW,
      adapterId: "gongyung-approval-renderer",
      deliveryTargetClass: "manual-operator-channel",
      handoffReference: "handoff-743",
    },
  );
  return { ...packet, ...overrides } as TerminalBriefSidecarAdapterHandoffApprovalPacket;
}

test("operator review table becomes ready without dispatch or runtime execution", () => {
  const packet = buildTerminalBriefSidecarOperatorReviewTable(readyHandoff(), {
    now: NOW,
    reviewOwner: "seoseo",
    reviewReference: "operator-review-743",
  });

  assert.equal(packet.kind, "a2a-broker.terminal-brief-sidecar-operator-review-table.packet");
  assert.equal(packet.state, "review_table_ready");
  assert.equal(packet.source.adapterHandoffReady, true);
  assert.equal(packet.source.adapterId, "gongyung-approval-renderer");
  assert.equal(packet.operatorReview.tableOnly, true);
  assert.equal(packet.operatorReview.rows.length, 8);
  assert.equal(packet.operatorReview.readyRowCount, 8);
  assert.equal(packet.operatorReview.blockedRowCount, 0);
  assert.equal(packet.operatorReview.dispatchPermitted, false);
  assert.equal(packet.operatorReview.providerSendPermitted, false);
  assert.equal(packet.operatorReview.approvalGrantPermitted, false);
  assert.equal(packet.operatorReview.terminalAckPermitted, false);
  assert.equal(packet.operatorReview.executionPermitted, false);
  assert.equal(packet.readiness.reviewTableReady, true);
  assert.equal(packet.readiness.approvalRequestDispatchPermitted, false);
  assert.equal(packet.readiness.approvalGrantPermitted, false);
  assert.equal(packet.readiness.executorInvocationPermitted, false);
  assert.equal(packet.readiness.processSpawnPermitted, false);
  assert.equal(packet.readiness.sidecarStartPermitted, false);
  assert.equal(packet.readiness.providerSendPermitted, false);
  assert.equal(packet.readiness.terminalAckPermitted, false);
  assert.equal(packet.readiness.executionPermitted, false);
  assert.equal(packet.readiness.dbMutationPermitted, false);
  assert.equal(packet.integrationContract.rendersOperatorReviewTable, true);
  assert.equal(packet.integrationContract.sendsApprovalRequest, false);
  assert.equal(packet.integrationContract.invokesExecutor, false);
  assert.equal(packet.integrationContract.spawnsProcess, false);
  assert.equal(packet.integrationContract.startsSidecar, false);
  assert.equal(packet.semantics.operatorReviewTableOnly, true);
  assert.equal(packet.semantics.reviewDoesNotSendApprovalRequest, true);
  assert.equal(packet.semantics.reviewDoesNotGrantApproval, true);
});

test("operator review table waits for unready adapter handoff", () => {
  const source = readyHandoff({
    state: "waiting_for_runtime_preflight_approval",
    readiness: {
      ...readyHandoff().readiness,
      sourceCriteriaMet: false,
      handoffPacketReady: false,
    },
  });
  const packet = buildTerminalBriefSidecarOperatorReviewTable(source, { now: NOW });

  assert.equal(packet.state, "waiting_for_adapter_handoff");
  assert.deepEqual(packet.readiness.missingEvidence, [
    "ready_adapter_handoff",
    "source_criteria",
    "adapter_handoff_packet",
  ]);
  assert.equal(packet.operatorReview.waitingRowCount, 8);
  assert.equal(packet.readiness.executionPermitted, false);
});

test("operator review table preserves stale conflicting and rejected source states", () => {
  const stale = buildTerminalBriefSidecarOperatorReviewTable(readyHandoff({ state: "stale" }), { now: NOW });
  const conflicting = buildTerminalBriefSidecarOperatorReviewTable(readyHandoff({ state: "conflicting" }), { now: NOW });
  const rejected = buildTerminalBriefSidecarOperatorReviewTable(readyHandoff({ state: "rejected" }), { now: NOW });

  assert.equal(stale.state, "stale");
  assert.equal(conflicting.state, "conflicting");
  assert.equal(rejected.state, "rejected");
  assert.equal(stale.readiness.providerSendPermitted, false);
  assert.equal(conflicting.readiness.terminalAckPermitted, false);
  assert.equal(rejected.readiness.sidecarStartPermitted, false);
});

test("operator review table blocks unsafe adapter handoff drift", () => {
  const unsafe = readyHandoff();
  unsafe.readiness.approvalRequestDispatchPermitted = true as false;
  const packet = buildTerminalBriefSidecarOperatorReviewTable(unsafe, { now: NOW });

  assert.equal(packet.state, "blocked");
  assert.equal(packet.blockers.some((blocker) => blocker.includes("approval dispatch")), true);
  assert.equal(packet.readiness.approvalRequestDispatchPermitted, false);
});

test("operator review table extractors and markdown preserve no-live boundary", () => {
  const source = readyHandoff();
  const input = {
    adapterHandoffApprovalPacket: source,
    operatorReviewTable: {
      review_owner: "seoseo",
      review_reference: "operator-review-743",
      review_rows: ["adapter", "runtime_boundary"],
    },
  };

  assert.equal(extractTerminalBriefSidecarOperatorReviewTableHandoff(input).idempotencyKey, source.idempotencyKey);
  assert.equal(extractTerminalBriefSidecarOperatorReviewTableOptions(input).review_owner, "seoseo");

  const packet = buildTerminalBriefSidecarOperatorReviewTable(
    extractTerminalBriefSidecarOperatorReviewTableHandoff(input),
    { ...extractTerminalBriefSidecarOperatorReviewTableOptions(input), now: NOW },
  );
  const markdown = renderTerminalBriefSidecarOperatorReviewTableMarkdown(packet);

  assert.deepEqual(packet.operatorReview.rows.map((row) => row.id), ["adapter", "runtime_boundary"]);
  assert.equal(markdown.includes("does not send approval"), true);
  assert.equal(markdown.includes("terminalAckPermitted=false"), true);
  assert.equal(packet.readiness.approvalRequestDispatchPermitted, false);
});
