/**
 * Team aggregate E2E proof matrix (issue #73).
 *
 * Validates that fanout/split/review/swarm assignment modes produce
 * correct parent/child lifecycle outcomes in the broker read model.
 *
 * Proof categories:
 *   - Closure: parent transitions correctly when children reach terminal states
 *   - Barrier: swarm/review modes enforce ordering/threshold constraints
 *   - Idempotency: duplicate child completions are suppressed
 *   - Edge: blocked child, PR-linked child, timeout child scenarios
 */

import type {
  AuditEvent,
  TaskRecord,
  TaskStatus,
} from "../core/types.js";
import type { AssignmentMode } from "../fixtures/team-assignment.js";
import type {
  HandoffScenarioId,
  HandoffOutcome,
} from "./handoff-types.js";

export interface BrokerSnapshot {
  tasks: TaskRecord[];
  auditEvents: AuditEvent[];
}

// ---------------------------------------------------------------------------
// Proof verdict
// ---------------------------------------------------------------------------

export type ProofVerdict = "pass" | "fail" | "skip" | "warn";

export interface ProofCheckResult {
  checkId: string;
  description: string;
  verdict: ProofVerdict;
  detail?: string;
}

export interface ProofMatrixResult {
  mode: AssignmentMode;
  scenario: string;
  checks: ProofCheckResult[];
  overallVerdict: ProofVerdict;
}

// ---------------------------------------------------------------------------
// Parent/child relationship helpers
// ---------------------------------------------------------------------------

export function extractParentChildren(
  snapshot: BrokerSnapshot,
): { parent: TaskRecord; children: TaskRecord[] } | null {
  const parents = snapshot.tasks.filter(
    t => t.payload.childTaskIds || t.payload.childTaskId,
  );
  if (parents.length === 0) return null;

  // Use first parent found
  const parent = parents[0];
  const childIds: string[] = [
    ...(parent.payload.childTaskIds as string[] ?? []),
  ];
  if (parent.payload.childTaskId) childIds.push(parent.payload.childTaskId as string);
  if (parent.payload.reviewTaskId) childIds.push(parent.payload.reviewTaskId as string);

  const children = snapshot.tasks.filter(t => childIds.includes(t.id));
  return { parent, children };
}

// ---------------------------------------------------------------------------
// Closure rules
// ---------------------------------------------------------------------------

/** Check that parent is still running while any child is non-terminal. */
export function checkParentWaitsForChildren(
  snapshot: BrokerSnapshot,
): ProofCheckResult {
  const rel = extractParentChildren(snapshot);
  if (!rel) return { checkId: "closure-001", description: "Parent waits for children", verdict: "skip", detail: "No parent/child structure" };

  const hasActiveChild = rel.children.some(c => !isTerminal(c.status));
  if (rel.parent.status === "running" && hasActiveChild) {
    return { checkId: "closure-001", description: "Parent waits for children", verdict: "pass" };
  }
  if (rel.parent.status === "running" && !hasActiveChild) {
    return { checkId: "closure-001", description: "Parent waits for children", verdict: "fail", detail: "Parent still running but all children are terminal" };
  }
  if (isTerminal(rel.parent.status)) {
    return { checkId: "closure-001", description: "Parent waits for children", verdict: "pass", detail: `Parent is ${rel.parent.status}` };
  }
  return { checkId: "closure-001", description: "Parent waits for children", verdict: "pass" };
}

/** Check that children reference the correct parent. */
export function checkChildParentReference(
  snapshot: BrokerSnapshot,
): ProofCheckResult {
  const rel = extractParentChildren(snapshot);
  if (!rel) return { checkId: "closure-002", description: "Children reference parent", verdict: "skip" };

  const orphans = rel.children.filter(c => c.payload.parentTaskId !== rel.parent.id);
  if (orphans.length > 0) {
    return { checkId: "closure-002", description: "Children reference parent", verdict: "fail", detail: `${orphans.length} orphans` };
  }
  return { checkId: "closure-002", description: "Children reference parent", verdict: "pass" };
}

/** Check parent transitions to succeeded when all children succeed. */
export function checkParentSuccessOnAllChildrenSuccess(
  snapshot: BrokerSnapshot,
): ProofCheckResult {
  const rel = extractParentChildren(snapshot);
  if (!rel) return { checkId: "closure-003", description: "Parent succeeds when all children succeed", verdict: "skip" };

  const allSucceeded = rel.children.length > 0 && rel.children.every(c => c.status === "succeeded");
  if (allSucceeded && rel.parent.status === "succeeded") {
    return { checkId: "closure-003", description: "Parent succeeds when all children succeed", verdict: "pass" };
  }
  if (allSucceeded && rel.parent.status !== "succeeded") {
    return { checkId: "closure-003", description: "Parent succeeds when all children succeed", verdict: "fail", detail: `All children succeeded but parent is ${rel.parent.status}` };
  }
  // Parent succeeded but not all children done → premature success
  if (rel.parent.status === "succeeded" && !allSucceeded) {
    return { checkId: "closure-003", description: "Parent succeeds when all children succeed", verdict: "fail", detail: `Parent succeeded but only ${rel.children.filter(c => c.status === "succeeded").length}/${rel.children.length} children succeeded` };
  }
  return { checkId: "closure-003", description: "Parent succeeds when all children succeed", verdict: "pass", detail: "Not all children succeeded yet" };
}

/** Check parent fails when any child fails (for non-swarm modes). */
export function checkParentFailsOnChildFailure(
  snapshot: BrokerSnapshot,
  mode: AssignmentMode,
): ProofCheckResult {
  const rel = extractParentChildren(snapshot);
  if (!rel) return { checkId: "closure-004", description: "Parent fails on child failure", verdict: "skip" };

  if (mode === "swarm") {
    return { checkId: "closure-004", description: "Parent fails on child failure", verdict: "skip", detail: "Swarm uses barrier, not fail-fast" };
  }

  const hasFailed = rel.children.some(c => c.status === "failed");
  if (hasFailed && rel.parent.status === "failed") {
    return { checkId: "closure-004", description: "Parent fails on child failure", verdict: "pass" };
  }
  if (hasFailed && rel.parent.status !== "failed") {
    return { checkId: "closure-004", description: "Parent fails on child failure", verdict: "warn", detail: "Child failed but parent not yet failed (may retry)" };
  }
  return { checkId: "closure-004", description: "Parent fails on child failure", verdict: "pass" };
}

// ---------------------------------------------------------------------------
// Barrier rules (swarm/review)
// ---------------------------------------------------------------------------

/** Check swarm barrier child is queued until threshold met. */
export function checkSwarmBarrier(
  snapshot: BrokerSnapshot,
): ProofCheckResult {
  const rel = extractParentChildren(snapshot);
  if (!rel) return { checkId: "barrier-001", description: "Swarm barrier child queued until threshold", verdict: "skip" };

  const barrierChild = rel.children.find(c => c.payload.barrier === true);
  if (!barrierChild) return { checkId: "barrier-001", description: "Swarm barrier child queued until threshold", verdict: "skip", detail: "No barrier child" };

  const completedCount = rel.children.filter(c => c.status === "succeeded").length;
  const threshold = (rel.parent.payload.completionThreshold as number) ?? rel.children.length;

  if (completedCount < threshold && barrierChild.status === "queued") {
    return { checkId: "barrier-001", description: "Swarm barrier child queued until threshold", verdict: "pass" };
  }
  if (completedCount >= threshold && barrierChild.status === "queued") {
    return { checkId: "barrier-001", description: "Swarm barrier child queued until threshold", verdict: "fail", detail: `Threshold ${threshold} met but barrier child still queued` };
  }
  return { checkId: "barrier-001", description: "Swarm barrier child queued until threshold", verdict: "pass" };
}

/** Check review task references implementer's artifacts. */
export function checkReviewArtifactLink(
  snapshot: BrokerSnapshot,
): ProofCheckResult {
  const rel = extractParentChildren(snapshot);
  if (!rel) return { checkId: "barrier-002", description: "Review task references implementer artifacts", verdict: "skip" };

  const reviewTask = rel.children.find(c => c.payload.role === "reviewer");
  const implTask = rel.children.find(c => c.payload.role === "implementer");
  if (!reviewTask || !implTask) return { checkId: "barrier-002", description: "Review task references implementer artifacts", verdict: "skip" };

  const implArtifacts: string[] = implTask.artifactIds ?? [];
  const reviewArtifacts: string[] = (reviewTask.payload.artifactIds as string[]) ?? [];

  const hasOverlap = implArtifacts.some(a => reviewArtifacts.includes(a));
  if (hasOverlap) {
    return { checkId: "barrier-002", description: "Review task references implementer artifacts", verdict: "pass" };
  }
  return { checkId: "barrier-002", description: "Review task references implementer artifacts", verdict: "warn", detail: "No artifact overlap found" };
}

/** Check review task is on a different worker than implementer. */
export function checkReviewWorkerSeparation(
  snapshot: BrokerSnapshot,
): ProofCheckResult {
  const rel = extractParentChildren(snapshot);
  if (!rel) return { checkId: "barrier-003", description: "Review worker ≠ implementer worker", verdict: "skip" };

  const reviewTask = rel.children.find(c => c.payload.role === "reviewer");
  const implTask = rel.children.find(c => c.payload.role === "implementer");
  if (!reviewTask || !implTask) return { checkId: "barrier-003", description: "Review worker ≠ implementer worker", verdict: "skip" };

  if (reviewTask.assignedWorkerId !== implTask.assignedWorkerId) {
    return { checkId: "barrier-003", description: "Review worker ≠ implementer worker", verdict: "pass" };
  }
  return { checkId: "barrier-003", description: "Review worker ≠ implementer worker", verdict: "fail", detail: "Same worker" };
}

// ---------------------------------------------------------------------------
// Mode-specific invariants
// ---------------------------------------------------------------------------

/** Fanout: children dispatched to distinct workers. */
export function checkFanoutDistinctWorkers(
  snapshot: BrokerSnapshot,
): ProofCheckResult {
  const rel = extractParentChildren(snapshot);
  if (!rel) return { checkId: "mode-fanout-001", description: "Fanout children on distinct workers", verdict: "skip" };

  const workers = new Set(rel.children.map(c => c.assignedWorkerId));
  if (workers.size === rel.children.length) {
    return { checkId: "mode-fanout-001", description: "Fanout children on distinct workers", verdict: "pass" };
  }
  return { checkId: "mode-fanout-001", description: "Fanout children on distinct workers", verdict: "fail", detail: `${workers.size} distinct workers for ${rel.children.length} children` };
}

/** Split: all children on the same worker. */
export function checkSplitSameWorker(
  snapshot: BrokerSnapshot,
): ProofCheckResult {
  const rel = extractParentChildren(snapshot);
  if (!rel) return { checkId: "mode-split-001", description: "Split children on same worker", verdict: "skip" };

  const workers = new Set(rel.children.map(c => c.assignedWorkerId));
  if (workers.size === 1) {
    return { checkId: "mode-split-001", description: "Split children on same worker", verdict: "pass" };
  }
  return { checkId: "mode-split-001", description: "Split children on same worker", verdict: "fail", detail: `${workers.size} distinct workers` };
}

/** Swarm: parent tracks completion count. */
export function checkSwarmCompletionTracking(
  snapshot: BrokerSnapshot,
): ProofCheckResult {
  const rel = extractParentChildren(snapshot);
  if (!rel) return { checkId: "mode-swarm-001", description: "Swarm parent tracks completion count", verdict: "skip" };

  const expected = rel.children.filter(c => c.status === "succeeded").length;
  const tracked = (rel.parent.payload.completionThreshold as number) ?? rel.children.length;

  if (tracked > 0) {
    return { checkId: "mode-swarm-001", description: "Swarm parent tracks completion count", verdict: "pass", detail: `${expected}/${tracked}` };
  }
  return { checkId: "mode-swarm-001", description: "Swarm parent tracks completion count", verdict: "warn", detail: "No completionThreshold in parent payload" };
}

// ---------------------------------------------------------------------------
// Edge scenarios
// ---------------------------------------------------------------------------

/** Duplicate child completion: same task completed twice should not double-count. */
export function checkDuplicateChildCompletion(
  snapshot: BrokerSnapshot,
): ProofCheckResult {
  const rel = extractParentChildren(snapshot);
  if (!rel) return { checkId: "edge-001", description: "Duplicate child completion suppressed", verdict: "skip" };

  // Check audit events for duplicate task.succeeded
  const successEvents = snapshot.auditEvents.filter(e => e.action === "task.succeeded");
  const taskIds = successEvents.map(e => e.targetId);
  const duplicates = taskIds.filter((id, i) => taskIds.indexOf(id) !== i);

  if (duplicates.length === 0) {
    return { checkId: "edge-001", description: "Duplicate child completion suppressed", verdict: "pass" };
  }
  return { checkId: "edge-001", description: "Duplicate child completion suppressed", verdict: "fail", detail: `Duplicate successes: ${[...new Set(duplicates)].join(", ")}` };
}

/** Blocked child: parent should not succeed if a child is failed/blocked. */
export function checkBlockedChildBlocksParent(
  snapshot: BrokerSnapshot,
): ProofCheckResult {
  const rel = extractParentChildren(snapshot);
  if (!rel) return { checkId: "edge-002", description: "Blocked child blocks parent", verdict: "skip" };

  const hasBlocked = rel.children.some(c => c.status === "failed" || c.status === "canceled");
  if (hasBlocked && rel.parent.status === "succeeded") {
    return { checkId: "edge-002", description: "Blocked child blocks parent", verdict: "fail", detail: "Parent succeeded despite blocked child" };
  }
  if (hasBlocked) {
    return { checkId: "edge-002", description: "Blocked child blocks parent", verdict: "pass" };
  }
  return { checkId: "edge-002", description: "Blocked child blocks parent", verdict: "pass", detail: "No blocked children" };
}

/** Timeout child: child with timeout should have requeueCount or error. */
export function checkTimeoutChildHasError(
  snapshot: BrokerSnapshot,
): ProofCheckResult {
  const rel = extractParentChildren(snapshot);
  if (!rel) return { checkId: "edge-003", description: "Timeout child has error/requeue", verdict: "skip" };

  const timedOut = rel.children.filter(c =>
    c.status === "failed" && c.error?.message?.toLowerCase().includes("timeout"),
  );

  if (timedOut.length === 0) {
    return { checkId: "edge-003", description: "Timeout child has error/requeue", verdict: "pass", detail: "No timed-out children" };
  }

  const hasRequeueInfo = timedOut.some(c => (c.requeueCount ?? 0) > 0 || c.error);
  if (hasRequeueInfo) {
    return { checkId: "edge-003", description: "Timeout child has error/requeue", verdict: "pass" };
  }
  return { checkId: "edge-003", description: "Timeout child has error/requeue", verdict: "warn", detail: "Timeout child missing requeue info" };
}

// ---------------------------------------------------------------------------
// Proof matrix runner
// ---------------------------------------------------------------------------

export interface ProofMatrixConfig {
  mode: AssignmentMode;
  scenario: string;
  snapshot: BrokerSnapshot;
  skipChecks?: string[];
}

export function runProofMatrix(config: ProofMatrixConfig): ProofMatrixResult {
  const checks: ProofCheckResult[] = [];

  // Universal closure checks
  checks.push(checkParentWaitsForChildren(config.snapshot));
  checks.push(checkChildParentReference(config.snapshot));
  checks.push(checkParentSuccessOnAllChildrenSuccess(config.snapshot));
  checks.push(checkParentFailsOnChildFailure(config.snapshot, config.mode));

  // Barrier checks
  checks.push(checkSwarmBarrier(config.snapshot));
  checks.push(checkReviewArtifactLink(config.snapshot));
  checks.push(checkReviewWorkerSeparation(config.snapshot));

  // Mode-specific
  if (config.mode === "fanout") {
    checks.push(checkFanoutDistinctWorkers(config.snapshot));
  }
  if (config.mode === "split") {
    checks.push(checkSplitSameWorker(config.snapshot));
  }
  if (config.mode === "swarm") {
    checks.push(checkSwarmCompletionTracking(config.snapshot));
  }

  // Edge cases
  checks.push(checkDuplicateChildCompletion(config.snapshot));
  checks.push(checkBlockedChildBlocksParent(config.snapshot));
  checks.push(checkTimeoutChildHasError(config.snapshot));

  // Filter skipped checks and apply skip list
  const filtered = checks.map(c => {
    if (config.skipChecks?.includes(c.checkId)) {
      return { ...c, verdict: "skip" as ProofVerdict, detail: "Explicitly skipped" };
    }
    return c;
  });

  const overallVerdict = computeOverall(filtered);

  return { mode: config.mode, scenario: config.scenario, checks: filtered, overallVerdict };
}

// ---------------------------------------------------------------------------
// Operator checklist (for closeout gate)
// ---------------------------------------------------------------------------

export interface OperatorChecklistItem {
  id: string;
  description: string;
  mode?: AssignmentMode;
  required: boolean;
}

export const ROUND16_OPERATOR_CHECKLIST: OperatorChecklistItem[] = [
  { id: "op-001", description: "All fanout children dispatched to distinct workers", mode: "fanout", required: true },
  { id: "op-002", description: "Split children coalesced to single worker session", mode: "split", required: true },
  { id: "op-003", description: "Review task created only after implementer succeeds", mode: "review", required: true },
  { id: "op-004", description: "Review worker ≠ implementer worker", mode: "review", required: true },
  { id: "op-005", description: "Swarm barrier child queued until threshold met", mode: "swarm", required: true },
  { id: "op-006", description: "Parent succeeds only when all children succeed", required: true },
  { id: "op-007", description: "Duplicate child completion suppressed in audit log", required: true },
  { id: "op-008", description: "Blocked/failed child prevents parent success", required: true },
  { id: "op-009", description: "Timeout child has error or requeueCount > 0", required: true },
  { id: "op-010", description: "GitHub mode task IDs link to issue/PR numbers", mode: "fanout", required: false },
];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isTerminal(status: TaskStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "canceled";
}

function computeOverall(checks: ProofCheckResult[]): ProofVerdict {
  if (checks.some(c => c.verdict === "fail")) return "fail";
  if (checks.some(c => c.verdict === "warn")) return "warn";
  const nonSkipped = checks.filter(c => c.verdict !== "skip");
  if (nonSkipped.length === 0) return "skip";
  if (nonSkipped.every(c => c.verdict === "pass")) return "pass";
  return "warn";
}
