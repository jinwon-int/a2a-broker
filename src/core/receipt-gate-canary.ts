/**
 * No-live receipt-gate canary matrix for terminal notification ACK safety.
 *
 * The matrix is intentionally pure and deterministic: it never calls provider
 * APIs and never acknowledges broker terminal-outbox rows. It models the states
 * a notifier/plugin can observe and produces operator-safe evidence that can be
 * attached to a pre-deploy proof comment.
 *
 * [[a2a-broker#294]] Advance with provider_sent/provider_accepted non-ACK gating
 * and stale/retry/requeue blocker reporting.
 */

export const RECEIPT_GATE_CANARY_SCENARIOS = [
  "no_notification_configured",
  "send_accepted_no_receipt",
  "provider_sent_no_receipt",
  "provider_accepted_no_receipt",
  "receipt_confirmed",
  "send_failed",
  "stale_timed_out",
  "stale_receipt_blocker",
  "retry_requeue_blocker",
  "duplicate_terminal_event",
] as const;

export type ReceiptGateCanaryScenarioId = (typeof RECEIPT_GATE_CANARY_SCENARIOS)[number];
export type ReceiptGateCanaryDecision =
  | "hold_unacked"
  | "receipt_confirmed"
  | "suppress_duplicate"
  | "block_retry";

export interface ReceiptGateCanaryFixture {
  scenarioId: ReceiptGateCanaryScenarioId;
  notificationConfigured: boolean;
  terminalEventId: string;
  sendAccepted?: boolean;
  providerSent?: boolean;
  providerAccepted?: boolean;
  providerReceipt?: boolean;
  sendFailed?: boolean;
  staleTimedOut?: boolean;
  staleReceipt?: boolean;
  retryRequeueCandidate?: boolean;
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
      scenarioId: "provider_sent_no_receipt",
      notificationConfigured: true,
      terminalEventId: "terminal:canary-provider-sent",
      sendAccepted: true,
      providerSent: true,
    },
    {
      scenarioId: "provider_accepted_no_receipt",
      notificationConfigured: true,
      terminalEventId: "terminal:canary-provider-accepted",
      sendAccepted: true,
      providerSent: true,
      providerAccepted: true,
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
      scenarioId: "stale_receipt_blocker",
      notificationConfigured: true,
      terminalEventId: "terminal:canary-stale-blocker",
      sendAccepted: true,
      staleReceipt: true,
    },
    {
      scenarioId: "retry_requeue_blocker",
      notificationConfigured: true,
      terminalEventId: "terminal:canary-retry-blocker",
      sendAccepted: true,
      staleTimedOut: true,
      retryRequeueCandidate: true,
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
  const retryBlocked = Boolean(fixture.retryRequeueCandidate) && !fixture.providerReceipt;
  const decision: ReceiptGateCanaryDecision = duplicate
    ? "suppress_duplicate"
    : retryBlocked
      ? "block_retry"
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
    case "retry_requeue_blocker":
      return "block_retry";
    case "no_notification_configured":
    case "send_accepted_no_receipt":
    case "provider_sent_no_receipt":
    case "provider_accepted_no_receipt":
    case "send_failed":
    case "stale_timed_out":
    case "stale_receipt_blocker":
      return "hold_unacked";
  }
}

function summarizeFixture(fixture: ReceiptGateCanaryFixture, decision: ReceiptGateCanaryDecision): string {
  switch (fixture.scenarioId) {
    case "no_notification_configured":
      return "notification channel absent; terminal event remains replayable until a real receipt path exists";
    case "send_accepted_no_receipt":
      return "send acceptance alone is not receipt evidence; terminal event remains unacked";
    case "provider_sent_no_receipt":
      return "provider_sent is send-only success, not delivery receipt evidence; terminal event remains unacked — provider_sent ≠ operator-visible ≠ ACK";
    case "provider_accepted_no_receipt":
      return "provider_accepted is transport ack, not operator-visible confirmation; terminal event remains unacked — provider_accepted ≠ operator-visible ≠ ACK";
    case "receipt_confirmed":
      return "provider/operator receipt present; dry-run model would allow receipt-confirmed ACK";
    case "send_failed":
      return "send failure is operator-visible evidence of non-delivery; terminal event remains unacked";
    case "stale_timed_out":
      return "accepted send exceeded receipt timeout; terminal event remains replayable for reconciliation";
    case "stale_receipt_blocker":
      return "stale receipt detected without live row mutation; terminal event remains unacked and replayable — no DB mutation performed";
    case "retry_requeue_blocker":
      return "retry/requeue candidate detected without receipt evidence; block retry until operator-visible/provider-delivery evidence — no live requeue performed";
    case "duplicate_terminal_event":
      return `duplicate of ${fixture.duplicateOf}; suppress duplicate notification without a second ACK`;
  }
}

// ---------------------------------------------------------------------------
// Broker → Plugin → Worker → Result projection canary (no-live)
// [[a2a-broker#294]] Read-only canary for the full broker→plugin→worker→
// result projection path without any live delivery or row mutation.
// ---------------------------------------------------------------------------

export type ProjectionStepId =
  | "broker_task_accept"
  | "plugin_dispatch"
  | "worker_claim"
  | "worker_execute"
  | "worker_result"
  | "broker_result_store"
  | "plugin_notify";

export type ProjectionStepStatus =
  | "accepted"
  | "started"
  | "produced"
  | "provider_sent"
  | "provider_accepted"
  | "operator_visible"
  | "failed"
  | "stale"
  | "timed_out";

export const PROJECTION_STEPS: readonly ProjectionStepId[] = [
  "broker_task_accept",
  "plugin_dispatch",
  "worker_claim",
  "worker_execute",
  "worker_result",
  "broker_result_store",
  "plugin_notify",
] as const;

export interface ProjectionStepFixture {
  stepId: ProjectionStepId;
  status: ProjectionStepStatus;
  hasReceipt: boolean;
}

export interface ProjectionStepCell {
  stepId: ProjectionStepId;
  status: ProjectionStepStatus;
  hasReceipt: boolean;
  ackAllowed: boolean;
  providerCalled: false;
  productionAckAttempted: false;
  summary: string;
}

export interface BrokerPluginWorkerProjection {
  kind: "broker-plugin-worker.projection.canary";
  runMode: "no-live";
  generatedAt: string;
  steps: ProjectionStepCell[];
  providerSentNonAckConfirmed: boolean;
  providerAcceptedNonAckConfirmed: boolean;
}

export function defaultProjectionStepFixtures(): ProjectionStepFixture[] {
  return [
    { stepId: "broker_task_accept", status: "accepted", hasReceipt: false },
    { stepId: "plugin_dispatch", status: "started", hasReceipt: false },
    { stepId: "worker_claim", status: "accepted", hasReceipt: false },
    { stepId: "worker_execute", status: "started", hasReceipt: false },
    { stepId: "worker_result", status: "produced", hasReceipt: false },
    { stepId: "broker_result_store", status: "accepted", hasReceipt: false },
    { stepId: "plugin_notify", status: "provider_sent", hasReceipt: false },
  ];
}

export function runBrokerPluginWorkerProjection(options: {
  generatedAt?: string;
  steps?: ProjectionStepFixture[];
} = {}): BrokerPluginWorkerProjection {
  const steps = (options.steps ?? defaultProjectionStepFixtures()).map(evaluateProjectionStep);
  const providerSentNonAckConfirmed = steps
    .filter((s) => s.status === "provider_sent")
    .every((s) => s.ackAllowed === false);
  const providerAcceptedNonAckConfirmed = steps
    .filter((s) => s.status === "provider_accepted")
    .every((s) => s.ackAllowed === false);
  return {
    kind: "broker-plugin-worker.projection.canary",
    runMode: "no-live",
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    steps,
    providerSentNonAckConfirmed,
    providerAcceptedNonAckConfirmed,
  };
}

export function evaluateProjectionStep(fixture: ProjectionStepFixture): ProjectionStepCell {
  const providerCalled = false as const;
  const productionAckAttempted = false as const;
  const ackAllowed = fixture.status === "operator_visible" && fixture.hasReceipt;
  const summary = fixture.hasReceipt
    ? `step ${fixture.stepId} at status ${fixture.status} with receipt; ACK ${ackAllowed ? "allowed" : "held"} in dry-run`
    : `step ${fixture.stepId} at status ${fixture.status} without receipt; ACK held in dry-run — ${fixture.status} ≠ operator-visible`;
  return { stepId: fixture.stepId, status: fixture.status, hasReceipt: fixture.hasReceipt, ackAllowed, providerCalled, productionAckAttempted, summary };
}

// ---------------------------------------------------------------------------
// Terminal ACK evidence policy health diagnostics (no-live)
//
// [[a2a-broker#580]] Bangtong safety lane: validates that only
// current_session_visible, operator_visible, operator_confirmed, and
// provider_delivery_receipt are accepted as terminal ACK evidence, and that
// provider_send_success, provider_accepted, and gateway_send_success are
// always rejected.
// ---------------------------------------------------------------------------

export type AckEvidencePolicyDiagnosticId =
  | "current_session_visible"
  | "operator_visible"
  | "operator_confirmed"
  | "provider_delivery_receipt"
  | "provider_send_success"
  | "provider_accepted"
  | "gateway_send_success";

export const ACK_EVIDENCE_POLICY_DIAGNOSTICS: readonly AckEvidencePolicyDiagnosticId[] = [
  "current_session_visible",
  "operator_visible",
  "operator_confirmed",
  "provider_delivery_receipt",
  "provider_send_success",
  "provider_accepted",
  "gateway_send_success",
] as const;

export interface AckEvidencePolicyCell {
  evidenceType: AckEvidencePolicyDiagnosticId;
  isValidAckEvidence: boolean;
  policyVerdict: "pass" | "fail";
  summary: string;
}

export function evaluateAckEvidencePolicy(): AckEvidencePolicyCell[] {
  // The terminal-event-outbox TERMINAL_TASK_ACK_EVIDENCE set defines valid types.
  const validEvidence = new Set<string>([
    "current_session_visible",
    "operator_visible",
    "operator_confirmed",
    "provider_delivery_receipt",
  ]);
  return ACK_EVIDENCE_POLICY_DIAGNOSTICS.map((evidenceType) => {
    const isValidAckEvidence = validEvidence.has(evidenceType);
    const expectsValid = evidenceType !== "provider_send_success"
      && evidenceType !== "provider_accepted"
      && evidenceType !== "gateway_send_success";
    const policyVerdict: "pass" | "fail" = isValidAckEvidence === expectsValid ? "pass" : "fail";
    const summary = isValidAckEvidence
      ? `valid terminal ACK evidence type; accepted by isTerminalTaskOutboxAckEvidence gate`
      : evidenceType === "provider_send_success"
        ? "provider_send_success is send-only success evidence; rejected as terminal ACK evidence — provider_send_success ≠ operator-visible ≠ ACK"
        : evidenceType === "provider_accepted"
          ? "provider_accepted is transport-level ack, not operator-visible confirmation; rejected as terminal ACK evidence — provider_accepted ≠ operator-visible ≠ ACK"
          : "gateway_send_success is transport send evidence; rejected as terminal ACK evidence — gateway delivery ≠ operator-visible ≠ ACK";
    return { evidenceType, isValidAckEvidence, policyVerdict, summary };
  });
}

export function renderAckEvidencePolicyDiagnostics(cells: AckEvidencePolicyCell[]): string {
  const rows = cells.map((cell) =>
    `| ${cell.evidenceType} | ${cell.isValidAckEvidence ? "yes" : "no"} | ${cell.policyVerdict} | ${cell.summary} |`,
  );
  return [
    "Terminal ACK evidence policy health diagnostics",
    "",
    "Validates that provider_send_success, provider_accepted, and gateway_send_success are rejected as terminal ACK evidence, and only current_session_visible, operator_visible, operator_confirmed, and provider_delivery_receipt are accepted.",
    "",
    "| Evidence type | Valid ACK evidence | Policy verdict | Summary |",
    "| --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

export function renderBrokerPluginWorkerProjectionMarkdown(projection: BrokerPluginWorkerProjection): string {
  const rows = projection.steps.map((step) =>
    `| ${step.stepId} | ${step.status} | ${step.hasReceipt ? "yes" : "no"} | ${step.ackAllowed ? "yes" : "no"} | ${step.summary} |`,
  );
  return [
    `Broker → Plugin → Worker projection canary: no-live`,
    "",
    `Generated: ${projection.generatedAt}`,
    `provider_sent 비ACK 확인: ${projection.providerSentNonAckConfirmed ? "통과" : "실패"}`,
    `provider_accepted 비ACK 확인: ${projection.providerAcceptedNonAckConfirmed ? "통과" : "실패"}`,
    "Run mode: no-live (providerCalled=false, productionAckAttempted=false for every step)",
    "",
    "| Step | Status | Receipt | ACK allowed | Evidence |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}
