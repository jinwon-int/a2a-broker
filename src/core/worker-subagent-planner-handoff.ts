import { createHash } from "node:crypto";

import type { A2AWorkerSelfAssessmentCapacityPacket } from "./worker-self-assessment-capacity.js";
import type { A2AWorkerSubagentPolicyPacket } from "./worker-subagent-orchestration-policy.js";

export interface A2AWorkerSubagentPlannerHandoffInput {
  now?: string;
  finalizer?: string;
  selfAssessment: A2AWorkerSelfAssessmentCapacityPacket;
  plannerPolicy: A2AWorkerSubagentPolicyPacket;
}

export interface A2AWorkerSubagentPlannerHandoffPacket {
  kind: "a2a-broker.worker-subagent-planner-handoff.packet";
  version: 1;
  generatedAt: string;
  sourceOnly: true;
  idempotencyKey: string;
  state: "ready_for_finalizer_review" | "blocked";
  finalizer: string;
  workerId: string;
  taskId?: string;
  source: {
    selfAssessmentIdempotencyKey: string;
    plannerPolicyIdempotencyKey: string;
    selfAssessmentReady: boolean;
    plannerParallelismHint: 0 | 1 | 2 | 3;
    recommendedRoles: string[];
  };
  review: {
    workerMatches: boolean;
    taskMatches: boolean;
    plannerInputMatches: boolean;
    sourceBoundariesIntact: boolean;
    finalizerRequired: true;
    evidenceOnlySubagents: true;
    writeSetIsolationRequired: true;
    directExecutionEscapeHatch: true;
    blockers: string[];
    nextAction: string;
  };
  boundaries: {
    sourceOnly: true;
    liveHostProbe: false;
    plannerRouteCall: false;
    actualSubagentSpawn: false;
    runtimeBehaviorChanged: false;
    mandatoryProductionSpawn: false;
    brokerDispatch: false;
    workerClaim: false;
    executorInvocation: false;
    processSpawn: false;
    taskFlowMutation: false;
    dbMutation: false;
    deployOrRestart: false;
    providerSend: false;
    terminalAckOrReplay: false;
    releaseOrPublish: false;
    secretMovement: false;
  };
}

export function buildA2AWorkerSubagentPlannerHandoff(
  input: A2AWorkerSubagentPlannerHandoffInput,
): A2AWorkerSubagentPlannerHandoffPacket {
  const generatedAt = input.now ?? new Date().toISOString();
  const blockers = buildBlockers(input.selfAssessment, input.plannerPolicy);
  const state = blockers.length === 0 ? "ready_for_finalizer_review" : "blocked";
  const finalizer = input.finalizer ?? "worker-or-broker-finalizer";
  return {
    kind: "a2a-broker.worker-subagent-planner-handoff.packet",
    version: 1,
    generatedAt,
    sourceOnly: true,
    idempotencyKey: buildHandoffId(input, generatedAt, state),
    state,
    finalizer,
    workerId: input.selfAssessment.workerId,
    taskId: input.selfAssessment.task?.taskId ?? input.plannerPolicy.task.taskId,
    source: {
      selfAssessmentIdempotencyKey: input.selfAssessment.idempotencyKey,
      plannerPolicyIdempotencyKey: input.plannerPolicy.idempotencyKey,
      selfAssessmentReady: input.selfAssessment.readiness.plannerInputReady,
      plannerParallelismHint: input.plannerPolicy.decision.parallelismHint,
      recommendedRoles: input.plannerPolicy.decision.recommendedSubagents.map((agent) => agent.role),
    },
    review: {
      workerMatches: input.selfAssessment.workerId === input.plannerPolicy.host.workerId,
      taskMatches: (input.selfAssessment.task?.taskId ?? "") === (input.plannerPolicy.task.taskId ?? ""),
      plannerInputMatches: plannerInputMatches(input.selfAssessment, input.plannerPolicy),
      sourceBoundariesIntact: sourceBoundariesIntact(input.selfAssessment, input.plannerPolicy),
      finalizerRequired: true,
      evidenceOnlySubagents: true,
      writeSetIsolationRequired: true,
      directExecutionEscapeHatch: true,
      blockers,
      nextAction: state === "ready_for_finalizer_review"
        ? "finalizer may review this handoff before any separate subagent spawn runtime gate"
        : "resolve handoff blockers before finalizer review",
    },
    boundaries: {
      sourceOnly: true,
      liveHostProbe: false,
      plannerRouteCall: false,
      actualSubagentSpawn: false,
      runtimeBehaviorChanged: false,
      mandatoryProductionSpawn: false,
      brokerDispatch: false,
      workerClaim: false,
      executorInvocation: false,
      processSpawn: false,
      taskFlowMutation: false,
      dbMutation: false,
      deployOrRestart: false,
      providerSend: false,
      terminalAckOrReplay: false,
      releaseOrPublish: false,
      secretMovement: false,
    },
  };
}

export function extractA2AWorkerSubagentPlannerHandoffInput(input: unknown): A2AWorkerSubagentPlannerHandoffInput {
  const envelope = isRecord(input) ? input : {};
  const candidate = isRecord(envelope.workerSubagentPlannerHandoff)
    ? envelope.workerSubagentPlannerHandoff
    : isRecord(envelope.plannerHandoff)
      ? envelope.plannerHandoff
      : envelope;
  if (!isRecord(candidate)) throw new Error("worker subagent planner handoff input must be an object");
  const selfAssessment = findSelfAssessment(candidate);
  const plannerPolicy = findPlannerPolicy(candidate);
  if (!selfAssessment) throw new Error("worker subagent planner handoff requires worker self-assessment packet");
  if (!plannerPolicy) throw new Error("worker subagent planner handoff requires planner policy packet");
  return {
    now: optionalString(candidate.now),
    finalizer: optionalString(candidate.finalizer),
    selfAssessment,
    plannerPolicy,
  };
}

export function renderA2AWorkerSubagentPlannerHandoffMarkdown(packet: A2AWorkerSubagentPlannerHandoffPacket): string {
  return [
    "A2A worker subagent planner handoff",
    "State: " + packet.state,
    "Worker: " + packet.workerId,
    "Task: " + (packet.taskId ?? "unknown"),
    "Finalizer: " + packet.finalizer,
    "Parallelism hint: " + packet.source.plannerParallelismHint,
    "Roles: " + (packet.source.recommendedRoles.join(",") || "direct"),
    "Blockers: " + (packet.review.blockers.join("; ") || "none"),
    "Safety: source-only handoff; no live probe, planner route call, subagent spawn, dispatch, DB/TaskFlow mutation, deploy/restart, provider send, terminal ACK/replay, release/publish, or secret movement.",
  ].join("\n");
}

function buildBlockers(
  selfAssessment: A2AWorkerSelfAssessmentCapacityPacket,
  plannerPolicy: A2AWorkerSubagentPolicyPacket,
): string[] {
  const blockers = [];
  if (!selfAssessment.readiness.plannerInputReady) blockers.push("self-assessment plannerInput is not ready");
  if (selfAssessment.workerId !== plannerPolicy.host.workerId) blockers.push("planner policy worker does not match self-assessment worker");
  if ((selfAssessment.task?.taskId ?? "") !== (plannerPolicy.task.taskId ?? "")) blockers.push("planner policy task does not match self-assessment task");
  if (!plannerInputMatches(selfAssessment, plannerPolicy)) blockers.push("planner policy does not match self-assessment plannerInput");
  if (!sourceBoundariesIntact(selfAssessment, plannerPolicy)) blockers.push("source-only/no-runtime boundaries are not intact");
  return blockers;
}

function plannerInputMatches(
  selfAssessment: A2AWorkerSelfAssessmentCapacityPacket,
  plannerPolicy: A2AWorkerSubagentPolicyPacket,
): boolean {
  const input = selfAssessment.plannerInput;
  if (!input) return false;
  return stableComparable(input.task) === stableComparable(plannerPolicy.task)
    && stableComparable(input.host) === stableComparable(plannerPolicy.host);
}

function sourceBoundariesIntact(
  selfAssessment: A2AWorkerSelfAssessmentCapacityPacket,
  plannerPolicy: A2AWorkerSubagentPolicyPacket,
): boolean {
  return selfAssessment.sourceOnly === true
    && selfAssessment.boundaries.liveHostProbe === false
    && selfAssessment.boundaries.plannerRouteCall === false
    && selfAssessment.boundaries.actualSubagentSpawn === false
    && selfAssessment.boundaries.brokerDispatch === false
    && selfAssessment.boundaries.dbMutation === false
    && plannerPolicy.sourceOnlyPolicy === true
    && plannerPolicy.decision.evidenceOnlySubagents === true
    && plannerPolicy.decision.oneFinalizerRequired === true
    && plannerPolicy.boundaries.runtimeBehaviorChanged === false
    && plannerPolicy.boundaries.mandatoryProductionSpawn === false
    && plannerPolicy.boundaries.brokerDispatchSemanticsChanged === false
    && plannerPolicy.boundaries.taskFlowMutation === false
    && plannerPolicy.boundaries.dbMutation === false;
}

function findSelfAssessment(input: Record<string, unknown>): A2AWorkerSelfAssessmentCapacityPacket | undefined {
  const candidates = [input.selfAssessment, input.workerSelfAssessment, input.workerSelfAssessmentCapacity, input.selfAssessmentPacket];
  return candidates.find(isSelfAssessmentPacket);
}

function findPlannerPolicy(input: Record<string, unknown>): A2AWorkerSubagentPolicyPacket | undefined {
  const candidates = [input.plannerPolicy, input.workerSubagentPolicy, input.workerSubagentOrchestrationPolicy, input.plannerPolicyPacket];
  return candidates.find(isPlannerPolicyPacket);
}

function isSelfAssessmentPacket(value: unknown): value is A2AWorkerSelfAssessmentCapacityPacket {
  return isRecord(value) && value.kind === "a2a-broker.worker-self-assessment-capacity.packet";
}

function isPlannerPolicyPacket(value: unknown): value is A2AWorkerSubagentPolicyPacket {
  return isRecord(value) && value.kind === "a2a-broker.worker-subagent-orchestration-policy.packet";
}

function buildHandoffId(input: A2AWorkerSubagentPlannerHandoffInput, generatedAt: string, state: string): string {
  const base = JSON.stringify({
    generatedAt,
    state,
    selfAssessment: input.selfAssessment.idempotencyKey,
    plannerPolicy: input.plannerPolicy.idempotencyKey,
    finalizer: input.finalizer,
  });
  return "a2a-worker-subagent-planner-handoff:" + createHash("sha256").update(base).digest("hex").slice(0, 24);
}

function stableComparable(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sortValue(item)]));
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
