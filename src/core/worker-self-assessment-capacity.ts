import { createHash } from "node:crypto";

import type {
  A2AWorkerSubagentHostSnapshot,
  A2AWorkerSubagentTaskProfile,
  A2AWorkerSubagentPolicyInput,
} from "./worker-subagent-orchestration-policy.js";

export interface A2AWorkerSelfAssessmentCapacityInput {
  now?: string;
  workerId: string;
  task?: A2AWorkerSubagentTaskProfile;
  host: Omit<A2AWorkerSubagentHostSnapshot, "workerId">;
  source?: {
    collector?: string;
    observedAt?: string;
    note?: string;
  };
}

export interface A2AWorkerSelfAssessmentCapacityPacket {
  kind: "a2a-broker.worker-self-assessment-capacity.packet";
  version: 1;
  generatedAt: string;
  sourceOnly: true;
  idempotencyKey: string;
  workerId: string;
  task?: A2AWorkerSubagentTaskProfile;
  host: A2AWorkerSubagentHostSnapshot;
  source: {
    collector?: string;
    observedAt?: string;
    note?: string;
    suppliedSnapshotOnly: true;
    probesHost: false;
    probesGateway: false;
  };
  plannerInput?: A2AWorkerSubagentPolicyInput;
  readiness: {
    plannerInputReady: boolean;
    missing: string[];
    nextAction: string;
  };
  boundaries: {
    sourceOnly: true;
    liveHostProbe: false;
    plannerRouteCall: false;
    runtimeBehaviorChanged: false;
    mandatoryProductionSpawn: false;
    actualSubagentSpawn: false;
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

export function buildA2AWorkerSelfAssessmentCapacity(
  input: A2AWorkerSelfAssessmentCapacityInput,
): A2AWorkerSelfAssessmentCapacityPacket {
  const generatedAt = input.now ?? new Date().toISOString();
  const host: A2AWorkerSubagentHostSnapshot = {
    workerId: input.workerId,
    ...input.host,
  };
  const missing = missingFields(input, host);
  const plannerInput = input.task && missing.length === 0
    ? { now: generatedAt, task: input.task, host }
    : undefined;
  return {
    kind: "a2a-broker.worker-self-assessment-capacity.packet",
    version: 1,
    generatedAt,
    sourceOnly: true,
    idempotencyKey: buildSelfAssessmentId(input, host, generatedAt),
    workerId: input.workerId,
    task: input.task,
    host,
    source: {
      collector: input.source?.collector,
      observedAt: input.source?.observedAt,
      note: input.source?.note,
      suppliedSnapshotOnly: true,
      probesHost: false,
      probesGateway: false,
    },
    plannerInput,
    readiness: {
      plannerInputReady: plannerInput !== undefined,
      missing,
      nextAction: plannerInput
        ? "submit plannerInput to POST /workers/subagent-orchestration/plan for a read-only recommendation"
        : "supply missing task or host capacity fields before planner route review",
    },
    boundaries: {
      sourceOnly: true,
      liveHostProbe: false,
      plannerRouteCall: false,
      runtimeBehaviorChanged: false,
      mandatoryProductionSpawn: false,
      actualSubagentSpawn: false,
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

export function extractA2AWorkerSelfAssessmentCapacityInput(input: unknown): A2AWorkerSelfAssessmentCapacityInput {
  const envelope = isRecord(input) ? input : {};
  const candidate = isRecord(envelope.workerSelfAssessment)
    ? envelope.workerSelfAssessment
    : isRecord(envelope.workerSelfAssessmentCapacity)
      ? envelope.workerSelfAssessmentCapacity
      : envelope;
  if (!isRecord(candidate)) {
    throw new Error("worker self-assessment capacity input must be an object");
  }
  const workerId = optionalString(candidate.workerId ?? candidate.worker_id);
  if (!workerId) throw new Error("worker self-assessment requires workerId");
  const hostInput = isRecord(candidate.host) ? candidate.host : candidate;
  return {
    now: optionalString(candidate.now),
    workerId,
    task: isRecord(candidate.task) ? extractTaskProfile(candidate.task) : undefined,
    host: {
      cpuLoadPct: numberValue(hostInput.cpuLoadPct ?? hostInput.cpu_load_pct),
      memoryUsedPct: numberValue(hostInput.memoryUsedPct ?? hostInput.memory_used_pct),
      ioPressure: enumValue(hostInput.ioPressure ?? hostInput.io_pressure, ["low", "medium", "high"]),
      eventLoopDegraded: optionalBoolean(hostInput.eventLoopDegraded ?? hostInput.event_loop_degraded),
      gatewayPressure: enumValue(hostInput.gatewayPressure ?? hostInput.gateway_pressure, ["low", "medium", "high"]),
      activeSubagents: numberValue(hostInput.activeSubagents ?? hostInput.active_subagents),
      workerSubagentCap: numberValue(hostInput.workerSubagentCap ?? hostInput.worker_subagent_cap),
      brokerActiveSubagents: numberValue(hostInput.brokerActiveSubagents ?? hostInput.broker_active_subagents),
      brokerSubagentCap: numberValue(hostInput.brokerSubagentCap ?? hostInput.broker_subagent_cap),
    },
    source: isRecord(candidate.source)
      ? {
          collector: optionalString(candidate.source.collector),
          observedAt: optionalString(candidate.source.observedAt ?? candidate.source.observed_at),
          note: optionalString(candidate.source.note),
        }
      : undefined,
  };
}

export function renderA2AWorkerSelfAssessmentCapacityMarkdown(packet: A2AWorkerSelfAssessmentCapacityPacket): string {
  return [
    "A2A worker self-assessment capacity packet",
    "Worker: " + packet.workerId,
    "Generated: " + packet.generatedAt,
    "Planner input ready: " + packet.readiness.plannerInputReady,
    "Missing: " + (packet.readiness.missing.join(", ") || "none"),
    "Capacity: cpu=" + valueOrUnknown(packet.host.cpuLoadPct)
      + " memory=" + valueOrUnknown(packet.host.memoryUsedPct)
      + " io=" + (packet.host.ioPressure ?? "unknown")
      + " gateway=" + (packet.host.gatewayPressure ?? "unknown")
      + " activeSubagents=" + valueOrUnknown(packet.host.activeSubagents)
      + " workerCap=" + valueOrUnknown(packet.host.workerSubagentCap)
      + " brokerCap=" + valueOrUnknown(packet.host.brokerSubagentCap),
    "Safety: source-only supplied snapshot; no live host probe, planner route call, subagent spawn, dispatch, DB/TaskFlow mutation, deploy/restart, provider send, terminal ACK/replay, release/publish, or secret movement.",
  ].join("\n");
}

function missingFields(input: A2AWorkerSelfAssessmentCapacityInput, host: A2AWorkerSubagentHostSnapshot): string[] {
  const missing = [];
  if (!input.task) missing.push("task");
  if (host.cpuLoadPct === undefined) missing.push("host.cpuLoadPct");
  if (host.memoryUsedPct === undefined) missing.push("host.memoryUsedPct");
  if (host.activeSubagents === undefined) missing.push("host.activeSubagents");
  if (host.workerSubagentCap === undefined) missing.push("host.workerSubagentCap");
  if (host.brokerActiveSubagents === undefined) missing.push("host.brokerActiveSubagents");
  if (host.brokerSubagentCap === undefined) missing.push("host.brokerSubagentCap");
  return missing;
}

function extractTaskProfile(value: Record<string, unknown>): A2AWorkerSubagentTaskProfile {
  const size = enumValue(value.size, ["trivial", "small", "medium", "large"]);
  const coupling = enumValue(value.coupling, ["low", "medium", "high"]);
  if (!size) throw new Error("worker self-assessment task.size must be trivial, small, medium, or large");
  if (!coupling) throw new Error("worker self-assessment task.coupling must be low, medium, or high");
  return {
    taskId: optionalString(value.taskId ?? value.task_id),
    size,
    coupling,
    sensitive: optionalBoolean(value.sensitive),
    urgent: optionalBoolean(value.urgent),
    hasIndependentSubtasks: optionalBoolean(value.hasIndependentSubtasks ?? value.has_independent_subtasks),
    writeSets: stringList(value.writeSets ?? value.write_sets),
    requiresSingleDesignDecision: optionalBoolean(value.requiresSingleDesignDecision ?? value.requires_single_design_decision),
  };
}

function buildSelfAssessmentId(
  input: A2AWorkerSelfAssessmentCapacityInput,
  host: A2AWorkerSubagentHostSnapshot,
  generatedAt: string,
): string {
  const base = JSON.stringify({ input, host, generatedAt });
  return "a2a-worker-self-assessment:" + createHash("sha256").update(base).digest("hex").slice(0, 24);
}

function valueOrUnknown(value: unknown): string {
  return value === undefined ? "unknown" : String(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as T : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
