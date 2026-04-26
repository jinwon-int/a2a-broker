import type { BrokerSnapshot } from "../core/proof-matrix.js";
import type { AuditEvent, TaskRecord } from "../core/types.js";

export type AssignmentMode = "fanout" | "split" | "review" | "swarm";
export type { BrokerSnapshot };

export interface AssignmentFixture {
  mode: AssignmentMode;
  expectedTaskCount: number;
  build: () => BrokerSnapshot;
}

const BASE_TIME = "2026-04-26T00:00:00.000Z";

function task(
  id: string,
  status: TaskRecord["status"],
  payload: Record<string, unknown>,
  assignedWorkerId?: string,
  artifactIds?: string[],
): TaskRecord {
  return {
    id,
    intent: "analyze",
    requester: { id: "operator", kind: "user", role: "operator" },
    target: { id: "broker", kind: "service", role: "hub" },
    targetNodeId: assignedWorkerId ?? "broker",
    assignedWorkerId,
    status,
    payload,
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
    artifactIds,
  };
}

function audit(id: string, action: AuditEvent["action"], targetId: string): AuditEvent {
  return {
    id,
    actorId: "worker-alpha",
    action,
    targetType: "task",
    targetId,
    createdAt: BASE_TIME,
  };
}

function fanout(): BrokerSnapshot {
  const parent = task("fanout-parent", "running", { childTaskIds: ["fanout-a", "fanout-b"] });
  return {
    tasks: [
      parent,
      task("fanout-a", "running", { parentTaskId: parent.id }, "worker-alpha"),
      task("fanout-b", "running", { parentTaskId: parent.id }, "worker-beta"),
    ],
    auditEvents: [audit("fanout-created", "task.created", parent.id)],
  };
}

function split(): BrokerSnapshot {
  const parent = task("split-parent", "running", { childTaskIds: ["split-a", "split-b"] });
  return {
    tasks: [
      parent,
      task("split-a", "succeeded", { parentTaskId: parent.id }, "worker-alpha"),
      task("split-b", "running", { parentTaskId: parent.id }, "worker-alpha"),
    ],
    auditEvents: [audit("split-a-success", "task.succeeded", "split-a")],
  };
}

function review(): BrokerSnapshot {
  const parent = task("review-parent", "running", { childTaskIds: ["review-impl", "review-check"] });
  return {
    tasks: [
      parent,
      task("review-impl", "succeeded", { parentTaskId: parent.id, role: "implementer" }, "worker-alpha", ["artifact-impl"]),
      task("review-check", "running", { parentTaskId: parent.id, role: "reviewer", artifactIds: ["artifact-impl"] }, "worker-beta"),
    ],
    auditEvents: [audit("review-impl-success", "task.succeeded", "review-impl")],
  };
}

function swarm(): BrokerSnapshot {
  const parent = task("swarm-parent", "running", {
    childTaskIds: ["swarm-a", "swarm-b", "swarm-barrier"],
    completionThreshold: 2,
  });
  return {
    tasks: [
      parent,
      task("swarm-a", "running", { parentTaskId: parent.id }, "worker-alpha"),
      task("swarm-b", "running", { parentTaskId: parent.id }, "worker-beta"),
      task("swarm-barrier", "queued", { parentTaskId: parent.id, barrier: true }, "worker-gamma"),
    ],
    auditEvents: [audit("swarm-created", "task.created", parent.id)],
  };
}

export const TEAM_ASSIGNMENT_FIXTURES: AssignmentFixture[] = [
  { mode: "fanout", expectedTaskCount: 3, build: fanout },
  { mode: "split", expectedTaskCount: 3, build: split },
  { mode: "review", expectedTaskCount: 3, build: review },
  { mode: "swarm", expectedTaskCount: 4, build: swarm },
];
