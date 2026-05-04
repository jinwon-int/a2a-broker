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
    assert.equal(report.checks.length, 5);
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

  it('passes when all stale accepted-only terminal outbox rows are before the legacy cutoff', () => {
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

    const report = runMigrationHealthGate({
      dbFile: file,
      nowMs: Date.parse('2026-05-03T00:40:00.000Z'),
      maxUnackedAgeMs: 5 * 60 * 1000,
      legacyResidueCutoffMs: Date.parse('2026-05-03T00:10:00.000Z'),
      legacyResidueCutoff: '2026-05-03T00:10:00.000Z',
    });
    const outboxCheck = report.checks.find((check) => check.check === 'terminal-outbox ACK invariant');

    assert.equal(report.ok, true);
    assert.equal(outboxCheck?.ok, true);
    assert.equal(outboxCheck?.legacyResidue.length, 1);
    assert.equal(outboxCheck?.legacyResidue[0].canonicalEvidence, true);
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
