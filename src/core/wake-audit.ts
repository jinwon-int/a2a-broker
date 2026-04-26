/**
 * Broker wake audit manager (issue #91 / Round 20).
 *
 * Manages the lifecycle of remote OpenClaw session wake/resume requests with:
 * - Cursor-based replay via CursorEventBuffer (same substrate as task/proposal events).
 * - Per-session idempotent state outside the replay buffer.
 * - Structured failure codes only — no free-form leakage.
 * - Duplicate wake suppression.
 * - Retention-safe: domain state survives event eviction.
 */

import { randomUUID } from "node:crypto";

import { CursorEventBuffer } from "./event-buffer.js";
import {
  type WakeEvent,
  type WakeEventKind,
  type WakeFailureCode,
  type WakeSessionState,
  type WakeStatus,
  WAKE_FAILURE_CODES,
  WAKE_TRANSITIONS,
} from "./wake-audit-types.js";

// ---------------------------------------------------------------------------
// Public options
// ---------------------------------------------------------------------------

export interface WakeAuditManagerOptions {
  maxEvents?: number;
  now?: () => Date;
  idFactory?: () => string;
}

export interface WakeRequestInput {
  sessionKey: string;
  peerNodeId: string;
  parentTaskId?: string;
  replayCursor?: number;
}

export interface WakeSubscribeOptions {
  afterId?: number;
  sessionKey?: string;
  peerNodeId?: string;
  parentTaskId?: string;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class WakeAuditError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "WakeAuditError";
  }
}

// ---------------------------------------------------------------------------
// Failure code resolution
// ---------------------------------------------------------------------------

const FAILURE_ALIASES: Record<string, WakeFailureCode> = {
  unreachable: "peer_unreachable",
  peer_unreachable: "peer_unreachable",
  expired: "session_expired",
  session_expired: "session_expired",
  auth: "auth_failed",
  auth_failed: "auth_failed",
  rate_limit: "rate_limited",
  rate_limited: "rate_limited",
  cursor_gap: "resume_cursor_gap",
  resume_cursor_gap: "resume_cursor_gap",
  runtime: "runtime_error",
  runtime_error: "runtime_error",
  timeout: "timeout",
  duplicate: "duplicate_wake",
  duplicate_wake: "duplicate_wake",
  other: "other",
};

const FAILURE_CODE_SET = new Set<string>(WAKE_FAILURE_CODES);

function resolveFailureCode(raw: string): WakeFailureCode {
  const resolved = FAILURE_ALIASES[raw];
  if (resolved && FAILURE_CODE_SET.has(resolved)) return resolved;
  if (FAILURE_CODE_SET.has(raw)) return raw as WakeFailureCode;
  return "other";
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class WakeAuditManager {
  private readonly sessions = new Map<string, WakeSessionState>();
  private readonly buffer: CursorEventBuffer<WakeEvent>;
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  constructor(options: WakeAuditManagerOptions = {}) {
    this.buffer = new CursorEventBuffer<WakeEvent>(
      options.maxEvents && options.maxEvents > 0 ? options.maxEvents : 500,
    );
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? (() => randomUUID());
  }

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  getSession(sessionKey: string): WakeSessionState | undefined {
    return this.sessions.get(sessionKey);
  }

  getSessionsForPeer(peerNodeId: string): WakeSessionState[] {
    return [...this.sessions.values()].filter(
      (s) => s.peerNodeId === peerNodeId,
    );
  }

  getSessionsForTask(parentTaskId: string): WakeSessionState[] {
    return [...this.sessions.values()].filter(
      (s) => s.parentTaskId === parentTaskId,
    );
  }

  // -------------------------------------------------------------------------
  // Wake lifecycle
  // -------------------------------------------------------------------------

  /**
   * Request a wake. If a session already exists and is in a non-terminal
   * active state, returns duplicate_suppressed instead of creating a new wake.
   */
  requestWake(input: WakeRequestInput): WakeSessionState {
    const existing = this.sessions.get(input.sessionKey);
    if (existing && isWakeActive(existing.status)) {
      const ts = this.now().toISOString();
      existing.status = "duplicate_suppressed";
      existing.updatedAt = ts;
      this.emitEvent(input.sessionKey, input.peerNodeId, input.parentTaskId, "wake_duplicate_suppressed", {
        dedupEventId: this.buffer["nextId"],
      });
      return existing;
    }

    // Allow retry from failed/unreachable
    const ts = this.now().toISOString();
    const state: WakeSessionState = {
      sessionKey: input.sessionKey,
      status: "requested",
      peerNodeId: input.peerNodeId,
      parentTaskId: input.parentTaskId,
      replayCursor: input.replayCursor,
      requestedAt: existing ? existing.requestedAt : ts,
      updatedAt: ts,
      wakeAttempts: existing ? existing.wakeAttempts + 1 : 1,
    };
    this.sessions.set(input.sessionKey, state);
    this.emitEvent(input.sessionKey, input.peerNodeId, input.parentTaskId, "wake_requested", {
      replayCursor: input.replayCursor,
    });
    return state;
  }

  acceptWake(sessionKey: string, runId?: string): WakeSessionState {
    return this.transition(sessionKey, "accepted", (s) => {
      s.acceptedAt = s.updatedAt;
      if (runId) s.runId = runId;
    });
  }

  resumeWake(sessionKey: string): WakeSessionState {
    return this.transition(sessionKey, "resumed", (s) => {
      s.startedAt = s.updatedAt;
    });
  }

  launchWake(sessionKey: string, runId?: string): WakeSessionState {
    const s = this.transition(sessionKey, "launched", (st) => {
      st.startedAt = st.updatedAt;
      if (runId) st.runId = runId;
    });
    this.emitEvent(sessionKey, s.peerNodeId, s.parentTaskId, "wake_launched");
    return s;
  }

  replyWake(sessionKey: string, durationMs?: number): WakeSessionState {
    return this.transition(sessionKey, "replied", (s) => {
      s.completedAt = s.updatedAt;
    }, { durationMs });
  }

  failWake(sessionKey: string, reason: string): WakeSessionState {
    return this.transition(sessionKey, "failed", (s) => {
      s.completedAt = s.updatedAt;
      s.failureCode = resolveFailureCode(reason);
    }, undefined, resolveFailureCode(reason));
  }

  markUnreachable(sessionKey: string): WakeSessionState {
    return this.transition(sessionKey, "unreachable", (s) => {
      s.completedAt = s.updatedAt;
      s.failureCode = "peer_unreachable";
    }, undefined, "peer_unreachable");
  }

  // -------------------------------------------------------------------------
  // Replay
  // -------------------------------------------------------------------------

  subscribe(options: WakeSubscribeOptions = {}): WakeEvent[] {
    return this.buffer.subscribe({
      afterId: options.afterId,
      limit: options.limit,
      matches: (e) => {
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

  private requireSession(sessionKey: string): WakeSessionState {
    const s = this.sessions.get(sessionKey);
    if (!s)
      throw new WakeAuditError(
        `Wake session not found: ${sessionKey}`,
        "NOT_FOUND",
      );
    return s;
  }

  private transition(
    sessionKey: string,
    target: WakeStatus,
    apply?: (s: WakeSessionState) => void,
    extraMeta?: Record<string, unknown>,
    failureCode?: WakeFailureCode,
  ): WakeSessionState {
    const session = this.requireSession(sessionKey);
    const allowed = WAKE_TRANSITIONS[session.status];
    if (!allowed.has(target)) {
      throw new WakeAuditError(
        `Cannot transition wake ${sessionKey} from ${session.status} to ${target}`,
        "INVALID_TRANSITION",
      );
    }
    const ts = this.now().toISOString();
    session.status = target;
    session.updatedAt = ts;
    apply?.(session);

    const kind = statusToEventKind(target);
    this.emitEvent(sessionKey, session.peerNodeId, session.parentTaskId, kind, {
      ...extraMeta,
      replayCursor: session.replayCursor,
      failureCode,
      runId: session.runId,
    });
    return session;
  }

  private emitEvent(
    sessionKey: string,
    peerNodeId: string,
    parentTaskId: string | undefined,
    kind: WakeEventKind,
    meta?: Record<string, unknown>,
  ): void {
    const id = this.buffer.allocateId();
    const metadata: WakeEvent["metadata"] = {};
    if (meta) {
      if (typeof meta.replayCursor === "number")
        metadata.replayCursor = meta.replayCursor;
      if (typeof meta.failureCode === "string")
        metadata.failureCode = meta.failureCode as WakeFailureCode;
      if (typeof meta.dedupEventId === "number")
        metadata.dedupEventId = meta.dedupEventId;
      if (typeof meta.durationMs === "number")
        metadata.durationMs = meta.durationMs;
    }
    this.buffer.push({
      id,
      timestamp: this.now().toISOString(),
      sessionKey,
      peerNodeId,
      runId: meta?.runId as string | undefined,
      parentTaskId,
      kind,
      metadata,
    });
  }
}

function statusToEventKind(status: WakeStatus): WakeEventKind {
  const map: Record<WakeStatus, WakeEventKind> = {
    requested: "wake_requested",
    accepted: "wake_accepted",
    resumed: "wake_resumed",
    launched: "wake_launched",
    replied: "wake_replied",
    failed: "wake_failed",
    unreachable: "wake_unreachable",
    duplicate_suppressed: "wake_duplicate_suppressed",
  };
  return map[status];
}

/** Active (non-terminal) wake states that trigger duplicate suppression. */
const ACTIVE_WAKE_STATUSES = new Set<WakeStatus>([
  "requested",
  "accepted",
  "resumed",
  "launched",
]);

function isWakeActive(status: WakeStatus): boolean {
  return ACTIVE_WAKE_STATUSES.has(status);
}
