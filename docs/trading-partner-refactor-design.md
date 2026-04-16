# Trading partner refactor design

## Why this design exists

The broker is no longer just a neutral message relay.

The target operating model is a coordinated trading system where:

- `bangtong` owns live trading execution and final promotion decisions
- `dengae` owns backfill, analysis, research, and strategy improvement proposals
- both nodes communicate continuously through the broker
- each node must retain freedom to modify its own local workspace
- cross-node direct filesystem writes are intentionally avoided

This means the current minimal broker must evolve from a simple exchange service into a coordination layer for stateful, workspace-owning trading partners.

## Operating assumptions

1. Each node has its own local trading workspace.
2. Each worker may read and write its own workspace locally.
3. Workers run in containers, but with narrowly scoped `rw` mounts for their own workspace.
4. The broker coordinates tasks, proposals, validation, and promotion, but does not directly edit remote files.
5. Change transfer between nodes happens through proposals, patches, parameter payloads, artifacts, and approval events.
6. `bangtong` is the last gate before live rollout.

## Design goals

- preserve local autonomy for each trading partner
- prevent DB, log, cache, and workspace contamination across nodes
- support iterative strategy development between live and research roles
- make every meaningful change auditable
- keep the broker transport-neutral so OpenClaw remains an adapter, not the core
- enable gradual rollout from the current scaffold without a rewrite

## Non-goals

- shared cross-node writable filesystem
- blind direct remote file mutation
- full GitOps automation in phase 1
- automatic live promotion without validation and policy gates

## Target architecture

```text
+-------------------+         +-------------------+
| bangtong worker   |         | dengae worker     |
| live trading      |         | backfill/research |
| local rw mount    |         | local rw mount    |
+---------+---------+         +---------+---------+
          \                           /
           \                         /
            \                       /
             +---------------------+
             |     A2A broker      |
             | coordination only   |
             | tasks + proposals   |
             | artifacts + audit   |
             +---------------------+
```

### Node responsibilities

#### bangtong

- runs live trading logic
- validates incoming proposals before live adoption
- applies approved changes to its own local workspace
- can emit live feedback, incident notes, and performance snapshots

#### dengae

- runs backfills, simulations, analysis, and exploratory modifications
- edits its own local workspace freely
- submits patches, parameter proposals, and benchmark artifacts
- never directly writes into `bangtong` filesystems

#### broker

- tracks exchanges, tasks, proposals, approvals, validation, and promotion state
- stores metadata and artifacts
- enforces role-aware policy
- provides audit trail and dashboard-facing state
- does not become the runtime owner of per-node codebases

## Isolation model

Containerization is recommended for both workers, but isolation must be explicit.

### Required separation per worker

- separate container
- separate environment file or injected config
- separate logs
- separate temp/cache paths
- separate data volume if local state is needed
- separate workspace mount
- separate node identity and namespace

### Example mount model

#### bangtong

- `/workspace/live` -> host live strategy directory, `rw`
- `/config` -> worker config, usually `ro` or tightly controlled `rw`
- `/artifacts` -> benchmark and report outputs

#### dengae

- `/workspace/research` -> host research directory, `rw`
- `/datasets` -> backfill inputs, usually `ro`
- `/artifacts` -> experiment and benchmark outputs

### Explicit anti-patterns

- shared writable workspace between nodes
- mounting `/` or `/home` into workers
- direct cross-node filesystem write APIs
- one shared SQLite or ad hoc local DB for all workers
- mixed log files without node tags or separate streams

## Core domain model changes

The current exchange model is too small for the desired workflow.

### Existing model

- requester
- target
- message
- maxTurns
- status

### Required additions

#### parties and roles

```ts
interface A2APartyRef {
  id: string;
  kind?: "session" | "node" | "user" | "service";
  role?: "hub" | "live-trader" | "researcher" | "analyst";
}
```

#### exchange intent

```ts
type A2AExchangeIntent =
  | "chat"
  | "analyze"
  | "backfill"
  | "propose_patch"
  | "propose_params"
  | "validate_change"
  | "apply_local_change"
  | "promote_to_live"
  | "rollback_live";
```

#### workspace context

```ts
interface WorkspaceRef {
  nodeId: string;
  workspaceId: string;
  pathHint?: string;
  branch?: string;
  strategyId?: string;
}
```

#### change proposal

```ts
interface ChangeProposal {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  kind: "patch" | "params" | "hybrid";
  summary: string;
  rationale?: string;
  workspace: WorkspaceRef;
  patchText?: string;
  parameterPayload?: Record<string, unknown>;
  artifactIds: string[];
  status:
    | "draft"
    | "submitted"
    | "validation_requested"
    | "validated"
    | "rejected"
    | "approved"
    | "applied"
    | "rolled_back";
  createdAt: string;
  updatedAt: string;
}
```

#### validation result

```ts
interface ValidationResult {
  id: string;
  proposalId: string;
  nodeId: string;
  kind: "backfill" | "paper" | "replay" | "smoke";
  verdict: "pass" | "fail" | "warn";
  metrics: Record<string, number | string | boolean>;
  artifactIds: string[];
  createdAt: string;
}
```

## Lifecycle design

The broker should manage a change lifecycle, not just a message loop.

### Proposed lifecycle

```text
analysis/backfill
-> proposal submission
-> validation request
-> validation result
-> approval decision
-> local apply on target node
-> optional live promotion
-> optional rollback
```

### Key rule

`dengae` may originate a proposal for `bangtong`, but only `bangtong` applies the change to the live workspace.

This preserves local autonomy and avoids hidden cross-node mutations.

## Task taxonomy

The current single exchange request should expand into a task-oriented contract.

### Minimum new task types

- `chat`
- `analyze_market_behavior`
- `run_backfill`
- `propose_patch`
- `propose_parameters`
- `validate_proposal`
- `apply_proposal_locally`
- `promote_strategy_to_live`
- `rollback_strategy`
- `collect_runtime_feedback`

### Minimum task envelope

```ts
interface A2ATaskRequest {
  id: string;
  intent: A2AExchangeIntent;
  requester: A2APartyRef;
  target: A2APartyRef;
  workspace?: WorkspaceRef;
  message?: string;
  proposalId?: string;
  artifactIds?: string[];
  policyContext?: {
    requiresApproval?: boolean;
    liveImpact?: boolean;
    targetEnvironment?: "research" | "staging" | "live";
  };
  createdAt: string;
}
```

## Artifact model

Artifacts must become first-class outputs.

### Expected artifact kinds

- patch diff
- parameter set JSON
- backfill result JSON
- equity curve or report bundle
- benchmark comparison
- runtime logs snapshot
- incident note or operator note

### Requirements

- every proposal can reference one or more artifacts
- every validation run produces artifacts
- dashboard views should load summaries without needing raw log scraping
- large binary outputs should be referenced by metadata, not embedded inline in task state

## Policy and safety rules

The broker needs role-aware rules in addition to transport-level auth.

### Core rules

1. A research node may propose changes to a live node.
2. A research node may not directly apply changes to a live node's workspace.
3. Live promotion requires explicit approval or a future policy gate.
4. Rollback requests should be allowed from the live node and from operators.
5. All apply and promote actions must leave an audit record.
6. Local worker write access must be constrained to the worker's own mounted paths.

## Storage refactor

The in-memory exchange map is enough for scaffolding, but not for this workflow.

### Needed persistence categories

- exchange state
- task state
- proposals
- validation runs
- artifact metadata
- approval decisions
- audit events

### Suggested persistence split

- relational store for metadata and lifecycle state
- object store or filesystem-backed artifact store for reports, diffs, and bundles
- container logs routed to standard logging, not mixed into broker metadata tables

## Worker runtime refactor

Workers are no longer pure stateless executors.

### New worker responsibilities

- maintain local workspace access
- run analysis/backfill commands against local files
- generate diffs or parameter proposals from local changes
- apply approved changes to local workspace
- emit structured artifacts and status updates

### Guardrails

- workers may mutate only mounted local paths
- workers should emit structured change outputs instead of freeform success text only
- worker capabilities should be declared at registration time

### Suggested capability model

```ts
interface WorkerCapabilities {
  canAnalyze: boolean;
  canBackfill: boolean;
  canPatchWorkspace: boolean;
  canPromoteLive: boolean;
  workspaceIds: string[];
  environments: Array<"research" | "staging" | "live">;
}
```

## API refactor plan

The current broker API can stay as the bootstrap layer, but it needs more resources.

### Keep

- `GET /health`
- `GET /exchanges`
- `GET /exchanges/:id`
- `POST /exchanges`

### Add next

- `POST /tasks`
- `GET /tasks/:id`
- `POST /proposals`
- `GET /proposals/:id`
- `POST /proposals/:id/validate`
- `POST /proposals/:id/approve`
- `POST /proposals/:id/reject`
- `POST /proposals/:id/apply`
- `POST /proposals/:id/promote`
- `POST /proposals/:id/rollback`
- `POST /artifacts`
- `GET /artifacts/:id`

## Module-by-module refactor impact

### `src/core/types.ts`

High change.

- expand exchange model into task, proposal, validation, artifact, and audit types
- add roles, environments, and policy context
- add workspace-aware references

### `src/core/broker.ts`

High change.

- evolve from a simple exchange map into a lifecycle coordinator
- add proposal creation and state transitions
- add validation and approval flow
- separate metadata storage interfaces from in-memory fallback implementation

### `src/server.ts`

Medium to high change.

- keep current endpoints for bootstrap compatibility
- add task, proposal, and artifact routes
- validate richer request bodies
- expose dashboard-oriented summaries

### New modules recommended

- `src/core/policy.ts`
- `src/core/store.ts`
- `src/core/proposals.ts`
- `src/core/artifacts.ts`
- `src/core/audit.ts`
- `src/workers/registry.ts`
- `src/workers/runtime.ts`
- `src/adapters/openclaw.ts`

## Dashboard implications

The dashboard should stop thinking only in terms of exchanges.

### New views

- partner overview by node and role
- proposal queue
- validation results
- promotion history
- rollback history
- artifact links by proposal
- live versus research drift summary

## Deployment model

### Recommended shape

#### `seoseo`

- broker service
- dashboard service
- metadata DB
- artifact storage

#### `bangtong`

- live worker container
- local mounted live workspace
- local logs and artifacts

#### `dengae`

- research worker container
- local mounted research workspace
- local datasets and artifacts

## Phase plan

### Phase 1: align the model

- expand types beyond bare exchanges
- add proposal and artifact primitives
- keep in-memory store temporarily
- keep current HTTP service simple

### Phase 2: worker-aware coordination

- register workers with roles and capabilities
- add workspace and environment context
- support proposal submission and validation tasks

### Phase 3: durable state

- move lifecycle metadata to persistent storage
- add artifact storage abstraction
- expose dashboard-friendly query endpoints

### Phase 4: live safety gates

- approval rules for live promotion
- rollback flow
- policy enforcement by node role and environment

### Phase 5: OpenClaw adapter hardening

- map broker tasks onto OpenClaw sessions and node messaging
- keep OpenClaw-specific logic out of core lifecycle types

## Recommended first implementation slice

The smallest useful slice that still matches the target design is:

1. add proposal types
2. add artifact metadata types
3. add `propose_patch` and `propose_params` flows
4. add `validate_proposal` flow
5. require target-node apply instead of remote write
6. record an audit trail for proposal, validation, approval, and apply

This gives the system the right shape without forcing full automation immediately.

## Decision summary

The refactor should treat workers as stateful local partners, not disposable stateless executors.

That means:

- keep per-node local workspace freedom
- isolate runtime state by container and volume
- exchange changes through proposals and artifacts
- let `bangtong` remain the final live gate
- let `dengae` remain the aggressive research and analysis node
- let the broker orchestrate, record, and enforce policy

This is the cleanest way to support collaborative strategy evolution without sacrificing operational safety.
