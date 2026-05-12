import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateLiberoValidationReadiness,
  LIBERO_CLOSURE_CRITERIA,
  LIBERO_FORBIDDEN_ACTIONS,
  LIBERO_NO_GO_TRAPS,
  LIBERO_REGRESSION_GATES,
  LIBERO_REQUIRED_AREAS,
  renderLiberoClosureCriteriaMarkdown,
  renderLiberoNoGoTrapsMarkdown,
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

test("libero closure criteria cover #497, #294, and cross-issue evidence hygiene", () => {
  assert.ok(LIBERO_CLOSURE_CRITERIA.some((item) => item.sourceIssue === "#497"));
  assert.ok(LIBERO_CLOSURE_CRITERIA.some((item) => item.sourceIssue === "#294"));
  assert.ok(LIBERO_CLOSURE_CRITERIA.some((item) => item.sourceIssue === "#497/#294"));

  const joined = LIBERO_CLOSURE_CRITERIA.map((item) => `${item.criterion} ${item.requiredEvidence} ${item.closesWhen}`).join("\n");
  assert.match(joined, /Hot-table persistence/);
  assert.match(joined, /provider accepted\/sent never implies ACK/);
  assert.match(joined, /providerCalled=false/);
  assert.match(joined, /AGENTS\/SOUL\/USER\/TOOLS\/HEARTBEAT\/IDENTITY\/\.openclaw/);
});

test("libero no-go traps fail closed on receipt, OOM, cleanup, replay, and evidence leaks", () => {
  const trapsByArea = new Map(LIBERO_NO_GO_TRAPS.map((trap) => [trap.area, trap]));

  assert.match(trapsByArea.get("receipt_semantics")?.failClosedResponse ?? "", /do not ACK/);
  assert.match(trapsByArea.get("hot_table_memory")?.trap ?? "", /NODE_OPTIONS/);
  assert.match(trapsByArea.get("terminal_outbox_hygiene")?.failClosedResponse ?? "", /separate DB cleanup\/ACK approval/);
  assert.match(trapsByArea.get("replay_canary")?.trap ?? "", /live provider send/);
  assert.match(trapsByArea.get("evidence_hygiene")?.failClosedResponse ?? "", /repo-relative offending paths/);
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

test("rendered closure criteria and no-go trap tables expose closeout blockers", () => {
  const criteria = renderLiberoClosureCriteriaMarkdown();
  const traps = renderLiberoNoGoTrapsMarkdown();

  assert.match(criteria, /Closure criterion/);
  assert.match(criteria, /full-history heap residency/);
  assert.match(criteria, /duplicate provider sends/);
  assert.match(traps, /NO-GO trap/);
  assert.match(traps, /operator-visible receipt/);
  assert.match(traps, /Fail closed before PR creation/);
  assert.doesNotMatch(`${criteria}\n${traps}`, /secret value|password|file:\/\//i);
});
