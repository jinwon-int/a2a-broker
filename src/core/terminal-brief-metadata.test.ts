import test from "node:test";
import assert from "node:assert/strict";

import {
  validateTerminalBriefMetadata,
  hasTerminalBriefMetadata,
  extractDispatchMetadata,
  TERMINAL_BRIEF_PAYLOAD_KEYS,
  type TerminalBriefDispatchMetadata,
  type TerminalBriefProjectionMetadata,
  type TerminalBriefHandoffMetadata,
  type TerminalBriefNotificationOwnership,
} from "./terminal-brief-metadata.js";

// ---------------------------------------------------------------------------
// Canonical schema structural tests
// ---------------------------------------------------------------------------

test("TerminalBriefDispatchMetadata keys match documented fields", () => {
  const metadata: TerminalBriefDispatchMetadata = {
    parentRoundId: "round-1",
    originBrokerId: "child-broker",
    brokerOfRecordId: "parent-broker",
    parentRoundTotal: 5,
    parentRoundOrder: 3,
  };
  assert.equal(metadata.parentRoundId, "round-1");
  assert.equal(metadata.originBrokerId, "child-broker");
  assert.equal(metadata.brokerOfRecordId, "parent-broker");
  assert.equal(metadata.parentRoundTotal, 5);
  assert.equal(metadata.parentRoundOrder, 3);
});

test("TerminalBriefDispatchMetadata only requires parentRoundId and originBrokerId", () => {
  const metadata: TerminalBriefDispatchMetadata = {
    parentRoundId: "round-1",
    originBrokerId: "child-broker",
    parentRoundTotal: 5,
    parentRoundOrder: 3,
  };
  assert.equal(metadata.parentRoundId, "round-1");
  // brokerOfRecordId is optional
  assert.equal(metadata.brokerOfRecordId, undefined);
});

test("TerminalBriefDispatchMetadata accepts numeric string for total and order", () => {
  const metadata: TerminalBriefDispatchMetadata = {
    parentRoundId: "round-1",
    originBrokerId: "child-broker",
    parentRoundTotal: "7",
    parentRoundOrder: "4",
  };
  assert.equal(metadata.parentRoundTotal, "7");
  assert.equal(metadata.parentRoundOrder, "4");
});

test("TerminalBriefHandoffMetadata carries traceability fields", () => {
  const handoff: TerminalBriefHandoffMetadata = {
    parentRoundId: "round-1",
    originBrokerId: "parent-broker",
    handoffBrokerId: "gwakga",
    originTaskId: "child-task-1",
    childWorkerId: "dungae",
  };
  assert.equal(handoff.parentRoundId, "round-1");
  assert.equal(handoff.originBrokerId, "parent-broker");
  assert.equal(handoff.handoffBrokerId, "gwakga");
});

test("TerminalBriefHandoffMetadata only requires parentRoundId and originBrokerId", () => {
  const handoff: TerminalBriefHandoffMetadata = {
    parentRoundId: "round-1",
    originBrokerId: "parent-broker",
  };
  assert.equal(handoff.parentRoundId, "round-1");
  assert.equal(handoff.handoffBrokerId, undefined);
  assert.equal(handoff.originTaskId, undefined);
  assert.equal(handoff.childWorkerId, undefined);
});

test("TerminalBriefNotificationOwnership has immutable cross-broker defaults", () => {
  const ownership: TerminalBriefNotificationOwnership = {
    ownerBrokerId: "parent-broker",
    scope: "parent-broker-only",
    providerSendPermittedByProjection: false,
    terminalAckPermittedByProjection: false,
    reason: "cross-broker projections are parent-broker aggregation evidence only",
  };
  assert.equal(ownership.ownerBrokerId, "parent-broker");
  assert.equal(ownership.scope, "parent-broker-only");
  assert.equal(ownership.providerSendPermittedByProjection, false);
  assert.equal(ownership.terminalAckPermittedByProjection, false);
});

test("TerminalBriefProjectionMetadata includes all dispatch and handoff fields", () => {
  const projection: TerminalBriefProjectionMetadata = {
    parentRoundId: "round-1",
    originBrokerId: "child-broker-a",
    brokerOfRecordId: "parent-broker",
    childTaskId: "child-1",
    childWorkerId: "dungae",
    status: "succeeded",
    summary: "child completed safely",
    taskBrief: "minimal safe patch",
    evidenceUrl: "https://github.com/acme/example/issues/1",
    completedAt: "2026-05-13T01:00:00.000Z",
    emittedAt: "2026-05-13T01:00:01.000Z",
    parentRoundTotal: 7,
    parentRoundOrder: 5,
  };
  assert.equal(projection.parentRoundId, "round-1");
  assert.equal(projection.originBrokerId, "child-broker-a");
  assert.equal(projection.status, "succeeded");
  assert.equal(projection.parentRoundTotal, 7);
  assert.equal(projection.parentRoundOrder, 5);
});

test("TERMINAL_BRIEF_PAYLOAD_KEYS includes all recognised keys", () => {
  assert.ok(TERMINAL_BRIEF_PAYLOAD_KEYS.has("parentRoundId"));
  assert.ok(TERMINAL_BRIEF_PAYLOAD_KEYS.has("parentRoundTotal"));
  assert.ok(TERMINAL_BRIEF_PAYLOAD_KEYS.has("parentRoundOrder"));
  assert.ok(TERMINAL_BRIEF_PAYLOAD_KEYS.has("crossBrokerHandoff"));
  assert.ok(TERMINAL_BRIEF_PAYLOAD_KEYS.has("originBrokerId"));
  assert.ok(TERMINAL_BRIEF_PAYLOAD_KEYS.has("brokerOfRecordId"));
  assert.ok(TERMINAL_BRIEF_PAYLOAD_KEYS.has("run"));
  assert.ok(TERMINAL_BRIEF_PAYLOAD_KEYS.has("runId"));
  assert.ok(TERMINAL_BRIEF_PAYLOAD_KEYS.has("round"));
  assert.ok(TERMINAL_BRIEF_PAYLOAD_KEYS.has("roundId"));
  assert.ok(TERMINAL_BRIEF_PAYLOAD_KEYS.has("roundTotal"));
  assert.ok(TERMINAL_BRIEF_PAYLOAD_KEYS.has("expectedWorkers"));
  assert.ok(TERMINAL_BRIEF_PAYLOAD_KEYS.has("taskCount"));
  const knownKeys = TERMINAL_BRIEF_PAYLOAD_KEYS.size;
  assert.ok(knownKeys >= 19, `expected at least 19 known keys, got ${knownKeys}`);
});

// ---------------------------------------------------------------------------
// validateTerminalBriefMetadata: valid cases
// ---------------------------------------------------------------------------

test("validateTerminalBriefMetadata passes with all required dispatch fields", () => {
  const result = validateTerminalBriefMetadata({
    parentRoundId: "round-1",
    originBrokerId: "child-broker",
    parentRoundTotal: "7",
    parentRoundOrder: 3,
  });
  assert.equal(result.valid, true);
  assert.equal(result.issues.length, 0);
});

test("validateTerminalBriefMetadata passes with number values for total and order", () => {
  const result = validateTerminalBriefMetadata({
    parentRoundId: "round-1",
    originBrokerId: "child-broker",
    parentRoundTotal: 7,
    parentRoundOrder: 3,
  });
  assert.equal(result.valid, true);
});

test("validateTerminalBriefMetadata passes with brokerOfRecordId", () => {
  const result = validateTerminalBriefMetadata({
    parentRoundId: "round-1",
    originBrokerId: "child-broker",
    brokerOfRecordId: "parent-broker",
    parentRoundTotal: 5,
    parentRoundOrder: 2,
  });
  assert.equal(result.valid, true);
});

test("validateTerminalBriefMetadata passes with valid crossBrokerHandoff", () => {
  const result = validateTerminalBriefMetadata({
    parentRoundId: "round-1",
    originBrokerId: "child-broker",
    parentRoundTotal: 5,
    parentRoundOrder: 2,
    crossBrokerHandoff: {
      parentRoundId: "round-1",
      originBrokerId: "parent-broker",
      handoffBrokerId: "child-broker",
      originTaskId: "child-task-1",
    },
  });
  assert.equal(result.valid, true);
});

test("validateTerminalBriefMetadata passes with empty crossBrokerHandoff optional fields", () => {
  const result = validateTerminalBriefMetadata({
    parentRoundId: "round-1",
    originBrokerId: "child-broker",
    parentRoundTotal: 3,
    parentRoundOrder: 1,
    crossBrokerHandoff: {
      parentRoundId: "round-1",
      originBrokerId: "parent-broker",
    },
  });
  assert.equal(result.valid, true);
});

test("validateTerminalBriefMetadata passes for standalone broker without receiver id", () => {
  const result = validateTerminalBriefMetadata({
    parentRoundId: "round-1",
    originBrokerId: "standalone-broker",
    parentRoundTotal: 1,
    parentRoundOrder: 1,
  });
  assert.equal(result.valid, true);
});

// ---------------------------------------------------------------------------
// validateTerminalBriefMetadata: missing fields (fail-closed)
// ---------------------------------------------------------------------------

test("validateTerminalBriefMetadata fails when parentRoundId is missing", () => {
  const result = validateTerminalBriefMetadata({
    originBrokerId: "child-broker",
    parentRoundTotal: 5,
    parentRoundOrder: 3,
  });
  assert.equal(result.valid, false);
  const issues = result.issues.filter((i) => i.path === "parentRoundId");
  assert.ok(issues.length > 0);
  assert.equal(issues[0]?.severity, "error");
});

test("validateTerminalBriefMetadata fails when parentRoundId is empty", () => {
  const result = validateTerminalBriefMetadata({
    parentRoundId: "",
    originBrokerId: "child-broker",
    parentRoundTotal: 5,
    parentRoundOrder: 3,
  });
  assert.equal(result.valid, false);
  const issues = result.issues.filter((i) => i.path === "parentRoundId");
  assert.ok(issues.length > 0);
});

test("validateTerminalBriefMetadata fails when parentRoundId is whitespace", () => {
  const result = validateTerminalBriefMetadata({
    parentRoundId: "  ",
    originBrokerId: "child-broker",
    parentRoundTotal: 5,
    parentRoundOrder: 3,
  });
  assert.equal(result.valid, false);
});

test("validateTerminalBriefMetadata fails when originBrokerId is missing", () => {
  const result = validateTerminalBriefMetadata({
    parentRoundId: "round-1",
    parentRoundTotal: 5,
    parentRoundOrder: 3,
  });
  assert.equal(result.valid, false);
  const issues = result.issues.filter((i) => i.path === "originBrokerId");
  assert.ok(issues.length > 0);
});

test("validateTerminalBriefMetadata fails when parentRoundTotal is missing", () => {
  const result = validateTerminalBriefMetadata({
    parentRoundId: "round-1",
    originBrokerId: "child-broker",
    parentRoundOrder: 3,
  });
  assert.equal(result.valid, false);
  const issues = result.issues.filter((i) => i.path === "parentRoundTotal");
  assert.ok(issues.length > 0);
});

test("validateTerminalBriefMetadata fails when parentRoundTotal is zero", () => {
  const result = validateTerminalBriefMetadata({
    parentRoundId: "round-1",
    originBrokerId: "child-broker",
    parentRoundTotal: 0,
    parentRoundOrder: 3,
  });
  assert.equal(result.valid, false);
  const issues = result.issues.filter((i) => i.path === "parentRoundTotal");
  assert.ok(issues.length > 0);
});

test("validateTerminalBriefMetadata fails when parentRoundTotal is negative", () => {
  const result = validateTerminalBriefMetadata({
    parentRoundId: "round-1",
    originBrokerId: "child-broker",
    parentRoundTotal: -1,
    parentRoundOrder: 3,
  });
  assert.equal(result.valid, false);
});

test("validateTerminalBriefMetadata fails when parentRoundOrder is missing", () => {
  const result = validateTerminalBriefMetadata({
    parentRoundId: "round-1",
    originBrokerId: "child-broker",
    parentRoundTotal: 5,
  });
  assert.equal(result.valid, false);
  const issues = result.issues.filter((i) => i.path === "parentRoundOrder");
  assert.ok(issues.length > 0);
});

test("validateTerminalBriefMetadata fails when parentRoundOrder exceeds total", () => {
  const result = validateTerminalBriefMetadata({
    parentRoundId: "round-1",
    originBrokerId: "child-broker",
    parentRoundTotal: 5,
    parentRoundOrder: 7,
  });
  assert.equal(result.valid, false);
  const orderIssues = result.issues.filter((i) => i.path === "parentRoundOrder");
  assert.ok(orderIssues.some((i) => i.message.includes("must not exceed")));
});

test("validateTerminalBriefMetadata fails with receiver mismatch for originBrokerId", () => {
  const result = validateTerminalBriefMetadata({
    parentRoundId: "round-1",
    originBrokerId: "parent-broker",
    parentRoundTotal: 5,
    parentRoundOrder: 3,
  }, "parent-broker");
  assert.equal(result.valid, false);
  const issues = result.issues.filter((i) => i.path === "originBrokerId");
  assert.ok(issues.length > 0);
  assert.ok(issues[0]?.message.includes("must differ"));
});

// ---------------------------------------------------------------------------
// validateTerminalBriefMetadata: multiple errors
// ---------------------------------------------------------------------------

test("validateTerminalBriefMetadata reports all missing fields at once", () => {
  const result = validateTerminalBriefMetadata({});
  assert.equal(result.valid, false);
  const errorIssues = result.issues.filter((i) => i.severity === "error");
  // parentRoundId + originBrokerId + parentRoundTotal + parentRoundOrder = 4
  assert.ok(errorIssues.length >= 4, `expected at least 4 errors, got ${errorIssues.length}`);
});

// ---------------------------------------------------------------------------
// validateTerminalBriefMetadata: crossBrokerHandoff validation
// ---------------------------------------------------------------------------

test("validateTerminalBriefMetadata accepts null crossBrokerHandoff (treated as absent)", () => {
  const result = validateTerminalBriefMetadata({
    parentRoundId: "round-1",
    originBrokerId: "child-broker",
    parentRoundTotal: 5,
    parentRoundOrder: 3,
    crossBrokerHandoff: null,
  });
  // null means absent, same as undefined
  assert.equal(result.valid, true);
});

test("validateTerminalBriefMetadata rejects handoff with missing required fields", () => {
  const result = validateTerminalBriefMetadata({
    parentRoundId: "round-1",
    originBrokerId: "child-broker",
    parentRoundTotal: 5,
    parentRoundOrder: 3,
    crossBrokerHandoff: {
      // parentRoundId is undefined
      originBrokerId: "parent-broker",
    },
  });
  assert.equal(result.valid, false);
  const issues = result.issues.filter((i) => i.path.startsWith("crossBrokerHandoff"));
  assert.ok(issues.length > 0);
});

test("validateTerminalBriefMetadata rejects handoff with empty handoffBrokerId", () => {
  const result = validateTerminalBriefMetadata({
    parentRoundId: "round-1",
    originBrokerId: "child-broker",
    parentRoundTotal: 5,
    parentRoundOrder: 3,
    crossBrokerHandoff: {
      parentRoundId: "round-1",
      originBrokerId: "parent-broker",
      handoffBrokerId: "",
    },
  });
  assert.equal(result.valid, false);
  const issues = result.issues.filter((i) => i.path === "crossBrokerHandoff.handoffBrokerId");
  assert.ok(issues.length > 0);
});

test("validateTerminalBriefMetadata accepts handoff with absent optional fields", () => {
  const result = validateTerminalBriefMetadata({
    parentRoundId: "round-1",
    originBrokerId: "child-broker",
    parentRoundTotal: 5,
    parentRoundOrder: 3,
    crossBrokerHandoff: {
      parentRoundId: "round-1",
      originBrokerId: "parent-broker",
    },
  });
  // handoff passes; the dispatch fields all pass
  assert.equal(result.valid, true);
});

// ---------------------------------------------------------------------------
// hasTerminalBriefMetadata
// ---------------------------------------------------------------------------

test("hasTerminalBriefMetadata returns true when parentRoundId is set", () => {
  assert.equal(hasTerminalBriefMetadata({ parentRoundId: "round-1" }), true);
});

test("hasTerminalBriefMetadata returns false when parentRoundId is missing", () => {
  assert.equal(hasTerminalBriefMetadata({}), false);
});

test("hasTerminalBriefMetadata returns false when parentRoundId is empty", () => {
  assert.equal(hasTerminalBriefMetadata({ parentRoundId: "" }), false);
});

test("hasTerminalBriefMetadata returns false when parentRoundId is whitespace", () => {
  assert.equal(hasTerminalBriefMetadata({ parentRoundId: "  " }), false);
});

test("hasTerminalBriefMetadata returns false when parentRoundId is non-string type", () => {
  assert.equal(hasTerminalBriefMetadata({ parentRoundId: 123 }), false);
});

// ---------------------------------------------------------------------------
// extractDispatchMetadata
// ---------------------------------------------------------------------------

test("extractDispatchMetadata reads parentRoundId directly", () => {
  const dispatch = extractDispatchMetadata({ parentRoundId: "round-1" });
  assert.equal(dispatch.parentRoundId, "round-1");
});

test("extractDispatchMetadata falls back to run/runId/round/roundId", () => {
  assert.equal(extractDispatchMetadata({ run: "round-a" }).parentRoundId, "round-a");
  assert.equal(extractDispatchMetadata({ runId: "round-b" }).parentRoundId, "round-b");
  assert.equal(extractDispatchMetadata({ round: "round-c" }).parentRoundId, "round-c");
  assert.equal(extractDispatchMetadata({ roundId: "round-d" }).parentRoundId, "round-d");
});

test("extractDispatchMetadata prefers parentRoundId over fallback keys", () => {
  const dispatch = extractDispatchMetadata({
    parentRoundId: "round-primary",
    run: "round-fallback",
  });
  assert.equal(dispatch.parentRoundId, "round-primary");
});

test("extractDispatchMetadata reads parentRoundTotal with fallbacks", () => {
  assert.equal(extractDispatchMetadata({ parentRoundTotal: 7 }).parentRoundTotal, 7);
  assert.equal(extractDispatchMetadata({ roundTotal: "5" }).parentRoundTotal, "5");
  assert.equal(extractDispatchMetadata({ expectedWorkers: 10 }).parentRoundTotal, 10);
  assert.equal(extractDispatchMetadata({ taskCount: "3" }).parentRoundTotal, "3");
});

test("extractDispatchMetadata returns undefined for missing values", () => {
  const dispatch = extractDispatchMetadata({});
  assert.equal(dispatch.parentRoundId, undefined);
  assert.equal(dispatch.originBrokerId, undefined);
  assert.equal(dispatch.brokerOfRecordId, undefined);
  assert.equal(dispatch.parentRoundTotal, undefined);
  assert.equal(dispatch.parentRoundOrder, undefined);
});

// ---------------------------------------------------------------------------
// TerminalBriefMetadataValidationResult summary format
// ---------------------------------------------------------------------------

test("validation result summary says passed when valid", () => {
  const result = validateTerminalBriefMetadata({
    parentRoundId: "round-1",
    originBrokerId: "child-broker",
    parentRoundTotal: 5,
    parentRoundOrder: 3,
  });
  assert.equal(result.valid, true);
  assert.match(result.summary, /passed/);
});

test("validation result summary reports error count when invalid", () => {
  const result = validateTerminalBriefMetadata({});
  assert.equal(result.valid, false);
  assert.match(result.summary, /failed/);
});
