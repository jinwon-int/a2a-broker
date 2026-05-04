#!/usr/bin/env node
// Broker post-merge migration/health gate for hot-table runtime readiness.
// Read-only: opens the SQLite broker DB, checks schema/hot-table diagnostics,
// worker row quarantine visibility, and terminal-outbox ACK invariants.

import process from 'node:process';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

const REQUIRED_SCHEMA_VERSION = 9;
const REQUIRED_STATE_VERSION = 8;
const DEFAULT_MAX_UNACKED_AGE_MS = 15 * 60 * 1000;

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
  evidence: z.enum(['operator_visible', 'operator_confirmed', 'provider_delivery_receipt']),
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
  ack: terminalAckSchema.optional(),
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
  return {
    dbFile: readOption('--db') ?? process.env.BROKER_SQLITE_FILE ?? process.env.SQLITE_STATE_FILE,
    json: argv.includes('--json'),
    maxUnackedAgeMs: Number.isFinite(maxUnackedAgeMs) && maxUnackedAgeMs >= 0 ? maxUnackedAgeMs : DEFAULT_MAX_UNACKED_AGE_MS,
    nowMs: nowRaw === undefined ? Date.now() : Number(nowRaw),
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

function isLegacyAcceptedOnlyOutbox(event, cutoffMs) {
  return isBeforeLegacyCutoff(event.createdAt, cutoffMs) &&
    !event.ack &&
    !event.deliveredAt &&
    event.receipt?.status === 'accepted';
}

function checkTerminalOutbox(db, { nowMs, maxUnackedAgeMs, legacyResidueCutoffMs }) {
  if (!tableExists(db, 'broker_terminal_outbox')) {
    return fail('terminal-outbox ACK invariant', 'broker_terminal_outbox table missing', { violations: [] });
  }
  const violations = [];
  const legacyResidue = [];
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
    if (!event.ack && !event.deliveredAt) {
      const createdMs = Date.parse(event.createdAt);
      if (Number.isFinite(createdMs) && nowMs - createdMs > maxUnackedAgeMs) {
        if (isLegacyAcceptedOnlyOutbox(event, legacyResidueCutoffMs)) {
          legacyResidue.push({
            id,
            reason: 'legacy_accepted_only_unacked_terminal_outbox',
            createdAt: event.createdAt,
            canonicalEvidence: hasCanonicalTerminalEvidence(event),
          });
          continue;
        }
        violations.push({ id, reason: 'stale_unacked_receipt_evidence', ageMs: nowMs - createdMs, maxUnackedAgeMs });
      }
    }
  }
  if (violations.length > 0) {
    return fail('terminal-outbox ACK invariant', `${violations.length} ACK invariant violation(s); rollout blocked`, { violations, legacyResidue });
  }
  const suffix = legacyResidue.length > 0 ? `; ${legacyResidue.length} legacy accepted-only row(s) quarantined by cutoff without ACK` : '';
  return pass('terminal-outbox ACK invariant', `${rows.length} outbox row(s) have receipt-safe ACK state or are within replay window${suffix}`, { rowCount: rows.length, legacyResidue });
}

export function runMigrationHealthGate(options) {
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
    const checks = [
      checkSchema(db),
      checkHotTables(db),
      checkWorkers(db),
      checkQueueCloseoutReconciliation(db, {
        legacyResidueCutoffMs: options.legacyResidueCutoffMs,
      }),
      checkTerminalOutbox(db, {
        nowMs: options.nowMs ?? Date.now(),
        maxUnackedAgeMs: options.maxUnackedAgeMs ?? DEFAULT_MAX_UNACKED_AGE_MS,
        legacyResidueCutoffMs: options.legacyResidueCutoffMs,
      }),
    ];
    return {
      kind: 'broker.migration-health-gate',
      dbFile: sanitizeDiagnosticValue(options.dbFile),
      required: {
        schemaVersion: REQUIRED_SCHEMA_VERSION,
        stateVersion: REQUIRED_STATE_VERSION,
        maxUnackedAgeMs: options.maxUnackedAgeMs ?? DEFAULT_MAX_UNACKED_AGE_MS,
        legacyResidueCutoff: options.legacyResidueCutoff ?? null,
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
