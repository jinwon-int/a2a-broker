import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runPreflight } from './terminal-outbox-preflight.mjs';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('terminal outbox preflight', () => {
  it('polls health and replay state without acknowledging outbox records', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      const parsed = new URL(String(url));
      calls.push({ path: parsed.pathname, query: parsed.searchParams.toString(), headers: init?.headers ?? {} });
      if (parsed.pathname === '/health') {
        return jsonResponse({ ok: true, persistence: { kind: 'sqlite' }, requestSecurity: { edgeSecretRequired: true } });
      }
      if (parsed.pathname === '/a2a/tasks/terminal-outbox') {
        const reconcile = parsed.searchParams.get('reconcile_unacked') === 'true';
        return jsonResponse({
          kind: 'task.terminal.outbox',
          count: 1,
          cursor: 'terminal-1',
          reconciledUnacked: reconcile ? 1 : undefined,
          events: [{
            id: 'terminal-1',
            kind: 'task.terminal',
            taskEventId: 7,
            createdAt: '2026-05-02T00:00:00.000Z',
            attempts: 0,
            payload: {
              taskId: 'task-1',
              status: 'succeeded',
              worker: 'bangtong',
              repo: 'jinwon-int/a2a-broker',
              issue: 276,
              taskBrief: 'broker receipt/evidence gate',
              prUrl: 'https://github.com/jinwon-int/a2a-broker/pull/1',
              createdAt: '2026-05-02T00:00:00.000Z',
              updatedAt: '2026-05-02T00:00:00.000Z',
            },
          }],
        });
      }
      throw new Error(`unexpected request ${parsed.pathname}`);
    };

    const report = await runPreflight({ baseUrl: 'http://broker.local', edgeSecret: 'redacted', fetchImpl });

    assert.equal(report.ok, true);
    assert.deepEqual(calls.map((call) => call.path), [
      '/health',
      '/a2a/tasks/terminal-outbox',
      '/a2a/tasks/terminal-outbox',
    ]);
    assert.equal(calls.some((call) => call.path.endsWith('/ack')), false);
    assert.equal(calls[2].query.includes('reconcile_unacked=true'), true);
    assert.equal(calls[1].headers['x-a2a-requester-role'], 'operator');
    assert.equal(report.checks[1].events[0].taskBrief, 'broker receipt/evidence gate');
    assert.equal(calls[1].headers['x-a2a-edge-secret'], 'redacted');
  });

  it('fails when terminal outbox evidence URLs are not HTTP(S)', async () => {
    const fetchImpl = async (url) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === '/health') return jsonResponse({ ok: true });
      return jsonResponse({
        kind: 'task.terminal.outbox',
        count: 1,
        cursor: 'terminal-1',
        events: [{ id: 'terminal-1', payload: { status: 'blocked', doneUrl: 'file:///tmp/private-log' } }],
      });
    };

    const report = await runPreflight({ baseUrl: 'http://broker.local', fetchImpl });

    assert.equal(report.ok, false);
    assert.match(report.checks.find((check) => check.check === 'terminal-outbox poll')?.detail ?? '', /non-HTTP evidence URLs/);
  });
});
