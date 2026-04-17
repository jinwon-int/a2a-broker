export const TRADING_DIALECTIC_KIND = "trading.dialectic" as const;
export const TRADING_DIALECTIC_VERSION = 1 as const;

export type TradingDialecticPhase =
  | "thesis"
  | "antithesis"
  | "rebuttal"
  | "synthesis"
  | "outcome";

export type TradingDialecticVerdict =
  | "EXECUTE_FULL"
  | "EXECUTE_PROBE"
  | "WAIT_TRIGGER"
  | "ABSTAIN"
  | "VETO";

export type TradingDialecticHardVetoCode =
  | "stale_data"
  | "exchange_incident"
  | "risk_budget_violation"
  | "timestamp_drift"
  | "execution_path_error";

export type TradingDialecticState =
  | "OPEN"
  | "THESIS_SUBMITTED"
  | "ANTITHESIS_SUBMITTED"
  | "REBUTTAL_SUBMITTED"
  | "WAITING_TRIGGER"
  | "EXECUTION_ROUTED"
  | "ABSTAINED"
  | "VETOED"
  | "SETTLED"
  | "EXPIRED"
  | "CANCELLED"
  | "FAILED";

export type TradingDialecticMarketType = "spot" | "perp" | "futures" | "options";
export type TradingDialecticSide = "long" | "short";
export type TradingDialecticTimeHorizon = "scalp" | "intraday" | "swing" | "position";
export type TradingDialecticUrgency = "low" | "normal" | "high";

export type TradingDialecticRoute = "bangtong" | "none";

export type TradingDialecticSchemaName =
  | "tradingDialectic.thesis.v1"
  | "tradingDialectic.antithesis.v1"
  | "tradingDialectic.rebuttal.v1"
  | "tradingDialectic.synthesisDecision.v1"
  | "tradingDialectic.outcome.v1";

export type TradingDialecticAgentRef = {
  agentId: string;
  sessionKey?: string;
  nodeId?: string;
};

export type TradingDialecticMetaV1 = {
  symbol: string;
  venue: string;
  marketType: TradingDialecticMarketType;
  side: TradingDialecticSide;
  accountRef: string;
  timeHorizon: TradingDialecticTimeHorizon;
  urgency: TradingDialecticUrgency;
  strategyId?: string;
  riskBudgetRef?: string;
  snapshotAt: string;
  dataFreshnessMs: number;
  openedAt: string;
  expiresAt: string;
  openedBy: string;
};

export type TradingDialecticContextV1 = {
  marketSnapshot: Record<string, unknown>;
  contextRefs?: string[];
  maxProbeRiskR?: number;
  maxFullRiskR?: number;
  maxLeverage?: number;
  maxTimestampDriftMs?: number;
};

export type TradingDialecticThesisV1 = {
  author: TradingDialecticAgentRef;
  submittedAt: string;
  regimeHypothesis: string;
  tradeIdea: string;
  whyNow: string;
  entryPlan: string;
  invalidation: string;
  targets: string[];
  confidence: number;
  evidenceRefs: string[];
  assumptions: string[];
  riskNotes: string[];
};

export type TradingDialecticAntithesisV1 = {
  author: TradingDialecticAgentRef;
  submittedAt: string;
  counterView: string;
  alternativeRegime: string;
  whyThesisMayFail: string;
  failureModes: string[];
  contradictions: string[];
  vetoFlags: TradingDialecticHardVetoCode[];
  evidenceRefs: string[];
  confidence: number;
};

export type TradingDialecticRebuttalV1 = {
  author: TradingDialecticAgentRef;
  submittedAt: string;
  response: string;
  defendedClaims: string[];
  concededRisks: string[];
  residualRisks: string[];
};

export type TradingDialecticSynthesisV1 = {
  author: TradingDialecticAgentRef;
  submittedAt: string;
  preserve: string[];
  discard: string[];
  metaRule: string;
  verdict: TradingDialecticVerdict;
  triggerSet: string[];
  sizeRule: string;
  killSwitch: string[];
  unresolved: string[];
};

export type TradingDialecticDecisionV1 = {
  action: TradingDialecticVerdict;
  routeTo: TradingDialecticRoute;
  ttlSec: number;
  hardVeto: boolean;
  executionPolicyRef: string;
  decisionBasisRevision: number;
};

export type TradingDialecticSynthesisDecisionV1 = {
  author: TradingDialecticAgentRef;
  submittedAt: string;
  synthesis: TradingDialecticSynthesisV1;
  decision: TradingDialecticDecisionV1;
};

export type TradingDialecticOutcomeV1 = {
  author: TradingDialecticAgentRef;
  observedAt: string;
  executed: boolean;
  resultR?: number;
  maxDrawdownR?: number;
  thesisScore?: number;
  antithesisScore?: number;
  synthesisScore?: number;
  notes: string;
  decisionBasisRevision: number;
};

export type TradingDialecticTaskV1 = {
  kind: typeof TRADING_DIALECTIC_KIND;
  version: typeof TRADING_DIALECTIC_VERSION;
  taskId: string;
  revision: number;
  state: TradingDialecticState;
  meta: TradingDialecticMetaV1;
  roles: {
    thesisAgent: TradingDialecticAgentRef;
    antithesisAgent: TradingDialecticAgentRef;
    synthAgent: TradingDialecticAgentRef;
  };
  context: TradingDialecticContextV1;
  thesis?: TradingDialecticThesisV1;
  antithesis?: TradingDialecticAntithesisV1;
  rebuttal?: TradingDialecticRebuttalV1;
  synthesis?: TradingDialecticSynthesisV1;
  decision?: TradingDialecticDecisionV1;
  outcome?: TradingDialecticOutcomeV1;
};

export type TradingDialecticTaskInputV1 = {
  contract: {
    kind: typeof TRADING_DIALECTIC_KIND;
    version: typeof TRADING_DIALECTIC_VERSION;
    phase: TradingDialecticPhase;
    task: TradingDialecticTaskV1;
  };
};

type TradingDialecticPatchBase = {
  patchId: string;
  taskId: string;
  expectedRevision: number;
  authorAgent: string;
  at: string;
};

export type TradingDialecticPatchV1 =
  | (TradingDialecticPatchBase & {
      op: "append.thesis";
      payload: TradingDialecticThesisV1;
    })
  | (TradingDialecticPatchBase & {
      op: "append.antithesis";
      payload: TradingDialecticAntithesisV1;
    })
  | (TradingDialecticPatchBase & {
      op: "append.rebuttal";
      payload: TradingDialecticRebuttalV1;
    })
  | (TradingDialecticPatchBase & {
      op: "set.synthesis_decision";
      payload: TradingDialecticSynthesisDecisionV1;
    })
  | (TradingDialecticPatchBase & {
      op: "append.outcome";
      payload: TradingDialecticOutcomeV1;
    });

export type TradingDialecticPatchErrorCode =
  | "task_id_mismatch"
  | "revision_conflict"
  | "author_not_allowed"
  | "phase_out_of_order"
  | "duplicate_phase"
  | "missing_prerequisite"
  | "hard_veto_required"
  | "verdict_policy_violation"
  | "decision_basis_mismatch"
  | "task_expired"
  | "task_terminal";
