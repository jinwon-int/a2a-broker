export const DECISION_DIALECTIC_KIND = "decision.dialectic" as const;
export const DECISION_DIALECTIC_VERSION = 1 as const;

export type DecisionDialecticPhase =
  | "thesis"
  | "antithesis"
  | "rebuttal"
  | "synthesis"
  | "outcome";

export type DecisionDialecticUrgency = "low" | "normal" | "high" | "critical";

export type DecisionDialecticVerdict =
  | "PROCEED"
  | "PROCEED_WITH_GUARDRAILS"
  | "WAIT"
  | "ABSTAIN"
  | "VETO";

export type DecisionDialecticState =
  | "OPEN"
  | "THESIS_SUBMITTED"
  | "ANTITHESIS_SUBMITTED"
  | "REBUTTAL_SUBMITTED"
  | "WAITING"
  | "DECISION_ROUTED"
  | "ABSTAINED"
  | "VETOED"
  | "SETTLED"
  | "EXPIRED"
  | "CANCELLED"
  | "FAILED";

export type DecisionDialecticRoute = string;

export type DecisionDialecticSchemaName =
  | "decisionDialectic.thesis.v1"
  | "decisionDialectic.antithesis.v1"
  | "decisionDialectic.rebuttal.v1"
  | "decisionDialectic.synthesisDecision.v1"
  | "decisionDialectic.outcome.v1";

export type DecisionDialecticAgentRef = {
  agentId: string;
  sessionKey?: string;
  nodeId?: string;
  teamId?: string;
  roleHint?: string;
};

export type DecisionDialecticMetaV1 = {
  topic: string;
  domain: string;
  urgency: DecisionDialecticUrgency;
  openedAt: string;
  snapshotAt: string;
  expiresAt: string;
  openedBy: string;
  contextRefs?: string[];
  tags?: string[];
};

export type DecisionDialecticContextV1 = {
  brief: string;
  objective: string;
  constraints?: string[];
  decisionCriteria?: string[];
  evidenceRefs?: string[];
  availableTools?: string[];
  hardVetoPolicy?: string[];
  domainContext?: Record<string, unknown>;
};

export type DecisionDialecticVetoSeverity = "warn" | "blocker";

export type DecisionDialecticVetoFlagV1 = {
  code: string;
  reason: string;
  severity: DecisionDialecticVetoSeverity;
};

export type DecisionDialecticThesisV1 = {
  author: DecisionDialecticAgentRef;
  submittedAt: string;
  claim: string;
  proposal: string;
  rationale: string;
  expectedBenefits: string[];
  evidenceRefs: string[];
  assumptions: string[];
  risks: string[];
  confidence: number;
};

export type DecisionDialecticAntithesisV1 = {
  author: DecisionDialecticAgentRef;
  submittedAt: string;
  counterClaim: string;
  whyThesisMayFail: string;
  failureModes: string[];
  contradictions: string[];
  vetoFlags: DecisionDialecticVetoFlagV1[];
  evidenceRefs: string[];
  confidence: number;
};

export type DecisionDialecticRebuttalV1 = {
  author: DecisionDialecticAgentRef;
  submittedAt: string;
  response: string;
  defendedClaims: string[];
  concededRisks: string[];
  residualRisks: string[];
};

export type DecisionDialecticSynthesisV1 = {
  author: DecisionDialecticAgentRef;
  submittedAt: string;
  preserve: string[];
  discard: string[];
  decisionRule: string;
  verdict: DecisionDialecticVerdict;
  guardrails: string[];
  followups: string[];
  unresolved: string[];
};

export type DecisionDialecticDecisionV1 = {
  action: DecisionDialecticVerdict;
  routeTo: DecisionDialecticRoute;
  ttlSec: number;
  hardVeto: boolean;
  decisionPolicyRef: string;
  decisionBasisRevision: number;
};

export type DecisionDialecticSynthesisDecisionV1 = {
  author: DecisionDialecticAgentRef;
  submittedAt: string;
  synthesis: DecisionDialecticSynthesisV1;
  decision: DecisionDialecticDecisionV1;
};

export type DecisionDialecticOutcomeV1 = {
  author: DecisionDialecticAgentRef;
  observedAt: string;
  implemented: boolean;
  outcomeSummary: string;
  impactScore?: number;
  thesisScore?: number;
  antithesisScore?: number;
  synthesisScore?: number;
  notes: string;
  decisionBasisRevision: number;
};

export type DecisionDialecticTaskV1 = {
  kind: typeof DECISION_DIALECTIC_KIND;
  version: typeof DECISION_DIALECTIC_VERSION;
  taskId: string;
  revision: number;
  state: DecisionDialecticState;
  meta: DecisionDialecticMetaV1;
  roles: {
    thesisAgent: DecisionDialecticAgentRef;
    antithesisAgent: DecisionDialecticAgentRef;
    rebuttalAgent?: DecisionDialecticAgentRef;
    synthAgent: DecisionDialecticAgentRef;
  };
  context: DecisionDialecticContextV1;
  thesis?: DecisionDialecticThesisV1;
  antithesis?: DecisionDialecticAntithesisV1;
  rebuttal?: DecisionDialecticRebuttalV1;
  synthesis?: DecisionDialecticSynthesisV1;
  decision?: DecisionDialecticDecisionV1;
  outcome?: DecisionDialecticOutcomeV1;
};

export type DecisionDialecticTaskInputV1 = {
  contract: {
    kind: typeof DECISION_DIALECTIC_KIND;
    version: typeof DECISION_DIALECTIC_VERSION;
    phase: DecisionDialecticPhase;
    task: DecisionDialecticTaskV1;
  };
};

type DecisionDialecticPatchBase = {
  patchId: string;
  taskId: string;
  expectedRevision: number;
  authorAgent: string;
  at: string;
};

export type DecisionDialecticPatchV1 =
  | (DecisionDialecticPatchBase & {
      op: "append.thesis";
      payload: DecisionDialecticThesisV1;
    })
  | (DecisionDialecticPatchBase & {
      op: "append.antithesis";
      payload: DecisionDialecticAntithesisV1;
    })
  | (DecisionDialecticPatchBase & {
      op: "append.rebuttal";
      payload: DecisionDialecticRebuttalV1;
    })
  | (DecisionDialecticPatchBase & {
      op: "set.synthesis_decision";
      payload: DecisionDialecticSynthesisDecisionV1;
    })
  | (DecisionDialecticPatchBase & {
      op: "append.outcome";
      payload: DecisionDialecticOutcomeV1;
    });

export type DecisionDialecticPatchErrorCode =
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
