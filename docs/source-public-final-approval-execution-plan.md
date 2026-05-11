# Source-public final approval execution plan

Issue: [#486](https://github.com/jinwon-int/a2a-broker/issues/486)  
Parent: [a2a-plane#218](https://github.com/jinwon-int/a2a-plane/issues/218)  
Run: `a2a-source-public-execution-orchestrator-20260511T023207Z`  
Lane: Team2 — dungae

This layer sits after the source-public approval rehearsal. It converts a
sanitized, approved evidence packet into a deterministic final approval packet
and execution ledger entry that an operator can review. It is deliberately
non-executing: the output can be rendered in `dry-run` or `simulate` mode, but it
never approves, releases, changes repository visibility, sends providers,
deploys, restarts Gateway/broker/workers, ACKs Terminal Briefs, mutates a
production database, posts to the community, merges/approves PRs, rewrites
history, or force-pushes.

## Local command

```bash
npm run source_public_execution_orchestrator -- --json \
  --mode simulate \
  --run-id a2a-source-public-execution-orchestrator-20260511T023207Z \
  --worker dungae \
  --repo jinwon-int/a2a-broker \
  --issue 486 \
  --packet-id approval-packet-abc123 \
  --approval-intent-id approval-intent-abc123 \
  --approval-idempotency-key source-public-approval-abc123 \
  --evidence-bundle-id evidence-bundle-abc123 \
  --evidence-decision GO_CANDIDATE \
  --scanner-run-id public-readiness-scan-20260511T023207Z \
  --scanner-digest sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
  --history-cursor history-cursor-486 \
  --history-digest sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789 \
  --preflight evidencePacketApproved=pass \
  --preflight scannerHistoryBound=pass \
  --preflight bootstrapContextExcluded=pass \
  --preflight rollbackAbortRunbookPresent=pass \
  --preflight explicitOperatorGatePresent=pass
```

## Packet and ledger model

The generated bundle contains:

- a final approval packet with stable `finalApprovalPacketId`,
  `executionIntentId`, and `executionIdempotencyKey`;
- a ledger entry that is `persistence: not-written` and
  `mutationAttempted: false` in this round;
- a final go/no-go gate ledger that records each required preflight status and
  its safe effect (`allow-review`, `warn-review`, `await-operator`, or
  `block-execution`);
- an approval intent record that binds the execution intent/idempotency key to
  the decision while keeping persistence `not-written` and mutation attempts
  disabled;
- scanner/history binding fields (`scannerRunId`, `scannerDigest`,
  `historyCursor`, and `historyDigest`);
- explicit operator-gate fields with `operatorApprovalRequired: true`,
  `executionAllowed: false`, and `mutationAllowed: false`;
- preflight failures, pending gates, warnings, and fail-closed semantics;
- a rollback/abort runbook; and
- redaction metadata proving raw prompts/logs/secrets/host-private paths and
  runtime/bootstrap context are not included.

## Final go/no-go ledger and approval intent record

Issue [#488](https://github.com/jinwon-int/a2a-broker/issues/488) / run
`a2a-source-public-go-nogo-gate-20260511T052500Z` adds the explicit gate ledger
and approval intent record to the generated bundle. These records are
status-only: they contain stable ids, preflight names, statuses, and decisions,
but no raw prompts, logs, secrets, host-private paths, runtime/bootstrap context,
or live approval execution.

## Idempotency and replay protection

The execution idempotency key is derived from the approved evidence packet,
source issue, run id, run mode, scanner digest, and history digest. Supplying a
previous `executionIntentId` or `executionIdempotencyKey` via
`--prior-execution-key` marks the output as `REPLAY_SUPPRESSED`, returns the same
logical key, and suppresses duplicate ledger writes.

## Preflight failure semantics

The plan fails closed:

- `fail` gates produce `PREFLIGHT_BLOCKED` and `blocked-not-executed`;
- `pending` gates produce `NEEDS_OPERATOR_APPROVAL`; and
- clean gates produce `READY_FOR_OPERATOR_APPROVAL`, which is still only an
  approval-ready artifact for a separate, explicit operator-approved live run.

Missing scanner/history binding is normalized to a failed preflight. A packet
whose evidence decision is not `GO_CANDIDATE` is also treated as failed.

## Runtime/bootstrap context safety

Before any PR or artifact evidence is produced, fail closed if runtime/bootstrap
context files would enter the branch or evidence, including `AGENTS.md`,
`SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, or
`.openclaw/**`. The execution plan itself only emits sanitized ids, digests,
statuses, and decision fields.
