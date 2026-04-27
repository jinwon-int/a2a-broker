import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { z } from "zod";

import type {
  ArtifactRecord,
  AuditEvent,
  A2AExchangeMessageRecord,
  A2AExchangeState,
  ChangeProposal,
  TaskRecord,
  TaskTombstone,
  ValidationResult,
  WorkerRecord,
} from "./types.js";

export const CURRENT_BROKER_STATE_VERSION = 7;
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
  tombstones?: TaskTombstone[];
}

export interface BrokerStateStore {
  load(): BrokerSnapshot;
  save(snapshot: BrokerSnapshot): void;
  getPersistenceInfo?(): BrokerPersistenceInfo;
}

export interface BrokerPersistenceInfo {
  kind: string;
  stateVersion: number;
  schemaVersion?: number;
  stateFile?: string;
  dbFile?: string;
  journalMode?: string;
  hotEntityTables?: string[];
  importedFromJsonFile?: string;
  lastImportAt?: string;
}

export interface JsonFileBrokerStateStoreOptions {
  maxBytes?: number;
}

export interface SqliteBrokerStateStoreOptions {
  maxBytes?: number;
  importJsonFile?: string;
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
  exchangeId?: string;
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

const SQLITE_SCHEMA_VERSION = 5;
const SQLITE_HOT_ENTITY_TABLES = [
  "broker_exchanges",
  "broker_exchange_messages",
  "broker_tasks",
  "broker_workers",
  "broker_audit_events",
];

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
    via: z.string().min(1).optional(),
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
    via: z.string().min(1).optional(),
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
    taskOrigin: z.enum(["github", "api", "sessions_send", "unknown"]).optional(),
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

  save(snapshot: BrokerSnapshot): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    const payload = JSON.stringify(
      {
        ...snapshot,
        version: CURRENT_BROKER_STATE_VERSION,
      },
      null,
      2,
    );
    writeFileSync(tempPath, payload, "utf8");
    renameSync(tempPath, this.filePath);
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
  private readonly db: DatabaseSync;
  private readonly journalMode: string;

  constructor(
    private readonly dbFile: string,
    options: SqliteBrokerStateStoreOptions = {},
  ) {
    this.maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_BROKER_STATE_MAX_BYTES);
    this.importJsonFile = options.importJsonFile;
    if (dbFile !== ":memory:") {
      mkdirSync(dirname(dbFile), { recursive: true });
    }
    this.db = new DatabaseSync(dbFile);
    this.journalMode = this.initializeDatabase();
  }

  load(): BrokerSnapshot {
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

  save(snapshot: BrokerSnapshot): void {
    this.saveSnapshot(snapshot);
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
      [["exchange_id", filters.exchangeId]],
      "created_at ASC, CASE WHEN kind = 'root' THEN 0 ELSE 1 END ASC, id ASC",
    );
    return this.db
      .prepare(sql)
      .all(...params)
      .map((row) => parseHotEntityPayload(row, exchangeMessageSchema, "broker_exchange_messages")) as A2AExchangeMessageRecord[];
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
      .map((row) => parseHotEntityPayload(row, workerSchema, "broker_workers")) as WorkerRecord[];
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
      schemaVersion: SQLITE_SCHEMA_VERSION,
      journalMode: this.journalMode,
      hotEntityTables: SQLITE_HOT_ENTITY_TABLES,
      importedFromJsonFile: this.readMetadata("imported_from_json_file"),
      lastImportAt: this.readMetadata("last_import_at"),
    };
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
      CREATE INDEX IF NOT EXISTS broker_tasks_worker_status_idx
        ON broker_tasks(assigned_worker_id, status);
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
      CREATE TABLE IF NOT EXISTS broker_workers (
        node_id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS broker_workers_last_seen_idx
        ON broker_workers(last_seen_at);
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

  private saveSnapshot(snapshot: BrokerSnapshot): void {
    const updatedAt = new Date().toISOString();
    this.runImmediateTransaction(() => {
      this.writeSnapshotRow(snapshot, updatedAt);
      this.writeMetadata("state_version", String(CURRENT_BROKER_STATE_VERSION));
    });
  }

  private writeSnapshotRow(snapshot: BrokerSnapshot, updatedAt: string): void {
    const payload = serializeSnapshot(snapshot, this.maxBytes);
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
    this.writeHotEntityTables(snapshot);
  }

  private writeHotEntityTables(snapshot: BrokerSnapshot): void {
    this.db.exec(`
      DELETE FROM broker_tasks;
      DELETE FROM broker_exchanges;
      DELETE FROM broker_exchange_messages;
      DELETE FROM broker_workers;
      DELETE FROM broker_audit_events;
    `);

    const insertExchange = this.db.prepare(
      `INSERT INTO broker_exchanges
        (id, status, intent, target_node_id, assigned_worker_id, created_at, updated_at, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const exchange of snapshot.exchanges) {
      insertExchange.run(
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

    const insertExchangeMessage = this.db.prepare(
      `INSERT INTO broker_exchange_messages
        (id, exchange_id, kind, parent_message_id, created_at, updated_at, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const message of snapshot.exchangeMessages) {
      insertExchangeMessage.run(
        message.id,
        message.exchangeId,
        message.kind,
        message.parentMessageId ?? null,
        message.createdAt,
        message.updatedAt,
        JSON.stringify(message),
      );
    }

    const insertTask = this.db.prepare(
      `INSERT INTO broker_tasks
        (id, status, intent, target_node_id, assigned_worker_id, task_origin, updated_at, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const task of snapshot.tasks) {
      insertTask.run(
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

    const insertWorker = this.db.prepare(
      `INSERT INTO broker_workers
        (node_id, role, last_seen_at, updated_at, payload)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const worker of snapshot.workers) {
      insertWorker.run(
        worker.nodeId,
        worker.role,
        worker.lastSeenAt,
        worker.updatedAt,
        JSON.stringify(worker),
      );
    }

    const insertAudit = this.db.prepare(
      `INSERT INTO broker_audit_events
        (id, action, target_type, target_id, created_at, payload)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const audit of snapshot.auditEvents) {
      insertAudit.run(
        audit.id,
        audit.action,
        audit.targetType,
        audit.targetId,
        audit.createdAt,
        JSON.stringify(audit),
      );
    }
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

function serializeSnapshot(snapshot: BrokerSnapshot, maxBytes: number): string {
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
  tableName:
    | "broker_exchanges"
    | "broker_exchange_messages"
    | "broker_tasks"
    | "broker_workers"
    | "broker_audit_events",
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

function parseHotEntityPayload<T>(row: unknown, schema: z.ZodType<T>, tableName: string): T {
  const payload = readSqlitePayload(row, tableName);
  const parsed = schema.safeParse(JSON.parse(payload));
  if (!parsed.success) {
    throw new Error(
      `invalid hot entity payload in ${tableName}: ${parsed.error.issues[0]?.message ?? "unknown schema error"}`,
    );
  }
  return parsed.data;
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
