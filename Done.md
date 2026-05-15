# Done — Open Issue Hygiene And Stability Roadmap Reconciliation

## Summary

R22 Sogyo issue-hygiene lane classified stale R14/R12 issues and reconciled the #294 stability roadmap after #631 and #634 closed.

## Classification Results

### Stale / Absorbed — Recommend Close

| Issue | Classification | Evidence |
|---|---|---|
| [#615 — R14 parent round](https://github.com/jinwon-int/a2a-broker/issues/615) | Superseded by R16/R18/R20; child goals resolved later or absorbed into #497 | R16 #631, R20 #641, #634 |
| [#617 — R14 nosuk hot-table retention](https://github.com/jinwon-int/a2a-broker/issues/617) | Absorbed into current hot-table growth/retention work | `src/core/hot-table-growth.ts`, `BrokerRetentionPolicy`, retention/health docs |
| [#618 — R14 dungae secret-safe diagnostics](https://github.com/jinwon-int/a2a-broker/issues/618) | Absorbed into edge-secret rotation runbook/tooling | Redacted-only diagnostics and no-secret guardrails |
| [#619 — R14 jingun two-broker deploy safety](https://github.com/jinwon-int/a2a-broker/issues/619) | Absorbed into two-broker safety/revision docs | Safety regression matrix and Team2 capacity parity docs |
| [#598 — R12 cross-broker metadata fail-closed](https://github.com/jinwon-int/a2a-broker/issues/598) | Resolved by closed #634 routing contract | Terminal Brief routing implementation and tests |

### Keep Open

| Issue | Rationale |
|---|---|
| [#527 — GitHub read-only validation without patch diffs](https://github.com/jinwon-int/a2a-broker/issues/527) | Verify/propose production routing gap remains. |
| [#489 — A2AD trading-dialectic forward plan](https://github.com/jinwon-int/a2a-broker/issues/489) | Forward-looking architecture item, separate from #294. |

## Roadmap Reconciliation

- #631 and #634 materially advance #294 Phase 2 receipt semantics and Phase 3 live canary gates.
- #294 should remain open; its phase structure still describes remaining stability work.
- No production/live/runtime action was performed by this docs-only lane.

## Changed Files

| File | Change |
|---|---|
| `docs/stability-roadmap-progress-20260515.md` | New reconciliation doc mapping #631/#634 closure to #294 phases, issue classifications, and remaining blockers. |

## References

- Lane: https://github.com/jinwon-int/a2a-broker/issues/643
- Parent: https://github.com/jinwon-int/a2a-broker/issues/497
- Roadmap: https://github.com/jinwon-int/a2a-broker/issues/294
- Run: `a2a-r22-broker-lightweight-20260515T015139Z`

## Safety

No production deploy/restart, Gateway/broker/worker restart, live provider/Telegram send, terminal ACK, production DB mutation/prune/migration, historical outbox replay, release/tag publish, secret/visibility change, force-push, or broad crossBrokerTerminalRelay live window was performed.
