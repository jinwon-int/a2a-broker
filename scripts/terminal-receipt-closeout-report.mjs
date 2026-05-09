#!/usr/bin/env node
// Read-only terminal-outbox receipt closeout report.
// Opens the broker SQLite DB read-only and prints operator-safe current vs legacy
// receipt gaps. It never emits raw terminal payloads, sends notifications, or ACKs rows.

import process from 'node:process';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

const DEFAULT_MAX_UNACKED_AGE_MS = 15 * 60 * 1000;
const SAFE_ACK_EVIDENCE = new Set(['current_session_visible', 'operator_visible', 'operator_confirmed', 'provider_delivery_receipt']);

const terminalAckSchema = z.object({
  status: z.literal('receipt_confirmed'),
  evidence: z.enum(['current_session_visible', 'operator_visible', 'operator_confirmed', 'provider_delivery_receipt']),
  acknowledgedAt: z.string(),
  receiptId: z.string().optional(),
  note: z.string().optional(),
}).passthrough();

const terminalOutboxSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('task.terminal'),
  taskEventId: z.number().int().nonnegative(),
  payload: z.object({
    taskId: z.string().min(1),
    status: z.enum(['succeeded', 'failed', 'canceled', 'blocked']),
    createdAt: z.string(),
    updatedAt: z.string(),
  }).passthrough(),
  createdAt: z.string(),
  ack: z.unknown().optional(),
  receipt: z.object({
    status: z.string().min(1),
    updatedAt: z.string().optional(),
    evidence: z.string().optional(),
    receiptId: z.string().optional(),
  }).passthrough().optional(),
  deliveredAt: z.string().optional(),
  attempts: z.number().int().nonnegative().optional(),
}).passthrough();

function ok(detail, extra = {}) {
  return { ok: true, detail, ...extra };
}

function fail(detail, extra = {}) {
  return { ok: false, detail, ...extra };
}

function parseArgs(argv) {
  const readOption = (name) => {
    const prefix = `${name}=`;
    const inline = argv.find((arg) => arg.startsWith(prefix));
    if (inline) return inline.slice(prefix.length);
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const nowRaw = readOption('--now-ms');
  const maxAgeRaw = readOption('--max-unacked-age-ms') ?? process.env.TERMINAL_RECEIPT_REPORT_MAX_UNACKED_AGE_MS;
  const legacyResidueCutoffRaw = readOption('--legacy-residue-cutoff') ?? process.env.TERMINAL_RECEIPT_REPORT_LEGACY_RESIDUE_CUTOFF;
  const legacyResidueCutoffMs = legacyResidueCutoffRaw === undefined ? null : Date.parse(legacyResidueCutoffRaw);
  const maxUnackedAgeMs = maxAgeRaw === undefined ? DEFAULT_MAX_UNACKED_AGE_MS : Number(maxAgeRaw);
  return {
    dbFile: readOption('--db') ?? process.env.BROKER_SQLITE_FILE ?? process.env.SQLITE_STATE_FILE,
    json: argv.includes('--json'),
    markdown: argv.includes('--markdown') || argv.includes('--md'),
    compact: argv.includes('--compact') || argv.includes('--telegram'),
    telegram: argv.includes('--telegram'),
    nowMs: nowRaw === undefined ? Date.now() : Number(nowRaw),
    maxUnackedAgeMs: Number.isFinite(maxUnackedAgeMs) && maxUnackedAgeMs >= 0 ? maxUnackedAgeMs : DEFAULT_MAX_UNACKED_AGE_MS,
    legacyResidueCutoff: Number.isFinite(legacyResidueCutoffMs) ? new Date(legacyResidueCutoffMs).toISOString() : null,
    legacyResidueCutoffMs: Number.isFinite(legacyResidueCutoffMs) ? legacyResidueCutoffMs : null,
  };
}

function sanitizeDiagnosticValue(value) {
  if (typeof value !== 'string') return '<non-string>';
  return value
    .replace(/\b(?:ghp|gho|ghu|ghs|github_pat|sk|xox[abp])-[-_A-Za-z0-9]+\b/g, '[redacted]')
    .replace(/\b(token|secret|password|api[_-]?key)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(/(^|\s)(?:[A-Za-z]:)?\/[\w./-]+/g, '$1[path]')
    .slice(0, 160);
}

function zodMessage(error) {
  const first = error.issues?.[0];
  if (!first) return 'schema validation failed';
  const path = first.path.length > 0 ? `${first.path.join('.')}: ` : '';
  return sanitizeDiagnosticValue(`${path}${first.message}`);
}

function tableExists(db, table) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  return Boolean(row?.name);
}

function parseJsonPayload(payload) {
  if (typeof payload !== 'string') return { success: false, error: 'payload is not a string' };
  try {
    const value = JSON.parse(payload);
    const parsed = terminalOutboxSchema.safeParse(value);
    return parsed.success ? { success: true, data: parsed.data } : { success: false, error: zodMessage(parsed.error) };
  } catch (error) {
    return { success: false, error: sanitizeDiagnosticValue(error instanceof Error ? error.message : String(error)) };
  }
}

function isReceiptConfirmed(event) {
  const parsed = terminalAckSchema.safeParse(event?.ack);
  return parsed.success && parsed.data.status === 'receipt_confirmed' && SAFE_ACK_EVIDENCE.has(parsed.data.evidence);
}

function receiptStateFor(event, row) {
  if (!event) return 'invalid_payload';
  const ackParsed = terminalAckSchema.safeParse(event.ack);
  if (ackParsed.success) return `ack:${ackParsed.data.evidence}`;
  if (event.ack !== undefined) return 'invalid_ack';
  if (row.acknowledgedAt) return 'acknowledged_at_without_receipt_ack';
  const receiptStatus = typeof event.receipt?.status === 'string' ? event.receipt.status : 'missing_receipt_state';
  if (event.deliveredAt) return `legacy_delivered_at:${receiptStatus}`;
  return `unacked:${receiptStatus}`;
}

function remediationHint({ event, row, stale, payloadError }) {
  if (payloadError) return 'repair/replace malformed hot-table row from source-of-truth evidence; do not forge ACK';
  if (event?.ack !== undefined && !isReceiptConfirmed(event)) return 'replace invalid/provider-send-only ACK with real operator-visible/provider-delivery receipt evidence, or clear and replay safely';
  if (row.acknowledgedAt && !event?.ack) return 'investigate legacy acknowledged_at cursor; add real receipt evidence only if independently verified';
  if (!stale) return 'still within replay window; monitor before ACK action';
  if (event?.receipt?.status === 'provider_sent' || event?.receipt?.status === 'provider_accepted') return 'confirm operator-visible/provider-delivery receipt before ACK; provider send success alone is insufficient';
  if (event?.receipt?.status === 'failed' || event?.receipt?.status === 'timed_out' || event?.receipt?.status === 'stale') return 'replay/remediate notifier path, then ACK only with confirmed receipt evidence';
  return 'obtain operator-visible/provider-delivery receipt evidence or remediate/replay notifier path before ACK';
}

function ageParts(nowMs, createdAt) {
  const createdMs = Date.parse(createdAt ?? '');
  if (!Number.isFinite(createdMs) || !Number.isFinite(nowMs)) return { ageMs: null, age: 'unknown', stale: true };
  const ageMs = Math.max(0, nowMs - createdMs);
  return { ageMs, age: formatDuration(ageMs), stale: false };
}

function formatDuration(ms) {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  if (hours < 48) return remMinutes === 0 ? `${hours}h` : `${hours}h ${remMinutes}m`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours === 0 ? `${days}d` : `${days}d ${remHours}h`;
}

function classifyGap(row, event, options, payloadError = null) {
  const createdAt = typeof row.createdAt === 'string' ? row.createdAt : event?.createdAt;
  const createdMs = Date.parse(createdAt ?? '');
  const age = ageParts(options.nowMs, createdAt);
  const stale = payloadError ? true : !Number.isFinite(age.ageMs) || age.ageMs > options.maxUnackedAgeMs;
  const base = {
    terminalEventId: sanitizeDiagnosticValue(row.id ?? event?.id ?? '<missing-id>'),
    taskEventId: Number.isInteger(row.taskEventId) ? row.taskEventId : event?.taskEventId ?? null,
    taskId: event?.payload?.taskId ? sanitizeDiagnosticValue(event.payload.taskId) : null,
    status: event?.payload?.status ?? null,
    createdAt: createdAt ?? null,
    ageMs: age.ageMs,
    age: age.age,
    receiptState: payloadError ? 'invalid_payload' : receiptStateFor(event, row),
    remediationHint: remediationHint({ event, row, stale, payloadError }),
  };
  const isLegacyResidue = Number.isFinite(options.legacyResidueCutoffMs) && Number.isFinite(createdMs) && createdMs < options.legacyResidueCutoffMs;
  return { ...base, group: isLegacyResidue ? 'legacyResidue' : 'currentPostCutoff' };
}

function buildSummary({ rows, confirmed, currentPostCutoff, legacyResidue, options }) {
  return {
    totalRows: rows,
    receiptConfirmedRows: confirmed,
    currentPostCutoffGapCount: currentPostCutoff.length,
    legacyResidueGapCount: legacyResidue.length,
    legacyResidueCutoff: options.legacyResidueCutoff ?? null,
    maxUnackedAgeMs: options.maxUnackedAgeMs,
  };
}

export function runTerminalReceiptCloseoutReport(rawOptions = {}) {
  const options = {
    nowMs: rawOptions.nowMs ?? Date.now(),
    maxUnackedAgeMs: rawOptions.maxUnackedAgeMs ?? DEFAULT_MAX_UNACKED_AGE_MS,
    legacyResidueCutoffMs: Number.isFinite(rawOptions.legacyResidueCutoffMs) ? rawOptions.legacyResidueCutoffMs : Date.parse(rawOptions.legacyResidueCutoff ?? ''),
    legacyResidueCutoff: rawOptions.legacyResidueCutoff ?? null,
    dbFile: rawOptions.dbFile,
  };
  if (Number.isFinite(options.legacyResidueCutoffMs)) options.legacyResidueCutoff = new Date(options.legacyResidueCutoffMs).toISOString();
  else options.legacyResidueCutoffMs = null;

  if (!options.dbFile) {
    return { kind: 'broker.terminal-receipt-closeout-report', ok: false, dbFile: null, check: fail('missing SQLite DB path; provide --db or BROKER_SQLITE_FILE') };
  }
  if (!existsSync(options.dbFile)) {
    return { kind: 'broker.terminal-receipt-closeout-report', ok: false, dbFile: sanitizeDiagnosticValue(options.dbFile), check: fail('SQLite DB path does not exist') };
  }

  const db = new DatabaseSync(options.dbFile, { readOnly: true });
  try {
    if (!tableExists(db, 'broker_terminal_outbox')) {
      return { kind: 'broker.terminal-receipt-closeout-report', ok: false, dbFile: sanitizeDiagnosticValue(options.dbFile), check: fail('broker_terminal_outbox table missing') };
    }

    const currentPostCutoff = [];
    const legacyResidue = [];
    let confirmed = 0;
    const rows = db.prepare('SELECT id, task_event_id AS taskEventId, acknowledged_at AS acknowledgedAt, created_at AS createdAt, payload FROM broker_terminal_outbox ORDER BY created_at ASC, id ASC').all();
    for (const row of rows) {
      const parsed = parseJsonPayload(row.payload);
      if (!parsed.success) {
        const gap = classifyGap(row, null, options, parsed.error);
        gap.schemaError = parsed.error;
        (gap.group === 'legacyResidue' ? legacyResidue : currentPostCutoff).push(gap);
        continue;
      }
      if (isReceiptConfirmed(parsed.data)) {
        confirmed += 1;
        continue;
      }
      const gap = classifyGap(row, parsed.data, options);
      (gap.group === 'legacyResidue' ? legacyResidue : currentPostCutoff).push(gap);
    }

    const summary = buildSummary({ rows: rows.length, confirmed, currentPostCutoff, legacyResidue, options });
    const check = currentPostCutoff.length === 0
      ? ok(`no current post-cutoff terminal receipt gap(s); legacy residue=${legacyResidue.length}`)
      : fail(`${currentPostCutoff.length} current post-cutoff terminal receipt gap(s); legacy residue=${legacyResidue.length}`);
    return {
      kind: 'broker.terminal-receipt-closeout-report',
      ok: currentPostCutoff.length === 0,
      dbFile: sanitizeDiagnosticValue(options.dbFile),
      generatedAt: new Date(options.nowMs).toISOString(),
      summary,
      currentPostCutoff,
      legacyResidue,
      check,
      safety: {
        readOnly: true,
        rawPayloadsIncluded: false,
        notifierSendAttempted: false,
        terminalAckAttempted: false,
        dbMutationAttempted: false,
      },
    };
  } finally {
    db.close();
  }
}

function escapeCell(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function renderRows(title, rows) {
  const lines = [`### ${title}`, ''];
  if (rows.length === 0) {
    lines.push('_None._', '');
    return lines;
  }
  lines.push('| terminal event id | task event id | task id | status | age | receipt state | remediation hint |');
  lines.push('| --- | ---: | --- | --- | ---: | --- | --- |');
  for (const row of rows) {
    lines.push(`| ${escapeCell(row.terminalEventId)} | ${escapeCell(row.taskEventId)} | ${escapeCell(row.taskId)} | ${escapeCell(row.status)} | ${escapeCell(row.age)} | ${escapeCell(row.receiptState)} | ${escapeCell(row.remediationHint)} |`);
  }
  lines.push('');
  return lines;
}

export function renderMarkdown(report) {
  const lines = [
    '## A2A terminal receipt closeout report (read-only)',
    '',
    `- generatedAt: ${report.generatedAt ?? 'n/a'}`,
    `- ok: ${report.ok === true ? 'true' : 'false'}`,
    `- totalRows: ${report.summary?.totalRows ?? 0}`,
    `- receiptConfirmedRows: ${report.summary?.receiptConfirmedRows ?? 0}`,
    `- currentPostCutoffGapCount: ${report.summary?.currentPostCutoffGapCount ?? 0}`,
    `- legacyResidueGapCount: ${report.summary?.legacyResidueGapCount ?? 0}`,
    `- legacyResidueCutoff: ${report.summary?.legacyResidueCutoff ?? 'none'}`,
    '- safety: readOnly=true; rawPayloadsIncluded=false; notifierSendAttempted=false; terminalAckAttempted=false; dbMutationAttempted=false',
    '',
    ...renderRows('Current post-cutoff gaps', report.currentPostCutoff ?? []),
    ...renderRows('Legacy residue gaps', report.legacyResidue ?? []),
  ];
  return lines.join('\n');
}

export function renderCompact(report) {
  const current = report.currentPostCutoff ?? [];
  const legacy = report.legacyResidue ?? [];
  const gapSummary = current.map((g) => `${g.receiptState}:${g.terminalEventId}`).join(', ') || 'none';
  const providerSentGaps = current.filter((g) => g.receiptState === 'unacked:provider_sent' || g.receiptState === 'unacked:provider_accepted');
  const lines = [
    `Receipt closeout: ${report.ok ? 'PASS' : 'BLOCK'} | rows=${report.summary?.totalRows ?? 0} confirmed=${report.summary?.receiptConfirmedRows ?? 0}`,
    `Gaps: current=${report.summary?.currentPostCutoffGapCount ?? 0} (provider-send-only=${providerSentGaps.length}) legacy=${report.summary?.legacyResidueGapCount ?? 0}`,
  ];
  if (current.length > 0) {
    lines.push(`Current: ${gapSummary}`);
  }
  lines.push('read-only | no-live-send | no-db-mutation | no-terminal-ack');
  return lines.join('\n');
}

function printHuman(report) {
  console.log(renderMarkdown(report));
}

function printCompact(report) {
  console.log(renderCompact(report));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = runTerminalReceiptCloseoutReport(options);
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else if (options.compact || options.telegram) printCompact(report);
  else printHuman(report);
  process.exit(report.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`fatal: ${error.message}`);
    process.exit(2);
  });
}
