#!/usr/bin/env node

import { readFileSync, existsSync } from 'node:fs';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const DEFAULT_WORKERS = ['bangtong', 'dungae', 'sogyo', 'nosuk'];
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'blocked', 'canceled']);
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_INTERVAL_MS = 2_000;
const USER_AGENT = 'a2a-broker-docker-live-smoke/0.1';

function parseArgs(argv) {
  const options = {
    live: false,
    dryRun: false,
    allowedWorkers: [...DEFAULT_WORKERS],
    timeoutMs: DEFAULT_TIMEOUT_MS,
    intervalMs: DEFAULT_INTERVAL_MS,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${arg} requires a value`);
      }
      i += 1;
      return value;
    };

    if (arg === '--live') options.live = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--broker-url') options.brokerUrl = next();
    else if (arg === '--edge-secret-file') options.edgeSecretFile = next();
    else if (arg === '--worker') options.worker = next();
    else if (arg === '--allowed-workers') options.allowedWorkers = splitCsv(next());
    else if (arg === '--timeout-ms') options.timeoutMs = parsePositiveInt(next(), arg);
    else if (arg === '--interval-ms') options.intervalMs = parsePositiveInt(next(), arg);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }

  return options;
}

function usage() {
  return `Usage: node scripts/docker-broker-live-smoke.mjs [--dry-run|--live] [options]\n\nCreates a safe generic no-op task on the live A2A broker, waits for claim/start/terminal status,\nand prints compact secret-free evidence. Defaults to --dry-run unless --live is present.\n\nOptions:\n  --live                         Actually create a broker task. Required for live smoke.\n  --dry-run                      Print the task that would be created without contacting broker.\n  --broker-url <url>             Broker URL. Env: A2A_BROKER_URL or BROKER_URL.\n  --edge-secret-file <path>      Local file containing edge secret. Env: A2A_EDGE_SECRET_FILE or BROKER_EDGE_SECRET_FILE.\n  --worker <id>                  Force worker id. Must be online unless --dry-run.\n  --allowed-workers <csv>        Worker preference list. Default: ${DEFAULT_WORKERS.join(',')}.\n  --timeout-ms <ms>              Wait timeout. Default: ${DEFAULT_TIMEOUT_MS}.\n  --interval-ms <ms>             Poll interval. Default: ${DEFAULT_INTERVAL_MS}.\n\nSecret loading order for --live:\n  1. --edge-secret-file / A2A_EDGE_SECRET_FILE / BROKER_EDGE_SECRET_FILE\n  2. A2A_EDGE_SECRET / BROKER_EDGE_SECRET / EDGE_SECRET\n`;
}

function splitCsv(value) {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function parsePositiveInt(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return Math.floor(parsed);
}

function normalizeBaseUrl(value) {
  const raw = value?.trim();
  if (!raw) return undefined;
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('broker URL must be http(s)');
  }
  return url.toString().replace(/\/$/, '');
}

function loadEdgeSecret(options) {
  const file = options.edgeSecretFile ?? process.env.A2A_EDGE_SECRET_FILE ?? process.env.BROKER_EDGE_SECRET_FILE;
  if (file) {
    const secret = readFileSync(file, 'utf8').trim();
    if (!secret) throw new Error('edge secret file is empty');
    return secret;
  }

  const secret = process.env.A2A_EDGE_SECRET ?? process.env.BROKER_EDGE_SECRET ?? process.env.EDGE_SECRET;
  if (secret?.trim()) return secret.trim();
  throw new Error('edge secret is required for --live; provide A2A_EDGE_SECRET_FILE or A2A_EDGE_SECRET');
}

function makeRequester(role, idPrefix) {
  return {
    id: `${idPrefix}-${Date.now()}-${randomUUID().slice(0, 8)}`,
    kind: 'service',
    role,
  };
}

function headers(edgeSecret, requester, hasBody = false) {
  return {
    accept: 'application/json',
    'user-agent': USER_AGENT,
    'x-a2a-edge-secret': edgeSecret,
    'x-a2a-requester-id': requester.id,
    'x-a2a-requester-kind': requester.kind,
    'x-a2a-requester-role': requester.role,
    ...(hasBody ? { 'content-type': 'application/json' } : {}),
  };
}

async function readResponseBody(response) {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function requestJson(baseUrl, edgeSecret, requester, method, pathname, body) {
  const response = await fetch(new URL(pathname, `${baseUrl}/`), {
    method,
    headers: headers(edgeSecret, requester, body !== undefined),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const parsed = await readResponseBody(response);
  if (!response.ok) {
    throw new Error(`${method} ${pathname} failed ${response.status}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`);
  }
  return parsed;
}

function buildNoopTask(workerId) {
  const stamp = new Date().toISOString();
  return {
    intent: 'analyze',
    requester: { id: 'operator-docker-smoke', kind: 'service', role: 'operator' },
    target: { id: workerId, kind: 'node', role: 'analyst' },
    assignedWorkerId: workerId,
    taskOrigin: 'operator',
    message: `docker broker noop smoke ${stamp}`,
    payload: {
      schemaVersion: 1,
      mode: 'docker-broker-noop-smoke',
      noOp: true,
      createdBy: USER_AGENT,
      createdAt: stamp,
    },
  };
}

function compactWorker(worker) {
  return {
    nodeId: worker.nodeId,
    role: worker.role,
    status: worker.status,
    lastSeenAt: worker.lastSeenAt,
  };
}

async function selectWorker(baseUrl, edgeSecret, options) {
  const requester = makeRequester('operator', 'docker-smoke-worker-select');
  const workers = await requestJson(baseUrl, edgeSecret, requester, 'GET', '/workers');
  const items = Array.isArray(workers?.items) ? workers.items : [];
  const allowed = options.worker ? [options.worker] : options.allowedWorkers;
  const selected = allowed.map((id) => items.find((worker) => worker.nodeId === id && worker.status === 'online')).find(Boolean);

  if (!selected) {
    const visible = items.filter((worker) => allowed.includes(worker.nodeId)).map(compactWorker);
    throw new Error(`no allowed worker is online; allowed=${allowed.join(',')} visible=${JSON.stringify(visible)}`);
  }
  return selected;
}

async function getTask(baseUrl, edgeSecret, taskId) {
  return requestJson(baseUrl, edgeSecret, makeRequester('operator', 'docker-smoke-task-check'), 'GET', `/tasks/${encodeURIComponent(taskId)}`);
}

async function getTaskAuditActions(baseUrl, edgeSecret, taskId) {
  try {
    const audit = await requestJson(baseUrl, edgeSecret, makeRequester('operator', 'docker-smoke-audit-check'), 'GET', `/audit?targetId=${encodeURIComponent(taskId)}`);
    const items = Array.isArray(audit?.items) ? audit.items : [];
    return items.map((item) => item.action).filter(Boolean);
  } catch {
    return [];
  }
}

async function waitForTerminalEvidence(baseUrl, edgeSecret, taskId, timeoutMs, intervalMs) {
  const startedAt = Date.now();
  const observedStatuses = [];
  let lastTask;
  let auditActions = [];

  while (Date.now() - startedAt < timeoutMs) {
    lastTask = await getTask(baseUrl, edgeSecret, taskId);
    if (observedStatuses.at(-1) !== lastTask.status) {
      observedStatuses.push(lastTask.status);
    }
    auditActions = await getTaskAuditActions(baseUrl, edgeSecret, taskId);

    if (TERMINAL_STATUSES.has(lastTask.status)) {
      const sawClaim = observedStatuses.includes('claimed') || auditActions.includes('task.claimed');
      const sawStart = observedStatuses.includes('running') || auditActions.includes('task.started');
      return { task: lastTask, observedStatuses, auditActions, sawClaim, sawStart };
    }

    await delay(intervalMs);
  }

  throw new Error(`task ${taskId} did not reach a terminal status within ${timeoutMs}ms; last=${JSON.stringify(lastTask)}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return 0;
  }

  const dryRun = options.dryRun || !options.live;
  const brokerUrl = normalizeBaseUrl(options.brokerUrl ?? process.env.A2A_BROKER_URL ?? process.env.BROKER_URL);
  const workerId = options.worker ?? options.allowedWorkers[0];
  const task = buildNoopTask(workerId);

  if (dryRun) {
    console.log(JSON.stringify({
      mode: 'dry-run',
      brokerUrl: brokerUrl ?? '<set A2A_BROKER_URL>',
      allowedWorkers: options.allowedWorkers,
      forcedWorker: options.worker ?? null,
      wouldCreateTask: task,
      secretPrinted: false,
    }, null, 2));
    return 0;
  }

  if (!brokerUrl) throw new Error('broker URL is required for --live; provide --broker-url or A2A_BROKER_URL');
  const edgeSecret = loadEdgeSecret(options);
  const selectedWorker = await selectWorker(brokerUrl, edgeSecret, options);
  const createRequester = makeRequester('operator', 'docker-smoke-create');
  const created = await requestJson(brokerUrl, edgeSecret, createRequester, 'POST', '/tasks', buildNoopTask(selectedWorker.nodeId));
  const evidence = await waitForTerminalEvidence(brokerUrl, edgeSecret, created.id, options.timeoutMs, options.intervalMs);

  const result = {
    mode: 'live',
    ok: evidence.task.status === 'succeeded' && evidence.sawClaim && evidence.sawStart,
    taskId: created.id,
    workerId: selectedWorker.nodeId,
    finalStatus: evidence.task.status,
    observedStatuses: evidence.observedStatuses,
    lifecycle: {
      claimed: evidence.sawClaim,
      started: evidence.sawStart,
      terminal: evidence.task.status,
    },
    completedAt: evidence.task.completedAt ?? null,
    summary: evidence.task.result?.summary ?? null,
  };

  console.log(JSON.stringify(result, null, 2));
  return result.ok ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
    process.exitCode = 1;
  });
