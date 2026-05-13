/**
 * Post-dispatch metadata verifier
 *
 * Validates that a dispatched task's metadata is internally consistent and
 * meets the expected shape after a worker has claimed or started it.
 *
 * "Post-dispatch" refers to any task that has left the "queued" or "blocked"
 * state — i.e., it has been claimed (status === "claimed" or "running").
 * The verifier checks:
 *   1. Attempt tracking — attemptId, claimedBy, claimedAt are present
 *   2. Status validity — task must be claimed or running
 *   3. Worker consistency — claimedBy is populated and matches expectation
 *   4. Timestamp sanity — claimedAt >= createdAt, updatedAt >= claimedAt
 *   5. GitHub canonical shape — for GitHub-origin tasks, payload fields are
 *      in their canonical form (mode, repo, issueNumber, issueUrl)
 */

import type { TaskRecord } from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PostDispatchMetadataCheck {
  /** Short machine-readable check name (e.g. "attempt-id-present"). */
  name: string;
  /** Whether this check passed. */
  passed: boolean;
  /** Human-readable description of what was checked and the outcome. */
  message: string;
  /** Optional structured detail for operators. */
  detail?: Record<string, unknown>;
}

export interface PostDispatchMetadataVerification {
  /** The task ID that was verified. */
  taskId: string;
  /** ISO-8601 timestamp of when the verification ran. */
  timestamp: string;
  /** Individual check results. */
  checks: PostDispatchMetadataCheck[];
  /** True when every check passed. */
  passed: boolean;
  /** Summary counts. */
  summary: {
    total: number;
    passed: number;
    failed: number;
  };
}

// ---------------------------------------------------------------------------
// Check helpers
// ---------------------------------------------------------------------------

function pass(name: string, message: string, detail?: Record<string, unknown>): PostDispatchMetadataCheck {
  return { name, passed: true, message, ...(detail ? { detail } : {}) };
}

function fail(name: string, message: string, detail?: Record<string, unknown>): PostDispatchMetadataCheck {
  return { name, passed: false, message, ...(detail ? { detail } : {}) };
}

// ---------------------------------------------------------------------------
// Individual verifiers
// ---------------------------------------------------------------------------

/**
 * Check 1: The task has been claimed (attemptId, claimedBy, claimedAt present).
 *
 * After a worker claims a task, the broker sets attemptId, claimedBy, and
 * claimedAt.  A missing claim-time field indicates the claim step never
 * completed properly.
 */
function verifyClaimMetadata(task: TaskRecord): PostDispatchMetadataCheck[] {
  const checks: PostDispatchMetadataCheck[] = [];

  // attemptId
  if (task.attemptId) {
    checks.push(pass(
      "attempt-id-present",
      `Task has attemptId: ${task.attemptId}`,
      { attemptId: task.attemptId },
    ));
  } else {
    checks.push(fail(
      "attempt-id-present",
      "Task has no attemptId — the claim step did not set an attempt identifier",
    ));
  }

  // claimedBy
  if (task.claimedBy) {
    checks.push(pass(
      "claimed-by-present",
      `Task claimed by worker: ${task.claimedBy}`,
      { claimedBy: task.claimedBy },
    ));
  } else {
    checks.push(fail(
      "claimed-by-present",
      "Task has no claimedBy — no worker has claimed this task",
    ));
  }

  // claimedAt
  if (task.claimedAt) {
    checks.push(pass(
      "claimed-at-present",
      `Task claimed at: ${task.claimedAt}`,
      { claimedAt: task.claimedAt },
    ));
  } else {
    checks.push(fail(
      "claimed-at-present",
      "Task has no claimedAt — the claim timestamp was never recorded",
    ));
  }

  return checks;
}

/**
 * Check 2: Status is valid for a post-dispatch task.
 *
 * A task that has been dispatched should be "claimed" or "running".
 * "queued" or "blocked" means it has not yet been picked up.
 */
function verifyPostDispatchStatus(task: TaskRecord): PostDispatchMetadataCheck[] {
  const validStatuses = new Set(["claimed", "running"]);
  const isValid = validStatuses.has(task.status) && task.claimedAt !== undefined;

  if (isValid) {
    return [pass(
      "post-dispatch-status",
      `Task status "${task.status}" is valid for post-dispatch (claimed/running)`,
      { status: task.status, claimedAt: task.claimedAt },
    )];
  }

  // Build a helpful diagnostic
  const hints: string[] = [];
  if (task.status === "queued" || task.status === "blocked") {
    hints.push(`task is still "${task.status}" — it has not been claimed yet`);
  } else if (task.status === "succeeded" || task.status === "failed" || task.status === "canceled") {
    hints.push(`task is terminal ("${task.status}") — this verifier is for in-flight tasks`);
  } else if (task.claimedAt === undefined) {
    hints.push("task has no claimedAt even though it may appear claimed");
  } else {
    hints.push(`unexpected status "${task.status}" for post-dispatch verification`);
  }

  return [fail(
    "post-dispatch-status",
    `Task status "${task.status}" is not a valid post-dispatch status`,
    { status: task.status, claimedAt: task.claimedAt, hints },
  )];
}

/**
 * Check 3: Worker consistency — claimedBy matches either assignedWorkerId or
 * targetNodeId.
 */
function verifyWorkerConsistency(task: TaskRecord): PostDispatchMetadataCheck[] {
  if (!task.claimedBy) {
    return [fail(
      "worker-consistency",
      "Cannot verify worker consistency — claimedBy is empty",
    )];
  }

  const expectedWorker = task.assignedWorkerId ?? task.targetNodeId;
  const matches = task.claimedBy === expectedWorker;

  if (matches) {
    return [pass(
      "worker-consistency",
      `claimedBy "${task.claimedBy}" matches the expected worker (assignedWorkerId or targetNodeId)`,
      { claimedBy: task.claimedBy, expectedWorker },
    )];
  }

  return [fail(
    "worker-consistency",
    `claimedBy "${task.claimedBy}" does not match the expected worker "${expectedWorker}"`,
    { claimedBy: task.claimedBy, expectedWorker, assignedWorkerId: task.assignedWorkerId, targetNodeId: task.targetNodeId },
  )];
}

/**
 * Check 4: Timestamp sanity — claimedAt >= createdAt and updatedAt >=
 * claimedAt.
 *
 * Caught timestamps that are out of order indicate broker-level data
 * corruption or a clock-skew issue.
 */
function verifyTimestampSanity(task: TaskRecord): PostDispatchMetadataCheck[] {
  const checks: PostDispatchMetadataCheck[] = [];
  const createdAt = task.createdAt ? new Date(task.createdAt).getTime() : NaN;
  const claimedAt = task.claimedAt ? new Date(task.claimedAt).getTime() : NaN;
  const updatedAt = task.updatedAt ? new Date(task.updatedAt).getTime() : NaN;

  // claimedAt >= createdAt
  if (!Number.isNaN(createdAt) && !Number.isNaN(claimedAt)) {
    if (claimedAt >= createdAt) {
      checks.push(pass(
        "claimed-at-after-created-at",
        `claimedAt (${task.claimedAt}) >= createdAt (${task.createdAt})`,
        { createdAt: task.createdAt, claimedAt: task.claimedAt },
      ));
    } else {
      checks.push(fail(
        "claimed-at-after-created-at",
        `claimedAt (${task.claimedAt}) is before createdAt (${task.createdAt}) — timestamps are out of order`,
        { createdAt: task.createdAt, claimedAt: task.claimedAt },
      ));
    }
  } else {
    checks.push(fail(
      "claimed-at-after-created-at",
      "Cannot compare timestamps — createdAt or claimedAt is missing or invalid",
      { createdAt: task.createdAt, claimedAt: task.claimedAt },
    ));
  }

  // updatedAt >= claimedAt
  if (!Number.isNaN(claimedAt) && !Number.isNaN(updatedAt)) {
    if (updatedAt >= claimedAt) {
      checks.push(pass(
        "updated-at-after-claimed-at",
        `updatedAt (${task.updatedAt}) >= claimedAt (${task.claimedAt})`,
        { claimedAt: task.claimedAt, updatedAt: task.updatedAt },
      ));
    } else {
      checks.push(fail(
        "updated-at-after-claimed-at",
        `updatedAt (${task.updatedAt}) is before claimedAt (${task.claimedAt}) — timestamps are out of order`,
        { claimedAt: task.claimedAt, updatedAt: task.updatedAt },
      ));
    }
  } else {
    checks.push(fail(
      "updated-at-after-claimed-at",
      "Cannot compare timestamps — claimedAt or updatedAt is missing or invalid",
      { claimedAt: task.claimedAt, updatedAt: task.updatedAt },
    ));
  }

  return checks;
}

/**
 * Check 5: For GitHub-origin tasks, verify the payload has the canonical
 * shape.
 *
 * Canonical shape includes:
 *  - payload.mode = "github-propose-patch" (or one of the known GitHub modes)
 *  - payload.repo in "owner/name" form
 *  - payload.issueNumber as a positive integer
 *  - payload.issueUrl as a GitHub issue URL
 */
function verifyGitHubCanonicalPayload(task: TaskRecord): PostDispatchMetadataCheck[] {
  const checks: PostDispatchMetadataCheck[] = [];
  const isGithubTask = task.taskOrigin === "github" || (
    typeof task.payload?.mode === "string" &&
    task.payload.mode.startsWith("github-")
  );

  if (!isGithubTask) {
    checks.push(pass(
      "github-canonical-payload",
      "Task is not a GitHub-origin task — skipping canonical payload check",
      { taskOrigin: task.taskOrigin, payloadMode: task.payload?.mode },
    ));
    return checks;
  }

  // --- mode ---
  const mode = typeof task.payload?.mode === "string" ? task.payload.mode : undefined;
  if (mode && mode.startsWith("github-")) {
    checks.push(pass("github-payload-mode", `payload.mode is "${mode}"`, { mode }));
  } else {
    checks.push(fail(
      "github-payload-mode",
      `payload.mode must start with "github-" for GitHub tasks; got "${mode ?? "undefined"}"`,
      { mode },
    ));
  }

  // --- repo (owner/name) ---
  const repo = typeof task.payload?.repo === "string" ? task.payload.repo : undefined;
  if (repo && /^[^/\s]+\/[^/\s]+$/.test(repo)) {
    checks.push(pass("github-payload-repo", `payload.repo is "${repo}"`, { repo }));
  } else {
    checks.push(fail(
      "github-payload-repo",
      `payload.repo must be in "owner/name" form for GitHub tasks; got "${repo ?? "undefined"}"`,
      { repo },
    ));
  }

  // --- issueNumber ---
  const issueNumber = typeof task.payload?.issueNumber === "number"
    ? task.payload.issueNumber
    : (typeof task.payload?.issueNumber === "string"
      ? Number(task.payload.issueNumber)
      : undefined);
  const hasValidIssueNumber = typeof issueNumber === "number" && Number.isInteger(issueNumber) && issueNumber > 0;
  if (hasValidIssueNumber) {
    checks.push(pass(
      "github-payload-issue-number",
      `payload.issueNumber is ${issueNumber}`,
      { issueNumber },
    ));
  } else {
    checks.push(fail(
      "github-payload-issue-number",
      `payload.issueNumber must be a positive integer for GitHub tasks; got "${String(task.payload?.issueNumber)}"`,
      { issueNumberRaw: task.payload?.issueNumber },
    ));
  }

  // --- issueUrl ---
  const issueUrl = typeof task.payload?.issueUrl === "string" ? task.payload.issueUrl : undefined;
  if (issueUrl && /^https?:\/\/github\.com\//i.test(issueUrl)) {
    checks.push(pass(
      "github-payload-issue-url",
      `payload.issueUrl is "${issueUrl}"`,
      { issueUrl },
    ));
  } else {
    checks.push(fail(
      "github-payload-issue-url",
      `payload.issueUrl must be a GitHub issue URL for GitHub tasks; got "${issueUrl ?? "undefined"}"`,
      { issueUrl },
    ));
  }

  return checks;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Verify post-dispatch metadata for a single task.
 *
 * @param task - The task record to verify.
 * @param expectedWorkerId - Optional. If provided, additionally checks that
 *   claimedBy matches this worker.
 * @returns A structured verification result with per-check outcomes.
 */
export function verifyPostDispatchMetadata(
  task: TaskRecord,
  expectedWorkerId?: string,
): PostDispatchMetadataVerification {
  const allChecks: PostDispatchMetadataCheck[] = [];

  // Collect all checks
  allChecks.push(...verifyClaimMetadata(task));
  allChecks.push(...verifyPostDispatchStatus(task));
  allChecks.push(...verifyWorkerConsistency(task));
  allChecks.push(...verifyTimestampSanity(task));
  allChecks.push(...verifyGitHubCanonicalPayload(task));

  // Additional: if expectedWorkerId was explicitly provided, check it
  if (expectedWorkerId) {
    const matches = task.claimedBy === expectedWorkerId;
    allChecks.push(
      matches
        ? pass(
            "expected-worker-match",
            `claimedBy matches expected worker "${expectedWorkerId}"`,
            { claimedBy: task.claimedBy, expectedWorkerId },
          )
        : fail(
            "expected-worker-match",
            `claimedBy "${task.claimedBy}" does not match expected worker "${expectedWorkerId}"`,
            { claimedBy: task.claimedBy, expectedWorkerId },
          ),
    );
  }

  const passed = allChecks.every((c) => c.passed);
  const total = allChecks.length;
  const passedCount = allChecks.filter((c) => c.passed).length;
  const failedCount = total - passedCount;

  return {
    taskId: task.id,
    timestamp: new Date().toISOString(),
    checks: allChecks,
    passed,
    summary: { total, passed: passedCount, failed: failedCount },
  };
}
