#!/usr/bin/env node
/**
 * closeout-reconcile.mjs — closeout reconciliation loop (issue #202)
 *
 * Wires the #197 drift diagnostic into an operator closeout loop.
 * Given a PR URL + issue URL, classifies the reconciliation state
 * and emits both machine-readable JSON and a concise human summary.
 *
 * Usage:
 *   node scripts/closeout-reconcile.mjs <pr-url> <issue-url>
 *
 * Example:
 *   node scripts/closeout-reconcile.mjs \
 *     https://github.com/jinwon-int/a2a-broker/pull/189 \
 *     https://github.com/jinwon-int/a2a-broker/issues/197
 *
 * Exit codes:
 *   0 — ok or not-merged (no drift, clean exit)
 *   1 — merged-open-drift (real drift detected)
 *   2 — usage / parse error (bad arguments)
 *   3 — gh CLI error (auth, network, rate limit)
 *   4 — missing-link or cross-repo (anomaly, not blocking)
 */

import { execFileSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Inline URL parser (standalone .mjs, no TS build dependency)
// ---------------------------------------------------------------------------

function parseGitHubUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.hostname !== "github.com") return null;
  const m = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/(pull|issues)\/(\d+)\/?$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2], kind: m[3] === "pull" ? "pull" : "issue", number: parseInt(m[4], 10) };
}

function sameRepo(prUrl, issueUrl) {
  const pr = parseGitHubUrl(prUrl);
  const issue = parseGitHubUrl(issueUrl);
  if (!pr || !issue) return false;
  return pr.owner === issue.owner && pr.repo === issue.repo;
}

// ---------------------------------------------------------------------------
// gh query helpers
// ---------------------------------------------------------------------------

function ghJson(args) {
  try {
    const raw = execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return JSON.parse(raw);
  } catch (err) {
    const msg = err.stderr?.trim() ?? err.message;
    throw new Error(`gh error: ${msg}`);
  }
}

function fetchPrState(owner, repo, number) {
  const data = ghJson(["pr", "view", String(number), "--repo", `${owner}/${repo}`, "--json", "state,mergedAt"]);
  return { merged: Boolean(data.mergedAt) };
}

function fetchIssueState(owner, repo, number) {
  const data = ghJson(["issue", "view", String(number), "--repo", `${owner}/${repo}`, "--json", "state"]);
  return { open: data.state === "OPEN" };
}

/**
 * Count PRs linked to this issue via cross-reference / closing keywords.
 * Uses `gh issue list` with search to find linked PRs.
 */
function countLinkedPrs(owner, repo, issueNumber) {
  try {
    // Search for PRs that reference this issue number in the owner/repo
    const data = ghJson([
      "search",
      "prs",
      `repo:${owner}/${repo} ${issueNumber} in:body`,
      "--json", "number",
      "--limit", "10",
    ]);
    return Array.isArray(data) ? data.length : 0;
  } catch {
    // If the search fails (e.g. empty result), treat as 0 — missing-link
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Reconciliation logic (inline — standalone .mjs)
// ---------------------------------------------------------------------------

const RECONCILE_LABELS = {
  ok: { summary: "OK", detail: "PR and issue are in sync. No drift detected." },
  "merged-open-drift": { summary: "DRIFT DETECTED", detail: "PR is merged but the linked issue is still open." },
  "not-merged": { summary: "NOT MERGED", detail: "PR has not yet been merged." },
  "missing-link": { summary: "MISSING LINK", detail: "PR/issue not found or no linked PR on the issue." },
  "cross-repo": { summary: "CROSS-REPO", detail: "PR and issue belong to different repositories." },
};

const RECONCILE_ACTIONS = {
  ok: "No action required.",
  "merged-open-drift": "Close the issue manually (`gh issue close`) or re-trigger closeout handler. See docs/closeout-reconcile-runbook.md.",
  "not-merged": "Wait for the PR to merge, then re-run this reconciliation check.",
  "missing-link": "Verify the PR references this issue in its body/title. Re-run after a short delay if the link is valid.",
  "cross-repo": "Confirm this is intentional (multi-repo task). If not, verify the URLs and re-run.",
};

function classifyReconciliation(pr, issue, prUrl, issueUrl, linkedPrCount) {
  if (!pr || !issue) return "missing-link";
  if (!sameRepo(prUrl, issueUrl)) return "cross-repo";
  if (linkedPrCount === 0) return "missing-link";
  if (!pr.merged) return "not-merged";
  if (issue.open) return "merged-open-drift";
  return "ok";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const [, , prArg, issueArg] = process.argv;

if (!prArg || !issueArg) {
  console.error("Usage: node scripts/closeout-reconcile.mjs <pr-url> <issue-url>");
  process.exit(2);
}

const prRef = parseGitHubUrl(prArg);
const issueRef = parseGitHubUrl(issueArg);

if (!prRef || prRef.kind !== "pull") {
  console.error(`Invalid PR URL: ${prArg}`);
  process.exit(2);
}
if (!issueRef || issueRef.kind !== "issue") {
  console.error(`Invalid issue URL: ${issueArg}`);
  process.exit(2);
}

// --- Human-readable header ---
console.log("========================================");
console.log("  A2A Closeout Reconciliation");
console.log("========================================");
console.log(`PR    : ${prArg}`);
console.log(`Issue : ${issueArg}`);
console.log();

// --- Fetch live data ---
let prState, issueState, linkedPrCount;
try {
  prState = fetchPrState(prRef.owner, prRef.repo, prRef.number);
  issueState = fetchIssueState(issueRef.owner, issueRef.repo, issueRef.number);
  linkedPrCount = countLinkedPrs(issueRef.owner, issueRef.repo, issueRef.number);
} catch (err) {
  console.error(err.message);
  process.exit(3);
}

console.log(`PR merged        : ${prState.merged}`);
console.log(`Issue open       : ${issueState.open}`);
console.log(`Linked PR count  : ${linkedPrCount}`);
console.log();

// --- Classify ---
const state = classifyReconciliation(prState, issueState, prArg, issueArg, linkedPrCount);
const label = RECONCILE_LABELS[state];

// --- Human summary ---
console.log(`>> State: ${state.toUpperCase()}`);
console.log(`   ${label.detail}`);
console.log();
console.log(`Action: ${RECONCILE_ACTIONS[state]}`);
console.log();

// --- Machine-readable JSON ---
const jsonReport = JSON.stringify(
  {
    state,
    prUrl: prArg,
    issueUrl: issueArg,
    pr: { merged: prState.merged },
    issue: { open: issueState.open },
    linkedPrCount,
    summary: label.detail,
    action: RECONCILE_ACTIONS[state],
    timestamp: new Date().toISOString(),
  },
  null,
  2,
);

console.log("--- JSON ---");
console.log(jsonReport);

// --- Exit code ---
switch (state) {
  case "ok":
  case "not-merged":
    process.exit(0);
  case "merged-open-drift":
    process.exit(1);
  case "missing-link":
  case "cross-repo":
    process.exit(4);
}
