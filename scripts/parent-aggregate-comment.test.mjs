import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_MARKER,
  buildParentAggregateMarkdown,
  findManagedComment,
  upsertManagedIssueComment,
} from './parent-aggregate-comment.mjs';

function taskReport(overrides = {}) {
  return {
    generatedAt: '2026-05-05T17:01:00.000Z',
    total: 2,
    active: 1,
    terminal: 1,
    stale: 1,
    reportable: 2,
    allTerminal: false,
    items: [
      { taskId: 'task-1', status: 'succeeded', final: true, stale: false, reportable: true, reportLine: '완료: dungae / #369 — https://github.com/jinwon-int/a2a-broker/pull/370' },
      { taskId: 'task-2', status: 'running', final: false, stale: true, reportable: true, reportLine: '중간보고 필요: nosuk / #371 — running 상태 20m 동안 갱신 없음' },
    ],
    ...overrides,
  };
}

function mockGithub(initialComments = []) {
  const calls = [];
  const comments = [...initialComments];
  return {
    calls,
    listIssueComments(repo, issue) {
      calls.push(['list', repo, issue]);
      return comments;
    },
    createIssueComment(repo, issue, body) {
      calls.push(['create', repo, issue, body]);
      return { id: 42, html_url: `https://github.com/${repo}/issues/${issue}#issuecomment-42` };
    },
    updateIssueComment(repo, id, body) {
      calls.push(['update', repo, id, body]);
      return { id, html_url: `https://github.com/${repo}/issues/comments/${id}` };
    },
  };
}

describe('parent aggregate comment helper', () => {
  it('renders a preview with task-report and closeout markdown without leaking secrets or local paths', () => {
    const markdown = buildParentAggregateMarkdown({
      taskReport: taskReport(),
      closeoutMarkdown: 'Done: closeout\nTOKEN=ghp_abcdefghijklmnopqrstuvwxyz1234567890\npath=/work/repo/secret.txt',
      repo: 'jinwon-int/a2a-broker',
      issue: '#364',
    });

    assert.match(markdown, new RegExp(DEFAULT_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(markdown, /Parent issue: jinwon-int\/a2a-broker#364/);
    assert.match(markdown, /Tasks: total=2 active=1 terminal=1 stale=1 reportable=2/);
    assert.match(markdown, /완료: dungae \/ #369/);
    assert.match(markdown, /Done: closeout/);
    assert.doesNotMatch(markdown, /ghp_/);
    assert.doesNotMatch(markdown, /TOKEN=ghp_/);
    assert.doesNotMatch(markdown, /\/work\/repo/);
  });

  it('creates one managed parent comment when no marker exists', () => {
    const github = mockGithub([{ id: 1, body: 'unmanaged comment' }]);
    const body = buildParentAggregateMarkdown({ taskReport: taskReport(), repo: 'jinwon-int/a2a-broker', issue: '364' });

    const result = upsertManagedIssueComment({ repo: 'jinwon-int/a2a-broker', issue: '364', body, github });

    assert.equal(result.action, 'created');
    assert.deepEqual(github.calls.map((call) => call[0]), ['list', 'create']);
    assert.equal(github.calls[1][2], '364');
  });

  it('updates the existing managed parent comment instead of creating a duplicate', () => {
    const github = mockGithub([{ id: 99, html_url: 'https://github.com/o/r/issues/1#issuecomment-99', body: `${DEFAULT_MARKER}\nold aggregate` }]);
    const body = buildParentAggregateMarkdown({ taskReport: taskReport({ active: 0, stale: 0, allTerminal: true }), repo: 'jinwon-int/a2a-broker', issue: '364' });

    const result = upsertManagedIssueComment({ repo: 'jinwon-int/a2a-broker', issue: '#364', body, github });

    assert.equal(result.action, 'updated');
    assert.equal(result.id, 99);
    assert.deepEqual(github.calls.map((call) => call[0]), ['list', 'update']);
    assert.equal(github.calls[1][2], 99);
  });

  it('finds managed comments only by the configured marker', () => {
    const managed = { id: 2, body: `${DEFAULT_MARKER}\naggregate` };
    assert.equal(findManagedComment([{ id: 1, body: 'other' }, managed]), managed);
    assert.equal(findManagedComment([{ id: 3, body: 'other' }]), undefined);
  });
});
