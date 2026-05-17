#!/usr/bin/env node
// Read-only terminal-outbox receipt closeout report.
// Opens the broker SQLite DB read-only and prints operator-safe current vs legacy
// receipt gaps. It never emits raw terminal payloads, sends notifications, or ACKs rows.

import process from 'node:process';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

const DEFAULT_MAX_UNACKED_AGE_MS = 15 * 60 * 1000;
const DEFAULT_SAMPLE_LIMIT = 20;
const SAFE_ACK_EVIDENCE = new Set(['current_session_visible', 'operator_visible', 'operator_confirmed', 'provider_delivery_receipt']);
const OPERATOR_VISIBLE_RECEIPTS = new Set(['current_session_visible', 'operator_visible']);
const PROVIDER_SEND_ONLY_RECEIPTS = new Set(['accepted', 'sent', 'provider_sent', 'provider_accepted', 'produced', 'started']);
const FAILED_RECEIPTS = new Set(['failed', 'timed_out', 'stale']);

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
  const sampleLimitRaw = readOption('--sample-limit') ?? process.env.TERMINAL_RECEIPT_REPORT_SAMPLE_LIMIT;
  const legacyResidueCutoffRaw = readOption('--legacy-residue-cutoff') ?? process.env.TERMINAL_RECEIPT_REPORT_LEGACY_RESIDUE_CUTOFF;
  const legacyResidueCutoffMs = legacyResidueCutoffRaw === undefined ? null : Date.parse(legacyResidueCutoffRaw);
  const maxUnackedAgeMs = maxAgeRaw === undefined ? DEFAULT_MAX_UNACKED_AGE_MS : Number(maxAgeRaw);
  const sampleLimit = sampleLimitRaw === undefined ? DEFAULT_SAMPLE_LIMIT : Number(sampleLimitRaw);
  return {
    dbFile: readOption('--db') ?? process.env.BROKER_SQLITE_FILE ?? process.env.SQLITE_STATE_FILE,
    json: argv.includes('--json'),
    markdown: argv.includes('--markdown') || argv.includes('--md'),
    compact: argv.includes('--compact') || argv.includes('--telegram'),
    telegram: argv.includes('--telegram'),
    nowMs: nowRaw === undefined ? Date.now() : Number(nowRaw),
    maxUnackedAgeMs: Number.isFinite(maxUnackedAgeMs) && maxUnackedAgeMs >= 0 ? maxUnackedAgeMs : DEFAULT_MAX_UNACKED_AGE_MS,
    sampleLimit: Number.isInteger(sampleLimit) && sampleLimit > 0 ? sampleLimit : DEFAULT_SAMPLE_LIMIT,
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

function firstEvidenceUrl(payload) {
  for (const key of ['prUrl', 'doneUrl', 'blockUrl', 'evidenceUrl']) {
    const value = payload?.[key];
    if (typeof value === 'string' && /^https?:\/\//.test(value)) return value;
  }
  const github = payload?.github;
  if (github && typeof github === 'object' && !Array.isArray(github)) {
    for (const key of ['prUrl', 'doneCommentUrl', 'blockCommentUrl']) {
      const value = github[key];
      if (typeof value === 'string' && /^https?:\/\//.test(value)) return value;
    }
  }
  return null;
}

function workerFor(event) {
  const payload = event?.payload ?? {};
  return typeof payload.worker === 'string' ? payload.worker
    : typeof payload.workerId === 'string' ? payload.workerId
      : typeof payload.assignedWorkerId === 'string' ? payload.assignedWorkerId
        : null;
}

function repoFor(event) {
  const payload = event?.payload ?? {};
  return typeof payload.repo === 'string' ? payload.repo
    : typeof payload.repository === 'string' ? payload.repository
      : null;
}

function issueFor(event) {
  const value = event?.payload?.issue ?? event?.payload?.issueNumber;
  return Number.isInteger(value) ? value : null;
}

function originFor(id, event) {
  const payload = event?.payload ?? {};
  const raw = [
    id,
    event?.id,
    payload.taskId,
    payload.parentRoundId,
    payload.originBrokerId,
    payload.sourceBrokerId,
  ].filter((value) => typeof value === 'string').join(' ');
  if (/cross[-_]broker/i.test(raw)) return 'crossBroker';
  if (typeof payload.originBrokerId === 'string' && payload.originBrokerId && payload.originBrokerId !== 'seoseo') return 'crossBroker';
  return 'local';
}

function evidenceClassFor(event, payloadError) {
  if (payloadError) return 'invalid_payload';
  const receipt = event?.receipt;
  const status = typeof receipt?.status === 'string' ? receipt.status : 'missing_receipt_state';
  const evidence = typeof receipt?.evidence === 'string' ? receipt.evidence : null;
  if (OPERATOR_VISIBLE_RECEIPTS.has(status) && evidence && SAFE_ACK_EVIDENCE.has(evidence)) return 'operator_visible_evidence_unacked';
  if (evidence === 'provider_delivery_receipt') return 'provider_delivery_evidence_unacked';
  if (PROVIDER_SEND_ONLY_RECEIPTS.has(status)) return 'accepted_or_provider_send_only';
  if (FAILED_RECEIPTS.has(status)) return 'failed_or_timed_out';
  if (status === 'missing_receipt_state') return 'missing_receipt_state';
  return `other:${sanitizeDiagnosticValue(status)}`;
}

function ageBucket(ageMs) {
  if (!Number.isFinite(ageMs)) return 'unknown';
  if (ageMs < 60 * 60 * 1000) return '<1h';
  if (ageMs < 6 * 60 * 60 * 1000) return '1-6h';
  if (ageMs < 24 * 60 * 60 * 1000) return '6-24h';
  if (ageMs < 3 * 24 * 60 * 60 * 1000) return '1-3d';
  if (ageMs < 7 * 24 * 60 * 60 * 1000) return '3-7d';
  return '>7d';
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
    worker: workerFor(event),
    repo: repoFor(event),
    issue: issueFor(event),
    origin: originFor(row.id, event),
    hasEvidenceUrl: Boolean(firstEvidenceUrl(event?.payload)),
    evidenceClass: evidenceClassFor(event, payloadError),
    createdAt: createdAt ?? null,
    ageMs: age.ageMs,
    age: age.age,
    ageBucket: ageBucket(age.ageMs),
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

function increment(map, key) {
  const safeKey = key === null || key === undefined || key === '' ? '<missing>' : String(key);
  map[safeKey] = (map[safeKey] ?? 0) + 1;
}

function buildGroup(rows, sampleLimit) {
  const byAgeBucket = {};
  const byStatus = {};
  const byWorker = {};
  const byReceiptState = {};
  const byEvidenceClass = {};
  const byOrigin = {};
  const byEvidenceUrlPresence = {};
  const byRepo = {};
  for (const row of rows) {
    increment(byAgeBucket, row.ageBucket);
    increment(byStatus, row.status);
    increment(byWorker, row.worker);
    increment(byReceiptState, row.receiptState);
    increment(byEvidenceClass, row.evidenceClass);
    increment(byOrigin, row.origin);
    increment(byEvidenceUrlPresence, row.hasEvidenceUrl ? 'hasEvidenceUrl' : 'missingEvidenceUrl');
    increment(byRepo, row.repo);
  }
  return {
    count: rows.length,
    byAgeBucket,
    byStatus,
    byWorker,
    byReceiptState,
    byEvidenceClass,
    byOrigin,
    byEvidenceUrlPresence,
    byRepo,
    sampleIds: rows.slice(0, sampleLimit).map((row) => row.terminalEventId),
  };
}

function buildClassifications({ currentPostCutoff, legacyResidue, options }) {
  const all = [...currentPostCutoff, ...legacyResidue];
  return {
    allUnacked: buildGroup(all, options.sampleLimit),
    currentPostCutoff: buildGroup(currentPostCutoff, options.sampleLimit),
    legacyResidue: buildGroup(legacyResidue, options.sampleLimit),
  };
}

function cleanupDispositionFor(row) {
  if (row.group === 'currentPostCutoff') return 'current_trace_required_before_canary';
  if (row.origin === 'crossBroker') return 'legacy_cross_broker_manual_review';
  if (row.evidenceClass === 'operator_visible_evidence_unacked' || row.evidenceClass === 'provider_delivery_evidence_unacked') {
    return 'legacy_receipt_evidence_review_before_ack';
  }
  if (row.hasEvidenceUrl) return 'legacy_manual_review_with_evidence_url';
  return 'legacy_prune_only_candidate_after_backup_approval';
}

function buildCleanupDryRun({ currentPostCutoff, legacyResidue, options }) {
  const rows = [...currentPostCutoff, ...legacyResidue];
  const byDisposition = {};
  const dispositionRows = new Map();
  for (const row of rows) {
    const disposition = cleanupDispositionFor(row);
    increment(byDisposition, disposition);
    const list = dispositionRows.get(disposition) ?? [];
    list.push(row);
    dispositionRows.set(disposition, list);
  }
  const groups = {};
  for (const [disposition, groupRows] of dispositionRows) {
    groups[disposition] = buildGroup(groupRows, options.sampleLimit);
  }
  const reviewBeforeDecision = rows.filter((row) => cleanupDispositionFor(row) !== 'legacy_prune_only_candidate_after_backup_approval').length;
  const pruneAfterBackupApproval = rows.filter((row) => cleanupDispositionFor(row) === 'legacy_prune_only_candidate_after_backup_approval').length;
  return {
    mode: 'dry-run',
    autoAckCandidates: 0,
    autoPruneCandidates: 0,
    pruneAfterBackupApprovalCandidates: pruneAfterBackupApproval,
    reviewBeforeDecisionCandidates: reviewBeforeDecision,
    byDisposition,
    groups,
    blockers: [
      ...(currentPostCutoff.length > 0 ? [String(currentPostCutoff.length) + ' current post-cutoff gap(s) require trace before broad canary'] : []),
      'provider accepted/send-only evidence is not terminal ACK evidence',
      'DB prune/ACK/replay requires separate operator approval and backup proof',
    ],
    recommendedOrder: [
      'trace current post-cutoff gaps first',
      'review cross-broker and evidence-url legacy rows before any prune decision',
      'prepare backup-backed prune-only approval plan for legacy accepted-only rows without evidence URLs',
      'rerun live-readiness after approved cleanup, then consider broad Team1 canary',
    ],
  };
}

function safeLookupTaskId(taskId) {
  if (typeof taskId !== 'string' || taskId.includes('[redacted]') || taskId.includes('[path]')) return null;
  return taskId;
}

function buildCurrentTrace(db, currentPostCutoff) {
  const hasTasks = tableExists(db, 'broker_tasks');
  const hasAudits = tableExists(db, 'broker_audit_events');
  return currentPostCutoff.map((gap) => {
    const taskId = safeLookupTaskId(gap.taskId);
    const task = taskId && hasTasks
      ? db.prepare('SELECT id, status, intent, target_node_id AS targetNodeId, assigned_worker_id AS assignedWorkerId, task_origin AS taskOrigin, updated_at AS updatedAt FROM broker_tasks WHERE id = ?').get(taskId)
      : null;
    const audits = taskId && hasAudits
      ? db.prepare('SELECT action, created_at AS createdAt FROM broker_audit_events WHERE target_id = ? ORDER BY created_at ASC, id ASC').all(taskId)
      : [];
    const auditActions = audits.map((audit) => audit.action).filter((action) => typeof action === 'string');
    const hasTerminalAudit = auditActions.some((action) => action === 'task.succeeded' || action === 'task.failed' || action === 'task.canceled');
    const conclusion = gap.evidenceClass === 'accepted_or_provider_send_only'
      ? 'task terminal event exists, but only accepted/send receipt state is present; no operator-visible/provider-delivery ACK evidence was persisted'
      : 'current gap requires manual receipt evidence review before ACK/prune';
    return {
      terminalEventId: gap.terminalEventId,
      taskEventId: gap.taskEventId,
      taskId: gap.taskId,
      worker: gap.worker,
      status: gap.status,
      repo: gap.repo,
      issue: gap.issue,
      receiptState: gap.receiptState,
      evidenceClass: gap.evidenceClass,
      taskFound: Boolean(task),
      task: task ? {
        status: task.status,
        intent: task.intent,
        targetNodeId: task.targetNodeId,
        assignedWorkerId: task.assignedWorkerId,
        taskOrigin: task.taskOrigin,
        updatedAt: task.updatedAt,
      } : null,
      auditActionCount: auditActions.length,
      auditActions,
      hasTerminalAudit,
      conclusion,
    };
  });
}

export function runTerminalReceiptCloseoutReport(rawOptions = {}) {
  const options = {
    nowMs: rawOptions.nowMs ?? Date.now(),
    maxUnackedAgeMs: rawOptions.maxUnackedAgeMs ?? DEFAULT_MAX_UNACKED_AGE_MS,
    sampleLimit: rawOptions.sampleLimit ?? DEFAULT_SAMPLE_LIMIT,
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
    const classifications = buildClassifications({ currentPostCutoff, legacyResidue, options });
    const cleanupDryRun = buildCleanupDryRun({ currentPostCutoff, legacyResidue, options });
    const currentTrace = buildCurrentTrace(db, currentPostCutoff);
    const check = currentPostCutoff.length === 0
      ? ok(`no current post-cutoff terminal receipt gap(s); legacy residue=${legacyResidue.length}`)
      : fail(`${currentPostCutoff.length} current post-cutoff terminal receipt gap(s); legacy residue=${legacyResidue.length}`);
    return {
      kind: 'broker.terminal-receipt-closeout-report',
      ok: currentPostCutoff.length === 0,
      dbFile: sanitizeDiagnosticValue(options.dbFile),
      generatedAt: new Date(options.nowMs).toISOString(),
      summary,
      classifications,
      cleanupDryRun,
      currentTrace,
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

function renderGroup(title, group) {
  const lines = [`### ${title}`, ''];
  if (!group) {
    lines.push('_None._', '');
    return lines;
  }
  lines.push(`- count: ${group.count ?? 0}`);
  lines.push(`- byAgeBucket: ${JSON.stringify(group.byAgeBucket ?? {})}`);
  lines.push(`- byStatus: ${JSON.stringify(group.byStatus ?? {})}`);
  lines.push(`- byWorker: ${JSON.stringify(group.byWorker ?? {})}`);
  lines.push(`- byReceiptState: ${JSON.stringify(group.byReceiptState ?? {})}`);
  lines.push(`- byEvidenceClass: ${JSON.stringify(group.byEvidenceClass ?? {})}`);
  lines.push(`- byOrigin: ${JSON.stringify(group.byOrigin ?? {})}`);
  lines.push(`- byEvidenceUrlPresence: ${JSON.stringify(group.byEvidenceUrlPresence ?? {})}`);
  lines.push(`- sampleIds: ${(group.sampleIds ?? []).join(', ') || 'none'}`);
  lines.push('');
  return lines;
}

function renderCleanupDryRun(cleanupDryRun) {
  const lines = ['### Cleanup dry-run plan', ''];
  if (!cleanupDryRun) {
    lines.push('_None._', '');
    return lines;
  }
  lines.push('- mode: ' + cleanupDryRun.mode);
  lines.push('- autoAckCandidates: ' + cleanupDryRun.autoAckCandidates);
  lines.push('- autoPruneCandidates: ' + cleanupDryRun.autoPruneCandidates);
  lines.push('- pruneAfterBackupApprovalCandidates: ' + cleanupDryRun.pruneAfterBackupApprovalCandidates);
  lines.push('- reviewBeforeDecisionCandidates: ' + cleanupDryRun.reviewBeforeDecisionCandidates);
  lines.push('- byDisposition: ' + JSON.stringify(cleanupDryRun.byDisposition ?? {}));
  for (const blocker of cleanupDryRun.blockers ?? []) lines.push('- blocker: ' + blocker);
  lines.push('');
  return lines;
}

function renderCurrentTrace(currentTrace) {
  const lines = ['### Current gap trace', ''];
  if (!Array.isArray(currentTrace) || currentTrace.length === 0) {
    lines.push('_None._', '');
    return lines;
  }
  lines.push('| terminal event id | task id | worker | status | repo | issue | audit actions | conclusion |');
  lines.push('| --- | --- | --- | --- | --- | ---: | --- | --- |');
  for (const trace of currentTrace) {
    lines.push('| ' + escapeCell(trace.terminalEventId) + ' | ' + escapeCell(trace.taskId) + ' | ' + escapeCell(trace.worker) + ' | ' + escapeCell(trace.status) + ' | ' + escapeCell(trace.repo) + ' | ' + escapeCell(trace.issue) + ' | ' + escapeCell((trace.auditActions ?? []).join(', ')) + ' | ' + escapeCell(trace.conclusion) + ' |');
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
    ...renderGroup('Classifier: all unacked gaps', report.classifications?.allUnacked),
    ...renderGroup('Classifier: current post-cutoff gaps', report.classifications?.currentPostCutoff),
    ...renderGroup('Classifier: legacy residue gaps', report.classifications?.legacyResidue),
    ...renderCleanupDryRun(report.cleanupDryRun),
    ...renderCurrentTrace(report.currentTrace),
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
  const evidenceClasses = report.classifications?.allUnacked?.byEvidenceClass ?? {};
  const origins = report.classifications?.allUnacked?.byOrigin ?? {};
  const lines = [
    `Receipt closeout: ${report.ok ? 'PASS' : 'BLOCK'} | rows=${report.summary?.totalRows ?? 0} confirmed=${report.summary?.receiptConfirmedRows ?? 0}`,
    `Gaps: current=${report.summary?.currentPostCutoffGapCount ?? 0} (provider-send-only=${providerSentGaps.length}) legacy=${report.summary?.legacyResidueGapCount ?? 0}`,
    `Classifier: evidenceClass=${JSON.stringify(evidenceClasses)} origin=${JSON.stringify(origins)}`,
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
