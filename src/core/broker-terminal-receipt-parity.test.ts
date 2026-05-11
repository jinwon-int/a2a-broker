import assert from "node:assert/strict";
import { test } from "node:test";
import { runReceiptGateCanaryMatrix } from "./receipt-gate-canary.js";
import {
  analyzeBrokerTerminalReceiptSnapshot,
  compareBrokerTerminalReceiptParity,
  renderBrokerTerminalReceiptParityMarkdown,
} from "./broker-terminal-receipt-parity.js";

function outbox(events: unknown[]) {
  return {
    kind: "task.terminal.outbox",
    count: events.length,
    cursor: events.at(-1) && typeof events.at(-1) === "object" ? "cursor" : null,
    events,
  };
}

test("broker terminal receipt parity accepts provider-sent rows only as unacked receipt gaps", () => {
  const seoseo = analyzeBrokerTerminalReceiptSnapshot("seoseo", outbox([
    {
      id: "terminal:seoseo:1",
      receipt: { status: "provider_sent", updatedAt: "2026-05-11T00:00:00.000Z" },
      payload: { worker: "dungae", doneUrl: "https://github.com/jinwon-int/a2a-broker/issues/493#issuecomment-seoseo" },
    },
  ]));
  const gwakga = analyzeBrokerTerminalReceiptSnapshot("gwakga", outbox([
    {
      id: "terminal:gwakga:1",
      ack: { status: "receipt_confirmed", evidence: "operator_visible" },
      receipt: { status: "operator_visible", evidence: "operator_visible", updatedAt: "2026-05-11T00:00:01.000Z" },
      payload: { worker: "dungae", doneUrl: "https://github.com/jinwon-int/a2a-broker/issues/493#issuecomment-gwakga" },
    },
  ]));

  assert.equal(seoseo.blockers.length, 0);
  assert.equal(seoseo.buckets.send_accepted_no_receipt, 1);
  assert.equal(gwakga.blockers.length, 0);
  assert.equal(gwakga.buckets.receipt_confirmed, 1);

  const report = compareBrokerTerminalReceiptParity({
    seoseo,
    gwakga,
    receiptGateCanary: runReceiptGateCanaryMatrix({ generatedAt: "2026-05-11T00:00:00.000Z" }),
  });

  assert.equal(report.ok, true);
  assert.match(renderBrokerTerminalReceiptParityMarkdown(report), /providerCalled=false/);
  assert.match(report.fixProposals.join("\n"), /rerun terminal_outbox_preflight/);
});

test("broker terminal receipt parity blocks receipt-confirmed rows without receipt evidence", () => {
  const seoseo = analyzeBrokerTerminalReceiptSnapshot("seoseo", outbox([]));
  const gwakga = analyzeBrokerTerminalReceiptSnapshot("gwakga", outbox([
    {
      id: "terminal:gwakga:bad-ack",
      ack: { status: "receipt_confirmed", evidence: "provider_sent" },
      receipt: { status: "provider_sent", evidence: "provider_sent" },
      payload: { doneUrl: "https://github.com/jinwon-int/a2a-broker/issues/493#issuecomment-provider-sent" },
    },
  ]));

  const report = compareBrokerTerminalReceiptParity({
    seoseo,
    gwakga,
    receiptGateCanary: runReceiptGateCanaryMatrix({ generatedAt: "2026-05-11T00:00:00.000Z" }),
  });

  assert.equal(gwakga.blockers.length, 1);
  assert.equal(report.ok, false);
  assert.match(report.fixProposals.join("\n"), /receipt_confirmed ACK requires/);
});

test("broker terminal receipt parity blocks non-http evidence on unacked terminal rows", () => {
  const summary = analyzeBrokerTerminalReceiptSnapshot("seoseo", outbox([
    {
      id: "terminal:unsafe",
      receipt: { status: "accepted" },
      payload: { doneUrl: "file:///tmp/private.log" },
    },
  ]));

  assert.equal(summary.unsafeEvidenceUrlCount, 1);
  assert.match(summary.blockers.join("\n"), /evidence URL must be http\(s\)/);
});
