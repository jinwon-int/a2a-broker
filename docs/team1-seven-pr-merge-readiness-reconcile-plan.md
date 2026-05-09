# Team1 seven-PR merge readiness and reconcile plan

Issue: [a2a-broker#452](https://github.com/jinwon-int/a2a-broker/issues/452)  
Parent roadmap: [a2a-broker#294](https://github.com/jinwon-int/a2a-broker/issues/294)  
Previous closeout: [a2a-broker#446](https://github.com/jinwon-int/a2a-broker/issues/446)  
Snapshot time: `2026-05-09T09:48:13Z`

This is a read-only operator checklist for the seven open Team1 PRs. It does not authorize or perform any PR merge, production deploy/restart, Gateway/broker/worker restart, production DB mutation, live provider/Telegram send, terminal-outbox ACK, or raw secret logging.

## Live readiness snapshot

| PR | Lane / source issue | Scope | Current evidence | Merge posture |
| --- | --- | --- | --- | --- |
| [a2a-plane#101](https://github.com/jinwon-int/a2a-plane/pull/101) | [a2a-plane#100](https://github.com/jinwon-int/a2a-plane/issues/100) | Public-readiness closeout doc update in `docs/public-readiness.md`. | `mergeable=MERGEABLE`; `check` succeeded; 1 commit `a3b6908`; files changed: `docs/public-readiness.md`. | Safe to merge only after explicit operator approval. |
| [a2a-plane#103](https://github.com/jinwon-int/a2a-plane/pull/103) | [a2a-plane#102](https://github.com/jinwon-int/a2a-plane/issues/102) | Docker Runner no-diff closeout guidance and guidance test. | `mergeable=MERGEABLE`; `check` succeeded; 1 commit `695ab79`; files changed: `docs/docker-runner-no-diff-closeout-guidance.md`, `scripts/check-no-diff-closeout-guidance.test.mjs`. | Safe to merge only after explicit operator approval. |
| [openclaw-plugin-a2a#241](https://github.com/jinwon-int/openclaw-plugin-a2a/pull/241) | [openclaw-plugin-a2a#240](https://github.com/jinwon-int/openclaw-plugin-a2a/issues/240) | Plugin public-stable readiness documentation. | `mergeable=MERGEABLE`; both `build` checks succeeded; 1 commit `ef28d5d`; files changed: `docs/public-stable-readiness.md`. | Safe to merge only after explicit operator approval. |
| [openclaw-plugin-a2a#243](https://github.com/jinwon-int/openclaw-plugin-a2a/pull/243) | [openclaw-plugin-a2a#242](https://github.com/jinwon-int/openclaw-plugin-a2a/issues/242) | Docker Runner dev E2E proof, worker status marker, and proposal marker bridge coverage. | `mergeable=MERGEABLE`; both `build` checks succeeded; 1 commit `b565b96`; files changed: `docs/docker-runner-dev-e2e-proof.md`, `src/worker-status-marker.ts`, `test/docker-runner-dev-e2e-proof.test.mjs`, `tests/proposal-marker-bridge.test.ts`. | Safe to merge only after explicit operator approval. |
| [a2a-broker#445](https://github.com/jinwon-int/a2a-broker/pull/445) | [a2a-broker#444](https://github.com/jinwon-int/a2a-broker/issues/444) | Team1 public-readiness final closeout matrix refresh. | `mergeable=MERGEABLE`; both `build` checks succeeded; 1 commit `2d2aa0f`; files changed: `docs/team1-public-readiness-final-closeout-matrix.md`. | Safe to merge only after explicit operator approval. |
| [a2a-broker#449](https://github.com/jinwon-int/a2a-broker/pull/449) | [a2a-broker#448](https://github.com/jinwon-int/a2a-broker/issues/448) | Command-center checklist and round closeout reconcile improvements. | `mergeable=MERGEABLE`; both `build` checks succeeded; 1 commit `90e44db`; files changed: `scripts/command-center-closeout-checklist.mjs`, `scripts/command-center-closeout-checklist.test.mjs`, `src/core/operator-task-report.test.ts`, `src/github/round-closeout-reconcile.test.ts`, `src/github/round-closeout-reconcile.ts`. | Safe to merge only after explicit operator approval. |
| [a2a-broker#450](https://github.com/jinwon-int/a2a-broker/pull/450) | [a2a-broker#447](https://github.com/jinwon-int/a2a-broker/issues/447) | Docker Runner branch/no-diff guard contract and regression coverage. | `mergeable=MERGEABLE`; both `build` checks succeeded after repair commit `e5e4feb`; commits `cfdfdce`, `e5e4feb`; files changed: `scripts/openclaw-a2a-task-handler.mjs`, `src/openclaw-handler-artifact.test.ts`. | Safe to merge only after explicit operator approval. |

No additional worker action is indicated for the seven PRs at this snapshot. Re-check each PR immediately before merging; if any PR becomes non-mergeable, receives a failing/pending required check, or gains requested changes, stop and send that lane back for worker action.

## Recommended merge order

1. `a2a-plane#101` — land the plane public-readiness documentation baseline.
2. `openclaw-plugin-a2a#241` — land the plugin public-stable readiness baseline.
3. `a2a-broker#445` — land the broker public-readiness closeout matrix baseline.
4. `a2a-plane#103` — land the plane Docker Runner no-diff closeout guidance.
5. `openclaw-plugin-a2a#243` — land the plugin Docker Runner dev E2E/status-marker proof.
6. `a2a-broker#449` — land broker command-center/reconcile improvements.
7. `a2a-broker#450` — land broker Docker Runner branch/no-diff guard hardening after the reconcile/checklist support is in place.

The first three PRs are public-readiness documentation/evidence baselines. The last four are branch-ownership/no-diff hardening and reconcile support. Cross-repo dependencies are loose, but this order keeps the operator narrative coherent and leaves the concrete broker guard last.

## Current blockers and no-go conditions

- No PR merge is authorized by this plan; require a separate explicit operator approval before merging any listed PR.
- Public-readiness remains **NO-GO**. `openclaw/openclaw#78261` changed from the previous `CONFLICTING/DIRTY` blocker shape to `mergeable=MERGEABLE`, `mergeStateStatus=UNSTABLE`, head `0f73522a2d2c8fae01744ca56ae511b3214d36a6`, with `Critical Quality (network-runtime-boundary)` still `IN_PROGRESS` at this snapshot. Treat the blocker as not cleared until required checks are complete/stable, the upstream PR is merged and rolled out where required, scanner evidence is refreshed, and the operator explicitly approves publication/visibility changes.
- Keep [a2a-broker#294](https://github.com/jinwon-int/a2a-broker/issues/294) open until post-merge reconcile confirms the seven PRs, source issues, upstream state, public-readiness scan, and operator approval state.
- Keep [a2a-broker#446](https://github.com/jinwon-int/a2a-broker/issues/446) open until the branch-ownership hardening PRs are merged and their source issues auto-close or receive explicit closeout comments.

## Post-merge reconcile plan

After the operator explicitly approves merges and the PRs are merged in order:

1. Capture each merged PR's merge commit, merged timestamp, final check conclusion, and compare-to-main result.
2. Confirm source issues auto-close: `a2a-plane#100/#102`, `openclaw-plugin-a2a#240/#242`, and `a2a-broker#444/#448/#447`. If any remains open, add a closeout comment linking the merged PR and close only if the operator's merge policy allows it.
3. Update [a2a-broker#446](https://github.com/jinwon-int/a2a-broker/issues/446) with the branch-ownership hardening outcome: `a2a-plane#103`, `openclaw-plugin-a2a#243`, `a2a-broker#449`, and `a2a-broker#450`, including the #450 repair commit `e5e4feb`.
4. Update [a2a-broker#294](https://github.com/jinwon-int/a2a-broker/issues/294) with the seven-PR merge table, any issue-close drift, and the current `openclaw/openclaw#78261` state.
5. Refresh the broker public-readiness scan from the merged broker main branch with `npm run scan:public-readiness`; record the result without performing any deploy/restart/provider send/outbox ACK.
6. If `openclaw/openclaw#78261` is still not merged/rolled out or public-readiness evidence is stale, keep parent public-readiness issues open and labeled/treated as NO-GO.
7. If every merge, issue close, scanner, and upstream/operator gate is clean, prepare the final parent closeout comment for operator review before changing any publication or production state.

## Local validation for this planning patch

- GitHub state was read with `gh pr view` / `gh issue view` only.
- This patch is documentation-only and performs no live mutation other than the required GitHub issue evidence comments for the A2A task.
