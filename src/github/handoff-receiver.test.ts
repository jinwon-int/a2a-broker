import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { InMemoryA2ABroker } from "../core/broker.js";
import {
  GwakgaSeoseoHandoffReceiver,
  parseGwakgaSeoseoHandoffManifest,
  renderHandoffEvidenceComment,
} from "./handoff-receiver.js";
import type { GitHubDeliveryContext, GitHubIssueCommentEvent, GitHubRepoRef, GitHubUserRef } from "./types.js";

const repo: GitHubRepoRef = {
  owner: "jinwon-int",
  name: "a2a-plane",
  fullName: "jinwon-int/a2a-plane",
};
const sender: GitHubUserRef = { login: "gwakga", id: 101, type: "User" };

function registerWorker(broker: InMemoryA2ABroker, nodeId: string, metadata: Record<string, string> = {}): void {
  broker.registerWorker({
    nodeId,
    role: "analyst",
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: true,
      canPromoteLive: false,
      workspaceIds: ["team1"],
      environments: ["research"],
    },
    metadata: { brokerOfRecord: "seoseo", teamId: "team1", ...metadata },
  });
}

function ctx(deliveryId: string): GitHubDeliveryContext {
  return { deliveryId, receivedAt: "2026-05-12T02:20:00Z" };
}

function comment(body: string, id = 24901): GitHubIssueCommentEvent {
  return {
    kind: "issue_comment",
    action: "created",
    repo,
    issue: {
      number: 249,
      title: "Parent closeout",
      body: "parent",
      htmlUrl: "https://github.com/jinwon-int/a2a-plane/issues/249",
      state: "open",
      user: sender,
      labels: [],
    },
    comment: {
      id,
      body,
      htmlUrl: `https://github.com/jinwon-int/a2a-plane/issues/249#issuecomment-${id}`,
      user: sender,
      createdAt: "2026-05-12T02:19:00Z",
    },
    sender,
  };
}

function manifest(overrides = ""): string {
  return `
Handoff metadata:

\`\`\`yaml
brokerOfRecord: seoseo
requestedByBroker: gwakga
requestingAgent: gwakga
sourceTaskId: https://github.com/jinwon-int/a2a-plane/issues/249
targetTeam: team1
handoffReason: operator-direction
status: requested
idempotencyKey: a2a-plane-249-team1-closeout-20260512-gwakga
${overrides}evidence:
  - https://github.com/jinwon-int/a2a-plane/issues/249
  - https://github.com/jinwon-int/a2a-plane/issues/256
\`\`\``;
}

describe("GwakgaSeoseoHandoffReceiver", () => {
  it("creates durable Seoseo-owned Team1 tasks from a Gwakga handoff comment", () => {
    const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "seoseo", teamId: "team1" });
    registerWorker(broker, "bangtong");
    registerWorker(broker, "yukson");
    const receiver = new GwakgaSeoseoHandoffReceiver({ broker });

    const body = `
/a2a assign bangtong --intent propose_patch -- re-check a2a-plane#250
/a2a assign yukson --intent validate_change -- re-check a2a-plane#251
${manifest()}`;

    const result = receiver.receiveIssueComment(comment(body), ctx("d1"));

    assert.equal(result.accepted, true);
    assert.equal(result.replayed, false);
    assert.deepEqual(result.targetTaskIds, [
      "handoff-a2a-plane-249-team1-closeout-20260512-gwakga-bangtong-0",
      "handoff-a2a-plane-249-team1-closeout-20260512-gwakga-yukson-1",
    ]);
    assert.equal(result.evidence[0]?.status, "accepted");
    assert.match(result.evidenceCommentBody ?? "", /targetTaskId=handoff-a2a-plane-249-team1-closeout-20260512-gwakga-bangtong-0 status=accepted/);

    const task = broker.getTask(result.targetTaskIds[0]!);
    assert.ok(task);
    assert.equal(task.brokerOfRecord, "seoseo");
    assert.equal(task.teamId, "team1");
    assert.equal(task.taskOrigin, "github");
    assert.equal(task.requester.id, "gwakga");
    assert.equal(task.payload.requestedByBroker, "gwakga");
    assert.equal(task.payload.sourceTaskId, "https://github.com/jinwon-int/a2a-plane/issues/249");
    assert.deepEqual(task.payload.evidenceUrls, [
      "https://github.com/jinwon-int/a2a-plane/issues/249",
      "https://github.com/jinwon-int/a2a-plane/issues/256",
    ]);
  });

  it("replays duplicate comments by idempotency key without creating new tasks", () => {
    const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "seoseo", teamId: "team1" });
    registerWorker(broker, "bangtong");
    const receiver = new GwakgaSeoseoHandoffReceiver({ broker });
    const body = `/a2a assign bangtong --intent propose_patch -- closeout\n${manifest()}`;

    const first = receiver.receiveIssueComment(comment(body, 10), ctx("d1"));
    const second = receiver.receiveIssueComment(comment(body, 11), ctx("d2"));

    assert.equal(first.accepted, true);
    assert.equal(second.accepted, true);
    assert.equal(second.replayed, true);
    assert.deepEqual(second.targetTaskIds, first.targetTaskIds);
    assert.equal(broker.listTasks().length, 1);
  });

  it("propagates parentRoundId and parentRoundTotal to the created task payload", () => {
    const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "seoseo", teamId: "team1" });
    registerWorker(broker, "bangtong");
    const receiver = new GwakgaSeoseoHandoffReceiver({ broker });

    const body = `/a2a assign bangtong --intent propose_patch -- closeout parent round\n${
      manifest(`parentRoundId: a2a-r13-terminal-brief-realround-20260514T013556Z\nparentRoundTotal: 7\n`)
    }`;

    const result = receiver.receiveIssueComment(comment(body), ctx("d1"));
    assert.equal(result.accepted, true);

    const task = broker.getTask(result.targetTaskIds[0]!);
    assert.ok(task);
    assert.equal(task.payload["parentRoundId"], "a2a-r13-terminal-brief-realround-20260514T013556Z");
    assert.equal(task.payload["parentRoundTotal"], "7");

    // Verify evidence comment includes parent metadata
    assert.match(result.evidenceCommentBody ?? "", /parentRoundId: a2a-r13-terminal-brief-realround-20260514T013556Z/);
    assert.match(result.evidenceCommentBody ?? "", /parentRoundTotal: 7/);
  });

  it("fails closed for an unknown Team1 worker", () => {
    const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "seoseo", teamId: "team1" });
    const receiver = new GwakgaSeoseoHandoffReceiver({ broker });

    const result = receiver.receiveIssueComment(
      comment(`/a2a assign ghost --intent propose_patch -- closeout\n${manifest()}`),
      ctx("d1"),
    );

    assert.equal(result.accepted, false);
    assert.equal(result.skippedReason, "unknown_worker");
    assert.equal(broker.listTasks().length, 0);
  });

  it("fails closed when the manifest targets a non-Seoseo team", () => {
    const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "seoseo", teamId: "team1" });
    registerWorker(broker, "bangtong");
    const receiver = new GwakgaSeoseoHandoffReceiver({ broker });
    const badManifest = manifest().replace("targetTeam: team1", "targetTeam: team2");

    const result = receiver.receiveIssueComment(
      comment(`/a2a assign bangtong --intent propose_patch -- closeout\n${badManifest}`),
      ctx("d1"),
    );

    assert.equal(result.accepted, false);
    assert.equal(result.skippedReason, "wrong_target_team");
    assert.equal(broker.listTasks().length, 0);
  });

  it("fails closed when a structured handoff omits idempotencyKey", () => {
    const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "seoseo", teamId: "team1" });
    registerWorker(broker, "bangtong");
    const receiver = new GwakgaSeoseoHandoffReceiver({ broker });
    const body = `/a2a assign bangtong --intent propose_patch -- closeout\n${manifest().replace(/idempotencyKey: .*\n/, "")}`;

    const result = receiver.receiveIssueComment(comment(body), ctx("d1"));

    assert.equal(result.accepted, false);
    assert.equal(result.skippedReason, "missing_idempotency_key");
    assert.equal(broker.listTasks().length, 0);
  });

  it("redacts secrets from stored task text and returned parent evidence", () => {
    const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "seoseo", teamId: "team1" });
    registerWorker(broker, "bangtong");
    const receiver = new GwakgaSeoseoHandoffReceiver({ broker });
    const secret = "super-secret-edge-value";
    const token = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";
    const body = `/a2a assign bangtong --intent propose_patch -- closeout edgeSecret=${secret}\n${manifest(`  - https://example.invalid/receipt?token=${token}\n`)}`;

    const result = receiver.receiveIssueComment(comment(body), ctx("d1"));
    const task = broker.getTask(result.targetTaskIds[0]!);
    assert.ok(task);

    const rendered = result.evidenceCommentBody ?? "";
    assert.doesNotMatch(task.message ?? "", new RegExp(secret));
    assert.doesNotMatch(JSON.stringify(task.payload), new RegExp(token));
    assert.doesNotMatch(rendered, new RegExp(secret));
    assert.doesNotMatch(rendered, new RegExp(token));
    assert.match(task.message ?? "", /edgeSecret=\[REDACTED\]/);
  });

  it("accepts a structured manifest with a single explicit targetWorker", () => {
    const broker = new InMemoryA2ABroker(undefined, undefined, { brokerId: "seoseo", teamId: "team1" });
    registerWorker(broker, "bangtong");
    const receiver = new GwakgaSeoseoHandoffReceiver({ broker });
    const body = manifest("targetWorker: bangtong\ntargetTaskId: gwakga-249-team1-bangtong-closeout\n");

    const result = receiver.receiveIssueComment(comment(body), ctx("d1"));

    assert.equal(result.accepted, true);
    assert.deepEqual(result.targetTaskIds, ["gwakga-249-team1-bangtong-closeout"]);
    assert.equal(broker.getTask("gwakga-249-team1-bangtong-closeout")?.targetNodeId, "bangtong");
  });
});

describe("handoff manifest parsing and evidence rendering", () => {
  it("parses the explicit handoff fields", () => {
    const parsed = parseGwakgaSeoseoHandoffManifest(manifest());
    assert.equal(parsed?.brokerOfRecord, "seoseo");
    assert.equal(parsed?.requestedByBroker, "gwakga");
    assert.equal(parsed?.requestingAgent, "gwakga");
    assert.equal(parsed?.targetTeam, "team1");
    assert.equal(parsed?.idempotencyKey, "a2a-plane-249-team1-closeout-20260512-gwakga");
    assert.equal(parsed?.evidence.length, 2);
  });

  it("parses parentRoundId and parentRoundTotal from handoff manifest", () => {
    const withParent = manifest(`parentRoundId: a2a-r13-terminal-brief-realround-20260514T013556Z\nparentRoundTotal: 7\n`);
    const parsed = parseGwakgaSeoseoHandoffManifest(withParent);
    assert.equal(parsed?.parentRoundId, "a2a-r13-terminal-brief-realround-20260514T013556Z");
    assert.equal(parsed?.parentRoundTotal, "7");
  });

  it("omits parentRoundId from parsed manifest when absent", () => {
    const parsed = parseGwakgaSeoseoHandoffManifest(manifest());
    assert.equal(parsed?.parentRoundId, undefined);
    assert.equal(parsed?.parentRoundTotal, undefined);
  });

  it("renders done/pr-open/blocked evidence statuses", () => {
    const body = renderHandoffEvidenceComment({
      manifest: parseGwakgaSeoseoHandoffManifest(manifest())!,
      evidence: [
        { workerId: "bangtong", targetTaskId: "t1", status: "done", evidenceUrl: "https://github.com/o/r/issues/1#issuecomment-1" },
        { workerId: "sogyo", targetTaskId: "t2", status: "pr-open", evidenceUrl: "https://github.com/o/r/pull/2" },
        { workerId: "nosuk", targetTaskId: "t3", status: "blocked" },
      ],
    });

    assert.match(body, /status=done/);
    assert.match(body, /status=pr-open/);
    assert.match(body, /status=blocked/);
  });
});
