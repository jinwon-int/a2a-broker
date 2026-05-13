# Team2/Gwakga ops dashboard and capacity parity

Run: `a2a-r8-ops-dashboard-20260513T111122Z`

Issue: `a2a-broker#556`  
Parent: `a2a-broker#553`

This is bounded, no-live evidence for the Team2/Gwakga lane. It compares the broker-owned dashboard and capacity read models that Team1/Seoseo and Team2/Gwakga should use before another dispatch round. It does not deploy, restart a broker or worker, mutate production state, send providers/Telegram, ACK terminal outbox rows, rotate secrets, publish releases, or rewrite history.

## Parity finding

No Team1-only or Team2-only code path is required for the R8 dashboard/capacity semantics. Both brokers use the same broker-owned projections:

- `GET /dashboard` for the bounded operator dashboard/read model.
- `GET /workers/capacity` for compact per-worker dispatch capacity.
- `npm run two_broker_worker_preflight` for duplicate online worker-id detection before retargeting.
- `npm run broker_terminal_receipt_parity` when receipt/outbox shape parity is part of the gate.

The semantics are broker-local and safe to compare across Seoseo and Gwakga by running the same read-only commands against each broker URL.

## Dashboard semantics to compare

| Surface | Field(s) | Operator meaning | GO expectation |
| --- | --- | --- | --- |
| Worker freshness | `workers.online`, `workers.stale`, `workers.byNode[].status`, `lastSeenAgeSec` | A worker is online only while its broker heartbeat is within the configured offline window; otherwise it is stale. | Expected Team2/Gwakga workers are online; historical workers are visibly stale, not silently treated as fresh capacity. |
| Queue pressure | `observability.queuePressure.blocked`, `queued`, `claimed`, `running` | Compact active queue pressure without task payloads or raw session data. | Counts are bounded for the planned round and do not require full task snapshots to interpret. |
| Stale worker leases | `observability.queuePressure.staleWorkerAssignments` | Claimed/running tasks attached to workers already stale by broker heartbeat. | `0` before dispatch; non-zero is NO-GO until requeued/reassigned with approval. |
| Active stale workers | `observability.workerHealth.staleWorkersWithActiveTasks[]` | Stale workers that still own claimed/running work. | Empty before dispatch; non-empty requires operator attention. |
| Oldest active work | `oldestClaimed`, `oldestRunning` with `statusSinceAt` and `statusAgeSec` | Broker-owned age fields for stuck-work triage; dashboards should not invent local browser-clock ages. | Ages remain below the stale threshold or are explicitly handled. |
| Recovery pressure | `observability.recovery.totalRequeued`, `totalDeadLettered`, `recentRequeues`, `recentDeadLetters` | Whether stale recovery is recycling work or exhausting retry caps. | No unexplained new dead letters; any requeues have issue/PR evidence. |
| Operator snapshot | `operatorSnapshot.recoverySummary` and `attentionItems[]` | Receipt-safe incident summary explaining why work is stuck and what to do next. | No critical/warn attention items for the target Team2 lane before GO. |

## Capacity semantics to compare

`GET /workers/capacity` is the pre-dispatch capacity view. It intentionally omits task messages, payloads, raw sessions, workspace paths, and secrets.

| Surface | Field(s) | Operator meaning | GO expectation |
| --- | --- | --- | --- |
| Fleet total | `totals.workers`, `online`, `staleWorkers` | Current registered workers and freshness by broker heartbeat. | Team2 expected workers are registered once and online only on Gwakga. |
| Active pressure | `totals.queued`, `claimed`, `running`, `active` and `items[].counts` | Per-worker and fleet active work counts. | Planned worker has capacity headroom; no unexpected backlog from the previous round. |
| Stale task pressure | `totals.staleTasks`, `items[].counts.stale` | Claimed/running work is stale when either the worker is stale or the task status age exceeds `stale_after_ms`. | `0` before dispatch; non-zero is NO-GO pending approved stale recovery. |
| Latest update | `items[].latestTaskUpdatedAt` | Last task update timestamp per worker without expanding task payloads. | Recent enough to explain active work, or old enough to trigger stale handling. |

## Read-only validation recipe

Use redacted broker URLs and local secret handling. Do not paste secrets, raw `.env`, OpenClaw runtime files, raw session dumps, or terminal-outbox payloads into issue/PR evidence.

```bash
# Duplicate online worker guard: GET /workers only.
SEOSEO_BROKER_URL="${SEOSEO_BROKER_URL}" \
GWAKGA_BROKER_URL="${GWAKGA_BROKER_URL}" \
npm run two_broker_worker_preflight

# Compact dashboard snapshots: GET only.
curl -fsS -H "x-a2a-edge-secret: ${BROKER_EDGE_SECRET}" \
  -H "x-a2a-requester-id: operator" \
  "${SEOSEO_BROKER_URL}/dashboard"

curl -fsS -H "x-a2a-edge-secret: ${BROKER_EDGE_SECRET}" \
  -H "x-a2a-requester-id: operator" \
  "${GWAKGA_BROKER_URL}/dashboard"

# Capacity snapshots: GET only, with the same stale threshold on both brokers.
curl -fsS -H "x-a2a-edge-secret: ${BROKER_EDGE_SECRET}" \
  -H "x-a2a-requester-id: operator" \
  "${SEOSEO_BROKER_URL}/workers/capacity?stale_after_ms=120000"

curl -fsS -H "x-a2a-edge-secret: ${BROKER_EDGE_SECRET}" \
  -H "x-a2a-requester-id: operator" \
  "${GWAKGA_BROKER_URL}/workers/capacity?stale_after_ms=120000"
```

Post only sanitized excerpts: totals, worker ids/roles, heartbeat ages, stale counts, queue counts, dead-letter counts, command exit codes, and links to issue/PR evidence.

## GO / NO-GO rule for Team2/Gwakga

GO for the Team2/Gwakga dashboard/capacity lane only when all of the following are true:

1. No duplicate online worker id appears across Seoseo and Gwakga.
2. The intended Team2 worker is online on Gwakga and not online on Seoseo.
3. `staleWorkerAssignments == 0` on the Gwakga dashboard.
4. `totals.staleTasks == 0` on the Gwakga capacity response.
5. `claimed`, `running`, and `active` counts are within the planned round limit.
6. No new dead-letter or ambiguous terminal-outbox evidence is present.
7. Evidence is receipt-safe: provider-accepted/send success is not represented as read visibility or terminal ACK.

Any failed item is NO-GO and should be posted as bounded Block/Done evidence rather than hidden in a raw task dump.

## OpenClaw context hygiene

Before opening a PR or posting artifacts for this lane, fail closed if any OpenClaw runtime/bootstrap context file would enter the branch or evidence packet: `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, or `.openclaw/**`.
