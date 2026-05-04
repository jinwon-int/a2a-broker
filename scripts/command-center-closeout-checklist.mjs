#!/usr/bin/env node
// Command-center closeout checklist (issue #355).
//
// Read-only by design. This script consumes sanitized evidence and can perform
// optional GET-only GitHub/broker reads; it never deploys, restarts Gateway,
// sends Telegram, mutates broker state, or ACKs terminal-outbox records.

import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import process from 'node:process';

const ACTIVE_STATUSES = ['blocked', 'queued', 'claimed', 'running'];
const SAFE_URL_RE = /^https:\/\//;

function parseArgs(argv) {
  const readOption = (name) => {
    const prefix = `${name}=`;
    const inline = argv.find((arg) => arg.startsWith(prefix));
    if (inline) return inline.slice(prefix.length);
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    input: readOption('--input'),
    repo: readOption('--repo'),
    issue: readOption('--issue'),
    pr: readOption('--pr'),
    dashboardUrl: readOption('--dashboard-url'),
    edgeSecretEnv: readOption('--edge-secret-env') ?? 'BROKER_EDGE_SECRET',
    json: argv.includes('--json') || argv.includes('--format=json'),
    markdown: argv.includes('--markdown') || argv.includes('--format=markdown'),
  };
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function getNested(object, path) {
  return path.split('.').reduce((current, key) => current?.[key], object);
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function isHttpsUrl(value) {
  return typeof value === 'string' && SAFE_URL_RE.test(value);
}

function sanitize(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, '[redacted-token]')
    .replace(/\b(BROKER_EDGE_SECRET|EDGE_SECRET|TOKEN|SECRET)=\S+/gi, '$1=[redacted]')
    .replace(/\/work\/[A-Za-z0-9_.\/-]+/g, '[path]')
    .slice(0, 240);
}

function parseIssueNumberFromUrl(url) {
  if (!isHttpsUrl(url)) return undefined;
  try {
    const match = new URL(url).pathname.match(/\/issues\/(\d+)\/?$/);
    return match?.[1] ? `#${match[1]}` : undefined;
  } catch {
    return undefined;
  }
}

function parseRepoFromUrl(url) {
  if (!isHttpsUrl(url)) return undefined;
  try {
    const [, owner, repo] = new URL(url).pathname.split('/');
    return owner && repo ? `${owner}/${repo}` : undefined;
  } catch {
    return undefined;
  }
}

function normalizeIssue(value) {
  if (typeof value === 'number') return `#${value}`;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (/^#\d+$/.test(trimmed)) return trimmed;
  if (/^\d+$/.test(trimmed)) return `#${trimmed}`;
  if (isHttpsUrl(trimmed)) return parseIssueNumberFromUrl(trimmed);
  return trimmed || undefined;
}

function queueCounts(evidence) {
  const source = firstDefined(
    getNested(evidence, 'dashboard.operatorSnapshot.taskStatusSummary.byStatus'),
    getNested(evidence, 'operatorSnapshot.taskStatusSummary.byStatus'),
    getNested(evidence, 'dashboard.queue.byStatus'),
    evidence.queue?.byStatus,
    evidence.queue,
    evidence.diagnostics?.tasks,
    {},
  ) ?? {};

  const counts = Object.fromEntries(ACTIVE_STATUSES.map((status) => [status, toNumber(source[status]) ?? 0]));
  const active = toNumber(firstDefined(
    getNested(evidence, 'dashboard.operatorSnapshot.taskStatusSummary.active'),
    getNested(evidence, 'operatorSnapshot.taskStatusSummary.active'),
    evidence.queue?.active,
  )) ?? ACTIVE_STATUSES.reduce((sum, status) => sum + counts[status], 0);

  return { ...counts, active };
}

function staleTaskCount(evidence) {
  return toNumber(firstDefined(
    evidence.staleTasks,
    evidence.queue?.stale,
    getNested(evidence, 'dashboard.operatorSnapshot.recoverySummary.stale.staleTasks'),
    getNested(evidence, 'dashboard.observability.queuePressure.staleTasks'),
    getNested(evidence, 'dashboard.attention.counts.stale_task'),
  )) ?? asArray(firstDefined(
    getNested(evidence, 'dashboard.operatorSnapshot.attentionItems'),
    getNested(evidence, 'operatorSnapshot.attentionItems'),
  )).filter((item) => item?.code === 'stale_task').length;
}

function staleWorkerCount(evidence) {
  const staleWorkers = firstDefined(
    getNested(evidence, 'dashboard.operatorSnapshot.recoverySummary.stale.staleWorkersWithActiveTasks'),
    getNested(evidence, 'operatorSnapshot.recoverySummary.stale.staleWorkersWithActiveTasks'),
    getNested(evidence, 'dashboard.observability.workerHealth.staleWorkersWithActiveTasks'),
  );
  if (Array.isArray(staleWorkers)) return staleWorkers.length;
  const direct = toNumber(firstDefined(
    evidence.staleWorkers,
    evidence.workers?.stale,
    staleWorkers,
    getNested(evidence, 'dashboard.observability.queuePressure.staleWorkerAssignments'),
  ));
  if (direct !== undefined) return direct;
  return asArray(firstDefined(getNested(evidence, 'dashboard.workers.items'), evidence.workers?.items, evidence.workers))
    .filter((worker) => worker?.status === 'stale').length;
}

function normalizeCheck(check) {
  const name = sanitize(firstDefined(check?.name, check?.context, check?.check, check?.workflowName, 'check'));
  const state = sanitize(firstDefined(check?.conclusion, check?.status, check?.state, check?.detail, 'unknown'));
  const ok = ['success', 'passed', 'pass', 'completed', 'neutral', 'skipped'].includes(String(state).toLowerCase());
  return { name, state, ok };
}

function checksFromEvidence(evidence) {
  const raw = firstDefined(
    evidence.checks,
    evidence.github?.checks,
    evidence.github?.statusCheckRollup,
    evidence.pr?.statusCheckRollup,
  );
  return asArray(raw).map(normalizeCheck);
}

function summarizeChecks(checks) {
  if (checks.length === 0) return { label: 'missing', ok: false, total: 0, passing: 0, failing: 0 };
  const failing = checks.filter((check) => !check.ok);
  const sample = failing[0] ?? checks[0];
  return {
    label: failing.length === 0
      ? `${checks.length}/${checks.length} passing`
      : `${checks.length - failing.length}/${checks.length} passing; first failing=${sample.name}:${sample.state}`,
    ok: failing.length === 0,
    total: checks.length,
    passing: checks.length - failing.length,
    failing: failing.length,
  };
}

function githubEvidence(evidence) {
  const issueUrl = firstDefined(evidence.issueUrl, evidence.github?.issueUrl, evidence.issue?.url);
  const prUrl = firstDefined(evidence.prUrl, evidence.github?.prUrl, evidence.pr?.url);
  const repo = firstDefined(evidence.repo, evidence.github?.repo, parseRepoFromUrl(prUrl), parseRepoFromUrl(issueUrl));
  const issue = normalizeIssue(firstDefined(evidence.laneIssue, evidence.issue, evidence.github?.issue, issueUrl));
  const prState = sanitize(firstDefined(evidence.prState, evidence.github?.prState, evidence.pr?.state));
  const mergeState = sanitize(firstDefined(evidence.mergeState, evidence.github?.mergeState, evidence.pr?.mergeStateStatus));
  const mergedAt = sanitize(firstDefined(evidence.mergedAt, evidence.github?.mergedAt, evidence.pr?.mergedAt));
  const issueState = sanitize(firstDefined(evidence.issueState, evidence.github?.issueState, evidence.issue?.state));
  return { repo, issue, issueUrl, prUrl, prState, mergeState, mergedAt, issueState, checks: checksFromEvidence(evidence) };
}

function liveGhEvidence({ repo, issue, pr }) {
  if (!repo || !issue) return {};
  const issueNumber = String(issue).replace(/^#/, '');
  const issueRaw = execFileSync('gh', ['issue', 'view', issueNumber, '--repo', repo, '--json', 'number,state,url'], { encoding: 'utf8' });
  const issueData = JSON.parse(issueRaw);
  const out = { repo, issue: `#${issueData.number}`, issueUrl: issueData.url, issueState: issueData.state };
  if (pr) {
    const prNumber = String(pr).replace(/^#/, '').replace(/^.*\/pull\//, '');
    const prRaw = execFileSync('gh', ['pr', 'view', prNumber, '--repo', repo, '--json', 'number,url,state,mergedAt,mergeStateStatus,statusCheckRollup'], { encoding: 'utf8' });
    const prData = JSON.parse(prRaw);
    out.prUrl = prData.url;
    out.prState = prData.state;
    out.mergedAt = prData.mergedAt;
    out.mergeState = prData.mergeStateStatus;
    out.checks = asArray(prData.statusCheckRollup).map((check) => ({ name: check.name ?? check.context, conclusion: check.conclusion ?? check.status }));
  }
  return { github: out };
}

async function liveDashboardEvidence({ dashboardUrl, edgeSecretEnv }) {
  if (!dashboardUrl) return {};
  const headers = {};
  const secret = process.env[edgeSecretEnv];
  if (secret) headers['x-broker-edge-secret'] = secret;
  const response = await fetch(dashboardUrl, { headers });
  if (!response.ok) throw new Error(`dashboard GET failed: HTTP ${response.status}`);
  return { dashboard: await response.json() };
}

export function buildCommandCenterCloseoutChecklist(evidence) {
  const github = githubEvidence(evidence);
  const checks = summarizeChecks(github.checks);
  const queue = queueCounts(evidence);
  const stale = { workers: staleWorkerCount(evidence), tasks: staleTaskCount(evidence) };
  const requeued = toNumber(firstDefined(
    evidence.requeued,
    evidence.queue?.requeued,
    getNested(evidence, 'dashboard.operatorSnapshot.recoverySummary.retry.totalRequeued'),
    getNested(evidence, 'operatorSnapshot.recoverySummary.retry.totalRequeued'),
    getNested(evidence, 'dashboard.observability.recovery.totalRequeued'),
  )) ?? 0;

  const required = [
    { ok: Boolean(github.repo && github.issue), check: 'lane issue', detail: github.repo && github.issue ? `${github.repo}${github.issue}` : 'missing repo or issue' },
    { ok: isHttpsUrl(github.prUrl), check: 'PR evidence', detail: github.prUrl ?? 'missing PR URL' },
    { ok: checks.total > 0, check: 'CI/check evidence', detail: checks.label },
    { ok: Boolean(github.prState || github.mergedAt || github.mergeState) && Boolean(github.issueState), check: 'merge/close evidence', detail: `pr=${github.mergedAt ? 'merged' : github.prState ?? github.mergeState ?? 'unknown'} issue=${github.issueState ?? 'unknown'}` },
    { ok: Number.isFinite(queue.active), check: 'active queue count', detail: `active=${queue.active} queued=${queue.queued} claimed=${queue.claimed} running=${queue.running} blocked=${queue.blocked}` },
    { ok: Number.isFinite(stale.workers) && Number.isFinite(stale.tasks), check: 'stale worker/task counts', detail: `workers=${stale.workers} tasks=${stale.tasks} requeued=${requeued}` },
  ];

  const readiness = [
    { ok: checks.total === 0 ? undefined : checks.ok, check: 'checks passing', detail: checks.label },
    { ok: queue.active === 0, check: 'queue empty', detail: `active=${queue.active}` },
    { ok: stale.workers === 0 && stale.tasks === 0, check: 'stale clear', detail: `workers=${stale.workers} tasks=${stale.tasks}` },
  ];

  const blockers = [...required, ...readiness.filter((item) => item.ok === false)].filter((item) => item.ok === false);
  return {
    kind: 'broker.command-center-closeout-checklist',
    generatedAt: new Date().toISOString(),
    mode: evidence.mode ?? 'read-only/no-live',
    lane: { repo: github.repo, issue: github.issue, issueUrl: github.issueUrl },
    pr: { url: github.prUrl, state: github.prState, mergeState: github.mergeState, mergedAt: github.mergedAt },
    issue: { state: github.issueState },
    ci: checks,
    queue,
    stale,
    requeued,
    checks: required,
    readiness,
    ok: blockers.length === 0,
  };
}

export function renderCommandCenterCloseoutMarkdown(report) {
  const title = report.ok ? 'Done' : 'Block';
  const lane = [report.lane.repo, report.lane.issue].filter(Boolean).join('') || 'missing';
  const mergeClose = `pr=${report.pr.mergedAt ? 'merged' : report.pr.state ?? report.pr.mergeState ?? 'unknown'} issue=${report.issue.state ?? 'unknown'}`;
  return [
    `${title}: command-center closeout checklist`,
    `Mode: ${report.mode}`,
    `Lane issue: ${lane}${report.lane.issueUrl ? ` (${report.lane.issueUrl})` : ''}`,
    `PR: ${report.pr.url ?? 'missing'}`,
    `CI/check: ${report.ci.label}`,
    `Merge/close: ${mergeClose}`,
    `Active queue: ${report.queue.active} (queued=${report.queue.queued}, claimed=${report.queue.claimed}, running=${report.queue.running}, blocked=${report.queue.blocked})`,
    `Stale/retry: workers=${report.stale.workers}, tasks=${report.stale.tasks}, requeued=${report.requeued}`,
    '',
    'Checklist:',
    ...report.checks.map((check) => `- ${check.ok ? 'PASS' : 'FAIL'} ${check.check}: ${sanitize(check.detail)}`),
    ...report.readiness.filter((check) => check.ok === false).map((check) => `- FAIL ${check.check}: ${sanitize(check.detail)}`),
    '',
    'Safety: read-only only; no live Telegram send, Gateway restart, production deploy, broker mutation, or terminal-outbox ACK.',
  ].join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let evidence = {};
  if (options.input) evidence = JSON.parse(await readFile(options.input, 'utf8'));
  if (options.repo && options.issue) evidence = { ...evidence, ...liveGhEvidence(options) };
  if (options.dashboardUrl) evidence = { ...evidence, ...(await liveDashboardEvidence(options)) };
  if (!options.input && !(options.repo && options.issue) && !options.dashboardUrl) {
    throw new Error('usage: node scripts/command-center-closeout-checklist.mjs --input evidence.json [--markdown|--json] OR --repo owner/repo --issue N [--pr N] [--dashboard-url URL]');
  }
  const report = buildCommandCenterCloseoutChecklist(evidence);
  if (options.json && !options.markdown) console.log(JSON.stringify(report, null, 2));
  else console.log(renderCommandCenterCloseoutMarkdown(report));
  process.exit(report.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`command-center-closeout-checklist: ${sanitize(error.message)}`);
    process.exit(2);
  });
}
