# Session Isolation Contract for A2A Full-Handler Workers

## Runtime Invariant

**Every A2A full-handler worker invocation MUST use a task-scoped ephemeral session id.**

Workers must NOT dispatch tasks into shared/long-lived sessions (e.g. `main`, Telegram channel session, or static `a2a-worker`).

## Rationale

Reusing a shared OpenClaw session for unrelated A2A tasks causes:

- **History leakage:** task B sees task A's conversation context, leading to
  incorrect inferences, phantom diagnostics, and task contamination.
- **Stale retry loops:** a retried task inherits the previous attempt's
  session state, re-triggering the same failure path without fresh context.

## Session ID Format

```
a2a-<nodeId>-<taskId>
```

| Component | Example | Description |
|-----------|---------|-------------|
| `a2a-` | `a2a-` | Fixed prefix for all A2A task sessions |
| `<nodeId>` | `dungae` | Worker node identifier |
| `<taskId>` | `550e8400-...` | Broker-assigned task UUID |

Example: `a2a-dungae-550e8400-e29b-41d4-a716-446655440000`

## Derivation

The session ID is derived deterministically from the task record:

```typescript
import { deriveSessionIdFromTask } from "./workers/session-isolation.js";

const sessionId = deriveSessionIdFromTask(task, "dungae");
// → "a2a-dungae-550e8400-e29b-41d4-a716-446655440000"
```

This is statelessly computable — no side-channel state or live session lookup needed.

## Forbidden Session IDs

The following session IDs MUST NOT be used by full-handler workers:

- `main` — the shared primary OpenClaw session
- `telegram` — the Telegram channel session
- `a2a-worker` — a static worker-wide session
- `openclaw-tui` — the TUI session
- `agent` — generic agent session

## Retry / Requeue Semantics

| Scenario | Session ID | Rationale |
|----------|-----------|-----------|
| First attempt | `a2a-dungae-task-abc` | Fresh task scope |
| Retry (requeued) | `a2a-dungae-task-abc` | Same task, preserved context within scope |
| Different task | `a2a-dungae-task-xyz` | Different scope, no cross-contamination |
| Different node | `a2a-sogyo-task-abc` | Different node, different scope |

Key insight: the session is scoped to the **task**, not the **attempt**. A requeued
task that picks up where the previous attempt left off benefits from preserved
context within its own isolated scope. Unrelated tasks never share this scope.

## Verification

### Source-level test

```bash
npm run build && node --test dist/workers/session-isolation.test.js
```

The test suite verifies:
- Deterministic session ID derivation
- Different tasks → different session IDs
- Forbidden session IDs (`main`, `telegram`, etc.) are rejected
- Missing `--session-id` flag is detected
- Wrong session ID is detected
- `buildSessionIsolatedArgs` produces correct handler arguments

### Regression guard

The regression tests specifically catch two common failure modes:

1. **Missing session isolation:** handler args without `--session-id`
2. **Shared session dispatch:** handler args using `--session-id main` or `--session-id telegram`

Both are treated as hard failures.

## Integration

When constructing an external worker handler for a full-handler worker, use
`buildSessionIsolatedArgs` to enforce the invariant:

```typescript
import { createExternalWorkerHandler } from "./worker.js";
import { buildSessionIsolatedArgs } from "./workers/session-isolation.js";

const handler = createExternalWorkerHandler({
  command: "openclaw",
  args: buildSessionIsolatedArgs(
    ["agent", "--model", "opus", "--print"],
    nodeId,
    taskId,
  ),
});
```

## References

- Issue: [jinwon-int/a2a-broker#164](https://github.com/jinwon-int/a2a-broker/issues/164)
- Module: `src/workers/session-isolation.ts`
- Tests: `src/workers/session-isolation.test.ts`
