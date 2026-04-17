import type {
  TradingDialecticDecisionV1,
  TradingDialecticTaskV1,
  TradingDialecticVerdict,
} from "./types.js";

const VerdictPhrases: Record<TradingDialecticVerdict, string> = {
  EXECUTE_FULL: "execute full",
  EXECUTE_PROBE: "execute probe",
  WAIT_TRIGGER: "wait for trigger",
  ABSTAIN: "abstain",
  VETO: "veto",
};

function formatPrefix(task: TradingDialecticTaskV1): string {
  return `[${task.meta.symbol} ${task.meta.side} ${task.state} r${task.revision}]`;
}

function formatRoute(routeTo: TradingDialecticDecisionV1["routeTo"] | undefined): string | null {
  if (!routeTo) {
    return null;
  }

  return routeTo === "none" ? "route none" : `route ${routeTo}`;
}

function formatDecisionFields(task: TradingDialecticTaskV1): string {
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

function formatExecutionOutcome(task: TradingDialecticTaskV1): string {
  if (!task.outcome) {
    return "settled";
  }

  const parts = [task.outcome.executed ? "executed" : "not executed"];

  if (task.outcome.resultR !== undefined) {
    parts.push(`result ${task.outcome.resultR}R`);
  }

  return `settled, ${parts.join(", ")}`;
}

export function summarizeTradingDialecticTask(task: TradingDialecticTaskV1): string {
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
    case "WAITING_TRIGGER":
      return `${prefix} waiting for trigger before execution${decisionFields}`;
    case "EXECUTION_ROUTED":
      return `${prefix} execution routed${decisionFields}`;
    case "ABSTAINED":
      return `${prefix} abstained, no execution route${decisionFields}`;
    case "VETOED":
      return `${prefix} vetoed, execution blocked${decisionFields}`;
    case "SETTLED":
      return `${prefix} ${formatExecutionOutcome(task)}${decisionFields}`;
    case "EXPIRED":
      return `${prefix} expired before settlement${decisionFields}`;
    case "CANCELLED":
      return `${prefix} cancelled${decisionFields}`;
    case "FAILED":
      return `${prefix} failed${decisionFields}`;
  }
}

export function summarizeTradingDialecticDecision(task: TradingDialecticTaskV1): string {
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

  switch (verdict) {
    case "WAIT_TRIGGER":
      return `${prefix} wait for trigger before execution (WAIT_TRIGGER)${suffix}`;
    case "EXECUTE_PROBE":
      return `${prefix} execute probe route selected (EXECUTE_PROBE)${suffix}`;
    case "EXECUTE_FULL":
      return `${prefix} execute full route selected (EXECUTE_FULL)${suffix}`;
    case "ABSTAIN":
      return `${prefix} abstain, leave unexecuted (ABSTAIN)${suffix}`;
    case "VETO":
      return `${prefix} veto, do not execute (VETO)${suffix}`;
  }
}
