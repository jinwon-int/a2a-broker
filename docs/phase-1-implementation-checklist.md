# Phase 1 implementation checklist

This checklist is for the first useful implementation slice of the trading-partner broker design.

Scope:

- keep the current broker scaffold alive
- add the minimum domain model needed for `bangtong` and `dengae`
- avoid full persistence and full automation in phase 1
- prefer auditable proposals over remote mutation

## Exit criteria

Phase 1 is done when all of the following are true:

- `dengae` can submit a patch or parameter proposal for `bangtong`
- a proposal can carry artifact metadata
- `bangtong` can validate and approve or reject a proposal
- `bangtong` applies the approved change locally instead of receiving direct remote writes
- the broker records proposal, validation, approval, and apply events
- dashboard or API clients can inspect the full lifecycle

## Workstream A: core types

### A1. expand `src/core/types.ts`

Add:

- `A2AExchangeIntent`
- `WorkspaceRef`
- `A2ATaskRequest`
- `ChangeProposal`
- `ValidationResult`
- `ArtifactRecord`
- `AuditEvent`
- `WorkerCapabilities`

Definition of done:

- no placeholder `any`
- explicit status enums for proposal and validation lifecycle
- request and response types are rich enough for HTTP routes and future adapters

## Workstream B: broker lifecycle

### B1. evolve `src/core/broker.ts`

Add in-memory methods for:

- create proposal
- get proposal
- list proposals
- attach artifact metadata
- submit validation result
- approve proposal
- reject proposal
- mark proposal applied
- append audit event

Definition of done:

- state transitions are explicit
- invalid transitions fail fast
- timestamps update consistently

### B2. keep exchange support intact

Do not break:

- existing exchange creation
- exchange list and get endpoints
- health endpoint

Definition of done:

- existing scaffold still works
- proposal lifecycle can coexist with exchange lifecycle

## Workstream C: API surface

### C1. extend `src/server.ts`

Add endpoints for:

- `POST /proposals`
- `GET /proposals`
- `GET /proposals/:id`
- `POST /proposals/:id/artifacts`
- `POST /proposals/:id/validate`
- `POST /proposals/:id/approve`
- `POST /proposals/:id/reject`
- `POST /proposals/:id/apply`
- `GET /audit`

Definition of done:

- bad requests return 400 with a useful error
- unknown resources return 404
- proposal lifecycle can be driven entirely through HTTP

### C2. add summary-first responses

For list endpoints, include:

- id
- source node
- target node
- proposal kind
- current status
- updated time
- summary

Definition of done:

- dashboard can render queue and history views without deep object fetching for every row

## Workstream D: policy and safety

### D1. add a simple policy module

Create `src/core/policy.ts` with minimum rules:

- research nodes may propose to live nodes
- research nodes may not directly apply to live workspaces
- live apply requires target-node action
- live promotion is disabled or approval-gated in phase 1

Definition of done:

- endpoints call policy checks before mutating proposal state
- policy failures are explicit and testable

### D2. add workspace ownership checks

Definition of done:

- apply requests include target node id and workspace ref
- broker rejects attempts to apply changes to a workspace not owned by the caller role or node

## Workstream E: artifact metadata

### E1. add lightweight artifact records

Phase 1 does not need full binary storage. Start with metadata:

- artifact id
- proposal id
- kind
- path or URI
- size if known
- content type if known
- summary
- created time

Definition of done:

- patch files, JSON reports, and benchmark summaries can be linked to proposals
- artifact records can be listed per proposal

## Workstream F: audit trail

### F1. add append-only audit events

Events to record:

- proposal created
- artifact attached
- validation submitted
- proposal approved
- proposal rejected
- proposal applied

Definition of done:

- audit events are queryable
- each event includes actor, action, target id, timestamp, and optional note

## Workstream G: tests

### G1. add unit tests for lifecycle transitions

Cover at minimum:

- proposal creation
- invalid proposal transition rejection
- validation submission
- approval flow
- apply flow
- policy rejection for invalid apply attempts

### G2. add server tests

Cover at minimum:

- create proposal
- approve proposal
- reject proposal
- attach artifact
- validation submission
- apply endpoint behavior

Definition of done:

- phase 1 routes and lifecycle have direct automated coverage

## Workstream H: worker contract prep

### H1. define worker-facing request shapes

Even if worker runtime is not fully built yet, define the envelope for:

- `propose_patch`
- `propose_params`
- `validate_proposal`
- `apply_proposal_locally`
- `register_worker`
- `worker_heartbeat`

Definition of done:

- worker registration and capability lookup are available through broker HTTP routes
- future worker implementation does not need a second protocol redesign

## Suggested delivery order

1. types
2. broker lifecycle methods
3. proposal endpoints
4. audit events
5. artifact metadata
6. policy checks
7. tests
8. worker contract prep cleanup

## Should wait until phase 2

Do not overbuild these yet unless they unblock phase 1:

- durable DB persistence
- binary artifact blob store
- automatic live promotion
- merge conflict automation
- Git branch orchestration
- dashboard polish
- multi-step retry orchestration

## Risk notes

### highest risk

- letting apply happen from the wrong actor
- letting proposal and apply statuses drift out of sync
- storing raw giant artifacts directly inside proposal objects

### medium risk

- mixing exchange and proposal routes without clear boundaries
- inventing too many task types before worker runtime exists

### low risk

- keeping in-memory persistence during phase 1 as long as interfaces stay clean

## Recommended milestone split

### milestone 1

- types
- create/get/list proposal
- approve/reject proposal
- audit events

### milestone 2

- artifact metadata
- validation results
- apply lifecycle
- policy checks

### milestone 3

- worker contract prep
- dashboard-facing list summaries
- cleanup and test hardening
