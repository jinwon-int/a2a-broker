import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPreflightResult,
  evaluateSafetyGates,
  fetchBrokerHealth,
  fetchWorkerList,
  findDuplicateOnlineWorkerIds,
  findStaleOrInactiveCrossBrokerWorkerIds,
  onlineWorkers,
  parseArgs,
} from './two-broker-worker-preflight.mjs';

describe('two-broker worker cutover preflight', () => {
  it('flags worker ids that are online on both seoseo and gwakga', () => {
    const duplicates = findDuplicateOnlineWorkerIds(
      [
        { nodeId: 'shared-worker', status: 'online', role: 'analyst', lastSeenAt: '2026-05-07T02:00:00.000Z', metadata: { revision: 'seoseo-r1' } },
        { nodeId: 'seoseo-only', status: 'online', role: 'analyst' },
        { nodeId: 'stale-shared', status: 'stale', role: 'analyst' },
      ],
      [
        { nodeId: 'shared-worker', status: 'online', role: 'analyst', lastSeenAt: '2026-05-07T02:00:05.000Z', metadata: { revision: 'gwakga-r2' } },
        { nodeId: 'gwakga-only', status: 'online', role: 'analyst' },
        { nodeId: 'stale-shared', status: 'online', role: 'analyst' },
      ],
    );

    assert.deepEqual(duplicates.map((worker) => worker.workerId), ['shared-worker']);
    assert.equal(duplicates[0].seoseo.lastSeenAt, '2026-05-07T02:00:00.000Z');
    assert.equal(duplicates[0].gwakga.lastSeenAt, '2026-05-07T02:00:05.000Z');
    assert.equal(duplicates[0].seoseo.revision, 'seoseo-r1');
    assert.equal(duplicates[0].gwakga.revision, 'gwakga-r2');
  });

  it('distinguishes stale cross-broker workers from duplicate-online blockers', () => {
    const stale = findStaleOrInactiveCrossBrokerWorkerIds(
      [
        { nodeId: 'retargeted-worker', status: 'stale', metadata: { buildRevision: 'old-r1', brokerId: 'seoseo' } },
        { nodeId: 'both-online', status: 'online' },
      ],
      [
        { nodeId: 'retargeted-worker', status: 'online', metadata: { buildRevision: 'new-r2', brokerId: 'gwakga' } },
        { nodeId: 'both-online', status: 'online' },
      ],
    );

    assert.deepEqual(stale.map((worker) => worker.workerId), ['retargeted-worker']);
    assert.equal(stale[0].seoseo.status, 'stale');
    assert.equal(stale[0].gwakga.status, 'online');
    assert.match(stale[0].distinction, /non-blocking/);
  });

  it('ignores stale workers and malformed ids for online counts', () => {
    const workers = onlineWorkers([
      { nodeId: 'online-worker', status: 'online' },
      { nodeId: 'stale-worker', status: 'stale' },
      { status: 'online' },
      null,
    ]);

    assert.deepEqual(workers.map((entry) => entry.workerId), ['online-worker']);
  });

  it('reads broker urls and safety evidence path from args before environment', () => {
    assert.deepEqual(
      parseArgs(['--seoseo-url', 'http://seoseo.example', '--gwakga-url=http://gwakga.example', '--safety-evidence', 'safe.json'], {
        SEOSEO_BROKER_URL: 'http://env-seoseo.example',
        GWAKGA_BROKER_URL: 'http://env-gwakga.example',
      }),
      { seoseoUrl: 'http://seoseo.example', gwakgaUrl: 'http://gwakga.example', safetyEvidence: 'safe.json', json: false },
    );
  });

  it('fetches /workers and /health without sending a mutating request', async () => {
    const seen = [];
    const fetchImpl = async (url, options) => {
      seen.push({ url: String(url), options });
      if (String(url).endsWith('/workers')) {
        return new Response(JSON.stringify({ items: [{ nodeId: 'w1', status: 'online' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true, brokerId: 'seoseo', build: { revision: 'rev-1' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const workers = await fetchWorkerList('http://broker.example/base/', fetchImpl);
    const health = await fetchBrokerHealth('http://broker.example/base/', fetchImpl);

    assert.deepEqual(workers, [{ nodeId: 'w1', status: 'online' }]);
    assert.equal(health.build.revision, 'rev-1');
    assert.deepEqual(seen.map((entry) => entry.url), [
      'http://broker.example/base/workers',
      'http://broker.example/base/health',
    ]);
    assert.deepEqual(seen.map((entry) => entry.options.method), ['GET', 'GET']);
  });

  it('reports broker and worker revisions plus rollback notes in the aggregate result', () => {
    const result = buildPreflightResult({
      seoseoHealth: { brokerId: 'seoseo', version: '0.1.0', build: { revision: 'broker-old' } },
      gwakgaHealth: { brokerId: 'gwakga', version: '0.1.0', build: { revision: 'broker-new' } },
      seoseoWorkers: [{ nodeId: 'w1', status: 'stale', metadata: { revision: 'worker-old', brokerId: 'seoseo' } }],
      gwakgaWorkers: [{ nodeId: 'w1', status: 'online', metadata: { revision: 'worker-new', brokerId: 'gwakga' } }],
    });

    assert.equal(result.ok, true);
    assert.equal(result.brokerRevisions.seoseo.revision, 'broker-old');
    assert.equal(result.brokerRevisions.gwakga.revision, 'broker-new');
    assert.equal(result.workerRevisionSummary.seoseo[0].revision, 'worker-old');
    assert.equal(result.workerRevisionSummary.gwakga[0].revision, 'worker-new');
    assert.match(result.rollbackNotes.join('\n'), /does not execute rollback/);
    assert.match(result.rollbackNotes.join('\n'), /Provider accepted\/message-id evidence is non-ACK/);
  });

  it('fails closed when sanitized evidence reports deploy/restart/canary/DB/ACK/release risk', () => {
    const safety = evaluateSafetyGates({
      productionDeploy: true,
      gatewayRestart: true,
      liveProviderCanary: true,
      dbMutation: true,
      terminalAckOrReplay: true,
      release: true,
      providerAcceptedMessageIdAsAck: true,
    });

    assert.equal(safety.ok, false);
    assert.equal(safety.blockers.length, 7);
    assert.match(safety.blockers.join('\n'), /production deploy/);
    assert.match(safety.blockers.join('\n'), /terminal ACK\/replay/);
    assert.match(safety.blockers.join('\n'), /provider accepted\/message-id counted as terminal ACK/);
  });
});
