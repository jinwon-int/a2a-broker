# Terminal Notifications Release Smoke and Rollback Runbook

Use this runbook before cutting a broker release that changes `task.terminal` notification delivery, outbox replay, or notifier integration. It is intentionally safe for PR validation: it does **not** deploy live services and it does **not** send Telegram messages.

## Scope and ownership

- Broker responsibility: expose compact, replayable terminal notification records over HTTP/SSE.
- Notifier responsibility: poll or subscribe, dedupe by `event.id`, deliver to Telegram/OpenClaw, and acknowledge delivered records.
- Required workers for a Round 3 fleet smoke: `bangtong,dungae,sogyo,nosuk`.
- Explicitly exclude `yukson` from fleet checks unless an operator approves a different cohort.

## Release smoke sequence

Run from the broker checkout.

1. Verify the code path and transport contract without external delivery:

   ```sh
   npm test -- --test-name-pattern "operator terminal push envelopes|terminal-outbox"
   ```

2. For release dry-runs where no live broker may be contacted, produce the
   deterministic no-live terminal payload proof:

   ```sh
   npm run terminal_outbox_preflight -- --no-live --json
   ```

   Pass evidence must include `mode: "no-live"`, `providerCalled: false`,
   `productionAckAttempted: false`, `brokerHttpRequested: false`, and a
   `terminal payload dry-run` preview. This mode is synthetic and must not
   contact a broker, deploy, restart Gateway, send Telegram, mutate a DB, or ACK
   a terminal-outbox record.

3. Run the standard release gate in CI-safe mode:

   ```sh
   npm run docker_runtime_preflight -- --dry-run
   npm run release_gate
   ```

4. Before any smoke that could hand off to a notifier, run the read-only broker
   preflight against the candidate broker. This checks `/health`, polls the
   terminal outbox, and replays with `reconcile_unacked=true` without calling
   the ACK endpoint or any Telegram transport:

   ```sh
   BROKER_URL="${BROKER_URL:-http://127.0.0.1:8787}" \
     BROKER_EDGE_SECRET="${BROKER_EDGE_SECRET:-}" \
     npm run terminal_outbox_preflight -- --json
   ```

   Pass evidence should show `broker health`, `terminal-outbox poll`,
   `terminal-outbox replay`, and `ack safety` as passing. An empty outbox is
   acceptable for a no-op preflight; any non-HTTP evidence URL, missing stable
   outbox id, auth failure, or failed replay is a Block.

5. If validating the Round 3 worker cohort against a disposable or approved broker, require only the active workers:

   ```sh
   npm run smoke:docker-broker:fleet -- --require-workers bangtong,dungae,sogyo,nosuk
   ```

6. Capture pass evidence in the PR/Done comment: commands, exit codes, and the sanitized release-gate summary. Do not paste secrets, raw logs, private paths, or session transcripts.

## Telegram-safe dry-run notification

Use the broker outbox directly. This proves the payload that the notifier would send while avoiding Telegram delivery.

```sh
BROKER_URL="${BROKER_URL:-http://127.0.0.1:8787}"
EDGE_SECRET="${BROKER_EDGE_SECRET:?set BROKER_EDGE_SECRET for protected brokers}"

curl -fsS "$BROKER_URL/a2a/tasks/terminal-outbox?limit=5" \
  -H "x-a2a-edge-secret: $EDGE_SECRET" \
  -H "x-a2a-requester-id: release-smoke" \
  -H "x-a2a-requester-role: operator" \
  | node -e '
      let body="";
      process.stdin.on("data", c => body += c);
      process.stdin.on("end", () => {
        const outbox = JSON.parse(body);
        const previews = (outbox.events || []).map((event) => ({
          dryRun: true,
          wouldSendTo: "operator-telegram",
          cursor: event.id,
          status: event.payload?.status,
          worker: event.payload?.worker,
          repo: event.payload?.repo,
          issue: event.payload?.issue,
          prUrl: event.payload?.prUrl,
          doneUrl: event.payload?.doneUrl,
          blockUrl: event.payload?.blockUrl,
          testSummary: event.payload?.testSummary,
        }));
        console.log(JSON.stringify({ kind: "terminal-notification.dry-run", count: previews.length, previews }, null, 2));
      });
    '
```

Expected result:

- `kind` is `terminal-notification.dry-run`.
- Each preview has `dryRun: true` and a stable `cursor`.
- No Telegram API, bot token, chat id, raw log, transcript, or private local path appears.
- `prUrl`, `doneUrl`, and `blockUrl` are HTTP(S) evidence links only.

Only after the dry-run is clean may a notifier owner run their own transport-specific dry-run or staged delivery. Do not enable live Telegram delivery from this broker runbook.

## Auth and rate-limit safety checks

For protected brokers, terminal outbox routes must be accessed as `hub` or `operator` and must include the edge secret. Confirm failures are safe before release:

```sh
# Missing edge secret should fail when BROKER_EDGE_SECRET is configured.
curl -s -o /dev/null -w "%{http_code}\n" \
  "$BROKER_URL/a2a/tasks/terminal-outbox" \
  -H "x-a2a-requester-id: release-smoke" \
  -H "x-a2a-requester-role: operator"

# Wrong role should fail even with the edge secret.
curl -s -o /dev/null -w "%{http_code}\n" \
  "$BROKER_URL/a2a/tasks/terminal-outbox" \
  -H "x-a2a-edge-secret: $EDGE_SECRET" \
  -H "x-a2a-requester-id: release-smoke" \
  -H "x-a2a-requester-role: analyst"

# Valid operator request should expose rate-limit headers.
curl -fsS -D - -o /dev/null "$BROKER_URL/a2a/tasks/terminal-outbox?limit=1" \
  -H "x-a2a-edge-secret: $EDGE_SECRET" \
  -H "x-a2a-requester-id: release-smoke" \
  -H "x-a2a-requester-role: operator" \
  | grep -iE '^(x-a2a-ratelimit-bucket|x-ratelimit-limit|x-ratelimit-remaining|x-ratelimit-reset):'
```

Treat missing auth failures, missing rate-limit headers, or unexpected raw payload fields as release blockers.

## Rollback plan

Rollback is transport-first, then broker-first:

1. Disable or pause the notifier transport so Telegram stops receiving new messages. Preserve its last saved cursor.
2. Keep the broker running if possible; the outbox remains replayable until retention evicts old records.
3. If the broker release itself must roll back, restore the previous image/config and restart using the existing deploy procedure. Do not change secrets as part of rollback unless compromise is suspected.
4. After rollback, poll `/a2a/tasks/terminal-outbox` with the notifier's preserved cursor and compare pending records to the last delivered Telegram/OpenClaw message.
5. Resume the notifier with the preserved cursor. Acknowledge only records actually delivered by the notifier.
6. Post Block/Done evidence with the rollback version, cursor, pending count, and sanitized smoke output.

## Stop conditions

Stop and post Block evidence if any of these occur:

- Release gate or terminal notification tests fail.
- Dry-run payload contains secrets, chat IDs, local paths, raw logs, transcripts, or non-HTTP evidence URLs.
- Auth checks allow unauthenticated/unauthorized outbox access.
- Rate-limit headers are absent on successful outbox requests.
- Worker fleet smoke includes `yukson` without explicit operator approval.
- A step requires live deploy or live Telegram delivery and no operator has approved it.
