# Handoff Scenario Matrix (S1–S5)

> Round 15 · Issue #69 · a2a-broker

## Overview

Defines five canonical handoff scenarios for A2A inter-node task dispatch, with
classification rules, expected outcomes, and a recovery ledger for observability.

## Scenarios

### S1: Normal Handoff

| Field | Value |
|---|---|
| **Trigger** | Sender dispatches to reachable receiver |
| **Outcome** | `delivered` |
| **Auto-retry** | No |
| **Escalate** | No |
| **Phases** | initiated → dispatched → acknowledged → completed |

### S2: Receiver Unavailable

| Field | Value |
|---|---|
| **Trigger** | Receiver unreachable or rejects dispatch |
| **Outcome** | `rejected` |
| **Auto-retry** | Yes |
| **Escalate** | Yes |
| **Phases** | initiated → dispatched → failed (receiver_unreachable / receiver_rejected) |

### S3: Sender Crash Mid-Handoff

| Field | Value |
|---|---|
| **Trigger** | Sender crashes during dispatch, partial state left |
| **Outcome** | `partial` |
| **Auto-retry** | Yes |
| **Escalate** | Yes |
| **Special** | `partialSnapshot` captured for crash recovery |

### S4: Duplicate Handoff (Idempotency)

| Field | Value |
|---|---|
| **Trigger** | Same idempotency key seen again |
| **Outcome** | `deduplicated` |
| **Auto-retry** | No |
| **Escalate** | Yes |
| **Priority** | Highest — takes precedence over S5, S2, S3 |

### S5: Recovery Handoff (Retry)

| Field | Value |
|---|---|
| **Trigger** | Retry of a previously failed handoff (`recoveryOf` set) |
| **Outcome** | `retried` |
| **Auto-retry** | No (already a retry) |
| **Escalate** | Yes |
| **Priority** | Second — takes precedence over S2, S3 |

## Classification Priority

```
S4 (duplicate) > S5 (recovery) > S2 (receiver unavailable) > S3 (sender crash) > S1 (normal)
```

## Phase State Machine

```
initiated ──→ dispatched ──→ acknowledged ──→ completed ✓
                  │               │                │
                  └──→ failed ✗   └──→ failed ✗   └──→ (terminal)
                       │               │
                       └──→ timed_out ─┘
                       └──→ canceled ──┘
```

Terminal phases (`completed`, `failed`, `timed_out`, `canceled`) reject further transitions.

## Recovery Ledger

The `RecoveryLedger` class tracks:

- **Handoff records**: per-attempt state with idempotency keys
- **Sealed entries**: final outcome classification after terminal phase
- **Recovery chains**: linked attempts sharing an idempotency key
- **Summary statistics**: by-scenario counts, by-outcome counts, active count, recovery metrics

### Summary Metrics

| Metric | Description |
|---|---|
| `totalAttempts` | Sealed ledger entries |
| `byScenario` | Count per S1–S5 |
| `byOutcome` | Count per outcome (delivered/rejected/partial/etc.) |
| `activeCount` | Non-terminal handoffs |
| `recoveryCount` | S5 entries |
| `avgRecoveryDurationMs` | Average S5 duration |

## Implementation

- **Types**: `src/core/handoff-types.ts`
- **Core logic**: `src/core/handoff-scenarios.ts`
- **Tests**: `src/core/handoff-scenarios.test.ts` (51 tests)

## Test Matrix

| Scenario | Classification | Phase Transition | Ledger Seal | Duplicate | Recovery Chain | Summary |
|---|---|---|---|---|---|---|
| S1 | ✓ | ✓ | ✓ (delivered) | — | — | ✓ |
| S2 | ✓ | ✓ (failed) | ✓ (rejected) | — | — | ✓ |
| S3 | ✓ | ✓ (failed+snapshot) | ✓ (partial) | — | — | ✓ |
| S4 | ✓ | ✓ (completed) | ✓ (deduplicated) | ✓ | — | ✓ |
| S5 | ✓ | ✓ (completed) | ✓ (retried) | — | ✓ | ✓ |
| Priority | ✓ | — | — | — | — | — |
