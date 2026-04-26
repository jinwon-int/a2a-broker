# Team Aggregate E2E Proof Matrix

> Round 16 · Issue #73 · a2a-broker

## Overview

Validates that `fanout`, `split`, `review`, `swarm` assignment modes produce correct parent/child lifecycle outcomes in the broker read model.

## Proof Categories

### Closure Rules

| Check ID | Description | Applies |
|---|---|---|
| closure-001 | Parent waits for non-terminal children | All modes |
| closure-002 | Children reference correct parent | All modes |
| closure-003 | Parent succeeds only when all children succeed | All modes |
| closure-004 | Parent fails on child failure (fail-fast) | fanout, split, review |

### Barrier Rules

| Check ID | Description | Applies |
|---|---|---|
| barrier-001 | Swarm barrier child queued until threshold | swarm |
| barrier-002 | Review task references implementer artifacts | review |
| barrier-003 | Review worker ≠ implementer worker | review |

### Mode-Specific Invariants

| Check ID | Description | Mode |
|---|---|---|
| mode-fanout-001 | Children dispatched to distinct workers | fanout |
| mode-split-001 | All children on same worker | split |
| mode-swarm-001 | Parent tracks completion count | swarm |

### Edge Scenarios

| Check ID | Description |
|---|---|
| edge-001 | Duplicate child completion suppressed |
| edge-002 | Blocked/failed child prevents parent success |
| edge-003 | Timeout child has error or requeueCount > 0 |

## Assignment Modes

### Fanout (parent → N children, distinct workers)
- Cross-node delivery
- Independent completion
- Fail-fast on any child failure

### Split (parent → N children, same worker)
- Parallel subtasks within single node
- Coalesced wake to single session
- Fail-fast on any child failure

### Review (parent → implementer → reviewer)
- Sequential dependency chain
- Role separation (implementer ≠ reviewer)
- Review task references implementer artifacts
- Parent waits on review, not implementer

### Swarm (parent → N children + barrier)
- Coordinated parallel execution
- Barrier child queued until threshold met
- Parent transitions on threshold, not individual completion
- No fail-fast (uses barrier instead)

## Operator Checklist (Round 16 Closeout)

| ID | Check | Mode | Required |
|---|---|---|---|
| op-001 | Fanout children on distinct workers | fanout | ✅ |
| op-002 | Split children coalesced to single session | split | ✅ |
| op-003 | Review created only after implementer succeeds | review | ✅ |
| op-004 | Review worker ≠ implementer worker | review | ✅ |
| op-005 | Swarm barrier queued until threshold | swarm | ✅ |
| op-006 | Parent succeeds only when all children succeed | all | ✅ |
| op-007 | Duplicate child completion suppressed | all | ✅ |
| op-008 | Blocked child prevents parent success | all | ✅ |
| op-009 | Timeout child has error/requeue info | all | ✅ |
| op-010 | GitHub mode task IDs link to issue/PR | fanout | Optional |

## Implementation

- **Proof matrix**: `src/core/proof-matrix.ts`
- **Tests**: `src/core/proof-matrix.test.ts` (37 tests)
- **Fixtures**: `src/fixtures/team-assignment.ts`

## Test Results

319/319 pass (all suites including 37 new proof matrix tests)
