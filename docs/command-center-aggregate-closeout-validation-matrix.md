# Command-center aggregate closeout validation matrix

Issue: [#370](https://github.com/jinwon-int/a2a-broker/issues/370)  
Parent: [#364](https://github.com/jinwon-int/a2a-broker/issues/364)  
Roadmap: [#294](https://github.com/jinwon-int/a2a-broker/issues/294)  
Run: `a2a-command-center-aggregation-20260505170100`  
Worker: `yukson` libero validation lane

This matrix is the no-live validation plan for the command-center aggregation round. It is safe to attach to the #370 issue or PR before all implementation lanes have PR/Done evidence, then re-run as linked lanes become available.

## Safety boundary

Default validation is read-only or synthetic fixture only.

Do **not** perform any of these without explicit operator approval:

- production deploy
- Gateway restart
- live Telegram/provider send
- production DB mutation
- terminal-outbox ACK
- package publish
- repository visibility change
- all-worker live smoke

Read-only live checks may inspect health, queue, worker fleet, and GitHub issue/PR state. If a read-only endpoint or credential is unavailable, record a `Block` for that evidence item instead of substituting a mutation, restart, live send, or ACK.

## Linked lane inputs

| Lane | Repo issue | Expected implementation evidence | If unavailable |
| --- | --- | --- | --- |
| Parent task-report query and matching | [`a2a-broker#367`](https://github.com/jinwon-int/a2a-broker/issues/367) | PR/Done evidence proving `parent_issue` scoping matches the #364 child tasks without breaking explicit `task_id` queries. | Mark L1/L2 blocked: waiting on #367 PR/Done/Block evidence. |
| Closeout markdown and lane state classification | [`a2a-broker#368`](https://github.com/jinwon-int/a2a-broker/issues/368) | PR/Done evidence proving compact `ready`, `waiting`, `blocked`, `stuck`, and `needs-evidence` rendering. | Mark L3 blocked: waiting on #368 PR/Done/Block evidence. |
| Idempotent aggregate comment trigger | [`a2a-broker#369`](https://github.com/jinwon-int/a2a-broker/issues/369) | PR/Done evidence proving preview/dry-run behavior and idempotent managed comment post/update semantics. | Mark L4 blocked: waiting on #369 PR/Done/Block evidence. |
| Runner evidence hints for recovery | [`a2a-docker-runner#143`](https://github.com/jinwon-int/a2a-docker-runner/issues/143) | PR/Done evidence proving runner outputs expose compact PR/Done/Block URLs or recovery hints without raw logs/secrets. | Mark L2/L5 blocked: waiting on #143 PR/Done/Block evidence. |
| Libero validation | [`a2a-broker#370`](https://github.com/jinwon-int/a2a-broker/issues/370) | This matrix plus local no-live command output and read-only before/after snapshots when available. | Post `Block` with the missing command, endpoint, or upstream lane evidence. |

## Validation matrix

| ID | Surface | No-live proof | Required commands/evidence | Expected result | Blocker condition |
| --- | --- | --- | --- | --- | --- |
| L1 | `GET /operator/task-report?parent_issue=jinwon-int/a2a-broker#364` | Unit/integration tests plus optional read-only broker GET | #367 PR/Done evidence; local targeted test covering parent issue query; optional before/after read-only task-report snapshot. | Report includes only #364 child lanes and keeps explicit `task_id` behavior unchanged. | Parent issue query is absent, over-broad, misses known child lanes, or requires broker mutation/live smoke. |
| L2 | Evidence URL recovery | Synthetic task fixtures and runner evidence | #367 and #143 PR/Done evidence; tests with runner result output, failure details, sanitized artifacts, and missing-evidence cases. | PR/Done/Block/branch/issue URLs are recovered when present; operator output remains compact and secret-safe. | Raw logs/secrets are emitted, existing evidence URLs are missed, or missing evidence is reported as success. |
| L3 | Closeout markdown states | Renderer tests with fixture lanes | #368 PR/Done evidence; local targeted renderer test. | Each lane has worker, repo#issue, status (`ready`, `waiting`, `blocked`, `stuck`, `needs-evidence`), evidence URL, and next action. | Any lane state is collapsed into ambiguous success/failure, or next action/evidence is missing. |
| L4 | Aggregate comment preview/post dry-run | Synthetic GitHub comment fixture or dry-run mode only | #369 PR/Done evidence; dry-run output showing would-create/would-update managed comment body; no live post unless explicitly approved. | Preview is deterministic, compact, idempotent, and clearly identifies the managed comment target. | Dry-run posts live comments, duplicates unmanaged comments, or cannot show what would be posted/updated. |
| L5 | Broker/worker health snapshots | Read-only dashboard/health GET when available | Before/after read-only `/health`, worker fleet, queue/stale summary, and task-report snapshot; otherwise explicit snapshot blocker. | Health and queue/fleet state are unchanged or explained; active/stale tasks are named with owner/action. | Endpoint/credential unavailable, non-zero stale/active state has no owner/action, or validation uses writes to compensate. |
| L6 | Round closeout recommendation | Aggregate of L1-L5 and linked lanes | Parent #364 lane table; #367/#368/#369/#143/#370 PR/Done/Block URLs; focused local test output. | Recommendation says either merge/deploy-ready, merge-ready-but-deploy-gated, or needs another hardening pass with exact blockers. | Any lane lacks PR/Done/Block evidence, safety boundary was crossed, or blockers/next owner are unnamed. |

## Focused local validation commands

Run from the broker repository after lane PRs are available and merged into the validation branch as appropriate:

```sh
npm run build
npm test
npm run command_center_closeout_checklist -- --input <sanitized-evidence.json> --markdown
```

Add any lane-specific targeted commands from #367/#368/#369 PR descriptions. For docs-only matrix updates, `npm run build` is sufficient to prove the repository still type-checks.

## Read-only before/after snapshot checklist

Capture these before and after L1-L4 when an operator provides read-only broker access:

1. broker `/health` status and persistence/schema summary
2. worker fleet count, enabled state, and heartbeat freshness buckets
3. queued/claimed/running/blocked/stale task counts
4. `parent_issue=jinwon-int/a2a-broker#364` task-report summary
5. open PR/issue state for #367, #368, #369, #143, and #370

Do not include raw task logs, raw runner transcripts, secret values, or host-specific private paths in the evidence.

## Issue/PR evidence templates

```md
Start
```

```md
PR: <pr-url>
Matrix: docs/command-center-aggregate-closeout-validation-matrix.md
Tests/smokes: <commands and pass/fail summary>
Lane evidence: #367=<PR/Done/Block>; #368=<PR/Done/Block>; #369=<PR/Done/Block>; #143=<PR/Done/Block>; #370=<PR/Done/Block>
Safety: no live Telegram send, Gateway restart, production deploy, production DB mutation, terminal-outbox ACK, package publish, repo visibility change, or all-worker live smoke.
Remaining blockers: <none or exact owner/repo#issue + missing evidence>
Recommendation: <ready to merge/deploy | merge-ready but deploy-gated | another hardening pass required>
```

```md
Block: <exact blocked command/evidence>
Next owner: <repo#issue or operator>
Safety: no live Telegram send, Gateway restart, production deploy, production DB mutation, terminal-outbox ACK, package publish, repo visibility change, or all-worker live smoke was performed.
```

```md
Done: libero validation matrix attached for #364 aggregate closeout flow.
Evidence: <matrix doc/PR + local no-live checks + before/after read-only snapshots or explicit snapshot blocker>
Recommendation: <next operator decision with exact blockers>
```
