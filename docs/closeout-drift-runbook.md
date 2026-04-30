# Closeout Drift Runbook

> Issue #197 · a2a-broker

## What is closeout drift?

"Closeout drift" occurs when a PR linked to a GitHub issue is **merged**, but the issue remains **open**. The A2A `github-propose-patch` task leaves a PR as its evidence, and the broker is expected to close the linked issue after merge. If that step fails (handler crash, missing token, race condition), the issue drifts out of sync with the PR.

Reference case: **#189** — PR merged, linked issue never closed by the broker.

---

## Quick detection

```sh
# Run from the repo root. Requires gh CLI authenticated.
node scripts/detect-closeout-drift.mjs \
  https://github.com/jinwon-int/a2a-broker/pull/189 \
  https://github.com/jinwon-int/a2a-broker/issues/197
```

| Exit code | Meaning |
|---|---|
| `0` | No drift (clean, PR not merged, or issue already closed) |
| `1` | **DRIFT DETECTED** — action required |
| `2` | Bad arguments / URL format |
| `3` | `gh` CLI error (auth, network, rate limit) |

---

## Drift state taxonomy

| State | PR merged? | Issue open? | Meaning |
|---|---|---|---|
| `drift` | ✅ | ✅ | **Drift — needs operator action** |
| `issue_closed` | any | ❌ | Clean — already closed |
| `pr_not_merged` | ❌ | ✅ | Early — not yet drift |
| `clean` | ✅ | ❌ | Fully resolved |

---

## Operator recovery steps

Follow these steps in order whenever a drift is confirmed.

### Step 1 — Verify PR is actually merged

```sh
gh pr view <PR-NUMBER> --repo <owner>/<repo> --json state,mergedAt,mergeCommit
```

If `mergedAt` is null, the PR is **not** merged. No drift — stop here.

### Step 2 — Check issue state

```sh
gh issue view <ISSUE-NUMBER> --repo <owner>/<repo> --json state,closedAt
```

If `state` is `"CLOSED"`, the issue is already closed — no action needed.

### Step 3 — Close the issue manually

If the issue is open and the PR is confirmed merged:

```sh
gh issue close <ISSUE-NUMBER> \
  --repo <owner>/<repo> \
  --comment "Closing: linked PR #<PR-NUMBER> was merged. Drift detected and recovered by operator per runbook docs/closeout-drift-runbook.md."
```

Do **not** include tokens, session dumps, or internal paths in the comment.

### Step 4 — Re-run detect-closeout-drift to confirm

```sh
node scripts/detect-closeout-drift.mjs <pr-url> <issue-url>
# Expected: exit 0, "Clean" message
```

### Step 5 — File an improvement issue

If drift was caused by a handler bug, open a follow-up issue:

```sh
gh issue create \
  --repo <owner>/<repo> \
  --title "Fix: closeout handler did not close issue after PR merge" \
  --body "Drift detected for PR #<PR> / issue #<ISSUE>. Root cause: <describe>. Recovered manually via runbook."
```

---

## Prevention

| Layer | Mechanism |
|---|---|
| Handler | Broker `github-propose-patch` handler must call `gh issue close` (or equivalent API) after confirming merge |
| Monitoring | Run `detect-closeout-drift.mjs` in CI or as a post-task hook |
| Recovery state | `src/github/recovery-state.ts` bucket `closed` should be emitted when a PR is merged and the issue is closed |

---

## Implementation

| File | Purpose |
|---|---|
| `src/github/closeout-drift.ts` | Pure helpers: URL parsing, drift classification, report formatting |
| `src/github/closeout-drift.test.ts` | Unit tests (no I/O, no `gh` calls) |
| `scripts/detect-closeout-drift.mjs` | CLI diagnostic using `gh` |
| `docs/closeout-drift-runbook.md` | This document |
