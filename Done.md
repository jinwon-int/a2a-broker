# Done — Two-broker deploy-safety/revision evidence audit (R22 jingun)

- **Agent:** Team2/jingun (A2A deploy-safety R22 round)
- **Issue:** https://github.com/jinwon-int/a2a-broker/issues/619
- **Parent:** https://github.com/jinwon-int/a2a-broker/issues/497
- **Roadmap:** https://github.com/jinwon-int/a2a-broker/issues/294
- **Run:** a2a-r22-broker-lightweight-20260515T015139Z
- **Branch:** `a2a-patch`
- **PR:** N/A — branch-level evidence packet (no GitHub credentials in runner); verification via tests and code review at commit `23d2bc8 + a2a-patch`

## Changes

### `src/core/release-evidence.ts` — OpenClaw bootstrap path protection

Added OpenClaw runtime/bootstrap filenames (`AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`) and `.openclaw/` to the `SECRETISH_RE` regex that guards all safe-string sanitizers (`safeToken`, `safeGithubUrl`, `safeIssueRef`, `safeRepo`).

**Before:**
```js
const SECRETISH_RE = /token|secret|chat_id|BROKER_EDGE_SECRET|EDGE_SECRET|\/work\//i;
```

**After:**
```js
const SECRETISH_RE = /token|secret|chat_id|BROKER_EDGE_SECRET|EDGE_SECRET|\/work\/|AGENTS\.md|SOUL\.md|USER\.md|TOOLS\.md|HEARTBEAT\.md|IDENTITY\.md|\.openclaw/i;
```

This provides defense-in-depth alongside the existing `terminal-brief-evidence.ts` `UNSAFE_OPENCLAW_RUNTIME_PATH_RE` guard, ensuring the release evidence export cannot emit OpenClaw bootstrap context paths.

### `src/core/release-evidence.test.ts` — Evidence boundary test

Added test case `release evidence export redacts OpenClaw runtime/bootstrap paths in task ids and output`:
- Creates a terminal task with `AGENTS.md` as task ID, `SOUL.md` in branch URL, `TOOLS.md` in PR URL
- Verifies the serialized export contains none of the OpenClaw bootstrap filenames or `.openclaw/`

## Verification

| Test suite | Pass/Tot | Status |
|---|---|---|
| `release-evidence.test.js` | 4/4 | ✅ New test + 3 existing |
| `terminal-brief-evidence.test.js` | 8/8 | ✅ Regression |
| `libero-validation-matrix.test.js` | 12/12 | ✅ No-op regression |
| `hot-table-growth.test.js` | 24/24 | ✅ No-op regression |

## Stale Tracker Audit

Checked for stale issue/PR references across active source code (`src/`, `scripts/`):
- `src/core/terminal-brief-routing.ts` references `#634` — this is a file-header comment documenting the originating PR; the code remains current.
- `src/core/post-dispatch-verifier.ts` references `PR #602` — same, historical header comment.
- `docs/hot-table-retention-prune-runbook.md` references `#617` — this is a still-relevant runbook.
- `Start.md`/`Done.md` (this round) — overwritten with R22 evidence; no stale references remain.

**Conclusion:** No stale issue references in active code that would create confusion. Header comments referencing prior PRs are standard practice and appropriate.

## Risk Assessment

| Risk | Level | Mitigation |
|---|---|---|
| Regex false positive on legitimate data | Low | OpenClaw bootstrap filenames are distinct pattern; `.openclaw` has a leading dot unlikely in URLs/tokens |
| Evidence boundary leak of private paths | Reduced | Defense-in-depth: both terminal-brief-evidence and release-evidence now guard OpenClaw paths |
| The regex doesn't catch `/tmp/openclaw-agent-workspace/` paths | Low | `SECRETISH_RE` is applied to GitHub URLs, issue refs, repo/run tokens — not to free-text descriptions; the terminal-brief-evidence.ts `UNSAFE_OPENCLAW_RUNTIME_PATH_RE` catches these in manifest projection |

## Safety Gate Verdict

**Done** — All safety gates respected:
- ✅ No production deploy/restart
- ✅ No Gateway/broker/worker restart or reload
- ✅ No live provider/Telegram canary beyond task notifications
- ✅ No production DB mutation/prune/migration
- ✅ No Terminal Brief ACK/replay
- ✅ No historical outbox replay
- ✅ No release/tag publish
- ✅ No secret/visibility change
- ✅ No history rewrite or force-push
- ✅ No OpenClaw runtime/bootstrap context files in branch artifacts (verified by `.gitignore` + scan + new code guard)
