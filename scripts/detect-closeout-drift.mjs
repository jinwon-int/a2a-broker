#!/usr/bin/env node
/**
 * detect-closeout-drift.mjs — closeout drift diagnostic (issue #197)
 *
 * Determines whether a merged PR's linked GitHub issue is still open
 * ("closeout drift"). Uses the `gh` CLI; no token is printed.
 *
 * Usage:
 *   node scripts/detect-closeout-drift.mjs <pr-url> <issue-url>
 *
 * Example:
 *   node scripts/detect-closeout-drift.mjs \
 *     https://github.com/jinwon-int/a2a-broker/pull/189 \
 *     https://github.com/jinwon-int/a2a-broker/issues/197
 *
 * Exit codes:
 *   0 — no drift (clean / pr not merged / issue already closed)
 *   1 — DRIFT DETECTED (PR merged, issue still open)
 *   2 — usage / parse error
 *   3 — gh CLI error
 */

import { execFileSync } from "node:child_process";

// ---------------------------------------------------------------------------
// URL helpers (inline — avoids needing to build TS first)
// ---------------------------------------------------------------------------

function parseGitHubUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.hostname !== "github.com") return null;
  const m = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/(pull|issues)\/(\d+)\/?$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2], kind: m[3] === "pull" ? "pull" : "issue", number: parseInt(m[4], 10) };
}

function classifyDriftState(pr, issue) {
  if (!issue.open) return "issue_closed";
  if (!pr.merged) return "pr_not_merged";
  return "drift";
}

// ---------------------------------------------------------------------------
// gh query helpers — only reads state; never prints tokens
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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const DRIFT_ACTIONS = {
  drift: "ACTION REQUIRED: close the issue or re-trigger the closeout handler. See docs/closeout-drift-runbook.md.",
  clean: "No action required.",
  pr_not_merged: "Wait for the PR to merge, then re-run this check.",
  issue_closed: "No action required.",
};

const [, , prArg, issueArg] = process.argv;

if (!prArg || !issueArg) {
  console.error("Usage: node scripts/detect-closeout-drift.mjs <pr-url> <issue-url>");
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

console.log(`PR    : ${prArg}`);
console.log(`Issue : ${issueArg}`);
console.log();

let prState, issueState;
try {
  prState = fetchPrState(prRef.owner, prRef.repo, prRef.number);
  issueState = fetchIssueState(issueRef.owner, issueRef.repo, issueRef.number);
} catch (err) {
  console.error(err.message);
  process.exit(3);
}

console.log(`PR merged     : ${prState.merged}`);
console.log(`Issue open    : ${issueState.open}`);
console.log();

const driftState = classifyDriftState(prState, issueState);

if (driftState === "drift") {
  console.error("DRIFT DETECTED — PR is merged but linked issue is still open.");
  console.error(`Next step: ${DRIFT_ACTIONS.drift}`);
  process.exit(1);
}

const labels = {
  issue_closed: "Clean — issue already closed.",
  pr_not_merged: "Clean — PR not yet merged.",
  clean: "Clean — PR merged and issue closed.",
};
console.log(labels[driftState] ?? `State: ${driftState}`);
console.log(`Next step: ${DRIFT_ACTIONS[driftState]}`);
process.exit(0);
