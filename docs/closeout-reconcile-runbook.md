# Closeout Reconciliation Runbook

> Issue #202 · a2a-broker

## Purpose

The closeout reconcile loop extends the #197 drift diagnostic by wiring it into a repeatable operator workflow. After every A2A `github-propose-patch` task produces PR evidence, the operator runs reconciliation to confirm the linked issue is in sync — or to surface drift, missing links, or cross-repo anomalies.

---

## Quick run

```sh
# From repo root. gh CLI must be authenticated.
node scripts/closeout-reconcile.mjs \
  https://github.com/jinwon-int/a2a-broker/pull/189 \
  https://github.com/jinwon-int/a2a-broker/issues/197
```

## Exit codes

| Exit code | Reconciliation state | Meaning |
|---|---|---|
| `0` | `ok` | PR and issue are in sync. No drift. |
| `0` | `not-merged` | PR not yet merged; wait and retry. |
| `1` | `merged-open-drift` | **DRIFT** — PR merged, issue open. Operator action required. |
| `2` | (parse) | Bad arguments / invalid URLs. |
| `3` | (gh error) | `gh` CLI error (auth, network, rate limit). |
| `4` | `missing-link` | PR/issue not found, or zero PRs linked to the issue. |
| `4` | `cross-repo` | PR and issue are in different repos. |

---

## Reconciliation state taxonomy

| State | PR merged? | Issue open? | Same repo? | Linked PRs? | Meaning |
|---|---|---|---|---|---|
| `ok` | ✅ | ❌ | ✅ | ≥1 | Fully resolved |
| `ok` | ❌ | ❌ | ✅ | ≥1 | Issue already closed, PR not yet merged |
| `merged-open-drift` | ✅ | ✅ | ✅ | ≥1 | **Drift — operator must act** |
| `not-merged` | ❌ | ✅ | ✅ | ≥1 | Early — no drift possible yet |
| `missing-link` | any | any | any | 0 or null obs | No linked PR found |
| `cross-repo` | any | any | ❌ | any | Different repos — verify intent |

---

## Operator recovery workflow

### After every A2A github-propose-patch task completion

1. **Run reconcile** with the PR URL and issue URL the task reported.
2. **If `ok`**: done. No further action.
3. **If `not-merged`**: wait for CI/merge, retry after merge.
4. **If `merged-open-drift`**: follow the drift recovery steps below.
5. **If `missing-link`**: verify the PR body actually references the issue. Re-run.
6. **If `cross-repo`**: confirm this is intentional. If not, correct the URLs and re-run.

### Drift recovery (merged-open-drift)

#### Step 1 — Verify PR is merged

```sh
gh pr view <PR-NUMBER> --repo <owner>/<repo> --json state,mergedAt,mergeCommit
```

If `mergedAt` is null → **not merged**, stop here.

#### Step 2 — Check issue state

```sh
gh issue view <ISSUE-NUMBER> --repo <owner>/<repo> --json state,closedAt
```

If `state` is `"CLOSED"` → already closed, re-run reconcile to confirm `ok`.

#### Step 3 — Close the issue manually

```sh
gh issue close <ISSUE-NUMBER> \
  --repo <owner>/<repo> \
  --comment "Closing: linked PR #<PR-NUMBER> was merged. Drift detected and recovered by operator per runbook docs/closeout-reconcile-runbook.md."
```

Do **not** include tokens, session dumps, or internal paths in the comment.

#### Step 4 — Re-run reconcile to confirm

```sh
node scripts/closeout-reconcile.mjs <pr-url> <issue-url>
# Expected: exit 0, "OK"
```

#### Step 5 — File an improvement issue (if root cause is handler bug)

```sh
gh issue create \
  --repo <owner>/<repo> \
  --title "Fix: closeout handler did not close issue after PR merge" \
  --body "Drift detected for PR #<PR> / issue #<ISSUE>. Recovered manually via runbook."
```

---

## JSON output schema

The script always emits machine-readable JSON before exit. The `state` field is the key decision:

```json
{
  "state": "merged-open-drift",
  "prUrl": "https://github.com/.../pull/189",
  "issueUrl": "https://github.com/.../issues/197",
  "pr": { "merged": true },
  "issue": { "open": true },
  "linkedPrCount": 1,
  "summary": "PR is merged but the linked issue is still open.",
  "action": "Close the issue manually...",
  "timestamp": "2026-05-01T..."
}
```

Operators can pipe this into scripts:

```sh
STATE=$(node scripts/closeout-reconcile.mjs "$PR" "$ISSUE" 2>/dev/null | tail -n +1 | grep '"state"' | head -1 | cut -d'"' -f4)
if [ "$STATE" = "merged-open-drift" ]; then
  echo "Drift detected — triggering recovery"
fi
```

Or parse the JSON block directly:

```sh
node scripts/closeout-reconcile.mjs "$PR" "$ISSUE" 2>/dev/null \
  | sed -n '/^{/,$ p' \
  | jq -r '.state'
```

---

## Batched reconciliation

To reconcile all open A2A tasks in a table:

```sh
# Example: batch-check known (PR, issue) pairs
while IFS=, read -r pr issue; do
  echo "=== $pr → $issue ==="
  node scripts/closeout-reconcile.mjs "$pr" "$issue"
  echo
done < closeout-pairs.csv
```

---

## npm script

```sh
npm run reconcile_closeout -- <pr-url> <issue-url>
```

---

## Prevention layers

| Layer | Mechanism |
|---|---|
| **Handler** | Broker `github-propose-patch` handler closes the issue after merge |
| **Post-task hook** | Run `closeout-reconcile.mjs` after every task completion |
| **CI gate** | Run reconcile in CI when PR merges into main |
| **Cron** | Batch reconcile all known open tasks daily |

---

## Implementation

| File | Purpose |
|---|---|
| `src/github/closeout-reconcile-loop.ts` | Pure helpers: sameRepo, classifyReconciliation, buildReconciliationReport, JSON serialisation, exit codes |
| `src/github/closeout-reconcile-loop.test.ts` | Unit tests (no I/O, no `gh` calls) |
| `scripts/closeout-reconcile.mjs` | CLI operator script using `gh` |
| `docs/closeout-reconcile-runbook.md` | This document |
