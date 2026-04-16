# A2A Broker Ops Handoff

## Current guaranteed behavior

- Exchange root and thread messages are stored separately.
- `GET /exchanges/:id/messages` supports thread-oriented lookup with `parentMessageId` and `includeDescendants`.
- Message payloads preserve `actor`, `via`, `targetNodeId`, `assignedWorkerId`, and `parentMessageId`.
- Decisions `accepted`, `partially_accepted`, `needs_clarification`, and `declined` remain available.
- `POST /tasks/:id/reassign` is limited to `hub` and `operator` actors and leaves an audit trail.
- Stale recovery remains `requeue_only`; it does not auto-reassign `assignedWorkerId`.

## Standard entrypoints

- Primary endpoint: `https://broker.seoyoon-family.com`
- Temporary fallback endpoint: `https://broker.192.3.106.253.sslip.io`
- Fallback policy: no public direct fallback
- Local maintenance path only: `http://127.0.0.1:8787`
- Edge auth: all broker routes except `GET /health` now require `X-A2A-Edge-Secret`

## Direct exposure control

- Docker publish is restricted to `127.0.0.1:8787:8787`
- Result: direct access from outside the host should no longer reach broker on `192.3.106.253:8787`
- Caddy remains the only supported external entrypoint
- Loopback direct access is retained only for host-local diagnostics and Caddy upstream reachability checks

## Applied auth hardening

- Applied method: shared secret header enforced at Caddy
- Protected scope: every broker route except `GET /health`
- Expected behavior:
  - `GET /health` works without the edge secret
  - missing or wrong `X-A2A-Edge-Secret` returns `401 unauthorized`
  - valid edge secret plus normal requester headers preserves existing broker behavior
- Secret handling:
  - Caddy matcher is stored in `/etc/caddy/broker-edge-auth.caddy`
  - do not place the secret in chat or docs
  - rotate by updating `/etc/caddy/broker-edge-auth.caddy`, then `caddy validate` and `caddy reload`

## External verification result

- Verified through the reverse proxy host `https://broker.seoyoon-family.com`
- Legacy fallback host `https://broker.192.3.106.253.sslip.io` remains available during transition
- Verified routes:
  - `GET /health`
  - `POST /workers/register`
  - `POST /exchanges`
  - `GET /exchanges/:id`
  - `POST /exchanges/:id/messages`
  - `GET /exchanges/:id/messages?parentMessageId=<id>&includeDescendants=true`
  - `POST /tasks/:id/reassign`
  - `POST /tasks/requeue_stale?older_than_seconds=0`
  - `GET /audit`
- Verified externally:
  - requester headers survive the proxy path
  - `parentMessageId`, `includeDescendants`, `assignedWorkerId`, and `targetNodeId` survive the proxy path
  - missing or wrong edge secret returns `401 unauthorized`
  - unauthorized reassign without the edge secret returns `401 unauthorized`
  - `health.persistence.stateVersion = 5`
  - direct public access on `http://192.3.106.253:8787` should fail after loopback bind restriction

## Soak and concurrency verification

- Scope: reverse proxy path, 4 concurrent flows, more than 10 minutes
- Each flow includes:
  - worker registration
  - exchange creation
  - accepted message append
  - subtree lookup
  - unauthorized reassign probe
  - authorized reassign
  - stale requeue
  - audit lookup
- Success condition:
  - no transport errors
  - no unexpected non-2xx or non-401 responses
  - no field loss through the proxy path

## Minimum post-deploy smoke

1. `curl https://broker.seoyoon-family.com/health`
2. Register two disposable workers with requester headers and `X-A2A-Edge-Secret`
3. Create one exchange and append one accepted message
4. Verify subtree lookup with `parentMessageId` and `includeDescendants=true`
5. Reassign the active task once and confirm `GET /audit?action=task.reassigned&targetId=<taskId>`
6. Call `POST /tasks/requeue_stale?older_than_seconds=0` and confirm `policy=requeue_only`
7. Confirm the same flow without `X-A2A-Edge-Secret` returns `401 unauthorized`
8. Confirm `curl http://192.3.106.253:8787/health` fails while `curl http://127.0.0.1:8787/health` still works on the host

## Apply and verify commands

- Apply config:
  - `cp .env .env.bak_YYYYMMDD_HHMMSS`
  - `cp docker-compose.yml docker-compose.yml.bak_YYYYMMDD_HHMMSS`
  - `cp /etc/caddy/broker-edge-auth.caddy /etc/caddy/broker-edge-auth.caddy.bak_YYYYMMDD_HHMMSS`
  - `cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak_YYYYMMDD_HHMMSS`
  - keep `docker-compose.yml` port publish on `127.0.0.1:8787:8787`
  - keep `.env` on `PUBLIC_BASE_URL=https://broker.seoyoon-family.com`
  - ensure the broker Caddy site block includes both `broker.seoyoon-family.com` and the temporary sslip fallback host during transition
  - `docker compose up -d`
  - `caddy validate --config /etc/caddy/Caddyfile`
  - `caddy reload --config /etc/caddy/Caddyfile`
- Verify config:
  - `curl https://broker.seoyoon-family.com/health`
  - `curl https://broker.192.3.106.253.sslip.io/health`
  - `curl http://127.0.0.1:8787/health`
  - `curl --max-time 5 http://192.3.106.253:8787/health` should fail
  - `curl -H 'X-A2A-Edge-Secret: <EDGE_SECRET>' https://broker.seoyoon-family.com/exchanges/.../messages?parentMessageId=...&includeDescendants=true`
  - `curl -H 'X-A2A-Edge-Secret: <EDGE_SECRET>' -X POST https://broker.seoyoon-family.com/tasks/.../reassign ...`
  - `curl -X POST https://broker.seoyoon-family.com/exchanges ...` should return `401` without the edge secret

## Fixed-domain status and fallback plan

- Permanent host: `broker.seoyoon-family.com`
- Current state:
  - DNS is active
  - TLS issuance is active
  - broker advertises `https://broker.seoyoon-family.com` as its public base URL
  - the broker Caddy site block serves both the fixed domain and the temporary sslip fallback host
- Transition policy:
  - use `broker.seoyoon-family.com` as the operator-facing standard endpoint
  - keep `broker.192.3.106.253.sslip.io` as a temporary fallback only during transition
  - remove sslip references from active docs and operator runbooks as they are updated
- Ongoing verification:
  - rerun the full proxy smoke on the fixed domain after meaningful proxy/auth changes
  - verify `GET /health`, exchange creation, subtree lookup, reassign, requeue, audit, and unauthorized `401` behavior
- Rollback criteria:
  - certificate issuance fails
  - proxy smoke fails on exchange, subtree, reassign, or requeue
  - fixed-domain health diverges from the sslip fallback host
- Rollback action:
  - keep `broker.192.3.106.253.sslip.io` available as temporary fallback
  - restore the previous `PUBLIC_BASE_URL` only if operator-facing flows depend on immediate rollback
  - keep direct port local-only on loopback

## Auth alternatives

- Signed header
  - better replay resistance than a static shared secret
  - requires timestamp and signature generation in the caller
  - recommended next auth step after the current shared secret rollout stabilizes
- mTLS
  - strongest channel-level control
  - highest operational cost because cert issuance, rotation, and client trust distribution must be added
  - keep as a later option if the caller set is small and tightly controlled

## First places to inspect on errors

- `GET /health` for uptime, `stateVersion`, and request-security config
- `GET /audit` for `exchange.message.added`, `task.reassigned`, and `task.requeued`
- requester headers: `x-a2a-requester-id`, `x-a2a-requester-role`
- edge secret presence: `X-A2A-Edge-Secret`
- reverse proxy config: `/etc/caddy/Caddyfile`, `/etc/caddy/broker-edge-auth.caddy`
- direct exposure config: `docker-compose.yml`, `.env`, `docker ps`, `ss -ltnp`
- Caddy issues: `caddy validate --config /etc/caddy/Caddyfile`, `journalctl -u caddy --no-pager -n 100`
- host-local broker reachability on `127.0.0.1:8787`
