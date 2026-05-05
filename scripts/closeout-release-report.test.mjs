import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXPECTED_WORKERS,
  REQUIRED_RECEIPT_SCENARIOS,
  buildCloseoutReport,
  renderCloseoutMarkdown,
} from './closeout-release-report.mjs';

function completeEvidence(overrides = {}) {
  const evidence = {
    mode: 'read-only/no-live',
    edgeSecret: { present: true },
    safety: {
      productionDeploy: false,
      gatewayRestart: false,
      liveTelegramSend: false,
      dbMutation: false,
      realTerminalOutboxAck: false,
      providerCalled: false,
    },
    health: { ok: true, build: 'test-revision' },
    workers: { onlineIds: [...EXPECTED_WORKERS] },
    queue: { queued: 0, claimed: 0, running: 0, stale: 0 },
    migrationHealthGate: {
      ok: true,
      checks: [
        { ok: true, check: 'schema/state version', detail: 'schema=9 state=8' },
        { ok: true, check: 'queue closeout reconciliation', detail: '0 violations' },
        { ok: true, check: 'terminal-outbox ACK invariant', detail: 'receipt-safe' },
      ],
    },
    liveReadiness: {
      ok: true,
      providerCalled: false,
      dbMutationAttempted: false,
      terminalAckAttempted: false,
      checks: [
        { ok: true, check: 'health revision', detail: 'healthy revision=test-revision' },
        { ok: true, check: 'online worker matrix', detail: '5/5 worker(s) online', onlineIds: [...EXPECTED_WORKERS] },
        { ok: true, check: 'queue emptiness and stale tasks', detail: 'queued=0, claimed=0, running=0, stale=0' },
      ],
    },
    terminalEvidence: {
      events: [
        { id: 'done', payload: { doneUrl: 'https://github.com/jinwon-int/a2a-broker/issues/342#issuecomment-done', receipt: { evidence: 'operator_visible' } } },
      ],
    },
    receiptGateMatrix: {
      overallVerdict: 'pass',
      cells: REQUIRED_RECEIPT_SCENARIOS.map((scenarioId) => ({
        scenarioId,
        verdict: 'pass',
        providerCalled: false,
        productionAckAttempted: false,
      })),
    },
    terminalOutbox: {
      lastNotificationAttempt: null,
    },
    finalConfigRestoration: {
      ok: true,
      operatorEventsEnabled: false,
      notificationEnabled: false,
      providerCalled: false,
      terminalAckAttempted: false,
    },
  };
  return deepMerge(evidence, overrides);
}

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch ?? base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? deepMerge(base?.[key] ?? {}, value)
      : value;
  }
  return out;
}

function check(report, name) {
  return report.checks.find((item) => item.check === name);
}

describe('consolidated closeout release report', () => {
  it('passes a complete read-only closeout evidence bundle and references #294', () => {
    const report = buildCloseoutReport(completeEvidence());

    assert.equal(report.ok, true);
    assert.equal(report.parent, '#294');
    assert.deepEqual(report.expectedWorkers, ['bangtong', 'dungae', 'sogyo', 'nosuk', 'yukson']);
    assert.equal(check(report, 'worker capacity matrix')?.ok, true);
    assert.equal(check(report, 'queue/stale closeout')?.ok, true);
    assert.equal(check(report, 'final config restoration/no-live verification')?.ok, true);
    assert.deepEqual(report.terminalOutboxLastNotificationAttemptShapes, { null: 1 });

    const markdown = renderCloseoutMarkdown(report);
    assert.match(markdown, /^Done: #342 consolidated read-only closeout report/);
    assert.doesNotMatch(markdown, /token|chat_id|\/work\/repo|BROKER_EDGE_SECRET=/i);
  });

  it('fails closed when edge secret presence proof is missing', () => {
    const report = buildCloseoutReport(completeEvidence({ edgeSecret: { present: false } }));

    assert.equal(report.ok, false);
    assert.equal(check(report, 'edge secret presence')?.ok, false);
    assert.match(check(report, 'edge secret presence')?.detail ?? '', /missing edge secret/);
  });

  it('fails closed when queue or stale task counts are non-zero', () => {
    const report = buildCloseoutReport(completeEvidence({ queue: { queued: 1, stale: 2 } }));

    assert.equal(report.ok, false);
    assert.equal(check(report, 'queue/stale closeout')?.ok, false);
    assert.match(check(report, 'queue/stale closeout')?.detail ?? '', /queued=1/);
    assert.match(check(report, 'queue/stale closeout')?.detail ?? '', /stale=2/);
  });

  it('fails closed on receipt evidence gaps', () => {
    const report = buildCloseoutReport(completeEvidence({
      terminalEvidence: {
        events: [
          { id: 'gap', payload: { doneUrl: 'file:///tmp/private.log', receipt: { evidence: 'provider_sent' } } },
        ],
      },
      receiptGateMatrix: {
        overallVerdict: 'pass',
        cells: REQUIRED_RECEIPT_SCENARIOS
          .filter((scenarioId) => scenarioId !== 'send_accepted_no_receipt')
          .map((scenarioId) => ({ scenarioId, verdict: 'pass', providerCalled: false, productionAckAttempted: false })),
      },
    }));

    assert.equal(report.ok, false);
    assert.equal(check(report, 'terminal evidence closeout')?.ok, false);
    assert.match(check(report, 'terminal evidence closeout')?.detail ?? '', /missing canonical HTTPS/);
    assert.match(check(report, 'terminal evidence closeout')?.detail ?? '', /invalid receipt evidence provider_sent/);
    assert.equal(check(report, 'receipt no-live matrix')?.ok, false);
    assert.match(check(report, 'receipt no-live matrix')?.detail ?? '', /missing scenario/);
  });

  it('summarizes terminalOutbox.lastNotificationAttempt shapes without leaking raw values or crashing', () => {
    const report = buildCloseoutReport(completeEvidence({
      terminalOutbox: {
        lastNotificationAttempt: [
          { provider: 'telegram', chat_id: 'redacted-by-shape-only' },
          'BROKER_EDGE_SECRET=do-not-render',
          null,
          ['nested'],
        ],
      },
    }));

    assert.equal(report.ok, true);
    assert.deepEqual(report.terminalOutboxLastNotificationAttemptShapes, {
      array: 1,
      null: 1,
      object: 1,
      string: 1,
    });
    const markdown = renderCloseoutMarkdown(report);
    assert.match(markdown, /terminalOutbox.lastNotificationAttempt shapes: array=1, null=1, object=1, string=1/);
    assert.doesNotMatch(markdown, /chat_id|BROKER_EDGE_SECRET|do-not-render/i);
  });

  it('fails closed without final config restoration no-live proof', () => {
    const evidence = completeEvidence();
    delete evidence.finalConfigRestoration;
    const report = buildCloseoutReport(evidence);

    assert.equal(report.ok, false);
    assert.equal(check(report, 'final config restoration/no-live verification')?.ok, false);
    assert.match(check(report, 'final config restoration/no-live verification')?.detail ?? '', /missing final config restoration/);
  });

  it('redacts unsafe terminal evidence identifiers in deterministic blocker comments', () => {
    const report = buildCloseoutReport(completeEvidence({
      terminalEvidence: {
        events: [
          { id: '/work/repo/private-token', payload: { receipt: { evidence: 'provider_sent' } } },
        ],
      },
    }));

    const detail = check(report, 'terminal evidence closeout')?.detail ?? '';
    assert.equal(report.ok, false);
    assert.match(detail, /<string>: missing canonical HTTPS/);
    assert.match(detail, /invalid receipt evidence provider_sent/);
    assert.doesNotMatch(detail, /\/work\/repo|private-token/);
  });
});
