import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CURRENT_POST_CUTOFF_GAP_SCENARIOS,
  TERMINAL_RECEIPT_VOCABULARY_STATES,
  renderTerminalReceiptGapMarkdown,
  runTerminalReceiptGapMatrix,
} from "./terminal-receipt-gap-matrix.js";

describe("terminal receipt gap no-live matrix", () => {
  it("models the seven current post-cutoff gaps as visible, replayable, and unacked", () => {
    const matrix = runTerminalReceiptGapMatrix({ generatedAt: "2026-05-04T11:10:00.000Z" });

    assert.equal(matrix.kind, "terminal-receipt-gap.no-live.matrix");
    assert.equal(matrix.runMode, "no-live");
    assert.equal(matrix.overallVerdict, "pass");
    assert.equal(matrix.currentGapCount, 7);

    const currentGaps = matrix.cells.filter((cell) => CURRENT_POST_CUTOFF_GAP_SCENARIOS.includes(cell.scenarioId as never));
    assert.deepEqual(currentGaps.map((cell) => cell.scenarioId), [...CURRENT_POST_CUTOFF_GAP_SCENARIOS]);
    assert.equal(currentGaps.every((cell) => cell.operatorVisible), true);
    assert.equal(currentGaps.every((cell) => cell.replayable), true);
    assert.equal(currentGaps.every((cell) => cell.ackAllowed === false), true);
    assert.equal(currentGaps.every((cell) => cell.productionAckAttempted === false), true);
    assert.equal(currentGaps.every((cell) => cell.providerCalled === false), true);
  });

  it("covers every receipt vocabulary state including the positive ACK control", () => {
    const matrix = runTerminalReceiptGapMatrix({ generatedAt: "2026-05-04T11:10:00.000Z" });

    assert.deepEqual(matrix.vocabularyStates, [...TERMINAL_RECEIPT_VOCABULARY_STATES]);
    assert.deepEqual(
      matrix.cells.map((cell) => cell.receiptState).sort(),
      [...TERMINAL_RECEIPT_VOCABULARY_STATES].sort(),
    );

    const positiveControl = matrix.cells.find((cell) => cell.scenarioId === "operator_visible_positive_control");
    assert.equal(positiveControl?.decision, "allow_receipt_confirmed_ack");
    assert.equal(positiveControl?.ackAllowed, true);
    assert.equal(positiveControl?.productionAckAttempted, false);
  });

  it("does not confuse provider send acceptance with receipt-confirmed ACK evidence", () => {
    const matrix = runTerminalReceiptGapMatrix({ generatedAt: "2026-05-04T11:10:00.000Z" });
    const sendAcceptedOnly = matrix.cells.filter((cell) => cell.providerSendAcceptanceOnly);

    assert.ok(sendAcceptedOnly.length >= 4);
    assert.equal(sendAcceptedOnly.every((cell) => cell.decision === "hold_unacked_replayable"), true);
    assert.equal(sendAcceptedOnly.every((cell) => cell.ackAllowed === false), true);
    assert.equal(sendAcceptedOnly.every((cell) => cell.summary.length > 0), true);
  });

  it("renders a secret-free operator scenario table", () => {
    const matrix = runTerminalReceiptGapMatrix({ generatedAt: "2026-05-04T11:10:00.000Z" });
    const markdown = renderTerminalReceiptGapMarkdown(matrix);

    assert.match(markdown, /Current post-cutoff gaps modeled: 7/);
    assert.match(markdown, /provider-delivered-if-known/);
    assert.match(markdown, /productionAckAttempted=false/);
    assert.doesNotMatch(markdown, /token|secret|password|file:\/\//i);
  });
});
