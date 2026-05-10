#!/usr/bin/env node
// Broker terminal-outbox preflight for receipt-gated smoke readiness.
// This script is intentionally read-only: it checks /health and polls/replays
// terminal-outbox state, but it never calls the ACK endpoint or any notifier.

import process from 'node:process';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8787';
const DEFAULT_LIMIT = 5;
const REQUESTER_ID = 'terminal-outbox-preflight';

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

  const limitRaw = readOption('--limit') ?? process.env.TERMINAL_OUTBOX_PREFLIGHT_LIMIT;
  const limit = limitRaw === undefined ? DEFAULT_LIMIT : Number(limitRaw);

  return {
    baseUrl: readOption('--base-url') ?? process.env.BROKER_URL ?? DEFAULT_BASE_URL,
    edgeSecret: readOption('--edge-secret') ?? process.env.BROKER_EDGE_SECRET ?? process.env.EDGE_SECRET,
    afterId: readOption('--after-id') ?? process.env.TERMINAL_OUTBOX_AFTER_ID,
    limit: Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_LIMIT,
    json: argv.includes('--json'),
    noLive: argv.includes('--no-live') || argv.includes('--dry-run'),
  };
}

function buildHeaders(edgeSecret) {
  const headers = {
    'accept': 'application/json',
    'x-a2a-requester-id': REQUESTER_ID,
    'x-a2a-requester-role': 'operator',
  };
  if (edgeSecret) {
    headers['x-a2a-edge-secret'] = edgeSecret;
    // Older docs/examples used this spelling; include both to keep preflight
    // compatible with already-deployed protected brokers.
    headers['x-edge-secret'] = edgeSecret;
  }
  return headers;
}

function outboxUrl(baseUrl, { afterId, limit, reconcileUnacked }) {
  const url = new URL('/a2a/tasks/terminal-outbox', ensureTrailingSlash(baseUrl));
  url.searchParams.set('limit', String(limit));
  if (afterId) url.searchParams.set('after_id', afterId);
  if (reconcileUnacked) url.searchParams.set('reconcile_unacked', 'true');
  return url;
}

function ensureTrailingSlash(value) {
  return value.endsWith('/') ? value : `${value}/`;
}

async function readJsonResponse(fetchImpl, url, headers) {
  const response = await fetchImpl(url, { headers });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { parseError: true, preview: text.slice(0, 160) };
  }
  return { response, body };
}

function summarizeEvent(event) {
  const payload = event?.payload ?? {};
  return {
    id: typeof event?.id === 'string' ? event.id : null,
    status: typeof payload.status === 'string' ? payload.status : null,
    worker: typeof payload.worker === 'string' ? payload.worker : undefined,
    repo: typeof payload.repo === 'string' ? payload.repo : undefined,
    issue: Number.isInteger(payload.issue) ? payload.issue : undefined,
    taskBrief: typeof payload.taskBrief === 'string' ? payload.taskBrief : undefined,
    evidenceUrl: firstEvidenceUrl(payload) ?? undefined,
    ackStatus: typeof event?.ack?.status === 'string' ? event.ack.status : 'unacknowledged',
  };
}

function firstEvidenceUrl(payload) {
  for (const key of ['prUrl', 'doneUrl', 'blockUrl']) {
    const value = payload?.[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function containsUnsafeEvidenceUrl(event) {
  const payload = event?.payload ?? {};
  return ['prUrl', 'doneUrl', 'blockUrl'].some((key) => {
    const value = payload[key];
    return typeof value === 'string' && value.length > 0 && !/^https?:\/\//.test(value);
  });
}

function isReceiptConfirmed(event) {
  return event?.ack?.status === 'receipt_confirmed';
}

function terminalReadiness(body, { reconcile }) {
  const events = Array.isArray(body?.events) ? body.events : [];
  const unacked = events.filter((event) => !isReceiptConfirmed(event));
  const receiptConfirmed = events.filter(isReceiptConfirmed);
  const staleReceipt = events.filter((event) => event?.receipt?.status === 'stale');
  // Receipt-confirmed rows are already terminal from the operator-facing
  // delivery perspective. Keep them visible in readiness counts, but do not let
  // legacy compact rows with older payload shapes block a fresh preflight/canary
  // gate. Fresh/unacknowledged delivery candidates still fail closed below.
  const deliveryCandidates = unacked;
  const missingEvidence = deliveryCandidates.filter((event) => !firstEvidenceUrl(event?.payload));
  const missingWorker = deliveryCandidates.filter((event) => typeof event?.payload?.worker !== 'string' || event.payload.worker.length === 0);
  const missingTaskBrief = deliveryCandidates.filter((event) => typeof event?.payload?.taskBrief !== 'string' || event.payload.taskBrief.length === 0);
  const receiptConfirmedMissingTaskBrief = receiptConfirmed.filter((event) => typeof event?.payload?.taskBrief !== 'string' || event.payload.taskBrief.length === 0);
  const unsafeEvidence = events.filter(containsUnsafeEvidenceUrl);
  const replayCandidates = Number.isInteger(body?.reconciledUnacked) ? body.reconciledUnacked : 0;
  const blockers = [];
  if (unsafeEvidence.length > 0) blockers.push(`unsafe/non-HTTP evidence URLs=${unsafeEvidence.length}`);
  if (missingEvidence.length > 0) blockers.push(`missing PR/Done/Block evidence=${missingEvidence.length}`);
  if (missingWorker.length > 0) blockers.push(`missing worker=${missingWorker.length}`);
  if (missingTaskBrief.length > 0) blockers.push(`missing task brief=${missingTaskBrief.length}`);
  const staleCursorOrReplayCandidates = reconcile ? replayCandidates + staleReceipt.length : staleReceipt.length;
  return {
    unackedCount: unacked.length,
    receiptConfirmedCount: receiptConfirmed.length,
    staleCursorOrReplayCandidates,
    missingEvidenceCount: missingEvidence.length,
    missingWorkerCount: missingWorker.length,
    missingTaskBriefCount: missingTaskBrief.length,
    receiptConfirmedMissingTaskBriefCount: receiptConfirmedMissingTaskBrief.length,
    unsafeEvidenceUrlCount: unsafeEvidence.length,
    blockers,
  };
}

function evaluateHealth(body, status) {
  if (status !== 200) return fail('broker health', `expected HTTP 200, got ${status}`);
  if (body?.ok === true || body?.status === 'ok') {
    const persistence = body.persistence?.kind ? `; persistence=${body.persistence.kind}` : '';
    const edge = body.requestSecurity?.edgeSecretRequired === true ? '; edge secret required' : '';
    return ok('broker health', `healthy${persistence}${edge}`);
  }
  return fail('broker health', 'health payload did not report ok');
}

function evaluateOutbox(body, status, { reconcile }) {
  const label = reconcile ? 'terminal-outbox replay' : 'terminal-outbox poll';
  if (status !== 200) return fail(label, `expected HTTP 200, got ${status}`);
  if (body?.kind !== 'task.terminal.outbox') return fail(label, 'unexpected outbox kind');
  if (!Array.isArray(body.events)) return fail(label, 'outbox events must be an array');
  const readiness = terminalReadiness(body, { reconcile });
  const unsafe = body.events.filter(containsUnsafeEvidenceUrl).map((event) => event.id ?? '<missing-id>');
  if (unsafe.length > 0) return fail(label, `found non-HTTP evidence URLs in ${unsafe.join(', ')}`, { readiness });
  const missingIds = body.events.filter((event) => typeof event?.id !== 'string' || event.id.length === 0).length;
  if (missingIds > 0) return fail(label, `${missingIds} event(s) missing stable id`, { readiness });
  if (readiness.blockers.length > 0) return fail(label, `terminal readiness blocked: ${readiness.blockers.join('; ')}`, { readiness });

  const summaries = body.events.map(summarizeEvent);
  const count = Number.isInteger(body.count) ? body.count : body.events.length;
  const replayNote = reconcile && Number.isInteger(body.reconciledUnacked)
    ? `; reconciledUnacked=${body.reconciledUnacked}`
    : '';
  const readyNote = `; readiness unacked=${readiness.unackedCount}, receiptConfirmed=${readiness.receiptConfirmedCount}, staleReplay=${readiness.staleCursorOrReplayCandidates}`;
  return ok(label, `${count} event(s), cursor=${body.cursor ?? 'null'}${replayNote}${readyNote}`, { count, cursor: body.cursor ?? null, events: summaries, readiness });
}

function sampleNoLiveOutboxBody() {
  return {
    kind: 'task.terminal.outbox',
    count: 1,
    cursor: 'terminal:no-live-task:succeeded:2026-05-04T00%3A00%3A00.000Z',
    events: [{
      id: 'terminal:no-live-task:succeeded:2026-05-04T00%3A00%3A00.000Z',
      kind: 'task.terminal',
      taskEventId: 1,
      createdAt: '2026-05-04T00:00:00.000Z',
      attempts: 0,
      receipt: { status: 'accepted', updatedAt: '2026-05-04T00:00:00.000Z' },
      payload: {
        taskId: 'no-live-task',
        status: 'succeeded',
        run: 'release-dryrun',
        worker: 'sogyo',
        repo: 'jinwon-int/a2a-broker',
        issue: 318,
        taskBrief: 'broker terminal payload no-live proof',
        doneUrl: 'https://github.com/jinwon-int/a2a-broker/issues/318#issuecomment-example',
        testSummary: 'synthetic broker payload; no provider call; no terminal ACK',
        createdAt: '2026-05-04T00:00:00.000Z',
        updatedAt: '2026-05-04T00:00:00.000Z',
        completedAt: '2026-05-04T00:00:00.000Z',
      },
    }],
  };
}

export function runNoLiveProof(options = {}) {
  const body = options.body ?? sampleNoLiveOutboxBody();
  const poll = evaluateOutbox(body, 200, { reconcile: false });
  const replay = evaluateOutbox({ ...body, reconciledUnacked: body.events?.length ?? 0 }, 200, { reconcile: true });
  const terminalPreviews = Array.isArray(body.events)
    ? body.events.map((event) => ({
        dryRun: true,
        wouldSendTo: 'operator-terminal-notifier',
        cursor: event.id,
        status: event.payload?.status,
        worker: event.payload?.worker,
        repo: event.payload?.repo,
        issue: event.payload?.issue,
        prUrl: event.payload?.prUrl,
        doneUrl: event.payload?.doneUrl,
        blockUrl: event.payload?.blockUrl,
        testSummary: event.payload?.testSummary,
      }))
    : [];
  const checks = [
    ok('run mode', 'no-live proof; no broker HTTP request, deploy, Gateway restart, Telegram send, DB mutation, or terminal ACK attempted'),
    poll,
    replay,
    ok('terminal payload dry-run', `${terminalPreviews.length} notifier preview(s); providerCalled=false; productionAckAttempted=false`, { terminalPreviews }),
    ok('ack safety', 'read-only synthetic proof only; no terminal-outbox ACK or notifier send attempted'),
  ];
  return {
    kind: 'terminal-outbox.no-live-proof',
    mode: 'no-live',
    providerCalled: false,
    productionAckAttempted: false,
    brokerHttpRequested: false,
    limit: options.limit ?? DEFAULT_LIMIT,
    checks,
    ok: checks.every((check) => check.ok),
  };
}

export async function runPreflight(options = {}) {
  if (options.noLive) return runNoLiveProof(options);

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('fetch is not available in this Node runtime');

  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const limit = options.limit ?? DEFAULT_LIMIT;
  const headers = buildHeaders(options.edgeSecret);
  const checks = [];

  const health = await readJsonResponse(fetchImpl, new URL('/health', ensureTrailingSlash(baseUrl)), headers);
  checks.push(evaluateHealth(health.body, health.response.status));

  const first = await readJsonResponse(fetchImpl, outboxUrl(baseUrl, { afterId: options.afterId, limit }), headers);
  const firstCheck = evaluateOutbox(first.body, first.response.status, { reconcile: false });
  checks.push(firstCheck);

  const replayAfterId = options.afterId ?? first.body?.cursor ?? undefined;
  const replay = await readJsonResponse(fetchImpl, outboxUrl(baseUrl, { afterId: replayAfterId, limit, reconcileUnacked: true }), headers);
  checks.push(evaluateOutbox(replay.body, replay.response.status, { reconcile: true }));

  checks.push(ok('ack safety', 'read-only preflight only; no terminal-outbox ACK or notifier send attempted'));
  return {
    kind: 'terminal-outbox.preflight',
    baseUrl,
    afterId: options.afterId ?? null,
    limit,
    checks,
    ok: checks.every((check) => check.ok),
  };
}

function printHuman(report) {
  console.log('A2A Broker terminal-outbox preflight (read-only)');
  for (const check of report.checks) {
    console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.check}: ${check.detail}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await runPreflight(options);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHuman(report);
  }
  process.exit(report.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`fatal: ${error.message}`);
    process.exit(2);
  });
}
