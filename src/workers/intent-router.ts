/**
 * Intent-based task handler router.
 *
 * Allows a worker to register specific handlers per intent instead of
 * a single monolithic handler. Falls back to a default handler for
 * unregistered intents.
 */
import type { TaskRecord, TaskResult, TaskError } from "../core/types.js";
import type { A2ABrokerWorker, WorkerHandlerOutcome } from "../worker.js";
import type { WorkerTaskHandler } from "../worker.js";

export interface IntentHandlerEntry {
  intent: string;
  handler: WorkerTaskHandler;
}

export interface IntentRouterOptions {
  /** Per-intent handlers. First match wins. */
  handlers: IntentHandlerEntry[];
  /** Fallback for unmatched intents. Defaults to noop. */
  defaultHandler?: WorkerTaskHandler;
  /** Called before the matched handler runs. Throw to abort. */
  beforeHandle?: (task: TaskRecord) => void | Promise<void>;
}

export function createIntentRouter(options: IntentRouterOptions): WorkerTaskHandler {
  const handlerMap = new Map<string, WorkerTaskHandler>();
  for (const entry of options.handlers) {
    handlerMap.set(entry.intent, entry.handler);
  }

  const fallback: WorkerTaskHandler =
    options.defaultHandler ??
    (async (task) => ({
      result: {
        summary: `no handler registered for intent=${task.intent}`,
        note: `task ${task.id} was acknowledged but not processed`,
      },
    }));

  return async (task: TaskRecord): Promise<WorkerHandlerOutcome | TaskResult | void> => {
    try {
      await options.beforeHandle?.(task);
    } catch (error) {
      if (error instanceof TaskAssertionError) {
        return error.outcome;
      }
      throw error;
    }

    const handler = handlerMap.get(task.intent) ?? fallback;
    return handler(task);
  };
}

/**
 * Validate that a task has the required fields for proposal-linked intents.
 * Throws WorkerHandlerOutcome with an error if validation fails.
 */
export class TaskAssertionError extends Error {
  readonly outcome: WorkerHandlerOutcome;
  constructor(outcome: WorkerHandlerOutcome) {
    const msg = outcome.error?.message ?? "task assertion failed";
    super(msg);
    this.name = "TaskAssertionError";
    this.outcome = outcome;
  }
}

export function assertProposalTask(task: TaskRecord, expectedIntent?: string): void {
  if (expectedIntent && task.intent !== expectedIntent) {
    throw new TaskAssertionError({
      error: {
        code: "intent_mismatch",
        message: `expected intent=${expectedIntent} but got ${task.intent}`,
      },
    });
  }

  if (!task.proposalId) {
    throw new TaskAssertionError({
      error: {
        code: "missing_proposal_id",
        message: `task ${task.id} has intent=${task.intent} but no proposalId`,
      },
    });
  }
}

/**
 * Validate that a task has workspace information for apply operations.
 */
export function assertWorkspaceTask(task: TaskRecord): void {
  if (!task.workspace?.nodeId || !task.workspace?.workspaceId) {
    throw new TaskAssertionError({
      error: {
        code: "missing_workspace",
        message: `task ${task.id} requires workspace.nodeId and workspace.workspaceId`,
      },
    });
  }
}

/**
 * Validate that task payload contains expected fields.
 */
export function assertPayloadField(
  task: TaskRecord,
  field: string,
): unknown {
  const value = task.payload?.[field];
  if (value === undefined || value === null) {
    throw new TaskAssertionError({
      error: {
        code: "missing_payload_field",
        message: `task ${task.id} payload missing required field: ${field}`,
      },
    });
  }
  return value;
}


/**
 * Middleware that preloads proposal details into task.payload.context
 * when a task references a proposalId. Handlers can then access
 * `task.payload.__proposalDetails` without each one fetching individually.
 *
 * Returns a modified beforeHandle hook to pass to createIntentRouter.
 */
export function withProposalContext(
  worker: { getProposalDetails: (id: string) => Promise<unknown> },
): NonNullable<IntentRouterOptions["beforeHandle"]> {
  return async (task) => {
    if (task.proposalId) {
      try {
        const details = await worker.getProposalDetails(task.proposalId);
        // Mutate payload to inject context — safe because each task is processed once
        (task.payload as Record<string, unknown>).__proposalDetails = details;
      } catch {
        // If fetch fails, the handler itself will handle the missing proposal
      }
    }
  };
}
