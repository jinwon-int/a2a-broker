# Terminal Brief approval dispatch adapter

Issue #706 adds a source-only/no-live adapter shell after the Terminal Brief approval executor. The goal is to keep approval dispatch reusable across OpenClaw, Hermes/Gongyung, and future external harnesses without hard-wiring broker core logic to `openclaw message send`.

The adapter consumes an `a2a-broker.terminal-brief-approval-executor.packet` and emits an `a2a-broker.terminal-brief-approval-dispatch-adapter.packet`.

## CLI

```bash
npm run terminal_brief_approval_dispatch -- --input approval-executor.json --adapter gongyung --target hermes://gongyung/approval --channel operator --requested-by broker-finalizer --json
```

The CLI also accepts lower-level Terminal Brief packets for convenience:

- approval request packet;
- closeout gate packet;
- finalizer workflow packet;
- finalizer handoff packet.

When lower-level packets are supplied, `--selected-action`, `--selected-target`, and `--attempt-execute` are forwarded through the no-live executor builder first.

Exit codes:

- 0: dispatch_draft_ready or approval_receipt_draft_ready;
- 1: dispatch_blocked;
- 2: usage or parsing error.

## API route

```text
POST /terminal-brief/closeout/approval-dispatch
```

Required role: `hub` or `operator`.

The request body must contain an approval executor packet directly or under one of:

- `approvalExecutor`
- `approvalExecutorPacket`
- `executorPacket`
- `packet`

Adapter options:

- `adapter`: `generic`, `openclaw`, `hermes`, or `gongyung`
- `target`
- `channel`
- `requestedBy` / `requested_by`
- `receiptId` / `receipt_id`

The route is read-only and returns `cache-control: no-store`.

## States

- `dispatch_draft_ready`: the executor is still `dispatch_pending`, and the adapter produced a transcript draft only.
- `approval_receipt_draft_ready`: the executor has simulated approval evidence, and the adapter produced a receipt draft only.
- `dispatch_blocked`: the executor is blocked, already reached `execute_blocked`, or the adapter name is unsupported.

## Adapter contract

Supported adapter types:

- `generic`
- `openclaw`
- `hermes`
- `gongyung`

All adapters share the same source-only contract:

- `dispatchPermitted=false`
- `providerSendPermitted=false`
- `approvalGrantPermitted=false`
- `executionPermitted=false`
- `terminalReceiptMutationPermitted=false`
- `integrationContract.openclawMessageSendRequired=false`
- `integrationContract.sendsApprovalRequest=false`
- `integrationContract.grantsApproval=false`
- `integrationContract.executesAction=false`

The transcript and receipt are drafts. They are not accepted-send evidence, visibility proof, terminal ACK, approval, or action execution.

## Safety boundaries

This adapter does not:

- send OpenClaw, Hermes, Gongyung, Telegram, or other provider messages;
- grant approval;
- execute a GitHub closeout action;
- post comments, merge PRs, or close issues;
- create TaskFlow records;
- ACK/replay terminal rows;
- deploy or restart runtime services;
- mutate DB state;
- perform historical replay;
- publish releases;
- move secrets or credentials.

Any future live adapter must preserve the separation between:

1. transcript dispatch;
2. real operator approval capture;
3. idempotent action execution;
4. receipt/visibility evidence.

Each live step needs explicit operator approval and its own idempotency boundary.
