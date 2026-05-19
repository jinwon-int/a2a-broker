import { createHash } from "node:crypto";

export type A2AWorkerTaskSize = "trivial" | "small" | "medium" | "large";
export type A2AWorkerTaskCoupling = "low" | "medium" | "high";
export type A2ASubagentRole = "explorer" | "implementer" | "verifier";

export interface A2AWorkerSubagentTaskProfile {
  taskId?: string;
  size: A2AWorkerTaskSize;
  coupling: A2AWorkerTaskCoupling;
  sensitive?: boolean;
  urgent?: boolean;
  hasIndependentSubtasks?: boolean;
  writeSets?: string[];
  requiresSingleDesignDecision?: boolean;
}

export interface A2AWorkerSubagentHostSnapshot {
  workerId: string;
  cpuLoadPct?: number;
  memoryUsedPct?: number;
  ioPressure?: "low" | "medium" | "high";
  eventLoopDegraded?: boolean;
  gatewayPressure?: "low" | "medium" | "high";
  activeSubagents?: number;
  workerSubagentCap?: number;
  brokerActiveSubagents?: number;
  brokerSubagentCap?: number;
}

export interface A2AWorkerSubagentPolicyInput {
  now?: string;
  task: A2AWorkerSubagentTaskProfile;
  host: A2AWorkerSubagentHostSnapshot;
}

export interface A2AWorkerSubagentPolicyPacket {
  kind: "a2a-broker.worker-subagent-orchestration-policy.packet";
  version: 1;
  generatedAt: string;
  sourceOnlyPolicy: true;
  idempotencyKey: string;
  task: A2AWorkerSubagentTaskProfile;
  host: A2AWorkerSubagentHostSnapshot;
  decision: {
    parallelismHint: 0 | 1 | 2 | 3;
    recommendedSubagents: Array<{ role: A2ASubagentRole; purpose: string; writeSet?: string }>;
    directExecutionAllowed: boolean;
    oneFinalizerRequired: true;
    finalizerOwner: "worker-or-broker";
    evidenceOnlySubagents: true;
    writeSetIsolationRequired: true;
    escapeHatchAllowed: true;
  };
  resourceGate: {
    cpuOk: boolean;
    memoryOk: boolean;
    ioOk: boolean;
    eventLoopOk: boolean;
    gatewayOk: boolean;
    workerCapOk: boolean;
    brokerCapOk: boolean;
    reducedBy: string[];
  };
  boundaries: {
    runtimeBehaviorChanged: false;
    mandatoryProductionSpawn: false;
    brokerDispatchSemanticsChanged: false;
    taskFlowMutation: false;
    dbMutation: false;
    deployOrRestart: false;
    secretMovement: false;
  };
  nextAction: string;
}

export function extractA2AWorkerSubagentPolicyInput(input: unknown): A2AWorkerSubagentPolicyInput {
  const envelope = isRecord(input) ? input : {};
  const candidate = isRecord(envelope.workerSubagentPolicy)
    ? envelope.workerSubagentPolicy
    : isRecord(envelope.workerSubagentOrchestrationPolicy)
      ? envelope.workerSubagentOrchestrationPolicy
      : envelope;
  if (!isRecord(candidate)) {
    throw new Error("worker subagent orchestration policy input must be an object");
  }
  const task = extractTaskProfile(candidate.task);
  const host = extractHostSnapshot(candidate.host);
  return {
    now: optionalString(candidate.now),
    task,
    host,
  };
}

export function buildA2AWorkerSubagentOrchestrationPolicy(input: A2AWorkerSubagentPolicyInput): A2AWorkerSubagentPolicyPacket {
  const generatedAt = input.now ?? new Date().toISOString();
  const resourceGate = buildResourceGate(input.host);
  const taskCeiling = taskParallelismCeiling(input.task);
  const workerRemaining = (input.host.workerSubagentCap ?? 2) - (input.host.activeSubagents ?? 0);
  const brokerRemaining = (input.host.brokerSubagentCap ?? 12) - (input.host.brokerActiveSubagents ?? 0);
  const capCeiling = Math.max(0, Math.min(input.host.workerSubagentCap ?? 2, workerRemaining, brokerRemaining));
  const resourceCeiling = resourceGate.reducedBy.length ? resourceReducedCeiling(resourceGate.reducedBy) : 3;
  const parallelismHint = clampParallelism(Math.min(taskCeiling, capCeiling, resourceCeiling));
  const recommendedSubagents = rolesFor(input.task, parallelismHint);

  return {
    kind: "a2a-broker.worker-subagent-orchestration-policy.packet",
    version: 1,
    generatedAt,
    sourceOnlyPolicy: true,
    idempotencyKey: buildPolicyId(input, generatedAt, parallelismHint),
    task: input.task,
    host: input.host,
    decision: {
      parallelismHint,
      recommendedSubagents,
      directExecutionAllowed: true,
      oneFinalizerRequired: true,
      finalizerOwner: "worker-or-broker",
      evidenceOnlySubagents: true,
      writeSetIsolationRequired: true,
      escapeHatchAllowed: true,
    },
    resourceGate,
    boundaries: {
      runtimeBehaviorChanged: false,
      mandatoryProductionSpawn: false,
      brokerDispatchSemanticsChanged: false,
      taskFlowMutation: false,
      dbMutation: false,
      deployOrRestart: false,
      secretMovement: false,
    },
    nextAction: nextActionFor(parallelismHint, resourceGate.reducedBy),
  };
}

export function renderA2AWorkerSubagentOrchestrationPolicyMarkdown(packet: A2AWorkerSubagentPolicyPacket): string {
  return [
    "A2A worker subagent orchestration policy",
    "Worker: " + packet.host.workerId,
    "Task size/coupling: " + packet.task.size + "/" + packet.task.coupling,
    "Parallelism hint: " + packet.decision.parallelismHint,
    "Roles: " + (packet.decision.recommendedSubagents.map((agent) => agent.role + (agent.writeSet ? ":" + agent.writeSet : "")).join(", ") || "direct"),
    "Reduced by: " + (packet.resourceGate.reducedBy.join(", ") || "none"),
    "Finalizer: one " + packet.decision.finalizerOwner,
    "Safety: source-only policy; no mandatory production spawn, broker dispatch semantic change, TaskFlow/DB mutation, deploy/restart, or secret movement.",
  ].join("\n");
}

function taskParallelismCeiling(task: A2AWorkerSubagentTaskProfile): number {
  if (task.sensitive || task.urgent || task.size === "trivial" || task.coupling === "high") return 0;
  if (task.requiresSingleDesignDecision) return 1;
  if (task.size === "small") return 1;
  if (task.size === "medium") return task.hasIndependentSubtasks ? 2 : 1;
  if (!task.hasIndependentSubtasks) return 1;
  return hasOverlappingWriteSets(task.writeSets ?? []) ? 2 : 3;
}

function extractTaskProfile(value: unknown): A2AWorkerSubagentTaskProfile {
  if (!isRecord(value)) throw new Error("worker subagent policy input requires task");
  const size = enumValue(value.size, ["trivial", "small", "medium", "large"]);
  const coupling = enumValue(value.coupling, ["low", "medium", "high"]);
  if (!size) throw new Error("worker subagent policy task.size must be trivial, small, medium, or large");
  if (!coupling) throw new Error("worker subagent policy task.coupling must be low, medium, or high");
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

function extractHostSnapshot(value: unknown): A2AWorkerSubagentHostSnapshot {
  if (!isRecord(value)) throw new Error("worker subagent policy input requires host");
  const workerId = optionalString(value.workerId ?? value.worker_id);
  if (!workerId) throw new Error("worker subagent policy host.workerId is required");
  return {
    workerId,
    cpuLoadPct: numberValue(value.cpuLoadPct ?? value.cpu_load_pct),
    memoryUsedPct: numberValue(value.memoryUsedPct ?? value.memory_used_pct),
    ioPressure: enumValue(value.ioPressure ?? value.io_pressure, ["low", "medium", "high"]),
    eventLoopDegraded: optionalBoolean(value.eventLoopDegraded ?? value.event_loop_degraded),
    gatewayPressure: enumValue(value.gatewayPressure ?? value.gateway_pressure, ["low", "medium", "high"]),
    activeSubagents: numberValue(value.activeSubagents ?? value.active_subagents),
    workerSubagentCap: numberValue(value.workerSubagentCap ?? value.worker_subagent_cap),
    brokerActiveSubagents: numberValue(value.brokerActiveSubagents ?? value.broker_active_subagents),
    brokerSubagentCap: numberValue(value.brokerSubagentCap ?? value.broker_subagent_cap),
  };
}

function buildResourceGate(host: A2AWorkerSubagentHostSnapshot): A2AWorkerSubagentPolicyPacket["resourceGate"] {
  const cpuOk = (host.cpuLoadPct ?? 0) < 75;
  const memoryOk = (host.memoryUsedPct ?? 0) < 80;
  const ioOk = (host.ioPressure ?? "low") !== "high";
  const eventLoopOk = host.eventLoopDegraded !== true;
  const gatewayOk = (host.gatewayPressure ?? "low") !== "high";
  const workerCapOk = (host.activeSubagents ?? 0) < (host.workerSubagentCap ?? 2);
  const brokerCapOk = (host.brokerActiveSubagents ?? 0) < (host.brokerSubagentCap ?? 12);
  const reducedBy = [
    ...(!cpuOk ? ["cpu_load"] : []),
    ...(!memoryOk ? ["memory_pressure"] : []),
    ...(!ioOk ? ["io_pressure"] : []),
    ...(!eventLoopOk ? ["event_loop_degraded"] : []),
    ...(!gatewayOk ? ["gateway_pressure"] : []),
    ...(!workerCapOk ? ["worker_cap"] : []),
    ...(!brokerCapOk ? ["broker_cap"] : []),
  ];
  return { cpuOk, memoryOk, ioOk, eventLoopOk, gatewayOk, workerCapOk, brokerCapOk, reducedBy };
}

function resourceReducedCeiling(reducedBy: string[]): number {
  if (reducedBy.some((reason) => ["memory_pressure", "event_loop_degraded", "gateway_pressure", "worker_cap", "broker_cap"].includes(reason))) return 0;
  if (reducedBy.includes("cpu_load") || reducedBy.includes("io_pressure")) return 1;
  return 2;
}

function rolesFor(task: A2AWorkerSubagentTaskProfile, count: 0 | 1 | 2 | 3): A2AWorkerSubagentPolicyPacket["decision"]["recommendedSubagents"] {
  if (count === 0) return [];
  if (count === 1) return [{ role: "verifier", purpose: "parallel risk/test review" }];
  if (count === 2) return [
    { role: "explorer", purpose: "bounded code and issue investigation" },
    { role: "verifier", purpose: "test and risk review" },
  ];
  const writeSets = task.writeSets ?? [];
  return [
    { role: "explorer", purpose: "bounded code and issue investigation" },
    { role: "implementer", purpose: "scoped implementation", writeSet: writeSets[0] ?? "assigned-disjoint-write-set" },
    { role: "verifier", purpose: "test and risk review" },
  ];
}

function hasOverlappingWriteSets(writeSets: string[]): boolean {
  return new Set(writeSets).size !== writeSets.length;
}

function clampParallelism(value: number): 0 | 1 | 2 | 3 {
  if (value <= 0) return 0;
  if (value === 1) return 1;
  if (value === 2) return 2;
  return 3;
}

function nextActionFor(parallelismHint: number, reducedBy: string[]): string {
  if (parallelismHint === 0 && reducedBy.length) return "run direct or wait for host capacity before spawning subagents";
  if (parallelismHint === 0) return "run direct; task shape does not justify subagent overhead";
  return "spawn recommended evidence-only subagents while preserving a single finalizer";
}

function buildPolicyId(input: A2AWorkerSubagentPolicyInput, generatedAt: string, parallelismHint: number): string {
  const base = JSON.stringify({ input, generatedAt, parallelismHint });
  return "a2a-worker-subagent-policy:" + createHash("sha256").update(base).digest("hex").slice(0, 24);
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
