# Terminal Brief Approval Executor Shell

Issue: jinwon-int/a2a-broker#704

This is a source-only/no-live shell after the Terminal Brief approval request planner. It validates the state boundary between approval request dispatch, simulated approval, and execution while keeping every real side effect disabled.

## Purpose

The approval request planner produces a deterministic draft request. The executor shell consumes that packet and emits one of these states:

- dispatch_pending: request exists, but no request was dispatched.
- approval_granted_dry_run: a requested action was selected only as simulated approval evidence.
- execute_blocked: an execution attempt was requested, but execution remains blocked.
- blocked: the request is not ready or the selected action is invalid.

This shell is not a live executor. It is the shape that future OpenClaw, Hermes, Gongyung, or other harness adapters can use before a real approval and execution path exists.

## CLI

Build first, then run:

    npm run terminal_brief_approval_executor -- --input fixtures/terminal-brief/finalizer-workflow.no-live.json --issue-url https://github.com/jinwon-int/a2a-broker/issues/704 --pr-url https://github.com/jinwon-int/a2a-broker/pull/705 --selected-action merge_pull_request --attempt-execute --json

Inputs may be:

- a Terminal Brief approval request packet;
- an approval request envelope containing approvalRequest, approvalRequestPacket, requestPacket, or packet;
- a closeout gate packet;
- a finalizer workflow packet;
- a finalizer handoff packet.

Lower-level inputs are converted through the existing closeout gate and approval request chain before the shell packet is generated.

Exit codes:

- 0: dispatch_pending, approval_granted_dry_run, or execute_blocked;
- 1: blocked;
- 2: usage or parsing error.

## Broker Route

Read-only route:

    POST /terminal-brief/closeout/approval-executor

Expected body:

    {
      "approvalRequest": { "...": "approval request packet" },
      "selectedAction": "merge_pull_request",
      "attemptExecute": true
    }

Accepted envelopes:

- approvalRequest;
- approvalRequestPacket;
- requestPacket;
- packet.

Required requester role: hub or operator.

Response cache header: no-store.

## Safety Contract

The shell always sets:

- dryRunOnly=true;
- dispatchPermitted=false;
- approvalGrantPermitted=false;
- executionPermitted=false;
- dispatch.requestDispatched=false;
- approval.realApprovalGranted=false;
- execution.executed=false;
- integrationContract.openclawMessageSendRequired=false;
- integrationContract.sendsApprovalRequest=false;
- integrationContract.grantsApproval=false;
- integrationContract.executesAction=false.

It never performs:

- approval request dispatch through OpenClaw, Hermes, Telegram, or another provider;
- real approval grant;
- GitHub comment post, issue close, or PR merge;
- terminal ACK or replay;
- Gateway, broker, worker, or sidecar restart/deploy;
- broker DB mutation, prune, or migration;
- TaskFlow record creation;
- historical replay;
- release, tag, or npm publish;
- secret or credential movement.

## Intended Follow-up

A later implementation can add a real approval transport and action-specific executor. That future work must keep dispatch, approval grant, and execution as separate idempotent states and must require explicit operator approval before any live action.
