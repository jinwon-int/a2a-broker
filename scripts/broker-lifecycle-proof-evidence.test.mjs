import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = new URL('./broker-lifecycle-proof-evidence.mjs', import.meta.url).pathname;

async function withEvidence(evidence, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'broker-lifecycle-proof-'));
  try {
    const file = join(dir, 'evidence.json');
    await writeFile(file, JSON.stringify(evidence, null, 2));
    return fn(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function run(inputFile) {
  return spawnSync(process.execPath, [script, '--input', inputFile], { encoding: 'utf8' });
}

const completeEvidence = {
  rolloutMode: 'no-live',
  candidates: {
    broker: 'broker-sha',
  },
  ci: {
    command: 'npm test',
    result: 'exit 0',
  },
  noLiveCanaryProofMatrix: {
    brokerWorkerResultProjection: { status: 'pass', evidence: 'worker completed local no-op task and dashboard projection showed terminal result' },
    workerHeartbeatObserved: { status: 'pass', evidence: 'worker heartbeat updated lastSeenAt before claim' },
    staleTaskDetected: { status: 'pass', evidence: 'diagnostics marked claimed task stale after threshold' },
    manualRequeueObserved: { status: 'pass', evidence: 'manual /tasks/requeue_stale test fixture requeued one stale claim' },
    retryAttemptVisible: { status: 'pass', evidence: 'task attempt moved 1 -> 2 and requeueCount moved 0 -> 1' },
    receiptGapObservable: { status: 'pass', evidence: 'terminal outbox item replayed as unacknowledged; no receipt_confirmed ACK' },
    noLiveDeliveryOrAck: { status: 'pass', evidence: 'live sends 0; real terminal ACK false' },
  },
  lifecycle: {
    taskId: 'task-no-live-1',
    workerId: 'nosuk',
    resultProjectionObserved: true,
  },
  recovery: {
    staleTaskId: 'task-stale-1',
    workerId: 'nosuk',
    heartbeatAgeMs: 180000,
    staleAfterMs: 120000,
    requeueCountBefore: 0,
    requeueCountAfter: 1,
    attemptBefore: 1,
    attemptAfter: 2,
  },
  receiptGap: {
    outboxId: 'terminal-outbox-1',
    unacknowledgedReplayed: true,
    realAckPerformed: false,
    ackStatus: 'pending_receipt',
  },
  safety: {
    productionDeploy: false,
    gatewayRestart: false,
    liveTelegramSend: false,
    dbMutation: false,
    realTerminalOutboxAck: false,
  },
};

describe('broker-lifecycle-proof-evidence collector', () => {
  it('renders Done for complete no-live lifecycle/recovery evidence', async () => {
    await withEvidence(completeEvidence, (file) => {
      const result = run(file);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /^Done: #311 no-live lifecycle\/recovery proof gate/);
      assert.match(result.stdout, /Parent: #294/);
      assert.match(result.stdout, /broker -> worker -> result projection: pass/);
      assert.match(result.stdout, /requeue count: 0 -> 1/);
      assert.match(result.stdout, /real ACK performed: no/);
    });
  });

  it('blocks when stale heartbeat evidence is not actually stale', async () => {
    await withEvidence({
      ...completeEvidence,
      recovery: {
        ...completeEvidence.recovery,
        heartbeatAgeMs: 30000,
      },
    }, (file) => {
      const result = run(file);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stdout, /^Block: #311 no-live lifecycle\/recovery proof gate is incomplete/);
      assert.match(result.stdout, /heartbeatAgeMs must be greater than or equal to recovery\.staleAfterMs/);
    });
  });

  it('blocks if a no-live run reports a real terminal-outbox ACK', async () => {
    await withEvidence({
      ...completeEvidence,
      receiptGap: {
        ...completeEvidence.receiptGap,
        realAckPerformed: true,
      },
      safety: {
        ...completeEvidence.safety,
        realTerminalOutboxAck: true,
      },
    }, (file) => {
      const result = run(file);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stdout, /receiptGap\.realAckPerformed must be false\/no/);
      assert.match(result.stdout, /must not report real terminal-outbox ACK/);
    });
  });
});
