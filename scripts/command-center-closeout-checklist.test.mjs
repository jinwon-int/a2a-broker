import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCommandCenterCloseoutChecklist,
  buildCommandCenterRoundCloseout,
  classifyCommandCenterLane,
  renderCommandCenterCloseoutMarkdown,
  renderCommandCenterRoundCloseoutMarkdown,
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

  it('classifies mixed terminal, active, stale, failed, and no-evidence task-report lanes', () => {
    const taskReport = {
      generatedAt: '2026-05-05T17:01:00.000Z',
      items: [
        {
          taskId: 'task-ready',
          status: 'succeeded',
          final: true,
          targetNodeId: 'nosuk',
          github: {
            repo: 'jinwon-int/a2a-broker',
            issue: '#368',
            issueUrl: 'https://github.com/jinwon-int/a2a-broker/issues/368',
            prUrl: 'https://github.com/jinwon-int/a2a-broker/pull/400',
          },
        },
        {
          taskId: 'task-waiting',
          status: 'running',
          final: false,
          stale: false,
          targetNodeId: 'bangtong',
          github: { repo: 'jinwon-int/a2a-broker', issue: '#369' },
        },
        {
          taskId: 'task-stuck',
          status: 'claimed',
          final: false,
          stale: true,
          targetNodeId: 'dungae',
          github: { repo: 'jinwon-int/a2a-broker', issue: '#370' },
        },
        {
          taskId: 'task-blocked',
          status: 'failed',
          final: true,
          errorCode: 'tests_failed',
          targetNodeId: 'sogyo',
          github: {
            repo: 'jinwon-int/a2a-broker',
            issue: '#371',
            blockCommentUrl: 'https://github.com/jinwon-int/a2a-broker/issues/371#issuecomment-1',
          },
        },
        {
          taskId: 'task-needs-evidence',
          status: 'succeeded',
          final: true,
          targetNodeId: 'haneul',
          github: { repo: 'jinwon-int/a2a-broker', issue: '#372' },
        },
      ],
    };

    assert.equal(classifyCommandCenterLane(taskReport.items[0]), 'ready');
    assert.equal(classifyCommandCenterLane(taskReport.items[1]), 'waiting');
    assert.equal(classifyCommandCenterLane(taskReport.items[2]), 'stuck');
    assert.equal(classifyCommandCenterLane(taskReport.items[3]), 'blocked');
    assert.equal(classifyCommandCenterLane(taskReport.items[4]), 'needs-evidence');

    const report = buildCommandCenterRoundCloseout(taskReport, { parent: '#364', round: 'aggregation-1', nowMs: Date.parse('2026-05-05T17:02:00.000Z') });
    assert.equal(report.ok, false);
    assert.deepEqual(report.counts, { ready: 1, waiting: 1, stuck: 1, blocked: 1, 'needs-evidence': 1 });

    const markdown = renderCommandCenterRoundCloseoutMarkdown(report);
    assert.match(markdown, /^Block: command-center round closeout/);
    assert.match(markdown, /nosuk \| jinwon-int\/a2a-broker#368 \| https:\/\/github.com\/jinwon-int\/a2a-broker\/pull\/400 \| ready \| next:/);
    assert.match(markdown, /bangtong \| jinwon-int\/a2a-broker#369 \| missing-evidence \| waiting \| next: wait for running task update/);
    assert.match(markdown, /dungae \| jinwon-int\/a2a-broker#370 \| missing-evidence \| stuck \| next: check worker heartbeat or reassign stale claimed task/);
    assert.match(markdown, /sogyo \| jinwon-int\/a2a-broker#371 \| https:\/\/github.com\/jinwon-int\/a2a-broker\/issues\/371#issuecomment-1 \| blocked \| next: inspect Block evidence and resolve blocker/);
    assert.match(markdown, /haneul \| jinwon-int\/a2a-broker#372 \| missing-evidence \| needs-evidence \| next: recover PR\/Done\/Block evidence before closeout/);
    assert.doesNotMatch(markdown, /ghp_|BROKER_EDGE_SECRET=|\/work\/repo/);
  });

  it('treats branch-only evidence as recovered failed evidence, not completed work', () => {
    const taskReport = {
      items: [
        {
          taskId: 'task-recovered-branch',
          status: 'failed',
          final: true,
          errorCode: 'pr_create_failed_or_missing_url',
          targetNodeId: 'nosuk',
          github: {
            repo: 'jinwon-int/a2a-broker',
            issue: '#443',
            branchUrl: 'https://github.com/jinwon-int/a2a-broker/tree/a2a-patch-scanner-closeout-evidence-442',
            partial: true,
          },
        },
        {
          taskId: 'task-branch-only-success',
          status: 'succeeded',
          final: true,
          targetNodeId: 'yukson',
          github: {
            repo: 'jinwon-int/a2a-broker',
            issue: '#448',
            branchUrl: 'https://github.com/jinwon-int/a2a-broker/tree/a2a-patch-no-terminal-marker',
          },
        },
      ],
    };

    assert.equal(classifyCommandCenterLane(taskReport.items[0]), 'blocked');
    assert.equal(classifyCommandCenterLane(taskReport.items[1]), 'needs-evidence');

    const report = buildCommandCenterRoundCloseout(taskReport, { parent: '#446', round: 'branchguard', nowMs: Date.parse('2026-05-09T08:30:00.000Z') });
    assert.equal(report.ok, false);
    assert.deepEqual(report.counts, { blocked: 1, 'needs-evidence': 1 });

    const markdown = renderCommandCenterRoundCloseoutMarkdown(report);
    assert.match(markdown, /nosuk \| jinwon-int\/a2a-broker#443 \| https:\/\/github.com\/jinwon-int\/a2a-broker\/tree\/a2a-patch-scanner-closeout-evidence-442 \| blocked \| next: inspect recovered branch evidence before retrying or replacing the worker/);
    assert.match(markdown, /yukson \| jinwon-int\/a2a-broker#448 \| https:\/\/github.com\/jinwon-int\/a2a-broker\/tree\/a2a-patch-no-terminal-marker \| needs-evidence \| next: recover PR\/Done\/Block evidence; branch-only evidence is not completion evidence for succeeded lanes/);
  });
});
