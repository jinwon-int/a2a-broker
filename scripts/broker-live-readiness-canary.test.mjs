import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateEvidenceAcceptance,
  runLiveReadinessCanary,
  runNoLiveCanary,
} from './broker-live-readiness-canary.mjs';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('broker live-readiness canary', () => {
  it('renders a no-live readiness proof without broker calls or unsafe actions', () => {
    const report = runNoLiveCanary();

    assert.equal(report.ok, true);
    assert.equal(report.mode, 'no-live');
    assert.equal(report.parent, '#294');
    assert.equal(report.brokerHttpRequested, false);
    assert.equal(report.providerCalled, false);
    assert.equal(report.dbMutationAttempted, false);
    assert.equal(report.terminalAckAttempted, false);
    assert.equal(report.oneShotLiveEligible, false);
    assert.equal(report.blockedCount, 3);
    assert.ok(report.checks.find((check) => check.check === 'health revision'));
    assert.ok(report.checks.find((check) => check.check === 'online worker matrix'));
    assert.ok(report.checks.find((check) => check.check === 'queue emptiness and stale tasks'));
    assert.match(JSON.stringify(report), /github-verify Done evidence regression/);
    assert.doesNotMatch(JSON.stringify(report), /token|secret|chat_id|\/work\/repo/);
  });

  it('accepts canonical PR Done and Block evidence, including #330 github-verify Done shape', () => {
    const check = evaluateEvidenceAcceptance({
      kind: 'task.terminal.outbox',
      events: [
        { id: 'pr', payload: { prUrl: 'https://github.com/jinwon-int/a2a-broker/pull/334', receipt: { status: 'operator_visible', evidence: 'operator_visible' } } },
        { id: 'done', payload: { github: { doneCommentUrl: 'https://github.com/jinwon-int/a2a-broker/issues/330#issuecomment-github-verify-done' }, receiptStatus: 'accepted' } },
        { id: 'block', payload: { blockUrl: 'https://github.com/jinwon-int/a2a-broker/issues/334#issuecomment-block', receipt: { status: 'failed' } } },
      ],
    }, 200);

    assert.equal(check.ok, true);
    assert.equal(check.eventCount, 3);
  });

  it('blocks non-HTTP evidence and provider-send-only receipt evidence', () => {
    const check = evaluateEvidenceAcceptance({
      events: [
        { id: 'unsafe', payload: { doneUrl: 'file:///tmp/private.log', receipt: { status: 'sent', evidence: 'provider_sent' } } },
      ],
    }, 200);

    assert.equal(check.ok, false);
    assert.match(check.detail, /missing canonical HTTP PR\/Done\/Block evidence/);
    assert.match(check.detail, /invalid receipt evidence: provider_sent/);
  });

  it('blocks one-shot live eligibility until manual receipt-confirmed ACK exists', async () => {
    const fetchImpl = async (url) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === '/health') {
        return jsonResponse({ ok: true, service: 'a2a-broker', version: '0.1.0', build: 'test-build' });
      }
      if (parsed.pathname === '/workers') {
        return jsonResponse({ items: [{ nodeId: 'sogyo', status: 'online' }] });
      }
      if (parsed.pathname === '/tasks/diagnostics') {
        return jsonResponse({ tasks: { byStatus: { queued: 0, claimed: 0, running: 0 }, stale: 0 } });
      }
      if (parsed.pathname === '/a2a/tasks/terminal-outbox') {
        return jsonResponse({
          kind: 'task.terminal.outbox',
          events: [
            {
              id: 'provider-send-only',
              payload: { worker: 'sogyo', doneUrl: 'https://github.com/jinwon-int/a2a-broker/issues/390#issuecomment-provider', receiptStatus: 'provider_sent' },
            },
            {
              id: 'provider-delivery-only',
              ack: { status: 'receipt_confirmed', evidence: 'provider_delivery_receipt', acknowledgedAt: '2026-05-05T00:00:00.000Z' },
              receipt: { status: 'provider_sent', evidence: 'provider_delivery_receipt', updatedAt: '2026-05-05T00:00:00.000Z' },
              payload: { worker: 'sogyo', doneUrl: 'https://github.com/jinwon-int/a2a-broker/issues/390#issuecomment-delivery' },
            },
          ],
        });
      }
      throw new Error(`unexpected path ${parsed.pathname}`);
    };

    const report = await runLiveReadinessCanary({ baseUrl: 'http://broker.local', fetchImpl });

    assert.equal(report.ok, true);
    assert.equal(report.oneShotLiveEligible, false);
    assert.equal(report.blockedCount, 2);
    const gate = report.checks.find((check) => check.check === 'one-shot live eligibility manual receipt gate');
    assert.equal(gate?.oneShotLiveEligible, false);
    assert.equal(gate?.blockedEvents[1].ackEvidence, 'provider_delivery_receipt');
  });

  it('allows one-shot live eligibility only for manual operator receipt-confirmed ACK', async () => {
    const fetchImpl = async (url) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === '/health') {
        return jsonResponse({ ok: true, service: 'a2a-broker', version: '0.1.0', build: 'test-build' });
      }
      if (parsed.pathname === '/workers') {
        return jsonResponse({ items: [{ nodeId: 'sogyo', status: 'online' }] });
      }
      if (parsed.pathname === '/tasks/diagnostics') {
        return jsonResponse({ tasks: { byStatus: { queued: 0, claimed: 0, running: 0 }, stale: 0 } });
      }
      if (parsed.pathname === '/a2a/tasks/terminal-outbox') {
        return jsonResponse({
          kind: 'task.terminal.outbox',
          events: [{
            id: 'manual-receipt',
            ack: { status: 'receipt_confirmed', evidence: 'operator_confirmed', acknowledgedAt: '2026-05-05T00:00:00.000Z' },
            receipt: { status: 'operator_visible', evidence: 'operator_confirmed', updatedAt: '2026-05-05T00:00:00.000Z' },
            payload: { worker: 'sogyo', doneUrl: 'https://github.com/jinwon-int/a2a-broker/issues/390#issuecomment-manual' },
          }],
        });
      }
      throw new Error(`unexpected path ${parsed.pathname}`);
    };

    const report = await runLiveReadinessCanary({ baseUrl: 'http://broker.local', fetchImpl });

    assert.equal(report.ok, true);
    assert.equal(report.oneShotLiveEligible, true);
    assert.equal(report.blockedCount, 0);
  });

  it('uses only read-only GET endpoints in live mode', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      const parsed = new URL(String(url));
      calls.push({ path: parsed.pathname, method: init?.method, query: parsed.searchParams.toString() });
      if (parsed.pathname === '/health') {
        return jsonResponse({ ok: true, service: 'a2a-broker', version: '0.1.0', build: 'test-build' });
      }
      if (parsed.pathname === '/workers') {
        return jsonResponse({ items: [{ nodeId: 'sogyo', status: 'online' }] });
      }
      if (parsed.pathname === '/tasks/diagnostics') {
        return jsonResponse({ tasks: { byStatus: { queued: 0, claimed: 0, running: 0 }, stale: 0 } });
      }
      if (parsed.pathname === '/a2a/tasks/terminal-outbox') {
        return jsonResponse({
          kind: 'task.terminal.outbox',
          events: [{ id: 'terminal-1', payload: { worker: 'sogyo', prUrl: 'https://github.com/jinwon-int/a2a-broker/pull/334', receiptStatus: 'accepted' } }],
        });
      }
      throw new Error(`unexpected path ${parsed.pathname}`);
    };

    const report = await runLiveReadinessCanary({ baseUrl: 'http://broker.local', fetchImpl, limit: 7 });

    assert.equal(report.ok, true);
    assert.equal(report.brokerHttpRequested, true);
    assert.equal(report.dbMutationAttempted, false);
    assert.equal(report.terminalAckAttempted, false);
    assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), [
      'GET /health',
      'GET /workers',
      'GET /tasks/diagnostics',
      'GET /a2a/tasks/terminal-outbox',
    ]);
    assert.equal(calls[3].query, 'limit=7');
    assert.equal(calls.some((call) => call.path.endsWith('/ack') || call.method !== 'GET'), false);
  });

  it('blocks readiness when diagnostics report non-zero queue or stale tasks', async () => {
    const fetchImpl = async (url) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === '/health') {
        return jsonResponse({ ok: true, service: 'a2a-broker', version: '0.1.0', build: 'test-build' });
      }
      if (parsed.pathname === '/workers') {
        return jsonResponse({ items: [{ nodeId: 'sogyo', status: 'online' }] });
      }
      if (parsed.pathname === '/tasks/diagnostics') {
        return jsonResponse({ tasks: { byStatus: { queued: 1, claimed: 0, running: 0 }, stale: 1 } });
      }
      if (parsed.pathname === '/a2a/tasks/terminal-outbox') {
        return jsonResponse({
          kind: 'task.terminal.outbox',
          events: [{ id: 'terminal-1', payload: { worker: 'sogyo', prUrl: 'https://github.com/jinwon-int/a2a-broker/pull/334', receiptStatus: 'accepted' } }],
        });
      }
      throw new Error(`unexpected path ${parsed.pathname}`);
    };

    const report = await runLiveReadinessCanary({ baseUrl: 'http://broker.local', fetchImpl });
    const queueCheck = report.checks.find((check) => check.check === 'queue emptiness and stale tasks');

    assert.equal(report.ok, false);
    assert.equal(queueCheck?.ok, false);
    assert.match(queueCheck?.detail ?? '', /queued=1/);
    assert.match(queueCheck?.detail ?? '', /stale=1/);
  });
});
