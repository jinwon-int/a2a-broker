import type { TaskRecord } from "../core/types.js";
import {
  summarizeTradingDialecticDecision,
  summarizeTradingDialecticTask,
} from "./summary.js";
import {
  TRADING_DIALECTIC_KIND,
  TRADING_DIALECTIC_VERSION,
  type TradingDialecticAgentRef,
  type TradingDialecticAntithesisV1,
  type TradingDialecticContextV1,
  type TradingDialecticDecisionV1,
  type TradingDialecticHardVetoCode,
  type TradingDialecticMetaV1,
  type TradingDialecticOutcomeV1,
  type TradingDialecticPhase,
  type TradingDialecticRebuttalV1,
  type TradingDialecticRoute,
  type TradingDialecticState,
  type TradingDialecticSynthesisV1,
  type TradingDialecticTaskV1,
  type TradingDialecticThesisV1,
  type TradingDialecticVerdict,
} from "./types.js";

export type TradingDialecticStageName =
  | "thesis"
  | "antithesis"
  | "rebuttal"
  | "synthesis"
  | "outcome";

export interface TradingDialecticStageBase {
  name: TradingDialecticStageName;
  present: boolean;
  author?: TradingDialecticAgentRef;
  at?: string;
}

export interface TradingDialecticThesisStage extends TradingDialecticStageBase {
  name: "thesis";
  data?: TradingDialecticThesisV1;
}

export interface TradingDialecticAntithesisStage extends TradingDialecticStageBase {
  name: "antithesis";
  data?: TradingDialecticAntithesisV1;
  vetoFlags: TradingDialecticHardVetoCode[];
}

export interface TradingDialecticRebuttalStage extends TradingDialecticStageBase {
  name: "rebuttal";
  data?: TradingDialecticRebuttalV1;
}

export interface TradingDialecticSynthesisStage extends TradingDialecticStageBase {
  name: "synthesis";
  data?: TradingDialecticSynthesisV1;
  verdict?: TradingDialecticVerdict;
}

export interface TradingDialecticOutcomeStage extends TradingDialecticStageBase {
  name: "outcome";
  data?: TradingDialecticOutcomeV1;
  executed?: boolean;
  resultR?: number;
}

export interface TradingDialecticStages {
  thesis: TradingDialecticThesisStage;
  antithesis: TradingDialecticAntithesisStage;
  rebuttal: TradingDialecticRebuttalStage;
  synthesis: TradingDialecticSynthesisStage;
  outcome: TradingDialecticOutcomeStage;
}

export interface TradingDialecticDecisionCard {
  present: boolean;
  verdict?: TradingDialecticVerdict;
  route?: TradingDialecticRoute;
  hardVeto?: boolean;
  executionPolicyRef?: string;
  decisionBasisRevision?: number;
  ttlSec?: number;
  decidedBy?: TradingDialecticAgentRef;
  decidedAt?: string;
}

export interface TradingDialecticReadModelV1 {
  kind: typeof TRADING_DIALECTIC_KIND;
  version: typeof TRADING_DIALECTIC_VERSION;
  brokerTaskId: string;
  brokerTaskStatus: TaskRecord["status"];
  brokerTaskUpdatedAt: string;
  contract: {
    taskId: string;
    revision: number;
    state: TradingDialecticState;
    phase: TradingDialecticPhase;
  };
  meta: TradingDialecticMetaV1;
  roles: TradingDialecticTaskV1["roles"];
  context: TradingDialecticContextV1;
  stages: TradingDialecticStages;
  decisionCard: TradingDialecticDecisionCard;
  summary: {
    headline: string;
    decision: string;
  };
}

export type TradingDialecticReadModelErrorCode =
  | "missing_contract"
  | "wrong_kind"
  | "unsupported_version"
  | "invalid_contract";

export class TradingDialecticReadModelError extends Error {
  constructor(
    public readonly code: TradingDialecticReadModelErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TradingDialecticReadModelError";
  }
}

interface TradingDialecticTaskInputShape {
  contract?: {
    kind?: unknown;
    version?: unknown;
    phase?: unknown;
    task?: unknown;
  };
}

export function projectTradingDialecticReadModel(
  task: TaskRecord,
): TradingDialecticReadModelV1 {
  const contract = extractContract(task.payload);
  const dialectic = contract.task;
  const phase = contract.phase;

  return {
    kind: TRADING_DIALECTIC_KIND,
    version: TRADING_DIALECTIC_VERSION,
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
      headline: summarizeTradingDialecticTask(dialectic),
      decision: summarizeTradingDialecticDecision(dialectic),
    },
  };
}

function extractContract(payload: Record<string, unknown>): {
  task: TradingDialecticTaskV1;
  phase: TradingDialecticPhase;
} {
  const wrapper = payload as TradingDialecticTaskInputShape;
  const contract = wrapper.contract;
  if (!contract || typeof contract !== "object") {
    throw new TradingDialecticReadModelError(
      "missing_contract",
      "task payload does not include a trading.dialectic contract",
    );
  }

  if (contract.kind !== TRADING_DIALECTIC_KIND) {
    throw new TradingDialecticReadModelError(
      "wrong_kind",
      `task payload contract is not ${TRADING_DIALECTIC_KIND}`,
    );
  }

  if (contract.version !== TRADING_DIALECTIC_VERSION) {
    throw new TradingDialecticReadModelError(
      "unsupported_version",
      `unsupported trading.dialectic contract version: ${String(contract.version)}`,
    );
  }

  const phase = contract.phase;
  if (!isPhase(phase)) {
    throw new TradingDialecticReadModelError(
      "invalid_contract",
      "trading.dialectic contract is missing a valid phase",
    );
  }

  const taskCandidate = contract.task;
  if (
    !taskCandidate ||
    typeof taskCandidate !== "object" ||
    typeof (taskCandidate as { taskId?: unknown }).taskId !== "string"
  ) {
    throw new TradingDialecticReadModelError(
      "invalid_contract",
      "trading.dialectic contract is missing the task body",
    );
  }

  return { task: taskCandidate as TradingDialecticTaskV1, phase };
}

function buildStages(task: TradingDialecticTaskV1): TradingDialecticStages {
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
      executed: outcome?.executed,
      resultR: outcome?.resultR,
    },
  };
}

function buildDecisionCard(task: TradingDialecticTaskV1): TradingDialecticDecisionCard {
  const decision: TradingDialecticDecisionV1 | undefined = task.decision;
  if (!decision) {
    return { present: false };
  }

  return {
    present: true,
    verdict: decision.action,
    route: decision.routeTo,
    hardVeto: decision.hardVeto,
    executionPolicyRef: decision.executionPolicyRef,
    decisionBasisRevision: decision.decisionBasisRevision,
    ttlSec: decision.ttlSec,
    decidedBy: task.synthesis?.author,
    decidedAt: task.synthesis?.submittedAt,
  };
}

function isPhase(value: unknown): value is TradingDialecticPhase {
  return (
    value === "thesis" ||
    value === "antithesis" ||
    value === "rebuttal" ||
    value === "synthesis" ||
    value === "outcome"
  );
}
