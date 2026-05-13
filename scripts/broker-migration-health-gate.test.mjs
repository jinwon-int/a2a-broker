import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { runMigrationHealthGate } from './broker-migration-health-gate.mjs';

function createDb() {
  const dir = mkdtempSync(join(tmpdir(), 'a2a-migration-gate-'));
  const file = join(dir, 'state.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE broker_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO broker_metadata (key, value) VALUES ('schema_version', '9'), ('state_version', '8');
    CREATE TABLE broker_exchanges (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE broker_exchange_messages (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE broker_proposals (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE broker_artifacts (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE broker_validations (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE broker_tasks (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE broker_tombstones (task_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE broker_audit_events (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE broker_workers (
      node_id TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE broker_terminal_outbox (
      id TEXT PRIMARY KEY,
      task_event_id INTEGER NOT NULL,
      acknowledged_at TEXT,
      created_at TEXT NOT NULL,
      payload TEXT NOT NULL
    );
  `);
  return { db, file };
}

function workerPayload(overrides = {}) {
  return JSON.stringify({
    nodeId: 'worker-a',
    role: 'analyst',
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: true,
      canPromoteLive: false,
      workspaceIds: ['ws-a'],
      environments: ['test'],
    },
    createdAt: '2026-05-03T00:00:00.000Z',
    updatedAt: '2026-05-03T00:00:00.000Z',
    lastSeenAt: '2026-05-03T00:00:00.000Z',
    ...overrides,
  });
}

function terminalPayload(overrides = {}) {
  return JSON.stringify({
    id: 'terminal-1',
    kind: 'task.terminal',
    taskEventId: 1,
    payload: {
      taskId: 'task-1',
      status: 'succeeded',
      createdAt: '2026-05-03T00:00:00.000Z',
      updatedAt: '2026-05-03T00:00:00.000Z',
    },
    createdAt: '2026-05-03T00:00:00.000Z',
    attempts: 0,
    ...overrides,
  });
}

function taskPayload(overrides = {}) {
  return JSON.stringify({
    id: 'task-1',
    intent: 'propose_patch',
    status: 'queued',
    createdAt: '2026-05-03T00:00:00.000Z',
    updatedAt: '2026-05-03T00:00:00.000Z',
    targetNodeId: 'worker-a',
    requester: { id: 'requester' },
    target: { id: 'worker-a' },
    payload: {},
    ...overrides,
  });
}

function tombstonePayload(overrides = {}) {
  return JSON.stringify({
    taskId: 'task-1',
    terminalStatus: 'failed',
    tombstoneReason: 'failed',
    durationMs: 60_000,
    requeueCount: 0,
    tombstonedAt: '2026-05-03T00:01:00.000Z',
    ...overrides,
  });
}

describe('broker migration health gate', () => {
  it('passes for current schema, normalized worker rows, and receipt-confirmed outbox ACKs', () => {
    const { db, file } = createDb();
    db.prepare('INSERT INTO broker_workers (node_id, role, last_seen_at, updated_at, payload) VALUES (?, ?, ?, ?, ?)')
      .run('worker-a', 'analyst', '2026-05-03T00:00:00.000Z', '2026-05-03T00:00:00.000Z', workerPayload());
    db.prepare('INSERT INTO broker_terminal_outbox (id, task_event_id, acknowledged_at, created_at, payload) VALUES (?, ?, ?, ?, ?)')
      .run('terminal-1', 1, '2026-05-03T00:01:00.000Z', '2026-05-03T00:00:00.000Z', terminalPayload({
        ack: {
          status: 'receipt_confirmed',
          evidence: 'provider_delivery_receipt',
          acknowledgedAt: '2026-05-03T00:01:00.000Z',
          receiptId: 'delivery-1',
        },
      }));
    db.close();

    const report = runMigrationHealthGate({ dbFile: file, nowMs: Date.parse('2026-05-03T00:05:00.000Z') });

    assert.equal(report.ok, true);
    assert.equal(report.checks.length, 8);
    assert.match(report.checks.find((check) => check.check === 'worker hot-table quarantine')?.detail ?? '', /normalized capabilities/);
  });

  it('fails queue closeout reconciliation for terminal task rows without matching tombstones', () => {
    const { db, file } = createDb();
    db.prepare('INSERT INTO broker_tasks (id, payload) VALUES (?, ?)')
      .run('task-failed-missing-tombstone', taskPayload({
        id: 'task-failed-missing-tombstone',
        status: 'failed',
        completedAt: '2026-05-03T00:01:00.000Z',
        error: { code: 'worker_failed', message: 'failed' },
      }));
    db.prepare('INSERT INTO broker_tasks (id, payload) VALUES (?, ?)')
      .run('task-canceled-mismatch', taskPayload({
        id: 'task-canceled-mismatch',
        status: 'canceled',
        completedAt: '2026-05-03T00:01:00.000Z',
        requeueCount: 2,
      }));
    db.prepare('INSERT INTO broker_tombstones (task_id, payload) VALUES (?, ?)')
      .run('task-canceled-mismatch', tombstonePayload({
        taskId: 'task-canceled-mismatch',
        terminalStatus: 'failed',
        requeueCount: 1,
      }));
    db.close();

    const report = runMigrationHealthGate({ dbFile: file, nowMs: Date.parse('2026-05-03T00:05:00.000Z') });
    const queueCheck = report.checks.find((check) => check.check === 'queue closeout reconciliation');

    assert.equal(report.ok, false);
    assert.equal(queueCheck?.ok, false);
    assert.deepEqual(queueCheck?.violations.map((violation) => violation.reason).sort(), [
      'terminal_task_missing_tombstone',
      'tombstone_requeue_count_mismatch',
      'tombstone_status_mismatch',
    ]);
  });

  it('fails closed with sanitized diagnostics for invalid worker hot rows', () => {
    const { db, file } = createDb();
    db.prepare('INSERT INTO broker_workers (node_id, role, last_seen_at, updated_at, payload) VALUES (?, ?, ?, ?, ?)')
      .run('/var/lib/secret-worker', 'analyst', '2026-05-03T00:00:00.000Z', '2026-05-03T00:00:00.000Z', workerPayload({ capabilities: { canAnalyze: 'yes' } }));
    db.close();

    const report = runMigrationHealthGate({ dbFile: file, nowMs: Date.parse('2026-05-03T00:05:00.000Z') });
    const workerCheck = report.checks.find((check) => check.check === 'worker hot-table quarantine');

    assert.equal(report.ok, false);
    assert.equal(workerCheck?.ok, false);
    assert.equal(workerCheck?.invalidRows[0].primaryKey, '[path]');
    assert.match(workerCheck?.invalidRows[0].schemaError ?? '', /capabilities/);
  });



  it('classifies current post-cutoff terminal receipt gaps into operator-safe buckets without ACKing provider acceptance', () => {
    const { db, file } = createDb();
    const base = '2026-05-03T00:00:00.000Z';
    const rows = [
      ['terminal-no-config', { id: 'terminal-no-config', attempts: 0, receipt: { status: 'accepted', updatedAt: base } }],
      ['terminal-provider-sent', { id: 'terminal-provider-sent', taskEventId: 2, attempts: 1, receipt: { status: 'provider_sent', updatedAt: base, note: 'provider accepted' } }],
      ['terminal-send-failed', { id: 'terminal-send-failed', taskEventId: 3, attempts: 1, receipt: { status: 'failed', updatedAt: base, note: 'provider failed' } }],
      ['terminal-stale', { id: 'terminal-stale', taskEventId: 4, attempts: 1, receipt: { status: 'timed_out', updatedAt: base } }],
      ['terminal-duplicate', { id: 'terminal-duplicate', taskEventId: 5, attempts: 1, receipt: { status: 'accepted', updatedAt: base }, duplicateOf: 'terminal-provider-sent' }],
      ['terminal-receipt-confirmed', {
        id: 'terminal-receipt-confirmed',
        taskEventId: 6,
        ack: {
          status: 'receipt_confirmed',
          evidence: 'operator_visible',
          acknowledgedAt: '2026-05-03T00:01:00.000Z',
        },
        receipt: { status: 'operator_visible', updatedAt: '2026-05-03T00:01:00.000Z', evidence: 'operator_visible' },
      }],
    ];
    for (const [id, overrides] of rows) {
      db.prepare('INSERT INTO broker_terminal_outbox (id, task_event_id, acknowledged_at, created_at, payload) VALUES (?, ?, ?, ?, ?)')
        .run(id, overrides.taskEventId ?? 1, overrides.ack ? overrides.ack.acknowledgedAt : null, base, terminalPayload(overrides));
    }
    db.close();

    const report = runMigrationHealthGate({
      dbFile: file,
      nowMs: Date.parse('2026-05-03T00:30:00.000Z'),
      maxUnackedAgeMs: 5 * 60 * 1000,
      legacyResidueCutoffMs: Date.parse('2026-05-02T23:59:00.000Z'),
      legacyResidueCutoff: '2026-05-02T23:59:00.000Z',
    });
    const outboxCheck = report.checks.find((check) => check.check === 'terminal-outbox ACK invariant');

    assert.equal(report.ok, false);
    assert.equal(outboxCheck?.violations.length, 5);
    assert.deepEqual(outboxCheck?.currentGapBuckets, {
      no_notification_config: 1,
      send_accepted_no_receipt: 1,
      send_failed: 1,
      stale_timed_out: 1,
      duplicate_suppressed: 1,
    });
    const byId = new Map(outboxCheck?.receiptGapClassifications.map((item) => [item.id, item]));
    assert.equal(byId.get('terminal-receipt-confirmed')?.bucket, 'receipt_confirmed');
    assert.equal(byId.get('terminal-receipt-confirmed')?.releaseBlocking, false);
    assert.equal(byId.get('terminal-provider-sent')?.bucket, 'send_accepted_no_receipt');
    assert.match(byId.get('terminal-provider-sent')?.action ?? '', /Provider send acceptance is not an ACK/);
    assert.equal(byId.get('terminal-duplicate')?.bucket, 'duplicate_suppressed');
    assert.equal(byId.get('terminal-duplicate')?.releaseBlocking, true);
  });

  it('fails stale unacknowledged or provider-send-only terminal outbox rows', () => {
    const { db, file } = createDb();
    db.prepare('INSERT INTO broker_terminal_outbox (id, task_event_id, acknowledged_at, created_at, payload) VALUES (?, ?, ?, ?, ?)')
      .run('terminal-stale', 1, null, '2026-05-03T00:00:00.000Z', terminalPayload({ id: 'terminal-stale' }));
    db.prepare('INSERT INTO broker_terminal_outbox (id, task_event_id, acknowledged_at, created_at, payload) VALUES (?, ?, ?, ?, ?)')
      .run('terminal-provider-send', 2, '2026-05-03T00:01:00.000Z', '2026-05-03T00:00:00.000Z', terminalPayload({
        id: 'terminal-provider-send',
        taskEventId: 2,
        ack: {
          status: 'receipt_confirmed',
          evidence: 'provider_send_success',
          acknowledgedAt: '2026-05-03T00:01:00.000Z',
        },
      }));
    db.close();

    const report = runMigrationHealthGate({
      dbFile: file,
      nowMs: Date.parse('2026-05-03T00:30:00.000Z'),
      maxUnackedAgeMs: 5 * 60 * 1000,
    });
    const outboxCheck = report.checks.find((check) => check.check === 'terminal-outbox ACK invariant');

    assert.equal(report.ok, false);
    assert.equal(outboxCheck?.ok, false);
    assert.deepEqual(outboxCheck?.violations.map((violation) => violation.reason).sort(), [
      'invalid_terminal_outbox_payload',
      'stale_unacked_receipt_evidence',
    ]);
  });
});

describe('broker migration health gate legacy residue cutoff', () => {
  it('quarantines pre-cutoff failed proof terminal outbox rows without marking them ACKed', () => {
    const { db, file } = createDb();
    db.prepare('INSERT INTO broker_terminal_outbox (id, task_event_id, acknowledged_at, created_at, payload) VALUES (?, ?, ?, ?, ?)')
      .run('terminal-legacy-failed-proof', 1, null, '2026-05-03T00:00:00.000Z', terminalPayload({
        id: 'terminal-legacy-failed-proof',
        attempts: 1,
        receipt: { status: 'failed', updatedAt: '2026-05-03T00:00:00.000Z', note: 'proof send failed closed' },
        payload: {
          taskId: 'task-1',
          status: 'failed',
          createdAt: '2026-05-03T00:00:00.000Z',
          updatedAt: '2026-05-03T00:00:00.000Z',
          doneCommentUrl: 'https://github.com/jinwon-int/a2a-broker/issues/294#issuecomment-1',
        },
      }));
    db.prepare('INSERT INTO broker_terminal_outbox (id, task_event_id, acknowledged_at, created_at, payload) VALUES (?, ?, ?, ?, ?)')
      .run('terminal-current-failed-proof', 2, null, '2026-05-03T00:20:00.000Z', terminalPayload({
        id: 'terminal-current-failed-proof',
        taskEventId: 2,
        createdAt: '2026-05-03T00:20:00.000Z',
        attempts: 1,
        receipt: { status: 'failed', updatedAt: '2026-05-03T00:20:00.000Z', note: 'current proof send failed' },
      }));
    db.close();

    const report = runMigrationHealthGate({
      dbFile: file,
      nowMs: Date.parse('2026-05-03T00:40:00.000Z'),
      maxUnackedAgeMs: 5 * 60 * 1000,
      legacyResidueCutoffMs: Date.parse('2026-05-03T00:10:00.000Z'),
      legacyResidueCutoff: '2026-05-03T00:10:00.000Z',
    });
    const outboxCheck = report.checks.find((check) => check.check === 'terminal-outbox ACK invariant');

    assert.equal(report.ok, false);
    assert.equal(outboxCheck?.legacyResidue.length, 1);
    assert.equal(outboxCheck?.legacyResidue[0].id, 'terminal-legacy-failed-proof');
    assert.equal(outboxCheck?.legacyResidue[0].reason, 'legacy_unacked_terminal_outbox');
    assert.equal(outboxCheck?.legacyResidue[0].bucket, 'send_failed');
    assert.equal(outboxCheck?.legacyResidue[0].canonicalEvidence, true);
    assert.equal(outboxCheck?.violations.length, 1);
    assert.equal(outboxCheck?.violations[0].id, 'terminal-current-failed-proof');
    assert.equal(outboxCheck?.violations[0].bucket, 'send_failed');
  });

  it('quarantines pre-cutoff accepted-only terminal outbox rows without marking them ACKed', () => {
    const { db, file } = createDb();
    db.prepare('INSERT INTO broker_terminal_outbox (id, task_event_id, acknowledged_at, created_at, payload) VALUES (?, ?, ?, ?, ?)')
      .run('terminal-legacy', 1, null, '2026-05-03T00:00:00.000Z', terminalPayload({
        id: 'terminal-legacy',
        receipt: { status: 'accepted', updatedAt: '2026-05-03T00:00:00.000Z' },
      }));
    db.prepare('INSERT INTO broker_terminal_outbox (id, task_event_id, acknowledged_at, created_at, payload) VALUES (?, ?, ?, ?, ?)')
      .run('terminal-current', 2, null, '2026-05-03T00:20:00.000Z', terminalPayload({
        id: 'terminal-current',
        taskEventId: 2,
        createdAt: '2026-05-03T00:20:00.000Z',
        receipt: { status: 'accepted', updatedAt: '2026-05-03T00:20:00.000Z' },
      }));
    db.close();

    const report = runMigrationHealthGate({
      dbFile: file,
      nowMs: Date.parse('2026-05-03T00:40:00.000Z'),
      maxUnackedAgeMs: 5 * 60 * 1000,
      legacyResidueCutoffMs: Date.parse('2026-05-03T00:10:00.000Z'),
      legacyResidueCutoff: '2026-05-03T00:10:00.000Z',
    });
    const outboxCheck = report.checks.find((check) => check.check === 'terminal-outbox ACK invariant');

    assert.equal(report.ok, false);
    assert.equal(outboxCheck?.legacyResidue.length, 1);
    assert.equal(outboxCheck?.legacyResidue[0].id, 'terminal-legacy');
    assert.equal(outboxCheck?.violations.length, 1);
    assert.equal(outboxCheck?.violations[0].id, 'terminal-current');
  });

  it('passes accepted-only legacy residue only when an explicit cutoff quarantines it', () => {
    const { db, file } = createDb();
    db.prepare('INSERT INTO broker_terminal_outbox (id, task_event_id, acknowledged_at, created_at, payload) VALUES (?, ?, ?, ?, ?)')
      .run('terminal-legacy', 1, null, '2026-05-03T00:00:00.000Z', terminalPayload({
        id: 'terminal-legacy',
        receipt: { status: 'accepted', updatedAt: '2026-05-03T00:00:00.000Z' },
        payload: {
          taskId: 'task-1',
          status: 'succeeded',
          createdAt: '2026-05-03T00:00:00.000Z',
          updatedAt: '2026-05-03T00:00:00.000Z',
          prUrl: 'https://github.com/jinwon-int/a2a-broker/pull/1',
        },
      }));
    db.close();

    const noCutoffReport = runMigrationHealthGate({
      dbFile: file,
      nowMs: Date.parse('2026-05-03T00:40:00.000Z'),
      maxUnackedAgeMs: 5 * 60 * 1000,
    });
    const noCutoffOutboxCheck = noCutoffReport.checks.find((check) => check.check === 'terminal-outbox ACK invariant');

    assert.equal(noCutoffReport.ok, false);
    assert.equal(noCutoffOutboxCheck?.ok, false);
    assert.equal(noCutoffOutboxCheck?.violations[0].reason, 'stale_unacked_receipt_evidence');

    const cutoffReport = runMigrationHealthGate({
      dbFile: file,
      nowMs: Date.parse('2026-05-03T00:40:00.000Z'),
      maxUnackedAgeMs: 5 * 60 * 1000,
      legacyResidueCutoffMs: Date.parse('2026-05-03T00:10:00.000Z'),
      legacyResidueCutoff: '2026-05-03T00:10:00.000Z',
    });
    const cutoffOutboxCheck = cutoffReport.checks.find((check) => check.check === 'terminal-outbox ACK invariant');

    assert.equal(cutoffReport.ok, true);
    assert.equal(cutoffOutboxCheck?.ok, true);
    const policyCheck = cutoffReport.checks.find((check) => check.check === 'legacy residue lifecycle policy');

    assert.equal(cutoffOutboxCheck?.legacyResidue.length, 1);
    assert.equal(cutoffOutboxCheck?.legacyResidue[0].canonicalEvidence, true);
    assert.equal(policyCheck?.ok, true);
    assert.equal(policyCheck?.totalLegacyResidue, 1);
    assert.match(policyCheck?.policy.lifecycle ?? '', /post-cutoff rows remain blocking|Rows at or after the cutoff are current regressions/);
    assert.equal(cutoffReport.required.legacyResidueExpires, '2026-05-10T00:10:00.000Z');
  });

  it('expires legacy residue quarantine instead of allowing an unbounded cutoff', () => {
    const { db, file } = createDb();
    db.prepare('INSERT INTO broker_terminal_outbox (id, task_event_id, acknowledged_at, created_at, payload) VALUES (?, ?, ?, ?, ?)')
      .run('terminal-legacy', 1, null, '2026-05-03T00:00:00.000Z', terminalPayload({
        id: 'terminal-legacy',
        receipt: { status: 'accepted', updatedAt: '2026-05-03T00:00:00.000Z' },
      }));
    db.close();

    const report = runMigrationHealthGate({
      dbFile: file,
      nowMs: Date.parse('2026-05-03T00:31:00.000Z'),
      maxUnackedAgeMs: 5 * 60 * 1000,
      legacyResidueCutoffMs: Date.parse('2026-05-03T00:10:00.000Z'),
      legacyResidueCutoff: '2026-05-03T00:10:00.000Z',
      legacyResidueExpiresMs: Date.parse('2026-05-03T00:30:00.000Z'),
      legacyResidueExpires: '2026-05-03T00:30:00.000Z',
    });
    const expiredPolicyCheck = report.checks.find((check) => check.check === 'legacy residue lifecycle policy');

    assert.equal(report.ok, false);
    assert.equal(expiredPolicyCheck?.ok, false);
    assert.equal(expiredPolicyCheck?.reason, 'legacy_residue_policy_expired');
    assert.equal(expiredPolicyCheck?.totalLegacyResidue, 1);
  });

  it('quarantines pre-cutoff terminal task tombstone gaps without hiding current gaps', () => {
    const { db, file } = createDb();
    db.prepare('INSERT INTO broker_tasks (id, payload) VALUES (?, ?)')
      .run('task-legacy', taskPayload({
        id: 'task-legacy',
        status: 'canceled',
        completedAt: '2026-05-03T00:00:00.000Z',
        updatedAt: '2026-05-03T00:00:00.000Z',
      }));
    db.prepare('INSERT INTO broker_tasks (id, payload) VALUES (?, ?)')
      .run('task-current', taskPayload({
        id: 'task-current',
        status: 'canceled',
        completedAt: '2026-05-03T00:20:00.000Z',
        updatedAt: '2026-05-03T00:20:00.000Z',
      }));
    db.close();

    const report = runMigrationHealthGate({
      dbFile: file,
      nowMs: Date.parse('2026-05-03T00:40:00.000Z'),
      legacyResidueCutoffMs: Date.parse('2026-05-03T00:10:00.000Z'),
      legacyResidueCutoff: '2026-05-03T00:10:00.000Z',
    });
    const queueCheck = report.checks.find((check) => check.check === 'queue closeout reconciliation');

    assert.equal(report.ok, false);
    assert.equal(queueCheck?.legacyResidue.length, 1);
    assert.equal(queueCheck?.legacyResidue[0].id, 'task-legacy');
    assert.equal(queueCheck?.violations.length, 1);
    assert.equal(queueCheck?.violations[0].id, 'task-current');
  });
});
