# A2A Analysis-Only / Read-Only Task Mode

## Overview

The analysis-only mode is a safe, read-only A2A task execution path that allows
tasks to complete with Start+Done/Block evidence **without requiring a patch or
pull request**. This mode is designed for analysis agents (e.g., `bangtong`
thesis agent) that produce findings, summaries, and risk assessments but never
modify code.

## Design

### Intent and Mode Detection

- **Intent:** `analyze`
- **Mode (payload.mode):** `analysis-only`, `read-only-analysis`, or `analyze-only`

The mode name is the gating factor: an `analyze` intent combined with any other
mode falls through to the generic builtin handler and is treated as a
conventional noop success without evidence tracking.

### Evidence Contract

| Evidence Field       | Required? | Notes                                                      |
|----------------------|-----------|------------------------------------------------------------|
| `prUrl`              | **No**    | Analysis-only tasks never produce pull requests            |
| `doneCommentUrl`     | Optional  | URL pointing to a Done comment (e.g., GitHub issue)        |
| `blockCommentUrl`    | Optional  | URL pointing to a Block comment                            |
| `startCommentUrl`    | Optional  | URL pointing to a Start marker comment                     |
| `findings`           | Optional  | Array of analysis findings                                 |
| `risks`              | Optional  | Array of identified risks                                  |
| `artifacts`          | Optional  | Array of analysis artifact references                      |
| `analysisSummary`    | Recommended | Human-readable summary of the analysis                  |

When `blockCommentUrl` is present, the task outcome is reported as **Blocked**
rather than **Done**.

### Safety Properties

1. **Read-only by design:** No code changes, no workspace modifications, no file
   writes. The handler produces structured output from payload data only.
2. **No PR bypass:** The analysis-only path is logically separate from
   `propose_patch`. Tasks with intent `propose_patch` continue to require
   executor evidence (docker runner or OpenClaw bridge).
3. **Fail-closed bootstrap guard:** The existing `.openclaw/`, `AGENTS.md`,
   `SOUL.md`, etc. path checks are not weakened — they remain enforced in
   docker runner and OpenClaw bridge paths.
4. **Explicit exemption in completion validation:**
   `requiresGithubCompletionEvidence()` returns `false` for analysis-only
   tasks regardless of `taskOrigin`.

## Usage

### Task Payload Shape

```json
{
  "intent": "analyze",
  "payload": {
    "mode": "analysis-only",
    "summary": "BTC/USDT regime analysis",
    "doneCommentUrl": "https://github.com/owner/repo/issues/1#issuecomment-123",
    "startCommentUrl": "https://github.com/owner/repo/issues/1#issuecomment-456",
    "findings": ["bullish divergence on 4H", "volume confirmation"],
    "risks": ["weekend liquidity thinning"],
    "artifacts": ["analysis-20260509.json"]
  }
}
```

### Handler Output (Done)

```json
{
  "result": {
    "summary": "analysis-only completed: BTC/USDT regime analysis",
    "note": "analysis-only task completed with Done evidence (no PR required)",
    "lifecycle": {
      "intent": "analyze",
      "mode": "analysis-only",
      "taskId": "task-abc"
    },
    "output": {
      "analysisSummary": "BTC/USDT regime analysis",
      "doneCommentUrl": "https://github.com/owner/repo/issues/1#issuecomment-123",
      "startCommentUrl": "https://github.com/owner/repo/issues/1#issuecomment-456",
      "findings": ["bullish divergence on 4H", "volume confirmation"],
      "risks": ["weekend liquidity thinning"],
      "artifacts": ["analysis-20260509.json"]
    }
  }
}
```

### Handler Output (Blocked)

```json
{
  "result": {
    "summary": "analysis-only blocked: cannot complete analysis",
    "note": "analysis-only task blocked with Block evidence",
    "output": {
      "analysisSummary": "cannot complete analysis",
      "blockCommentUrl": "https://github.com/owner/repo/issues/1#issuecomment-999",
      "risks": ["data feed unavailable"]
    }
  }
}
```

## Regression Tests

Tests cover:

| Test | Location |
|------|----------|
| Handler produces Done evidence without PR | `src/openclaw-handler-artifact.test.ts` |
| Handler carries `doneCommentUrl` | `src/openclaw-handler-artifact.test.ts` |
| Handler produces Block evidence | `src/openclaw-handler-artifact.test.ts` |
| Handler preserves Start marker URL | `src/openclaw-handler-artifact.test.ts` |
| Alias modes (`read-only-analysis`) work | `src/openclaw-handler-artifact.test.ts` |
| Unknown mode falls through to generic | `src/openclaw-handler-artifact.test.ts` |
| Propose_patch evidence is preserved | `src/openclaw-handler-artifact.test.ts` |
| `validateTaskCompletionEvidence` skips analysis-only | `src/openclaw-handler-artifact.test.ts` |
| Worker completes analysis-only (api origin) | `src/worker.test.ts` |
| Worker completes analysis-only (github origin) | `src/worker.test.ts` |
| Worker fails propose_patch without PR | `src/worker.test.ts` |

## Related

- `scripts/openclaw-a2a-task-handler.mjs` — Handler implementation
- `src/core/github-task-completion.ts` — Completion evidence validation
- `docs/a2a-protocol.md` — A2A protocol reference
