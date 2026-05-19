# Terminal Brief sidecar execution gate final review

terminal-brief-sidecar-execution-gate-final-review is a source-only/no-live
packet that consumes accepted approval grant evidence and renders the final
execution-gate checklist plus abort and rollback conditions.

It does not dispatch or invoke an executor, spawn a process, start or stop the
sidecar, enable default-on behavior, send providers, ACK terminal rows, mutate
state, restart services, publish releases, or move secrets.

## Input

- a2a-broker.terminal-brief-sidecar-approval-grant-evidence-ingestor.packet
- the source packet must be in grant_evidence_accepted
- the source packet must have grantEvidenceAccepted=true

Accepted grant evidence is not runtime authorization. It is only the source
evidence required to render the final review gate.

## Output states

- ready_for_execution_gate_final_review
- waiting_for_grant_evidence
- grant_rejected
- more_evidence_requested
- stale
- conflicting
- blocked

## Safety boundary

The packet always keeps approval request dispatch, approval grant, approval
grant execution, start executor dispatch, executor invocation, process spawn,
sidecar start, default-on, live activation, provider send, terminal ACK,
execution, and DB mutation as false.

## CLI

    npm run terminal_brief_sidecar_execution_gate_final_review -- \
      --input fixtures/terminal-brief/sidecar-execution-gate-final-review.no-live.json \
      --json

The CLI exits 0 for ready_for_execution_gate_final_review, grant_rejected, or
more_evidence_requested. Waiting, stale, conflicting, and blocked states exit 1.
Usage/parsing errors exit 2.

## Broker route

    POST /terminal-brief/sidecar/execution-gate-final-review

Requester roles: hub or operator.

Action role: terminal_brief.sidecar_execution_gate_final_review.read.

The route is read-only and returns cache-control: no-store.
