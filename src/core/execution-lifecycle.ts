/**
 * Broker remote execution lifecycle manager (issue #96 / Round 21).
 *
 * Manages wake-to-work execution from session readiness through result
 * reporting, with lease/timeout semantics and result reconciliation.
 *
 * Key properties:
 * - Extends Round 20 wake audit model with execution-specific states.
 * - Per-run state machine: wake_requested → session_ready → payload_delivered → running → result_reported/failed/timeout.
 * - Duplicate payload suppression (once delivered, no re-delivery).
 * - Lease deadline tracking for timeout detection.
 * - Cursor-based replay via CursorEventBuffer.
 * - Structured result artifacts only — no raw prompt/session text.
 * - Aggregate closeout can distinguish completed, failed, timed out, waiting.
 */

import { randomUUID } from "node:crypto";

import { CursorEventBuffer } from "./event-buffer.js";
import {
  type ExecutionCloseoutKind,
  type ExecutionCloseoutSummary,
  type ExecutionEvent,
  type ExecutionEventKind,
  type ExecutionFailureCode,
  type ExecutionRunState,
  type ExecutionStatus,
  type ResultArtifact,
  type ResultOutcome,
  EXECUTION_FAILURE_CODES,
  EXECUTION_TRANSITIONS,
} from "./execution-lifecycle-types.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ExecutionManagerOptions {
  maxEvents?: number;
  now?: () => Date;
  idFactory?: () => string;
}

export interface ExecutionRequestInput {
  sessionKey: string;
  peerNodeId: string;
  parentTaskId?: string;
  wakeEventId?: number;
}

export interface PayloadDeliveryInput {
  runId: string;
  leaseDeadline?: string;
}

export interface ResultReportInput {
  runId: string;
  outcome: ResultOutcome;
  summary: string;
  artifactIds?: string[];
  errorCode?: ExecutionFailureCode;
}

export interface ExecutionSubscribeOptions {
  afterId?: number;
  runId?: string;
  sessionKey?: string;
  peerNodeId?: string;
  parentTaskId?: string;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ExecutionError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "ExecutionError";
  }
}

// ---------------------------------------------------------------------------
// Failure code resolution
// ---------------------------------------------------------------------------

const FAILURE_ALIASES: Record<string, ExecutionFailureCode> = {
  unreachable: "peer_unreachable",
  peer_unreachable: "peer_unreachable",
  expired: "session_expired",
  session_expired: "session_expired",
  payload_large: "payload_too_large",
  payload_too_large: "payload_too_large",
  delivery: "delivery_failed",
  delivery_failed: "delivery_failed",
  runtime: "runtime_error",
  runtime_error: "runtime_error",
  parse: "result_parse_error",
  result_parse_error: "result_parse_error",
  auth: "auth_failed",
  auth_failed: "auth_failed",
  rate_limit: "rate_limited",
  rate_limited: "rate_limited",
  lease: "lease_expired",
  lease_expired: "lease_expired",
  timeout: "execution_timeout",
  execution_timeout: "execution_timeout",
  cancelled: "cancelled_by_operator",
  cancelled_by_operator: "cancelled_by_operator",
  duplicate: "duplicate_payload_suppressed",
  duplicate_payload_suppressed: "duplicate_payload_suppressed",
  other: "other",
};

const FAILURE_CODE_SET = new Set<string>(EXECUTION_FAILURE_CODES);

function resolveFailureCode(raw: string): ExecutionFailureCode {
  const resolved = FAILURE_ALIASES[raw];
  if (resolved && FAILURE_CODE_SET.has(resolved)) return resolved;
  if (FAILURE_CODE_SET.has(raw)) return raw as ExecutionFailureCode;
  return "other";
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class ExecutionManager {
  private readonly runs = new Map<string, ExecutionRunState>();
  private readonly buffer: CursorEventBuffer<ExecutionEvent>;
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  constructor(options: ExecutionManagerOptions = {}) {
    this.buffer = new CursorEventBuffer<ExecutionEvent>(
      options.maxEvents && options.maxEvents > 0 ? options.maxEvents : 500,
    );
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? (() => randomUUID());
  }

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  getRun(runId: string): ExecutionRunState | undefined {
    return this.runs.get(runId);
  }

  getRunsForSession(sessionKey: string): ExecutionRunState[] {
    return [...this.runs.values()].filter(
      (r) => r.sessionKey === sessionKey,
    );
  }

  getRunsForTask(parentTaskId: string): ExecutionRunState[] {
    return [...this.runs.values()].filter(
      (r) => r.parentTaskId === parentTaskId,
    );
  }

  // -------------------------------------------------------------------------
  // Execution lifecycle
  // -------------------------------------------------------------------------

  /** Start a new execution run (wake phase). */
  requestExecution(input: ExecutionRequestInput): ExecutionRunState {
    const runId = this.idFactory();
    const ts = this.now().toISOString();
    const state: ExecutionRunState = {
      runId,
      sessionKey: input.sessionKey,
      peerNodeId: input.peerNodeId,
      parentTaskId: input.parentTaskId,
      status: "wake_requested",
      wakeEventId: input.wakeEventId,
      createdAt: ts,
      updatedAt: ts,
      attempts: 1,
      payloadDelivered: false,
    };
    this.runs.set(runId, state);
    this.emitEvent(runId, input.sessionKey, input.peerNodeId, input.parentTaskId, "exec_wake_requested", {
      wakeEventId: input.wakeEventId,
    });
    return state;
  }

  /** Session is ready to receive payload. */
  sessionReady(runId: string, leaseDeadline?: string): ExecutionRunState {
    return this.transition(runId, "session_ready", (s) => {
      s.leaseDeadline = leaseDeadline;
    }, { leaseDeadline });
  }

  /**
   * Deliver payload. Idempotent: if already delivered for this run,
   * returns current state without emitting duplicate event.
   */
  deliverPayload(input: PayloadDeliveryInput): ExecutionRunState {
    const run = this.requireRun(input.runId);
    if (run.payloadDelivered) return run;

    return this.transition(input.runId, "payload_delivered", (s) => {
      s.payloadDelivered = true;
      s.payloadDeliveredAt = s.updatedAt;
      if (input.leaseDeadline) s.leaseDeadline = input.leaseDeadline;
    });
  }

  /** Mark execution as actively running. */
  startRunning(runId: string): ExecutionRunState {
    return this.transition(runId, "running", (s) => {
      s.startedAt = s.updatedAt;
    });
  }

  /** Report successful (or partial/rejected) result. */
  reportResult(input: ResultReportInput): ExecutionRunState {
    const result: ResultArtifact = {
      outcome: input.outcome,
      summary: input.summary,
      artifactIds: input.artifactIds,
      errorCode: input.errorCode,
    };
    return this.transition(input.runId, "result_reported", (s) => {
      s.result = result;
      s.completedAt = s.updatedAt;
    }, { outcome: input.outcome });
  }

  /** Mark execution as failed with structured code. */
  failExecution(runId: string, reason: string): ExecutionRunState {
    return this.transition(runId, "failed", (s) => {
      s.failureCode = resolveFailureCode(reason);
      s.completedAt = s.updatedAt;
    }, undefined, resolveFailureCode(reason));
  }

  /** Mark execution as timed out. */
  timeoutExecution(runId: string): ExecutionRunState {
    return this.transition(runId, "timeout", (s) => {
      s.failureCode = "execution_timeout";
      s.completedAt = s.updatedAt;
    }, undefined, "execution_timeout");
  }

  /** Cancel execution. */
  cancelExecution(runId: string): ExecutionRunState {
    return this.transition(runId, "cancelled", (s) => {
      s.failureCode = "cancelled_by_operator";
      s.completedAt = s.updatedAt;
    }, undefined, "cancelled_by_operator");
  }

  /**
   * Retry a failed or timed-out execution. Creates a new run for the same
   * session, incrementing the attempt counter.
   */
  retryExecution(runId: string): ExecutionRunState {
    const existing = this.requireRun(runId);
    if (existing.status !== "failed" && existing.status !== "timeout") {
      throw new ExecutionError(
        `Cannot retry run ${runId} in status ${existing.status}`,
        "INVALID_RETRY",
      );
    }
    const ts = this.now().toISOString();
    const newRunId = this.idFactory();
    const state: ExecutionRunState = {
      runId: newRunId,
      sessionKey: existing.sessionKey,
      peerNodeId: existing.peerNodeId,
      parentTaskId: existing.parentTaskId,
      status: "wake_requested",
      wakeEventId: existing.wakeEventId,
      createdAt: ts,
      updatedAt: ts,
      attempts: existing.attempts + 1,
      payloadDelivered: false,
    };
    this.runs.set(newRunId, state);
    this.emitEvent(newRunId, state.sessionKey, state.peerNodeId, state.parentTaskId, "exec_wake_requested", {
      wakeEventId: state.wakeEventId,
    });
    return state;
  }

  // -------------------------------------------------------------------------
  // Closeout
  // -------------------------------------------------------------------------

  /** Generate closeout summary for a single run. */
  closeoutRun(runId: string): ExecutionCloseoutSummary | null {
    const run = this.runs.get(runId);
    if (!run) return null;
    return toCloseoutSummary(run);
  }

  /** Generate closeout summaries for all runs of a task. */
  closeoutTask(parentTaskId: string): ExecutionCloseoutSummary[] {
    return this.getRunsForTask(parentTaskId).map(toCloseoutSummary);
  }

  /** Generate closeout summaries for all runs of a session. */
  closeoutSession(sessionKey: string): ExecutionCloseoutSummary[] {
    return this.getRunsForSession(sessionKey).map(toCloseoutSummary);
  }

  // -------------------------------------------------------------------------
  // Lease management
  // -------------------------------------------------------------------------

  /**
   * Check if a run has exceeded its lease deadline.
   * Returns true if the run is active and past deadline.
   */
  isLeaseExpired(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run || !run.leaseDeadline) return false;
    const active = new Set<ExecutionStatus>([
      "session_ready", "payload_delivered", "running",
    ]);
    if (!active.has(run.status)) return false;
    return new Date(run.leaseDeadline) < this.now();
  }

  /**
   * Bulk check for expired leases. Returns run ids that need timeout handling.
   */
  findExpiredLeases(): string[] {
    return [...this.runs.values()]
      .filter((r) => this.isLeaseExpired(r.runId))
      .map((r) => r.runId);
  }

  // -------------------------------------------------------------------------
  // Replay
  // -------------------------------------------------------------------------

  subscribe(options: ExecutionSubscribeOptions = {}): ExecutionEvent[] {
    return this.buffer.subscribe({
      afterId: options.afterId,
      limit: options.limit,
      matches: (e) => {
        if (options.runId && e.runId !== options.runId) return false;
        if (options.sessionKey && e.sessionKey !== options.sessionKey)
          return false;
        if (options.peerNodeId && e.peerNodeId !== options.peerNodeId)
          return false;
        if (options.parentTaskId && e.parentTaskId !== options.parentTaskId)
          return false;
        return true;
      },
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private requireRun(runId: string): ExecutionRunState {
    const r = this.runs.get(runId);
    if (!r)
      throw new ExecutionError(`Execution run not found: ${runId}`, "NOT_FOUND");
    return r;
  }

  private transition(
    runId: string,
    target: ExecutionStatus,
    apply?: (s: ExecutionRunState) => void,
    extraMeta?: Record<string, unknown>,
    failureCode?: ExecutionFailureCode,
  ): ExecutionRunState {
    const run = this.requireRun(runId);
    const allowed = EXECUTION_TRANSITIONS[run.status];
    if (!allowed.has(target)) {
      throw new ExecutionError(
        `Cannot transition run ${runId} from ${run.status} to ${target}`,
        "INVALID_TRANSITION",
      );
    }
    const ts = this.now().toISOString();
    run.status = target;
    run.updatedAt = ts;
    apply?.(run);

    const kind = statusToEventKind(target);
    const metadata: ExecutionEvent["metadata"] = {};
    if (extraMeta?.leaseDeadline) metadata.leaseDeadline = extraMeta.leaseDeadline as string;
    if (extraMeta?.outcome) metadata.outcome = extraMeta.outcome as ResultOutcome;
    if (failureCode) metadata.failureCode = failureCode;

    // Compute execution duration if we have a terminal state
    if (run.payloadDeliveredAt && run.completedAt) {
      metadata.executionDurationMs =
        new Date(run.completedAt).getTime() - new Date(run.payloadDeliveredAt).getTime();
    }

    this.emitEvent(runId, run.sessionKey, run.peerNodeId, run.parentTaskId, kind, metadata);
    return run;
  }

  private emitEvent(
    runId: string,
    sessionKey: string,
    peerNodeId: string,
    parentTaskId: string | undefined,
    kind: ExecutionEventKind,
    metadata: ExecutionEvent["metadata"],
  ): void {
    const id = this.buffer.allocateId();
    this.buffer.push({
      id,
      timestamp: this.now().toISOString(),
      runId,
      sessionKey,
      peerNodeId,
      parentTaskId,
      kind,
      metadata,
    });
  }
}

function statusToEventKind(status: ExecutionStatus): ExecutionEventKind {
  const map: Record<ExecutionStatus, ExecutionEventKind> = {
    wake_requested: "exec_wake_requested",
    session_ready: "exec_session_ready",
    payload_delivered: "exec_payload_delivered",
    running: "exec_running",
    result_reported: "exec_result_reported",
    failed: "exec_failed",
    timeout: "exec_timeout",
    cancelled: "exec_cancelled",
  };
  return map[status];
}

function toCloseoutSummary(run: ExecutionRunState): ExecutionCloseoutSummary {
  let kind: ExecutionCloseoutKind;
  switch (run.status) {
    case "result_reported": kind = "completed"; break;
    case "failed": kind = "failed"; break;
    case "timeout": kind = "timed_out"; break;
    case "cancelled": kind = "cancelled"; break;
    default: kind = "waiting";
  }
  return {
    runId: run.runId,
    sessionKey: run.sessionKey,
    peerNodeId: run.peerNodeId,
    kind,
    attempts: run.attempts,
    result: run.result,
    failureCode: run.failureCode,
    updatedAt: run.updatedAt,
  };
}
