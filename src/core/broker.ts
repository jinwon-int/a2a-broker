import { randomUUID } from "node:crypto";

import {
  assertProposalApplyAllowed,
  assertProposalCreationAllowed,
  assertProposalReviewAllowed,
  assertValidationSubmissionAllowed,
  isPrivilegedTaskApprover,
  normalizeTaskPolicyContext,
  PolicyError,
} from "./policy.js";
import {
  CURRENT_BROKER_STATE_VERSION,
  type BrokerSnapshot,
  type BrokerStateSaveHints,
  type BrokerStateStore,
} from "./store.js";
import { TaskEventStream } from "./task-event-stream.js";
import { ConferenceRoomManager } from "./conference-room.js";
import type { TaskRuntimeRepository } from "./task-repository.js";
import type { WorkerRuntimeRepository } from "./worker-repository.js";
import type {
  ApplyProposalRequest,
  ArtifactRecord,
  AttachArtifactRequest,
  AuditAction,
  AuditEvent,
  AuditListFilters,
  A2AExchangeMessageRecord,
  A2AExchangeMessageRequest,
  A2AExchangeRequest,
  A2AExchangeState,
  BrokerDashboard,
  ChangeProposal,
  CreateProposalRequest,
  CreateTaskRequest,
  ProposalActorRequest,
  ProposalDetails,
  ProposalListFilters,
  ProposalPipelineSummary,
  ProposalStatus,
  RegisterWorkerRequest,
  SubmitValidationRequest,
  TaskCancelRequest,
  TaskError,
  TaskApprovalRequest,
  TaskApprovalTerminalRequest,
  TaskApprovalOutcomeStatus,
  TaskHistorySummary,
  TaskListFilters,
  TaskQueueSummary,
  TaskRecord,
  TaskReassignRequest,
  TaskResult,
  TaskStatus,
  TaskWakeDecisionRequest,
  TaskWakePlanRequest,
  TaskWakePlanResult,
  TaskWakeState,
  ValidationResult,
  WorkerFleetSummary,
  WorkerHeartbeatRequest,
  TaskDiagnosticReport,
  TaskDiagnosticStatus,
  TaskTombstone,
  TombstoneListFilters,
  TombstoneReason,
  WorkerListFilters,
  WorkerRecord,
  WorkerView,
} from "./types.js";

export type BrokerErrorCode =
  | "bad_request"
  | "not_found"
  | "policy_denied"
  | "invalid_transition"
  | "unauthorized"
  | "rate_limited";

export class BrokerError extends Error {
  constructor(
    readonly code: BrokerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BrokerError";
  }
}

export interface BrokerRetentionPolicy {
  terminalRetentionMs: number;
  maxTerminalExchanges: number;
  maxTerminalTasks: number;
  maxTerminalProposals: number;
  inactiveWorkerRetentionMs: number;
  maxInactiveWorkers: number;
  auditRetentionMs: number;
  maxAuditEvents: number;
}

export interface InMemoryA2ABrokerOptions {
  /** Optional table-native repository for high-churn task lifecycle state. */
  taskRepository?: TaskRuntimeRepository;
  /** Optional table-native repository for high-churn worker runtime state. */
  workerRepository?: WorkerRuntimeRepository;
  retention?: Partial<BrokerRetentionPolicy>;
  /**
   * Maximum number of times the stale-task reaper (or manual requeue) is allowed to recycle a
   * single task back to `queued`. Once the cap is reached the next stale-recovery pass marks
   * the task `failed` with a `exceeded_requeue_limit` error instead of requeuing it again, so
   * a flapping worker or poisoned payload cannot thrash the queue forever. `0` disables the
   * cap (unlimited requeues, legacy behavior).
   */
  maxRequeueAttempts?: number;
  /**
   * Max buffered SSE events per task for replay after reconnect.
   * Events beyond this limit are discarded (oldest first).
   * Default: 100.
   */
  maxBufferedEventsPerTask?: number;
  /**
   * Max retained {@link TaskStatusEvent}s in the broker-wide
   * {@link TaskEventStream}. Older events are evicted FIFO when exceeded.
   * Default: 1000.
   */
  maxTaskStatusEvents?: number;
}

export interface TaskDiagnosticsOptions {
  /** Threshold in ms after which a running task without heartbeat is stale. */
  staleAfterMs?: number;
  /** Threshold in ms after which a running task is long-running. */
  longRunningAfterMs?: number;
  /** Threshold in ms after which an assigned worker is considered stale/offline. */
  workerOfflineAfterMs?: number;
  nowMs?: number;
}

/**
 * Default cap on automatic requeues for a single task. Chosen to tolerate a short burst of
 * worker crashes or transient outages without masking a genuinely stuck task forever.
 */
export const DEFAULT_MAX_REQUEUE_ATTEMPTS = 5;

export const REQUEUE_EXHAUSTED_ERROR_CODE = "exceeded_requeue_limit";

export const DEFAULT_BROKER_RETENTION_POLICY: BrokerRetentionPolicy = {
  terminalRetentionMs: 7 * 24 * 60 * 60 * 1000,
  maxTerminalExchanges: 1_000,
  maxTerminalTasks: 2_000,
  maxTerminalProposals: 1_000,
  inactiveWorkerRetentionMs: 14 * 24 * 60 * 60 * 1000,
  maxInactiveWorkers: 500,
  auditRetentionMs: 7 * 24 * 60 * 60 * 1000,
  maxAuditEvents: 5_000,
};

export type TaskUpdateReason =
  | "created"
  | "approved"
  | "claimed"
  | "started"
  | "succeeded"
  | "failed"
  | "canceled"
  | "reassigned"
  | "requeued"
  | "dead_lettered"
  | "wake_planned"
  | "wake_scheduled"
  | "wake_skipped"
  | "wake_failed";

export interface TaskUpdate {
  task: TaskRecord;
  reason: TaskUpdateReason;
  /** Terminal updates should be the last event a subscriber sees for this task. */
  final: boolean;
  /** Monotonically increasing sequence number per task for SSE `id:` field and replay. */
  seq: number;
}

/** Buffered SSE event for replay after reconnect. */
export interface BufferedTaskEvent {
  seq: number;
  event: string;
  data: TaskUpdate;
}

export type TaskUpdateListener = (update: TaskUpdate) => void;
export type BrokerStateListener = () => void;

export class InMemoryA2ABroker {
  private readonly exchanges = new Map<string, A2AExchangeState>();
  private readonly exchangeMessages = new Map<string, A2AExchangeMessageRecord>();
  private readonly proposals = new Map<string, ChangeProposal>();
  private readonly artifacts = new Map<string, ArtifactRecord>();
  private readonly validations = new Map<string, ValidationResult>();
  private readonly auditEvents = new Map<string, AuditEvent>();
  private readonly workers = new Map<string, WorkerRecord>();
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly tombstones = new Map<string, TaskTombstone>();
  private readonly taskListeners = new Map<string, Set<TaskUpdateListener>>();
  private readonly taskEventBuffers = new Map<string, BufferedTaskEvent[]>();
  private readonly taskEventSeqs = new Map<string, number>();
  private readonly pendingHotTasks = new Map<string, TaskRecord>();
  private readonly pendingHotTombstones = new Map<string, TaskTombstone>();
  private readonly pendingHotAuditEvents = new Map<string, AuditEvent>();
  private readonly pendingHotWorkers = new Map<string, WorkerRecord>();
  private readonly pendingHotExchanges = new Map<string, A2AExchangeState>();
  private readonly pendingHotExchangeMessages = new Map<string, A2AExchangeMessageRecord>();
  private readonly pendingHotProposals = new Map<string, ChangeProposal>();
  private readonly pendingHotArtifacts = new Map<string, ArtifactRecord>();
  private readonly pendingHotValidations = new Map<string, ValidationResult>();
  private readonly stateListeners = new Set<BrokerStateListener>();
  private readonly maxBufferedEventsPerTask: number;
  private readonly taskEventStream: TaskEventStream;
  private readonly conferenceManager: ConferenceRoomManager;
  private readonly taskRepository?: TaskRuntimeRepository;
  private readonly workerRepository?: WorkerRuntimeRepository;

  constructor(
    private readonly stateStore?: BrokerStateStore,
    snapshot?: BrokerSnapshot,
    options: InMemoryA2ABrokerOptions = {},
  ) {
    this.taskRepository = options.taskRepository;
    this.workerRepository = options.workerRepository;
    this.retentionPolicy = normalizeBrokerRetentionPolicy(options.retention);
    this.maxRequeueAttempts = normalizeMaxRequeueAttempts(options.maxRequeueAttempts);
    this.maxBufferedEventsPerTask = options.maxBufferedEventsPerTask ?? 100;
    this.taskEventStream = new TaskEventStream({ maxEvents: options.maxTaskStatusEvents });
    this.conferenceManager = new ConferenceRoomManager();
    if (snapshot) {
      this.loadSnapshot(snapshot);
    }
    this.applyRetentionPolicy();
  }

  /**
   * Cursor-based stream of task status transitions. Wraps the audit-event
   * pipeline so subscribers can replay missed events after reconnect without
   * polling. See `docs/task-event-stream.md`.
   */
  getTaskEventStream(): TaskEventStream {
    return this.taskEventStream;
  }

  /**
   * Manager for agent teleconference rooms. Each room is anchored to a parent
   * task id and tracks participant status transitions using the same bounded
   * cursor/replay substrate as the task status stream. See `docs/conference-room.md`.
   */
  getConferenceManager(): ConferenceRoomManager {
    return this.conferenceManager;
  }

  private readonly retentionPolicy: BrokerRetentionPolicy;
  private readonly maxRequeueAttempts: number;

  /** Returns the configured max automatic requeues per task. `0` means disabled. */
  getMaxRequeueAttempts(): number {
    return this.maxRequeueAttempts;
  }

  /**
   * Subscribe to task-lifecycle updates. The listener fires once per state transition
   * (claim, start, complete, fail, cancel, reassign, requeue, dead-letter) with the current
   * `TaskRecord` snapshot. Returns an unsubscribe function. Listeners are not invoked with
   * the current state on subscribe; callers that need the initial state should read it via
   * `getTask(taskId)` before subscribing. Listener errors are caught and logged so a broken
   * subscriber cannot stall the broker.
   */
  subscribeToTask(taskId: string, listener: TaskUpdateListener): () => void {
    let listeners = this.taskListeners.get(taskId);
    if (!listeners) {
      listeners = new Set();
      this.taskListeners.set(taskId, listeners);
    }
    listeners.add(listener);
    return () => {
      const current = this.taskListeners.get(taskId);
      if (!current) {
        return;
      }
      current.delete(listener);
      if (current.size === 0) {
        this.taskListeners.delete(taskId);
      }
    };
  }

  /** Subscribe to broker-wide state changes after a successful persisted mutation. */
  subscribeToState(listener: BrokerStateListener): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  private emitTaskUpdate(task: TaskRecord, reason: TaskUpdateReason): void {
    const listeners = this.taskListeners.get(task.id);
    const hasActiveSubscribers = listeners && listeners.size > 0;
    const hasBuffer = this.taskEventBuffers.has(task.id);

    if (!hasActiveSubscribers && !hasBuffer) {
      return;
    }

    const final = isTerminalTaskStatus(task.status);
    const seq = this.advanceTaskEventSeq(task.id);
    // Snapshot the listener set and clone the task so a listener that mutates its copy (or
    // the broker mutating later) can't alter what other subscribers observe.
    const snapshot: TaskUpdate = {
      task: structuredClone(task),
      reason,
      final,
      seq,
    };

    // Buffer event for replay even if no active subscribers.
    this.bufferTaskEvent(task.id, {
      seq,
      event: "task-status-update",
      data: snapshot,
    });

    if (!hasActiveSubscribers) {
      return;
    }
    for (const listener of [...listeners!]) {
      try {
        listener(snapshot);
      } catch (error) {
        console.error(
          `[a2a-broker] task subscriber for ${task.id} threw: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  private advanceTaskEventSeq(taskId: string): number {
    const current = this.taskEventSeqs.get(taskId) ?? 0;
    const next = current + 1;
    this.taskEventSeqs.set(taskId, next);
    return next;
  }

  private bufferTaskEvent(taskId: string, event: BufferedTaskEvent): void {
    let buffer = this.taskEventBuffers.get(taskId);
    if (!buffer) {
      buffer = [];
      this.taskEventBuffers.set(taskId, buffer);
    }
    buffer.push(event);
    // Trim oldest events beyond the limit.
    if (buffer.length > this.maxBufferedEventsPerTask) {
      buffer.splice(0, buffer.length - this.maxBufferedEventsPerTask);
    }
  }

  /** Replay buffered events after the given sequence number. Returns events with seq > afterSeq. */
  replayTaskEvents(taskId: string, afterSeq: number): BufferedTaskEvent[] {
    const buffer = this.taskEventBuffers.get(taskId);
    if (!buffer) {
      return [];
    }
    return buffer.filter((e) => e.seq > afterSeq);
  }

  /** Build the SSE `id` field value: `{taskId}:{seq}`. */
  formatSseEventId(taskId: string, seq: number): string {
    return `${taskId}:${seq}`;
  }

  /** Parse an SSE `Last-Event-Id` value into taskId and seq. Returns null if malformed. */
  parseSseEventId(raw: string): { taskId: string; seq: number } | null {
    const colonIdx = raw.lastIndexOf(":");
    if (colonIdx < 1) {
      return null;
    }
    const taskId = raw.substring(0, colonIdx);
    const seq = Number(raw.substring(colonIdx + 1));
    if (!taskId || !Number.isFinite(seq) || seq < 0) {
      return null;
    }
    return { taskId, seq };
  }

  startExchange(request: A2AExchangeRequest): A2AExchangeState {
    const now = isoNow();
    const exchangeId = randomUUID();
    const rootMessage: A2AExchangeMessageRecord = {
      id: randomUUID(),
      exchangeId,
      kind: "root",
      message: request.message,
      requester: request.requester,
      via: request.via,
      targetNodeId: request.target.id,
      createdAt: now,
      updatedAt: now,
    };
    const exchange: A2AExchangeState = {
      id: exchangeId,
      requester: request.requester,
      target: request.target,
      targetNodeId: request.target.id,
      message: request.message,
      maxTurns: request.maxTurns ?? 8,
      intent: request.intent ?? "chat",
      status: "queued",
      rootMessageId: rootMessage.id,
      latestMessageId: rootMessage.id,
      messageCount: 1,
      lastMessageAt: now,
      createdAt: now,
      updatedAt: now,
    };

    this.setExchangeMessageRecord(rootMessage);
    this.setExchangeRecord(exchange);
    this.persistState();
    return exchange;
  }

  getExchange(id: string): A2AExchangeState | null {
    return this.exchanges.get(id) ?? null;
  }

  listExchanges(): A2AExchangeState[] {
    return sortedCopy(this.exchanges.values(), sortNewestFirst);
  }

  listExchangeMessages(
    exchangeId: string,
    filters?: {
      parentMessageId?: string;
      includeDescendants?: boolean;
    },
  ): A2AExchangeMessageRecord[] {
    const exchange = this.requireExchange(exchangeId);
    const items = sortedCopy(
      [...this.exchangeMessages.values()].filter((message) => message.exchangeId === exchangeId),
      sortExchangeMessages,
    );

    if (!filters?.parentMessageId) {
      return items;
    }

    this.requireExchangeMessage(exchange.id, filters.parentMessageId);
    if (filters.includeDescendants) {
      const allowedIds = collectThreadMessageIds(items, filters.parentMessageId);
      return items.filter((message) => allowedIds.has(message.id));
    }
    return items.filter((message) => message.parentMessageId === filters.parentMessageId);
  }

  addExchangeMessage(exchangeId: string, request: A2AExchangeMessageRequest): A2AExchangeMessageRecord {
    const exchange = this.requireExchange(exchangeId);

    if (!request.actor?.id) {
      throw new BrokerError("bad_request", "actor.id is required");
    }
    if (!request.message) {
      throw new BrokerError("bad_request", "message is required");
    }

    this.assertExchangeMessageActor(exchange, request);

    if (request.targetNodeId) {
      this.requireWorker(request.targetNodeId);
    }
    if (request.assignedWorkerId) {
      this.requireWorker(request.assignedWorkerId);
    }
    if (request.parentMessageId) {
      this.requireExchangeMessage(exchange.id, request.parentMessageId);
    }

    const now = isoNow();
    const message: A2AExchangeMessageRecord = {
      id: randomUUID(),
      exchangeId,
      kind: "thread",
      message: request.message,
      actor: request.actor,
      via: request.via,
      decision: request.decision,
      targetNodeId: request.targetNodeId ?? exchange.target.id,
      assignedWorkerId: request.assignedWorkerId,
      parentMessageId: request.parentMessageId ?? exchange.rootMessageId,
      createdAt: now,
      updatedAt: now,
    };

    this.setExchangeMessageRecord(message);
    exchange.messageCount += 1;
    exchange.lastMessageAt = now;
    exchange.latestMessageId = message.id;
    exchange.updatedAt = now;
    this.applyExchangeMessageDecision(exchange, message);
    this.setExchangeRecord(exchange);
    this.appendAuditEvent({
      actorId: request.actor.id,
      action: "exchange.message.added",
      targetType: "exchange-message",
      targetId: message.id,
      note: request.decision ? `${request.decision}: ${request.message}` : request.message,
    });
    this.persistState();
    return message;
  }

  registerWorker(request: RegisterWorkerRequest): WorkerRecord {
    this.assertWorkerRegistrationPayload(request);

    const now = isoNow();
    const existing = this.getWorker(request.nodeId);
    const worker: WorkerRecord = {
      nodeId: request.nodeId,
      role: request.role,
      displayName: request.displayName,
      brokerUrl: request.brokerUrl,
      capabilities: normalizeCapabilities(request.capabilities),
      metadata: request.metadata,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastSeenAt: now,
    };

    this.setWorkerRecord(worker);
    this.appendAuditEvent({
      actorId: worker.nodeId,
      action: "worker.registered",
      targetType: "worker",
      targetId: worker.nodeId,
      note: worker.displayName ?? worker.role,
    });
    this.persistState();
    return worker;
  }

  heartbeatWorker(nodeId: string, request?: WorkerHeartbeatRequest): WorkerRecord {
    const worker = this.requireWorker(nodeId);
    const now = isoNow();

    worker.displayName = request?.displayName ?? worker.displayName;
    worker.brokerUrl = request?.brokerUrl ?? worker.brokerUrl;
    worker.capabilities = request?.capabilities
      ? normalizeCapabilities(request.capabilities)
      : worker.capabilities;
    worker.metadata = request?.metadata ?? worker.metadata;
    worker.updatedAt = now;
    worker.lastSeenAt = now;

    this.setWorkerRecord(worker);
    this.appendAuditEvent({
      actorId: worker.nodeId,
      action: "worker.heartbeat",
      targetType: "worker",
      targetId: worker.nodeId,
      note: "heartbeat",
    });
    this.persistState();
    return worker;
  }

  getWorker(nodeId: string): WorkerRecord | null {
    const repositoryWorker = this.workerRepository?.getWorker(nodeId);
    if (repositoryWorker) {
      const worker = normalizeWorkerRecord(repositoryWorker);
      this.workers.set(worker.nodeId, worker);
      return worker;
    }
    return this.workers.get(nodeId) ?? null;
  }

  listWorkers(filters?: WorkerListFilters): WorkerRecord[] {
    if (this.workerRepository) {
      const workers = this.workerRepository.listWorkers(filters).map(normalizeWorkerRecord);
      for (const worker of workers) {
        this.workers.set(worker.nodeId, worker);
      }
      return sortedCopy(
        workers.filter((worker) => workerMatchesFilters(worker, filters)),
        sortWorkersNewestFirst,
      );
    }
    return sortedCopy(
      [...this.workers.values()].filter((worker) => {
        return workerMatchesFilters(worker, filters);
      }),
      sortWorkersNewestFirst,
    );
  }

  listWorkerViews(offlineAfterMs: number, filters?: WorkerListFilters): WorkerView[] {
    return this.listWorkers(filters).map((worker) => ({
      ...worker,
      status: computeWorkerStatus(worker.lastSeenAt, offlineAfterMs),
    }));
  }

  getWorkerView(nodeId: string, offlineAfterMs: number): WorkerView | null {
    const worker = this.getWorker(nodeId);
    if (!worker) {
      return null;
    }

    return {
      ...worker,
      status: computeWorkerStatus(worker.lastSeenAt, offlineAfterMs),
    };
  }

  createProposal(request: CreateProposalRequest): ChangeProposal {
    this.assertProposalPayload(request);

    try {
      assertProposalCreationAllowed(request.source, request.target);
    } catch (error) {
      throw normalizePolicyError(error);
    }

    const now = isoNow();
    const proposal: ChangeProposal = {
      id: randomUUID(),
      source: request.source,
      target: request.target,
      sourceNodeId: request.source.id,
      targetNodeId: request.target.id,
      kind: request.kind,
      summary: request.summary,
      rationale: request.rationale,
      workspace: request.workspace,
      patchText: request.patchText,
      parameterPayload: request.parameterPayload,
      artifactIds: [...(request.artifactIds ?? [])],
      status: "submitted",
      createdAt: now,
      updatedAt: now,
    };

    this.setProposalRecord(proposal);
    this.appendAuditEvent({
      actorId: request.source.id,
      action: "proposal.created",
      targetType: "proposal",
      targetId: proposal.id,
      proposalId: proposal.id,
      note: request.summary,
    });
    this.persistState();
    return proposal;
  }

  getProposal(id: string): ChangeProposal | null {
    return this.proposals.get(id) ?? null;
  }

  listProposals(filters?: ProposalListFilters): ChangeProposal[] {
    return sortedCopy(
      [...this.proposals.values()].filter((proposal) => {
        if (filters?.status && proposal.status !== filters.status) {
          return false;
        }
        if (filters?.sourceNodeId && proposal.sourceNodeId !== filters.sourceNodeId) {
          return false;
        }
        if (filters?.targetNodeId && proposal.targetNodeId !== filters.targetNodeId) {
          return false;
        }
        if (filters?.kind && proposal.kind !== filters.kind) {
          return false;
        }
        return true;
      }),
      sortNewestFirst,
    );
  }

  getProposalDetails(id: string): ProposalDetails | null {
    const proposal = this.getProposal(id);
    if (!proposal) {
      return null;
    }

    return {
      proposal,
      artifacts: this.listArtifactsForProposal(id),
      validations: this.listValidationsForProposal(id),
      audit: this.listAuditEvents({ proposalId: id }),
    };
  }

  attachArtifact(proposalId: string, request: AttachArtifactRequest): ArtifactRecord {
    const proposal = this.requireProposal(proposalId);
    if (!request.kind || !request.uri) {
      throw new BrokerError("bad_request", "kind and uri are required");
    }

    const artifact: ArtifactRecord = {
      id: randomUUID(),
      proposalId,
      kind: request.kind,
      uri: request.uri,
      contentType: request.contentType,
      sizeBytes: request.sizeBytes,
      summary: request.summary,
      createdAt: isoNow(),
    };

    this.setArtifactRecord(artifact);
    proposal.artifactIds = uniqueIds([...proposal.artifactIds, artifact.id]);
    proposal.updatedAt = isoNow();
    this.setProposalRecord(proposal);

    this.appendAuditEvent({
      actorId: proposal.sourceNodeId,
      action: "artifact.attached",
      targetType: "artifact",
      targetId: artifact.id,
      proposalId,
      note: artifact.summary,
    });

    this.persistState();
    return artifact;
  }

  submitValidationResult(
    proposalId: string,
    request: SubmitValidationRequest,
  ): ValidationResult {
    const proposal = this.requireProposal(proposalId);
    if (!request.kind || !request.verdict || !request.nodeId) {
      throw new BrokerError("bad_request", "nodeId, kind, and verdict are required");
    }

    try {
      assertValidationSubmissionAllowed(proposal, request);
    } catch (error) {
      throw normalizePolicyError(error);
    }

    const validation: ValidationResult = {
      id: randomUUID(),
      proposalId,
      nodeId: request.nodeId,
      kind: request.kind,
      verdict: request.verdict,
      metrics: request.metrics ?? {},
      artifactIds: [...(request.artifactIds ?? [])],
      note: request.note,
      createdAt: isoNow(),
    };

    this.setValidationRecord(validation);
    proposal.status = "validated";
    proposal.updatedAt = isoNow();
    proposal.artifactIds = uniqueIds([...proposal.artifactIds, ...validation.artifactIds]);
    this.setProposalRecord(proposal);

    this.appendAuditEvent({
      actorId: request.nodeId,
      action: "validation.submitted",
      targetType: "validation",
      targetId: validation.id,
      proposalId,
      note: request.note,
    });

    this.persistState();
    return validation;
  }

  approveProposal(proposalId: string, request: ProposalActorRequest): ChangeProposal {
    const proposal = this.requireProposal(proposalId);
    this.assertTransition(proposal.status, ["submitted", "validated"], "approve");

    try {
      assertProposalReviewAllowed(proposal, request);
    } catch (error) {
      throw normalizePolicyError(error);
    }

    proposal.status = "approved";
    proposal.updatedAt = isoNow();
    this.setProposalRecord(proposal);
    this.appendAuditEvent({
      actorId: request.actor.id,
      action: "proposal.approved",
      targetType: "proposal",
      targetId: proposal.id,
      proposalId,
      note: request.note,
    });
    this.persistState();
    return proposal;
  }

  rejectProposal(proposalId: string, request: ProposalActorRequest): ChangeProposal {
    const proposal = this.requireProposal(proposalId);
    this.assertTransition(proposal.status, ["submitted", "validated"], "reject");

    try {
      assertProposalReviewAllowed(proposal, request);
    } catch (error) {
      throw normalizePolicyError(error);
    }

    proposal.status = "rejected";
    proposal.updatedAt = isoNow();
    this.setProposalRecord(proposal);
    this.appendAuditEvent({
      actorId: request.actor.id,
      action: "proposal.rejected",
      targetType: "proposal",
      targetId: proposal.id,
      proposalId,
      note: request.note,
    });
    this.persistState();
    return proposal;
  }

  applyProposalLocally(proposalId: string, request: ApplyProposalRequest): ChangeProposal {
    const proposal = this.requireProposal(proposalId);
    this.assertTransition(proposal.status, ["approved"], "apply");

    if (request.workspace.nodeId !== proposal.targetNodeId) {
      throw new BrokerError(
        "policy_denied",
        "apply workspace nodeId must match the proposal target node",
      );
    }

    try {
      assertProposalApplyAllowed(proposal, request);
    } catch (error) {
      throw normalizePolicyError(error);
    }

    proposal.status = "applied";
    proposal.updatedAt = isoNow();
    this.setProposalRecord(proposal);
    this.appendAuditEvent({
      actorId: request.actor.id,
      action: "proposal.applied",
      targetType: "proposal",
      targetId: proposal.id,
      proposalId,
      note: request.note,
    });
    this.persistState();
    return proposal;
  }

  createTask(request: CreateTaskRequest): TaskRecord {
    this.assertTaskPayload(request);

    // Idempotent create: if a task with the requested id already exists, return it as-is.
    if (request.id) {
      const existing = this.getTask(request.id);
      if (existing) {
        return existing;
      }
    }

    if (request.exchangeId) {
      this.requireExchange(request.exchangeId);
    }
    this.requireWorker(request.target.id);
    if (request.assignedWorkerId) {
      this.requireWorker(request.assignedWorkerId);
    }
    this.assertTaskProposalLink(request);

    const now = isoNow();
    const policyContext = normalizeTaskPolicyContext(request);
    const initialStatus: TaskStatus = policyContext?.requiresApproval === true ? "blocked" : "queued";
    const task: TaskRecord = {
      id: request.id ?? randomUUID(),
      exchangeId: request.exchangeId,
      parentTaskId: request.parentTaskId,
      intent: request.intent,
      requester: request.requester,
      target: request.target,
      targetNodeId: request.target.id,
      assignedWorkerId: request.assignedWorkerId ?? request.target.id,
      workspace: request.workspace,
      message: request.message,
      proposalId: request.proposalId,
      artifactIds: uniqueIds(request.artifactIds ?? []),
      via: request.via,
      policyContext,
      payload: normalizeTaskPayload(request.payload),
      status: initialStatus,
      createdAt: request.createdAt ?? now,
      updatedAt: now,
      taskOrigin: request.taskOrigin ?? "unknown",
    };

    this.setTaskRecord(task);
    if (task.exchangeId) {
      this.linkTaskToExchange(task);
    }
    this.appendAuditEvent({
      actorId: task.requester.id,
      action: "task.created",
      targetType: "task",
      targetId: task.id,
      proposalId: task.proposalId,
      note: task.status === "blocked" ? `approval required: ${task.message ?? task.intent}` : task.message ?? task.intent,
    });
    this.persistState();
    this.emitTaskUpdate(task, "created");
    return task;
  }

  planAcceptedTaskWake(taskId: string, request: TaskWakePlanRequest): TaskWakePlanResult {
    const task = this.requireTask(taskId);
    if (!request.targetSessionKey?.trim()) {
      throw new BrokerError("bad_request", "targetSessionKey is required");
    }
    if (isTerminalTaskStatus(task.status)) {
      throw new BrokerError("invalid_transition", `cannot plan wake for terminal task ${task.status}`);
    }

    const wakeKey = buildTaskWakeKey(task, request);
    const idempotencyKey = normalizeWakeString(request.idempotencyKey) ?? `a2a-wake:${wakeKey}`;
    const existing = task.wake;
    if (existing) {
      if (existing.wakeKey !== wakeKey) {
        throw new BrokerError("invalid_transition", "task wake already planned with a different wake key");
      }
      task.wake = {
        ...existing,
        replayCount: (existing.replayCount ?? 0) + 1,
        updatedAt: isoNow(),
      };
      this.setTaskRecord(task);
      this.persistState();
      return {
        task,
        wake: task.wake,
        shouldDispatch: existing.status === "planned",
        replayed: true,
      };
    }

    const now = isoNow();
    const wake: TaskWakeState = {
      status: "planned",
      wakeKey,
      idempotencyKey,
      targetSessionKey: request.targetSessionKey.trim(),
      ...(normalizeWakeString(request.targetNodeId) ? { targetNodeId: normalizeWakeString(request.targetNodeId) } : {}),
      ...(normalizeWakeString(request.waitRunId) ? { waitRunId: normalizeWakeString(request.waitRunId) } : {}),
      ...(normalizeWakeString(request.correlationId) ? { correlationId: normalizeWakeString(request.correlationId) } : {}),
      ...(normalizeWakeString(request.parentRunId) ? { parentRunId: normalizeWakeString(request.parentRunId) } : {}),
      ...(normalizeWakeString(request.message) ? { message: normalizeWakeString(request.message) } : {}),
      plannedAt: now,
      updatedAt: now,
      replayCount: 0,
    };

    task.wake = wake;
    task.updatedAt = now;
    this.setTaskRecord(task);
    this.appendAuditEvent({
      actorId: task.requester.id,
      action: "task.wake.planned",
      targetType: "task",
      targetId: task.id,
      proposalId: task.proposalId,
      note: wake.message ?? wake.wakeKey,
    });
    this.persistState();
    this.emitTaskUpdate(task, "wake_planned");
    return { task, wake, shouldDispatch: true, replayed: false };
  }

  recordTaskWakeDecision(taskId: string, request: TaskWakeDecisionRequest): TaskRecord {
    const task = this.requireTask(taskId);
    if (!task.wake) {
      throw new BrokerError("invalid_transition", "task wake has not been planned");
    }
    const existing = task.wake;
    if (existing.status !== "planned") {
      if (existing.status === request.status) {
        return task;
      }
      throw new BrokerError("invalid_transition", `task wake already decided as ${existing.status}`);
    }

    const now = isoNow();
    const message = normalizeWakeString(request.message) ?? defaultWakeDecisionMessage(request.status);
    task.wake = {
      ...existing,
      status: request.status,
      ...(request.coalesced !== undefined ? { coalesced: request.coalesced } : {}),
      ...(normalizeWakeString(request.runtimeRunId) ? { runtimeRunId: normalizeWakeString(request.runtimeRunId) } : {}),
      ...(normalizeWakeString(request.code) ? { code: normalizeWakeString(request.code) } : {}),
      message,
      decidedAt: now,
      updatedAt: now,
    };
    task.updatedAt = now;
    this.setTaskRecord(task);
    const action = wakeDecisionAuditAction(request.status);
    this.appendAuditEvent({
      actorId: "broker",
      action,
      targetType: "task",
      targetId: task.id,
      proposalId: task.proposalId,
      note: `${request.status}: ${message}`,
    });
    this.persistState();
    this.emitTaskUpdate(task, wakeDecisionUpdateReason(request.status));
    return task;
  }

  getTask(id: string): TaskRecord | null {
    const repositoryTask = this.taskRepository?.getTask(id);
    if (repositoryTask) {
      const task = normalizeTaskRecord(repositoryTask);
      this.tasks.set(task.id, task);
      return task;
    }
    return this.tasks.get(id) ?? null;
  }

  listTasks(filters?: TaskListFilters): TaskRecord[] {
    const tasksById = new Map(this.tasks);
    if (this.taskRepository) {
      for (const repositoryTask of this.taskRepository.listTasks(filters).map(normalizeTaskRecord)) {
        this.tasks.set(repositoryTask.id, repositoryTask);
        tasksById.set(repositoryTask.id, repositoryTask);
      }
    }
    return sortedCopy(
      [...tasksById.values()].filter((task) => taskMatchesFilters(task, filters)),
      sortNewestFirst,
    );
  }

  reassignTask(taskId: string, request: TaskReassignRequest): TaskRecord {
    const task = this.requireTask(taskId);
    if (!request.actor?.id) {
      throw new BrokerError("bad_request", "actor.id is required");
    }
    if (request.actor.role !== "hub" && request.actor.role !== "operator") {
      throw new BrokerError("policy_denied", "task reassignment requires a hub or operator actor");
    }
    if (task.status === "succeeded" || task.status === "canceled") {
      throw new BrokerError("invalid_transition", `cannot reassign task while status is ${task.status}`);
    }

    const previousTargetNodeId = task.targetNodeId;
    const previousAssignedWorkerId = task.assignedWorkerId ?? task.targetNodeId;
    const nextTargetNodeId = request.targetNodeId ?? task.targetNodeId;
    const nextAssignedWorkerId = request.assignedWorkerId ?? request.targetNodeId ?? task.assignedWorkerId ?? nextTargetNodeId;
    const targetWorker = this.requireWorker(nextTargetNodeId);
    const assignedWorker = this.requireWorker(nextAssignedWorkerId);
    const now = isoNow();

    task.targetNodeId = nextTargetNodeId;
    task.target = {
      id: targetWorker.nodeId,
      kind: "node",
      role: targetWorker.role,
    };
    task.assignedWorkerId = assignedWorker.nodeId;
    task.status = task.policyContext?.requiresApproval === true && !task.approval ? "blocked" : "queued";
    task.claimedBy = undefined;
    task.claimedAt = undefined;
    task.completedAt = undefined;
    task.result = undefined;
    task.error = undefined;
    // Operator reassignment is a fresh attempt budget: clearing `requeueCount` so the new
    // target isn't penalized by the previous worker's flaps.
    task.requeueCount = 0;
    task.attemptId = undefined;
    task.updatedAt = now;
    this.setTaskRecord(task);
    this.syncExchangeStateFromTask(task, "queued");
    this.appendAuditEvent({
      actorId: request.actor.id,
      action: "task.reassigned",
      targetType: "task",
      targetId: task.id,
      proposalId: task.proposalId,
      note:
        request.note ??
        `reassigned targetNodeId ${previousTargetNodeId} -> ${task.targetNodeId}, assignedWorkerId ${previousAssignedWorkerId} -> ${task.assignedWorkerId}`,
    });
    this.persistState();
    this.emitTaskUpdate(task, "reassigned");
    return task;
  }

  cancelTask(taskId: string, request: TaskCancelRequest): TaskRecord {
    const task = this.requireTask(taskId);
    if (!request.actor?.id) {
      throw new BrokerError("bad_request", "actor.id is required");
    }

    const actorId = request.actor.id;
    const actorRole = request.actor.role;
    const requesterMatch = actorId === task.requester.id;
    const workerMatch =
      actorId === task.claimedBy ||
      actorId === task.assignedWorkerId ||
      actorId === task.targetNodeId;

    if (
      actorRole !== "hub" &&
      actorRole !== "operator" &&
      !requesterMatch &&
      !workerMatch
    ) {
      throw new BrokerError(
        "policy_denied",
        "task cancellation requires a hub, operator, requester, or assigned worker actor",
      );
    }

    if (task.status === "succeeded" || task.status === "failed" || task.status === "canceled") {
      return task;
    }

    return this.cancelTaskTree(task, {
      actorId,
      reason: request.reason,
    });
  }

  approveTask(taskId: string, request: TaskApprovalRequest): TaskRecord {
    const task = this.requireTask(taskId);
    if (!request.actor?.id) {
      throw new BrokerError("bad_request", "actor.id is required");
    }
    if (!isPrivilegedTaskApprover(request.actor)) {
      throw new BrokerError("policy_denied", "task approval requires a hub or operator actor");
    }
    if (task.policyContext?.requiresApproval !== true) {
      throw new BrokerError("invalid_transition", "task does not require approval");
    }
    if (task.approval) {
      return task;
    }
    if (isTerminalTaskStatus(task.status)) {
      throw new BrokerError("invalid_transition", `cannot approve task while status is ${task.status}`);
    }
    if (task.status !== "blocked" && task.status !== "queued") {
      throw new BrokerError("invalid_transition", `cannot approve task while status is ${task.status}`);
    }

    const now = isoNow();
    task.approval = {
      approvalId: normalizeApprovalId(request.approvalId) ?? randomUUID(),
      approvedAt: now,
      approvedBy: request.actor.id,
      actorRole: request.actor.role,
      requesterRole: task.requester.role,
      reason: normalizeApprovalReason(request.reason),
    };
    task.approvalOutcome = {
      status: "approved",
      approvalId: task.approval.approvalId,
      decidedAt: now,
      decidedBy: request.actor.id,
      actorRole: request.actor.role,
      requesterRole: task.requester.role,
      reason: task.approval.reason,
    };
    task.status = "queued";
    task.updatedAt = now;
    this.setTaskRecord(task);
    this.syncExchangeStateFromTask(task, "queued");
    this.appendAuditEvent({
      actorId: request.actor.id,
      action: "task.approved",
      targetType: "task",
      targetId: task.id,
      proposalId: task.proposalId,
      note: task.approval.reason ?? `approvalId=${task.approval.approvalId}`,
    });
    this.persistState();
    this.emitTaskUpdate(task, "approved");
    return task;
  }

  rejectTaskApproval(taskId: string, request: TaskApprovalTerminalRequest): TaskRecord {
    const task = this.requireTask(taskId);
    if (!request.actor?.id) {
      throw new BrokerError("bad_request", "actor.id is required");
    }
    if (!isPrivilegedTaskApprover(request.actor)) {
      throw new BrokerError("policy_denied", "task approval rejection requires a hub or operator actor");
    }
    if (task.policyContext?.requiresApproval !== true) {
      throw new BrokerError("invalid_transition", "task does not require approval");
    }
    if (task.approval || task.approvalOutcome?.status === "approved") {
      throw new BrokerError("invalid_transition", "task approval is already approved");
    }
    if (task.approvalOutcome) {
      return task;
    }
    if (isTerminalTaskStatus(task.status)) {
      throw new BrokerError("invalid_transition", `cannot reject approval while task status is ${task.status}`);
    }
    if (task.status !== "blocked" && task.status !== "queued") {
      throw new BrokerError("invalid_transition", `cannot reject approval while task status is ${task.status}`);
    }

    const now = isoNow();
    const status = normalizeApprovalTerminalStatus(request.status);
    const reason = normalizeApprovalReason(request.reason) ?? `approval ${status}`;
    task.approvalOutcome = {
      status,
      approvalId: normalizeApprovalId(request.approvalId) ?? randomUUID(),
      decidedAt: now,
      decidedBy: request.actor.id,
      actorRole: request.actor.role,
      requesterRole: task.requester.role,
      reason,
    };
    const canceled = this.cancelTaskTree(task, {
      actorId: request.actor.id,
      reason,
    });
    this.appendAuditEvent({
      actorId: request.actor.id,
      action: "task.approval_rejected",
      targetType: "task",
      targetId: task.id,
      proposalId: task.proposalId,
      note: `${status}: ${reason}`,
    });
    this.persistState();
    return canceled;
  }

  claimTask(taskId: string, workerId: string): TaskRecord {
    const task = this.requireTask(taskId);
    this.assertTaskWorker(task, workerId, "claim");
    if (task.policyContext?.requiresApproval === true && !task.approval) {
      throw new BrokerError("policy_denied", "task requires operator or hub approval before claim");
    }
    this.assertTaskStatus(task.status, ["queued"], "claim");

    const now = isoNow();
    task.status = "claimed";
    task.attemptId = randomUUID();
    task.claimedBy = workerId;
    task.claimedAt = now;
    task.updatedAt = now;
    this.setTaskRecord(task);
    this.syncExchangeStateFromTask(task, "running");
    this.appendAuditEvent({
      actorId: workerId,
      action: "task.claimed",
      targetType: "task",
      targetId: task.id,
      proposalId: task.proposalId,
      note: task.intent,
    });
    this.persistState();
    this.emitTaskUpdate(task, "claimed");
    return task;
  }

  startTask(taskId: string, workerId: string): TaskRecord {
    const task = this.requireTask(taskId);
    this.assertTaskWorker(task, workerId, "start");
    this.assertTaskStatus(task.status, ["claimed"], "start");

    task.status = "running";
    task.updatedAt = isoNow();
    this.setTaskRecord(task);
    this.syncExchangeStateFromTask(task, "running");
    this.appendAuditEvent({
      actorId: workerId,
      action: "task.started",
      targetType: "task",
      targetId: task.id,
      proposalId: task.proposalId,
      note: task.intent,
    });
    this.persistState();
    this.emitTaskUpdate(task, "started");
    return task;
  }

  completeTask(taskId: string, workerId: string, result?: TaskResult): TaskRecord {
    const task = this.requireTask(taskId);
    this.assertTaskWorker(task, workerId, "complete");

    // Idempotent: if already terminal, return as-is without mutation
    if (isTerminalTaskStatus(task.status)) {
      return task;
    }
    if (task.status !== "claimed" && task.status !== "running") {
      throw new BrokerError("invalid_transition", "cannot complete task while status is " + task.status);
    }

    const normalizedResult = normalizeTaskResult(result);
    this.applyTaskCompletion(task, workerId, normalizedResult);

    const now = isoNow();
    task.status = "succeeded";
    task.claimedBy = workerId;
    task.updatedAt = now;
    task.completedAt = now;
    task.result = normalizedResult;
    task.error = undefined;
    task.artifactIds = uniqueIds([
      ...(task.artifactIds ?? []),
      ...(normalizedResult.artifactIds ?? []),
      ...(normalizedResult.validation?.artifactIds ?? []),
      ...(normalizedResult.apply?.artifactIds ?? []),
    ]);
    this.setTaskRecord(task);
    this.syncExchangeStateFromTask(task, "completed");
    this.appendAuditEvent({
      actorId: workerId,
      action: "task.succeeded",
      targetType: "task",
      targetId: task.id,
      proposalId: task.proposalId,
      note: normalizedResult.note ?? normalizedResult.summary ?? task.intent,
    });
    this.persistState();
    this.emitTaskUpdate(task, "succeeded");
    // Succeeded tasks don't get a tombstone — they completed normally.
    return task;
  }

  failTask(taskId: string, workerId: string, error?: TaskError): TaskRecord {
    const task = this.requireTask(taskId);
    this.assertTaskWorker(task, workerId, "fail");

    // Idempotent: if already terminal, return as-is without mutation
    if (isTerminalTaskStatus(task.status)) {
      return task;
    }
    if (task.status !== "claimed" && task.status !== "running") {
      throw new BrokerError("invalid_transition", "cannot fail task while status is " + task.status);
    }

    const now = isoNow();
    const normalizedError = normalizeTaskError(error);
    task.status = "failed";
    task.claimedBy = workerId;
    task.updatedAt = now;
    task.completedAt = now;
    task.error = normalizedError;
    this.setTaskRecord(task);
    this.syncExchangeStateFromTask(task, "failed");
    this.appendAuditEvent({
      actorId: workerId,
      action: "task.failed",
      targetType: "task",
      targetId: task.id,
      proposalId: task.proposalId,
      note: normalizedError.message,
    });
    this.persistState();
    this.emitTaskUpdate(task, "failed");
    this.writeTombstone(task, "failed");
    return task;
  }

  requeueStaleTasks(
    olderThanMs: number,
    options?: {
      nowMs?: number;
      workerOfflineAfterMs?: number;
    },
  ): TaskRecord[] {
    const result = this.requeueStaleTasksDetailed(olderThanMs, options);
    return result.requeued;
  }

  /**
   * Same as {@link requeueStaleTasks} but also surfaces the tasks that were dead-lettered to
   * `failed` because they exceeded `maxRequeueAttempts`. Kept as a separate method so the
   * existing public `requeueStaleTasks` signature stays backwards-compatible for the manual
   * `POST /tasks/requeue_stale` response and the in-process stale reaper.
   */
  requeueStaleTasksDetailed(
    olderThanMs: number,
    options?: {
      nowMs?: number;
      workerOfflineAfterMs?: number;
    },
  ): { requeued: TaskRecord[]; deadLettered: TaskRecord[] } {
    const thresholdMs = Math.max(0, olderThanMs);
    const nowMs = options?.nowMs ?? Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const staleWorkerIds =
      options?.workerOfflineAfterMs && options.workerOfflineAfterMs >= 0
        ? new Set(this.listStaleWorkerIds(options.workerOfflineAfterMs, nowMs))
        : new Set<string>();
    const requeued: TaskRecord[] = [];
    const deadLettered: TaskRecord[] = [];

    for (const task of this.tasks.values()) {
      const requeueReason = getTaskRequeueReason(task, thresholdMs, staleWorkerIds, nowMs);
      if (!requeueReason) {
        continue;
      }

      const currentRequeues = task.requeueCount ?? 0;
      const previousStatus = task.status;

      if (this.maxRequeueAttempts > 0 && currentRequeues >= this.maxRequeueAttempts) {
        // Dead-letter: mark failed so operators see the real state instead of an endless
        // requeue loop. Preserve `claimedBy` and the final `requeueCount` for forensics.
        task.status = "failed";
        task.updatedAt = nowIso;
        task.completedAt = nowIso;
        task.error = {
          code: REQUEUE_EXHAUSTED_ERROR_CODE,
          message: `dead-lettered after ${currentRequeues} automatic requeue${
            currentRequeues === 1 ? "" : "s"
          }: ${requeueReason}`,
          details: {
            requeueCount: currentRequeues,
            maxRequeueAttempts: this.maxRequeueAttempts,
            previousStatus,
            lastRequeueReason: requeueReason,
          },
        };
        this.setTaskRecord(task);
        this.syncExchangeStateFromTask(task, "failed");
        this.appendAuditEvent({
          actorId: "broker",
          action: "task.failed",
          targetType: "task",
          targetId: task.id,
          proposalId: task.proposalId,
          note: task.error.message,
        });
        deadLettered.push(task);
        this.writeTombstone(task, "dead_lettered");
        continue;
      }

      task.status = "queued";
      task.claimedBy = undefined;
      task.claimedAt = undefined;
      task.completedAt = undefined;
      task.attemptId = undefined;
      task.updatedAt = nowIso;
      task.requeueCount = currentRequeues + 1;
      this.setTaskRecord(task);
      this.syncExchangeStateFromTask(task, "queued");
      this.appendAuditEvent({
        actorId: "broker",
        action: "task.requeued",
        targetType: "task",
        targetId: task.id,
        proposalId: task.proposalId,
        note: `requeued ${previousStatus} task without reassignment (attempt ${task.requeueCount}): ${requeueReason}`,
      });
      requeued.push(task);
    }

    if (requeued.length > 0 || deadLettered.length > 0) {
      this.persistState();
    }

    for (const task of deadLettered) {
      this.emitTaskUpdate(task, "dead_lettered");
    }
    for (const task of requeued) {
      this.emitTaskUpdate(task, "requeued");
    }

    return { requeued, deadLettered };
  }

  private listStaleWorkerIds(offlineAfterMs: number, nowMs: number): string[] {
    return [...this.workers.values()]
      .filter((worker) => isWorkerStale(worker.lastSeenAt, offlineAfterMs, nowMs))
      .map((worker) => worker.nodeId);
  }

  listArtifactsForProposal(proposalId: string): ArtifactRecord[] {
    return sortedCopy(
      [...this.artifacts.values()].filter((artifact) => artifact.proposalId === proposalId),
      sortNewestFirst,
    );
  }

  listValidationsForProposal(proposalId: string): ValidationResult[] {
    return sortedCopy(
      [...this.validations.values()].filter((validation) => validation.proposalId === proposalId),
      sortNewestFirst,
    );
  }

  listAuditEvents(filters?: AuditListFilters): AuditEvent[] {
    return sortedCopy(
      [...this.auditEvents.values()].filter((event) => {
        if (filters?.proposalId && event.proposalId !== filters.proposalId) {
          return false;
        }
        if (filters?.actorId && event.actorId !== filters.actorId) {
          return false;
        }
        if (filters?.action && event.action !== filters.action) {
          return false;
        }
        if (filters?.targetId && event.targetId !== filters.targetId) {
          return false;
        }
        return true;
      }),
      sortNewestFirst,
    );
  }


  getDashboard(options?: {
    nowMs?: number;
    offlineAfterMs?: number;
    recentHistoryLimit?: number;
    oldestPendingLimit?: number;
    pendingActionLimit?: number;
  }): BrokerDashboard {
    const nowMs = options?.nowMs ?? Date.now();
    const offlineAfterMs = options?.offlineAfterMs ?? 90_000;
    const recentHistoryLimit = options?.recentHistoryLimit ?? 10;
    const oldestPendingLimit = options?.oldestPendingLimit ?? 5;
    const pendingActionLimit = options?.pendingActionLimit ?? 5;

    const allTasks = [...this.tasks.values()];
    const allProposals = [...this.proposals.values()];
    const allWorkers = [...this.workers.values()];
    const staleWorkerIds = new Set(this.listStaleWorkerIds(offlineAfterMs, nowMs));

    // --- Queue ---
    const pendingTasks = allTasks.filter(
      (t) => t.status === "blocked" || t.status === "queued" || t.status === "claimed",
    );
    const oldestPending = sortedCopy(
      pendingTasks,
      (a, b) => taskStatusSinceAt(a).localeCompare(taskStatusSinceAt(b)),
    ).slice(0, oldestPendingLimit);
    const queue: TaskQueueSummary = {
      total: pendingTasks.length,
      byStatus: this.countBy(allTasks, (t) => t.status) as Record<TaskStatus, number>,
      byIntent: this.countBy(allTasks, (t) => t.intent),
      oldestPending: oldestPending.map((t) => ({
        id: t.id,
        intent: t.intent,
        status: t.status,
        targetNodeId: t.targetNodeId,
        assignedWorkerId: t.assignedWorkerId,
        createdAt: t.createdAt,
        statusSinceAt: taskStatusSinceAt(t),
        statusAgeSec: ageSecFromIso(taskStatusSinceAt(t), nowMs),
      })),
    };

    // --- History ---
    const oneHourAgoMs = nowMs - 3_600_000;
    const completedTasks = allTasks.filter(
      (t) => t.status === "succeeded" && t.completedAt && Date.parse(t.completedAt) >= oneHourAgoMs,
    );
    const failedTasks = allTasks.filter(
      (t) => t.status === "failed" && t.completedAt && Date.parse(t.completedAt) >= oneHourAgoMs,
    );
    const recentOutcomes = sortedCopy(
      allTasks.filter((t) => (t.status === "succeeded" || t.status === "failed") && t.completedAt),
      (a, b) => {
        const cmp = (b.completedAt ?? "").localeCompare(a.completedAt ?? "");
        if (cmp !== 0) {
          return cmp;
        }
        const cmp2 = b.createdAt.localeCompare(a.createdAt);
        if (cmp2 !== 0) {
          return cmp2;
        }
        return b.id.localeCompare(a.id);
      },
    ).slice(0, recentHistoryLimit);
    const history: TaskHistorySummary = {
      completedLastHour: completedTasks.length,
      failedLastHour: failedTasks.length,
      totalCompleted: allTasks.filter((t) => t.status === "succeeded").length,
      totalFailed: allTasks.filter((t) => t.status === "failed").length,
      recent: recentOutcomes.map((t) => ({
        id: t.id,
        intent: t.intent,
        status: t.status,
        targetNodeId: t.targetNodeId,
        completedAt: t.completedAt!,
        result: t.result,
        error: t.error,
      })),
    };

    // --- Proposals ---
    const actionableStatuses = new Set<ProposalStatus>(["submitted", "validated", "approved"]);
    const pendingAction = sortedCopy(
      allProposals.filter((p) => actionableStatuses.has(p.status)),
      (a, b) => a.updatedAt.localeCompare(b.updatedAt),
    ).slice(0, pendingActionLimit)
      .map((p) => ({
        id: p.id,
        kind: p.kind,
        summary: p.summary,
        status: p.status,
        sourceNodeId: p.sourceNodeId,
        targetNodeId: p.targetNodeId,
        updatedAt: p.updatedAt,
      }));
    const proposals: ProposalPipelineSummary = {
      total: allProposals.length,
      byStatus: this.countBy(allProposals, (p) => p.status) as Record<ProposalStatus, number>,
      pendingAction,
    };

    // --- Workers ---
    let onlineCount = 0;
    let staleCount = 0;
    const byNode = allWorkers.map((w) => {
      const isStale = isWorkerStale(w.lastSeenAt, offlineAfterMs, nowMs);
      const status: WorkerFleetSummary["byNode"][number]["status"] = isStale ? "stale" : "online";
      if (isStale) {
        staleCount++;
      } else {
        onlineCount++;
      }
      return {
        nodeId: w.nodeId,
        role: w.role,
        displayName: w.displayName,
        status,
        activeTaskCount: allTasks.filter(
          (t) =>
            t.status === "claimed" || t.status === "running"
              ? t.assignedWorkerId === w.nodeId || t.targetNodeId === w.nodeId
              : false,
        ).length,
        lastSeenAt: w.lastSeenAt,
        lastSeenAgeSec: ageSecFromIso(w.lastSeenAt, nowMs),
      };
    });
    const workers: WorkerFleetSummary = {
      total: allWorkers.length,
      online: onlineCount,
      stale: staleCount,
      byNode,
    };

    const claimedTasks = allTasks.filter((task) => task.status === "claimed");
    const runningTasks = allTasks.filter((task) => task.status === "running");
    const oldestClaimedTask = sortedCopy(
      claimedTasks,
      (a, b) => taskStatusSinceAt(a).localeCompare(taskStatusSinceAt(b)),
    )[0];
    const oldestRunningTask = sortedCopy(
      runningTasks,
      (a, b) => taskStatusSinceAt(a).localeCompare(taskStatusSinceAt(b)),
    )[0];
    const staleWorkerAssignments = allTasks.filter((task) => {
      const workerId = task.assignedWorkerId ?? task.targetNodeId;
      return (
        (task.status === "claimed" || task.status === "running") &&
        typeof workerId === "string" &&
        staleWorkerIds.has(workerId)
      );
    }).length;
    const recentRequeueEvents = this.listAuditEvents({ action: "task.requeued" })
      .slice(0, 5)
      .map((event) => ({
        taskId: event.targetId,
        actorId: event.actorId,
        createdAt: event.createdAt,
        note: event.note,
      }));
    const deadLetteredTasks = sortedCopy(
      allTasks.filter(
        (task) => task.status === "failed" && task.error?.code === "exceeded_requeue_limit",
      ),
      (a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""),
    );
    const observability = {
      queuePressure: {
        blocked: queue.byStatus.blocked ?? 0,
        queued: queue.byStatus.queued ?? 0,
        claimed: queue.byStatus.claimed ?? 0,
        running: queue.byStatus.running ?? 0,
        staleWorkerAssignments,
        oldestClaimed: oldestClaimedTask
          ? {
              id: oldestClaimedTask.id,
              intent: oldestClaimedTask.intent,
              targetNodeId: oldestClaimedTask.targetNodeId,
              assignedWorkerId: oldestClaimedTask.assignedWorkerId,
              createdAt: oldestClaimedTask.createdAt,
              statusSinceAt: taskStatusSinceAt(oldestClaimedTask),
              statusAgeSec: ageSecFromIso(taskStatusSinceAt(oldestClaimedTask), nowMs),
            }
          : undefined,
        oldestRunning: oldestRunningTask
          ? {
              id: oldestRunningTask.id,
              intent: oldestRunningTask.intent,
              targetNodeId: oldestRunningTask.targetNodeId,
              assignedWorkerId: oldestRunningTask.assignedWorkerId,
              createdAt: oldestRunningTask.createdAt,
              statusSinceAt: taskStatusSinceAt(oldestRunningTask),
              statusAgeSec: ageSecFromIso(taskStatusSinceAt(oldestRunningTask), nowMs),
            }
          : undefined,
      },
      recovery: {
        totalRequeued: this.listAuditEvents({ action: "task.requeued" }).length,
        totalDeadLettered: deadLetteredTasks.length,
        recentRequeues: recentRequeueEvents,
        recentDeadLetters: deadLetteredTasks.slice(0, 5).map((task) => ({
          id: task.id,
          intent: task.intent,
          targetNodeId: task.targetNodeId,
          assignedWorkerId: task.assignedWorkerId,
          completedAt: task.completedAt,
          error: task.error,
          requeueCount: task.requeueCount,
        })),
      },
      workerHealth: {
        staleWorkersWithActiveTasks: byNode
          .filter((worker) => worker.status === "stale" && worker.activeTaskCount > 0)
          .map((worker) => ({
            nodeId: worker.nodeId,
            activeTaskCount: worker.activeTaskCount,
            lastSeenAt: worker.lastSeenAt,
            lastSeenAgeSec: worker.lastSeenAgeSec,
          })),
      },
    };

    return {
      generatedAt: new Date(nowMs).toISOString(),
      queue,
      history,
      proposals,
      workers,
      observability,
    };
  }

  private countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
    const result: Record<string, number> = {};
    for (const item of items) {
      const k = key(item);
      result[k] = (result[k] ?? 0) + 1;
    }
    return result;
  }

  exportSnapshot(): BrokerSnapshot {
    return {
      version: CURRENT_BROKER_STATE_VERSION,
      exchanges: [...this.exchanges.values()],
      exchangeMessages: [...this.exchangeMessages.values()],
      proposals: [...this.proposals.values()],
      artifacts: [...this.artifacts.values()],
      validations: [...this.validations.values()],
      auditEvents: [...this.auditEvents.values()],
      workers: [...this.workers.values()],
      tasks: [...this.tasks.values()],
      tombstones: [...this.tombstones.values()],
    };
  }

  private applyRetentionPolicy(nowMs = Date.now()): void {
    const retainedExchangeIds = selectRetainedTerminalRecordIds({
      records: [...this.exchanges.values()],
      isTerminal: (exchange) => isTerminalExchangeStatus(exchange.status),
      getId: (exchange) => exchange.id,
      getTimestamp: (exchange) => exchange.updatedAt,
      nowMs,
      retentionMs: this.retentionPolicy.terminalRetentionMs,
      maxTerminalRecords: this.retentionPolicy.maxTerminalExchanges,
    });

    const protectedTaskIds = new Set<string>();
    for (const exchangeId of retainedExchangeIds) {
      const activeTaskId = this.exchanges.get(exchangeId)?.activeTaskId;
      if (activeTaskId) {
        protectedTaskIds.add(activeTaskId);
      }
    }

    const retainedTaskIds = selectRetainedTerminalRecordIds({
      records: [...this.tasks.values()],
      isTerminal: (task) => isTerminalTaskStatus(task.status),
      getId: (task) => task.id,
      getTimestamp: (task) => task.completedAt ?? task.updatedAt,
      nowMs,
      retentionMs: this.retentionPolicy.terminalRetentionMs,
      maxTerminalRecords: this.retentionPolicy.maxTerminalTasks,
      protectedIds: protectedTaskIds,
    });

    for (const taskId of retainedTaskIds) {
      const exchangeId = this.tasks.get(taskId)?.exchangeId;
      if (exchangeId) {
        retainedExchangeIds.add(exchangeId);
      }
    }

    const protectedProposalIds = new Set<string>();
    for (const taskId of retainedTaskIds) {
      const proposalId = this.tasks.get(taskId)?.proposalId;
      if (proposalId) {
        protectedProposalIds.add(proposalId);
      }
    }

    const retainedProposalIds = selectRetainedTerminalRecordIds({
      records: [...this.proposals.values()],
      isTerminal: (proposal) => isTerminalProposalStatus(proposal.status),
      getId: (proposal) => proposal.id,
      getTimestamp: (proposal) => proposal.updatedAt,
      nowMs,
      retentionMs: this.retentionPolicy.terminalRetentionMs,
      maxTerminalRecords: this.retentionPolicy.maxTerminalProposals,
      protectedIds: protectedProposalIds,
    });

    const retainedArtifactIds = this.collectRetainedArtifactIds({
      retainedTaskIds,
      retainedProposalIds,
    });
    const retainedValidationIds = this.collectRetainedValidationIds(retainedProposalIds);
    const retainedMessageIds = this.collectRetainedExchangeMessageIds(retainedExchangeIds);

    const retainedWorkerIds = selectRetainedWorkerIds({
      workers: [...this.workers.values()],
      nowMs,
      inactiveWorkerRetentionMs: this.retentionPolicy.inactiveWorkerRetentionMs,
      maxInactiveWorkers: this.retentionPolicy.maxInactiveWorkers,
      protectedIds: this.collectProtectedWorkerIds({
        retainedExchangeIds,
        retainedTaskIds,
        retainedProposalIds,
      }),
    });

    const retainedAuditEventIds = selectRetainedAuditEventIds({
      auditEvents: [...this.auditEvents.values()],
      nowMs,
      auditRetentionMs: this.retentionPolicy.auditRetentionMs,
      maxAuditEvents: this.retentionPolicy.maxAuditEvents,
      retainedProposalIds,
      retainedTaskIds,
      retainedExchangeIds,
      retainedMessageIds,
      retainedArtifactIds,
      retainedValidationIds,
      retainedWorkerIds,
    });

    pruneMapEntries(this.exchanges, retainedExchangeIds);
    pruneMapEntries(this.exchangeMessages, retainedMessageIds);
    pruneMapEntries(this.tasks, retainedTaskIds);
    pruneMapEntries(this.proposals, retainedProposalIds);
    pruneMapEntries(this.artifacts, retainedArtifactIds);
    pruneMapEntries(this.validations, retainedValidationIds);
    pruneMapEntries(this.workers, retainedWorkerIds);
    pruneMapEntries(this.auditEvents, retainedAuditEventIds);
  }

  private collectRetainedExchangeMessageIds(retainedExchangeIds: Set<string>): Set<string> {
    const retainedMessageIds = new Set<string>();
    for (const message of this.exchangeMessages.values()) {
      if (retainedExchangeIds.has(message.exchangeId)) {
        retainedMessageIds.add(message.id);
      }
    }
    return retainedMessageIds;
  }

  private collectRetainedArtifactIds(params: {
    retainedTaskIds: Set<string>;
    retainedProposalIds: Set<string>;
  }): Set<string> {
    const retainedArtifactIds = new Set<string>();

    for (const proposalId of params.retainedProposalIds) {
      const proposal = this.proposals.get(proposalId);
      for (const artifactId of proposal?.artifactIds ?? []) {
        retainedArtifactIds.add(artifactId);
      }
    }

    for (const artifact of this.artifacts.values()) {
      if (params.retainedProposalIds.has(artifact.proposalId)) {
        retainedArtifactIds.add(artifact.id);
      }
    }

    for (const taskId of params.retainedTaskIds) {
      const task = this.tasks.get(taskId);
      for (const artifactId of task?.artifactIds ?? []) {
        retainedArtifactIds.add(artifactId);
      }
      for (const artifactId of task?.result?.artifactIds ?? []) {
        retainedArtifactIds.add(artifactId);
      }
      for (const artifactId of task?.result?.validation?.artifactIds ?? []) {
        retainedArtifactIds.add(artifactId);
      }
      for (const artifactId of task?.result?.apply?.artifactIds ?? []) {
        retainedArtifactIds.add(artifactId);
      }
    }

    return retainedArtifactIds;
  }

  private collectRetainedValidationIds(retainedProposalIds: Set<string>): Set<string> {
    const retainedValidationIds = new Set<string>();
    for (const validation of this.validations.values()) {
      if (retainedProposalIds.has(validation.proposalId)) {
        retainedValidationIds.add(validation.id);
      }
    }
    return retainedValidationIds;
  }

  private collectProtectedWorkerIds(params: {
    retainedExchangeIds: Set<string>;
    retainedTaskIds: Set<string>;
    retainedProposalIds: Set<string>;
  }): Set<string> {
    const retainedWorkerIds = new Set<string>();

    for (const exchangeId of params.retainedExchangeIds) {
      const exchange = this.exchanges.get(exchangeId);
      if (!exchange) {
        continue;
      }
      retainedWorkerIds.add(exchange.targetNodeId);
      if (exchange.assignedWorkerId) {
        retainedWorkerIds.add(exchange.assignedWorkerId);
      }
      retainedWorkerIds.add(exchange.target.id);
    }

    for (const taskId of params.retainedTaskIds) {
      const task = this.tasks.get(taskId);
      if (!task) {
        continue;
      }
      retainedWorkerIds.add(task.targetNodeId);
      retainedWorkerIds.add(task.target.id);
      if (task.assignedWorkerId) {
        retainedWorkerIds.add(task.assignedWorkerId);
      }
      if (task.claimedBy) {
        retainedWorkerIds.add(task.claimedBy);
      }
    }

    for (const proposalId of params.retainedProposalIds) {
      const proposal = this.proposals.get(proposalId);
      if (!proposal) {
        continue;
      }
      retainedWorkerIds.add(proposal.sourceNodeId);
      retainedWorkerIds.add(proposal.targetNodeId);
      retainedWorkerIds.add(proposal.source.id);
      retainedWorkerIds.add(proposal.target.id);
    }

    return retainedWorkerIds;
  }

  private loadSnapshot(snapshot: BrokerSnapshot): void {
    for (const exchange of snapshot.exchanges) {
      const normalizedExchange = normalizeExchangeState(exchange);
      this.exchanges.set(normalizedExchange.id, normalizedExchange);
    }

    for (const message of snapshot.exchangeMessages ?? []) {
      this.exchangeMessages.set(message.id, normalizeExchangeMessageRecord(message));
    }

    for (const exchange of this.exchanges.values()) {
      if (exchange.rootMessageId) {
        continue;
      }

      const syntheticRoot = createLegacyRootExchangeMessage(exchange);
      this.exchangeMessages.set(syntheticRoot.id, syntheticRoot);
      exchange.rootMessageId = syntheticRoot.id;
      exchange.messageCount = Math.max(exchange.messageCount ?? 0, 1);
      exchange.lastMessageAt = exchange.lastMessageAt ?? exchange.updatedAt;
      this.exchanges.set(exchange.id, exchange);
    }

    for (const proposal of snapshot.proposals) {
      this.proposals.set(proposal.id, proposal);
    }

    for (const artifact of snapshot.artifacts) {
      this.artifacts.set(artifact.id, artifact);
    }

    for (const validation of snapshot.validations) {
      this.validations.set(validation.id, validation);
    }

    for (const auditEvent of snapshot.auditEvents) {
      this.auditEvents.set(auditEvent.id, auditEvent);
    }

    for (const worker of snapshot.workers ?? []) {
      const normalizedWorker = normalizeWorkerRecord(worker);
      this.workers.set(normalizedWorker.nodeId, normalizedWorker);
    }

    for (const task of snapshot.tasks ?? []) {
      this.tasks.set(task.id, normalizeTaskRecord(task));
    }

    for (const tombstone of snapshot.tombstones ?? []) {
      this.tombstones.set(tombstone.taskId, tombstone);
    }

    this.applyRetentionPolicy();
  }

  private persistState(): void {
    this.applyRetentionPolicy();
    const snapshot = this.exportSnapshot();
    const hints = this.consumeStateSaveHints(snapshot);
    this.stateStore?.save(snapshot, hints);
    this.emitStateChange();
  }

  private setTaskRecord(task: TaskRecord): void {
    this.taskRepository?.upsertTask(structuredClone(task));
    this.tasks.set(task.id, task);
    this.pendingHotTasks.set(task.id, structuredClone(task));
  }

  private setExchangeRecord(exchange: A2AExchangeState): void {
    this.exchanges.set(exchange.id, exchange);
    this.pendingHotExchanges.set(exchange.id, structuredClone(exchange));
  }

  private setExchangeMessageRecord(message: A2AExchangeMessageRecord): void {
    this.exchangeMessages.set(message.id, message);
    this.pendingHotExchangeMessages.set(message.id, structuredClone(message));
  }

  private setProposalRecord(proposal: ChangeProposal): void {
    this.proposals.set(proposal.id, proposal);
    this.pendingHotProposals.set(proposal.id, structuredClone(proposal));
  }

  private setArtifactRecord(artifact: ArtifactRecord): void {
    this.artifacts.set(artifact.id, artifact);
    this.pendingHotArtifacts.set(artifact.id, structuredClone(artifact));
  }

  private setValidationRecord(validation: ValidationResult): void {
    this.validations.set(validation.id, validation);
    this.pendingHotValidations.set(validation.id, structuredClone(validation));
  }

  private setWorkerRecord(worker: WorkerRecord): void {
    const normalizedWorker = normalizeWorkerRecord(worker);
    this.workerRepository?.upsertWorker(structuredClone(normalizedWorker));
    this.workers.set(normalizedWorker.nodeId, normalizedWorker);
    this.pendingHotWorkers.set(normalizedWorker.nodeId, structuredClone(normalizedWorker));
  }

  private consumeStateSaveHints(snapshot: BrokerSnapshot): BrokerStateSaveHints | undefined {
    if (
      this.pendingHotExchanges.size === 0 &&
      this.pendingHotExchangeMessages.size === 0 &&
      this.pendingHotProposals.size === 0 &&
      this.pendingHotArtifacts.size === 0 &&
      this.pendingHotValidations.size === 0 &&
      this.pendingHotTasks.size === 0 &&
      this.pendingHotTombstones.size === 0 &&
      this.pendingHotAuditEvents.size === 0 &&
      this.pendingHotWorkers.size === 0
    ) {
      return undefined;
    }
    const retainedExchangeIds = new Set(snapshot.exchanges.map((exchange) => exchange.id));
    const retainedExchangeMessageIds = new Set(snapshot.exchangeMessages.map((message) => message.id));
    const retainedProposalIds = new Set(snapshot.proposals.map((proposal) => proposal.id));
    const retainedArtifactIds = new Set(snapshot.artifacts.map((artifact) => artifact.id));
    const retainedValidationIds = new Set(snapshot.validations.map((validation) => validation.id));
    const retainedTaskIds = new Set(snapshot.tasks.map((task) => task.id));
    const retainedTombstoneTaskIds = new Set((snapshot.tombstones ?? []).map((tombstone) => tombstone.taskId));
    const retainedAuditEventIds = new Set(snapshot.auditEvents.map((event) => event.id));
    const retainedWorkerIds = new Set(snapshot.workers.map((worker) => worker.nodeId));
    const hotExchanges = [...this.pendingHotExchanges.values()].filter((exchange) => retainedExchangeIds.has(exchange.id));
    const hotExchangeMessages = [...this.pendingHotExchangeMessages.values()].filter((message) => retainedExchangeMessageIds.has(message.id));
    const hotProposals = [...this.pendingHotProposals.values()].filter((proposal) => retainedProposalIds.has(proposal.id));
    const hotArtifacts = [...this.pendingHotArtifacts.values()].filter((artifact) => retainedArtifactIds.has(artifact.id));
    const hotValidations = [...this.pendingHotValidations.values()].filter((validation) => retainedValidationIds.has(validation.id));
    const hotTasks = [...this.pendingHotTasks.values()].filter((task) => retainedTaskIds.has(task.id));
    const hotTombstones = [...this.pendingHotTombstones.values()].filter((tombstone) => retainedTombstoneTaskIds.has(tombstone.taskId));
    const hotAuditEvents = [...this.pendingHotAuditEvents.values()].filter((event) => retainedAuditEventIds.has(event.id));
    const hotWorkers = [...this.pendingHotWorkers.values()].filter((worker) => retainedWorkerIds.has(worker.nodeId));
    this.pendingHotExchanges.clear();
    this.pendingHotExchangeMessages.clear();
    this.pendingHotProposals.clear();
    this.pendingHotArtifacts.clear();
    this.pendingHotValidations.clear();
    this.pendingHotTasks.clear();
    this.pendingHotTombstones.clear();
    this.pendingHotAuditEvents.clear();
    this.pendingHotWorkers.clear();
    return {
      ...(hotExchanges.length ? { hotExchanges } : {}),
      ...(hotExchangeMessages.length ? { hotExchangeMessages } : {}),
      ...(hotProposals.length ? { hotProposals } : {}),
      ...(hotArtifacts.length ? { hotArtifacts } : {}),
      ...(hotValidations.length ? { hotValidations } : {}),
      ...(hotTasks.length ? { hotTasks } : {}),
      ...(hotTombstones.length ? { hotTombstones } : {}),
      ...(hotAuditEvents.length ? { hotAuditEvents } : {}),
      ...(hotWorkers.length ? { hotWorkers } : {}),
    };
  }

  private emitStateChange(): void {
    for (const listener of [...this.stateListeners]) {
      try {
        listener();
      } catch (error) {
        console.error(
          `[a2a-broker] broker state listener threw: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  private appendAuditEvent(input: {
    actorId: string;
    action: AuditAction;
    targetType: AuditEvent["targetType"];
    targetId: string;
    proposalId?: string;
    note?: string;
  }): AuditEvent {
    const event: AuditEvent = {
      id: randomUUID(),
      actorId: input.actorId,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      proposalId: input.proposalId,
      note: input.note,
      createdAt: isoNow(),
    };

    this.auditEvents.set(event.id, event);
    this.pendingHotAuditEvents.set(event.id, structuredClone(event));
    if (event.targetType === "task") {
      const task = this.tasks.get(event.targetId);
      if (task) {
        this.taskEventStream.push(event, task);
      }
    }
    return event;
  }

  private requireProposal(id: string): ChangeProposal {
    const proposal = this.proposals.get(id);
    if (!proposal) {
      throw new BrokerError("not_found", "proposal not found");
    }
    return proposal;
  }

  private requireExchange(id: string): A2AExchangeState {
    const exchange = this.exchanges.get(id);
    if (!exchange) {
      throw new BrokerError("not_found", "exchange not found");
    }
    return exchange;
  }

  private requireWorker(nodeId: string): WorkerRecord {
    const worker = this.getWorker(nodeId);
    if (!worker) {
      throw new BrokerError("not_found", "worker not found");
    }
    return worker;
  }

  private requireTask(id: string): TaskRecord {
    const task = this.getTask(id);
    if (!task) {
      throw new BrokerError("not_found", "task not found");
    }
    return task;
  }

  private requireExchangeMessage(exchangeId: string, messageId: string): A2AExchangeMessageRecord {
    const message = this.exchangeMessages.get(messageId);
    if (!message || message.exchangeId !== exchangeId) {
      throw new BrokerError("not_found", "exchange message not found");
    }
    return message;
  }

  private assertExchangeMessageActor(
    exchange: A2AExchangeState,
    request: A2AExchangeMessageRequest,
  ): void {
    const actor = request.actor;
    const isPrivileged = actor.role === "hub" || actor.role === "operator";
    const isRequester = actor.id === exchange.requester.id;
    const isTarget = actor.id === exchange.target.id;

    if (!isPrivileged && !isRequester && !isTarget) {
      throw new BrokerError(
        "policy_denied",
        "exchange messages require the requester, target, hub, or operator actor",
      );
    }

    if (isRequester && exchange.requester.role && actor.role && exchange.requester.role !== actor.role) {
      throw new BrokerError("policy_denied", "requester actor role must match the exchange requester role");
    }

    if (isTarget && exchange.target.role && actor.role && exchange.target.role !== actor.role) {
      throw new BrokerError("policy_denied", "target actor role must match the exchange target role");
    }

    if ((request.targetNodeId || request.assignedWorkerId) && !isPrivileged) {
      throw new BrokerError("policy_denied", "only hub or operator actors may change assignment fields");
    }

    if (request.decision && !isPrivileged && !isTarget) {
      throw new BrokerError("policy_denied", "only the target, hub, or operator actor may set a decision");
    }
  }

  private applyExchangeMessageDecision(
    exchange: A2AExchangeState,
    message: A2AExchangeMessageRecord,
  ): void {
    exchange.targetNodeId = message.targetNodeId ?? exchange.targetNodeId ?? exchange.target.id;
    exchange.assignedWorkerId = message.assignedWorkerId ?? exchange.assignedWorkerId;
    exchange.currentDecision = message.decision ?? exchange.currentDecision;

    const targetWorker = this.workers.get(exchange.targetNodeId);
    if (targetWorker) {
      exchange.target = {
        id: targetWorker.nodeId,
        kind: "node",
        role: targetWorker.role,
      };
    }

    if (!message.decision) {
      if (message.targetNodeId || message.assignedWorkerId) {
        const assignedWorkerId = exchange.assignedWorkerId ?? exchange.targetNodeId;
        this.ensureExchangeTask(exchange, message, assignedWorkerId);
        exchange.status = "queued";
      }
      return;
    }

    if (message.decision === "accepted" || message.decision === "partially_accepted") {
      const assignedWorkerId = exchange.assignedWorkerId ?? exchange.targetNodeId;
      exchange.assignedWorkerId = assignedWorkerId;
      exchange.status = "running";
      this.ensureExchangeTask(exchange, message, assignedWorkerId);
      return;
    }

    if (message.decision === "needs_clarification") {
      exchange.status = "queued";
      this.cancelActiveExchangeTask(exchange, `decision=${message.decision}`);
      return;
    }

    exchange.status = "failed";
    this.cancelActiveExchangeTask(exchange, `decision=${message.decision}`);
    exchange.status = "failed";
  }

  private ensureExchangeTask(
    exchange: A2AExchangeState,
    message: A2AExchangeMessageRecord,
    assignedWorkerId: string,
  ): void {
    const current = exchange.activeTaskId ? this.tasks.get(exchange.activeTaskId) ?? null : null;
    const assignedWorker = this.requireWorker(assignedWorkerId);
    const targetWorker = this.requireWorker(exchange.targetNodeId);

    if (current && current.status !== "succeeded" && current.status !== "failed" && current.status !== "canceled") {
      if (
        current.targetNodeId !== exchange.targetNodeId ||
        current.assignedWorkerId !== assignedWorkerId
      ) {
        this.reassignTask(current.id, {
          actor: message.actor ?? { id: "broker", role: "hub", kind: "service" },
          targetNodeId: exchange.targetNodeId,
          assignedWorkerId,
          note: `exchange ${exchange.id} synchronized from thread message ${message.id}`,
        });
      }
      exchange.status = "running";
      return;
    }

    const task = this.createTask({
      exchangeId: exchange.id,
      intent: exchange.intent,
      requester: exchange.requester,
      target: {
        id: targetWorker.nodeId,
        kind: "node",
        role: targetWorker.role,
      },
      assignedWorkerId: assignedWorker.nodeId,
      message: message.message,
      via: message.via,
    });
    exchange.activeTaskId = task.id;
    exchange.assignedWorkerId = assignedWorker.nodeId;
    exchange.targetNodeId = targetWorker.nodeId;
    exchange.target = {
      id: targetWorker.nodeId,
      kind: "node",
      role: targetWorker.role,
    };
  }

  private cancelActiveExchangeTask(exchange: A2AExchangeState, reason: string): void {
    if (!exchange.activeTaskId) {
      return;
    }
    const task = this.tasks.get(exchange.activeTaskId);
    if (!task) {
      return;
    }
    if (task.status === "succeeded" || task.status === "failed" || task.status === "canceled") {
      return;
    }
    this.cancelTaskRecord(task, {
      actorId: "broker",
      reason,
    });
  }

  private cancelTaskRecord(
    task: TaskRecord,
    params: {
      actorId: string;
      reason?: string;
      sourceTaskId?: string;
    },
  ): TaskRecord {
    const canceledAt = isoNow();
    task.status = "canceled";
    task.claimedBy = undefined;
    task.claimedAt = undefined;
    task.completedAt = canceledAt;
    task.updatedAt = canceledAt;
    task.result = undefined;
    task.error = undefined;
    task.cancellation = {
      requestedAt: canceledAt,
      requestedBy: params.actorId,
      reason: params.reason,
      sourceTaskId: params.sourceTaskId,
    };
    this.setTaskRecord(task);
    this.syncExchangeStateFromTask(task, "queued");
    this.appendAuditEvent({
      actorId: params.actorId,
      action: "task.canceled",
      targetType: "task",
      targetId: task.id,
      proposalId: task.proposalId,
      note: params.reason,
    });
    this.persistState();
    this.emitTaskUpdate(task, "canceled");
    this.writeTombstone(task, "canceled", { actorId: params.actorId, reason: params.reason });
    return task;
  }

  private cancelTaskTree(
    task: TaskRecord,
    params: {
      actorId: string;
      reason?: string;
      sourceTaskId?: string;
    },
    visited = new Set<string>(),
  ): TaskRecord {
    if (visited.has(task.id)) {
      return task;
    }
    visited.add(task.id);

    const canceledTask = this.cancelTaskRecord(task, params);
    for (const childTask of this.listChildTasks(task.id)) {
      if (isTerminalTaskStatus(childTask.status)) {
        continue;
      }
      this.cancelTaskTree(
        childTask,
        {
          actorId: params.actorId,
          reason: params.reason,
          sourceTaskId: task.id,
        },
        visited,
      );
    }

    return canceledTask;
  }

  private listChildTasks(parentTaskId: string): TaskRecord[] {
    return sortedCopy(
      [...this.tasks.values()].filter((task) => task.parentTaskId === parentTaskId),
      sortNewestFirst,
    );
  }

  // --- Task Heartbeat ---

  /** Record a task-level heartbeat from the assigned worker. */
  heartbeatTask(taskId: string, workerId: string): TaskRecord {
    const task = this.requireTask(taskId);
    this.assertTaskWorker(task, workerId, "heartbeat");
    this.assertTaskStatus(task.status, ["claimed", "running"], "heartbeat");

    const now = isoNow();
    task.lastHeartbeatAt = now;
    task.updatedAt = now;
    this.setTaskRecord(task);
    this.appendAuditEvent({
      actorId: workerId,
      action: "task.heartbeat",
      targetType: "task",
      targetId: task.id,
      proposalId: task.proposalId,
      note: "task heartbeat",
    });
    this.persistState();
    this.emitTaskUpdate(task, "started"); // re-emit so subscribers see the heartbeat
    return task;
  }

  // --- Diagnostics ---

  /** Compute the diagnostic status for a single task. */
  getTaskDiagnostics(
    taskId: string,
    options?: TaskDiagnosticsOptions,
  ): TaskDiagnosticReport {
    const task = this.requireTask(taskId);
    return this.getTaskDiagnosticsForRecord(task, options, {
      tombstone: this.tombstones.get(taskId),
    });
  }

  /** Compute diagnostics for a task snapshot supplied by a read model/store. */
  getTaskDiagnosticsForRecord(
    task: TaskRecord,
    options?: TaskDiagnosticsOptions,
    overrides?: {
      tombstone?: TaskTombstone | null;
      assignedWorker?: WorkerRecord | null;
      lastRequeueEvent?: AuditEvent | null;
    },
  ): TaskDiagnosticReport {
    const nowMs = options?.nowMs ?? Date.now();
    const staleAfterMs = options?.staleAfterMs ?? 120_000; // 2 min default
    const longRunningAfterMs = options?.longRunningAfterMs ?? 3_600_000; // 1 hr default
    const workerOfflineAfterMs = options?.workerOfflineAfterMs ?? 90_000;

    const tombstone = overrides && "tombstone" in overrides
      ? overrides.tombstone ?? undefined
      : this.tombstones.get(task.id);
    const diagnosticStatus = computeTaskDiagnosticStatus(task, staleAfterMs, longRunningAfterMs, nowMs);
    const assignedWorker = overrides && "assignedWorker" in overrides
      ? overrides.assignedWorker ?? undefined
      : task.assignedWorkerId
        ? this.workers.get(task.assignedWorkerId)
        : undefined;
    const staleWorker = assignedWorker
      ? isWorkerStale(assignedWorker.lastSeenAt, workerOfflineAfterMs, nowMs)
      : false;
    const lastRequeueEvent = overrides && "lastRequeueEvent" in overrides
      ? overrides.lastRequeueEvent ?? undefined
      : findLatestTaskAuditEvent(this.auditEvents.values(), task.id, "task.requeued");
    const durableSignals = projectTaskDurableSignals({
      task,
      diagnosticStatus,
      tombstone,
      assignedWorker,
      staleWorker,
      lastRequeueEvent,
    });
    const createdAtMs = Date.parse(task.createdAt);
    const lastStatusChangeMs = Math.max(
      createdAtMs,
      task.claimedAt ? Date.parse(task.claimedAt) : 0,
      task.completedAt ? Date.parse(task.completedAt) : 0,
      task.lastHeartbeatAt ? Date.parse(task.lastHeartbeatAt) : 0,
    );
    const stalenessMs = task.lastHeartbeatAt
      ? nowMs - Date.parse(task.lastHeartbeatAt)
      : undefined;

    return {
      taskId: task.id,
      diagnosticStatus,
      brokerState: durableSignals.brokerState,
      reconcileNeeded: durableSignals.reconcileNeeded,
      interruption: durableSignals.interruption,
      task: structuredClone(task),
      currentStatusDurationMs: nowMs - lastStatusChangeMs,
      stalenessMs,
      brokerHints: durableSignals.brokerHints,
      tombstone: tombstone ? structuredClone(tombstone) : undefined,
      lifecycle: {
        createdAt: task.createdAt,
        claimedAt: task.claimedAt,
        startedAt: task.status === "running" || task.status === "succeeded" || task.status === "failed"
          ? task.claimedAt
          : undefined,
        lastHeartbeatAt: task.lastHeartbeatAt,
        completedAt: task.completedAt,
        tombstonedAt: tombstone?.tombstonedAt,
      },
    };
  }

  /** List tasks that are stale (claimed/running with no recent heartbeat). */
  listStaleTasks(options?: {
    staleAfterMs?: number;
    nowMs?: number;
  }): TaskRecord[] {
    const staleAfterMs = options?.staleAfterMs ?? 120_000;
    const nowMs = options?.nowMs ?? Date.now();
    const threshold = nowMs - staleAfterMs;

    return [...this.tasks.values()].filter((task) => {
      if (task.status !== "claimed" && task.status !== "running") {
        return false;
      }
      const lastSignal = task.lastHeartbeatAt
        ? Date.parse(task.lastHeartbeatAt)
        : task.claimedAt
          ? Date.parse(task.claimedAt)
          : Date.parse(task.createdAt);
      return lastSignal < threshold;
    });
  }

  /** List tasks that have been running longer than a threshold. */
  listLongRunningTasks(options?: {
    longRunningAfterMs?: number;
    nowMs?: number;
  }): TaskRecord[] {
    const longRunningAfterMs = options?.longRunningAfterMs ?? 3_600_000;
    const nowMs = options?.nowMs ?? Date.now();
    const threshold = nowMs - longRunningAfterMs;

    return [...this.tasks.values()].filter((task) => {
      if (task.status !== "running") {
        return false;
      }
      const startTime = task.claimedAt
        ? Date.parse(task.claimedAt)
        : Date.parse(task.createdAt);
      return startTime < threshold;
    });
  }

  // --- Tombstones ---

  /** Get a tombstone by task ID. */
  getTombstone(taskId: string): TaskTombstone | null {
    return this.tombstones.get(taskId) ?? null;
  }

  /** List tombstones with optional filters. */
  listTombstones(filters?: TombstoneListFilters): TaskTombstone[] {
    const items = [...this.tombstones.values()].filter((ts) => {
      if (filters?.taskId && ts.taskId !== filters.taskId) return false;
      if (filters?.tombstoneReason && ts.tombstoneReason !== filters.tombstoneReason) return false;
      if (filters?.terminalStatus && ts.terminalStatus !== filters.terminalStatus) return false;
      if (filters?.since && ts.tombstonedAt < filters.since) return false;
      return true;
    });
    items.sort((a, b) => b.tombstonedAt.localeCompare(a.tombstonedAt));
    return items;
  }

  /** Write a tombstone for a terminal task. Called internally on terminal transitions. */
  private writeTombstone(
    task: TaskRecord,
    reason: TombstoneReason,
    context?: { actorId?: string; reason?: string },
  ): void {
    const now = isoNow();
    const createdAtMs = Date.parse(task.createdAt);
    const completedAtMs = task.completedAt ? Date.parse(task.completedAt) : Date.now();

    const tombstone: TaskTombstone = {
      taskId: task.id,
      terminalStatus: task.status as TaskStatus,
      tombstoneReason: reason,
      durationMs: completedAtMs - createdAtMs,
      requeueCount: task.requeueCount ?? 0,
      error: task.error ? structuredClone(task.error) : undefined,
      result: task.result ? structuredClone(task.result) : undefined,
      tombstonedAt: now,
      metadata: context ? { actorId: context.actorId, cancelReason: context.reason } : undefined,
    };

    this.tombstones.set(task.id, tombstone);
    this.pendingHotTombstones.set(task.id, structuredClone(tombstone));
    this.appendAuditEvent({
      actorId: context?.actorId ?? "broker",
      action: "task.tombstoned",
      targetType: "task",
      targetId: task.id,
      proposalId: task.proposalId,
      note: `tombstoned: ${reason}`,
    });
  }

  private linkTaskToExchange(task: TaskRecord): void {
    if (!task.exchangeId) {
      return;
    }
    const exchange = this.exchanges.get(task.exchangeId);
    if (!exchange) {
      return;
    }
    exchange.activeTaskId = task.id;
    exchange.targetNodeId = task.targetNodeId;
    exchange.assignedWorkerId = task.assignedWorkerId ?? task.targetNodeId;
    exchange.target = task.target;
    exchange.updatedAt = isoNow();
    this.setExchangeRecord(exchange);
  }

  private syncExchangeStateFromTask(
    task: TaskRecord,
    nextStatus: A2AExchangeState["status"],
  ): void {
    if (!task.exchangeId) {
      return;
    }
    const exchange = this.exchanges.get(task.exchangeId);
    if (!exchange) {
      return;
    }
    exchange.activeTaskId = task.id;
    exchange.targetNodeId = task.targetNodeId;
    exchange.assignedWorkerId = task.assignedWorkerId ?? task.targetNodeId;
    exchange.target = task.target;
    exchange.status = nextStatus;
    exchange.updatedAt = isoNow();
    this.setExchangeRecord(exchange);
  }

  private assertWorkerRegistrationPayload(request: RegisterWorkerRequest): void {
    if (!request.nodeId) {
      throw new BrokerError("bad_request", "nodeId is required");
    }
    if (!request.role) {
      throw new BrokerError("bad_request", "role is required");
    }
    if (!request.capabilities) {
      throw new BrokerError("bad_request", "capabilities are required");
    }
  }

  private assertProposalPayload(request: CreateProposalRequest): void {
    if (!request.source?.id || !request.target?.id) {
      throw new BrokerError("bad_request", "source.id and target.id are required");
    }
    if (!request.summary) {
      throw new BrokerError("bad_request", "summary is required");
    }
    if (!request.workspace?.nodeId || !request.workspace?.workspaceId) {
      throw new BrokerError(
        "bad_request",
        "workspace.nodeId and workspace.workspaceId are required",
      );
    }
    if (request.kind === "patch" && !request.patchText) {
      throw new BrokerError("bad_request", "patch proposals require patchText");
    }
    if (request.kind === "params" && !request.parameterPayload) {
      throw new BrokerError("bad_request", "params proposals require parameterPayload");
    }
    if (request.kind === "hybrid" && !request.patchText && !request.parameterPayload) {
      throw new BrokerError(
        "bad_request",
        "hybrid proposals require patchText, parameterPayload, or both",
      );
    }
  }

  private assertTaskPayload(request: CreateTaskRequest): void {
    if (!request.requester?.id || !request.target?.id) {
      throw new BrokerError("bad_request", "requester.id and target.id are required");
    }
    if (!request.intent) {
      throw new BrokerError("bad_request", "intent is required");
    }
    if (request.workspace && request.workspace.nodeId !== request.target.id) {
      throw new BrokerError(
        "policy_denied",
        "task workspace.nodeId must match the target worker node",
      );
    }
    if (request.assignedWorkerId && !request.assignedWorkerId.trim()) {
      throw new BrokerError("bad_request", "assignedWorkerId must not be empty");
    }
  }

  private assertTaskProposalLink(request: CreateTaskRequest): void {
    if (!request.proposalId) {
      return;
    }

    const proposal = this.requireProposal(request.proposalId);
    if (request.target.id !== proposal.targetNodeId) {
      throw new BrokerError(
        "policy_denied",
        "task target must match the proposal target node",
      );
    }

    if (request.intent === "validate_change") {
      this.assertTransition(proposal.status, ["submitted", "validated"], "queue validation task for");
      return;
    }

    if (request.intent === "apply_local_change") {
      this.assertTransition(proposal.status, ["approved"], "queue apply task for");
      if (!request.workspace?.workspaceId || request.workspace.nodeId !== proposal.targetNodeId) {
        throw new BrokerError(
          "bad_request",
          "apply tasks require a target-owned workspace",
        );
      }
    }
  }

  private assertTransition(
    current: ProposalStatus,
    allowed: ProposalStatus[],
    action: string,
  ): void {
    if (!allowed.includes(current)) {
      throw new BrokerError(
        "invalid_transition",
        `cannot ${action} proposal while status is ${current}`,
      );
    }
  }

  private assertTaskStatus(
    current: TaskStatus,
    allowed: TaskStatus[],
    action: string,
  ): void {
    if (!allowed.includes(current)) {
      throw new BrokerError(
        "invalid_transition",
        `cannot ${action} task while status is ${current}`,
      );
    }
  }

  private assertTaskWorker(task: TaskRecord, workerId: string, action: string): void {
    this.requireWorker(workerId);
    const expectedWorkerId = task.assignedWorkerId ?? task.targetNodeId;
    if (workerId !== expectedWorkerId) {
      throw new BrokerError(
        "policy_denied",
        `${action} requires the assigned worker`,
      );
    }

    if (task.claimedBy && task.claimedBy !== workerId) {
      throw new BrokerError(
        "policy_denied",
        `${action} requires the worker that claimed the task`,
      );
    }
  }

  private applyTaskCompletion(task: TaskRecord, workerId: string, result: TaskResult): void {
    if (!task.proposalId) {
      return;
    }

    if (task.intent === "validate_change") {
      if (!result.validation) {
        throw new BrokerError(
          "bad_request",
          "validate_change completion requires result.validation",
        );
      }
      this.submitValidationResult(task.proposalId, {
        nodeId: result.validation.nodeId ?? workerId,
        kind: result.validation.kind,
        verdict: result.validation.verdict,
        metrics: result.validation.metrics,
        artifactIds: uniqueIds([
          ...(result.artifactIds ?? []),
          ...(result.validation.artifactIds ?? []),
        ]),
        note: result.validation.note ?? result.note ?? result.summary,
      });
      return;
    }

    if (task.intent === "apply_local_change") {
      const workspace = result.apply?.workspace ?? task.workspace;
      if (!workspace) {
        throw new BrokerError(
          "bad_request",
          "apply_local_change completion requires a workspace",
        );
      }
      const proposal = this.applyProposalLocally(task.proposalId, {
        actor: {
          id: workerId,
          role: task.target.role,
          kind: task.target.kind,
        },
        workspace,
        note: result.apply?.note ?? result.note ?? result.summary,
      });
      const artifactIds = uniqueIds([
        ...(result.artifactIds ?? []),
        ...(result.apply?.artifactIds ?? []),
      ]);
      if (artifactIds.length > 0) {
        proposal.artifactIds = uniqueIds([...proposal.artifactIds, ...artifactIds]);
        proposal.updatedAt = isoNow();
        this.setProposalRecord(proposal);
      }
    }
  }
}

function isoNow(): string {
  return new Date().toISOString();
}

function uniqueIds(values: string[]): string[] {
  return [...new Set(values)];
}

function sortedCopy<T>(values: Iterable<T>, compare: (a: T, b: T) => number): T[] {
  const items = [...values];
  items.sort(compare);
  return items;
}

function taskStatusSinceAt(task: Pick<TaskRecord, "status" | "createdAt" | "updatedAt" | "claimedAt">): string {
  if (task.status === "claimed") {
    return task.claimedAt ?? task.updatedAt ?? task.createdAt;
  }
  if (task.status === "running") {
    return task.updatedAt ?? task.claimedAt ?? task.createdAt;
  }
  return task.createdAt;
}

function ageSecFromIso(iso: string, nowMs: number): number {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.max(0, Math.floor((nowMs - parsed) / 1000));
}

function sortNewestFirst<T extends { createdAt: string }>(a: T, b: T): number {
  return a.createdAt < b.createdAt ? 1 : -1;
}

function sortWorkersNewestFirst(a: WorkerRecord, b: WorkerRecord): number {
  return a.lastSeenAt < b.lastSeenAt ? 1 : -1;
}

function sortExchangeMessages(a: A2AExchangeMessageRecord, b: A2AExchangeMessageRecord): number {
  if (a.createdAt === b.createdAt) {
    return a.kind === "root" ? -1 : 1;
  }
  return a.createdAt > b.createdAt ? 1 : -1;
}

function collectThreadMessageIds(
  messages: A2AExchangeMessageRecord[],
  parentMessageId: string,
): Set<string> {
  const allowedIds = new Set<string>([parentMessageId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const message of messages) {
      if (message.parentMessageId && allowedIds.has(message.parentMessageId) && !allowedIds.has(message.id)) {
        allowedIds.add(message.id);
        changed = true;
      }
    }
  }
  return allowedIds;
}

function computeWorkerStatus(
  lastSeenAt: string,
  offlineAfterMs: number,
): WorkerView["status"] {
  return Date.now() - Date.parse(lastSeenAt) <= offlineAfterMs ? "online" : "stale";
}

function taskMatchesFilters(task: TaskRecord, filters?: TaskListFilters): boolean {
  if (filters?.exchangeId && task.exchangeId !== filters.exchangeId) {
    return false;
  }
  if (filters?.status && task.status !== filters.status) {
    return false;
  }
  if (filters?.targetNodeId && task.targetNodeId !== filters.targetNodeId) {
    return false;
  }
  if (filters?.proposalId && task.proposalId !== filters.proposalId) {
    return false;
  }
  if (filters?.intent && task.intent !== filters.intent) {
    return false;
  }
  if (filters?.claimedBy && task.claimedBy !== filters.claimedBy) {
    return false;
  }
  if (filters?.assignedWorkerId && task.assignedWorkerId !== filters.assignedWorkerId) {
    return false;
  }
  if (filters?.taskOrigin && (task.taskOrigin ?? "unknown") !== filters.taskOrigin) {
    return false;
  }
  return true;
}

function workerMatchesFilters(worker: WorkerRecord, filters?: WorkerListFilters): boolean {
  if (filters?.role && worker.role !== filters.role) {
    return false;
  }
  if (filters?.environment && !worker.capabilities.environments.includes(filters.environment)) {
    return false;
  }
  if (filters?.workspaceId && !worker.capabilities.workspaceIds.includes(filters.workspaceId)) {
    return false;
  }
  return true;
}

function getTaskRequeueReason(
  task: TaskRecord,
  olderThanMs: number,
  staleWorkerIds: Set<string>,
  nowMs: number,
): string | null {
  if (task.status !== "claimed" && task.status !== "running") {
    return null;
  }

  if (task.completedAt) {
    return null;
  }

  if (task.claimedBy && staleWorkerIds.has(task.claimedBy)) {
    return `worker ${task.claimedBy} is stale`;
  }

  const lastActivityAt = Date.parse(task.updatedAt || task.claimedAt || task.createdAt);
  if (!Number.isFinite(lastActivityAt)) {
    return null;
  }

  if (nowMs - lastActivityAt >= olderThanMs) {
    return `task exceeded stale threshold ${olderThanMs}ms`;
  }

  return null;
}

function isWorkerStale(lastSeenAt: string, offlineAfterMs: number, nowMs: number): boolean {
  const lastSeenMs = Date.parse(lastSeenAt);
  if (!Number.isFinite(lastSeenMs)) {
    return false;
  }

  return nowMs - lastSeenMs > offlineAfterMs;
}

function findLatestTaskAuditEvent(
  events: Iterable<AuditEvent>,
  taskId: string,
  action: AuditAction,
): AuditEvent | undefined {
  let latest: AuditEvent | undefined;
  for (const event of events) {
    if (event.targetId !== taskId || event.action !== action) {
      continue;
    }
    if (!latest || event.createdAt > latest.createdAt) {
      latest = event;
    }
  }
  return latest;
}

function projectTaskDurableSignals(params: {
  task: TaskRecord;
  diagnosticStatus: TaskDiagnosticStatus;
  tombstone?: TaskTombstone;
  assignedWorker?: WorkerRecord;
  staleWorker: boolean;
  lastRequeueEvent?: AuditEvent;
}): Pick<TaskDiagnosticReport, "brokerState" | "reconcileNeeded" | "interruption" | "brokerHints"> {
  const { task, diagnosticStatus, tombstone, assignedWorker, staleWorker, lastRequeueEvent } = params;
  const staleLease = diagnosticStatus === "stale";
  const requeued = (task.requeueCount ?? 0) > 0;

  const brokerHints: TaskDiagnosticReport["brokerHints"] = {
    staleLease,
    staleWorker,
    cancellationRequested: Boolean(task.cancellation),
    requeued,
    lastRequeueAt: lastRequeueEvent?.createdAt,
    lastRequeueReason: lastRequeueEvent?.note,
    workerLastSeenAt: assignedWorker?.lastSeenAt,
    tombstoneReason: tombstone?.tombstoneReason,
  };

  if (tombstone) {
    switch (tombstone.tombstoneReason) {
      case "timeout":
        return {
          brokerState: "terminal",
          reconcileNeeded: false,
          interruption: {
            kind: "timeout",
            source: "tombstone",
            summary: "broker marked the task as timed out",
            detectedAt: tombstone.tombstonedAt,
            reason: tombstone.error?.message,
          },
          brokerHints,
        };
      case "worker_lost":
        return {
          brokerState: "terminal",
          reconcileNeeded: false,
          interruption: {
            kind: "worker_lost",
            source: "tombstone",
            summary: "broker terminated the task after worker loss",
            detectedAt: tombstone.tombstonedAt,
          },
          brokerHints,
        };
      case "dead_lettered":
        return {
          brokerState: "terminal",
          reconcileNeeded: false,
          interruption: {
            kind: "dead_lettered",
            source: "tombstone",
            summary: "broker dead-lettered the task after exhausting requeues",
            detectedAt: tombstone.tombstonedAt,
            reason: tombstone.error?.message,
          },
          brokerHints,
        };
      case "canceled":
        return {
          brokerState: "terminal",
          reconcileNeeded: false,
          interruption: {
            kind: "operator_canceled",
            source: "tombstone",
            summary: "broker canceled the task",
            detectedAt: tombstone.tombstonedAt,
            actorId: task.cancellation?.requestedBy,
            reason: task.cancellation?.reason,
          },
          brokerHints,
        };
      case "failed":
        if (tombstone.error?.code === "timeout") {
          return {
            brokerState: "terminal",
            reconcileNeeded: false,
            interruption: {
              kind: "timeout",
              source: "tombstone",
              summary: "broker recorded timeout failure for the task",
              detectedAt: tombstone.tombstonedAt,
              reason: tombstone.error?.message,
            },
            brokerHints,
          };
        }
        return {
          brokerState: "terminal",
          reconcileNeeded: false,
          interruption: {
            kind: "failed",
            source: "tombstone",
            summary: "broker recorded task failure",
            detectedAt: tombstone.tombstonedAt,
            reason: tombstone.error?.message,
          },
          brokerHints,
        };
    }
  }

  if (staleWorker && (task.status === "claimed" || task.status === "running")) {
    return {
      brokerState: "reconcile_needed",
      reconcileNeeded: true,
      interruption: {
        kind: "stale_worker",
        source: "worker_state",
        summary: "assigned worker is stale while the task is still active",
        detectedAt: assignedWorker?.lastSeenAt,
        actorId: task.assignedWorkerId,
      },
      brokerHints,
    };
  }

  if (staleLease && (task.status === "claimed" || task.status === "running")) {
    return {
      brokerState: "reconcile_needed",
      reconcileNeeded: true,
      interruption: {
        kind: "stale_lease",
        source: "task_state",
        summary: "task lease is stale and should be reconciled from broker state",
      },
      brokerHints,
    };
  }

  if (task.status === "queued" && requeued) {
    return {
      brokerState: "interrupted",
      reconcileNeeded: false,
      interruption: {
        kind: "requeued",
        source: "audit",
        summary: "broker requeued the task after interruption detection",
        detectedAt: lastRequeueEvent?.createdAt,
        reason: lastRequeueEvent?.note,
      },
      brokerHints,
    };
  }

  return {
    brokerState: task.status === "succeeded" ? "terminal" : "healthy",
    reconcileNeeded: false,
    interruption: undefined,
    brokerHints,
  };
}

function normalizeCapabilities(
  capabilities: WorkerRecord["capabilities"],
): WorkerRecord["capabilities"] {
  return {
    canAnalyze: capabilities.canAnalyze,
    canBackfill: capabilities.canBackfill,
    canPatchWorkspace: capabilities.canPatchWorkspace,
    canPromoteLive: capabilities.canPromoteLive,
    workspaceIds: [...new Set(capabilities.workspaceIds ?? [])],
    environments: [...new Set(capabilities.environments ?? [])],
  };
}

function normalizeWorkerRecord(worker: WorkerRecord): WorkerRecord {
  return {
    ...worker,
    capabilities: normalizeCapabilities(worker.capabilities),
  };
}

function normalizePolicyError(error: unknown): BrokerError {
  if (error instanceof BrokerError) {
    return error;
  }

  if (error instanceof PolicyError) {
    return new BrokerError(error.code, error.message);
  }

  return new BrokerError("policy_denied", "policy denied");
}

function normalizeTaskPayload(
  payload: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!payload) {
    return {};
  }

  return { ...payload };
}

function normalizeTaskResult(result: TaskResult | undefined): TaskResult {
  if (!result) {
    return {};
  }

  return {
    summary: result.summary,
    note: result.note,
    artifactIds: uniqueIds(result.artifactIds ?? []),
    output: result.output ? { ...result.output } : undefined,
    validation: result.validation
      ? {
          nodeId: result.validation.nodeId,
          kind: result.validation.kind,
          verdict: result.validation.verdict,
          metrics: result.validation.metrics ? { ...result.validation.metrics } : undefined,
          artifactIds: uniqueIds(result.validation.artifactIds ?? []),
          note: result.validation.note,
        }
      : undefined,
    apply: result.apply
      ? {
          workspace: result.apply.workspace,
          artifactIds: uniqueIds(result.apply.artifactIds ?? []),
          note: result.apply.note,
        }
      : undefined,
  };
}

function normalizeBrokerRetentionPolicy(
  overrides?: Partial<BrokerRetentionPolicy>,
): BrokerRetentionPolicy {
  return {
    terminalRetentionMs: normalizeNonNegativeInteger(
      overrides?.terminalRetentionMs,
      DEFAULT_BROKER_RETENTION_POLICY.terminalRetentionMs,
    ),
    maxTerminalExchanges: normalizeNonNegativeInteger(
      overrides?.maxTerminalExchanges,
      DEFAULT_BROKER_RETENTION_POLICY.maxTerminalExchanges,
    ),
    maxTerminalTasks: normalizeNonNegativeInteger(
      overrides?.maxTerminalTasks,
      DEFAULT_BROKER_RETENTION_POLICY.maxTerminalTasks,
    ),
    maxTerminalProposals: normalizeNonNegativeInteger(
      overrides?.maxTerminalProposals,
      DEFAULT_BROKER_RETENTION_POLICY.maxTerminalProposals,
    ),
    inactiveWorkerRetentionMs: normalizeNonNegativeInteger(
      overrides?.inactiveWorkerRetentionMs,
      DEFAULT_BROKER_RETENTION_POLICY.inactiveWorkerRetentionMs,
    ),
    maxInactiveWorkers: normalizeNonNegativeInteger(
      overrides?.maxInactiveWorkers,
      DEFAULT_BROKER_RETENTION_POLICY.maxInactiveWorkers,
    ),
    auditRetentionMs: normalizeNonNegativeInteger(
      overrides?.auditRetentionMs,
      DEFAULT_BROKER_RETENTION_POLICY.auditRetentionMs,
    ),
    maxAuditEvents: normalizeNonNegativeInteger(
      overrides?.maxAuditEvents,
      DEFAULT_BROKER_RETENTION_POLICY.maxAuditEvents,
    ),
  };
}

function normalizeMaxRequeueAttempts(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_MAX_REQUEUE_ATTEMPTS;
  }
  return Math.max(0, Math.trunc(value));
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  const normalized = value ?? fallback;
  return Math.max(0, Math.trunc(normalized));
}

function isTerminalExchangeStatus(status: A2AExchangeState["status"]): boolean {
  return status === "completed" || status === "failed";
}

function isTerminalTaskStatus(status: TaskRecord["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "canceled";
}

function computeTaskDiagnosticStatus(
  task: TaskRecord,
  staleAfterMs: number,
  longRunningAfterMs: number,
  nowMs: number,
): TaskDiagnosticStatus {
  if (isTerminalTaskStatus(task.status)) {
    return "terminal";
  }

  if (task.status === "claimed" || task.status === "running") {
    const lastSignal = task.lastHeartbeatAt
      ? Date.parse(task.lastHeartbeatAt)
      : task.claimedAt
        ? Date.parse(task.claimedAt)
        : Date.parse(task.createdAt);
    const elapsed = nowMs - lastSignal;

    if (elapsed > staleAfterMs) {
      return "stale";
    }

    const runningSince = task.claimedAt
      ? Date.parse(task.claimedAt)
      : Date.parse(task.createdAt);
    if (task.status === "running" && nowMs - runningSince > longRunningAfterMs) {
      return "long_running";
    }
  }

  return "active";
}

function isTerminalProposalStatus(status: ChangeProposal["status"]): boolean {
  return status === "rejected" || status === "applied" || status === "rolled_back";
}

function parseRetentionTimestamp(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function selectRetainedTerminalRecordIds<T>(params: {
  records: T[];
  isTerminal: (record: T) => boolean;
  getId: (record: T) => string;
  getTimestamp: (record: T) => string | undefined;
  nowMs: number;
  retentionMs: number;
  maxTerminalRecords: number;
  protectedIds?: Set<string>;
}): Set<string> {
  const retainedIds = new Set<string>(params.protectedIds ?? []);
  const terminalCandidates: Array<{ id: string; timestampMs: number }> = [];
  const cutoffMs = params.nowMs - params.retentionMs;

  for (const record of params.records) {
    const id = params.getId(record);
    if (!params.isTerminal(record) || retainedIds.has(id)) {
      retainedIds.add(id);
      continue;
    }

    const timestampMs = parseRetentionTimestamp(params.getTimestamp(record));
    if (timestampMs === null || timestampMs >= cutoffMs) {
      retainedIds.add(id);
      continue;
    }

    terminalCandidates.push({ id, timestampMs });
  }

  sortedCopy(
    terminalCandidates,
    (a, b) => b.timestampMs - a.timestampMs || a.id.localeCompare(b.id),
  )
    .slice(0, params.maxTerminalRecords)
    .forEach((entry) => retainedIds.add(entry.id));

  return retainedIds;
}

function selectRetainedWorkerIds(params: {
  workers: WorkerRecord[];
  nowMs: number;
  inactiveWorkerRetentionMs: number;
  maxInactiveWorkers: number;
  protectedIds: Set<string>;
}): Set<string> {
  const retainedIds = new Set<string>(params.protectedIds);
  const staleCandidates: Array<{ id: string; timestampMs: number }> = [];
  const cutoffMs = params.nowMs - params.inactiveWorkerRetentionMs;

  for (const worker of params.workers) {
    if (retainedIds.has(worker.nodeId)) {
      continue;
    }
    const lastSeenMs = parseRetentionTimestamp(worker.lastSeenAt);
    if (lastSeenMs === null || lastSeenMs >= cutoffMs) {
      retainedIds.add(worker.nodeId);
      continue;
    }
    staleCandidates.push({ id: worker.nodeId, timestampMs: lastSeenMs });
  }

  sortedCopy(
    staleCandidates,
    (a, b) => b.timestampMs - a.timestampMs || a.id.localeCompare(b.id),
  )
    .slice(0, params.maxInactiveWorkers)
    .forEach((entry) => retainedIds.add(entry.id));

  return retainedIds;
}

function selectRetainedAuditEventIds(params: {
  auditEvents: AuditEvent[];
  nowMs: number;
  auditRetentionMs: number;
  maxAuditEvents: number;
  retainedProposalIds: Set<string>;
  retainedTaskIds: Set<string>;
  retainedExchangeIds: Set<string>;
  retainedMessageIds: Set<string>;
  retainedArtifactIds: Set<string>;
  retainedValidationIds: Set<string>;
  retainedWorkerIds: Set<string>;
}): Set<string> {
  const retainedIds = new Set<string>();
  const olderCandidates: Array<{ id: string; timestampMs: number }> = [];
  const cutoffMs = params.nowMs - params.auditRetentionMs;

  for (const event of params.auditEvents) {
    const timestampMs = parseRetentionTimestamp(event.createdAt);
    if (
      isAuditEventRetained(event, params) ||
      timestampMs === null ||
      timestampMs >= cutoffMs
    ) {
      retainedIds.add(event.id);
      continue;
    }
    olderCandidates.push({ id: event.id, timestampMs });
  }

  sortedCopy(
    olderCandidates,
    (a, b) => b.timestampMs - a.timestampMs || a.id.localeCompare(b.id),
  )
    .slice(0, params.maxAuditEvents)
    .forEach((entry) => retainedIds.add(entry.id));

  return retainedIds;
}

function isAuditEventRetained(
  event: AuditEvent,
  params: {
    retainedProposalIds: Set<string>;
    retainedTaskIds: Set<string>;
    retainedExchangeIds: Set<string>;
    retainedMessageIds: Set<string>;
    retainedArtifactIds: Set<string>;
    retainedValidationIds: Set<string>;
    retainedWorkerIds: Set<string>;
  },
): boolean {
  if (event.proposalId && params.retainedProposalIds.has(event.proposalId)) {
    return true;
  }

  switch (event.targetType) {
    case "proposal":
      return params.retainedProposalIds.has(event.targetId);
    case "artifact":
      return params.retainedArtifactIds.has(event.targetId);
    case "validation":
      return params.retainedValidationIds.has(event.targetId);
    case "worker":
      return params.retainedWorkerIds.has(event.targetId);
    case "task":
      return params.retainedTaskIds.has(event.targetId);
    case "exchange":
      return params.retainedExchangeIds.has(event.targetId);
    case "exchange-message":
      return params.retainedMessageIds.has(event.targetId);
    default:
      return false;
  }
}

function pruneMapEntries<T>(items: Map<string, T>, retainedIds: Set<string>): void {
  for (const key of items.keys()) {
    if (!retainedIds.has(key)) {
      items.delete(key);
    }
  }
}

function normalizeTaskError(error: TaskError | undefined): TaskError {
  if (!error) {
    return { message: "task failed" };
  }

  return {
    code: error.code,
    message: error.message || "task failed",
    details: error.details ? { ...error.details } : undefined,
  };
}

function normalizeWakeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeApprovalId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeApprovalReason(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeApprovalTerminalStatus(value: unknown): Exclude<TaskApprovalOutcomeStatus, "approved"> {
  return value === "expired" || value === "canceled" ? value : "rejected";
}

function buildTaskWakeKey(task: TaskRecord, request: TaskWakePlanRequest): string {
  const explicit = normalizeWakeString(request.wakeKey);
  if (explicit) {
    return explicit;
  }
  const stableCorrelation =
    normalizeWakeString(request.correlationId) ??
    normalizeWakeString(task.payload.correlationId) ??
    task.id;
  const stableRun =
    normalizeWakeString(request.waitRunId) ??
    normalizeWakeString(task.payload.waitRunId) ??
    normalizeWakeString(request.targetSessionKey) ??
    task.targetNodeId;
  return `${stableCorrelation}:${stableRun}`;
}

function defaultWakeDecisionMessage(status: Exclude<TaskWakeState["status"], "planned">): string {
  switch (status) {
    case "scheduled":
      return "Wake-on-Task scheduled.";
    case "skipped":
      return "Wake-on-Task skipped.";
    case "failed":
      return "Wake-on-Task failed.";
  }
}

function wakeDecisionAuditAction(status: Exclude<TaskWakeState["status"], "planned">): AuditAction {
  switch (status) {
    case "scheduled":
      return "task.wake.scheduled";
    case "skipped":
      return "task.wake.skipped";
    case "failed":
      return "task.wake.failed";
  }
}

function wakeDecisionUpdateReason(status: Exclude<TaskWakeState["status"], "planned">): TaskUpdateReason {
  switch (status) {
    case "scheduled":
      return "wake_scheduled";
    case "skipped":
      return "wake_skipped";
    case "failed":
      return "wake_failed";
  }
}

function normalizeTaskWakeState(wake: TaskWakeState | undefined): TaskWakeState | undefined {
  if (!wake) {
    return undefined;
  }
  return {
    ...wake,
    replayCount: wake.replayCount ?? 0,
  };
}

function normalizeTaskRecord(task: TaskRecord): TaskRecord {
  return {
    ...task,
    targetNodeId: task.targetNodeId ?? task.target.id,
    assignedWorkerId: task.assignedWorkerId ?? task.targetNodeId ?? task.target.id,
    artifactIds: uniqueIds(task.artifactIds ?? []),
    payload: normalizeTaskPayload(task.payload),
    result: task.result ? normalizeTaskResult(task.result) : undefined,
    error: task.error ? normalizeTaskError(task.error) : undefined,
    attemptId: task.attemptId,
    wake: normalizeTaskWakeState(task.wake),
    taskOrigin: task.taskOrigin ?? "unknown",
  };
}

function normalizeExchangeState(exchange: A2AExchangeState): A2AExchangeState {
  return {
    ...exchange,
    targetNodeId: exchange.targetNodeId ?? exchange.target.id,
    assignedWorkerId: exchange.assignedWorkerId,
    currentDecision: exchange.currentDecision,
    rootMessageId: exchange.rootMessageId ?? "",
    latestMessageId: exchange.latestMessageId ?? exchange.rootMessageId ?? "",
    messageCount: exchange.messageCount ?? 0,
    lastMessageAt: exchange.lastMessageAt ?? exchange.updatedAt,
    activeTaskId: exchange.activeTaskId,
  };
}

function normalizeExchangeMessageRecord(message: A2AExchangeMessageRecord): A2AExchangeMessageRecord {
  return {
    ...message,
    kind: message.kind ?? "thread",
    updatedAt: message.updatedAt ?? message.createdAt,
  };
}

function createLegacyRootExchangeMessage(exchange: A2AExchangeState): A2AExchangeMessageRecord {
  return {
    id: `legacy-root:${exchange.id}`,
    exchangeId: exchange.id,
    kind: "root",
    message: exchange.message,
    requester: exchange.requester,
    targetNodeId: exchange.targetNodeId ?? exchange.target.id,
    createdAt: exchange.createdAt,
    updatedAt: exchange.updatedAt,
  };
}
