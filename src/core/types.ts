export type A2APartyKind = "session" | "node" | "user" | "service";
export type A2APartyRole =
  | "hub"
  | "live-trader"
  | "researcher"
  | "analyst"
  | "operator";

export type A2AExchangeIntent =
  | "chat"
  | "analyze"
  | "backfill"
  | "propose_patch"
  | "propose_params"
  | "validate_change"
  | "apply_local_change"
  | "promote_to_live"
  | "rollback_live";

export type A2AExchangeStatus = "queued" | "running" | "completed" | "failed";
export type A2AExchangeMessageKind = "root" | "thread";
export type A2AExchangeDecision =
  | "accepted"
  | "partially_accepted"
  | "needs_clarification"
  | "declined";
export type ProposalKind = "patch" | "params" | "hybrid";
export type ProposalStatus =
  | "draft"
  | "submitted"
  | "validated"
  | "approved"
  | "rejected"
  | "applied"
  | "rolled_back";
export type ValidationKind = "backfill" | "paper" | "replay" | "smoke";
export type ValidationVerdict = "pass" | "fail" | "warn";
export type TaskKind = A2AExchangeIntent;
export type TaskStatus =
  | "blocked"
  | "queued"
  | "claimed"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled";
export type AuditAction =
  | "proposal.created"
  | "artifact.attached"
  | "validation.submitted"
  | "proposal.approved"
  | "proposal.rejected"
  | "proposal.applied"
  | "exchange.message.added"
  | "task.created"
  | "task.approved"
  | "task.approval_rejected"
  | "task.claimed"
  | "task.started"
  | "task.heartbeat"
  | "task.reassigned"
  | "task.requeued"
  | "task.succeeded"
  | "task.failed"
  | "task.canceled"
  | "task.tombstoned"
  | "task.wake.planned"
  | "task.wake.scheduled"
  | "task.wake.skipped"
  | "task.wake.failed"
  | "worker.registered"
  | "worker.heartbeat";
export type A2AWorkerEnvironment = "research" | "staging" | "live";
export type WorkerStatus = "online" | "stale";

/**
 * Declared operating mode of a worker node.
 * - `persistent`: always-on VPS / server (default if absent).
 * - `mobile`: battery-powered or sleep-capable device (Android/Termux, laptop).
 *   Mobile workers use shorter stale thresholds because brief offline
 *   windows are expected (Doze, network suspend, lid close).
 */
export type WorkerMode = "persistent" | "mobile";
/**
 * Where a task entered the broker. `unknown` is the backward-compatible default
 * for tasks created before this field existed or by callers that don't tag the
 * source. Downstream consumers use this to distinguish GitHub-driven
 * collaboration from API/sessions_send invocations.
 */
export type TaskOrigin = "github" | "api" | "sessions_send" | "operator" | "unknown";

export interface A2APartyRef {
  id: string;
  kind?: A2APartyKind;
  role?: A2APartyRole;
}

export interface A2AExchangeVia {
  transport?: string;
  channel?: string;
  nodeId?: string;
  sessionId?: string;
  traceId?: string;
}

export interface WorkspaceRef {
  nodeId: string;
  workspaceId: string;
  pathHint?: string;
  branch?: string;
  strategyId?: string;
}

export interface A2AExchangeRequest {
  requester: A2APartyRef;
  target: A2APartyRef;
  message: string;
  maxTurns?: number;
  intent?: A2AExchangeIntent;
  via?: A2AExchangeVia;
}

export interface A2AExchangeMessageRecord {
  id: string;
  exchangeId: string;
  kind: A2AExchangeMessageKind;
  message: string;
  requester?: A2APartyRef;
  actor?: A2APartyRef;
  via?: A2AExchangeVia;
  decision?: A2AExchangeDecision;
  targetNodeId?: string;
  assignedWorkerId?: string;
  parentMessageId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface A2AExchangeMessageRequest {
  actor: A2APartyRef;
  message: string;
  via?: A2AExchangeVia;
  decision?: A2AExchangeDecision;
  targetNodeId?: string;
  assignedWorkerId?: string;
  parentMessageId?: string;
}

export interface A2AExchangeState {
  id: string;
  requester: A2APartyRef;
  target: A2APartyRef;
  targetNodeId: string;
  assignedWorkerId?: string;
  message: string;
  maxTurns: number;
  intent: A2AExchangeIntent;
  status: A2AExchangeStatus;
  currentDecision?: A2AExchangeDecision;
  rootMessageId: string;
  latestMessageId: string;
  messageCount: number;
  lastMessageAt: string;
  activeTaskId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface A2ATaskRequest {
  id: string;
  exchangeId?: string;
  parentTaskId?: string;
  intent: A2AExchangeIntent;
  requester: A2APartyRef;
  target: A2APartyRef;
  workspace?: WorkspaceRef;
  message?: string;
  proposalId?: string;
  artifactIds?: string[];
  assignedWorkerId?: string;
  via?: A2AExchangeVia;
  policyContext?: {
    requiresApproval?: boolean;
    liveImpact?: boolean;
    targetEnvironment?: A2AWorkerEnvironment;
  };
  createdAt: string;
}

export interface CreateTaskRequest extends Omit<A2ATaskRequest, "id" | "createdAt"> {
  id?: string;
  createdAt?: string;
  payload?: Record<string, unknown>;
  taskOrigin?: TaskOrigin;
}

export interface TaskValidationPayload {
  nodeId?: string;
  kind: ValidationKind;
  verdict: ValidationVerdict;
  metrics?: Record<string, number | string | boolean>;
  artifactIds?: string[];
  note?: string;
}

export interface TaskApplyPayload {
  workspace?: WorkspaceRef;
  artifactIds?: string[];
  note?: string;
}

export interface TaskResult {
  summary?: string;
  note?: string;
  artifactIds?: string[];
  output?: Record<string, unknown>;
  validation?: TaskValidationPayload;
  apply?: TaskApplyPayload;
}

export interface TaskError {
  code?: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface TaskCancellationInfo {
  requestedAt: string;
  requestedBy: string;
  reason?: string;
  sourceTaskId?: string;
}

export interface TaskApprovalInfo {
  approvalId: string;
  approvedAt: string;
  approvedBy: string;
  actorRole?: A2APartyRole;
  requesterRole?: A2APartyRole;
  reason?: string;
}

export type TaskApprovalOutcomeStatus = "approved" | "rejected" | "expired" | "canceled";

export interface TaskApprovalOutcomeInfo {
  status: TaskApprovalOutcomeStatus;
  approvalId: string;
  decidedAt: string;
  decidedBy: string;
  actorRole?: A2APartyRole;
  requesterRole?: A2APartyRole;
  reason?: string;
}

export interface TaskApprovalRequest {
  actor: A2APartyRef;
  reason?: string;
  approvalId?: string;
}

export interface TaskApprovalTerminalRequest extends TaskApprovalRequest {
  status?: Exclude<TaskApprovalOutcomeStatus, "approved">;
}

export type TaskWakeStatus = "planned" | "scheduled" | "skipped" | "failed";

export interface TaskWakeState {
  status: TaskWakeStatus;
  wakeKey: string;
  idempotencyKey: string;
  targetSessionKey: string;
  targetNodeId?: string;
  waitRunId?: string;
  correlationId?: string;
  parentRunId?: string;
  coalesced?: boolean;
  runtimeRunId?: string;
  code?: string;
  message?: string;
  plannedAt: string;
  updatedAt: string;
  decidedAt?: string;
  replayCount?: number;
}

export interface TaskWakePlanRequest {
  targetSessionKey: string;
  targetNodeId?: string;
  waitRunId?: string;
  correlationId?: string;
  parentRunId?: string;
  wakeKey?: string;
  idempotencyKey?: string;
  message?: string;
}

export interface TaskWakeDecisionRequest {
  status: Exclude<TaskWakeStatus, "planned">;
  coalesced?: boolean;
  runtimeRunId?: string;
  code?: string;
  message?: string;
}

export interface TaskWakePlanResult {
  task: TaskRecord;
  wake: TaskWakeState;
  shouldDispatch: boolean;
  replayed: boolean;
}

export interface TaskRecord extends A2ATaskRequest {
  intent: TaskKind;
  status: TaskStatus;
  targetNodeId: string;
  payload: Record<string, unknown>;
  updatedAt: string;
  claimedAt?: string;
  completedAt?: string;
  claimedBy?: string;
  result?: TaskResult;
  error?: TaskError;
  cancellation?: TaskCancellationInfo;
  /** Operator/hub approval that released an approval-gated task for worker claim. */
  approval?: TaskApprovalInfo;
  /** Terminal approval decision, including negative outcomes that keep live-impact work stopped. */
  approvalOutcome?: TaskApprovalOutcomeInfo;
  /**
   * Count of times this task has been requeued from claimed/running back to queued by the
   * stale-task reaper or the manual requeue endpoint. Capped by the broker's
   * `maxRequeueAttempts` policy so a flapping worker cannot thrash the queue indefinitely.
   * Reset to 0 when an operator reassigns the task (fresh attempt budget).
   */
  requeueCount?: number;
  /**
   * Last time a worker explicitly heartbeat this task, confirming active progress.
   * Updated by `heartbeatTask()`. Enables per-task staleness detection independent
   * of the worker-level `lastSeenAt`.
   */
  lastHeartbeatAt?: string;
  /**
   * Broker-generated UUID assigned when a task transitions from queued to claimed.
   * Reset on requeue/reassign. Each attempt represents a discrete execution window.
   */
  attemptId?: string;
  /** Durable Wake-on-Task decision state for accepted-task replay/idempotency. */
  wake?: TaskWakeState;
  /**
   * Where this task originated. `"github"` is set by the GitHub ingestion
   * service when projecting `/a2a assign` commands; non-GitHub callers default
   * to `"unknown"` unless they pass an explicit value through the create
   * request. Optional/additive for backward compatibility.
   */
  taskOrigin?: TaskOrigin;
}

export interface TaskClaimRequest {
  workerId: string;
}

export interface TaskStartRequest extends TaskClaimRequest {}

export interface TaskCompleteRequest extends TaskClaimRequest {
  result?: TaskResult;
}

export interface TaskFailRequest extends TaskClaimRequest {
  error?: TaskError;
}

export interface TaskCancelRequest {
  actor: A2APartyRef;
  reason?: string;
}

export interface TaskReassignRequest {
  actor: A2APartyRef;
  targetNodeId?: string;
  assignedWorkerId?: string;
  note?: string;
}

export interface TaskListFilters {
  exchangeId?: string;
  status?: TaskStatus;
  targetNodeId?: string;
  proposalId?: string;
  intent?: TaskKind;
  claimedBy?: string;
  assignedWorkerId?: string;
  taskOrigin?: TaskOrigin;
}

export interface ChangeProposal {
  id: string;
  source: A2APartyRef;
  target: A2APartyRef;
  sourceNodeId: string;
  targetNodeId: string;
  kind: ProposalKind;
  summary: string;
  rationale?: string;
  workspace: WorkspaceRef;
  patchText?: string;
  parameterPayload?: Record<string, unknown>;
  artifactIds: string[];
  status: ProposalStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactRecord {
  id: string;
  proposalId: string;
  kind: string;
  uri: string;
  contentType?: string;
  sizeBytes?: number;
  summary?: string;
  createdAt: string;
}

export interface ValidationResult {
  id: string;
  proposalId: string;
  nodeId: string;
  kind: ValidationKind;
  verdict: ValidationVerdict;
  metrics: Record<string, number | string | boolean>;
  artifactIds: string[];
  note?: string;
  createdAt: string;
}

export interface AuditEvent {
  id: string;
  actorId: string;
  action: AuditAction;
  targetType: "proposal" | "artifact" | "validation" | "worker" | "task" | "exchange" | "exchange-message";
  targetId: string;
  proposalId?: string;
  note?: string;
  createdAt: string;
}

export interface WorkerCapabilities {
  canAnalyze: boolean;
  canBackfill: boolean;
  canPatchWorkspace: boolean;
  canPromoteLive: boolean;
  workspaceIds: string[];
  environments: A2AWorkerEnvironment[];
}

export interface WorkerRecord {
  nodeId: string;
  role: A2APartyRole;
  displayName?: string;
  brokerUrl?: string;
  capabilities: WorkerCapabilities;
  /** Declared operating mode. Defaults to "persistent" when absent. */
  workerMode?: WorkerMode;
  metadata?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
}

export interface RegisterWorkerRequest {
  nodeId: string;
  role: A2APartyRole;
  displayName?: string;
  brokerUrl?: string;
  capabilities: WorkerCapabilities;
  workerMode?: WorkerMode;
  metadata?: Record<string, string>;
}

export interface WorkerHeartbeatRequest {
  displayName?: string;
  brokerUrl?: string;
  capabilities?: WorkerCapabilities;
  workerMode?: WorkerMode;
  metadata?: Record<string, string>;
}

export interface WorkerListFilters {
  role?: A2APartyRole;
  environment?: A2AWorkerEnvironment;
  workspaceId?: string;
}

export interface WorkerView extends WorkerRecord {
  status: WorkerStatus;
}

export interface CreateProposalRequest {
  source: A2APartyRef;
  target: A2APartyRef;
  kind: ProposalKind;
  summary: string;
  rationale?: string;
  workspace: WorkspaceRef;
  patchText?: string;
  parameterPayload?: Record<string, unknown>;
  artifactIds?: string[];
}

export interface AttachArtifactRequest {
  kind: string;
  uri: string;
  contentType?: string;
  sizeBytes?: number;
  summary?: string;
}

export interface SubmitValidationRequest {
  nodeId: string;
  kind: ValidationKind;
  verdict: ValidationVerdict;
  metrics?: Record<string, number | string | boolean>;
  artifactIds?: string[];
  note?: string;
}

export interface ProposalActorRequest {
  actor: A2APartyRef;
  note?: string;
}

export interface ApplyProposalRequest extends ProposalActorRequest {
  workspace: WorkspaceRef;
}

export interface ProposalDetails {
  proposal: ChangeProposal;
  artifacts: ArtifactRecord[];
  validations: ValidationResult[];
  audit: AuditEvent[];
}

export interface ProposalListFilters {
  status?: ProposalStatus;
  sourceNodeId?: string;
  targetNodeId?: string;
  kind?: ProposalKind;
}

export interface AuditListFilters {
  proposalId?: string;
  actorId?: string;
  action?: AuditAction;
  targetId?: string;
}

/** Diagnostic status for a delegated run, computed from lifecycle data. */
export type TaskDiagnosticStatus =
  | "active"      // claimed or running with recent heartbeat
  | "stale"       // claimed or running but no recent heartbeat / exceeded expected duration
  | "long_running" // running beyond a configurable threshold
  | "terminal";    // succeeded, failed, or canceled

/** Stable broker-owned classification for downstream reconciliation / interruption handling. */
export type TaskBrokerState = "healthy" | "reconcile_needed" | "interrupted" | "terminal";

/** Distinguishable interruption / reconciliation causes projected from durable broker state. */
export type TaskInterruptionKind =
  | "stale_lease"
  | "stale_worker"
  | "requeued"
  | "operator_canceled"
  | "timeout"
  | "worker_lost"
  | "dead_lettered"
  | "failed";

export interface TaskInterruptionDiagnostic {
  kind: TaskInterruptionKind;
  /** Where this signal came from so plugin/operator lanes do not need to infer it. */
  source: "task_state" | "worker_state" | "audit" | "tombstone";
  summary: string;
  detectedAt?: string;
  actorId?: string;
  reason?: string;
}

/** Reason a tombstone was written. */
export type TombstoneReason =
  | "failed"              // task completed with error
  | "canceled"            // operator/requester canceled
  | "timeout"             // exceeded maximum allowed run time
  | "dead_lettered"       // requeue limit exhausted
  | "worker_lost";        // assigned worker went offline

/** Preserved terminal context for post-mortem inspection. */
export interface TaskTombstone {
  taskId: string;
  terminalStatus: TaskStatus;
  tombstoneReason: TombstoneReason;
  /** Wall-clock duration from creation to termination, in milliseconds. */
  durationMs: number;
  requeueCount: number;
  error?: TaskError;
  result?: TaskResult;
  tombstonedAt: string;
  /** Arbitrary context the broker attaches at tombstone time. */
  metadata?: Record<string, unknown>;
}

/** Stable diagnostic report for downstream consumers (adapter, UI). */
export interface TaskDiagnosticReport {
  taskId: string;
  diagnosticStatus: TaskDiagnosticStatus;
  /** Higher-level broker-owned state for downstream lanes. */
  brokerState: TaskBrokerState;
  /** Whether downstream consumers should reconcile this task from broker state. */
  reconcileNeeded: boolean;
  /** Distinguishable interruption/reconciliation signal when one exists. */
  interruption?: TaskInterruptionDiagnostic;
  /** Current task snapshot (read-only copy). */
  task: TaskRecord;
  /** How long the task has been in its current status, in milliseconds. */
  currentStatusDurationMs: number;
  /** Time since last task heartbeat, in milliseconds. Undefined if never heartbeaten. */
  stalenessMs?: number;
  /** Broker-owned hints that plugin/operator consumers may rely on directly. */
  brokerHints: {
    staleLease: boolean;
    staleWorker: boolean;
    cancellationRequested: boolean;
    requeued: boolean;
    lastRequeueAt?: string;
    lastRequeueReason?: string;
    workerLastSeenAt?: string;
    tombstoneReason?: TombstoneReason;
  };
  /** For terminal tasks: the tombstone, if one was written. */
  tombstone?: TaskTombstone;
  /** Lifecycle summary: key timestamps. */
  lifecycle: {
    createdAt: string;
    claimedAt?: string;
    startedAt?: string;
    lastHeartbeatAt?: string;
    completedAt?: string;
    tombstonedAt?: string;
  };
}

/** Filters for querying tombstones. */
export interface TombstoneListFilters {
  taskId?: string;
  tombstoneReason?: TombstoneReason;
  terminalStatus?: TaskStatus;
  since?: string;
}

/** Dashboard: aggregated summary of broker state for operator visibility. */
export interface BrokerDashboard {
  /** When this summary was computed. */
  generatedAt: string;
  /** Task queue overview. */
  queue: TaskQueueSummary;
  /** Recent task execution history (last N completed/failed). */
  history: TaskHistorySummary;
  /** Proposal pipeline state. */
  proposals: ProposalPipelineSummary;
  /** Worker fleet status. */
  workers: WorkerFleetSummary;
  /** Operator-facing observability summary for queue pressure and recovery cases. */
  observability: BrokerObservabilitySummary;
}

export interface BrokerObservabilitySummary {
  queuePressure: {
    blocked: number;
    queued: number;
    claimed: number;
    running: number;
    staleWorkerAssignments: number;
    oldestClaimed?: Pick<TaskRecord, 'id' | 'intent' | 'targetNodeId' | 'assignedWorkerId' | 'createdAt'> & {
      statusSinceAt: string;
      statusAgeSec: number;
    };
    oldestRunning?: Pick<TaskRecord, 'id' | 'intent' | 'targetNodeId' | 'assignedWorkerId' | 'createdAt'> & {
      statusSinceAt: string;
      statusAgeSec: number;
    };
  };
  recovery: {
    totalRequeued: number;
    totalDeadLettered: number;
    recentRequeues: Array<{
      taskId: string;
      actorId: string;
      createdAt: string;
      note?: string;
    }>;
    recentDeadLetters: Array<Pick<TaskRecord, 'id' | 'intent' | 'targetNodeId' | 'assignedWorkerId' | 'completedAt' | 'error' | 'requeueCount'>>;
  };
  workerHealth: {
    staleWorkersWithActiveTasks: Array<{
      nodeId: string;
      activeTaskCount: number;
      lastSeenAt: string;
      lastSeenAgeSec: number;
    }>;
  };
}

export interface TaskQueueSummary {
  total: number;
  byStatus: Record<TaskStatus, number>;
  byIntent: Record<string, number>;
  /** Tasks waiting longest in their current blocked/queued/claimed state. */
  oldestPending: Array<Pick<TaskRecord, 'id' | 'intent' | 'status' | 'targetNodeId' | 'assignedWorkerId' | 'createdAt'> & {
    statusSinceAt: string;
    statusAgeSec: number;
  }>;
}

export interface TaskHistorySummary {
  /** Number of tasks completed in the last hour. */
  completedLastHour: number;
  /** Number of tasks failed in the last hour. */
  failedLastHour: number;
  /** Total completed (all time). */
  totalCompleted: number;
  /** Total failed (all time). */
  totalFailed: number;
  /** Most recent N task outcomes (succeeded/failed), newest first. */
  recent: Array<Pick<TaskRecord, 'id' | 'intent' | 'status' | 'targetNodeId' | 'completedAt' | 'result' | 'error'>>;
}

export interface ProposalPipelineSummary {
  total: number;
  byStatus: Record<ProposalStatus, number>;
  /** Proposals awaiting validation or approval action. */
  pendingAction: Array<Pick<ChangeProposal, 'id' | 'kind' | 'summary' | 'status' | 'sourceNodeId' | 'targetNodeId' | 'updatedAt'>>;
}

export interface WorkerFleetSummary {
  total: number;
  online: number;
  stale: number;
  /** Per-worker status snapshot. */
  byNode: Array<{
    nodeId: string;
    role: string;
    displayName: string | undefined;
    status: 'online' | 'stale';
    activeTaskCount: number;
    lastSeenAt: string;
    lastSeenAgeSec: number;
  }>;
}

export interface WorkerCapacitySummaryItem {
  nodeId: string;
  role: string;
  displayName: string | undefined;
  status: WorkerStatus;
  lastSeenAt: string;
  lastSeenAgeSec: number;
  counts: {
    queued: number;
    claimed: number;
    running: number;
    stale: number;
    active: number;
  };
  latestTaskUpdatedAt?: string;
}

export interface WorkerCapacitySummary {
  generatedAt: string;
  workerOfflineAfterMs: number;
  taskStaleAfterMs: number;
  totals: {
    workers: number;
    online: number;
    staleWorkers: number;
    queued: number;
    claimed: number;
    running: number;
    staleTasks: number;
    active: number;
  };
  items: WorkerCapacitySummaryItem[];
}

// ---------------------------------------------------------------------------
// Delegated-run types (re-exported from ./delegated-runtime.ts)
// ---------------------------------------------------------------------------

export type {
  DelegatedRunState,
  DelegatedRun,
  DelegatedRunOptions,
  DelegatedRunHandle,
  BrokerTaskBridge,
} from "./delegated-runtime.js";
