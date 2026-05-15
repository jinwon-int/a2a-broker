# Done — Open issue hygiene and stability roadmap reconciliation

## Summary

R22 sogyo issue-hygiene lane: classified 7 stale R14/R12 issues and reconciled
#294 stability roadmap wording after #631 (#634 closure.

## Classification results

### STALE / ABSORBED — recommend close

| Issue | Classification | Evidence |
|---|---|---|
| [#615 — R14 parent round](https://github.com/jinwon-int/a2a-broker/issues/615) | Superseded by R16/R18/R20; all 7 child goals resolved via later rounds or absorbed into #497 | R16 #631 (Terminal Brief notification), R20 #641 (hot-table retention), #634 (four-case routing) |
| [#617 — R14 nosuk hot-table retention](https://github.com/jinwon-int/a2a-broker/issues/617) | Fully absorbed into R20 bangtong work | `src/core/hot-table-growth.ts`, `BrokerRetentionPolicy`, `docs/hot-table-retention-prune-runbook.md`, `docs/hot-table-health.md` |
| [#618 — R14 dungae secret-safe diagnostics](https://github.com/jinwon-int/a2a-broker/issues/618) | Team2; absorbed into `docs/edge-secret-rotation-runbook.md` | Redacted-only rotation runbook with no-secret-values guardrails |
| [#619 — R14 jingun two-broker deploy safety](https://github.com/jinwon-int/a2a-broker/issues/619) | Team2; absorbed into docs | `docs/a2a-2broker-safety-regression-readiness-matrix.md`, `docs/team2-gwakga-ops-dashboard-capacity-parity.md` |
| [#598 — R12 guard: cross-broker metadata fail-closed](https://github.com/jinwon-int/a2a-broker/issues/598) | Fully resolved by closed #634 | `src/core/terminal-brief-routing.ts`, terminal-brief-routing.test.ts covering all 4 cases + reject conditions |

### KEEP — still actionable

| Issue | Rationale |
|---|---|
| [#527 — GitHub read-only validation without patch diffs](https://github.com/jinwon-int/a2a-broker/issues/527) | Test fixtures exist for `github-verify` mode but production dispatch routing still requires patch diffs. Schema gap remains. |
| [#489 — A2AD trading-dialectic forward plan](https://github.com/jinwon-int/a2a-broker/issues/489) | Forward-looking design doc (Korean). Separate from stability roadmap; not stale. |

## Roadmap reconciliation

- **#631** (R16 Terminal Brief live notification fix) and **#634** (four-case
  routing contract) are both CLOSED and represent material progress under #294
  Phase 2 (receipt semantics) and Phase 3 (live canary gates).
- **No wording change to #294 is warranted** — the four phases correctly
  describe remaining work. Phase 2 vocabulary definition (openclaw#79) still
  pending. External upstream blocker `openclaw/openclaw#78261` still open.
- **Keep #294 open** as the stability roadmap.

## Changed files

| File | Change |
|---|---|
| `docs/stability-roadmap-progress-20260515.md` | **New** — reconciliation doc mapping #631/#634 closure to #294 phases, issue-by-issue classification table, remaining blockers |

## References

- **Lane:** https://github.com/jinwon-int/a2a-broker/issues/643
- **Parent:** https://github.com/jinwon-int/a2a-broker/issues/497
- **Roadmap:** https://github.com/jinwon-int/a2a-broker/issues/294
- **Run:** a2a-r22-broker-lightweight-20260515T015139Z
- **Classified issues:** #615, #617, #618, #619, #598, #527, #489

## Safety

No production deploy/restart, Gateway/broker/worker restart, live provider/Telegram
send, terminal ACK, production DB mutation/prune/migration, historical outbox replay,
release/tag publish, secret/visibility change, force-push, or broad crossBrokerTerminalRelay
live window was performed. Only docs change — no code, no tests, no live actions.

## Recommendation

Merge docs-only patch. No code change warranted: all stale R14/R12 content is
already absorbed into existing codebase and docs. Keep #527 and #489 open as
notable actionable items. Keep #294 open as the stability roadmap.
