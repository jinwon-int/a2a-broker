import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateLiberoValidationReadiness,
  LIBERO_FORBIDDEN_ACTIONS,
  LIBERO_REGRESSION_GATES,
  LIBERO_REQUIRED_AREAS,
  renderLiberoValidationMatrixMarkdown,
  type LiberoEvidenceInput,
} from "./libero-validation-matrix.js";

test("libero validation matrix covers every #497/#294 required area", () => {
  for (const area of LIBERO_REQUIRED_AREAS) {
    assert.ok(
      LIBERO_REGRESSION_GATES.some((gate) => gate.area === area),
      `missing libero validation gate for ${area}`,
    );
  }
});

test("libero validation gates stay no-live and include explicit NO-GO conditions", () => {
  for (const gate of LIBERO_REGRESSION_GATES) {
    assert.equal(gate.noLiveOnly, true, `${gate.id} must stay no-live`);
    assert.match(gate.sourceIssue, /^#(497|294|497\/#294)$/);
    assert.match(gate.requiredProof, /test|matrix|canary|preflight|evidence|snapshot|diagnostics/i);
    assert.match(gate.noGoIf, /ACK|OOM|unbounded|live|mutation|secret|OpenClaw|provider|raw DB|Done/i);
  }
});

test("libero validation fails closed until all evidence areas pass", () => {
  const partial: LiberoEvidenceInput[] = [
    { area: "hot_table_memory", status: "pass", evidenceUrl: "https://example.invalid/497-hot-table" },
    { area: "retention_hygiene", status: "pass", evidenceUrl: "https://example.invalid/497-retention" },
    { area: "terminal_outbox_hygiene", status: "blocked", note: "read-only outbox snapshot unavailable" },
    { area: "receipt_semantics", status: "pass", evidenceUrl: "https://example.invalid/294-receipt" },
  ];

  const result = evaluateLiberoValidationReadiness(partial);

  assert.equal(result.decision, "no-go");
  assert.deepEqual(result.blockedAreas, ["terminal_outbox_hygiene"]);
  assert.ok(result.missingAreas.includes("replay_canary"));
  assert.ok(result.missingAreas.includes("observability_readiness"));
  assert.ok(result.missingAreas.includes("evidence_hygiene"));
});

test("libero validation remains NO-GO if any forbidden live action is reported", () => {
  const passingEvidence = LIBERO_REQUIRED_AREAS.map((area) => ({ area, status: "pass" as const }));

  for (const action of LIBERO_FORBIDDEN_ACTIONS) {
    const result = evaluateLiberoValidationReadiness(passingEvidence, { [action]: true });
    assert.equal(result.decision, "no-go", `${action} must block the lane`);
    assert.deepEqual(result.forbiddenActions, [action]);
  }
});

test("libero validation goes green only with complete clean no-live evidence", () => {
  const result = evaluateLiberoValidationReadiness(
    LIBERO_REQUIRED_AREAS.map((area) => ({ area, status: "pass" })),
    {
      productionDeploy: false,
      gatewayRestart: false,
      liveProviderSend: false,
      terminalAck: false,
      dbMutation: false,
      secretChange: false,
      release: false,
      forcePush: false,
    },
  );

  assert.equal(result.decision, "go");
  assert.deepEqual(result.missingAreas, []);
  assert.deepEqual(result.blockedAreas, []);
  assert.deepEqual(result.warningAreas, []);
  assert.deepEqual(result.forbiddenActions, []);
});

test("rendered libero matrix names hot-table, terminal ACK, and evidence hygiene blockers", () => {
  const markdown = renderLiberoValidationMatrixMarkdown();

  assert.match(markdown, /#497/);
  assert.match(markdown, /#294/);
  assert.match(markdown, /hot-table\/OOM risk/);
  assert.match(markdown, /Terminal outbox unacked backlog/);
  assert.match(markdown, /Provider send acceptance is never treated as operator-visible receipt/);
  assert.match(markdown, /OpenClaw runtime\/bootstrap context files/);
  assert.doesNotMatch(markdown, /token|secret value|password|file:\/\//i);
});
