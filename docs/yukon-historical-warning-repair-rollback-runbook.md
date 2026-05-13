# Yukon Lane — Bounded Historical Warning Repair and Rollback

> Issue: [#581](https://github.com/jinwon-int/a2a-broker/issues/581)
> Parent: [#577](https://github.com/jinwon-int/a2a-broker/issues/577)
> Root bug: [#576](https://github.com/jinwon-int/a2a-broker/issues/576)
> Run: `a2a-r10-terminal-outbox-ack-persistence-20260513T1654Z`
> Round: R10 all-hands — terminal-outbox ACK SQLite persistence closeout

## Lane overview

Yukon lane documents the operator-safe bounded procedure for inspecting,
backing up, auditing, and — if explicitly approved — rolling back terminal-outbox
historical warning patterns detected by the backlog risk analyzer
([`src/core/terminal-outbox-backlog-risk.ts`](../src/core/terminal-outbox-backlog-risk.ts)).

This runbook covers the **read-only evidence and rollback-planning path only**.
It does not authorise any production DB mutation, live provider send, terminal
ACK, Gateway restart, or state repair without fresh explicit operator approval.

### Warning signals addressed

See `analyzeTerminalOutboxBacklogRisk()` in `terminal-outbox-backlog-risk.ts`:

| Signal kind | Meaning | Default threshold |
|---|---|---|
| `high_unacked_ratio` | Unacked entries exceed ratio of total | > 50 % |
| `unacked_accumulation` | Absolute unacked count above warning or critical | Warning: 100; Critical: 500 |
| `stale_unacked_entry` | Oldest unacked row exceeds age threshold | Warning: 7d; Critical: 30d |
| `provider_send_only_stall` | Provider-sent/accepted events without operator-visible receipt | > 0 |
| `ack_eligible_stall` | ACK-eligible but unconfirmed events | > 0 |
| `stale_receipt_blindspot` | Unacked events with `stale` receipt status | > 0 |

### Safety boundary

| Action | Permitted in this lane? |
|---|---|
| Read-only outbox poll / backlog analysis | ✅ Yes — `terminal-outbox-preflight.mjs` with `--no-live` |
| Read-only SQLite diagnostic query | ✅ Yes — `terminal-receipt-closeout-report.mjs` |
| SQLite WAL snapshot backup (read-only copy) | ✅ Yes — offline file copy with broker stopped, or SQLite backup API during low activity |
| Audit note / evidence comment | ✅ Yes — GitHub issue/PR comment via `terminal-brief-evidence.ts` |
| Bounded rollback plan (JSON file) | ✅ Yes — generated plan document; not applied |
| DB mutation / repair | ❌ No — requires fresh explicit operator (Seoseo) approval |
| Terminal-outbox ACK | ❌ No — provider send/success evidence alone is not terminal ack evidence |
| Provider replay / send | ❌ No — historical records must not be replayed to notifier |
| Gateway restart / reload | ❌ No — approval-gated operational work per R4 activation runbook |
| Live deploy / release | ❌ No — separate operator approval chain |
| Secret / visibility change | ❌ No — must not alter outbox row visibility or access control |

---

## Step 1 — Read-only warning detection

Run the backlog risk analyzer against the terminal-outbox snapshot without
contacting the notifier or mutating any broker state:

```sh
# Build first so the module is available
npm run build

# Read-only preflight with no-live mode (no broker HTTP call, no provider send)
npm run terminal_outbox_preflight -- --no-live --json
```

Expected output shape (the checker runs synchronously with synthetic payloads):

```json
{
  "kind": "terminal-outbox.no-live-proof",
  "mode": "no-live",
  "providerCalled": false,
  "productionAckAttempted": false,
  "brokerHttpRequested": false,
  "ok": true
}
```

For live broker polling (still read-only, no ACK):

```sh
npm run terminal_outbox_preflight -- \
  --base-url http://127.0.0.1:8787 \
  --limit 100 \
  --json
```

Examine the `events` field for unacked records and review the `readiness`
blockers. An `ok: false` result with blockages such as `staleCursorOrReplayCandidates`
or `missing PR/Done/Block evidence` indicates historical warning signals.

### Script reference

| Property | Meaning |
|---|---|
| `checks[].ok` | Per-check pass/fail |
| `checks[].readiness.unackedCount` | Total unacked events in snapshot |
| `checks[].readiness.receiptConfirmedCount` | Events with confirmed ACK |
| `checks[].readiness.staleCursorOrReplayCandidates` | Stale receipt or replay-overlap candidates |
| `checks[].readiness.blockers` | Human-readable blockage reasons |

---

## Step 2 — Read-only receipt closeout diagnostic

Generate the operator receipt closeout report from the SQLite database directly.
This marks receipt gaps as `currentPostCutoff` vs `legacyResidue` without
sending notifications or ACKing rows:

```sh
npm run terminal_receipt_closeout_report -- \
  --db /var/lib/a2a-broker/state.sqlite \
  --legacy-residue-cutoff 2026-05-04T07:10:00.000Z \
  --json
```

For a human-readable table:

```sh
npm run terminal_receipt_closeout_report -- \
  --db /var/lib/a2a-broker/state.sqlite \
  --legacy-residue-cutoff 2026-05-04T07:10:00.000Z \
  --markdown
```

### Report safety

```json
{
  "safety": {
    "readOnly": true,
    "rawPayloadsIncluded": false,
    "notifierSendAttempted": false,
    "terminalAckAttempted": false,
    "dbMutationAttempted": false
  }
}
```

`rawPayloadsIncluded=false` means the report redacts token-shaped content and
local paths. It never includes session transcripts, raw logs, or secret values.

### Key diagnostic fields

| Field | Purpose |
|---|---|
| `summary.currentPostCutoffGapCount` | Unacked events created after the legacy cutoff — **real gaps** |
| `summary.legacyResidueGapCount` | Unacked events before the cutoff — quarantined historical residue |
| `summary.receiptConfirmedRows` | Events with receipt-confirmed ACK evidence |
| `currentPostCutoff[].receiptState` | E.g. `unacked:provider_sent`, `unacked:accepted`, `invalid_ack` |
| `currentPostCutoff[].remediationHint` | Operator-facing next step hint (never implies action) |
| `legacyResidue[].receiptState` | E.g. `legacy_delivered_at:accepted` for pre-ACK snapshot migrations |

---

## Step 3 — Safe SQLite WAL backup

Before any rollback planning, create a read-only WAL-consistent snapshot of the
SQLite database for audit evidence. This is the **record of what was observed**,
not a mutation.

### Option A — Broker stopped (preferred)

```sh
# Stop the broker first (operator approval required)
# Then copy the SQLite triple atomically
cp /var/lib/a2a-broker/state.sqlite    /var/lib/a2a-broker/backups/state.r10-yukon-backup.sqlite
cp /var/lib/a2a-broker/state.sqlite-wal /var/lib/a2a-broker/backups/state.r10-yukon-backup.sqlite-wal 2>/dev/null || true
cp /var/lib/a2a-broker/state.sqlite-shm /var/lib/a2a-broker/backups/state.r10-yukon-backup.sqlite-shm 2>/dev/null || true
```

### Option B — Online backup with SQLite backup API (no stop required)

```sh
node -e "
const { DatabaseSync } = require('node:sqlite');
const src = new DatabaseSync('/var/lib/a2a-broker/state.sqlite', { readOnly: true });
src.exec(\"VACUUM INTO '/var/lib/a2a-broker/backups/state.r10-yukon-<RUNTAG>.sqlite'\");
src.close();
console.log('OK: read-only vacuum backup created');
"
```

### Option C — JSON export

```sh
npm run export:sqlite -- \
  --db /var/lib/a2a-broker/state.sqlite \
  --out /var/lib/a2a-broker/backups/state.r10-yukon-<RUNTAG>.json
```

### Backup metadata file

Alongside the backup file, write a minimal audit metadata file describing what
was backed up and the constraints in effect:

```json
{
  "kind": "a2a-broker.backup.audit-metadata",
  "version": 1,
  "backupFile": "state.r10-yukon-<RUNTAG>.sqlite",
  "sourceDb": "/var/lib/a2a-broker/state.sqlite",
  "createdAt": "<ISO-8601>",
  "run": "a2a-r10-terminal-outbox-ack-persistence-20260513T1654Z",
  "lane": "yukon",
  "safetyConstraints": [
    "no provider replay/send",
    "no terminal ACK",
    "no DB mutation/repair",
    "no Gateway restart/reload",
    "no live deploy/release",
    "no secret/visibility change"
  ],
  "operatorNotes": "Read-only backup for bounded historical warning audit. Not a rollback checkpoint — rollback requires separate approval.",
  "evidenceUrls": {}
}
```

---

## Step 4 — Audit note (GitHub evidence comment)

Document the observed warning signals as a bounded evidence comment on the
parent issue (#577) via the Terminal Brief evidence projection. The comment must
**not** call terminal-outbox ACK APIs, mark read/visibility state, imply
operator approval, mutate production DB, or perform live sends.

### Via the Terminal Brief evidence helper

The `TerminalBriefGitHubEvidenceProjection` in
[`src/github/terminal-brief-evidence.ts`](../src/github/terminal-brief-evidence.ts)
renders manifest-bound comments with stable idempotency keys:

| Marker | When to use |
|---|---|
| `Start` | First observation of historical warning signals |
| `Block` | Confirmed stale/provider-send-only backlog that prevents closeout |
| `Done` | Warning acknowledged with audit note after backup capture |

### Audit note content rules

The evidence comment body must:

1. State the run (`a2a-r10-terminal-outbox-ack-persistence-20260513T1654Z`)
2. List each observed warning signal with count and severity
3. Reference the backup file name (not absolute paths containing secrets)
4. Include the idempotent safety statement:
   > "No provider replay/send, terminal ACK, DB mutation, Gateway restart,
   > deploy/release, or secret/visibility change was performed or is implied
   > by this audit note."
5. Link to the preflight or closeout report that was run (evidence URL)
6. **Not** include raw logs, session transcripts, secrets, or private local paths

### Example audit note (Block marker)

```markdown
**🔴 Yukon Lane — Historical Warning Audit (Block)**

Run: `a2a-r10-terminal-outbox-ack-persistence-20260513T1654Z`

| Signal | Count | Severity |
|---|---|---|
| `stale_unacked_entry` | 12 | Critical |
| `unacked_accumulation` | 450 | Warning |
| `provider_send_only_stall` | 8 | Warning |
| `stale_receipt_blindspot` | 3 | Warning |

**Backup:** `state.r10-yukon-backup.sqlite` (WAL-consistent snapshot)

**Safety statement:** No provider replay/send, terminal ACK, DB mutation,
Gateway restart, deploy/release, or secret/visibility change was performed
or is implied by this audit note.

**Evidence:** [Preflight report](#link-to-preflight-json)
**Next step:** Awaiting operator (Seoseo) approval before any repair/rollback action.
```

---

## Step 5 — Rollback plan (document only; do not apply)

If operator approval is granted for a rollback, document the exact bounded
rollback steps here. **This section is a template for the plan only** — executing
it requires fresh explicit operator (Seoseo or designated approver) consent per R10
safety policy.

### Prerequisites for rollback approval

- [ ] Backup metadata file exists with SHA-256 digest
- [ ] Preflight report shows no active provider-send-in-flight state that would
      be orphaned by rollback
- [ ] No unapproved DB mutation has occurred since the backup was taken
- [ ] Gateway/notifier path is confirmed to be in no-live/dry-run mode per the
      no-replay constraint
- [ ] Exact terminal-outbox rows to be affected are identified by stable event id
- [ ] Rollback scope is bounded — only the specific historical warning rows, not
      the entire outbox

### Rollback steps (not to be executed without approval)

A rollback means reverting the terminal-outbox to a previous safe snapshot
**without** replaying any records to the notifier. The approved rollback
procedure would follow these steps in order:

1. **Stop the broker** (with operator approval):
   ```sh
   # e.g., systemctl stop a2a-broker
   ```

2. **Confirm no-live notifier state** — verify the notifier/plugin is in
   dry-run or disabled mode so that any post-restore replay stays bounded:
   ```sh
   # Read-only check; no config mutation
   curl -s http://127.0.0.1:8787/health | jq '.persistence'
   ```

3. **Restore the SQLite backup** (overwrite the current state with the
   pre-warning snapshot):
   ```sh
   cp /var/lib/a2a-broker/backups/state.r10-yukon-backup.sqlite \
      /var/lib/a2a-broker/state.sqlite
   rm -f /var/lib/a2a-broker/state.sqlite-wal /var/lib/a2a-broker/state.sqlite-shm
   ```

4. **JSON fallback** — if the SQLite restore is unavailable, re-import the
   JSON snapshot export through the broker's native JSON import:
   ```sh
   STATE_FILE=/var/lib/a2a-broker/backups/state.r10-yukon-backup.json \
   npm start
   # Then stop and restart with the normal config
   ```

5. **Run read-only preflight** to confirm no historical warning rows remain:
   ```sh
   npm run terminal_outbox_preflight -- --base-url http://127.0.0.1:8787 --json
   ```

6. **Run receipt closeout report** to confirm only expected receipt-confirmed
   rows exist:
   ```sh
   npm run terminal_receipt_closeout_report -- \
     --db /var/lib/a2a-broker/state.sqlite \
     --legacy-residue-cutoff 2026-05-04T07:10:00.000Z
   ```

7. **Verify replay cursor consistency** — after restore, run a reconcile poll
   to confirm that no duplicate replay records appear:

   ```sh
   # Read-only reconcile poll using terminal-outbox HTTP adapter
   curl -s 'http://127.0.0.1:8787/a2a/tasks/terminal-outbox?reconcile_unacked=true&limit=5' | jq '.events | length'
   # Expected: 0 or only receipt-confirmed entries at/before cursor
   ```

8. **Post a Done audit comment** on the parent issue confirming the bounded
   rollback, with explicit reference to the operator approval that authorised it.

### Safety gates for rollback execution

| Gate | Description |
|---|---|
| Operator approval | Fresh explicit Seoseo/operator approval message or issue comment |
| No-live notifier | Notifier/plugin confirmed in dry-run/disabled mode before and after |
| Bounded scope | Only the specific historical warning rows — not a full state reset |
| Pre-rollback backup | Current (pre-restore) state backed up as evidence |
| Post-rollback verification | Preflight + receipt closeout report pass before restarting notifier |
| Audit trail | Start/Block/Done comments on the parent issue documenting every action |

---

## No-provider-replay/send constraint

This is the most critical safety constraint in this lane. Historical terminal-outbox
rows **must never be replayed** to the notifier, even if they appear replayable
through `subscribeWithCursor()` / `reconcile()`.

### What is NOT a replay

| Action | Is replay? |
|---|---|
| Read-only `GET /a2a/tasks/terminal-outbox` poll | ❌ No — read-only observation |
| `reconcile_unacked=true` HTTP parameter | ❌ No — returns retained rows for inspection |
| Running `terminal-outbox-preflight.mjs` | ❌ No — read-only diagnostic |
| `terminal-receipt-closeout-report.mjs` | ❌ No — offline SQLite diagnostic |
| Creating a GitHub evidence comment | ❌ No — evidence ledger entry only |
| Reading an in-memory cursor from a crash recovery | ❌ No — internal cursor state is not a send |

### What IS a replay

| Action | Is replay? | Why it is blocked |
|---|---|---|
| Calling notifier plugin SSE/subscribe after restore | ✅ **Yes — BLOCKED** | Historical rows would be re-emitted to Telegram/operator |
| Automatic `subscribeWithCursor()` reconnection in notifier code | ✅ **Yes — BLOCKED** | Notifier reconnection must be gated by operator after rollback |
| Passing retained historical rows to `POST /a2a/tasks/terminal-outbox/ack` | ✅ **Yes — BLOCKED** | Terminal ACK requires fresh current-session-visible or operator-visible evidence |
| Any cron/webhook that pushes historical outbox state to external transport | ✅ **Yes — BLOCKED** | Only the notifier owns delivery, and only for new (post-rollback) records |
| Any implicit cursor advancement that causes a historical row to be 'new' again | ✅ **Yes — BLOCKED** | Cursor advancement alone is not operator-visibility or ACK evidence |

### Preventing replay after backup/restore

After any SQLite backup or restore operation:

1. Verify the notifier is in **dry-run / no-live mode** before allowing it to
   reconnect.
2. Run `terminal_outbox_preflight --no-live --json` to confirm the candidate
   state without any notifier interaction.
3. Clear or reset the notifier's `after_id` cursor only in coordination with
   the notifier operator. A stale notifier cursor can cause retained rows to be
   re-fetched as 'new'.
4. The notifier must be restarted with an explicit cursor reset (set
   `after_id` to the current stable cursor), not with the old pre-restore cursor.

### Audit log of no-replay evidence

For each observation or backup, record in the audit note:

```
No-replay check:
- Notifier confirmed in dry-run: yes/no
- Reconcile poll after_id set to current cursor: yes/no
- No historical rows passed to external transport: yes/no
- No terminal ACK called: yes/no
- No cursor advancement used as ACK evidence: yes/no
```

---

## Rollback restore procedure (documentation only)

This section describes the full restore sequence for operator reference. It must
not be executed without explicit operator approval as documented above.

### Pre-approval checklist

- [ ] Backup file exists with SHA-256 digest recorded in audit metadata
- [ ] Current (pre-restore) state is backed up separately
- [ ] Notifier/plugin confirmed in dry-run/disabled mode
- [ ] Operator approval comment exists on the parent issue
- [ ] All terminal-outbox row ids to be affected are identified
- [ ] Scope is bounded — only the historical warning rows, not the full outbox

### Restore sequence (requires approval)

```
1. STOP broker                          → systemctl stop a2a-broker
2. CONFIRM notifier dry-run             → verify plugin config; no-live env
3. BACKUP current state                 → cp state.sqlite backups/state.pre-rollback.sqlite
4. RESTORE backup                       → cp backups/state.r10-yukon-backup.sqlite state.sqlite
5. CLEAN WAL/SHM                        → rm -f state.sqlite-wal state.sqlite-shm
6. START broker                         → systemctl start a2a-broker
7. VERIFY preflight (read-only)         → npm run terminal_outbox_preflight -- --no-live --json
8. VERIFY receipt closeout report       → npm run terminal_receipt_closeout_report -- --db state.sqlite
9. VERIFY reconcile poll (read-only)    → curl .../terminal-outbox?reconcile_unacked=true&limit=5
10. POST audit comment (Done marker)    → parent issue #577
11. CLEAR notifier cursor               → set after_id to current stable cursor
12. ENABLE notifier (operator approval) → switch from dry-run to live
```

---

## Related runbooks

| Runbook | Purpose |
|---|---|
| [`operator-terminal-outbox.md`](operator-terminal-outbox.md) | Overall terminal-outbox contract, HTTP adapter, operator read model |
| [`sqlite-persistence.md`](sqlite-persistence.md) | SQLite backup, restore, WAL handling |
| [`terminal-brief-r4-automatic-receipt-ack-runbook.md`](terminal-brief-r4-automatic-receipt-ack-runbook.md) | R4 activation, receipt vocabulary, provider-send vs ACK |
| [`receipt-gated-ack-canary-runbook.md`](receipt-gated-ack-canary-runbook.md) | Receipt-gated ACK canary smoke procedure |
| [`closeout-reconcile-runbook.md`](closeout-reconcile-runbook.md) | Closeout drift detection and recovery |

## Implementation reference

| File | Purpose |
|---|---|
| `docs/yukon-historical-warning-repair-rollback-runbook.md` | This document |
| `src/core/terminal-outbox-backlog-risk.ts` | Warning signal detection |
| `src/core/terminal-outbox-backlog-risk.test.ts` | Warning signal tests |
| `src/core/terminal-event-outbox.ts` | Outbox record model, ack/receipt state |
| `scripts/terminal-outbox-preflight.mjs` | Read-only preflight checker |
| `scripts/terminal-receipt-closeout-report.mjs` | Read-only receipt closeout diagnostic |
| `scripts/broker-cleanup-safe-prune.mjs` | Safe SQLite row ID plan/execute (approval-gated) |
| `src/github/terminal-brief-evidence.ts` | GitHub evidence comment projection |

## Explicit safety statement

This runbook is documentation only. It does not authorise:

- Production DB mutation, repair, or manual terminal-outbox ACK
- Provider replay, resend, or historical notifier dispatch
- Gateway restart, reload, deploy, or release
- Secret exposure, visibility change, access control change
- Force-push to any branch
- Any action on a live production broker without fresh explicit Seoseo/operator
  approval recorded as a GitHub issue comment on the parent issue.

**Provider accepted/send evidence is not terminal ACK evidence.**
