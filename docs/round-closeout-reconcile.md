# Round Closeout Reconciliation Helper

`src/github/round-closeout-reconcile.ts` provides a pure helper for checking an A2A hardening round before dispatching the next one. It accepts a round label, task id prefix or issue set, expected worker roster, excluded workers, and compact worker observations.

Example operator shape:

```ts
const report = reconcileRoundCloseout(observations, {
  roundLabel: "a2a-hardening-r1",
  taskIdPrefix: "r1-",
  issueNumbers: [241, 243],
  expectedWorkers: ["bangtong", "dungae", "sogyo", "nosuk", "yukson"],
  excludedWorkers: ["yukson"],
  staleAfterMs: 30 * 60 * 1000,
});
```

The report is intentionally compact and safe for operator surfaces. It does not include raw logs or stdout/stderr dumps. For each required worker it classifies:

- `completed` — succeeded with PR, Done, Block, or branch evidence.
- `blocked` — failed/canceled with operator evidence.
- `missing-evidence` — terminal but no PR/Done/Block/branch evidence.
- `stuck` — queued/claimed/running beyond the stale threshold.
- `waiting` — fresh active work or no scoped observation yet.
- `excluded` — present only for workers excluded from dispatch/closeout, such as `yukson` in Round 1.

Round state precedence is `needs-evidence` before `stuck`, then `blocked`, `waiting`, and finally `ready`. That keeps the operator from re-running or reassigning work when evidence recovery is the safer next action.

Typical Round 2/3 pre-dispatch check:

1. Build observations from the broker task summary or operator task report.
2. Scope them with the round task prefix or issue numbers.
3. Confirm `report.state === "ready"` before posting round Done evidence or dispatching the next round.
4. If the state is `needs-evidence`, recover/post evidence first; if `stuck`, ask for progress then requeue/reassign; if `blocked`, inspect Block/PR evidence and decide retry/split/defer.
