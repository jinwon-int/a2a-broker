/**
 * Closeout reconciliation loop helpers — unit tests (issue #202).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  sameRepo,
  classifyReconciliation,
  buildReconciliationReport,
  reconciliationReportToJson,
  reconciliationExitCode,
  type ReconciliationInput,
} from "./closeout-reconcile-loop.js";

// ---------------------------------------------------------------------------
// sameRepo
// ---------------------------------------------------------------------------

describe("sameRepo", () => {
  it("true for matching repos", () => {
    assert.equal(
      sameRepo(
        "https://github.com/jinwon-int/a2a-broker/pull/42",
        "https://github.com/jinwon-int/a2a-broker/issues/197",
      ),
      true,
    );
  });

  it("false for different owners", () => {
    assert.equal(
      sameRepo(
        "https://github.com/jinwon-int/a2a-broker/pull/42",
        "https://github.com/other-org/a2a-broker/issues/197",
      ),
      false,
    );
  });

  it("false for different repos", () => {
    assert.equal(
      sameRepo(
        "https://github.com/jinwon-int/a2a-broker/pull/42",
        "https://github.com/jinwon-int/other-repo/issues/197",
      ),
      false,
    );
  });

  it("false for malformed PR URL", () => {
    assert.equal(
      sameRepo(
        "not-a-url",
        "https://github.com/jinwon-int/a2a-broker/issues/197",
      ),
      false,
    );
  });

  it("false for malformed issue URL", () => {
    assert.equal(
      sameRepo(
        "https://github.com/jinwon-int/a2a-broker/pull/42",
        "broken",
      ),
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// classifyReconciliation
// ---------------------------------------------------------------------------

const PR_URL = "https://github.com/jinwon-int/a2a-broker/pull/189";
const ISSUE_URL = "https://github.com/jinwon-int/a2a-broker/issues/197";

function input(
  overrides: Partial<ReconciliationInput> & { prMerged?: boolean; issueOpen?: boolean; linkedPrCount?: number },
): ReconciliationInput {
  return {
    prUrl: PR_URL,
    issueUrl: ISSUE_URL,
    pr: { merged: overrides.prMerged ?? true },
    issue: { open: overrides.issueOpen ?? true },
    linkedPrCount: overrides.linkedPrCount ?? 1,
  };
}

describe("classifyReconciliation", () => {
  it("merged-open-drift: PR merged, issue open, linked", () => {
    assert.equal(
      classifyReconciliation(input({ prMerged: true, issueOpen: true, linkedPrCount: 1 })),
      "merged-open-drift",
    );
  });

  it("ok: PR merged, issue closed", () => {
    assert.equal(
      classifyReconciliation(input({ prMerged: true, issueOpen: false, linkedPrCount: 1 })),
      "ok",
    );
  });

  it("not-merged: PR open, issue open", () => {
    assert.equal(
      classifyReconciliation(input({ prMerged: false, issueOpen: true, linkedPrCount: 1 })),
      "not-merged",
    );
  });

  it("ok: PR open, issue closed", () => {
    assert.equal(
      classifyReconciliation(input({ prMerged: false, issueOpen: false, linkedPrCount: 1 })),
      "ok",
    );
  });

  it("missing-link: zero linked PRs", () => {
    assert.equal(
      classifyReconciliation(input({ prMerged: true, issueOpen: true, linkedPrCount: 0 })),
      "missing-link",
    );
  });

  it("missing-link: null PR observation", () => {
    assert.equal(
      classifyReconciliation({
        prUrl: PR_URL,
        issueUrl: ISSUE_URL,
        pr: null,
        issue: { open: true },
        linkedPrCount: 1,
      }),
      "missing-link",
    );
  });

  it("missing-link: null issue observation", () => {
    assert.equal(
      classifyReconciliation({
        prUrl: PR_URL,
        issueUrl: ISSUE_URL,
        pr: { merged: true },
        issue: null,
        linkedPrCount: 1,
      }),
      "missing-link",
    );
  });

  it("cross-repo: different owner", () => {
    assert.equal(
      classifyReconciliation({
        prUrl: "https://github.com/other/a2a-broker/pull/42",
        issueUrl: ISSUE_URL,
        pr: { merged: true },
        issue: { open: true },
        linkedPrCount: 1,
      }),
      "cross-repo",
    );
  });

  it("cross-repo: different repo name", () => {
    assert.equal(
      classifyReconciliation({
        prUrl: "https://github.com/jinwon-int/other/pull/42",
        issueUrl: ISSUE_URL,
        pr: { merged: true },
        issue: { open: true },
        linkedPrCount: 1,
      }),
      "cross-repo",
    );
  });
});

// ---------------------------------------------------------------------------
// buildReconciliationReport
// ---------------------------------------------------------------------------

describe("buildReconciliationReport", () => {
  it("drift report", () => {
    const r = buildReconciliationReport(
      input({ prMerged: true, issueOpen: true, linkedPrCount: 1 }),
    );
    assert.equal(r.state, "merged-open-drift");
    assert.match(r.summary, /DRIFT/);
    assert.match(r.action, /[Cc]lose/);
    assert.equal(r.prUrl, PR_URL);
    assert.equal(r.issueUrl, ISSUE_URL);
  });

  it("ok report", () => {
    const r = buildReconciliationReport(
      input({ prMerged: true, issueOpen: false, linkedPrCount: 1 }),
    );
    assert.equal(r.state, "ok");
    assert.match(r.summary, /OK/);
  });

  it("not-merged report", () => {
    const r = buildReconciliationReport(
      input({ prMerged: false, issueOpen: true, linkedPrCount: 1 }),
    );
    assert.equal(r.state, "not-merged");
    assert.match(r.summary, /NOT MERGED/);
  });

  it("missing-link report", () => {
    const r = buildReconciliationReport(
      input({ prMerged: true, issueOpen: true, linkedPrCount: 0 }),
    );
    assert.equal(r.state, "missing-link");
    assert.match(r.summary, /MISSING LINK/);
  });

  it("cross-repo report", () => {
    const r = buildReconciliationReport({
      prUrl: "https://github.com/other/repo/pull/1",
      issueUrl: ISSUE_URL,
      pr: { merged: true },
      issue: { open: true },
      linkedPrCount: 1,
    });
    assert.equal(r.state, "cross-repo");
    assert.match(r.summary, /CROSS-REPO/);
  });
});

// ---------------------------------------------------------------------------
// reconciliationReportToJson
// ---------------------------------------------------------------------------

describe("reconciliationReportToJson", () => {
  it("produces valid JSON with all fields", () => {
    const report = buildReconciliationReport(
      input({ prMerged: true, issueOpen: true, linkedPrCount: 1 }),
    );
    const json = reconciliationReportToJson(report);
    const parsed = JSON.parse(json);
    assert.equal(parsed.state, "merged-open-drift");
    assert.equal(parsed.prUrl, PR_URL);
    assert.equal(parsed.issueUrl, ISSUE_URL);
    assert.ok(typeof parsed.summary === "string");
    assert.ok(typeof parsed.action === "string");
  });

  it("produces 2-space indented JSON", () => {
    const report = buildReconciliationReport(
      input({ prMerged: false, issueOpen: false, linkedPrCount: 1 }),
    );
    const json = reconciliationReportToJson(report);
    // Verify the JSON is pretty-printed
    assert.match(json, /\n  "/);
  });
});

// ---------------------------------------------------------------------------
// reconciliationExitCode
// ---------------------------------------------------------------------------

describe("reconciliationExitCode", () => {
  it("ok → 0", () => {
    assert.equal(reconciliationExitCode("ok"), 0);
  });

  it("not-merged → 0", () => {
    assert.equal(reconciliationExitCode("not-merged"), 0);
  });

  it("merged-open-drift → 1", () => {
    assert.equal(reconciliationExitCode("merged-open-drift"), 1);
  });

  it("missing-link → 4", () => {
    assert.equal(reconciliationExitCode("missing-link"), 4);
  });

  it("cross-repo → 4", () => {
    assert.equal(reconciliationExitCode("cross-repo"), 4);
  });
});
