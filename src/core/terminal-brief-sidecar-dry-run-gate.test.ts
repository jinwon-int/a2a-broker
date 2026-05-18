import assert from "node:assert/strict";
import test from "node:test";

import type { TerminalBriefFinalizerApprovalStatusPacket } from "./terminal-brief-finalizer-approval-status.js";
import {
  buildTerminalBriefSidecarDryRunGate,
  extractTerminalBriefSidecarDryRunGateFinalizerStatus,
  extractTerminalBriefSidecarDryRunGateRehearsal,
  extractTerminalBriefSidecarDryRunOperatingEvidence,
  renderTerminalBriefSidecarDryRunGateMarkdown,
} from "./terminal-brief-sidecar-dry-run-gate.js";
import type { TerminalBriefSidecarIntegrationRehearsal } from "./terminal-brief-sidecar-integration-rehearsal.js";

const NOW = "2026-05-18T23:30:00.000Z";
const FRESH = "2026-05-18T23:29:30.000Z";
const OLD = "2026-05-18T23:00:00.000Z";

function sidecar(overrides: Partial<TerminalBriefSidecarIntegrationRehearsal> = {}): TerminalBriefSidecarIntegrationRehearsal {
  const base: TerminalBriefSidecarIntegrationRehearsal = {
    kind: "a2a-broker.terminal-brief-sidecar-integration-rehearsal",
    version: 1,
    generatedAt: NOW,
    mode: "read-only/no-live",
    parentRoundId: "round-712",
    decision: "candidate",
    sidecar: {
      spoolRecords: 3,
      finalCountSignalsFromSpool: 3,
      receiptDecisions: 1,
      terminalReceiptStatuses: ["produced"],
      providerSendAttempted: false,
      terminalAckAttempted: false,
      dryRunOnly: true,
      unsafeSpoolRecords: [],
    },
    finalCountCandidate: {
      kind: "a2a-broker.terminal-brief-final-count-closeout-candidate",
      version: 1,
      generatedAt: NOW,
      mode: "read-only/no-live",
      parentRoundId: "round-712",
      decision: "candidate",
      dryRunOnly: true,
      idempotencyKey: "tb-final-count:fixture-712",
      finalCount: {
        expectedTotal: 3,
        observedFinal: 3,
        complete: true,
        conflicting: false,
      },
      completionWatcher: {
        kind: "a2a-broker.terminal-brief-completion-watcher.packet",
        version: 1,
        generatedAt: NOW,
        mode: "read-only/no-live",
        parentRoundId: "round-712",
        decision: "ready_for_finalizer",
        idempotencyKey: "tb-completion-watcher:fixture-712",
        workers: [],
        evidence: [],
        receiptGaps: [],
        blockers: [],
        nextActions: [],
        semantics: {
          completionWatcherIsNotFinalAction: true,
          providerAcceptedIsNotTerminalAck: true,
          currentSessionVisibilityRequiredForAck: true,
          brokerFinalizerRequired: true,
        },
      },
      finalCountSignals: [],
      workers: [],
      blockers: [],
      nextActions: [],
      semantics: {
        candidateIsNotFinalAction: true,
        finalCountIsCloseoutInputOnly: true,
        brokerFinalizerRequired: true,
        performsGitHubMutation: false,
        performsProviderSend: false,
        performsTerminalAck: false,
        performsRuntimeRestartOrDeploy: false,
        performsDbMutation: false,
      },
    } as never,
    blockers: [],
    nextStep: "open broker finalizer review from sidecar no-live rehearsal",
    approvalSensitiveActionsExcluded: [],
    semantics: {
      sidecarSpoolIsReceiptProof: false,
      sidecarProducedReceiptIsTerminalAck: false,
      finalCountIsCloseoutTrigger: true,
      closeoutCandidateIsNotFinalAction: true,
      brokerFinalizerRequired: true,
    },
  };
  return { ...base, ...overrides };
}

function status(overrides: Partial<TerminalBriefFinalizerApprovalStatusPacket> = {}): TerminalBriefFinalizerApprovalStatusPacket {
  const base = {
    kind: "a2a-broker.terminal-brief-finalizer-approval-status.packet",
    version: 1,
    generatedAt: NOW,
    mode: "read-only/no-live",
    parentRoundId: "round-712",
    state: "ready_for_finalizer_review",
    dryRunOnly: true,
    sourceOnlyNoLive: true,
    finalizer: {
      brokerOfRecordId: "broker-finalizer",
      owner: "broker-finalizer",
      required: true,
      singleFinalizerRequired: true,
    },
    idempotencyKey: "tb-finalizer-approval-status:fixture-712",
    source: {
      dispatchState: "dispatch_draft_ready",
      dispatchIdempotencyKey: "tb-approval-dispatch:fixture-712",
      adapterType: "gongyung",
    },
    requestedAction: {
      action: "post_closeout_comment",
      target: "https://github.com/jinwon-int/a2a-broker/issues/712",
      requestedActions: 2,
      nonRequestableActions: 1,
    },
    approval: {
      receiptEvidenceAccepted: true,
      providerAccepted: false,
      currentSessionVisible: true,
      manualOperatorConfirmed: false,
      approvalGrantAccepted: true,
      terminalAckEligible: true,
      terminalAckPermitted: false,
      approvalGrantPermitted: false,
      executionPermitted: false,
    },
    table: {
      rows: [],
      requiredRowsReady: 3,
      requiredRows: 3,
      readyRows: 4,
      totalRows: 5,
    },
    defaultOnReadiness: {
      sourceCriteriaMet: true,
      defaultOnPermitted: false,
      missingEvidence: [],
      blockers: [
        "default-on enablement still requires separate live deployment/canary approval",
      ],
      nextAction: "request explicit operator approval for any default-on/live canary step",
    },
    blockers: [],
    nextActions: [],
    approvalSensitiveActionsExcluded: [],
    integrationContract: {
      transport: "json",
      statusTableVersion: 1,
      harnessNeutral: true,
      openclawMessageSendRequired: false,
      hermesAdapterCompatible: true,
      gongyungAdapterCompatible: true,
      consumesDispatchAdapterPacket: true,
      consumesReceiptIngestorPacket: true,
      grantsApproval: false,
      executesAction: false,
    },
    semantics: {
      statusTableOnly: true,
      sourceOnlyNoLive: true,
      tableDoesNotMutateState: true,
      dispatchDraftIsNotSend: true,
      providerAcceptedIsVisibilityProof: false,
      terminalAckEligibleDoesNotPermitAck: true,
      approvalGrantEvidenceDoesNotGrantApproval: true,
      executionNotPermitted: true,
      defaultOnNotEnabledByThisPacket: true,
      routeIsReadOnly: true,
      brokerFinalizerRequired: true,
      singleFinalizerRequired: true,
      performsGitHubMutation: false,
      performsProviderSend: false,
      performsTerminalAck: false,
      performsRuntimeRestartOrDeploy: false,
      performsDbMutation: false,
      createsTaskFlowRecords: false,
      performsHistoricalReplay: false,
      performsReleaseOrPublish: false,
      movesSecretsOrCredentials: false,
    },
  } satisfies TerminalBriefFinalizerApprovalStatusPacket;
  return { ...base, ...overrides } as TerminalBriefFinalizerApprovalStatusPacket;
}

function operatingEvidence(overrides = {}) {
  return {
    observedAt: FRESH,
    cursorPersisted: true,
    boundedPolling: true,
    pollIntervalMs: 15000,
    maxBatch: 20,
    gatewayReady: true,
    eventLoopDegraded: false,
    queueBacklog: 0,
    dryRunOnly: true,
    operatorEventsCrossBrokersEnabled: false,
    supervisedSidecar: true,
    ...overrides,
  };
}

test("sidecar dry-run gate waits for finalizer status when missing", () => {
  const packet = buildTerminalBriefSidecarDryRunGate(sidecar(), undefined, operatingEvidence(), { now: NOW });

  assert.equal(packet.kind, "a2a-broker.terminal-brief-sidecar-dry-run-gate.packet");
  assert.equal(packet.state, "waiting_for_finalizer_status");
  assert.equal(packet.readiness.alwaysOnDryRunStartPermitted, false);
  assert.equal(packet.readiness.defaultOnPermitted, false);
  assert.equal(packet.integrationContract.startsSidecar, false);
  assert.equal(packet.semantics.performsRuntimeRestartOrDeploy, false);
  assert.equal(packet.table.rows.some((row) => row.name === "finalizer_status" && row.ready === false), true);
});

test("sidecar dry-run gate becomes ready for operator approval with safe sidecar, finalizer status, and operating evidence", () => {
  const packet = buildTerminalBriefSidecarDryRunGate(sidecar(), status(), operatingEvidence(), { now: NOW });

  assert.equal(packet.state, "ready_for_operator_approval");
  assert.equal(packet.readiness.sourceCriteriaMet, true);
  assert.equal(packet.readiness.alwaysOnDryRunCandidate, true);
  assert.equal(packet.readiness.alwaysOnDryRunStartPermitted, false);
  assert.equal(packet.readiness.defaultOnPermitted, false);
  assert.equal(packet.readiness.liveActivationPermitted, false);
  assert.equal(packet.table.requiredRowsReady, 5);
  assert.equal(packet.table.rows.find((row) => row.name === "live_activation")?.ready, false);
});

test("sidecar dry-run gate blocks unsafe sidecar flags", () => {
  const packet = buildTerminalBriefSidecarDryRunGate(sidecar({
    decision: "blocked",
    sidecar: {
      ...sidecar().sidecar,
      dryRunOnly: false,
      providerSendAttempted: true,
      terminalAckAttempted: true,
      unsafeSpoolRecords: ["unsafe-spool"],
    },
    blockers: ["unsafe-spool: sidecar spool safety flags are not dry-run-only"],
  }), status(), operatingEvidence(), { now: NOW });

  assert.equal(packet.state, "blocked");
  assert.equal(packet.blockers.some((blocker) => blocker.includes("provider send")), true);
  assert.equal(packet.readiness.alwaysOnDryRunCandidate, false);
});

test("sidecar dry-run gate fails closed on stale or degraded operating evidence", () => {
  const stale = buildTerminalBriefSidecarDryRunGate(sidecar(), status(), operatingEvidence({
    observedAt: OLD,
  }), { now: NOW, maxAgeMs: 60_000 });
  assert.equal(stale.state, "stale");
  assert.equal(stale.blockers.includes("operating evidence is stale or expired"), true);

  const degraded = buildTerminalBriefSidecarDryRunGate(sidecar(), status(), operatingEvidence({
    eventLoopDegraded: true,
    queueBacklog: 2000,
  }), { now: NOW, maxQueueBacklog: 1000 });
  assert.equal(degraded.state, "waiting_for_operating_evidence");
  assert.equal(degraded.table.rows.find((row) => row.name === "gateway_load")?.ready, false);
});

test("sidecar dry-run gate extractors and markdown preserve no-live boundaries", () => {
  const rehearsal = sidecar();
  const finalizerStatus = status();
  assert.equal(extractTerminalBriefSidecarDryRunGateRehearsal(rehearsal), rehearsal);
  assert.equal(extractTerminalBriefSidecarDryRunGateRehearsal({ sidecarRehearsal: rehearsal }), rehearsal);
  assert.equal(extractTerminalBriefSidecarDryRunGateFinalizerStatus(finalizerStatus), finalizerStatus);
  assert.equal(extractTerminalBriefSidecarDryRunGateFinalizerStatus({ finalizerApprovalStatus: finalizerStatus }), finalizerStatus);
  assert.deepEqual(extractTerminalBriefSidecarDryRunOperatingEvidence({
    operatingEvidence: { cursorPersisted: true },
  }), { cursorPersisted: true });
  assert.throws(() => extractTerminalBriefSidecarDryRunGateRehearsal({ packet: { kind: "not-it" } }), /expected/);

  const packet = buildTerminalBriefSidecarDryRunGate(rehearsal, finalizerStatus, operatingEvidence(), { now: NOW });
  const markdown = renderTerminalBriefSidecarDryRunGateMarkdown(packet);
  assert.match(markdown, /^Ready: Terminal Brief sidecar always-on dry-run gate/);
  assert.match(markdown, /alwaysOnDryRunStartPermitted=false/);
  assert.match(markdown, /does not start sidecar, enable default-on, send providers/);
  assert.doesNotMatch(markdown, /ghp_|BROKER_EDGE_SECRET=|\/root\/\.openclaw/);
});
