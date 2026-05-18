# Terminal Brief broker finalizer approval status table

terminal-brief-finalizer-approval-status is a source-only/no-live bridge after the
approval dispatch adapter and approval receipt evidence ingestor.

It gives one broker finalizer a compact readiness table before any real closeout
action is allowed.

## Inputs

- a2a-broker.terminal-brief-approval-dispatch-adapter.packet
- optional a2a-broker.terminal-brief-approval-receipt-ingestor.packet

The status table is harness-neutral. It can be used by OpenClaw, Hermes,
Gongyung, or another public A2A harness as JSON. It does not require
openclaw message send.

## Output states

- waiting_for_receipt_evidence: receipt ingestor packet is missing or
  insufficient. Provider accepted alone stays insufficient.
- waiting_for_visibility_evidence: approval evidence exists, but no
  current_session_visible or manual_operator_confirmation evidence exists.
- waiting_for_approval_evidence: visibility/manual receipt exists, but no
  matching approval_grant evidence exists for the selected action/target.
- ready_for_finalizer_review: dispatch, visibility receipt, and approval
  evidence are all present as source-only evidence.
- stale: receipt evidence is stale or expired.
- conflicting: receipt/approval evidence conflicts.
- blocked: dispatch or receipt evidence is blocked.

## Table rows

The packet includes five rows:

1. dispatch: approval dispatch adapter packet availability and state.
2. receipt: accepted receipt evidence plus visibility/manual proof.
3. approval: matching approval grant evidence for the requested action/target.
4. execution: always not_permitted_source_only.
5. default_on: whether source criteria are met, while still keeping default-on
   activation disabled until separate live approval.

## Safety boundary

This packet does not:

- send via OpenClaw, Hermes, Gongyung, Telegram, or another provider;
- grant real approval;
- post comments, merge PRs, or close issues;
- ACK/replay terminal rows or mutate terminal receipt DB state;
- create TaskFlow records;
- restart/deploy production services;
- mutate/prune/migrate broker DB state;
- replay historical outbox rows;
- publish releases/tags/packages;
- move or expose secrets.

terminalAckEligible=true remains informational. It does not permit ACK.
approvalGrantAccepted=true remains evidence. It does not grant approval.

## CLI

    npm run terminal_brief_finalizer_approval_status -- \
      --input fixtures/terminal-brief/approval-dispatch.no-live.json \
      --receipt-file fixtures/terminal-brief/approval-receipt-ingestor.visible-approval.no-live.json \
      --json

The CLI exits 0 only for ready_for_finalizer_review. Waiting, stale,
conflicting, and blocked states exit 1. Usage/parsing errors exit 2.

## Broker route

    POST /terminal-brief/closeout/finalizer-approval-status

Requester roles: hub or operator.

Action role: terminal_brief.finalizer_approval_status.read.

The route is read-only and returns cache-control: no-store.
