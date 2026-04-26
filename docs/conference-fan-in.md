# Teleconference Fan-In Proof and Transcript Artifact

> Round 18 · Issue #83 · a2a-broker

## Overview

Deterministic fan-in from multi-agent teleconference into a quorum decision and redacted transcript artifact. Extends Round 17 closeout reconciler concepts.

## Decision Types

| Decision | Meaning |
|---|---|
| `ready` | Quorum met and every non-terminal participant has contributed and settled, or is explicitly idle |
| `waiting` | Quorum not met, participants still contributing, or joined participants have not contributed/settled |
| `blocked` | Chair missing, participant blocked, or participant timed out |
| `failed` | Quorum unreachable (participants left) |

## Quorum Rules

1. `minQuorum` participants must be available (default: 2)
2. Chair must be present and contribute (if `requireChairContribution`)
3. `ready` requires every available participant to have contributed and settled, or be explicitly `idle`; a merely `joined` participant keeps the conference `waiting`
4. `idleTimeoutMs` is reconciled against participant `lastActiveAt` via `currentVerdict(asOf)` or `reconcileTimeouts(asOf)`; timed-out participants block the conference
5. If remaining available participants drop below `minQuorum` after departures → `failed` (unreachable)

## Contribution Idempotency

- Each contribution identified by `(participantId, id)` pair
- Duplicate submissions are rejected (no state change)
- Unknown participants cannot contribute
- Optional `maxContributionsPerParticipant` limit

## Transcript Artifact

Redacted and deterministic by default — no raw session text. Participant order, contribution order (including equal timestamps), artifact IDs, unique artifact lists, and generated timestamps are stable for the same inputs:

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
| Participant timed out manually or by elapsed idle timeout | `blocked` |
| Quorum unreachable | `failed` |
| Duplicate contribution | idempotent (no-op) |
| Max contributions exceeded | rejected |
| Joined participant has not contributed or settled | `waiting` |
| Explicitly idle participant without contribution | settled for closeout |

## Implementation

- **Fan-in**: `src/core/conference-fan-in.ts`
- **Tests**: `src/core/conference-fan-in.test.ts` (38 tests)

## Test Results

`node --test dist/core/conference-fan-in.test.js` → 38/38 pass
