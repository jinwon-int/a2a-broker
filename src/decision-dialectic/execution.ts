import { BrokerError } from "../core/broker.js";
import type { A2APartyRole, CreateTaskRequest, TaskRecord } from "../core/types.js";
import { buildDecisionDialecticPromptSpec } from "./prompt-spec.js";
import {
  DECISION_DIALECTIC_KIND,
  DECISION_DIALECTIC_VERSION,
  type DecisionDialecticAgentRef,
  type DecisionDialecticPatchErrorCode,
  type DecisionDialecticPatchV1,
  type DecisionDialecticPhase,
  type DecisionDialecticTaskInputV1,
  type DecisionDialecticTaskV1,
  type DecisionDialecticVerdict,
} from "./types.js";

const DecisionDialecticPhases = ["thesis", "antithesis", "rebuttal", "synthesis", "outcome"] as const;
const TerminalDecisionStates = new Set<DecisionDialecticTaskV1["state"]>([
  "DECISION_ROUTED",
  "ABSTAINED",
  "VETOED",
  "SETTLED",
  "EXPIRED",
  "CANCELLED",
  "FAILED",
]);

export class DecisionDialecticExecutionError extends Error {
  constructor(
    public readonly code: DecisionDialecticPatchErrorCode | "missing_contract" | "wrong_kind" | "invalid_contract",
    message: string,
  ) {
    super(message);
    this.name = "DecisionDialecticExecutionError";
  }
}

export function extractDecisionDialecticTaskInput(payload: Record<string, unknown>): DecisionDialecticTaskInputV1 {
  const contract = (payload as { contract?: Record<string, unknown> }).contract;
  if (!contract || typeof contract !== "object") {
    throw new DecisionDialecticExecutionError(
      "missing_contract",
      "task payload does not include a decision.dialectic contract",
    );
  }
  if (contract.kind !== DECISION_DIALECTIC_KIND || contract.version !== DECISION_DIALECTIC_VERSION) {
    throw new DecisionDialecticExecutionError("wrong_kind", "task payload contract is not decision.dialectic v1");
  }
  if (!isDecisionDialecticPhase(contract.phase)) {
    throw new DecisionDialecticExecutionError("invalid_contract", "decision.dialectic contract has invalid phase");
  }
  if (!contract.task || typeof contract.task !== "object") {
    throw new DecisionDialecticExecutionError("invalid_contract", "decision.dialectic contract is missing task body");
  }
  return {
    contract: {
      kind: DECISION_DIALECTIC_KIND,
      version: DECISION_DIALECTIC_VERSION,
      phase: contract.phase,
      task: contract.task as DecisionDialecticTaskV1,
    },
  };
}

export function nextDecisionDialecticPhase(task: DecisionDialecticTaskV1): DecisionDialecticPhase | null {
  if (!task.thesis) {
    return "thesis";
  }
  if (!task.antithesis) {
    return "antithesis";
  }
  if (!task.rebuttal) {
    return "rebuttal";
  }
  if (!task.synthesis || !task.decision) {
    return "synthesis";
  }
  if (!task.outcome) {
    return "outcome";
  }
  return null;
}

export function buildDecisionDialecticPhaseTaskRequest(
  parentTask: TaskRecord,
  options: {
    id?: string;
    phase?: DecisionDialecticPhase;
    requesterId?: string;
  } = {},
): { phase: DecisionDialecticPhase; request: CreateTaskRequest } {
  const input = extractDecisionDialecticTaskInput(parentTask.payload);
  const dialectic = input.contract.task;
  const nextPhase = nextDecisionDialecticPhase(dialectic);
  const phase = options.phase ?? nextPhase;
  if (!phase) {
    throw new BrokerError("invalid_transition", "decision.dialectic round already has all phases");
  }
  if (options.phase && options.phase !== nextPhase) {
    throw new BrokerError("invalid_transition", "next decision.dialectic phase is " + String(nextPhase));
  }

  const agent = phaseAgent(dialectic, phase);
  const nodeId = agent.nodeId ?? agent.agentId;
  const role = partyRole(agent.roleHint);
  const promptSpec = buildDecisionDialecticPromptSpec({ phase, agent, domain: dialectic.meta.domain });
  const id = options.id ?? dialectic.taskId + ":" + phase + ":" + dialectic.revision;

  return {
    phase,
    request: {
      id,
      parentTaskId: parentTask.id,
      referenceTaskIds: [parentTask.id],
      requester: { id: options.requesterId ?? parentTask.requester.id, kind: "node", role: "hub" },
      target: { id: nodeId, kind: "node", role },
      assignedWorkerId: nodeId,
      intent: "analyze",
      message: "decision.dialectic " + phase + " phase for " + dialectic.meta.topic,
      payload: {
        contract: {
          kind: DECISION_DIALECTIC_KIND,
          version: DECISION_DIALECTIC_VERSION,
          phase,
          task: dialectic,
        },
        promptSpec,
        execution: {
          parentTaskId: parentTask.id,
          taskId: dialectic.taskId,
          expectedRevision: dialectic.revision,
          phase,
        },
      },
      taskOrigin: "operator",
      brokerOfRecord: parentTask.brokerOfRecord,
      teamId: parentTask.teamId,
    },
  };
}

export function applyDecisionDialecticPatch(
  task: DecisionDialecticTaskV1,
  patch: DecisionDialecticPatchV1,
): DecisionDialecticTaskV1 {
  if (patch.taskId !== task.taskId) {
    throw new DecisionDialecticExecutionError("task_id_mismatch", "patch taskId does not match decision.dialectic taskId");
  }
  if (patch.expectedRevision !== task.revision) {
    throw new DecisionDialecticExecutionError("revision_conflict", "patch expectedRevision does not match current revision");
  }
  if (TerminalDecisionStates.has(task.state) && patch.op !== "append.outcome") {
    throw new DecisionDialecticExecutionError("task_terminal", "cannot apply " + patch.op + " while state is " + task.state);
  }

  const next = structuredClone(task);
  switch (patch.op) {
    case "append.thesis":
      assertAuthor(patch.authorAgent, next.roles.thesisAgent);
      assertMissing(next.thesis, "duplicate_phase", "thesis already submitted");
      next.thesis = patch.payload;
      next.state = "THESIS_SUBMITTED";
      break;
    case "append.antithesis":
      assertAuthor(patch.authorAgent, next.roles.antithesisAgent);
      assertPresent(next.thesis, "missing_prerequisite", "thesis is required before antithesis");
      assertMissing(next.antithesis, "duplicate_phase", "antithesis already submitted");
      next.antithesis = patch.payload;
      next.state = "ANTITHESIS_SUBMITTED";
      break;
    case "append.rebuttal":
      assertAuthor(patch.authorAgent, next.roles.rebuttalAgent ?? next.roles.thesisAgent);
      assertPresent(next.antithesis, "missing_prerequisite", "antithesis is required before rebuttal");
      assertMissing(next.rebuttal, "duplicate_phase", "rebuttal already submitted");
      next.rebuttal = patch.payload;
      next.state = "REBUTTAL_SUBMITTED";
      break;
    case "set.synthesis_decision":
      assertAuthor(patch.authorAgent, next.roles.synthAgent);
      assertPresent(next.thesis, "missing_prerequisite", "thesis is required before synthesis");
      assertPresent(next.antithesis, "missing_prerequisite", "antithesis is required before synthesis");
      assertPresent(next.rebuttal, "missing_prerequisite", "rebuttal is required before synthesis");
      assertMissing(next.synthesis, "duplicate_phase", "synthesis already submitted");
      if (patch.payload.synthesis.verdict !== patch.payload.decision.action) {
        throw new DecisionDialecticExecutionError(
          "verdict_policy_violation",
          "synthesis verdict must match decision action",
        );
      }
      if (patch.payload.decision.decisionBasisRevision !== next.revision) {
        throw new DecisionDialecticExecutionError(
          "decision_basis_mismatch",
          "decision basis revision must match the current revision",
        );
      }
      assertHardVetoPolicy(next, patch.payload.decision.action, patch.payload.decision.hardVeto);
      next.synthesis = patch.payload.synthesis;
      next.decision = patch.payload.decision;
      next.state = stateForVerdict(patch.payload.decision.action);
      break;
    case "append.outcome":
      assertPresent(next.decision, "missing_prerequisite", "decision is required before outcome");
      assertMissing(next.outcome, "duplicate_phase", "outcome already submitted");
      if (patch.payload.decisionBasisRevision !== next.revision) {
        throw new DecisionDialecticExecutionError(
          "decision_basis_mismatch",
          "outcome decisionBasisRevision must match the current revision",
        );
      }
      next.outcome = patch.payload;
      next.state = "SETTLED";
      break;
  }
  next.revision += 1;
  return next;
}

function isDecisionDialecticPhase(value: unknown): value is DecisionDialecticPhase {
  return typeof value === "string" && DecisionDialecticPhases.includes(value as DecisionDialecticPhase);
}

function phaseAgent(task: DecisionDialecticTaskV1, phase: DecisionDialecticPhase): DecisionDialecticAgentRef {
  if (phase === "thesis") {
    return task.roles.thesisAgent;
  }
  if (phase === "antithesis") {
    return task.roles.antithesisAgent;
  }
  if (phase === "rebuttal") {
    return task.roles.rebuttalAgent ?? task.roles.thesisAgent;
  }
  return task.roles.synthAgent;
}

function partyRole(roleHint: string | undefined): A2APartyRole {
  if (roleHint === "hub" || roleHint === "operator" || roleHint === "live-trader" || roleHint === "researcher") {
    return roleHint;
  }
  return "analyst";
}

function assertAuthor(authorAgent: string, expected: DecisionDialecticAgentRef): void {
  if (authorAgent !== expected.agentId && authorAgent !== expected.nodeId) {
    throw new DecisionDialecticExecutionError(
      "author_not_allowed",
      "author " + authorAgent + " is not allowed for this decision.dialectic phase",
    );
  }
}

function assertPresent<T>(
  value: T | undefined,
  code: DecisionDialecticPatchErrorCode,
  message: string,
): asserts value is T {
  if (value === undefined) {
    throw new DecisionDialecticExecutionError(code, message);
  }
}

function assertMissing(value: unknown, code: DecisionDialecticPatchErrorCode, message: string): void {
  if (value !== undefined) {
    throw new DecisionDialecticExecutionError(code, message);
  }
}

function assertHardVetoPolicy(
  task: DecisionDialecticTaskV1,
  action: DecisionDialecticVerdict,
  hardVeto: boolean,
): void {
  const hasBlocker = task.antithesis?.vetoFlags.some((flag) => flag.severity === "blocker") ?? false;
  if (!hasBlocker) {
    return;
  }
  if (action !== "VETO" || hardVeto !== true) {
    throw new DecisionDialecticExecutionError(
      "hard_veto_required",
      "blocker veto flags require decision.action=VETO and hardVeto=true",
    );
  }
}

function stateForVerdict(verdict: DecisionDialecticVerdict): DecisionDialecticTaskV1["state"] {
  if (verdict === "WAIT") {
    return "WAITING";
  }
  if (verdict === "ABSTAIN") {
    return "ABSTAINED";
  }
  if (verdict === "VETO") {
    return "VETOED";
  }
  return "DECISION_ROUTED";
}
