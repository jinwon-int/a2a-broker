import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from "node:http";
import { getHeapStatistics } from "node:v8";

import { createBrokerAgentCard, type AgentCard } from "./a2a/agent-card.js";
import { executeA2AJsonRpc } from "./a2a/json-rpc.js";
import { PeerStatusService } from "./a2a/peer-status.js";
import { projectBrokerTask } from "./a2a/task-projection.js";
import {
  BrokerError,
  DEFAULT_BROKER_RETENTION_POLICY,
  DEFAULT_MAX_REQUEUE_ATTEMPTS,
  InMemoryA2ABroker,
  type BrokerRetentionPolicy,
  type TaskDiagnosticsOptions,
} from "./core/broker.js";
import {
  applyRateLimitHeaders,
  assertEdgeSecret,
  assertRequesterCanSubscribeToTask,
  assertRequesterHasRole,
  assertRequesterCanTouchProposalArtifacts,
  assertRequesterMatchesParty,
  classifyRateLimitBucket,
  extractRequesterIdentity,
  InMemoryRateLimiter,
  rateLimitKey,
  type RateLimitPressureSnapshot,
  type RequesterIdentity,
} from "./core/request-security.js";
import {
  CURRENT_BROKER_STATE_VERSION,
  DEFAULT_BROKER_STATE_MAX_BYTES,
  DEFAULT_HOT_RUNTIME_MAX_AUDIT_EVENTS,
  DEFAULT_HOT_RUNTIME_MAX_HEARTBEAT_AUDIT_EVENTS,
  DEFAULT_HOT_RUNTIME_MAX_NON_TERMINAL_TASKS,
  DEFAULT_HOT_RUNTIME_MAX_TERMINAL_OUTBOX_EVENTS,
  DEFAULT_HOT_RUNTIME_MAX_TERMINAL_TASKS,
  JsonFileBrokerStateStore,
  SqliteArtifactRuntimeRepository,
  SqliteAuditRuntimeRepository,
  SqliteBrokerStateStore,
  SqliteExchangeMessageRuntimeRepository,
  SqliteExchangeRuntimeRepository,
  SqliteProposalRuntimeRepository,
  SqliteTaskRuntimeRepository,
  SqliteTombstoneRuntimeRepository,
  SqliteValidationRuntimeRepository,
  SqliteWorkerRuntimeRepository,
  type BrokerHotAuditDiagnostics,
  type BrokerHotEntityDiagnostics,
  type BrokerPersistenceInfo,
  type BrokerStateStore,
  type SqliteBrokerLoadSource,
  type BrokerHotTableLoadMetrics,
  type BrokerHotTableRuntimeLoadLimits,
} from "./core/store.js";
import {
  projectHotTableGrowth,
  type HotTableGrowthProjection,
} from "./core/hot-table-growth.js";
import type {
  A2AExchangeMessageRecord,
  A2AExchangeMessageRequest,
  A2AExchangeRequest,
  A2AExchangeState,
  AuditAction,
  AuditEvent,
  AuditListFilters,
  BrokerDashboard,
  ChangeProposal,
  ApplyProposalRequest,
  AttachArtifactRequest,
  CreateProposalRequest,
  CreateTaskRequest,
  ProposalActorRequest,
  ProposalDetails,
  ProposalKind,
  ProposalListFilters,
  ProposalStatus,
  RegisterWorkerRequest,
  SubmitValidationRequest,
  TaskApprovalRequest,
  TaskApprovalTerminalRequest,
  TaskCancelRequest,
  TaskClaimRequest,
  TaskCompleteRequest,
  TaskDiagnosticReport,
  TaskEvidenceRequest,
  TaskFailRequest,
  TaskKind,
  TaskListFilters,
  TaskOrigin,
  TaskReassignRequest,
  TaskRecord,
  TaskStatus,
  TaskTombstone,
  TaskWakeDecisionRequest,
  TaskWakePlanRequest,
  WorkerHeartbeatRequest,
  WorkerListFilters,
  WorkerRecord,
  WorkerView,
  A2AWorkerEnvironment,
  A2APartyRole,
} from "./core/types.js";
import type { DecisionDialecticPatchV1, DecisionDialecticPhase } from "./decision-dialectic/types.js";
import {
  applyDecisionDialecticPatch,
  buildDecisionDialecticPhaseTaskRequest,
  DecisionDialecticExecutionError,
  extractDecisionDialecticTaskInput,
  nextDecisionDialecticPhase,
} from "./decision-dialectic/execution.js";
import {
  projectDecisionDialecticReadModel,
  DecisionDialecticReadModelError,
} from "./decision-dialectic/read-model.js";
import {
  projectTradingDialecticReadModel,
  TradingDialecticReadModelError,
} from "./trading-dialectic/read-model.js";
import { projectAlerts, type Alert, type AlertScanResult } from "./core/alert-projection.js";
import { buildOperatorTaskReport } from "./core/operator-task-report.js";
import { buildReleaseEvidenceExport } from "./core/release-evidence.js";
import {
  buildTerminalBriefCloseoutGate,
  extractTerminalBriefFinalizerWorkflowPacket,
} from "./core/terminal-brief-closeout-gate.js";
import {
  buildTerminalBriefApprovalRequest,
  extractTerminalBriefCloseoutGatePacket,
} from "./core/terminal-brief-approval-request.js";
import {
  buildTerminalBriefApprovalExecutor,
  extractTerminalBriefApprovalRequestPacket,
} from "./core/terminal-brief-approval-executor.js";
import {
  buildTerminalBriefApprovalDispatchAdapter,
  extractTerminalBriefApprovalExecutorPacket,
} from "./core/terminal-brief-approval-dispatch-adapter.js";
import {
  buildTerminalBriefApprovalReceiptIngestor,
  extractTerminalBriefApprovalDispatchAdapterPacket,
  extractTerminalBriefApprovalReceiptEvidence,
} from "./core/terminal-brief-approval-receipt-ingestor.js";
import {
  buildTerminalBriefFinalizerApprovalStatus,
  extractTerminalBriefFinalizerApprovalReceiptStatus,
  extractTerminalBriefFinalizerApprovalStatusDispatch,
} from "./core/terminal-brief-finalizer-approval-status.js";
import {
  buildTerminalBriefSidecarDryRunGate,
  extractTerminalBriefSidecarDryRunGateFinalizerStatus,
  extractTerminalBriefSidecarDryRunGateRehearsal,
  extractTerminalBriefSidecarDryRunOperatingEvidence,
} from "./core/terminal-brief-sidecar-dry-run-gate.js";
import {
  buildTerminalBriefSidecarActivationApproval,
  extractTerminalBriefSidecarActivationApprovalGate,
  extractTerminalBriefSidecarActivationApprovalOptions,
} from "./core/terminal-brief-sidecar-activation-approval.js";
import {
  buildTerminalBriefSidecarActivationReceiptIngestor,
  extractTerminalBriefSidecarActivationApprovalPacket,
  extractTerminalBriefSidecarActivationReceiptEvidence,
} from "./core/terminal-brief-sidecar-activation-receipt-ingestor.js";
import {
  buildTerminalBriefSidecarStartExecutorGate,
  extractTerminalBriefSidecarStartExecutorGateOptions,
  extractTerminalBriefSidecarStartExecutorGateReceipt,
} from "./core/terminal-brief-sidecar-start-executor-gate.js";
import {
  buildTerminalBriefSidecarExecutorInvocationRehearsal,
  extractTerminalBriefSidecarExecutorInvocationRehearsalGate,
  extractTerminalBriefSidecarExecutorInvocationRehearsalOptions,
} from "./core/terminal-brief-sidecar-executor-invocation-rehearsal.js";
import {
  buildTerminalBriefSidecarDryRunStartCanaryPlan,
  extractTerminalBriefSidecarDryRunStartCanaryPlanOptions,
  extractTerminalBriefSidecarDryRunStartCanaryPlanRehearsal,
} from "./core/terminal-brief-sidecar-dry-run-start-canary-plan.js";
import {
  buildTerminalBriefSidecarPreflightEvidenceCollector,
  extractTerminalBriefSidecarPreflightEvidence,
  extractTerminalBriefSidecarPreflightEvidenceCollectorCanaryPlan,
  extractTerminalBriefSidecarPreflightEvidenceCollectorOptions,
} from "./core/terminal-brief-sidecar-preflight-evidence-collector.js";
import {
  buildBrokerCleanupPlan,
  executeBrokerCleanupPlan,
  validateCleanupExecution,
  type BrokerCleanupPlanOptions,
} from "./core/broker-cleanup.js";
import {
  isTerminalTaskOutboxAckEvidence,
  isTerminalTaskReceiptStatus,
  type TerminalTaskOutboxAckInput,
  type TerminalTaskOutboxReceiptUpdateInput,
} from "./core/terminal-event-outbox.js";
import type { TaskStatusEvent } from "./core/task-events.js";
import { GitHubIngestionService } from "./github/ingestion.js";
import { BoundedPoller } from "./github/bounded-poller.js";
import { parseGitHubWebhook, validateWebhookHeaders } from "./github/webhook-parser.js";

const DEFAULT_TASK_LIST_LIMIT = 100;
const MAX_TASK_LIST_LIMIT = 500;

interface ThreadedExchangeMessage extends A2AExchangeMessageRecord {
  replies: ThreadedExchangeMessage[];
}

interface DashboardAttentionItem {
  code: string;
  severity: "info" | "warn" | "critical";
  count: number;
  summary: string;
}

interface DashboardAttentionSummary {
  highestSeverity: "none" | DashboardAttentionItem["severity"];
  items: DashboardAttentionItem[];
}

export interface BrokerBuildInfo {
  component: string;
  revision: string;
  source: string;
  builtAt?: string;
  runtime?: string;
  image?: {
    tag?: string;
    digest?: string;
  };
}

interface OperatorTaskStatusSummary {
  total: number;
  active: number;
  terminal: number;
  byStatus: Record<TaskStatus, number>;
}

interface OperatorAttentionItem {
  code: "stale_worker" | "stale_task" | "long_running" | "dead_lettered" | "requeued";
  severity: "info" | "warn" | "critical";
  taskId: string;
  status: TaskStatus;
  intent: TaskKind;
  targetNodeId: string;
  assignedWorkerId?: string;
  claimedBy?: string;
  requeueCount: number;
  statusAgeSec: number;
  whyStuck: string;
  whoClaimed: string | null;
  whatNext: string;
  lastHeartbeatAt?: string;
  completedAt?: string;
  errorCode?: string;
  errorMessage?: string;
}

interface OperatorDashboardSnapshot {
  generatedAt: string;
  workers: BrokerDashboard["workers"];
  taskStatusSummary: OperatorTaskStatusSummary;
  recoverySummary: {
    stale: {
      staleWorkerAssignments: number;
      staleWorkersWithActiveTasks: BrokerDashboard["observability"]["workerHealth"]["staleWorkersWithActiveTasks"];
      oldestClaimed?: BrokerDashboard["observability"]["queuePressure"]["oldestClaimed"];
      oldestRunning?: BrokerDashboard["observability"]["queuePressure"]["oldestRunning"];
    };
    retry: {
      totalRequeued: number;
      maxRequeueAttempts: number;
      recentRequeues: BrokerDashboard["observability"]["recovery"]["recentRequeues"];
    };
    deadLetter: {
      totalDeadLettered: number;
      recentDeadLetters: BrokerDashboard["observability"]["recovery"]["recentDeadLetters"];
    };
  };
  attentionItems: OperatorAttentionItem[];
}

type OperatorSummary = BrokerDashboard & {
  version: string;
  build: BrokerBuildInfo;
  staleReaper: BrokerStaleReaperStatus;
  requestPressure: {
    general: RateLimitPressureSnapshot;
    worker: RateLimitPressureSnapshot;
  };
  attention: DashboardAttentionSummary;
  operatorSnapshot: OperatorDashboardSnapshot;
  hotEntityDiagnostics?: BrokerHotEntityDiagnostics;
};

interface OperatorSnapshotEvent {
  summary: OperatorSummary;
  alerts: AlertScanResult;
}

interface OperatorSummaryUpdateEvent {
  summary: OperatorSummary;
  alerts: AlertScanResult;
}

interface OperatorAlertEvent {
  alert: Alert;
}

type OperatorEventName =
  | "operator-snapshot"
  | "operator-summary-update"
  | "operator-alert-opened"
  | "operator-alert-resolved";

type OperatorEventPayload =
  | OperatorSnapshotEvent
  | OperatorSummaryUpdateEvent
  | OperatorAlertEvent;

interface BufferedOperatorEvent {
  seq: number;
  event: OperatorEventName;
  data: OperatorEventPayload;
}

interface OperatorReplayWindow {
  oldestBufferedSeq: number | null;
  currentSeq: number;
}

const DEFAULT_DASHBOARD_RECENT_HISTORY_LIMIT = 10;
const DEFAULT_DASHBOARD_OLDEST_PENDING_LIMIT = 5;
const DEFAULT_DASHBOARD_PENDING_ACTION_LIMIT = 5;
const DEFAULT_ALERT_STALE_AFTER_MS = 120_000;
const DEFAULT_ALERT_LONG_RUNNING_AFTER_MS = 3_600_000;
const DEFAULT_OPERATOR_EVENT_BUFFER_LIMIT = 200;
const DEFAULT_HEALTH_DIAGNOSTICS_TTL_MS = 5_000;

type CachedHealthDiagnostics = {
  persistence: BrokerPersistenceInfo;
  auditDiagnostics: BrokerHotAuditDiagnostics | undefined;
  hotTableGrowth: HotTableGrowthProjection | undefined;
};

function readRuntimeMemoryUsage(): Record<string, number> {
  const memory = process.memoryUsage();
  const heap = getHeapStatistics();
  return {
    rssBytes: memory.rss,
    heapTotalBytes: memory.heapTotal,
    heapUsedBytes: memory.heapUsed,
    heapLimitBytes: heap.heap_size_limit,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers,
  };
}

let _eventLoopDelayHistogram: ReturnType<typeof import("node:perf_hooks").monitorEventLoopDelay> | null = null;

function readEventLoopDelayMs(): number | null {
  try {
    const { monitorEventLoopDelay } = require("node:perf_hooks") as typeof import("node:perf_hooks");
    if (!_eventLoopDelayHistogram) {
      _eventLoopDelayHistogram = monitorEventLoopDelay({ resolution: 20 });
      _eventLoopDelayHistogram.enable();
    }
    const p99 = _eventLoopDelayHistogram.percentile(99) / 1e6;
    const p50 = _eventLoopDelayHistogram.percentile(50) / 1e6;
    // Return max(p50, p99) as a conservative estimate; reset to avoid stale accumulation.
    _eventLoopDelayHistogram.reset();
    return Math.round(Math.max(p50, p99) * 1000) / 1000;
  } catch {
    return null;
  }
}

class HealthDiagnosticsCache {
  private cached: CachedHealthDiagnostics | null = null;
  private cachedAt = 0;
  private readonly ttlMs: number;
  /** Prior snapshot of hot-table load metrics, used to compute growth rate across cache refreshes. */
  private priorMetrics: BrokerHotTableLoadMetrics | undefined;
  /** Timestamp of the prior snapshot. */
  private priorGeneratedAt: string | undefined;

  constructor(ttlMs: number = DEFAULT_HEALTH_DIAGNOSTICS_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  get(
    stateStore: BrokerStateStore,
    extra?: {
      processMemory?: {
        rssBytes: number;
        heapTotalBytes: number;
        heapUsedBytes: number;
        heapLimitBytes: number;
      };
      snapshotMetrics?: {
        lastSnapshotBytes?: number | null;
        lastPersistDurationMs?: number | null;
        lastSnapshotAt?: string | null;
      };
    },
  ): { persistence: BrokerPersistenceInfo; auditDiagnostics: BrokerHotAuditDiagnostics | undefined; hotTableGrowth: HotTableGrowthProjection | undefined; fromCache: boolean } {
    const now = Date.now();
    if (this.cached !== null && now - this.cachedAt < this.ttlMs) {
      return { ...this.cached, fromCache: true };
    }
    const persistence = stateStore.getPersistenceInfo?.() ?? {
      kind: "custom",
      stateVersion: CURRENT_BROKER_STATE_VERSION,
    };
    const auditDiagnostics = stateStore instanceof SqliteBrokerStateStore
      ? stateStore.readHotAuditDiagnostics()
      : undefined;

    // Compute hot-table growth projection from current load metrics.
    let hotTableGrowth: HotTableGrowthProjection | undefined;
    if (persistence.hotTableLoadMetrics) {
      hotTableGrowth = projectHotTableGrowth({
        current: persistence.hotTableLoadMetrics,
        prior: this.priorMetrics,
        priorGeneratedAt: this.priorGeneratedAt,
        runtimeLoadLimits: persistence.hotTableRuntimeLoadLimits,
        maxWarnings: 10,
        ...(extra?.processMemory ? { processMemory: extra.processMemory } : {}),
        ...(extra?.snapshotMetrics ? { snapshotMetrics: extra.snapshotMetrics } : {}),
      });
    }

    // Rotate prior snapshot for the next cache refresh.
    if (persistence.hotTableLoadMetrics) {
      this.priorMetrics = persistence.hotTableLoadMetrics;
      this.priorGeneratedAt = hotTableGrowth?.generatedAt;
    }

    this.cached = { persistence, auditDiagnostics, hotTableGrowth };
    this.cachedAt = now;
    return { persistence, auditDiagnostics, hotTableGrowth, fromCache: false };
  }
}

export interface BrokerServerOptions {
  host?: string;
  port?: number;
  serviceName?: string;
  publicBaseUrl?: string;
  stateFile?: string;
  sqliteFile?: string;
  persistenceBackend?: "json-file" | "sqlite";
  sqliteLoadSource?: SqliteBrokerLoadSource;
  workerOfflineAfterSec?: number;
  rateLimitWindowSec?: number;
  rateLimitMaxRequests?: number;
  workerRateLimitWindowSec?: number;
  workerRateLimitMaxRequests?: number;
  enforceRequesterIdentity?: boolean;
  edgeSecret?: string;
  agentCard?: AgentCard;
  stateStore?: BrokerStateStore;
  broker?: InMemoryA2ABroker;
  retentionPolicy?: Partial<BrokerRetentionPolicy>;
  maxSnapshotBytes?: number;
  /** Max non-terminal task rows to hydrate from SQLite hot tables. Env: `BROKER_HOT_RUNTIME_MAX_NON_TERMINAL_TASKS`. */
  maxHotRuntimeNonTerminalTasks?: number;
  /** Max terminal task rows to hydrate from SQLite hot tables; active tasks always hydrate. Env: `BROKER_HOT_RUNTIME_MAX_TERMINAL_TASKS`. */
  maxHotRuntimeTerminalTasks?: number;
  /** Max audit rows to hydrate from SQLite hot tables. Env: BROKER_HOT_RUNTIME_MAX_AUDIT_EVENTS. */
  maxHotRuntimeAuditEvents?: number;
  /** Max heartbeat audit rows retained in SQLite hot tables. Env: BROKER_HOT_RUNTIME_MAX_HEARTBEAT_AUDIT_EVENTS. */
  maxHotRuntimeHeartbeatAuditEvents?: number;
  /** Max terminal outbox rows to hydrate from SQLite hot tables. Env: `BROKER_HOT_RUNTIME_MAX_TERMINAL_OUTBOX_EVENTS`. */
  maxHotRuntimeTerminalOutboxEvents?: number;
  trustedProxy?: boolean;
  staleReaperEnabled?: boolean;
  staleReaperIntervalSec?: number;
  staleReaperOlderThanSec?: number;
  /**
   * Max times the stale-task reaper (or manual requeue) may recycle a single task back to
   * `queued` before dead-lettering it to `failed`. `0` disables the cap. Env:
   * `BROKER_MAX_REQUEUE_ATTEMPTS`.
   */
  maxRequeueAttempts?: number;
  /** Optional broker identity exposed on health/worker registration and stamped onto new tasks as broker-of-record. Env: `A2A_BROKER_ID` or `BROKER_ID`. */
  brokerId?: string;
  /** Team/tenant identity stamped onto new tasks for lifecycle ownership checks. Env: `A2A_TEAM_ID`. */
  teamId?: string;
  /**
   * SSE heartbeat interval for `/a2a/tasks/:id/events`. Comments (`: heartbeat ...`) keep
   * intermediaries from timing out idle subscriptions. `0` disables heartbeats. Env:
   * `TASK_SUBSCRIBE_HEARTBEAT_SEC`.
   */
  taskSubscribeHeartbeatSec?: number;
  /**
   * Enables the read-only `a2a.peer.status` JSON-RPC method. Default-off until
   * canary proof validates the Round 7 wake-layer rollout. Env: `A2A_PEER_STATUS_ENABLED`.
   */
  peerStatusEnabled?: boolean;
  /**
   * Optional deployment/build revision to expose on health and operator status surfaces.
   * Env priority: `A2A_BROKER_REVISION`, `BROKER_RELEASE_REVISION`, `RELEASE_REVISION`.
   */
  buildRevision?: string;
  /** Backward-compatible alias for older draft callers. Prefer `buildRevision`. */
  releaseRevision?: string;
  /** Optional broker version override. Defaults to package metadata. Env: `A2A_BROKER_VERSION`. */
  version?: string;
  /** Optional generated build-info JSON path. Defaults to bundled `dist/build-info.json` when present. */
  buildInfoFile?: string;
}

export interface BrokerStaleReaperStatus {
  enabled: boolean;
  intervalSec: number;
  olderThanSec: number;
  maxRequeueAttempts: number;
  lastRunAt?: string;
  lastRequeued?: number;
  lastDeadLettered?: number;
  totalDeadLettered: number;
  lastError?: string;
  runCount: number;
}

export interface BrokerServerRuntime {
  server: Server;
  handler: RequestListener<typeof IncomingMessage, typeof ServerResponse>;
  broker: InMemoryA2ABroker;
  /** Run the stale-task reaper sweep once. Returns the number of requeued tasks. */
  runStaleReaperSweep: () => number;
  /** Stop the periodic stale-task reaper timer (if started). Safe to call multiple times. */
  stopStaleReaper: () => void;
  /** Current reaper configuration and last-run observations for ops visibility. */
  getStaleReaperStatus: () => BrokerStaleReaperStatus;
  /** GitHub /a2a assign ingestion service — exposed for diagnostics and direct calls. */
  githubIngestion: GitHubIngestionService;
  /** Bounded poller for periodic GitHub event fetch — exposed for diagnostics. */
  boundedPoller?: BoundedPoller;
  /** Stop the bounded poller (if started). Safe to call multiple times. */
  stopPoller: () => void;
  config: {
    host: string;
    port: number;
    serviceName: string;
    publicBaseUrl: string;
    stateFile: string;
    sqliteFile?: string;
    persistenceBackend: "json-file" | "sqlite";
    sqliteLoadSource?: SqliteBrokerLoadSource;
    workerOfflineAfterSec: number;
    rateLimitWindowSec: number;
    rateLimitMaxRequests: number;
    workerRateLimitWindowSec: number;
    workerRateLimitMaxRequests: number;
    enforceRequesterIdentity: boolean;
    edgeSecret?: string;
    retentionPolicy: BrokerRetentionPolicy;
    maxSnapshotBytes: number;
    maxHotRuntimeNonTerminalTasks: number;
    maxHotRuntimeTerminalTasks: number;
    maxHotRuntimeAuditEvents: number;
    maxHotRuntimeHeartbeatAuditEvents: number;
    maxHotRuntimeTerminalOutboxEvents: number;
    trustedProxy: boolean;
    staleReaperEnabled: boolean;
    staleReaperIntervalSec: number;
    staleReaperOlderThanSec: number;
    maxRequeueAttempts: number;
    taskSubscribeHeartbeatSec: number;
    peerStatusEnabled: boolean;
    brokerId: string;
    version: string;
    build: BrokerBuildInfo;
  };
}

export function createBrokerServer(options: BrokerServerOptions = {}): BrokerServerRuntime {
  const host = options.host ?? process.env.HOST ?? "0.0.0.0";
  const port = options.port ?? Number(process.env.PORT ?? 8787);
  const serviceName = options.serviceName ?? process.env.SERVICE_NAME ?? "a2a-broker";
  const publicBaseUrl = resolvePublicBaseUrl(options.publicBaseUrl ?? process.env.PUBLIC_BASE_URL);
  const stateFile = options.stateFile ?? process.env.STATE_FILE ?? "/var/lib/a2a-broker/state.json";
  const persistenceBackend =
    options.persistenceBackend ?? normalizePersistenceBackend(process.env.BROKER_PERSISTENCE_BACKEND);
  const sqliteFile = options.sqliteFile ?? process.env.SQLITE_STATE_FILE ?? process.env.BROKER_SQLITE_FILE;
  const sqliteLoadSource = options.sqliteLoadSource ?? normalizeSqliteLoadSource(process.env.BROKER_SQLITE_LOAD_SOURCE);
  const workerOfflineAfterSec = options.workerOfflineAfterSec ?? Number(process.env.WORKER_OFFLINE_AFTER_SEC ?? 90);
  const rateLimitWindowSec = options.rateLimitWindowSec ?? Number(process.env.RATE_LIMIT_WINDOW_SEC ?? 60);
  const rateLimitMaxRequests = options.rateLimitMaxRequests ?? Number(process.env.RATE_LIMIT_MAX_REQUESTS ?? 10);
  const workerRateLimitWindowSec =
    options.workerRateLimitWindowSec ?? Number(process.env.WORKER_RATE_LIMIT_WINDOW_SEC ?? rateLimitWindowSec);
  const workerRateLimitMaxRequests =
    options.workerRateLimitMaxRequests ?? Number(process.env.WORKER_RATE_LIMIT_MAX_REQUESTS ?? 60);
  const enforceRequesterIdentity =
    options.enforceRequesterIdentity ?? process.env.ENFORCE_REQUESTER_IDENTITY !== "0";
  const edgeSecret = options.edgeSecret ?? process.env.EDGE_SECRET ?? process.env.A2A_EDGE_SECRET;
  const trustedProxy = options.trustedProxy ?? process.env.TRUSTED_PROXY === "1";
  const retentionPolicy = resolveBrokerRetentionPolicy(options.retentionPolicy);
  const hotRuntimeLimits = resolveHotRuntimeLimits(options);
  const maxSnapshotBytes = Math.max(
    1,
    options.maxSnapshotBytes ?? Number(process.env.STATE_FILE_MAX_BYTES ?? DEFAULT_BROKER_STATE_MAX_BYTES),
  );
  const maxHotRuntimeNonTerminalTasks = hotRuntimeLimits.maxNonTerminalTasks;
  const maxHotRuntimeTerminalTasks = hotRuntimeLimits.maxTerminalTasks;
  const maxHotRuntimeAuditEvents = hotRuntimeLimits.maxAuditEvents;
  const maxHotRuntimeHeartbeatAuditEvents = hotRuntimeLimits.maxHeartbeatAuditEvents;
  const maxHotRuntimeTerminalOutboxEvents = hotRuntimeLimits.maxTerminalOutboxEvents;
  const staleReaperEnabled =
    options.staleReaperEnabled ?? resolveBooleanEnv(process.env.STALE_REAPER_ENABLED, true);
  // Default sweep cadence (60s) is well below the default worker offline threshold (90s),
  // so a dead worker's in-flight task gets reaped within roughly offlineAfterSec + intervalSec.
  const staleReaperIntervalSec = Math.max(
    1,
    resolveIntegerOption(options.staleReaperIntervalSec, process.env.STALE_REAPER_INTERVAL_SEC, 60),
  );
  // Baseline stale threshold falls back to the worker offline window so local reaping never
  // fires earlier than "worker definitely missed a heartbeat cycle".
  const staleReaperOlderThanSec = Math.max(
    0,
    resolveIntegerOption(
      options.staleReaperOlderThanSec,
      process.env.STALE_REAPER_OLDER_THAN_SEC,
      Math.max(workerOfflineAfterSec, 1),
    ),
  );
  const maxRequeueAttempts = Math.max(
    0,
    resolveIntegerOption(
      options.maxRequeueAttempts,
      process.env.BROKER_MAX_REQUEUE_ATTEMPTS,
      DEFAULT_MAX_REQUEUE_ATTEMPTS,
    ),
  );
  const taskSubscribeHeartbeatSec = Math.max(
    0,
    resolveIntegerOption(options.taskSubscribeHeartbeatSec, process.env.TASK_SUBSCRIBE_HEARTBEAT_SEC, 15),
  );
  const peerStatusEnabled =
    options.peerStatusEnabled ?? resolveBooleanEnv(process.env.A2A_PEER_STATUS_ENABLED, false);
  const brokerId = resolveBrokerId(options.brokerId, serviceName);
  const teamId = resolveStringOption(options.teamId, process.env.A2A_TEAM_ID);
  const buildInfo = resolveBrokerBuildInfo(options, serviceName);

  const stateStore =
    options.stateStore ??
    createDefaultStateStore({
      backend: persistenceBackend,
      stateFile,
      sqliteFile,
      sqliteLoadSource,
      maxSnapshotBytes,
      hotRuntimeLimits,
    });
  const broker =
    options.broker ??
    new InMemoryA2ABroker(stateStore, stateStore.load(), {
      taskRepository: stateStore instanceof SqliteBrokerStateStore
        ? new SqliteTaskRuntimeRepository(stateStore)
        : undefined,
      auditRepository: stateStore instanceof SqliteBrokerStateStore
        ? new SqliteAuditRuntimeRepository(stateStore, { maxHotAuditEvents: retentionPolicy.maxAuditEvents })
        : undefined,
      tombstoneRepository: stateStore instanceof SqliteBrokerStateStore
        ? new SqliteTombstoneRuntimeRepository(stateStore)
        : undefined,
      workerRepository: stateStore instanceof SqliteBrokerStateStore
        ? new SqliteWorkerRuntimeRepository(stateStore)
        : undefined,
      exchangeRepository: stateStore instanceof SqliteBrokerStateStore
        ? new SqliteExchangeRuntimeRepository(stateStore)
        : undefined,
      exchangeMessageRepository: stateStore instanceof SqliteBrokerStateStore
        ? new SqliteExchangeMessageRuntimeRepository(stateStore)
        : undefined,
      proposalRepository: stateStore instanceof SqliteBrokerStateStore
        ? new SqliteProposalRuntimeRepository(stateStore)
        : undefined,
      artifactRepository: stateStore instanceof SqliteBrokerStateStore
        ? new SqliteArtifactRuntimeRepository(stateStore)
        : undefined,
      validationRepository: stateStore instanceof SqliteBrokerStateStore
        ? new SqliteValidationRuntimeRepository(stateStore)
        : undefined,
      retention: retentionPolicy,
      maxRequeueAttempts,
      brokerId,
      teamId,
    });
  const rateLimiter = new InMemoryRateLimiter(
    Math.max(1, rateLimitMaxRequests),
    Math.max(1, rateLimitWindowSec) * 1000,
  );
  const workerRateLimiter = new InMemoryRateLimiter(
    Math.max(1, workerRateLimitMaxRequests),
    Math.max(1, workerRateLimitWindowSec) * 1000,
  );
  const agentCard =
    options.agentCard ??
    createBrokerAgentCard({
      serviceName,
      publicBaseUrl,
      supportsStreaming: true,
      supportsPushNotifications: false,
    });
  const peerStatusService = peerStatusEnabled
    ? new PeerStatusService(broker, { workerOfflineAfterMs: workerOfflineAfterSec * 1000 })
    : undefined;

  const healthDiagnosticsCache = new HealthDiagnosticsCache();

  // In-broker periodic stale-task reaper. Without this, claimed/running tasks pointing at a
  // dead worker stay stuck until an operator manually hits POST /tasks/requeue_stale. The
  // broker snapshot already survives restart, but recovery still required a human. This loop
  // makes recovery self-healing after node, worker, or broker restarts.
  let staleReaperTimer: NodeJS.Timeout | null = null;
  let staleReaperLastRunAt: string | undefined;
  let staleReaperLastRequeued: number | undefined;
  let staleReaperLastDeadLettered: number | undefined;
  let staleReaperTotalDeadLettered = 0;
  let staleReaperLastError: string | undefined;
  let staleReaperRunCount = 0;
  let suppressOperatorStateBroadcast = false;

  const runStaleReaperSweep = (): number => {
    suppressOperatorStateBroadcast = true;
    try {
      const { requeued, deadLettered } = broker.requeueStaleTasksDetailed(
        staleReaperOlderThanSec * 1000,
        { workerOfflineAfterMs: workerOfflineAfterSec * 1000 },
      );
      staleReaperLastRunAt = new Date().toISOString();
      staleReaperLastRequeued = requeued.length;
      staleReaperLastDeadLettered = deadLettered.length;
      staleReaperTotalDeadLettered += deadLettered.length;
      staleReaperLastError = undefined;
      staleReaperRunCount += 1;
      if (deadLettered.length > 0) {
        // Operators want to see this without trawling audit logs. Keep it a single, greppable
        // line with task ids so it maps back to `task.failed` audit events.
        console.warn(
          `[a2a-broker] stale reaper dead-lettered ${deadLettered.length} task(s) after ${broker.getMaxRequeueAttempts()} requeue attempts: ${deadLettered
            .map((task) => task.id)
            .join(", ")}`,
        );
      }
      publishOperatorEvents();
      return requeued.length;
    } catch (error) {
      staleReaperLastRunAt = new Date().toISOString();
      staleReaperLastRequeued = 0;
      staleReaperLastDeadLettered = 0;
      staleReaperLastError = error instanceof Error ? error.message : String(error);
      staleReaperRunCount += 1;
      // Keep the loop alive: transient persistence errors shouldn't kill the timer.
      console.error(`[a2a-broker] stale reaper sweep failed: ${staleReaperLastError}`);
      publishOperatorEvents();
      return 0;
    } finally {
      suppressOperatorStateBroadcast = false;
    }
  };

  const stopStaleReaper = (): void => {
    if (staleReaperTimer !== null) {
      clearInterval(staleReaperTimer);
      staleReaperTimer = null;
    }
  };

  const getStaleReaperStatus = (): BrokerStaleReaperStatus => ({
    enabled: staleReaperEnabled,
    intervalSec: staleReaperIntervalSec,
    olderThanSec: staleReaperOlderThanSec,
    maxRequeueAttempts,
    lastRunAt: staleReaperLastRunAt,
    lastRequeued: staleReaperLastRequeued,
    lastDeadLettered: staleReaperLastDeadLettered,
    totalDeadLettered: staleReaperTotalDeadLettered,
    lastError: staleReaperLastError,
    runCount: staleReaperRunCount,
  });

  const operatorListeners = new Set<(event: BufferedOperatorEvent) => void>();
  const operatorEventBuffer: BufferedOperatorEvent[] = [];
  let operatorEventSeq = 0;
  let operatorAlertsById = new Map(
    buildAlertScan({
      broker,
      workerHeartbeatMissedAfterMs: workerOfflineAfterSec * 1000,
    }).alerts.map((alert) => [alert.id, alert] as const),
  );

  const currentOperatorSnapshot = (): OperatorSnapshotEvent => ({
    summary: buildDashboardResponse({
      broker,
      workerOfflineAfterSec,
      getStaleReaperStatus,
      rateLimiter,
      workerRateLimiter,
      version: buildInfo.version,
      build: buildInfo.build,
    }),
    alerts: buildAlertScan({
      broker,
      workerHeartbeatMissedAfterMs: workerOfflineAfterSec * 1000,
    }),
  });

  const replayOperatorEvents = (afterSeq: number): BufferedOperatorEvent[] =>
    operatorEventBuffer.filter((event) => event.seq > afterSeq);

  const currentOperatorReplayWindow = (): OperatorReplayWindow => ({
    oldestBufferedSeq: operatorEventBuffer[0]?.seq ?? null,
    currentSeq: operatorEventSeq,
  });

  const subscribeToOperatorEvents = (
    listener: (event: BufferedOperatorEvent) => void,
  ): (() => void) => {
    operatorListeners.add(listener);
    return () => {
      operatorListeners.delete(listener);
    };
  };

  const emitOperatorEvent = (event: OperatorEventName, data: OperatorEventPayload): void => {
    const buffered: BufferedOperatorEvent = {
      seq: operatorEventSeq + 1,
      event,
      data: structuredClone(data),
    };
    operatorEventSeq = buffered.seq;
    operatorEventBuffer.push(buffered);
    if (operatorEventBuffer.length > DEFAULT_OPERATOR_EVENT_BUFFER_LIMIT) {
      operatorEventBuffer.splice(0, operatorEventBuffer.length - DEFAULT_OPERATOR_EVENT_BUFFER_LIMIT);
    }

    for (const listener of [...operatorListeners]) {
      try {
        listener(buffered);
      } catch (error) {
        console.error(
          `[a2a-broker] operator subscriber threw: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  };

  const publishOperatorEvents = (): void => {
    if (operatorListeners.size === 0) {
      // Do not run operator projections on every broker state change while
      // the SSE stream is idle. A new subscriber gets a fresh snapshot on
      // connect, and active subscribers still receive buffered updates.
      return;
    }

    const snapshot = currentOperatorSnapshot();
    emitOperatorEvent("operator-summary-update", {
      summary: snapshot.summary,
      alerts: snapshot.alerts,
    });

    publishOperatorAlertChanges(snapshot.alerts);
  };

  const publishOperatorAlertChanges = (alerts: AlertScanResult): void => {
    const nextAlertsById = new Map(alerts.alerts.map((alert) => [alert.id, alert] as const));
    const openedAlerts = alerts.alerts
      .filter((alert) => !operatorAlertsById.has(alert.id))
      .sort((left, right) => left.id.localeCompare(right.id));
    const resolvedAlerts = [...operatorAlertsById.values()]
      .filter((alert) => !nextAlertsById.has(alert.id))
      .sort((left, right) => left.id.localeCompare(right.id));

    for (const alert of openedAlerts) {
      emitOperatorEvent("operator-alert-opened", { alert });
    }
    for (const alert of resolvedAlerts) {
      emitOperatorEvent("operator-alert-resolved", { alert });
    }

    operatorAlertsById = nextAlertsById;
  };

  const unsubscribeBrokerState = broker.subscribeToState(() => {
    if (suppressOperatorStateBroadcast) {
      return;
    }
    publishOperatorEvents();
  });

  if (staleReaperEnabled) {
    staleReaperTimer = setInterval(runStaleReaperSweep, staleReaperIntervalSec * 1000);
    // Reaper should never block process exit; tests and scripts expect clean shutdown.
    staleReaperTimer.unref?.();
  }

  // GitHub /a2a assign ingestion service — shared across the webhook endpoint and the bounded poller.
  const githubIngestion = new GitHubIngestionService({
    broker,
    defaultIntent: "analyze",
    requesterId: "github-ingestion",
  });

  // Bounded poller for periodic GitHub event fetch. Not started by default; the operator
  // may call `startPoller()` with a `fetchEvents` callback or start it externally.
  let boundedPoller: BoundedPoller | undefined;
  let pollerStarted = false;

  /**
   * Start the bounded poller with the given fetch function.
   * No-op if already started. Returns the poller instance.
   */
  function startPoller(fetchEvents: BoundedPoller["fetchEvents"]): BoundedPoller {
    if (pollerStarted && boundedPoller) return boundedPoller;
    boundedPoller = new BoundedPoller({
      ingestionService: githubIngestion,
      fetchEvents,
      label: "github-bounded-poller",
    });
    boundedPoller.start();
    pollerStarted = true;
    return boundedPoller;
  }

  /** Stop the bounded poller. Safe to call multiple times. */
  function stopPoller(): void {
    if (boundedPoller) {
      boundedPoller.stop();
      boundedPoller = undefined;
    }
    pollerStarted = false;
  }

  const handler: RequestListener<typeof IncomingMessage, typeof ServerResponse> = async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;
    const segments = path.split("/").filter(Boolean);
    let requesterIdentity: RequesterIdentity | null = null;

    try {
      requesterIdentity = extractRequesterIdentity(req);
      const isPublicDiscoveryRoute = req.method === "GET" && path === "/.well-known/agent-card.json";
      const isPublicLivenessRoute = req.method === "GET" && path === "/livez";
      if (path !== "/health" && !isPublicLivenessRoute && !isPublicDiscoveryRoute) {
        assertEdgeSecret(req, edgeSecret);

        const bucket = classifyRateLimitBucket(req, url);
        const limiter = bucket === "worker" ? workerRateLimiter : rateLimiter;
        const decision = limiter.check(
          rateLimitKey(req, requesterIdentity, {
            trustedProxy,
          }),
        );
        applyRateLimitHeaders(res, decision, bucket);
        if (!decision.allowed) {
          res.setHeader("retry-after", String(decision.retryAfterSec));
          throw new BrokerError("rate_limited", "rate limit exceeded");
        }
      }

      if (req.method === "GET" && path === "/livez") {
        return sendJson(res, 200, {
          ok: true,
          service: serviceName,
          brokerId,
          uptimeSec: Math.round(process.uptime()),
        }, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "GET" && path === "/health") {
        const t0 = performance.now();
        const runtimeMemory = readRuntimeMemoryUsage();
        const { persistence, auditDiagnostics, hotTableGrowth, fromCache } = healthDiagnosticsCache.get(stateStore, {
          processMemory: {
            rssBytes: runtimeMemory.rssBytes,
            heapTotalBytes: runtimeMemory.heapTotalBytes,
            heapUsedBytes: runtimeMemory.heapUsedBytes,
            heapLimitBytes: runtimeMemory.heapLimitBytes,
          },
        });
        const t1 = performance.now();
        const persistenceDurationMs = Math.round((t1 - t0) * 100) / 100;

        const requestPressure = {
          general: rateLimiter.snapshot(),
          worker: workerRateLimiter.snapshot(),
        };
        const t2 = performance.now();
        const pressureDurationMs = Math.round((t2 - t1) * 100) / 100;

        // runtimeMemory already read above — avoid duplicate call.
        const heapUsedRatio =
          runtimeMemory.heapLimitBytes > 0
            ? runtimeMemory.heapUsedBytes / runtimeMemory.heapLimitBytes
            : 0;
        const eventLoopDelayMs = readEventLoopDelayMs();

        const body: Record<string, unknown> = {
          ok: true,
          service: serviceName,
          brokerId,
          version: buildInfo.version,
          build: buildInfo.build,
          publicBaseUrl,
          uptimeSec: Math.round(process.uptime()),
          runtimeMemory: {
            ...runtimeMemory,
            heapUsedRatio: Math.round(heapUsedRatio * 1000) / 1000,
            eventLoopDelayMs: eventLoopDelayMs ?? null,
          },
          persistence,
          ...(auditDiagnostics !== undefined ? { auditDiagnostics } : {}),
          ...(hotTableGrowth !== undefined ? { hotTableGrowth } : {}),
          workers: {
            offlineAfterSec: workerOfflineAfterSec,
          },
          staleReaper: getStaleReaperStatus(),
          requestSecurity: {
            enforceRequesterIdentity,
            edgeSecretRequired: Boolean(edgeSecret),
            rateLimitWindowSec,
            rateLimitMaxRequests,
            workerRateLimitWindowSec,
            workerRateLimitMaxRequests,
            trustedProxy,
          },
          requestPressure,
          retentionPolicy,
          maxSnapshotBytes,
          ...(stateStore instanceof SqliteBrokerStateStore
            ? {
                terminalOutboxDiagnostics: stateStore.readHotTerminalOutboxDiagnostics(),
              }
            : {}),
        };

        if (heapUsedRatio > 0.85) {
          body.ok = false;
          body.error = `heap pressure critical: ${Math.round(heapUsedRatio * 100)}% used`;
        } else if (heapUsedRatio > 0.70) {
          body.warning = `heap pressure elevated: ${Math.round(heapUsedRatio * 100)}% used`;
        }
        const t3 = performance.now();
        const jsonDurationMs = Math.round((t3 - t2) * 100) / 100;
        const totalDurationMs = Math.round((t3 - t0) * 100) / 100;

        if (hotTableGrowth && hotTableGrowth.overallSeverity === "critical") {
          body.ok = false;
          const crit = hotTableGrowth.warnings.filter((w) => w.startsWith("CRITICAL"));
          body.error = `hot-table growth critical: ${truncateMessage(crit.join("; "), 500) || "one or more tables near stability limits"}`;
        } else if (hotTableGrowth && hotTableGrowth.overallSeverity === "warning") {
          const existing = body.warning ? `${body.warning}; ` : "";
          const warns = hotTableGrowth.warnings.filter((w) => w.startsWith("WARNING"));
          body.warning = `${existing}hot-table growth warning: ${truncateMessage(warns.join("; "), 500) || "growth approaching stability limits"}`;
        }

        body.timing = {
          totalMs: totalDurationMs,
          persistenceMs: persistenceDurationMs,
          pressureMs: pressureDurationMs,
          jsonMs: jsonDurationMs,
          fromCache,
        };

        return sendJson(res, 200, body, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "GET" && path === "/.well-known/agent-card.json") {
        return sendJson(res, 200, agentCard, {
          "cache-control": "public, max-age=300",
        });
      }

      if (req.method === "POST" && path === "/a2a/jsonrpc") {
        const body = await readJson(req);
        const response = executeA2AJsonRpc(body, {
          broker,
          agentCard,
          publicBaseUrl,
          requesterIdentity,
          enforceRequesterIdentity,
          peerStatusService,
        });
        return sendJson(res, 200, response);
      }

      if (
        req.method === "GET" &&
        segments[0] === "a2a" &&
        segments[1] === "workers" &&
        segments[2] &&
        segments[3] === "assignment-events" &&
        segments.length === 4
      ) {
        const workerId = segments[2];
        if (enforceRequesterIdentity) {
          assertRequesterCanSubscribeToWorkerAssignments(requesterIdentity, workerId);
        }
        if (!broker.getWorker(workerId)) {
          throw new BrokerError("not_found", "worker not found");
        }

        handleWorkerAssignmentEventStream(req, res, {
          broker,
          workerId,
          heartbeatMs: taskSubscribeHeartbeatSec * 1000,
        });
        return;
      }

      if (
        req.method === "GET" &&
        segments[0] === "a2a" &&
        segments[1] === "tasks" &&
        segments[2] &&
        segments[3] === "events" &&
        segments.length === 4
      ) {
        const taskId = segments[2];
        const task = broker.getTask(taskId);
        if (!task) {
          throw new BrokerError("not_found", "task not found");
        }
        if (enforceRequesterIdentity) {
          assertRequesterCanSubscribeToTask(requesterIdentity, task);
        }

        handleTaskEventStream(req, res, {
          broker,
          task,
          heartbeatMs: taskSubscribeHeartbeatSec * 1000,
        });
        return;
      }

      if (
        req.method === "POST" &&
        path === "/a2a/cross-broker/terminal-briefs"
      ) {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "cross-broker-terminal-brief.ingest");
        }

        const body = await readJson(req);
        const result = broker.ingestCrossBrokerTerminalBriefProjection(body as Parameters<typeof broker.ingestCrossBrokerTerminalBriefProjection>[0]);
        if (!result.accepted) {
          const status = result.ack.code === "missing_parent" ? 404 : result.ack.code === "stale_replay" ? 409 : 400;
          return sendJson(res, status, result);
        }
        return sendJson(res, result.replayed ? 200 : 202, result);
      }

      if (
        req.method === "GET" &&
        path === "/a2a/cross-broker/terminal-briefs"
      ) {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "cross-broker-terminal-brief.query");
        }

        const parentRoundId = url.searchParams.get("parent_round_id") ?? undefined;
        const originBrokerId = url.searchParams.get("origin_broker_id") ?? undefined;
        const records = broker.listCrossBrokerTerminalBriefProjections({ parentRoundId, originBrokerId });
        return sendJson(res, 200, {
          kind: "a2a.cross-broker.terminal-briefs",
          count: records.length,
          records,
        });
      }

      if (
        req.method === "GET" &&
        path === "/a2a/tasks/terminal-outbox"
      ) {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "task-terminal-outbox.subscribe");
        }

        const afterId = url.searchParams.get("after_id") ?? undefined;
        const limit = numberQueryParam(url, "limit");
        const reconcileUnacked = booleanQueryParam(url, "reconcile_unacked") ?? false;
        if (reconcileUnacked) {
          const subscription = broker.getTerminalTaskEventOutbox().subscribeWithCursor({ afterId, limit });
          return sendJson(res, 200, {
            kind: "task.terminal.outbox",
            count: subscription.events.length,
            cursor: subscription.cursor,
            reconciledUnacked: subscription.reconciledUnacked,
            events: subscription.events,
          });
        }
        const events = broker.getTerminalTaskEventOutbox().subscribe({ afterId, limit });
        return sendJson(res, 200, {
          kind: "task.terminal.outbox",
          count: events.length,
          cursor: events.at(-1)?.id ?? afterId ?? null,
          events,
        });
      }

      if (
        req.method === "POST" &&
        path === "/a2a/tasks/terminal-outbox/receipt"
      ) {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "task-terminal-outbox.receipt");
        }

        const body = await readJson<{ id?: unknown; receipt?: unknown }>(req);
        const id = body?.id;
        if (typeof id !== "string" || id.length === 0) {
          throw new BrokerError("bad_request", "terminal outbox receipt update requires a non-empty id");
        }
        const receipt = parseTerminalOutboxReceiptUpdate(body?.receipt);
        const event = broker.recordTerminalTaskOutboxReceiptStatus(id, receipt);
        if (!event) {
          throw new BrokerError("not_found", "terminal outbox event not found");
        }
        return sendJson(res, 200, { event });
      }

      if (
        req.method === "POST" &&
        path === "/a2a/tasks/terminal-outbox/ack"
      ) {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "task-terminal-outbox.ack");
        }

        const body = await readJson<{ id?: unknown; receipt?: unknown }>(req);
        const id = body?.id;
        if (typeof id !== "string" || id.length === 0) {
          throw new BrokerError("bad_request", "terminal outbox ack requires a non-empty id");
        }
        const receipt = parseTerminalOutboxAckReceipt(body?.receipt);
        const event = broker.acknowledgeTerminalTaskOutboxEvent(id, receipt);
        if (!event) {
          throw new BrokerError("not_found", "terminal outbox event not found");
        }
        return sendJson(res, 200, { event });
      }

      if (
        req.method === "GET" &&
        path === "/a2a/tasks/terminal-events"
      ) {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "task-terminal.subscribe");
        }

        handleTerminalTaskEventStream(req, res, {
          broker,
          heartbeatMs: taskSubscribeHeartbeatSec * 1000,
        });
        return;
      }

      if (
        req.method === "GET" &&
        path === "/a2a/operator/events"
      ) {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "operator.subscribe");
        }

        handleOperatorEventStream(req, res, {
          currentSnapshot: currentOperatorSnapshot,
          replayEvents: replayOperatorEvents,
          subscribe: subscribeToOperatorEvents,
          replayWindow: currentOperatorReplayWindow,
          heartbeatMs: taskSubscribeHeartbeatSec * 1000,
        });
        return;
      }

      if (req.method === "GET" && path === "/dashboard") {
        const recentLimit = numberQueryParam(url, "recent_history_limit") ?? 10;
        const oldestPendingLimit = numberQueryParam(url, "oldest_pending_limit") ?? 5;
        const pendingActionLimit = numberQueryParam(url, "pending_action_limit") ?? 5;
        return sendJson(res, 200, buildDashboardResponse({
          broker,
          workerOfflineAfterSec,
          getStaleReaperStatus,
          rateLimiter,
          workerRateLimiter,
          version: buildInfo.version,
          build: buildInfo.build,
          recentHistoryLimit: recentLimit,
          oldestPendingLimit,
          pendingActionLimit,
          hotEntityDiagnostics: stateStore instanceof SqliteBrokerStateStore
            ? stateStore.readHotEntityDiagnostics()
            : undefined,
        }));
      }

      if (req.method === "GET" && path === "/release/evidence") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "release.evidence.read");
        }
        const filters = taskFiltersFromUrl(url);
        const wantedTaskIds = new Set(taskIdsFromUrl(url));
        const tasks = listTasksForReadPath(stateStore, broker, filters)
          .filter((task) => wantedTaskIds.size === 0 || wantedTaskIds.has(task.id));
        const report = buildReleaseEvidenceExport(tasks, {
          repo: optionalString(url.searchParams.get("repo")),
          issue: optionalString(url.searchParams.get("issue")),
          parentIssue: optionalString(url.searchParams.get("parentIssue") ?? url.searchParams.get("parent_issue")),
          runId: optionalString(url.searchParams.get("runId") ?? url.searchParams.get("run_id")),
        });
        return sendJson(res, 200, report, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "POST" && path === "/terminal-brief/closeout/gate") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "terminal_brief.closeout_gate.read");
        }
        const body = await readJson<Record<string, unknown>>(req);
        let workflow;
        try {
          workflow = extractTerminalBriefFinalizerWorkflowPacket(body);
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid closeout gate input";
          throw new BrokerError("bad_request", message);
        }
        const report = buildTerminalBriefCloseoutGate(workflow, {
          issueUrl: optionalString(url.searchParams.get("issueUrl") ?? url.searchParams.get("issue_url")),
          prUrl: optionalString(url.searchParams.get("prUrl") ?? url.searchParams.get("pr_url")),
        });
        return sendJson(res, 200, report, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "POST" && path === "/terminal-brief/closeout/approval-request") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "terminal_brief.approval_request.read");
        }
        const body = await readJson<Record<string, unknown>>(req);
        let gate;
        try {
          gate = extractTerminalBriefCloseoutGatePacket(body);
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid approval request input";
          throw new BrokerError("bad_request", message);
        }
        const report = buildTerminalBriefApprovalRequest(gate);
        return sendJson(res, 200, report, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "POST" && path === "/terminal-brief/closeout/approval-executor") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "terminal_brief.approval_executor.read");
        }
        const body = await readJson<Record<string, unknown>>(req);
        let approvalRequest;
        try {
          approvalRequest = extractTerminalBriefApprovalRequestPacket(body);
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid approval executor input";
          throw new BrokerError("bad_request", message);
        }
        const executorOptions = body ?? {};
        const report = buildTerminalBriefApprovalExecutor(approvalRequest, {
          selectedAction: optionalString(executorOptions.selectedAction ?? executorOptions.selected_action),
          selectedTarget: optionalString(executorOptions.selectedTarget ?? executorOptions.selected_target),
          attemptExecute: executorOptions.attemptExecute === true || executorOptions.attempt_execute === true,
        });
        return sendJson(res, 200, report, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "POST" && path === "/terminal-brief/closeout/approval-dispatch") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "terminal_brief.approval_dispatch.read");
        }
        const body = await readJson<Record<string, unknown>>(req);
        let approvalExecutor;
        try {
          approvalExecutor = extractTerminalBriefApprovalExecutorPacket(body);
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid approval dispatch input";
          throw new BrokerError("bad_request", message);
        }
        const dispatchOptions = body ?? {};
        const report = buildTerminalBriefApprovalDispatchAdapter(approvalExecutor, {
          adapter: optionalString(dispatchOptions.adapter ?? dispatchOptions.adapter_type ?? dispatchOptions.adapterType),
          target: optionalString(dispatchOptions.target),
          channel: optionalString(dispatchOptions.channel),
          requestedBy: optionalString(dispatchOptions.requestedBy ?? dispatchOptions.requested_by),
          receiptId: optionalString(dispatchOptions.receiptId ?? dispatchOptions.receipt_id),
        });
        return sendJson(res, 200, report, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "POST" && path === "/terminal-brief/closeout/approval-receipt") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "terminal_brief.approval_receipt.read");
        }
        const body = await readJson<Record<string, unknown>>(req);
        let approvalDispatch;
        try {
          approvalDispatch = extractTerminalBriefApprovalDispatchAdapterPacket(body);
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid approval receipt input";
          throw new BrokerError("bad_request", message);
        }
        const receiptOptions = body ?? {};
        const maxAgeMsRaw = receiptOptions.maxAgeMs ?? receiptOptions.max_age_ms;
        const maxAgeMs = typeof maxAgeMsRaw === "number" && Number.isFinite(maxAgeMsRaw) ? maxAgeMsRaw : undefined;
        const report = buildTerminalBriefApprovalReceiptIngestor(
          approvalDispatch,
          extractTerminalBriefApprovalReceiptEvidence(body),
          { maxAgeMs },
        );
        return sendJson(res, 200, report, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "POST" && path === "/terminal-brief/closeout/finalizer-approval-status") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "terminal_brief.finalizer_approval_status.read");
        }
        const body = await readJson<Record<string, unknown>>(req);
        let approvalDispatch;
        try {
          approvalDispatch = extractTerminalBriefFinalizerApprovalStatusDispatch(body);
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid finalizer approval status input";
          throw new BrokerError("bad_request", message);
        }
        const report = buildTerminalBriefFinalizerApprovalStatus(
          approvalDispatch,
          extractTerminalBriefFinalizerApprovalReceiptStatus(body),
        );
        return sendJson(res, 200, report, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "POST" && path === "/terminal-brief/sidecar/dry-run-gate") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "terminal_brief.sidecar_dry_run_gate.read");
        }
        const body = await readJson<Record<string, unknown>>(req);
        let sidecarRehearsal;
        try {
          sidecarRehearsal = extractTerminalBriefSidecarDryRunGateRehearsal(body);
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid sidecar dry-run gate input";
          throw new BrokerError("bad_request", message);
        }
        const report = buildTerminalBriefSidecarDryRunGate(
          sidecarRehearsal,
          extractTerminalBriefSidecarDryRunGateFinalizerStatus(body),
          extractTerminalBriefSidecarDryRunOperatingEvidence(body),
        );
        return sendJson(res, 200, report, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "POST" && path === "/terminal-brief/sidecar/activation-approval") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "terminal_brief.sidecar_activation_approval.read");
        }
        const body = await readJson<Record<string, unknown>>(req);
        let dryRunGate;
        try {
          dryRunGate = extractTerminalBriefSidecarActivationApprovalGate(body);
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid sidecar activation approval input";
          throw new BrokerError("bad_request", message);
        }
        const report = buildTerminalBriefSidecarActivationApproval(
          dryRunGate,
          extractTerminalBriefSidecarActivationApprovalOptions(body),
        );
        return sendJson(res, 200, report, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "POST" && path === "/terminal-brief/sidecar/activation-receipt") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "terminal_brief.sidecar_activation_receipt.read");
        }
        const body = await readJson<Record<string, unknown>>(req);
        let activationApproval;
        try {
          activationApproval = extractTerminalBriefSidecarActivationApprovalPacket(body);
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid sidecar activation receipt input";
          throw new BrokerError("bad_request", message);
        }
        const report = buildTerminalBriefSidecarActivationReceiptIngestor(
          activationApproval,
          extractTerminalBriefSidecarActivationReceiptEvidence(body),
        );
        return sendJson(res, 200, report, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "POST" && path === "/terminal-brief/sidecar/start-executor-gate") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "terminal_brief.sidecar_start_executor_gate.read");
        }
        const body = await readJson<Record<string, unknown>>(req);
        let activationReceipt;
        try {
          activationReceipt = extractTerminalBriefSidecarStartExecutorGateReceipt(body);
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid sidecar start executor gate input";
          throw new BrokerError("bad_request", message);
        }
        const report = buildTerminalBriefSidecarStartExecutorGate(
          activationReceipt,
          extractTerminalBriefSidecarStartExecutorGateOptions(body),
        );
        return sendJson(res, 200, report, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "POST" && path === "/terminal-brief/sidecar/executor-invocation-rehearsal") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "terminal_brief.sidecar_executor_invocation_rehearsal.read");
        }
        const body = await readJson<Record<string, unknown>>(req);
        let startExecutorGate;
        try {
          startExecutorGate = extractTerminalBriefSidecarExecutorInvocationRehearsalGate(body);
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid sidecar executor invocation rehearsal input";
          throw new BrokerError("bad_request", message);
        }
        const report = buildTerminalBriefSidecarExecutorInvocationRehearsal(
          startExecutorGate,
          extractTerminalBriefSidecarExecutorInvocationRehearsalOptions(body),
        );
        return sendJson(res, 200, report, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "POST" && path === "/terminal-brief/sidecar/dry-run-start-canary-plan") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "terminal_brief.sidecar_dry_run_start_canary_plan.read");
        }
        const body = await readJson<Record<string, unknown>>(req);
        let executorInvocationRehearsal;
        try {
          executorInvocationRehearsal = extractTerminalBriefSidecarDryRunStartCanaryPlanRehearsal(body);
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid sidecar dry-run start canary plan input";
          throw new BrokerError("bad_request", message);
        }
        const report = buildTerminalBriefSidecarDryRunStartCanaryPlan(
          executorInvocationRehearsal,
          extractTerminalBriefSidecarDryRunStartCanaryPlanOptions(body),
        );
        return sendJson(res, 200, report, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "POST" && path === "/terminal-brief/sidecar/preflight-evidence-collector") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "terminal_brief.sidecar_preflight_evidence_collector.read");
        }
        const body = await readJson<Record<string, unknown>>(req);
        let dryRunStartCanaryPlan;
        try {
          dryRunStartCanaryPlan = extractTerminalBriefSidecarPreflightEvidenceCollectorCanaryPlan(body);
        } catch (error) {
          const message = error instanceof Error ? error.message : "invalid sidecar preflight evidence collector input";
          throw new BrokerError("bad_request", message);
        }
        const report = buildTerminalBriefSidecarPreflightEvidenceCollector(
          dryRunStartCanaryPlan,
          extractTerminalBriefSidecarPreflightEvidence(body),
          extractTerminalBriefSidecarPreflightEvidenceCollectorOptions(body),
        );
        return sendJson(res, 200, report, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "GET" && path === "/operator/cleanup/plan") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "operator.cleanup.plan");
        }
        if (!(stateStore instanceof SqliteBrokerStateStore)) {
          throw new BrokerError("bad_request", "broker cleanup planning requires sqlite persistence");
        }
        const plan = buildBrokerCleanupPlan(stateStore, cleanupPlanOptionsFromUrl(url));
        return sendJson(res, 200, plan, { "cache-control": "no-store" });
      }

      if (req.method === "POST" && path === "/operator/cleanup/execute") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "operator.cleanup.execute");
        }
        if (!(stateStore instanceof SqliteBrokerStateStore)) {
          throw new BrokerError("bad_request", "broker cleanup execution requires sqlite persistence");
        }
        const body = await readJson<Record<string, unknown>>(req);
        const plan = buildBrokerCleanupPlan(stateStore, cleanupPlanOptionsFromBody(body));
        const executionOptions = {
          approvalToken: optionalString(body?.approvalToken),
          confirmation: optionalString(body?.confirmation),
          backupProof: optionalString(body?.backupProof),
          allowWorkerPrune: body?.allowWorkerPrune === true,
          actorId: requesterIdentity?.id,
        };
        const blockers = validateCleanupExecution(plan, executionOptions);
        if (blockers.length > 0) {
          return sendJson(res, 409, {
            ok: false,
            error: "cleanup_execution_blocked",
            blockers,
            plan,
          }, { "cache-control": "no-store" });
        }
        const result = executeBrokerCleanupPlan(stateStore, plan, executionOptions);
        return sendJson(res, 200, { ok: true, plan, result }, { "cache-control": "no-store" });
      }

      // GET /alerts — monitoring-friendly alert projection
      if (req.method === "GET" && path === "/alerts") {
        const result = buildAlertScan({
          broker,
          staleAfterMs: numberQueryParam(url, "stale_after_ms") ?? DEFAULT_ALERT_STALE_AFTER_MS,
          longRunningAfterMs: numberQueryParam(url, "long_running_after_ms") ?? DEFAULT_ALERT_LONG_RUNNING_AFTER_MS,
          staleWarningMs: numberQueryParam(url, "stale_warning_ms") ?? undefined,
          staleCriticalMs: numberQueryParam(url, "stale_critical_ms") ?? undefined,
          longRunningWarningMs: numberQueryParam(url, "long_running_warning_ms") ?? undefined,
          longRunningCriticalMs: numberQueryParam(url, "long_running_critical_ms") ?? undefined,
          workerHeartbeatMissedAfterMs:
            numberQueryParam(url, "worker_heartbeat_missed_after_ms") ?? workerOfflineAfterSec * 1000,
        });
        return sendJson(res, 200, result);
      }

      // GET /cleanup/candidates — read-only cleanup candidate discovery (issue #520)
      if (req.method === "GET" && path === "/cleanup/candidates") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "cleanup.candidates.read");
        }
        const plan = broker.discoverCleanupCandidates({
          staleWorkerAfterMs: numberQueryParam(url, "stale_worker_after_ms") ?? undefined,
          staleTaskAfterMs: numberQueryParam(url, "stale_task_after_ms") ?? undefined,
          terminalOutboxBacklogAfterMs: numberQueryParam(url, "terminal_outbox_backlog_after_ms") ?? undefined,
          historicalTerminalAfterMs: numberQueryParam(url, "historical_terminal_after_ms") ?? undefined,
        });
        return sendJson(res, 200, plan, {
          "cache-control": "no-store",
        });
      }

      if (req.method === "GET" && path === "/workers") {
        const filters = workerFiltersFromUrl(url);
        const items = listWorkerViewsForReadPath(stateStore, broker, workerOfflineAfterSec * 1000, filters);
        return sendJson(res, 200, { items });
      }

      if (req.method === "GET" && path === "/workers/capacity") {
        return sendJson(res, 200, broker.getWorkerCapacitySummary({
          workerOfflineAfterMs: workerOfflineAfterSec * 1000,
          taskStaleAfterMs: numberQueryParam(url, "stale_after_ms") ?? workerOfflineAfterSec * 1000,
        }));
      }

      if (req.method === "POST" && path === "/workers/register") {
        const body = await readJson<RegisterWorkerRequest>(req);
        if (!body) {
          throw new BrokerError("bad_request", "request body is required");
        }
        if (enforceRequesterIdentity) {
          assertRequesterMatchesParty(
            requesterIdentity,
            { id: body.nodeId, role: body.role },
            "worker.register",
          );
        }
        const worker = broker.registerWorker(body);
        return sendJson(res, 201, { ...worker, status: "online", brokerId });
      }

      if (req.method === "GET" && segments[0] === "workers" && segments[1] && segments.length === 2) {
        const worker = getWorkerViewForReadPath(stateStore, broker, segments[1], workerOfflineAfterSec * 1000);
        if (!worker) {
          throw new BrokerError("not_found", "worker not found");
        }
        return sendJson(res, 200, worker);
      }

      if (req.method === "POST" && segments[0] === "workers" && segments[1] && segments[2] === "heartbeat") {
        const body = await readJson<WorkerHeartbeatRequest>(req);
        if (enforceRequesterIdentity) {
          const existingWorker = broker.getWorker(segments[1]);
          assertRequesterMatchesParty(
            requesterIdentity,
            { id: segments[1], role: existingWorker?.role },
            "worker.heartbeat",
          );
        }
        const worker = broker.heartbeatWorker(segments[1], body ?? undefined);
        return sendJson(res, 200, { ...worker, status: "online" });
      }

      if (req.method === "GET" && path === "/exchanges") {
        return sendJson(res, 200, { items: listExchangesForReadPath(stateStore, broker) });
      }

      if (req.method === "POST" && path === "/exchanges") {
        const body = await readJson<A2AExchangeRequest>(req);
        if (!body?.requester?.id || !body?.target?.id || !body?.message) {
          throw new BrokerError("bad_request", "requester.id, target.id, and message are required");
        }
        if (enforceRequesterIdentity) {
          assertRequesterMatchesParty(
            requesterIdentity,
            { id: body.requester.id, role: body.requester.role },
            "exchange.create",
          );
        }
        const exchange = broker.startExchange(body);
        return sendJson(res, 201, exchange);
      }

      if (req.method === "GET" && segments[0] === "exchanges" && segments[1] && segments[2] === "messages") {
        const parentMessageId = optionalString(url.searchParams.get("parentMessageId"));
        const includeDescendants = booleanQueryParam(url, "includeDescendants") ?? false;
        const items = listExchangeMessagesForReadPath(stateStore, broker, segments[1], {
          parentMessageId,
          includeDescendants,
        });
        return sendJson(res, 200, {
          exchangeId: segments[1],
          parentMessageId,
          items,
          threads: buildMessageThreads(items),
        });
      }

      if (req.method === "POST" && segments[0] === "exchanges" && segments[1] && segments[2] === "messages") {
        const body = await readJson<A2AExchangeMessageRequest>(req);
        if (!body?.actor?.id || !body?.message) {
          throw new BrokerError("bad_request", "actor.id and message are required");
        }
        if (enforceRequesterIdentity) {
          assertRequesterMatchesParty(
            requesterIdentity,
            { id: body.actor.id, role: body.actor.role },
            "exchange.message.create",
          );
        }
        const message = broker.addExchangeMessage(segments[1], body);
        return sendJson(res, 201, message);
      }

      if (req.method === "GET" && segments[0] === "exchanges" && segments[1] && segments.length === 2) {
        const exchange = getExchangeForReadPath(stateStore, broker, segments[1]);
        if (!exchange) {
          throw new BrokerError("not_found", "exchange not found");
        }
        return sendJson(res, 200, exchange);
      }

      if (req.method === "GET" && path === "/proposals") {
        const filters = proposalFiltersFromUrl(url);
        const items = listProposalSummariesForReadPath(stateStore, broker, filters);
        return sendJson(res, 200, { items });
      }

      if (req.method === "POST" && path === "/proposals") {
        const body = await readJson<CreateProposalRequest>(req);
        if (!body) {
          throw new BrokerError("bad_request", "request body is required");
        }
        if (enforceRequesterIdentity) {
          assertRequesterMatchesParty(
            requesterIdentity,
            { id: body.source.id, role: body.source.role },
            "proposal.create",
          );
        }
        const proposal = broker.createProposal(body);
        return sendJson(res, 201, proposal);
      }

      if (req.method === "GET" && segments[0] === "proposals" && segments[1] && segments.length === 2) {
        const details = getProposalDetailsForReadPath(stateStore, broker, segments[1]);
        if (!details) {
          throw new BrokerError("not_found", "proposal not found");
        }
        return sendJson(res, 200, details);
      }

      if (req.method === "POST" && segments[0] === "proposals" && segments[1] && segments[2] === "artifacts") {
        const body = await readJson<AttachArtifactRequest>(req);
        if (!body) {
          throw new BrokerError("bad_request", "request body is required");
        }
        if (enforceRequesterIdentity) {
          const proposal = broker.getProposal(segments[1]);
          if (!proposal) {
            throw new BrokerError("not_found", "proposal not found");
          }
          assertRequesterCanTouchProposalArtifacts(requesterIdentity, proposal);
        }
        const artifact = broker.attachArtifact(segments[1], body);
        return sendJson(res, 201, artifact);
      }

      if (req.method === "POST" && segments[0] === "proposals" && segments[1] && segments[2] === "validate") {
        const body = await readJson<SubmitValidationRequest>(req);
        if (!body) {
          throw new BrokerError("bad_request", "request body is required");
        }
        if (enforceRequesterIdentity) {
          assertRequesterMatchesParty(requesterIdentity, { id: body.nodeId }, "proposal.validate");
        }
        const validation = broker.submitValidationResult(segments[1], body);
        return sendJson(res, 201, validation);
      }

      if (req.method === "POST" && segments[0] === "proposals" && segments[1] && segments[2] === "approve") {
        const body = await readJson<ProposalActorRequest>(req);
        if (!body?.actor?.id) {
          throw new BrokerError("bad_request", "actor.id is required");
        }
        if (enforceRequesterIdentity) {
          assertRequesterMatchesParty(
            requesterIdentity,
            { id: body.actor.id, role: body.actor.role },
            "proposal.approve",
          );
        }
        const proposal = broker.approveProposal(segments[1], body);
        return sendJson(res, 200, {
          ok: true,
          proposalId: proposal.id,
          status: proposal.status,
          updatedAt: proposal.updatedAt,
        });
      }

      if (req.method === "POST" && segments[0] === "proposals" && segments[1] && segments[2] === "reject") {
        const body = await readJson<ProposalActorRequest>(req);
        if (!body?.actor?.id) {
          throw new BrokerError("bad_request", "actor.id is required");
        }
        if (enforceRequesterIdentity) {
          assertRequesterMatchesParty(
            requesterIdentity,
            { id: body.actor.id, role: body.actor.role },
            "proposal.reject",
          );
        }
        const proposal = broker.rejectProposal(segments[1], body);
        return sendJson(res, 200, {
          ok: true,
          proposalId: proposal.id,
          status: proposal.status,
          updatedAt: proposal.updatedAt,
        });
      }

      if (req.method === "POST" && segments[0] === "proposals" && segments[1] && segments[2] === "apply") {
        const body = await readJson<ApplyProposalRequest>(req);
        if (!body?.actor?.id || !body.workspace?.nodeId || !body.workspace?.workspaceId) {
          throw new BrokerError("bad_request", "actor.id, workspace.nodeId, and workspace.workspaceId are required");
        }
        if (enforceRequesterIdentity) {
          assertRequesterMatchesParty(
            requesterIdentity,
            { id: body.actor.id, role: body.actor.role },
            "proposal.apply",
          );
        }
        const proposal = broker.applyProposalLocally(segments[1], body);
        return sendJson(res, 200, {
          ok: true,
          proposalId: proposal.id,
          status: proposal.status,
          updatedAt: proposal.updatedAt,
        });
      }

      if (req.method === "GET" && path === "/tasks") {
        const filters = taskFiltersFromUrl(url, { defaultLimit: DEFAULT_TASK_LIST_LIMIT });
        const tasks = listTasksForReadPath(stateStore, broker, filters);
        const includeFullTaskRecords = url.searchParams.get("detail") === "full" || url.searchParams.get("include") === "full";
        return sendJson(res, 200, {
          count: tasks.length,
          limit: filters.limit,
          items: includeFullTaskRecords ? tasks : tasks.map(projectTaskListItem),
        });
      }

      if (req.method === "POST" && path === "/tasks") {
        const body = await readJson<CreateTaskRequest>(req);
        if (!body) {
          throw new BrokerError("bad_request", "request body is required");
        }
        if (enforceRequesterIdentity) {
          assertRequesterMatchesParty(
            requesterIdentity,
            { id: body.requester.id, role: body.requester.role },
            "task.create",
          );
        }
        const task = broker.createTask(body);
        return sendJson(res, 201, task);
      }

      if (req.method === "POST" && path === "/tasks/requeue_stale") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "task.requeue_stale");
        }
        const olderThanSec = numberQueryParam(url, "older_than_seconds") ?? 300;
        const { requeued, deadLettered } = broker.requeueStaleTasksDetailed(olderThanSec * 1000, {
          workerOfflineAfterMs: workerOfflineAfterSec * 1000,
        });
        return sendJson(res, 200, {
          ok: true,
          olderThanSeconds: olderThanSec,
          workerOfflineAfterSeconds: workerOfflineAfterSec,
          maxRequeueAttempts: broker.getMaxRequeueAttempts(),
          policy: "requeue_only",
          requeued: requeued.length,
          deadLettered: deadLettered.length,
          items: requeued.map((task) => ({
            id: task.id,
            status: task.status,
            targetNodeId: task.targetNodeId,
            assignedWorkerId: task.assignedWorkerId,
            proposalId: task.proposalId,
            requeueCount: task.requeueCount,
            updatedAt: task.updatedAt,
          })),
          deadLetteredItems: deadLettered.map((task) => ({
            id: task.id,
            status: task.status,
            targetNodeId: task.targetNodeId,
            assignedWorkerId: task.assignedWorkerId,
            proposalId: task.proposalId,
            requeueCount: task.requeueCount,
            error: task.error,
            updatedAt: task.updatedAt,
          })),
        });
      }

      if (
        req.method === "GET" &&
        segments[0] === "tasks" &&
        segments[1] &&
        segments[2] === "decision-dialectic" &&
        segments.length === 3
      ) {
        const task = broker.getTask(segments[1]);
        if (!task) {
          throw new BrokerError("not_found", "task not found");
        }
        try {
          const readModel = projectDecisionDialecticReadModel(task);
          return sendJson(res, 200, readModel);
        } catch (error) {
          if (error instanceof DecisionDialecticReadModelError) {
            const code = error.code === "missing_contract" || error.code === "wrong_kind" ? "not_found" : "bad_request";
            throw new BrokerError(code, error.message);
          }
          throw error;
        }
      }

      if (
        req.method === "POST" &&
        segments[0] === "tasks" &&
        segments[1] &&
        segments[2] === "decision-dialectic" &&
        segments[3] === "advance" &&
        segments.length === 4
      ) {
        const body = (await readJson<{ id?: string; phase?: DecisionDialecticPhase }>(req)) ?? {};
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "decision-dialectic.advance");
        }
        const task = broker.getTask(segments[1]);
        if (!task) {
          throw new BrokerError("not_found", "task not found");
        }
        try {
          const { phase, request } = buildDecisionDialecticPhaseTaskRequest(task, {
            id: body.id,
            phase: body.phase,
            requesterId: requesterIdentity?.id,
          });
          const childTask = broker.createTask(request);
          return sendJson(res, 201, {
            phase,
            parentTaskId: task.id,
            childTask,
          });
        } catch (error) {
          if (error instanceof DecisionDialecticExecutionError) {
            const code =
              error.code === "missing_contract" || error.code === "wrong_kind"
                ? "not_found"
                : "bad_request";
            throw new BrokerError(code, error.message);
          }
          throw error;
        }
      }

      if (
        req.method === "POST" &&
        segments[0] === "tasks" &&
        segments[1] &&
        segments[2] === "decision-dialectic" &&
        segments[3] === "patch" &&
        segments.length === 4
      ) {
        const body = await readJson<DecisionDialecticPatchV1>(req);
        if (!body) {
          throw new BrokerError("bad_request", "request body is required");
        }
        if (enforceRequesterIdentity) {
          const requesterRole = requesterIdentity?.role;
          if (requesterRole === "hub" || requesterRole === "operator") {
            assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "decision-dialectic.patch");
          } else {
            assertRequesterMatchesParty(requesterIdentity, { id: body.authorAgent }, "decision-dialectic.patch");
          }
        }
        const task = broker.getTask(segments[1]);
        if (!task) {
          throw new BrokerError("not_found", "task not found");
        }
        try {
          const input = extractDecisionDialecticTaskInput(task.payload);
          const updatedTask = applyDecisionDialecticPatch(input.contract.task, body);
          const nextPhase = nextDecisionDialecticPhase(updatedTask) ?? input.contract.phase;
          const updated = broker.updateTaskPayload(
            task.id,
            {
              ...task.payload,
              contract: {
                ...input.contract,
                phase: nextPhase,
                task: updatedTask,
              },
            },
            {
              actor: {
                id: requesterIdentity?.id ?? body.authorAgent,
                kind: "node",
                role: requesterIdentity?.role,
              },
              note: "decision.dialectic patch " + body.op,
            },
          );
          const readModel = projectDecisionDialecticReadModel(updated);
          return sendJson(res, 200, readModel);
        } catch (error) {
          if (error instanceof DecisionDialecticExecutionError) {
            const code =
              error.code === "missing_contract" || error.code === "wrong_kind"
                ? "not_found"
                : error.code === "invalid_contract"
                  ? "bad_request"
                  : "invalid_transition";
            throw new BrokerError(code, error.message);
          }
          throw error;
        }
      }

      if (
        req.method === "GET" &&
        segments[0] === "tasks" &&
        segments[1] &&
        segments[2] === "trading-dialectic" &&
        segments.length === 3
      ) {
        const task = broker.getTask(segments[1]);
        if (!task) {
          throw new BrokerError("not_found", "task not found");
        }
        try {
          const readModel = projectTradingDialecticReadModel(task);
          return sendJson(res, 200, readModel);
        } catch (error) {
          if (error instanceof TradingDialecticReadModelError) {
            const code = error.code === "missing_contract" || error.code === "wrong_kind" ? "not_found" : "bad_request";
            throw new BrokerError(code, error.message);
          }
          throw error;
        }
      }

      // GET /tasks/diagnostics — bulk diagnostic scan (MUST come before /tasks/:id)
      if (req.method === "GET" && path === "/operator/task-report") {
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "operator.task-report");
        }
        const taskIds = taskIdsFromUrl(url);
        const parentIssue = optionalString(url.searchParams.get("parent_issue"));
        const staleAfterMs = numberQueryParam(url, "stale_after_ms") ?? 15 * 60 * 1000;
        const updatedAfter = optionalString(url.searchParams.get("updated_after"));
        const tasks = taskIds.length
          ? taskIds.map((id) => getTaskForReadPath(stateStore, broker, id)).filter((task): task is TaskRecord => Boolean(task))
          : listTasksForReadPath(stateStore, broker, {});
        const terminalOutbox = broker.getTerminalTaskEventOutbox().subscribe();
        return sendJson(res, 200, buildOperatorTaskReport(tasks, { taskIds, parentIssue, staleAfterMs, updatedAfter, terminalOutbox }));
      }

      if (req.method === "GET" && path === "/tasks/diagnostics") {
        const staleAfterMs = numberQueryParam(url, "stale_after_ms") ?? 120_000;
        const longRunningAfterMs = numberQueryParam(url, "long_running_after_ms") ?? 3_600_000;
        const reports = listTaskDiagnosticsForReadPath(stateStore, broker, { staleAfterMs, longRunningAfterMs });
        return sendJson(res, 200, { items: reports, generatedAt: new Date().toISOString() });
      }

      if (
        req.method === "POST" &&
        segments[0] === "tasks" &&
        segments[1] &&
        segments[2] === "wake" &&
        segments[3] === "plan" &&
        segments.length === 4
      ) {
        const body = await readJson<TaskWakePlanRequest>(req);
        if (!body?.targetSessionKey) {
          throw new BrokerError("bad_request", "targetSessionKey is required");
        }
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "task.wake.plan");
        }
        const result = broker.planAcceptedTaskWake(segments[1], body);
        return sendJson(res, result.replayed ? 200 : 201, result);
      }

      if (
        req.method === "POST" &&
        segments[0] === "tasks" &&
        segments[1] &&
        segments[2] === "wake" &&
        segments[3] === "decision" &&
        segments.length === 4
      ) {
        const body = await readJson<TaskWakeDecisionRequest>(req);
        if (!body?.status) {
          throw new BrokerError("bad_request", "status is required");
        }
        if (enforceRequesterIdentity) {
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "task.wake.decision");
        }
        const task = broker.recordTaskWakeDecision(segments[1], body);
        return sendJson(res, 200, task);
      }

      if (req.method === "GET" && segments[0] === "tasks" && segments[1] && segments.length === 2) {
        const task = getTaskForReadPath(stateStore, broker, segments[1]);
        if (!task) {
          throw new BrokerError("not_found", "task not found");
        }
        return sendJson(res, 200, task);
      }

      // GET /tasks/:id/diagnostics — monitoring-friendly diagnostic report
      if (
        req.method === "GET" &&
        segments[0] === "tasks" &&
        segments[1] &&
        segments[2] === "diagnostics" &&
        segments.length === 3
      ) {
        const report = getTaskDiagnosticsForReadPath(stateStore, broker, segments[1], {
          staleAfterMs: numberQueryParam(url, "stale_after_ms") ?? undefined,
          longRunningAfterMs: numberQueryParam(url, "long_running_after_ms") ?? undefined,
        });
        return sendJson(res, 200, report);
      }

      if (
        req.method === "POST" && segments[0] === "tasks" && segments[1] && segments[2] === "claim") {
        const body = await readJson<TaskClaimRequest>(req);
        if (!body?.workerId) {
          throw new BrokerError("bad_request", "workerId is required");
        }
        if (enforceRequesterIdentity) {
          assertRequesterMatchesParty(requesterIdentity, { id: body.workerId }, "task.claim");
        }
        const task = broker.claimTask(segments[1], body.workerId);
        return sendJson(res, 200, task);
      }

      if (req.method === "POST" && segments[0] === "tasks" && segments[1] && segments[2] === "start") {
        const body = await readJson<TaskClaimRequest>(req);
        if (!body?.workerId) {
          throw new BrokerError("bad_request", "workerId is required");
        }
        if (enforceRequesterIdentity) {
          assertRequesterMatchesParty(requesterIdentity, { id: body.workerId }, "task.start");
        }
        const task = broker.startTask(segments[1], body.workerId);
        return sendJson(res, 200, task);
      }

      if (req.method === "POST" && segments[0] === "tasks" && segments[1] && segments[2] === "heartbeat") {
        const body = await readJson<TaskClaimRequest>(req);
        if (!body?.workerId) {
          throw new BrokerError("bad_request", "workerId is required");
        }
        if (enforceRequesterIdentity) {
          assertRequesterMatchesParty(requesterIdentity, { id: body.workerId }, "task.heartbeat");
        }
        const task = broker.heartbeatTask(segments[1], body.workerId);
        return sendJson(res, 200, task);
      }

      if (req.method === "POST" && segments[0] === "tasks" && segments[1] && segments[2] === "complete") {
        const body = await readJson<TaskCompleteRequest>(req);
        if (!body?.workerId) {
          throw new BrokerError("bad_request", "workerId is required");
        }
        if (enforceRequesterIdentity) {
          assertRequesterMatchesParty(requesterIdentity, { id: body.workerId }, "task.complete");
        }
        const task = broker.completeTask(segments[1], body.workerId, body.result);
        return sendJson(res, 200, task);
      }

      if (req.method === "POST" && segments[0] === "tasks" && segments[1] && segments[2] === "evidence") {
        const body = await readJson<TaskEvidenceRequest>(req);
        if (!body?.workerId) {
          throw new BrokerError("bad_request", "workerId is required");
        }
        if (enforceRequesterIdentity) {
          assertRequesterMatchesParty(requesterIdentity, { id: body.workerId }, "task.evidence");
        }
        const outcome = body.outcome ?? "done";
        if (outcome === "done" || outcome === "pr") {
          const task = broker.completeTask(segments[1], body.workerId, body.result);
          return sendJson(res, 200, task);
        }
        if (outcome === "blocked" || outcome === "failed") {
          const task = broker.failTask(segments[1], body.workerId, body.error ?? {
            code: outcome,
            message: body.result?.summary ?? body.result?.note ?? `worker posted ${outcome} evidence`,
          });
          return sendJson(res, 200, task);
        }
        throw new BrokerError("bad_request", "outcome must be done, pr, blocked, or failed");
      }

      if (req.method === "POST" && segments[0] === "tasks" && segments[1] && segments[2] === "fail") {
        const body = await readJson<TaskFailRequest>(req);
        if (!body?.workerId) {
          throw new BrokerError("bad_request", "workerId is required");
        }
        if (enforceRequesterIdentity) {
          assertRequesterMatchesParty(requesterIdentity, { id: body.workerId }, "task.fail");
        }
        const task = broker.failTask(segments[1], body.workerId, body.error);
        return sendJson(res, 200, task);
      }

      if (req.method === "POST" && segments[0] === "tasks" && segments[1] && segments[2] === "approve") {
        const body = await readJson<TaskApprovalRequest>(req);
        if (!body?.actor?.id) {
          throw new BrokerError("bad_request", "actor.id is required");
        }
        if (enforceRequesterIdentity) {
          assertRequesterMatchesParty(
            requesterIdentity,
            { id: body.actor.id, role: body.actor.role },
            "task.approve",
          );
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "task.approve");
        }
        const task = broker.approveTask(segments[1], body);
        return sendJson(res, 200, task);
      }

      if (req.method === "POST" && segments[0] === "tasks" && segments[1] && segments[2] === "reject-approval") {
        const body = await readJson<TaskApprovalTerminalRequest>(req);
        if (!body?.actor?.id) {
          throw new BrokerError("bad_request", "actor.id is required");
        }
        if (enforceRequesterIdentity) {
          assertRequesterMatchesParty(
            requesterIdentity,
            { id: body.actor.id, role: body.actor.role },
            "task.reject-approval",
          );
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "task.reject-approval");
        }
        const task = broker.rejectTaskApproval(segments[1], body);
        return sendJson(res, 200, task);
      }

      if (req.method === "POST" && segments[0] === "tasks" && segments[1] && segments[2] === "cancel") {
        const body = await readJson<TaskCancelRequest>(req);
        if (!body?.actor?.id) {
          throw new BrokerError("bad_request", "actor.id is required");
        }
        if (enforceRequesterIdentity) {
          assertRequesterMatchesParty(
            requesterIdentity,
            { id: body.actor.id, role: body.actor.role },
            "task.cancel",
          );
        }
        const task = broker.cancelTask(segments[1], body);
        return sendJson(res, 200, task);
      }

      if (req.method === "POST" && segments[0] === "tasks" && segments[1] && segments[2] === "reassign") {
        const body = await readJson<TaskReassignRequest>(req);
        if (!body?.actor?.id) {
          throw new BrokerError("bad_request", "actor.id is required");
        }
        if (enforceRequesterIdentity) {
          assertRequesterMatchesParty(
            requesterIdentity,
            { id: body.actor.id, role: body.actor.role },
            "task.reassign",
          );
          assertRequesterHasRole(requesterIdentity, ["hub", "operator"], "task.reassign");
        }
        const task = broker.reassignTask(segments[1], body);
        return sendJson(res, 200, task);
      }

      if (req.method === "GET" && path === "/audit") {
        const filters = auditFiltersFromUrl(url);
        return sendJson(res, 200, { items: listAuditEventsForReadPath(stateStore, broker, filters) });
      }

      // -----------------------------------------------------------------------
      // GitHub /a2a assign ingestion endpoint
      // -----------------------------------------------------------------------
      if (req.method === "POST" && path === "/github/webhook") {
        const validationError = validateWebhookHeaders(
          req.headers["x-github-event"] as string | undefined,
          req.headers["x-github-delivery"] as string | undefined,
        );
        if (validationError) {
          throw new BrokerError("bad_request", validationError);
        }

        const body = await readJson<Record<string, unknown>>(req);
        const parsed = parseGitHubWebhook(
          req.headers["x-github-event"] as string,
          req.headers["x-github-delivery"] as string,
          body,
        );
        if (!parsed) {
          throw new BrokerError("bad_request", "unsupported or malformed webhook payload");
        }

        const result = githubIngestion.ingest(parsed.event, parsed.ctx);
        return sendJson(res, result.deduped ? 200 : 201, result);
      }

      // GitHub webhook ingestion diagnostics
      if (req.method === "GET" && path === "/github/webhook/health") {
        const replayStats = githubIngestion.getReplayStats();
        return sendJson(res, 200, {
          ok: true,
          service: "github-ingestion",
          replayStats,
        });
      }

      // GitHub bounded poller diagnostics
      if (req.method === "GET" && path === "/github/poller/health") {
        const poller = boundedPoller;
        if (!poller) {
          return sendJson(res, 200, {
            ok: true,
            service: "github-bounded-poller",
            status: "not_started",
          });
        }
        return sendJson(res, 200, {
          ok: true,
          service: "github-bounded-poller",
          status: "started",
          stats: poller.getStats(),
        });
      }

      throw new BrokerError("not_found", "not found");
    } catch (error) {
      return sendError(res, error);
    }
  };

  const server = createServer(handler);
  // When the HTTP server closes, ensure the reaper timer is cleaned up. This matters for
  // tests and for any runtime that shuts down via server.close() rather than the SIGINT
  // path in startBrokerServer.
  server.on("close", () => {
    stopStaleReaper();
    stopPoller();
    unsubscribeBrokerState();
  });

  return {
    server,
    handler,
    broker,
    runStaleReaperSweep,
    stopStaleReaper,
    getStaleReaperStatus,
    githubIngestion,
    get boundedPoller(): BoundedPoller | undefined {
      return boundedPoller;
    },
    stopPoller,
    config: {
      host,
      port,
      serviceName,
      publicBaseUrl,
      stateFile,
      ...(sqliteFile ? { sqliteFile } : {}),
      persistenceBackend,
      ...(persistenceBackend === "sqlite" ? { sqliteLoadSource } : {}),
      workerOfflineAfterSec,
      rateLimitWindowSec,
      rateLimitMaxRequests,
      workerRateLimitWindowSec,
      workerRateLimitMaxRequests,
      enforceRequesterIdentity,
      edgeSecret,
      retentionPolicy,
      maxSnapshotBytes,
      maxHotRuntimeNonTerminalTasks,
      maxHotRuntimeTerminalTasks,
      maxHotRuntimeAuditEvents,
      maxHotRuntimeHeartbeatAuditEvents,
      maxHotRuntimeTerminalOutboxEvents,
      trustedProxy,
      staleReaperEnabled,
      staleReaperIntervalSec,
      staleReaperOlderThanSec,
      maxRequeueAttempts,
      taskSubscribeHeartbeatSec,
      peerStatusEnabled,
      brokerId,
      version: buildInfo.version,
      build: buildInfo.build,
    },
  };
}

export interface BrokerHotRuntimeLimits {
  maxNonTerminalTasks: number;
  maxTerminalTasks: number;
  maxAuditEvents: number;
  maxHeartbeatAuditEvents: number;
  maxTerminalOutboxEvents: number;
}

const DEFAULT_BROKER_HOT_RUNTIME_LIMITS: BrokerHotRuntimeLimits = {
  maxNonTerminalTasks: DEFAULT_HOT_RUNTIME_MAX_NON_TERMINAL_TASKS,
  maxTerminalTasks: DEFAULT_HOT_RUNTIME_MAX_TERMINAL_TASKS,
  maxAuditEvents: DEFAULT_HOT_RUNTIME_MAX_AUDIT_EVENTS,
  maxHeartbeatAuditEvents: DEFAULT_HOT_RUNTIME_MAX_HEARTBEAT_AUDIT_EVENTS,
  maxTerminalOutboxEvents: DEFAULT_HOT_RUNTIME_MAX_TERMINAL_OUTBOX_EVENTS,
};

function resolveHotRuntimeLimits(
  options: BrokerServerOptions,
): BrokerHotRuntimeLimits {
  return {
    maxNonTerminalTasks: Math.max(
      0,
      resolveIntegerOption(
        options.maxHotRuntimeNonTerminalTasks,
        process.env.BROKER_HOT_RUNTIME_MAX_NON_TERMINAL_TASKS,
        DEFAULT_BROKER_HOT_RUNTIME_LIMITS.maxNonTerminalTasks,
      ),
    ),
    maxTerminalTasks: Math.max(
      0,
      resolveIntegerOption(
        options.maxHotRuntimeTerminalTasks,
        process.env.BROKER_HOT_RUNTIME_MAX_TERMINAL_TASKS,
        DEFAULT_BROKER_HOT_RUNTIME_LIMITS.maxTerminalTasks,
      ),
    ),
    maxAuditEvents: Math.max(
      0,
      resolveIntegerOption(
        options.maxHotRuntimeAuditEvents,
        process.env.BROKER_HOT_RUNTIME_MAX_AUDIT_EVENTS,
        DEFAULT_BROKER_HOT_RUNTIME_LIMITS.maxAuditEvents,
      ),
    ),
    maxHeartbeatAuditEvents: Math.max(
      0,
      resolveIntegerOption(
        options.maxHotRuntimeHeartbeatAuditEvents,
        process.env.BROKER_HOT_RUNTIME_MAX_HEARTBEAT_AUDIT_EVENTS,
        Math.min(
          DEFAULT_BROKER_HOT_RUNTIME_LIMITS.maxAuditEvents,
          DEFAULT_BROKER_HOT_RUNTIME_LIMITS.maxHeartbeatAuditEvents,
        ),
      ),
    ),
    maxTerminalOutboxEvents: Math.max(
      0,
      resolveIntegerOption(
        options.maxHotRuntimeTerminalOutboxEvents,
        process.env.BROKER_HOT_RUNTIME_MAX_TERMINAL_OUTBOX_EVENTS,
        DEFAULT_BROKER_HOT_RUNTIME_LIMITS.maxTerminalOutboxEvents,
      ),
    ),
  };
}

function resolveBrokerRetentionPolicy(
  overrides?: Partial<BrokerRetentionPolicy>,
): BrokerRetentionPolicy {
  const maxAuditEvents = resolvePolicyNumber(
    overrides?.maxAuditEvents,
    process.env.BROKER_MAX_AUDIT_EVENTS,
    DEFAULT_BROKER_RETENTION_POLICY.maxAuditEvents,
  );
  return {
    terminalRetentionMs: resolvePolicyNumber(
      overrides?.terminalRetentionMs,
      process.env.BROKER_TERMINAL_RETENTION_MS,
      DEFAULT_BROKER_RETENTION_POLICY.terminalRetentionMs,
    ),
    maxTerminalExchanges: resolvePolicyNumber(
      overrides?.maxTerminalExchanges,
      process.env.BROKER_MAX_TERMINAL_EXCHANGES,
      DEFAULT_BROKER_RETENTION_POLICY.maxTerminalExchanges,
    ),
    maxTerminalTasks: resolvePolicyNumber(
      overrides?.maxTerminalTasks,
      process.env.BROKER_MAX_TERMINAL_TASKS,
      DEFAULT_BROKER_RETENTION_POLICY.maxTerminalTasks,
    ),
    maxTerminalProposals: resolvePolicyNumber(
      overrides?.maxTerminalProposals,
      process.env.BROKER_MAX_TERMINAL_PROPOSALS,
      DEFAULT_BROKER_RETENTION_POLICY.maxTerminalProposals,
    ),
    inactiveWorkerRetentionMs: resolvePolicyNumber(
      overrides?.inactiveWorkerRetentionMs,
      process.env.BROKER_INACTIVE_WORKER_RETENTION_MS,
      DEFAULT_BROKER_RETENTION_POLICY.inactiveWorkerRetentionMs,
    ),
    maxInactiveWorkers: resolvePolicyNumber(
      overrides?.maxInactiveWorkers,
      process.env.BROKER_MAX_INACTIVE_WORKERS,
      DEFAULT_BROKER_RETENTION_POLICY.maxInactiveWorkers,
    ),
    auditRetentionMs: resolvePolicyNumber(
      overrides?.auditRetentionMs,
      process.env.BROKER_AUDIT_RETENTION_MS,
      DEFAULT_BROKER_RETENTION_POLICY.auditRetentionMs,
    ),
    maxAuditEvents,
    maxHeartbeatAuditEvents: resolvePolicyNumber(
      overrides?.maxHeartbeatAuditEvents,
      process.env.BROKER_MAX_HEARTBEAT_AUDIT_EVENTS,
      Math.min(maxAuditEvents, DEFAULT_BROKER_RETENTION_POLICY.maxHeartbeatAuditEvents),
    ),
    heartbeatAuditSampleIntervalMs: resolvePolicyNumber(
      overrides?.heartbeatAuditSampleIntervalMs,
      process.env.BROKER_HEARTBEAT_AUDIT_SAMPLE_INTERVAL_MS,
      DEFAULT_BROKER_RETENTION_POLICY.heartbeatAuditSampleIntervalMs,
    ),
  };
}

function resolveStringOption(
  explicit: string | undefined,
  fromEnv: string | undefined,
  fallback?: string,
): string | undefined {
  if (typeof explicit === "string" && explicit.trim()) {
    return explicit.trim();
  }
  if (typeof fromEnv === "string" && fromEnv.trim()) {
    return fromEnv.trim();
  }
  if (typeof fallback === "string" && fallback.trim()) {
    return fallback.trim();
  }
  return undefined;
}

function resolveIntegerOption(
  explicit: number | undefined,
  fromEnv: string | undefined,
  fallback: number,
): number {
  if (typeof explicit === "number" && Number.isFinite(explicit)) {
    return Math.trunc(explicit);
  }
  if (fromEnv !== undefined) {
    const parsed = Number(fromEnv);
    if (Number.isFinite(parsed)) {
      return Math.trunc(parsed);
    }
  }
  return fallback;
}

function resolveBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no") {
    return false;
  }
  return fallback;
}

function resolveBrokerId(explicit: string | undefined, serviceName: string): string {
  return sanitizeBuildToken(explicit ?? process.env.A2A_BROKER_ID ?? process.env.BROKER_ID ?? serviceName, {
    fallback: serviceName,
    unsafeFallback: "redacted",
  }) ?? serviceName;
}

function resolveBrokerBuildInfo(options: BrokerServerOptions, serviceName: string): { version: string; build: BrokerBuildInfo } {
  const generated = readGeneratedBuildInfo(options.buildInfoFile);
  const version = sanitizeBuildToken(options.version ?? process.env.A2A_BROKER_VERSION ?? generated.version ?? readPackageVersion(), {
    fallback: "0.0.0",
    unsafeFallback: "0.0.0",
  }) ?? "0.0.0";
  const revision = sanitizeBuildToken(
    options.buildRevision ??
      options.releaseRevision ??
      process.env.A2A_BROKER_REVISION ??
      process.env.BROKER_RELEASE_REVISION ??
      process.env.RELEASE_REVISION ??
      generated.revision,
    { fallback: "unknown", unsafeFallback: "redacted" },
  ) ?? "unknown";
  const source = sanitizeBuildSource(process.env.A2A_BROKER_SOURCE ?? generated.source ?? "github.com/jinwon-int/a2a-broker");
  const builtAt = sanitizeIsoTimestamp(process.env.A2A_BROKER_BUILT_AT ?? generated.builtAt);
  const runtime = sanitizeBuildToken(process.env.A2A_BROKER_RUNTIME ?? generated.runtime, {
    fallback: undefined,
    unsafeFallback: undefined,
  });
  const imageTag = sanitizeBuildToken(process.env.A2A_BROKER_IMAGE_TAG ?? generated.image?.tag, {
    fallback: undefined,
    unsafeFallback: undefined,
  });
  const imageDigest = sanitizeImageDigest(process.env.A2A_BROKER_IMAGE_DIGEST ?? generated.image?.digest);

  const image = imageTag || imageDigest ? { ...(imageTag ? { tag: imageTag } : {}), ...(imageDigest ? { digest: imageDigest } : {}) } : undefined;

  return {
    version,
    build: {
      component: serviceName,
      revision,
      source,
      ...(builtAt ? { builtAt } : {}),
      ...(runtime ? { runtime } : {}),
      ...(image ? { image } : {}),
    },
  };
}

function readGeneratedBuildInfo(path?: string): Partial<BrokerBuildInfo & { version: string }> {
  const candidates = path ? [path] : [new URL("./build-info.json", import.meta.url)];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as Partial<BrokerBuildInfo & { version: string }>;
      if (parsed && typeof parsed === "object") {
        return parsed;
      }
    } catch {
      // Generated build-info is optional in local/dev runs.
    }
  }
  return {};
}

function readPackageVersion(): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    return parsed.version;
  } catch {
    return undefined;
  }
}

function sanitizeBrokerId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized)) {
    throw new Error("A2A_BROKER_ID must be a stable id using only letters, numbers, dots, underscores, colons, or hyphens");
  }
  return normalized;
}

function sanitizeBuildToken(value: string | undefined, options: { fallback: string | undefined; unsafeFallback: string | undefined }): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return options.fallback;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/.test(normalized)) {
    return options.unsafeFallback;
  }
  return normalized;
}

function sanitizeBuildSource(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized || normalized.length > 128) {
    return "github.com/jinwon-int/a2a-broker";
  }
  if (!/^(https:\/\/github\.com\/jinwon-int\/a2a-broker|github\.com\/jinwon-int\/a2a-broker)$/.test(normalized)) {
    return "github.com/jinwon-int/a2a-broker";
  }
  return normalized.replace(/^https:\/\//, "");
}

function sanitizeIsoTimestamp(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized || normalized.length > 32) {
    return undefined;
  }
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(normalized) ? normalized : undefined;
}

function sanitizeImageDigest(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  return /^sha256:[a-fA-F0-9]{64}$/.test(normalized) ? normalized.toLowerCase() : undefined;
}

function normalizePersistenceBackend(value: string | undefined): "json-file" | "sqlite" {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "sqlite") {
    return "sqlite";
  }
  return "json-file";
}

function normalizeSqliteLoadSource(value: string | undefined): SqliteBrokerLoadSource {
  const normalized = value?.trim().toLowerCase().replace(/_/g, "-");
  if (normalized === "hot-tables" || normalized === "hot-table" || normalized === "hot-runtime") {
    return "hot-tables";
  }
  return "snapshot";
}

function createDefaultStateStore(params: {
  backend: "json-file" | "sqlite";
  stateFile: string;
  sqliteFile?: string;
  sqliteLoadSource: SqliteBrokerLoadSource;
  maxSnapshotBytes: number;
  hotRuntimeLimits?: BrokerHotRuntimeLimits;
}): BrokerStateStore {
  if (params.backend === "sqlite") {
    return new SqliteBrokerStateStore(params.sqliteFile ?? `${params.stateFile}.sqlite`, {
      importJsonFile: params.stateFile,
      loadSource: params.sqliteLoadSource,
      maxBytes: params.maxSnapshotBytes,
      maxHotRuntimeNonTerminalTasks: params.hotRuntimeLimits?.maxNonTerminalTasks,
      maxHotRuntimeTerminalTasks: params.hotRuntimeLimits?.maxTerminalTasks,
      maxHotRuntimeAuditEvents: params.hotRuntimeLimits?.maxAuditEvents,
      maxHotRuntimeHeartbeatAuditEvents: params.hotRuntimeLimits?.maxHeartbeatAuditEvents,
      maxHotRuntimeTerminalOutboxEvents: params.hotRuntimeLimits?.maxTerminalOutboxEvents,
    });
  }
  return new JsonFileBrokerStateStore(params.stateFile, { maxBytes: params.maxSnapshotBytes });
}

function resolvePolicyNumber(
  explicit: number | undefined,
  fromEnv: string | undefined,
  fallback: number,
): number {
  if (typeof explicit === "number" && Number.isFinite(explicit)) {
    return Math.max(0, Math.trunc(explicit));
  }
  const parsed = Number(fromEnv);
  if (Number.isFinite(parsed)) {
    return Math.max(0, Math.trunc(parsed));
  }
  return fallback;
}

function resolvePublicBaseUrl(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(
      "PUBLIC_BASE_URL is required. Set a real public base URL instead of relying on the masked placeholder.",
    );
  }

  const normalized = trimmed.toLowerCase();
  if (normalized.includes("<masked-host>")) {
    throw new Error(
      "PUBLIC_BASE_URL must not use the placeholder http://<masked-host>:8787. Set the real public base URL before starting the broker.",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`PUBLIC_BASE_URL must be a valid absolute URL: ${trimmed}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`PUBLIC_BASE_URL must use http or https: ${trimmed}`);
  }

  return parsed.toString();
}

export function startBrokerServer(options: BrokerServerOptions = {}): BrokerServerRuntime {
  const runtime = createBrokerServer(options);
  runtime.server.listen(runtime.config.port, runtime.config.host, () => {
    console.log(`${runtime.config.serviceName} listening on ${runtime.config.publicBaseUrl}`);
    if (runtime.config.staleReaperEnabled) {
      const cap =
        runtime.config.maxRequeueAttempts === 0
          ? "unlimited"
          : `${runtime.config.maxRequeueAttempts}`;
      console.log(
        `[a2a-broker] stale reaper enabled: interval=${runtime.config.staleReaperIntervalSec}s olderThan=${runtime.config.staleReaperOlderThanSec}s maxRequeueAttempts=${cap}`,
      );
    }
  });

  const gracefulShutdown = (signal: NodeJS.Signals) => {
    console.log(`[a2a-broker] received ${signal}, stopping stale reaper and closing server`);
    runtime.stopStaleReaper();
    runtime.stopPoller();
    runtime.server.close(() => process.exit(0));
  };
  process.once("SIGINT", gracefulShutdown);
  process.once("SIGTERM", gracefulShutdown);

  return runtime;
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file://").href) {
  startBrokerServer();
}

async function readJson<T = unknown>(req: IncomingMessage): Promise<T | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return null;
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new BrokerError("bad_request", "invalid JSON body");
  }
}

function proposalFiltersFromUrl(url: URL): {
  status?: ProposalStatus;
  sourceNodeId?: string;
  targetNodeId?: string;
  kind?: ProposalKind;
} {
  return {
    status: optionalEnum(url.searchParams.get("status"), [
      "draft",
      "submitted",
      "validated",
      "approved",
      "rejected",
      "applied",
      "rolled_back",
    ]),
    sourceNodeId: optionalString(url.searchParams.get("sourceNodeId")),
    targetNodeId: optionalString(url.searchParams.get("targetNodeId")),
    kind: optionalEnum(url.searchParams.get("kind"), ["patch", "params", "hybrid"]),
  };
}

function workerFiltersFromUrl(url: URL): WorkerListFilters {
  return {
    role: optionalEnum(url.searchParams.get("role"), [
      "hub",
      "live-trader",
      "researcher",
      "analyst",
      "operator",
    ] as A2APartyRole[]),
    environment: optionalEnum(url.searchParams.get("environment"), [
      "research",
      "staging",
      "live",
    ] as A2AWorkerEnvironment[]),
    workspaceId: optionalString(url.searchParams.get("workspaceId")),
  };
}

function taskFiltersFromUrl(url: URL, options: { defaultLimit?: number } = {}): {
  exchangeId?: string;
  status?: TaskStatus;
  targetNodeId?: string;
  proposalId?: string;
  intent?: TaskKind;
  claimedBy?: string;
  assignedWorkerId?: string;
  taskOrigin?: TaskOrigin;
  limit?: number;
} {
  const rawStatus = url.searchParams.get("status");
  const status = rawStatus === "pending"
    ? "queued"
    : optionalEnum(rawStatus, [
      "blocked",
      "queued",
      "claimed",
      "running",
      "succeeded",
      "failed",
      "canceled",
    ]);
  return {
    exchangeId: optionalString(url.searchParams.get("exchangeId")),
    status,
    targetNodeId: optionalString(url.searchParams.get("targetNodeId")),
    proposalId: optionalString(url.searchParams.get("proposalId")),
    intent: optionalEnum(url.searchParams.get("intent"), [
      "chat",
      "analyze",
      "verify",
      "backfill",
      "propose_patch",
      "propose_params",
      "validate_change",
      "apply_local_change",
      "promote_to_live",
      "rollback_live",
    ]),
    claimedBy: optionalString(url.searchParams.get("claimedBy")),
    assignedWorkerId: optionalString(url.searchParams.get("assignedWorkerId")) ?? optionalString(url.searchParams.get("worker")),
    taskOrigin: optionalEnum(url.searchParams.get("taskOrigin"), ["github", "api", "sessions_send", "operator", "unknown"]),
    limit: boundedLimitQueryParam(url, "limit", MAX_TASK_LIST_LIMIT, options.defaultLimit),
  };
}

function auditFiltersFromUrl(url: URL): {
  proposalId?: string;
  actorId?: string;
  targetId?: string;
  action?: AuditAction;
} {
  return {
    proposalId: optionalString(url.searchParams.get("proposalId")),
    actorId: optionalString(url.searchParams.get("actorId")),
    targetId: optionalString(url.searchParams.get("targetId")),
    action: optionalEnum(url.searchParams.get("action"), [
      "exchange.message.added",
      "proposal.created",
      "artifact.attached",
      "validation.submitted",
      "proposal.approved",
      "proposal.rejected",
      "proposal.applied",
      "task.created",
      "task.approved",
      "task.claimed",
      "task.started",
      "task.reassigned",
      "task.requeued",
      "task.succeeded",
      "task.failed",
      "task.canceled",
      "worker.registered",
      "worker.heartbeat",
    ]),
  };
}

function taskIdsFromUrl(url: URL): string[] {
  const repeated = url.searchParams.getAll("task_id").flatMap((value) => value.split(","));
  const csv = optionalString(url.searchParams.get("task_ids"));
  if (csv) repeated.push(...csv.split(","));
  return [...new Set(repeated.map((value) => value.trim()).filter(Boolean))];
}

function listAuditEventsForReadPath(
  stateStore: BrokerStateStore,
  broker: InMemoryA2ABroker,
  filters: AuditListFilters,
) {
  if (stateStore instanceof SqliteBrokerStateStore) {
    return stateStore.readHotAuditEvents(filters);
  }
  return broker.listAuditEvents(filters);
}

interface TaskListItem {
  id: string;
  intent: TaskKind;
  status: TaskStatus;
  targetNodeId: string;
  requester: TaskRecord["requester"];
  target: TaskRecord["target"];
  exchangeId?: string;
  parentTaskId?: string;
  proposalId?: string;
  assignedWorkerId?: string;
  claimedBy?: string;
  taskOrigin?: TaskOrigin;
  artifactIds?: string[];
  resultSummary?: string;
  error?: Pick<NonNullable<TaskRecord["error"]>, "code" | "message">;
  requeueCount?: number;
  createdAt: string;
  updatedAt: string;
  claimedAt?: string;
  completedAt?: string;
}

function projectTaskListItem(task: TaskRecord): TaskListItem {
  const artifactIds = task.result?.artifactIds ?? task.artifactIds;
  return {
    id: task.id,
    intent: task.intent,
    status: task.status,
    targetNodeId: task.targetNodeId,
    requester: task.requester,
    target: task.target,
    exchangeId: task.exchangeId,
    parentTaskId: task.parentTaskId,
    proposalId: task.proposalId,
    assignedWorkerId: task.assignedWorkerId,
    claimedBy: task.claimedBy,
    taskOrigin: task.taskOrigin,
    artifactIds,
    resultSummary: task.result?.summary ?? task.result?.note,
    error: task.error ? { code: task.error.code, message: task.error.message } : undefined,
    requeueCount: task.requeueCount,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    claimedAt: task.claimedAt,
    completedAt: task.completedAt,
  };
}

function listTasksForReadPath(
  stateStore: BrokerStateStore,
  broker: InMemoryA2ABroker,
  filters: TaskListFilters,
): TaskRecord[] {
  if (stateStore instanceof SqliteBrokerStateStore && canUseSqliteTaskHotRead(filters)) {
    return stateStore.readHotTasks({
      status: filters.status,
      targetNodeId: filters.targetNodeId,
      intent: filters.intent,
      assignedWorkerId: filters.assignedWorkerId,
      taskOrigin: filters.taskOrigin,
    });
  }
  return broker.listTasks(filters);
}

function getTaskForReadPath(
  stateStore: BrokerStateStore,
  broker: InMemoryA2ABroker,
  taskId: string,
): TaskRecord | null {
  if (stateStore instanceof SqliteBrokerStateStore) {
    return stateStore.readHotTasks({ id: taskId })[0] ?? null;
  }
  return broker.getTask(taskId);
}

function getTaskDiagnosticsForReadPath(
  stateStore: BrokerStateStore,
  broker: InMemoryA2ABroker,
  taskId: string,
  options: TaskDiagnosticsOptions,
): TaskDiagnosticReport {
  if (stateStore instanceof SqliteBrokerStateStore) {
    const task = stateStore.readHotTasks({ id: taskId })[0];
    if (!task) {
      throw new BrokerError("not_found", "task not found");
    }
    const assignedWorker = task.assignedWorkerId
      ? stateStore.readHotWorkers({ nodeId: task.assignedWorkerId })[0] ?? null
      : null;
    const lastRequeueEvent = latestAuditEvent(stateStore.readHotAuditEvents({
      targetId: taskId,
      action: "task.requeued",
    }));
    return broker.getTaskDiagnosticsForRecord(task, options, {
      tombstone: stateStore.readHotTombstones({ taskId })[0] ?? null,
      assignedWorker,
      lastRequeueEvent,
    });
  }
  return broker.getTaskDiagnostics(taskId, options);
}

function listTaskDiagnosticsForReadPath(
  stateStore: BrokerStateStore,
  broker: InMemoryA2ABroker,
  options: TaskDiagnosticsOptions,
): TaskDiagnosticReport[] {
  if (stateStore instanceof SqliteBrokerStateStore) {
    const tombstonesByTaskId = new Map<string, TaskTombstone>(
      stateStore.readHotTombstones().map((tombstone) => [tombstone.taskId, tombstone]),
    );
    const workersByNodeId = new Map<string, WorkerRecord>(
      stateStore.readHotWorkers().map((worker) => [worker.nodeId, worker]),
    );
    const latestRequeueEventByTaskId = new Map<string, AuditEvent>();
    for (const event of stateStore.readHotAuditEvents({ action: "task.requeued" })) {
      const existing = latestRequeueEventByTaskId.get(event.targetId);
      if (!existing || event.createdAt > existing.createdAt) {
        latestRequeueEventByTaskId.set(event.targetId, event);
      }
    }
    return stateStore.readHotTasks().map((task) => broker.getTaskDiagnosticsForRecord(task, options, {
      tombstone: tombstonesByTaskId.get(task.id) ?? null,
      assignedWorker: task.assignedWorkerId ? workersByNodeId.get(task.assignedWorkerId) ?? null : null,
      lastRequeueEvent: latestRequeueEventByTaskId.get(task.id) ?? null,
    }));
  }
  return broker.listTasks().map((task) => broker.getTaskDiagnostics(task.id, options));
}

function latestAuditEvent(events: AuditEvent[]): AuditEvent | null {
  let latest: AuditEvent | null = null;
  for (const event of events) {
    if (!latest || event.createdAt > latest.createdAt) {
      latest = event;
    }
  }
  return latest;
}

function listExchangesForReadPath(
  stateStore: BrokerStateStore,
  broker: InMemoryA2ABroker,
): A2AExchangeState[] {
  if (stateStore instanceof SqliteBrokerStateStore) {
    return stateStore.readHotExchanges();
  }
  return broker.listExchanges();
}

function getExchangeForReadPath(
  stateStore: BrokerStateStore,
  broker: InMemoryA2ABroker,
  exchangeId: string,
): A2AExchangeState | null {
  if (stateStore instanceof SqliteBrokerStateStore) {
    return stateStore.readHotExchanges({ id: exchangeId })[0] ?? null;
  }
  return broker.getExchange(exchangeId);
}

function listExchangeMessagesForReadPath(
  stateStore: BrokerStateStore,
  broker: InMemoryA2ABroker,
  exchangeId: string,
  filters: {
    parentMessageId?: string;
    includeDescendants?: boolean;
  },
): A2AExchangeMessageRecord[] {
  if (!(stateStore instanceof SqliteBrokerStateStore)) {
    return broker.listExchangeMessages(exchangeId, filters);
  }

  if (!stateStore.readHotExchanges({ id: exchangeId })[0]) {
    throw new BrokerError("not_found", "exchange not found");
  }

  const items = stateStore.readHotExchangeMessages({ exchangeId });
  if (!filters.parentMessageId) {
    return items;
  }

  if (!items.some((message) => message.id === filters.parentMessageId)) {
    throw new BrokerError("not_found", "exchange message not found");
  }
  if (filters.includeDescendants) {
    const allowedIds = collectThreadMessageIds(items, filters.parentMessageId);
    return items.filter((message) => allowedIds.has(message.id));
  }
  return items.filter((message) => message.parentMessageId === filters.parentMessageId);
}

function listProposalSummariesForReadPath(
  stateStore: BrokerStateStore,
  broker: InMemoryA2ABroker,
  filters: ProposalListFilters,
): Array<Pick<ChangeProposal, "id" | "sourceNodeId" | "targetNodeId" | "kind" | "summary" | "status" | "updatedAt">> {
  const proposals = stateStore instanceof SqliteBrokerStateStore
    ? stateStore.readHotProposals(filters)
    : broker.listProposals(filters);
  return proposals.map(toProposalSummary);
}

function getProposalDetailsForReadPath(
  stateStore: BrokerStateStore,
  broker: InMemoryA2ABroker,
  proposalId: string,
): ProposalDetails | null {
  if (!(stateStore instanceof SqliteBrokerStateStore)) {
    return broker.getProposalDetails(proposalId);
  }

  const proposal = stateStore.readHotProposals({ id: proposalId })[0];
  if (!proposal) {
    return null;
  }

  return {
    proposal,
    artifacts: broker.listArtifactsForProposal(proposalId),
    validations: broker.listValidationsForProposal(proposalId),
    audit: stateStore.readHotAuditEvents({ proposalId }),
  };
}

function toProposalSummary(
  proposal: ChangeProposal,
): Pick<ChangeProposal, "id" | "sourceNodeId" | "targetNodeId" | "kind" | "summary" | "status" | "updatedAt"> {
  return {
    id: proposal.id,
    sourceNodeId: proposal.sourceNodeId,
    targetNodeId: proposal.targetNodeId,
    kind: proposal.kind,
    summary: proposal.summary,
    status: proposal.status,
    updatedAt: proposal.updatedAt,
  };
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

function listWorkerViewsForReadPath(
  stateStore: BrokerStateStore,
  broker: InMemoryA2ABroker,
  offlineAfterMs: number,
  filters: WorkerListFilters,
): WorkerView[] {
  if (stateStore instanceof SqliteBrokerStateStore) {
    return stateStore
      .readHotWorkers({ role: filters.role })
      .filter((worker) => workerMatchesNonSqliteFilters(worker, filters))
      .map((worker) => toWorkerView(worker, offlineAfterMs));
  }
  return broker.listWorkerViews(offlineAfterMs, filters);
}

function getWorkerViewForReadPath(
  stateStore: BrokerStateStore,
  broker: InMemoryA2ABroker,
  nodeId: string,
  offlineAfterMs: number,
): WorkerView | null {
  if (stateStore instanceof SqliteBrokerStateStore) {
    const worker = stateStore.readHotWorkers({ nodeId })[0];
    return worker ? toWorkerView(worker, offlineAfterMs) : null;
  }
  return broker.getWorkerView(nodeId, offlineAfterMs);
}

function workerMatchesNonSqliteFilters(worker: WorkerRecord, filters: WorkerListFilters): boolean {
  if (filters.environment && !worker.capabilities.environments.includes(filters.environment)) {
    return false;
  }
  if (filters.workspaceId && !worker.capabilities.workspaceIds.includes(filters.workspaceId)) {
    return false;
  }
  return true;
}

function toWorkerView(worker: WorkerRecord, offlineAfterMs: number): WorkerView {
  return {
    ...worker,
    status: Date.now() - Date.parse(worker.lastSeenAt) <= offlineAfterMs ? "online" : "stale",
  };
}

function canUseSqliteTaskHotRead(filters: TaskListFilters): boolean {
  return !(
    filters.exchangeId ||
    filters.proposalId ||
    filters.claimedBy
  );
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalEnum<T extends string>(value: string | null, allowed: readonly T[]): T | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim() as T;
  return allowed.includes(normalized) ? normalized : undefined;
}

function parseTerminalOutboxAckReceipt(value: unknown): TerminalTaskOutboxAckInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BrokerError(
      "bad_request",
      "terminal outbox ack requires receipt evidence; Gateway/provider send success alone is not accepted",
    );
  }
  const receipt = value as Record<string, unknown>;
  if (!isTerminalTaskOutboxAckEvidence(receipt.evidence)) {
    throw new BrokerError(
      "bad_request",
      "terminal outbox ack evidence must be current_session_visible, operator_visible, operator_confirmed, or provider_delivery_receipt",
    );
  }
  return {
    evidence: receipt.evidence,
    acknowledgedAt: typeof receipt.acknowledgedAt === "string" ? receipt.acknowledgedAt : undefined,
    receiptId: typeof receipt.receiptId === "string" ? receipt.receiptId : undefined,
    note: typeof receipt.note === "string" ? receipt.note : undefined,
  };
}

function parseTerminalOutboxReceiptUpdate(value: unknown): TerminalTaskOutboxReceiptUpdateInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BrokerError("bad_request", "terminal outbox receipt update requires a receipt object");
  }
  const receipt = value as Record<string, unknown>;
  if (!isTerminalTaskReceiptStatus(receipt.status)) {
    throw new BrokerError(
      "bad_request",
      "terminal outbox receipt status must be accepted, started, produced, provider_sent, provider_accepted, current_session_visible, operator_visible, timed_out, stale, or failed",
    );
  }
  return {
    status: receipt.status,
    updatedAt: typeof receipt.updatedAt === "string" ? receipt.updatedAt : undefined,
    note: typeof receipt.note === "string" ? receipt.note : undefined,
  };
}

function numberQueryParam(url: URL, name: string): number | undefined {
  const value = url.searchParams.get(name);
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new BrokerError("bad_request", `${name} must be a non-negative number`);
  }
  return parsed;
}

function boundedLimitQueryParam(
  url: URL,
  name: string,
  max: number,
  defaultValue?: number,
): number | undefined {
  const parsed = numberQueryParam(url, name);
  if (parsed === undefined) {
    return defaultValue;
  }
  if (!Number.isInteger(parsed)) {
    throw new BrokerError("bad_request", `${name} must be an integer`);
  }
  return Math.min(parsed, max);
}

function booleanQueryParam(url: URL, name: string): boolean | undefined {
  const value = url.searchParams.get(name);
  if (!value) {
    return undefined;
  }
  if (value === "1" || value.toLowerCase() === "true") {
    return true;
  }
  if (value === "0" || value.toLowerCase() === "false") {
    return false;
  }
  throw new BrokerError("bad_request", `${name} must be a boolean`);
}

function cleanupPlanOptionsFromUrl(url: URL): BrokerCleanupPlanOptions {
  return {
    nowMs: numberQueryParam(url, "now_ms"),
    taskRetentionMs: numberQueryParam(url, "task_retention_ms"),
    maxTerminalTasks: numberQueryParam(url, "max_terminal_tasks"),
    auditRetentionMs: numberQueryParam(url, "audit_retention_ms"),
    maxAuditEvents: numberQueryParam(url, "max_audit_events"),
    workerRetentionMs: numberQueryParam(url, "worker_retention_ms"),
    maxInactiveWorkers: numberQueryParam(url, "max_inactive_workers"),
    terminalOutboxRetentionMs: numberQueryParam(url, "terminal_outbox_retention_ms"),
    maxAcknowledgedTerminalOutboxEvents: numberQueryParam(url, "max_acknowledged_terminal_outbox_events"),
    protectedTaskIds: stringListQueryParam(url, "protected_task_id"),
    protectedWorkerIds: stringListQueryParam(url, "protected_worker_id"),
  };
}

function cleanupPlanOptionsFromBody(body: Record<string, unknown> | null | undefined): BrokerCleanupPlanOptions {
  return {
    nowMs: nonNegativeNumberBodyField(body, "nowMs"),
    taskRetentionMs: nonNegativeNumberBodyField(body, "taskRetentionMs"),
    maxTerminalTasks: nonNegativeNumberBodyField(body, "maxTerminalTasks"),
    auditRetentionMs: nonNegativeNumberBodyField(body, "auditRetentionMs"),
    maxAuditEvents: nonNegativeNumberBodyField(body, "maxAuditEvents"),
    workerRetentionMs: nonNegativeNumberBodyField(body, "workerRetentionMs"),
    maxInactiveWorkers: nonNegativeNumberBodyField(body, "maxInactiveWorkers"),
    terminalOutboxRetentionMs: nonNegativeNumberBodyField(body, "terminalOutboxRetentionMs"),
    maxAcknowledgedTerminalOutboxEvents: nonNegativeNumberBodyField(body, "maxAcknowledgedTerminalOutboxEvents"),
    protectedTaskIds: stringListBodyField(body, "protectedTaskIds"),
    protectedWorkerIds: stringListBodyField(body, "protectedWorkerIds"),
  };
}

function stringListQueryParam(url: URL, name: string): string[] | undefined {
  const values = url.searchParams.getAll(name).flatMap((value) => value.split(","));
  const normalized = values.map((value) => value.trim()).filter(Boolean);
  return normalized.length > 0 ? [...new Set(normalized)] : undefined;
}

function nonNegativeNumberBodyField(body: Record<string, unknown> | null | undefined, name: string): number | undefined {
  const value = body?.[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new BrokerError("bad_request", `${name} must be a non-negative number`);
  }
  return value;
}

function stringListBodyField(body: Record<string, unknown> | null | undefined, name: string): string[] | undefined {
  const value = body?.[name];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new BrokerError("bad_request", `${name} must be an array of strings`);
  }
  const normalized = value.map((item) => item.trim()).filter(Boolean);
  return normalized.length > 0 ? [...new Set(normalized)] : undefined;
}

function buildMessageThreads(items: A2AExchangeMessageRecord[]): ThreadedExchangeMessage[] {
  const repliesByParent = new Map<string, A2AExchangeMessageRecord[]>();
  const itemIds = new Set(items.map((item) => item.id));
  const roots: A2AExchangeMessageRecord[] = [];

  for (const item of items) {
    if (!item.parentMessageId || !itemIds.has(item.parentMessageId)) {
      roots.push(item);
      continue;
    }
    const siblings = repliesByParent.get(item.parentMessageId) ?? [];
    siblings.push(item);
    repliesByParent.set(item.parentMessageId, siblings);
  }

  const attachReplies = (
    node: A2AExchangeMessageRecord,
  ): ThreadedExchangeMessage => ({
    ...node,
    replies: (repliesByParent.get(node.id) ?? []).map(attachReplies),
  });

  return roots.map(attachReplies);
}

function buildDashboardAttention(input: {
  dashboard: BrokerDashboard;
  staleReaper: BrokerStaleReaperStatus;
  requestPressure: {
    general: RateLimitPressureSnapshot;
    worker: RateLimitPressureSnapshot;
  };
}): DashboardAttentionSummary {
  const items: DashboardAttentionItem[] = [];

  const staleAssignments = input.dashboard.observability.queuePressure.staleWorkerAssignments;
  if (staleAssignments > 0) {
    items.push({
      code: "stale-worker-assignments",
      severity: "critical",
      count: staleAssignments,
      summary: `${staleAssignments} claimed/running task(s) are assigned to stale workers`,
    });
  }

  const staleWorkers = input.dashboard.observability.workerHealth.staleWorkersWithActiveTasks.length;
  if (staleWorkers > 0) {
    items.push({
      code: "stale-workers-with-active-tasks",
      severity: "critical",
      count: staleWorkers,
      summary: `${staleWorkers} stale worker(s) still have active tasks`,
    });
  }

  const claimedAgeThresholdSec = Math.max(1, input.staleReaper.olderThanSec || 0);
  const oldestClaimed = input.dashboard.observability.queuePressure.oldestClaimed;
  if (oldestClaimed && oldestClaimed.statusAgeSec >= claimedAgeThresholdSec) {
    items.push({
      code: "aged-claimed-task",
      severity: oldestClaimed.statusAgeSec >= claimedAgeThresholdSec * 2 ? "critical" : "warn",
      count: 1,
      summary: `claimed task ${oldestClaimed.id} has been waiting ${oldestClaimed.statusAgeSec}s since claim`,
    });
  }

  const runningAgeThresholdSec = claimedAgeThresholdSec;
  const oldestRunning = input.dashboard.observability.queuePressure.oldestRunning;
  if (oldestRunning && oldestRunning.statusAgeSec >= runningAgeThresholdSec) {
    items.push({
      code: "aged-running-task",
      severity: oldestRunning.statusAgeSec >= runningAgeThresholdSec * 2 ? "critical" : "warn",
      count: 1,
      summary: `running task ${oldestRunning.id} has been active ${oldestRunning.statusAgeSec}s since start`,
    });
  }

  const recentDeadLetters = Math.max(
    input.dashboard.observability.recovery.recentDeadLetters.length,
    input.staleReaper.lastDeadLettered ?? 0,
  );
  if (recentDeadLetters > 0) {
    items.push({
      code: "dead-lettered-tasks",
      severity: "warn",
      count: recentDeadLetters,
      summary: `${recentDeadLetters} task(s) were dead-lettered and need operator review`,
    });
  }

  const recentRequeues = input.staleReaper.lastRequeued ?? 0;
  if (recentRequeues > 0) {
    items.push({
      code: "stale-reaper-requeues",
      severity: "info",
      count: recentRequeues,
      summary: `stale reaper requeued ${recentRequeues} task(s) on the last sweep`,
    });
  }

  const saturatedGeneralKeys = input.requestPressure.general.busiest.filter((entry) => entry.remaining === 0).length;
  const saturatedWorkerKeys = input.requestPressure.worker.busiest.filter((entry) => entry.remaining === 0).length;
  const saturatedKeys = saturatedGeneralKeys + saturatedWorkerKeys;
  if (saturatedKeys > 0) {
    items.push({
      code: "rate-limit-saturation",
      severity: "warn",
      count: saturatedKeys,
      summary: `${saturatedKeys} rate-limit key(s) are currently saturated`,
    });
  }

  return {
    highestSeverity: highestDashboardAttentionSeverity(items),
    items,
  };
}

function highestDashboardAttentionSeverity(items: DashboardAttentionItem[]): DashboardAttentionSummary["highestSeverity"] {
  let highest: DashboardAttentionSummary["highestSeverity"] = "none";
  for (const item of items) {
    if (item.severity === "critical") {
      return "critical";
    }
    if (item.severity === "warn") {
      highest = highest === "none" || highest === "info" ? "warn" : highest;
      continue;
    }
    if (item.severity === "info" && highest === "none") {
      highest = "info";
    }
  }
  return highest;
}


function buildOperatorDashboardSnapshot(input: {
  broker: InMemoryA2ABroker;
  dashboard: BrokerDashboard;
  staleReaper: BrokerStaleReaperStatus;
  staleAfterMs?: number;
  longRunningAfterMs?: number;
}): OperatorDashboardSnapshot {
  const tasks = input.broker.listTasks();
  const byStatus = { ...input.dashboard.queue.byStatus } as Record<TaskStatus, number>;
  const terminalStatuses = new Set<TaskStatus>(["succeeded", "failed", "canceled"]);
  const activeStatuses = new Set<TaskStatus>(["blocked", "queued", "claimed", "running"]);
  const attentionItems: OperatorAttentionItem[] = [];

  for (const task of tasks) {
    const report = input.broker.getTaskDiagnostics(task.id, {
      staleAfterMs: input.staleAfterMs ?? Math.max(1, input.staleReaper.olderThanSec) * 1000,
      longRunningAfterMs: input.longRunningAfterMs,
    });
    const statusAgeSec = Math.floor(report.currentStatusDurationMs / 1000);
    const whoClaimed = task.claimedBy ?? task.assignedWorkerId ?? null;
    const base = {
      taskId: task.id,
      status: task.status,
      intent: task.intent,
      targetNodeId: task.targetNodeId,
      assignedWorkerId: task.assignedWorkerId,
      claimedBy: task.claimedBy,
      requeueCount: task.requeueCount ?? 0,
      statusAgeSec,
      whoClaimed,
      lastHeartbeatAt: task.lastHeartbeatAt,
    };

    if (task.status === "failed" && task.error?.code === "exceeded_requeue_limit") {
      attentionItems.push({
        ...base,
        code: "dead_lettered",
        severity: "critical",
        whyStuck: `task exceeded the stale requeue limit (${task.requeueCount ?? 0}/${input.staleReaper.maxRequeueAttempts})`,
        whatNext: "inspect the failed attempt evidence, fix or replace the worker, then create/reassign follow-up work",
        completedAt: task.completedAt,
        errorCode: task.error.code,
        errorMessage: task.error.message,
      });
      continue;
    }

    if (report.brokerHints.staleWorker && (task.status === "claimed" || task.status === "running")) {
      attentionItems.push({
        ...base,
        code: "stale_worker",
        severity: "critical",
        whyStuck: `${whoClaimed ?? task.targetNodeId} claimed/owns the task but its worker heartbeat is stale`,
        whatNext: "check the worker process; if it is not recovering, requeue stale tasks or reassign to a healthy worker",
      });
      continue;
    }

    if (report.diagnosticStatus === "stale") {
      attentionItems.push({
        ...base,
        code: "stale_task",
        severity: "warn",
        whyStuck: report.interruption?.summary ?? `task has had no fresh heartbeat for ${statusAgeSec}s`,
        whatNext: "ask the claimant for progress; if no evidence arrives, run stale requeue or reassign",
      });
      continue;
    }

    if (report.diagnosticStatus === "long_running") {
      attentionItems.push({
        ...base,
        code: "long_running",
        severity: "warn",
        whyStuck: `running longer than the configured operator threshold (${statusAgeSec}s)`,
        whatNext: "request progress evidence or split/cancel the task if it cannot finish promptly",
      });
      continue;
    }

    if ((task.requeueCount ?? 0) > 0 && (task.status === "queued" || task.status === "claimed" || task.status === "running")) {
      attentionItems.push({
        ...base,
        code: "requeued",
        severity: "info",
        whyStuck: `task has already been requeued ${task.requeueCount} time(s) after stale execution attempts`,
        whatNext: "prefer a healthy worker and watch for another stale attempt before the dead-letter cap",
      });
    }
  }

  attentionItems.sort((left, right) => {
    const severityRank = { critical: 0, warn: 1, info: 2 } as const;
    const severityCmp = severityRank[left.severity] - severityRank[right.severity];
    if (severityCmp !== 0) {
      return severityCmp;
    }
    const ageCmp = right.statusAgeSec - left.statusAgeSec;
    if (ageCmp !== 0) {
      return ageCmp;
    }
    return left.taskId.localeCompare(right.taskId);
  });

  return {
    generatedAt: input.dashboard.generatedAt,
    workers: input.dashboard.workers,
    taskStatusSummary: {
      total: tasks.length,
      active: tasks.filter((task) => activeStatuses.has(task.status)).length,
      terminal: tasks.filter((task) => terminalStatuses.has(task.status)).length,
      byStatus,
    },
    recoverySummary: {
      stale: {
        staleWorkerAssignments: input.dashboard.observability.queuePressure.staleWorkerAssignments,
        staleWorkersWithActiveTasks: input.dashboard.observability.workerHealth.staleWorkersWithActiveTasks,
        oldestClaimed: input.dashboard.observability.queuePressure.oldestClaimed,
        oldestRunning: input.dashboard.observability.queuePressure.oldestRunning,
      },
      retry: {
        totalRequeued: input.dashboard.observability.recovery.totalRequeued,
        maxRequeueAttempts: input.staleReaper.maxRequeueAttempts,
        recentRequeues: input.dashboard.observability.recovery.recentRequeues,
      },
      deadLetter: {
        totalDeadLettered: input.dashboard.observability.recovery.totalDeadLettered,
        recentDeadLetters: input.dashboard.observability.recovery.recentDeadLetters,
      },
    },
    attentionItems,
  };
}

function buildDashboardResponse(input: {
  broker: InMemoryA2ABroker;
  workerOfflineAfterSec: number;
  getStaleReaperStatus: () => BrokerStaleReaperStatus;
  rateLimiter: InMemoryRateLimiter;
  workerRateLimiter: InMemoryRateLimiter;
  version: string;
  build: BrokerBuildInfo;
  recentHistoryLimit?: number;
  oldestPendingLimit?: number;
  pendingActionLimit?: number;
  hotEntityDiagnostics?: BrokerHotEntityDiagnostics;
}): OperatorSummary {
  const dashboard = input.broker.getDashboard({
    offlineAfterMs: input.workerOfflineAfterSec * 1000,
    recentHistoryLimit: input.recentHistoryLimit ?? DEFAULT_DASHBOARD_RECENT_HISTORY_LIMIT,
    oldestPendingLimit: input.oldestPendingLimit ?? DEFAULT_DASHBOARD_OLDEST_PENDING_LIMIT,
    pendingActionLimit: input.pendingActionLimit ?? DEFAULT_DASHBOARD_PENDING_ACTION_LIMIT,
  });
  const staleReaper = input.getStaleReaperStatus();
  const requestPressure = {
    general: input.rateLimiter.snapshot(),
    worker: input.workerRateLimiter.snapshot(),
  };
  return {
    ...dashboard,
    version: input.version,
    build: input.build,
    staleReaper,
    requestPressure,
    attention: buildDashboardAttention({
      dashboard,
      staleReaper,
      requestPressure,
    }),
    operatorSnapshot: buildOperatorDashboardSnapshot({
      broker: input.broker,
      dashboard,
      staleReaper,
    }),
    hotEntityDiagnostics: input.hotEntityDiagnostics,
  };
}

function buildAlertScan(input: {
  broker: InMemoryA2ABroker;
  staleAfterMs?: number;
  longRunningAfterMs?: number;
  staleWarningMs?: number;
  staleCriticalMs?: number;
  longRunningWarningMs?: number;
  longRunningCriticalMs?: number;
  workerHeartbeatMissedAfterMs: number;
  nowMs?: number;
}): AlertScanResult {
  const staleAfterMs = input.staleAfterMs ?? DEFAULT_ALERT_STALE_AFTER_MS;
  const longRunningAfterMs = input.longRunningAfterMs ?? DEFAULT_ALERT_LONG_RUNNING_AFTER_MS;
  const allTasks = input.broker.listTasks();
  const reports = allTasks.map((task) =>
    input.broker.getTaskDiagnostics(task.id, { staleAfterMs, longRunningAfterMs }),
  );

  return projectAlerts(reports, {
    staleWarningMs: input.staleWarningMs,
    staleCriticalMs: input.staleCriticalMs,
    longRunningWarningMs: input.longRunningWarningMs,
    longRunningCriticalMs: input.longRunningCriticalMs,
    workers: input.broker.listWorkers(),
    workerHeartbeatMissedAfterMs: input.workerHeartbeatMissedAfterMs,
    nowMs: input.nowMs,
  });
}

function assertRequesterCanSubscribeToWorkerAssignments(
  identity: RequesterIdentity | null,
  workerId: string,
): void {
  if (!identity?.id) {
    throw new BrokerError("unauthorized", "x-a2a-requester-id is required for this route");
  }
  if (identity.role === "hub" || identity.role === "operator" || identity.id === workerId) {
    return;
  }
  throw new BrokerError(
    "unauthorized",
    "worker assignment subscribe requires the assigned worker requester or a hub/operator role",
  );
}

function formatOperatorSseEventId(seq: number): string {
  return `operator:${seq}`;
}

function parseOperatorSseEventId(raw: string): number | null {
  if (!raw.startsWith("operator:")) {
    return null;
  }
  const seq = Number(raw.slice("operator:".length));
  if (!Number.isFinite(seq) || seq < 0) {
    return null;
  }
  return seq;
}

function resolveOperatorReplayAfterSeq(
  rawLastEventId: string | undefined,
  replayWindow: OperatorReplayWindow,
): number | null {
  if (!rawLastEventId) {
    return null;
  }

  const parsed = parseOperatorSseEventId(rawLastEventId);
  if (parsed === null) {
    return null;
  }
  if (parsed > replayWindow.currentSeq) {
    return null;
  }
  if (replayWindow.oldestBufferedSeq !== null && parsed < replayWindow.oldestBufferedSeq - 1) {
    return null;
  }

  return parsed;
}

function sendError(res: ServerResponse<IncomingMessage>, error: unknown): void {
  if (error instanceof BrokerError) {
    const status = statusCodeFor(error.code);
    sendJson(res, status, {
      error: {
        code: error.code,
        message: error.message,
      },
    });
    return;
  }

  sendJson(res, 500, {
    error: {
      code: "internal_error",
      message: "internal error",
    },
  });
}

function statusCodeFor(code: BrokerError["code"]): number {
  switch (code) {
    case "bad_request":
      return 400;
    case "unauthorized":
      return 401;
    case "policy_denied":
      return 403;
    case "not_found":
      return 404;
    case "invalid_transition":
      return 409;
    case "rate_limited":
      return 429;
    default:
      throw new Error("unhandled broker error code");
  }
}

function writeSseResponseHeaders(res: ServerResponse<IncomingMessage>): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-store, no-transform",
    connection: "keep-alive",
    // Disable proxy buffering (nginx, Caddy, most ingresses) so events flush immediately.
    "x-accel-buffering": "no",
    // CORS for browser-based consumers (dashboards, dev tools).
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "Last-Event-ID, x-a2a-requester-id, x-a2a-edge-secret",
  });
  res.flushHeaders?.();

  // Send retry advisory: wait 3 seconds before reconnecting.
  res.write("retry: 3000\n\n");
}

function writeSseEvent(
  res: ServerResponse<IncomingMessage>,
  event: string,
  data: unknown,
  id?: string,
): void {
  if (res.writableEnded) {
    return;
  }
  if (id) {
    res.write(`id: ${id}\n`);
  }
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function handleWorkerAssignmentEventStream(
  req: IncomingMessage,
  res: ServerResponse<IncomingMessage>,
  params: {
    broker: InMemoryA2ABroker;
    workerId: string;
    heartbeatMs: number;
  },
): void {
  const { broker, workerId, heartbeatMs } = params;
  const stream = broker.getTaskEventStream();

  writeSseResponseHeaders(res);

  const lastEventIdHeader = req.headers["last-event-id"] as string | undefined;
  const replayAfterId = lastEventIdHeader ? Number(lastEventIdHeader) : -1;
  const afterId = Number.isFinite(replayAfterId) && replayAfterId >= 0 ? replayAfterId : -1;

  const queuedTasks = broker.listTasks({ assignedWorkerId: workerId, status: "queued" });
  writeSseEvent(res, "worker-assignment-snapshot", {
    workerId,
    count: queuedTasks.length,
    tasks: queuedTasks.map((task) => ({
      taskId: task.id,
      status: task.status,
      assignedWorkerId: task.assignedWorkerId ?? task.targetNodeId,
      updatedAt: task.updatedAt,
    })),
  });

  for (const event of stream.subscribe({ afterId })) {
    if (isWorkerAssignmentEvent(event, workerId)) {
      writeSseEvent(res, "worker-assignment", buildWorkerAssignmentEvent(event), String(event.id));
    }
  }

  let heartbeatTimer: NodeJS.Timeout | null = null;
  let unsubscribe: (() => void) | null = null;

  const cleanup = (): void => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  };

  unsubscribe = stream.onStatus((event) => {
    if (isWorkerAssignmentEvent(event, workerId)) {
      writeSseEvent(res, "worker-assignment", buildWorkerAssignmentEvent(event), String(event.id));
    }
  });

  req.on("close", () => {
    cleanup();
    if (!res.writableEnded) {
      res.end();
    }
  });
  req.on("error", cleanup);

  if (heartbeatMs > 0) {
    heartbeatTimer = setInterval(() => {
      if (res.writableEnded) {
        cleanup();
        return;
      }
      res.write(`: heartbeat ${new Date().toISOString()}\n\n`);
    }, heartbeatMs);
    heartbeatTimer.unref?.();
  }
}

function isWorkerAssignmentEvent(event: TaskStatusEvent, workerId: string): boolean {
  return (
    event.status === "queued" &&
    event.metadata.assignedWorkerId === workerId &&
    (event.kind === "created" ||
      event.kind === "approved" ||
      event.kind === "reassigned" ||
      event.kind === "requeued")
  );
}

function buildWorkerAssignmentEvent(event: TaskStatusEvent): {
  id: number;
  taskId: string;
  status: TaskStatus;
  reason: TaskStatusEvent["kind"];
  assignedWorkerId: string;
  updatedAt: string;
  metadata: TaskStatusEvent["metadata"];
} {
  return {
    id: event.id,
    taskId: event.taskId,
    status: event.status,
    reason: event.kind,
    assignedWorkerId: event.metadata.assignedWorkerId ?? "",
    updatedAt: event.timestamp,
    metadata: event.metadata,
  };
}

function handleTerminalTaskEventStream(
  req: IncomingMessage,
  res: ServerResponse<IncomingMessage>,
  params: {
    broker: InMemoryA2ABroker;
    heartbeatMs: number;
  },
): void {
  const { broker, heartbeatMs } = params;
  const stream = broker.getTaskEventStream();

  writeSseResponseHeaders(res);

  const lastEventIdHeader = req.headers["last-event-id"] as string | undefined;
  const replayAfterId = lastEventIdHeader ? Number(lastEventIdHeader) : -1;
  const afterId = Number.isFinite(replayAfterId) && replayAfterId >= 0 ? replayAfterId : -1;

  for (const event of stream.subscribeTerminal({ afterId })) {
    writeSseEvent(res, "task-terminal", event, String(event.id));
  }

  let heartbeatTimer: NodeJS.Timeout | null = null;
  let unsubscribe: (() => void) | null = null;

  const cleanup = (): void => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  };

  unsubscribe = stream.onTerminal((event) => {
    writeSseEvent(res, "task-terminal", event, String(event.id));
  });

  req.on("close", () => {
    cleanup();
    if (!res.writableEnded) {
      res.end();
    }
  });

  heartbeatTimer = setInterval(() => {
    if (res.writableEnded) {
      cleanup();
      return;
    }
    res.write(`: heartbeat ${new Date().toISOString()}\n\n`);
  }, heartbeatMs);
}

function handleTaskEventStream(
  req: IncomingMessage,
  res: ServerResponse<IncomingMessage>,
  params: {
    broker: InMemoryA2ABroker;
    task: TaskRecord;
    heartbeatMs: number;
  },
): void {
  const { broker, task, heartbeatMs } = params;

  writeSseResponseHeaders(res);

  // Parse Last-Event-ID for reconnect replay.
  const lastEventIdHeader = req.headers["last-event-id"] as string | undefined;
  let replayAfterSeq = -1;
  if (lastEventIdHeader) {
    const parsed = broker.parseSseEventId(lastEventIdHeader);
    if (parsed && parsed.taskId === task.id) {
      replayAfterSeq = parsed.seq;
    }
  }

  // If reconnecting with a valid Last-Event-ID, replay missed events first.
  if (replayAfterSeq >= 0) {
    const missed = broker.replayTaskEvents(task.id, replayAfterSeq);
    for (const buffered of missed) {
      writeSseEvent(
        res,
        buffered.event,
        {
          task: projectBrokerTask(buffered.data.task),
          reason: buffered.data.reason,
          final: buffered.data.final,
        },
        broker.formatSseEventId(task.id, buffered.seq),
      );
    }
  }

  // Always send a fresh snapshot as the opening event.
  const snapshotSeq = broker.replayTaskEvents(task.id, -1).length;
  // Use seq=0 for the initial snapshot if no buffered events exist.
  writeSseEvent(
    res,
    "task-snapshot",
    {
      task: projectBrokerTask(task),
      reason: "snapshot",
      final: isTerminalSnapshotStatus(task.status),
    },
    broker.formatSseEventId(task.id, snapshotSeq > 0 ? snapshotSeq : 0),
  );

  if (isTerminalSnapshotStatus(task.status)) {
    // Nothing further will fire for an already-terminal task. Close immediately so the
    // caller doesn't hold the connection open waiting for an update that never comes.
    res.end();
    return;
  }

  let heartbeatTimer: NodeJS.Timeout | null = null;
  let unsubscribe: (() => void) | null = null;

  const cleanup = (): void => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  };

  unsubscribe = broker.subscribeToTask(task.id, (update) => {
    writeSseEvent(
      res,
      "task-status-update",
      {
        task: projectBrokerTask(update.task),
        reason: update.reason,
        final: update.final,
      },
      broker.formatSseEventId(task.id, update.seq),
    );
    if (update.final) {
      cleanup();
      if (!res.writableEnded) {
        res.end();
      }
    }
  });

  req.on("close", () => {
    cleanup();
    if (!res.writableEnded) {
      res.end();
    }
  });
  req.on("error", cleanup);

  if (heartbeatMs > 0) {
    heartbeatTimer = setInterval(() => {
      if (res.writableEnded) {
        cleanup();
        return;
      }
      res.write(`: heartbeat ${new Date().toISOString()}\n\n`);
    }, heartbeatMs);
    heartbeatTimer.unref?.();
  }
}

function handleOperatorEventStream(
  req: IncomingMessage,
  res: ServerResponse<IncomingMessage>,
  params: {
    currentSnapshot: () => OperatorSnapshotEvent;
    replayEvents: (afterSeq: number) => BufferedOperatorEvent[];
    subscribe: (listener: (event: BufferedOperatorEvent) => void) => () => void;
    replayWindow: () => OperatorReplayWindow;
    heartbeatMs: number;
  },
): void {
  writeSseResponseHeaders(res);

  const replayAfterSeq = resolveOperatorReplayAfterSeq(
    req.headers["last-event-id"] as string | undefined,
    params.replayWindow(),
  );

  if (replayAfterSeq !== null) {
    const missed = params.replayEvents(replayAfterSeq);
    for (const buffered of missed) {
      writeSseEvent(
        res,
        buffered.event,
        buffered.data,
        formatOperatorSseEventId(buffered.seq),
      );
    }
  }

  const snapshotSeq = params.replayWindow().currentSeq;
  writeSseEvent(
    res,
    "operator-snapshot",
    params.currentSnapshot(),
    formatOperatorSseEventId(snapshotSeq > 0 ? snapshotSeq : 0),
  );

  let heartbeatTimer: NodeJS.Timeout | null = null;
  let unsubscribe: (() => void) | null = null;

  const cleanup = (): void => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  };

  unsubscribe = params.subscribe((event) => {
    writeSseEvent(
      res,
      event.event,
      event.data,
      formatOperatorSseEventId(event.seq),
    );
  });

  req.on("close", () => {
    cleanup();
    if (!res.writableEnded) {
      res.end();
    }
  });
  req.on("error", cleanup);

  if (params.heartbeatMs > 0) {
    heartbeatTimer = setInterval(() => {
      if (res.writableEnded) {
        cleanup();
        return;
      }
      res.write(`: heartbeat ${new Date().toISOString()}\n\n`);
    }, params.heartbeatMs);
    heartbeatTimer.unref?.();
  }
}

function isTerminalSnapshotStatus(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "canceled";
}

/**
 * Truncate a message to `maxLen` characters, appending "..." if truncated.
 * Returns the original message unchanged when it fits within the limit.
 */
function truncateMessage(msg: string, maxLen: number): string {
  if (msg.length <= maxLen) return msg;
  return `${msg.slice(0, Math.max(0, maxLen - 3))}...`;
}

function sendJson(
  res: ServerResponse<IncomingMessage>,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json),
    ...headers,
  });
  res.end(json);
}
