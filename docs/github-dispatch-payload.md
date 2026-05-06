# Canonical GitHub Patch Dispatch Payload

GitHub-driven patch tasks must use the canonical task payload at the broker/API boundary so workers can fail closed when dispatch evidence is incomplete.

## Required task fields

- `intent`: `"propose_patch"`
- `taskOrigin`: `"github"` (the broker stamps this automatically for canonical GitHub patch payloads; conflicting values are rejected)
- `payload.mode`: `"github-propose-patch"`
- `payload.repo`: GitHub repository in `owner/name` form
- `payload.issueNumber`: positive integer issue number
- `payload.issue`: string issue reference such as `"#291"` (accepted as input; normalized from `issueNumber` when omitted)
- `payload.issueUrl`: canonical GitHub issue URL

## Compatibility guard

The broker accepts the previous legacy-only shape (`githubRepo`, `githubIssueNumber`, `githubIssueUrl`, `workMode=github`) only by deterministically normalizing it into the canonical fields above and adding:

```json
"githubDispatchCompatibility": {
  "normalizedFromLegacyPayload": true,
  "legacyFields": ["githubRepo", "githubIssueNumber", "workMode"]
}
```

Canonical GitHub dispatch payloads with a non-`github` `taskOrigin` are rejected with an actionable `bad_request` error. The broker also rejects GitHub-looking non-canonical dispatches before worker routing when the message/payload contains a GitHub issue URL, `repo` plus `issueNumber`/`issueUrl`, or legacy `github*` fields without the compatibility marker. This prevents ad-hoc API callers from silently creating GitHub work that falls through to `generic ... accepted by versioned OpenClaw A2A handler`.

## Post-dispatch verifier

Within 30-60 seconds after dispatching GitHub issue work, verify all of:

1. Shape is canonical: `intent=propose_patch`, `taskOrigin=github`, `payload.mode=github-propose-patch`, with `payload.repo`, `payload.issueNumber`, and `payload.issueUrl` present.
2. Task is `claimed` or `running` by the intended worker.
3. The GitHub issue has a `Start` comment.
4. `resultSummary` does **not** match `generic .* accepted by versioned OpenClaw A2A handler`.
5. If the worker blocks with `openclaw_workspace_bootstrap_leak`, the Block/evidence must name the exact repo-relative offending paths before any PR is created; OpenClaw bootstrap files (`AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, `.openclaw/**`) remain fail-closed.

If generic false success is detected, mark the old task superseded/no-op, do not treat it as work evidence, and re-dispatch only with the canonical GitHub payload while recording old/new task ids and issue links.

## Task status troubleshooting

Use JSON-RPC `GetTask` / `ListTasks` for strict A2A-compatible task status reads by id, status, worker, intent, exchange/context, or proposal. The JSON-RPC list schema intentionally does not accept broker-only `taskOrigin` filters. When debugging GitHub-origin dispatch lanes or filtering out non-GitHub/generic tasks, use the broker REST read path instead:

```text
GET /tasks?taskOrigin=github&status=running&detail=full
GET /tasks?taskOrigin=github&assignedWorkerId=<worker>&detail=full
```

This keeps the public A2A JSON-RPC surface strict while preserving the broker/operator troubleshooting path needed by the R4 post-dispatch verifier.

See `examples/github-dispatch-payload.json` for a reusable fixture.
