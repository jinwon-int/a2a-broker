/**
 * No-live receipt-gate canary matrix for terminal notification ACK safety.
 *
 * The matrix is intentionally pure and deterministic: it never calls provider
 * APIs and never acknowledges broker terminal-outbox rows. It models the states
 * a notifier/plugin can observe and produces operator-safe evidence that can be
 * attached to a pre-deploy proof comment.
 */

export const RECEIPT_GATE_CANARY_SCENARIOS = [
  "no_notification_configured",
  "send_accepted_no_receipt",
  "receipt_confirmed",
  "send_failed",
  "stale_timed_out",
  "duplicate_terminal_event",
] as const;

export type ReceiptGateCanaryScenarioId = (typeof RECEIPT_GATE_CANARY_SCENARIOS)[number];
export type ReceiptGateCanaryDecision = "hold_unacked" | "receipt_confirmed" | "suppress_duplicate";

export interface ReceiptGateCanaryFixture {
  scenarioId: ReceiptGateCanaryScenarioId;
  notificationConfigured: boolean;
  terminalEventId: string;
  sendAccepted?: boolean;
  providerReceipt?: boolean;
  sendFailed?: boolean;
  staleTimedOut?: boolean;
  duplicateOf?: string;
}

export interface ReceiptGateCanaryCell {
  scenarioId: ReceiptGateCanaryScenarioId;
  verdict: "pass" | "fail";
  decision: ReceiptGateCanaryDecision;
  ackAllowed: boolean;
  providerCalled: false;
  productionAckAttempted: false;
  summary: string;
}

export interface ReceiptGateCanaryMatrix {
  kind: "receipt-gate.canary.matrix";
  runMode: "no-live";
  generatedAt: string;
  cells: ReceiptGateCanaryCell[];
  overallVerdict: "pass" | "fail";
}

export function defaultReceiptGateCanaryFixtures(): ReceiptGateCanaryFixture[] {
  return [
    {
      scenarioId: "no_notification_configured",
      notificationConfigured: false,
      terminalEventId: "terminal:canary-no-config",
    },
    {
      scenarioId: "send_accepted_no_receipt",
      notificationConfigured: true,
      terminalEventId: "terminal:canary-send-accepted",
      sendAccepted: true,
    },
    {
      scenarioId: "receipt_confirmed",
      notificationConfigured: true,
      terminalEventId: "terminal:canary-receipt-confirmed",
      sendAccepted: true,
      providerReceipt: true,
    },
    {
      scenarioId: "send_failed",
      notificationConfigured: true,
      terminalEventId: "terminal:canary-send-failed",
      sendFailed: true,
    },
    {
      scenarioId: "stale_timed_out",
      notificationConfigured: true,
      terminalEventId: "terminal:canary-stale-timeout",
      sendAccepted: true,
      staleTimedOut: true,
    },
    {
      scenarioId: "duplicate_terminal_event",
      notificationConfigured: true,
      terminalEventId: "terminal:canary-duplicate",
      duplicateOf: "terminal:canary-receipt-confirmed",
      providerReceipt: true,
    },
  ];
}

export function runReceiptGateCanaryMatrix(options: {
  generatedAt?: string;
  fixtures?: ReceiptGateCanaryFixture[];
} = {}): ReceiptGateCanaryMatrix {
  const fixtures = options.fixtures ?? defaultReceiptGateCanaryFixtures();
  const cells = fixtures.map(evaluateReceiptGateCanaryFixture);
  return {
    kind: "receipt-gate.canary.matrix",
    runMode: "no-live",
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    cells,
    overallVerdict: cells.every((cell) => cell.verdict === "pass") ? "pass" : "fail",
  };
}

export function evaluateReceiptGateCanaryFixture(fixture: ReceiptGateCanaryFixture): ReceiptGateCanaryCell {
  const providerCalled = false as const;
  const productionAckAttempted = false as const;
  const duplicate = typeof fixture.duplicateOf === "string" && fixture.duplicateOf.length > 0;
  const ackAllowed = Boolean(fixture.providerReceipt) && !duplicate;
  const decision: ReceiptGateCanaryDecision = duplicate
    ? "suppress_duplicate"
    : ackAllowed
      ? "receipt_confirmed"
      : "hold_unacked";

  const summary = summarizeFixture(fixture, decision);
  const verdict = expectedDecision(fixture.scenarioId) === decision && providerCalled === false && productionAckAttempted === false
    ? "pass"
    : "fail";

  return {
    scenarioId: fixture.scenarioId,
    verdict,
    decision,
    ackAllowed,
    providerCalled,
    productionAckAttempted,
    summary,
  };
}

export function renderReceiptGateCanaryMarkdown(matrix: ReceiptGateCanaryMatrix): string {
  const rows = matrix.cells.map((cell) => (
    `| ${cell.scenarioId} | ${cell.verdict} | ${cell.decision} | ${cell.ackAllowed ? "yes" : "no"} | ${cell.summary} |`
  ));
  return [
    `Receipt-gate no-live canary matrix: ${matrix.overallVerdict}`,
    "",
    `Generated: ${matrix.generatedAt}`,
    "Run mode: no-live (providerCalled=false, productionAckAttempted=false for every scenario)",
    "",
    "| Scenario | Verdict | Decision | ACK allowed | Operator-safe evidence |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

function expectedDecision(scenarioId: ReceiptGateCanaryScenarioId): ReceiptGateCanaryDecision {
  switch (scenarioId) {
    case "receipt_confirmed":
      return "receipt_confirmed";
    case "duplicate_terminal_event":
      return "suppress_duplicate";
    case "no_notification_configured":
    case "send_accepted_no_receipt":
    case "send_failed":
    case "stale_timed_out":
      return "hold_unacked";
  }
}

function summarizeFixture(fixture: ReceiptGateCanaryFixture, decision: ReceiptGateCanaryDecision): string {
  switch (fixture.scenarioId) {
    case "no_notification_configured":
      return "notification channel absent; terminal event remains replayable until a real receipt path exists";
    case "send_accepted_no_receipt":
      return "send acceptance alone is not receipt evidence; terminal event remains unacked";
    case "receipt_confirmed":
      return "provider/operator receipt present; dry-run model would allow receipt-confirmed ACK";
    case "send_failed":
      return "send failure is operator-visible evidence of non-delivery; terminal event remains unacked";
    case "stale_timed_out":
      return "accepted send exceeded receipt timeout; terminal event remains replayable for reconciliation";
    case "duplicate_terminal_event":
      return `duplicate of ${fixture.duplicateOf}; suppress duplicate notification without a second ACK`;
  }
}
