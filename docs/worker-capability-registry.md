# Worker Capability / AgentCard registry shape

Issue: `jinwon-int/a2a-broker#432`

This is a validation-first, additive registry shape for worker discovery. It does **not** auto-route work, mutate production assignments, restart workers, or expose live provider/terminal-outbox state. Assignment engines may use these cards as recommendations or preflight evidence only; broker policy and operator approval remain authoritative.

## Shape source

The TypeScript shape and checker live in `src/core/worker-capability-card.ts`:

- `WorkerCapabilityCard` is the registry record.
- `createWorkerCapabilityCard(worker, options)` projects a safe card from a `WorkerView` without copying raw `metadata`, `brokerUrl`, private host hints, or secrets.
- `validateWorkerCapabilityCard(card)` fails closed on unsafe public visibility, missing Team1/Team2/libero metadata, disabled live approval gating, or secret-like fields.

Required registry dimensions:

- worker id/name, party role, and runtime mode
- `team.teamId`, `team.lane`, and `team.brokerOfRecord`
- assignment roles: `implementation`, `docs-compat`, `runner-safety`, `libero`
- supported task types and environments
- risk boundaries and `requiresApprovalForLive: true`
- optional max/current capacity hints
- optional liveness summary
- `visibility.scope` (`public`, `team`, `private`) plus explicit safe exposure flags
- AgentCard-compatible discovery subset (`protocolVersion`, `capabilities`, `skills`) that intentionally omits URLs/provider metadata

## Safe visibility rules

Public cards must be sanitized:

- `visibility.safeForDiscovery=true`
- `visibility.exposeBrokerUrl=false`
- `visibility.exposeWorkspaceIds=false`
- `visibility.exposesSecrets` set to `false`
- no raw worker `metadata`, tokens, credentials, private keys, or provider payloads

Team/private cards may expose more operational hints, but still must not include secrets or raw credential paths. Capacity and liveness are hints only; they are not lease authority.

### Public AgentCard-style seam review (#460)

For public-safe worker discovery, the registry maps the current worker read model into two deliberately small surfaces:

- Public-safe registry fields: `schemaVersion`, `worker.id`, `worker.name`, `worker.role`, `worker.mode`, `team.teamId`, `team.lane`, `team.brokerOfRecord`, `assignment.roles`, `assignment.supportedTaskTypes`, `assignment.environments`, `capabilities.canAnalyze`, `capabilities.canBackfill`, `capabilities.canPatchWorkspace`, `capabilities.canPromoteLive`, `capabilities.environments`, `skills`, `safety.canTouchLive`, `safety.requiresApprovalForLive`, `safety.boundaries`, `visibility`, optional capacity hints, and optional liveness summary when explicitly enabled.
- AgentCard-compatible discovery fields: `agentCard.protocolVersion`, `agentCard.capabilities.streaming`, `agentCard.capabilities.pushNotifications`, `agentCard.defaultInputModes`, `agentCard.defaultOutputModes`, and `agentCard.skills`.
- Forbidden public fields: worker `brokerUrl`, raw `metadata`, terminal/provider identifiers, private hostnames, tokens, credentials, private keys, raw provider payloads, raw session or prompt text, and `workspaceIds` unless a non-public reviewed card explicitly enables `visibility.exposeWorkspaceIds`.

Assignment safety remains broker-owned and fail-closed: cards may help select candidate workers for #432 readiness lanes such as Team2/gwakga `dungae`, but they do not grant a lease, approve live work, ACK terminal receipts, or bypass operator approval. Public cards must keep `visibility.safeForDiscovery=true`, `visibility.exposeBrokerUrl=false`, `visibility.exposeWorkspaceIds=false`, and `safety.requiresApprovalForLive=true`.

## Representative cards

### Team1 implementation worker

```json
{
  "schemaVersion": "worker-capability-card/v1",
  "worker": { "id": "team1-impl-a", "name": "Team1 implementation", "role": "analyst", "mode": "persistent" },
  "team": { "teamId": "team1", "lane": "team1", "brokerOfRecord": "seoseo" },
  "assignment": {
    "roles": ["implementation"],
    "supportedTaskTypes": ["propose_patch", "apply_local_change"],
    "environments": ["research", "staging"]
  },
  "visibility": { "scope": "team", "safeForDiscovery": false, "exposeBrokerUrl": false, "exposeWorkspaceIds": false, "exposeCapacity": true, "exposeLiveness": true, "exposesSecrets": false }
}
```

### Team2 docs/compat worker

```json
{
  "schemaVersion": "worker-capability-card/v1",
  "worker": { "id": "team2-docs-compat", "name": "Team2 docs/compat", "role": "researcher", "mode": "persistent" },
  "team": { "teamId": "team2", "lane": "team2", "brokerOfRecord": "gwakga" },
  "assignment": {
    "roles": ["docs-compat"],
    "supportedTaskTypes": ["analyze", "validate_change"],
    "environments": ["research"]
  },
  "visibility": { "scope": "public", "safeForDiscovery": true, "exposeBrokerUrl": false, "exposeWorkspaceIds": false, "exposeCapacity": true, "exposeLiveness": false, "exposesSecrets": false }
}
```

### Runner/safety worker

```json
{
  "schemaVersion": "worker-capability-card/v1",
  "worker": { "id": "runner-safety-a", "name": "Runner safety", "role": "operator", "mode": "persistent" },
  "team": { "teamId": "team1", "lane": "team1", "brokerOfRecord": "seoseo" },
  "assignment": {
    "roles": ["runner-safety"],
    "supportedTaskTypes": ["analyze", "validate_change"],
    "environments": ["research", "staging"]
  },
  "safety": { "canTouchLive": false, "requiresApprovalForLive": true, "boundaries": ["no production deploy", "no provider send", "no terminal-outbox ACK"] },
  "visibility": { "scope": "team", "safeForDiscovery": false, "exposeBrokerUrl": false, "exposeWorkspaceIds": false, "exposeCapacity": true, "exposeLiveness": true, "exposesSecrets": false }
}
```

### Libero validation worker (`yukson` lane)

```json
{
  "schemaVersion": "worker-capability-card/v1",
  "worker": { "id": "yukson", "name": "Yukson libero", "role": "analyst", "mode": "mobile" },
  "team": { "teamId": "team1", "lane": "team1", "brokerOfRecord": "seoseo" },
  "assignment": {
    "roles": ["libero"],
    "supportedTaskTypes": ["analyze", "validate_change"],
    "environments": ["research", "staging"],
    "libero": { "validatesTeams": ["team1", "team2"], "authority": "advisory", "safeToAssignProduction": false }
  },
  "visibility": { "scope": "public", "safeForDiscovery": true, "exposeBrokerUrl": false, "exposeWorkspaceIds": false, "exposeCapacity": true, "exposeLiveness": false, "exposesSecrets": false }
}
```

## Implications for related work

- `#294` stability roadmap: cards make receipt/canary lanes easier to target without hardcoding workers, but they preserve the roadmap's fail-closed rule by treating capacity/liveness as hints and live work as approval-gated.
- `#93` wake audit/resume: liveness fields should stay summary-only (`status`, `lastSeenAt`) and must not include raw prompt/session text, replay payloads, or wake cursor internals.
- `#94` durable wake proof matrix: libero/runner-safety roles can be selected for deterministic validation scenarios, but S1-S5 proof artifacts should reference card ids/roles rather than copying private worker metadata.
