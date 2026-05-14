# Terminal Brief Child Dispatch Guard

## Rationale

When a broker creates child tasks that belong to a Terminal Brief parent round, the
task payload **must** carry complete dispatch metadata (`parentRoundId`, `originBrokerId`,
`parentRoundTotal`, `parentRoundOrder`). Without these fields, downstream Terminal Brief
projection ingestion would either reject the projection (silently dropping it) or proceed
with incomplete metadata, resulting in mangled progress tracking and terminal notifications.

The dispatch guard enforces a **fail-closed** policy: child task creation is rejected at the
broker entry point (`createTask`) rather than allowing incomplete metadata through.

## Required Payload Fields

The following payload keys (exported as constants from
`src/core/cross-broker-terminal-brief.ts`) are checked:

| Constant | Payload Key | Description |
|----------|-------------|-------------|
| `TERMINAL_BRIEF_PARENT_ROUND_ID_KEY` | `parentRoundId` | Parent round task ID |
| `TERMINAL_BRIEF_ORIGIN_BROKER_ID_KEY` | `originBrokerId` | Broker creating the child task (defaults to `this.brokerId` when absent) |
| `TERMINAL_BRIEF_PARENT_ROUND_TOTAL_KEY` | `parentRoundTotal` | Total expected children in the round (positive integer) |
| `TERMINAL_BRIEF_PARENT_ROUND_ORDER_KEY` | `parentRoundOrder` | 1-based order of this child in the round (positive integer, ≤ total) |
| `TERMINAL_BRIEF_BROKER_OF_RECORD_ID_KEY` | `brokerOfRecordId` | Parent broker-of-record for `crossBrokerHandoff` construction |

## Trigger Condition

The guard fires when the task payload contains **any** Terminal Brief field. If the payload
has a `parentRoundId` but is missing `originBrokerId` (and no broker id is available as a
default), the creation is rejected with `BrokerError("bad_request", ...)`.

If the payload has **no** Terminal Brief fields, the guard is a no-op and task creation
proceeds normally.

## Validation Rules (via `validateChildTaskTerminalBriefPayload`)

1. `parentRoundId` must be a non-empty string.
2. `originBrokerId` must be a non-empty string. When absent from the payload but a
   `brokerId` is provided, the broker id is used as the default.
3. `parentRoundTotal` must be a positive integer (or non-empty numeric string).
4. `parentRoundOrder` must be a positive integer (or non-empty numeric string).
5. `parentRoundOrder` must not exceed `parentRoundTotal`.
6. `brokerOfRecordId` is required for `crossBrokerHandoff` construction.

## Idempotency

If a task already exists with the requested `id`, the idempotency check fires **before**
the Terminal Brief guard. This means re-creating an already-accepted task with the same id
(and possibly incomplete metadata) succeeds — the existing task record is returned as-is.

## Entry Point

The guard lives in `src/core/broker.ts` inside `createTask()`, immediately after
`normalizeGitHubPatchTaskRequest()` and `assertTaskPayload()`, and before any
resource lookups or side effects.

## API

### `validateChildTaskTerminalBriefPayload(payload, brokerId?)`

Returns `{ valid: true, errors: [] }` when:
- The payload has no Terminal Brief fields (no-op).
- All required fields are present and valid.

Returns `{ valid: false, errors: [...] }` when Terminal Brief fields are detected but
incomplete or invalid.

### `hasTerminalBriefPayloadFields(payload)`

Quick check: returns `true` if the payload contains any recognized Terminal Brief key.

### `extractTerminalBriefPayloadFields(payload)`

Extracts and normalizes Terminal Brief fields from a free-form payload into a
`TerminalBriefDispatchValidationInput`.

## Related

- `src/core/cross-broker-terminal-brief.ts` — validation functions and constants
- `src/core/broker.ts` — `createTask()` entry point
- `docs/gwakga-seoseo-handoff-receiver-ops.md` — handoff receiver ops
- Issue #598 (superseded by this guard)
