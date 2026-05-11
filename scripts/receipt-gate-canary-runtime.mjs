// Runtime JavaScript copy of the receipt-gate canary matrix used by
// scripts/receipt-gate-canary.mjs when dist/ is not present. Keep this module
// dependency-free so the canary can run before build/install side effects.

export const RECEIPT_GATE_CANARY_SCENARIOS = [
  'no_notification_configured',
  'send_accepted_no_receipt',
  'provider_sent_no_receipt',
  'provider_accepted_no_receipt',
  'receipt_confirmed',
  'send_failed',
  'stale_timed_out',
  'stale_receipt_blocker',
  'retry_requeue_blocker',
  'duplicate_terminal_event',
];

export function defaultReceiptGateCanaryFixtures() {
  return [
    { scenarioId: 'no_notification_configured', notificationConfigured: false, terminalEventId: 'terminal:canary-no-config' },
    { scenarioId: 'send_accepted_no_receipt', notificationConfigured: true, terminalEventId: 'terminal:canary-send-accepted', sendAccepted: true },
    { scenarioId: 'provider_sent_no_receipt', notificationConfigured: true, terminalEventId: 'terminal:canary-provider-sent', sendAccepted: true, providerSent: true },
    { scenarioId: 'provider_accepted_no_receipt', notificationConfigured: true, terminalEventId: 'terminal:canary-provider-accepted', sendAccepted: true, providerSent: true, providerAccepted: true },
    { scenarioId: 'receipt_confirmed', notificationConfigured: true, terminalEventId: 'terminal:canary-receipt-confirmed', sendAccepted: true, providerReceipt: true },
    { scenarioId: 'send_failed', notificationConfigured: true, terminalEventId: 'terminal:canary-send-failed', sendFailed: true },
    { scenarioId: 'stale_timed_out', notificationConfigured: true, terminalEventId: 'terminal:canary-stale-timeout', sendAccepted: true, staleTimedOut: true },
    { scenarioId: 'stale_receipt_blocker', notificationConfigured: true, terminalEventId: 'terminal:canary-stale-blocker', sendAccepted: true, staleReceipt: true },
    { scenarioId: 'retry_requeue_blocker', notificationConfigured: true, terminalEventId: 'terminal:canary-retry-blocker', sendAccepted: true, staleTimedOut: true, retryRequeueCandidate: true },
    { scenarioId: 'duplicate_terminal_event', notificationConfigured: true, terminalEventId: 'terminal:canary-duplicate', duplicateOf: 'terminal:canary-receipt-confirmed', providerReceipt: true },
  ];
}

export function runReceiptGateCanaryMatrix(options = {}) {
  const fixtures = options.fixtures ?? defaultReceiptGateCanaryFixtures();
  const cells = fixtures.map(evaluateReceiptGateCanaryFixture);
  return {
    kind: 'receipt-gate.canary.matrix',
    runMode: 'no-live',
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    cells,
    overallVerdict: cells.every((cell) => cell.verdict === 'pass') ? 'pass' : 'fail',
  };
}

export function evaluateReceiptGateCanaryFixture(fixture) {
  const providerCalled = false;
  const productionAckAttempted = false;
  const duplicate = typeof fixture.duplicateOf === 'string' && fixture.duplicateOf.length > 0;
  const ackAllowed = Boolean(fixture.providerReceipt) && !duplicate;
  const retryBlocked = Boolean(fixture.retryRequeueCandidate) && !fixture.providerReceipt;
  const decision = duplicate
    ? 'suppress_duplicate'
    : retryBlocked
      ? 'block_retry'
      : ackAllowed
        ? 'receipt_confirmed'
        : 'hold_unacked';
  const summary = summarizeFixture(fixture);
  const verdict = expectedDecision(fixture.scenarioId) === decision && providerCalled === false && productionAckAttempted === false
    ? 'pass'
    : 'fail';
  return { scenarioId: fixture.scenarioId, verdict, decision, ackAllowed, providerCalled, productionAckAttempted, summary };
}

export function renderReceiptGateCanaryMarkdown(matrix) {
  const rows = matrix.cells.map((cell) => (
    `| ${cell.scenarioId} | ${cell.verdict} | ${cell.decision} | ${cell.ackAllowed ? 'yes' : 'no'} | ${cell.summary} |`
  ));
  return [
    `Receipt-gate no-live canary matrix: ${matrix.overallVerdict}`,
    '',
    `Generated: ${matrix.generatedAt}`,
    'Run mode: no-live (providerCalled=false, productionAckAttempted=false for every scenario)',
    '',
    '| Scenario | Verdict | Decision | ACK allowed | Operator-safe evidence |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

function expectedDecision(scenarioId) {
  switch (scenarioId) {
    case 'receipt_confirmed':
      return 'receipt_confirmed';
    case 'duplicate_terminal_event':
      return 'suppress_duplicate';
    case 'retry_requeue_blocker':
      return 'block_retry';
    case 'no_notification_configured':
    case 'send_accepted_no_receipt':
    case 'provider_sent_no_receipt':
    case 'provider_accepted_no_receipt':
    case 'send_failed':
    case 'stale_timed_out':
    case 'stale_receipt_blocker':
      return 'hold_unacked';
    default:
      return 'hold_unacked';
  }
}

function summarizeFixture(fixture) {
  switch (fixture.scenarioId) {
    case 'no_notification_configured':
      return 'notification channel absent; terminal event remains replayable until a real receipt path exists';
    case 'send_accepted_no_receipt':
      return 'send acceptance alone is not receipt evidence; terminal event remains unacked';
    case 'provider_sent_no_receipt':
      return 'provider_sent is send-only success, not delivery receipt evidence; terminal event remains unacked — provider_sent ≠ operator-visible ≠ ACK';
    case 'provider_accepted_no_receipt':
      return 'provider_accepted is transport ack, not operator-visible confirmation; terminal event remains unacked — provider_accepted ≠ operator-visible ≠ ACK';
    case 'receipt_confirmed':
      return 'provider/operator receipt present; dry-run model would allow receipt-confirmed ACK';
    case 'send_failed':
      return 'send failure is operator-visible evidence of non-delivery; terminal event remains unacked';
    case 'stale_timed_out':
      return 'accepted send exceeded receipt timeout; terminal event remains replayable for reconciliation';
    case 'stale_receipt_blocker':
      return 'stale receipt detected without live row mutation; terminal event remains unacked and replayable — no DB mutation performed';
    case 'retry_requeue_blocker':
      return 'retry/requeue candidate detected without receipt evidence; block retry until operator-visible/provider-delivery evidence — no live requeue performed';
    case 'duplicate_terminal_event':
      return `duplicate of ${fixture.duplicateOf}; suppress duplicate notification without a second ACK`;
    default:
      return 'unknown scenario; terminal event remains unacked';
  }
}
