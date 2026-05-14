# Start — Broker hot-table health metrics and R14 #620 reconciliation

- **Agent:** Team1/bangtong (A2A Stability R20 retry lane)
- **Origin coordinator:** Gwakga
- **Receiving broker:** Seoseo
- **Issue:** https://github.com/jinwon-int/a2a-broker/issues/637
- **Parent:** https://github.com/jinwon-int/a2a-broker/issues/636
- **PR #620 (R14):** Reconciles unmerged hot-table retention PR — adopts warning truncation, runbook doc
- **Branch:** `a2a-patch-20260514-232005-a2a-stability-r20-retry-20260515T0818Z-1-bangtong`

## Changes

### Phase 1 — PR #620 reconciliation (warning truncation)
- `src/core/hot-table-growth.ts`:
  - Added `warningsTruncated` field to `HotTableGrowthProjection`
  - Added `DEFAULT_MAX_WARNINGS = 10` constant
  - Added `maxWarnings` option to `HotTableGrowthProjectionOptions`
  - Added `appendBounded()`, `countWarnings()`, `normalizeMaxWarnings()` helpers
  - Updated `buildWarnings()` to cap at `maxWarnings`
- `src/core/hot-table-growth.test.ts`: 3 test cases for warning truncation (`warningsTruncated fits`, `warningsTruncated when low max`, `warningsTruncated equals total` + `warningsTruncated false on zero`)
- `src/server.ts`:
  - Added `truncateMessage()` utility (caps string to maxLen + `...`)
  - Applied truncation (500 chars) to hot-table critical/warning health messages
- `docs/hot-table-retention-prune-runbook.md`: New runbook documenting retention policy, cleanup pipeline, health warnings, safe prune checklist, rollback

### Phase 2 — Health metrics
- `src/core/hot-table-growth.ts`:
  - Added `processMemory?` field to `HotTableGrowthProjection` (rssBytes, heapTotalBytes, heapUsedBytes, heapLimitBytes, heapUsedRatio)
  - Added `snapshotMetrics?` field (lastSnapshotBytes, lastPersistDurationMs, lastSnapshotAt)
  - Added `readinessDegradation?` field (heapPressure, memoryPressure, hydrationPressure, overallRisky)
  - Added `processMemory?` and `snapshotMetrics?` inputs to `HotTableGrowthProjectionOptions`
  - Added `computeReadinessDegradation()`: heap pressure at >80%, memory pressure at >50%, hydration pressure from critical skipped tables
  - Added `DEFAULT_HEAP_PRESSURE_RATIO`, `DEFAULT_MEMORY_PRESSURE_RATIO` constants
- `src/core/hot-table-growth.test.ts`: 3 test cases for processMemory/readinessDegradation/snapshotMetrics
- `src/server.ts`:
  - Updated `HealthDiagnosticsCache.get()` to accept optional `processMemory` and `snapshotMetrics`
  - Updated `/health` handler to read `readRuntimeMemoryUsage()` once and pass it as `processMemory` to the cache, avoiding duplicate calls

## Verification
- `npm run build` (tsc) — passes
- `node --test src/core/hot-table-growth.test.ts` — 24/24 tests pass
