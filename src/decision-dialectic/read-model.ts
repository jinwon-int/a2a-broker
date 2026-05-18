import type { TaskRecord } from "../core/types.js";
import {
  summarizeDecisionDialecticDecision,
  summarizeDecisionDialecticTask,
} from "./summary.js";
import {
  DECISION_DIALECTIC_KIND,
  DECISION_DIALECTIC_VERSION,
  type DecisionDialecticAgentRef,
  type DecisionDialecticAntithesisV1,
  type DecisionDialecticContextV1,
  type DecisionDialecticDecisionV1,
  type DecisionDialecticMetaV1,
  type DecisionDialecticOutcomeV1,
  type DecisionDialecticPhase,
  type DecisionDialecticRebuttalV1,
  type DecisionDialecticState,
  type DecisionDialecticSynthesisV1,
  type DecisionDialecticTaskV1,
  type DecisionDialecticThesisV1,
  type DecisionDialecticVerdict,
  type DecisionDialecticVetoFlagV1,
} from "./types.js";

export type DecisionDialecticStageName =
  | "thesis"
  | "antithesis"
  | "rebuttal"
  | "synthesis"
  | "outcome";

export interface DecisionDialecticStageBase {
  name: DecisionDialecticStageName;
  present: boolean;
  author?: DecisionDialecticAgentRef;
  at?: string;
}

export interface DecisionDialecticThesisStage extends DecisionDialecticStageBase {
  name: "thesis";
  data?: DecisionDialecticThesisV1;
}

export interface DecisionDialecticAntithesisStage extends DecisionDialecticStageBase {
  name: "antithesis";
  data?: DecisionDialecticAntithesisV1;
  vetoFlags: DecisionDialecticVetoFlagV1[];
}

export interface DecisionDialecticRebuttalStage extends DecisionDialecticStageBase {
  name: "rebuttal";
  data?: DecisionDialecticRebuttalV1;
}

export interface DecisionDialecticSynthesisStage extends DecisionDialecticStageBase {
  name: "synthesis";
  data?: DecisionDialecticSynthesisV1;
  verdict?: DecisionDialecticVerdict;
}

export interface DecisionDialecticOutcomeStage extends DecisionDialecticStageBase {
  name: "outcome";
  data?: DecisionDialecticOutcomeV1;
  implemented?: boolean;
  impactScore?: number;
}

export interface DecisionDialecticStages {
  thesis: DecisionDialecticThesisStage;
  antithesis: DecisionDialecticAntithesisStage;
  rebuttal: DecisionDialecticRebuttalStage;
  synthesis: DecisionDialecticSynthesisStage;
  outcome: DecisionDialecticOutcomeStage;
}

export interface DecisionDialecticDecisionCard {
  present: boolean;
  verdict?: DecisionDialecticVerdict;
  route?: DecisionDialecticDecisionV1["routeTo"];
  hardVeto?: boolean;
  decisionPolicyRef?: string;
  decisionBasisRevision?: number;
  ttlSec?: number;
  decidedBy?: DecisionDialecticAgentRef;
  decidedAt?: string;
}

export interface DecisionDialecticReadModelV1 {
  kind: typeof DECISION_DIALECTIC_KIND;
  version: typeof DECISION_DIALECTIC_VERSION;
  brokerTaskId: string;
  brokerTaskStatus: TaskRecord["status"];
  brokerTaskUpdatedAt: string;
  contract: {
    taskId: string;
    revision: number;
    state: DecisionDialecticState;
    phase: DecisionDialecticPhase;
  };
  meta: DecisionDialecticMetaV1;
  roles: DecisionDialecticTaskV1["roles"];
  context: DecisionDialecticContextV1;
  stages: DecisionDialecticStages;
  decisionCard: DecisionDialecticDecisionCard;
  summary: {
    headline: string;
    decision: string;
  };
}

export type DecisionDialecticReadModelErrorCode =
  | "missing_contract"
  | "wrong_kind"
  | "unsupported_version"
  | "invalid_contract";

export class DecisionDialecticReadModelError extends Error {
  constructor(
    public readonly code: DecisionDialecticReadModelErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DecisionDialecticReadModelError";
  }
}

interface DecisionDialecticTaskInputShape {
  contract?: {
    kind?: unknown;
    version?: unknown;
    phase?: unknown;
    task?: unknown;
  };
}

export function projectDecisionDialecticReadModel(
  task: TaskRecord,
): DecisionDialecticReadModelV1 {
  const contract = extractContract(task.payload);
  const dialectic = contract.task;
  const phase = contract.phase;

  return {
    kind: DECISION_DIALECTIC_KIND,
    version: DECISION_DIALECTIC_VERSION,
    brokerTaskId: task.id,
    brokerTaskStatus: task.status,
    brokerTaskUpdatedAt: task.updatedAt,
    contract: {
      taskId: dialectic.taskId,
      revision: dialectic.revision,
      state: dialectic.state,
      phase,
    },
    meta: dialectic.meta,
    roles: dialectic.roles,
    context: dialectic.context,
    stages: buildStages(dialectic),
    decisionCard: buildDecisionCard(dialectic),
    summary: {
      headline: summarizeDecisionDialecticTask(dialectic),
      decision: summarizeDecisionDialecticDecision(dialectic),
    },
  };
}

function extractContract(payload: Record<string, unknown>): {
  task: DecisionDialecticTaskV1;
  phase: DecisionDialecticPhase;
} {
  const wrapper = payload as DecisionDialecticTaskInputShape;
  const contract = wrapper.contract;
  if (!contract || typeof contract !== "object") {
    throw new DecisionDialecticReadModelError(
      "missing_contract",
      "task payload does not include a decision.dialectic contract",
    );
  }

  if (contract.kind !== DECISION_DIALECTIC_KIND) {
    throw new DecisionDialecticReadModelError(
      "wrong_kind",
      `task payload contract is not ${DECISION_DIALECTIC_KIND}`,
    );
  }

  if (contract.version !== DECISION_DIALECTIC_VERSION) {
    throw new DecisionDialecticReadModelError(
      "unsupported_version",
      `unsupported decision.dialectic contract version: ${String(contract.version)}`,
    );
  }

  const phase = contract.phase;
  if (!isPhase(phase)) {
    throw new DecisionDialecticReadModelError(
      "invalid_contract",
      "decision.dialectic contract is missing a valid phase",
    );
  }

  const taskCandidate = contract.task;
  if (
    !taskCandidate ||
    typeof taskCandidate !== "object" ||
    typeof (taskCandidate as { taskId?: unknown }).taskId !== "string"
  ) {
    throw new DecisionDialecticReadModelError(
      "invalid_contract",
      "decision.dialectic contract is missing the task body",
    );
  }

  return { task: taskCandidate as DecisionDialecticTaskV1, phase };
}

function buildStages(task: DecisionDialecticTaskV1): DecisionDialecticStages {
  const thesis = task.thesis;
  const antithesis = task.antithesis;
  const rebuttal = task.rebuttal;
  const synthesis = task.synthesis;
  const outcome = task.outcome;

  return {
    thesis: {
      name: "thesis",
      present: Boolean(thesis),
      author: thesis?.author,
      at: thesis?.submittedAt,
      data: thesis,
    },
    antithesis: {
      name: "antithesis",
      present: Boolean(antithesis),
      author: antithesis?.author,
      at: antithesis?.submittedAt,
      data: antithesis,
      vetoFlags: antithesis?.vetoFlags ?? [],
    },
    rebuttal: {
      name: "rebuttal",
      present: Boolean(rebuttal),
      author: rebuttal?.author,
      at: rebuttal?.submittedAt,
      data: rebuttal,
    },
    synthesis: {
      name: "synthesis",
      present: Boolean(synthesis),
      author: synthesis?.author,
      at: synthesis?.submittedAt,
      data: synthesis,
      verdict: synthesis?.verdict,
    },
    outcome: {
      name: "outcome",
      present: Boolean(outcome),
      author: outcome?.author,
      at: outcome?.observedAt,
      data: outcome,
      implemented: outcome?.implemented,
      impactScore: outcome?.impactScore,
    },
  };
}

function buildDecisionCard(task: DecisionDialecticTaskV1): DecisionDialecticDecisionCard {
  const decision: DecisionDialecticDecisionV1 | undefined = task.decision;
  if (!decision) {
    return { present: false };
  }

  return {
    present: true,
    verdict: decision.action,
    route: decision.routeTo,
    hardVeto: decision.hardVeto,
    decisionPolicyRef: decision.decisionPolicyRef,
    decisionBasisRevision: decision.decisionBasisRevision,
    ttlSec: decision.ttlSec,
    decidedBy: task.synthesis?.author,
    decidedAt: task.synthesis?.submittedAt,
  };
}

function isPhase(value: unknown): value is DecisionDialecticPhase {
  return (
    value === "thesis" ||
    value === "antithesis" ||
    value === "rebuttal" ||
    value === "synthesis" ||
    value === "outcome"
  );
}
