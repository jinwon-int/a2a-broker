# Stability Roadmap Progress: #631/#634 closure and stale issue reconciliation

**Date:** 2026-05-15  
**Parent:** [#294 (Stability Roadmap)](https://github.com/jinwon-int/a2a-broker/issues/294)  
**Lane:** [#643 (R22 sogyo)](https://github.com/jinwon-int/a2a-broker/issues/643)  
**Previous round:** R20 merge at `23d2bc8`  

This document reconciles the stability roadmap wording after the closure of two
key Terminal Brief tracking issues and classifies seven stale R14/R12 issues
that are open in the repository.

## Closed issues now absorbed into #294 progress

### #631 — R16: Terminal Brief live notification path fix (CLOSED, completed)

**Phase mapping:**
- **Phase 2 (operator receipt semantics):** Fixed the
  plugin/broker notification bridge so accepted-send rows actually trigger
  Telegram delivery. Proved that `attempts=0` / `receipt.status=accepted` alone
  is not operator-visible receipt.
- **Phase 3 (live canary and recovery gates):** Demonstrated a bounded canary
  matrix that proves success/failure without DB prune, manual ACK, replay, or
  repeated provider sends.

**Evidence absorbed into roadmap progress:** The notification path fix directly
advances Phase 2's receipt-boundary enforcement and Phase 3's no-live canary
proof pattern.

### #634 — A2A Terminal Brief four-case parent-origin routing contract (CLOSED, completed)

**Phase mapping:**
- **Phase 2 (operator receipt semantics):** Encoded the four normal routing
  cases (Seoseo Team1-only, Seoseo cross-team, Gwakga Team2-only, Gwakga
  cross-team) as explicit dispatch invariants rather than per-canary
  procedures. Published as `src/core/terminal-brief-routing.ts` with tests.
  Core invariant: the initiating broker is the parent/origin broker and the
  only operator-facing Terminal Brief sender.

**Evidence absorbed into roadmap progress:** Defines the vocabulary of
`parentRoundId`, `originBrokerId`, `brokerOfRecordId`, `handoffBrokerId`, and
`team/scope` that the roadmap's Phase 2 receipt semantics require for correct
parent-origin routing.

## Stale issue classifications

### STALE / ABSORBED — recommend close

| Issue | Original scope | Absorbed into | Action |
|---|---|---|---|
| [#615 — R14 parent round](https://github.com/jinwon-int/a2a-broker/issues/615) | Live broker/worker hardening (7 children) | Superseded by R16/R18/R20. Goals (fail-closed metadata, secret-safe diagnostics, hot-table retention, deploy safety) all resolved in later rounds or absorbed into #497. | Keep open for archival reference; mark as superseded by #497. |
| [#617 — R14 nosuk hot-table retention](https://github.com/jinwon-int/a2a-broker/issues/617) | Hot-table retention/compaction design, bounded health warnings | Entirely absorbed into `src/core/hot-table-growth.ts` (474 lines), `BrokerRetentionPolicy` in `src/core/broker.ts`, `docs/hot-table-retention-prune-runbook.md`, and `docs/hot-table-health.md` — all produced in R20 #641 (merged at current HEAD). | Recommend close. No remaining actionable gap. |
| [#618 — R14 dungae secret-safe diagnostics](https://github.com/jinwon-int/a2a-broker/issues/618) | Secret-safe diagnostics/rotation tooling without printing secrets | Absorbed into `docs/edge-secret-rotation-runbook.md` — full rotation checklist with redacted-only preflight evidence and no-secret-values guardrails. Team2 issue. | Recommend close. Team1 has no remaining action. |
| [#619 — R14 jingun two-broker deploy safety](https://github.com/jinwon-int/a2a-broker/issues/619) | Two-broker deploy safety evidence, revision reporting, rollback notes | Absorbed into `docs/a2a-2broker-safety-regression-readiness-matrix.md`, `docs/team2-gwakga-ops-dashboard-capacity-parity.md`, `docs/team2-gwakga-worker-onboarding-retargeting.md`. Team2 issue. | Recommend close. Team1 has no remaining action. |
| [#598 — R12 guard: cross-broker metadata fail-closed](https://github.com/jinwon-int/a2a-broker/issues/598) | Fail-closed when cross-broker dispatch omits parent Terminal Brief metadata | Entirely resolved by the closed #634 routing contract. `src/core/terminal-brief-routing.ts` explicitly rejects unknown initiators, unsupported scopes, and parentless projections. Tests in `src/core/terminal-brief-routing.test.ts` cover all four cases plus reject conditions. | Recommend close. Implemented and tested in closed #634. |

### STILL ACTIONABLE — recommend keep open

| Issue | Original scope | Current status | Action |
|---|---|---|---|
| [#527 — GitHub read-only validation without patch diffs](https://github.com/jinwon-int/a2a-broker/issues/527) | Broker/worker dispatch hard-codes `github-propose-patch` and can't handle read-only `github-verify`/libero tasks | Test fixtures exist in `src/core/broker.test.ts` and `src/openclaw-handler-artifact.test.ts` for `github-verify` mode, but the production dispatch routing in the worker handler still treats GitHub issues as requiring patch diffs. No merged implementation separates verify vs. propose paths. | Recommend keep open. Partially modelled in tests but not deployed. |
| [#489 — A2AD trading-dialectic development plan](https://github.com/jinwon-int/a2a-broker/issues/489) | Forward design for A2A dialectic mode generalization (Korean) | Forward-looking architecture document. Not stale — it describes planned work beyond the stability roadmap. | Recommend keep open. Separate from #294 roadmap; R22+ design discussion. |

## Roadmap reconciliation conclusion

**Keep #294 open.** The roadmap's four phases remain valid:

- **Phase 1 (queue hygiene)** — Closeout checklist exists; ongoing maintenance.
- **Phase 2 (receipt semantics)** — #631/#634 advance vocabulary and path; full
  OpenClaw core vocabulary definition (`openclaw#79`) still pending.
- **Phase 3 (live canary gates)** — #631 proves bounded canary matrix pattern;
  stale/retry/requeue proof checks and standardized rollback checks remain.
- **Phase 4 (operational docs)** — Per-worker Telegram notification disabled;
  version baselines need documenting after each future round.

The closure of #631 and #634 represents material progress under Phase 2 and
Phase 3, but does not complete either phase. No wording change to #294 is
warranted — the phases correctly describe the remaining work.

## Remaining blockers

- Upstream `openclaw/openclaw#78261` remains `OPEN` / `CONFLICTING` / `DIRTY`.
- External scanner/public-readiness evidence not yet complete per
  `docs/team1-public-readiness-final-closeout-matrix.md`.
- No explicit operator approval for public-readiness publication.
