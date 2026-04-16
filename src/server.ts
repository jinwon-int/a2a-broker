import { createServer, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from "node:http";

import { createBrokerAgentCard, type AgentCard } from "./a2a/agent-card.js";
import { executeA2AJsonRpc } from "./a2a/json-rpc.js";
import { BrokerError, InMemoryA2ABroker } from "./core/broker.js";
import {
  applyRateLimitHeaders,
  assertEdgeSecret,
  assertRequesterHasRole,
  assertRequesterCanTouchProposalArtifacts,
  assertRequesterMatchesParty,
  classifyRateLimitBucket,
  extractRequesterIdentity,
  InMemoryRateLimiter,
  rateLimitKey,
} from "./core/request-security.js";
import {
  CURRENT_BROKER_STATE_VERSION,
  JsonFileBrokerStateStore,
  type BrokerStateStore,
} from "./core/store.js";
import type {
  A2AExchangeMessageRecord,
  AuditAction,
  ProposalKind,
  ProposalStatus,
  TaskKind,
  TaskStatus,
  WorkerListFilters,
  A2AWorkerEnvironment,
  A2APartyRole,
} from "./core/types.js";

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
}

export interface BrokerServerRuntime {
  server: Server;
  handler: RequestListener<typeof IncomingMessage, typeof ServerResponse>;
  broker: InMemoryA2ABroker;
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
  };
}

export function createBrokerServer(options: BrokerServerOptions = {}): BrokerServerRuntime {
  const host = options.host ?? process.env.HOST ?? "0.0.0.0";
  const port = options.port ?? Number(process.env.PORT ?? 8787);
  const serviceName = options.serviceName ?? process.env.SERVICE_NAME ?? "a2a-broker";
  const publicBaseUrl =
    options.publicBaseUrl ?? process.env.PUBLIC_BASE_URL ?? "http://<masked-host>:8787";
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

  const stateStore =
    options.stateStore ?? new JsonFileBrokerStateStore(stateFile);
  const broker =
    options.broker ?? new InMemoryA2ABroker(stateStore, stateStore.load());
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
      supportsStreaming: false,
      supportsPushNotifications: false,
    });

  const handler: RequestListener<typeof IncomingMessage, typeof ServerResponse> = async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;
    const segments = path.split("/").filter(Boolean);
    const requesterIdentity = extractRequesterIdentity(req);

    try {
      const isPublicDiscoveryRoute = req.method === "GET" && path === "/.well-known/agent-card.json";
      if (path !== "/health" && !isPublicDiscoveryRoute) {
        assertEdgeSecret(req, edgeSecret);

        const bucket = classifyRateLimitBucket(req, url);
        const limiter = bucket === "worker" ? workerRateLimiter : rateLimiter;
        const decision = limiter.check(rateLimitKey(req, requesterIdentity));
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
          requestSecurity: {
            enforceRequesterIdentity,
            edgeSecretRequired: Boolean(edgeSecret),
            rateLimitWindowSec,
            rateLimitMaxRequests,
            workerRateLimitWindowSec,
            workerRateLimitMaxRequests,
          },
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
          requesterIdentity,
          enforceRequesterIdentity,
        });
        return sendJson(res, 200, response);
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
        return sendJson(res, 200, dashboard);
      }

      if (req.method === "GET" && path === "/workers") {
        const filters = workerFiltersFromUrl(url);
        const items = broker.listWorkerViews(workerOfflineAfterSec * 1000, filters);
        return sendJson(res, 200, { items });
      }

      if (req.method === "POST" && path === "/workers/register") {
        const body = await readJson(req);
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
        const body = await readJson(req);
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
        const body = await readJson(req);
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
        const body = await readJson(req);
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
        const body = await readJson(req);
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
        const body = await readJson(req);
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
        const body = await readJson(req);
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
        const body = await readJson(req);
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
        const body = await readJson(req);
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
        const body = await readJson(req);
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
        const body = await readJson(req);
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
        const requeued = broker.requeueStaleTasks(olderThanSec * 1000, {
          workerOfflineAfterMs: workerOfflineAfterSec * 1000,
        });
        return sendJson(res, 200, {
          ok: true,
          olderThanSeconds: olderThanSec,
          workerOfflineAfterSeconds: workerOfflineAfterSec,
          policy: "requeue_only",
          requeued: requeued.length,
          items: requeued.map((task) => ({
            id: task.id,
            status: task.status,
            targetNodeId: task.targetNodeId,
            assignedWorkerId: task.assignedWorkerId,
            proposalId: task.proposalId,
            updatedAt: task.updatedAt,
          })),
        });
      }

      if (req.method === "GET" && segments[0] === "tasks" && segments[1] && segments.length === 2) {
        const task = broker.getTask(segments[1]);
        if (!task) {
          throw new BrokerError("not_found", "task not found");
        }
        return sendJson(res, 200, task);
      }

      if (req.method === "POST" && segments[0] === "tasks" && segments[1] && segments[2] === "claim") {
        const body = await readJson(req);
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
        const body = await readJson(req);
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
        const body = await readJson(req);
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
        const body = await readJson(req);
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
        const body = await readJson(req);
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
        const body = await readJson(req);
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

  return {
    server,
    handler,
    broker,
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
    },
  };
}

export function startBrokerServer(options: BrokerServerOptions = {}): BrokerServerRuntime {
  const runtime = createBrokerServer(options);
  runtime.server.listen(runtime.config.port, runtime.config.host, () => {
    console.log(`${runtime.config.serviceName} listening on ${runtime.config.publicBaseUrl}`);
  });
  return runtime;
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file://").href) {
  startBrokerServer();
}

async function readJson(req: IncomingMessage): Promise<any | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return null;
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw);
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
  }
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
