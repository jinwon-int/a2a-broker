import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const script = new URL('./terminal-outbox-ack-closeout-finalizer.mjs', import.meta.url).pathname;

function run(args = []) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

describe('terminal-outbox ACK closeout finalizer', () => {
  it('runs the no-live SQLite ACK proof and returns sanitized JSON evidence', () => {
    const result = run(['--json']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);

    assert.equal(report.ok, true);
    assert.equal(report.status, 'done');
    assert.equal(report.run, 'a2a-r10-terminal-outbox-ack-persistence-20260513T1654Z');
    assert.equal(report.checks.createTerminalOutboxRow.status, 'pass');
    assert.equal(report.checks.rejectInvalidAck.status, 'pass');
    assert.equal(report.checks.acceptValidAck.status, 'pass');
    assert.equal(report.checks.sqliteAckPersistence.status, 'pass');
    assert.equal(report.checks.health.status, 'pass');
    assert.equal(report.checks.operatorReport.status, 'pass');
    assert.equal(report.checks.noLiveSends.status, 'pass');

    assert.equal(report.evidence.invalidAckHttpStatus, 400);
    assert.equal(report.evidence.validAckHttpStatus, 200);
    assert.equal(report.evidence.ackEvidence, 'operator_visible');
    assert.equal(report.evidence.sqliteAckPersisted, true);
    assert.equal(report.evidence.healthPersistenceKind, 'sqlite');
    assert.equal(report.evidence.healthTerminalOutboxRows, 1);
    assert.equal(report.evidence.healthTerminalOutboxUnackedRows, 0);
    assert.equal(report.evidence.operatorReportAckStatus, 'receipt_confirmed');
    assert.equal(report.evidence.operatorReportReceiptStatus, 'operator_visible');

    assert.equal(report.safety.noLiveProviderSend, true);
    assert.equal(report.safety.noDeployRestartReload, true);
    assert.equal(report.safety.noHistoricalReplay, true);
    assert.equal(report.safety.noManualTerminalAck, true);
    assert.equal(report.safety.noProductionDbMutationOrRepair, true);
    assert.equal(report.safety.noSecretOrVisibilityChange, true);
    assert.equal(report.safety.noReleaseOrForcePush, true);
    assert.equal(report.safety.localFixtureDbOnly, true);

    assert.doesNotMatch(result.stdout, /must-not-leak-terminal-ack-finalizer|rawPrompt|rawLog|\/work\/private/);
    assert.doesNotMatch(result.stdout, new RegExp(tmpdir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('renders a Done checklist in markdown with the required safety statement', () => {
    const result = run(['--markdown']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /^Done: #584 terminal-outbox ACK SQLite persistence closeout finalizer/);
    assert.match(result.stdout, /rejectInvalidAck: pass/);
    assert.match(result.stdout, /acceptValidAck: pass/);
    assert.match(result.stdout, /sqliteAckPersistence: pass/);
    assert.match(result.stdout, /\/health persistence: sqlite; outbox rows=1; unacked=0/);
    assert.match(result.stdout, /no deploy\/restart\/reload, live provider send, historical replay, manual terminal ACK, production DB mutation\/repair, secret\/visibility change, release, or force-push was performed/);
  });
});
