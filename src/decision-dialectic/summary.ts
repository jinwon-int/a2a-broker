import type {
  DecisionDialecticDecisionV1,
  DecisionDialecticTaskV1,
  DecisionDialecticVerdict,
} from "./types.js";

const VerdictPhrases: Record<DecisionDialecticVerdict, string> = {
  PROCEED: "proceed",
  PROCEED_WITH_GUARDRAILS: "proceed with guardrails",
  WAIT: "wait",
  ABSTAIN: "abstain",
  VETO: "veto",
};

function formatPrefix(task: DecisionDialecticTaskV1): string {
  return `[${task.meta.domain}:${task.meta.topic} ${task.state} r${task.revision}]`;
}

function formatRoute(routeTo: DecisionDialecticDecisionV1["routeTo"] | undefined): string | null {
  if (!routeTo) {
    return null;
  }

  return routeTo === "none" ? "route none" : `route ${routeTo}`;
}

function formatDecisionFields(task: DecisionDialecticTaskV1): string {
  const verdict = task.decision?.action ?? task.synthesis?.verdict;
  const route = formatRoute(task.decision?.routeTo);
  const basisRevision = task.decision?.decisionBasisRevision;
  const parts: string[] = [];

  if (verdict) {
    parts.push(`verdict ${verdict}`);
  }

  if (route) {
    parts.push(route);
  }

  if (basisRevision !== undefined) {
    parts.push(`basis r${basisRevision}`);
  }

  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

function formatOutcome(task: DecisionDialecticTaskV1): string {
  if (!task.outcome) {
    return "settled";
  }

  const status = task.outcome.implemented ? "implemented" : "not implemented";
  const parts = [status, task.outcome.outcomeSummary];

  if (task.outcome.impactScore !== undefined) {
    parts.push(`impact ${task.outcome.impactScore}`);
  }

  return `settled, ${parts.join(", ")}`;
}

export function summarizeDecisionDialecticTask(task: DecisionDialecticTaskV1): string {
  const prefix = formatPrefix(task);
  const decisionFields = formatDecisionFields(task);

  switch (task.state) {
    case "OPEN":
      return `${prefix} open, awaiting thesis`;
    case "THESIS_SUBMITTED":
      return `${prefix} thesis submitted, awaiting antithesis`;
    case "ANTITHESIS_SUBMITTED":
      return `${prefix} antithesis submitted, awaiting rebuttal`;
    case "REBUTTAL_SUBMITTED":
      return `${prefix} rebuttal submitted, awaiting synthesis`;
    case "WAITING":
      return `${prefix} waiting before decision route${decisionFields}`;
    case "DECISION_ROUTED":
      return `${prefix} decision routed${decisionFields}`;
    case "ABSTAINED":
      return `${prefix} abstained, no route${decisionFields}`;
    case "VETOED":
      return `${prefix} vetoed, blocked${decisionFields}`;
    case "SETTLED":
      return `${prefix} ${formatOutcome(task)}${decisionFields}`;
    case "EXPIRED":
      return `${prefix} expired before settlement${decisionFields}`;
    case "CANCELLED":
      return `${prefix} cancelled${decisionFields}`;
    case "FAILED":
      return `${prefix} failed${decisionFields}`;
  }
}

export function summarizeDecisionDialecticDecision(task: DecisionDialecticTaskV1): string {
  const prefix = formatPrefix(task);
  const verdict = task.decision?.action ?? task.synthesis?.verdict;
  const route = formatRoute(task.decision?.routeTo);
  const basisRevision = task.decision?.decisionBasisRevision;
  const suffixParts: string[] = [];

  if (route) {
    suffixParts.push(route);
  }

  if (basisRevision !== undefined) {
    suffixParts.push(`basis r${basisRevision}`);
  }

  const suffix = suffixParts.length > 0 ? ` (${suffixParts.join(", ")})` : "";

  if (!verdict) {
    return `${prefix} no decision recorded yet`;
  }

  return `${prefix} ${VerdictPhrases[verdict]} (${verdict})${suffix}`;
}
