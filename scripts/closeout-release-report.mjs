#!/usr/bin/env node
// Consolidated A2A closeout release report.
//
// Read-only by design: this renderer consumes sanitized evidence JSON and emits a
// Done/Block report. It never deploys, restarts Gateway, sends Telegram, mutates
// the broker DB, or ACKs terminal-outbox records.

import process from 'node:process';
import { readFile } from 'node:fs/promises';

export const ISSUE = '#342';
export const PARENT_ISSUE = '#294';
export const EXPECTED_WORKERS = ['bangtong', 'dungae', 'sogyo', 'nosuk', 'yukson'];
export const REQUIRED_RECEIPT_SCENARIOS = [
  'no_notification_configured',
  'send_accepted_no_receipt',
  'receipt_confirmed',
  'send_failed',
  'stale_timed_out',
  'duplicate_terminal_event',
];

const RECEIPT_ACK_EVIDENCE = new Set(['operator_visible', 'operator_confirmed', 'provider_delivery_receipt']);

function pass(check, detail, extra = {}) {
  return { ok: true, check, detail, ...extra };
}

function fail(check, detail, extra = {}) {
  return { ok: false, check, detail, ...extra };
}

function parseArgs(argv) {
  const readOption = (name) => {
    const prefix = `${name}=`;
    const inline = argv.find((arg) => arg.startsWith(prefix));
    if (inline) return inline.slice(prefix.length);
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    input: readOption('--input'),
    json: argv.includes('--json') || argv.includes('--format=json'),
    markdown: argv.includes('--markdown') || argv.includes('--format=markdown'),
  };
}

function isHttpUrl(value) {
  return typeof value === 'string' && /^https:\/\//.test(value);
}

function asBoolean(value) {
  if (value === true || value === 'true' || value === 'yes') return true;
  if (value === false || value === 'false' || value === 'no') return false;
  return Boolean(value);
}

function getNested(object, path) {
  return path.split('.').reduce((current, key) => current?.[key], object);
}

function shapeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function safeToken(value, fallback = '<missing>') {
  if (value === undefined || value === null) return fallback;
  const text = String(value);
  if (/^[A-Za-z0-9._:#/-]{1,96}$/.test(text) && !/token|secret|chat_id|BROKER_EDGE_SECRET|\/work\//i.test(text)) return text;
  return `<${shapeOf(value)}>`;
}

function summarizeShapeCounts(values) {
  const counts = new Map();
  for (const value of values) {
    const shape = shapeOf(value);
    counts.set(shape, (counts.get(shape) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function renderShapeCounts(counts) {
  const entries = Object.entries(counts);
  return entries.length > 0 ? entries.map(([shape, count]) => `${shape}=${count}`).join(', ') : 'none';
}

function terminalOutboxLastNotificationAttemptValues(evidence) {
  const candidates = [
    [evidence.terminalOutbox, 'lastNotificationAttempt'],
    [evidence.liveReadiness?.terminalOutbox, 'lastNotificationAttempt'],
  ];
  for (const [container, key] of candidates) {
    if (container && Object.hasOwn(container, key)) {
      const raw = container[key];
      return Array.isArray(raw) ? raw : [raw];
    }
  }
  const rows = firstDefined(evidence.terminalOutbox?.rows, evidence.liveReadiness?.terminalOutbox?.rows);
  if (Array.isArray(rows)) return rows.map((row) => row?.lastNotificationAttempt);
  return [];
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function queueCounts(evidence) {
  const source = firstDefined(
    evidence.queue,
    evidence.capacity?.queue,
    evidence.diagnostics?.tasks,
    evidence.liveReadiness?.diagnostics?.tasks,
  ) ?? {};
  const byStatus = source.byStatus ?? source;
  return {
    queued: Number(byStatus.queued ?? source.queued ?? 0),
    claimed: Number(byStatus.claimed ?? source.claimed ?? 0),
    running: Number(byStatus.running ?? source.running ?? 0),
    stale: Number(source.stale ?? evidence.capacity?.stale ?? evidence.diagnostics?.stale ?? 0),
  };
}

function workerIds(evidence) {
  const direct = firstDefined(evidence.workers?.onlineIds, evidence.workerMatrix?.onlineIds);
  if (Array.isArray(direct)) return direct.filter((id) => typeof id === 'string').sort();

  const rows = firstDefined(evidence.workers?.items, evidence.workers, evidence.workerMatrix?.items);
  if (Array.isArray(rows)) {
    return rows
      .filter((row) => row?.status === 'online' || row?.online === true || row?.isOnline === true)
      .map((row) => row.nodeId ?? row.id)
      .filter((id) => typeof id === 'string')
      .sort();
  }

  const readinessCheck = evidence.liveReadiness?.checks?.find?.((check) => check.check === 'online worker matrix');
  if (Array.isArray(readinessCheck?.onlineIds)) return readinessCheck.onlineIds.filter((id) => typeof id === 'string').sort();
  return [];
}

function firstEvidenceUrl(payload) {
  for (const key of ['prUrl', 'doneUrl', 'blockUrl', 'doneCommentUrl', 'blockCommentUrl']) {
    if (isHttpUrl(payload?.[key])) return payload[key];
  }
  const github = payload?.github;
  if (github && typeof github === 'object') {
    for (const key of ['prUrl', 'doneCommentUrl', 'blockCommentUrl']) {
      if (isHttpUrl(github[key])) return github[key];
    }
  }
  return null;
}

function terminalEvidenceEvents(evidence) {
  const events = firstDefined(
    evidence.terminalEvidence?.events,
    evidence.terminalOutbox?.events,
    evidence.liveReadiness?.terminalOutbox?.events,
    evidence.liveReadiness?.checks?.find?.((check) => check.check === 'canonical PR/Done/Block evidence acceptance')?.events,
  );
  return Array.isArray(events) ? events : [];
}

function validateSafety(evidence) {
  const unsafe = [];
  const flags = {
    productionDeploy: firstDefined(evidence.safety?.productionDeploy, evidence.productionDeploy, false),
    gatewayRestart: firstDefined(evidence.safety?.gatewayRestart, evidence.gatewayRestart, false),
    liveTelegramSend: firstDefined(evidence.safety?.liveTelegramSend, evidence.liveTelegramSend, false),
    dbMutation: firstDefined(evidence.safety?.dbMutation, evidence.dbMutationAttempted, evidence.liveReadiness?.dbMutationAttempted, false),
    realTerminalOutboxAck: firstDefined(evidence.safety?.realTerminalOutboxAck, evidence.terminalAckAttempted, evidence.liveReadiness?.terminalAckAttempted, false),
    providerCalled: firstDefined(evidence.safety?.providerCalled, evidence.providerCalled, evidence.liveReadiness?.providerCalled, false),
  };
  for (const [key, value] of Object.entries(flags)) {
    if (asBoolean(value)) unsafe.push(key);
  }
  return unsafe.length === 0
    ? pass('safety gate', 'read-only/no-delivery/no-real-ACK flags are clean', { flags })
    : fail('safety gate', `unsafe action flag(s) set: ${unsafe.join(', ')}`, { flags });
}

function validateEdgeSecret(evidence) {
  const present = firstDefined(evidence.edgeSecret?.present, evidence.edgeSecretPresent, evidence.inputs?.edgeSecretPresent);
  return present === true
    ? pass('edge secret presence', 'edge secret present for read-only broker checks; value redacted')
    : fail('edge secret presence', 'missing edge secret presence proof; closeout must fail closed before live broker reads');
}

function validateHealth(evidence) {
  const health = firstDefined(evidence.health, evidence.liveReadiness?.health) ?? {};
  const ok = health.ok === true || health.status === 'ok' || health.status === 200;
  const revision = firstDefined(health.build, health.revision, health.version);
  if (!ok) return fail('health revision', 'health evidence did not report ok');
  if (!revision) return fail('health revision', 'missing build/version/revision evidence');
  return pass('health revision', `healthy revision=${revision}`);
}

function validateWorkers(evidence, expectedWorkers = EXPECTED_WORKERS) {
  const onlineIds = workerIds(evidence);
  const missing = expectedWorkers.filter((id) => !onlineIds.includes(id));
  if (missing.length > 0) {
    return fail('worker capacity matrix', `missing expected online worker(s): ${missing.join(', ')}`, { expectedWorkers, onlineIds });
  }
  return pass('worker capacity matrix', `${expectedWorkers.length}/${expectedWorkers.length} expected worker(s) online`, { expectedWorkers, onlineIds });
}

function validateQueue(evidence) {
  const counts = queueCounts(evidence);
  const blockers = Object.entries(counts).filter(([, value]) => value !== 0).map(([key, value]) => `${key}=${value}`);
  return blockers.length === 0
    ? pass('queue/stale closeout', 'queued=0, claimed=0, running=0, stale=0', { counts })
    : fail('queue/stale closeout', `non-zero closeout queue/stale count(s): ${blockers.join(', ')}`, { counts });
}

function validateMigration(evidence) {
  const report = evidence.migrationHealthGate;
  if (!report) return fail('migration health gate', 'missing migration health gate report');
  const checks = Array.isArray(report.checks) ? report.checks : [];
  const failing = checks.filter((check) => check?.ok !== true);
  if (report.ok === false || failing.length > 0) {
    return fail('migration health gate', `${failing.length || 1} migration check(s) failed`, { failingChecks: failing.map((check) => check.check).filter(Boolean) });
  }
  return pass('migration health gate', `${checks.length} migration check(s) passed`);
}

function validateLiveReadiness(evidence) {
  const report = evidence.liveReadiness;
  if (!report) return fail('live-readiness canary', 'missing live-readiness canary report');
  const checks = Array.isArray(report.checks) ? report.checks : [];
  const failing = checks.filter((check) => check?.ok !== true);
  const unsafe = [];
  if (asBoolean(report.providerCalled)) unsafe.push('providerCalled');
  if (asBoolean(report.dbMutationAttempted)) unsafe.push('dbMutationAttempted');
  if (asBoolean(report.terminalAckAttempted)) unsafe.push('terminalAckAttempted');
  if (report.ok === false || failing.length > 0 || unsafe.length > 0) {
    return fail('live-readiness canary', `readiness failure(s): ${[...failing.map((check) => check.check), ...unsafe].join(', ')}`);
  }
  return pass('live-readiness canary', `${checks.length} read-only readiness check(s) passed`);
}

function validateTerminalEvidence(evidence) {
  const events = terminalEvidenceEvents(evidence)
    .map((event) => {
      const payload = event?.payload ?? event?.output ?? event;
      const id = safeToken(event?.id ?? payload?.id, '<missing-id>');
      return { payload, id };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  const blockers = [];
  for (const { payload, id } of events) {
    if (!firstEvidenceUrl(payload)) blockers.push(`${id}: missing canonical HTTPS PR/Done/Block evidence`);
    const receipt = payload?.receipt && typeof payload.receipt === 'object' ? payload.receipt : {};
    const receiptEvidence = firstDefined(receipt.evidence, payload?.receiptEvidence);
    if (receiptEvidence !== undefined && !RECEIPT_ACK_EVIDENCE.has(receiptEvidence)) {
      blockers.push(`${id}: invalid receipt evidence ${safeToken(receiptEvidence, '<missing-receipt-evidence>')}`);
    }
  }
  blockers.sort();
  if (blockers.length > 0) return fail('terminal evidence closeout', blockers.join('; '), { eventCount: events.length });
  return pass('terminal evidence closeout', `${events.length} terminal event(s) have canonical evidence or no terminal events were supplied`, { eventCount: events.length });
}

function validateReceiptMatrix(evidence) {
  const matrix = evidence.receiptGateMatrix;
  if (!matrix) return fail('receipt no-live matrix', 'missing receipt no-live canary matrix');
  const cells = Array.isArray(matrix.cells) ? matrix.cells : [];
  const scenarios = new Set(cells.map((cell) => cell.scenarioId));
  const missing = REQUIRED_RECEIPT_SCENARIOS.filter((scenario) => !scenarios.has(scenario));
  const failures = cells.filter((cell) => cell.verdict !== 'pass' || cell.providerCalled !== false || cell.productionAckAttempted !== false);
  if (matrix.overallVerdict !== 'pass' || missing.length > 0 || failures.length > 0) {
    return fail('receipt no-live matrix', [
      matrix.overallVerdict !== 'pass' ? `overallVerdict=${matrix.overallVerdict}` : null,
      missing.length > 0 ? `missing scenario(s): ${missing.join(', ')}` : null,
      failures.length > 0 ? `unsafe/failing cell(s): ${failures.map((cell) => cell.scenarioId).join(', ')}` : null,
    ].filter(Boolean).join('; '));
  }
  return pass('receipt no-live matrix', `${cells.length} no-live receipt scenario(s) passed with providerCalled=false and productionAckAttempted=false`);
}

function validateTerminalOutboxNotificationAttemptSummary(evidence) {
  const counts = summarizeShapeCounts(terminalOutboxLastNotificationAttemptValues(evidence));
  return pass('terminal-outbox lastNotificationAttempt summary', `shape counts: ${renderShapeCounts(counts)}`, { counts });
}

function validateFinalConfigRestoration(evidence) {
  const restoration = firstDefined(
    evidence.finalConfigRestoration,
    evidence.noLiveRestoration,
    evidence.liveReadiness?.finalConfigRestoration,
  );
  if (!restoration || typeof restoration !== 'object') {
    return fail('final config restoration/no-live verification', 'missing final config restoration/no-live verification evidence');
  }
  const flags = {
    operatorEventsEnabled: firstDefined(restoration.operatorEventsEnabled, restoration.operatorBridgeEnabled, false),
    notificationEnabled: firstDefined(restoration.notificationEnabled, restoration.providerDeliveryEnabled, restoration.liveProviderConfigured, false),
    providerCalled: firstDefined(restoration.providerCalled, evidence.safety?.providerCalled, evidence.liveReadiness?.providerCalled, false),
    terminalAckAttempted: firstDefined(restoration.terminalAckAttempted, evidence.safety?.realTerminalOutboxAck, evidence.liveReadiness?.terminalAckAttempted, false),
  };
  const unsafe = Object.entries(flags).filter(([, value]) => asBoolean(value)).map(([key]) => key).sort();
  const verified = restoration.ok === true || restoration.restored === true || restoration.noLiveVerified === true;
  if (!verified || unsafe.length > 0) {
    return fail('final config restoration/no-live verification', [
      !verified ? 'missing ok/restored/noLiveVerified=true proof' : null,
      unsafe.length > 0 ? `unsafe final no-live flag(s): ${unsafe.join(', ')}` : null,
    ].filter(Boolean).join('; '), { flags });
  }
  return pass('final config restoration/no-live verification', 'final config restored and no-live state verified; providerCalled=false and terminalAckAttempted=false', { flags });
}

export function buildCloseoutReport(evidence, options = {}) {
  const expectedWorkers = options.expectedWorkers ?? evidence.expectedWorkers ?? EXPECTED_WORKERS;
  const checks = [
    validateSafety(evidence),
    validateEdgeSecret(evidence),
    validateHealth(evidence),
    validateWorkers(evidence, expectedWorkers),
    validateQueue(evidence),
    validateMigration(evidence),
    validateLiveReadiness(evidence),
    validateTerminalEvidence(evidence),
    validateReceiptMatrix(evidence),
    validateTerminalOutboxNotificationAttemptSummary(evidence),
    validateFinalConfigRestoration(evidence),
  ];
  const terminalOutboxLastNotificationAttemptShapes = summarizeShapeCounts(terminalOutboxLastNotificationAttemptValues(evidence));
  return {
    kind: 'broker.closeout-release-report',
    issue: ISSUE,
    parent: PARENT_ISSUE,
    mode: evidence.mode ?? 'read-only/no-live',
    expectedWorkers,
    terminalOutboxLastNotificationAttemptShapes,
    checks,
    ok: checks.every((check) => check.ok),
  };
}

export function renderCloseoutMarkdown(report) {
  const title = report.ok ? 'Done' : 'Block';
  return [
    `${title}: ${ISSUE} consolidated read-only closeout report`,
    '',
    `Parent: ${PARENT_ISSUE}`,
    `Mode: ${report.mode}`,
    `Expected workers: ${report.expectedWorkers.join(',')}`,
    `terminalOutbox.lastNotificationAttempt shapes: ${renderShapeCounts(report.terminalOutboxLastNotificationAttemptShapes ?? {})}`,
    '',
    'Focused validation:',
    ...report.checks.map((check) => `- ${check.ok ? 'PASS' : 'FAIL'} ${check.check}: ${check.detail}`),
    '',
    'Safety: no production deploy, Gateway restart, live Telegram send, DB mutation, or real terminal-outbox ACK is performed by this renderer.',
  ].join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.input) throw new Error('usage: node scripts/closeout-release-report.mjs --input <sanitized-evidence.json> [--markdown|--json]');
  const evidence = JSON.parse(await readFile(options.input, 'utf8'));
  const report = buildCloseoutReport(evidence);
  if (options.markdown && !options.json) console.log(renderCloseoutMarkdown(report));
  else console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`closeout-release-report: ${error.message}`);
    process.exit(2);
  });
}
