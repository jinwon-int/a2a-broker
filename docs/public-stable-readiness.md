# Public/Stable Readiness Checklist

Use this checklist before any `a2a-broker` visibility change, stable label, release
announcement, or Family Wiki/runbook promotion. It is a decision checklist, not a
release action: completing it does **not** change repository visibility, publish a
package, deploy production, restart Gateway, send live Telegram traffic, mutate a
DB, or ACK terminal outbox rows.

## Repository responsibility boundaries

| Repository | Owns | Does not own for this gate |
|---|---|---|
| `jinwon-int/a2a-broker` | Broker HTTP/JSON-RPC APIs, AgentCard discovery, task lifecycle, worker registration/heartbeat/queueing, status/read models, SSE, persistence, evidence validation, broker docs, and broker release gates. | Isolated GitHub patch execution, OpenClaw plugin UX, repo visibility changes, package publishing, production deploys, or provider delivery ACKs. |
| `jinwon-int/openclaw-plugin-a2a` | OpenClaw-facing request/status/cancel mapping, operator/plugin config, and caller UX into the broker. | Broker protocol semantics, broker persistence migrations, or docker-runner container execution. |
| `jinwon-int/a2a-docker-runner` | Isolated Docker execution for GitHub patch tasks and runner-owned artifact/evidence collection. | Broker task state machines, plugin routing UX, or release decisions for this repo. |

## Required gates

- [ ] **Operator approval boundary:** seoseo explicitly approves the intended
  public/stable action after reviewing this checklist and all lane evidence.
- [ ] **No action creep:** this gate only records readiness. Do not change repo
  visibility, publish packages/images, deploy production, restart Gateway, send
  live Telegram traffic, mutate DB rows, or ACK terminal outbox entries unless a
  separate operator approval names that exact action.
- [ ] **License decision:** a root `LICENSE` file is present and matches the
  approved release intent, or the release is blocked with an explicit owner/date
  for the license decision. `package.json.private=true` is not itself a license.
- [ ] **Secret/history scan:** run a fresh scan of committed history and the
  working tree. Findings must be redacted (`<redacted>`/placeholders only) and
  either remediated or accepted by seoseo before visibility changes.
- [ ] **Repository visibility review:** confirm branch protection, CODEOWNERS or
  review owners if used, issue/PR templates, default branch, and public-facing
  metadata before changing visibility.
- [ ] **Docs review:** README, quickstart, `.env.example`, protocol compatibility,
  release gate, and rollback docs describe the current broker behavior without
  host-specific paths, secret values, or private topology leaks.
- [ ] **Compatibility matrix:** `docs/protocol-compatibility.md` reflects the
  advertised AgentCard/JSON-RPC profile, non-goals, and conformance tests.
- [ ] **Cross-repo alignment:** plugin and runner docs/issues agree on the
  broker/plugin/runner responsibility split above; do not present this repo as a
  monorepo or as owning runner/plugin releases.
- [ ] **CI:** default branch CI is green for the exact commit proposed for public
  or stable readiness.
- [ ] **Local validation:** run `npm test` or, at minimum for docs-only changes,
  `npm run build` plus a focused docs/link inspection. Record exact commands and
  summarized output.
- [ ] **Smoke/release gate:** run the appropriate broker gate from
  `docs/release-gate.md` (`npm run release_gate`, `npm run docker_runtime_preflight
  -- --dry-run`, and/or approved no-live closeout report inputs). Any live-impact
  lane requires separate approval.
- [ ] **Rollback plan:** identify the owner and exact rollback path for docs,
  release tags, package/image publication, repo visibility, and production config.
- [ ] **Evidence links:** attach PR/Done/Block evidence to the readiness issue
  with sanitized command output and links to CI, smoke results, and unresolved
  blockers.

## Release decision record

Before announcing stable/public readiness, fill this in on the issue or release
runbook:

- Decision: `Block` / `Proceed to visibility review` / `Proceed to stable label`
- Commit/PR:
- Approver:
- CI evidence:
- Local validation:
- Smoke/release-gate evidence:
- Secret/history scan result: `clean` / `remediated` / `blocked`
- License decision:
- Rollback owner and path:
- Deferred follow-ups:

If any required gate is unknown, stale, or unapproved, the decision is `Block`.
