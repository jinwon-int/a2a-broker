# Teleconference Fan-In Proof and Transcript Artifact

> Round 18 · Issue #83 · a2a-broker

## Overview

Deterministic fan-in from multi-agent teleconference into a quorum decision and redacted transcript artifact. Extends Round 17 closeout reconciler concepts.

## Decision Types

| Decision | Meaning |
|---|---|
| `ready` | Quorum met, all participants contributed or idle |
| `waiting` | Quorum not met or participants still contributing |
| `blocked` | Chair missing, participant timed out |
| `failed` | Quorum unreachable (participants left) |

## Quorum Rules

1. `minQuorum` participants must be active (default: 2)
2. Chair must be present and contribute (if `requireChairContribution`)
3. Timed-out participants block the conference
4. If active + left < minQuorum → `failed` (unreachable)

## Contribution Idempotency

- Each contribution identified by `(participantId, id)` pair
- Duplicate submissions are rejected (no state change)
- Unknown participants cannot contribute
- Optional `maxContributionsPerParticipant` limit

## Transcript Artifact

Redacted by default — no raw session text:

```typescript
{
  type: "teleconference-transcript",
  generatedAt: string,
  participants: [{ nodeId, displayName, role, status, contributionCount }],
  contributions: [{ id, participantId, summary, category, artifactIds, replyTo, createdAt }],
  decisionCategories: { total, analysis, decision, question, artifact, correction },
  threadCount: number,
  uniqueArtifacts: string[]
}
```

## Scenarios Covered

| Scenario | Decision |
|---|---|
| Simple 2-participant success | `ready` |
| No quorum | `waiting` |
| Chair missing | `blocked` |
| Chair not contributed | `waiting` |
| Participant timed out | `blocked` |
| Quorum unreachable | `failed` |
| Duplicate contribution | idempotent (no-op) |
| Max contributions exceeded | rejected |

## Implementation

- **Fan-in**: `src/core/conference-fan-in.ts`
- **Tests**: `src/core/conference-fan-in.test.ts` (31 tests)

## Test Results

401/401 pass (all suites including 31 new)
