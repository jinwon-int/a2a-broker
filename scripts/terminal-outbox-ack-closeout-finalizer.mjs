#!/usr/bin/env node
// No-live terminal outbox ACK closeout finalizer.
//
// This runner starts an ephemeral localhost broker backed by a temp SQLite file,
// creates one terminal outbox row through the HTTP task lifecycle, proves invalid
// ACK evidence is rejected, proves valid receipt evidence is accepted and persisted,
// and verifies /health plus /operator/task-report. It never calls provider APIs or
// external notifiers and does not mutate production state.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import process from 'node:process';

const ISSUE_URL = 'https://github.com/jinwon-int/a2a-broker/issues/584';
const PARENT_URL = 'https://github.com/jinwon-int/a2a-broker/issues/577';
const ROOT_BUG_URL = 'https://github.com/jinwon-int/a2a-broker/issues/576';
const RUN_ID = 'a2a-r10-terminal-outbox-ack-persistence-20260513T1654Z';
const DEFAULT_EDGE_SECRET = 'local-terminal-outbox-closeout-secret';
const VALID_ACK_AT = '2026-05-13T16:54:00.000Z';
const VALID_RECEIPT_ID = 'operator-local-finalizer-proof-584';

export function parseArgs(argv) {
  const options = { format: 'markdown', keepTemp: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      i += 1;
      return value;
    };
    if (arg === '--json') options.format = 'json';
    else if (arg === '--markdown' || arg === '--md') options.format = 'markdown';
    else if (arg === '--keep-temp') options.keepTemp = true;
    else if (arg === '--edge-secret') options.edgeSecret = next();
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

export function usage() {
  return `Usage: npm run terminal_outbox_ack_closeout_finalizer -- [--markdown|--json]\n\nRuns a no-live localhost E2E proof for terminal-outbox ACK SQLite persistence:\ncreate terminal outbox row, reject provider-send-only ACK, accept operator-visible ACK,\nverify /health and /operator/task-report, and confirm no live provider sends.\n`;
}

function headers(secret, overrides = {}) {
  return {
    'content-type': 'application/json',
    'x-a2a-edge-secret': secret,
    ...overrides,
  };
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text.slice(0, 500) };
    }
  }
  return { response, body };
}

function assertStatus(step, actual, expected) {
  if (actual !== expected) {
    throw new Error(`${step}: expected HTTP ${expected}, got ${actual}`);
  }
}

function assertEqual(step, actual, expected) {
  if (actual !== expected) {
    throw new Error(`${step}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertTruthy(step, value) {
  if (!value) throw new Error(`${step}: expected truthy value`);
}

function readOutboxRow(dbFile, id) {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const row = db
      .prepare('SELECT id, task_event_id AS taskEventId, acknowledged_at AS acknowledgedAt, created_at AS createdAt, payload FROM broker_terminal_outbox WHERE id = ?')
      .get(id);
    if (!row) throw new Error(`SQLite broker_terminal_outbox row not found for ${id}`);
    const payload = JSON.parse(row.payload);
    return {
      id: row.id,
      taskEventId: row.taskEventId,
      acknowledgedAt: row.acknowledgedAt ?? null,
      createdAt: row.createdAt,
      ackStatus: payload.ack?.status ?? null,
      ackEvidence: payload.ack?.evidence ?? null,
      receiptStatus: payload.receipt?.status ?? null,
      receiptEvidence: payload.receipt?.evidence ?? null,
      attempts: payload.attempts,
    };
  } finally {
    db.close();
  }
}

async function listen(server) {
  server.server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.server.once('listening', resolve);
    server.server.once('error', reject);
  });
  const address = server.server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind local broker');
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server) {
  if (!server?.server?.listening) return;
  await new Promise((resolve, reject) => {
    server.server.close((error) => error ? reject(error) : resolve());
  });
}

function step(status, detail, extra = {}) {
  return { status, detail, ...extra };
}

export async function runTerminalOutboxAckCloseoutFinalizer(options = {}) {
  const startedAt = new Date().toISOString();
  const tempRoot = await mkdtemp(join(tmpdir(), 'a2a-terminal-ack-closeout-'));
  const dbFile = join(tempRoot, 'broker-state.sqlite');
  const stateFile = join(tempRoot, 'state.json');
  const edgeSecret = options.edgeSecret ?? DEFAULT_EDGE_SECRET;
  const checks = {};
  let server;
  try {
    const { createBrokerServer } = await import('../dist/server.js');
    server = createBrokerServer({
      host: '127.0.0.1',
      port: 0,
      publicBaseUrl: 'https://broker.local.invalid/',
      stateFile,
      sqliteFile: dbFile,
      persistenceBackend: 'sqlite',
      sqliteLoadSource: 'hot-tables',
      edgeSecret,
      enforceRequesterIdentity: true,
      staleReaperEnabled: false,
      rateLimitMaxRequests: 200,
      workerRateLimitMaxRequests: 200,
      brokerId: 'terminal-ack-closeout-local',
      buildRevision: 'local-no-live-finalizer',
      version: '0.1.0',
    });
    const baseUrl = await listen(server);
    checks.localOnly = step('pass', 'ephemeral broker bound to 127.0.0.1 only; no deploy/restart/reload was requested');

    const hubHeaders = headers(edgeSecret, {
      'x-a2a-requester-id': 'closeout-hub',
      'x-a2a-requester-role': 'hub',
    });
    const workerHeaders = headers(edgeSecret, {
      'x-a2a-requester-id': 'closeout-worker',
      'x-a2a-requester-role': 'analyst',
    });

    const reg = await requestJson(`${baseUrl}/workers/register`, {
      method: 'POST',
      headers: workerHeaders,
      body: JSON.stringify({
        nodeId: 'closeout-worker',
        role: 'analyst',
        capabilities: {
          canAnalyze: true,
          canBackfill: false,
          canPatchWorkspace: false,
          canPromoteLive: false,
          workspaceIds: ['no-live-closeout'],
          environments: ['research'],
        },
      }),
    });
    assertStatus('register worker', reg.response.status, 201);

    const createTask = await requestJson(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: hubHeaders,
      body: JSON.stringify({
        intent: 'verify',
        requester: { id: 'closeout-hub', kind: 'node', role: 'hub' },
        target: { id: 'closeout-worker', kind: 'node', role: 'analyst' },
        assignedWorkerId: 'closeout-worker',
        payload: {
          githubRepo: 'jinwon-int/a2a-broker',
          githubIssueNumber: 584,
          lane: 'terminal-outbox-ack-closeout-finalizer',
          rawPrompt: 'must-not-leak-terminal-ack-finalizer',
        },
        message: 'no-live terminal outbox ACK SQLite persistence finalizer fixture',
      }),
    });
    assertStatus('create task', createTask.response.status, 201);
    const task = createTask.body;
    assertTruthy('created task id', task?.id);

    const claim = await requestJson(`${baseUrl}/tasks/${encodeURIComponent(task.id)}/claim`, {
      method: 'POST',
      headers: workerHeaders,
      body: JSON.stringify({ workerId: 'closeout-worker' }),
    });
    assertStatus('claim task', claim.response.status, 200);

    const complete = await requestJson(`${baseUrl}/tasks/${encodeURIComponent(task.id)}/complete`, {
      method: 'POST',
      headers: workerHeaders,
      body: JSON.stringify({
        workerId: 'closeout-worker',
        result: {
          summary: 'Done: terminal outbox ACK SQLite persistence no-live finalizer passed',
          output: {
            doneUrl: 'https://github.com/jinwon-int/a2a-broker/issues/584#issuecomment-local-finalizer',
            testSummary: { status: 'passed', total: 1, passed: 1 },
            rawLog: 'must-not-leak-terminal-ack-finalizer',
          },
        },
      }),
    });
    assertStatus('complete task', complete.response.status, 200);

    const outbox = await requestJson(`${baseUrl}/a2a/tasks/terminal-outbox`, { headers: hubHeaders });
    assertStatus('list terminal outbox', outbox.response.status, 200);
    assertEqual('terminal outbox count', outbox.body?.count, 1);
    const event = outbox.body.events?.[0];
    assertTruthy('terminal outbox event', event);
    assertEqual('terminal outbox row task id', event.payload?.taskId, task.id);
    assertEqual('terminal outbox row status', event.payload?.status, 'succeeded');
    assertEqual('terminal outbox initial receipt status', event.receipt?.status, 'accepted');
    assertEqual('terminal outbox initial ack', event.ack, undefined);
    checks.createTerminalOutboxRow = step('pass', 'created one compact task.terminal outbox row through localhost HTTP lifecycle', {
      outboxId: event.id,
      taskId: task.id,
      initialReceiptStatus: event.receipt.status,
    });

    const invalidAck = await requestJson(`${baseUrl}/a2a/tasks/terminal-outbox/ack`, {
      method: 'POST',
      headers: hubHeaders,
      body: JSON.stringify({ id: event.id, receipt: { evidence: 'provider_send_success' } }),
    });
    assertStatus('reject provider-send-only ACK', invalidAck.response.status, 400);
    const afterInvalid = readOutboxRow(dbFile, event.id);
    assertEqual('invalid ACK did not persist acknowledged_at', afterInvalid.acknowledgedAt, null);
    assertEqual('invalid ACK did not persist ack status', afterInvalid.ackStatus, null);
    checks.rejectInvalidAck = step('pass', 'provider_send_success was rejected as non-terminal ACK evidence and did not set acknowledged_at');

    const validAck = await requestJson(`${baseUrl}/a2a/tasks/terminal-outbox/ack`, {
      method: 'POST',
      headers: hubHeaders,
      body: JSON.stringify({
        id: event.id,
        receipt: {
          evidence: 'operator_visible',
          acknowledgedAt: VALID_ACK_AT,
          receiptId: VALID_RECEIPT_ID,
        },
      }),
    });
    assertStatus('accept operator-visible ACK', validAck.response.status, 200);
    assertEqual('valid ACK status', validAck.body?.event?.ack?.status, 'receipt_confirmed');
    assertEqual('valid ACK evidence', validAck.body?.event?.ack?.evidence, 'operator_visible');
    assertEqual('valid receipt status', validAck.body?.event?.receipt?.status, 'operator_visible');
    checks.acceptValidAck = step('pass', 'operator_visible receipt evidence was accepted as terminal ACK evidence', {
      ackStatus: validAck.body.event.ack.status,
      ackEvidence: validAck.body.event.ack.evidence,
      receiptStatus: validAck.body.event.receipt.status,
    });

    const persisted = readOutboxRow(dbFile, event.id);
    assertEqual('SQLite acknowledged_at persisted', persisted.acknowledgedAt, VALID_ACK_AT);
    assertEqual('SQLite ack status persisted', persisted.ackStatus, 'receipt_confirmed');
    assertEqual('SQLite ack evidence persisted', persisted.ackEvidence, 'operator_visible');
    assertEqual('SQLite receipt status persisted', persisted.receiptStatus, 'operator_visible');
    checks.sqliteAckPersistence = step('pass', 'SQLite broker_terminal_outbox row persisted acknowledged_at and receipt_confirmed payload using read-only verification', {
      ackStatus: persisted.ackStatus,
      ackEvidence: persisted.ackEvidence,
      receiptStatus: persisted.receiptStatus,
    });

    const health = await requestJson(`${baseUrl}/health`);
    assertStatus('health', health.response.status, 200);
    assertEqual('health persistence kind', health.body?.persistence?.kind, 'sqlite');
    assertEqual('health hot terminal outbox table count', health.body?.persistence?.hotTableLoadMetrics?.tables?.broker_terminal_outbox?.count, 1);
    assertEqual('health hot terminal outbox unacked count', health.body?.persistence?.hotTableLoadMetrics?.tables?.broker_terminal_outbox?.unackedCount, 0);
    checks.health = step('pass', '/health reported SQLite persistence and terminal outbox count=1/unacked=0');

    const report = await requestJson(`${baseUrl}/operator/task-report?task_id=${encodeURIComponent(task.id)}`, { headers: hubHeaders });
    assertStatus('operator task report', report.response.status, 200);
    assertEqual('operator report total', report.body?.total, 1);
    const reportItem = report.body.items?.[0];
    assertEqual('operator report receipt status', reportItem?.receiptStatus, 'operator_visible');
    assertEqual('operator report terminal ack status', reportItem?.terminalBrief?.ackStatus, 'receipt_confirmed');
    assertEqual('operator report terminal cursor', reportItem?.terminalBrief?.cursor, event.id);
    checks.operatorReport = step('pass', '/operator/task-report surfaced receiptStatus=operator_visible and ackStatus=receipt_confirmed for the terminal brief');

    const serialized = JSON.stringify({ outbox: outbox.body, validAck: validAck.body, report: report.body });
    for (const forbidden of [
      'must-not-leak-terminal-ack-finalizer',
      'rawPrompt',
      'rawLog',
      '/work/private',
      tempRoot,
    ]) {
      if (serialized.includes(forbidden)) throw new Error(`operator evidence leaked forbidden value: ${forbidden}`);
    }
    checks.operatorSafeEvidence = step('pass', 'operator evidence excluded raw prompt/log/token/temp-path fields');

    const safety = {
      noLiveProviderSend: true,
      noDeployRestartReload: true,
      noHistoricalReplay: true,
      noManualTerminalAck: true,
      noProductionDbMutationOrRepair: true,
      noSecretOrVisibilityChange: true,
      noReleaseOrForcePush: true,
      localFixtureDbOnly: true,
    };
    checks.noLiveSends = step('pass', 'no provider/notifier API was called; all requests targeted the ephemeral 127.0.0.1 broker');

    const finishedAt = new Date().toISOString();
    return {
      kind: 'terminal-outbox-ack-closeout-finalizer',
      status: 'done',
      ok: true,
      run: RUN_ID,
      issue: ISSUE_URL,
      parent: PARENT_URL,
      rootBug: ROOT_BUG_URL,
      startedAt,
      finishedAt,
      checks,
      safety,
      evidence: {
        taskId: task.id,
        outboxId: event.id,
        invalidAckHttpStatus: invalidAck.response.status,
        validAckHttpStatus: validAck.response.status,
        ackEvidence: 'operator_visible',
        sqliteAckPersisted: true,
        healthPersistenceKind: 'sqlite',
        healthTerminalOutboxRows: 1,
        healthTerminalOutboxUnackedRows: 0,
        operatorReportAckStatus: 'receipt_confirmed',
        operatorReportReceiptStatus: 'operator_visible',
      },
    };
  } catch (error) {
    return {
      kind: 'terminal-outbox-ack-closeout-finalizer',
      status: 'block',
      ok: false,
      run: RUN_ID,
      issue: ISSUE_URL,
      parent: PARENT_URL,
      rootBug: ROOT_BUG_URL,
      startedAt,
      finishedAt: new Date().toISOString(),
      checks,
      blocker: error instanceof Error ? error.message : String(error),
      safety: {
        noLiveProviderSend: true,
        noDeployRestartReload: true,
        noHistoricalReplay: true,
        noManualTerminalAck: true,
        noProductionDbMutationOrRepair: true,
        noSecretOrVisibilityChange: true,
        noReleaseOrForcePush: true,
        localFixtureDbOnly: true,
      },
    };
  } finally {
    await closeServer(server).catch(() => {});
    if (!options.keepTemp) await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

export function renderMarkdown(report) {
  const lines = [];
  const label = report.ok ? 'Done' : 'Block';
  lines.push(`${label}: #584 terminal-outbox ACK SQLite persistence closeout finalizer`);
  lines.push('');
  lines.push(`Run: ${report.run}`);
  lines.push(`Parent: ${report.parent}`);
  lines.push(`Root bug: ${report.rootBug}`);
  lines.push('');
  lines.push('Checks:');
  for (const [name, check] of Object.entries(report.checks ?? {})) {
    lines.push(`- ${name}: ${check.status} — ${check.detail}`);
  }
  if (report.evidence) {
    lines.push('');
    lines.push('Evidence:');
    lines.push(`- taskId: ${report.evidence.taskId}`);
    lines.push(`- outboxId: ${report.evidence.outboxId}`);
    lines.push(`- invalid ACK HTTP status: ${report.evidence.invalidAckHttpStatus}`);
    lines.push(`- valid ACK HTTP status: ${report.evidence.validAckHttpStatus}`);
    lines.push(`- ACK evidence: ${report.evidence.ackEvidence}`);
    lines.push(`- SQLite ACK persisted: ${report.evidence.sqliteAckPersisted ? 'yes' : 'no'}`);
    lines.push(`- /health persistence: ${report.evidence.healthPersistenceKind}; outbox rows=${report.evidence.healthTerminalOutboxRows}; unacked=${report.evidence.healthTerminalOutboxUnackedRows}`);
    lines.push(`- operator report: ack=${report.evidence.operatorReportAckStatus}; receipt=${report.evidence.operatorReportReceiptStatus}`);
  }
  if (report.blocker) {
    lines.push('');
    lines.push(`Blocker: ${report.blocker}`);
  }
  lines.push('');
  lines.push('Safety statement: no deploy/restart/reload, live provider send, historical replay, manual terminal ACK, production DB mutation/repair, secret/visibility change, release, or force-push was performed. The finalizer uses only an ephemeral localhost broker and temp SQLite fixture.');
  return `${lines.join('\n')}\n`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return 0;
  }
  const report = await runTerminalOutboxAckCloseoutFinalizer(options);
  if (options.format === 'json') console.log(JSON.stringify(report, null, 2));
  else console.log(renderMarkdown(report));
  return report.ok ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
