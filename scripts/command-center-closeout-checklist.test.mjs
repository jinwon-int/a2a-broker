import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCommandCenterCloseoutChecklist,
  renderCommandCenterCloseoutMarkdown,
} from './command-center-closeout-checklist.mjs';

function completeEvidence(overrides = {}) {
  return deepMerge({
    mode: 'read-only/no-live',
    github: {
      repo: 'jinwon-int/a2a-broker',
      issue: '#355',
      issueUrl: 'https://github.com/jinwon-int/a2a-broker/issues/355',
      prUrl: 'https://github.com/jinwon-int/a2a-broker/pull/356',
      prState: 'MERGED',
      mergedAt: '2026-05-04T13:00:00Z',
      issueState: 'CLOSED',
      checks: [
        { name: 'test', conclusion: 'success' },
        { name: 'build', conclusion: 'success' },
      ],
    },
    dashboard: {
      queue: { byStatus: { blocked: 0, queued: 0, claimed: 0, running: 0 } },
      operatorSnapshot: {
        taskStatusSummary: { active: 0, byStatus: { blocked: 0, queued: 0, claimed: 0, running: 0 } },
        recoverySummary: {
          stale: { staleWorkersWithActiveTasks: [] },
          retry: { totalRequeued: 1 },
        },
        attentionItems: [],
      },
    },
  }, overrides);
}

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch ?? base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? deepMerge(base?.[key] ?? {}, value)
      : value;
  }
  return out;
}

describe('command-center closeout checklist', () => {
  it('passes a compact read-only closeout bundle with lane, PR, CI, merge, queue, and stale counts', () => {
    const report = buildCommandCenterCloseoutChecklist(completeEvidence());

    assert.equal(report.ok, true);
    assert.equal(report.lane.repo, 'jinwon-int/a2a-broker');
    assert.equal(report.lane.issue, '#355');
    assert.equal(report.pr.url, 'https://github.com/jinwon-int/a2a-broker/pull/356');
    assert.equal(report.ci.label, '2/2 passing');
    assert.equal(report.queue.active, 0);
    assert.equal(report.stale.workers, 0);
    assert.equal(report.stale.tasks, 0);

    const markdown = renderCommandCenterCloseoutMarkdown(report);
    assert.match(markdown, /^Done: command-center closeout checklist/);
    assert.match(markdown, /Lane issue: jinwon-int\/a2a-broker#355/);
    assert.match(markdown, /CI\/check: 2\/2 passing/);
    assert.match(markdown, /Active queue: 0 \(queued=0, claimed=0, running=0, blocked=0\)/);
    assert.match(markdown, /Stale\/retry: workers=0, tasks=0, requeued=1/);
    assert.doesNotMatch(markdown, /ghp_|BROKER_EDGE_SECRET=|\/work\/repo/);
  });

  it('blocks when checks fail or active/stale work remains, but still reports compact evidence', () => {
    const report = buildCommandCenterCloseoutChecklist(completeEvidence({
      github: { checks: [{ name: 'test', conclusion: 'failure' }] },
      dashboard: {
        operatorSnapshot: {
          taskStatusSummary: { active: 2, byStatus: { blocked: 0, queued: 1, claimed: 1, running: 0 } },
          recoverySummary: { stale: { staleWorkersWithActiveTasks: ['nosuk'] } },
          attentionItems: [{ code: 'stale_task', taskId: 'task-1' }],
        },
      },
    }));

    assert.equal(report.ok, false);
    assert.equal(report.ci.failing, 1);
    assert.equal(report.queue.active, 2);
    assert.equal(report.stale.workers, 1);
    assert.equal(report.stale.tasks, 1);

    const markdown = renderCommandCenterCloseoutMarkdown(report);
    assert.match(markdown, /^Block: command-center closeout checklist/);
    assert.match(markdown, /FAIL checks passing/);
    assert.match(markdown, /FAIL queue empty: active=2/);
    assert.match(markdown, /FAIL stale clear: workers=1 tasks=1/);
  });

  it('fails required evidence closed when lane issue or PR is missing', () => {
    const report = buildCommandCenterCloseoutChecklist({
      queue: { queued: 0, claimed: 0, running: 0, blocked: 0, stale: 0 },
      checks: [{ name: 'smoke', conclusion: 'success' }],
      prState: 'OPEN',
      issueState: 'OPEN',
    });

    assert.equal(report.ok, false);
    assert.equal(report.checks.find((check) => check.check === 'lane issue')?.ok, false);
    assert.equal(report.checks.find((check) => check.check === 'PR evidence')?.ok, false);
  });
});
