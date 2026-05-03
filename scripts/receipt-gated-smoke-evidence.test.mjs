import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = new URL('./receipt-gated-smoke-evidence.mjs', import.meta.url).pathname;

async function withEvidence(evidence, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'receipt-gated-evidence-'));
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

const completeDryRunEvidence = {
  rolloutMode: 'no-live',
  candidates: {
    broker: 'broker-sha',
    plugin: 'openclaw-plugin-a2a#164',
  },
  ci: {
    command: 'npm test',
    result: 'exit 0',
  },
  noLiveRolloutProofMatrix: {
    ciSafeBrokerRegression: { status: 'pass', evidence: 'npm test exit 0' },
    readOnlyTerminalOutboxPreflight: { status: 'pass', evidence: 'terminal_outbox_preflight --json exit 0; no ACK/send attempted' },
    receiptGateRejectsSendSuccessOnly: { status: 'pass', evidence: 'invalid ACK rejected with receipt evidence required' },
    reconcileReplayBeforeReceipt: { status: 'pass', evidence: 'reconcile_unacked replayed same outbox id before receipt' },
    duplicateSuppressionNoTelegram: { status: 'pass', evidence: 'dry-run planned one Telegram send for stable outbox id; live sends 0' },
    rollbackNoLiveCleanup: { status: 'pass', evidence: 'notifier live delivery unchanged; unacknowledged records remain replayable' },
  },
  dryRunAckGate: {
    outboxId: 'terminal-outbox-1',
    invalidAckRejected: true,
    invalidAckStatus: '400 receipt evidence required',
    reconcileUnackedReplayedBeforeReceipt: true,
    validReceiptEvidence: 'operator_visible',
    ackStatus: 'receipt_confirmed',
  },
  duplicateGuard: {
    dedupeKey: 'terminal-outbox-1',
    plannedTelegramSendsForSameId: 1,
    replayAfterReceiptClosedRetryCandidate: true,
  },
  liveSendGate: {
    sendsExecuted: 0,
  },
  rollbackCleanup: {
    notifierLiveDeliveryDisabledOrUnchanged: true,
    unacknowledgedRecordsRemainReplayable: 'yes',
  },
};

describe('receipt-gated-smoke-evidence collector', () => {
  it('renders a final Done comment when receipt-gated dry-run evidence is complete', async () => {
    await withEvidence(completeDryRunEvidence, (file) => {
      const result = run(file);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /^Done: #241\/#168 receipt-gated ACK canary smoke/);
      assert.match(result.stdout, /invalid ACK rejected: yes/);
      assert.match(result.stdout, /No-live rollout proof matrix:/);
      assert.match(result.stdout, /duplicate suppression with no Telegram send: pass/);
      assert.match(result.stdout, /approved: no/);
      assert.match(result.stdout, /sends executed: 0/);
    });
  });

  it('renders Block and exits non-zero instead of Done when ACK proof is missing', async () => {
    await withEvidence({
      ...completeDryRunEvidence,
      dryRunAckGate: {
        ...completeDryRunEvidence.dryRunAckGate,
        invalidAckRejected: false,
      },
    }, (file) => {
      const result = run(file);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stdout, /^Block: #241\/#168 receipt-gated ACK canary smoke evidence is incomplete/);
      assert.match(result.stdout, /invalidAckRejected must be yes\/true/);
    });
  });

  it('blocks no-live rollout evidence if any live send is reported', async () => {
    await withEvidence({
      ...completeDryRunEvidence,
      liveSendGate: {
        sendsExecuted: 1,
      },
    }, (file) => {
      const result = run(file);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stdout, /no-live rollout requires liveSendGate\.sendsExecuted to be 0/);
    });
  });
});
