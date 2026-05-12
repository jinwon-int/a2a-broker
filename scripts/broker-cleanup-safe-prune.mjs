#!/usr/bin/env node
import { SqliteBrokerStateStore } from '../dist/core/store.js';
import {
  BROKER_CLEANUP_CONFIRMATION,
  buildBrokerCleanupPlan,
  executeBrokerCleanupPlan,
  validateCleanupExecution,
} from '../dist/core/broker-cleanup.js';

const args = parseArgs(process.argv.slice(2));
const sqliteFile = args['sqlite-file'] ?? process.env.SQLITE_STATE_FILE ?? process.env.BROKER_SQLITE_FILE;

if (!sqliteFile) {
  fail('missing --sqlite-file (or SQLITE_STATE_FILE/BROKER_SQLITE_FILE)');
}

const planOptions = {
  nowMs: numberArg(args, 'now-ms'),
  taskRetentionMs: numberArg(args, 'task-retention-ms'),
  maxTerminalTasks: numberArg(args, 'max-terminal-tasks'),
  auditRetentionMs: numberArg(args, 'audit-retention-ms'),
  maxAuditEvents: numberArg(args, 'max-audit-events'),
  workerRetentionMs: numberArg(args, 'worker-retention-ms'),
  maxInactiveWorkers: numberArg(args, 'max-inactive-workers'),
  protectedTaskIds: listArg(args, 'protected-task-id'),
  protectedWorkerIds: listArg(args, 'protected-worker-id'),
};

const store = new SqliteBrokerStateStore(sqliteFile);
try {
  const plan = buildBrokerCleanupPlan(store, planOptions);
  if (!args.execute) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    process.exit(0);
  }

  const executionOptions = {
    approvalToken: args['approval-token'],
    confirmation: args.confirmation,
    backupProof: args['backup-proof'],
    allowWorkerPrune: args['allow-worker-prune'] === true,
  };
  const blockers = validateCleanupExecution(plan, executionOptions);
  if (blockers.length > 0) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      error: 'cleanup_execution_blocked',
      expectedConfirmation: BROKER_CLEANUP_CONFIRMATION,
      blockers,
      plan,
    }, null, 2)}\n`);
    process.exit(2);
  }

  const result = executeBrokerCleanupPlan(store, plan, executionOptions);
  process.stdout.write(`${JSON.stringify({ ok: true, plan, result }, null, 2)}\n`);
} finally {
  store.close();
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) fail(`unexpected argument ${arg}`);
    const key = arg.slice(2);
    if (key === 'execute' || key === 'allow-worker-prune') {
      parsed[key] = true;
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) fail(`missing value for --${key}`);
    if (parsed[key] === undefined) parsed[key] = next;
    else if (Array.isArray(parsed[key])) parsed[key].push(next);
    else parsed[key] = [parsed[key], next];
    i += 1;
  }
  return parsed;
}

function numberArg(args, key) {
  const value = args[key];
  if (value === undefined) return undefined;
  if (Array.isArray(value)) fail(`--${key} may only be supplied once`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) fail(`--${key} must be a non-negative number`);
  return parsed;
}

function listArg(args, key) {
  const value = args[key];
  if (value === undefined) return undefined;
  const values = (Array.isArray(value) ? value : [value]).flatMap((item) => String(item).split(','));
  const normalized = values.map((item) => item.trim()).filter(Boolean);
  return normalized.length > 0 ? [...new Set(normalized)] : undefined;
}

function fail(message) {
  console.error(`broker-cleanup-safe-prune: ${message}`);
  process.exit(1);
}
