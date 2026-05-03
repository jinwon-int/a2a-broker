import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  RECEIPT_GATE_CANARY_SCENARIOS,
  renderReceiptGateCanaryMarkdown,
  runReceiptGateCanaryMatrix,
} from "./receipt-gate-canary.js";

describe("receipt-gate no-live canary matrix", () => {
  it("covers required receipt-gate scenarios without provider calls or production ACKs", () => {
    const matrix = runReceiptGateCanaryMatrix({ generatedAt: "2026-05-03T00:00:00.000Z" });

    assert.equal(matrix.kind, "receipt-gate.canary.matrix");
    assert.equal(matrix.runMode, "no-live");
    assert.equal(matrix.overallVerdict, "pass");
    assert.deepEqual(matrix.cells.map((cell) => cell.scenarioId), [...RECEIPT_GATE_CANARY_SCENARIOS]);
    assert.equal(matrix.cells.every((cell) => cell.providerCalled === false), true);
    assert.equal(matrix.cells.every((cell) => cell.productionAckAttempted === false), true);
  });

  it("allows ACK only for actual receipt confirmation", () => {
    const matrix = runReceiptGateCanaryMatrix({ generatedAt: "2026-05-03T00:00:00.000Z" });
    const byScenario = new Map(matrix.cells.map((cell) => [cell.scenarioId, cell]));

    assert.equal(byScenario.get("no_notification_configured")?.decision, "hold_unacked");
    assert.equal(byScenario.get("send_accepted_no_receipt")?.decision, "hold_unacked");
    assert.equal(byScenario.get("receipt_confirmed")?.decision, "receipt_confirmed");
    assert.equal(byScenario.get("receipt_confirmed")?.ackAllowed, true);
    assert.equal(byScenario.get("send_failed")?.decision, "hold_unacked");
    assert.equal(byScenario.get("stale_timed_out")?.decision, "hold_unacked");
    assert.equal(byScenario.get("duplicate_terminal_event")?.decision, "suppress_duplicate");
    assert.equal(byScenario.get("duplicate_terminal_event")?.ackAllowed, false);
  });

  it("renders operator-safe evidence summaries", () => {
    const matrix = runReceiptGateCanaryMatrix({ generatedAt: "2026-05-03T00:00:00.000Z" });
    const markdown = renderReceiptGateCanaryMarkdown(matrix);

    assert.match(markdown, /Run mode: no-live/);
    assert.match(markdown, /send acceptance alone is not receipt evidence/);
    assert.match(markdown, /suppress duplicate notification without a second ACK/);
    assert.doesNotMatch(markdown, /token|secret|password|file:\/\//i);
  });
});
