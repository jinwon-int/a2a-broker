# Broker restart recovery smoke

This runbook captures the manual operator flow and the repo-backed automation for validating broker restart recovery.

## What this proves

The smoke validates this sequence end to end:

1. a worker claims a task and moves it to `running`
2. the worker disappears mid-task
3. the broker service restarts and reloads persisted state
4. the task still exists as `running`
5. an operator forces `POST /tasks/requeue_stale?older_than_seconds=0`
6. a replacement worker with the same `assignedWorkerId` picks the task back up
7. the task reaches `succeeded`

This is intentionally the `requeue_only` recovery path. The broker does not auto-reassign `assignedWorkerId` during stale recovery.

## Prerequisites

- Node 22+
- built broker runtime at `dist/worker.js`
- operator access that can restart the broker service
- `BROKER_URL` pointing at the broker under test
- `BROKER_EDGE_SECRET` (or `EDGE_SECRET`) set when the broker requires edge auth

Recommended default:

```bash
cd a2a-broker
npm run build
```

## Automated smoke

The repo now includes:

- script: `scripts/restart-recovery-smoke.mjs`
- npm alias: `npm run smoke:restart-recovery`

Minimal host-local example:

```bash
cd a2a-broker
BROKER_URL=http://127.0.0.1:8787 \
BROKER_EDGE_SECRET=YOUR_EDGE_SECRET \
npm run smoke:restart-recovery
```

Public reverse-proxy example:

```bash
cd a2a-broker
BROKER_URL=https://broker.example.com \
BROKER_EDGE_SECRET=YOUR_EDGE_SECRET \
npm run smoke:restart-recovery
```

If your broker is not managed by `systemd`, override the restart command:

```bash
cd a2a-broker
BROKER_URL=https://broker.example.com \
BROKER_EDGE_SECRET=YOUR_EDGE_SECRET \
BROKER_RESTART_CMD='docker compose restart a2a-broker' \
npm run smoke:restart-recovery
```

## What the script does

The automation intentionally uses two worker phases with the same worker id:

- phase 1: a long-running external sleep handler so the task stays in `running`
- phase 2: a replacement echo worker that proves the requeued task can be reclaimed and completed

The script:

1. starts a worker with a sleep handler
2. waits for `/workers/:id` to report `online`
3. creates a broker task pinned to that worker id
4. waits for the task to reach `running`
5. kills the worker process
6. runs `BROKER_RESTART_CMD`
7. waits for `/health`
8. verifies the task still exists as `running`
9. calls `POST /tasks/requeue_stale?older_than_seconds=0`
10. starts a replacement echo worker with the same worker id
11. waits for the task to reach `succeeded`
12. prints a JSON summary including audit actions

## Important behavior notes

- `older_than_seconds=0` is deliberate. It forces an operator recovery sweep immediately and does not wait for `WORKER_OFFLINE_AFTER_SEC`.
- `POST /tasks/requeue_stale` still requires requester identity, edge auth when enabled, and a `hub` or `operator` role.
- recovery remains `requeue_only`, so the replacement worker must reuse the same `assignedWorkerId` unless an operator separately reassigns the task.
- the script rotates non-mutating requester ids for inspection calls so normal verification stays well below the general requester rate limit.

## Manual fallback flow

If you need to run the recovery path by hand:

1. start a worker and let it pick up a task
2. stop the worker mid-task
3. restart the broker service
4. confirm `GET /tasks/:id` still shows `running`
5. force stale recovery:

```bash
curl -X POST \
  -H 'x-a2a-edge-secret: YOUR_EDGE_SECRET' \
  -H 'x-a2a-requester-id: recovery-operator' \
  -H 'x-a2a-requester-kind: service' \
  -H 'x-a2a-requester-role: operator' \
  'https://broker.example.com/tasks/requeue_stale?older_than_seconds=0'
```

6. start a replacement worker with the same worker id
7. verify `GET /tasks/:id` reaches `succeeded`
8. verify `GET /audit?targetId=<taskId>` contains `task.requeued` and `task.succeeded`

## Expected audit trail

A successful recovery smoke should show this shape:

- `task.created`
- `task.claimed`
- `task.started`
- `task.requeued`
- `task.claimed`
- `task.started`
- `task.succeeded`

## Failure triage

Start here if the smoke fails:

- `GET /health`
- `GET /tasks/:id`
- `GET /workers/:id`
- `GET /audit?targetId=<taskId>`
- broker state file persistence and service restart logs
- requester headers and edge secret handling through the reverse proxy
