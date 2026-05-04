import type { TerminalTaskOutboxEvent, TerminalTaskEventPayload } from "../core/terminal-event-outbox.js";

/**
 * Round closeout reconciliation helpers (issue #243).
 *
 * Pure operator-facing classifier for A2A hardening rounds. It reconciles the
 * expected worker roster against latest task observations and separates normal
 * waiting from stale work, terminal results missing GitHub evidence, and real
 * blocked closeout states.
 */

export type RoundWorkerStatus = "queued" | "claimed" | "running" | "succeeded" | "failed" | "canceled" | "blocked";
export type RoundWorkerState = "completed" | "blocked" | "missing-evidence" | "stuck" | "waiting" | "excluded";
export type RoundCloseoutState = "ready" | "blocked" | "needs-evidence" | "stuck" | "waiting";

export interface RoundEvidence {
  prUrl?: string;
  doneCommentUrl?: string;
  blockCommentUrl?: string;
  branchUrl?: string;
}

export interface RoundWorkerObservation {
  workerId: string;
  status: RoundWorkerStatus;
  updatedAt: string;
  taskId?: string;
  run?: string;
  traceId?: string;
  issueNumber?: number;
  taskDescription?: string;
  summary?: string;
  evidence?: RoundEvidence;
}

export interface RoundCloseoutOptions {
  expectedWorkers: string[];
  excludedWorkers?: string[];
  /** Optional operator label for the round, e.g. `a2a-hardening-r1`. */
  roundLabel?: string;
  /** Optional task id prefix used to select this round's observations. */
  taskIdPrefix?: string;
  /** Optional GitHub issue allow-list used to select this round's observations. */
  issueNumbers?: number[];
  nowMs?: number;
  staleAfterMs?: number;
}

export interface RoundWorkerReconciliation {
  workerId: string;
  required: boolean;
  state: RoundWorkerState;
  status?: RoundWorkerStatus;
  taskId?: string;
  run?: string;
  traceId?: string;
  issueNumber?: number;
  taskDescription?: string;
  ageMs?: number;
  evidenceUrl?: string;
  reason: string;
  action: string;
}

export type RoundWorkerSummaryStatus = "completed" | "blocked" | "failed" | "pending";

export interface RoundWorkerSummary {
  workerId: string;
  status: RoundWorkerSummaryStatus;
  taskId?: string;
  taskDescription?: string;
  evidenceUrl?: string;
}

export interface RoundCloseoutReconciliation {
  state: RoundCloseoutState;
  generatedAt: string;
  staleAfterMs: number;
  roundLabel?: string;
  taskIdPrefix?: string;
  issueNumbers?: number[];
  counts: {
    required: number;
    completed: number;
    blocked: number;
    missingEvidence: number;
    stuck: number;
    waiting: number;
    excluded: number;
  };
  summary: string;
  action: string;
  /** Compact operator closeout lines, one per required worker. */
  workerSummaries: RoundWorkerSummary[];
  workers: RoundWorkerReconciliation[];
}

const DEFAULT_STALE_AFTER_MS = 30 * 60 * 1000;
const TERMINAL_STATUSES = new Set<RoundWorkerStatus>(["succeeded", "failed", "canceled", "blocked"]);

/**
 * Build a deterministic closeout view for one A2A round.
 *
 * Observations can be scoped by `taskIdPrefix` and/or `issueNumbers`, letting
 * operators ask for one round label/task prefix/issue set without dumping raw
 * worker logs. When both filters are present, an observation may match either.
 *
 * Precedence for each required worker:
 *   1. Missing observation/non-terminal fresh work → waiting
 *   2. Non-terminal stale work → stuck
 *   3. Terminal work without PR/Done/Block evidence → missing-evidence
 *   4. Failed/canceled terminal work with evidence → blocked
 *   5. Succeeded terminal work with evidence → completed
 */
export function reconcileRoundCloseout(
  observations: RoundWorkerObservation[],
  options: RoundCloseoutOptions,
): RoundCloseoutReconciliation {
  const nowMs = options.nowMs ?? Date.now();
  const staleAfterMs = Math.max(1, options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS);
  const excluded = new Set(options.excludedWorkers ?? []);
  const requiredWorkers = [...new Set(options.expectedWorkers)].filter((workerId) => !excluded.has(workerId));
  const scopedObservations = filterRoundObservations(observations, options);
  const latestByWorker = latestObservationsByWorker(scopedObservations);

  const workers: RoundWorkerReconciliation[] = [
    ...requiredWorkers.map((workerId) => classifyWorker(workerId, latestByWorker.get(workerId), { nowMs, staleAfterMs })),
    ...[...excluded].sort().map((workerId) => classifyExcludedWorker(workerId, latestByWorker.get(workerId), nowMs)),
  ];

  const required = workers.filter((worker) => worker.required);
  const counts = {
    required: required.length,
    completed: required.filter((worker) => worker.state === "completed").length,
    blocked: required.filter((worker) => worker.state === "blocked").length,
    missingEvidence: required.filter((worker) => worker.state === "missing-evidence").length,
    stuck: required.filter((worker) => worker.state === "stuck").length,
    waiting: required.filter((worker) => worker.state === "waiting").length,
    excluded: workers.filter((worker) => worker.state === "excluded").length,
  };

  const state = classifyRoundState(counts);
  const { summary, action } = roundMessage(state, counts);
  const workerSummaries = required.map(buildWorkerSummary);

  return {
    state,
    generatedAt: new Date(nowMs).toISOString(),
    staleAfterMs,
    roundLabel: options.roundLabel,
    taskIdPrefix: options.taskIdPrefix,
    issueNumbers: options.issueNumbers ? [...new Set(options.issueNumbers)].sort((a, b) => a - b) : undefined,
    counts,
    summary,
    action,
    workerSummaries,
    workers,
  };
}

export interface TerminalRoundCloseoutOptions extends RoundCloseoutOptions {
  /** Match terminal events for a specific payload.run/round id. */
  run?: string;
  /** Match terminal events for a specific A2A trace id. */
  traceId?: string;
  /** Match terminal events for a specific GitHub repo, usually with issueNumbers. */
  repo?: string;
}

export function reconcileRoundCloseoutFromTerminalOutbox(
  events: TerminalTaskOutboxEvent[],
  options: TerminalRoundCloseoutOptions,
): RoundCloseoutReconciliation {
  return reconcileRoundCloseout(
    events
      .map((event) => event.payload)
      .filter((payload) => terminalPayloadMatchesRound(payload, options))
      .map(terminalPayloadToObservation),
    options,
  );
}

export function terminalRoundKey(payload: TerminalTaskEventPayload): string {
  if (payload.run) return `run:${payload.run}`;
  if (payload.traceId) return `trace:${payload.traceId}`;
  if (payload.repo && payload.issue !== undefined) return `issue:${payload.repo}#${payload.issue}`;
  return `task:${payload.taskId}`;
}

function terminalPayloadMatchesRound(payload: TerminalTaskEventPayload, options: TerminalRoundCloseoutOptions): boolean {
  if (options.run && payload.run !== options.run) return false;
  if (options.traceId && payload.traceId !== options.traceId) return false;
  if (options.repo && payload.repo !== options.repo) return false;
  if (options.issueNumbers?.length && (payload.issue === undefined || !options.issueNumbers.includes(payload.issue))) return false;
  return true;
}

function terminalPayloadToObservation(payload: TerminalTaskEventPayload): RoundWorkerObservation {
  return {
    workerId: payload.worker ?? payload.taskId,
    status: payload.status,
    updatedAt: payload.completedAt ?? payload.updatedAt,
    taskId: payload.taskId,
    run: payload.run,
    traceId: payload.traceId,
    issueNumber: payload.issue,
    taskDescription: payload.taskDescription,
    summary: payload.testSummary,
    evidence: {
      prUrl: payload.prUrl,
      doneCommentUrl: payload.doneUrl,
      blockCommentUrl: payload.blockUrl,
    },
  };
}

function filterRoundObservations(
  observations: RoundWorkerObservation[],
  options: RoundCloseoutOptions,
): RoundWorkerObservation[] {
  const issueNumbers = new Set(options.issueNumbers ?? []);
  const hasTaskPrefix = Boolean(options.taskIdPrefix);
  const hasIssueFilter = issueNumbers.size > 0;
  if (!hasTaskPrefix && !hasIssueFilter) return observations;

  return observations.filter((observation) => {
    const taskMatches = hasTaskPrefix && Boolean(observation.taskId?.startsWith(options.taskIdPrefix!));
    const issueMatches = hasIssueFilter && observation.issueNumber !== undefined && issueNumbers.has(observation.issueNumber);
    return taskMatches || issueMatches;
  });
}

function latestObservationsByWorker(observations: RoundWorkerObservation[]): Map<string, RoundWorkerObservation> {
  const latest = new Map<string, RoundWorkerObservation>();
  for (const observation of observations) {
    const current = latest.get(observation.workerId);
    if (!current || Date.parse(observation.updatedAt) >= Date.parse(current.updatedAt)) {
      latest.set(observation.workerId, observation);
    }
  }
  return latest;
}

function classifyWorker(
  workerId: string,
  observation: RoundWorkerObservation | undefined,
  options: { nowMs: number; staleAfterMs: number },
): RoundWorkerReconciliation {
  if (!observation) {
    return {
      workerId,
      required: true,
      state: "waiting",
      reason: "No task observation found for required worker.",
      action: "Dispatch or verify assignment before closing the round.",
    };
  }

  const ageMs = Math.max(0, options.nowMs - Date.parse(observation.updatedAt));
  const evidenceUrl = pickEvidenceUrl(observation.evidence);

  if (!TERMINAL_STATUSES.has(observation.status)) {
    if (ageMs >= options.staleAfterMs) {
      return {
        ...baseWorker(workerId, observation, ageMs, evidenceUrl),
        required: true,
        state: "stuck",
        reason: `${observation.status} task has not updated within the stale threshold.`,
        action: "Ask for progress evidence or requeue/reassign this worker before closeout.",
      };
    }
    return {
      ...baseWorker(workerId, observation, ageMs, evidenceUrl),
      required: true,
      state: "waiting",
      reason: `${observation.status} task is still active.`,
      action: "Wait for terminal PR/Done/Block evidence.",
    };
  }

  if (!evidenceUrl) {
    return {
      ...baseWorker(workerId, observation, ageMs, evidenceUrl),
      required: true,
      state: "missing-evidence",
      reason: `${observation.status} task is terminal but has no PR, Done, Block, or branch evidence URL.`,
      action: "Recover or post evidence before marking the round closed.",
    };
  }

  if (observation.status === "succeeded") {
    return {
      ...baseWorker(workerId, observation, ageMs, evidenceUrl),
      required: true,
      state: "completed",
      reason: "Succeeded with closeout evidence.",
      action: "No action required.",
    };
  }

  return {
    ...baseWorker(workerId, observation, ageMs, evidenceUrl),
    required: true,
    state: "blocked",
    reason: `${observation.status} with operator evidence.`,
    action: "Inspect Block/PR evidence and decide whether to retry, split, or defer.",
  };
}

function classifyExcludedWorker(
  workerId: string,
  observation: RoundWorkerObservation | undefined,
  nowMs: number,
): RoundWorkerReconciliation {
  return {
    ...baseWorker(workerId, observation, observation ? Math.max(0, nowMs - Date.parse(observation.updatedAt)) : undefined, observation ? pickEvidenceUrl(observation.evidence) : undefined),
    workerId,
    required: false,
    state: "excluded",
    reason: "Worker is excluded from this round closeout.",
    action: "Do not dispatch or wait on this worker for this round.",
  };
}

function baseWorker(
  workerId: string,
  observation?: RoundWorkerObservation,
  ageMs?: number,
  evidenceUrl?: string,
): Pick<RoundWorkerReconciliation, "workerId" | "status" | "taskId" | "run" | "traceId" | "issueNumber" | "taskDescription" | "ageMs" | "evidenceUrl"> {
  return {
    workerId,
    status: observation?.status,
    taskId: observation?.taskId,
    run: observation?.run,
    traceId: observation?.traceId,
    issueNumber: observation?.issueNumber,
    taskDescription: observation?.taskDescription,
    ageMs,
    evidenceUrl,
  };
}

function buildWorkerSummary(worker: RoundWorkerReconciliation): RoundWorkerSummary {
  return {
    workerId: worker.workerId,
    status: summarizeWorkerStatus(worker),
    taskId: worker.taskId,
    taskDescription: worker.taskDescription,
    evidenceUrl: worker.evidenceUrl,
  };
}

function summarizeWorkerStatus(worker: RoundWorkerReconciliation): RoundWorkerSummaryStatus {
  if (worker.status === "failed" || worker.status === "canceled") return "failed";
  if (worker.status === "blocked" || worker.state === "blocked") return "blocked";
  if (worker.state === "completed") return "completed";
  return "pending";
}

function pickEvidenceUrl(evidence?: RoundEvidence): string | undefined {
  return evidence?.prUrl ?? evidence?.doneCommentUrl ?? evidence?.blockCommentUrl ?? evidence?.branchUrl;
}

function classifyRoundState(counts: RoundCloseoutReconciliation["counts"]): RoundCloseoutState {
  if (counts.missingEvidence > 0) return "needs-evidence";
  if (counts.stuck > 0) return "stuck";
  if (counts.blocked > 0) return "blocked";
  if (counts.waiting > 0 || counts.required === 0) return "waiting";
  return "ready";
}

function roundMessage(
  state: RoundCloseoutState,
  counts: RoundCloseoutReconciliation["counts"],
): Pick<RoundCloseoutReconciliation, "summary" | "action"> {
  switch (state) {
    case "ready":
      return {
        summary: `READY — all ${counts.required} required workers completed with evidence.`,
        action: "Post round Done/closeout evidence and proceed to the next hardening round.",
      };
    case "needs-evidence":
      return {
        summary: `NEEDS EVIDENCE — ${counts.missingEvidence} terminal worker(s) lack PR/Done/Block evidence.`,
        action: "Recover or post missing evidence before closing the round; do not rerun blindly.",
      };
    case "stuck":
      return {
        summary: `STUCK — ${counts.stuck} worker(s) exceeded the stale threshold without terminal evidence.`,
        action: "Request progress, then requeue or reassign stale workers if no evidence arrives.",
      };
    case "blocked":
      return {
        summary: `BLOCKED — ${counts.blocked} worker(s) ended failed/canceled with evidence.`,
        action: "Inspect blocker evidence and decide retry, split, or defer before closeout.",
      };
    case "waiting":
      return {
        summary: `WAITING — ${counts.waiting} of ${counts.required} required worker(s) are not terminal yet.`,
        action: "Wait for active workers or dispatch missing assignments.",
      };
  }
}
