import { randomUUID } from "node:crypto";

import {
  assertProposalApplyAllowed,
  assertProposalCreationAllowed,
  assertProposalReviewAllowed,
  assertValidationSubmissionAllowed,
  PolicyError,
} from "./policy.js";
import {
  CURRENT_BROKER_STATE_VERSION,
  type BrokerSnapshot,
  type BrokerStateStore,
} from "./store.js";
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
  TaskHistorySummary,
  TaskListFilters,
  TaskQueueSummary,
  TaskRecord,
  TaskReassignRequest,
  TaskResult,
  TaskStatus,
  ValidationResult,
  WorkerFleetSummary,
  WorkerHeartbeatRequest,
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

export class InMemoryA2ABroker {
  private readonly exchanges = new Map<string, A2AExchangeState>();
  private readonly exchangeMessages = new Map<string, A2AExchangeMessageRecord>();
  private readonly proposals = new Map<string, ChangeProposal>();
  private readonly artifacts = new Map<string, ArtifactRecord>();
  private readonly validations = new Map<string, ValidationResult>();
  private readonly auditEvents = new Map<string, AuditEvent>();
  private readonly workers = new Map<string, WorkerRecord>();
  private readonly tasks = new Map<string, TaskRecord>();

  constructor(
    private readonly stateStore?: BrokerStateStore,
    snapshot?: BrokerSnapshot,
  ) {
    if (snapshot) {
      this.loadSnapshot(snapshot);
    }
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

    this.exchangeMessages.set(rootMessage.id, rootMessage);
    this.exchanges.set(exchange.id, exchange);
    this.persistState();
    return exchange;
  }

  getExchange(id: string): A2AExchangeState | null {
    return this.exchanges.get(id) ?? null;
  }

  listExchanges(): A2AExchangeState[] {
    return [...this.exchanges.values()].sort(sortNewestFirst);
  }

  listExchangeMessages(
    exchangeId: string,
    filters?: {
      parentMessageId?: string;
      includeDescendants?: boolean;
    },
  ): A2AExchangeMessageRecord[] {
    const exchange = this.requireExchange(exchangeId);
    const items = [...this.exchangeMessages.values()]
      .filter((message) => message.exchangeId === exchangeId)
      .sort(sortExchangeMessages);

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

    this.exchangeMessages.set(message.id, message);
    exchange.messageCount += 1;
    exchange.lastMessageAt = now;
    exchange.latestMessageId = message.id;
    exchange.updatedAt = now;
    this.applyExchangeMessageDecision(exchange, message);
    this.exchanges.set(exchange.id, exchange);
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
    const existing = this.workers.get(request.nodeId);
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

    this.workers.set(worker.nodeId, worker);
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

    this.workers.set(worker.nodeId, worker);
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
    return this.workers.get(nodeId) ?? null;
  }

  listWorkers(filters?: WorkerListFilters): WorkerRecord[] {
    return [...this.workers.values()]
      .filter((worker) => {
        if (filters?.role && worker.role !== filters.role) {
          return false;
        }
        if (
          filters?.environment &&
          !worker.capabilities.environments.includes(filters.environment)
        ) {
          return false;
        }
        if (
          filters?.workspaceId &&
          !worker.capabilities.workspaceIds.includes(filters.workspaceId)
        ) {
          return false;
        }
        return true;
      })
      .sort(sortWorkersNewestFirst);
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

    this.proposals.set(proposal.id, proposal);
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
    return [...this.proposals.values()]
      .filter((proposal) => {
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
      })
      .sort(sortNewestFirst);
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

    this.artifacts.set(artifact.id, artifact);
    proposal.artifactIds = uniqueIds([...proposal.artifactIds, artifact.id]);
    proposal.updatedAt = isoNow();
    this.proposals.set(proposal.id, proposal);

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

    this.validations.set(validation.id, validation);
    proposal.status = "validated";
    proposal.updatedAt = isoNow();
    proposal.artifactIds = uniqueIds([...proposal.artifactIds, ...validation.artifactIds]);
    this.proposals.set(proposal.id, proposal);

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
    this.proposals.set(proposal.id, proposal);
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
    this.proposals.set(proposal.id, proposal);
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
    this.proposals.set(proposal.id, proposal);
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
    if (request.exchangeId) {
      this.requireExchange(request.exchangeId);
    }
    this.requireWorker(request.target.id);
    if (request.assignedWorkerId) {
      this.requireWorker(request.assignedWorkerId);
    }
    this.assertTaskProposalLink(request);

    const now = isoNow();
    const task: TaskRecord = {
      id: request.id ?? randomUUID(),
      exchangeId: request.exchangeId,
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
      policyContext: request.policyContext,
      payload: normalizeTaskPayload(request.payload),
      status: "queued",
      createdAt: request.createdAt ?? now,
      updatedAt: now,
    };

    this.tasks.set(task.id, task);
    if (task.exchangeId) {
      this.linkTaskToExchange(task);
    }
    this.appendAuditEvent({
      actorId: task.requester.id,
      action: "task.created",
      targetType: "task",
      targetId: task.id,
      proposalId: task.proposalId,
      note: task.message ?? task.intent,
    });
    this.persistState();
    return task;
  }

  getTask(id: string): TaskRecord | null {
    return this.tasks.get(id) ?? null;
  }

  listTasks(filters?: TaskListFilters): TaskRecord[] {
    return [...this.tasks.values()]
      .filter((task) => {
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
        return true;
      })
      .sort(sortNewestFirst);
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
    task.status = "queued";
    task.claimedBy = undefined;
    task.claimedAt = undefined;
    task.completedAt = undefined;
    task.result = undefined;
    task.error = undefined;
    task.updatedAt = now;
    this.tasks.set(task.id, task);
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
    return task;
  }

  cancelTask(taskId: string, request: TaskCancelRequest): TaskRecord {
    const task = this.requireTask(taskId);
    if (!request.actor?.id) {
      throw new BrokerError("bad_request", "actor.id is required");
    }

    if (task.status === "succeeded" || task.status === "failed" || task.status === "canceled") {
      return task;
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

    return this.cancelTaskRecord(task, {
      actorId,
      reason: request.reason,
    });
  }

  claimTask(taskId: string, workerId: string): TaskRecord {
    const task = this.requireTask(taskId);
    this.assertTaskWorker(task, workerId, "claim");
    this.assertTaskStatus(task.status, ["queued"], "claim");

    const now = isoNow();
    task.status = "claimed";
    task.claimedBy = workerId;
    task.claimedAt = now;
    task.updatedAt = now;
    this.tasks.set(task.id, task);
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
    return task;
  }

  startTask(taskId: string, workerId: string): TaskRecord {
    const task = this.requireTask(taskId);
    this.assertTaskWorker(task, workerId, "start");
    this.assertTaskStatus(task.status, ["claimed"], "start");

    task.status = "running";
    task.updatedAt = isoNow();
    this.tasks.set(task.id, task);
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
    return task;
  }

  completeTask(taskId: string, workerId: string, result?: TaskResult): TaskRecord {
    const task = this.requireTask(taskId);
    this.assertTaskWorker(task, workerId, "complete");
    this.assertTaskStatus(task.status, ["claimed", "running"], "complete");

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
    this.tasks.set(task.id, task);
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
    return task;
  }

  failTask(taskId: string, workerId: string, error?: TaskError): TaskRecord {
    const task = this.requireTask(taskId);
    this.assertTaskWorker(task, workerId, "fail");
    this.assertTaskStatus(task.status, ["claimed", "running"], "fail");

    const now = isoNow();
    const normalizedError = normalizeTaskError(error);
    task.status = "failed";
    task.claimedBy = workerId;
    task.updatedAt = now;
    task.completedAt = now;
    task.error = normalizedError;
    this.tasks.set(task.id, task);
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
    return task;
  }

  requeueStaleTasks(
    olderThanMs: number,
    options?: {
      nowMs?: number;
      workerOfflineAfterMs?: number;
    },
  ): TaskRecord[] {
    const thresholdMs = Math.max(0, olderThanMs);
    const nowMs = options?.nowMs ?? Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const staleWorkerIds =
      options?.workerOfflineAfterMs && options.workerOfflineAfterMs >= 0
        ? new Set(this.listStaleWorkerIds(options.workerOfflineAfterMs, nowMs))
        : new Set<string>();
    const requeued: TaskRecord[] = [];

    for (const task of this.tasks.values()) {
      const requeueReason = getTaskRequeueReason(task, thresholdMs, staleWorkerIds, nowMs);
      if (!requeueReason) {
        continue;
      }

      const previousStatus = task.status;
      task.status = "queued";
      task.claimedBy = undefined;
      task.claimedAt = undefined;
      task.completedAt = undefined;
      task.updatedAt = nowIso;
      this.tasks.set(task.id, task);
      this.syncExchangeStateFromTask(task, "queued");
      this.appendAuditEvent({
        actorId: "broker",
        action: "task.requeued",
        targetType: "task",
        targetId: task.id,
        proposalId: task.proposalId,
        note: `requeued ${previousStatus} task without reassignment: ${requeueReason}`,
      });
      requeued.push(task);
    }

    if (requeued.length > 0) {
      this.persistState();
    }

    return requeued;
  }

  private listStaleWorkerIds(offlineAfterMs: number, nowMs: number): string[] {
    return [...this.workers.values()]
      .filter((worker) => isWorkerStale(worker.lastSeenAt, offlineAfterMs, nowMs))
      .map((worker) => worker.nodeId);
  }

  listArtifactsForProposal(proposalId: string): ArtifactRecord[] {
    return [...this.artifacts.values()]
      .filter((artifact) => artifact.proposalId === proposalId)
      .sort(sortNewestFirst);
  }

  listValidationsForProposal(proposalId: string): ValidationResult[] {
    return [...this.validations.values()]
      .filter((validation) => validation.proposalId === proposalId)
      .sort(sortNewestFirst);
  }

  listAuditEvents(filters?: AuditListFilters): AuditEvent[] {
    return [...this.auditEvents.values()]
      .filter((event) => {
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
      })
      .sort(sortNewestFirst);
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

    // --- Queue ---
    const pendingTasks = allTasks.filter(
      (t) => t.status === "queued" || t.status === "claimed",
    );
    const queue: TaskQueueSummary = {
      total: pendingTasks.length,
      byStatus: this.countBy(allTasks, (t) => t.status) as Record<TaskStatus, number>,
      byIntent: this.countBy(allTasks, (t) => t.intent),
      oldestPending: pendingTasks
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(0, oldestPendingLimit)
        .map((t) => ({
          id: t.id,
          intent: t.intent,
          status: t.status,
          targetNodeId: t.targetNodeId,
          assignedWorkerId: t.assignedWorkerId,
          createdAt: t.createdAt,
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
    const recentOutcomes = allTasks
      .filter((t) => (t.status === "succeeded" || t.status === "failed") && t.completedAt)
      .sort((a, b) => {
      const cmp = (b.completedAt ?? "").localeCompare(a.completedAt ?? "");
      if (cmp !== 0) return cmp;
      const cmp2 = b.createdAt.localeCompare(a.createdAt);
      if (cmp2 !== 0) return cmp2;
      return b.id.localeCompare(a.id);
    })
      .slice(0, recentHistoryLimit);
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
    const actionableStatuses: ProposalStatus[] = ["submitted", "validated", "approved"];
    const pendingAction = allProposals
      .filter((p) => actionableStatuses.includes(p.status))
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .slice(0, pendingActionLimit)
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
      if (isStale) {
        staleCount++;
      } else {
        onlineCount++;
      }
      return {
        nodeId: w.nodeId,
        role: w.role,
        displayName: w.displayName,
        status: (isStale ? "stale" : "online") as "online" | "stale",
        activeTaskCount: allTasks.filter(
          (t) =>
            t.status === "claimed" || t.status === "running"
              ? t.assignedWorkerId === w.nodeId || t.targetNodeId === w.nodeId
              : false,
        ).length,
        lastSeenAt: w.lastSeenAt,
      };
    });
    const workers: WorkerFleetSummary = {
      total: allWorkers.length,
      online: onlineCount,
      stale: staleCount,
      byNode,
    };

    return {
      generatedAt: new Date(nowMs).toISOString(),
      queue,
      history,
      proposals,
      workers,
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
    };
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
      this.workers.set(worker.nodeId, {
        ...worker,
        capabilities: normalizeCapabilities(worker.capabilities),
      });
    }

    for (const task of snapshot.tasks ?? []) {
      this.tasks.set(task.id, normalizeTaskRecord(task));
    }
  }

  private persistState(): void {
    this.stateStore?.save(this.exportSnapshot());
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
    const worker = this.workers.get(nodeId);
    if (!worker) {
      throw new BrokerError("not_found", "worker not found");
    }
    return worker;
  }

  private requireTask(id: string): TaskRecord {
    const task = this.tasks.get(id);
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
    },
  ): TaskRecord {
    task.status = "canceled";
    task.claimedBy = undefined;
    task.claimedAt = undefined;
    task.completedAt = isoNow();
    task.updatedAt = task.completedAt;
    task.result = undefined;
    task.error = undefined;
    this.tasks.set(task.id, task);
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
    return task;
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
    this.exchanges.set(exchange.id, exchange);
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
    this.exchanges.set(exchange.id, exchange);
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
        this.proposals.set(proposal.id, proposal);
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

function normalizeCapabilities(
  capabilities: WorkerRecord["capabilities"],
): WorkerRecord["capabilities"] {
  return {
    canAnalyze: Boolean(capabilities.canAnalyze),
    canBackfill: Boolean(capabilities.canBackfill),
    canPatchWorkspace: Boolean(capabilities.canPatchWorkspace),
    canPromoteLive: Boolean(capabilities.canPromoteLive),
    workspaceIds: [...new Set(capabilities.workspaceIds ?? [])],
    environments: [...new Set(capabilities.environments ?? [])],
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

function normalizeTaskRecord(task: TaskRecord): TaskRecord {
  return {
    ...task,
    targetNodeId: task.targetNodeId ?? task.target.id,
    assignedWorkerId: task.assignedWorkerId ?? task.targetNodeId ?? task.target.id,
    artifactIds: uniqueIds(task.artifactIds ?? []),
    payload: normalizeTaskPayload(task.payload),
    result: task.result ? normalizeTaskResult(task.result) : undefined,
    error: task.error ? normalizeTaskError(task.error) : undefined,
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
