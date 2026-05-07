# Team2/Gwakga worker onboarding and retargeting runbook

This runbook prepares the Team2/Gwakga side of a two-broker cutover. It is intentionally conservative: it documents safe preflight, onboarding, retarget, and rollback steps without changing production routes, restarting Gateway, rotating secrets, mutating production databases, sending through live providers, or acknowledging terminal outbox rows.

Reference config: [`examples/team2-gwakga.worker.env.example`](../examples/team2-gwakga.worker.env.example).

## Broker and team naming conventions

Use stable lowercase IDs everywhere a worker reports broker/team ownership. Do not infer ownership from hostnames or URLs.

| Side | brokerId | teamId | Use |
| --- | --- | --- | --- |
| Team1/Seoseo | `seoseo` | `team1` | Current/home broker before retargeting. |
| Team2/Gwakga | `gwakga` | `team2` | Target broker for Team2 worker onboarding. |

For worker metadata, keep the values explicit and redundant:

```json
{
  "brokerId": "gwakga",
  "teamId": "team2",
  "homeBrokerId": "gwakga",
  "retargetRun": "a2a-2broker-safety-20260507T021114Z"
}
```

When retargeting from Seoseo to Gwakga, also record `previousHomeBrokerId: "seoseo"` and keep any human approval reference outside secrets or raw session logs.

## Evidence required before moving `soonwook` or future workers

Capture sanitized evidence in the issue/PR comment before the cutover is considered ready:

- worker ID and intended home side (`soonwook` → `brokerId=gwakga`, `teamId=team2`)
- exact old and new broker URLs, redacted to host labels if private
- old-broker check showing no active lease for the worker (`claimed`, `running`, or queued task assigned to that worker)
- target-broker check showing no fresh duplicate registration for the same worker ID, or an explicit operator-approved replacement plan
- config diff or env summary with secrets redacted (`BROKER_EDGE_SECRET`, provider tokens, runner tokens)
- rollback owner and trigger conditions
- validation command output with exit codes

Do not paste raw `.env` files, edge secrets, OpenClaw runtime context files, raw session dumps, or terminal outbox payloads.

## Safe preflight: duplicate and lease checks

Run these as read-only checks first. Replace placeholders in your local shell; keep secrets out of logs.

```bash
export WORKER_ID=soonwook
export OLD_BROKER_URL=https://seoseo-broker.example.invalid
export NEW_BROKER_URL=https://gwakga-broker.example.invalid
export BROKER_EDGE_SECRET='<set in local shell only; never paste>'

# Old broker: worker registration should be absent or stale after stop.
curl -fsS \
  -H "x-a2a-edge-secret: ${BROKER_EDGE_SECRET}" \
  -H "x-a2a-requester-id: operator" \
  "${OLD_BROKER_URL}/workers/${WORKER_ID}"

# Old broker: no work should remain assigned or leased to this worker.
for status in queued claimed running; do
  curl -fsS \
    -H "x-a2a-edge-secret: ${BROKER_EDGE_SECRET}" \
    -H "x-a2a-requester-id: operator" \
    "${OLD_BROKER_URL}/tasks?assignedWorkerId=${WORKER_ID}&status=${status}"
done

# Target broker: no fresh duplicate should already be registered for this ID.
curl -fsS \
  -H "x-a2a-edge-secret: ${BROKER_EDGE_SECRET}" \
  -H "x-a2a-requester-id: operator" \
  "${NEW_BROKER_URL}/workers/${WORKER_ID}"
```

Fail closed if any old-broker task is `claimed` or `running`, if the target broker already has a fresh same-ID worker without an approved replacement, or if the checks require an unapproved production secret/routing change.

## Onboarding a new Gwakga worker

1. Create a worker-specific env file from the example, using a unique `WORKER_ID` and `WORKER_METADATA_JSON` with `brokerId=gwakga`, `teamId=team2`, and `homeBrokerId=gwakga`.
2. Keep workspace and artifact roots worker-specific. Do not share writable workspace mounts with Seoseo workers.
3. Run the duplicate preflight against the Gwakga broker.
4. Start the worker only after operator approval for the onboarding window.
5. Confirm exactly one fresh registration/heartbeat exists for the worker on Gwakga.
6. Submit only sanitized evidence: worker ID, broker/team IDs, fresh heartbeat timestamp, validation commands, and redacted config summary.

## Retargeting `soonwook` from Seoseo to Gwakga

Retargeting has a hard boundary: one worker ID must have one active home broker.

1. **Stop the old worker process** on the Seoseo side using the operator-approved service/container procedure. Do not restart Gateway.
2. **Verify lease drain** on Seoseo: no `claimed` or `running` tasks for `soonwook`; queued tasks are either drained, cancelled, or explicitly requeued by an approved operator.
3. **Wait for stale window or deregistration evidence** according to the broker's worker-offline threshold. Do not rely on silence alone; capture the read-only worker/task checks.
4. **Apply local worker config** so `BROKER_URL` points at the Gwakga broker and metadata reports `brokerId=gwakga`, `teamId=team2`, `homeBrokerId=gwakga`, and `previousHomeBrokerId=seoseo`.
5. **Run duplicate preflight** on Gwakga before start. If Gwakga already reports a fresh `soonwook`, stop and resolve ownership.
6. **Restart only the worker process/container** using the approved worker procedure. No production deploy, public route change, secret rotation, live provider send, terminal-outbox ACK, or Gateway restart is part of this runbook.
7. **Verify post-start**: Gwakga shows one fresh `soonwook` heartbeat; Seoseo shows no active lease for `soonwook`; evidence is sanitized.

## Rollback boundary

Rollback is a worker retarget only, not a broker deploy.

Rollback triggers:

- Gwakga registration is missing or flapping after the approved window.
- Any dual fresh registration appears for the same worker ID.
- Tasks are claimed on the wrong broker.
- Required validation/evidence cannot be produced safely.

Rollback steps:

1. Stop the Gwakga-side worker process/container.
2. Confirm Gwakga has no `claimed` or `running` tasks for the worker, or get operator approval to fail/requeue them.
3. Restore the previous Seoseo worker env/config from the last known-good sanitized config summary.
4. Restart only the worker process/container on Seoseo.
5. Verify exactly one fresh home registration on Seoseo and no fresh duplicate on Gwakga.
6. Post rollback evidence with secrets and host-private paths redacted.
