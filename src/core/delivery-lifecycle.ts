/**
 * Broker status/result delivery lifecycle manager (Round 22 / issue #101).
 *
 * Manages the post-execution delivery path: once ExecutionManager reports
 * a result, DeliveryManager takes over to ensure the originator receives it.
 *
 * Key properties:
 * - Separate from execution lifecycle: execution tracks "work done",
 *   delivery tracks "result received".
 * - Per-delivery state machine with retry/backoff and ACK tracking.
 * - Duplicate delivery suppression per runId.
 * - Delivery and ACK deadlines with timeout detection.
 * - Cursor-based replay via CursorEventBuffer.
 * - Owner-scoped, redacted artifacts only.
 */

import { randomUUID } from "node:crypto";

import { CursorEventBuffer } from "./event-buffer.js";
import {
  type DeliveryArtifact,
  type DeliveryCloseoutKind,
  type DeliveryCloseoutSummary,
  type DeliveryEvent,
  type DeliveryEventKind,
  type DeliveryFailureCode,
  type DeliveryState,
  type DeliveryStatus,
  DELIVERY_FAILURE_CODES,
  DELIVERY_TRANSITIONS,
} from "./delivery-lifecycle-types.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface DeliveryManagerOptions {
  maxEvents?: number;
  defaultMaxRetries?: number;
  now?: () => Date;
  idFactory?: () => string;
}

export interface RegisterDeliveryInput {
  runId: string;
  originatorSessionKey: string;
  originatorNodeId: string;
  parentTaskId?: string;
  artifact: DeliveryArtifact;
  deliveryDeadline?: string;
  ackDeadline?: string;
  channel?: string;
  maxRetries?: number;
}

export interface DeliverInput {
  deliveryId: string;
  channel?: string;
}

export interface AckInput {
  deliveryId: string;
}

export interface DeliverySubscribeOptions {
  afterId?: number;
  deliveryId?: string;
  runId?: string;
  originatorSessionKey?: string;
  originatorNodeId?: string;
  parentTaskId?: string;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class DeliveryError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "DeliveryError";
  }
}

// ---------------------------------------------------------------------------
// Failure code resolution
// ---------------------------------------------------------------------------

const FAILURE_ALIASES: Record<string, DeliveryFailureCode> = {
  unreachable: "originator_unreachable",
  originator_unreachable: "originator_unreachable",
  channel_unavailable: "channel_unavailable",
  payload_large: "payload_too_large",
  payload_too_large: "payload_too_large",
  delivery_timeout: "delivery_timeout",
  ack_timeout: "ack_timeout",
  rate_limit: "rate_limited",
  rate_limited: "rate_limited",
  auth: "auth_failed",
  auth_failed: "auth_failed",
  duplicate: "duplicate_delivery_suppressed",
  duplicate_delivery_suppressed: "duplicate_delivery_suppressed",
  max_retries: "max_retries_exceeded",
  max_retries_exceeded: "max_retries_exceeded",
  serialization: "serialization_error",
  serialization_error: "serialization_error",
  other: "other",
};

const FAILURE_CODE_SET = new Set<string>(DELIVERY_FAILURE_CODES);

function resolveFailureCode(raw: string): DeliveryFailureCode {
  const resolved = FAILURE_ALIASES[raw];
  if (resolved && FAILURE_CODE_SET.has(resolved)) return resolved;
  if (FAILURE_CODE_SET.has(raw)) return raw as DeliveryFailureCode;
  return "other";
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class DeliveryManager {
  private readonly deliveries = new Map<string, DeliveryState>();
  private readonly runIndex = new Map<string, string>(); // runId → deliveryId
  private readonly buffer: CursorEventBuffer<DeliveryEvent>;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly defaultMaxRetries: number;

  constructor(options: DeliveryManagerOptions = {}) {
    this.buffer = new CursorEventBuffer<DeliveryEvent>(
      options.maxEvents && options.maxEvents > 0 ? options.maxEvents : 500,
    );
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? (() => randomUUID());
    this.defaultMaxRetries = options.defaultMaxRetries ?? 3;
  }

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  getDelivery(deliveryId: string): DeliveryState | undefined {
    return this.deliveries.get(deliveryId);
  }

  getDeliveryByRunId(runId: string): DeliveryState | undefined {
    const deliveryId = this.runIndex.get(runId);
    return deliveryId ? this.deliveries.get(deliveryId) : undefined;
  }

  getDeliveriesForSession(originatorSessionKey: string): DeliveryState[] {
    return [...this.deliveries.values()].filter(
      (d) => d.originatorSessionKey === originatorSessionKey,
    );
  }

  getDeliveriesForTask(parentTaskId: string): DeliveryState[] {
    return [...this.deliveries.values()].filter(
      (d) => d.parentTaskId === parentTaskId,
    );
  }

  // -------------------------------------------------------------------------
  // Delivery lifecycle
  // -------------------------------------------------------------------------

  /**
   * Register a new delivery for an execution result.
   * Duplicate suppression: if a delivery already exists for this runId,
   * returns the existing delivery without creating a new one.
   */
  registerDelivery(input: RegisterDeliveryInput): DeliveryState {
    // Duplicate suppression
    const existingId = this.runIndex.get(input.runId);
    if (existingId) {
      const existing = this.deliveries.get(existingId)!;
      existing.duplicateSuppressed = true;
      return existing;
    }

    const deliveryId = this.idFactory();
    const ts = this.now().toISOString();
    const maxRetries = input.maxRetries ?? this.defaultMaxRetries;
    const state: DeliveryState = {
      deliveryId,
      runId: input.runId,
      originatorSessionKey: input.originatorSessionKey,
      originatorNodeId: input.originatorNodeId,
      parentTaskId: input.parentTaskId,
      status: "result_ready",
      artifact: input.artifact,
      attempt: 1,
      maxRetries,
      deliveryDeadline: input.deliveryDeadline,
      channel: input.channel,
      acknowledged: false,
      duplicateSuppressed: false,
      createdAt: ts,
      updatedAt: ts,
    };
    this.deliveries.set(deliveryId, state);
    this.runIndex.set(input.runId, deliveryId);
    this.emitEvent(state, "del_result_ready", { attempt: 1, maxRetries });
    return state;
  }

  /** Queue delivery for sending. */
  queueDelivery(deliveryId: string): DeliveryState {
    return this.transition(deliveryId, "delivery_pending");
  }

  /** Mark delivery as actively being sent. */
  startDelivery(input: DeliverInput): DeliveryState {
    const state = this.transition(input.deliveryId, "delivering", (s) => {
      s.deliveryStartedAt = s.updatedAt;
      if (input.channel) s.channel = input.channel;
    });
    return state;
  }

  /** Mark delivery as successfully sent to originator. */
  markDelivered(deliveryId: string, ackDeadline?: string): DeliveryState {
    return this.transition(deliveryId, "delivered", (s) => {
      s.deliveredAt = s.updatedAt;
      if (ackDeadline) s.ackDeadline = ackDeadline;
    });
  }

  /** Acknowledge delivery — originator confirmed receipt. */
  acknowledgeDelivery(input: AckInput): DeliveryState {
    return this.transition(input.deliveryId, "acked", (s) => {
      s.acknowledged = true;
      s.ackedAt = s.updatedAt;
      s.completedAt = s.updatedAt;
    });
  }

  /** Mark delivery attempt as failed. */
  failDelivery(deliveryId: string, reason: string): DeliveryState {
    return this.transition(deliveryId, "failed", undefined, undefined, resolveFailureCode(reason));
  }

  /** Retry a failed delivery. Increments attempt counter. */
  retryDelivery(deliveryId: string): DeliveryState {
    const existing = this.requireDelivery(deliveryId);
    if (existing.status !== "failed" && existing.status !== "timed_out") {
      throw new DeliveryError(
        `Cannot retry delivery ${deliveryId} in status ${existing.status}`,
        "INVALID_RETRY",
      );
    }
    // Check max retries BEFORE incrementing: if next attempt would exceed, auto-timeout
    const nextAttempt = existing.attempt + 1;
    if (nextAttempt > existing.maxRetries) {
      return this.transition(deliveryId, "timed_out", (s) => {
        s.attempt = nextAttempt;
      }, undefined, "max_retries_exceeded");
    }
    return this.transition(deliveryId, "retrying", (s) => {
      s.attempt = nextAttempt;
      s.failureCode = undefined;
    });
  }

  /** Mark delivery as timed out. */
  timeoutDelivery(deliveryId: string, reason?: string): DeliveryState {
    return this.transition(deliveryId, "timed_out", (s) => {
      s.completedAt = s.updatedAt;
    }, undefined, resolveFailureCode(reason ?? "delivery_timeout"));
  }

  // -------------------------------------------------------------------------
  // Deadline management
  // -------------------------------------------------------------------------

  /** Find deliveries past their delivery deadline (still pending/delivering). */
  findDeliveryTimeouts(): string[] {
    return [...this.deliveries.values()]
      .filter((d) => {
        if (!d.deliveryDeadline) return false;
        if (d.status !== "delivery_pending" && d.status !== "delivering") return false;
        return new Date(d.deliveryDeadline) < this.now();
      })
      .map((d) => d.deliveryId);
  }

  /** Find deliveries past their ACK deadline (delivered but not acked). */
  findAckTimeouts(): string[] {
    return [...this.deliveries.values()]
      .filter((d) => {
        if (!d.ackDeadline) return false;
        if (d.status !== "delivered") return false;
        return new Date(d.ackDeadline) < this.now();
      })
      .map((d) => d.deliveryId);
  }

  // -------------------------------------------------------------------------
  // Closeout
  // -------------------------------------------------------------------------

  closeoutDelivery(deliveryId: string): DeliveryCloseoutSummary | null {
    const d = this.deliveries.get(deliveryId);
    if (!d) return null;
    return toCloseoutSummary(d);
  }

  closeoutTask(parentTaskId: string): DeliveryCloseoutSummary[] {
    return this.getDeliveriesForTask(parentTaskId).map(toCloseoutSummary);
  }

  closeoutSession(originatorSessionKey: string): DeliveryCloseoutSummary[] {
    return this.getDeliveriesForSession(originatorSessionKey).map(toCloseoutSummary);
  }

  // -------------------------------------------------------------------------
  // Replay
  // -------------------------------------------------------------------------

  subscribe(options: DeliverySubscribeOptions = {}): DeliveryEvent[] {
    return this.buffer.subscribe({
      afterId: options.afterId,
      limit: options.limit,
      matches: (e) => {
        if (options.deliveryId && e.deliveryId !== options.deliveryId) return false;
        if (options.runId && e.runId !== options.runId) return false;
        if (options.originatorSessionKey && e.originatorSessionKey !== options.originatorSessionKey)
          return false;
        if (options.originatorNodeId && e.originatorNodeId !== options.originatorNodeId)
          return false;
        if (options.parentTaskId && e.parentTaskId !== options.parentTaskId) return false;
        return true;
      },
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private requireDelivery(deliveryId: string): DeliveryState {
    const d = this.deliveries.get(deliveryId);
    if (!d)
      throw new DeliveryError(`Delivery not found: ${deliveryId}`, "NOT_FOUND");
    return d;
  }

  private transition(
    deliveryId: string,
    target: DeliveryStatus,
    apply?: (s: DeliveryState) => void,
    extraMeta?: Record<string, unknown>,
    failureCode?: DeliveryFailureCode,
  ): DeliveryState {
    const state = this.requireDelivery(deliveryId);
    const allowed = DELIVERY_TRANSITIONS[state.status];
    if (!allowed.has(target)) {
      throw new DeliveryError(
        `Cannot transition delivery ${deliveryId} from ${state.status} to ${target}`,
        "INVALID_TRANSITION",
      );
    }
    const ts = this.now().toISOString();
    state.status = target;
    state.updatedAt = ts;
    if (failureCode) state.failureCode = failureCode;
    apply?.(state);

    const kind = statusToEventKind(target);
    const metadata: DeliveryEvent["metadata"] = {
      attempt: state.attempt,
      maxRetries: state.maxRetries,
    };
    if (failureCode) metadata.failureCode = failureCode;
    if (state.deliveryDeadline) metadata.deliveryDeadline = state.deliveryDeadline;
    if (state.ackDeadline) metadata.ackDeadline = state.ackDeadline;
    if (state.channel) metadata.channel = state.channel;

    // Delivery duration
    if (state.deliveryStartedAt && (state.deliveredAt || state.status === "failed" || state.status === "timed_out")) {
      const end = state.deliveredAt ?? ts;
      metadata.deliveryDurationMs =
        new Date(end).getTime() - new Date(state.deliveryStartedAt).getTime();
    }

    // ACK duration
    if (state.deliveredAt && state.ackedAt) {
      metadata.ackDurationMs =
        new Date(state.ackedAt).getTime() - new Date(state.deliveredAt).getTime();
    }

    this.emitEvent(state, kind, metadata);
    return state;
  }

  private emitEvent(
    state: DeliveryState,
    kind: DeliveryEventKind,
    metadata: DeliveryEvent["metadata"],
  ): void {
    const id = this.buffer.allocateId();
    this.buffer.push({
      id,
      timestamp: this.now().toISOString(),
      deliveryId: state.deliveryId,
      runId: state.runId,
      originatorSessionKey: state.originatorSessionKey,
      originatorNodeId: state.originatorNodeId,
      parentTaskId: state.parentTaskId,
      kind,
      metadata,
    });
  }
}

function statusToEventKind(status: DeliveryStatus): DeliveryEventKind {
  const map: Record<DeliveryStatus, DeliveryEventKind> = {
    result_ready: "del_result_ready",
    delivery_pending: "del_pending",
    delivering: "del_delivering",
    delivered: "del_delivered",
    acked: "del_acked",
    failed: "del_failed",
    retrying: "del_retrying",
    timed_out: "del_timed_out",
  };
  return map[status];
}

function toCloseoutSummary(d: DeliveryState): DeliveryCloseoutSummary {
  let kind: DeliveryCloseoutKind;
  switch (d.status) {
    case "acked": kind = "acked"; break;
    case "delivered": kind = "delivered_unacked"; break;
    case "timed_out":
      kind = d.attempt > d.maxRetries ? "max_retries_exceeded" : "timed_out";
      break;
    case "failed": kind = "failed"; break;
    default: kind = "pending";
  }
  if (d.duplicateSuppressed && d.status === "result_ready") kind = "duplicate_suppressed";
  return {
    deliveryId: d.deliveryId,
    runId: d.runId,
    originatorSessionKey: d.originatorSessionKey,
    originatorNodeId: d.originatorNodeId,
    kind,
    attempts: d.attempt,
    artifact: d.artifact,
    failureCode: d.failureCode,
    channel: d.channel,
    updatedAt: d.updatedAt,
  };
}
