import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateTwoBrokerCutoverReadiness,
  renderTwoBrokerSafetyMatrixMarkdown,
  TWO_BROKER_REGRESSION_SCENARIOS,
  TWO_BROKER_REQUIRED_AREAS,
  type TwoBrokerEvidenceInput,
} from "./two-broker-safety-matrix.js";

test("two-broker safety matrix covers every required readiness area", () => {
  for (const area of TWO_BROKER_REQUIRED_AREAS) {
    assert.ok(
      TWO_BROKER_REGRESSION_SCENARIOS.some((scenario) => scenario.area === area),
      `missing scenario for ${area}`,
    );
  }
});

test("two-broker safety matrix is no-live and fail-closed", () => {
  for (const scenario of TWO_BROKER_REGRESSION_SCENARIOS) {
    assert.equal(scenario.noLiveOnly, true, `${scenario.id} must stay no-live`);
    assert.match(scenario.requiredProof, /test|fixture|evidence|Runbook|PR\/Done\/Block/i);
    assert.ok(scenario.blockerCondition.length > 20, `${scenario.id} needs an explicit blocker condition`);
  }
});

test("two-broker cutover readiness is no-go until every area has passing evidence", () => {
  const partial: TwoBrokerEvidenceInput[] = [
    { area: "broker_identity", status: "pass", evidenceUrl: "https://example.invalid/410" },
    { area: "worker_home_broker_lease", status: "pass", evidenceUrl: "https://example.invalid/411" },
    { area: "broker_of_record_lifecycle", status: "blocked", note: "missing lifecycle mismatch tests" },
  ];

  const result = evaluateTwoBrokerCutoverReadiness(partial);

  assert.equal(result.decision, "no-go");
  assert.deepEqual(result.blockedAreas, ["broker_of_record_lifecycle"]);
  assert.ok(result.missingAreas.includes("duplicate_worker_preflight"));
  assert.ok(result.missingAreas.includes("backward_compatibility"));
  assert.ok(result.missingAreas.includes("cutover_runbook"));
});

test("two-broker cutover readiness goes green only with clean evidence for all areas", () => {
  const result = evaluateTwoBrokerCutoverReadiness(
    TWO_BROKER_REQUIRED_AREAS.map((area) => ({ area, status: "pass" })),
  );

  assert.equal(result.decision, "go");
  assert.deepEqual(result.missingAreas, []);
  assert.deepEqual(result.blockedAreas, []);
  assert.deepEqual(result.warningAreas, []);
});

test("rendered two-broker matrix includes child issue owners and critical safety surfaces", () => {
  const markdown = renderTwoBrokerSafetyMatrixMarkdown();

  for (const issue of ["#410", "#411", "#412", "#413", "#414", "#415"]) {
    assert.match(markdown, new RegExp(issue));
  }
  assert.match(markdown, /brokerId/);
  assert.match(markdown, /workerId -> brokerId lease/);
  assert.match(markdown, /brokerOfRecord\/teamId/);
  assert.match(markdown, /duplicate online workerIds/);
});
