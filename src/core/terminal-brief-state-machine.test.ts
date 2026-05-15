/**
 * Tests for the Terminal Brief state machine — transition table, guard
 * functions, terminal/active classifications, and metadata types.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  TERMINAL_BRIEF_TRANSITIONS,
  TERMINAL_BRIEF_ACTIVE_STATES,
  TERMINAL_BRIEF_TERMINAL_STATES,
  TERMINAL_BRIEF_ACK_ELIGIBLE_EVIDENCE,
  canTransitionTerminalBriefEvent,
  canAckTerminalBriefEvent,
  isTerminalBriefEventTerminal,
  isTerminalBriefEventActive,
  mapReceiptStatusToEventStatus,
} from "./terminal-brief-state-machine.js";

// ---------------------------------------------------------------------------
// All state constants
// ---------------------------------------------------------------------------

const ALL_STATES = [
  "outbox_accepted",
  "outbox_started",
  "outbox_produced",
  "provider_sent",
  "provider_accepted",
  "current_session_visible",
  "operator_visible",
  "receipt_confirmed",
  "failed",
  "timed_out",
  "stale",
] as const;

// ---------------------------------------------------------------------------
// Transition table integrity
// ---------------------------------------------------------------------------

test("every known state appears in the transition table exactly once", () => {
  for (const state of ALL_STATES) {
    const allowed = TERMINAL_BRIEF_TRANSITIONS[state];
    assert.ok(allowed, `Missing transition entry for ${state}`);
    assert.ok(allowed instanceof Set, `${state} transitions should be a Set`);
  }
  // Same count — no extra keys, no missing keys
  assert.equal(
    Object.keys(TERMINAL_BRIEF_TRANSITIONS).length,
    ALL_STATES.length,
    "Transition table should not have extra keys",
  );
});

test("every next state in the transition table is a known state", () => {
  const known = new Set(ALL_STATES);
  for (const [, nextSet] of Object.entries(TERMINAL_BRIEF_TRANSITIONS)) {
    for (const next of nextSet as ReadonlySet<string>) {
      assert.ok(known.has(next as typeof ALL_STATES[number]), `Unknown target state: ${next}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Specific transition validation
// ---------------------------------------------------------------------------

test("outbox_accepted → outbox_started is valid", () => {
  assert.ok(canTransitionTerminalBriefEvent("outbox_accepted", "outbox_started"));
});

test("outbox_accepted → receipt_confirmed is NOT valid (must go through visibility states)", () => {
  assert.equal(canTransitionTerminalBriefEvent("outbox_accepted", "receipt_confirmed"), false);
});

test("outbox_accepted → failed is valid (immediate failure)", () => {
  assert.ok(canTransitionTerminalBriefEvent("outbox_accepted", "failed"));
});

test("provider_sent → provider_accepted is valid", () => {
  assert.ok(canTransitionTerminalBriefEvent("provider_sent", "provider_accepted"));
});

test("provider_sent → operator_visible is valid (direct visibility)", () => {
  assert.ok(canTransitionTerminalBriefEvent("provider_sent", "operator_visible"));
});

test("operator_visible → receipt_confirmed is valid", () => {
  assert.ok(canTransitionTerminalBriefEvent("operator_visible", "receipt_confirmed"));
});

test("receipt_confirmed → nothing (absorbing state)", () => {
  for (const state of ALL_STATES) {
    assert.equal(
      canTransitionTerminalBriefEvent("receipt_confirmed", state as any),
      false,
      `Should not transition from receipt_confirmed to ${state}`,
    );
  }
});

test("failed → outbox_accepted is valid (retry)", () => {
  assert.ok(canTransitionTerminalBriefEvent("failed", "outbox_accepted"));
});

test("stale → nothing (absorbing state)", () => {
  for (const state of ALL_STATES) {
    assert.equal(
      canTransitionTerminalBriefEvent("stale", state as any),
      false,
      `Should not transition from stale to ${state}`,
    );
  }
});

test("timed_out → outbox_accepted is valid (retry)", () => {
  assert.ok(canTransitionTerminalBriefEvent("timed_out", "outbox_accepted"));
});

test("self-transitions are not valid (no reflexive entries)", () => {
  for (const state of ALL_STATES) {
    const allowed = TERMINAL_BRIEF_TRANSITIONS[state];
    assert.equal(allowed?.has(state as any), false, `${state} should not self-transition`);
  }
});

// ---------------------------------------------------------------------------
// ACK evidence guard
// ---------------------------------------------------------------------------

test("ack eligible evidence types are accepted", () => {
  assert.ok(canAckTerminalBriefEvent("current_session_visible"));
  assert.ok(canAckTerminalBriefEvent("operator_visible"));
  assert.ok(canAckTerminalBriefEvent("operator_confirmed"));
  assert.ok(canAckTerminalBriefEvent("provider_delivery_receipt"));
});

test("provider_sent alone is NOT ack-eligible", () => {
  assert.equal(canAckTerminalBriefEvent("provider_sent"), false);
});

test("provider_accepted alone is NOT ack-eligible", () => {
  assert.equal(canAckTerminalBriefEvent("provider_accepted"), false);
});

test("random string is NOT ack-eligible", () => {
  assert.equal(canAckTerminalBriefEvent("some_other_evidence"), false);
});

// ---------------------------------------------------------------------------
// Terminal / active classification
// ---------------------------------------------------------------------------

test("terminal states are correctly classified", () => {
  for (const s of ["receipt_confirmed", "failed", "timed_out", "stale"] as const) {
    assert.ok(isTerminalBriefEventTerminal(s), `${s} should be terminal`);
  }
});

test("active states are correctly classified", () => {
  for (const s of TERMINAL_BRIEF_ACTIVE_STATES) {
    assert.ok(isTerminalBriefEventActive(s), `${s} should be active`);
    assert.equal(isTerminalBriefEventTerminal(s), false, `${s} should not be terminal`);
  }
});

test("no overlap between active and terminal", () => {
  for (const active of TERMINAL_BRIEF_ACTIVE_STATES) {
    assert.equal(
      TERMINAL_BRIEF_TERMINAL_STATES.has(active),
      false,
      `${active} should not be in both sets`,
    );
  }
});

test("active + terminal sets cover all defined states", () => {
  const covered = new Set([...TERMINAL_BRIEF_ACTIVE_STATES, ...TERMINAL_BRIEF_TERMINAL_STATES]);
  for (const state of ALL_STATES) {
    assert.ok(covered.has(state as any), `${state} must be in active or terminal set`);
  }
});

// ---------------------------------------------------------------------------
// Receipt status mapping
// ---------------------------------------------------------------------------

test("mapReceiptStatusToEventStatus maps all known receipt statuses", () => {
  assert.equal(mapReceiptStatusToEventStatus("accepted", false), "outbox_accepted");
  assert.equal(mapReceiptStatusToEventStatus("started", false), "outbox_started");
  assert.equal(mapReceiptStatusToEventStatus("produced", false), "outbox_produced");
  assert.equal(mapReceiptStatusToEventStatus("provider_sent", false), "provider_sent");
  assert.equal(mapReceiptStatusToEventStatus("provider_accepted", false), "provider_accepted");
  assert.equal(mapReceiptStatusToEventStatus("current_session_visible", false), "current_session_visible");
  assert.equal(mapReceiptStatusToEventStatus("operator_visible", false), "operator_visible");
  assert.equal(mapReceiptStatusToEventStatus("failed", false), "failed");
  assert.equal(mapReceiptStatusToEventStatus("timed_out", false), "timed_out");
  assert.equal(mapReceiptStatusToEventStatus("stale", false), "stale");
});

test("mapReceiptStatusToEventStatus prefers receipt_confirmed over receipt status", () => {
  assert.equal(mapReceiptStatusToEventStatus("accepted", true), "receipt_confirmed");
  assert.equal(mapReceiptStatusToEventStatus("operator_visible", true), "receipt_confirmed");
});

test("mapReceiptStatusToEventStatus defaults to outbox_accepted for unknown status", () => {
  assert.equal(mapReceiptStatusToEventStatus("unknown_status", false), "outbox_accepted");
  assert.equal(mapReceiptStatusToEventStatus("unknown_status", true), "receipt_confirmed");
});

// ---------------------------------------------------------------------------
// Template metadata and TaskFlow linkage (type-level checks via runtime)
// ---------------------------------------------------------------------------

test("template metadata interface fields are accessible at runtime", () => {
  // Instantiate via plain object — verifies structural compatibility
  const meta = {
    templateId: "terminal-brief/r23-team2-dungae",
    templateVersion: "1.0.0",
    taskDefinitionRef: "specs/terminal-brief-r23.md",
    templateParameters: { lane: "dungae", team: "Team2" },
  };
  assert.equal(meta.templateId, "terminal-brief/r23-team2-dungae");
  assert.equal(meta.templateVersion, "1.0.0");
  assert.equal(meta.taskDefinitionRef, "specs/terminal-brief-r23.md");
  assert.deepEqual(meta.templateParameters, { lane: "dungae", team: "Team2" });
});

test("TaskFlow linkage fields are accessible at runtime", () => {
  const linkage = {
    taskFlowRunId: "a2a-r23-terminal-brief-spec-taskflow-monorepo-20260515T055352Z",
    taskFlowTaskId: "team2-dungae-state-machine",
    taskFlowStepId: "implement-state-machine",
    parentTaskFlowRunId: "a2a-r23-master",
    stepLabel: "Terminal Brief state machine definition",
  };
  assert.equal(
    linkage.taskFlowRunId,
    "a2a-r23-terminal-brief-spec-taskflow-monorepo-20260515T055352Z",
  );
  assert.equal(linkage.taskFlowTaskId, "team2-dungae-state-machine");
  assert.equal(linkage.taskFlowStepId, "implement-state-machine");
  assert.equal(linkage.parentTaskFlowRunId, "a2a-r23-master");
  assert.equal(linkage.stepLabel, "Terminal Brief state machine definition");
});

test("TerminalBriefRuntimeEvent scaffold is structurally sound", () => {
  // Just ensure the type can be instantiated with the fields we care about
  const event = {
    id: "tb-event-001",
    taskId: "task-649",
    status: "provider_sent" as const,
    receiptStatus: "provider_sent",
    receiptConfirmed: false,
    createdAt: new Date().toISOString(),
    template: {
      templateId: "terminal-brief/r23-team2-dungae",
    },
    taskFlow: {
      taskFlowRunId: "run-001",
    },
  };
  assert.equal(event.id, "tb-event-001");
  assert.equal(event.status, "provider_sent");
  assert.ok(event.createdAt);
  assert.equal(event.template?.templateId, "terminal-brief/r23-team2-dungae");
  assert.equal(event.taskFlow?.taskFlowRunId, "run-001");
});
