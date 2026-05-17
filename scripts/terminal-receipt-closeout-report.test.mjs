import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { renderMarkdown, runTerminalReceiptCloseoutReport } from './terminal-receipt-closeout-report.mjs';

function createDb() {
  const dir = mkdtempSync(join(tmpdir(), 'a2a-terminal-receipt-report-'));
  const file = join(dir, 'state.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`
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

function terminalPayload(overrides = {}) {
  return JSON.stringify({
    id: 'terminal-1',
    kind: 'task.terminal',
    taskEventId: 1,
    payload: {
      taskId: 'task-1',
      status: 'succeeded',
      createdAt: '2026-05-04T07:30:00.000Z',
      updatedAt: '2026-05-04T07:30:00.000Z',
      taskBrief: 'operator safe brief only',
      testSummary: 'must not appear in report',
    },
    createdAt: '2026-05-04T07:30:00.000Z',
    receipt: { status: 'accepted', updatedAt: '2026-05-04T07:30:00.000Z' },
    attempts: 0,
    ...overrides,
  });
}

function insertOutbox(db, { id, taskEventId, acknowledgedAt = null, createdAt, payload }) {
  db.prepare('INSERT INTO broker_terminal_outbox (id, task_event_id, acknowledged_at, created_at, payload) VALUES (?, ?, ?, ?, ?)')
    .run(id, taskEventId, acknowledgedAt, createdAt, payload);
}

describe('terminal receipt closeout report', () => {
  it('groups current post-cutoff gaps separately from legacy residue and confirmed receipts', () => {
    const { db, file } = createDb();
    insertOutbox(db, {
      id: 'terminal-legacy',
      taskEventId: 1,
      createdAt: '2026-05-04T07:00:00.000Z',
      payload: terminalPayload({
        id: 'terminal-legacy',
        taskEventId: 1,
        createdAt: '2026-05-04T07:00:00.000Z',
        payload: { taskId: 'task-legacy', status: 'failed', createdAt: '2026-05-04T07:00:00.000Z', updatedAt: '2026-05-04T07:00:00.000Z' },
      }),
    });
    insertOutbox(db, {
      id: 'terminal-current',
      taskEventId: 2,
      createdAt: '2026-05-04T07:30:00.000Z',
      payload: terminalPayload({ id: 'terminal-current', taskEventId: 2 }),
    });
    insertOutbox(db, {
      id: 'terminal-confirmed',
      taskEventId: 3,
      acknowledgedAt: '2026-05-04T07:31:00.000Z',
      createdAt: '2026-05-04T07:30:00.000Z',
      payload: terminalPayload({
        id: 'terminal-confirmed',
        taskEventId: 3,
        ack: {
          status: 'receipt_confirmed',
          evidence: 'operator_visible',
          acknowledgedAt: '2026-05-04T07:31:00.000Z',
        },
      }),
    });
    db.close();

    const report = runTerminalReceiptCloseoutReport({
      dbFile: file,
      nowMs: Date.parse('2026-05-04T08:00:00.000Z'),
      legacyResidueCutoff: '2026-05-04T07:10:00.000Z',
      maxUnackedAgeMs: 5 * 60 * 1000,
    });

    assert.equal(report.ok, false);
    assert.equal(report.summary.totalRows, 3);
    assert.equal(report.summary.receiptConfirmedRows, 1);
    assert.equal(report.currentPostCutoff.length, 1);
    assert.equal(report.legacyResidue.length, 1);
    assert.equal(report.currentPostCutoff[0].terminalEventId, 'terminal-current');
    assert.equal(report.currentPostCutoff[0].taskId, 'task-1');
    assert.equal(report.currentPostCutoff[0].status, 'succeeded');
    assert.equal(report.currentPostCutoff[0].receiptState, 'unacked:accepted');
    assert.equal(report.currentPostCutoff[0].worker, null);
    assert.equal(report.currentPostCutoff[0].origin, 'local');
    assert.equal(report.currentPostCutoff[0].hasEvidenceUrl, false);
    assert.equal(report.currentPostCutoff[0].evidenceClass, 'accepted_or_provider_send_only');
    assert.equal(report.currentPostCutoff[0].ageBucket, '<1h');
    assert.equal(report.classifications.allUnacked.count, 2);
    assert.deepEqual(report.classifications.allUnacked.byEvidenceClass, { accepted_or_provider_send_only: 2 });
    assert.deepEqual(report.classifications.allUnacked.byOrigin, { local: 2 });
    assert.deepEqual(report.classifications.currentPostCutoff.sampleIds, ['terminal-current']);
    assert.match(report.currentPostCutoff[0].remediationHint, /operator-visible\/provider-delivery receipt evidence/);
  });

  it('classifies gaps by worker, status, evidence, age bucket, and cross-broker origin', () => {
    const { db, file } = createDb();
    insertOutbox(db, {
      id: 'terminal:cross-broker%3Around%3Agwakga%3Atask-1:succeeded:2026-05-04T07%3A30%3A00.000Z',
      taskEventId: 1,
      createdAt: '2026-05-04T07:30:00.000Z',
      payload: terminalPayload({
        id: 'terminal:cross-broker%3Around%3Agwakga%3Atask-1:succeeded:2026-05-04T07%3A30%3A00.000Z',
        payload: {
          taskId: 'cross-broker:round:gwakga:task-1',
          status: 'succeeded',
          worker: 'gwakga',
          repo: 'jinwon-int/a2a-broker',
          issue: 681,
          doneUrl: 'https://github.com/jinwon-int/a2a-broker/issues/681#cross-broker',
          createdAt: '2026-05-04T07:30:00.000Z',
          updatedAt: '2026-05-04T07:30:00.000Z',
        },
        receipt: { status: 'operator_visible', evidence: 'operator_visible', updatedAt: '2026-05-04T07:31:00.000Z' },
      }),
    });
    insertOutbox(db, {
      id: 'terminal-local-provider',
      taskEventId: 2,
      createdAt: '2026-05-04T01:30:00.000Z',
      payload: terminalPayload({
        id: 'terminal-local-provider',
        payload: {
          taskId: 'task-local-provider',
          status: 'failed',
          worker: 'sogyo',
          createdAt: '2026-05-04T01:30:00.000Z',
          updatedAt: '2026-05-04T01:30:00.000Z',
        },
        receipt: { status: 'provider_sent', updatedAt: '2026-05-04T01:31:00.000Z' },
      }),
    });
    db.close();

    const report = runTerminalReceiptCloseoutReport({
      dbFile: file,
      nowMs: Date.parse('2026-05-04T08:00:00.000Z'),
      legacyResidueCutoff: '2026-05-04T00:00:00.000Z',
      sampleLimit: 1,
    });

    assert.equal(report.ok, false);
    assert.equal(report.classifications.allUnacked.count, 2);
    assert.deepEqual(report.classifications.allUnacked.byWorker, { sogyo: 1, gwakga: 1 });
    assert.deepEqual(report.classifications.allUnacked.byStatus, { failed: 1, succeeded: 1 });
    assert.deepEqual(report.classifications.allUnacked.byOrigin, { local: 1, crossBroker: 1 });
    assert.deepEqual(report.classifications.allUnacked.byEvidenceClass, {
      accepted_or_provider_send_only: 1,
      operator_visible_evidence_unacked: 1,
    });
    assert.deepEqual(report.classifications.allUnacked.byEvidenceUrlPresence, {
      missingEvidenceUrl: 1,
      hasEvidenceUrl: 1,
    });
    assert.deepEqual(report.classifications.allUnacked.byAgeBucket, { '6-24h': 1, '<1h': 1 });
    assert.equal(report.classifications.allUnacked.sampleIds.length, 1);
    assert.match(renderMarkdown(report), /Classifier: all unacked gaps/);
  });

  it('keeps report output operator-safe without raw payload, secrets, or filesystem paths', () => {
    const { db, file } = createDb();
    insertOutbox(db, {
      id: '/var/lib/terminal-secret',
      taskEventId: 1,
      createdAt: '2026-05-04T07:30:00.000Z',
      payload: terminalPayload({
        id: '/var/lib/terminal-secret',
        payload: {
          taskId: '/srv/token=<fake-token-placeholder>',
          status: 'blocked',
          createdAt: '2026-05-04T07:30:00.000Z',
          updatedAt: '2026-05-04T07:30:00.000Z',
          taskBrief: 'raw payload brief must not be rendered',
          testSummary: 'password=super-secret must not be rendered',
        },
        receipt: { status: 'provider_sent', updatedAt: '2026-05-04T07:31:00.000Z' },
      }),
    });
    db.close();

    const report = runTerminalReceiptCloseoutReport({
      dbFile: file,
      nowMs: Date.parse('2026-05-04T08:00:00.000Z'),
      legacyResidueCutoff: '2026-05-04T07:10:00.000Z',
    });
    const markdown = renderMarkdown(report);

    assert.equal(report.currentPostCutoff[0].terminalEventId, '[path]');
    assert.equal(report.currentPostCutoff[0].taskId, '[path]=[redacted]');
    assert.doesNotMatch(markdown, /super-secret|fake-token-placeholder|raw payload brief|must not be rendered/);
    assert.match(markdown, /rawPayloadsIncluded=false/);
    assert.match(markdown, /provider send success alone is insufficient/);
  });

  it('passes when only legacy receipt gaps remain under an explicit cutoff', () => {
    const { db, file } = createDb();
    insertOutbox(db, {
      id: 'terminal-legacy',
      taskEventId: 1,
      createdAt: '2026-05-04T07:00:00.000Z',
      payload: terminalPayload({ id: 'terminal-legacy', createdAt: '2026-05-04T07:00:00.000Z' }),
    });
    db.close();

    const report = runTerminalReceiptCloseoutReport({
      dbFile: file,
      nowMs: Date.parse('2026-05-04T08:00:00.000Z'),
      legacyResidueCutoff: '2026-05-04T07:10:00.000Z',
    });

    assert.equal(report.ok, true);
    assert.equal(report.currentPostCutoff.length, 0);
    assert.equal(report.legacyResidue.length, 1);
    assert.equal(report.check.ok, true);
  });
});
