/**
 * Closeout drift detection helpers — unit tests (issue #197).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseGitHubUrl,
  classifyDriftState,
  isDrift,
  buildDriftReport,
} from "./closeout-drift.js";

// ---------------------------------------------------------------------------
// parseGitHubUrl
// ---------------------------------------------------------------------------

describe("parseGitHubUrl", () => {
  it("parses a PR URL", () => {
    const r = parseGitHubUrl("https://github.com/jinwon-int/a2a-broker/pull/42");
    assert.deepEqual(r, { owner: "jinwon-int", repo: "a2a-broker", kind: "pull", number: 42 });
  });

  it("parses an issue URL", () => {
    const r = parseGitHubUrl("https://github.com/jinwon-int/a2a-broker/issues/197");
    assert.deepEqual(r, { owner: "jinwon-int", repo: "a2a-broker", kind: "issue", number: 197 });
  });

  it("returns null for non-github URL", () => {
    assert.equal(parseGitHubUrl("https://gitlab.com/owner/repo/issues/1"), null);
  });

  it("returns null for malformed URL", () => {
    assert.equal(parseGitHubUrl("not-a-url"), null);
  });

  it("returns null for unknown path shape", () => {
    assert.equal(parseGitHubUrl("https://github.com/owner/repo/commit/abc123"), null);
  });

  it("handles trailing slash", () => {
    const r = parseGitHubUrl("https://github.com/owner/repo/pull/7/");
    assert.deepEqual(r, { owner: "owner", repo: "repo", kind: "pull", number: 7 });
  });

  it("returns null for missing issue number", () => {
    assert.equal(parseGitHubUrl("https://github.com/owner/repo/issues/"), null);
  });
});

// ---------------------------------------------------------------------------
// classifyDriftState
// ---------------------------------------------------------------------------

describe("classifyDriftState", () => {
  it("drift: PR merged, issue open", () => {
    assert.equal(classifyDriftState({ merged: true }, { open: true }), "drift");
  });

  it("clean: PR merged, issue closed", () => {
    assert.equal(classifyDriftState({ merged: true }, { open: false }), "issue_closed");
  });

  it("pr_not_merged: PR open, issue open", () => {
    assert.equal(classifyDriftState({ merged: false }, { open: true }), "pr_not_merged");
  });

  it("issue_closed: PR open, issue already closed", () => {
    assert.equal(classifyDriftState({ merged: false }, { open: false }), "issue_closed");
  });

  it("issue_closed takes precedence over drift", () => {
    // Even if merged, if the issue is closed we report issue_closed (already done)
    assert.equal(classifyDriftState({ merged: true }, { open: false }), "issue_closed");
  });
});

// ---------------------------------------------------------------------------
// isDrift
// ---------------------------------------------------------------------------

describe("isDrift", () => {
  it("true when merged + open", () => {
    assert.equal(isDrift({ merged: true }, { open: true }), true);
  });

  it("false when not merged", () => {
    assert.equal(isDrift({ merged: false }, { open: true }), false);
  });

  it("false when issue closed", () => {
    assert.equal(isDrift({ merged: true }, { open: false }), false);
  });
});

// ---------------------------------------------------------------------------
// buildDriftReport
// ---------------------------------------------------------------------------

describe("buildDriftReport", () => {
  const PR_URL = "https://github.com/jinwon-int/a2a-broker/pull/189";
  const ISSUE_URL = "https://github.com/jinwon-int/a2a-broker/issues/197";

  it("drift report contains DRIFT DETECTED", () => {
    const r = buildDriftReport(PR_URL, ISSUE_URL, { merged: true }, { open: true });
    assert.equal(r.state, "drift");
    assert.match(r.summary, /DRIFT DETECTED/);
    assert.match(r.action, /[Cc]lose/);
    assert.equal(r.prUrl, PR_URL);
    assert.equal(r.issueUrl, ISSUE_URL);
  });

  it("clean report", () => {
    const r = buildDriftReport(PR_URL, ISSUE_URL, { merged: true }, { open: false });
    assert.equal(r.state, "issue_closed");
    assert.match(r.summary, /[Cc]losed/);
  });

  it("pr_not_merged report", () => {
    const r = buildDriftReport(PR_URL, ISSUE_URL, { merged: false }, { open: true });
    assert.equal(r.state, "pr_not_merged");
    assert.match(r.action, /[Ww]ait/);
  });
});
