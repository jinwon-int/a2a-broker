# Wake-on-Task live canary rollout and rollback runbook

This runbook is the operator-facing Round 10 delta for closing the final
Wake-on-Task live proof tracked in `openclaw-plugin-a2a#40` and indexed from
`a2a-broker#39`.

Baseline candidate SHAs from the Round 9 closeout:

| Repo | Candidate SHA |
|---|---|
| `jinon86/a2a-broker` | `d6661c71b195` |
| `jinon86/openclaw-plugin-a2a` | `abdb831ab918` |
| `jinon86/openclaw` | `f13097255ba3` |

## 1. Proof standard for #40 closure

`openclaw-plugin-a2a#40` can close only when the live canary evidence shows all
of the following on healthy VPS-class nodes:

1. **Live two-node Wake-on-Task path** — an accepted task from the driver node
   wakes the target OpenClaw/plugin runtime without waiting for the normal
   proactive heartbeat cycle.
2. **Sub-minute latency** — record timestamps from accepted/create to target
   wake/run start. The observed wake must be under 60 seconds.
3. **Duplicate wake prevention** — replaying or duplicating the same wake key
   must not spawn a duplicate target run. Broker/plugin evidence should show the
   duplicate as skipped, coalesced, or otherwise suppressed.
4. **Fallback behavior** — if wake dispatch fails, the normal fallback path must
   remain available and visible to operators instead of leaving a silent stuck
   wait.
5. **Clean terminal state** — the broker task, plugin audit, and peer status
   should converge: no unexpected queued/active/stale task remains after the
   proof run.

A single receiver smoke, worker completion, or peer-status query is useful
supporting evidence, but it is not enough by itself to close #40 unless it also
proves the live OpenClaw session wake/resume path above.

## 2. Resource-only warnings vs candidate failures

Round 9 produced a false NO-GO on `yukson` because VPS2 memory pressure blocked
local proof execution while the same candidate passed on a healthier seoseo
rerun. Round 10 operators should classify outcomes this way:

### Resource-only warning

Treat as a resource warning, not candidate failure, when:

- the same candidate SHA passes on a healthy VPS-class node pair;
- the failing node shows independent resource pressure such as memory pressure,
  swap thrash, OOM kills, disk exhaustion, or CPU steal;
- broker/plugin protocol evidence remains coherent: no malformed task state, no
  duplicate wake, no auth/schema mismatch, and no unexplained broker exception;
- peer status reports the target as unreachable/degraded because the node is
  resource constrained, not because the candidate cannot route or wake.

Resource warnings should be posted as `Blocked:` or `Done with resource warning`
with host evidence and an alternate healthy-node proof link.

### Candidate NO-GO

Treat as candidate failure when any of these occur on a healthy baseline node:

- accepted task does not schedule or attempt wake within the expected path;
- accepted-to-wake latency is >= 60 seconds without a resource-pressure cause;
- duplicate wake creates duplicate target runs;
- wake failure leaves an orphaned wait, stale session lock, or invisible stuck
  task without fallback or operator-facing error;
- broker/plugin disagree on task terminal state, wake decision, or peer status;
- rollback/reset cannot return the system to a clean disabled or fallback state.

## 3. Rollout checklist

Use one non-critical pair first. Round 10's expected live pair is the command
center driver plus the target/audit node named in the current board.

1. **Pin candidate SHAs**
   - Confirm broker, plugin, and OpenClaw candidate SHAs match the Round 10 board
     or record the exact replacement SHAs before running.
   - Do not mix unreported local patches into the live proof.
2. **Preflight health**
   - Broker `GET /health` is ok and reports the expected state version.
   - Target worker is registered and heartbeating.
   - `a2a.peer.status` for the target reports `health=ok`, reachable gateway,
     no unexpected queued/active/stale tasks, and acceptable resource headroom.
   - Node-level memory/disk/CPU pressure is checked before blaming the candidate.
3. **Enable opt-in wake canary**
   - Keep Wake-on-Task default-off globally.
   - Enable only the canary path for the target pair, e.g. the plugin config
     equivalent of `wakeOnTask.enabled=true` for the A2A broker adapter.
   - Record the config key, node, and timestamp in the proof comment.
4. **Run S1 cold wake proof**
   - Create/accept one task targeted at the receiver node.
   - Record task id, wake key, accepted/created timestamp, wake/run-start
     timestamp, completed timestamp, and final broker task status.
   - Gate: accepted-to-wake/run-start < 60 seconds.
5. **Run duplicate guard proof**
   - Repeat with the same idempotency/wake key or the command-center-approved
     duplicate scenario.
   - Evidence must show at most one target run and a skipped/coalesced duplicate
     wake decision.
6. **Run fallback proof**
   - Exercise the approved failure/fallback scenario without destabilizing the
     target node.
   - Evidence must show operator-visible wake failure or skip plus normal fallback
     availability.
7. **Post evidence**
   - Post the proof to `openclaw-plugin-a2a#40` and link from `a2a-broker#39`.
   - Include candidate SHAs, task ids, timestamps, latency, peer status summary,
     duplicate result, fallback result, and any resource warnings.

## 4. Rollback and reset checklist

Use rollback when the live proof is a candidate NO-GO, when resource pressure
makes evidence unreliable, or when the canary leaves stuck state.

1. **Disable the opt-in canary first**
   - Set the plugin wake canary config back to the disabled/default state
     (`wakeOnTask.enabled=false` or the node's equivalent).
   - Restart/reload only the affected plugin/gateway runtime if that is how the
     node applies plugin config.
   - Confirm no new wake audit entries are scheduled after disable.
2. **Settle or stop in-flight broker tasks**
   - For tasks that should finish normally, let the worker complete and verify
     terminal status.
   - For known-bad proof tasks, cancel the specific task id instead of broad
     deleting state.
   - For tasks stuck on an offline worker, run the broker's stale-task recovery
     path (`POST /tasks/requeue_stale`) or reassign by operator/hub if the task
     should be retried on another worker.
3. **Clear stuck waits/session runs cautiously**
   - Identify the exact session/run/wait id from the wake audit and task metadata.
   - Prefer the runtime's normal cancel/stop API over deleting files or process
     state by hand.
   - If a node-specific stale session lock must be cleared, record the lock id and
     owning process first, stop the owning runtime, clear only that stale lock,
     then restart and verify peer status. Do not remove unknown lock files in bulk.
4. **Recover from node resource pressure**
   - Capture host evidence first: memory, swap, disk, load, and OOM/service logs.
   - Stop only non-essential proof/canary processes or move the proof to a healthy
     VPS-class node pair.
   - Mark the original node as `resource warning` unless the same candidate fails
     on a healthy rerun.
5. **Verify clean fallback state**
   - Peer status for the target returns reachable/healthy or a clearly explained
     resource warning.
   - Broker has no unexpected queued/active/stale proof tasks.
   - Duplicate wake keys from the failed proof no longer trigger new runs.
   - Normal proactive heartbeat/fallback behavior remains available.
6. **Report rollback result**
   - Post `Blocked:` or `Done:` with the exact failed hop, reset actions, final
     peer status, and whether this is candidate NO-GO or resource-only warning.

## 5. Evidence comment template

```markdown
Done: Round 10 live Wake-on-Task canary evidence

Candidate SHAs:
- broker: <sha>
- plugin: <sha>
- openclaw: <sha>

S1 cold wake:
- task: <task-id>
- target: <node>
- accepted/created: <timestamp>
- wake/run start: <timestamp>
- completed: <timestamp>
- latency: <ms> (< 60s)
- final status: <status>

Duplicate guard:
- wake key: <key>
- first decision: <scheduled/coalesced/etc>
- duplicate decision: <skipped/coalesced/etc>
- target runs created: <count>

Fallback:
- scenario: <description>
- operator-visible result: <result>
- fallback available: <yes/no>

Resource classification:
- healthy node proof: <yes/no/link>
- resource warning only: <yes/no + evidence>
- candidate NO-GO: <yes/no + exact hop>

Links:
- #40 proof comment: <url>
- #39 board/closeout comment: <url>
```
