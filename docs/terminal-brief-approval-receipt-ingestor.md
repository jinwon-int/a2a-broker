# Terminal Brief approval receipt evidence ingestor

Issue #708 adds a source-only/no-live receipt evidence ingestor after the Terminal Brief approval dispatch adapter.

The ingestor defines the JSON evidence contract that OpenClaw, Hermes/Gongyung, or another external harness must provide before Terminal Brief can move toward a live/default-on path. It does not send providers, mutate terminal receipt rows, grant approval, or execute any closeout action.

## Input

The ingestor consumes an `a2a-broker.terminal-brief-approval-dispatch-adapter.packet` and zero or more receipt evidence records.

Accepted packet envelope keys:

- `approvalDispatch`
- `approvalDispatchPacket`
- `dispatchAdapter`
- `dispatchAdapterPacket`
- `packet`

Accepted evidence envelope keys:

- `receiptEvidence`
- `evidence`
- `evidenceRecords`
- `records`
- `receipt`
- `receiptRecord`

## Evidence kinds

| Kind | Meaning | Sufficient by itself? | Terminal ACK? |
|---|---|---:|---:|
| `provider_accepted` | provider/spool says the message was accepted, sent, delivered, or produced | No | No |
| `current_session_visible` | the current session has visibility/read proof for the Terminal Brief | Yes, as no-live evidence | No, only ACK-eligible |
| `manual_operator_confirmation` | a human operator confirms seeing the same Terminal Brief | Yes, as no-live evidence | No, only ACK-eligible |
| `approval_grant` | explicit approval evidence for the selected action/target | Yes, as no-live evidence | No |
| `rejected` | approval/receipt was rejected | Blocks unless reconciled | No |
| `expired` | receipt evidence expired or timed out | Stale | No |

Provider accepted evidence is intentionally not visibility proof. It can explain that a provider accepted a send/spool action, but it cannot justify terminal ACK, approval, or action execution.

## States

- `accepted`: fresh current-session-visible, manual operator confirmation, or matching approval grant evidence exists.
- `insufficient`: no evidence, or only provider-accepted evidence exists.
- `stale`: all supplied evidence is stale or expired.
- `conflicting`: positive and rejected evidence are mixed, or approval action/target conflicts with the dispatch packet.
- `blocked`: the dispatch adapter is blocked or evidence kind is unsupported.

## CLI

```bash
npm run terminal_brief_approval_receipt_ingestor -- --input approval-dispatch.json --evidence-kind current_session_visible --observed-at 2026-05-18T21:29:30.000Z --receipt-id receipt-1 --json
```

You can also provide an evidence file:

```bash
npm run terminal_brief_approval_receipt_ingestor -- --input approval-dispatch.json --evidence-file receipt-evidence.json --max-age-ms 300000 --json
```

Exit codes:

- 0: accepted or insufficient;
- 1: stale, conflicting, or blocked;
- 2: usage or parsing error.

## API route

```text
POST /terminal-brief/closeout/approval-receipt
```

Required role: `hub` or `operator`.

The route is read-only and returns `cache-control: no-store`.

Request body example:

```json
{
  "approvalDispatch": { "...": "a2a-broker.terminal-brief-approval-dispatch-adapter.packet" },
  "receiptEvidence": [
    {
      "kind": "current_session_visible",
      "observedAt": "2026-05-18T21:29:30.000Z",
      "receiptId": "receipt-visible-1",
      "currentSessionId": "session-current"
    }
  ],
  "maxAgeMs": 300000
}
```

## Safety boundaries

The ingestor sets all live effects to false:

- `providerSendPermitted=false`
- `approvalGrantPermitted=false`
- `executionPermitted=false`
- `terminalAckPermitted=false`
- `terminalReceiptMutationPermitted=false`
- `integrationContract.providerAcceptedIsVisibilityProof=false`
- `integrationContract.grantsApproval=false`
- `integrationContract.executesAction=false`

Even when `terminalAckEligible=true`, this route does not ACK anything. ACK remains a separately approved live operation requiring current-session-visible or manual operator receipt proof.

The ingestor does not post comments, merge PRs, close issues, send OpenClaw/Hermes/Gongyung/Telegram providers, ACK/replay terminal rows, restart/deploy services, mutate DB state, create TaskFlow records, replay history, publish releases, or move secrets.
