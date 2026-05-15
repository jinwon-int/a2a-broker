import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { TerminalTaskOutboxEvent } from "../core/terminal-event-outbox.js";
import {
  assertNoOpenClawRuntimePaths,
  findOpenClawRuntimePaths,
  planTerminalBriefGitHubCommentWrite,
  projectTerminalBriefGitHubEvidenceComment,
  reconcileTerminalBriefGitHubEvidenceComments,
  writeTerminalBriefGitHubEvidenceComment,
  type GitHubIssueCommentObservation,
  type TerminalBriefGitHubCommentTarget,
} from "./terminal-brief-evidence.js";

function makeTerminalEvent(overrides: Partial<TerminalTaskOutboxEvent> = {}): TerminalTaskOutboxEvent {
  return {
    id: "terminal:task-1:succeeded:2026-05-11T00%3A00%3A00.000Z",
    kind: "task.terminal",
    taskEventId: 77,
    payload: {
      taskId: "task-1",
      status: "succeeded",
      parentRoundId: "run-1",
      run: "run-1",
      originBrokerId: "gwakga",
      brokerOfRecordId: "seoseo",
      traceId: "trace-1",
      worker: "dungae",
      repo: "acme/platform",
      issue: 42,
      taskBrief: "safe brief",
      parentRoundProgress: 3,
      parentRoundTotal: 7,
      parentRoundOrder: 3,
      terminalBriefTitle: "A2A Terminal Brief 완료: dungae(3/7)",
      crossBrokerHandoff: {
        parentRoundId: "run-1",
        originBrokerId: "seoseo",
        handoffBrokerId: "gwakga",
        originTaskId: "gwakga-child-3",
        childWorkerId: "dungae",
      },
      notificationOwnership: {
        ownerBrokerId: "seoseo",
        scope: "parent-broker-only",
        providerSendPermittedByProjection: false,
        terminalAckPermittedByProjection: false,
        reason: "parent owns notifications",
      },
      prUrl: "https://github.com/acme/platform/pull/9",
      createdAt: "2026-05-11T00:00:00.000Z",
      updatedAt: "2026-05-11T00:05:00.000Z",
      completedAt: "2026-05-11T00:06:00.000Z",
    },
    createdAt: "2026-05-11T00:06:00.000Z",
    receipt: {
      status: "provider_sent",
      updatedAt: "2026-05-11T00:06:05.000Z",
      note: "provider accepted only",
    },
    ackAudit: {
      decision: "pending",
      reason: "provider send-only success recorded; awaiting receipt evidence",
      updatedAt: "2026-05-11T00:06:05.000Z",
      taskId: "task-1",
      receiptStatus: "provider_sent",
    },
    attempts: 1,
    ...overrides,
  };
}

describe("Terminal Brief GitHub evidence projection", () => {
  it("renders a manifest-bound PR comment without implying terminal ACK/read/visibility/approval", () => {
    const projection = projectTerminalBriefGitHubEvidenceComment({ kind: "terminal", event: makeTerminalEvent() });

    assert.ok(projection);
    assert.equal(projection.marker, "PR");
    assert.equal(projection.target.repo, "acme/platform");
    assert.equal(projection.target.number, 42);
    assert.equal(projection.manifest.semantics.githubCommentIsEvidenceLedgerEntry, true);
    assert.equal(projection.manifest.semantics.githubCommentIsTerminalAck, false);
    assert.equal(projection.manifest.semantics.githubCommentIsReadReceipt, false);
    assert.equal(projection.manifest.semantics.githubCommentIsVisibilityProof, false);
    assert.equal(projection.manifest.semantics.githubCommentIsOperatorApproval, false);
    assert.match(projection.body, /a2a:terminal-brief-github-evidence/);
    assert.match(projection.body, /manifest_sha256: [a-f0-9]{64}/);
    assert.equal(projection.manifest.terminalBriefTitle, "A2A Terminal Brief 완료: dungae(3/7)");
    assert.equal(projection.manifest.parentRoundId, "run-1");
    assert.equal(projection.manifest.originBrokerId, "gwakga");
    assert.equal(projection.manifest.brokerOfRecordId, "seoseo");
    assert.equal(projection.manifest.parentRoundProgress, 3);
    assert.equal(projection.manifest.parentRoundTotal, 7);
    assert.equal(projection.manifest.parentRoundOrder, 3);
    assert.deepEqual(projection.manifest.crossBrokerHandoff, {
      parentRoundId: "run-1",
      originBrokerId: "seoseo",
      handoffBrokerId: "gwakga",
      originTaskId: "gwakga-child-3",
      childWorkerId: "dungae",
    });
    assert.deepEqual(projection.manifest.notificationOwnership, {
      ownerBrokerId: "seoseo",
      scope: "parent-broker-only",
      providerSendPermittedByProjection: false,
      terminalAckPermittedByProjection: false,
    });
    assert.match(projection.body, /terminal_brief_title: A2A Terminal Brief 완료: dungae\(3\/7\)/);
    assert.match(projection.body, /parent_round_progress: 3\/7/);
    assert.match(projection.body, /parent_round_order: 3/);
    assert.match(projection.body, /origin_broker: gwakga/);
    assert.match(projection.body, /broker_of_record: seoseo/);
    assert.match(projection.body, /cross_broker_handoff: parent=run-1; origin=seoseo; handoff=gwakga; origin_task=gwakga-child-3; child_worker=dungae/);
    assert.match(projection.body, /notification_owner: seoseo \(parent-broker-only; provider_send_by_projection=false; terminal_ack_by_projection=false\)/);
    assert.match(projection.body, /pull_request: https:\/\/github\.com\/acme\/platform\/pull\/9/);
    assert.match(projection.body, /not a Terminal Brief ACK, read receipt, visibility proof, or operator approval/);
    assert.doesNotMatch(projection.body, /operator_visible.*confirmed/);
  });

  it("maps terminal success without a PR to Done and failed terminal events to Block", () => {
    const done = projectTerminalBriefGitHubEvidenceComment({
      kind: "terminal",
      event: makeTerminalEvent({
        payload: { ...makeTerminalEvent().payload, prUrl: undefined },
      }),
    });
    const block = projectTerminalBriefGitHubEvidenceComment({
      kind: "terminal",
      event: makeTerminalEvent({
        id: "terminal:task-1:failed:2026-05-11T00%3A00%3A00.000Z",
        payload: { ...makeTerminalEvent().payload, status: "failed", prUrl: undefined, blockUrl: "https://github.com/acme/platform/issues/42#issuecomment-99" },
      }),
    });

    assert.equal(done?.marker, "Done");
    assert.equal(block?.marker, "Block");
    assert.match(block?.body ?? "", /block: https:\/\/github\.com\/acme\/platform\/issues\/42#issuecomment-99/);
  });

  it("renders Start comments with the same manifest and idempotency contract", () => {
    const projection = projectTerminalBriefGitHubEvidenceComment({
      kind: "start",
      repo: "acme/platform",
      number: 42,
      taskId: "task-1",
      run: "run-1",
      worker: "dungae",
      status: "running",
    });

    assert.ok(projection);
    assert.equal(projection.marker, "Start");
    assert.match(projection.idempotencyKey, /terminal-brief:task-start/);
    assert.match(projection.body, /\[a2a:Start\] task=task-1/);
    assert.match(projection.body, /manifest_json:/);
  });

  it("plans create, noop, and update operations idempotently by stable key", () => {
    const projection = projectTerminalBriefGitHubEvidenceComment({ kind: "terminal", event: makeTerminalEvent() });
    assert.ok(projection);

    assert.equal(planTerminalBriefGitHubCommentWrite(projection, []).action, "create");

    const existing = [{ id: 10, body: projection.body, htmlUrl: "https://github.com/acme/platform/issues/42#issuecomment-10" }];
    const noop = planTerminalBriefGitHubCommentWrite(projection, existing);
    assert.equal(noop.action, "noop");

    const update = planTerminalBriefGitHubCommentWrite(projection, [{ ...existing[0], body: `${projection.body}\nstale` }]);
    assert.equal(update.action, "update");
    if (update.action === "update") assert.equal(update.commentId, 10);
  });

  it("reconciles replayed Start and terminal evidence without using ACK semantics", () => {
    const start = projectTerminalBriefGitHubEvidenceComment({
      kind: "start",
      repo: "acme/platform",
      number: 42,
      taskId: "task-1",
      run: "run-1",
    });
    assert.ok(start);

    const plans = reconcileTerminalBriefGitHubEvidenceComments(
      [
        { kind: "start", repo: "acme/platform", number: 42, taskId: "task-1", run: "run-1" },
        { kind: "terminal", event: makeTerminalEvent() },
      ],
      [{ id: 1, body: start.body }],
    );

    assert.deepEqual(plans.map((plan) => plan.action), ["noop", "create"]);
    assert.equal(plans[0]?.projection.manifest.semantics.githubCommentIsTerminalAck, false);
  });

  it("redacts token-shaped content before rendering and manifest hashing", () => {
    const fixtureToken = ["ghp", "abcdef0123456789ABCDEF0123"].join("_");
    const projection = projectTerminalBriefGitHubEvidenceComment({
      kind: "start",
      repo: "acme/platform",
      number: 42,
      taskId: "task-1",
      run: `token=${fixtureToken}`,
      worker: "dungae",
    });

    assert.ok(projection);
    assert.doesNotMatch(projection.body, /ghp_[A-Za-z0-9]+/);
    assert.match(projection.body, /\[REDACTED\]/);
    assert.doesNotMatch(JSON.stringify(projection.manifest), /ghp_[A-Za-z0-9]+/);
  });

  it("fails closed before projecting OpenClaw runtime/bootstrap paths into evidence", () => {
    const paths = findOpenClawRuntimePaths({
      summary: "would include AGENTS.md and .openclaw/workspace-state.json",
      nested: ["SOUL.md"],
    });

    assert.deepEqual(paths, [".openclaw/workspace-state.json", "AGENTS.md", "SOUL.md"]);
    assert.throws(
      () => assertNoOpenClawRuntimePaths({ output: "see USER.md" }),
      /USER\.md/,
    );
    assert.throws(
      () => projectTerminalBriefGitHubEvidenceComment({
        kind: "start",
        repo: "acme/platform",
        number: 42,
        taskId: "task-1",
        run: "mentions TOOLS.md",
      }),
      /TOOLS\.md/,
    );
  });

  it("uses an injected writer and is replay-safe on a second write", async () => {
    const writer = new FakeCommentWriter();
    const input = { kind: "terminal" as const, event: makeTerminalEvent() };

    const first = await writeTerminalBriefGitHubEvidenceComment(input, writer);
    const second = await writeTerminalBriefGitHubEvidenceComment(input, writer);

    assert.equal(first?.plan.action, "create");
    assert.equal(second?.plan.action, "noop");
    assert.equal(writer.created, 1);
    assert.equal(writer.updated, 0);
    assert.equal(writer.comments.length, 1);
  });
});

class FakeCommentWriter {
  comments: GitHubIssueCommentObservation[] = [];
  created = 0;
  updated = 0;

  async listIssueComments(_target: TerminalBriefGitHubCommentTarget): Promise<GitHubIssueCommentObservation[]> {
    return this.comments;
  }

  async createIssueComment(
    _target: TerminalBriefGitHubCommentTarget,
    body: string,
  ): Promise<GitHubIssueCommentObservation> {
    this.created += 1;
    const comment = { id: this.comments.length + 1, body, htmlUrl: `https://github.com/acme/platform/issues/42#issuecomment-${this.comments.length + 1}` };
    this.comments.push(comment);
    return comment;
  }

  async updateIssueComment(
    _target: TerminalBriefGitHubCommentTarget,
    commentId: number,
    body: string,
  ): Promise<GitHubIssueCommentObservation> {
    this.updated += 1;
    const existing = this.comments.find((comment) => comment.id === commentId);
    if (!existing) throw new Error(`missing comment ${commentId}`);
    existing.body = body;
    return existing;
  }
}
