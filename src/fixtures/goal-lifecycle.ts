import type { BrokerSnapshot } from "../core/store.js";
import type { GoalRecord, TaskRecord } from "../core/types.js";

const BASE_TIME = "2026-05-04T00:00:00.000Z";

function task(
  id: string,
  status: TaskRecord["status"],
  role: string,
  assignedWorkerId: string,
  overrides: Partial<TaskRecord> = {},
): TaskRecord {
  return {
    id,
    intent: "analyze",
    requester: { id: "operator", kind: "user", role: "operator" },
    target: { id: assignedWorkerId, kind: "node", role: "analyst" },
    targetNodeId: assignedWorkerId,
    assignedWorkerId,
    parentTaskId: "goal-smoke-parent",
    message: `Goal lifecycle smoke child: ${role}`,
    payload: {
      goalId: "goal-smoke-302",
      goalRole: role,
    },
    status,
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
    ...overrides,
  };
}

export function buildGoalLifecycleSmokeFixture(): BrokerSnapshot {
  const goal: GoalRecord = {
    id: "goal-smoke-302",
    title: "Ship broker goal lifecycle proposal",
    objective: "Define a bounded objective above A2A tasks and aggregate multiple child outcomes.",
    requester: { id: "operator", kind: "user", role: "operator" },
    status: "budget_limited",
    createdAt: BASE_TIME,
    updatedAt: "2026-05-04T00:15:00.000Z",
    completedAt: "2026-05-04T00:15:00.000Z",
    budget: {
      maxChildAttempts: 3,
      maxResourceUnits: 3,
    },
    taskAttachments: [
      { taskId: "goal-smoke-parent", role: "coordinator", attachedAt: BASE_TIME },
      { taskId: "goal-smoke-design", role: "design", attachedAt: "2026-05-04T00:01:00.000Z" },
      { taskId: "goal-smoke-impl", role: "implementation", attachedAt: "2026-05-04T00:02:00.000Z" },
      { taskId: "goal-smoke-smoke", role: "smoke", attachedAt: "2026-05-04T00:03:00.000Z" },
    ],
    history: [
      {
        id: "goal-event-1",
        goalId: "goal-smoke-302",
        to: "pursuing",
        reason: "operator_requested",
        createdAt: BASE_TIME,
        actor: { id: "operator", kind: "user", role: "operator" },
      },
      {
        id: "goal-event-2",
        goalId: "goal-smoke-302",
        from: "pursuing",
        to: "budget_limited",
        reason: "budget_exhausted",
        createdAt: "2026-05-04T00:15:00.000Z",
        taskId: "goal-smoke-smoke",
        note: "Child attempts were exhausted before all checks passed; this is not classified as task failure.",
      },
    ],
    outcome: {
      summary: "Design and implementation completed; smoke remained queued when the child-attempt budget was exhausted.",
      failed: false,
      artifactIds: ["artifact-goal-design"],
    },
  };

  return {
    version: 8,
    exchanges: [],
    exchangeMessages: [],
    proposals: [],
    artifacts: [],
    validations: [],
    workers: [],
    tasks: [
      task("goal-smoke-parent", "running", "coordinator", "broker", {
        parentTaskId: undefined,
        payload: { goalId: goal.id, childTaskIds: ["goal-smoke-design", "goal-smoke-impl", "goal-smoke-smoke"] },
      }),
      task("goal-smoke-design", "succeeded", "design", "worker-alpha", {
        completedAt: "2026-05-04T00:08:00.000Z",
        result: { summary: "Goal lifecycle design accepted." },
      }),
      task("goal-smoke-impl", "succeeded", "implementation", "worker-beta", {
        completedAt: "2026-05-04T00:12:00.000Z",
        result: { summary: "Types and read-model sketch produced." },
      }),
      task("goal-smoke-smoke", "queued", "smoke", "worker-gamma"),
    ],
    goals: [goal],
    auditEvents: [
      { id: "audit-goal-parent-created", actorId: "broker", action: "task.created", targetType: "task", targetId: "goal-smoke-parent", createdAt: BASE_TIME },
      { id: "audit-goal-design-succeeded", actorId: "worker-alpha", action: "task.succeeded", targetType: "task", targetId: "goal-smoke-design", createdAt: "2026-05-04T00:08:00.000Z" },
      { id: "audit-goal-impl-succeeded", actorId: "worker-beta", action: "task.succeeded", targetType: "task", targetId: "goal-smoke-impl", createdAt: "2026-05-04T00:12:00.000Z" },
    ],
    tombstones: [],
    terminalOutbox: [],
  };
}
