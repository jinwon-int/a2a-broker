#!/usr/bin/env node
// Idempotent parent aggregate comment helper (issue #369).
//
// Preview-first by default. Posting/updating requires --mode=post or --mode=update
// and uses a managed marker so repeated operator runs update one comment instead
// of spamming the parent issue.

import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import process from 'node:process';

export const DEFAULT_MARKER = '<!-- a2a-command-center-parent-aggregate:v1 -->';
const SAFE_URL_RE = /^https:\/\//;

function parseArgs(argv) {
  const readOption = (name) => {
    const prefix = `${name}=`;
    const inline = argv.find((arg) => arg.startsWith(prefix));
    if (inline) return inline.slice(prefix.length);
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const mode = readOption('--mode') ?? (argv.includes('--post') ? 'post' : 'preview');
  return {
    taskReportJson: readOption('--task-report-json'),
    closeoutMarkdown: readOption('--closeout-markdown'),
    repo: readOption('--repo'),
    issue: readOption('--issue'),
    mode,
    marker: readOption('--marker') ?? DEFAULT_MARKER,
  };
}

function sanitize(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, '[redacted-token]')
    .replace(/\b(BROKER_EDGE_SECRET|EDGE_SECRET|TOKEN|SECRET)=\S+/gi, '$1=[redacted]')
    .replace(/\/work\/[A-Za-z0-9_.\/-]+/g, '[path]')
    .slice(0, 500);
}

function safeLine(value, fallback = '') {
  return sanitize(String(value ?? fallback)).replace(/[\r\n]+/g, ' ').trim();
}

function isHttpsUrl(value) {
  return typeof value === 'string' && SAFE_URL_RE.test(value);
}

function normalizeIssue(issue) {
  const value = String(issue ?? '').trim();
  if (!value) return '';
  if (/^#?\d+$/.test(value)) return value.replace(/^#/, '');
  if (isHttpsUrl(value)) {
    try {
      return new URL(value).pathname.match(/\/issues\/(\d+)\/?$/)?.[1] ?? value;
    } catch {
      return value;
    }
  }
  return value;
}

export function buildParentAggregateMarkdown({ taskReport = {}, closeoutMarkdown = '', repo, issue, marker = DEFAULT_MARKER, generatedAt = new Date().toISOString() } = {}) {
  const items = Array.isArray(taskReport.items) ? taskReport.items : [];
  const reportable = items.filter((item) => item?.reportable !== false);
  const lines = [
    marker,
    '## A2A Command Center Parent Aggregate',
    '',
    `Generated: ${safeLine(taskReport.generatedAt, generatedAt)}`,
    `Parent issue: ${safeLine(repo) || 'unknown'}${issue ? `#${safeLine(normalizeIssue(issue))}` : ''}`,
    `Tasks: total=${Number(taskReport.total ?? items.length)} active=${Number(taskReport.active ?? 0)} terminal=${Number(taskReport.terminal ?? 0)} stale=${Number(taskReport.stale ?? 0)} reportable=${Number(taskReport.reportable ?? reportable.length)}`,
    `All terminal: ${Boolean(taskReport.allTerminal)}`,
    '',
    '### Task report',
  ];

  if (reportable.length === 0) {
    lines.push('- No reportable task updates in the supplied task report.');
  } else {
    for (const item of reportable.slice(0, 50)) {
      const prefix = item.final ? 'terminal' : item.stale ? 'stale' : 'progress';
      lines.push(`- ${prefix}: ${safeLine(item.reportLine ?? `${item.taskId ?? 'task'} ${item.status ?? 'unknown'}`)}`);
    }
    if (reportable.length > 50) lines.push(`- … ${reportable.length - 50} additional reportable items omitted from comment preview.`);
  }

  if (closeoutMarkdown) {
    lines.push('', '### Closeout checklist', sanitize(closeoutMarkdown));
  }

  lines.push('', 'Safety: preview-first helper; GitHub write only when operator passes --mode=post or --mode=update.');
  return `${lines.join('\n')}\n`;
}

export function findManagedComment(comments, marker = DEFAULT_MARKER) {
  return (Array.isArray(comments) ? comments : []).find((comment) => typeof comment?.body === 'string' && comment.body.includes(marker));
}

export function upsertManagedIssueComment({ repo, issue, body, marker = DEFAULT_MARKER, github = defaultGithubClient() }) {
  if (!repo || !issue) throw new Error('repo and issue are required for post/update mode');
  if (!body?.includes(marker)) throw new Error('managed marker missing from comment body');
  const issueNumber = normalizeIssue(issue);
  const comments = github.listIssueComments(repo, issueNumber);
  const existing = findManagedComment(comments, marker);
  if (existing?.id) {
    const updated = github.updateIssueComment(repo, existing.id, body);
    return { action: 'updated', id: existing.id, url: updated?.html_url ?? existing.html_url };
  }
  const created = github.createIssueComment(repo, issueNumber, body);
  return { action: 'created', id: created?.id, url: created?.html_url };
}

function defaultGithubClient() {
  return {
    listIssueComments(repo, issue) {
      const raw = execFileSync('gh', ['api', `repos/${repo}/issues/${issue}/comments`, '--paginate'], { encoding: 'utf8' });
      return JSON.parse(raw || '[]');
    },
    createIssueComment(repo, issue, body) {
      const raw = execFileSync('gh', ['api', `repos/${repo}/issues/${issue}/comments`, '--method', 'POST', '--field', `body=${body}`], { encoding: 'utf8' });
      return JSON.parse(raw || '{}');
    },
    updateIssueComment(repo, commentId, body) {
      const raw = execFileSync('gh', ['api', `repos/${repo}/issues/comments/${commentId}`, '--method', 'PATCH', '--field', `body=${body}`], { encoding: 'utf8' });
      return JSON.parse(raw || '{}');
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.taskReportJson) throw new Error('usage: node scripts/parent-aggregate-comment.mjs --task-report-json report.json [--closeout-markdown closeout.md] [--repo owner/repo --issue N --mode=preview|post|update]');
  const taskReport = JSON.parse(await readFile(options.taskReportJson, 'utf8'));
  const closeoutMarkdown = options.closeoutMarkdown ? await readFile(options.closeoutMarkdown, 'utf8') : '';
  const body = buildParentAggregateMarkdown({ taskReport, closeoutMarkdown, repo: options.repo, issue: options.issue, marker: options.marker });

  if (options.mode === 'preview' || !options.mode) {
    console.log(body);
    return;
  }
  if (!['post', 'update'].includes(options.mode)) throw new Error(`unsupported mode: ${options.mode}`);
  const result = upsertManagedIssueComment({ repo: options.repo, issue: options.issue, body, marker: options.marker });
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`parent-aggregate-comment: ${sanitize(error.message)}`);
    process.exit(2);
  });
}
