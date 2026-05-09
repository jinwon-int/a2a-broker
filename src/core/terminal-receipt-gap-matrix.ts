/**
 * No-live validation matrix for post-cutoff terminal receipt gaps.
 *
 * This proof is deliberately pure: it models current-gap shaped terminal-outbox
 * rows without contacting providers, sending Telegram messages, mutating SQLite,
 * or acknowledging any real broker terminal-outbox rows.
 */

export const TERMINAL_RECEIPT_VOCABULARY_STATES = [
  "accepted",
  "sent",
  "provider_sent",
  "provider-delivered-if-known",
  "operator-visible",
  "timed_out",
  "stale",
  "failed",
] as const;

export type TerminalReceiptVocabularyState = (typeof TERMINAL_RECEIPT_VOCABULARY_STATES)[number];

export const CURRENT_POST_CUTOFF_GAP_SCENARIOS = [
  "accepted_current_gap",
  "sent_current_gap",
  "provider_sent_current_gap",
  "provider_delivery_unknown_current_gap",
  "timed_out_current_gap",
  "stale_current_gap",
  "failed_current_gap",
] as const;

export type CurrentPostCutoffGapScenarioId = (typeof CURRENT_POST_CUTOFF_GAP_SCENARIOS)[number];
export type TerminalReceiptGapScenarioId = CurrentPostCutoffGapScenarioId | "operator_visible_positive_control";
export type TerminalReceiptGapDecision = "hold_unacked_replayable" | "allow_receipt_confirmed_ack";

export interface TerminalReceiptGapFixture {
  scenarioId: TerminalReceiptGapScenarioId;
  outboxId: string;
  createdAt: string;
  receiptState: TerminalReceiptVocabularyState;
  providerSendAccepted?: boolean;
  providerDeliveryKnown?: boolean;
  operatorVisibleEvidence?: boolean;
  postCutoff: boolean;
}

export interface TerminalReceiptGapCell {
  scenarioId: TerminalReceiptGapScenarioId;
  outboxId: string;
  receiptState: TerminalReceiptVocabularyState;
  verdict: "pass" | "fail";
  decision: TerminalReceiptGapDecision;
  operatorVisible: boolean;
  replayable: boolean;
  ackAllowed: boolean;
  providerSendAcceptanceOnly: boolean;
  providerCalled: false;
  productionAckAttempted: false;
  summary: string;
}

export interface TerminalReceiptGapMatrix {
  kind: "terminal-receipt-gap.no-live.matrix";
  runMode: "no-live";
  generatedAt: string;
  cutoff: string;
  currentGapCount: number;
  cells: TerminalReceiptGapCell[];
  vocabularyStates: TerminalReceiptVocabularyState[];
  overallVerdict: "pass" | "fail";
}

export function defaultTerminalReceiptGapFixtures(cutoff = "2026-05-04T07:10:00.000Z"): TerminalReceiptGapFixture[] {
  return [
    {
      scenarioId: "accepted_current_gap",
      outboxId: "terminal-gap-accepted-1",
      createdAt: "2026-05-04T07:10:01.000Z",
      receiptState: "accepted",
      providerSendAccepted: true,
      postCutoff: true,
    },
    {
      scenarioId: "sent_current_gap",
      outboxId: "terminal-gap-sent-2",
      createdAt: "2026-05-04T07:10:02.000Z",
      receiptState: "sent",
      providerSendAccepted: true,
      postCutoff: true,
    },
    {
      scenarioId: "provider_sent_current_gap",
      outboxId: "terminal-gap-provider-sent-3",
      createdAt: "2026-05-04T07:10:03.000Z",
      receiptState: "provider_sent",
      providerSendAccepted: true,
      providerDeliveryKnown: false,
      postCutoff: true,
    },
    {
      scenarioId: "provider_delivery_unknown_current_gap",
      outboxId: "terminal-gap-provider-unknown-5",
      createdAt: "2026-05-04T07:10:04.000Z",
      receiptState: "provider-delivered-if-known",
      providerSendAccepted: true,
      providerDeliveryKnown: false,
      postCutoff: true,
    },
    {
      scenarioId: "timed_out_current_gap",
      outboxId: "terminal-gap-timeout-5",
      createdAt: "2026-05-04T07:10:05.000Z",
      receiptState: "timed_out",
      providerSendAccepted: true,
      postCutoff: true,
    },
    {
      scenarioId: "stale_current_gap",
      outboxId: "terminal-gap-stale-6",
      createdAt: "2026-05-04T07:10:06.000Z",
      receiptState: "stale",
      providerSendAccepted: true,
      postCutoff: true,
    },
    {
      scenarioId: "failed_current_gap",
      outboxId: "terminal-gap-failed-7",
      createdAt: "2026-05-04T07:10:07.000Z",
      receiptState: "failed",
      providerSendAccepted: false,
      postCutoff: true,
    },
    {
      scenarioId: "operator_visible_positive_control",
      outboxId: "terminal-receipt-operator-visible-control",
      createdAt: cutoff,
      receiptState: "operator-visible",
      operatorVisibleEvidence: true,
      postCutoff: true,
    },
  ];
}

export function runTerminalReceiptGapMatrix(options: {
  generatedAt?: string;
  cutoff?: string;
  fixtures?: TerminalReceiptGapFixture[];
} = {}): TerminalReceiptGapMatrix {
  const cutoff = options.cutoff ?? "2026-05-04T07:10:00.000Z";
  const fixtures = options.fixtures ?? defaultTerminalReceiptGapFixtures(cutoff);
  const cells = fixtures.map(evaluateTerminalReceiptGapFixture);
  return {
    kind: "terminal-receipt-gap.no-live.matrix",
    runMode: "no-live",
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    cutoff,
    currentGapCount: cells.filter((cell) => isCurrentGapScenario(cell.scenarioId)).length,
    cells,
    vocabularyStates: [...TERMINAL_RECEIPT_VOCABULARY_STATES],
    overallVerdict: cells.every((cell) => cell.verdict === "pass") ? "pass" : "fail",
  };
}

export function evaluateTerminalReceiptGapFixture(fixture: TerminalReceiptGapFixture): TerminalReceiptGapCell {
  const providerCalled = false as const;
  const productionAckAttempted = false as const;
  const providerSendAcceptanceOnly = Boolean(fixture.providerSendAccepted) && !fixture.providerDeliveryKnown && !fixture.operatorVisibleEvidence;
  const ackAllowed = Boolean(fixture.operatorVisibleEvidence || fixture.providerDeliveryKnown);
  const decision: TerminalReceiptGapDecision = ackAllowed ? "allow_receipt_confirmed_ack" : "hold_unacked_replayable";
  const replayable = !ackAllowed;
  const operatorVisible = ackAllowed || isCurrentGapScenario(fixture.scenarioId);
  const expectedAckAllowed = fixture.scenarioId === "operator_visible_positive_control";
  const expectedDecision: TerminalReceiptGapDecision = expectedAckAllowed ? "allow_receipt_confirmed_ack" : "hold_unacked_replayable";
  const verdict = fixture.postCutoff &&
    providerCalled === false &&
    productionAckAttempted === false &&
    decision === expectedDecision &&
    (expectedAckAllowed || (operatorVisible && replayable && !ackAllowed))
    ? "pass"
    : "fail";

  return {
    scenarioId: fixture.scenarioId,
    outboxId: fixture.outboxId,
    receiptState: fixture.receiptState,
    verdict,
    decision,
    operatorVisible,
    replayable,
    ackAllowed,
    providerSendAcceptanceOnly,
    providerCalled,
    productionAckAttempted,
    summary: summarizeGapFixture(fixture, decision),
  };
}

export function renderTerminalReceiptGapMarkdown(matrix: TerminalReceiptGapMatrix): string {
  const rows = matrix.cells.map((cell) => (
    `| ${cell.scenarioId} | ${cell.receiptState} | ${cell.verdict} | ${cell.operatorVisible ? "yes" : "no"} | ${cell.replayable ? "yes" : "no"} | ${cell.ackAllowed ? "yes" : "no"} | ${cell.providerSendAcceptanceOnly ? "yes" : "no"} | ${cell.summary} |`
  ));
  return [
    `Terminal receipt gap no-live matrix: ${matrix.overallVerdict}`,
    "",
    `Generated: ${matrix.generatedAt}`,
    `Legacy residue cutoff: ${matrix.cutoff}`,
    `Current post-cutoff gaps modeled: ${matrix.currentGapCount}`,
    `Vocabulary states: ${matrix.vocabularyStates.join(", ")}`,
    "Run mode: no-live (providerCalled=false, productionAckAttempted=false for every scenario)",
    "",
    "| Scenario | Receipt state | Verdict | Visible | Replayable | ACK allowed | Send acceptance only | Evidence |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

function isCurrentGapScenario(scenarioId: TerminalReceiptGapScenarioId): scenarioId is CurrentPostCutoffGapScenarioId {
  return (CURRENT_POST_CUTOFF_GAP_SCENARIOS as readonly string[]).includes(scenarioId);
}

function summarizeGapFixture(fixture: TerminalReceiptGapFixture, decision: TerminalReceiptGapDecision): string {
  if (decision === "allow_receipt_confirmed_ack") {
    return "real operator-visible/receipt-confirmed evidence exists; dry-run model would allow ACK, but no production ACK is attempted";
  }
  switch (fixture.receiptState) {
    case "accepted":
      return "provider accepted the send request only; keep current gap operator-visible and replayable";
    case "sent":
      return "legacy send handoff is not delivery evidence; keep current gap unacked for reconciliation replay";
    case "provider_sent":
      return "provider send-only success recorded; provider send acceptance is never terminal ACK evidence; keep unacked for operator-visible/provider-delivery reconciliation";
    case "provider-delivered-if-known":
      return "provider delivery is unknown in this shaped gap; do not infer receipt from send acceptance";
    case "timed_out":
      return "receipt window timed out; visible retry candidate remains unacked";
    case "stale":
      return "stale cursor/current gap remains replayable; never forge ACK during cleanup";
    case "failed":
      return "failed delivery is operator evidence of non-delivery, not ACK evidence";
    case "operator-visible":
      return "operator-visible evidence missing receipt confirmation; hold unacked";
  }
}
