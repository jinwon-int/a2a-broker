# Generic Decision Dialectic

decision.dialectic is the domain-independent successor lane for the older trading.dialectic A2AD shape. It keeps the same explicit phase order and read-model ergonomics while removing trading-only fields such as symbol, venue, side, market type, fixed bangtong/dengae/seoseo routing, and trading-only verdicts.

## Contract

A v1 task payload is wrapped in a broker task with contract.kind set to decision.dialectic, contract.version set to 1, a phase value, and the embedded task body.

The phase rail remains:

    thesis -> antithesis -> rebuttal -> synthesis -> outcome

The generic meta/context fields are:

- meta.topic, meta.domain, meta.urgency, meta.contextRefs, meta.snapshotAt, meta.expiresAt
- context.brief, context.objective, context.constraints, context.decisionCriteria, context.evidenceRefs, context.availableTools, context.hardVetoPolicy, context.domainContext

domainContext is intentionally open so a security, architecture, operations, or trading task can carry its own typed payload without forcing the broker core to know that domain.

## Worker Roles

Roles are assigned per task:

- roles.thesisAgent
- roles.antithesisAgent
- roles.rebuttalAgent, optional and operationally defaultable to the thesis lane
- roles.synthAgent

This lets any Team1 or Team2 worker take a dialectic role, including libero workers, without changing the task kind.

## Verdicts

The generic verdict enum is:

- PROCEED
- PROCEED_WITH_GUARDRAILS
- WAIT
- ABSTAIN
- VETO

PROCEED_WITH_GUARDRAILS is the non-trading equivalent of a bounded probe. It should be used for constrained pilots, no-live validations, staged rollouts, or decisions that are valid only under explicit guardrails.

## Hard Veto Policy

Unlike trading.dialectic, veto flags are domain-defined records:

    { "code": "drops_operator_visibility", "reason": "Heartbeat evidence would disappear", "severity": "blocker" }

The broker contract preserves the hard veto mechanism without baking trading-specific codes into the core.

## Read Model

Operators can inspect a generic decision dialectic task with:

    GET /tasks/:id/decision-dialectic

The response mirrors the trading dialectic projection: contract metadata, dynamic roles, stage rail, decision card, and compact summaries.

## Execution Round

The broker can now drive a decision.dialectic round with two explicit source-only endpoints:

    POST /tasks/:id/decision-dialectic/advance
    POST /tasks/:id/decision-dialectic/patch

advance is hub/operator-only. It reads the parent task contract, determines the next missing phase, and creates a child broker task assigned to that phase's configured worker. The child task keeps parentTaskId/referenceTaskIds links, inherits broker/team ownership, and carries the phase promptSpec plus expectedRevision in payload.execution.

patch is worker-authored by default, with hub/operator override for broker-finalizer repair. It appends exactly one phase payload at the expected revision, rejects out-of-order or duplicate phases, and keeps the parent task payload as the source of truth. Rebuttal defaults to roles.rebuttalAgent when present, otherwise roles.thesisAgent.

The fail-closed rules are:

- thesis must precede antithesis
- antithesis must precede rebuttal
- thesis, antithesis, and rebuttal must precede synthesis/decision
- synthesis.verdict must match decision.action
- decisionBasisRevision must match the current revision
- blocker veto flags require decision.action=VETO and hardVeto=true
- already routed/abstained/vetoed/settled rounds reject further phase mutation except outcome

These endpoints do not perform provider sends, terminal ACK/replay, deploys, DB cleanup, or live canaries. Those remain separate approval-gated operations.

## Compatibility

trading.dialectic remains unchanged in v1. Existing trading payloads and GET /tasks/:id/trading-dialectic callers are intentionally not migrated by this first slice.
