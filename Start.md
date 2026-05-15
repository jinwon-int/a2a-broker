# Start — Two-broker deploy-safety/revision evidence audit (R22 jingun)

- **Agent:** Team2/jingun (A2A deploy-safety R22 round)
- **Origin coordinator:** Gwakga
- **Receiving broker:** Seoseo
- **Issue:** https://github.com/jinwon-int/a2a-broker/issues/619
- **Parent:** https://github.com/jinwon-int/a2a-broker/issues/497
- **Roadmap:** https://github.com/jinwon-int/a2a-broker/issues/294
- **Run:** a2a-r22-broker-lightweight-20260515T015139Z
- **Branch:** `a2a-patch`

## Focus

Two-broker deploy-safety/revision evidence audit for R22:
1. **Evidence boundaries** — verify OpenClaw runtime/bootstrap path protection is consistent across release-evidence and terminal-brief-evidence paths
2. **Stale tracker cleanup** — identify outdated issue references in active code/docs

## Changes

### Evidence boundary: OpenClaw bootstrap path guard in release-evidence.ts

`release-evidence.ts` uses `SECRETISH_RE` to sanitize URLs, issue refs, repo names, and tokens before including them in evidence output. This regex caught local path prefixes and secret-like values but did not explicitly reject OpenClaw runtime/bootstrap filenames (AGENTS.md, SOUL.md, USER.md, TOOLS.md, HEARTBEAT.md, IDENTITY.md, .openclaw/**).

`terminal-brief-evidence.ts` already had the comprehensive `UNSAFE_OPENCLAW_RUNTIME_PATH_RE` check that fails closed before projecting to GitHub comments. This round extends the same protection to the release-evidence export path for defense-in-depth.

**Files changed:**
- `src/core/release-evidence.ts` — Added OpenClaw bootstrap filenames and `.openclaw/` to `SECRETISH_RE`
- `src/core/release-evidence.test.ts` — Added test case verifying that OpenClaw bootstrap paths in task IDs and outputs are properly redacted from release evidence exports

### Verification
- `node --test dist/core/release-evidence.test.js` — 4/4 pass (new + 3 existing)
- `node --test dist/github/terminal-brief-evidence.test.js` — 8/8 pass (regression)
- `node --test dist/core/libero-validation-matrix.test.js` — 12/12 pass (no-op regression)
