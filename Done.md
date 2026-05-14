# Done — Broker hot-table health metrics and R14 #620 reconciliation

## Summary

This patch reconciles the still-open R14 hot-table retention PR (#620) against current `main` and adds health metrics to the `HotTableGrowthProjection` for OOM-risk detection in the broker health endpoint.

## Changed Files

| File | Change |
|---|---|
| `src/core/hot-table-growth.ts` | **+6 exports, +4 interfaces, +4 functions** — warning truncation (`warningsTruncated`, `DEFAULT_MAX_WARNINGS`, `maxWarnings`, `appendBounded`, `countWarnings`, `normalizeMaxWarnings`), health metrics (`processMemory`, `snapshotMetrics`, `readinessDegradation`, `computeReadinessDegradation`), bounded `buildWarnings` |
| `src/core/hot-table-growth.test.ts` | **+7 test cases** — 4 warning truncation tests, 3 health-metric tests |
| `src/server.ts` | `truncateMessage()` utility, message truncation at 500 chars in health endpoint, `processMemory` wired from `readRuntimeMemoryUsage()` into `HealthDiagnosticsCache.get()` |
| `docs/hot-table-retention-prune-runbook.md` | **New** — runbook covering retention policy, cleanup pipeline, health warnings, prune checklist, rollback |

## Test Results

```
✔ projectHotTableGrowth (24 tests)
  — 17 existing tests pass unchanged
  — 4 new warning truncation tests (fits, truncates, exact, zero)
  — 3 new health metrics tests (processMemory + readinessDegradation, heapPressure, snapshotMetrics)
```

## Health Metrics Added

- **`processMemory`**: rssBytes, heapTotalBytes, heapUsedBytes, heapLimitBytes, heapUsedRatio
- **`snapshotMetrics`**: lastSnapshotBytes, lastPersistDurationMs, lastSnapshotAt
- **`readinessDegradation`**:
  - `heapPressure` — heapUsedRatio > 80%
  - `memoryPressure` — hot-table memory > 50% of heap limit
  - `hydrationPressure` — any table at critical skipped ratio
  - `overallRisky` — any pressure flag set

## References

- **Issue:** https://github.com/jinwon-int/a2a-broker/issues/637
- **Parent:** https://github.com/jinwon-int/a2a-broker/issues/636
- **PR #620:** https://github.com/jinwon-int/a2a-broker/pull/620
- **Issues:** #617, #497, #294
