import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  RECEIPT_GATE_CANARY_SCENARIOS,
  renderReceiptGateCanaryMarkdown,
  runReceiptGateCanaryMatrix,
  PROJECTION_STEPS,
  runBrokerPluginWorkerProjection,
  renderBrokerPluginWorkerProjectionMarkdown,
  ACK_EVIDENCE_POLICY_DIAGNOSTICS,
  evaluateAckEvidencePolicy,
  renderAckEvidencePolicyDiagnostics,
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
    assert.equal(byScenario.get("provider_sent_no_receipt")?.decision, "hold_unacked");
    assert.equal(byScenario.get("provider_sent_no_receipt")?.ackAllowed, false);
    assert.equal(byScenario.get("provider_accepted_no_receipt")?.decision, "hold_unacked");
    assert.equal(byScenario.get("provider_accepted_no_receipt")?.ackAllowed, false);
    assert.equal(byScenario.get("receipt_confirmed")?.decision, "receipt_confirmed");
    assert.equal(byScenario.get("receipt_confirmed")?.ackAllowed, true);
    assert.equal(byScenario.get("send_failed")?.decision, "hold_unacked");
    assert.equal(byScenario.get("stale_timed_out")?.decision, "hold_unacked");
    assert.equal(byScenario.get("stale_receipt_blocker")?.decision, "hold_unacked");
    assert.equal(byScenario.get("stale_receipt_blocker")?.ackAllowed, false);
    assert.equal(byScenario.get("retry_requeue_blocker")?.decision, "block_retry");
    assert.equal(byScenario.get("retry_requeue_blocker")?.ackAllowed, false);
    assert.equal(byScenario.get("duplicate_terminal_event")?.decision, "suppress_duplicate");
    assert.equal(byScenario.get("duplicate_terminal_event")?.ackAllowed, false);
  });

  it("provider_sent and provider_accepted must not allow ACK", () => {
    const matrix = runReceiptGateCanaryMatrix({ generatedAt: "2026-05-03T00:00:00.000Z" });
    const byScenario = new Map(matrix.cells.map((cell) => [cell.scenarioId, cell]));

    // provider_sent is NOT receipt evidence → hold_unacked, ackAllowed=false
    const providerSent = byScenario.get("provider_sent_no_receipt")!;
    assert.equal(providerSent.decision, "hold_unacked");
    assert.equal(providerSent.ackAllowed, false);
    assert.match(providerSent.summary, /provider_sent ≠ operator-visible ≠ ACK/);

    // provider_accepted is NOT receipt evidence → hold_unacked, ackAllowed=false
    const providerAccepted = byScenario.get("provider_accepted_no_receipt")!;
    assert.equal(providerAccepted.decision, "hold_unacked");
    assert.equal(providerAccepted.ackAllowed, false);
    assert.match(providerAccepted.summary, /provider_accepted ≠ operator-visible ≠ ACK/);
  });

  it("stale and retry/requeue blockers report without mutation", () => {
    const matrix = runReceiptGateCanaryMatrix({ generatedAt: "2026-05-03T00:00:00.000Z" });
    const byScenario = new Map(matrix.cells.map((cell) => [cell.scenarioId, cell]));

    const stale = byScenario.get("stale_receipt_blocker")!;
    assert.equal(stale.providerCalled, false);
    assert.equal(stale.productionAckAttempted, false);
    assert.match(stale.summary, /no DB mutation performed/);

    const retry = byScenario.get("retry_requeue_blocker")!;
    assert.equal(retry.decision, "block_retry");
    assert.equal(retry.providerCalled, false);
    assert.equal(retry.productionAckAttempted, false);
    assert.match(retry.summary, /no live requeue performed/);
  });

  it("renders operator-safe evidence summaries", () => {
    const matrix = runReceiptGateCanaryMatrix({ generatedAt: "2026-05-03T00:00:00.000Z" });
    const markdown = renderReceiptGateCanaryMarkdown(matrix);

    assert.match(markdown, /Run mode: no-live/);
    assert.match(markdown, /send acceptance alone is not receipt evidence/);
    assert.match(markdown, /provider_sent is send-only success/);
    assert.match(markdown, /provider_accepted is transport ack/);
    assert.match(markdown, /suppress duplicate notification without a second ACK/);
    assert.match(markdown, /no DB mutation performed/);
    assert.match(markdown, /no live requeue performed/);
    assert.doesNotMatch(markdown, /token|secret|password|file:\/\//i);
  });

  it("receipt vocabulary distinguishes accepted/provider_sent/provider_accepted/operator-visible/ACK", () => {
    const matrix = runReceiptGateCanaryMatrix({ generatedAt: "2026-05-03T00:00:00.000Z" });
    const byScenario = new Map(matrix.cells.map((cell) => [cell.scenarioId, cell]));

    // accepted: sendAccepted — hold_unacked
    assert.match(byScenario.get("send_accepted_no_receipt")!.summary, /send acceptance alone is not receipt evidence/);
    // provider_sent: send-only — hold_unacked
    assert.match(byScenario.get("provider_sent_no_receipt")!.summary, /provider_sent ≠ operator-visible ≠ ACK/);
    // provider_accepted: transport ack — hold_unacked
    assert.match(byScenario.get("provider_accepted_no_receipt")!.summary, /provider_accepted ≠ operator-visible ≠ ACK/);
    // operator-visible / receipt confirmed: allow ACK
    assert.equal(byScenario.get("receipt_confirmed")!.ackAllowed, true);
    assert.equal(byScenario.get("receipt_confirmed")!.decision, "receipt_confirmed");
  });
});

describe("broker → plugin → worker projection canary", () => {
  it("covers full projection path without live delivery", () => {
    const projection = runBrokerPluginWorkerProjection({ generatedAt: "2026-05-03T00:00:00.000Z" });

    assert.equal(projection.kind, "broker-plugin-worker.projection.canary");
    assert.equal(projection.runMode, "no-live");
    assert.equal(projection.steps.length, PROJECTION_STEPS.length);
    assert.deepEqual(projection.steps.map((s) => s.stepId), [...PROJECTION_STEPS]);
    assert.equal(projection.steps.every((s) => s.providerCalled === false), true);
    assert.equal(projection.steps.every((s) => s.productionAckAttempted === false), true);
  });

  it("provider_sent and provider_accepted are confirmed non-ACK in projection", () => {
    const projection = runBrokerPluginWorkerProjection({ generatedAt: "2026-05-03T00:00:00.000Z" });

    assert.equal(projection.providerSentNonAckConfirmed, true);
    assert.equal(projection.providerAcceptedNonAckConfirmed, true);
  });

  it("only operator_visible with receipt allows ACK", () => {
    const projection = runBrokerPluginWorkerProjection({ generatedAt: "2026-05-03T00:00:00.000Z" });

    for (const step of projection.steps) {
      if (step.status === "operator_visible" && step.hasReceipt) {
        assert.equal(step.ackAllowed, true);
      } else {
        assert.equal(step.ackAllowed, false);
      }
    }
  });

  it("renders projection markdown with Korean status labels", () => {
    const projection = runBrokerPluginWorkerProjection({ generatedAt: "2026-05-03T00:00:00.000Z" });
    const markdown = renderBrokerPluginWorkerProjectionMarkdown(projection);

    assert.match(markdown, /Broker → Plugin → Worker projection canary/);
    assert.match(markdown, /provider_sent 비ACK 확인/);
    assert.match(markdown, /provider_accepted 비ACK 확인/);
    assert.match(markdown, /Run mode: no-live/);
    assert.doesNotMatch(markdown, /token|secret|password|file:\/\//i);
  });
});

describe("terminal ACK evidence policy health diagnostics", () => {
  it("covers all known evidence types without provider calls or production ACKs", () => {
    const cells = evaluateAckEvidencePolicy();

    assert.equal(cells.length, ACK_EVIDENCE_POLICY_DIAGNOSTICS.length);
    assert.deepEqual(cells.map((c) => c.evidenceType), [...ACK_EVIDENCE_POLICY_DIAGNOSTICS]);
    assert.equal(cells.every((c) => c.policyVerdict === "pass"), true);
  });

  it("rejects provider_send_success, provider_accepted, and gateway_send_success as terminal ACK evidence", () => {
    const cells = evaluateAckEvidencePolicy();
    const byType = new Map(cells.map((c) => [c.evidenceType, c]));

    // These must be rejected as terminal ACK evidence
    assert.equal(byType.get("provider_send_success")?.isValidAckEvidence, false);
    assert.match(byType.get("provider_send_success")?.summary ?? "", /provider_send_success is send-only success/);

    assert.equal(byType.get("provider_accepted")?.isValidAckEvidence, false);
    assert.match(byType.get("provider_accepted")?.summary ?? "", /provider_accepted is transport-level ack/);

    assert.equal(byType.get("gateway_send_success")?.isValidAckEvidence, false);
    assert.match(byType.get("gateway_send_success")?.summary ?? "", /gateway delivery ≠ operator-visible ≠ ACK/);
  });

  it("accepts current_session_visible, operator_visible, operator_confirmed, and provider_delivery_receipt", () => {
    const cells = evaluateAckEvidencePolicy();
    const byType = new Map(cells.map((c) => [c.evidenceType, c]));

    assert.equal(byType.get("current_session_visible")?.isValidAckEvidence, true);
    assert.equal(byType.get("operator_visible")?.isValidAckEvidence, true);
    assert.equal(byType.get("operator_confirmed")?.isValidAckEvidence, true);
    assert.equal(byType.get("provider_delivery_receipt")?.isValidAckEvidence, true);
  });

  it("renders human-readable markdown with rejection summaries", () => {
    const cells = evaluateAckEvidencePolicy();
    const markdown = renderAckEvidencePolicyDiagnostics(cells);

    assert.match(markdown, /Terminal ACK evidence policy health diagnostics/);
    assert.match(markdown, /provider_send_success/);
    assert.match(markdown, /provider_accepted/);
    assert.match(markdown, /gateway_send_success/);
    assert.match(markdown, /current_session_visible/);
    assert.match(markdown, /operator_visible/);
    assert.match(markdown, /operator_confirmed/);
    assert.match(markdown, /provider_delivery_receipt/);
    assert.match(markdown, /≠ operator-visible/);
    assert.doesNotMatch(markdown, /token|secret|password|file:\/\//i);
  });
});
