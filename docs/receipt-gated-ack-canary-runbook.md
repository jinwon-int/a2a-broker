# Receipt-gated ACK canary smoke runbook (#241)

Use this runbook for the #241/#168 closeout canary when validating that
terminal notification ACKs are gated on receipt evidence and that replay does
not create a duplicate Telegram flood. It is intentionally broker-safe: the
default path is dry-run/manual evidence only, does not deploy production, and
does not send Telegram messages.

Related trackers:

- Command center: `jinwon-int/a2a-broker#241`
- Plugin regression: `jinwon-int/openclaw-plugin-a2a#168`
- Plugin fix PR: `jinwon-int/openclaw-plugin-a2a#164`

## Safety rules

1. **Default to dry-run.** Do not enable notifier live delivery, deploy
   production, rotate secrets, or call Telegram from this runbook.
2. **ACK only after receipt evidence.** Gateway/provider send success is not
   sufficient. The broker ACK endpoint accepts only:
   - `operator_visible`
   - `operator_confirmed`
   - `provider_delivery_receipt`
3. **Live-send is a separate approval gate.** Any staged Telegram send must be
   approved explicitly by the command-center operator in the relevant issue
   thread before it is run. Keep those commands out of copy/paste default blocks.
4. **Redact sensitive data.** Evidence may include task ids, outbox ids,
   timestamps, cursors, ACK status, and sanitized summaries. Do not post bot
   tokens, chat ids, raw logs, transcript paths, or host-private secret paths.

## Preconditions

- Broker candidate includes receipt-gated terminal outbox ACK behavior.
- Plugin candidate includes the duplicate Telegram flood regression fix.
- Local checkout is clean except for the candidate under test.
- For live/staged checks, the command-center issue has named the operator,
  target environment, candidate SHAs, and rollback owner.

## Phase 0 — CI-safe proof

Run the broker tests that cover terminal outbox replay and receipt-gated ACK:

```bash
npm test
```

Minimum evidence to capture:

- test command and exit code;
- candidate broker SHA;
- candidate plugin SHA or PR reference;
- no secret-bearing output included.

## Phase 1 — Broker-only dry-run smoke

This phase verifies the ACK gate without contacting Telegram.

1. Start a local broker or use the PR validation broker instance.
2. Create or identify one terminal outbox record from a safe no-op task.
3. Poll the terminal outbox and record the returned `id`, cursor, and sanitized
   payload summary.
4. Attempt an invalid ACK using send-success-only evidence. The expected result
   is a non-2xx response with a message equivalent to: `receipt evidence` is
   required and provider send success alone is not accepted.
5. Reconcile with `reconcile_unacked=true` from the same cursor. The same record
   must still be replayable because it has not received receipt evidence.
6. ACK manually with receipt evidence only after a human-visible or simulated
   receipt is available:

```bash
curl -fsS -X POST "$BROKER_URL/a2a/tasks/terminal-outbox/ack" \
  -H "content-type: application/json" \
  -H "x-edge-secret: $BROKER_EDGE_SECRET" \
  --data '{
    "id": "<terminal-outbox-id>",
    "receipt": {
      "evidence": "operator_visible",
      "acknowledgedAt": "<iso8601>",
      "receiptId": "dry-run-manual-receipt-<short-id>",
      "note": "manual dry-run receipt for #241/#168 closeout"
    }
  }'
```

7. Re-poll/reconcile and verify the record reports `ack.status =
   receipt_confirmed` with the expected evidence and receipt id.

Pass criteria:

- invalid send-success-only ACK is rejected;
- unacknowledged record remains replayable across cursor reconciliation;
- valid receipt ACK records receipt metadata;
- no Telegram send occurs.

## Phase 2 — Duplicate replay guard dry-run

Use the same terminal outbox record or a controlled duplicate scenario.

1. Poll with the last saved cursor.
2. Poll again with `reconcile_unacked=true` from the cursor before ACK.
3. Confirm the notifier/plugin dry-run would dedupe by stable outbox `id` and
   would not enqueue a second Telegram delivery for the same id.
4. After valid receipt ACK, repeat reconciliation and confirm the record is no
   longer treated as an undelivered retry candidate.

Pass criteria:

- at most one delivery attempt is planned for each outbox `id`;
- replay before receipt does not advance the cursor in a way that hides the
  unacknowledged record;
- receipt ACK closes the retry candidate without deleting audit/replay evidence.

## Explicit approval gate for staged live-send

Do not run this section by default. A staged Telegram send is allowed only when a
command-center operator posts an explicit approval that names all of the
following:

- approved environment and node;
- exact broker/plugin/OpenClaw SHAs;
- Telegram target class (for example, a non-production operator test chat);
- maximum number of sends, normally `1`;
- rollback owner and stop condition.

After approval, the transport owner may execute their plugin/notifier-specific
staged send procedure outside this broker runbook. The broker-side closeout
still requires receipt evidence before ACK. If approval is absent, post `Block:`
evidence instead of attempting live delivery.

## Rollback / stop conditions

Stop immediately and preserve evidence if any of these occur:

- duplicate Telegram sends are observed or planned for the same outbox `id`;
- send-success-only evidence is accepted as an ACK;
- `reconcile_unacked=true` fails to replay an unacknowledged record;
- notifier/plugin dry-run cannot prove id-based dedupe;
- live-send approval is missing, ambiguous, or broader than one staged canary.

Rollback order for staged checks:

1. Disable/pause notifier live delivery first.
2. Preserve the last cursor, outbox id, receipt id, and notifier dedupe key.
3. Reconcile unacknowledged broker records with `reconcile_unacked=true`.
4. ACK only records with valid receipt evidence; leave the rest replayable.
5. Post `Block:` evidence with exact failed gate and rollback status.

## Evidence comment template

```markdown
Done: #241/#168 receipt-gated ACK canary smoke

Candidates:
- broker: <sha>
- plugin: <sha-or-PR-164>
- openclaw: <sha-if-live/staged>

CI-safe proof:
- command: npm test
- result: <exit-code/link>

Dry-run ACK gate:
- outbox id: <id>
- invalid ACK rejected: <yes/no + status/message>
- reconcile_unacked replayed before receipt: <yes/no>
- valid receipt evidence: <operator_visible/operator_confirmed/provider_delivery_receipt>
- ack status: <receipt_confirmed>

Duplicate guard:
- dedupe key: <outbox-id/plugin-key>
- planned Telegram sends for same id: <count>
- replay after receipt closed retry candidate: <yes/no>

Live-send gate:
- approved: <no / approval comment URL>
- sends executed: <0 unless explicitly approved>

Rollback/cleanup:
- notifier live delivery disabled or unchanged: <yes/no>
- unacknowledged records remain replayable: <yes/no/not-applicable>

Links:
- command center: https://github.com/jinwon-int/a2a-broker/issues/241
- plugin regression: https://github.com/jinwon-int/openclaw-plugin-a2a/issues/168
- plugin PR: https://github.com/jinwon-int/openclaw-plugin-a2a/pull/164
```
