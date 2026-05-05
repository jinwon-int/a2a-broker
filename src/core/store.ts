import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { z } from "zod";

import type {
  ArtifactRecord,
  AuditEvent,
  AuditListFilters,
  A2AExchangeMessageRecord,
  A2AExchangeState,
  ChangeProposal,
  ProposalListFilters,
  TaskListFilters,
  GoalRecord,
  TaskRecord,
  TaskTombstone,
  TombstoneListFilters,
  ValidationResult,
  WorkerListFilters,
  WorkerRecord,
} from "./types.js";
import type { ArtifactRuntimeRepository } from "./artifact-repository.js";
import type { AuditRuntimeRepository } from "./audit-repository.js";
import type { ExchangeMessageRuntimeRepository, ExchangeRuntimeRepository } from "./exchange-repository.js";
import type { ProposalRuntimeRepository } from "./proposal-repository.js";
import type { TaskRuntimeRepository } from "./task-repository.js";
import type { TombstoneRuntimeRepository } from "./tombstone-repository.js";
import type { ValidationRuntimeRepository } from "./validation-repository.js";
import type { WorkerRuntimeRepository } from "./worker-repository.js";
import type { TerminalTaskOutboxEvent } from "./terminal-event-outbox.js";

export const CURRENT_BROKER_STATE_VERSION = 8;
export const DEFAULT_BROKER_STATE_MAX_BYTES = 50 * 1024 * 1024;

export interface BrokerSnapshot {
  version: number;
  exchanges: A2AExchangeState[];
  exchangeMessages: A2AExchangeMessageRecord[];
  proposals: ChangeProposal[];
  artifacts: ArtifactRecord[];
  validations: ValidationResult[];
  auditEvents: AuditEvent[];
  workers: WorkerRecord[];
  tasks: TaskRecord[];
  goals?: GoalRecord[];
  tombstones?: TaskTombstone[];
  terminalOutbox?: TerminalTaskOutboxEvent[];
}

export interface BrokerStateStore {
  load(): BrokerSnapshot;
  save(snapshot: BrokerSnapshot, hints?: BrokerStateSaveHints): void;
  getPersistenceInfo?(): BrokerPersistenceInfo;
}

export interface BrokerStateSaveHints {
  hotExchanges?: A2AExchangeState[];
  hotExchangeMessages?: A2AExchangeMessageRecord[];
  hotProposals?: ChangeProposal[];
  hotArtifacts?: ArtifactRecord[];
  hotValidations?: ValidationResult[];
  hotTasks?: TaskRecord[];
  hotTombstones?: TaskTombstone[];
  hotAuditEvents?: AuditEvent[];
  hotWorkers?: WorkerRecord[];
}

export interface BrokerPersistenceInfo {
  kind: string;
  stateVersion: number;
  loadSource?: string;
  schemaVersion?: number;
  stateFile?: string;
  dbFile?: string;
  journalMode?: string;
  hotEntityTables?: string[];
  hotEntityHintTables?: string[];
  hotEntityHintCoverage?: BrokerHotEntityHintCoverage;
  hotEntityMirror?: BrokerHotEntityMirrorStatus;
  hotEntityDiagnostics?: BrokerHotEntityDiagnostics;
  importedFromJsonFile?: string;
  lastImportAt?: string;
}

export interface BrokerHotEntityDiagnostics {
  invalidRows: BrokerInvalidHotEntityRow[];
}

export interface BrokerInvalidHotEntityRow {
  table: string;
  primaryKey: string;
  schemaError: string;
  count: number;
}

export interface BrokerHotEntityHintCoverage {
  ok: boolean;
  supportedTables: string[];
  missingTables: string[];
  supportedCount: number;
  totalCount: number;
}

export interface BrokerHotEntityMirrorStatus {
  ok: boolean;
  tableCounts: Record<string, number>;
  snapshotCounts?: Record<string, number>;
  mismatches: BrokerHotEntityMirrorMismatch[];
  retentionWindows?: BrokerHotEntityMirrorRetentionWindow[];
}

export interface BrokerHotEntityMirrorMismatch {
  table: string;
  snapshotKey: string;
  tableCount: number;
  snapshotCount: number;
  reason?: "count_drift" | "id_drift" | "audit_hot_retention";
}

export interface BrokerHotEntityMirrorRetentionWindow extends BrokerHotEntityMirrorMismatch {
  reason: "audit_hot_retention";
  prunedCount: number;
}

export interface BrokerHotAuditDiagnostics {
  total: number;
  workerHeartbeat: number;
  workerHeartbeatRatio: number;
  warnings: string[];
}

export interface JsonFileBrokerStateStoreOptions {
  maxBytes?: number;
}

export type SqliteBrokerLoadSource = "snapshot" | "hot-tables";

export interface SqliteBrokerStateStoreOptions {
  maxBytes?: number;
  importJsonFile?: string;
  loadSource?: SqliteBrokerLoadSource;
}

export interface SqliteAuditRuntimeRepositoryOptions {
  maxHotAuditEvents?: number;
}

export interface SqliteTaskHotTableFilters {
  id?: string;
  status?: TaskRecord["status"];
  targetNodeId?: string;
  intent?: TaskRecord["intent"];
  assignedWorkerId?: string;
  taskOrigin?: TaskRecord["taskOrigin"];
}

export interface SqliteExchangeHotTableFilters {
  id?: string;
}

export interface SqliteExchangeMessageHotTableFilters {
  id?: string;
  exchangeId?: string;
}

export interface SqliteProposalHotTableFilters {
  id?: string;
  status?: ChangeProposal["status"];
  sourceNodeId?: string;
  targetNodeId?: string;
  kind?: ChangeProposal["kind"];
}

export interface SqliteArtifactHotTableFilters {
  id?: string;
  proposalId?: string;
}

export interface SqliteValidationHotTableFilters {
  id?: string;
  proposalId?: string;
}

export interface SqliteAuditHotTableFilters {
  proposalId?: string;
  actorId?: string;
  action?: AuditEvent["action"];
  targetType?: AuditEvent["targetType"];
  targetId?: string;
}

export interface SqliteWorkerHotTableFilters {
  nodeId?: string;
  role?: WorkerRecord["role"];
}

export interface SqliteTombstoneHotTableFilters {
  taskId?: string;
  tombstoneReason?: TaskTombstone["tombstoneReason"];
  terminalStatus?: TaskTombstone["terminalStatus"];
  since?: string;
}

export interface SqliteHotRetentionPlan {
  table: "broker_exchanges" | "broker_exchange_messages" | "broker_proposals" | "broker_artifacts" | "broker_validations" | "broker_tasks" | "broker_tombstones" | "broker_audit_events" | "broker_workers" | "broker_terminal_outbox";
  cutoffMs: number;
  retainedIds: string[];
  pruneIds: string[];
}

export interface SqliteHotRetentionApplyResult {
  table: SqliteHotRetentionPlan["table"];
  retainedCount: number;
  requestedPruneCount: number;
  prunedCount: number;
  remainingCount: number;
}

export interface SqliteTaskHotRetentionPlanOptions {
  nowMs?: number;
  retentionMs: number;
  maxTerminalRecords: number;
  protectedTaskIds?: string[];
}

export interface SqliteAuditHotRetentionProtection {
  proposalIds?: string[];
  taskIds?: string[];
  exchangeIds?: string[];
  exchangeMessageIds?: string[];
  artifactIds?: string[];
  validationIds?: string[];
  workerIds?: string[];
}

export interface SqliteAuditHotRetentionPlanOptions {
  nowMs?: number;
  retentionMs: number;
  maxRecords: number;
  protectedIds?: SqliteAuditHotRetentionProtection;
}

export interface SqliteWorkerHotRetentionPlanOptions {
  nowMs?: number;
  retentionMs: number;
  maxInactiveWorkers: number;
  protectedWorkerIds?: string[];
}

const SQLITE_SCHEMA_VERSION = 10;
const SQLITE_HOT_ENTITY_TABLES = [
  "broker_exchanges",
  "broker_exchange_messages",
  "broker_proposals",
  "broker_artifacts",
  "broker_validations",
  "broker_tasks",
  "broker_tombstones",
  "broker_workers",
  "broker_audit_events",
  "broker_terminal_outbox",
] as const;
const SQLITE_HOT_ENTITY_HINT_TABLES = [
  "broker_exchanges",
  "broker_exchange_messages",
  "broker_proposals",
  "broker_artifacts",
  "broker_validations",
  "broker_tasks",
  "broker_tombstones",
  "broker_workers",
  "broker_audit_events",
  "broker_terminal_outbox",
] as const;
type SqliteHotEntityTable = typeof SQLITE_HOT_ENTITY_TABLES[number];
type BrokerSnapshotArrayKey = Exclude<{
  [K in keyof BrokerSnapshot]: BrokerSnapshot[K] extends unknown[] | undefined ? K : never;
}[keyof BrokerSnapshot], undefined>;
const SQLITE_HOT_ENTITY_SNAPSHOT_KEYS: Record<SqliteHotEntityTable, BrokerSnapshotArrayKey> = {
  broker_exchanges: "exchanges",
  broker_exchange_messages: "exchangeMessages",
  broker_proposals: "proposals",
  broker_artifacts: "artifacts",
  broker_validations: "validations",
  broker_tasks: "tasks",
  broker_tombstones: "tombstones",
  broker_workers: "workers",
  broker_audit_events: "auditEvents",
  broker_terminal_outbox: "terminalOutbox",
};

const partyRefSchema = z
  .object({
    id: z.string().min(1),
    kind: z.string().optional(),
    role: z.string().optional(),
  })
  .passthrough();

const workspaceRefSchema = z
  .object({
    nodeId: z.string().min(1),
    workspaceId: z.string().min(1),
    pathHint: z.string().optional(),
    branch: z.string().optional(),
    strategyId: z.string().optional(),
  })
  .passthrough();

const exchangeViaObjectSchema = z
  .object({
    transport: z.string().min(1).optional(),
    channel: z.string().min(1).optional(),
    nodeId: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
    traceId: z.string().min(1).optional(),
  })
  .passthrough();

const exchangeViaSchema = z.union([
  exchangeViaObjectSchema,
  z.string().min(1).transform((transport) => ({ transport })),
]);

const exchangeStateSchema = z
  .object({
    id: z.string().min(1),
    requester: partyRefSchema,
    target: partyRefSchema,
    targetNodeId: z.string().min(1),
    assignedWorkerId: z.string().min(1).optional(),
    message: z.string(),
    maxTurns: z.number(),
    intent: z.string().min(1),
    status: z.string().min(1),
    currentDecision: z.string().min(1).optional(),
    rootMessageId: z.string(),
    latestMessageId: z.string(),
    messageCount: z.number(),
    lastMessageAt: z.string(),
    activeTaskId: z.string().min(1).optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

const exchangeMessageSchema = z
  .object({
    id: z.string().min(1),
    exchangeId: z.string().min(1),
    kind: z.string().min(1),
    message: z.string(),
    requester: partyRefSchema.optional(),
    actor: partyRefSchema.optional(),
    via: exchangeViaSchema.optional(),
    decision: z.string().min(1).optional(),
    targetNodeId: z.string().min(1).optional(),
    assignedWorkerId: z.string().min(1).optional(),
    parentMessageId: z.string().min(1).optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

const taskValidationPayloadSchema = z
  .object({
    nodeId: z.string().min(1).optional(),
    kind: z.string().min(1),
    verdict: z.string().min(1),
    metrics: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    artifactIds: z.array(z.string()).optional(),
    note: z.string().optional(),
  })
  .passthrough();

const taskApplyPayloadSchema = z
  .object({
    workspace: workspaceRefSchema.optional(),
    artifactIds: z.array(z.string()).optional(),
    note: z.string().optional(),
  })
  .passthrough();

const taskResultSchema = z
  .object({
    summary: z.string().optional(),
    note: z.string().optional(),
    artifactIds: z.array(z.string()).optional(),
    output: z.record(z.string(), z.unknown()).optional(),
    validation: taskValidationPayloadSchema.optional(),
    apply: taskApplyPayloadSchema.optional(),
  })
  .passthrough();

const taskErrorSchema = z
  .object({
    code: z.string().optional(),
    message: z.string().min(1),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const taskCancellationSchema = z
  .object({
    requestedAt: z.string(),
    requestedBy: z.string().min(1),
    reason: z.string().optional(),
    sourceTaskId: z.string().min(1).optional(),
  })
  .passthrough();

const taskApprovalSchema = z
  .object({
    approvalId: z.string().min(1),
    approvedAt: z.string(),
    approvedBy: z.string().min(1),
    actorRole: z.string().optional(),
    requesterRole: z.string().optional(),
    reason: z.string().optional(),
  })
  .passthrough();

const taskApprovalOutcomeSchema = z
  .object({
    status: z.enum(["approved", "rejected", "expired", "canceled"]),
    approvalId: z.string().min(1),
    decidedAt: z.string(),
    decidedBy: z.string().min(1),
    actorRole: z.string().optional(),
    requesterRole: z.string().optional(),
    reason: z.string().optional(),
  })
  .passthrough();

const taskPolicyContextSchema = z
  .object({
    requiresApproval: z.boolean().optional(),
    liveImpact: z.boolean().optional(),
    targetEnvironment: z.string().min(1).optional(),
  })
  .passthrough();


const taskWakeSchema = z
  .object({
    status: z.enum(["planned", "scheduled", "skipped", "failed"]),
    wakeKey: z.string().min(1),
    idempotencyKey: z.string().min(1),
    targetSessionKey: z.string().min(1),
    targetNodeId: z.string().min(1).optional(),
    waitRunId: z.string().min(1).optional(),
    correlationId: z.string().min(1).optional(),
    parentRunId: z.string().min(1).optional(),
    coalesced: z.boolean().optional(),
    runtimeRunId: z.string().min(1).optional(),
    code: z.string().min(1).optional(),
    message: z.string().optional(),
    plannedAt: z.string().min(1),
    updatedAt: z.string().min(1),
    decidedAt: z.string().min(1).optional(),
    replayCount: z.number().int().nonnegative().optional(),
  })
  .passthrough();

const taskSchema = z
  .object({
    id: z.string().min(1),
    exchangeId: z.string().min(1).optional(),
    parentTaskId: z.string().min(1).optional(),
    intent: z.string().min(1),
    requester: partyRefSchema,
    target: partyRefSchema,
    workspace: workspaceRefSchema.optional(),
    message: z.string().optional(),
    proposalId: z.string().min(1).optional(),
    artifactIds: z.array(z.string()).optional(),
    assignedWorkerId: z.string().min(1).optional(),
    via: exchangeViaSchema.optional(),
    policyContext: taskPolicyContextSchema.optional(),
    createdAt: z.string(),
    status: z.string().min(1),
    targetNodeId: z.string().min(1),
    payload: z.record(z.string(), z.unknown()),
    updatedAt: z.string(),
    claimedAt: z.string().optional(),
    completedAt: z.string().optional(),
    claimedBy: z.string().min(1).optional(),
    result: taskResultSchema.optional(),
    error: taskErrorSchema.optional(),
    cancellation: taskCancellationSchema.optional(),
    approval: taskApprovalSchema.optional(),
    approvalOutcome: taskApprovalOutcomeSchema.optional(),
    requeueCount: z.number().int().nonnegative().optional(),
    lastHeartbeatAt: z.string().optional(),
    attemptId: z.string().min(1).optional(),
    wake: taskWakeSchema.optional(),
    taskOrigin: z.enum(["github", "api", "sessions_send", "operator", "unknown"]).optional(),
  })
  .passthrough();

const proposalSchema = z
  .object({
    id: z.string().min(1),
    source: partyRefSchema,
    target: partyRefSchema,
    sourceNodeId: z.string().min(1),
    targetNodeId: z.string().min(1),
    kind: z.string().min(1),
    summary: z.string().min(1),
    rationale: z.string().optional(),
    workspace: workspaceRefSchema,
    patchText: z.string().optional(),
    parameterPayload: z.record(z.string(), z.unknown()).optional(),
    artifactIds: z.array(z.string()),
    status: z.string().min(1),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

const artifactSchema = z
  .object({
    id: z.string().min(1),
    proposalId: z.string().min(1),
    kind: z.string().min(1),
    uri: z.string().min(1),
    contentType: z.string().optional(),
    sizeBytes: z.number().optional(),
    summary: z.string().optional(),
    createdAt: z.string(),
  })
  .passthrough();

const validationSchema = z
  .object({
    id: z.string().min(1),
    proposalId: z.string().min(1),
    nodeId: z.string().min(1),
    kind: z.string().min(1),
    verdict: z.string().min(1),
    metrics: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    artifactIds: z.array(z.string()),
    note: z.string().optional(),
    createdAt: z.string(),
  })
  .passthrough();

const auditEventSchema = z
  .object({
    id: z.string().min(1),
    actorId: z.string().min(1),
    action: z.string().min(1),
    targetType: z.string().min(1),
    targetId: z.string().min(1),
    proposalId: z.string().min(1).optional(),
    note: z.string().optional(),
    createdAt: z.string(),
  })
  .passthrough();

const workerCapabilitiesSchema = z
  .object({
    canAnalyze: z.boolean(),
    canBackfill: z.boolean(),
    canPatchWorkspace: z.boolean(),
    canPromoteLive: z.boolean(),
    workspaceIds: z.array(z.string()),
    environments: z.array(z.string()),
  })
  .passthrough();

const workerSchema = z
  .object({
    nodeId: z.string().min(1),
    role: z.string().min(1),
    displayName: z.string().optional(),
    brokerUrl: z.string().optional(),
    capabilities: workerCapabilitiesSchema,
    metadata: z.record(z.string(), z.string()).optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
    lastSeenAt: z.string(),
  })
  .passthrough();

const tombstoneSchema = z
  .object({
    taskId: z.string().min(1),
    terminalStatus: z.string().min(1),
    tombstoneReason: z.string().min(1),
    durationMs: z.number(),
    requeueCount: z.number(),
    error: taskErrorSchema.optional(),
    result: taskResultSchema.optional(),
    tombstonedAt: z.string().min(1),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const terminalOutboxEventSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal("task.terminal"),
    taskEventId: z.number().int().nonnegative(),
    payload: z
      .object({
        taskId: z.string().min(1),
        status: z.enum(["succeeded", "failed", "canceled", "blocked"]),
        worker: z.string().optional(),
        repo: z.string().optional(),
        issue: z.number().int().nonnegative().optional(),
        prUrl: z.string().url().optional(),
        doneUrl: z.string().url().optional(),
        blockUrl: z.string().url().optional(),
        testSummary: z.string().optional(),
        createdAt: z.string(),
        updatedAt: z.string(),
        completedAt: z.string().optional(),
      })
      .passthrough(),
    createdAt: z.string(),
    ack: z
      .object({
        status: z.literal("receipt_confirmed"),
        evidence: z.enum(["operator_visible", "operator_confirmed", "provider_delivery_receipt"]),
        acknowledgedAt: z.string(),
        receiptId: z.string().optional(),
        note: z.string().optional(),
      })
      .passthrough()
      .optional(),
    receipt: z
      .object({
        status: z.enum(["accepted", "started", "produced", "provider_sent", "operator_visible", "timed_out", "stale", "failed", "sent", "provider_delivered_if_known"]),
        updatedAt: z.string(),
        evidence: z.enum(["operator_visible", "operator_confirmed", "provider_delivery_receipt"]).optional(),
        receiptId: z.string().optional(),
        note: z.string().optional(),
      })
      .passthrough()
      .optional(),
    deliveredAt: z.string().optional(),
    attempts: z.number().int().nonnegative(),
  })
  .passthrough();

const brokerSnapshotSchema = z
  .object({
    version: z.number().int().nonnegative().optional().default(CURRENT_BROKER_STATE_VERSION),
    exchanges: z.array(exchangeStateSchema).optional().default([]),
    exchangeMessages: z.array(exchangeMessageSchema).optional().default([]),
    proposals: z.array(proposalSchema).optional().default([]),
    artifacts: z.array(artifactSchema).optional().default([]),
    validations: z.array(validationSchema).optional().default([]),
    auditEvents: z.array(auditEventSchema).optional().default([]),
    workers: z.array(workerSchema).optional().default([]),
    tasks: z.array(taskSchema).optional().default([]),
    tombstones: z.array(tombstoneSchema).optional().default([]),
    terminalOutbox: z.array(terminalOutboxEventSchema).optional().default([]),
  })
  .passthrough();

export class JsonFileBrokerStateStore implements BrokerStateStore {
  private readonly maxBytes: number;

  constructor(
    private readonly filePath: string,
    options: JsonFileBrokerStateStoreOptions = {},
  ) {
    this.maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_BROKER_STATE_MAX_BYTES);
  }

  load(): BrokerSnapshot {
    try {
      const stat = statSync(this.filePath);
      if (stat.size > this.maxBytes) {
        throw new Error(
          `broker snapshot exceeds max size (${stat.size} > ${this.maxBytes} bytes): ${this.filePath}`,
        );
      }

      const raw = readFileSync(this.filePath, "utf8");
      const parsed = brokerSnapshotSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        throw new Error(
          `invalid broker snapshot at ${this.filePath}: ${parsed.error.issues[0]?.message ?? "unknown schema error"}`,
        );
      }
      return parsed.data as BrokerSnapshot;
    } catch (error) {
      if (isMissingFileError(error)) {
        return emptySnapshot();
      }
      throw error;
    }
  }

  save(snapshot: BrokerSnapshot, _hints?: BrokerStateSaveHints): void {
    writeBrokerSnapshotFile(this.filePath, snapshot, this.maxBytes);
  }

  getPersistenceInfo(): BrokerPersistenceInfo {
    return {
      kind: "json-file",
      stateFile: this.filePath,
      stateVersion: CURRENT_BROKER_STATE_VERSION,
    };
  }
}

export class SqliteBrokerStateStore implements BrokerStateStore {
  private readonly maxBytes: number;
  private readonly importJsonFile?: string;
  private readonly loadSource: SqliteBrokerLoadSource;
  private readonly db: DatabaseSync;
  private readonly journalMode: string;

  constructor(
    private readonly dbFile: string,
    options: SqliteBrokerStateStoreOptions = {},
  ) {
    this.maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_BROKER_STATE_MAX_BYTES);
    this.importJsonFile = options.importJsonFile;
    this.loadSource = options.loadSource ?? "snapshot";
    if (dbFile !== ":memory:") {
      mkdirSync(dirname(dbFile), { recursive: true });
    }
    this.db = new DatabaseSync(dbFile);
    this.journalMode = this.initializeDatabase();
  }

  load(): BrokerSnapshot {
    if (this.loadSource === "hot-tables") {
      return this.loadHotRuntimeSnapshot();
    }
    return this.loadCanonicalSnapshot();
  }

  save(snapshot: BrokerSnapshot, hints?: BrokerStateSaveHints): void {
    this.saveSnapshot(snapshot, hints);
  }

  readHotRuntimeSnapshot(): BrokerSnapshot {
    return {
      version: CURRENT_BROKER_STATE_VERSION,
      exchanges: this.readHotExchanges(),
      exchangeMessages: this.readHotExchangeMessages(),
      proposals: this.readHotProposals(),
      artifacts: this.readHotArtifacts(),
      validations: this.readHotValidations(),
      auditEvents: this.readHotAuditEvents(),
      workers: this.readHotWorkers(),
      tasks: this.readHotTasks(),
      tombstones: this.readHotTombstones(),
      terminalOutbox: this.readHotTerminalOutbox(),
    };
  }

  readHotTasks(filters: SqliteTaskHotTableFilters = {}): TaskRecord[] {
    const { sql, params } = buildHotTableSelect(
      "broker_tasks",
      [
        ["id", filters.id],
        ["status", filters.status],
        ["target_node_id", filters.targetNodeId],
        ["intent", filters.intent],
        ["assigned_worker_id", filters.assignedWorkerId],
        ["task_origin", filters.taskOrigin],
      ],
      "updated_at DESC, id ASC",
    );
    return this.db
      .prepare(sql)
      .all(...params)
      .map((row) => parseHotEntityPayload(row, taskSchema, "broker_tasks")) as TaskRecord[];
  }

  readHotExchanges(filters: SqliteExchangeHotTableFilters = {}): A2AExchangeState[] {
    const { sql, params } = buildHotTableSelect(
      "broker_exchanges",
      [["id", filters.id]],
      "created_at DESC, id ASC",
    );
    return this.db
      .prepare(sql)
      .all(...params)
      .map((row) => parseHotEntityPayload(row, exchangeStateSchema, "broker_exchanges")) as A2AExchangeState[];
  }

  readHotExchangeMessages(filters: SqliteExchangeMessageHotTableFilters = {}): A2AExchangeMessageRecord[] {
    const { sql, params } = buildHotTableSelect(
      "broker_exchange_messages",
      [
        ["id", filters.id],
        ["exchange_id", filters.exchangeId],
      ],
      "created_at ASC, CASE WHEN kind = 'root' THEN 0 ELSE 1 END ASC, id ASC",
    );
    return this.db
      .prepare(sql)
      .all(...params)
      .map((row) => parseHotEntityPayload(row, exchangeMessageSchema, "broker_exchange_messages")) as A2AExchangeMessageRecord[];
  }

  readHotProposals(filters: SqliteProposalHotTableFilters = {}): ChangeProposal[] {
    const { sql, params } = buildHotTableSelect(
      "broker_proposals",
      [
        ["id", filters.id],
        ["status", filters.status],
        ["source_node_id", filters.sourceNodeId],
        ["target_node_id", filters.targetNodeId],
        ["kind", filters.kind],
      ],
      "created_at DESC, id ASC",
    );
    return this.db
      .prepare(sql)
      .all(...params)
      .map((row) => parseHotEntityPayload(row, proposalSchema, "broker_proposals")) as ChangeProposal[];
  }

  readHotArtifacts(filters: SqliteArtifactHotTableFilters = {}): ArtifactRecord[] {
    const { sql, params } = buildHotTableSelect(
      "broker_artifacts",
      [
        ["id", filters.id],
        ["proposal_id", filters.proposalId],
      ],
      "created_at DESC, id ASC",
    );
    return this.db
      .prepare(sql)
      .all(...params)
      .map((row) => parseHotEntityPayload(row, artifactSchema, "broker_artifacts")) as ArtifactRecord[];
  }

  readHotValidations(filters: SqliteValidationHotTableFilters = {}): ValidationResult[] {
    const { sql, params } = buildHotTableSelect(
      "broker_validations",
      [
        ["id", filters.id],
        ["proposal_id", filters.proposalId],
      ],
      "created_at DESC, id ASC",
    );
    return this.db
      .prepare(sql)
      .all(...params)
      .map((row) => parseHotEntityPayload(row, validationSchema, "broker_validations")) as ValidationResult[];
  }

  readHotWorkers(filters: SqliteWorkerHotTableFilters = {}): WorkerRecord[] {
    const { sql, params } = buildHotTableSelect(
      "broker_workers",
      [
        ["node_id", filters.nodeId],
        ["role", filters.role],
      ],
      "last_seen_at DESC, node_id ASC",
    );
    return this.db
      .prepare(sql)
      .all(...params)
      .flatMap((row) => parseHotEntityPayloadSafe(row, workerSchema, "broker_workers")) as WorkerRecord[];
  }

  readHotTombstones(filters: SqliteTombstoneHotTableFilters = {}): TaskTombstone[] {
    const { sql, params } = buildHotTableSelect(
      "broker_tombstones",
      [
        ["task_id", filters.taskId],
        ["tombstone_reason", filters.tombstoneReason],
        ["terminal_status", filters.terminalStatus],
      ],
      "tombstoned_at DESC, task_id ASC",
    );
    const tombstones = this.db
      .prepare(sql)
      .all(...params)
      .map((row) => parseHotEntityPayload(row, tombstoneSchema, "broker_tombstones")) as TaskTombstone[];
    return filters.since
      ? tombstones.filter((tombstone) => tombstone.tombstonedAt >= filters.since!)
      : tombstones;
  }

  readHotTerminalOutbox(): TerminalTaskOutboxEvent[] {
    return this.db
      .prepare("SELECT payload FROM broker_terminal_outbox ORDER BY created_at ASC, id ASC")
      .all()
      .map((row) => parseHotEntityPayload(row, terminalOutboxEventSchema, "broker_terminal_outbox")) as TerminalTaskOutboxEvent[];
  }

  readHotAuditEvents(filters: SqliteAuditHotTableFilters = {}): AuditEvent[] {
    const { sql, params } = buildHotTableSelect(
      "broker_audit_events",
      [
        ["action", filters.action],
        ["target_type", filters.targetType],
        ["target_id", filters.targetId],
      ],
      "created_at DESC, id ASC",
    );
    const events = this.db
      .prepare(sql)
      .all(...params)
      .map((row) => parseHotEntityPayload(row, auditEventSchema, "broker_audit_events")) as AuditEvent[];
    return events.filter((event) => {
      if (filters.proposalId && event.proposalId !== filters.proposalId) {
        return false;
      }
      if (filters.actorId && event.actorId !== filters.actorId) {
        return false;
      }
      return true;
    });
  }

  close(): void {
    this.db.close();
  }

  getPersistenceInfo(): BrokerPersistenceInfo {
    return {
      kind: "sqlite",
      dbFile: this.dbFile,
      stateVersion: CURRENT_BROKER_STATE_VERSION,
      loadSource: this.loadSource,
      schemaVersion: SQLITE_SCHEMA_VERSION,
      journalMode: this.journalMode,
      hotEntityTables: [...SQLITE_HOT_ENTITY_TABLES],
      hotEntityHintTables: [...SQLITE_HOT_ENTITY_HINT_TABLES],
      hotEntityHintCoverage: this.readHotEntityHintCoverage(),
      hotEntityMirror: this.readHotEntityMirrorStatus(),
      hotEntityDiagnostics: this.readHotEntityDiagnostics(),
      importedFromJsonFile: this.readMetadata("imported_from_json_file"),
      lastImportAt: this.readMetadata("last_import_at"),
    };
  }

  readHotEntityHintCoverage(): BrokerHotEntityHintCoverage {
    return buildHotEntityHintCoverage(SQLITE_HOT_ENTITY_TABLES, SQLITE_HOT_ENTITY_HINT_TABLES);
  }

  readHotEntityDiagnostics(): BrokerHotEntityDiagnostics {
    return {
      invalidRows: this.readInvalidHotWorkerRows(),
    };
  }

  private readInvalidHotWorkerRows(): BrokerInvalidHotEntityRow[] {
    const invalidRows = (this.db
      .prepare("SELECT node_id AS primaryKey, payload FROM broker_workers ORDER BY node_id ASC")
      .all() as Array<{ primaryKey?: unknown; payload?: unknown }>).flatMap((row): BrokerInvalidHotEntityRow[] => {
        const parsed = parseHotEntityPayloadResult(row, workerSchema, "broker_workers");
        if (parsed.success) {
          return [];
        }
        return [{
          table: "broker_workers",
          primaryKey: sanitizeDiagnosticValue(row.primaryKey),
          schemaError: parsed.error,
          count: 1,
        }];
      });
    return coalesceInvalidHotEntityRows(invalidRows);
  }

  readHotEntityMirrorStatus(): BrokerHotEntityMirrorStatus {
    const tableCounts = this.readHotEntityTableCounts();
    const snapshot = this.readSnapshotRow();
    if (!snapshot) {
      return {
        ok: Object.values(tableCounts).every((count) => count === 0),
        tableCounts,
        mismatches: Object.entries(tableCounts)
          .filter(([, tableCount]) => tableCount !== 0)
          .map(([table, tableCount]) => ({
            table,
            snapshotKey: SQLITE_HOT_ENTITY_SNAPSHOT_KEYS[table as SqliteHotEntityTable],
            tableCount,
            snapshotCount: 0,
          })),
      };
    }

    const snapshotCounts = countSnapshotEntities(snapshot);
    const snapshotAuditIds = new Set((snapshot.auditEvents ?? []).map((event) => event.id));
    const retentionWindows: BrokerHotEntityMirrorRetentionWindow[] = [];
    const mismatches: BrokerHotEntityMirrorMismatch[] = SQLITE_HOT_ENTITY_TABLES.flatMap((table): BrokerHotEntityMirrorMismatch[] => {
      const snapshotKey = SQLITE_HOT_ENTITY_SNAPSHOT_KEYS[table];
      const tableCount = tableCounts[table] ?? 0;
      const snapshotCount = snapshotCounts[snapshotKey] ?? 0;
      if (table === "broker_audit_events") {
        const hotAuditIds = this.readTableIds("broker_audit_events");
        const hotAuditIdsAreSnapshotRows = hotAuditIds.every((id) => snapshotAuditIds.has(id));
        if (tableCount < snapshotCount && hotAuditIdsAreSnapshotRows) {
          retentionWindows.push({
            table,
            snapshotKey,
            tableCount,
            snapshotCount,
            reason: "audit_hot_retention",
            prunedCount: snapshotCount - tableCount,
          });
          return [];
        }
        if (tableCount === snapshotCount && hotAuditIdsAreSnapshotRows) {
          return [];
        }
        return [{
          table,
          snapshotKey,
          tableCount,
          snapshotCount,
          reason: tableCount === snapshotCount ? "id_drift" as const : "count_drift" as const,
        }];
      }
      if (tableCount === snapshotCount) {
        return [];
      }
      return [{ table, snapshotKey, tableCount, snapshotCount }];
    });
    return {
      ok: mismatches.length === 0,
      tableCounts,
      snapshotCounts,
      mismatches,
      ...(retentionWindows.length > 0 ? { retentionWindows } : {}),
    };
  }

  readHotEntityTableCounts(): Record<string, number> {
    return Object.fromEntries(
      SQLITE_HOT_ENTITY_TABLES.map((table) => [table, this.readTableCount(table)]),
    );
  }

  readHotAuditDiagnostics(): BrokerHotAuditDiagnostics {
    const total = this.readTableCount("broker_audit_events");
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM broker_audit_events WHERE action = 'worker.heartbeat'").get() as
      | { count?: number | bigint }
      | undefined;
    const workerHeartbeat = typeof row?.count === "bigint"
      ? Number(row.count)
      : typeof row?.count === "number" ? row.count : 0;
    const workerHeartbeatRatio = total > 0 ? workerHeartbeat / total : 0;
    const warnings: string[] = [];
    if (total > 8_000) {
      warnings.push(`broker_audit_events has ${total} rows; expected SQLite hot-table retention near 5000`);
    }
    if (total > 0 && workerHeartbeatRatio > 0.8) {
      warnings.push(`worker.heartbeat audit events are ${Math.round(workerHeartbeatRatio * 100)}% of broker_audit_events`);
    }
    return { total, workerHeartbeat, workerHeartbeatRatio, warnings };
  }

  planHotTaskRetention(options: SqliteTaskHotRetentionPlanOptions): SqliteHotRetentionPlan {
    const records = this.db
      .prepare("SELECT payload FROM broker_tasks")
      .all()
      .map((row) => parseHotEntityPayload(row, taskSchema, "broker_tasks")) as TaskRecord[];
    return planTaskRetentionFromRecords(records, options);
  }

  planHotAuditRetention(options: SqliteAuditHotRetentionPlanOptions): SqliteHotRetentionPlan {
    const records = this.db
      .prepare("SELECT payload FROM broker_audit_events")
      .all()
      .map((row) => parseHotEntityPayload(row, auditEventSchema, "broker_audit_events")) as AuditEvent[];
    return planAuditRetentionFromRecords(records, options);
  }

  planHotWorkerRetention(options: SqliteWorkerHotRetentionPlanOptions): SqliteHotRetentionPlan {
    const records = this.db
      .prepare("SELECT payload FROM broker_workers")
      .all()
      .map((row) => parseHotEntityPayload(row, workerSchema, "broker_workers")) as WorkerRecord[];
    return planWorkerRetentionFromRecords(records, options);
  }

  applyHotRetentionPlan(plan: SqliteHotRetentionPlan): SqliteHotRetentionApplyResult {
    let result: SqliteHotRetentionApplyResult | undefined;
    this.runImmediateTransaction(() => {
      result = this.applyHotRetentionPlanUnsafe(plan);
    });
    return result!;
  }

  applyHotRetentionPlans(plans: SqliteHotRetentionPlan[]): SqliteHotRetentionApplyResult[] {
    const results: SqliteHotRetentionApplyResult[] = [];
    this.runImmediateTransaction(() => {
      for (const plan of plans) {
        results.push(this.applyHotRetentionPlanUnsafe(plan));
      }
    });
    return results;
  }

  upsertHotTasks(tasks: TaskRecord[]): void {
    this.runImmediateTransaction(() => {
      this.upsertHotTasksUnsafe(tasks);
    });
  }

  upsertHotExchanges(exchanges: A2AExchangeState[]): void {
    this.runImmediateTransaction(() => {
      this.upsertHotExchangesUnsafe(exchanges);
    });
  }

  upsertHotExchangeMessages(messages: A2AExchangeMessageRecord[]): void {
    this.runImmediateTransaction(() => {
      this.upsertHotExchangeMessagesUnsafe(messages);
    });
  }

  upsertHotProposals(proposals: ChangeProposal[]): void {
    this.runImmediateTransaction(() => {
      this.upsertHotProposalsUnsafe(proposals);
    });
  }

  upsertHotArtifacts(artifacts: ArtifactRecord[]): void {
    this.runImmediateTransaction(() => {
      this.upsertHotArtifactsUnsafe(artifacts);
    });
  }

  upsertHotValidations(validations: ValidationResult[]): void {
    this.runImmediateTransaction(() => {
      this.upsertHotValidationsUnsafe(validations);
    });
  }

  upsertHotAuditEvents(events: AuditEvent[]): void {
    this.runImmediateTransaction(() => {
      this.upsertHotAuditEventsUnsafe(events);
    });
  }

  pruneHotAuditEventsToMax(maxRecords: number): SqliteHotRetentionApplyResult {
    const max = Math.max(0, Math.floor(maxRecords));
    let result: SqliteHotRetentionApplyResult | undefined;
    this.runImmediateTransaction(() => {
      const before = this.readTableCount("broker_audit_events");
      if (before <= max) {
        result = {
          table: "broker_audit_events",
          retainedCount: before,
          requestedPruneCount: 0,
          prunedCount: 0,
          remainingCount: before,
        };
        return;
      }
      const deleteResult = this.db.prepare(
        `DELETE FROM broker_audit_events
         WHERE id IN (
           SELECT id FROM broker_audit_events
           ORDER BY created_at DESC, id DESC
           LIMIT -1 OFFSET ?
         )`,
      ).run(max);
      const remaining = this.readTableCount("broker_audit_events");
      result = {
        table: "broker_audit_events",
        retainedCount: max,
        requestedPruneCount: before - max,
        prunedCount: Number(deleteResult.changes ?? 0),
        remainingCount: remaining,
      };
    });
    return result!;
  }

  upsertHotWorkers(workers: WorkerRecord[]): void {
    this.runImmediateTransaction(() => {
      this.upsertHotWorkersUnsafe(workers);
    });
  }

  upsertHotTombstones(tombstones: TaskTombstone[]): void {
    this.runImmediateTransaction(() => {
      this.upsertHotTombstonesUnsafe(tombstones);
    });
  }

  private initializeDatabase(): string {
    const journal = this.db.prepare("PRAGMA journal_mode = WAL").get() as
      | { journal_mode?: string }
      | undefined;
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS broker_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS broker_snapshots (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS broker_tasks (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        intent TEXT NOT NULL,
        target_node_id TEXT NOT NULL,
        assigned_worker_id TEXT,
        task_origin TEXT NOT NULL DEFAULT 'unknown',
        updated_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS broker_tasks_status_updated_idx
        ON broker_tasks(status, updated_at);
      CREATE INDEX IF NOT EXISTS broker_tasks_updated_id_idx
        ON broker_tasks(updated_at DESC, id ASC);
      CREATE INDEX IF NOT EXISTS broker_tasks_status_updated_id_idx
        ON broker_tasks(status, updated_at DESC, id ASC);
      CREATE INDEX IF NOT EXISTS broker_tasks_worker_status_idx
        ON broker_tasks(assigned_worker_id, status);
      CREATE INDEX IF NOT EXISTS broker_tasks_worker_status_updated_id_idx
        ON broker_tasks(assigned_worker_id, status, updated_at DESC, id ASC);
      CREATE INDEX IF NOT EXISTS broker_tasks_target_status_idx
        ON broker_tasks(target_node_id, status);
      CREATE INDEX IF NOT EXISTS broker_tasks_intent_status_idx
        ON broker_tasks(intent, status);
      CREATE TABLE IF NOT EXISTS broker_exchanges (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        intent TEXT NOT NULL,
        target_node_id TEXT NOT NULL,
        assigned_worker_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS broker_exchanges_created_idx
        ON broker_exchanges(created_at);
      CREATE TABLE IF NOT EXISTS broker_exchange_messages (
        id TEXT PRIMARY KEY,
        exchange_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        parent_message_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS broker_exchange_messages_exchange_created_idx
        ON broker_exchange_messages(exchange_id, created_at);
      CREATE INDEX IF NOT EXISTS broker_exchange_messages_parent_idx
        ON broker_exchange_messages(exchange_id, parent_message_id);
      CREATE TABLE IF NOT EXISTS broker_proposals (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        kind TEXT NOT NULL,
        source_node_id TEXT NOT NULL,
        target_node_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS broker_proposals_status_updated_idx
        ON broker_proposals(status, updated_at);
      CREATE INDEX IF NOT EXISTS broker_proposals_source_status_idx
        ON broker_proposals(source_node_id, status);
      CREATE INDEX IF NOT EXISTS broker_proposals_target_status_idx
        ON broker_proposals(target_node_id, status);
      CREATE INDEX IF NOT EXISTS broker_proposals_kind_status_idx
        ON broker_proposals(kind, status);
      CREATE TABLE IF NOT EXISTS broker_artifacts (
        id TEXT PRIMARY KEY,
        proposal_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        created_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS broker_artifacts_proposal_created_idx
        ON broker_artifacts(proposal_id, created_at);
      CREATE TABLE IF NOT EXISTS broker_validations (
        id TEXT PRIMARY KEY,
        proposal_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        verdict TEXT NOT NULL,
        created_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS broker_validations_proposal_created_idx
        ON broker_validations(proposal_id, created_at);
      CREATE INDEX IF NOT EXISTS broker_validations_verdict_idx
        ON broker_validations(verdict, created_at);
      CREATE TABLE IF NOT EXISTS broker_workers (
        node_id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS broker_workers_last_seen_idx
        ON broker_workers(last_seen_at);
      CREATE TABLE IF NOT EXISTS broker_tombstones (
        task_id TEXT PRIMARY KEY,
        terminal_status TEXT NOT NULL,
        tombstone_reason TEXT NOT NULL,
        tombstoned_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS broker_tombstones_reason_idx
        ON broker_tombstones(tombstone_reason, tombstoned_at);
      CREATE INDEX IF NOT EXISTS broker_tombstones_status_idx
        ON broker_tombstones(terminal_status, tombstoned_at);
      CREATE TABLE IF NOT EXISTS broker_audit_events (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS broker_audit_events_target_idx
        ON broker_audit_events(target_type, target_id, created_at);
      CREATE INDEX IF NOT EXISTS broker_audit_events_action_idx
        ON broker_audit_events(action, created_at);
      CREATE TABLE IF NOT EXISTS broker_terminal_outbox (
        id TEXT PRIMARY KEY,
        task_event_id INTEGER NOT NULL,
        acknowledged_at TEXT,
        created_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS broker_terminal_outbox_unacked_idx
        ON broker_terminal_outbox(acknowledged_at, created_at);
    `);
    this.ensureColumn("broker_tasks", "task_origin", "TEXT NOT NULL DEFAULT 'unknown'");
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS broker_tasks_origin_status_idx
        ON broker_tasks(task_origin, status);
    `);
    this.writeMetadata("schema_version", String(SQLITE_SCHEMA_VERSION));
    this.writeMetadata("state_version", String(CURRENT_BROKER_STATE_VERSION));
    return journal?.journal_mode ?? "unknown";
  }

  private saveImportedJsonSnapshot(snapshot: BrokerSnapshot, jsonFile: string): void {
    const importedAt = new Date().toISOString();
    this.runImmediateTransaction(() => {
      this.writeSnapshotRow(snapshot, importedAt);
      this.writeMetadata("imported_from_json_file", jsonFile);
      this.writeMetadata("last_import_at", importedAt);
    });
  }

  private loadCanonicalSnapshot(): BrokerSnapshot {
    const row = this.db
      .prepare("SELECT payload FROM broker_snapshots WHERE id = 1")
      .get() as { payload?: string } | undefined;
    if (typeof row?.payload === "string") {
      return parseSnapshotPayload(row.payload, `SQLite broker snapshot at ${this.dbFile}`, this.maxBytes);
    }

    if (this.importJsonFile && existsSync(this.importJsonFile)) {
      const imported = new JsonFileBrokerStateStore(this.importJsonFile, {
        maxBytes: this.maxBytes,
      }).load();
      this.saveImportedJsonSnapshot(imported, this.importJsonFile);
      return imported;
    }

    return emptySnapshot();
  }

  private loadHotRuntimeSnapshot(): BrokerSnapshot {
    const hotSnapshot = this.readHotRuntimeSnapshot();
    if (
      hasSnapshotRuntimeRows(hotSnapshot) ||
      this.hasCanonicalSnapshot() ||
      !this.importJsonFile ||
      !existsSync(this.importJsonFile)
    ) {
      return hotSnapshot;
    }

    const imported = new JsonFileBrokerStateStore(this.importJsonFile, {
      maxBytes: this.maxBytes,
    }).load();
    this.saveImportedJsonSnapshot(imported, this.importJsonFile);
    return this.readHotRuntimeSnapshot();
  }

  private hasCanonicalSnapshot(): boolean {
    const row = this.db
      .prepare("SELECT 1 AS found FROM broker_snapshots WHERE id = 1")
      .get() as { found?: number } | undefined;
    return row?.found === 1;
  }

  private saveSnapshot(snapshot: BrokerSnapshot, hints?: BrokerStateSaveHints): void {
    const updatedAt = new Date().toISOString();
    this.runImmediateTransaction(() => {
      this.writeSnapshotRow(snapshot, updatedAt, hints);
      this.writeMetadata("state_version", String(CURRENT_BROKER_STATE_VERSION));
    });
  }

  private writeSnapshotRow(snapshot: BrokerSnapshot, updatedAt: string, hints?: BrokerStateSaveHints): void {
    const payload = serializeBrokerSnapshot(snapshot, this.maxBytes);
    this.db
      .prepare(
        `INSERT INTO broker_snapshots (id, version, payload, updated_at)
         VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           version = excluded.version,
           payload = excluded.payload,
           updated_at = excluded.updated_at`,
      )
      .run(CURRENT_BROKER_STATE_VERSION, payload, updatedAt);
    this.writeHotEntityTables(snapshot, hints);
  }

  private readSnapshotRow(): BrokerSnapshot | undefined {
    const row = this.db
      .prepare("SELECT payload FROM broker_snapshots WHERE id = 1")
      .get() as { payload?: string } | undefined;
    if (typeof row?.payload !== "string") {
      return undefined;
    }
    return parseSnapshotPayload(row.payload, `SQLite broker snapshot at ${this.dbFile}`, this.maxBytes);
  }

  private readTableCount(tableName: SqliteHotEntityTable): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { count?: number | bigint } | undefined;
    if (typeof row?.count === "bigint") {
      return Number(row.count);
    }
    return typeof row?.count === "number" ? row.count : 0;
  }

  private writeHotEntityTables(snapshot: BrokerSnapshot, hints?: BrokerStateSaveHints): void {
    const hotExchangeHints = hints?.hotExchanges;
    const hotExchangeMessageHints = hints?.hotExchangeMessages;
    const hotProposalHints = hints?.hotProposals;
    const hotArtifactHints = hints?.hotArtifacts;
    const hotValidationHints = hints?.hotValidations;
    const hotTaskHints = hints?.hotTasks;
    const hotTombstoneHints = hints?.hotTombstones;
    const hotAuditHints = hints?.hotAuditEvents;
    const hotWorkerHints = hints?.hotWorkers;
    if (hotExchangeHints) {
      this.applyCanonicalHotRetentionPlan("broker_exchanges", snapshot.exchanges.map((exchange) => exchange.id));
    } else {
      this.db.exec("DELETE FROM broker_exchanges;");
    }
    if (hotExchangeMessageHints) {
      this.applyCanonicalHotRetentionPlan("broker_exchange_messages", snapshot.exchangeMessages.map((message) => message.id));
    } else {
      this.db.exec("DELETE FROM broker_exchange_messages;");
    }
    if (hotProposalHints) {
      this.applyCanonicalHotRetentionPlan("broker_proposals", snapshot.proposals.map((proposal) => proposal.id));
    } else {
      this.db.exec("DELETE FROM broker_proposals;");
    }
    if (hotArtifactHints) {
      this.applyCanonicalHotRetentionPlan("broker_artifacts", snapshot.artifacts.map((artifact) => artifact.id));
    } else {
      this.db.exec("DELETE FROM broker_artifacts;");
    }
    if (hotValidationHints) {
      this.applyCanonicalHotRetentionPlan("broker_validations", snapshot.validations.map((validation) => validation.id));
    } else {
      this.db.exec("DELETE FROM broker_validations;");
    }
    if (hotTaskHints) {
      this.applyCanonicalHotRetentionPlan("broker_tasks", snapshot.tasks.map((task) => task.id));
    } else {
      this.db.exec("DELETE FROM broker_tasks;");
    }
    if (hotTombstoneHints) {
      this.applyCanonicalHotRetentionPlan("broker_tombstones", (snapshot.tombstones ?? []).map((tombstone) => tombstone.taskId));
    } else {
      this.db.exec("DELETE FROM broker_tombstones;");
    }
    if (hotAuditHints) {
      this.applyCanonicalHotRetentionPlan("broker_audit_events", snapshot.auditEvents.map((event) => event.id));
    } else {
      this.db.exec("DELETE FROM broker_audit_events;");
    }
    if (hotWorkerHints) {
      this.applyCanonicalHotRetentionPlan("broker_workers", snapshot.workers.map((worker) => worker.nodeId));
    } else {
      this.db.exec("DELETE FROM broker_workers;");
    }
    this.applyCanonicalHotRetentionPlan("broker_terminal_outbox", (snapshot.terminalOutbox ?? []).map((event) => event.id));

    this.upsertHotExchangesUnsafe(hotExchangeHints ?? snapshot.exchanges);
    this.upsertHotExchangeMessagesUnsafe(hotExchangeMessageHints ?? snapshot.exchangeMessages);

    this.upsertHotProposalsUnsafe(hotProposalHints ?? snapshot.proposals);
    this.upsertHotArtifactsUnsafe(hotArtifactHints ?? snapshot.artifacts);
    this.upsertHotValidationsUnsafe(hotValidationHints ?? snapshot.validations);

    this.upsertHotTasksUnsafe(hotTaskHints ?? snapshot.tasks);

    this.upsertHotTombstonesUnsafe(hotTombstoneHints ?? snapshot.tombstones ?? []);

    this.upsertHotWorkersUnsafe(hotWorkerHints ?? snapshot.workers);

    this.upsertHotAuditEventsUnsafe(hotAuditHints ?? snapshot.auditEvents);

    this.upsertHotTerminalOutboxUnsafe(snapshot.terminalOutbox ?? []);
  }

  private applyCanonicalHotRetentionPlan(
    tableName: SqliteHotRetentionPlan["table"],
    retainedIds: string[],
  ): SqliteHotRetentionApplyResult {
    const retained = new Set(retainedIds);
    const existingIds = this.readTableIds(tableName);
    return this.applyHotRetentionPlanUnsafe({
      table: tableName,
      cutoffMs: 0,
      retainedIds,
      pruneIds: existingIds.filter((id) => !retained.has(id)),
    });
  }

  private applyHotRetentionPlanUnsafe(plan: SqliteHotRetentionPlan): SqliteHotRetentionApplyResult {
    const beforeIds = new Set(this.readTableIds(plan.table));
    const pruneIds = plan.pruneIds.filter((id) => beforeIds.has(id));
    if (pruneIds.length > 0) {
      const primaryKeyColumn = this.hotRetentionPrimaryKeyColumn(plan.table);
      const placeholders = pruneIds.map(() => "?").join(", ");
      this.db.prepare(`DELETE FROM ${plan.table} WHERE ${primaryKeyColumn} IN (${placeholders})`).run(...pruneIds);
    }
    return {
      table: plan.table,
      retainedCount: plan.retainedIds.length,
      requestedPruneCount: plan.pruneIds.length,
      prunedCount: pruneIds.length,
      remainingCount: this.readTableCount(plan.table),
    };
  }

  private readTableIds(tableName: SqliteHotRetentionPlan["table"]): string[] {
    const primaryKeyColumn = this.hotRetentionPrimaryKeyColumn(tableName);
    return (this.db.prepare(`SELECT ${primaryKeyColumn} AS id FROM ${tableName} ORDER BY ${primaryKeyColumn} ASC`).all() as Array<{ id?: string }>)
      .flatMap((row) => typeof row.id === "string" ? [row.id] : []);
  }

  private upsertHotTasksUnsafe(tasks: TaskRecord[]): void {
    const upsertTask = this.db.prepare(
      `INSERT INTO broker_tasks
        (id, status, intent, target_node_id, assigned_worker_id, task_origin, updated_at, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status = excluded.status,
         intent = excluded.intent,
         target_node_id = excluded.target_node_id,
         assigned_worker_id = excluded.assigned_worker_id,
         task_origin = excluded.task_origin,
         updated_at = excluded.updated_at,
         payload = excluded.payload`,
    );
    for (const task of tasks) {
      upsertTask.run(
        task.id,
        task.status,
        task.intent,
        task.targetNodeId,
        task.assignedWorkerId ?? null,
        task.taskOrigin ?? "unknown",
        task.updatedAt,
        JSON.stringify(task),
      );
    }
  }

  private upsertHotExchangesUnsafe(exchanges: A2AExchangeState[]): void {
    const upsertExchange = this.db.prepare(
      `INSERT INTO broker_exchanges
        (id, status, intent, target_node_id, assigned_worker_id, created_at, updated_at, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status = excluded.status,
         intent = excluded.intent,
         target_node_id = excluded.target_node_id,
         assigned_worker_id = excluded.assigned_worker_id,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at,
         payload = excluded.payload`,
    );
    for (const exchange of exchanges) {
      upsertExchange.run(
        exchange.id,
        exchange.status,
        exchange.intent,
        exchange.targetNodeId,
        exchange.assignedWorkerId ?? null,
        exchange.createdAt,
        exchange.updatedAt,
        JSON.stringify(exchange),
      );
    }
  }

  private upsertHotExchangeMessagesUnsafe(messages: A2AExchangeMessageRecord[]): void {
    const upsertMessage = this.db.prepare(
      `INSERT INTO broker_exchange_messages
        (id, exchange_id, kind, parent_message_id, created_at, updated_at, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         exchange_id = excluded.exchange_id,
         kind = excluded.kind,
         parent_message_id = excluded.parent_message_id,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at,
         payload = excluded.payload`,
    );
    for (const message of messages) {
      upsertMessage.run(
        message.id,
        message.exchangeId,
        message.kind,
        message.parentMessageId ?? null,
        message.createdAt,
        message.updatedAt,
        JSON.stringify(message),
      );
    }
  }

  private upsertHotProposalsUnsafe(proposals: ChangeProposal[]): void {
    const upsertProposal = this.db.prepare(
      `INSERT INTO broker_proposals
        (id, status, kind, source_node_id, target_node_id, created_at, updated_at, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status = excluded.status,
         kind = excluded.kind,
         source_node_id = excluded.source_node_id,
         target_node_id = excluded.target_node_id,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at,
         payload = excluded.payload`,
    );
    for (const proposal of proposals) {
      upsertProposal.run(
        proposal.id,
        proposal.status,
        proposal.kind,
        proposal.sourceNodeId,
        proposal.targetNodeId,
        proposal.createdAt,
        proposal.updatedAt,
        JSON.stringify(proposal),
      );
    }
  }

  private upsertHotArtifactsUnsafe(artifacts: ArtifactRecord[]): void {
    const upsertArtifact = this.db.prepare(
      `INSERT INTO broker_artifacts
        (id, proposal_id, kind, created_at, payload)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         proposal_id = excluded.proposal_id,
         kind = excluded.kind,
         created_at = excluded.created_at,
         payload = excluded.payload`,
    );
    for (const artifact of artifacts) {
      upsertArtifact.run(
        artifact.id,
        artifact.proposalId,
        artifact.kind,
        artifact.createdAt,
        JSON.stringify(artifact),
      );
    }
  }

  private upsertHotValidationsUnsafe(validations: ValidationResult[]): void {
    const upsertValidation = this.db.prepare(
      `INSERT INTO broker_validations
        (id, proposal_id, node_id, kind, verdict, created_at, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         proposal_id = excluded.proposal_id,
         node_id = excluded.node_id,
         kind = excluded.kind,
         verdict = excluded.verdict,
         created_at = excluded.created_at,
         payload = excluded.payload`,
    );
    for (const validation of validations) {
      upsertValidation.run(
        validation.id,
        validation.proposalId,
        validation.nodeId,
        validation.kind,
        validation.verdict,
        validation.createdAt,
        JSON.stringify(validation),
      );
    }
  }

  private upsertHotAuditEventsUnsafe(events: AuditEvent[]): void {
    const upsertAudit = this.db.prepare(
      `INSERT INTO broker_audit_events
        (id, action, target_type, target_id, created_at, payload)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         action = excluded.action,
         target_type = excluded.target_type,
         target_id = excluded.target_id,
         created_at = excluded.created_at,
         payload = excluded.payload`,
    );
    for (const audit of events) {
      upsertAudit.run(
        audit.id,
        audit.action,
        audit.targetType,
        audit.targetId,
        audit.createdAt,
        JSON.stringify(audit),
      );
    }
  }

  private upsertHotWorkersUnsafe(workers: WorkerRecord[]): void {
    const upsertWorker = this.db.prepare(
      `INSERT INTO broker_workers
        (node_id, role, last_seen_at, updated_at, payload)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(node_id) DO UPDATE SET
         role = excluded.role,
         last_seen_at = excluded.last_seen_at,
         updated_at = excluded.updated_at,
         payload = excluded.payload`,
    );
    for (const worker of workers) {
      upsertWorker.run(
        worker.nodeId,
        worker.role,
        worker.lastSeenAt,
        worker.updatedAt,
        JSON.stringify(worker),
      );
    }
  }

  private upsertHotTerminalOutboxUnsafe(events: TerminalTaskOutboxEvent[]): void {
    const upsertEvent = this.db.prepare(
      `INSERT INTO broker_terminal_outbox
        (id, task_event_id, acknowledged_at, created_at, payload)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         task_event_id = excluded.task_event_id,
         acknowledged_at = excluded.acknowledged_at,
         created_at = excluded.created_at,
         payload = excluded.payload`,
    );
    for (const event of events) {
      upsertEvent.run(
        event.id,
        event.taskEventId,
        event.ack?.acknowledgedAt ?? event.deliveredAt ?? null,
        event.createdAt,
        JSON.stringify(event),
      );
    }
  }

  private upsertHotTombstonesUnsafe(tombstones: TaskTombstone[]): void {
    const upsertTombstone = this.db.prepare(
      `INSERT INTO broker_tombstones
        (task_id, terminal_status, tombstone_reason, tombstoned_at, payload)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(task_id) DO UPDATE SET
         terminal_status = excluded.terminal_status,
         tombstone_reason = excluded.tombstone_reason,
         tombstoned_at = excluded.tombstoned_at,
         payload = excluded.payload`,
    );
    for (const tombstone of tombstones) {
      upsertTombstone.run(
        tombstone.taskId,
        tombstone.terminalStatus,
        tombstone.tombstoneReason,
        tombstone.tombstonedAt,
        JSON.stringify(tombstone),
      );
    }
  }

  private hotRetentionPrimaryKeyColumn(tableName: SqliteHotRetentionPlan["table"]): "id" | "node_id" | "task_id" {
    if (tableName === "broker_workers") {
      return "node_id";
    }
    if (tableName === "broker_tombstones") {
      return "task_id";
    }
    return "id";
  }

  private runImmediateTransaction(fn: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original error; rollback failure only confirms the write did not cleanly complete.
      }
      throw error;
    }
  }

  private writeMetadata(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO broker_metadata (key, value)
         VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  private readMetadata(key: string): string | undefined {
    const row = this.db
      .prepare("SELECT value FROM broker_metadata WHERE key = ?")
      .get(key) as { value?: string } | undefined;
    return typeof row?.value === "string" ? row.value : undefined;
  }

  private ensureColumn(tableName: string, columnName: string, columnDefinition: string): void {
    const rows = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: string }>;
    if (rows.some((row) => row.name === columnName)) {
      return;
    }
    this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
  }
}

export class SqliteTaskRuntimeRepository implements TaskRuntimeRepository {
  constructor(private readonly store: SqliteBrokerStateStore) {}

  getTask(id: string): TaskRecord | null {
    return this.store.readHotTasks({ id })[0] ?? null;
  }

  listTasks(filters: TaskListFilters = {}): TaskRecord[] {
    return this.store
      .readHotTasks({
        status: filters.status,
        targetNodeId: filters.targetNodeId,
        intent: filters.intent,
        assignedWorkerId: filters.assignedWorkerId,
        taskOrigin: filters.taskOrigin,
      })
      .filter((task) => taskMatchesRuntimeFilters(task, filters));
  }

  upsertTask(task: TaskRecord): void {
    this.store.upsertHotTasks([task]);
  }
}

export class SqliteExchangeRuntimeRepository implements ExchangeRuntimeRepository {
  constructor(private readonly store: SqliteBrokerStateStore) {}

  getExchange(id: string): A2AExchangeState | null {
    return this.store.readHotExchanges({ id })[0] ?? null;
  }

  listExchanges(): A2AExchangeState[] {
    return this.store.readHotExchanges();
  }

  upsertExchange(exchange: A2AExchangeState): void {
    this.store.upsertHotExchanges([exchange]);
  }
}

export class SqliteExchangeMessageRuntimeRepository implements ExchangeMessageRuntimeRepository {
  constructor(private readonly store: SqliteBrokerStateStore) {}

  getExchangeMessage(id: string): A2AExchangeMessageRecord | null {
    return this.store.readHotExchangeMessages({ id })[0] ?? null;
  }

  listExchangeMessages(exchangeId: string): A2AExchangeMessageRecord[] {
    return this.store.readHotExchangeMessages({ exchangeId });
  }

  upsertExchangeMessage(message: A2AExchangeMessageRecord): void {
    this.store.upsertHotExchangeMessages([message]);
  }
}

export class SqliteProposalRuntimeRepository implements ProposalRuntimeRepository {
  constructor(private readonly store: SqliteBrokerStateStore) {}

  getProposal(id: string): ChangeProposal | null {
    return this.store.readHotProposals({ id })[0] ?? null;
  }

  listProposals(filters: ProposalListFilters = {}): ChangeProposal[] {
    return this.store.readHotProposals(filters);
  }

  upsertProposal(proposal: ChangeProposal): void {
    this.store.upsertHotProposals([proposal]);
  }
}

export class SqliteArtifactRuntimeRepository implements ArtifactRuntimeRepository {
  constructor(private readonly store: SqliteBrokerStateStore) {}

  getArtifact(id: string): ArtifactRecord | null {
    return this.store.readHotArtifacts({ id })[0] ?? null;
  }

  listArtifactsForProposal(proposalId: string): ArtifactRecord[] {
    return this.store.readHotArtifacts({ proposalId });
  }

  upsertArtifact(artifact: ArtifactRecord): void {
    this.store.upsertHotArtifacts([artifact]);
  }
}

export class SqliteValidationRuntimeRepository implements ValidationRuntimeRepository {
  constructor(private readonly store: SqliteBrokerStateStore) {}

  getValidation(id: string): ValidationResult | null {
    return this.store.readHotValidations({ id })[0] ?? null;
  }

  listValidationsForProposal(proposalId: string): ValidationResult[] {
    return this.store.readHotValidations({ proposalId });
  }

  upsertValidation(validation: ValidationResult): void {
    this.store.upsertHotValidations([validation]);
  }
}

function taskMatchesRuntimeFilters(task: TaskRecord, filters: TaskListFilters): boolean {
  if (filters.exchangeId && task.exchangeId !== filters.exchangeId) {
    return false;
  }
  if (filters.status && task.status !== filters.status) {
    return false;
  }
  if (filters.targetNodeId && task.targetNodeId !== filters.targetNodeId) {
    return false;
  }
  if (filters.proposalId && task.proposalId !== filters.proposalId) {
    return false;
  }
  if (filters.intent && task.intent !== filters.intent) {
    return false;
  }
  if (filters.claimedBy && task.claimedBy !== filters.claimedBy) {
    return false;
  }
  if (filters.assignedWorkerId && task.assignedWorkerId !== filters.assignedWorkerId) {
    return false;
  }
  if (filters.taskOrigin && (task.taskOrigin ?? "unknown") !== filters.taskOrigin) {
    return false;
  }
  return true;
}

export class SqliteWorkerRuntimeRepository implements WorkerRuntimeRepository {
  constructor(private readonly store: SqliteBrokerStateStore) {}

  getWorker(nodeId: string): WorkerRecord | null {
    return this.store.readHotWorkers({ nodeId })[0] ?? null;
  }

  listWorkers(filters: WorkerListFilters = {}): WorkerRecord[] {
    return this.store
      .readHotWorkers({ role: filters.role })
      .filter((worker) => workerMatchesRuntimeFilters(worker, filters));
  }

  upsertWorker(worker: WorkerRecord): void {
    this.store.upsertHotWorkers([worker]);
  }
}

function workerMatchesRuntimeFilters(worker: WorkerRecord, filters: WorkerListFilters): boolean {
  if (filters.role && worker.role !== filters.role) {
    return false;
  }
  if (filters.environment && !worker.capabilities.environments.includes(filters.environment)) {
    return false;
  }
  if (filters.workspaceId && !worker.capabilities.workspaceIds.includes(filters.workspaceId)) {
    return false;
  }
  return true;
}

export class SqliteAuditRuntimeRepository implements AuditRuntimeRepository {
  private readonly maxHotAuditEvents: number;

  constructor(
    private readonly store: SqliteBrokerStateStore,
    options: SqliteAuditRuntimeRepositoryOptions = {},
  ) {
    this.maxHotAuditEvents = Math.max(0, Math.floor(options.maxHotAuditEvents ?? 5_000));
  }

  listAuditEvents(filters: AuditListFilters = {}): AuditEvent[] {
    return this.store.readHotAuditEvents(filters);
  }

  appendAuditEvent(event: AuditEvent): void {
    const hotEvent = event.action === "worker.heartbeat" && event.targetType === "worker"
      ? { ...event, id: `worker-heartbeat:${event.targetId}` }
      : event;
    this.store.upsertHotAuditEvents([hotEvent]);
    this.store.pruneHotAuditEventsToMax(this.maxHotAuditEvents);
  }
}

export class SqliteTombstoneRuntimeRepository implements TombstoneRuntimeRepository {
  constructor(private readonly store: SqliteBrokerStateStore) {}

  getTombstone(taskId: string): TaskTombstone | null {
    return this.store.readHotTombstones({ taskId })[0] ?? null;
  }

  listTombstones(filters: TombstoneListFilters = {}): TaskTombstone[] {
    return this.store.readHotTombstones(filters);
  }

  upsertTombstone(tombstone: TaskTombstone): void {
    this.store.upsertHotTombstones([tombstone]);
  }
}

export function emptySnapshot(): BrokerSnapshot {
  return {
    version: CURRENT_BROKER_STATE_VERSION,
    exchanges: [],
    exchangeMessages: [],
    proposals: [],
    artifacts: [],
    validations: [],
    auditEvents: [],
    workers: [],
    tasks: [],
    tombstones: [],
    terminalOutbox: [],
  };
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

export function serializeBrokerSnapshot(
  snapshot: BrokerSnapshot,
  maxBytes: number = DEFAULT_BROKER_STATE_MAX_BYTES,
): string {
  const payload = JSON.stringify(
    {
      ...snapshot,
      version: CURRENT_BROKER_STATE_VERSION,
    },
    null,
    2,
  );
  const bytes = Buffer.byteLength(payload, "utf8");
  if (bytes > maxBytes) {
    throw new Error(`broker snapshot exceeds max size (${bytes} > ${maxBytes} bytes)`);
  }
  return payload;
}

export function writeBrokerSnapshotFile(
  filePath: string,
  snapshot: BrokerSnapshot,
  maxBytes: number = DEFAULT_BROKER_STATE_MAX_BYTES,
): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  const payload = serializeBrokerSnapshot(snapshot, maxBytes);
  writeFileSync(tempPath, payload, "utf8");
  renameSync(tempPath, filePath);
}

function parseSnapshotPayload(payload: string, source: string, maxBytes: number): BrokerSnapshot {
  const bytes = Buffer.byteLength(payload, "utf8");
  if (bytes > maxBytes) {
    throw new Error(`broker snapshot exceeds max size (${bytes} > ${maxBytes} bytes): ${source}`);
  }
  const parsed = brokerSnapshotSchema.safeParse(JSON.parse(payload));
  if (!parsed.success) {
    throw new Error(
      `invalid broker snapshot at ${source}: ${parsed.error.issues[0]?.message ?? "unknown schema error"}`,
    );
  }
  return parsed.data as BrokerSnapshot;
}

function buildHotTableSelect(
  tableName: SqliteHotEntityTable,
  filters: Array<[string, string | undefined]>,
  orderBy: string,
): { sql: string; params: string[] } {
  const params: string[] = [];
  const clauses = filters.flatMap(([column, value]) => {
    if (!value) {
      return [];
    }
    params.push(value);
    return [`${column} = ?`];
  });
  return {
    sql: `SELECT payload FROM ${tableName}${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY ${orderBy}`,
    params,
  };
}

function countSnapshotEntities(snapshot: BrokerSnapshot): Record<string, number> {
  return Object.fromEntries(
    Object.values(SQLITE_HOT_ENTITY_SNAPSHOT_KEYS).map((key) => [key, (snapshot[key] ?? []).length]),
  );
}

function hasSnapshotRuntimeRows(snapshot: BrokerSnapshot): boolean {
  return Object.values(SQLITE_HOT_ENTITY_SNAPSHOT_KEYS).some(
    (key) => (snapshot[key] ?? []).length > 0,
  );
}

function planTaskRetentionFromRecords(
  records: TaskRecord[],
  options: SqliteTaskHotRetentionPlanOptions,
): SqliteHotRetentionPlan {
  const nowMs = options.nowMs ?? Date.now();
  const cutoffMs = nowMs - options.retentionMs;
  const retainedIds = new Set(options.protectedTaskIds ?? []);
  const olderTerminalCandidates: Array<{ id: string; timestampMs: number }> = [];

  for (const task of records) {
    if (!isTerminalTaskStatus(task.status) || retainedIds.has(task.id)) {
      retainedIds.add(task.id);
      continue;
    }
    const timestampMs = parseRetentionTimestamp(task.completedAt ?? task.updatedAt);
    if (timestampMs === null || timestampMs >= cutoffMs) {
      retainedIds.add(task.id);
      continue;
    }
    olderTerminalCandidates.push({ id: task.id, timestampMs });
  }

  [...olderTerminalCandidates]
    .sort((a, b) => b.timestampMs - a.timestampMs || a.id.localeCompare(b.id))
    .slice(0, options.maxTerminalRecords)
    .forEach((entry) => retainedIds.add(entry.id));

  return buildRetentionPlan("broker_tasks", cutoffMs, records.map((record) => record.id), retainedIds);
}

function planAuditRetentionFromRecords(
  records: AuditEvent[],
  options: SqliteAuditHotRetentionPlanOptions,
): SqliteHotRetentionPlan {
  const nowMs = options.nowMs ?? Date.now();
  const cutoffMs = nowMs - options.retentionMs;
  const retainedIds = new Set<string>();
  const retentionCandidates: Array<{ id: string; timestampMs: number }> = [];
  const protectedIds = normalizeAuditRetentionProtection(options.protectedIds);

  for (const event of records) {
    const timestampMs = parseRetentionTimestamp(event.createdAt);
    if (isAuditEventProtected(event, protectedIds) || timestampMs === null) {
      retainedIds.add(event.id);
      continue;
    }
    retentionCandidates.push({ id: event.id, timestampMs });
  }

  [...retentionCandidates]
    .sort((a, b) => b.timestampMs - a.timestampMs || a.id.localeCompare(b.id))
    .filter((entry) => entry.timestampMs >= cutoffMs)
    .slice(0, options.maxRecords)
    .forEach((entry) => retainedIds.add(entry.id));

  return buildRetentionPlan("broker_audit_events", cutoffMs, records.map((record) => record.id), retainedIds);
}

function planWorkerRetentionFromRecords(
  records: WorkerRecord[],
  options: SqliteWorkerHotRetentionPlanOptions,
): SqliteHotRetentionPlan {
  const nowMs = options.nowMs ?? Date.now();
  const cutoffMs = nowMs - options.retentionMs;
  const retainedIds = new Set(options.protectedWorkerIds ?? []);
  const olderInactiveCandidates: Array<{ id: string; timestampMs: number }> = [];

  for (const worker of records) {
    if (retainedIds.has(worker.nodeId)) {
      continue;
    }
    const timestampMs = parseRetentionTimestamp(worker.lastSeenAt);
    if (timestampMs === null || timestampMs >= cutoffMs) {
      retainedIds.add(worker.nodeId);
      continue;
    }
    olderInactiveCandidates.push({ id: worker.nodeId, timestampMs });
  }

  [...olderInactiveCandidates]
    .sort((a, b) => b.timestampMs - a.timestampMs || a.id.localeCompare(b.id))
    .slice(0, options.maxInactiveWorkers)
    .forEach((entry) => retainedIds.add(entry.id));

  return buildRetentionPlan("broker_workers", cutoffMs, records.map((record) => record.nodeId), retainedIds);
}

export function buildHotEntityHintCoverage(
  hotEntityTables: readonly string[],
  hintedWriteTables: readonly string[],
): BrokerHotEntityHintCoverage {
  const supportedTables = [...hintedWriteTables];
  const supported = new Set(supportedTables);
  const missingTables = hotEntityTables.filter((table) => !supported.has(table));
  return {
    ok: missingTables.length === 0,
    supportedTables,
    missingTables,
    supportedCount: supportedTables.length,
    totalCount: hotEntityTables.length,
  };
}

function buildRetentionPlan(
  table: SqliteHotRetentionPlan["table"],
  cutoffMs: number,
  allIds: string[],
  retainedIds: Set<string>,
): SqliteHotRetentionPlan {
  return {
    table,
    cutoffMs,
    retainedIds: allIds.filter((id) => retainedIds.has(id)).sort(),
    pruneIds: allIds.filter((id) => !retainedIds.has(id)).sort(),
  };
}

function normalizeAuditRetentionProtection(
  input: SqliteAuditHotRetentionProtection | undefined,
): Required<Record<keyof SqliteAuditHotRetentionProtection, Set<string>>> {
  return {
    proposalIds: new Set(input?.proposalIds ?? []),
    taskIds: new Set(input?.taskIds ?? []),
    exchangeIds: new Set(input?.exchangeIds ?? []),
    exchangeMessageIds: new Set(input?.exchangeMessageIds ?? []),
    artifactIds: new Set(input?.artifactIds ?? []),
    validationIds: new Set(input?.validationIds ?? []),
    workerIds: new Set(input?.workerIds ?? []),
  };
}

function isAuditEventProtected(
  event: AuditEvent,
  protectedIds: Required<Record<keyof SqliteAuditHotRetentionProtection, Set<string>>>,
): boolean {
  if (event.proposalId && protectedIds.proposalIds.has(event.proposalId)) {
    return true;
  }
  switch (event.targetType) {
    case "proposal":
      return protectedIds.proposalIds.has(event.targetId);
    case "artifact":
      return protectedIds.artifactIds.has(event.targetId);
    case "validation":
      return protectedIds.validationIds.has(event.targetId);
    case "worker":
      if (event.action === "worker.heartbeat") {
        return false;
      }
      return protectedIds.workerIds.has(event.targetId);
    case "task":
      return protectedIds.taskIds.has(event.targetId);
    case "exchange":
      return protectedIds.exchangeIds.has(event.targetId);
    case "exchange-message":
      return protectedIds.exchangeMessageIds.has(event.targetId);
  }
}

function isTerminalTaskStatus(status: TaskRecord["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "canceled";
}

function parseRetentionTimestamp(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseHotEntityPayload<T>(row: unknown, schema: z.ZodType<T>, tableName: string): T {
  const parsed = parseHotEntityPayloadResult(row, schema, tableName);
  if (!parsed.success) {
    throw new Error(
      `invalid hot entity payload in ${tableName}: ${parsed.error}`,
    );
  }
  return parsed.data;
}

function parseHotEntityPayloadSafe<T>(row: unknown, schema: z.ZodType<T>, tableName: string): T[] {
  const parsed = parseHotEntityPayloadResult(row, schema, tableName);
  if (!parsed.success) {
    return [];
  }
  return [parsed.data];
}

function parseHotEntityPayloadResult<T>(row: unknown, schema: z.ZodType<T>, tableName: string): { success: true; data: T } | { success: false; error: string } {
  let value: unknown;
  try {
    value = JSON.parse(readSqlitePayload(row, tableName));
  } catch (error) {
    return { success: false, error: sanitizeDiagnosticValue(error instanceof Error ? error.message : String(error)) };
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    return { success: false, error: sanitizeDiagnosticValue(parsed.error.issues[0]?.message ?? "unknown schema error") };
  }
  return { success: true, data: parsed.data };
}

function sanitizeDiagnosticValue(value: unknown): string {
  const raw = typeof value === "string" ? value : String(value ?? "unknown");
  return raw.replace(/[\r\n\t]+/g, " ").slice(0, 240);
}

function coalesceInvalidHotEntityRows(rows: BrokerInvalidHotEntityRow[]): BrokerInvalidHotEntityRow[] {
  const byKey = new Map<string, BrokerInvalidHotEntityRow>();
  for (const row of rows) {
    const key = `${row.table}\u0000${row.primaryKey}\u0000${row.schemaError}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.count += row.count;
    } else {
      byKey.set(key, { ...row });
    }
  }
  return [...byKey.values()];
}

function readSqlitePayload(row: unknown, tableName: string): string {
  if (
    typeof row === "object" &&
    row !== null &&
    "payload" in row &&
    typeof row.payload === "string"
  ) {
    return row.payload;
  }
  throw new Error(`missing payload column from ${tableName}`);
}
