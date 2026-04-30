# GitHub Development Loop Contract

A2A tasks created from GitHub issue dispatches use `taskOrigin: "github"` or
`payload.mode: "github-propose-patch"`. These tasks are not complete merely
because a worker generated notes, local files, or an internal broker proposal.

A worker may mark a GitHub development task as succeeded only when its task
result contains external GitHub evidence:

- `result.output.github.prUrl` for a submitted pull request
- `result.output.github.doneCommentUrl` for a completed no-code/documentation outcome
- `result.output.github.blockCommentUrl` for an explicit blocker report

For backward-compatible handlers, the same URL fields are also accepted at
`result.output.prUrl`, `result.output.doneCommentUrl`, and
`result.output.blockCommentUrl`.

If evidence is absent, the broker worker fails the task with
`github_completion_evidence_missing`. This intentionally turns false-positive
"succeeded" tasks into actionable failures so the operator can retry, recover
local work, or fix the handler.

Operator-dispatched tasks may use `taskOrigin: "operator"` when they are not
GitHub-ingestion events but still need to survive SQLite hot-table reloads and
support origin filtering. Use `taskOrigin: "github"` only when GitHub completion
evidence should be enforced; use `payload.mode: "github-propose-patch"` when the
task should still route through the GitHub patch runner.

The versioned handler artifact in `scripts/openclaw-a2a-task-handler.mjs` exposes
`BUILD_INFO` with version, source path, runtime checksum, and a credential-free /
host-neutral contract. Installers should deploy this artifact from the repo (or a
release bundle) instead of copying ad-hoc files from live nodes.
