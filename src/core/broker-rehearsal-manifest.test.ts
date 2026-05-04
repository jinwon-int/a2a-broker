import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildBrokerRehearsalManifest,
  renderBrokerRehearsalManifestMarkdown,
} from "./broker-rehearsal-manifest.js";

test("broker rehearsal manifest composes no-live contracts for runner lanes", () => {
  const manifest = buildBrokerRehearsalManifest({
    generatedAt: "2026-05-04T03:50:26.000Z",
    runId: "a2a-no-live-integration-20260504035026",
    worker: "sogyo",
  });

  assert.equal(manifest.kind, "a2a-broker.rehearsal-manifest");
  assert.equal(manifest.version, 1);
  assert.equal(manifest.runMode, "no-live");
  assert.deepEqual(manifest.safety, {
    productionDeploy: false,
    gatewayRestart: false,
    liveProviderSend: false,
    databaseMutation: false,
    terminalOutboxAck: false,
  });

  assert.deepEqual(manifest.canonicalGithubTaskPayload, {
    intent: "propose_patch",
    taskOrigin: "github",
    payload: {
      mode: "github-propose-patch",
      repo: "jinwon-int/a2a-broker",
      issue: "#328",
      issueNumber: 328,
      issueUrl: "https://github.com/jinwon-int/a2a-broker/issues/328",
    },
  });

  assert.equal(manifest.terminalOutboxReadinessGate.subscribeOnly, true);
  assert.equal(manifest.terminalOutboxReadinessGate.ackEndpointExercised, false);
  assert.deepEqual(manifest.terminalOutboxReadinessGate.requiredAckEvidence, [
    "operator_visible",
    "operator_confirmed",
    "provider_delivery_receipt",
  ]);
  assert.deepEqual(manifest.terminalOutboxReadinessGate.rejectedEvidence, ["provider_send_success"]);

  const providerSent = manifest.ackAuditDecisions.find((decision) => decision.receiptStatus === "provider_sent");
  assert.equal(providerSent?.ackAllowed, false);
  assert.match(providerSent?.reason ?? "", /send-only success is not terminal ACK evidence/);

  const operatorVisible = manifest.ackAuditDecisions.find((decision) => decision.receiptStatus === "operator_visible");
  assert.equal(operatorVisible?.decision, "eligible");
  assert.equal(operatorVisible?.evidence, "operator_visible");

  assert.equal(manifest.receiptGateCanary.overallVerdict, "pass");
  assert.equal(manifest.overallVerdict, "pass");
});

test("broker rehearsal renderer emits compact operator-readable evidence", () => {
  const manifest = buildBrokerRehearsalManifest({ generatedAt: "2026-05-04T03:50:26.000Z" });
  const markdown = renderBrokerRehearsalManifestMarkdown(manifest);

  assert.match(markdown, /^A2A broker no-live rehearsal manifest: pass/);
  assert.match(markdown, /productionDeploy: not attempted/);
  assert.match(markdown, /liveProviderSend: not attempted/);
  assert.match(markdown, /terminalOutboxAck: not attempted/);
  assert.match(markdown, /github-propose-patch/);
  assert.match(markdown, /provider_send_success/);
  assert.doesNotMatch(markdown, /rawPrompt|rawLogs|provider send complete/i);
});
