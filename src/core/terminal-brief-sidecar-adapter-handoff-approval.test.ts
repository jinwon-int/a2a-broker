import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildTerminalBriefSidecarRuntimePreflightApproval,
  extractTerminalBriefSidecarRuntimePreflightApprovalOptions,
  extractTerminalBriefSidecarRuntimePreflightApprovalRehearsal,
  type TerminalBriefSidecarRuntimePreflightApprovalPacket,
} from "./terminal-brief-sidecar-runtime-preflight-approval.js";
import {
  buildTerminalBriefSidecarAdapterHandoffApproval,
  extractTerminalBriefSidecarAdapterHandoffApprovalOptions,
  extractTerminalBriefSidecarAdapterHandoffApprovalPacket,
  renderTerminalBriefSidecarAdapterHandoffApprovalMarkdown,
} from "./terminal-brief-sidecar-adapter-handoff-approval.js";

const NOW = "2026-05-19T01:00:00.000Z";

function readyApproval(
  overrides: Partial<TerminalBriefSidecarRuntimePreflightApprovalPacket> = {},
): TerminalBriefSidecarRuntimePreflightApprovalPacket {
  const fixture = JSON.parse(readFileSync("fixtures/terminal-brief/sidecar-runtime-preflight-approval.no-live.json", "utf8"));
  const packet = buildTerminalBriefSidecarRuntimePreflightApproval(
    extractTerminalBriefSidecarRuntimePreflightApprovalRehearsal(fixture),
    {
      ...extractTerminalBriefSidecarRuntimePreflightApprovalOptions(fixture),
      now: NOW,
    },
  );
  return { ...packet, ...overrides } as TerminalBriefSidecarRuntimePreflightApprovalPacket;
}

test("adapter handoff approval packet becomes ready without sending approval", () => {
  const packet = buildTerminalBriefSidecarAdapterHandoffApproval(readyApproval(), {
    now: NOW,
    adapterId: "gongyung-approval-renderer",
    deliveryTargetClass: "manual-operator-channel",
    handoffReference: "handoff-741",
  });

  assert.equal(packet.kind, "a2a-broker.terminal-brief-sidecar-adapter-handoff-approval.packet");
  assert.equal(packet.state, "handoff_packet_ready");
  assert.equal(packet.source.runtimePreflightApprovalReady, true);
  assert.equal(packet.source.adapterContractReady, true);
  assert.equal(packet.adapterHandoff.draftOnly, true);
  assert.equal(packet.adapterHandoff.adapterId, "gongyung-approval-renderer");
  assert.equal(packet.adapterHandoff.messageBody.includes("Terminal Brief sidecar supervised dry-run start approval request"), true);
  assert.equal(packet.adapterHandoff.dispatchPermitted, false);
  assert.equal(packet.adapterHandoff.providerSendPermitted, false);
  assert.equal(packet.adapterHandoff.approvalGrantPermitted, false);
  assert.equal(packet.adapterHandoff.terminalAckPermitted, false);
  assert.equal(packet.adapterHandoff.executionPermitted, false);
  assert.equal(packet.adapterHandoff.secretsIncluded, false);
  assert.equal(packet.readiness.handoffPacketReady, true);
  assert.equal(packet.readiness.approvalRequestDispatchPermitted, false);
  assert.equal(packet.readiness.approvalGrantPermitted, false);
  assert.equal(packet.readiness.executorInvocationPermitted, false);
  assert.equal(packet.readiness.processSpawnPermitted, false);
  assert.equal(packet.readiness.sidecarStartPermitted, false);
  assert.equal(packet.readiness.providerSendPermitted, false);
  assert.equal(packet.readiness.terminalAckPermitted, false);
  assert.equal(packet.readiness.executionPermitted, false);
  assert.equal(packet.readiness.dbMutationPermitted, false);
  assert.equal(packet.integrationContract.rendersApprovalRequestDraft, true);
  assert.equal(packet.integrationContract.sendsApprovalRequest, false);
  assert.equal(packet.integrationContract.invokesExecutor, false);
  assert.equal(packet.integrationContract.spawnsProcess, false);
  assert.equal(packet.integrationContract.startsSidecar, false);
  assert.equal(packet.semantics.adapterHandoffPacketOnly, true);
  assert.equal(packet.semantics.handoffDoesNotSendApprovalRequest, true);
  assert.equal(packet.semantics.adapterOutputDoesNotImplyReceiptProof, true);
});

test("adapter handoff waits for unready runtime preflight approval", () => {
  const source = readyApproval({
    state: "waiting_for_invocation_rehearsal",
    readiness: {
      ...readyApproval().readiness,
      sourceCriteriaMet: false,
      approvalPacketReady: false,
    },
  });
  const packet = buildTerminalBriefSidecarAdapterHandoffApproval(source, { now: NOW });

  assert.equal(packet.state, "waiting_for_runtime_preflight_approval");
  assert.deepEqual(packet.readiness.missingEvidence, [
    "ready_runtime_preflight_approval",
    "source_criteria",
    "runtime_preflight_approval_packet",
  ]);
  assert.equal(packet.readiness.approvalRequestDispatchPermitted, false);
  assert.equal(packet.readiness.executionPermitted, false);
});

test("adapter handoff preserves stale conflicting and rejected source states", () => {
  const stale = buildTerminalBriefSidecarAdapterHandoffApproval(readyApproval({ state: "stale" }), { now: NOW });
  const conflicting = buildTerminalBriefSidecarAdapterHandoffApproval(readyApproval({ state: "conflicting" }), { now: NOW });
  const rejected = buildTerminalBriefSidecarAdapterHandoffApproval(readyApproval({ state: "rejected" }), { now: NOW });

  assert.equal(stale.state, "stale");
  assert.equal(conflicting.state, "conflicting");
  assert.equal(rejected.state, "rejected");
  assert.equal(stale.readiness.providerSendPermitted, false);
  assert.equal(conflicting.readiness.terminalAckPermitted, false);
  assert.equal(rejected.readiness.sidecarStartPermitted, false);
});

test("adapter handoff blocks unsafe runtime preflight drift", () => {
  const unsafe = readyApproval();
  unsafe.readiness.providerSendPermitted = true as false;
  const packet = buildTerminalBriefSidecarAdapterHandoffApproval(unsafe, { now: NOW });

  assert.equal(packet.state, "blocked");
  assert.equal(packet.blockers.some((blocker) => blocker.includes("provider send")), true);
  assert.equal(packet.readiness.providerSendPermitted, false);
});

test("adapter handoff extractors and markdown preserve no-live boundary", () => {
  const source = readyApproval();
  const input = {
    runtimePreflightApprovalPacket: source,
    adapterHandoffApproval: {
      adapter_id: "openclaw-approval-renderer",
      delivery_target_class: "operator-visible-chat",
      evidence_bundle_references: ["runtime-preflight", "adapter-contract"],
    },
  };

  assert.equal(extractTerminalBriefSidecarAdapterHandoffApprovalPacket(input).idempotencyKey, source.idempotencyKey);
  assert.equal(extractTerminalBriefSidecarAdapterHandoffApprovalOptions(input).adapter_id, "openclaw-approval-renderer");

  const packet = buildTerminalBriefSidecarAdapterHandoffApproval(
    extractTerminalBriefSidecarAdapterHandoffApprovalPacket(input),
    { ...extractTerminalBriefSidecarAdapterHandoffApprovalOptions(input), now: NOW },
  );
  const markdown = renderTerminalBriefSidecarAdapterHandoffApprovalMarkdown(packet);

  assert.deepEqual(packet.adapterHandoff.evidenceBundleReferences, input.adapterHandoffApproval.evidence_bundle_references);
  assert.equal(markdown.includes("sends approval"), false);
  assert.equal(markdown.includes("does not send approval"), true);
  assert.equal(markdown.includes("terminalAckPermitted=false"), true);
  assert.equal(packet.readiness.approvalRequestDispatchPermitted, false);
});
