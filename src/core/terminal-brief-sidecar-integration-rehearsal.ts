import {
  buildTerminalBriefFinalCountCloseoutCandidate,
  renderTerminalBriefFinalCountCloseoutMarkdown,
  type TerminalBriefFinalCountCloseoutCandidate,
  type TerminalBriefFinalCountCloseoutOptions,
  type TerminalBriefFinalCountSignal,
} from "./terminal-brief-final-count-closeout.js";
import type { TerminalBriefCompletionWatcherInput } from "./terminal-brief-completion-watcher.js";

export type TerminalBriefSidecarIntegrationDecision = "candidate" | "blocked" | "waiting";

export interface TerminalBriefSidecarSpoolRecord {
  schema?: string;
  writtenAt?: string;
  operator?: string;
  envelopeId?: string;
  dedupeKey?: string;
  taskId?: string;
  worker?: string;
  status?: string;
  title?: string;
  text?: string;
  safety?: {
    providerSend?: boolean;
    terminalAck?: boolean;
    dryRunOnly?: boolean;
  };
}

export interface TerminalBriefSidecarReceiptDecision {
  ackTerminalEvent?: boolean;
  terminalReceiptStatus?: string;
  confirmationSource?: string;
  receiptId?: string;
  reason?: string;
}

export interface TerminalBriefSidecarIntegrationInput extends TerminalBriefCompletionWatcherInput {
  finalCountSignals?: TerminalBriefFinalCountSignal[];
  sidecarSpool?: TerminalBriefSidecarSpoolRecord[];
  sidecarReceipts?: TerminalBriefSidecarReceiptDecision[];
}

export interface TerminalBriefSidecarIntegrationRehearsal {
  kind: "a2a-broker.terminal-brief-sidecar-integration-rehearsal";
  version: 1;
  generatedAt: string;
  mode: string;
  parentRoundId?: string;
  decision: TerminalBriefSidecarIntegrationDecision;
  sidecar: {
    spoolRecords: number;
    finalCountSignalsFromSpool: number;
    receiptDecisions: number;
    terminalReceiptStatuses: string[];
    providerSendAttempted: boolean;
    terminalAckAttempted: boolean;
    dryRunOnly: boolean;
    unsafeSpoolRecords: string[];
  };
  finalCountCandidate: TerminalBriefFinalCountCloseoutCandidate;
  blockers: string[];
  nextStep: string;
  approvalSensitiveActionsExcluded: string[];
  semantics: {
    sidecarSpoolIsReceiptProof: false;
    sidecarProducedReceiptIsTerminalAck: false;
    finalCountIsCloseoutTrigger: true;
    closeoutCandidateIsNotFinalAction: true;
    brokerFinalizerRequired: true;
  };
}

const APPROVAL_SENSITIVE_ACTIONS_EXCLUDED = [
  "GitHub PR merge or issue close",
  "live provider/Hermes/Telegram/OpenClaw send",
  "terminal ACK/replay",
  "Gateway/broker/worker/sidecar restart or deploy",
  "broker DB mutation/prune/migration",
  "historical replay",
  "release/tag/npm publish",
  "secret or credential movement",
];

export function buildTerminalBriefSidecarIntegrationRehearsal(
  input: TerminalBriefSidecarIntegrationInput,
  options: TerminalBriefFinalCountCloseoutOptions = {},
): TerminalBriefSidecarIntegrationRehearsal {
  const sidecarSpool = input.sidecarSpool ?? [];
  const sidecarReceipts = input.sidecarReceipts ?? [];
  const sidecarSignals = sidecarSpool.flatMap((record) => signalFromSpoolRecord(record, input.parentRoundId));
  const finalCountCandidate = buildTerminalBriefFinalCountCloseoutCandidate({
    ...input,
    finalCountSignals: [
      ...(input.finalCountSignals ?? []),
      ...sidecarSignals,
    ],
  }, options);
  const unsafeSpoolRecords = sidecarSpool
    .map((record, index) => ({ record, index }))
    .filter(({ record }) => !isDryRunOnlySpoolRecord(record))
    .map(({ record, index }) => record.envelopeId ?? record.taskId ?? record.dedupeKey ?? "spool[" + index + "]");
  const providerSendAttempted = sidecarSpool.some((record) => record.safety?.providerSend === true);
  const terminalAckAttempted = sidecarSpool.some((record) => record.safety?.terminalAck === true)
    || sidecarReceipts.some((receipt) => receipt.ackTerminalEvent === true);
  const terminalReceiptStatuses = [...new Set(sidecarReceipts
    .map((receipt) => receipt.terminalReceiptStatus)
    .filter((value): value is string => Boolean(value)))].sort();
  const blockers = [
    ...finalCountCandidate.blockers,
    ...unsafeSpoolRecords.map((recordId) => recordId + ": sidecar spool safety flags are not dry-run-only"),
    ...(providerSendAttempted ? ["sidecar fixture attempted provider send"] : []),
    ...(terminalAckAttempted ? ["sidecar fixture attempted terminal ACK"] : []),
  ];
  const decision = blockers.length > 0 ? "blocked" : finalCountCandidate.decision;

  return {
    kind: "a2a-broker.terminal-brief-sidecar-integration-rehearsal",
    version: 1,
    generatedAt: options.now ?? new Date().toISOString(),
    mode: options.mode ?? "read-only/no-live",
    parentRoundId: input.parentRoundId ?? finalCountCandidate.parentRoundId,
    decision,
    sidecar: {
      spoolRecords: sidecarSpool.length,
      finalCountSignalsFromSpool: sidecarSignals.length,
      receiptDecisions: sidecarReceipts.length,
      terminalReceiptStatuses,
      providerSendAttempted,
      terminalAckAttempted,
      dryRunOnly: unsafeSpoolRecords.length === 0,
      unsafeSpoolRecords,
    },
    finalCountCandidate,
    blockers,
    nextStep: nextStepForDecision(decision),
    approvalSensitiveActionsExcluded: APPROVAL_SENSITIVE_ACTIONS_EXCLUDED,
    semantics: {
      sidecarSpoolIsReceiptProof: false,
      sidecarProducedReceiptIsTerminalAck: false,
      finalCountIsCloseoutTrigger: true,
      closeoutCandidateIsNotFinalAction: true,
      brokerFinalizerRequired: true,
    },
  };
}

export function renderTerminalBriefSidecarIntegrationRehearsalMarkdown(
  rehearsal: TerminalBriefSidecarIntegrationRehearsal,
): string {
  const title = rehearsal.decision === "candidate"
    ? "Candidate: terminal-brief sidecar integration rehearsal"
    : rehearsal.decision === "blocked"
      ? "Block: terminal-brief sidecar integration rehearsal"
      : "Wait: terminal-brief sidecar integration rehearsal";
  return [
    title,
    "Mode: " + rehearsal.mode,
    "Parent round: " + (rehearsal.parentRoundId ?? "unknown"),
    "Sidecar spool: records=" + rehearsal.sidecar.spoolRecords
      + " signals=" + rehearsal.sidecar.finalCountSignalsFromSpool
      + " dryRunOnly=" + rehearsal.sidecar.dryRunOnly
      + " providerSendAttempted=" + rehearsal.sidecar.providerSendAttempted
      + " terminalAckAttempted=" + rehearsal.sidecar.terminalAckAttempted,
    "Sidecar receipts: decisions=" + rehearsal.sidecar.receiptDecisions
      + " statuses=" + (rehearsal.sidecar.terminalReceiptStatuses.join(", ") || "none"),
    "Final-count candidate: " + rehearsal.finalCountCandidate.decision
      + " idempotency=" + rehearsal.finalCountCandidate.idempotencyKey,
    "Next step: " + rehearsal.nextStep,
    "",
    renderTerminalBriefFinalCountCloseoutMarkdown(rehearsal.finalCountCandidate),
    ...(rehearsal.blockers.length ? ["", "Integration blockers:", ...rehearsal.blockers.map((blocker) => "- " + blocker)] : []),
    "",
    "Safety: source/no-live rehearsal only; sidecar spool or produced receipt is not terminal ACK, read receipt, visibility proof, or operator approval.",
  ].join("\n");
}

function signalFromSpoolRecord(
  record: TerminalBriefSidecarSpoolRecord,
  parentRoundId?: string,
): TerminalBriefFinalCountSignal[] {
  const text = [record.title, record.text].filter(Boolean).join("\n");
  if (!text) return [];
  return [{
    source: "envelope",
    parentRoundId,
    worker: record.worker,
    text,
    createdAt: record.writtenAt,
  }];
}

function isDryRunOnlySpoolRecord(record: TerminalBriefSidecarSpoolRecord): boolean {
  return record.safety?.providerSend === false
    && record.safety.terminalAck === false
    && record.safety.dryRunOnly === true;
}

function nextStepForDecision(decision: TerminalBriefSidecarIntegrationDecision): string {
  if (decision === "candidate") return "open broker finalizer review from sidecar no-live rehearsal";
  if (decision === "blocked") return "fix sidecar safety/evidence blockers before finalizer review";
  return "wait for final sidecar Terminal Brief spool evidence";
}
