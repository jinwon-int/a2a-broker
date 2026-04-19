import { randomUUID } from "node:crypto";

import type { CreateTaskRequest, TaskRecord, TaskResult, TaskError } from "./types.js";

// ---------------------------------------------------------------------------
// State enum
// ---------------------------------------------------------------------------

export type DelegatedRunState =
  | "waiting"
  | "running"
  | "completed"
  | "canceled"
  | "timed_out"
  | "failed";

// ---------------------------------------------------------------------------
// Core data types
// ---------------------------------------------------------------------------

export interface DelegatedRun {
  id: string;
  taskId: string;
  state: DelegatedRunState;
  result?: TaskResult;
  error?: TaskError;
  createdAt: string;
  completedAt?: string;
}

export interface DelegatedRunOptions {
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Handle returned to callers
// ---------------------------------------------------------------------------

export interface DelegatedRunHandle {
  readonly id: string;
  readonly taskId: string;
  /** Resolves when the run reaches a terminal state. */
  wait(): Promise<DelegatedRun>;
  /** Request cancellation. No-op if already terminal. */
  cancel(): void;
  /** Snapshot of the current run state. */
  getState(): DelegatedRunState;
  /** Full snapshot of the current run record. */
  getRun(): DelegatedRun;
}

// ---------------------------------------------------------------------------
// Bridge interface — abstracts broker so plugin-a2a doesn't import broker
// ---------------------------------------------------------------------------

/**
 * Minimal surface that the delegated runtime needs from the broker.
 * Implementations may call InMemoryA2ABroker directly or go through the
 * HTTP API — the runtime does not care.
 */
export interface BrokerTaskBridge {
  /** Create a task in the broker and return the created record. */
  createTask(request: CreateTaskRequest): TaskRecord | Promise<TaskRecord>;

  /**
   * Subscribe to task lifecycle updates. Must invoke `listener` for every
   * state change. Returns an unsubscribe function.
   *
   * The listener receives an object with at minimum:
   *  - task: current TaskRecord snapshot
   *  - final: true when the task has reached a terminal status
   */
  subscribeToTask(
    taskId: string,
    listener: (update: { task: TaskRecord; final: boolean }) => void,
  ): () => void;

  /** Cancel a task in the broker. */
  cancelTask(
    taskId: string,
    request: { actor: { id: string; kind: string; role: string }; reason?: string },
  ): TaskRecord | Promise<TaskRecord>;
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export class DelegatedRunRuntime {
  private readonly runs = new Map<string, ManagedRun>();

  constructor(private readonly bridge: BrokerTaskBridge) {}

  /**
   * Start a delegated run: create a broker task, subscribe to its updates,
   * and return a handle the caller can await / cancel.
   */
  async start(
    taskRequest: CreateTaskRequest,
    options: DelegatedRunOptions = {},
  ): Promise<DelegatedRunHandle> {
    const task = await this.bridge.createTask(taskRequest);
    const run = new ManagedRun(task, this.bridge, options);
    this.runs.set(run.id, run);
    return run.handle();
  }

  /** Get a run by id (mainly for diagnostics). */
  getRun(id: string): DelegatedRun | undefined {
    return this.runs.get(id)?.snapshot();
  }

  /** Number of active (non-terminal) runs. */
  get activeCount(): number {
    let count = 0;
    for (const run of this.runs.values()) {
      if (!isTerminal(run.snapshot().state)) count++;
    }
    return count;
  }
}

// ---------------------------------------------------------------------------
// Internal managed run
// ---------------------------------------------------------------------------

function isTerminal(state: DelegatedRunState): boolean {
  return (
    state === "completed" ||
    state === "canceled" ||
    state === "timed_out" ||
    state === "failed"
  );
}

class ManagedRun {
  readonly id: string;
  private state: DelegatedRunState = "waiting";
  private result?: TaskResult;
  private error?: TaskError;
  private readonly createdAt: string;
  private completedAt?: string;
  private readonly taskId: string;

  private resolveFn!: (run: DelegatedRun) => void;
  private readonly promise: Promise<DelegatedRun>;
  private unsubscribe?: () => void;
  private timeoutTimer?: ReturnType<typeof setTimeout>;
  private abortHandler?: () => void;

  constructor(
    task: TaskRecord,
    private readonly bridge: BrokerTaskBridge,
    options: DelegatedRunOptions,
  ) {
    this.id = randomUUID();
    this.taskId = task.id;
    this.createdAt = new Date().toISOString();

    // Build the settlement promise
    this.promise = new Promise<DelegatedRun>((resolve) => {
      this.resolveFn = resolve;
    });

    // Subscribe to broker task updates
    this.unsubscribe = this.bridge.subscribeToTask(task.id, (update) => {
      this.onTaskUpdate(update);
    });

    // Timeout
    if (options.timeoutMs != null && options.timeoutMs > 0) {
      this.timeoutTimer = setTimeout(() => {
        this.settle("timed_out", undefined, { code: "timeout", message: "Delegated run timed out" });
      }, options.timeoutMs);
    }

    // AbortSignal
    if (options.abortSignal) {
      if (options.abortSignal.aborted) {
        // Already aborted before we started
        this.settle("canceled", undefined, { code: "aborted", message: "Aborted before start" });
      } else {
        this.abortHandler = () => {
          this.settle("canceled", undefined, { code: "aborted", message: "Aborted via signal" });
        };
        options.abortSignal.addEventListener("abort", this.abortHandler, { once: true });
      }
    }
  }

  snapshot(): DelegatedRun {
    return {
      id: this.id,
      taskId: this.taskId,
      state: this.state,
      result: this.result,
      error: this.error,
      createdAt: this.createdAt,
      completedAt: this.completedAt,
    };
  }

  handle(): DelegatedRunHandle {
    return {
      id: this.id,
      taskId: this.taskId,
      wait: () => this.promise,
      cancel: () => this.requestCancel(),
      getState: () => this.state,
      getRun: () => this.snapshot(),
    };
  }

  private onTaskUpdate(update: { task: TaskRecord; final: boolean }): void {
    if (isTerminal(this.state)) return;

    const { task } = update;

    // Map broker task status to delegated run state
    if (task.status === "claimed" || task.status === "running") {
      this.state = "running";
    } else if (task.status === "succeeded") {
      this.settle("completed", task.result, undefined);
    } else if (task.status === "failed") {
      this.settle("failed", undefined, task.error ?? { message: "Task failed" });
    } else if (task.status === "canceled") {
      this.settle("canceled", undefined, task.error ?? { code: "canceled", message: "Task canceled" });
    }
    // "queued" maps to "waiting" which is already the initial state
  }

  private settle(
    finalState: DelegatedRunState,
    result: TaskResult | undefined,
    error: TaskError | undefined,
  ): void {
    if (isTerminal(this.state)) return;

    this.state = finalState;
    this.result = result;
    this.error = error;
    this.completedAt = new Date().toISOString();

    this.cleanup();
    this.resolveFn(this.snapshot());
  }

  private requestCancel(): void {
    if (isTerminal(this.state)) return;

    // Fire-and-forget cancel through bridge — the subscription will
    // pick up the resulting "canceled" update and settle the run.
    // If the bridge cancel fails we still settle locally.
    try {
      const maybePromise = this.bridge.cancelTask(this.taskId, {
        actor: { id: "delegated-runtime", kind: "service", role: "operator" },
        reason: "Canceled via DelegatedRunHandle",
      });
      if (maybePromise && typeof (maybePromise as Promise<unknown>).catch === "function") {
        (maybePromise as Promise<unknown>).catch(() => {
          this.settle("canceled", undefined, { code: "canceled", message: "Canceled locally (bridge cancel failed)" });
        });
      }
    } catch {
      this.settle("canceled", undefined, { code: "canceled", message: "Canceled locally (bridge cancel failed)" });
    }
  }

  private cleanup(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
    if (this.timeoutTimer != null) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = undefined;
    }
    // Note: AbortSignal listener is { once: true } so no explicit removal needed
  }
}
