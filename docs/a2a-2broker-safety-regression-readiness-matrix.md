# A2A 2-broker safety regression/readiness matrix

Parent: [#409](https://github.com/jinwon-int/a2a-broker/issues/409)  
Issue: [#414](https://github.com/jinwon-int/a2a-broker/issues/414)  
Run: `a2a-2broker-safety-20260507T021114Z`  
Worker: `yukson` validation/matrix lane

This matrix is the no-live regression and cutover-readiness gate for the broker identity, worker home-broker lease, broker-of-record/teamId lifecycle, and duplicate worker preflight work split across #410-#415.

## Safety boundary

This lane is read-only or synthetic-fixture only. It must not perform or count any of the following without explicit operator approval:

- production deploy
- Gateway restart
- live provider send
- production DB mutation
- edge secret rotation
- public routing change
- terminal-outbox ACK

Evidence must stay bounded: no secrets, raw session dumps, OpenClaw bootstrap/context files, private host paths, raw task payloads, or notification targets.

## Linked evidence inputs

| Lane | Owner issue | Required evidence before merge/cutover | Current validation impact |
| --- | --- | --- | --- |
| Broker identity/API exposure | #410 | PR/Done evidence with brokerId config/defaults, `/health`, worker register/heartbeat read-model exposure, and type/schema tests. | Blocks cutover until available and merged. |
| Worker home-broker lease | #411 | PR/Done evidence for `A2A_HOME_BROKER_ID` validation, local workerId -> brokerId lease, mismatch fail-close, and explicit retarget path. | Blocks cutover until available and merged. |
| Broker-of-record/teamId lifecycle | #412 | PR/Done evidence for task metadata defaults, legacy task compatibility, and claim/start/heartbeat/complete/fail mismatch guards. | Blocks cutover until available and merged. |
| Duplicate worker preflight | #413 | PR/Done evidence for two-broker worker-list comparison, duplicate online workerId failure, stale/unreachable/brokerId ambiguity handling, and redacted output. | Blocks cutover until available and merged. |
| Gwakga/Team2 onboarding runbook | #415 | PR/Done evidence for seoseo/gwakga conventions, stop/retarget/restart procedure, duplicate preflight requirement, rollback, and approval boundaries. | Blocks cutover until available and merged. |
| Regression/readiness lane | #414 | This matrix plus local no-live validation output and exact remaining blockers. | Safe to merge as readiness documentation/tests; not a live go signal by itself. |

## Regression matrix

| ID | Area | Owner | Scenario | Required proof | Expected result | Blocker condition |
| --- | --- | --- | --- | --- | --- | --- |
| R1 | Broker identity | #410 | Broker identity is configured with a safe single-broker default and explicit seoseo/gwakga values. | Type/config tests plus `/health` and worker register/heartbeat response assertions for brokerId exposure. | Clients can read brokerId without secrets; legacy deployments keep a deterministic default. | brokerId is absent, secret-derived, unstable across restart, or not exposed to worker startup. |
| R2 | Worker home-broker guard | #411 | Worker validates `A2A_HOME_BROKER_ID` against the broker response before polling. | Worker tests for matching broker, mismatched broker, absent expected id compatibility, and startup fail-close. | A worker refuses to process tasks when configured home broker and actual broker differ. | Mismatch only logs a warning, or polling can start before identity validation succeeds. |
| R3 | Worker local lease | #411 | Local workerId -> brokerId lease prevents silent retargeting. | Fixture-backed tests for first start, same-broker restart, silent broker change, explicit retarget override, and corrupt lease handling. | Silent retargeting fails closed; intentional retargeting is explicit, auditable, and documented. | Lease storage prints secrets, silently rewrites brokerId, or lacks an explicit retarget path. |
| R4 | Broker-of-record/task defaults | #412 | New tasks carry brokerOfRecord/teamId defaults while old tasks remain readable. | Core task creation/type tests for default metadata plus legacy fixture tests with missing fields. | New task ownership is explicit; pre-existing task snapshots remain backward compatible. | Old tasks fail to load, or new tasks can be created without a broker/team owner once the feature is enabled. |
| R5 | Broker-of-record lifecycle guard | #412 | Task claim/start/heartbeat/complete/fail enforce broker/team ownership. | Lifecycle tests for matching broker/team success, mismatched broker/team `policy_denied` or `bad_request`, and cancel/handoff compatibility. | A worker can mutate only tasks owned by its broker/team; mismatches fail closed without terminal side effects. | Any mismatch can claim or complete a task, or a failure path emits terminal evidence/ACK-like side effects. |
| R6 | Duplicate preflight clean/fail cases | #413 | Two broker worker snapshots contain no online duplicate workerIds. | Preflight fixture tests for clean seoseo/gwakga lists and duplicate-online workerId failure. | Clean lists pass; duplicate online workerIds produce non-zero/failed preflight output. | Duplicate online workerIds are reported as pass or require a production mutation to detect. |
| R7 | Duplicate preflight ambiguity | #413 | Preflight handles stale, unreachable, and brokerId-mismatch ambiguity safely. | Fixtures for stale/unknown worker status, unreachable broker, brokerId mismatch, compact redacted JSON/markdown output. | Ambiguous or unreachable data blocks cutover instead of guessing; secrets and raw targets are redacted. | Unreachable broker, stale ambiguity, or brokerId mismatch is downgraded to success. |
| R8 | Backward compatibility | #414 | Existing single-broker tasks/workers continue to pass the current regression suite. | Focused build/tests for broker, worker, server, and any new matrix/preflight fixtures after #410-#413 land. | Legacy brokerUrl-only workers and task snapshots remain accepted unless explicit two-broker guards are configured. | A default single-broker checkout requires new production config or breaks existing task/worker tests. |
| R9 | Cutover/retarget runbook | #415 | Gwakga/Team2 onboarding uses stop / verify lease / retarget / restart / preflight / rollback semantics. | Runbook evidence with brokerId/teamId conventions, approval boundaries, rollback steps, and required duplicate preflight output. | Operators have a no-live checklist that makes silent dual registration unlikely before any cutover. | Runbook implies live restart, route change, or secret rotation without explicit operator approval. |
| R10 | Evidence hygiene | #414 | Safety evidence remains bounded and secret-safe. | PR/Done/Block evidence lists commands, pass/fail result, and gaps without raw session dumps, secrets, private paths, or live payloads. | Evidence is enough to decide merge/cutover readiness without leaking sensitive runtime context. | Evidence includes secrets, OpenClaw bootstrap files, raw session dumps, or host-specific private paths. |

## No-live validation checklist

Run from a clean broker checkout after #410-#415 candidate branches are merged or checked out together:

```sh
npm run build
node --test dist/core/two-broker-safety-matrix.test.js
node --test dist/core/broker.test.js dist/worker.test.js dist/server.test.js
npm test
```

If #413 adds a dedicated preflight script, also run its clean, duplicate, stale, unreachable, and brokerId-mismatch fixture tests. If #411 adds a lease file path, run tests against a temporary directory only; do not point tests at production worker state.

Expected no-live safety signals:

- no provider call or live notification send
- no broker HTTP write to production endpoints
- no SQLite/production DB mutation
- no worker service restart or public routing change
- no terminal-outbox ACK attempt
- redacted output for URLs, secrets, headers, lease paths, and raw worker payloads

## Cutover decision rule

Default decision is **NO-GO** until every linked lane has PR/Done evidence, the focused tests above pass in an integrated checkout, and duplicate preflight reports no online duplicate workerIds across seoseo/gwakga.

Cutover remains **NO-GO** if any linked lane is missing, blocked, open/unmerged, or reports warning-only behavior for broker mismatch, lease mismatch, broker/team lifecycle mismatch, stale/unreachable duplicate preflight ambiguity, or evidence hygiene.

A **GO for cutover rehearsal** can be considered only after all required areas pass with bounded no-live evidence. A production cutover still needs separate explicit operator approval for deploy/restart/routing/secret actions.
