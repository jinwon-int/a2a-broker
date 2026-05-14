/**
 * Tests for the GitHub webhook-parser module.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { parseGitHubWebhook, validateWebhookHeaders } from "./webhook-parser.js";

// ---------------------------------------------------------------------------
// Webhook parser tests
// ---------------------------------------------------------------------------

test("validateWebhookHeaders returns null when all headers present", () => {
  assert.equal(validateWebhookHeaders("issues", "abc-123"), null);
  assert.equal(validateWebhookHeaders("issue_comment", "abc-123"), null);
  assert.equal(validateWebhookHeaders("pull_request", "abc-123"), null);
  assert.equal(validateWebhookHeaders("pull_request_review_comment", "abc-123"), null);
});

test("validateWebhookHeaders returns error for missing X-GitHub-Event", () => {
  const err = validateWebhookHeaders(undefined, "abc-123");
  assert.ok(err !== null);
  assert.ok(err.includes("Missing X-GitHub-Event"));
});

test("validateWebhookHeaders returns error for missing X-GitHub-Delivery", () => {
  const err = validateWebhookHeaders("issues", undefined);
  assert.ok(err !== null);
  assert.ok(err.includes("Missing X-GitHub-Delivery"));
});

test("validateWebhookHeaders rejects unsupported event types", () => {
  const err = validateWebhookHeaders("push", "abc-123");
  assert.ok(err !== null);
  assert.ok(err.includes("Unsupported"));
});

test("parseGitHubWebhook returns null for missing inputs", () => {
  assert.equal(parseGitHubWebhook(undefined, "d1", {}), null);
  assert.equal(parseGitHubWebhook("issues", undefined, {}), null);
  assert.equal(parseGitHubWebhook("issues", "d1", null), null);
  assert.equal(parseGitHubWebhook("issues", "d1", undefined), null);
});

test("parseGitHubWebhook parses a valid issues/opened event", () => {
  const result = parseGitHubWebhook("issues", "d1", {
    action: "opened",
    repository: {
      owner: { login: "test-owner" },
      name: "test-repo",
      full_name: "test-owner/test-repo",
    },
    issue: {
      number: 1,
      title: "Test issue",
      html_url: "https://github.com/test-owner/test-repo/issues/1",
      state: "open",
    },
    sender: {
      login: "test-user",
      id: 42,
    },
  });

  assert.ok(result !== null);
  assert.equal(result.event.kind, "issues");
  if (result.event.kind === "issues") {
    assert.equal(result.event.action, "opened");
    assert.equal(result.event.repo.fullName, "test-owner/test-repo");
    assert.equal(result.event.issue.number, 1);
    assert.equal(result.event.sender.login, "test-user");
  }
  assert.equal(result.ctx.deliveryId, "d1");
  assert.ok(typeof result.ctx.receivedAt === "string");
});

test("parseGitHubWebhook parses a valid issue_comment/created event", () => {
  const result = parseGitHubWebhook("issue_comment", "d2", {
    action: "created",
    repository: {
      owner: { login: "o" },
      name: "r",
      full_name: "o/r",
    },
    issue: {
      number: 5,
      title: "PR #5",
      html_url: "https://github.com/o/r/issues/5",
      state: "open",
    },
    comment: {
      id: 100,
      body: "/a2a assign worker-1 --intent=analyze",
      html_url: "https://github.com/o/r/issues/5#issuecomment-100",
      created_at: "2025-01-01T00:00:00Z",
    },
    sender: {
      login: "bot",
      id: 99,
    },
  });

  assert.ok(result !== null);
  assert.equal(result.event.kind, "issue_comment");
  if (result.event.kind === "issue_comment") {
    assert.equal(result.event.action, "created");
    assert.equal(result.event.comment.id, 100);
    assert.ok(result.event.comment.body.includes("/a2a assign"));
  }
});

test("parseGitHubWebhook returns null for unsupported event kind", () => {
  const result = parseGitHubWebhook("push", "d3", { action: "push", ref: "main" });
  assert.equal(result, null);
});

test("parseGitHubWebhook returns null for malformed payloads", () => {
  // Missing repository
  assert.equal(
    parseGitHubWebhook("issues", "d4", { action: "opened", issue: {} }),
    null,
  );
  // Missing sender
  assert.equal(
    parseGitHubWebhook("issues", "d5", {
      action: "opened",
      repository: { owner: { login: "o" }, name: "r", full_name: "o/r" },
      issue: { number: 1, title: "Test" },
    }),
    null,
  );
  // Bad action
  assert.equal(
    parseGitHubWebhook("issues", "d6", {
      action: "invalid_action",
      repository: { owner: { login: "o" }, name: "r", full_name: "o/r" },
      issue: { number: 1, title: "Test" },
      sender: { login: "u", id: 1 },
    }),
    null,
  );
});

test("parseGitHubWebhook handles missing repository owner gracefully", () => {
  const result = parseGitHubWebhook("issues", "d9", {
    action: "opened",
    repository: { name: "r", full_name: "o/r" },
    issue: { number: 1, title: "Test", html_url: "", state: "open" },
    sender: { login: "u", id: 1 },
  });
  assert.equal(result, null);
});

test("parseGitHubWebhook handles pull_request events", () => {
  const result = parseGitHubWebhook("pull_request", "d10", {
    action: "closed",
    repository: {
      owner: { login: "o" },
      name: "r",
      full_name: "o/r",
    },
    pull_request: {
      number: 10,
      title: "Test PR",
      html_url: "https://github.com/o/r/pull/10",
      state: "closed",
      merged: true,
    },
    sender: { login: "u", id: 1 },
  });

  assert.ok(result !== null);
  assert.equal(result.event.kind, "pull_request");
  if (result.event.kind === "pull_request") {
    assert.equal(result.event.action, "closed");
    assert.equal(result.event.pullRequest.number, 10);
    assert.equal(result.event.pullRequest.merged, true);
  }
});

test("parseGitHubWebhook handles pull_request_review_comment events", () => {
  const result = parseGitHubWebhook("pull_request_review_comment", "d11", {
    action: "created",
    repository: {
      owner: { login: "o" },
      name: "r",
      full_name: "o/r",
    },
    pull_request: {
      number: 10,
      title: "Test PR",
      html_url: "https://github.com/o/r/pull/10",
      state: "open",
    },
    comment: {
      id: 200,
      body: "review comment",
      html_url: "https://github.com/o/r/pull/10#discussion-200",
      created_at: "2025-01-01T00:00:00Z",
    },
    sender: { login: "u", id: 1 },
  });

  assert.ok(result !== null);
  assert.equal(result.event.kind, "pull_request_review_comment");
  if (result.event.kind === "pull_request_review_comment") {
    assert.equal(result.event.action, "created");
    assert.equal(result.event.comment.id, 200);
  }
});
