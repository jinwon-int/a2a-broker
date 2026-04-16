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
      proposalId: task.proposalId,
      targetNodeId: task.targetNodeId,
      assignedWorkerId: task.assignedWorkerId,
      claimedBy: task.claimedBy,
      workspace: task.workspace,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      error: task.error,
      result: task.result,
    },
    artifacts: (task.result?.artifactIds ?? task.artifactIds ?? []).map((id) => ({ id })),
  };
}

function mapTaskState(status: TaskStatus): A2ATaskState {
  switch (status) {
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
  }
}
