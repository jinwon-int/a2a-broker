/**
 * Session Isolation Invariant for A2A Full-Handler Workers
 *
 * ## Contract
 *
 * Every A2A full-handler worker invocation MUST use a task-scoped ephemeral
 * session id derived from the node and task, **never** a shared/long-lived
 * session (e.g. `main`, the Telegram channel session, or a static `a2a-worker`).
 *
 * ## Rationale
 *
 * Reusing a shared OpenClaw session for unrelated A2A tasks causes:
 * - **History leakage:** task B sees task A's conversation context, leading to
 *   incorrect inferences and phantom diagnostics.
 * - **Stale retry loops:** a retried task inherits the previous attempt's
 *   session state, re-triggering the same failure path.
 *
 * ## Session ID Format
 *
 * ```
 * a2a-<nodeId>-<taskId>
 * ```
 *
 * - `nodeId`: the worker node identifier (e.g. `dungae`, `sogyo`, `bangtong`)
 * - `taskId`: the broker-assigned task UUID
 *
 * This is deterministic, collision-resistant, and statelessly derivable from
 * the task record alone — no side-channel state needed.
 *
 * ## Retry / Requeue Semantics
 *
 * Each task attempt reuses the **same** session id. This is intentional:
 * the session is scoped to the task, not the attempt. A requeued task that
 * picks up where the previous attempt left off benefits from preserved
 * context within its own scope. Unrelated tasks never share this scope.
 *
 * ## Enforcement
 *
 * - `deriveTaskSessionId` produces the canonical session id from node + task.
 * - `validateSessionIsolation` checks that an external handler configuration
 *   includes a `--session-id` flag (or equivalent) derived from the task.
 * - `buildSessionIsolatedArgs` constructs handler arguments with the invariant
 *   baked in, suitable for use with `createExternalWorkerHandler`.
 *
 * @see jinwon-int/a2a-broker#164
 */

import type { TaskRecord } from "../core/types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Prefix shared by all task-scoped A2A session ids. */
export const A2A_SESSION_ID_PREFIX = "a2a-";

/** Well-known session ids that full-handler workers MUST NOT use. */
export const FORBIDDEN_SESSION_IDS = new Set([
  "main",
  "telegram",
  "a2a-worker",
  "openclaw-tui",
  "agent",
]);

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/**
 * Derive a task-scoped, ephemeral session id from node and task identifiers.
 *
 * The resulting id is deterministic (same inputs → same output) and statelessly
 * computable from a `TaskRecord`.
 */
export function deriveTaskSessionId(nodeId: string, taskId: string): string {
  if (!isNonEmpty(nodeId)) {
    throw new Error("nodeId must be a non-empty string");
  }
  if (!isNonEmpty(taskId)) {
    throw new Error("taskId must be a non-empty string");
  }
  return `${A2A_SESSION_ID_PREFIX}${nodeId}-${taskId}`;
}

/**
 * Derive a task-scoped session id from a TaskRecord.
 */
export function deriveSessionIdFromTask(task: TaskRecord, nodeId: string): string {
  return deriveTaskSessionId(nodeId, task.id);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface SessionIsolationCheck {
  /** Whether the handler configuration satisfies the session isolation invariant. */
  valid: boolean;
  /** The session id derived from the task, for comparison. */
  expectedSessionId: string;
  /** The session id found in the handler args, or undefined if none was found. */
  foundSessionId?: string;
  /** Human-readable reason for failure, if any. */
  reason?: string;
}

/**
 * Check whether an external handler command's arguments satisfy the
 * session-isolation invariant for a given task.
 *
 * The handler args MUST include `--session-id <value>` where `<value>`
 * equals the canonical session id derived from the task.
 */
export function validateSessionIsolation(
  task: TaskRecord,
  nodeId: string,
  args: string[],
): SessionIsolationCheck {
  const expectedSessionId = deriveSessionIdFromTask(task, nodeId);
  const sessionIdIndex = findSessionIdInArgs(args);

  if (sessionIdIndex < 0) {
    return {
      valid: false,
      expectedSessionId,
      reason: `handler args do not include --session-id flag (args: ${JSON.stringify(args)})`,
    };
  }

  const foundSessionId = args[sessionIdIndex + 1];
  if (FORBIDDEN_SESSION_IDS.has(foundSessionId)) {
    return {
      valid: false,
      expectedSessionId,
      foundSessionId,
      reason: `handler uses forbidden shared session id "${foundSessionId}"`,
    };
  }

  if (foundSessionId !== expectedSessionId) {
    return {
      valid: false,
      expectedSessionId,
      foundSessionId,
      reason: `session id mismatch: expected "${expectedSessionId}", got "${foundSessionId}"`,
    };
  }

  return {
    valid: true,
    expectedSessionId,
    foundSessionId,
  };
}

// ---------------------------------------------------------------------------
// Argument construction
// ---------------------------------------------------------------------------

/**
 * Build handler arguments with the task-scoped session id baked in.
 *
 * Merges the invariant `--session-id` flag into the provided base args.
 * If the base args already contain a `--session-id` flag, it is replaced.
 */
export function buildSessionIsolatedArgs(
  baseArgs: string[],
  nodeId: string,
  taskId: string,
): string[] {
  const sessionId = deriveTaskSessionId(nodeId, taskId);
  const args = [...baseArgs];
  const sessionFlagIndex = findSessionIdInArgs(args);

  if (sessionFlagIndex >= 0) {
    // Replace existing session id value
    args[sessionFlagIndex + 1] = sessionId;
  } else {
    args.push("--session-id", sessionId);
  }

  return args;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findSessionIdInArgs(args: string[]): number {
  return args.findIndex(
    (arg, i) =>
      (arg === "--session-id" || arg === "--sessionId" || arg === "-s") &&
      i + 1 < args.length,
  );
}

function isNonEmpty(value: string): boolean {
  return typeof value === "string" && value.trim().length > 0;
}
