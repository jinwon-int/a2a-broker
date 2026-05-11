# Source-public approval rehearsal packet

Issue: [#484](https://github.com/jinwon-int/a2a-broker/issues/484)  
Parent: [a2a-plane#211](https://github.com/jinwon-int/a2a-plane/issues/211)  
Run: `a2a-source-public-approval-rehearsal-20260511T014240Z`  
Lane: Team2 — dungae

This lane adds a deterministic, read-only source-public approval rehearsal. It
builds approval packets and evidence bundles before any real source-public
execution. It does **not** approve, publish, change repository visibility,
deploy, restart Gateway/broker/workers, send provider/Telegram traffic, mutate a
production database, or ACK a Terminal Brief.

## Local command

```bash
npm run source_public_approval_rehearsal -- --json \
  --run-id a2a-source-public-approval-rehearsal-20260511T014240Z \
  --worker dungae \
  --repo jinwon-int/a2a-broker \
  --issue 484
```

Use repeated `--evidence key=pass|warn|fail|pending` flags to bind the packet to
known evidence status. The default is conservative: evidence is `pending` and the
decision is `NEEDS_OPERATOR_APPROVAL` unless a gate fails, in which case it is
`NO_GO`.

## Packet contents

The bundle contains:

- a deterministic approval packet (`packetId`, `intentId`, `idempotencyKey`, and
  `requestFingerprint`);
- an idempotent approval-intent rehearsal record with `persistence: not-written`
  and `mutationAttempted: false`;
- integrated sanitized evidence status fields;
- a no-live Terminal Brief rehearsal proving `liveProviderSendAttempted: false`
  and `terminalAckAttempted: false`;
- replay/no-duplicate proof using the stable idempotency key;
- rollback/abort paths; and
- one decision value: `GO_CANDIDATE`, `NO_GO`, or `NEEDS_OPERATOR_APPROVAL`.

`GO_CANDIDATE` is still not execution authorization. A real source-public
visibility/release action requires a separate, explicit operator-approved live
run.

## Safety and redaction invariants

The rehearsal exports only sanitized fields such as run id, repository, issue,
packet ids, check statuses, and the decision. It intentionally excludes raw
prompts, raw logs, secrets, host-private paths, provider-send-only success, and
OpenClaw runtime/bootstrap context evidence.

Before any PR, fail closed if runtime/bootstrap context files would be added to
the branch or packet evidence, including `AGENTS.md`, `SOUL.md`, `USER.md`,
`TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, or `.openclaw/**`.

## Replay / duplicate handling

The approval-intent rehearsal record is derived from stable run/action fields.
Passing `--prior-intent-id <intentId-or-idempotencyKey>` marks the run as a
replay and returns the same logical record without writing a duplicate. The
script and core builder never persist this record; production storage remains the
responsibility of a later explicitly approved live path.

## Abort / rollback

Abort instead of executing if any gate fails or remains pending before the live
source-public action. Since the rehearsal is read-only and writes no broker state,
rollback is limited to superseding/closing the packet and rerunning with corrected
evidence. Any future visibility/release action needs a fresh explicit operator
approval.
