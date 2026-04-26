# Autonomous Aggregate Closeout Reconciler

> Round 17 · Issue #78 · a2a-broker

## Overview

Deterministic closeout decision engine for parent aggregate tasks. Consumes child task events and produces `ready`, `waiting`, `blocked`, or `failed` verdicts without polling.

## Decision Types

| Decision | Meaning | Signals |
|---|---|---|
| `ready` | All children terminal, parent can close | None |
| `waiting` | Children still in progress | Active/queued child IDs |
| `blocked` | Fail-fast triggered (failure/cancel/stale) | Blocking child IDs |
| `failed` | Max requeue exceeded, unrecoverable | Exhausted child IDs |

## Configuration

| Option | Default | Description |
|---|---|---|
| `failFast` | `true` | Any child failure blocks parent |
| `maxRequeueAttempts` | `3` | Requeue limit before permanent failure |
| `treatStaleAsBlocked` | `true` | Stale children count as blocked |

## Decision Flow

```
ingest(child_event)
  → duplicate? (same status+stale) → no-op, return current
  → update child state
  → compute:
    1. fail-fast: any failed/canceled/stale? → blocked
    2. max requeue exceeded? → failed
    3. all terminal?
       - fail-fast: all succeeded → ready
       - non-fail-fast: any terminal → ready
    4. otherwise → waiting
```

## Scenarios Covered

| Scenario | Events | Decision |
|---|---|---|
| All succeed | 3× succeeded | `ready` |
| Partial completion | 1× succeeded, 1× running | `waiting` |
| Child failure (fail-fast) | 1× failed | `blocked` |
| Child failure (non-fail-fast) | 1× failed | `ready` |
| Canceled child | 1× canceled | `blocked` |
| Stale child | 1× running+stale | `blocked` |
| Max requeue exceeded | 1× queued, requeueCount=3 | `failed` |
| Duplicate completion | Same event twice | idempotent (no seq change) |
| Swarm barrier | 2× succeeded, 1× running | `waiting` |
| Review chain | impl succeeded, review running | `waiting` |
| Review rejected | impl succeeded, review failed | `blocked` |

## Command-Center Comment

`formatCloseoutComment()` produces Markdown suitable for GitHub issue comments:

```
✅ **Closeout: READY**
> All 3 children succeeded
> Children: 3✓ 0✗ 0⊘ 0⟳ 0⋯ 0⏰
> Parent: `parent-123` | seq: 3
```

## Implementation

- **Reconciler**: `src/core/closeout-reconciler.ts`
- **Tests**: `src/core/closeout-reconciler.test.ts` (40 tests)

## Test Results

363/363 pass (all suites including 40 new)
