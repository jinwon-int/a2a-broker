import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { TaskRecord } from "../core/types.js";
import {
  MAX_GITHUB_COMMENT_LENGTH,
  projectStatusMarker,
  projectTaskComment,
  redactSensitive,
} from "./projection.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task-1",
    intent: "analyze",
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    targetNodeId: "worker-a",
    assignedWorkerId: "worker-a",
    payload: {
      githubRepo: "acme/platform",
      githubIssueNumber: 7,
      githubWorkMode: "github",
    },
    artifactIds: [],
    status: "queued",
    createdAt: "2026-04-26T12:00:00Z",
    updatedAt: "2026-04-26T12:00:00Z",
    ...overrides,
  } as TaskRecord;
}

// ---------------------------------------------------------------------------
// projectStatusMarker
// ---------------------------------------------------------------------------

describe("projectStatusMarker", () => {
  it("returns null while the task is queued", () => {
    assert.equal(projectStatusMarker(makeTask({ status: "queued" })), null);
  });

  it("returns Start when the task is claimed or running", () => {
    assert.equal(projectStatusMarker(makeTask({ status: "claimed" })), "Start");
    assert.equal(projectStatusMarker(makeTask({ status: "running" })), "Start");
  });

  it("returns Done on success without a PR artifact", () => {
    assert.equal(
      projectStatusMarker(
        makeTask({
          status: "succeeded",
          result: { summary: "all good" },
        }),
      ),
      "Done",
    );
  });

  it("returns PR when the result references a github pull request", () => {
    const marker = projectStatusMarker(
      makeTask({
        status: "succeeded",
        result: {
          summary: "opened PR",
          output: {
            pullRequestUrl: "https://github.com/acme/platform/pull/42",
          },
        },
      }),
    );
    assert.equal(marker, "PR");
  });

  it("returns Block when the task fails or is canceled", () => {
    assert.equal(projectStatusMarker(makeTask({ status: "failed" })), "Block");
    assert.equal(
      projectStatusMarker(makeTask({ status: "canceled" })),
      "Block",
    );
  });
});

// ---------------------------------------------------------------------------
// projectTaskComment
// ---------------------------------------------------------------------------

describe("projectTaskComment", () => {
  it("returns null when there is no marker yet", () => {
    assert.equal(projectTaskComment(makeTask({ status: "queued" })), null);
  });

  it("renders a comment body that includes the marker and task id", () => {
    const projection = projectTaskComment(makeTask({ status: "running" }));
    assert.ok(projection);
    assert.equal(projection!.marker, "Start");
    assert.match(projection!.body, /Start/);
    assert.match(projection!.body, /task-1/);
  });

  it("includes the PR URL on a PR marker", () => {
    const projection = projectTaskComment(
      makeTask({
        status: "succeeded",
        result: {
          summary: "ready for review",
          output: {
            pullRequestUrl: "https://github.com/acme/platform/pull/42",
          },
        },
      }),
    );
    assert.ok(projection);
    assert.equal(projection!.marker, "PR");
    assert.match(
      projection!.body,
      /https:\/\/github\.com\/acme\/platform\/pull\/42/,
    );
  });

  it("includes the failure reason on a Block marker", () => {
    const projection = projectTaskComment(
      makeTask({
        status: "failed",
        error: { code: "exec_error", message: "tests failed" },
      }),
    );
    assert.ok(projection);
    assert.equal(projection!.marker, "Block");
    assert.match(projection!.body, /tests failed/);
  });

  it("truncates a very long body to the comment length limit", () => {
    const huge = "x".repeat(MAX_GITHUB_COMMENT_LENGTH * 2);
    const projection = projectTaskComment(
      makeTask({
        status: "succeeded",
        result: { summary: huge },
      }),
    );
    assert.ok(projection);
    assert.ok(projection!.body.length <= MAX_GITHUB_COMMENT_LENGTH);
    assert.match(projection!.body, /truncated/i);
  });

  it("redacts sensitive values from the rendered body", () => {
    const fixtureToken = ["ghp", "abcdef0123456789ABCDEF0123"].join("_");
    const projection = projectTaskComment(
      makeTask({
        status: "succeeded",
        result: {
          summary: "see output",
          output: {
            apiToken: fixtureToken,
            details: `token is ${fixtureToken} keep secret`,
          },
        },
      }),
    );
    assert.ok(projection);
    assert.doesNotMatch(projection!.body, /ghp_[A-Za-z0-9]+/);
    assert.match(projection!.body, /\[REDACTED\]/);
  });
});

// ---------------------------------------------------------------------------
// redactSensitive
// ---------------------------------------------------------------------------

describe("redactSensitive", () => {
  it("redacts string values whose key matches a sensitive pattern", () => {
    const out = redactSensitive({ token: "abc", apiKey: "xyz", message: "hi" });
    assert.deepEqual(out, {
      token: "[REDACTED]",
      apiKey: "[REDACTED]",
      message: "hi",
    });
  });

  it("redacts known token-like values regardless of key", () => {
    const fixtureToken = ["ghp", "abcdef0123456789ABCDEF0123"].join("_");
    const out = redactSensitive({
      details: `use ${fixtureToken} to authenticate`,
    });
    assert.equal(
      (out as { details: string }).details.includes("ghp_"),
      false,
    );
    assert.match((out as { details: string }).details, /\[REDACTED\]/);
  });

  it("recurses into nested objects and arrays", () => {
    const out = redactSensitive({
      nested: { secret: "abc", values: [{ password: "p" }, "ok"] },
    });
    const nested = (out as { nested: Record<string, unknown> }).nested;
    assert.equal(nested.secret, "[REDACTED]");
    const values = nested.values as Array<Record<string, string> | string>;
    assert.equal((values[0] as Record<string, string>).password, "[REDACTED]");
    assert.equal(values[1], "ok");
  });

  it("returns primitives unchanged when not sensitive", () => {
    assert.equal(redactSensitive("plain"), "plain");
    assert.equal(redactSensitive(42), 42);
    assert.equal(redactSensitive(null), null);
  });
});
