# Operator dashboard snapshot

`GET /dashboard` includes an additive `operatorSnapshot` object for operator UIs and incident handoffs. It is a compact JSON projection over the broker's workers, task status counters, recovery signals, and attention items.

## Shape

```json
{
  "operatorSnapshot": {
    "generatedAt": "2026-04-30T10:00:00.000Z",
    "workers": { "total": 4, "online": 3, "stale": 1, "byNode": [] },
    "taskStatusSummary": {
      "total": 12,
      "active": 5,
      "terminal": 7,
      "byStatus": { "queued": 2, "claimed": 1, "running": 2, "succeeded": 6, "failed": 1 }
    },
    "recoverySummary": {
      "stale": {
        "staleWorkerAssignments": 1,
        "staleWorkersWithActiveTasks": [],
        "oldestClaimed": null,
        "oldestRunning": null
      },
      "retry": {
        "totalRequeued": 2,
        "maxRequeueAttempts": 2,
        "recentRequeues": []
      },
      "deadLetter": {
        "totalDeadLettered": 1,
        "recentDeadLetters": []
      }
    },
    "attentionItems": []
  }
}
```

## Attention items

Each `attentionItems[]` entry is designed to answer the operator's first three questions without opening raw task/session logs:

- `whyStuck`: broker-owned reason the task needs attention (stale worker, stale task heartbeat, long-running task, prior requeue, or dead-letter).
- `whoClaimed`: worker/claimant identity when known.
- `whatNext`: recommended operator action, such as checking the worker, requeueing stale work, reassigning to a healthy worker, or inspecting dead-letter evidence.

Items also include `taskId`, `status`, `intent`, `targetNodeId`, `assignedWorkerId`, `claimedBy`, `requeueCount`, `statusAgeSec`, and relevant terminal error fields.

## Operator interpretation

- **Stale**: `recoverySummary.stale` and `stale_worker`/`stale_task` attention items indicate work that may be stuck because the worker heartbeat or task heartbeat is too old.
- **Retry**: `recoverySummary.retry` shows how much stale work has been recycled and what cap (`maxRequeueAttempts`) applies before dead-lettering.
- **Dead-letter**: `recoverySummary.deadLetter` and `dead_lettered` attention items identify tasks that exhausted retries and require human review before recreating/reassigning work.

The projection intentionally excludes secrets, private filesystem paths, and raw session dumps.
