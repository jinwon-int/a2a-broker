import { DecisionDialecticExpectedOutputJsonSchemas } from "./json-schema.js";
import type {
  DecisionDialecticAgentRef,
  DecisionDialecticPhase,
  DecisionDialecticSchemaName,
} from "./types.js";

export type DecisionDialecticPromptSpec<
  TPhase extends DecisionDialecticPhase = DecisionDialecticPhase,
  TSchemaName extends DecisionDialecticSchemaName = DecisionDialecticSchemaName,
> = {
  phase: TPhase;
  schemaName: TSchemaName;
  jsonSchema: (typeof DecisionDialecticExpectedOutputJsonSchemas)[TSchemaName];
  systemPrompt: string;
};

const PhaseSchemaNames = {
  thesis: "decisionDialectic.thesis.v1",
  antithesis: "decisionDialectic.antithesis.v1",
  rebuttal: "decisionDialectic.rebuttal.v1",
  synthesis: "decisionDialectic.synthesisDecision.v1",
  outcome: "decisionDialectic.outcome.v1",
} as const satisfies Record<DecisionDialecticPhase, DecisionDialecticSchemaName>;

const PhaseResponsibilities: Record<DecisionDialecticPhase, string> = {
  thesis:
    "produce the strongest actionable case for the proposed decision without balancing both sides",
  antithesis:
    "attack the thesis, identify failure modes, contradictions, and any domain hard veto flags",
  rebuttal:
    "respond to the antithesis, defend still-valid claims, and concede live residual risk",
  synthesis:
    "weigh the prior stages, choose one verdict, and route the decision with guardrails",
  outcome:
    "record what happened after the decision and score the usefulness of each stage",
};

const RequiredFields: Record<DecisionDialecticPhase, string[]> = {
  thesis: [
    "author",
    "submittedAt",
    "claim",
    "proposal",
    "rationale",
    "expectedBenefits",
    "evidenceRefs",
    "assumptions",
    "risks",
    "confidence",
  ],
  antithesis: [
    "author",
    "submittedAt",
    "counterClaim",
    "whyThesisMayFail",
    "failureModes",
    "contradictions",
    "vetoFlags",
    "evidenceRefs",
    "confidence",
  ],
  rebuttal: [
    "author",
    "submittedAt",
    "response",
    "defendedClaims",
    "concededRisks",
    "residualRisks",
  ],
  synthesis: ["author", "submittedAt", "synthesis", "decision"],
  outcome: [
    "author",
    "observedAt",
    "implemented",
    "outcomeSummary",
    "notes",
    "decisionBasisRevision",
  ],
};

export interface BuildDecisionDialecticPromptSpecOptions {
  phase: DecisionDialecticPhase;
  agent: DecisionDialecticAgentRef;
  domain?: string;
  roleDescription?: string;
}

export function buildDecisionDialecticPromptSpec<
  TPhase extends DecisionDialecticPhase,
>(
  options: BuildDecisionDialecticPromptSpecOptions & { phase: TPhase },
): DecisionDialecticPromptSpec<TPhase, (typeof PhaseSchemaNames)[TPhase]> {
  const schemaName = PhaseSchemaNames[options.phase];
  const roleDescription = options.roleDescription ?? PhaseResponsibilities[options.phase];
  const domainLine = options.domain ? `Domain: ${options.domain}` : "Domain: supplied by task meta";
  const requiredFields = RequiredFields[options.phase].map((field) => `- ${field}`).join("\n");

  return {
    phase: options.phase,
    schemaName,
    jsonSchema: DecisionDialecticExpectedOutputJsonSchemas[schemaName],
    systemPrompt: `You are ${options.agent.agentId}, assigned to the ${options.phase} phase for decision.dialectic.
${domainLine}
Role hint: ${options.agent.roleHint ?? "use the assigned dialectic role"}

Your job is to ${roleDescription}.
Use the task context, domainContext, evidenceRefs, and any approved tool results provided between phases.
Do not invent evidence. If evidence is weak, say so in the required risk or unresolved fields.

Return JSON only, matching schemaName:
${schemaName}

Required output fields:
${requiredFields}

Verdict policy for synthesis:
- VETO when a blocker vetoFlag or policy violation should stop the decision.
- WAIT when the decision may be valid but needs more evidence, timing, or prerequisite work.
- PROCEED_WITH_GUARDRAILS when the decision can move in a constrained pilot or bounded rollout.
- ABSTAIN when the evidence cannot support a decision.
- PROCEED only when the positive case is strong and guardrails are already satisfied.

No markdown, no prose outside JSON.`,
  };
}
