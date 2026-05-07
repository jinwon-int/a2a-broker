import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchWorkerList,
  findDuplicateOnlineWorkerIds,
  onlineWorkers,
  parseArgs,
} from './two-broker-worker-preflight.mjs';

describe('two-broker worker cutover preflight', () => {
  it('flags worker ids that are online on both seoseo and gwakga', () => {
    const duplicates = findDuplicateOnlineWorkerIds(
      [
        { nodeId: 'shared-worker', status: 'online', role: 'analyst', lastSeenAt: '2026-05-07T02:00:00.000Z' },
        { nodeId: 'seoseo-only', status: 'online', role: 'analyst' },
        { nodeId: 'stale-shared', status: 'stale', role: 'analyst' },
      ],
      [
        { nodeId: 'shared-worker', status: 'online', role: 'analyst', lastSeenAt: '2026-05-07T02:00:05.000Z' },
        { nodeId: 'gwakga-only', status: 'online', role: 'analyst' },
        { nodeId: 'stale-shared', status: 'online', role: 'analyst' },
      ],
    );

    assert.deepEqual(duplicates.map((worker) => worker.workerId), ['shared-worker']);
    assert.equal(duplicates[0].seoseo.lastSeenAt, '2026-05-07T02:00:00.000Z');
    assert.equal(duplicates[0].gwakga.lastSeenAt, '2026-05-07T02:00:05.000Z');
  });

  it('ignores stale workers and malformed ids', () => {
    const workers = onlineWorkers([
      { nodeId: 'online-worker', status: 'online' },
      { nodeId: 'stale-worker', status: 'stale' },
      { status: 'online' },
      null,
    ]);

    assert.deepEqual(workers.map((entry) => entry.workerId), ['online-worker']);
  });

  it('reads broker urls from args before environment', () => {
    assert.deepEqual(
      parseArgs(['--seoseo-url', 'http://seoseo.example', '--gwakga-url=http://gwakga.example'], {
        SEOSEO_BROKER_URL: 'http://env-seoseo.example',
        GWAKGA_BROKER_URL: 'http://env-gwakga.example',
      }),
      { seoseoUrl: 'http://seoseo.example', gwakgaUrl: 'http://gwakga.example', json: false },
    );
  });

  it('fetches /workers without sending a mutating request', async () => {
    const seen = [];
    const workers = await fetchWorkerList('http://broker.example/base/', async (url, options) => {
      seen.push({ url: String(url), options });
      return new Response(JSON.stringify({ items: [{ nodeId: 'w1', status: 'online' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    assert.deepEqual(workers, [{ nodeId: 'w1', status: 'online' }]);
    assert.equal(seen[0].url, 'http://broker.example/base/workers');
    assert.equal(seen[0].options.method, 'GET');
  });
});
