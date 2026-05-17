#!/usr/bin/env node
// Broker live-readiness canary gate for release dry-runs.
// Read-only by design: it only performs safe GET requests in live mode and uses
// synthetic fixtures in --no-live mode. It never deploys, restarts Gateway, sends
// Telegram, mutates broker/DB state, or ACKs terminal-outbox records.

import process from 'node:process';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8787';
const DEFAULT_LIMIT = 25;
const REQUESTER_ID = 'broker-live-readiness-canary';
const PARENT_ISSUE = '#294';
const ISSUE = '#334';

const RECEIPT_STATUSES = new Set([
  'accepted',
  'started',
  'produced',
  'sent',
  'provider_sent',
  'provider_accepted',
  'operator_visible',
  'timed_out',
  'stale',
  'failed',
]);
const RECEIPT_ACK_EVIDENCE = new Set([
  'operator_visible',
  'operator_confirmed',
  'provider_delivery_receipt',
]);
const MANUAL_RECEIPT_ACK_EVIDENCE = new Set([
  'operator_visible',
  'operator_confirmed',
]);

function ok(check, detail, extra = {}) {
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
  const limitRaw = readOption('--limit') ?? process.env.BROKER_LIVE_READINESS_LIMIT;
  const limit = Number(limitRaw ?? DEFAULT_LIMIT);
  return {
    baseUrl: readOption('--base-url') ?? process.env.BROKER_URL ?? DEFAULT_BASE_URL,
    edgeSecret: readOption('--edge-secret') ?? process.env.BROKER_EDGE_SECRET ?? process.env.EDGE_SECRET,
    noLive: argv.includes('--no-live') || argv.includes('--dry-run'),
    markdown: argv.includes('--markdown') || argv.includes('--format=markdown'),
    json: argv.includes('--json') || argv.includes('--format=json'),
    limit: Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_LIMIT,
  };
}

function ensureTrailingSlash(value) {
  return value.endsWith('/') ? value : `${value}/`;
}

function buildHeaders(edgeSecret) {
  const headers = {
    accept: 'application/json',
    'x-a2a-requester-id': REQUESTER_ID,
    'x-a2a-requester-role': 'operator',
  };
  if (edgeSecret) {
    headers['x-a2a-edge-secret'] = edgeSecret;
    headers['x-edge-secret'] = edgeSecret;
  }
  return headers;
}

async function readJsonResponse(fetchImpl, baseUrl, path, headers) {
  const url = new URL(path, ensureTrailingSlash(baseUrl));
  const response = await fetchImpl(url, { method: 'GET', headers });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { parseError: true, preview: text.slice(0, 160) };
  }
  return { status: response.status, body };
}

function isHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//.test(value);
}

export function hasCanonicalEvidence(output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return false;
  const github = output.github;
  if (github && typeof github === 'object' && !Array.isArray(github)) {
    if (isHttpUrl(github.prUrl) || isHttpUrl(github.doneCommentUrl) || isHttpUrl(github.blockCommentUrl)) return true;
  }
  return isHttpUrl(output.prUrl) || isHttpUrl(output.doneCommentUrl) || isHttpUrl(output.blockCommentUrl);
}

export function validateReceiptFields(output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return [];
  const receipt = output.receipt && typeof output.receipt === 'object' && !Array.isArray(output.receipt)
    ? output.receipt
    : undefined;
  const status = receipt?.status ?? output.receiptStatus;
  const evidence = receipt?.evidence ?? output.receiptEvidence;
  const blockers = [];
  if (status !== undefined && !(typeof status === 'string' && RECEIPT_STATUSES.has(status))) {
    blockers.push(`invalid receipt status: ${typeof status === 'string' ? status.slice(0, 80) : typeof status}`);
  }
  if (evidence !== undefined && !(typeof evidence === 'string' && RECEIPT_ACK_EVIDENCE.has(evidence))) {
    blockers.push(`invalid receipt evidence: ${typeof evidence === 'string' ? evidence.slice(0, 80) : typeof evidence}`);
  }
  return blockers;
}

function firstEvidenceUrl(payload) {
  for (const key of ['prUrl', 'doneUrl', 'blockUrl']) {
    const value = payload?.[key];
    if (isHttpUrl(value)) return value;
  }
  const github = payload?.github;
  if (github && typeof github === 'object') {
    for (const key of ['prUrl', 'doneCommentUrl', 'blockCommentUrl']) {
      const value = github[key];
      if (isHttpUrl(value)) return value;
    }
  }
  return null;
}

function healthRevision(body) {
  const build = body?.build;
  if (build && typeof build === 'object' && !Array.isArray(build)) {
    return build.revision ?? build.version ?? build.tag ?? null;
  }
  return build ?? body?.revision ?? body?.version ?? null;
}

function evaluateHealth(body, status) {
  if (status !== 200) return fail('health revision', `expected HTTP 200, got ${status}`);
  if (!(body?.ok === true || body?.status === 'ok')) return fail('health revision', 'health payload did not report ok');
  const revision = healthRevision(body);
  if (!revision) return fail('health revision', 'missing build/version revision in /health payload');
  return ok('health revision', `healthy revision=${revision}`, {
    service: body.service ?? null,
    version: body.version ?? null,
    build: body.build ?? null,
    persistence: body.persistence?.kind ?? null,
  });
}

function workerItems(body) {
  if (Array.isArray(body?.items)) return body.items;
  if (Array.isArray(body?.workers)) return body.workers;
  if (Array.isArray(body?.byNode)) return body.byNode;
  if (Array.isArray(body?.workers?.byNode)) return body.workers.byNode;
  return [];
}

function evaluateWorkers(body, status, expectedWorkers = []) {
  if (status !== 200) return fail('online worker matrix', `expected HTTP 200, got ${status}`);
  const items = workerItems(body);
  const online = items.filter((item) => item?.status === 'online' || item?.online === true || item?.isOnline === true);
  const onlineIds = online.map((item) => item.nodeId ?? item.id).filter(Boolean).sort();
  const missing = expectedWorkers.filter((id) => !onlineIds.includes(id));
  if (expectedWorkers.length > 0 && missing.length > 0) {
    return fail('online worker matrix', `missing online worker(s): ${missing.join(', ')}`, { onlineIds, expectedWorkers });
  }
  if (items.length === 0) return fail('online worker matrix', 'no worker rows returned');
  return ok('online worker matrix', `${online.length}/${items.length} worker(s) online`, { onlineIds, totalWorkers: items.length });
}

function statusCountsFromDiagnostics(body) {
  const byStatus = body?.tasks?.byStatus ?? body?.byStatus ?? {};
  const items = Array.isArray(body?.items) ? body.items : Array.isArray(body?.tasks) ? body.tasks : [];
  const countStatus = (status) => Number(byStatus?.[status] ?? items.filter((item) => item?.status === status).length ?? 0);
  return {
    queued: countStatus('queued'),
    claimed: countStatus('claimed'),
    running: countStatus('running'),
    stale: Number(body?.tasks?.stale ?? body?.stale ?? items.filter((item) => item?.diagnosticStatus === 'stale' || item?.status === 'stale').length ?? 0),
  };
}

function evaluateTerminalOutboxDiagnostics(body, status) {
  if (status !== 200) return fail('terminal-outbox backlog diagnostic', `expected HTTP 200, got ${status}`);
  const diagnostics = body?.terminalOutboxDiagnostics;
  if (!diagnostics || typeof diagnostics !== 'object') {
    return ok('terminal-outbox backlog diagnostic', 'health payload has no terminal-outbox diagnostics; skipped');
  }
  const total = Number(diagnostics.total ?? 0);
  const acked = Number(diagnostics.acked ?? 0);
  const unacked = Number(diagnostics.unacked ?? 0);
  const oldestUnackedCreatedAt = diagnostics.oldestUnackedCreatedAt ?? null;
  const warnings = Array.isArray(diagnostics.warnings) ? diagnostics.warnings : [];
  const detail = `total=${total}, acked=${acked}, unacked=${unacked}${oldestUnackedCreatedAt ? `, oldestUnacked=${oldestUnackedCreatedAt}` : ''}`;
  if (unacked > 0) {
    return fail('terminal-outbox backlog diagnostic', `${detail}; live canary must stay blocked until stale unacked rows are isolated, ACKed with approved evidence, or pruned under an approved plan`, {
      total,
      acked,
      unacked,
      oldestUnackedCreatedAt,
      warnings,
    });
  }
  return ok('terminal-outbox backlog diagnostic', detail, {
    total,
    acked,
    unacked,
    oldestUnackedCreatedAt,
    warnings,
  });
}

function evaluateQueue(body, status) {
  if (status !== 200) return fail('queue emptiness and stale tasks', `expected HTTP 200, got ${status}`);
  const counts = statusCountsFromDiagnostics(body);
  const blockers = [];
  if (counts.queued !== 0) blockers.push(`queued=${counts.queued}`);
  if (counts.claimed !== 0) blockers.push(`claimed=${counts.claimed}`);
  if (counts.running !== 0) blockers.push(`running=${counts.running}`);
  if (counts.stale !== 0) blockers.push(`stale=${counts.stale}`);
  if (blockers.length > 0) return fail('queue emptiness and stale tasks', `not empty: ${blockers.join(', ')}`, { counts });
  return ok('queue emptiness and stale tasks', 'queued=0, claimed=0, running=0, stale=0', { counts });
}

function manualReceiptSatisfied(event) {
  const ack = event?.ack;
  const receipt = event?.receipt ?? event?.payload?.receipt;
  const evidence = ack?.evidence ?? receipt?.evidence ?? event?.payload?.receiptEvidence;
  return ack?.status === 'receipt_confirmed'
    && receipt?.status === 'operator_visible'
    && MANUAL_RECEIPT_ACK_EVIDENCE.has(evidence);
}

function projectOneShotLiveEligibility(body, status) {
  if (status !== 200) return fail('one-shot live eligibility manual receipt gate', `expected HTTP 200, got ${status}`);
  const events = Array.isArray(body?.events) ? body.events : [];
  const readyEvents = events.filter(manualReceiptSatisfied);
  const blockedEvents = events.filter((event) => !manualReceiptSatisfied(event));
  return ok('one-shot live eligibility manual receipt gate', `${readyEvents.length} eligible, ${blockedEvents.length} blocked until manual receipt confirmation`, {
    oneShotLiveEligible: readyEvents.length > 0 && blockedEvents.length === 0,
    readyCount: readyEvents.length,
    blockedCount: blockedEvents.length,
    blockedEvents: blockedEvents.map((event) => ({
      id: event?.id ?? '<missing-id>',
      receiptStatus: event?.receipt?.status ?? event?.payload?.receipt?.status ?? event?.payload?.receiptStatus ?? null,
      ackStatus: event?.ack?.status ?? 'unacknowledged',
      ackEvidence: event?.ack?.evidence ?? event?.receipt?.evidence ?? event?.payload?.receipt?.evidence ?? event?.payload?.receiptEvidence ?? null,
    })),
  });
}

function oneShotEligibilityFromChecks(checks) {
  return checks.find((check) => check.check === 'one-shot live eligibility manual receipt gate') ?? {};
}

function receiptConfirmed(event) {
  return event?.ack?.status === 'receipt_confirmed';
}

function summarizeOutboxEvent(event) {
  const payload = event?.payload ?? event?.output ?? {};
  return {
    id: typeof event?.id === 'string' ? event.id : null,
    worker: typeof payload.worker === 'string' ? payload.worker : undefined,
    issue: Number.isInteger(payload.issue) ? payload.issue : undefined,
    status: typeof payload.status === 'string' ? payload.status : undefined,
    evidenceUrl: firstEvidenceUrl(payload) ?? undefined,
  };
}

export function evaluateEvidenceAcceptance(body, status) {
  if (status !== 200) return fail('canonical PR/Done/Block evidence acceptance', `expected HTTP 200, got ${status}`);
  const events = Array.isArray(body?.events) ? body.events : [];
  const blockers = [];
  const legacyReceiptConfirmedWithoutEvidence = [];
  const acceptedEvents = [];
  for (const event of events) {
    const payload = event?.payload ?? event?.output ?? {};
    const evidenceUrl = firstEvidenceUrl(payload);
    if (!evidenceUrl) {
      if (receiptConfirmed(event)) {
        legacyReceiptConfirmedWithoutEvidence.push(event?.id ?? '<missing-id>');
      } else {
        blockers.push(`${event?.id ?? '<missing-id>'}: missing canonical HTTP PR/Done/Block evidence`);
      }
    } else {
      acceptedEvents.push(event);
    }
    blockers.push(...validateReceiptFields(payload).map((reason) => `${event?.id ?? '<missing-id>'}: ${reason}`));
  }
  if (blockers.length > 0) return fail('canonical PR/Done/Block evidence acceptance', blockers.join('; '), { eventCount: events.length });
  const legacySuffix = legacyReceiptConfirmedWithoutEvidence.length > 0
    ? `; ${legacyReceiptConfirmedWithoutEvidence.length} receipt-confirmed legacy row(s) without evidence classified non-blocking`
    : '';
  return ok('canonical PR/Done/Block evidence acceptance', `${acceptedEvents.length}/${events.length} terminal event(s) carry canonical evidence${legacySuffix}`, {
    eventCount: events.length,
    acceptedCount: acceptedEvents.length,
    legacyReceiptConfirmedWithoutEvidenceCount: legacyReceiptConfirmedWithoutEvidence.length,
    legacyReceiptConfirmedWithoutEvidence: legacyReceiptConfirmedWithoutEvidence.slice(0, 20),
    events: events.map(summarizeOutboxEvent),
  });
}

function evaluateGithubVerifyDoneRegression() {
  const output = {
    github: {
      doneCommentUrl: 'https://github.com/jinwon-int/a2a-broker/issues/330#issuecomment-github-verify-done',
    },
    receipt: { status: 'operator_visible', evidence: 'operator_visible' },
  };
  const blockers = [];
  if (!hasCanonicalEvidence(output)) blockers.push('nested github.doneCommentUrl was not accepted');
  blockers.push(...validateReceiptFields(output));
  if (blockers.length > 0) return fail('github-verify Done evidence regression', blockers.join('; '));
  return ok('github-verify Done evidence regression', '#330 nested github.doneCommentUrl plus operator_visible receipt accepted', {
    sourceIssue: 330,
    evidenceUrl: output.github.doneCommentUrl,
  });
}

function sampleNoLivePayload() {
  return {
    health: {
      status: 200,
      body: { ok: true, service: 'a2a-broker', version: '0.1.0', build: 'no-live-canary', persistence: { kind: 'sqlite' } },
    },
    workers: {
      status: 200,
      body: { items: [
        { nodeId: 'bangtong', status: 'online' },
        { nodeId: 'dungae', status: 'online' },
        { nodeId: 'sogyo', status: 'online' },
        { nodeId: 'nosuk', status: 'online' },
        { nodeId: 'yukson', status: 'online' },
      ] },
    },
    diagnostics: {
      status: 200,
      body: { tasks: { byStatus: { queued: 0, claimed: 0, running: 0 }, stale: 0 } },
    },
    outbox: {
      status: 200,
      body: {
        kind: 'task.terminal.outbox',
        count: 3,
        events: [
          { id: 'terminal-pr', payload: { worker: 'sogyo', status: 'succeeded', issue: 334, prUrl: 'https://github.com/jinwon-int/a2a-broker/pull/334', receipt: { status: 'operator_visible', evidence: 'operator_visible' } } },
          { id: 'terminal-done', payload: { worker: 'sogyo', status: 'succeeded', issue: 330, doneUrl: 'https://github.com/jinwon-int/a2a-broker/issues/330#issuecomment-github-verify-done', receiptStatus: 'accepted' } },
          { id: 'terminal-block', payload: { worker: 'sogyo', status: 'blocked', issue: 334, blockUrl: 'https://github.com/jinwon-int/a2a-broker/issues/334#issuecomment-block', receipt: { status: 'failed' } } },
        ],
      },
    },
  };
}

export function runNoLiveCanary(options = {}) {
  const sample = options.sample ?? sampleNoLivePayload();
  const checks = [
    ok('run mode', 'no-live synthetic proof; no broker HTTP request, deploy, Gateway restart, Telegram send, DB mutation, or terminal ACK attempted'),
    evaluateHealth(sample.health.body, sample.health.status),
    evaluateTerminalOutboxDiagnostics(sample.health.body, sample.health.status),
    evaluateWorkers(sample.workers.body, sample.workers.status, options.expectedWorkers ?? ['bangtong', 'dungae', 'sogyo', 'nosuk', 'yukson']),
    evaluateQueue(sample.diagnostics.body, sample.diagnostics.status),
    evaluateEvidenceAcceptance(sample.outbox.body, sample.outbox.status),
    projectOneShotLiveEligibility(sample.outbox.body, sample.outbox.status),
    evaluateGithubVerifyDoneRegression(),
    ok('safety gate', 'read-only validation only; no live Telegram send, DB mutation, production deploy, Gateway restart, or real terminal-outbox ACK'),
  ];
  return {
    kind: 'broker.live-readiness-canary',
    mode: 'no-live',
    issue: ISSUE,
    parent: PARENT_ISSUE,
    brokerHttpRequested: false,
    providerCalled: false,
    dbMutationAttempted: false,
    terminalAckAttempted: false,
    oneShotLiveEligible: oneShotEligibilityFromChecks(checks).oneShotLiveEligible ?? false,
    blockedCount: oneShotEligibilityFromChecks(checks).blockedCount ?? 0,
    checks,
    ok: checks.every((check) => check.ok),
  };
}

export async function runLiveReadinessCanary(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('fetch is not available in this Node runtime');
  const headers = buildHeaders(options.edgeSecret);
  const [health, workers, diagnostics, outbox] = await Promise.all([
    readJsonResponse(fetchImpl, options.baseUrl ?? DEFAULT_BASE_URL, '/health', headers),
    readJsonResponse(fetchImpl, options.baseUrl ?? DEFAULT_BASE_URL, '/workers', headers),
    readJsonResponse(fetchImpl, options.baseUrl ?? DEFAULT_BASE_URL, '/tasks/diagnostics', headers),
    readJsonResponse(fetchImpl, options.baseUrl ?? DEFAULT_BASE_URL, `/a2a/tasks/terminal-outbox?limit=${options.limit ?? DEFAULT_LIMIT}`, headers),
  ]);
  const checks = [
    evaluateHealth(health.body, health.status),
    evaluateTerminalOutboxDiagnostics(health.body, health.status),
    evaluateWorkers(workers.body, workers.status, options.expectedWorkers ?? []),
    evaluateQueue(diagnostics.body, diagnostics.status),
    evaluateEvidenceAcceptance(outbox.body, outbox.status),
    projectOneShotLiveEligibility(outbox.body, outbox.status),
    evaluateGithubVerifyDoneRegression(),
    ok('safety gate', 'read-only GET validation only; no live Telegram send, DB mutation, production deploy, Gateway restart, or real terminal-outbox ACK'),
  ];
  return {
    kind: 'broker.live-readiness-canary',
    mode: 'read-only-live',
    issue: ISSUE,
    parent: PARENT_ISSUE,
    baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
    brokerHttpRequested: true,
    providerCalled: false,
    dbMutationAttempted: false,
    terminalAckAttempted: false,
    oneShotLiveEligible: oneShotEligibilityFromChecks(checks).oneShotLiveEligible ?? false,
    blockedCount: oneShotEligibilityFromChecks(checks).blockedCount ?? 0,
    checks,
    ok: checks.every((check) => check.ok),
  };
}

export async function runCanary(options = {}) {
  return options.noLive ? runNoLiveCanary(options) : runLiveReadinessCanary(options);
}

function renderMarkdown(report) {
  const title = report.ok ? 'Done' : 'Block';
  const lines = [
    `${title}: ${ISSUE} broker live-readiness canary gate`,
    '',
    `Parent: ${PARENT_ISSUE}`,
    `Mode: ${report.mode}`,
    '',
    'Focused validation:',
    ...report.checks.map((check) => `- ${check.ok ? 'PASS' : 'FAIL'} ${check.check}: ${check.detail}`),
    '',
    'Safety:',
    `- broker HTTP requested: ${report.brokerHttpRequested ? 'yes (GET only)' : 'no'}`,
    `- provider/live Telegram called: ${report.providerCalled ? 'yes' : 'no'}`,
    `- DB mutation attempted: ${report.dbMutationAttempted ? 'yes' : 'no'}`,
    `- terminal-outbox ACK attempted: ${report.terminalAckAttempted ? 'yes' : 'no'}`,
  ];
  return lines.join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await runCanary(options);
  if (options.markdown && !options.json) {
    console.log(renderMarkdown(report));
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
  process.exit(report.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`broker-live-readiness-canary: ${error.message}`);
    process.exit(2);
  });
}
