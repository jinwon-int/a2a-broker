# Broker release evidence export (dry-run/read-only)

`GET /release/evidence` exports a sanitized broker-side release evidence snapshot for dry-run orchestrators. It is read-only: it only lists broker task state and canonical GitHub evidence links, and it never sends provider/Telegram messages, ACKs terminal outbox records, mutates the production DB, deploys, restarts, publishes releases, or changes visibility/secrets.

Example:

```bash
curl -H "x-a2a-edge-secret: $A2A_EDGE_SECRET" \
  -H "x-a2a-requester-id: operator" \
  -H "x-a2a-requester-role: operator" \
  "https://broker.example/release/evidence?repo=jinwon-int/a2a-broker&issue=479&parentIssue=jinwon-int/a2a-plane%23197&runId=a2a-source-dryrun-orchestrator-20260510T133022Z"
```

Useful filters mirror `/tasks`: `status`, `targetNodeId`, `assignedWorkerId`, `intent`, `taskOrigin`, plus `task_id`/`task_ids` for exact task IDs.

The JSON response includes:

- `mode: "dry-run/read-only"` and `readOnly: true`
- no-live gate metadata (`liveActionAllowed=false`, `mutationAllowed=false`)
- task counts by status
- PR/Done/Block evidence counts and canonical GitHub links
- per-task sanitized evidence rows

A local CLI wrapper is also available after build:

```bash
npm run release_evidence_export -- --input sanitized-tasks.json --markdown
```

The CLI accepts either an array of `TaskRecord` objects or `{ "tasks": [...], "options": { ... } }` and prints JSON by default. Inputs and outputs should remain sanitized; do not include secrets, raw runner logs, or host-local paths in evidence artifacts.
