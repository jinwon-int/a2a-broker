import test from "node:test";
import assert from "node:assert/strict";

import { InMemoryA2ABroker } from "../core/broker.js";
import { createIntentRouter, assertProposalTask, assertWorkspaceTask, assertPayloadField, withProposalContext, TaskAssertionError } from "./intent-router.js";
import type { TaskRecord } from "../core/types.js";

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task-1",
    intent: "analyze",
    requester: { id: "hub-1", kind: "node", role: "hub" },
    target: { id: "w1", kind: "node", role: "analyst" },
    targetNodeId: "w1",
    assignedWorkerId: "w1",
    status: "queued",
    payload: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as TaskRecord;
}

test("createIntentRouter routes to correct handler by intent", async () => {
  const router = createIntentRouter({
    handlers: [
      {
        intent: "analyze",
        handler: async (task) => ({
          result: { summary: `analyzed ${task.id}` },
        }),
      },
      {
        intent: "backfill",
        handler: async (task) => ({
          result: { summary: `backfilled ${task.id}` },
        }),
      },
    ],
  });

  const analyzeResult = await router(makeTask({ intent: "analyze" }));
  assert.ok("result" in (analyzeResult as any));
  assert.equal((analyzeResult as any).result.summary, "analyzed task-1");

  const backfillResult = await router(makeTask({ intent: "backfill" }));
  assert.equal((backfillResult as any).result.summary, "backfilled task-1");
});

test("createIntentRouter falls back to default handler for unmatched intents", async () => {
  const router = createIntentRouter({
    handlers: [
      {
        intent: "analyze",
        handler: async () => ({ result: { summary: "hit" } }),
      },
    ],
  });

  const result = await router(makeTask({ intent: "unknown_intent" as any }));
  assert.ok("result" in (result as any));
  assert.match((result as any).result.summary, /no handler registered/);
});

test("createIntentRouter uses custom defaultHandler", async () => {
  const router = createIntentRouter({
    handlers: [],
    defaultHandler: async (task) => ({
      result: { summary: `custom-default: ${task.intent}` },
    }),
  });

  const result = await router(makeTask({ intent: "rare_intent" as any }));
  assert.equal((result as any).result.summary, "custom-default: rare_intent");
});

test("createIntentRouter calls beforeHandle before dispatch", async () => {
  const seenIntents: string[] = [];

  const router = createIntentRouter({
    handlers: [
      {
        intent: "analyze",
        handler: async () => ({ result: { summary: "ok" } }),
      },
    ],
    beforeHandle: async (task) => {
      seenIntents.push(task.intent);
    },
  });

  await router(makeTask({ intent: "analyze" }));
  assert.deepEqual(seenIntents, ["analyze"]);
});

test("createIntentRouter beforeHandle abort can prevent handler execution", async () => {
  const router = createIntentRouter({
    handlers: [
      {
        intent: "analyze",
        handler: async () => {
          throw new Error("should not reach here");
        },
      },
    ],
    beforeHandle: async () => {
      const { TaskAssertionError } = await import("./intent-router.js");
      throw new TaskAssertionError({
        error: { code: "blocked", message: "beforeHandle aborted" },
      });
    },
  });

  const result = await router(makeTask({ intent: "analyze" }));
  assert.ok("error" in (result as any));
  assert.equal((result as any).error.code, "blocked");
});

test("assertProposalTask passes for valid proposal-linked task", () => {
  const task = makeTask({ intent: "validate_change", proposalId: "prop-1" });
  assert.doesNotThrow(() => assertProposalTask(task, "validate_change"));
});

test("assertProposalTask throws on intent mismatch", () => {
  const task = makeTask({ intent: "analyze", proposalId: "prop-1" });
  try {
    assertProposalTask(task, "validate_change");
    assert.fail("should have thrown");
  } catch (error: any) {
    assert.ok(error instanceof Error);
    assert.ok(error.message.length > 0);
    assert.equal((error as any).outcome.error.code, "intent_mismatch");
  }
});

test("assertProposalTask throws on missing proposalId", () => {
  const task = makeTask({ intent: "validate_change" });
  try {
    assertProposalTask(task);
    assert.fail("should have thrown");
  } catch (error: any) {
    assert.ok(error instanceof Error);
    assert.ok(error.message.length > 0);
    assert.equal((error as any).outcome.error.code, "missing_proposal_id");
  }
});

test("assertWorkspaceTask throws on missing workspace", () => {
  const task = makeTask({});
  try {
    assertWorkspaceTask(task);
    assert.fail("should have thrown");
  } catch (error: any) {
    assert.ok(error instanceof Error);
    assert.ok(error.message.length > 0);
    assert.equal((error as any).outcome.error.code, "missing_workspace");
  }
});

test("assertWorkspaceTask passes with valid workspace", () => {
  const task = makeTask({
    workspace: { nodeId: "n1", workspaceId: "ws1" },
  });
  assert.doesNotThrow(() => assertWorkspaceTask(task));
});

test("assertPayloadField returns value for existing field", () => {
  const task = makeTask({ payload: { threshold: 3.0 } });
  const result = assertPayloadField(task, "threshold");
  assert.equal(result, 3.0);
});

test("assertPayloadField throws on missing field", () => {
  const task = makeTask({ payload: {} });
  try {
    assertPayloadField(task, "threshold");
    assert.fail("should have thrown");
  } catch (error: any) {
    assert.ok(error instanceof Error);
    assert.ok(error.message.length > 0);
    assert.equal((error as any).outcome.error.code, "missing_payload_field");
  }
});

test("withProposalContext loads proposal details into task payload", async () => {
  const mockDetails = { proposal: { id: "p1", status: "submitted" }, validations: [] };
  const mockWorker = {
    async getProposalDetails(id: string) {
      if (id === "p1") return mockDetails;
      throw new Error("not found");
    },
  };

  let capturedPayload: Record<string, unknown> | undefined;
  const router = createIntentRouter({
    handlers: [
      {
        intent: "validate_change",
        handler: async (task) => {
          capturedPayload = task.payload;
          return { result: { summary: "ok" } };
        },
      },
    ],
    beforeHandle: withProposalContext(mockWorker),
  });

  const task = makeTask({ intent: "validate_change", proposalId: "p1" });
  await router(task);

  assert.ok(capturedPayload);
  assert.ok(capturedPayload.__proposalDetails);
  assert.deepEqual((capturedPayload.__proposalDetails as any).proposal.id, "p1");
});

test("withProposalContext is no-op when no proposalId", async () => {
  let capturedPayload: Record<string, unknown> | undefined;
  const router = createIntentRouter({
    handlers: [
      {
        intent: "analyze",
        handler: async (task) => {
          capturedPayload = task.payload;
          return { result: { summary: "ok" } };
        },
      },
    ],
    beforeHandle: withProposalContext({
      async getProposalDetails() { throw new Error("should not be called"); },
    }),
  });

  const task = makeTask({ intent: "analyze" });
  await router(task);

  assert.ok(capturedPayload);
  assert.equal(capturedPayload.__proposalDetails, undefined);
});
