# Terminal Brief Closeout Gate

Issue #700 adds the source-only closeout gate after the Terminal Brief finalizer workflow packet from #699.

The gate is the last dry-run planning layer before a broker finalizer performs any real closeout action. It is meant for OpenClaw, Hermes/Gongyung, or another external harness to call with plain JSON and receive the same approval-gated plan.

## Usage

    npm run terminal_brief_closeout_gate -- \\
      --input fixtures/terminal-brief/finalizer-workflow.no-live.json \\
      --issue-url https://github.com/owner/repo/issues/700 \\
      --pr-url https://github.com/owner/repo/pull/701 \\
      --markdown

The input can be either:

- a a2a-broker.terminal-brief-finalizer-workflow.packet; or
- the no-live finalizer handoff fixture used by terminal_brief_finalizer_workflow.

## Output

The packet contains:

- decision: ready_for_approval, waiting, or blocked
- gateState: approval_required, waiting_for_evidence, or blocked
- dryRunOnly=true and executePermitted=false
- finalizer identity and single-finalizer requirement
- draft closeout comment metadata
- proposed GitHub closeout actions with requiresApproval=true and executePermitted=false
- forbidden live actions such as provider sends, terminal ACK/replay, restart/deploy, DB mutation, release, and secret movement
- a harness-neutral JSON contract, with no dependency on openclaw message send

## Read-only route contract

Broker deployments can expose the same planner through:

    POST /terminal-brief/closeout/gate

The request body is the workflow packet or an envelope containing workflowPacket, finalizerWorkflow, or packet.

The response is the same closeout gate packet returned by the CLI. The route is read-only and returns cache-control: no-store.

## Safety

This gate does not:

- post GitHub comments
- merge pull requests
- close issues
- send providers, Hermes, Telegram, or OpenClaw messages
- ACK/replay terminal rows
- create TaskFlow records
- mutate broker DB state
- restart or deploy Gateway, broker, worker, or sidecar services
- replay history
- publish releases/tags/packages
- move secrets or credentials

ready_for_approval means the broker finalizer may request a separate explicit approval for the exact mutation. It never means the mutation is already authorized.
