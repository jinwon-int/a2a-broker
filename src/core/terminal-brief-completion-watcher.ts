import type {
  TerminalTaskOutboxEvent,
  TerminalTaskReceiptStatus,
  TerminalTaskStatus,
} from "./terminal-event-outbox.js";

export type TerminalBriefCompletionDecision = "ready_for_finalizer" | "blocked" | "waiting";
export type TerminalBriefCompletionLaneState = "ready" | "blocked" | "waiting" | "needs_evidence" | "conflict";
export type TerminalBriefReceiptProofClass =
  | "receipt_confirmed"
  | "operator_visible"
  | "provider_only_not_ack"
  | "receipt_failed_or_stale"
  | "missing";

export interface TerminalBriefCompletionWatcherInput {
  parentRoundId?: string;
  expectedWorkers?: string[];
  expectedTotal?: number;
  events: TerminalTaskOutboxEvent[];
}

export interface TerminalBriefCompletionWatcherOptions {
  now?: string;
  mode?: string;
}

export interface TerminalBriefCompletionLane {
  worker: string;
  taskId?: string;
  status?: TerminalTaskStatus;
  state: TerminalBriefCompletionLaneState;
  evidenceUrl?: string;
  receiptStatus?: TerminalTaskReceiptStatus;
  receiptProof: TerminalBriefReceiptProofClass;
  receiptConfirmed: boolean;
  operatorVisible: boolean;
  providerOnly: boolean;
  parentRoundProgress?: number;
  parentRoundTotal?: number;
  completedAt?: string;
  blockers: string[];
  nextAction: string;
}

export interface TerminalBriefCompletionPacket {
  kind: "a2a-broker.terminal-brief-completion-watcher.packet";
  version: 1;
  generatedAt: string;
  mode: string;
  parentRoundId?: string;
  decision: TerminalBriefCompletionDecision;
  nextStep: string;
  summary: {
    expectedTotal: number;
    observedWorkers: number;
    terminalEvents: number;
    ready: number;
    blocked: number;
    waiting: number;
    needsEvidence: number;
    conflicts: number;
    receiptConfirmed: number;
    operatorVisible: number;
    providerOnly: number;
    receiptFailedOrStale: number;
    finalCount?: {
      progress: number;
      total: number;
      reached: boolean;
    };
  };
  lanes: TerminalBriefCompletionLane[];
  missingWorkers: string[];
  missingEvidence: string[];
  conflicts: string[];
  receiptGaps: string[];
  closeoutCandidate: {
    status: "candidate" | "blocked" | "waiting";
    reason: string;
    evidenceUrls: string[];
  };
  followUpTaskCandidates: string[];
  approvalSensitiveActionsExcluded: string[];
  semantics: {
    terminalBriefCompletionIsCloseoutInput: true;
    providerAcceptedIsTerminalAck: false;
    providerAcceptedIsReadReceipt: false;
    providerAcceptedIsVisibilityProof: false;
    brokerFinalizerRequired: true;
  };
}

const APPROVAL_SENSITIVE_ACTIONS_EXCLUDED = [
  "live provider/Telegram/Hermes/OpenClaw send",
  "terminal ACK/replay",
  "GitHub PR merge or issue close",
  "Gateway/broker/worker/sidecar restart or deploy",
  "broker DB mutation/prune/migration",
  "historical replay",
  "release/tag/npm publish",
  "secret or credential movement",
];

const HTTPS_URL_RE = /^https:\/\/[^\s]+$/;
const TERMINAL_STATUSES = new Set<TerminalTaskStatus>(["succeeded", "failed", "canceled", "blocked"]);
const PROVIDER_ONLY_RECEIPT_STATUSES = new Set<TerminalTaskReceiptStatus>([
  "accepted",
  "started",
  "produced",
  "provider_sent",
  "provider_accepted",
]);
const OPERATOR_VISIBLE_RECEIPT_STATUSES = new Set<TerminalTaskReceiptStatus>([
  "current_session_visible",
  "operator_visible",
]);
const RECEIPT_FAILED_OR_STALE_STATUSES = new Set<TerminalTaskReceiptStatus>([
  "failed",
  "timed_out",
  "stale",
]);

export function buildTerminalBriefCompletionPacket(
  input: TerminalBriefCompletionWatcherInput,
  options: TerminalBriefCompletionWatcherOptions = {},
): TerminalBriefCompletionPacket {
  const events = normalizeEvents(input.events, input.parentRoundId);
  const byWorker = groupByWorker(events);
  const expectedWorkers = deriveExpectedWorkers(input, byWorker);
  const expectedTotal = deriveExpectedTotal(input, expectedWorkers, events);
  const lanes = expectedWorkers.map((worker) => buildLane(worker, byWorker.get(worker) ?? []));
  const missingWorkers = lanes.filter((lane) => lane.state === "waiting").map((lane) => lane.worker);
  const missingEvidence = lanes
    .filter((lane) => lane.state === "needs_evidence")
    .map((lane) => lane.worker + ": " + (lane.status ?? "missing") + " lacks PR/Done/Block evidence");
  const conflicts = lanes.flatMap((lane) => lane.state === "conflict" ? lane.blockers.map((blocker) => lane.worker + ": " + blocker) : []);
  const receiptGaps = lanes
    .filter((lane) => lane.providerOnly || lane.receiptProof === "missing" || lane.receiptProof === "receipt_failed_or_stale")
    .map((lane) => lane.worker + ": receipt=" + (lane.receiptStatus ?? "missing") + " is not terminal ACK/read/visibility proof");

  const counts = lanes.reduce((acc, lane) => {
    acc[lane.state] = (acc[lane.state] ?? 0) + 1;
    return acc;
  }, {} as Record<TerminalBriefCompletionLaneState, number>);
  const finalCount = deriveFinalCount(events, expectedTotal);
  const hardBlockers = [
    ...missingWorkers.map((worker) => worker + ": no terminal event observed"),
    ...missingEvidence,
    ...conflicts,
    ...lanes
      .filter((lane) => lane.state === "blocked")
      .flatMap((lane) => lane.blockers.length
        ? lane.blockers.map((blocker) => lane.worker + ": " + blocker)
        : [lane.worker + ": " + lane.nextAction]),
  ];

  const readyCount = counts.ready ?? 0;
  const waitingCount = counts.waiting ?? 0;
  const decision = hardBlockers.length > 0
    ? "blocked"
    : waitingCount > 0 || readyCount < expectedTotal
      ? "waiting"
      : "ready_for_finalizer";
  const nextStep = nextStepForDecision(decision);
  const evidenceUrls = lanes.map((lane) => lane.evidenceUrl).filter((value): value is string => Boolean(value));

  return {
    kind: "a2a-broker.terminal-brief-completion-watcher.packet",
    version: 1,
    generatedAt: options.now ?? new Date().toISOString(),
    mode: options.mode ?? "read-only/no-live",
    parentRoundId: input.parentRoundId ?? mostCommon(events.map((event) => event.payload.parentRoundId)),
    decision,
    nextStep,
    summary: {
      expectedTotal,
      observedWorkers: byWorker.size,
      terminalEvents: events.length,
      ready: readyCount,
      blocked: lanes.filter((lane) => lane.state === "blocked").length,
      waiting: waitingCount,
      needsEvidence: counts.needs_evidence ?? 0,
      conflicts: counts.conflict ?? 0,
      receiptConfirmed: lanes.filter((lane) => lane.receiptConfirmed).length,
      operatorVisible: lanes.filter((lane) => lane.operatorVisible).length,
      providerOnly: lanes.filter((lane) => lane.providerOnly).length,
      receiptFailedOrStale: lanes.filter((lane) => lane.receiptProof === "receipt_failed_or_stale").length,
      finalCount,
    },
    lanes,
    missingWorkers,
    missingEvidence,
    conflicts,
    receiptGaps,
    closeoutCandidate: {
      status: decision === "ready_for_finalizer" ? "candidate" : decision,
      reason: closeoutReason(decision, hardBlockers, waitingCount),
      evidenceUrls,
    },
    followUpTaskCandidates: followUpsForDecision(decision, hardBlockers, waitingCount, receiptGaps),
    approvalSensitiveActionsExcluded: APPROVAL_SENSITIVE_ACTIONS_EXCLUDED,
    semantics: {
      terminalBriefCompletionIsCloseoutInput: true,
      providerAcceptedIsTerminalAck: false,
      providerAcceptedIsReadReceipt: false,
      providerAcceptedIsVisibilityProof: false,
      brokerFinalizerRequired: true,
    },
  };
}

export function renderTerminalBriefCompletionPacketMarkdown(packet: TerminalBriefCompletionPacket): string {
  const title = packet.decision === "ready_for_finalizer"
    ? "Ready: terminal-brief completion watcher"
    : packet.decision === "blocked"
      ? "Block: terminal-brief completion watcher"
      : "Wait: terminal-brief completion watcher";
  const finalCount = packet.summary.finalCount
    ? "Final count: " + packet.summary.finalCount.progress + "/" + packet.summary.finalCount.total + " reached=" + packet.summary.finalCount.reached
    : "Final count: unknown";
  return [
    title,
    "Mode: " + packet.mode,
    "Parent round: " + (packet.parentRoundId ?? "unknown"),
    "Workers: expected=" + packet.summary.expectedTotal + " observed=" + packet.summary.observedWorkers + " ready=" + packet.summary.ready + " blocked=" + packet.summary.blocked + " waiting=" + packet.summary.waiting + " needsEvidence=" + packet.summary.needsEvidence + " conflicts=" + packet.summary.conflicts,
    finalCount,
    "Receipt proof: confirmed=" + packet.summary.receiptConfirmed + " operatorVisible=" + packet.summary.operatorVisible + " providerOnly=" + packet.summary.providerOnly + " failedOrStale=" + packet.summary.receiptFailedOrStale,
    "Next step: " + packet.nextStep,
    "",
    "Lanes:",
    ...packet.lanes.map((lane) => {
      const progress = lane.parentRoundProgress && lane.parentRoundTotal ? " (" + lane.parentRoundProgress + "/" + lane.parentRoundTotal + ")" : "";
      const evidence = lane.evidenceUrl ?? "missing-evidence";
      return "- " + lane.worker + progress + " | " + (lane.status ?? "missing") + " | " + lane.state + " | " + evidence + " | receipt=" + (lane.receiptStatus ?? "missing") + " | next: " + lane.nextAction;
    }),
    "",
    "Closeout candidate:",
    "- status=" + packet.closeoutCandidate.status,
    "- reason=" + packet.closeoutCandidate.reason,
    ...(packet.missingEvidence.length ? ["", "Missing evidence:", ...packet.missingEvidence.map((item) => "- " + item)] : []),
    ...(packet.conflicts.length ? ["", "Conflicts:", ...packet.conflicts.map((item) => "- " + item)] : []),
    ...(packet.receiptGaps.length ? ["", "Receipt gaps:", ...packet.receiptGaps.map((item) => "- " + item)] : []),
    "",
    "Safety: read-only candidate only; provider accepted/message-id is not terminal ACK, read receipt, visibility proof, or operator approval.",
  ].join("\n");
}

function normalizeEvents(events: TerminalTaskOutboxEvent[], parentRoundId?: string): TerminalTaskOutboxEvent[] {
  return events
    .filter((event) => event.kind === "task.terminal")
    .filter((event) => TERMINAL_STATUSES.has(event.payload.status))
    .filter((event) => !parentRoundId || event.payload.parentRoundId === parentRoundId)
    .slice()
    .sort((a, b) => {
      const aTime = a.payload.completedAt ?? a.payload.updatedAt ?? a.createdAt;
      const bTime = b.payload.completedAt ?? b.payload.updatedAt ?? b.createdAt;
      return aTime.localeCompare(bTime) || a.id.localeCompare(b.id);
    });
}

function groupByWorker(events: TerminalTaskOutboxEvent[]): Map<string, TerminalTaskOutboxEvent[]> {
  const byWorker = new Map<string, TerminalTaskOutboxEvent[]>();
  for (const event of events) {
    const worker = event.payload.worker ?? event.payload.taskId;
    const bucket = byWorker.get(worker) ?? [];
    bucket.push(event);
    byWorker.set(worker, bucket);
  }
  return byWorker;
}

function deriveExpectedWorkers(
  input: TerminalBriefCompletionWatcherInput,
  byWorker: Map<string, TerminalTaskOutboxEvent[]>,
): string[] {
  const expected = (input.expectedWorkers ?? []).filter(Boolean);
  const observed = [...byWorker.keys()];
  return [...new Set([...expected, ...observed])].sort();
}

function deriveExpectedTotal(
  input: TerminalBriefCompletionWatcherInput,
  expectedWorkers: string[],
  events: TerminalTaskOutboxEvent[],
): number {
  const fromInput = positiveInteger(input.expectedTotal);
  if (fromInput !== undefined) return fromInput;
  const fromEvents = Math.max(0, ...events.map((event) => positiveInteger(event.payload.parentRoundTotal) ?? 0));
  if (fromEvents > 0) return fromEvents;
  return expectedWorkers.length;
}

function buildLane(worker: string, events: TerminalTaskOutboxEvent[]): TerminalBriefCompletionLane {
  if (events.length === 0) {
    return {
      worker,
      state: "waiting",
      receiptProof: "missing",
      receiptConfirmed: false,
      operatorVisible: false,
      providerOnly: false,
      blockers: ["no terminal event observed"],
      nextAction: "wait for worker Terminal Brief completion evidence",
    };
  }

  const latest = events[events.length - 1]!;
  const statusSet = new Set(events.map((event) => event.payload.status));
  const taskSet = new Set(events.map((event) => event.payload.taskId));
  const evidenceSet = new Set(events.map((event) => completionEvidenceUrl(event) ?? ""));
  const blockers: string[] = [];
  if (events.length > 1 && (statusSet.size > 1 || taskSet.size > 1 || evidenceSet.size > 1)) {
    blockers.push("conflicting duplicate Terminal Brief events for worker");
  }

  const evidenceUrl = completionEvidenceUrl(latest);
  const receiptProof = classifyReceiptProof(latest);
  const receiptConfirmed = latest.ack?.status === "receipt_confirmed";
  const operatorVisible = receiptProof === "receipt_confirmed" || receiptProof === "operator_visible";
  const providerOnly = receiptProof === "provider_only_not_ack";
  const status = latest.payload.status;
  if (status === "succeeded" && !evidenceUrl) blockers.push("succeeded lane has no PR or Done evidence URL");
  if (status !== "succeeded" && !evidenceUrl) blockers.push(status + " lane has no Block/Done/PR evidence URL");

  const state = blockers.some((blocker) => blocker.includes("conflicting"))
    ? "conflict"
    : status === "succeeded" && evidenceUrl
      ? "ready"
      : status === "succeeded"
        ? "needs_evidence"
        : "blocked";

  return {
    worker,
    taskId: latest.payload.taskId,
    status,
    state,
    evidenceUrl,
    receiptStatus: latest.receipt.status,
    receiptProof,
    receiptConfirmed,
    operatorVisible,
    providerOnly,
    parentRoundProgress: latest.payload.parentRoundProgress,
    parentRoundTotal: latest.payload.parentRoundTotal,
    completedAt: latest.payload.completedAt,
    blockers,
    nextAction: nextActionForLane(state, status),
  };
}

function completionEvidenceUrl(event: TerminalTaskOutboxEvent): string | undefined {
  const candidates = event.payload.status === "succeeded"
    ? [event.payload.prUrl, event.payload.doneUrl]
    : [event.payload.blockUrl, event.payload.doneUrl, event.payload.prUrl];
  return candidates.find((candidate) => typeof candidate === "string" && HTTPS_URL_RE.test(candidate));
}

function classifyReceiptProof(event: TerminalTaskOutboxEvent): TerminalBriefReceiptProofClass {
  if (event.ack?.status === "receipt_confirmed") return "receipt_confirmed";
  const status = event.receipt?.status;
  if (!status) return "missing";
  if (OPERATOR_VISIBLE_RECEIPT_STATUSES.has(status)) return "operator_visible";
  if (PROVIDER_ONLY_RECEIPT_STATUSES.has(status)) return "provider_only_not_ack";
  if (RECEIPT_FAILED_OR_STALE_STATUSES.has(status)) return "receipt_failed_or_stale";
  return "missing";
}

function deriveFinalCount(events: TerminalTaskOutboxEvent[], expectedTotal: number): TerminalBriefCompletionPacket["summary"]["finalCount"] {
  const candidates = events
    .map((event) => ({
      progress: positiveInteger(event.payload.parentRoundProgress),
      total: positiveInteger(event.payload.parentRoundTotal),
    }))
    .filter((candidate): candidate is { progress: number; total: number } => candidate.progress !== undefined && candidate.total !== undefined);
  if (candidates.length === 0 && expectedTotal > 0) {
    return { progress: events.filter((event) => event.payload.status === "succeeded").length, total: expectedTotal, reached: false };
  }
  if (candidates.length === 0) return undefined;
  const latest = candidates.sort((a, b) => a.progress - b.progress || a.total - b.total)[candidates.length - 1]!;
  return { ...latest, reached: latest.progress >= latest.total };
}

function nextStepForDecision(decision: TerminalBriefCompletionDecision): string {
  if (decision === "ready_for_finalizer") return "prepare broker-finalizer closeout candidate from structured evidence";
  if (decision === "blocked") return "collect missing evidence or resolve blocked/conflicting worker lanes before closeout";
  return "wait for remaining worker Terminal Brief completion events";
}

function nextActionForLane(state: TerminalBriefCompletionLaneState, status?: TerminalTaskStatus): string {
  if (state === "ready") return "include lane in broker finalizer closeout candidate";
  if (state === "needs_evidence") return "recover PR/Done evidence before closeout";
  if (state === "conflict") return "dedupe or reconcile conflicting Terminal Brief evidence";
  if (state === "blocked") return status === "blocked" ? "inspect Block evidence and decide follow-up" : "inspect terminal failure and decide retry/reassign";
  return "wait for worker completion evidence";
}

function closeoutReason(decision: TerminalBriefCompletionDecision, hardBlockers: string[], waitingCount: number): string {
  if (decision === "ready_for_finalizer") return "all expected worker lanes have terminal success evidence; broker finalizer still required";
  if (decision === "waiting") return String(waitingCount) + " worker lane(s) still waiting for terminal evidence";
  return String(hardBlockers.length) + " blocker(s): " + hardBlockers.slice(0, 3).join("; ") + (hardBlockers.length > 3 ? "; ..." : "");
}

function followUpsForDecision(decision: TerminalBriefCompletionDecision, hardBlockers: string[], waitingCount: number, receiptGaps: string[]): string[] {
  if (decision === "ready_for_finalizer") {
    const followUps = ["create broker finalizer review packet"];
    if (receiptGaps.length > 0) followUps.push("surface receipt gaps separately; do not ACK from provider-only evidence");
    return followUps;
  }
  if (decision === "waiting") return ["wait for " + waitingCount + " remaining worker completion event(s)"];
  return [
    "create missing/conflicting evidence recovery task",
    ...hardBlockers.slice(0, 5),
  ];
}

function positiveInteger(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function mostCommon(values: Array<string | undefined>): string | undefined {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
}
