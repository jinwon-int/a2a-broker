# A2A Terminal Brief 완료: bangtong(1/7)

**Run:** a2a-r13-terminal-brief-realround-20260514T013556Z
**Parent Round:** a2a-r13-terminal-brief-realround-20260514T013556Z
**Origin Broker:** seoseo
**Lane:** bangtong (Team1, 1/7)
**Guard:** #598 fail-closed broker guard (cross-broker dispatch metadata validation)
**Parent Issue:** #607 (A2A R13 compact Terminal Brief real-round guard and aggregation verification)
**Issue:** #608 (R13 Team1 bangtong: #598 fail-closed dispatch guard implementation)

---

## Evidence: #598 fail-closed broker guard verified

### Guard Implementation (R12/PR #602)

The fail-closed broker guard was implemented in R12 (PR #602) and lives in:

| Component | File | Function |
|---|---|---|
| Preflight validation | `src/core/cross-broker-terminal-brief.ts` | `validateTerminalBriefForDispatch()` — validates parentRoundId, originBrokerId, parentRoundTotal, crossBrokerHandoff metadata before dispatch |
| Projection ingestion guard | `src/core/cross-broker-terminal-brief.ts` | `CrossBrokerTerminalBriefProjectionStore.ingest()` — calls preflight validation, fails closed (rejects) if metadata is missing/inconsistent |
| Post-dispatch verifier | `src/core/post-dispatch-verifier.ts` | `PostDispatchVerifier.verifyDispatch()` / `verifyCrossBrokerHandoff()` — validates crossBrokerHandoff payload fields |
| Broker integration | `src/core/broker.ts` | `ingestCrossBrokerTerminalBriefProjection()` — only stores/enqueues projections that pass the guard |

### What the guard validates

For every all-hands or cross-broker child Terminal Brief projection:

| Field | Guard Action |
|---|---|
| `parentRoundId` | Required, non-empty, non-whitespace |
| `originBrokerId` | Required, non-empty, must differ from receiving broker |
| `parentRoundTotal` | Required, must be a positive integer |
| `brokerOfRecordId` | Required for crossBrokerHandoff construction |

If any field is missing, invalid, or inconsistent, the guard **rejects** the projection with `missing_dispatch_metadata` — fail closed, never silently dropped.

### Test Results

**cross-broker-terminal-brief.test.ts** — 15 tests, all pass:

```
ok  1 - ingest is idempotent by parentRoundId/originBrokerId
ok  2 - rejects wrong-origin packets
ok  3 - rejects missing parent rounds
ok  4 - rejects stale replay
ok  5 - carries parent round denominator into outbox progress
ok  6 - symmetric for Gwakga-owned parent rounds
ok  7 - redacts unsafe content and fails closed for ACKs
ok  8 - survives broker snapshot persistence
ok  9 - rejects projection with missing parentRoundId
ok 10 - rejects projection with missing originBrokerId
ok 11 - rejects projection with missing parentRoundTotal
ok 12 - rejects projection with non-positive parentRoundTotal
ok 13 - rejects projection lacking brokerOfRecordId for crossBrokerHandoff
ok 14 - accepts valid seoseo-origin projection
ok 15 - accepts valid gwakga-origin projection
```

**post-dispatch-verifier.test.ts** — 35 tests across 7 suites, all pass:
- Valid dispatch (5 tests)
- Missing fields (4 tests)
- Mismatched fields (5 tests)
- crossBrokerHandoff validation (7 tests)
- Snapshot/check flow (8 tests)
- verifyDispatchWithSnapshot (3 tests)
- InMemorySnapshotStore (3 tests)

### Full Build

```
npm run build     → OK (TypeScript compilation clean)
node --test       → 1310 tests, 0 failures ✅
```

### Safety Verification

- No OpenClaw bootstrap context files would leak into the branch (checked `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, `.openclaw/` — all absent from repo root)
- No Gateway restart, broker/worker restart/reload, production deploy, DB mutation, manual ACK/replay, historical outbox replay, secret change, release, or force-push performed
- Provider accepted/message-id is not read/visibility/terminal ACK

### Cross-Broker Handoff Construction

When a valid projection is accepted, the terminal event outbox constructs `crossBrokerHandoff` with:

```json
{
  "parentRoundId": "<parentRoundId>",
  "originBrokerId": "<brokerOfRecordId>",
  "handoffBrokerId": "<originBrokerId>",
  "originTaskId": "<childTaskId>",
  "childWorkerId": "<childWorkerId>"
}
```

Validated and confirmed working for both seoseo-origin and gwakga-origin projections.

---

### Conclusion

The fail-closed broker guard for cross-broker dispatch (#598) is **proven working**. The guard correctly rejects projections with missing or inconsistent parentRoundId, originBrokerId, parentRoundTotal, or crossBrokerHandoff metadata at the ingestion preflight stage. All 50 relevant tests pass, and the full test suite (1310 tests) is green.

**Parent-only Terminal Brief ownership** — no terminal ACK, no provider send, no read/visibility proof; this is parent-broker aggregation evidence only, as verified by `notificationOwnership` in the outbox payload.
