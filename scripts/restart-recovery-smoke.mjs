#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);
const brokerRoot = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(brokerRoot, '..');
const workerEntry = path.resolve(brokerRoot, 'dist', 'worker.js');

if (process.argv.includes('--sleep-handler')) {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  const task = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  const sleepMs = Number(process.env.RESTART_RECOVERY_HANDLER_SLEEP_MS ?? '300000');
  await delay(Number.isFinite(sleepMs) && sleepMs > 0 ? sleepMs : 300000);
  process.stdout.write(
    JSON.stringify({
      result: {
        summary: `restart-recovery sleep handler completed ${task.id ?? 'unknown-task'}`,
        output: {
          taskId: task.id,
          message: task.message,
        },
      },
    }),
  );
  process.exit(0);
}

function requiredEnv(name, fallbackNames = []) {
  const candidates = [name, ...fallbackNames];
  for (const key of candidates) {
    const value = process.env[key]?.trim();
    if (value) {
      return value;
    }
  }
  throw new Error(`${candidates.join(' or ')} is required`);
}

function optionalEnv(name, fallbackNames = []) {
  const candidates = [name, ...fallbackNames];
  for (const key of candidates) {
    const value = process.env[key]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

function parsePositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function makeRequester(role, prefix = 'smoke', kind = 'service') {
  return {
    id: `${prefix}-${role}-${Date.now()}-${randomUUID().slice(0, 8)}`,
    kind,
    role,
  };
}

function withJsonContent(headers, hasBody) {
  return hasBody ? { 'content-type': 'application/json', ...headers } : headers;
}

function buildRequesterHeaders(requester, edgeSecret, hasBody) {
  return withJsonContent(
    {
      accept: 'application/json',
      'user-agent': 'a2a-broker-restart-recovery-smoke/0.1',
      'x-a2a-edge-secret': edgeSecret,
      'x-a2a-requester-id': requester.id,
      ...(requester.kind ? { 'x-a2a-requester-kind': requester.kind } : {}),
      ...(requester.role ? { 'x-a2a-requester-role': requester.role } : {}),
    },
    hasBody,
  );
}

async function readResponseBody(response) {
  const text = await response.text();
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function requestJson(baseUrl, method, pathname, options) {
  const url = new URL(pathname, `${baseUrl}/`).toString();
  const hasBody = options?.body !== undefined;
  const response = await fetch(url, {
    method,
    headers: options?.requester
      ? buildRequesterHeaders(options.requester, options.edgeSecret, hasBody)
      : withJsonContent({ accept: 'application/json' }, hasBody),
    ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
  });
  const body = await readResponseBody(response);
  if (!response.ok) {
    throw new Error(
      `${method} ${pathname} failed with ${response.status}: ${
        typeof body === 'string' ? body : JSON.stringify(body)
      }`,
    );
  }
  return body;
}

async function waitForHealth(baseUrl, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(new URL('/health', `${baseUrl}/`));
      if (response.ok) {
        return await readResponseBody(response);
      }
    } catch {}
    await delay(500);
  }
  throw new Error(`broker health did not recover within ${timeoutMs}ms`);
}

async function waitForWorkerOnline(baseUrl, edgeSecret, workerId, timeoutMs) {
  const startedAt = Date.now();
  let lastBody;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      lastBody = await requestJson(baseUrl, 'GET', `/workers/${encodeURIComponent(workerId)}`, {
        edgeSecret,
        requester: makeRequester('operator', 'worker-check'),
      });
      if (lastBody?.status === 'online') {
        return lastBody;
      }
    } catch (error) {
      lastBody = { error: error instanceof Error ? error.message : String(error) };
    }
    await delay(1000);
  }
  throw new Error(`worker ${workerId} did not reach online state: ${JSON.stringify(lastBody)}`);
}

async function waitForTaskStatus(baseUrl, edgeSecret, taskId, expectedStatuses, timeoutMs, intervalMs) {
  const startedAt = Date.now();
  let lastTask;
  const observedStatuses = [];
  while (Date.now() - startedAt < timeoutMs) {
    lastTask = await requestJson(baseUrl, 'GET', `/tasks/${encodeURIComponent(taskId)}`, {
      edgeSecret,
      requester: makeRequester('operator', 'task-check'),
    });
    if (observedStatuses.at(-1) !== lastTask?.status) {
      observedStatuses.push(lastTask?.status ?? 'unknown');
    }
    if (expectedStatuses.includes(lastTask?.status)) {
      return { task: lastTask, observedStatuses };
    }
    await delay(intervalMs);
  }
  throw new Error(
    `task ${taskId} did not reach ${expectedStatuses.join(', ')} within ${timeoutMs}ms (last=${JSON.stringify(lastTask)})`,
  );
}

function streamChildLogs(child, label) {
  child.stdout.on('data', (chunk) => {
    const text = chunk.toString().trim();
    if (text) {
      console.error(`[${label}] ${text}`);
    }
  });
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString().trim();
    if (text) {
      console.error(`[${label}:stderr] ${text}`);
    }
  });
}

function startWorkerProcess({
  baseUrl,
  edgeSecret,
  workerId,
  handlerMode,
  workerRole,
  pollIntervalMs,
  heartbeatIntervalMs,
  handlerTimeoutMs,
}) {
  const env = {
    ...process.env,
    BROKER_URL: baseUrl,
    BROKER_EDGE_SECRET: edgeSecret,
    WORKER_ID: workerId,
    WORKER_ROLE: workerRole,
    WORKER_POLL_INTERVAL_MS: String(pollIntervalMs),
    WORKER_HEARTBEAT_INTERVAL_MS: String(heartbeatIntervalMs),
    WORKER_HANDLER_TIMEOUT_MS: String(handlerTimeoutMs),
  };

  if (handlerMode === 'sleep') {
    env.WORKER_HANDLER_COMMAND = process.execPath;
    env.WORKER_HANDLER_ARGS_JSON = JSON.stringify([scriptPath, '--sleep-handler']);
  } else {
    env.WORKER_HANDLER_BUILTIN = 'echo';
  }

  const child = spawn(process.execPath, [workerEntry], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  streamChildLogs(child, `worker:${workerId}:${handlerMode}`);
  return child;
}

async function stopChild(child, signal = 'SIGTERM', timeoutMs = 5000) {
  if (!child || child.exitCode !== null || child.killed) {
    return;
  }
  child.kill(signal);
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
      }
      resolve();
    }, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function runShellCommand(command, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn('bash', ['-lc', command], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`command failed (${code}): ${command}\n${stdout}${stderr}`.trim()));
    });
  });
}

const baseUrl = requiredEnv('BROKER_URL', ['A2A_BROKER_URL']);
const edgeSecret = requiredEnv('BROKER_EDGE_SECRET', ['A2A_BROKER_EDGE_SECRET', 'EDGE_SECRET', 'A2A_EDGE_SECRET']);
const restartCommand = optionalEnv('BROKER_RESTART_CMD') ?? 'systemctl restart a2a-broker.service';
const workerRole = optionalEnv('WORKER_ROLE', ['A2A_WORKER_ROLE']) ?? 'analyst';
const workerId = optionalEnv('SMOKE_WORKER_ID') ?? `restart-recovery-smoke-${Date.now()}`;
const timeoutMs = parsePositiveInt(optionalEnv('SMOKE_TIMEOUT_MS'), 120000);
const pollIntervalMs = parsePositiveInt(optionalEnv('SMOKE_WORKER_POLL_INTERVAL_MS'), 1000);
const heartbeatIntervalMs = parsePositiveInt(optionalEnv('SMOKE_WORKER_HEARTBEAT_INTERVAL_MS'), 2000);
const handlerTimeoutMs = parsePositiveInt(optionalEnv('SMOKE_WORKER_HANDLER_TIMEOUT_MS'), 310000);

let firstWorker;
let replacementWorker;

try {
  const requesterSessionKey = `agent:main:smoke:${randomUUID()}`;
  const expected = `RESTART_RECOVERY_OK ${randomUUID()}`;
  const taskId = randomUUID();

  firstWorker = startWorkerProcess({
    baseUrl,
    edgeSecret,
    workerId,
    handlerMode: 'sleep',
    workerRole,
    pollIntervalMs,
    heartbeatIntervalMs,
    handlerTimeoutMs,
  });
  await waitForWorkerOnline(baseUrl, edgeSecret, workerId, timeoutMs);

  const createRequester = { id: requesterSessionKey, kind: 'session', role: 'hub' };
  const createdTask = await requestJson(baseUrl, 'POST', '/tasks', {
    edgeSecret,
    requester: createRequester,
    body: {
      id: taskId,
      intent: 'chat',
      requester: createRequester,
      target: { id: workerId, kind: 'node' },
      assignedWorkerId: workerId,
      message: `Reply exactly with: ${expected}`,
      payload: {
        smoke: 'restart-recovery',
        expected,
        requesterSessionKey,
      },
    },
  });

  const runningBeforeRestart = await waitForTaskStatus(
    baseUrl,
    edgeSecret,
    taskId,
    ['running'],
    timeoutMs,
    2000,
  );

  await stopChild(firstWorker, 'SIGKILL', 2000);
  firstWorker = undefined;

  await runShellCommand(restartCommand, repoRoot);
  const healthAfterRestart = await waitForHealth(baseUrl, 30000);

  const persistedRunning = await requestJson(baseUrl, 'GET', `/tasks/${encodeURIComponent(taskId)}`, {
    edgeSecret,
    requester: makeRequester('operator', 'post-restart'),
  });

  const requeueResponse = await requestJson(
    baseUrl,
    'POST',
    '/tasks/requeue_stale?older_than_seconds=0',
    {
      edgeSecret,
      requester: makeRequester('operator', 'requeue'),
    },
  );

  const queuedAfterRequeue = await requestJson(baseUrl, 'GET', `/tasks/${encodeURIComponent(taskId)}`, {
    edgeSecret,
    requester: makeRequester('operator', 'post-requeue'),
  });

  replacementWorker = startWorkerProcess({
    baseUrl,
    edgeSecret,
    workerId,
    handlerMode: 'echo',
    workerRole,
    pollIntervalMs,
    heartbeatIntervalMs,
    handlerTimeoutMs,
  });
  await waitForWorkerOnline(baseUrl, edgeSecret, workerId, timeoutMs);

  const finalTask = await waitForTaskStatus(
    baseUrl,
    edgeSecret,
    taskId,
    ['succeeded'],
    timeoutMs,
    2000,
  );

  const audit = await requestJson(baseUrl, 'GET', `/audit?targetId=${encodeURIComponent(taskId)}`, {
    edgeSecret,
    requester: makeRequester('operator', 'audit'),
  });

  const summary = {
    ok: true,
    brokerUrl: baseUrl,
    workerId,
    taskId,
    requesterSessionKey,
    expected,
    createdStatus: createdTask.status,
    runningBeforeRestart: {
      status: runningBeforeRestart.task.status,
      observedStatuses: runningBeforeRestart.observedStatuses,
    },
    healthAfterRestart,
    persistedAfterRestart: {
      status: persistedRunning.status,
      claimedBy: persistedRunning.claimedBy,
      assignedWorkerId: persistedRunning.assignedWorkerId,
    },
    requeue: {
      requeued: requeueResponse.requeued,
      policy: requeueResponse.policy,
      items: requeueResponse.items,
    },
    queuedAfterRequeue: {
      status: queuedAfterRequeue.status,
      assignedWorkerId: queuedAfterRequeue.assignedWorkerId,
    },
    final: {
      status: finalTask.task.status,
      observedStatuses: finalTask.observedStatuses,
      result: finalTask.task.result,
      error: finalTask.task.error,
    },
    auditActions: Array.isArray(audit?.items) ? audit.items.map((item) => item.action) : [],
  };

  console.log(JSON.stringify(summary, null, 2));
} finally {
  await stopChild(firstWorker).catch(() => {});
  await stopChild(replacementWorker).catch(() => {});
}
