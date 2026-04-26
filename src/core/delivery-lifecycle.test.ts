/**
 * Tests for broker delivery lifecycle manager (Round 22 / issue #101).
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { DeliveryManager, DeliveryError } from "./delivery-lifecycle.js";
import type { DeliveryArtifact, DeliveryEvent } from "./delivery-lifecycle-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXED_NOW = new Date("2026-04-26T12:00:00.000Z");
const NOW = () => new Date(FIXED_NOW);
let idCounter = 0;
const ID_FACTORY = () => `test-${++idCounter}`;

const SAMPLE_ARTIFACT: DeliveryArtifact = {
  runId: "run-1",
  outcome: "success",
  summary: "Task completed with 3 artifacts",
  artifactIds: ["a1", "a2", "a3"],
};

function makeInput(overrides?: Partial<Parameters<DeliveryManager["registerDelivery"]>[0]>) {
  return {
    runId: "run-1",
    originatorSessionKey: "session-main",
    originatorNodeId: "seoseo",
    parentTaskId: "task-1",
    artifact: SAMPLE_ARTIFACT,
    ...overrides,
  };
}

function makeManager() {
  return new DeliveryManager({ now: NOW, idFactory: ID_FACTORY });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DeliveryManager", () => {
  let dm: DeliveryManager;
  let deliveryId: string;

  beforeEach(() => {
    idCounter = 0;
    dm = makeManager();
    const d = dm.registerDelivery(makeInput());
    deliveryId = d.deliveryId;
  });

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  describe("registerDelivery", () => {
    it("registers a delivery in result_ready state", () => {
      const d = dm.getDelivery(deliveryId)!;
      assert.equal(d.status, "result_ready");
      assert.equal(d.runId, "run-1");
      assert.equal(d.originatorSessionKey, "session-main");
      assert.equal(d.originatorNodeId, "seoseo");
      assert.equal(d.attempt, 1);
      assert.equal(d.maxRetries, 3);
      assert.equal(d.acknowledged, false);
      assert.equal(d.duplicateSuppressed, false);
    });

    it("emits del_result_ready event", () => {
      const events = dm.subscribe({ deliveryId });
      assert.equal(events.length, 1);
      assert.equal(events[0].kind, "del_result_ready");
      assert.equal(events[0].runId, "run-1");
    });

    it("suppresses duplicate registrations for same runId", () => {
      const d2 = dm.registerDelivery(makeInput({ artifact: { ...SAMPLE_ARTIFACT, summary: "different" } }));
      assert.equal(d2.deliveryId, deliveryId);
      assert.equal(d2.duplicateSuppressed, true);
      // Original artifact preserved
      assert.equal(d2.artifact.summary, "Task completed with 3 artifacts");
    });

    it("finds delivery by runId", () => {
      const d = dm.getDeliveryByRunId("run-1");
      assert.ok(d);
      assert.equal(d!.deliveryId, deliveryId);
    });
  });

  // -------------------------------------------------------------------------
  // Lifecycle transitions
  // -------------------------------------------------------------------------

  describe("lifecycle", () => {
    it("full happy path: ready → pending → delivering → delivered → acked", () => {
      dm.queueDelivery(deliveryId);
      assert.equal(dm.getDelivery(deliveryId)!.status, "delivery_pending");

      dm.startDelivery({ deliveryId, channel: "telegram" });
      assert.equal(dm.getDelivery(deliveryId)!.status, "delivering");
      assert.equal(dm.getDelivery(deliveryId)!.channel, "telegram");

      dm.markDelivered(deliveryId, "2026-04-26T12:05:00.000Z");
      assert.equal(dm.getDelivery(deliveryId)!.status, "delivered");
      assert.ok(dm.getDelivery(deliveryId)!.deliveredAt);
      assert.equal(dm.getDelivery(deliveryId)!.ackDeadline, "2026-04-26T12:05:00.000Z");

      dm.acknowledgeDelivery({ deliveryId });
      assert.equal(dm.getDelivery(deliveryId)!.status, "acked");
      assert.equal(dm.getDelivery(deliveryId)!.acknowledged, true);
      assert.ok(dm.getDelivery(deliveryId)!.ackedAt);
      assert.ok(dm.getDelivery(deliveryId)!.completedAt);
    });

    it("emits correct events for happy path", () => {
      dm.queueDelivery(deliveryId);
      dm.startDelivery({ deliveryId });
      dm.markDelivered(deliveryId);
      dm.acknowledgeDelivery({ deliveryId });

      const events = dm.subscribe({ deliveryId });
      assert.equal(events.length, 5);
      assert.equal(events[0].kind, "del_result_ready");
      assert.equal(events[1].kind, "del_pending");
      assert.equal(events[2].kind, "del_delivering");
      assert.equal(events[3].kind, "del_delivered");
      assert.equal(events[4].kind, "del_acked");
    });
  });

  // -------------------------------------------------------------------------
  // Failure and retry
  // -------------------------------------------------------------------------

  describe("failure and retry", () => {
    it("marks delivery as failed", () => {
      dm.queueDelivery(deliveryId);
      dm.startDelivery({ deliveryId });
      dm.failDelivery(deliveryId, "originator_unreachable");
      const d = dm.getDelivery(deliveryId)!;
      assert.equal(d.status, "failed");
      assert.equal(d.failureCode, "originator_unreachable");
    });

    it("retries failed delivery and increments attempt", () => {
      dm.queueDelivery(deliveryId);
      dm.startDelivery({ deliveryId });
      dm.failDelivery(deliveryId, "channel_unavailable");
      dm.retryDelivery(deliveryId);
      const d = dm.getDelivery(deliveryId)!;
      assert.equal(d.status, "retrying");
      assert.equal(d.attempt, 2);
      assert.equal(d.failureCode, undefined);
    });

    it("allows retrying → pending → delivering after retry", () => {
      dm.queueDelivery(deliveryId);
      dm.startDelivery({ deliveryId });
      dm.failDelivery(deliveryId, "rate_limited");
      dm.retryDelivery(deliveryId);
      dm.queueDelivery(deliveryId);
      dm.startDelivery({ deliveryId });
      dm.markDelivered(deliveryId);
      dm.acknowledgeDelivery({ deliveryId });
      assert.equal(dm.getDelivery(deliveryId)!.status, "acked");
    });

    it("auto-transitions to timed_out when max retries exceeded", () => {
      // Register with maxRetries=1 so we hit the limit quickly
      idCounter = 0;
      dm = makeManager();
      const d = dm.registerDelivery(makeInput({ maxRetries: 1 }));
      dm.queueDelivery(d.deliveryId);
      dm.startDelivery({ deliveryId: d.deliveryId });
      dm.failDelivery(d.deliveryId, "auth_failed");
      dm.retryDelivery(d.deliveryId); // attempt 2, maxRetries=1
      assert.equal(dm.getDelivery(d.deliveryId)!.status, "timed_out");
      assert.equal(dm.getDelivery(d.deliveryId)!.failureCode, "max_retries_exceeded");
    });

    it("rejects retry from non-failed/timed_out state", () => {
      assert.throws(
        () => dm.retryDelivery(deliveryId),
        (err: unknown) => err instanceof DeliveryError && err.code === "INVALID_RETRY",
      );
    });
  });

  // -------------------------------------------------------------------------
  // Timeout
  // -------------------------------------------------------------------------

  describe("timeout", () => {
    it("transitions to timed_out", () => {
      dm.queueDelivery(deliveryId);
      dm.timeoutDelivery(deliveryId, "delivery_timeout");
      const d = dm.getDelivery(deliveryId)!;
      assert.equal(d.status, "timed_out");
      assert.equal(d.failureCode, "delivery_timeout");
      assert.ok(d.completedAt);
    });

    it("allows retry from timed_out", () => {
      dm.queueDelivery(deliveryId);
      dm.timeoutDelivery(deliveryId);
      dm.retryDelivery(deliveryId);
      assert.equal(dm.getDelivery(deliveryId)!.status, "retrying");
    });

    it("finds delivery timeouts by deadline", () => {
      dm.queueDelivery(deliveryId);
      dm.startDelivery({ deliveryId });
      const d = dm.getDelivery(deliveryId)!;
      d.deliveryDeadline = "2026-04-25T12:00:00.000Z"; // past
      const timeouts = dm.findDeliveryTimeouts();
      assert.equal(timeouts.length, 1);
      assert.equal(timeouts[0], deliveryId);
    });

    it("finds ACK timeouts by deadline", () => {
      dm.queueDelivery(deliveryId);
      dm.startDelivery({ deliveryId });
      dm.markDelivered(deliveryId);
      const d = dm.getDelivery(deliveryId)!;
      d.ackDeadline = "2026-04-25T12:00:00.000Z"; // past
      const ackTimeouts = dm.findAckTimeouts();
      assert.equal(ackTimeouts.length, 1);
      assert.equal(ackTimeouts[0], deliveryId);
    });

    it("ignores non-pending deliveries for delivery timeout", () => {
      dm.queueDelivery(deliveryId);
      const d = dm.getDelivery(deliveryId)!;
      d.deliveryDeadline = "2026-04-25T12:00:00.000Z";
      // status is delivery_pending — should be found
      assert.equal(dm.findDeliveryTimeouts().length, 1);

      // Mark as delivered — should no longer be found
      dm.startDelivery({ deliveryId });
      dm.markDelivered(deliveryId);
      assert.equal(dm.findDeliveryTimeouts().length, 0);
    });
  });

  // -------------------------------------------------------------------------
  // Invalid transitions
  // -------------------------------------------------------------------------

  describe("invalid transitions", () => {
    it("rejects skipping states", () => {
      // result_ready → delivering (should go through pending)
      assert.throws(
        () => dm.startDelivery({ deliveryId }),
        (err: unknown) => err instanceof DeliveryError && err.code === "INVALID_TRANSITION",
      );
    });

    it("rejects ack from non-delivered state", () => {
      assert.throws(
        () => dm.acknowledgeDelivery({ deliveryId }),
        (err: unknown) => err instanceof DeliveryError && err.code === "INVALID_TRANSITION",
      );
    });

    it("rejects transition from terminal acked state", () => {
      dm.queueDelivery(deliveryId);
      dm.startDelivery({ deliveryId });
      dm.markDelivered(deliveryId);
      dm.acknowledgeDelivery({ deliveryId });
      assert.throws(
        () => dm.failDelivery(deliveryId, "other"),
        (err: unknown) => err instanceof DeliveryError && err.code === "INVALID_TRANSITION",
      );
    });
  });

  // -------------------------------------------------------------------------
  // Closeout
  // -------------------------------------------------------------------------

  describe("closeout", () => {
    it("closeout for acked delivery", () => {
      dm.queueDelivery(deliveryId);
      dm.startDelivery({ deliveryId });
      dm.markDelivered(deliveryId);
      dm.acknowledgeDelivery({ deliveryId });
      const c = dm.closeoutDelivery(deliveryId)!;
      assert.equal(c.kind, "acked");
      assert.equal(c.attempts, 1);
      assert.ok(c.artifact);
    });

    it("closeout for delivered_unacked", () => {
      dm.queueDelivery(deliveryId);
      dm.startDelivery({ deliveryId });
      dm.markDelivered(deliveryId);
      const c = dm.closeoutDelivery(deliveryId)!;
      assert.equal(c.kind, "delivered_unacked");
    });

    it("closeout for failed", () => {
      dm.queueDelivery(deliveryId);
      dm.startDelivery({ deliveryId });
      dm.failDelivery(deliveryId, "auth_failed");
      const c = dm.closeoutDelivery(deliveryId)!;
      assert.equal(c.kind, "failed");
      assert.equal(c.failureCode, "auth_failed");
    });

    it("closeout for pending", () => {
      const c = dm.closeoutDelivery(deliveryId)!;
      assert.equal(c.kind, "pending");
    });

    it("closeout for duplicate_suppressed", () => {
      dm.registerDelivery(makeInput());
      const c = dm.closeoutDelivery(deliveryId)!;
      assert.equal(c.kind, "duplicate_suppressed");
    });

    it("closeout returns null for unknown delivery", () => {
      assert.equal(dm.closeoutDelivery("nonexistent"), null);
    });

    it("closeout by task", () => {
      const id2 = dm.registerDelivery(makeInput({ runId: "run-2", artifact: { ...SAMPLE_ARTIFACT, runId: "run-2" } })).deliveryId;
      dm.queueDelivery(deliveryId);
      dm.startDelivery({ deliveryId });
      dm.markDelivered(deliveryId);
      dm.acknowledgeDelivery({ deliveryId });
      dm.queueDelivery(id2);
      dm.startDelivery({ deliveryId: id2 });
      dm.markDelivered(id2);
      dm.acknowledgeDelivery({ deliveryId: id2 });

      const summaries = dm.closeoutTask("task-1");
      assert.equal(summaries.length, 2);
    });

    it("closeout by session", () => {
      const summaries = dm.closeoutSession("session-main");
      assert.equal(summaries.length, 1);
      assert.equal(summaries[0].originatorSessionKey, "session-main");
    });
  });

  // -------------------------------------------------------------------------
  // Replay / subscribe
  // -------------------------------------------------------------------------

  describe("subscribe", () => {
    it("filters by runId", () => {
      dm.queueDelivery(deliveryId);
      const id2 = dm.registerDelivery(makeInput({ runId: "run-2", artifact: { ...SAMPLE_ARTIFACT, runId: "run-2" } })).deliveryId;
      dm.queueDelivery(id2);

      const events = dm.subscribe({ runId: "run-1" });
      assert.equal(events.length, 2); // result_ready + pending
      events.forEach((e) => assert.equal(e.runId, "run-1"));
    });

    it("filters by originatorSessionKey", () => {
      dm.queueDelivery(deliveryId);
      const id2 = dm.registerDelivery(makeInput({
        runId: "run-2",
        originatorSessionKey: "session-other",
        artifact: { ...SAMPLE_ARTIFACT, runId: "run-2" },
      })).deliveryId;
      dm.queueDelivery(id2);

      const events = dm.subscribe({ originatorSessionKey: "session-main" });
      assert.equal(events.length, 2);
      events.forEach((e) => assert.equal(e.originatorSessionKey, "session-main"));
    });

    it("cursor-based replay with afterId", () => {
      dm.queueDelivery(deliveryId);
      dm.startDelivery({ deliveryId });
      const all = dm.subscribe({ deliveryId });
      assert.equal(all.length, 3);
      const partial = dm.subscribe({ deliveryId, afterId: all[1].id });
      assert.equal(partial.length, 1);
      assert.equal(partial[0].kind, "del_delivering");
    });

    it("limit works", () => {
      dm.queueDelivery(deliveryId);
      dm.startDelivery({ deliveryId });
      dm.markDelivered(deliveryId);
      const events = dm.subscribe({ deliveryId, limit: 2 });
      assert.equal(events.length, 2);
    });
  });

  // -------------------------------------------------------------------------
  // Event metadata
  // -------------------------------------------------------------------------

  describe("event metadata", () => {
    it("includes channel in metadata", () => {
      dm.queueDelivery(deliveryId);
      dm.startDelivery({ deliveryId, channel: "telegram" });
      const events = dm.subscribe({ deliveryId });
      const delEvent = events.find((e) => e.kind === "del_delivering");
      assert.ok(delEvent);
      assert.equal(delEvent.metadata.channel, "telegram");
    });

    it("includes failureCode in metadata", () => {
      dm.queueDelivery(deliveryId);
      dm.startDelivery({ deliveryId });
      dm.failDelivery(deliveryId, "rate_limited");
      const events = dm.subscribe({ deliveryId });
      const failEvent = events.find((e) => e.kind === "del_failed");
      assert.ok(failEvent);
      assert.equal(failEvent.metadata.failureCode, "rate_limited");
    });

    it("includes attempt and maxRetries", () => {
      const events = dm.subscribe({ deliveryId });
      assert.equal(events[0].metadata.attempt, 1);
      assert.equal(events[0].metadata.maxRetries, 3);
    });

    it("tracks delivery duration", () => {
      idCounter = 0;
      dm = new DeliveryManager({
        now: () => new Date("2026-04-26T12:00:00.000Z"),
        idFactory: ID_FACTORY,
      });
      const d = dm.registerDelivery(makeInput());
      dm.queueDelivery(d.deliveryId);
      dm.startDelivery({ deliveryId: d.deliveryId });
      // Advance time 30s for delivery
      dm = new DeliveryManager({
        now: () => new Date("2026-04-26T12:00:30.000Z"),
        idFactory: ID_FACTORY,
        // Copy state from previous manager
      });
      // We need to test on same manager, so just verify the duration logic
      // by directly checking the transition output.
      idCounter = 0;
      dm = new DeliveryManager({
        now: () => new Date("2026-04-26T12:00:30.000Z"),
        idFactory: ID_FACTORY,
      });
      const d2 = dm.registerDelivery(makeInput());
      dm.queueDelivery(d2.deliveryId);
      // Set deliveryStartedAt in the past
      const state = dm.getDelivery(d2.deliveryId)!;
      (state as any).deliveryStartedAt = "2026-04-26T12:00:00.000Z";
      state.status = "delivering";
      dm.markDelivered(d2.deliveryId);

      const events = dm.subscribe({ deliveryId: d2.deliveryId });
      const delEvent = events.find((e) => e.kind === "del_delivered");
      assert.ok(delEvent);
      assert.equal(delEvent.metadata.deliveryDurationMs, 30000);
    });

    it("tracks ACK duration", () => {
      idCounter = 0;
      dm = new DeliveryManager({
        now: () => new Date("2026-04-26T12:00:10.000Z"),
        idFactory: ID_FACTORY,
      });
      const d = dm.registerDelivery(makeInput());
      dm.queueDelivery(d.deliveryId);
      dm.startDelivery({ deliveryId: d.deliveryId });
      dm.markDelivered(d.deliveryId);
      const state = dm.getDelivery(d.deliveryId)!;
      (state as any).deliveredAt = "2026-04-26T12:00:00.000Z";
      dm.acknowledgeDelivery({ deliveryId: d.deliveryId });
      (dm.getDelivery(d.deliveryId) as any).ackedAt = "2026-04-26T12:00:10.000Z";

      const events = dm.subscribe({ deliveryId: d.deliveryId });
      const ackEvent = events.find((e) => e.kind === "del_acked");
      assert.ok(ackEvent);
      assert.equal(ackEvent.metadata.ackDurationMs, 10000);
    });
  });

  // -------------------------------------------------------------------------
  // Multiple deliveries
  // -------------------------------------------------------------------------

  describe("multiple deliveries", () => {
    it("tracks separate deliveries for different runs", () => {
      const id2 = dm.registerDelivery(makeInput({
        runId: "run-2",
        artifact: { ...SAMPLE_ARTIFACT, runId: "run-2" },
      })).deliveryId;

      assert.notEqual(deliveryId, id2);
      assert.ok(dm.getDelivery(deliveryId));
      assert.ok(dm.getDelivery(id2));
      assert.equal(dm.getDeliveryByRunId("run-1")!.deliveryId, deliveryId);
      assert.equal(dm.getDeliveryByRunId("run-2")!.deliveryId, id2);
    });

    it("closeout task aggregates all runs", () => {
      const id2 = dm.registerDelivery(makeInput({
        runId: "run-2",
        artifact: { ...SAMPLE_ARTIFACT, runId: "run-2" },
      })).deliveryId;

      // Complete both
      for (const id of [deliveryId, id2]) {
        dm.queueDelivery(id);
        dm.startDelivery({ deliveryId: id });
        dm.markDelivered(id);
        dm.acknowledgeDelivery({ deliveryId: id });
      }

      const summaries = dm.closeoutTask("task-1");
      assert.equal(summaries.length, 2);
      assert(summaries.every((s) => s.kind === "acked"));
    });
  });

  // -------------------------------------------------------------------------
  // Failure code resolution
  // -------------------------------------------------------------------------

  describe("failure code resolution", () => {
    it("resolves aliases", () => {
      dm.queueDelivery(deliveryId);
      dm.startDelivery({ deliveryId });
      dm.failDelivery(deliveryId, "unreachable");
      assert.equal(dm.getDelivery(deliveryId)!.failureCode, "originator_unreachable");
    });

    it("resolves full codes", () => {
      dm.queueDelivery(deliveryId);
      dm.startDelivery({ deliveryId });
      dm.failDelivery(deliveryId, "ack_timeout");
      assert.equal(dm.getDelivery(deliveryId)!.failureCode, "ack_timeout");
    });

    it("falls back to 'other' for unknown codes", () => {
      dm.queueDelivery(deliveryId);
      dm.startDelivery({ deliveryId });
      dm.failDelivery(deliveryId, "something_weird");
      assert.equal(dm.getDelivery(deliveryId)!.failureCode, "other");
    });
  });

  // -------------------------------------------------------------------------
  // Deadline propagation
  // -------------------------------------------------------------------------

  describe("deadlines", () => {
    it("accepts delivery deadline on registration", () => {
      idCounter = 0;
      dm = makeManager();
      const d = dm.registerDelivery(makeInput({
        deliveryDeadline: "2026-04-26T13:00:00.000Z",
        ackDeadline: "2026-04-26T13:05:00.000Z",
      }));
      assert.equal(d.deliveryDeadline, "2026-04-26T13:00:00.000Z");
    });

    it("accepts ack deadline on markDelivered", () => {
      dm.queueDelivery(deliveryId);
      dm.startDelivery({ deliveryId });
      dm.markDelivered(deliveryId, "2026-04-26T12:10:00.000Z");
      assert.equal(dm.getDelivery(deliveryId)!.ackDeadline, "2026-04-26T12:10:00.000Z");
    });

    it("no delivery timeout when deadline is in the future", () => {
      dm.queueDelivery(deliveryId);
      dm.startDelivery({ deliveryId });
      const d = dm.getDelivery(deliveryId)!;
      d.deliveryDeadline = "2026-04-27T12:00:00.000Z"; // future
      assert.equal(dm.findDeliveryTimeouts().length, 0);
    });

    it("no ack timeout when deadline is in the future", () => {
      dm.queueDelivery(deliveryId);
      dm.startDelivery({ deliveryId });
      dm.markDelivered(deliveryId);
      const d = dm.getDelivery(deliveryId)!;
      d.ackDeadline = "2026-04-27T12:00:00.000Z"; // future
      assert.equal(dm.findAckTimeouts().length, 0);
    });

    it("no ack timeout when not delivered", () => {
      dm.queueDelivery(deliveryId);
      const d = dm.getDelivery(deliveryId)!;
      d.ackDeadline = "2026-04-25T12:00:00.000Z";
      assert.equal(dm.findAckTimeouts().length, 0);
    });
  });
});
