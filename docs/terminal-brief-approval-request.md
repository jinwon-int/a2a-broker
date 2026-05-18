# Terminal Brief Approval Request Planner

Issue: jinwon-int/a2a-broker#702

This planner is the source-only bridge after the Terminal Brief closeout gate. It consumes a closeout gate packet and emits a deterministic approval request draft for the broker finalizer. It does not send that request and it does not grant approval.

## Purpose

The closeout gate decides whether a Terminal Brief round is ready for human approval. The approval request planner converts that gate into a harness-neutral request packet:

- stable idempotency key;
- broker finalizer and target issue/PR context;
- requested actions derived only from gate actions with status=proposed;
- non-requestable blocked/forbidden actions with reasons;
- operator-facing request text;
- disabled presentation/button plan for UI-capable harnesses;
- CLI plan for non-UI harnesses;
- explicit no-live semantics.

OpenClaw message send is not required. Hermes or another external harness can read the JSON packet and decide how to present it in a later executor path.

## CLI

Build first, then run:

    npm run terminal_brief_approval_request -- --input fixtures/terminal-brief/finalizer-workflow.no-live.json --issue-url https://github.com/jinwon-int/a2a-broker/issues/702 --pr-url https://github.com/jinwon-int/a2a-broker/pull/703 --json

Inputs may be:

- a Terminal Brief closeout gate packet;
- an envelope containing gatePacket, closeoutGate, gate, or packet;
- a finalizer workflow packet;
- a finalizer handoff packet.

The workflow and handoff convenience paths are lowered into a closeout gate before the approval request packet is generated.

Exit codes:

- 0: request_ready;
- 1: waiting or blocked;
- 2: usage or parsing error.

## Broker Route

Read-only route:

    POST /terminal-brief/closeout/approval-request

Expected body:

    { "gatePacket": { ...closeout gate packet... } }

Accepted envelopes:

- gatePacket;
- closeoutGate;
- gate;
- packet.

Required requester role: hub or operator.

Response cache header: no-store.

## Safety Contract

The planner always sets:

- dryRunOnly=true;
- requestDispatchPermitted=false;
- approvalGrantPermitted=false;
- executionPermitted=false;
- request.sendPermitted=false;
- presentationPlan.sendPermitted=false;
- presentationPlan.buttonsEnabled=false;
- integrationContract.openclawMessageSendRequired=false;
- integrationContract.hermesAdapterCompatible=true;
- integrationContract.sendsApprovalRequest=false.

It never performs:

- GitHub comment post, issue close, or PR merge;
- live provider, Telegram, Hermes, or OpenClaw send;
- terminal ACK or replay;
- Gateway, broker, worker, or sidecar restart/deploy;
- broker DB mutation, prune, or migration;
- TaskFlow record creation;
- historical replay;
- release, tag, or npm publish;
- secret or credential movement.

## Intended Follow-up

A later executor may consume the approval request packet, present it through a selected harness, receive explicit operator approval, and execute exactly one approved action. That later executor must keep approval, dispatch, idempotency, replay, and action execution as separate states.
