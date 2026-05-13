#!/usr/bin/env node
// Broker post-merge migration/health gate for hot-table runtime readiness.
// Read-only: opens the SQLite broker DB, checks schema/hot-table diagnostics,
// worker row quarantine visibility, and terminal-outbox ACK invariants.

import process from 'node:process';
import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

const REQUIRED_SCHEMA_VERSION = 9;
const REQUIRED_STATE_VERSION = 8;
const DEFAULT_MAX_UNACKED_AGE_MS = 15 * 60 * 1000;
const DEFAULT_LEGACY_RESIDUE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const HOT_TABLES = [
  'broker_exchanges',
  'broker_exchange_messages',
  'broker_proposals',
  'broker_artifacts',
  'broker_validations',
  'broker_tasks',
  'broker_tombstones',
  'broker_audit_events',
  'broker_workers',
  'broker_terminal_outbox',
];

const workerCapabilitiesSchema = z.object({
  canAnalyze: z.boolean(),
  canBackfill: z.boolean(),
  canPatchWorkspace: z.boolean(),
  canPromoteLive: z.boolean(),
  workspaceIds: z.array(z.string()),
  environments: z.array(z.string()),
}).passthrough();

const workerSchema = z.object({
  nodeId: z.string().min(1),
  role: z.string().min(1),
  displayName: z.string().optional(),
  brokerUrl: z.string().optional(),
  capabilities: workerCapabilitiesSchema,
  metadata: z.record(z.string(), z.string()).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastSeenAt: z.string(),
}).passthrough();

const terminalAckSchema = z.object({
  status: z.literal('receipt_confirmed'),
  evidence: z.enum(['current_session_visible', 'operator_visible', 'operator_confirmed', 'provider_delivery_receipt']),
  acknowledgedAt: z.string(),
  receiptId: z.string().optional(),
  note: z.string().optional(),
}).passthrough();

const terminalReceiptSchema = z.object({
  status: z.enum(['accepted', 'started', 'produced', 'provider_sent', 'provider_accepted', 'current_session_visible', 'operator_visible', 'timed_out', 'stale', 'failed', 'sent', 'provider_delivered_if_known']),
  updatedAt: z.string(),
  evidence: z.enum(['current_session_visible', 'operator_visible', 'operator_confirmed', 'provider_delivery_receipt']).optional(),
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
  ack: terminalAckSchema.optional(),
  receipt: terminalReceiptSchema.optional(),
  ackAudit: z.object({
    decision: z.string().optional(),
    reason: z.string().optional(),
  }).passthrough().optional(),
  deliveredAt: z.string().optional(),
  attempts: z.number().int().nonnegative(),
}).passthrough();

const taskCloseoutSchema = z.object({
  id: z.string().min(1),
  status: z.string().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().optional(),
  claimedBy: z.string().min(1).optional(),
  requeueCount: z.number().int().nonnegative().optional(),
  error: z.unknown().optional(),
}).passthrough();

const tombstoneCloseoutSchema = z.object({
  taskId: z.string().min(1),
  terminalStatus: z.string().min(1),
  tombstoneReason: z.string().min(1),
  durationMs: z.number().nonnegative(),
  requeueCount: z.number().int().nonnegative(),
  tombstonedAt: z.string(),
}).passthrough();

const TERMINAL_TASK_STATUSES = new Set(['succeeded', 'failed', 'canceled']);
const TOMBSTONE_REQUIRED_STATUSES = new Set(['failed', 'canceled']);

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
  const maxAgeRaw = readOption('--max-unacked-age-ms') ?? process.env.BROKER_MIGRATION_GATE_MAX_UNACKED_AGE_MS;
  const maxUnackedAgeMs = maxAgeRaw === undefined ? DEFAULT_MAX_UNACKED_AGE_MS : Number(maxAgeRaw);
  const nowRaw = readOption('--now-ms');
  const legacyResidueCutoffRaw = readOption('--legacy-residue-cutoff') ?? process.env.BROKER_MIGRATION_GATE_LEGACY_RESIDUE_CUTOFF;
  const legacyResidueCutoffMs = legacyResidueCutoffRaw === undefined ? null : Date.parse(legacyResidueCutoffRaw);
  const legacyResidueExpiresRaw = readOption('--legacy-residue-expires') ?? process.env.BROKER_MIGRATION_GATE_LEGACY_RESIDUE_EXPIRES;
  const legacyResidueExpiresMs = legacyResidueExpiresRaw === undefined || !Number.isFinite(legacyResidueCutoffMs)
    ? null
    : Date.parse(legacyResidueExpiresRaw);
  const defaultLegacyResidueExpiresMs = Number.isFinite(legacyResidueCutoffMs)
    ? legacyResidueCutoffMs + DEFAULT_LEGACY_RESIDUE_TTL_MS
    : null;
  return {
    dbFile: readOption('--db') ?? process.env.BROKER_SQLITE_FILE ?? process.env.SQLITE_STATE_FILE,
    json: argv.includes('--json'),
    maxUnackedAgeMs: Number.isFinite(maxUnackedAgeMs) && maxUnackedAgeMs >= 0 ? maxUnackedAgeMs : DEFAULT_MAX_UNACKED_AGE_MS,
    nowMs: nowRaw === undefined ? Date.now() : Number(nowRaw),
    priorMetricsPath: readOption('--prior-metrics') ?? process.env.BROKER_MIGRATION_GATE_PRIOR_METRICS ?? null,
    legacyResidueCutoff: Number.isFinite(legacyResidueCutoffMs) ? new Date(legacyResidueCutoffMs).toISOString() : null,
    legacyResidueCutoffMs: Number.isFinite(legacyResidueCutoffMs) ? legacyResidueCutoffMs : null,
    legacyResidueExpires: Number.isFinite(legacyResidueExpiresMs)
      ? new Date(legacyResidueExpiresMs).toISOString()
      : Number.isFinite(defaultLegacyResidueExpiresMs) ? new Date(defaultLegacyResidueExpiresMs).toISOString() : null,
    legacyResidueExpiresMs: Number.isFinite(legacyResidueExpiresMs)
      ? legacyResidueExpiresMs
      : Number.isFinite(defaultLegacyResidueExpiresMs) ? defaultLegacyResidueExpiresMs : null,
  };
}

function sanitizeDiagnosticValue(value) {
  if (typeof value !== 'string') return '<non-string>';
  return value
    .replace(/\b(?:ghp|gho|ghu|ghs|github_pat|sk|xox[abp])-[-_A-Za-z0-9]+\b/g, '[redacted]')
    .replace(/\b(token|secret|password|api[_-]?key)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(/(^|\s)(?:[A-Za-z]:)?\/[\w./-]+/g, '$1[path]')
    .slice(0, 120);
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

function readMetadata(db, key) {
  if (!tableExists(db, 'broker_metadata')) return undefined;
  const row = db.prepare('SELECT value FROM broker_metadata WHERE key = ?').get(key);
  return typeof row?.value === 'string' ? row.value : undefined;
}

function parseJsonPayload(payload, schema) {
  if (typeof payload !== 'string') return { success: false, error: 'payload is not a string' };
  try {
    const value = JSON.parse(payload);
    const parsed = schema.safeParse(value);
    return parsed.success ? { success: true, data: parsed.data } : { success: false, error: zodMessage(parsed.error) };
  } catch (error) {
    return { success: false, error: sanitizeDiagnosticValue(error instanceof Error ? error.message : String(error)) };
  }
}

function isBeforeLegacyCutoff(isoTimestamp, cutoffMs) {
  if (!Number.isFinite(cutoffMs)) return false;
  const valueMs = Date.parse(isoTimestamp ?? '');
  return Number.isFinite(valueMs) && valueMs < cutoffMs;
}

function normalizeOptions(options = {}) {
  const legacyResidueCutoffMs = Number.isFinite(options.legacyResidueCutoffMs)
    ? options.legacyResidueCutoffMs
    : Date.parse(options.legacyResidueCutoff ?? '');
  const legacyResidueExpiresMs = Number.isFinite(options.legacyResidueExpiresMs)
    ? options.legacyResidueExpiresMs
    : Date.parse(options.legacyResidueExpires ?? '');
  const defaultLegacyResidueExpiresMs = Number.isFinite(legacyResidueCutoffMs)
    ? legacyResidueCutoffMs + DEFAULT_LEGACY_RESIDUE_TTL_MS
    : null;
  return {
    ...options,
    priorMetricsPath: options.priorMetricsPath ?? null,
    legacyResidueCutoffMs: Number.isFinite(legacyResidueCutoffMs) ? legacyResidueCutoffMs : null,
    legacyResidueCutoff: Number.isFinite(legacyResidueCutoffMs) ? new Date(legacyResidueCutoffMs).toISOString() : null,
    legacyResidueExpiresMs: Number.isFinite(legacyResidueExpiresMs)
      ? legacyResidueExpiresMs
      : Number.isFinite(defaultLegacyResidueExpiresMs) ? defaultLegacyResidueExpiresMs : null,
    legacyResidueExpires: Number.isFinite(legacyResidueExpiresMs)
      ? new Date(legacyResidueExpiresMs).toISOString()
      : Number.isFinite(defaultLegacyResidueExpiresMs) ? new Date(defaultLegacyResidueExpiresMs).toISOString() : null,
  };
}

function buildLegacyResiduePolicy({ legacyResidueCutoff, legacyResidueExpires }) {
  if (!legacyResidueCutoff) return null;
  return {
    cutoff: legacyResidueCutoff,
    expiresAt: legacyResidueExpires ?? null,
    lifecycle: 'Rows older than the cutoff are legacy residue: report-only quarantine, never forged ACK/tombstone evidence. Rows at or after the cutoff are current regressions and block release. Legacy residue must be cleaned or the cutoff removed before expiry.',
  };
}

function checkLegacyResidueLifecycle(checks, { nowMs, legacyResidueCutoff, legacyResidueExpiresMs, legacyResidueExpires }) {
  const legacyResidueCounts = checks
    .filter((check) => Array.isArray(check.legacyResidue))
    .map((check) => ({ check: check.check, count: check.legacyResidue.length }))
    .filter((item) => item.count > 0);
  const totalLegacyResidue = legacyResidueCounts.reduce((sum, item) => sum + item.count, 0);
  const policy = buildLegacyResiduePolicy({ legacyResidueCutoff, legacyResidueExpires });
  if (!policy) {
    return pass('legacy residue lifecycle policy', 'no legacy residue cutoff configured; all residue is treated as current', { legacyResidueCounts, totalLegacyResidue, policy });
  }
  if (totalLegacyResidue === 0) {
    return pass('legacy residue lifecycle policy', `legacy residue cutoff active until ${policy.expiresAt ?? 'manual removal'}; no quarantined residue found`, { legacyResidueCounts, totalLegacyResidue, policy });
  }
  if (Number.isFinite(legacyResidueExpiresMs) && Number.isFinite(nowMs) && nowMs >= legacyResidueExpiresMs) {
    return fail('legacy residue lifecycle policy', `${totalLegacyResidue} legacy residue row(s) remain after cutoff policy expiry; remove/resolve residue or remove --legacy-residue-cutoff`, {
      reason: 'legacy_residue_policy_expired',
      legacyResidueCounts,
      totalLegacyResidue,
      policy,
    });
  }
  return pass('legacy residue lifecycle policy', `${totalLegacyResidue} legacy residue row(s) quarantined by cutoff until ${policy.expiresAt ?? 'manual removal'}; post-cutoff rows remain blocking`, { legacyResidueCounts, totalLegacyResidue, policy });
}

function checkSchema(db) {
  const schemaVersion = Number(readMetadata(db, 'schema_version'));
  const stateVersion = Number(readMetadata(db, 'state_version'));
  const problems = [];
  if (!Number.isInteger(schemaVersion) || schemaVersion < REQUIRED_SCHEMA_VERSION) {
    problems.push(`schema_version ${Number.isInteger(schemaVersion) ? schemaVersion : 'missing'} < ${REQUIRED_SCHEMA_VERSION}`);
  }
  if (!Number.isInteger(stateVersion) || stateVersion !== REQUIRED_STATE_VERSION) {
    problems.push(`state_version ${Number.isInteger(stateVersion) ? stateVersion : 'missing'} != ${REQUIRED_STATE_VERSION}`);
  }
  return problems.length === 0
    ? pass('schema version', `schema=${schemaVersion}, state=${stateVersion}`, { schemaVersion, stateVersion })
    : fail('schema version', problems.join('; '), { schemaVersion: Number.isInteger(schemaVersion) ? schemaVersion : null, stateVersion: Number.isInteger(stateVersion) ? stateVersion : null });
}

function checkHotTables(db) {
  const missingTables = HOT_TABLES.filter((table) => !tableExists(db, table));
  const counts = {};
  for (const table of HOT_TABLES) {
    if (!missingTables.includes(table)) {
      counts[table] = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
    }
  }
  return missingTables.length === 0
    ? pass('hot-table load diagnostics', `${HOT_TABLES.length} hot tables available`, { tableCounts: counts })
    : fail('hot-table load diagnostics', `missing hot tables: ${missingTables.join(', ')}`, { missingTables, tableCounts: counts });
}

function checkHotTableGrowth(db, { priorMetricsPath, nowMs } = {}) {
  if (HOT_TABLES.some((table) => !tableExists(db, table))) {
    return fail('hot-table growth', 'one or more hot tables missing; cannot compute growth', { tables: [] });
  }

  const tables = [];
  for (const table of HOT_TABLES) {
    const count = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
    tables.push({ table, count });
  }

  const totalRows = tables.reduce((sum, t) => sum + t.count, 0);

  // Growth vs prior snapshot
  let priorTotal = null;
  let growthRate = null;
  let priorGeneratedAt = null;
  if (priorMetricsPath && existsSync(priorMetricsPath)) {
    try {
      const priorRaw = JSON.parse(readFileSync(priorMetricsPath, 'utf-8'));
      if (priorRaw?.kind === 'broker.migration-health-gate') {
        const priorGrowthCheck = priorRaw.checks?.find((c) => c.check === 'hot-table growth');
        if (priorGrowthCheck?.tableCounts) {
          priorTotal = Object.values(priorGrowthCheck.tableCounts).reduce((sum, c) => sum + c, 0);
        } else if (priorGrowthCheck?.totalRows) {
          priorTotal = priorGrowthCheck.totalRows;
        }
        priorGeneratedAt = priorRaw.generatedAt ?? null;
      }
    } catch { /* ignore unparseable prior */ }
  }

  if (priorTotal !== null && priorTotal > 0) {
    growthRate = (totalRows - priorTotal) / priorTotal;
  }

  const warnings = [];
  if (totalRows >= 10000) {
    warnings.push(`CRITICAL: total hot-table rows (${totalRows}) exceed 10,000`);
  } else if (totalRows >= 2000) {
    warnings.push(`WARNING: total hot-table rows (${totalRows}) exceed 2,000`);
  }
  if (growthRate !== null && growthRate > 0.5) {
    warnings.push(`WARNING: growth rate ${(growthRate * 100).toFixed(1)}% exceeds 50%`);
  }

  const severity = warnings.some((w) => w.startsWith('CRITICAL')) ? 'critical' : warnings.length > 0 ? 'warning' : 'ok';

  return warnings.length === 0
    ? pass('hot-table growth', `${totalRows} total rows across ${HOT_TABLES.length} tables${growthRate !== null ? ` (${(growthRate * 100).toFixed(1)}% growth)` : ''}`, { totalRows, tableCounts: Object.fromEntries(tables.map((t) => [t.table, t.count])), growthRate, priorTotal, priorGeneratedAt, severity, warnings })
    : (severity === 'critical' ? fail : pass)('hot-table growth', `${totalRows} total rows; ${warnings.join('; ')}`, { totalRows, tableCounts: Object.fromEntries(tables.map((t) => [t.table, t.count])), growthRate, priorTotal, priorGeneratedAt, severity, warnings });
}

function checkWorkers(db) {
  if (!tableExists(db, 'broker_workers')) {
    return fail('worker hot-table quarantine', 'broker_workers table missing', { invalidRows: [] });
  }
  const invalidRows = db.prepare('SELECT node_id AS primaryKey, payload FROM broker_workers ORDER BY node_id ASC').all()
    .flatMap((row) => {
      const parsed = parseJsonPayload(row.payload, workerSchema);
      return parsed.success ? [] : [{
        table: 'broker_workers',
        primaryKey: sanitizeDiagnosticValue(row.primaryKey),
        schemaError: parsed.error,
        count: 1,
      }];
    });
  if (invalidRows.length > 0) {
    return fail('worker hot-table quarantine', `${invalidRows.length} invalid worker row(s) quarantined; rollout blocked until fixed`, { invalidRows });
  }
  return pass('worker hot-table quarantine', 'all worker rows validate normalized capabilities', { invalidRows: [] });
}

function checkQueueCloseoutReconciliation(db, { legacyResidueCutoffMs } = {}) {
  if (!tableExists(db, 'broker_tasks') || !tableExists(db, 'broker_tombstones')) {
    return fail('queue closeout reconciliation', 'broker_tasks or broker_tombstones table missing', { violations: [] });
  }

  const tombstones = new Map();
  const tombstoneRows = db.prepare('SELECT task_id AS taskId, payload FROM broker_tombstones ORDER BY task_id ASC').all();
  for (const row of tombstoneRows) {
    const taskId = sanitizeDiagnosticValue(row.taskId);
    const parsed = parseJsonPayload(row.payload, tombstoneCloseoutSchema);
    if (!parsed.success) {
      tombstones.set(row.taskId, { invalid: true, taskId, detail: parsed.error });
    } else {
      tombstones.set(row.taskId, parsed.data);
    }
  }

  const violations = [];
  const legacyResidue = [];
  const rows = db.prepare('SELECT id, payload FROM broker_tasks ORDER BY id ASC').all();
  for (const row of rows) {
    const id = sanitizeDiagnosticValue(row.id);
    const parsed = parseJsonPayload(row.payload, taskCloseoutSchema);
    if (!parsed.success) {
      violations.push({ id, reason: 'invalid_task_payload', detail: parsed.error });
      continue;
    }

    const task = parsed.data;
    const status = task.status;
    const tombstone = tombstones.get(task.id);
    if (!TERMINAL_TASK_STATUSES.has(status) && task.completedAt) {
      violations.push({ id, reason: 'non_terminal_task_has_completed_at', status });
    }
    if (!TOMBSTONE_REQUIRED_STATUSES.has(status)) {
      continue;
    }
    if (!task.completedAt) {
      violations.push({ id, reason: 'terminal_task_missing_completed_at', status });
    }
    if (!tombstone) {
      if (isBeforeLegacyCutoff(task.completedAt ?? task.updatedAt, legacyResidueCutoffMs)) {
        legacyResidue.push({ id, reason: 'legacy_terminal_task_missing_tombstone', status, completedAt: task.completedAt ?? null });
        continue;
      }
      violations.push({ id, reason: 'terminal_task_missing_tombstone', status });
      continue;
    }
    if (tombstone.invalid) {
      violations.push({ id, reason: 'invalid_tombstone_payload', detail: tombstone.detail });
      continue;
    }
    if (tombstone.terminalStatus !== status) {
      violations.push({ id, reason: 'tombstone_status_mismatch', status, tombstoneStatus: tombstone.terminalStatus });
    }
    if (tombstone.requeueCount !== (task.requeueCount ?? 0)) {
      violations.push({ id, reason: 'tombstone_requeue_count_mismatch', requeueCount: task.requeueCount ?? 0, tombstoneRequeueCount: tombstone.requeueCount });
    }
  }

  if (violations.length > 0) {
    return fail('queue closeout reconciliation', `${violations.length} queue closeout violation(s); rollout blocked`, { violations, legacyResidue });
  }
  const suffix = legacyResidue.length > 0 ? `; ${legacyResidue.length} legacy residue row(s) quarantined by cutoff` : '';
  return pass('queue closeout reconciliation', `${rows.length} task row(s) have reconciled terminal closeout state${suffix}`, { rowCount: rows.length, legacyResidue });
}

function hasCanonicalTerminalEvidence(event) {
  const payload = event?.payload ?? {};
  return Boolean(
    payload.prUrl ||
    payload.doneCommentUrl ||
    payload.blockCommentUrl ||
    payload.github?.prUrl ||
    payload.github?.doneCommentUrl ||
    payload.github?.blockCommentUrl
  );
}

function normalizeTerminalReceiptStatus(status) {
  if (status === 'sent' || status === 'provider_delivered_if_known') return 'provider_sent';
  return typeof status === 'string' ? status : 'accepted';
}

function hasDuplicateSuppressionHint(event) {
  const reason = typeof event.ackAudit?.reason === 'string' ? event.ackAudit.reason : '';
  return Boolean(
    event.duplicateOf ||
    event.duplicateSuppressed === true ||
    event.receipt?.duplicateOf ||
    /duplicate|suppress/i.test(reason)
  );
}

function terminalReceiptGapClassification(event, { ageMs, maxUnackedAgeMs } = {}) {
  if (event.ack || event.deliveredAt) {
    return {
      bucket: 'receipt_confirmed',
      releaseBlocking: false,
      action: 'No remediation required; ACK is backed by receipt-confirmed evidence.',
    };
  }
  if (hasDuplicateSuppressionHint(event)) {
    return {
      bucket: 'duplicate_suppressed',
      releaseBlocking: true,
      action: 'Suppress duplicate notification, but keep the row unacked/release-blocking until the original receipt evidence or operator-approved duplicate policy is recorded.',
    };
  }
  const receiptStatus = normalizeTerminalReceiptStatus(event.receipt?.status);
  if (receiptStatus === 'operator_visible') {
    return {
      bucket: 'receipt_confirmed',
      releaseBlocking: true,
      action: 'Operator-visible receipt is recorded; convert to receipt-confirmed ACK only through the terminal ACK endpoint with real receipt evidence.',
    };
  }
  if (receiptStatus === 'failed') {
    return {
      bucket: 'send_failed',
      releaseBlocking: true,
      action: 'Investigate notification provider failure, retry delivery, and ACK only after operator-visible/provider-delivery evidence exists.',
    };
  }
  if (receiptStatus === 'timed_out' || receiptStatus === 'stale' || (Number.isFinite(ageMs) && Number.isFinite(maxUnackedAgeMs) && ageMs > maxUnackedAgeMs && event.attempts > 0 && receiptStatus === 'accepted')) {
    return {
      bucket: 'stale_timed_out',
      releaseBlocking: true,
      action: 'Replay/reconcile the terminal event; stale or timed-out send state is not ACK evidence.',
    };
  }
  if (receiptStatus === 'provider_sent' || receiptStatus === 'provider_accepted' || receiptStatus === 'started' || receiptStatus === 'produced') {
    return {
      bucket: 'send_accepted_no_receipt',
      releaseBlocking: true,
      action: 'Provider send acceptance is not an ACK; wait for provider-delivery/operator-visible receipt evidence.',
    };
  }
  return {
    bucket: 'no_notification_config',
    releaseBlocking: true,
    action: 'Configure/repair the operator notification path and replay; no send/receipt evidence exists.',
  };
}

function summarizeGapBuckets(classifications) {
  const buckets = {};
  for (const item of classifications) {
    buckets[item.bucket] = (buckets[item.bucket] ?? 0) + 1;
  }
  return buckets;
}

function isLegacyUnackedTerminalOutboxResidue(event, createdAt, cutoffMs) {
  return isBeforeLegacyCutoff(createdAt, cutoffMs) &&
    !event.ack &&
    !event.deliveredAt;
}

function checkTerminalOutbox(db, { nowMs, maxUnackedAgeMs, legacyResidueCutoffMs }) {
  if (!tableExists(db, 'broker_terminal_outbox')) {
    return fail('terminal-outbox ACK invariant', 'broker_terminal_outbox table missing', { violations: [] });
  }
  const violations = [];
  const legacyResidue = [];
  const classifications = [];
  const rows = db.prepare('SELECT id, acknowledged_at AS acknowledgedAt, created_at AS createdAt, payload FROM broker_terminal_outbox ORDER BY created_at ASC, id ASC').all();
  for (const row of rows) {
    const id = sanitizeDiagnosticValue(row.id);
    const parsed = parseJsonPayload(row.payload, terminalOutboxSchema);
    if (!parsed.success) {
      violations.push({ id, reason: 'invalid_terminal_outbox_payload', detail: parsed.error });
      continue;
    }
    const event = parsed.data;
    if (row.acknowledgedAt && !event.ack) {
      violations.push({ id, reason: 'acknowledged_without_receipt_evidence' });
    }
    if (event.ack) {
      const ackParsed = terminalAckSchema.safeParse(event.ack);
      if (!ackParsed.success) {
        violations.push({ id, reason: 'invalid_ack_receipt', detail: zodMessage(ackParsed.error) });
      }
    }
    const createdAt = typeof row.createdAt === 'string' ? row.createdAt : event.createdAt;
    const createdMs = Date.parse(createdAt);
    const ageMs = Number.isFinite(createdMs) && Number.isFinite(nowMs) ? nowMs - createdMs : null;
    const classification = terminalReceiptGapClassification(event, { ageMs, maxUnackedAgeMs });
    if (!event.ack || row.acknowledgedAt || event.deliveredAt) {
      classifications.push({
        id,
        bucket: classification.bucket,
        releaseBlocking: classification.releaseBlocking,
        action: classification.action,
        receiptStatus: normalizeTerminalReceiptStatus(event.receipt?.status),
        createdAt,
        ageMs,
      });
    }
    if (!event.ack && !event.deliveredAt) {
      if (Number.isFinite(createdMs) && nowMs - createdMs > maxUnackedAgeMs) {
        if (isLegacyUnackedTerminalOutboxResidue(event, createdAt, legacyResidueCutoffMs)) {
          legacyResidue.push({
            id,
            reason: 'legacy_unacked_terminal_outbox',
            bucket: classification.bucket,
            action: classification.action,
            releaseBlocking: false,
            createdAt,
            payloadCreatedAt: event.createdAt,
            canonicalEvidence: hasCanonicalTerminalEvidence(event),
          });
          continue;
        }
        violations.push({
          id,
          reason: 'stale_unacked_receipt_evidence',
          bucket: classification.bucket,
          releaseBlocking: true,
          action: classification.action,
          ageMs: nowMs - createdMs,
          maxUnackedAgeMs,
          createdAt,
        });
      }
    }
  }
  const currentGapBuckets = summarizeGapBuckets(violations.filter((violation) => violation.releaseBlocking));
  const receiptGapClassifications = classifications;
  if (violations.length > 0) {
    return fail('terminal-outbox ACK invariant', `${violations.length} ACK invariant violation(s); rollout blocked; current receipt gaps=${JSON.stringify(currentGapBuckets)}`, { violations, legacyResidue, receiptGapClassifications, currentGapBuckets });
  }
  const suffix = legacyResidue.length > 0 ? `; ${legacyResidue.length} legacy unacked row(s) quarantined by cutoff without ACK` : '';
  return pass('terminal-outbox ACK invariant', `${rows.length} outbox row(s) have receipt-safe ACK state or are within replay window${suffix}`, { rowCount: rows.length, legacyResidue, receiptGapClassifications, currentGapBuckets });
}

function checkQueueHygiene(db, { nowMs } = {}) {
  if (!tableExists(db, 'broker_tasks')) {
    return fail('queue hygiene', 'broker_tasks table missing', { violations: [] });
  }

  const taskAgeSchema = z.object({
    id: z.string().min(1),
    status: z.string().min(1),
    createdAt: z.string(),
    updatedAt: z.string(),
    requeueCount: z.number().int().nonnegative().optional(),
  }).passthrough();

  const allTasks = [];
  const parseErrors = [];
  const rows = db.prepare('SELECT id, payload FROM broker_tasks ORDER BY id ASC').all();
  for (const row of rows) {
    const parsed = parseJsonPayload(row.payload, taskAgeSchema);
    if (!parsed.success) {
      parseErrors.push({ id: sanitizeDiagnosticValue(row.id), detail: parsed.error });
      continue;
    }
    allTasks.push(parsed.data);
  }

  const activeTasks = allTasks.filter((t) => !TERMINAL_TASK_STATUSES.has(t.status));
  const terminalTasks = allTasks.filter((t) => TERMINAL_TASK_STATUSES.has(t.status));

  // Age buckets for active tasks
  const ageBuckets = { 'lt_15m': 0, '15m_1h': 0, '1h_4h': 0, '4h_24h': 0, 'gt_24h': 0 };
  let oldestActiveAgeMs = 0;
  for (const task of activeTasks) {
    const createdMs = Date.parse(task.createdAt ?? '');
    if (!Number.isFinite(createdMs)) continue;
    const ageMs = nowMs - createdMs;
    oldestActiveAgeMs = Math.max(oldestActiveAgeMs, ageMs);
    if (ageMs < 15 * 60 * 1000) ageBuckets.lt_15m++;
    else if (ageMs < 60 * 60 * 1000) ageBuckets['15m_1h']++;
    else if (ageMs < 4 * 60 * 60 * 1000) ageBuckets['1h_4h']++;
    else if (ageMs < 24 * 60 * 60 * 1000) ageBuckets['4h_24h']++;
    else ageBuckets.gt_24h++;
  }

  // Requeue analysis
  const requeuedTasks = allTasks.filter((t) => (t.requeueCount ?? 0) > 0);
  const multiRequeued = requeuedTasks.filter((t) => (t.requeueCount ?? 0) > 1);
  const maxRequeueDepth = requeuedTasks.reduce((max, t) => Math.max(max, t.requeueCount ?? 0), 0);

  // Status breakdown
  const byStatus = {};
  for (const task of allTasks) {
    byStatus[task.status] = (byStatus[task.status] ?? 0) + 1;
  }

  // Queue pressure ratio
  const queuedCount = byStatus.queued ?? 0;
  const claimedRunning = (byStatus.claimed ?? 0) + (byStatus.running ?? 0);
  const queuePressure = claimedRunning > 0 ? queuedCount / claimedRunning : (queuedCount > 0 ? Infinity : 0);

  const warnings = [];
  if (activeTasks.length >= 200) {
    warnings.push(`CRITICAL: ${activeTasks.length} active tasks exceed 200`);
  } else if (activeTasks.length >= 50) {
    warnings.push(`WARNING: ${activeTasks.length} active tasks exceed 50`);
  }
  if (maxRequeueDepth >= 5) {
    warnings.push(`CRITICAL: max requeue depth ${maxRequeueDepth} exceeds 5`);
  } else if (maxRequeueDepth >= 3) {
    warnings.push(`WARNING: max requeue depth ${maxRequeueDepth} exceeds 3`);
  }
  if (oldestActiveAgeMs >= 4 * 60 * 60 * 1000) {
    warnings.push(`CRITICAL: oldest active task age ${Math.round(oldestActiveAgeMs / 60000)}min exceeds 4h`);
  } else if (oldestActiveAgeMs >= 30 * 60 * 1000) {
    warnings.push(`WARNING: oldest active task age ${Math.round(oldestActiveAgeMs / 60000)}min exceeds 30min`);
  }
  if (queuePressure > 3) {
    warnings.push(`WARNING: queue pressure ratio ${queuePressure.toFixed(1)} exceeds 3.0`);
  }

  const severity = warnings.some((w) => w.startsWith('CRITICAL')) ? 'critical' : warnings.length > 0 ? 'warning' : 'ok';

  if (warnings.length > 0) {
    return (severity === 'critical' ? fail : pass)('queue hygiene', `${allTasks.length} tasks, ${activeTasks.length} active; ${warnings.join('; ')}`, {
      totalTasks: allTasks.length,
      activeTasks: activeTasks.length,
      terminalTasks: terminalTasks.length,
      byStatus,
      ageBuckets,
      oldestActiveAgeMs,
      requeuedCount: requeuedTasks.length,
      multiRequeued: multiRequeued.length,
      maxRequeueDepth,
      queuePressure,
      severity,
      warnings,
      parseErrors: parseErrors.length > 0 ? parseErrors.slice(0, 5) : [],
    });
  }

  return pass('queue hygiene', `${allTasks.length} tasks, ${activeTasks.length} active, ${terminalTasks.length} terminal`, {
    totalTasks: allTasks.length,
    activeTasks: activeTasks.length,
    terminalTasks: terminalTasks.length,
    byStatus,
    ageBuckets,
    oldestActiveAgeMs,
    requeuedCount: requeuedTasks.length,
    multiRequeued: multiRequeued.length,
    maxRequeueDepth,
    queuePressure,
    severity,
    warnings,
    parseErrors: parseErrors.length > 0 ? parseErrors.slice(0, 5) : [],
  });
}

export function runMigrationHealthGate(rawOptions) {
  const options = normalizeOptions(rawOptions);
  if (!options?.dbFile) {
    return {
      kind: 'broker.migration-health-gate',
      ok: false,
      dbFile: null,
      checks: [fail('configuration', 'missing SQLite DB path; provide --db or BROKER_SQLITE_FILE')],
    };
  }
  if (!existsSync(options.dbFile)) {
    return {
      kind: 'broker.migration-health-gate',
      ok: false,
      dbFile: sanitizeDiagnosticValue(options.dbFile),
      checks: [fail('configuration', 'SQLite DB path does not exist')],
    };
  }

  const db = new DatabaseSync(options.dbFile, { readOnly: true });
  try {
    const nowMs = options.nowMs ?? Date.now();
    const checks = [
      checkSchema(db),
      checkHotTables(db),
      checkHotTableGrowth(db, {
        priorMetricsPath: options.priorMetricsPath ?? null,
        nowMs,
      }),
      checkWorkers(db),
      checkQueueCloseoutReconciliation(db, {
        legacyResidueCutoffMs: options.legacyResidueCutoffMs,
      }),
      checkTerminalOutbox(db, {
        nowMs,
        maxUnackedAgeMs: options.maxUnackedAgeMs ?? DEFAULT_MAX_UNACKED_AGE_MS,
        legacyResidueCutoffMs: options.legacyResidueCutoffMs,
      }),
      checkQueueHygiene(db, { nowMs }),
    ];
    checks.push(checkLegacyResidueLifecycle(checks, {
      nowMs,
      legacyResidueCutoff: options.legacyResidueCutoff ?? null,
      legacyResidueExpiresMs: options.legacyResidueExpiresMs,
      legacyResidueExpires: options.legacyResidueExpires ?? null,
    }));
    return {
      kind: 'broker.migration-health-gate',
      dbFile: sanitizeDiagnosticValue(options.dbFile),
      required: {
        schemaVersion: REQUIRED_SCHEMA_VERSION,
        stateVersion: REQUIRED_STATE_VERSION,
        maxUnackedAgeMs: options.maxUnackedAgeMs ?? DEFAULT_MAX_UNACKED_AGE_MS,
        legacyResidueCutoff: options.legacyResidueCutoff ?? null,
        legacyResidueExpires: options.legacyResidueExpires ?? null,
        legacyResiduePolicy: buildLegacyResiduePolicy({
          legacyResidueCutoff: options.legacyResidueCutoff ?? null,
          legacyResidueExpires: options.legacyResidueExpires ?? null,
        }),
      },
      checks,
      ok: checks.every((check) => check.ok),
    };
  } finally {
    db.close();
  }
}

function printHuman(report) {
  console.log('A2A Broker migration/health gate (read-only)');
  for (const check of report.checks) {
    console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.check}: ${check.detail}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = runMigrationHealthGate(options);
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
