import { createHash } from "node:crypto";

import {
  buildTerminalBriefCompletionPacket,
  type TerminalBriefCompletionPacket,
  type TerminalBriefCompletionWatcherInput,
} from "./terminal-brief-completion-watcher.js";
import type { TerminalTaskOutboxEvent } from "./terminal-event-outbox.js";

export type TerminalBriefFinalCountDecision = "candidate" | "blocked" | "waiting";

export interface TerminalBriefFinalCountSignal {
  id?: string;
  source?: "envelope" | "structured" | "terminal-event";
  parentRoundId?: string;
  worker?: string;
  text?: string;
  title?: string;
  progress?: number;
  total?: number;
  createdAt?: string;
}

export interface TerminalBriefFinalCountCloseoutInput extends TerminalBriefCompletionWatcherInput {
  finalCountSignals?: TerminalBriefFinalCountSignal[];
}

export interface NormalizedTerminalBriefFinalCountSignal {
  parentRoundId?: string;
  progress: number;
  total: number;
  worker?: string;
  source: "envelope" | "structured" | "terminal-event";
  createdAt?: string;
}

export interface TerminalBriefFinalCountCloseoutCandidate {
  kind: "a2a-broker.terminal-brief-final-count-closeout.candidate";
  version: 1;
  generatedAt: string;
  mode: string;
  parentRoundId?: string;
  decision: TerminalBriefFinalCountDecision;
  idempotencyKey: string;
  trigger?: NormalizedTerminalBriefFinalCountSignal;
  normalizedSignals: NormalizedTerminalBriefFinalCountSignal[];
  completion: TerminalBriefCompletionPacket;
  blockers: string[];
  missingWorkers: string[];
  nextStep: string;
  approvalSensitiveActionsExcluded: string[];
  semantics: {
    finalCountIsCloseoutTrigger: true;
    closeoutCandidateIsNotFinalAction: true;
    providerAcceptedIsTerminalAck: false;
    providerAcceptedIsReadReceipt: false;
    providerAcceptedIsVisibilityProof: false;
    brokerFinalizerRequired: true;
  };
}

export interface TerminalBriefFinalCountCloseoutOptions {
  now?: string;
  mode?: string;
}

const COUNT_IN_PARENS_RE = /\((\d{1,4})\s*\/\s*(\d{1,4})\)/g;
const COUNT_BARE_RE = /\b(\d{1,4})\s*\/\s*(\d{1,4})\b/g;
const APPROVAL_SENSITIVE_ACTIONS_EXCLUDED = [
  "GitHub PR merge or issue close",
  "live provider/Telegram/Hermes/OpenClaw send",
  "terminal ACK/replay",
  "Gateway/broker/worker/sidecar restart or deploy",
  "broker DB mutation/prune/migration",
  "historical replay",
  "release/tag/npm publish",
  "secret or credential movement",
];

export function buildTerminalBriefFinalCountCloseoutCandidate(
  input: TerminalBriefFinalCountCloseoutInput,
  options: TerminalBriefFinalCountCloseoutOptions = {},
): TerminalBriefFinalCountCloseoutCandidate {
  const completion = buildTerminalBriefCompletionPacket(input, {
    now: options.now,
    mode: options.mode ?? "read-only/no-live",
  });
  const normalizedSignals = normalizeFinalCountSignals(input);
  const signalConflicts = findFinalCountConflicts(normalizedSignals, input.parentRoundId);
  const trigger = chooseTrigger(normalizedSignals);
  const blockers = [...signalConflicts];

  if (!trigger) {
    blockers.push("no final-count Terminal Brief signal observed");
  } else if (trigger.progress < trigger.total) {
    blockers.push("final count not reached: " + trigger.progress + "/" + trigger.total);
  }

  if (trigger?.progress === trigger?.total && completion.decision !== "ready_for_finalizer") {
    blockers.push("final count reached but completion watcher is " + completion.decision + ": " + completion.closeoutCandidate.reason);
  }

  const missingWorkers = [...new Set([
    ...completion.missingWorkers,
    ...completion.lanes
      .filter((lane) => lane.state === "waiting" || lane.state === "needs_evidence" || lane.state === "conflict" || lane.state === "blocked")
      .map((lane) => lane.worker),
  ])].sort();
  const decision = decide(trigger, blockers, completion);

  return {
    kind: "a2a-broker.terminal-brief-final-count-closeout.candidate",
    version: 1,
    generatedAt: options.now ?? new Date().toISOString(),
    mode: options.mode ?? "read-only/no-live",
    parentRoundId: input.parentRoundId ?? trigger?.parentRoundId ?? completion.parentRoundId,
    decision,
    idempotencyKey: buildIdempotencyKey(trigger, completion),
    trigger,
    normalizedSignals,
    completion,
    blockers,
    missingWorkers,
    nextStep: nextStepForDecision(decision),
    approvalSensitiveActionsExcluded: APPROVAL_SENSITIVE_ACTIONS_EXCLUDED,
    semantics: {
      finalCountIsCloseoutTrigger: true,
      closeoutCandidateIsNotFinalAction: true,
      providerAcceptedIsTerminalAck: false,
      providerAcceptedIsReadReceipt: false,
      providerAcceptedIsVisibilityProof: false,
      brokerFinalizerRequired: true,
    },
  };
}

export function normalizeFinalCountSignals(
  input: TerminalBriefFinalCountCloseoutInput,
): NormalizedTerminalBriefFinalCountSignal[] {
  const signals: NormalizedTerminalBriefFinalCountSignal[] = [];
  for (const signal of input.finalCountSignals ?? []) {
    const normalized = normalizeExplicitSignal(signal, input.parentRoundId);
    if (normalized) signals.push(normalized);
  }
  for (const event of input.events) {
    const normalized = normalizeTerminalEventSignal(event, input.parentRoundId);
    if (normalized) signals.push(normalized);
  }
  return dedupeSignals(signals).sort((a, b) => {
    const aTime = a.createdAt ?? "";
    const bTime = b.createdAt ?? "";
    return a.progress - b.progress || a.total - b.total || aTime.localeCompare(bTime) || (a.worker ?? "").localeCompare(b.worker ?? "");
  });
}

export function renderTerminalBriefFinalCountCloseoutMarkdown(candidate: TerminalBriefFinalCountCloseoutCandidate): string {
  const title = candidate.decision === "candidate"
    ? "Candidate: terminal-brief final-count closeout"
    : candidate.decision === "blocked"
      ? "Block: terminal-brief final-count closeout"
      : "Wait: terminal-brief final-count closeout";
  const trigger = candidate.trigger
    ? candidate.trigger.progress + "/" + candidate.trigger.total + " source=" + candidate.trigger.source
    : "missing";
  return [
    title,
    "Mode: " + candidate.mode,
    "Parent round: " + (candidate.parentRoundId ?? "unknown"),
    "Trigger: " + trigger,
    "Idempotency: " + candidate.idempotencyKey,
    "Completion watcher: " + candidate.completion.decision + " (" + candidate.completion.closeoutCandidate.status + ")",
    "Workers: expected=" + candidate.completion.summary.expectedTotal + " ready=" + candidate.completion.summary.ready + " missing=" + candidate.missingWorkers.length,
    "Next step: " + candidate.nextStep,
    "",
    "Closeout candidate:",
    "- status=" + candidate.decision,
    "- reason=" + (candidate.blockers[0] ?? "final count reached and completion watcher is ready; broker finalizer still required"),
    ...(candidate.missingWorkers.length ? ["- missingWorkers=" + candidate.missingWorkers.join(", ")] : []),
    ...(candidate.blockers.length ? ["", "Blockers:", ...candidate.blockers.map((blocker) => "- " + blocker)] : []),
    ...(candidate.completion.receiptGaps.length ? ["", "Receipt gaps:", ...candidate.completion.receiptGaps.map((gap) => "- " + gap)] : []),
    "",
    "Safety: candidate only; no merge, issue close, live send, terminal ACK/replay, restart, DB mutation, release, or secret movement.",
  ].join("\n");
}

function normalizeExplicitSignal(
  signal: TerminalBriefFinalCountSignal,
  parentRoundId?: string,
): NormalizedTerminalBriefFinalCountSignal | null {
  if (parentRoundId && signal.parentRoundId && signal.parentRoundId !== parentRoundId) return null;
  const structured = normalizeCountPair(signal.progress, signal.total);
  const parsed = structured ?? parseFinalCountText(signal.title) ?? parseFinalCountText(signal.text);
  if (!parsed) return null;
  return {
    parentRoundId: signal.parentRoundId ?? parentRoundId,
    progress: parsed.progress,
    total: parsed.total,
    worker: signal.worker,
    source: signal.source ?? (structured ? "structured" : "envelope"),
    createdAt: signal.createdAt,
  };
}

function normalizeTerminalEventSignal(
  event: TerminalTaskOutboxEvent,
  parentRoundId?: string,
): NormalizedTerminalBriefFinalCountSignal | null {
  if (parentRoundId && event.payload.parentRoundId !== parentRoundId) return null;
  const count = normalizeCountPair(event.payload.parentRoundProgress, event.payload.parentRoundTotal);
  if (!count) return null;
  return {
    parentRoundId: event.payload.parentRoundId ?? parentRoundId,
    progress: count.progress,
    total: count.total,
    worker: event.payload.worker,
    source: "terminal-event",
    createdAt: event.payload.completedAt ?? event.payload.updatedAt ?? event.createdAt,
  };
}

function parseFinalCountText(text: string | undefined): { progress: number; total: number } | null {
  if (!text) return null;
  const inParens = lastCountMatch(text, COUNT_IN_PARENS_RE);
  if (inParens) return inParens;
  return lastCountMatch(text, COUNT_BARE_RE);
}

function lastCountMatch(text: string, regex: RegExp): { progress: number; total: number } | null {
  regex.lastIndex = 0;
  let found: { progress: number; total: number } | null = null;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const pair = normalizeCountPair(match[1], match[2]);
    if (pair) found = pair;
  }
  return found;
}

function normalizeCountPair(progress: unknown, total: unknown): { progress: number; total: number } | null {
  const p = positiveInteger(progress);
  const t = positiveInteger(total);
  if (p === undefined || t === undefined || p > t) return null;
  return { progress: p, total: t };
}

function dedupeSignals(signals: NormalizedTerminalBriefFinalCountSignal[]): NormalizedTerminalBriefFinalCountSignal[] {
  const seen = new Set<string>();
  const out: NormalizedTerminalBriefFinalCountSignal[] = [];
  for (const signal of signals) {
    const key = [
      signal.parentRoundId ?? "",
      signal.worker ?? "",
      signal.progress,
      signal.total,
      signal.source,
      signal.createdAt ?? "",
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(signal);
  }
  return out;
}

function findFinalCountConflicts(
  signals: NormalizedTerminalBriefFinalCountSignal[],
  parentRoundId?: string,
): string[] {
  if (signals.length === 0) return [];
  const parentRoundIds = new Set(signals.map((signal) => signal.parentRoundId).filter(Boolean));
  const totals = new Set(signals.map((signal) => signal.total));
  const finalTotals = new Set(signals.filter((signal) => signal.progress === signal.total).map((signal) => signal.total));
  const conflicts: string[] = [];
  if (parentRoundId && parentRoundIds.size > 0 && !parentRoundIds.has(parentRoundId)) {
    conflicts.push("final-count signal parent round does not match requested parent round");
  }
  if (totals.size > 1) {
    conflicts.push("conflicting final-count totals observed: " + [...totals].sort((a, b) => a - b).join(", "));
  }
  if (finalTotals.size > 1) {
    conflicts.push("conflicting final terminal counts observed: " + [...finalTotals].sort((a, b) => a - b).join(", "));
  }
  return conflicts;
}

function chooseTrigger(signals: NormalizedTerminalBriefFinalCountSignal[]): NormalizedTerminalBriefFinalCountSignal | undefined {
  return signals
    .slice()
    .sort((a, b) => {
      const finalDelta = Number(b.progress === b.total) - Number(a.progress === a.total);
      if (finalDelta !== 0) return finalDelta;
      if (a.progress !== b.progress) return b.progress - a.progress;
      const aTime = a.createdAt ?? "";
      const bTime = b.createdAt ?? "";
      return bTime.localeCompare(aTime);
    })[0];
}

function decide(
  trigger: NormalizedTerminalBriefFinalCountSignal | undefined,
  blockers: string[],
  completion: TerminalBriefCompletionPacket,
): TerminalBriefFinalCountDecision {
  if (!trigger) return "waiting";
  if (blockers.length > 0) return "blocked";
  if (trigger.progress !== trigger.total) return "blocked";
  if (completion.decision !== "ready_for_finalizer") return "blocked";
  return "candidate";
}

function nextStepForDecision(decision: TerminalBriefFinalCountDecision): string {
  if (decision === "candidate") return "open broker finalizer review from closeout candidate";
  if (decision === "blocked") return "resolve missing/conflicting completion evidence before finalizer review";
  return "wait for final (N/N) Terminal Brief signal";
}

function buildIdempotencyKey(
  trigger: NormalizedTerminalBriefFinalCountSignal | undefined,
  completion: TerminalBriefCompletionPacket,
): string {
  const stable = JSON.stringify({
    parentRoundId: trigger?.parentRoundId ?? completion.parentRoundId ?? "",
    progress: trigger?.progress ?? 0,
    total: trigger?.total ?? completion.summary.expectedTotal,
    lanes: completion.lanes.map((lane) => ({
      worker: lane.worker,
      taskId: lane.taskId,
      state: lane.state,
      status: lane.status,
      evidenceUrl: lane.evidenceUrl,
    })).sort((a, b) => a.worker.localeCompare(b.worker)),
  });
  return "terminal-brief-final-count:" + createHash("sha256").update(stable).digest("hex").slice(0, 24);
}

function positiveInteger(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}
