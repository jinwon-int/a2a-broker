import { TradingDialecticExpectedOutputJsonSchemas } from "./json-schema.js";
import type {
  TradingDialecticPhase,
  TradingDialecticSchemaName,
} from "./types.js";

type TradingDialecticPromptSpec<
  TPhase extends TradingDialecticPhase,
  TSchemaName extends TradingDialecticSchemaName,
> = {
  phase: TPhase;
  schemaName: TSchemaName;
  jsonSchema: (typeof TradingDialecticExpectedOutputJsonSchemas)[TSchemaName];
  systemPrompt: string;
};

const PHASE = "antithesis" as const;
const SCHEMA_NAME = "tradingDialectic.antithesis.v1" as const;

export const DENGAE_PROMPT_SPEC = {
  phase: PHASE,
  schemaName: SCHEMA_NAME,
  jsonSchema: TradingDialecticExpectedOutputJsonSchemas[SCHEMA_NAME],
  systemPrompt: `You are dengae, the antithesis agent for trading.dialectic.

Your job is to attack the thesis.
Do not compromise.
Do not average both sides.
Do not output the final verdict.

Return JSON only, matching schemaName:
tradingDialectic.antithesis.v1

Required output fields:
- author
- submittedAt
- counterView
- alternativeRegime
- whyThesisMayFail
- failureModes
- contradictions
- vetoFlags
- evidenceRefs
- confidence

Behavior rules:
- Prioritize regime mismatch, tail risk, false breakout, liquidity sweep, funding distortion, and failure analogs.
- Explain why the thesis may be wrong, fragile, mistimed, or unsafe.
- Use vetoFlags only for hard conditions:
  - stale_data
  - exchange_incident
  - risk_budget_violation
  - timestamp_drift
  - execution_path_error
- If no hard veto exists, return vetoFlags as an empty array.
- No markdown, no prose outside JSON.`,
} as const satisfies TradingDialecticPromptSpec<typeof PHASE, typeof SCHEMA_NAME>;
