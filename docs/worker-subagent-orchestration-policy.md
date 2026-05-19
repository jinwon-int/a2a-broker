# A2A worker subagent orchestration policy

This source-only policy describes when an A2A worker should use subagents for parallel exploration, implementation, or verification.

It does not change production worker runtime behavior, force subagent spawning, mutate broker dispatch semantics, create TaskFlow records, mutate DB state, deploy/restart services, or move secrets.

## Policy

Subagent count is adaptive, not fixed.

| Task and host state | Recommended subagents |
|---|---:|
| trivial, urgent, sensitive, or tightly coupled | 0 |
| small task with useful side review | 1 |
| medium task with separable exploration/verification | 2 |
| large independent task with healthy host capacity | 3 |

Workers must reduce or disable subagent spawning when CPU, memory, IO, event-loop, Gateway, worker cap, or broker/fleet cap conditions are constrained.

## Roles

- explorer: bounded code, issue, and log investigation.
- implementer: scoped code changes in an assigned disjoint write set.
- verifier: tests, CI, risk, and evidence review.

## Finalizer Rule

Exactly one worker or broker finalizer owns merge, closeout, approval, and runtime decisions.

Subagents submit evidence packets only.

## Write-Set Rule

Implementation subagents require disjoint file or module ownership. If write sets overlap, use one implementer and a verifier instead of multiple implementers.

## Escape Hatch

Direct execution with zero subagents is always allowed when the task is too small, too risky, too coupled, urgent, sensitive, or the host lacks capacity.

## Read-only Planner Route

`POST /workers/subagent-orchestration/plan` accepts a supplied task profile and host capacity snapshot, then returns the same source-only policy packet.

The route is a planner/classifier only. It does not inspect live host state, spawn subagents, dispatch broker work, claim tasks, invoke executors, create TaskFlow records, mutate DB state, deploy/restart services, send providers, ACK/replay terminal rows, publish releases, or move secrets.

## Worker Self-Assessment Packet

`a2a-broker.worker-self-assessment-capacity.packet` standardizes the supplied worker/host capacity snapshot before a planner route call.

The packet can include task profile, CPU load, memory usage, IO pressure, event-loop degradation, Gateway pressure, active subagent count, worker cap, broker active subagent count, and broker cap. When all required fields are present, `plannerInput` is ready to submit to `POST /workers/subagent-orchestration/plan`.

The self-assessment packet does not probe the live host or Gateway, call the planner route, spawn subagents, dispatch broker work, claim tasks, invoke executors, create TaskFlow records, mutate DB state, deploy/restart services, send providers, ACK/replay terminal rows, publish releases, or move secrets.

Example input:

```json
{
  "task": {
    "taskId": "task-large-independent",
    "size": "large",
    "coupling": "low",
    "hasIndependentSubtasks": true,
    "writeSets": ["src/core/planner.ts", "docs/planner.md", "test/planner.test.ts"]
  },
  "host": {
    "workerId": "bangtong",
    "cpuLoadPct": 42,
    "memoryUsedPct": 55,
    "ioPressure": "low",
    "eventLoopDegraded": false,
    "gatewayPressure": "low",
    "activeSubagents": 0,
    "workerSubagentCap": 3,
    "brokerActiveSubagents": 4,
    "brokerSubagentCap": 12
  }
}
```
