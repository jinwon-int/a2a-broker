import type { TaskRecord, TaskStatus } from "../core/types.js";

export type A2ATaskState = "submitted" | "working" | "completed" | "failed" | "canceled";

export interface A2ATextPart {
  text: string;
}

export interface A2AMessage {
  role: "agent";
  parts: A2ATextPart[];
}

export interface A2ATaskStatusProjection {
  state: A2ATaskState;
  timestamp: string;
  message?: A2AMessage;
}

export interface A2ATaskProjection {
  id: string;
  kind: "task";
  status: A2ATaskStatusProjection;
  metadata: Record<string, unknown>;
  artifacts: Array<{ id: string }>;
}

export interface A2ATaskListProjection extends A2ATaskProjection {
  metadata: Omit<A2ATaskProjection["metadata"], "result"> & {
    resultSummary?: string;
  };
}

export function projectBrokerTask(task: TaskRecord): A2ATaskProjection {
  const summary = task.result?.summary ?? task.result?.note ?? task.message;
  return {
    id: task.id,
    kind: "task",
    status: {
      state: mapTaskState(task.status),
      timestamp: task.completedAt ?? task.updatedAt,
      message: summary
        ? {
            role: "agent",
            parts: [{ text: summary }],
          }
        : undefined,
    },
    metadata: {
      internalStatus: task.status,
      intent: task.intent,
      requester: task.requester,
      target: task.target,
      exchangeId: task.exchangeId,
      parentTaskId: task.parentTaskId,
      proposalId: task.proposalId,
      targetNodeId: task.targetNodeId,
      assignedWorkerId: task.assignedWorkerId,
      claimedBy: task.claimedBy,
      workspace: task.workspace,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      cancellation: task.cancellation,
      error: task.error,
      result: task.result,
      policyContext: task.policyContext,
      approval: task.approval,
    },
    artifacts: (task.result?.artifactIds ?? task.artifactIds ?? []).map((id) => ({ id })),
  };
}

export function projectBrokerTaskForList(task: TaskRecord): A2ATaskListProjection {
  const projected = projectBrokerTask(task);
  const resultSummary = task.result?.summary ?? task.result?.note;
  return {
    ...projected,
    metadata: {
      internalStatus: task.status,
      intent: task.intent,
      requester: task.requester,
      target: task.target,
      exchangeId: task.exchangeId,
      parentTaskId: task.parentTaskId,
      proposalId: task.proposalId,
      targetNodeId: task.targetNodeId,
      assignedWorkerId: task.assignedWorkerId,
      claimedBy: task.claimedBy,
      workspace: task.workspace,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      cancellation: task.cancellation,
      error: task.error ? { code: task.error.code, message: task.error.message } : undefined,
      resultSummary,
      policyContext: task.policyContext,
      approval: task.approval,
    },
  };
}

/**
 * Map broker-internal {@link TaskStatus} to the public A2A 1.0 task state.
 *
 * Broker status → A2A 1.0 state:
 *
 * | Broker status | A2A 1.0 state | Terminal? |
 * |--------------|--------------|----------|
 * | `blocked`    | `submitted`  | no       |
 * | `queued`     | `submitted`  | no       |
 * | `claimed`    | `working`    | no       |
 * | `running`    | `working`    | no       |
 * | `succeeded`  | `completed`  | **yes**  |
 * | `failed`     | `failed`     | **yes**  |
 * | `canceled`   | `canceled`   | **yes**  |
 *
 * **Terminal immutability:** Once a task reaches a terminal broker status
 * (`succeeded`, `failed`, or `canceled`), the broker rejects further
 * lifecycle mutations (reassign, complete, fail, cancel). The projected
 * A2A state (`completed`, `failed`, `canceled`) is likewise immutable.
 */
function mapTaskState(status: TaskStatus): A2ATaskState {
  switch (status) {
    case "blocked":
    case "queued":
      return "submitted";
    case "claimed":
    case "running":
      return "working";
    case "succeeded":
      return "completed";
    case "failed":
      return "failed";
    case "canceled":
      return "canceled";
    default:
      throw new Error("unhandled task status");
  }
}
