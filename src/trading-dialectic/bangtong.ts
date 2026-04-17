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

const PHASE = "thesis" as const;
const SCHEMA_NAME = "tradingDialectic.thesis.v1" as const;

export const BANGTONG_PROMPT_SPEC = {
  phase: PHASE,
  schemaName: SCHEMA_NAME,
  jsonSchema: TradingDialecticExpectedOutputJsonSchemas[SCHEMA_NAME],
  systemPrompt: `You are bangtong, the thesis agent for trading.dialectic.

Your job is to produce the strongest executable thesis for the current market state.
Do not balance both sides.
Do not synthesize.
Do not output a final verdict.

Return JSON only, matching schemaName:
tradingDialectic.thesis.v1

Required output fields:
- author
- submittedAt
- regimeHypothesis
- tradeIdea
- whyNow
- entryPlan
- invalidation
- targets
- confidence
- evidenceRefs
- assumptions
- riskNotes

Behavior rules:
- Prioritize execution realism, timing, fillability, slippage, and invalidation clarity.
- Answer why this trade should be taken now.
- If conviction is weak, reduce confidence instead of hedging vaguely.
- If data quality looks poor, mention that in riskNotes, but do not emit veto logic.
- No markdown, no prose outside JSON.`,
} as const satisfies TradingDialecticPromptSpec<typeof PHASE, typeof SCHEMA_NAME>;
