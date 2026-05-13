/**
 * Tests for terminal-outbox backlog risk analyzer (issue #540).
 *
 * Reference: #540 Team1/Bangtong stability gates for #497/#294.
 */
import { describe, it } from "node:test";
import * as assert from "node:assert";
import {
  analyzeTerminalOutboxBacklogRisk,
  DEFAULT_TERMINAL_OUTBOX_BACKLOG_THRESHOLDS,
  type TerminalOutboxBacklogSnapshot,
} from "./terminal-outbox-backlog-risk.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptySnapshot(): TerminalOutboxBacklogSnapshot {
  return { total: 0, acked: 0, unacked: 0, unackedRatio: 0, oldestUnackedAgeMs: null, oldestUnackedCreatedAt: null, warnings: [] };
}

function snapshot(overrides: Partial<TerminalOutboxBacklogSnapshot>): TerminalOutboxBacklogSnapshot {
  return { ...emptySnapshot(), ...overrides };
}

// ---------------------------------------------------------------------------
// Empty outbox
// ---------------------------------------------------------------------------

describe("analyzeTerminalOutboxBacklogRisk — empty outbox", () => {
  it("returns none risk for an empty outbox", () => {
    const result = analyzeTerminalOutboxBacklogRisk(emptySnapshot());
    assert.strictEqual(result.risk, "none");
    assert.strictEqual(result.stabilityGatePass, true);
    assert.strictEqual(result.signals.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Healthy outbox
// ---------------------------------------------------------------------------

describe("analyzeTerminalOutboxBacklogRisk — healthy outbox", () => {
  it("returns none risk when everything is acked", () => {
    const s = snapshot({ total: 50, acked: 50, unacked: 0, unackedRatio: 0 });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    assert.strictEqual(result.risk, "none");
    assert.strictEqual(result.stabilityGatePass, true);
    assert.strictEqual(result.signals.length, 0);
  });

  it("returns none risk for low unacked count below thresholds", () => {
    const s = snapshot({ total: 200, acked: 190, unacked: 10, unackedRatio: 0.05 });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    assert.strictEqual(result.risk, "none");
    assert.strictEqual(result.stabilityGatePass, true);
  });
});

// ---------------------------------------------------------------------------
// High unacked ratio
// ---------------------------------------------------------------------------

describe("analyzeTerminalOutboxBacklogRisk — high unacked ratio", () => {
  it("flags high_unacked_ratio when unackedRatio > 0.5", () => {
    const s = snapshot({ total: 100, acked: 20, unacked: 80, unackedRatio: 0.8 });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    const signal = result.signals.find((sig) => sig.kind === "high_unacked_ratio");
    assert.ok(signal, "should have high_unacked_ratio signal");
    assert.strictEqual(signal.severity, "warning");
    assert.strictEqual(result.risk, "low");
  });

  it("flags high_unacked_ratio as critical at >= 90%", () => {
    const s = snapshot({ total: 100, acked: 5, unacked: 95, unackedRatio: 0.95 });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    const signal = result.signals.find((sig) => sig.kind === "high_unacked_ratio");
    assert.ok(signal);
    assert.strictEqual(signal.severity, "critical");
    assert.strictEqual(result.risk, "high");
  });

  it("respects custom unacked ratio threshold", () => {
    const s = snapshot({ total: 100, acked: 70, unacked: 30, unackedRatio: 0.3 });
    const result = analyzeTerminalOutboxBacklogRisk(s, { maxUnackedRatioWarning: 0.25 });
    const signal = result.signals.find((sig) => sig.kind === "high_unacked_ratio");
    assert.ok(signal, "should flag with custom lower threshold");
  });
});

// ---------------------------------------------------------------------------
// Unacked accumulation
// ---------------------------------------------------------------------------

describe("analyzeTerminalOutboxBacklogRisk — unacked accumulation", () => {
  it("flags unacked_accumulation at warning level", () => {
    const s = snapshot({ total: 300, acked: 100, unacked: 200, unackedRatio: 0.67 });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    const signal = result.signals.find((sig) => sig.kind === "unacked_accumulation");
    assert.ok(signal, "should have unacked_accumulation signal");
    assert.strictEqual(signal.severity, "warning");
  });

  it("flags unacked_accumulation at critical level above 500", () => {
    const s = snapshot({ total: 600, acked: 50, unacked: 550, unackedRatio: 0.92 });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    const signal = result.signals.find((sig) => sig.kind === "unacked_accumulation");
    assert.ok(signal);
    assert.strictEqual(signal.severity, "critical");
    assert.strictEqual(result.stabilityGatePass, false);
  });

  it("uses custom unacked count thresholds", () => {
    const s = snapshot({ total: 50, acked: 0, unacked: 50, unackedRatio: 1.0 });
    const result = analyzeTerminalOutboxBacklogRisk(s, { maxUnackedCountWarning: 40, maxUnackedCountCritical: 200 });
    const signal = result.signals.find((sig) => sig.kind === "unacked_accumulation");
    assert.ok(signal);
    assert.strictEqual(signal.severity, "warning");
  });

  it("does not flag when below both ratio and count thresholds", () => {
    const s = snapshot({ total: 10, acked: 9, unacked: 1, unackedRatio: 0.1 });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    assert.strictEqual(result.signals.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Stale unacked entries
// ---------------------------------------------------------------------------

describe("analyzeTerminalOutboxBacklogRisk — stale unacked entries", () => {
  it("flags stale_unacked_entry at warning level (>7 days)", () => {
    const s = snapshot({
      total: 100, acked: 90, unacked: 10, unackedRatio: 0.1,
      oldestUnackedAgeMs: 8 * 24 * 60 * 60 * 1000,
      oldestUnackedCreatedAt: "2026-05-01T00:00:00.000Z",
    });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    const signal = result.signals.find((sig) => sig.kind === "stale_unacked_entry");
    assert.ok(signal, "should have stale_unacked_entry signal");
    assert.strictEqual(signal.severity, "warning");
  });

  it("flags stale_unacked_entry at critical level (>30 days)", () => {
    const s = snapshot({
      total: 100, acked: 80, unacked: 20, unackedRatio: 0.2,
      oldestUnackedAgeMs: 31 * 24 * 60 * 60 * 1000,
      oldestUnackedCreatedAt: "2026-04-01T00:00:00.000Z",
    });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    const signal = result.signals.find((sig) => sig.kind === "stale_unacked_entry");
    assert.ok(signal);
    assert.strictEqual(signal.severity, "critical");
  });

  it("skips stale check when oldestUnackedAgeMs is null", () => {
    const s = snapshot({ total: 10, acked: 5, unacked: 5, unackedRatio: 0.5 });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    const signal = result.signals.find((sig) => sig.kind === "stale_unacked_entry");
    assert.strictEqual(signal, undefined);
  });

  it("respects custom age thresholds", () => {
    const s = snapshot({
      total: 50, acked: 49, unacked: 1, unackedRatio: 0.02,
      oldestUnackedAgeMs: 3 * 24 * 60 * 60 * 1000,
      oldestUnackedCreatedAt: "2026-05-08T00:00:00.000Z",
    });
    const result = analyzeTerminalOutboxBacklogRisk(s, { maxUnackedAgeMsWarning: 2 * 24 * 60 * 60 * 1000 });
    assert.ok(result.signals.find((sig) => sig.kind === "stale_unacked_entry"));
  });
});

// ---------------------------------------------------------------------------
// Provider send-only stall
// ---------------------------------------------------------------------------

describe("analyzeTerminalOutboxBacklogRisk — provider send-only stall", () => {
  it("flags provider_send_only_stall when provider-sent entries are unacked", () => {
    const s = snapshot({ total: 100, acked: 80, unacked: 20, unackedRatio: 0.2, providerSendOnlyUnacked: 5 });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    const signal = result.signals.find((sig) => sig.kind === "provider_send_only_stall");
    assert.ok(signal, "should flag provider-sent/accepted entries without operator visibility");
    assert.strictEqual(signal.severity, "warning");
  });

  it("does not flag when providerSendOnlyUnacked is zero", () => {
    const s = snapshot({ total: 100, acked: 80, unacked: 20, unackedRatio: 0.2, providerSendOnlyUnacked: 0 });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    assert.strictEqual(result.signals.find((sig) => sig.kind === "provider_send_only_stall"), undefined);
  });

  it("does not flag when providerSendOnlyUnacked is undefined", () => {
    const s = snapshot({ total: 100, acked: 80, unacked: 20, unackedRatio: 0.2 });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    assert.strictEqual(result.signals.find((sig) => sig.kind === "provider_send_only_stall"), undefined);
  });
});

// ---------------------------------------------------------------------------
// ACK-eligible stall
// ---------------------------------------------------------------------------

describe("analyzeTerminalOutboxBacklogRisk — ACK-eligible stall", () => {
  it("flags ack_eligible_stall as info when eligible events are unconfirmed", () => {
    const s = snapshot({ total: 50, acked: 30, unacked: 20, unackedRatio: 0.4, ackEligibleUnacked: 5 });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    const signal = result.signals.find((sig) => sig.kind === "ack_eligible_stall");
    assert.ok(signal);
    assert.strictEqual(signal.severity, "info");
  });

  it("does not flag ack_eligible_stall at zero", () => {
    const s = snapshot({ total: 50, acked: 30, unacked: 20, unackedRatio: 0.4, ackEligibleUnacked: 0 });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    assert.strictEqual(result.signals.find((sig) => sig.kind === "ack_eligible_stall"), undefined);
  });
});

// ---------------------------------------------------------------------------
// Stale receipt blindspot
// ---------------------------------------------------------------------------

describe("analyzeTerminalOutboxBacklogRisk — stale receipt blindspot", () => {
  it("flags stale_receipt_blindspot for unacked stale-receipt entries", () => {
    const s = snapshot({ total: 100, acked: 50, unacked: 50, unackedRatio: 0.5, staleReceiptUnacked: 12 });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    const signal = result.signals.find((sig) => sig.kind === "stale_receipt_blindspot");
    assert.ok(signal, "should flag stale-receipt unacked blindspot");
    assert.strictEqual(signal.severity, "warning");
  });

  it("does not flag when staleReceiptUnacked is zero", () => {
    const s = snapshot({ total: 100, acked: 50, unacked: 50, unackedRatio: 0.5, staleReceiptUnacked: 0 });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    assert.strictEqual(result.signals.find((sig) => sig.kind === "stale_receipt_blindspot"), undefined);
  });
});

// ---------------------------------------------------------------------------
// Risk level and stability gate
// ---------------------------------------------------------------------------

describe("analyzeTerminalOutboxBacklogRisk — risk levels", () => {
  it("returns critical when two critical signals are present", () => {
    const s = snapshot({
      total: 600, acked: 50, unacked: 550, unackedRatio: 0.92,
      oldestUnackedAgeMs: 31 * 24 * 60 * 60 * 1000,
      oldestUnackedCreatedAt: "2026-04-01T00:00:00.000Z",
    });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    assert.strictEqual(result.risk, "critical");
    assert.strictEqual(result.stabilityGatePass, false);
  });

  it("returns high with one critical signal", () => {
    const s = snapshot({
      total: 600, acked: 50, unacked: 550, unackedRatio: 0.92,
    });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    assert.strictEqual(result.risk, "high");
    assert.strictEqual(result.stabilityGatePass, false);
  });

  it("returns medium with two warning signals", () => {
    const s = snapshot({
      total: 150, acked: 50, unacked: 100, unackedRatio: 0.67,
      oldestUnackedAgeMs: 8 * 24 * 60 * 60 * 1000,
      oldestUnackedCreatedAt: "2026-05-01T00:00:00.000Z",
      providerSendOnlyUnacked: 20,
    });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    assert.strictEqual(result.risk, "medium");
    assert.strictEqual(result.stabilityGatePass, false);
  });

  it("returns low with one warning signal", () => {
    const s = snapshot({ total: 200, acked: 50, unacked: 150, unackedRatio: 0.75 });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    assert.strictEqual(result.risk, "low");
    assert.strictEqual(result.stabilityGatePass, true);
  });

  it("returns none with no signals", () => {
    const s = snapshot({ total: 50, acked: 50, unacked: 0, unackedRatio: 0 });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    assert.strictEqual(result.risk, "none");
    assert.strictEqual(result.stabilityGatePass, true);
  });
});

// ---------------------------------------------------------------------------
// Recommendation
// ---------------------------------------------------------------------------

describe("analyzeTerminalOutboxBacklogRisk — recommendations", () => {
  it("provides operator recommendation on critical stale entry", () => {
    const s = snapshot({
      total: 600, acked: 50, unacked: 550, unackedRatio: 0.92,
      oldestUnackedAgeMs: 31 * 24 * 60 * 60 * 1000,
      oldestUnackedCreatedAt: "2026-04-01T00:00:00.000Z",
    });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    assert.ok(result.recommendation, "should provide recommendation");
  });

  it("provides recommendation for provider send-only stall", () => {
    const s = snapshot({ total: 50, acked: 20, unacked: 30, unackedRatio: 0.6, providerSendOnlyUnacked: 20 });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    assert.ok(result.recommendation);
  });

  it("returns undefined recommendation for healthy outbox", () => {
    const s = snapshot({ total: 50, acked: 50, unacked: 0, unackedRatio: 0 });
    const result = analyzeTerminalOutboxBacklogRisk(s);
    assert.strictEqual(result.recommendation, undefined);
  });
});

// ---------------------------------------------------------------------------
// Threshold defaults
// ---------------------------------------------------------------------------

describe("DEFAULT_TERMINAL_OUTBOX_BACKLOG_THRESHOLDS", () => {
  it("has consistent defaults", () => {
    const t = DEFAULT_TERMINAL_OUTBOX_BACKLOG_THRESHOLDS;
    assert.ok(t.maxUnackedRatioWarning > 0 && t.maxUnackedRatioWarning < 1, "ratio in (0,1)");
    assert.ok(t.maxUnackedCountWarning > 0);
    assert.ok(t.maxUnackedCountCritical > t.maxUnackedCountWarning);
    assert.ok(t.maxUnackedAgeMsCritical > t.maxUnackedAgeMsWarning);
  });
});
