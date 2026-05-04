# No-live lifecycle/recovery proof gate (#311)

Use this gate for the #311 closeout lane under parent #294. It creates a
repeatable broker-safe proof path for task lifecycle projection, stale/retry /
requeue visibility, and receipt-gap observability without production deploys,
Gateway restarts, live Telegram delivery, database mutation, or real
terminal-outbox ACK.

Related trackers:

- Issue: `jinwon-int/a2a-broker#311`
- Parent: `jinwon-int/a2a-broker#294`

## Safety rules

1. **Default to no-live.** Run local/CI-safe tests, read-only preflights, or
   disposable fixtures only.
2. **No real ACK.** Receipt-gap proof must show that an unacknowledged terminal
   outbox record remains observable/replayable. Do not call the live ACK path for
   this lane.
3. **No live delivery.** Do not send Telegram or other provider messages from
   this runbook.
4. **No production mutation.** Do not deploy, restart Gateway, mutate a real DB,
   or fan out beyond the assigned worker/task.
5. **Sanitize evidence.** Post task ids, worker ids, counters, timestamps, and
   command results only. Do not post secrets, chat ids, raw session dumps, or
   host-private paths.

## Proof matrix

Capture one sanitized evidence line for each required cell:

| Cell | Pass proof |
| --- | --- |
| `brokerWorkerResultProjection` | A broker-created task is picked up by a worker path and its terminal/result projection is visible in broker/dashboard/read-model output. |
| `workerHeartbeatObserved` | Worker heartbeat or `lastSeenAt` is visible before or during task handling. |
| `staleTaskDetected` | A claimed/running task with an old heartbeat is reported as stale by diagnostics or stale listing. |
| `manualRequeueObserved` | A safe fixture/manual stale sweep requeues the stale claim and reports the requeue. |
| `retryAttemptVisible` | Attempt/retry visibility changes across requeue, for example attempt `1 -> 2` and `requeueCount 0 -> 1`. |
| `receiptGapObservable` | A terminal outbox item without receipt remains observable/replayable; it is not marked `receipt_confirmed`. |
| `noLiveDeliveryOrAck` | Live sends are `0` and no real terminal-outbox ACK was performed. |

## Suggested local validation

Run the focused local gates first:

```bash
npm run build
node --test dist/server-e2e-regression.test.js dist/worker.test.js
node --test scripts/broker-lifecycle-proof-evidence.test.mjs
```

The existing server/worker tests exercise broker task creation, worker
registration/heartbeat, completion projection, and stale requeue/tombstone
behavior without production deployment or live provider sends.

For read-only terminal-outbox visibility, use the preflight only; it does not
ACK records:

```bash
BROKER_URL="${BROKER_URL:-http://127.0.0.1:8787}" \
  BROKER_EDGE_SECRET="${BROKER_EDGE_SECRET:-}" \
  npm run terminal_outbox_preflight -- --json
```

Treat any need for a production restart, live Telegram send, DB write, or real
terminal ACK as `Block` evidence for this no-live lane.

## Render closeout evidence

Write a sanitized JSON file and render the issue comment:

```bash
node scripts/broker-lifecycle-proof-evidence.mjs --input evidence.json
```

A complete no-live evidence file looks like:

```json
{
  "rolloutMode": "no-live",
  "candidates": { "broker": "<broker-sha>" },
  "ci": { "command": "npm test", "result": "exit 0" },
  "noLiveCanaryProofMatrix": {
    "brokerWorkerResultProjection": { "status": "pass", "evidence": "<worker completed task; result visible>" },
    "workerHeartbeatObserved": { "status": "pass", "evidence": "<heartbeat/lastSeenAt observed>" },
    "staleTaskDetected": { "status": "pass", "evidence": "<stale diagnostic/list proof>" },
    "manualRequeueObserved": { "status": "pass", "evidence": "<requeue_stale safe fixture proof>" },
    "retryAttemptVisible": { "status": "pass", "evidence": "<attempt/requeueCount before -> after>" },
    "receiptGapObservable": { "status": "pass", "evidence": "<unacknowledged outbox replay proof>" },
    "noLiveDeliveryOrAck": { "status": "pass", "evidence": "live sends 0; real ACK false" }
  },
  "lifecycle": {
    "taskId": "<task-id>",
    "workerId": "nosuk",
    "resultProjectionObserved": true
  },
  "recovery": {
    "staleTaskId": "<stale-task-id>",
    "workerId": "nosuk",
    "heartbeatAgeMs": 180000,
    "staleAfterMs": 120000,
    "requeueCountBefore": 0,
    "requeueCountAfter": 1,
    "attemptBefore": 1,
    "attemptAfter": 2
  },
  "receiptGap": {
    "outboxId": "<terminal-outbox-id>",
    "unacknowledgedReplayed": true,
    "realAckPerformed": false,
    "ackStatus": "pending_receipt"
  },
  "safety": {
    "productionDeploy": false,
    "gatewayRestart": false,
    "liveTelegramSend": false,
    "dbMutation": false,
    "realTerminalOutboxAck": false
  }
}
```

The renderer exits non-zero and prints `Block:` if any required proof is
missing, stale timing does not exceed the threshold, requeue/attempt counters do
not advance, an ACK is marked `receipt_confirmed`, or any forbidden live action
is reported.
