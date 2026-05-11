import type { ReceiptGateCanaryMatrix } from "./receipt-gate-canary.js";

const SAFE_ACK_EVIDENCE = new Set([
  "current_session_visible",
  "operator_visible",
  "operator_confirmed",
  "provider_delivery_receipt",
]);

const SEND_ONLY_OR_PENDING_RECEIPT = new Set([
  "accepted",
  "started",
  "produced",
  "provider_sent",
  "provider_accepted",
]);

const REQUIRED_CANARY_DECISIONS = new Map([
  ["send_accepted_no_receipt", "hold_unacked"],
  ["provider_sent_no_receipt", "hold_unacked"],
  ["provider_accepted_no_receipt", "hold_unacked"],
  ["receipt_confirmed", "receipt_confirmed"],
]);

export type TerminalReceiptBucket =
  | "send_accepted_no_receipt"
  | "receipt_confirmed"
  | "failed"
  | "stale_or_timed_out"
  | "missing_receipt_state";

export interface BrokerTerminalReceiptSummary {
  brokerId: string;
  validOutboxShape: boolean;
  totalEvents: number;
  buckets: Record<TerminalReceiptBucket, number>;
  observedAckStatuses: string[];
  observedReceiptStatuses: string[];
  unsafeEvidenceUrlCount: number;
  blockers: string[];
}

export interface BrokerTerminalReceiptParityReport {
  kind: "broker-terminal-receipt.parity";
  ok: boolean;
  receiptGateCanaryVerdict: "pass" | "fail";
  seoseo: BrokerTerminalReceiptSummary;
  gwakga: BrokerTerminalReceiptSummary;
  discrepancies: string[];
  fixProposals: string[];
  safety: {
    readOnly: true;
    providerCalled: false;
    productionAckAttempted: false;
    dbMutationAttempted: false;
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function firstEvidenceUrl(payload: Record<string, unknown> | null): string | undefined {
  if (!payload) return undefined;
  for (const key of ["prUrl", "doneUrl", "blockUrl"]) {
    const value = stringValue(payload[key]);
    if (value) return value;
  }
  return undefined;
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//.test(value);
}

function emptyBuckets(): Record<TerminalReceiptBucket, number> {
  return {
    send_accepted_no_receipt: 0,
    receipt_confirmed: 0,
    failed: 0,
    stale_or_timed_out: 0,
    missing_receipt_state: 0,
  };
}

function bucketFor(receiptStatus: string | undefined, receiptConfirmed: boolean): TerminalReceiptBucket {
  if (receiptConfirmed) return "receipt_confirmed";
  if (receiptStatus === "failed") return "failed";
  if (receiptStatus === "stale" || receiptStatus === "timed_out") return "stale_or_timed_out";
  if (receiptStatus && SEND_ONLY_OR_PENDING_RECEIPT.has(receiptStatus)) return "send_accepted_no_receipt";
  return "missing_receipt_state";
}

export function analyzeBrokerTerminalReceiptSnapshot(
  brokerId: string,
  snapshot: unknown,
): BrokerTerminalReceiptSummary {
  const body = asRecord(snapshot);
  const blockers: string[] = [];
  const buckets = emptyBuckets();
  const ackStatuses = new Set<string>();
  const receiptStatuses = new Set<string>();
  let unsafeEvidenceUrlCount = 0;

  if (!body) {
    return {
      brokerId,
      validOutboxShape: false,
      totalEvents: 0,
      buckets,
      observedAckStatuses: [],
      observedReceiptStatuses: [],
      unsafeEvidenceUrlCount: 0,
      blockers: [`${brokerId}: terminal-outbox response must be a JSON object`],
    };
  }

  if (body.kind !== "task.terminal.outbox") {
    blockers.push(`${brokerId}: terminal-outbox kind must be task.terminal.outbox`);
  }

  const events = Array.isArray(body.events) ? body.events : [];
  if (!Array.isArray(body.events)) {
    blockers.push(`${brokerId}: terminal-outbox events must be an array`);
  }

  for (const rawEvent of events) {
    const event = asRecord(rawEvent);
    const eventId = stringValue(event?.id) ?? "<missing-id>";
    if (!event || eventId === "<missing-id>") blockers.push(`${brokerId}: terminal event is missing stable id`);

    const ack = asRecord(event?.ack);
    const receipt = asRecord(event?.receipt);
    const payload = asRecord(event?.payload);
    const ackStatus = stringValue(ack?.status);
    const receiptStatus = stringValue(receipt?.status);
    if (ackStatus) ackStatuses.add(ackStatus);
    if (receiptStatus) receiptStatuses.add(receiptStatus);

    const receiptConfirmed = ackStatus === "receipt_confirmed";
    buckets[bucketFor(receiptStatus, receiptConfirmed)] += 1;

    const evidenceUrl = firstEvidenceUrl(payload);
    if (evidenceUrl && !isHttpUrl(evidenceUrl)) {
      unsafeEvidenceUrlCount += 1;
      blockers.push(`${brokerId}:${eventId}: evidence URL must be http(s)`);
    }

    if (!receiptConfirmed && !evidenceUrl) {
      blockers.push(`${brokerId}:${eventId}: unacknowledged terminal event is missing PR/Done/Block evidence URL`);
    }

    if (receiptConfirmed) {
      const evidence = stringValue(ack?.evidence) ?? stringValue(receipt?.evidence) ?? stringValue(payload?.receiptEvidence);
      if (!evidence || !SAFE_ACK_EVIDENCE.has(evidence)) {
        blockers.push(`${brokerId}:${eventId}: receipt_confirmed ACK requires operator-visible/current-session/provider-delivery evidence`);
      }
    }
  }

  return {
    brokerId,
    validOutboxShape: body.kind === "task.terminal.outbox" && Array.isArray(body.events),
    totalEvents: events.length,
    buckets,
    observedAckStatuses: [...ackStatuses].sort(),
    observedReceiptStatuses: [...receiptStatuses].sort(),
    unsafeEvidenceUrlCount,
    blockers,
  };
}

function canaryBlockers(matrix: ReceiptGateCanaryMatrix): string[] {
  const blockers: string[] = [];
  if (matrix.overallVerdict !== "pass") blockers.push("receipt-gate canary overall verdict must pass");

  for (const [scenarioId, expectedDecision] of REQUIRED_CANARY_DECISIONS) {
    const cell = matrix.cells.find((candidate) => candidate.scenarioId === scenarioId);
    if (!cell) {
      blockers.push(`receipt-gate canary missing scenario ${scenarioId}`);
      continue;
    }
    if (cell.verdict !== "pass" || cell.decision !== expectedDecision || cell.providerCalled !== false || cell.productionAckAttempted !== false) {
      blockers.push(`receipt-gate canary scenario ${scenarioId} must decide ${expectedDecision} without provider call or production ACK`);
    }
  }

  return blockers;
}

function bucketDiscrepancies(seoseo: BrokerTerminalReceiptSummary, gwakga: BrokerTerminalReceiptSummary): string[] {
  const discrepancies: string[] = [];
  for (const bucket of Object.keys(seoseo.buckets) as TerminalReceiptBucket[]) {
    const left = seoseo.buckets[bucket];
    const right = gwakga.buckets[bucket];
    if ((left === 0) !== (right === 0)) {
      discrepancies.push(`observed ${bucket} rows differ: seoseo=${left}, gwakga=${right}`);
    }
  }
  return discrepancies;
}

export function compareBrokerTerminalReceiptParity(options: {
  seoseo: BrokerTerminalReceiptSummary;
  gwakga: BrokerTerminalReceiptSummary;
  receiptGateCanary: ReceiptGateCanaryMatrix;
}): BrokerTerminalReceiptParityReport {
  const blockers = [
    ...options.seoseo.blockers,
    ...options.gwakga.blockers,
    ...canaryBlockers(options.receiptGateCanary),
  ];
  const discrepancies = bucketDiscrepancies(options.seoseo, options.gwakga);
  const fixProposals = [
    ...blockers.map((blocker) => `Fix ${blocker}.`),
    ...discrepancies.map((discrepancy) => `Investigate ${discrepancy}; rerun terminal_outbox_preflight on both brokers with the same cursor/limit and backfill only after operator-approved receipt evidence.`),
  ];

  return {
    kind: "broker-terminal-receipt.parity",
    ok: blockers.length === 0,
    receiptGateCanaryVerdict: options.receiptGateCanary.overallVerdict,
    seoseo: options.seoseo,
    gwakga: options.gwakga,
    discrepancies,
    fixProposals,
    safety: {
      readOnly: true,
      providerCalled: false,
      productionAckAttempted: false,
      dbMutationAttempted: false,
    },
  };
}

export function renderBrokerTerminalReceiptParityMarkdown(report: BrokerTerminalReceiptParityReport): string {
  const lines = [
    `Broker terminal receipt cross-broker parity: ${report.ok ? "pass" : "block"}`,
    "",
    "Safety: read-only only; providerCalled=false, productionAckAttempted=false, dbMutationAttempted=false.",
    `Receipt-gate canary: ${report.receiptGateCanaryVerdict}`,
    "",
    "| Broker | Events | send accepted/no receipt | receipt confirmed | failed | stale/timed out | missing receipt state |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    renderBrokerRow(report.seoseo),
    renderBrokerRow(report.gwakga),
  ];

  if (report.discrepancies.length > 0) {
    lines.push("", "Observed discrepancies:", ...report.discrepancies.map((item) => `- ${item}`));
  }

  if (report.fixProposals.length > 0) {
    lines.push("", report.ok ? "Follow-up proposals:" : "Fix proposals:", ...report.fixProposals.map((item) => `- ${item}`));
  }

  return lines.join("\n");
}

function renderBrokerRow(summary: BrokerTerminalReceiptSummary): string {
  return `| ${summary.brokerId} | ${summary.totalEvents} | ${summary.buckets.send_accepted_no_receipt} | ${summary.buckets.receipt_confirmed} | ${summary.buckets.failed} | ${summary.buckets.stale_or_timed_out} | ${summary.buckets.missing_receipt_state} |`;
}
