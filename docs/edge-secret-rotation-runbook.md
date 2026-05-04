# A2A broker edge secret rotation runbook

Use this runbook when the broker edge secret may have appeared in operator or
tool logs. Do not paste the old or new secret into chat, issues, PRs, Wiki,
shell history, or command output.

## Approval required before mutation

No rotation, env edit, drop-in change, service restart, or production config
mutation may happen until the operator explicitly approves the exact window and
scope, for example:

> Approve rotating the A2A broker edge secret now for the production broker and
> active workers listed in the current production baseline (`bangtong`, `sogyo`,
> `dungae`, `nosuk`). Update only edge secret env/drop-ins, restart the broker
> once, then restart workers one at a time, and record only rotation time,
> affected nodes, and redacted validation results.

## Scope to update

Update every place that supplies the broker edge secret. Known config names are:

- Broker: `EDGE_SECRET` or `A2A_EDGE_SECRET`.
- Worker clients: `BROKER_EDGE_SECRET`, `A2A_BROKER_EDGE_SECRET`,
  `EDGE_SECRET`, or `A2A_EDGE_SECRET`.
- Secret files referenced by env/drop-ins, if a node uses file-based injection.
- Service manager drop-ins or env files for the broker and active workers.
- Any deployment/orchestration secret store that templates those files.

Active workers from the current README production baseline are `bangtong`,
`sogyo`, `dungae`, and `nosuk`. Older handoff notes list `bangtong`, `dungae`,
and `sogyo`; include `nosuk` unless the operator confirms it is out of service.
`yukson` is explicitly excluded unless the operator makes a new decision to
bring it back into the active worker fleet.

## Preflight evidence, redacted only

Run with tracing disabled and never echo secret variables:

```bash
set +x
curl -fsS "$BROKER_URL/health" | jq '{ok, service, persistence}'

curl -fsS "$BROKER_URL/workers" \
  -H "x-a2a-edge-secret: $BROKER_EDGE_SECRET" \
  | jq '{items: [.items[] | {nodeId, role, status, lastSeenAt}]}'
```

Safe config-shape checks may list variable names and file paths, but must redact
values:

```bash
systemctl cat a2a-broker 2>/dev/null \
  | sed -E 's/(EDGE_SECRET|A2A_EDGE_SECRET|BROKER_EDGE_SECRET|A2A_BROKER_EDGE_SECRET)=.*/\1=<redacted>/g'

systemctl cat openclaw-a2a-worker 2>/dev/null \
  | sed -E 's/(EDGE_SECRET|A2A_EDGE_SECRET|BROKER_EDGE_SECRET|A2A_BROKER_EDGE_SECRET)=.*/\1=<redacted>/g'
```

Do not run broad `env`, `printenv`, `systemctl show -p Environment`, or raw file
`cat` commands against production env files because they can reveal values.

## Rotation order

1. Generate/store the new edge secret in the approved secret store or operator
   channel without printing it.
2. Quiet broad dispatches if needed so no new multi-worker operation starts
   during the short auth cutover.
3. Update the broker's edge secret source only. Keep all other config unchanged.
4. Restart the broker once and verify public health:

   ```bash
   systemctl restart a2a-broker
   curl -fsS "$BROKER_URL/health" | jq '{ok, service, persistence}'
   ```

5. For each active worker, one at a time in this order: `bangtong`, `sogyo`,
   `dungae`, `nosuk`:
   - update only that worker's edge secret source;
   - restart only that worker service;
   - wait for it to register/heartbeat with the broker;
   - verify it before moving to the next worker:

   ```bash
   systemctl restart openclaw-a2a-worker
   curl -fsS "$BROKER_URL/workers" \
     -H "x-a2a-edge-secret: $BROKER_EDGE_SECRET" \
     | jq --arg node "$NODE_ID" \
       '{items: [.items[] | select(.nodeId == $node) | {nodeId, status, lastSeenAt}]}'
   ```

6. After all active workers are online, re-run the fleet view:

   ```bash
   curl -fsS "$BROKER_URL/workers/capacity?stale_after_ms=120000" \
     -H "x-a2a-edge-secret: $BROKER_EDGE_SECRET" \
     | jq '{items: [.items[] | {nodeId, status, queued, claimed, running, stale, active, latestTaskUpdatedAt}]}'
   ```

7. Confirm the old secret is removed from active env/drop-ins/secret stores and
   any local shell variables used during the rotation are unset.

## Records to keep

Record only:

- rotation start/end time, preferably UTC and KST;
- operator approval reference;
- affected broker/worker node names;
- service restart timestamps;
- redacted health/worker validation results;
- any failed validation and rollback decision.

Never record secret values, hashes of secret values, screenshots containing
secret material, raw env output, or unredacted file contents.
