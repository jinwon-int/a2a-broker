#!/usr/bin/env node
// a2a-broker release gate — unified smoke + restart-recovery verification
//
// Usage:
//   node scripts/release-gate.mjs [--skip-compose] [--skip-recovery]
//
// Environment (compose smoke):
//   COMPOSE_PROJECT  — docker compose project name (default: release-gate-smoke)
//   PORT             — host port for broker (default: 18787, random if taken)
//
// Environment (restart-recovery smoke):
//   BROKER_URL              — broker URL under test (default: auto-detected from compose)
//   BROKER_EDGE_SECRET      — edge secret (default: none)
//   BROKER_RESTART_CMD      — broker restart command (default: docker compose restart)
//   SMOKE_TIMEOUT_MS        — per-phase timeout (default: 120000)
//
// Exit codes:
//   0  — all enabled gates passed
//   1  — one or more gates failed
//   2  — setup error (missing deps, port conflict, etc.)

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

class SetupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SetupError';
    this.setupError = true;
  }
}

function gateFailure(gate, err, durationMs) {
  return {
    gate,
    ok: false,
    error: err.message,
    ...(err.setupError ? { setupError: true } : {}),
    durationMs,
  };
}

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = dirname(scriptPath);
const brokerRoot = resolve(scriptDir, '..');

function resolve(...segments) {
  return join(...segments);
}

function parsePositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function makeRequester(role, prefix = 'gate', kind = 'service') {
  return { id: `${prefix}-${role}-${Date.now()}-${randomUUID().slice(0, 8)}`, kind, role };
}

function buildHeaders(requester, edgeSecret, hasBody) {
  return {
    accept: 'application/json',
    'user-agent': 'a2a-broker-release-gate/1.0',
    ...(edgeSecret ? { 'x-a2a-edge-secret': edgeSecret } : {}),
    'x-a2a-requester-id': requester.id,
    ...(requester.kind ? { 'x-a2a-requester-kind': requester.kind } : {}),
    ...(requester.role ? { 'x-a2a-requester-role': requester.role } : {}),
    ...(hasBody ? { 'content-type': 'application/json' } : {}),
  };
}

async function requestJson(baseUrl, method, pathname, { requester, edgeSecret, body } = {}) {
  const url = `${baseUrl}${pathname}`;
  const hasBody = body !== undefined;
  const response = await fetch(url, {
    method,
    headers: buildHeaders(requester, edgeSecret, hasBody),
    ...(hasBody ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  if (!response.ok) {
    throw new Error(`${method} ${pathname} → ${response.status}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`);
  }
  return parsed;
}

async function pollUntil(predicate, { intervalMs = 1000, timeoutMs = 30000, label = 'poll' } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await predicate();
    if (result) return result;
    await delay(intervalMs);
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms`);
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} ${args.join(' ')} exited ${code}\n${stderr}`.trim()));
    });
  });
}

function streamLogs(child, label) {
  child.stdout.on('data', c => { const t = c.toString().trim(); if (t) console.error(`[${label}] ${t}`); });
  child.stderr.on('data', c => { const t = c.toString().trim(); if (t) console.error(`[${label}:err] ${t}`); });
}

async function resolveComposeRunner() {
  const candidates = [
    { cmd: 'docker', args: ['compose'] },
    { cmd: 'docker-compose', args: [] },
  ];

  for (const candidate of candidates) {
    try {
      await run(candidate.cmd, [...candidate.args, 'version']);
      return candidate;
    } catch {}
  }

  throw new SetupError('docker compose is required for compose smoke (tried "docker compose" and "docker-compose")');
}

// ---------------------------------------------------------------------------
// Gate: Compose Smoke (happy path)
// ---------------------------------------------------------------------------

async function gateComposeSmoke({ edgeSecret, timeoutMs }) {
  const composeFile = resolve(brokerRoot, 'examples', 'docker-compose.smoke.yml');
  if (!existsSync(composeFile)) {
    throw new Error(`compose file not found: ${composeFile}`);
  }

  const projectName = process.env.COMPOSE_PROJECT || `release-gate-${Date.now()}`;
  const port = parsePositiveInt(process.env.PORT, 0) || await findFreePort(18787);

  // override the port by generating a temporary compose override
  const override = {
    services: {
      'a2a-broker': {
        ports: [`127.0.0.1:${port}:8787`],
        environment: {
          PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
        },
      },
    },
  };

  const overrideDir = await mkdtemp(join(tmpdir(), 'release-gate-'));
  const overrideFile = join(overrideDir, 'override.yml');
  await writeFile(overrideFile, JSON.stringify(override, null, 2));

  const baseUrl = `http://127.0.0.1:${port}`;
  let compose;
  const composeArgs = (sub) => [
    ...compose.args,
    '-p', projectName,
    '-f', composeFile,
    '-f', overrideFile,
    sub,
  ];

  const report = { gate: 'compose-smoke', ok: false, baseUrl, composeProject: projectName };

  try {
    compose = await resolveComposeRunner();

    // 1. Build + start
    console.log(`[compose] starting stack (project=${projectName}, port=${port})…`);
    await run(compose.cmd, [...composeArgs('up'), '--build', '-d']);

    // 2. Wait for broker health
    console.log('[compose] waiting for broker health…');
    const health = await pollUntil(async () => {
      try {
        const r = await fetch(`${baseUrl}/health`);
        if (r.ok) return await r.json();
      } catch {}
      return null;
    }, { timeoutMs, label: 'broker-health' });
    report.health = health;
    if (health?.status !== 'ok') throw new Error(`unexpected health: ${JSON.stringify(health)}`);

    // 3. Verify worker registration
    console.log('[compose] verifying echo-worker-1 registration…');
    const worker = await pollUntil(async () => {
      try {
        return await requestJson(baseUrl, 'GET', '/workers/echo-worker-1', {
          requester: makeRequester('operator', 'compose'),
          edgeSecret,
        });
      } catch { return null; }
    }, { intervalMs: 2000, timeoutMs, label: 'worker-online' });
    report.workerStatus = worker?.status;
    if (worker?.status !== 'online') throw new Error(`worker not online: ${worker?.status}`);

    // 4. Seed a task
    const taskId = randomUUID();
    const requester = { id: 'smoke-operator', kind: 'service', role: 'operator' };
    console.log(`[compose] seeding task ${taskId.slice(0, 8)}…`);
    const created = await requestJson(baseUrl, 'POST', '/tasks', {
      requester, edgeSecret,
      body: {
        id: taskId,
        intent: 'chat',
        requester,
        target: { id: 'echo-worker-1', kind: 'node' },
        assignedWorkerId: 'echo-worker-1',
        message: 'release-gate compose smoke',
      },
    });
    report.createdStatus = created?.status;
    if (created?.status !== 'queued') throw new Error(`unexpected initial status: ${created?.status}`);

    // 5. Wait for succeeded
    console.log('[compose] waiting for task to succeed…');
    const succeeded = await pollUntil(async () => {
      try {
        const t = await requestJson(baseUrl, 'GET', `/tasks/${taskId}`, {
          requester: makeRequester('operator', 'compose-poll'),
          edgeSecret,
        });
        if (t?.status === 'succeeded') return t;
      } catch {}
      return null;
    }, { intervalMs: 2000, timeoutMs, label: 'task-succeeded' });
    report.finalStatus = succeeded?.status;

    // 6. Verify audit trail
    const audit = await requestJson(baseUrl, 'GET', `/audit?targetId=${taskId}`, {
      requester: makeRequester('operator', 'compose-audit'),
      edgeSecret,
    });
    const auditActions = Array.isArray(audit?.items) ? audit.items.map(i => i.action) : [];
    report.auditActions = auditActions;

    const expectedActions = ['task.created', 'task.claimed', 'task.started', 'task.succeeded'];
    const missing = expectedActions.filter(a => !auditActions.includes(a));
    if (missing.length) throw new Error(`missing audit actions: ${missing.join(', ')}`);

    // 7. Prove live-impact approval lifecycle: blocked -> approved/queued -> worker success.
    const approvalProof = await verifyApprovalLifecycle({
      baseUrl,
      edgeSecret,
      workerId: 'echo-worker-1',
      timeoutMs,
    });
    report.approvalLifecycle = approvalProof;

    report.ok = true;
    console.log(
      `[compose] ✅ PASSED — ${auditActions.length} base audit events; approval lifecycle proved`,
    );
    return { report, baseUrl, projectName, composeArgs };

  } finally {
    // always tear down
    if (compose) {
      try {
        console.log('[compose] tearing down…');
        await run(compose.cmd, [...composeArgs('down'), '--volumes']);
      } catch (e) {
        console.error(`[compose] teardown error: ${e.message}`);
      }
    }
    // clean override
    try { await run('rm', ['-rf', overrideDir]); } catch {}
  }
}

async function verifyApprovalLifecycle({ baseUrl, edgeSecret, workerId, timeoutMs }) {
  const operator = { id: 'smoke-operator', kind: 'service', role: 'operator' };
  const analyst = { id: 'smoke-analyst', kind: 'service', role: 'analyst' };
  const report = {};

  const approvedTaskId = randomUUID();
  console.log(`[compose] seeding approval-gated task ${approvedTaskId.slice(0, 8)}…`);
  const blocked = await requestJson(baseUrl, 'POST', '/tasks', {
    requester: analyst,
    edgeSecret,
    body: {
      id: approvedTaskId,
      intent: 'promote_to_live',
      requester: analyst,
      target: { id: workerId, kind: 'node', role: 'analyst' },
      assignedWorkerId: workerId,
      message: 'release-gate approval lifecycle: approve path',
    },
  });
  report.approveInitialStatus = blocked?.status;
  if (blocked?.status !== 'blocked') {
    throw new Error(`approval proof task did not block: ${blocked?.status}`);
  }
  if (blocked?.policyContext?.requiresApproval !== true) {
    throw new Error('approval proof task missing requiresApproval policy context');
  }

  const approved = await requestJson(baseUrl, 'POST', `/tasks/${approvedTaskId}/approve`, {
    requester: operator,
    edgeSecret,
    body: {
      actor: operator,
      approvalId: 'release-gate-approval',
      reason: 'release gate approval lifecycle proof',
    },
  });
  report.approveAfterDecisionStatus = approved?.status;
  if (approved?.status !== 'queued') {
    throw new Error(`approved task did not return to queued: ${approved?.status}`);
  }
  if (approved?.approvalOutcome?.status !== 'approved') {
    throw new Error(`approved task missing approved outcome: ${JSON.stringify(approved?.approvalOutcome)}`);
  }

  const succeeded = await pollUntil(async () => {
    try {
      const t = await requestJson(baseUrl, 'GET', `/tasks/${approvedTaskId}`, {
        requester: makeRequester('operator', 'compose-approval-poll'),
        edgeSecret,
      });
      if (t?.status === 'succeeded') return t;
    } catch {}
    return null;
  }, { intervalMs: 2000, timeoutMs, label: 'approved-task-succeeded' });
  report.approveFinalStatus = succeeded?.status;

  const approvedAudit = await requestJson(baseUrl, 'GET', `/audit?targetId=${approvedTaskId}`, {
    requester: makeRequester('operator', 'compose-approval-audit'),
    edgeSecret,
  });
  const approvedAuditActions = Array.isArray(approvedAudit?.items)
    ? approvedAudit.items.map(i => i.action)
    : [];
  report.approveAuditActions = approvedAuditActions;
  const expectedApprovedActions = [
    'task.created',
    'task.approved',
    'task.claimed',
    'task.started',
    'task.succeeded',
  ];
  const missingApproved = expectedApprovedActions.filter(a => !approvedAuditActions.includes(a));
  if (missingApproved.length) {
    throw new Error(`approved task missing audit actions: ${missingApproved.join(', ')}`);
  }

  const rejectedTaskId = randomUUID();
  console.log(`[compose] seeding rejected approval task ${rejectedTaskId.slice(0, 8)}…`);
  const rejectBlocked = await requestJson(baseUrl, 'POST', '/tasks', {
    requester: analyst,
    edgeSecret,
    body: {
      id: rejectedTaskId,
      intent: 'promote_to_live',
      requester: analyst,
      target: { id: workerId, kind: 'node', role: 'analyst' },
      assignedWorkerId: workerId,
      message: 'release-gate approval lifecycle: reject path',
    },
  });
  report.rejectInitialStatus = rejectBlocked?.status;
  if (rejectBlocked?.status !== 'blocked') {
    throw new Error(`rejection proof task did not block: ${rejectBlocked?.status}`);
  }

  const rejected = await requestJson(baseUrl, 'POST', `/tasks/${rejectedTaskId}/reject-approval`, {
    requester: operator,
    edgeSecret,
    body: {
      actor: operator,
      approvalId: 'release-gate-rejection',
      status: 'rejected',
      reason: 'release gate rejection lifecycle proof',
    },
  });
  report.rejectFinalStatus = rejected?.status;
  if (rejected?.status !== 'canceled') {
    throw new Error(`rejected task did not cancel: ${rejected?.status}`);
  }
  if (rejected?.approvalOutcome?.status !== 'rejected') {
    throw new Error(`rejected task missing rejected outcome: ${JSON.stringify(rejected?.approvalOutcome)}`);
  }

  // Give the echo worker a poll interval to prove the canceled task is not picked up.
  await delay(2500);
  const rejectedAudit = await requestJson(baseUrl, 'GET', `/audit?targetId=${rejectedTaskId}`, {
    requester: makeRequester('operator', 'compose-rejection-audit'),
    edgeSecret,
  });
  const rejectedAuditActions = Array.isArray(rejectedAudit?.items)
    ? rejectedAudit.items.map(i => i.action)
    : [];
  report.rejectAuditActions = rejectedAuditActions;
  if (!rejectedAuditActions.includes('task.approval_rejected')) {
    throw new Error(`rejected task missing task.approval_rejected audit action: ${rejectedAuditActions.join(', ')}`);
  }
  const forbiddenRejectedActions = ['task.claimed', 'task.started', 'task.succeeded'];
  const leakedRejectedActions = forbiddenRejectedActions.filter(a => rejectedAuditActions.includes(a));
  if (leakedRejectedActions.length) {
    throw new Error(`rejected task should not execute but saw: ${leakedRejectedActions.join(', ')}`);
  }

  return report;
}

// ---------------------------------------------------------------------------
// Gate: Restart Recovery
// ---------------------------------------------------------------------------

async function gateRestartRecovery({ baseUrl: providedBaseUrl, edgeSecret, timeoutMs }) {
  const baseUrl = providedBaseUrl;
  const workerId = `gate-recovery-${Date.now()}`;
  const restartCmd = process.env.BROKER_RESTART_CMD || `docker compose restart a2a-broker`;
  const workerEntry = resolve(brokerRoot, 'dist', 'worker.js');

  const report = { gate: 'restart-recovery', ok: false, baseUrl, workerId };

  let phase1Worker, phase2Worker;

  try {
    // 1. Start sleep worker
    console.log(`[recovery] starting phase-1 sleep worker (${workerId})…`);
    phase1Worker = spawnWorker({ baseUrl, edgeSecret, workerId, workerEntry, handlerMode: 'sleep', scriptPath });

    await pollUntil(async () => {
      try {
        const w = await requestJson(baseUrl, 'GET', `/workers/${encodeURIComponent(workerId)}`, {
          requester: makeRequester('operator', 'recovery'), edgeSecret,
        });
        return w?.status === 'online' ? w : null;
      } catch { return null; }
    }, { intervalMs: 1000, timeoutMs, label: 'phase1-worker-online' });

    // 2. Create task pinned to this worker
    const taskId = randomUUID();
    const requester = { id: `agent:main:gate:${randomUUID()}`, kind: 'session', role: 'hub' };
    console.log(`[recovery] seeding task ${taskId.slice(0, 8)}…`);
    await requestJson(baseUrl, 'POST', '/tasks', {
      requester, edgeSecret,
      body: {
        id: taskId, intent: 'chat', requester,
        target: { id: workerId, kind: 'node' },
        assignedWorkerId: workerId,
        message: 'release-gate restart recovery',
      },
    });

    // 3. Wait for running
    console.log('[recovery] waiting for task to reach running…');
    await pollUntil(async () => {
      const t = await requestJson(baseUrl, 'GET', `/tasks/${taskId}`, {
        requester: makeRequester('operator', 'recovery-poll'), edgeSecret,
      });
      return t?.status === 'running' ? t : null;
    }, { intervalMs: 2000, timeoutMs, label: 'task-running' });
    report.taskReachedRunning = true;

    // 4. Kill worker
    console.log('[recovery] killing phase-1 worker…');
    await stopChild(phase1Worker, 'SIGKILL');
    phase1Worker = undefined;

    // 5. Restart broker
    console.log('[recovery] restarting broker…');
    await run('bash', ['-lc', restartCmd]);

    // 6. Verify health returns
    console.log('[recovery] waiting for broker health after restart…');
    await pollUntil(async () => {
      try {
        const r = await fetch(`${baseUrl}/health`);
        if (r.ok) return await r.json();
      } catch {}
      return null;
    }, { timeoutMs: 30000, label: 'broker-health-after-restart' });

    // 7. Verify task still exists as running
    const persisted = await requestJson(baseUrl, 'GET', `/tasks/${taskId}`, {
      requester: makeRequester('operator', 'post-restart'), edgeSecret,
    });
    report.persistedStatus = persisted?.status;
    if (persisted?.status !== 'running') throw new Error(`task not persisted as running: ${persisted?.status}`);

    // 8. Force stale requeue
    console.log('[recovery] forcing stale requeue…');
    const requeue = await requestJson(baseUrl, 'POST', '/tasks/requeue_stale?older_than_seconds=0', {
      requester: makeRequester('operator', 'requeue'), edgeSecret,
    });
    report.requeued = requeue?.requeued;

    // 9. Start replacement echo worker
    console.log('[recovery] starting phase-2 echo worker…');
    phase2Worker = spawnWorker({ baseUrl, edgeSecret, workerId, workerEntry, handlerMode: 'echo', scriptPath });

    await pollUntil(async () => {
      try {
        const w = await requestJson(baseUrl, 'GET', `/workers/${encodeURIComponent(workerId)}`, {
          requester: makeRequester('operator', 'recovery'), edgeSecret,
        });
        return w?.status === 'online' ? w : null;
      } catch { return null; }
    }, { intervalMs: 1000, timeoutMs, label: 'phase2-worker-online' });

    // 10. Wait for succeeded
    console.log('[recovery] waiting for task to succeed after recovery…');
    const final = await pollUntil(async () => {
      try {
        const t = await requestJson(baseUrl, 'GET', `/tasks/${taskId}`, {
          requester: makeRequester('operator', 'recovery-poll'), edgeSecret,
        });
        return t?.status === 'succeeded' ? t : null;
      } catch { return null; }
    }, { intervalMs: 2000, timeoutMs, label: 'task-succeeded-after-recovery' });
    report.finalStatus = final?.status;

    // 11. Verify audit trail
    const audit = await requestJson(baseUrl, 'GET', `/audit?targetId=${taskId}`, {
      requester: makeRequester('operator', 'recovery-audit'), edgeSecret,
    });
    const auditActions = Array.isArray(audit?.items) ? audit.items.map(i => i.action) : [];
    report.auditActions = auditActions;

    const expectedRecovery = ['task.requeued'];
    const missing = expectedRecovery.filter(a => !auditActions.includes(a));
    if (missing.length) throw new Error(`missing recovery audit actions: ${missing.join(', ')}`);

    report.ok = true;
    console.log(`[recovery] ✅ PASSED — ${auditActions.length} audit events`);
    return report;

  } finally {
    await stopChild(phase1Worker, 'SIGKILL').catch(() => {});
    await stopChild(phase2Worker, 'SIGTERM').catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Worker helpers
// ---------------------------------------------------------------------------

function spawnWorker({ baseUrl, edgeSecret, workerId, workerEntry, handlerMode, scriptPath }) {
  const env = {
    ...process.env,
    BROKER_URL: baseUrl,
    ...(edgeSecret ? { BROKER_EDGE_SECRET: edgeSecret } : {}),
    WORKER_ID: workerId,
    WORKER_ROLE: 'analyst',
    WORKER_POLL_INTERVAL_MS: '1000',
    WORKER_HEARTBEAT_INTERVAL_MS: '2000',
    WORKER_HANDLER_TIMEOUT_MS: '310000',
  };
  if (handlerMode === 'sleep') {
    env.WORKER_HANDLER_COMMAND = process.execPath;
    env.WORKER_HANDLER_ARGS_JSON = JSON.stringify([scriptPath, '--sleep-handler']);
  } else {
    env.WORKER_HANDLER_BUILTIN = 'echo';
  }
  const child = spawn(process.execPath, [workerEntry], { cwd: brokerRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
  streamLogs(child, `worker:${workerId}:${handlerMode}`);
  return child;
}

async function stopChild(child, signal = 'SIGTERM', timeoutMs = 5000) {
  if (!child || child.exitCode !== null || child.killed) return;
  child.kill(signal);
  await new Promise(resolve => {
    const t = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); resolve(); }, timeoutMs);
    child.once('exit', () => { clearTimeout(t); resolve(); });
  });
}

// Sleep handler mode (reused from restart-recovery-smoke.mjs pattern)
if (process.argv.includes('--sleep-handler')) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const task = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  await delay(Number(process.env.RESTART_RECOVERY_HANDLER_SLEEP_MS ?? '300000'));
  process.stdout.write(JSON.stringify({ result: { summary: `sleep handler ${task.id ?? '?'}` } }));
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Port helper
// ---------------------------------------------------------------------------

async function findFreePort(preferred) {
  const net = await import('node:net');
  for (const port of [preferred, 18788, 18789, 18790, 18791, 18792]) {
    try {
      await new Promise((resolve, reject) => {
        const s = net.createServer();
        s.once('error', reject);
        s.once('listening', () => { s.close(); resolve(); });
        s.listen(port, '127.0.0.1');
      });
      return port;
    } catch {}
  }
  throw new SetupError('no free port found');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const skipCompose = args.includes('--skip-compose');
  const skipRecovery = args.includes('--skip-recovery');
  const timeoutMs = parsePositiveInt(process.env.SMOKE_TIMEOUT_MS, 120000);
  const edgeSecret = process.env.BROKER_EDGE_SECRET || '';

  if (skipCompose && skipRecovery) {
    console.error('error: cannot skip both gates');
    process.exit(2);
  }

  console.log('='.repeat(60));
  console.log('a2a-broker release gate v1.0');
  console.log(`compose-smoke: ${skipCompose ? 'SKIP' : 'RUN'}`);
  console.log(`restart-recovery: ${skipRecovery ? 'SKIP' : 'RUN'}`);
  console.log(`timeout: ${timeoutMs}ms`);
  console.log('='.repeat(60));

  const results = [];

  // Phase 1: Compose smoke
  if (!skipCompose) {
    const t0 = Date.now();
    try {
      const { report } = await gateComposeSmoke({ edgeSecret, timeoutMs });
      report.durationMs = Date.now() - t0;
      results.push(report);
    } catch (err) {
      results.push(gateFailure('compose-smoke', err, Date.now() - t0));
      console.error(`[compose] ❌ FAILED: ${err.message}`);
    }
  }

  // Phase 2: Restart recovery
  // If compose ran successfully, reuse its baseUrl. Otherwise require BROKER_URL.
  if (!skipRecovery) {
    const composeResult = results.find(r => r.gate === 'compose-smoke');
    let baseUrl;

    if (composeResult?.ok) {
      // compose was torn down; recovery needs a persistent broker
      console.log('\n⚠️  Compose smoke passed and stack was torn down.');
      console.log('   Restart-recovery requires a persistent broker instance.');
      console.log('   Set BROKER_URL and BROKER_EDGE_SECRET, then re-run with --skip-compose');
      console.log('   Example: BROKER_URL=http://127.0.0.1:8787 BROKER_EDGE_SECRET=xxx node scripts/release-gate.mjs --skip-compose\n');
      results.push({
        gate: 'restart-recovery', ok: true, skipped: true,
        nonBlocking: true,
        reason: 'compose stack torn down; run with --skip-compose and BROKER_URL',
      });
    } else {
      baseUrl = process.env.BROKER_URL || process.env.A2A_BROKER_URL;
      if (!baseUrl) {
        console.error('error: BROKER_URL required for restart-recovery (no compose stack available)');
        results.push({ gate: 'restart-recovery', ok: false, skipped: true, setupError: true, reason: 'BROKER_URL not set' });
      } else {
        const t0 = Date.now();
        try {
          const report = await gateRestartRecovery({ baseUrl, edgeSecret, timeoutMs });
          report.durationMs = Date.now() - t0;
          results.push(report);
        } catch (err) {
          results.push(gateFailure('restart-recovery', err, Date.now() - t0));
          console.error(`[recovery] ❌ FAILED: ${err.message}`);
        }
      }
    }
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('RELEASE GATE SUMMARY');
  console.log('='.repeat(60));

  const allPassed = results.every(r => r.ok);
  const hasSetupError = results.some(r => r.setupError);
  const hasNonBlockingSkip = results.some(r => r.ok && r.skipped && r.nonBlocking);
  for (const r of results) {
    const icon = r.ok ? '✅' : '❌';
    const label = r.skipped ? '⏭️' : icon;
    const detail = r.error || r.reason || `${r.durationMs}ms`;
    console.log(`  ${label} ${r.gate}: ${detail}`);
  }

  console.log('='.repeat(60));
  if (allPassed && hasNonBlockingSkip) {
    console.log('RESULT: GATES PASSED — broker is ready for compose-smoke cut (restart-recovery skipped)');
  } else if (allPassed) {
    console.log('RESULT: ALL GATES PASSED — broker is ready for the next cut');
  } else if (hasSetupError) {
    console.log('RESULT: SETUP ERROR — install/configure required dependencies before shipping');
  } else {
    console.log('RESULT: ONE OR MORE GATES FAILED — do not ship');
  }

  // Output machine-readable JSON
  console.log('\n--- JSON ---');
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), results }, null, 2));

  process.exit(allPassed ? 0 : (hasSetupError ? 2 : 1));
}

main().catch(err => {
  console.error(`fatal: ${err.message}`);
  process.exit(2);
});
