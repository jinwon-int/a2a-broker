# Runnable smoke compose

This is the copy/paste path that proves a fresh broker build can
accept a task and drive it to `succeeded` without any external worker
runtime.

It intentionally uses the built-in `echo` worker from this repo, so
an operator can verify a deploy end to end before wiring up
`openclaw-plugin-a2a`, `bangtong`, or `dengae`.

Reference files:

- compose: `examples/docker-compose.smoke.yml`
- built-in worker handler: `src/worker.ts` (`createBuiltinWorkerHandler("echo")`)

Closes issue #4.

## What this validates

The flow proves:

1. the broker image builds
2. `GET /health` reports `ok` and a usable `stateVersion`
3. a worker registers, heartbeats, and shows up under `GET /workers`
4. `POST /tasks` is accepted by the broker with the right requester
   headers
5. the echo worker claims, starts, and completes the task
6. `GET /tasks/:id` reports `status: "succeeded"` with a non-empty
   `result`
7. `GET /audit?targetId=<taskId>` contains `task.created`,
   `task.claimed`, `task.started`, and `task.succeeded`

This is the minimum end-to-end success path listed in
`docs/v1-acceptance-handoff.md` section 4.

## Prerequisites

- Docker with `docker compose` v2
- curl
- port `127.0.0.1:8787` free on the host

This compose stack has no secrets, no edge secret, and no reverse
proxy. It is for single-host smoke verification only. Do not use it
for production.

## Start the stack

```bash
cd a2a-broker
docker compose -f examples/docker-compose.smoke.yml up --build -d
```

Wait for both services to be healthy:

```bash
docker compose -f examples/docker-compose.smoke.yml ps
curl -sf http://127.0.0.1:8787/health | head -c 400 ; echo
```

You should see `status:"ok"` and `stateVersion:5`.

## Confirm the worker registered

```bash
curl -sf http://127.0.0.1:8787/workers | head -c 400 ; echo
curl -sf http://127.0.0.1:8787/workers/echo-worker-1 | head -c 400 ; echo
```

The worker entry should show `role:"analyst"` and a recent
`lastSeenAt`.

## Seed a task from the shell

The task target is the echo worker. The requester headers must match
the body `requester.id` and `requester.role`.

```bash
TASK_ID=$(uuidgen | tr 'A-Z' 'a-z')
curl -sf -X POST http://127.0.0.1:8787/tasks \
  -H 'content-type: application/json' \
  -H 'x-a2a-requester-id: smoke-operator' \
  -H 'x-a2a-requester-kind: service' \
  -H 'x-a2a-requester-role: operator' \
  -d "{
    \"id\": \"${TASK_ID}\",
    \"intent\": \"chat\",
    \"requester\": { \"id\": \"smoke-operator\", \"kind\": \"service\", \"role\": \"operator\" },
    \"target\": { \"id\": \"echo-worker-1\", \"kind\": \"node\" },
    \"assignedWorkerId\": \"echo-worker-1\",
    \"message\": \"hello echo\"
  }" | head -c 600 ; echo
echo "TASK_ID=${TASK_ID}"
```

The response is the full task record with `status:"queued"`.

## Verify the task reaches `succeeded`

Poll the task. The echo worker polls every 2 seconds in this stack,
so it should transition within a few seconds.

```bash
for i in 1 2 3 4 5 6 7 8 9 10; do
  STATUS=$(curl -sf "http://127.0.0.1:8787/tasks/${TASK_ID}" \
    -H 'x-a2a-requester-id: smoke-operator' \
    -H 'x-a2a-requester-kind: service' \
    -H 'x-a2a-requester-role: operator' \
    | sed -n 's/.*"status":"\([^"]*\)".*/\1/p')
  echo "attempt ${i}: ${STATUS}"
  [ "${STATUS}" = "succeeded" ] && break
  sleep 2
done
```

When `STATUS` is `succeeded`, fetch the full record:

```bash
curl -sf "http://127.0.0.1:8787/tasks/${TASK_ID}" \
  -H 'x-a2a-requester-id: smoke-operator' \
  -H 'x-a2a-requester-kind: service' \
  -H 'x-a2a-requester-role: operator' | head -c 800 ; echo
```

You should see `"status":"succeeded"` and a `result.output` that
echoes the task message.

## Verify the audit trail

```bash
curl -sf "http://127.0.0.1:8787/audit?targetId=${TASK_ID}" \
  -H 'x-a2a-requester-id: smoke-operator' \
  -H 'x-a2a-requester-kind: service' \
  -H 'x-a2a-requester-role: operator' | head -c 800 ; echo
```

Expected actions for a successful smoke:

- `task.created`
- `task.claimed`
- `task.started`
- `task.succeeded`

The automated release gate (`npm run release_gate`) additionally exercises
live-impact approval handling on this compose stack: an approved
`promote_to_live` task must move `blocked → queued → succeeded`, while a
rejected approval must move `blocked → canceled` without `task.claimed`,
`task.started`, or `task.succeeded` audit actions.

## Tear down

```bash
docker compose -f examples/docker-compose.smoke.yml down --volumes
```

The `--volumes` flag drops the persisted broker state so the next
smoke starts fresh.

## When this smoke is not the right tool

- For restart-recovery verification (worker dies mid-task, broker
  restarts, task is requeued and completed), use
  `docs/restart-recovery-smoke.md`. That drill uses the same broker
  build but a host-local worker with a sleep handler.
- For the trading-partner isolation reference (`bangtong`, `dengae`),
  use `examples/docker-compose.trading-partners.yml` together with
  `docs/docker-compose-trading-partners.md`. That compose is
  intentionally not a runnable smoke stack and has placeholder worker
  commands.

## Failure triage

If the smoke does not reach `succeeded`, check in this order:

1. `docker compose -f examples/docker-compose.smoke.yml logs a2a-broker`
   — look for `PUBLIC_BASE_URL` rejection, state-file errors, or
   rate-limit `429` responses.
2. `docker compose -f examples/docker-compose.smoke.yml logs echo-worker`
   — look for register, heartbeat, and poll log lines.
3. `curl http://127.0.0.1:8787/workers/echo-worker-1` — confirm
   `status:"online"`.
4. `curl http://127.0.0.1:8787/tasks/${TASK_ID}` — confirm the task
   was created and is `queued` or `claimed`.
5. `curl http://127.0.0.1:8787/audit?targetId=${TASK_ID}` — confirm
   which lifecycle step is missing.
