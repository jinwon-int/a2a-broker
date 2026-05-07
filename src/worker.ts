import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { validateGithubTaskCompletionEvidence } from "./core/github-task-completion.js";
import type {
  A2APartyKind,
  A2APartyRole,
  WorkerView,
  WorkerRegistrationResponse,
  RegisterWorkerRequest,
  SubmitValidationRequest,
  ProposalActorRequest,
  ApplyProposalRequest,
  CreateProposalRequest,
  ChangeProposal,
  ProposalDetails,
  TaskError,
  TaskRecord,
  TaskResult,
  WorkerHeartbeatRequest,
} from "./core/types.js";

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_HANDLER_TIMEOUT_MS = 60_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 5_000;
const DEFAULT_USER_AGENT = "a2a-broker-worker/0.1";

export type FetchLike = typeof fetch;
export type BuiltinWorkerHandlerKind = "noop" | "echo";

export interface WorkerHandlerOutcome {
  result?: TaskResult;
  error?: TaskError;
}

export type WorkerTaskHandler = (task: TaskRecord) => Promise<WorkerHandlerOutcome | TaskResult | void>;

export interface ExternalWorkerHandlerConfig {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface BrokerWorkerConfig {
  brokerUrl: string;
  edgeSecret?: string;
  homeBrokerId?: string;
  homeBrokerLeaseFile?: string;
  worker: RegisterWorkerRequest;
  requesterKind: A2APartyKind;
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
  handlerTimeoutMs: number;
  userAgent: string;
  handler: WorkerTaskHandler;
}

interface TaskListResponse {
  items: TaskRecord[];
}

interface ErrorResponseBody {
  error?: {
    code?: string;
    message?: string;
  };
}

interface BrokerHealthResponse {
  brokerId?: unknown;
}

interface HomeBrokerLease {
  brokerId: string;
  brokerUrl: string;
  workerId: string;
  createdAt: string;
}

export class BrokerApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "BrokerApiError";
  }
}

export class A2ABrokerWorker {
  private readonly brokerUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly config: BrokerWorkerConfig;
  private running = false;
  private stopping = false;
  private stopHeartbeatLoop: (() => void) | null = null;
  private loopAbort: (() => void) | null = null;
  private homeBrokerVerified = false;

  constructor(config: BrokerWorkerConfig, options?: { fetchImpl?: FetchLike }) {
    this.config = config;
    this.fetchImpl = options?.fetchImpl ?? fetch;
    this.brokerUrl = normalizeBrokerUrl(config.brokerUrl);
  }

  get workerId(): string {
    return this.config.worker.nodeId;
  }

  async register(): Promise<WorkerRegistrationResponse> {
    return this.requestJson<WorkerRegistrationResponse>("/workers/register", {
      method: "POST",
      body: this.config.worker,
    });
  }

  async heartbeat(): Promise<WorkerView> {
    const payload: WorkerHeartbeatRequest = {
      displayName: this.config.worker.displayName,
      brokerUrl: this.config.worker.brokerUrl,
      capabilities: this.config.worker.capabilities,
      metadata: this.config.worker.metadata,
    };

    return this.requestJson<WorkerView>(`/workers/${encodeURIComponent(this.workerId)}/heartbeat`, {
      method: "POST",
      body: payload,
    });
  }

  async getWorker(): Promise<WorkerView> {
    return this.requestJson<WorkerView>(`/workers/${encodeURIComponent(this.workerId)}`);
  }

  async pollQueuedTasks(): Promise<TaskRecord[]> {
    const search = new URLSearchParams({
      assignedWorkerId: this.workerId,
      status: "queued",
    });
    const response = await this.requestJson<TaskListResponse>(`/tasks?${search.toString()}`);
    return response.items ?? [];
  }

  async runOnce(): Promise<number> {
    const tasks = await this.pollQueuedTasks();
    let processed = 0;

    for (const task of tasks) {
      const handled = await this.processTask(task);
      if (handled) {
        processed += 1;
      }
    }

    return processed;
  }

  async run(): Promise<void> {
    if (this.running) {
      throw new Error(`worker ${this.workerId} is already running`);
    }

    await this.register();
    await this.heartbeat();

    console.log(`[worker:${this.workerId}] registered with ${this.brokerUrl}`);

    this.running = true;
    this.stopping = false;
    const loopAbortController = new AbortController();
    this.loopAbort = () => loopAbortController.abort();
    this.startHeartbeatTimer();

    try {
      while (this.running) {
        try {
          const processed = await this.runOnce();
          if (processed > 0) {
            console.log(`[worker:${this.workerId}] processed ${processed} task(s)`);
          }
        } catch (error) {
          console.error(`[worker:${this.workerId}] poll loop error`, error);
        }

        await delay(this.config.pollIntervalMs, undefined, {
          signal: loopAbortController.signal,
        }).catch((error: unknown) => {
          if (this.running) {
            throw error;
          }
        });
      }
    } finally {
      this.running = false;
      this.stopHeartbeatTimer();
      this.loopAbort = null;
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.running = false;
    this.stopHeartbeatTimer();
    this.loopAbort?.();
  }

  private async processTask(task: TaskRecord): Promise<boolean> {
    try {
      await this.claimTask(task.id);
    } catch (error) {
      if (isSkippableClaimError(error)) {
        return false;
      }
      throw error;
    }

    try {
      const runningTask = await this.startTask(task.id);
      const outcome = normalizeWorkerHandlerOutcome(await this.config.handler(runningTask));

      if (outcome.error) {
        await this.failTask(task.id, outcome.error);
        console.warn(`[worker:${this.workerId}] task ${task.id} failed: ${outcome.error.message}`);
        return true;
      }

      const completionEvidenceError = validateTaskCompletionEvidence(runningTask, outcome.result);
      if (completionEvidenceError) {
        await this.failTask(task.id, completionEvidenceError);
        console.warn(`[worker:${this.workerId}] task ${task.id} failed: ${completionEvidenceError.message}`);
        return true;
      }

      await this.completeTask(task.id, outcome.result);
      return true;
    } catch (error) {
      const taskError = toTaskError(error);
      try {
        await this.failTask(task.id, taskError);
      } catch (failError) {
        console.error(`[worker:${this.workerId}] failed to mark task ${task.id} as failed`, failError);
        throw error;
      }
      console.warn(`[worker:${this.workerId}] task ${task.id} failed: ${taskError.message}`);
      return true;
    }
  }

  private async claimTask(taskId: string): Promise<TaskRecord> {
    return this.requestJson<TaskRecord>(`/tasks/${encodeURIComponent(taskId)}/claim`, {
      method: "POST",
      body: { workerId: this.workerId },
    });
  }

  private async startTask(taskId: string): Promise<TaskRecord> {
    return this.requestJson<TaskRecord>(`/tasks/${encodeURIComponent(taskId)}/start`, {
      method: "POST",
      body: { workerId: this.workerId },
    });
  }

  private async completeTask(taskId: string, result?: TaskResult): Promise<TaskRecord> {
    return this.requestJson<TaskRecord>(`/tasks/${encodeURIComponent(taskId)}/complete`, {
      method: "POST",
      body: { workerId: this.workerId, result },
    });
  }

  private async failTask(taskId: string, error?: TaskError): Promise<TaskRecord> {
    return this.requestJson<TaskRecord>(`/tasks/${encodeURIComponent(taskId)}/fail`, {
      method: "POST",
      body: { workerId: this.workerId, error },
    });
  }


  // --- Proposal API methods (for use inside task handlers) ---

  async submitValidation(
    proposalId: string,
    request: SubmitValidationRequest,
  ): Promise<unknown> {
    return this.requestJson(`/proposals/${encodeURIComponent(proposalId)}/validate`, {
      method: "POST",
      body: request,
    });
  }

  async approveProposal(
    proposalId: string,
    request: ProposalActorRequest,
  ): Promise<unknown> {
    return this.requestJson(`/proposals/${encodeURIComponent(proposalId)}/approve`, {
      method: "POST",
      body: request,
    });
  }

  async rejectProposal(
    proposalId: string,
    request: ProposalActorRequest,
  ): Promise<unknown> {
    return this.requestJson(`/proposals/${encodeURIComponent(proposalId)}/reject`, {
      method: "POST",
      body: request,
    });
  }

  async applyProposal(
    proposalId: string,
    request: ApplyProposalRequest,
  ): Promise<unknown> {
    return this.requestJson(`/proposals/${encodeURIComponent(proposalId)}/apply`, {
      method: "POST",
      body: request,
    });
  }

  async getProposalDetails(proposalId: string): Promise<ProposalDetails> {
    return this.requestJson<ProposalDetails>(`/proposals/${encodeURIComponent(proposalId)}`);
  }

  async createProposal(request: CreateProposalRequest): Promise<ChangeProposal> {
    return this.requestJson<ChangeProposal>("/proposals", {
      method: "POST",
      body: request,
    });
  }

  /** Expose fetchImpl and brokerUrl for use by external intent handlers. */
  get brokerClient() {
    return {
      fetch: this.fetchImpl,
      brokerUrl: this.brokerUrl,
      workerId: this.workerId,
      role: this.config.worker.role,
      edgeSecret: this.config.edgeSecret,
      userAgent: this.config.userAgent,
      requestJson: <T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> =>
        this.requestJson<T>(path, init),
    };
  }

  private startHeartbeatTimer(): void {
    this.stopHeartbeatTimer();
    const heartbeatTimer = setInterval(() => {
      void this.safeHeartbeat();
    }, this.config.heartbeatIntervalMs);
    this.stopHeartbeatLoop = () => {
      clearInterval(heartbeatTimer);
    };
    if (typeof heartbeatTimer.unref === "function") {
      heartbeatTimer.unref();
    }
  }

  private stopHeartbeatTimer(): void {
    if (!this.stopHeartbeatLoop) {
      return;
    }
    this.stopHeartbeatLoop();
    this.stopHeartbeatLoop = null;
  }

  private async safeHeartbeat(): Promise<void> {
    if (!this.running || this.stopping) {
      return;
    }

    try {
      await this.heartbeat();
    } catch (error) {
      console.error(`[worker:${this.workerId}] heartbeat failed`, error);
    }
  }

  private async ensureHomeBrokerLease(): Promise<void> {
    const expectedBrokerId = this.config.homeBrokerId?.trim();
    if (!expectedBrokerId || this.homeBrokerVerified) {
      return;
    }

    const actualBrokerId = await this.fetchBrokerId();
    if (actualBrokerId !== expectedBrokerId) {
      throw new Error(
        `home broker mismatch: expected A2A_HOME_BROKER_ID=${expectedBrokerId}, got ${actualBrokerId ?? "<missing>"}`,
      );
    }

    if (this.config.homeBrokerLeaseFile) {
      await assertHomeBrokerLease(this.config.homeBrokerLeaseFile, {
        brokerId: expectedBrokerId,
        brokerUrl: this.brokerUrl,
        workerId: this.workerId,
        createdAt: new Date().toISOString(),
      });
    }

    this.homeBrokerVerified = true;
  }

  private async fetchBrokerId(): Promise<string | undefined> {
    const response = await this.fetchImpl(new URL("/health", this.brokerUrl), {
      method: "GET",
      headers: new Headers({
        accept: "application/json",
        "user-agent": this.config.userAgent,
      }),
    });
    const text = await response.text();
    const json = parseJsonText(text) as BrokerHealthResponse | null;

    if (!response.ok) {
      const payload = json as ErrorResponseBody | null;
      throw new BrokerApiError(
        response.status,
        payload?.error?.code ?? `http_${response.status}`,
        (payload?.error?.message ?? response.statusText) || `broker identity request failed with ${response.status}`,
        json,
      );
    }

    return typeof json?.brokerId === "string" && json.brokerId.trim() ? json.brokerId.trim() : undefined;
  }

  private async requestJson<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
    await this.ensureHomeBrokerLease();

    const headers = new Headers({
      accept: "application/json",
      "x-a2a-requester-id": this.workerId,
      "x-a2a-requester-kind": this.config.requesterKind,
      "x-a2a-requester-role": this.config.worker.role,
      "user-agent": this.config.userAgent,
    });

    if (this.config.edgeSecret) {
      headers.set("x-a2a-edge-secret", this.config.edgeSecret);
    }

    let body: string | undefined;
    if (init?.body !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(init.body);
    }

    const response = await this.fetchImpl(new URL(path, this.brokerUrl), {
      method: init?.method ?? "GET",
      headers,
      body,
    });

    const text = await response.text();
    const json = parseJsonText(text);

    if (!response.ok) {
      const payload = json as ErrorResponseBody | null;
      throw new BrokerApiError(
        response.status,
        payload?.error?.code ?? `http_${response.status}`,
        (payload?.error?.message ?? response.statusText) || `request failed with ${response.status}`,
        json,
      );
    }

    return json as T;
  }
}

export function validateTaskCompletionEvidence(task: TaskRecord, result?: TaskResult): TaskError | null {
  return validateGithubTaskCompletionEvidence(task, result);
}

export function createBuiltinWorkerHandler(kind: BuiltinWorkerHandlerKind): WorkerTaskHandler {
  switch (kind) {
    case "noop":
      return async (task) => ({
        result: {
          summary: `noop handled ${task.intent}`,
          note: task.message,
        },
      });
    case "echo":
      return async (task) => ({
        result: {
          summary: task.message ?? `echo handled ${task.intent}`,
          note: `echo handled task ${task.id}`,
          output: {
            taskId: task.id,
            intent: task.intent,
            message: task.message,
            payload: task.payload,
            proposalId: task.proposalId,
            exchangeId: task.exchangeId,
          },
        },
      });
    default:
      throw new Error("unhandled built-in worker handler kind");
  }
}

export function createExternalWorkerHandler(config: ExternalWorkerHandlerConfig): WorkerTaskHandler {
  if (!config.command?.trim()) {
    throw new Error("external handler command is required");
  }

  const args = [...(config.args ?? [])];
  const timeoutMs = Math.max(1, config.timeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS);

  return async (task) => {
    const { stdout, stderr, code, signal, timedOut } = await runExternalHandler({
      command: config.command,
      args,
      cwd: config.cwd,
      env: config.env,
      timeoutMs,
      input: JSON.stringify(task),
    });

    if (timedOut) {
      return {
        error: {
          code: "handler_timeout",
          message: `handler timed out after ${timeoutMs}ms`,
          details: { command: config.command, args },
        },
      } satisfies WorkerHandlerOutcome;
    }

    if (code !== 0) {
      return {
        error: {
          code: "handler_exit_nonzero",
          message: stderr.trim() || `handler exited with code ${code}${signal ? ` (${signal})` : ""}`,
          details: { command: config.command, args, code, signal, stdout: stdout.trim() || undefined },
        },
      } satisfies WorkerHandlerOutcome;
    }

    const trimmed = stdout.trim();
    if (!trimmed) {
      return {
        error: {
          code: "handler_invalid_output",
          message: "handler must write a JSON result to stdout",
          details: { command: config.command, args },
        },
      } satisfies WorkerHandlerOutcome;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      return {
        error: {
          code: "handler_invalid_output",
          message: "handler stdout must be valid JSON",
          details: {
            command: config.command,
            args,
            parseError: error instanceof Error ? error.message : String(error),
            stdout: trimmed,
          },
        },
      } satisfies WorkerHandlerOutcome;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        error: {
          code: "handler_invalid_output",
          message: "handler stdout JSON must be an object",
          details: { command: config.command, args, stdout: trimmed },
        },
      } satisfies WorkerHandlerOutcome;
    }

    const record = parsed as Record<string, unknown>;
    if (record.error) {
      return {
        error: normalizeExternalTaskError(record.error),
      } satisfies WorkerHandlerOutcome;
    }

    if (record.result && typeof record.result === "object" && !Array.isArray(record.result)) {
      return {
        result: record.result as TaskResult,
      } satisfies WorkerHandlerOutcome;
    }

    return {
      result: record as TaskResult,
    } satisfies WorkerHandlerOutcome;
  };
}

export function createWorkerConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BrokerWorkerConfig {
  const brokerUrl = requiredEnv(env, ["BROKER_URL", "A2A_BROKER_URL"]);
  const workerId = requiredEnv(env, ["WORKER_ID", "A2A_WORKER_ID", "NODE_ID"]);
  const role = parsePartyRole(env.WORKER_ROLE ?? env.A2A_WORKER_ROLE ?? "analyst");
  const requesterKind = parsePartyKind(env.WORKER_REQUESTER_KIND ?? env.A2A_WORKER_REQUESTER_KIND ?? "node");
  const handlerTimeoutMs = parsePositiveInt(
    env.WORKER_HANDLER_TIMEOUT_MS ?? env.A2A_WORKER_HANDLER_TIMEOUT_MS,
    DEFAULT_HANDLER_TIMEOUT_MS,
    "WORKER_HANDLER_TIMEOUT_MS",
  );

  const worker: RegisterWorkerRequest = {
    nodeId: workerId,
    role,
    displayName: optionalTrimmed(env.WORKER_DISPLAY_NAME ?? env.A2A_WORKER_DISPLAY_NAME),
    brokerUrl: optionalTrimmed(env.WORKER_PUBLIC_URL ?? env.A2A_WORKER_PUBLIC_URL),
    capabilities: parseWorkerCapabilities(env, role),
    metadata: parseMetadataEnv(env.WORKER_METADATA_JSON ?? env.A2A_WORKER_METADATA_JSON),
  };

  return {
    brokerUrl,
    edgeSecret: optionalTrimmed(
      env.BROKER_EDGE_SECRET ?? env.A2A_BROKER_EDGE_SECRET ?? env.EDGE_SECRET ?? env.A2A_EDGE_SECRET,
    ),
    homeBrokerId: parseBrokerIdEnv(env.A2A_HOME_BROKER_ID ?? env.HOME_BROKER_ID, "A2A_HOME_BROKER_ID"),
    homeBrokerLeaseFile: optionalTrimmed(env.A2A_HOME_BROKER_LEASE_FILE ?? env.HOME_BROKER_LEASE_FILE),
    worker,
    requesterKind,
    pollIntervalMs: parsePositiveInt(
      env.WORKER_POLL_INTERVAL_MS ?? env.A2A_WORKER_POLL_INTERVAL_MS,
      DEFAULT_POLL_INTERVAL_MS,
      "WORKER_POLL_INTERVAL_MS",
    ),
    heartbeatIntervalMs: parsePositiveInt(
      env.WORKER_HEARTBEAT_INTERVAL_MS ?? env.A2A_WORKER_HEARTBEAT_INTERVAL_MS,
      DEFAULT_HEARTBEAT_INTERVAL_MS,
      "WORKER_HEARTBEAT_INTERVAL_MS",
    ),
    handlerTimeoutMs,
    userAgent: optionalTrimmed(env.WORKER_USER_AGENT ?? env.A2A_WORKER_USER_AGENT) ?? DEFAULT_USER_AGENT,
    handler: createWorkerHandlerFromEnv(env, handlerTimeoutMs),
  };
}

export async function startWorkerFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const worker = new A2ABrokerWorker(createWorkerConfigFromEnv(env));
  const shutdown = async (signal: string) => {
    console.log(`[worker:${worker.workerId}] received ${signal}, shutting down`);
    await worker.stop();
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  await worker.run();
}

function createWorkerHandlerFromEnv(
  env: NodeJS.ProcessEnv,
  handlerTimeoutMs: number,
): WorkerTaskHandler {
  const command = optionalTrimmed(env.WORKER_HANDLER_COMMAND ?? env.A2A_WORKER_HANDLER_COMMAND);
  if (command) {
    return createExternalWorkerHandler({
      command,
      args: parseStringArrayEnv(env.WORKER_HANDLER_ARGS_JSON ?? env.A2A_WORKER_HANDLER_ARGS_JSON),
      cwd: optionalTrimmed(env.WORKER_HANDLER_CWD ?? env.A2A_WORKER_HANDLER_CWD),
      env,
      timeoutMs: handlerTimeoutMs,
    });
  }

  const builtin = parseBuiltinWorkerHandlerKind(
    env.WORKER_HANDLER_BUILTIN ?? env.A2A_WORKER_HANDLER_BUILTIN ?? "echo",
  );
  return createBuiltinWorkerHandler(builtin);
}

async function runExternalHandler(options: {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  input: string;
}): Promise<{
  stdout: string;
  stderr: string;
  code: number | null;
  signal: string | null;
  timedOut: boolean;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const hardKillTimer = setTimeout(() => {
      if (settled) {
        return;
      }
      child.kill("SIGKILL");
    }, options.timeoutMs + DEFAULT_SHUTDOWN_GRACE_MS);

    const timeoutTimer = setTimeout(() => {
      if (settled) {
        return;
      }
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(hardKillTimer);
      reject(error);
    });

    child.once("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(hardKillTimer);
      resolve({ stdout, stderr, code, signal, timedOut });
    });

    child.stdin.end(options.input);
  });
}

function normalizeExternalTaskError(value: unknown): TaskError {
  if (typeof value === "string") {
    return { message: value };
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { message: "external handler reported an unknown error" };
  }

  const record = value as Record<string, unknown>;
  return {
    code: typeof record.code === "string" ? record.code : undefined,
    message: typeof record.message === "string" ? record.message : "external handler failed",
    details:
      record.details && typeof record.details === "object" && !Array.isArray(record.details)
        ? (record.details as Record<string, unknown>)
        : undefined,
  };
}

function normalizeWorkerHandlerOutcome(value: WorkerHandlerOutcome | TaskResult | void): WorkerHandlerOutcome {
  if (!value) {
    return { result: {} };
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("worker handler must return an object");
  }

  if (isWorkerHandlerOutcome(value)) {
    return value;
  }

  return { result: value };
}

function isWorkerHandlerOutcome(value: TaskResult | WorkerHandlerOutcome): value is WorkerHandlerOutcome {
  return "result" in value || "error" in value;
}

function isSkippableClaimError(error: unknown): boolean {
  return error instanceof BrokerApiError && [401, 403, 404, 409].includes(error.status);
}

function parseJsonText(text: string): unknown {
  if (!text.trim()) {
    return null;
  }
  return JSON.parse(text);
}

function toTaskError(error: unknown): TaskError {
  if (error instanceof BrokerApiError) {
    return {
      code: error.code,
      message: error.message,
      details: { status: error.status },
    };
  }

  if (error instanceof Error) {
    return {
      message: error.message,
      details: { name: error.name },
    };
  }

  return { message: typeof error === "string" ? error : "task failed" };
}

async function assertHomeBrokerLease(path: string, expected: HomeBrokerLease): Promise<void> {
  try {
    const text = await readFile(path, "utf8");
    const parsed = JSON.parse(text) as Partial<HomeBrokerLease>;
    if (parsed.brokerId !== expected.brokerId) {
      throw new Error(
        `home broker lease mismatch at ${path}: expected ${expected.brokerId}, found ${parsed.brokerId ?? "<missing>"}`,
      );
    }
    return;
  } catch (error: unknown) {
    if (!isFileNotFoundError(error)) {
      throw error;
    }
  }

  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, `${JSON.stringify(expected, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error: unknown) {
    if (!isFileAlreadyExistsError(error)) {
      throw error;
    }
    await assertHomeBrokerLease(path, expected);
  }
}

function isFileNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isFileAlreadyExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function normalizeBrokerUrl(value: string): string {
  const trimmed = value.trim();
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

function requiredEnv(env: NodeJS.ProcessEnv, names: string[]): string {
  for (const name of names) {
    const value = optionalTrimmed(env[name]);
    if (value) {
      return value;
    }
  }
  throw new Error(`missing required env var: ${names.join(" or ")}`);
}

function optionalTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseBrokerIdEnv(value: string | undefined, label: string): string | undefined {
  const normalized = optionalTrimmed(value);
  if (!normalized) {
    return undefined;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized)) {
    throw new Error(`${label} must use only letters, numbers, dots, underscores, colons, or hyphens`);
  }
  return normalized;
}

function parsePositiveInt(
  value: string | undefined,
  fallback: number,
  label: string,
): number {
  if (!optionalTrimmed(value)) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
  return Math.trunc(parsed);
}

function parseBooleanEnv(value: string | undefined, fallback = false): boolean {
  const normalized = optionalTrimmed(value)?.toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  throw new Error(`invalid boolean value: ${value}`);
}

function parseStringArrayEnv(value: string | undefined): string[] {
  const trimmed = optionalTrimmed(value);
  if (!trimmed) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(
      `expected JSON string array but received ${value}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error("expected JSON string array");
  }

  return parsed.map((item) => item.trim()).filter(Boolean);
}

function parseCsvEnv(value: string | undefined): string[] {
  const trimmed = optionalTrimmed(value);
  if (!trimmed) {
    return [];
  }
  return [...new Set(trimmed.split(",").map((item) => item.trim()).filter(Boolean))];
}

function parseMetadataEnv(value: string | undefined): Record<string, string> | undefined {
  const trimmed = optionalTrimmed(value);
  if (!trimmed) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(
      `expected metadata JSON object but received ${value}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("WORKER_METADATA_JSON must be a JSON object");
  }

  const entries = Object.entries(parsed as Record<string, unknown>).map(([key, item]) => [key, String(item)]);
  return Object.fromEntries(entries);
}

function parsePartyRole(value: string): A2APartyRole {
  if (
    value === "hub" ||
    value === "live-trader" ||
    value === "researcher" ||
    value === "analyst" ||
    value === "operator"
  ) {
    return value;
  }
  throw new Error(`invalid worker role: ${value}`);
}

function parsePartyKind(value: string): A2APartyKind {
  if (value === "session" || value === "node" || value === "user" || value === "service") {
    return value;
  }
  throw new Error(`invalid requester kind: ${value}`);
}

function parseBuiltinWorkerHandlerKind(value: string): BuiltinWorkerHandlerKind {
  if (value === "noop" || value === "echo") {
    return value;
  }
  throw new Error(`invalid built-in worker handler: ${value}`);
}

function parseWorkerCapabilities(
  env: NodeJS.ProcessEnv,
  role: A2APartyRole,
): RegisterWorkerRequest["capabilities"] {
  const capabilitiesJson = optionalTrimmed(env.WORKER_CAPABILITIES_JSON ?? env.A2A_WORKER_CAPABILITIES_JSON);
  if (capabilitiesJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(capabilitiesJson);
    } catch (error) {
      throw new Error(
        `WORKER_CAPABILITIES_JSON must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("WORKER_CAPABILITIES_JSON must be a JSON object");
    }

    const record = parsed as Record<string, unknown>;
    return {
      canAnalyze: Boolean(record.canAnalyze),
      canBackfill: Boolean(record.canBackfill),
      canPatchWorkspace: Boolean(record.canPatchWorkspace),
      canPromoteLive: Boolean(record.canPromoteLive),
      workspaceIds: Array.isArray(record.workspaceIds)
        ? record.workspaceIds.map((item) => String(item)).filter(Boolean)
        : [],
      environments: Array.isArray(record.environments)
        ? record.environments
            .map((item) => String(item))
            .filter(isWorkerEnvironment)
        : [],
    };
  }

  return {
    canAnalyze: parseBooleanEnv(env.WORKER_CAN_ANALYZE ?? env.A2A_WORKER_CAN_ANALYZE, role === "analyst" || role === "researcher"),
    canBackfill: parseBooleanEnv(env.WORKER_CAN_BACKFILL ?? env.A2A_WORKER_CAN_BACKFILL, false),
    canPatchWorkspace: parseBooleanEnv(env.WORKER_CAN_PATCH_WORKSPACE ?? env.A2A_WORKER_CAN_PATCH_WORKSPACE, false),
    canPromoteLive: parseBooleanEnv(env.WORKER_CAN_PROMOTE_LIVE ?? env.A2A_WORKER_CAN_PROMOTE_LIVE, false),
    workspaceIds: parseCsvEnv(env.WORKER_WORKSPACE_IDS ?? env.A2A_WORKER_WORKSPACE_IDS),
    environments: parseCsvEnv(env.WORKER_ENVIRONMENTS ?? env.A2A_WORKER_ENVIRONMENTS).filter(isWorkerEnvironment),
  };
}

function isWorkerEnvironment(value: string): value is RegisterWorkerRequest["capabilities"]["environments"][number] {
  return value === "research" || value === "staging" || value === "live";
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file://").href) {
  startWorkerFromEnv().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
