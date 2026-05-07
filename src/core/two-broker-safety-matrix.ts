export type TwoBrokerSafetyArea =
  | "broker_identity"
  | "worker_home_broker_lease"
  | "broker_of_record_lifecycle"
  | "duplicate_worker_preflight"
  | "backward_compatibility"
  | "cutover_runbook";

export type TwoBrokerEvidenceStatus = "pass" | "warn" | "blocked" | "missing";

export interface TwoBrokerRegressionScenario {
  id: string;
  area: TwoBrokerSafetyArea;
  ownerIssue: string;
  scenario: string;
  requiredProof: string;
  expectedResult: string;
  blockerCondition: string;
  noLiveOnly: boolean;
}

export interface TwoBrokerEvidenceInput {
  area: TwoBrokerSafetyArea;
  status: TwoBrokerEvidenceStatus;
  evidenceUrl?: string;
  note?: string;
}

export interface TwoBrokerReadinessResult {
  decision: "go" | "no-go";
  missingAreas: TwoBrokerSafetyArea[];
  blockedAreas: TwoBrokerSafetyArea[];
  warningAreas: TwoBrokerSafetyArea[];
}

export const TWO_BROKER_REQUIRED_AREAS: readonly TwoBrokerSafetyArea[] = [
  "broker_identity",
  "worker_home_broker_lease",
  "broker_of_record_lifecycle",
  "duplicate_worker_preflight",
  "backward_compatibility",
  "cutover_runbook",
] as const;

export const TWO_BROKER_REGRESSION_SCENARIOS: readonly TwoBrokerRegressionScenario[] = [
  {
    id: "R1",
    area: "broker_identity",
    ownerIssue: "#410",
    scenario: "Broker identity is configured with a safe single-broker default and explicit seoseo/gwakga values.",
    requiredProof: "Type/config tests plus /health and worker register/heartbeat response assertions for brokerId exposure.",
    expectedResult: "Clients can read brokerId without secrets; legacy deployments keep a deterministic default.",
    blockerCondition: "brokerId is absent, secret-derived, unstable across restart, or not exposed to worker startup.",
    noLiveOnly: true,
  },
  {
    id: "R2",
    area: "worker_home_broker_lease",
    ownerIssue: "#411",
    scenario: "Worker validates A2A_HOME_BROKER_ID against the broker response before polling.",
    requiredProof: "Worker tests for matching broker, mismatched broker, absent expected id compatibility, and startup fail-close.",
    expectedResult: "A worker refuses to process tasks when the configured home broker and actual broker differ.",
    blockerCondition: "Mismatch only logs a warning, or polling can start before identity validation succeeds.",
    noLiveOnly: true,
  },
  {
    id: "R3",
    area: "worker_home_broker_lease",
    ownerIssue: "#411",
    scenario: "Local workerId -> brokerId lease prevents silent retargeting.",
    requiredProof: "Fixture-backed tests for first start, same-broker restart, silent broker change, explicit retarget override, and corrupt lease handling.",
    expectedResult: "Silent retargeting fails closed; intentional retargeting is explicit, auditable, and documented.",
    blockerCondition: "Lease storage prints secrets, silently rewrites brokerId, or lacks an explicit retarget path.",
    noLiveOnly: true,
  },
  {
    id: "R4",
    area: "broker_of_record_lifecycle",
    ownerIssue: "#412",
    scenario: "New tasks carry brokerOfRecord/teamId defaults while old tasks remain readable.",
    requiredProof: "Core task creation/type tests for default metadata plus legacy fixture tests with missing fields.",
    expectedResult: "New task ownership is explicit; pre-existing task snapshots remain backward compatible.",
    blockerCondition: "Old tasks fail to load, or new tasks can be created without a broker/team owner once the feature is enabled.",
    noLiveOnly: true,
  },
  {
    id: "R5",
    area: "broker_of_record_lifecycle",
    ownerIssue: "#412",
    scenario: "Task claim/start/heartbeat/complete/fail enforce broker/team ownership.",
    requiredProof: "Lifecycle tests for matching broker/team success, mismatched broker/team policy_denied or bad_request, and cancel/handoff compatibility.",
    expectedResult: "A worker can mutate only tasks owned by its broker/team; mismatches fail closed without terminal side effects.",
    blockerCondition: "Any mismatch can claim or complete a task, or a failure path emits terminal evidence/ACK-like side effects.",
    noLiveOnly: true,
  },
  {
    id: "R6",
    area: "duplicate_worker_preflight",
    ownerIssue: "#413",
    scenario: "Two broker worker snapshots contain no online duplicate workerIds.",
    requiredProof: "Preflight fixture tests for clean seoseo/gwakga lists and duplicate-online workerId failure.",
    expectedResult: "Clean lists pass; duplicate online workerIds produce non-zero/failed preflight output.",
    blockerCondition: "Duplicate online workerIds are reported as pass or require a production mutation to detect.",
    noLiveOnly: true,
  },
  {
    id: "R7",
    area: "duplicate_worker_preflight",
    ownerIssue: "#413",
    scenario: "Preflight handles stale, unreachable, and brokerId-mismatch ambiguity safely.",
    requiredProof: "Fixtures for stale/unknown worker status, unreachable broker, brokerId mismatch, compact redacted JSON/markdown output.",
    expectedResult: "Ambiguous or unreachable data blocks cutover instead of guessing; secrets and raw targets are redacted.",
    blockerCondition: "Unreachable broker, stale ambiguity, or brokerId mismatch is downgraded to success.",
    noLiveOnly: true,
  },
  {
    id: "R8",
    area: "backward_compatibility",
    ownerIssue: "#414",
    scenario: "Existing single-broker tasks/workers continue to pass the current regression suite.",
    requiredProof: "Focused build/tests for broker, worker, server, and any new matrix/preflight fixtures after #410-#413 land.",
    expectedResult: "Legacy brokerUrl-only workers and task snapshots remain accepted unless explicit two-broker guards are configured.",
    blockerCondition: "A default single-broker checkout requires new production config or breaks existing task/worker tests.",
    noLiveOnly: true,
  },
  {
    id: "R9",
    area: "cutover_runbook",
    ownerIssue: "#415",
    scenario: "Gwakga/Team2 onboarding uses stop / verify lease / retarget / restart / preflight / rollback semantics.",
    requiredProof: "Runbook evidence with brokerId/teamId conventions, approval boundaries, rollback steps, and required duplicate preflight output.",
    expectedResult: "Operators have a no-live checklist that makes silent dual registration unlikely before any cutover.",
    blockerCondition: "Runbook implies live restart, route change, or secret rotation without explicit operator approval.",
    noLiveOnly: true,
  },
  {
    id: "R10",
    area: "backward_compatibility",
    ownerIssue: "#414",
    scenario: "Safety evidence remains bounded and secret-safe.",
    requiredProof: "PR/Done/Block evidence lists commands, pass/fail result, and gaps without raw session dumps, secrets, private paths, or live payloads.",
    expectedResult: "Evidence is enough to decide merge/cutover readiness without leaking sensitive runtime context.",
    blockerCondition: "Evidence includes secrets, OpenClaw bootstrap files, raw session dumps, or host-specific private paths.",
    noLiveOnly: true,
  },
] as const;

export function evaluateTwoBrokerCutoverReadiness(
  evidence: readonly TwoBrokerEvidenceInput[],
): TwoBrokerReadinessResult {
  const byArea = new Map<TwoBrokerSafetyArea, TwoBrokerEvidenceInput>();
  for (const item of evidence) {
    byArea.set(item.area, item);
  }

  const missingAreas: TwoBrokerSafetyArea[] = [];
  const blockedAreas: TwoBrokerSafetyArea[] = [];
  const warningAreas: TwoBrokerSafetyArea[] = [];

  for (const area of TWO_BROKER_REQUIRED_AREAS) {
    const item = byArea.get(area);
    if (!item || item.status === "missing") {
      missingAreas.push(area);
      continue;
    }
    if (item.status === "blocked") {
      blockedAreas.push(area);
      continue;
    }
    if (item.status === "warn") {
      warningAreas.push(area);
    }
  }

  return {
    decision: missingAreas.length === 0 && blockedAreas.length === 0 && warningAreas.length === 0 ? "go" : "no-go",
    missingAreas,
    blockedAreas,
    warningAreas,
  };
}

export function renderTwoBrokerSafetyMatrixMarkdown(
  scenarios: readonly TwoBrokerRegressionScenario[] = TWO_BROKER_REGRESSION_SCENARIOS,
): string {
  const rows = scenarios.map((item) => (
    `| ${item.id} | ${item.area} | ${item.ownerIssue} | ${item.scenario} | ${item.requiredProof} | ${item.expectedResult} | ${item.blockerCondition} |`
  ));

  return [
    "| ID | Area | Owner | Scenario | Required proof | Expected result | Blocker condition |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}
