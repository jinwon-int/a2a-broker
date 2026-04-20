import { createServer, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from "node:http";

import { createBrokerAgentCard, type AgentCard } from "./a2a/agent-card.js";
import { executeA2AJsonRpc } from "./a2a/json-rpc.js";
import { projectBrokerTask } from "./a2a/task-projection.js";
import {
  BrokerError,
  DEFAULT_BROKER_RETENTION_POLICY,
  DEFAULT_MAX_REQUEUE_ATTEMPTS,
  InMemoryA2ABroker,
  type BrokerRetentionPolicy,
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
  type RequesterIdentity,
} from "./core/request-security.js";
import {
  CURRENT_BROKER_STATE_VERSION,
  DEFAULT_BROKER_STATE_MAX_BYTES,
  JsonFileBrokerStateStore,
  type BrokerStateStore,
} from "./core/store.js";
import type {
  A2AExchangeMessageRecord,
  A2AExchangeMessageRequest,
  A2AExchangeRequest,
  AuditAction,
  ApplyProposalRequest,
  AttachArtifactRequest,
  CreateProposalRequest,
  CreateTaskRequest,
  ProposalActorRequest,
  ProposalKind,
  ProposalStatus,
  RegisterWorkerRequest,
  SubmitValidationRequest,
  TaskCancelRequest,
  TaskClaimRequest,
  TaskCompleteRequest,
  TaskFailRequest,
  TaskKind,
  TaskReassignRequest,
  TaskRecord,
  TaskStatus,
  WorkerHeartbeatRequest,
  WorkerListFilters,
  A2AWorkerEnvironment,
  A2APartyRole,
} from "./core/types.js";
import {
  projectTradingDialecticReadModel,
  TradingDialecticReadModelError,
} from "./trading-dialectic/read-model.js";
import { projectAlerts } from "./core/alert-projection.js";

interface ThreadedExchangeMessage extends A2AExchangeMessageRecord {
  replies: ThreadedExchangeMessage[];
}

export interface BrokerServerOptions {
  host?: string;
  port?: number;
  serviceName?: string;
  publicBaseUrl?: string;
  stateFile?: string;
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
  /**
   * SSE heartbeat interval for `/a2a/tasks/:id/events`. Comments (`: heartbeat ...`) keep
   * intermediaries from timing out idle subscriptions. `0` disables heartbeats. Env:
   * `TASK_SUBSCRIBE_HEARTBEAT_SEC`.
   */
  taskSubscribeHeartbeatSec?: number;
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
  config: {
    host: string;
    port: number;
    serviceName: string;
    publicBaseUrl: string;
    stateFile: string;
    workerOfflineAfterSec: number;
    rateLimitWindowSec: number;
    rateLimitMaxRequests: number;
    workerRateLimitWindowSec: number;
    workerRateLimitMaxRequests: number;
    enforceRequesterIdentity: boolean;
    edgeSecret?: string;
    retentionPolicy: BrokerRetentionPolicy;
    maxSnapshotBytes: number;
    trustedProxy: boolean;
    staleReaperEnabled: boolean;
    staleReaperIntervalSec: number;
    staleReaperOlderThanSec: number;
    maxRequeueAttempts: number;
    taskSubscribeHeartbeatSec: number;
  };
}

export function createBrokerServer(options: BrokerServerOptions = {}): BrokerServerRuntime {
  const host = options.host ?? process.env.HOST ?? "0.0.0.0";
  const port = options.port ?? Number(process.env.PORT ?? 8787);
  const serviceName = options.serviceName ?? process.env.SERVICE_NAME ?? "a2a-broker";
  const publicBaseUrl = resolvePublicBaseUrl(options.publicBaseUrl ?? process.env.PUBLIC_BASE_URL);
  const stateFile = options.stateFile ?? process.env.STATE_FILE ?? "/var/lib/a2a-broker/state.json";
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
  const maxSnapshotBytes = Math.max(
    1,
    options.maxSnapshotBytes ?? Number(process.env.STATE_FILE_MAX_BYTES ?? DEFAULT_BROKER_STATE_MAX_BYTES),
  );
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

  const stateStore =
    options.stateStore ?? new JsonFileBrokerStateStore(stateFile, { maxBytes: maxSnapshotBytes });
  const broker =
    options.broker ??
    new InMemoryA2ABroker(stateStore, stateStore.load(), {
      retention: retentionPolicy,
      maxRequeueAttempts,
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

  const runStaleReaperSweep = (): number => {
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
      return requeued.length;
    } catch (error) {
      staleReaperLastRunAt = new Date().toISOString();
      staleReaperLastRequeued = 0;
      staleReaperLastDeadLettered = 0;
      staleReaperLastError = error instanceof Error ? error.message : String(error);
      staleReaperRunCount += 1;
      // Keep the loop alive: transient persistence errors shouldn't kill the timer.
      console.error(`[a2a-broker] stale reaper sweep failed: ${staleReaperLastError}`);
      return 0;
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

  if (staleReaperEnabled) {
    staleReaperTimer = setInterval(runStaleReaperSweep, staleReaperIntervalSec * 1000);
    // Reaper should never block process exit; tests and scripts expect clean shutdown.
    staleReaperTimer.unref?.();
  }

  const handler: RequestListener<typeof IncomingMessage, typeof ServerResponse> = async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;
    const segments = path.split("/").filter(Boolean);
    let requesterIdentity: RequesterIdentity | null = null;

    try {
      requesterIdentity = extractRequesterIdentity(req);
      const isPublicDiscoveryRoute = req.method === "GET" && path === "/.well-known/agent-card.json";
      if (path !== "/health" && !isPublicDiscoveryRoute) {
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

      if (req.method === "GET" && path === "/health") {
        return sendJson(res, 200, {
          ok: true,
          service: serviceName,
          publicBaseUrl,
          uptimeSec: Math.round(process.uptime()),
          persistence: {
            kind: "json-file",
            stateFile,
            stateVersion: CURRENT_BROKER_STATE_VERSION,
          },
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
          requestPressure: {
            general: rateLimiter.snapshot(),
            worker: workerRateLimiter.snapshot(),
          },
          retentionPolicy,
          maxSnapshotBytes,
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
        });
        return sendJson(res, 200, response);
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

      if (req.method === "GET" && path === "/dashboard") {
        const recentLimit = numberQueryParam(url, "recent_history_limit") ?? 10;
        const oldestPendingLimit = numberQueryParam(url, "oldest_pending_limit") ?? 5;
        const pendingActionLimit = numberQueryParam(url, "pending_action_limit") ?? 5;
        const dashboard = broker.getDashboard({
          offlineAfterMs: workerOfflineAfterSec * 1000,
          recentHistoryLimit: recentLimit,
          oldestPendingLimit,
          pendingActionLimit,
        });
        return sendJson(res, 200, {
          ...dashboard,
          requestPressure: {
            general: rateLimiter.snapshot(),
            worker: workerRateLimiter.snapshot(),
          },
        });
      }

      // GET /alerts — monitoring-friendly alert projection
      if (req.method === "GET" && path === "/alerts") {
        const staleAfterMs = numberQueryParam(url, "stale_after_ms") ?? 120_000;
        const longRunningAfterMs = numberQueryParam(url, "long_running_after_ms") ?? 3_600_000;
        const allTasks = broker.listTasks();
        const reports = allTasks.map((task) =>
          broker.getTaskDiagnostics(task.id, { staleAfterMs, longRunningAfterMs }),
        );
        const result = projectAlerts(reports, {
          staleWarningMs: numberQueryParam(url, "stale_warning_ms") ?? undefined,
          staleCriticalMs: numberQueryParam(url, "stale_critical_ms") ?? undefined,
          longRunningWarningMs: numberQueryParam(url, "long_running_warning_ms") ?? undefined,
          longRunningCriticalMs: numberQueryParam(url, "long_running_critical_ms") ?? undefined,
        });
        return sendJson(res, 200, result);
      }

      if (req.method === "GET" && path === "/workers") {
        const filters = workerFiltersFromUrl(url);
        const items = broker.listWorkerViews(workerOfflineAfterSec * 1000, filters);
        return sendJson(res, 200, { items });
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
        return sendJson(res, 201, { ...worker, status: "online" });
      }

      if (req.method === "GET" && segments[0] === "workers" && segments[1] && segments.length === 2) {
        const worker = broker.getWorkerView(segments[1], workerOfflineAfterSec * 1000);
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
        return sendJson(res, 200, { items: broker.listExchanges() });
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
        const items = broker.listExchangeMessages(segments[1], {
          parentMessageId: optionalString(url.searchParams.get("parentMessageId")),
          includeDescendants: booleanQueryParam(url, "includeDescendants") ?? false,
        });
        return sendJson(res, 200, {
          exchangeId: segments[1],
          parentMessageId: optionalString(url.searchParams.get("parentMessageId")),
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
        const exchange = broker.getExchange(segments[1]);
        if (!exchange) {
          throw new BrokerError("not_found", "exchange not found");
        }
        return sendJson(res, 200, exchange);
      }

      if (req.method === "GET" && path === "/proposals") {
        const filters = proposalFiltersFromUrl(url);
        const items = broker.listProposals(filters).map((proposal) => ({
          id: proposal.id,
          sourceNodeId: proposal.sourceNodeId,
          targetNodeId: proposal.targetNodeId,
          kind: proposal.kind,
          summary: proposal.summary,
          status: proposal.status,
          updatedAt: proposal.updatedAt,
        }));
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
        const details = broker.getProposalDetails(segments[1]);
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
        const filters = taskFiltersFromUrl(url);
        return sendJson(res, 200, { items: broker.listTasks(filters) });
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
      if (req.method === "GET" && path === "tasks/diagnostics") {
        const staleAfterMs = numberQueryParam(url, "stale_after_ms") ?? 120_000;
        const longRunningAfterMs = numberQueryParam(url, "long_running_after_ms") ?? 3_600_000;
        const allTasks = broker.listTasks();
        const reports = allTasks.map((task) =>
          broker.getTaskDiagnostics(task.id, { staleAfterMs, longRunningAfterMs }),
        );
        return sendJson(res, 200, { items: reports, generatedAt: new Date().toISOString() });
      }

      if (req.method === "GET" && segments[0] === "tasks" && segments[1] && segments.length === 2) {
        const task = broker.getTask(segments[1]);
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
        const report = broker.getTaskDiagnostics(segments[1], {
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
        return sendJson(res, 200, { items: broker.listAuditEvents(filters) });
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
  server.on("close", stopStaleReaper);

  return {
    server,
    handler,
    broker,
    runStaleReaperSweep,
    stopStaleReaper,
    getStaleReaperStatus,
    config: {
      host,
      port,
      serviceName,
      publicBaseUrl,
      stateFile,
      workerOfflineAfterSec,
      rateLimitWindowSec,
      rateLimitMaxRequests,
      workerRateLimitWindowSec,
      workerRateLimitMaxRequests,
      enforceRequesterIdentity,
      edgeSecret,
      retentionPolicy,
      maxSnapshotBytes,
      trustedProxy,
      staleReaperEnabled,
      staleReaperIntervalSec,
      staleReaperOlderThanSec,
      maxRequeueAttempts,
      taskSubscribeHeartbeatSec,
    },
  };
}

function resolveBrokerRetentionPolicy(
  overrides?: Partial<BrokerRetentionPolicy>,
): BrokerRetentionPolicy {
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
    maxAuditEvents: resolvePolicyNumber(
      overrides?.maxAuditEvents,
      process.env.BROKER_MAX_AUDIT_EVENTS,
      DEFAULT_BROKER_RETENTION_POLICY.maxAuditEvents,
    ),
  };
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

function taskFiltersFromUrl(url: URL): {
  exchangeId?: string;
  status?: TaskStatus;
  targetNodeId?: string;
  proposalId?: string;
  intent?: TaskKind;
  claimedBy?: string;
  assignedWorkerId?: string;
} {
  return {
    exchangeId: optionalString(url.searchParams.get("exchangeId")),
    status: optionalEnum(url.searchParams.get("status"), [
      "queued",
      "claimed",
      "running",
      "succeeded",
      "failed",
      "canceled",
    ]),
    targetNodeId: optionalString(url.searchParams.get("targetNodeId")),
    proposalId: optionalString(url.searchParams.get("proposalId")),
    intent: optionalEnum(url.searchParams.get("intent"), [
      "chat",
      "analyze",
      "backfill",
      "propose_patch",
      "propose_params",
      "validate_change",
      "apply_local_change",
      "promote_to_live",
      "rollback_live",
    ]),
    claimedBy: optionalString(url.searchParams.get("claimedBy")),
    assignedWorkerId: optionalString(url.searchParams.get("assignedWorkerId")),
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

function optionalString(value: string | null): string | undefined {
  return value && value.trim() ? value.trim() : undefined;
}

function optionalEnum<T extends string>(value: string | null, allowed: readonly T[]): T | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim() as T;
  return allowed.includes(normalized) ? normalized : undefined;
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

  const writeEvent = (event: string, data: unknown, id?: string): void => {
    if (res.writableEnded) {
      return;
    }
    if (id) {
      res.write(`id: ${id}\n`);
    }
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

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
      writeEvent(
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
  writeEvent(
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
    writeEvent(
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

function isTerminalSnapshotStatus(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "canceled";
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
