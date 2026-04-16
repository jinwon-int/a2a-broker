# A2A Broker audit remediation, 2026-04-17

## Completed fixes

### 1. Gateway A2A runtime reuse
- `src/gateway/server-methods/a2a.ts`
- Reused one broker runtime instance across `a2a.task.request` and `a2a.task.cancel`
- Avoids per-request runtime churn and state loss risk

### 2. A2A event-log failure surfacing
- `src/agents/a2a/log.ts`
- `mkdir` and `appendFile` failures now log warnings and throw
- Callers now stop on persistence failure instead of silently diverging from disk state

### 3. Standalone broker retention + snapshot validation
- `a2a-broker/src/core/broker.ts`
- `a2a-broker/src/core/store.ts`
- Added bounded retention for terminal exchanges, tasks, proposals, audit events, and stale workers
- Retention preserves the newest referenced graph so task, exchange, proposal, artifact, validation, worker, and audit links do not break mid-prune
- Added snapshot max-size guard and schema validation on load

### 4. `PUBLIC_BASE_URL` boot validation
- `a2a-broker/src/server.ts`
- Broker startup now fails fast when `PUBLIC_BASE_URL` is missing, placeholder-based, or not a valid absolute `http/https` URL
- Prevents publishing broken AgentCard discovery metadata

### 5. Trusted-proxy gated rate limiting
- `a2a-broker/src/core/request-security.ts`
- `a2a-broker/src/server.ts`
- `x-forwarded-for` is now ignored unless `TRUSTED_PROXY=1`
- Prevents clients from spoofing rate-limit identity through forwarded headers on direct connections

## Validation run

### OpenClaw repo
```bash
pnpm test src/agents/a2a/log.test.ts src/agents/a2a/broker.test.ts src/agents/a2a/status.test.ts src/gateway/server-methods/a2a.test.ts
pnpm tsgo
```

### Standalone broker
```bash
cd a2a-broker
npm test
```

## Follow-up candidates

1. Revisit broker response parsing in `src/agents/a2a/standalone-broker-client.ts`
