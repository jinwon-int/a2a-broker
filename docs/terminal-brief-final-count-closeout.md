# Terminal Brief Final-Count Closeout Candidate

Issue #690 adds a read-only layer on top of the Terminal Brief completion watcher. It consumes a final-count signal such as (3/3), combines it with worker terminal-event evidence, and prepares a broker finalizer candidate.

This is not an autonomous closeout actor. It does not merge pull requests, close issues, send providers, ACK terminal rows, restart Gateway/broker/worker/sidecar services, mutate the broker database, replay history, publish releases, or move secrets.

## No-live quick run

Run:

    npm run terminal_brief_final_count_closeout -- --input fixtures/terminal-brief/final-count-closeout.no-live.json --markdown

The fixture models a completed three-worker round:

- the Terminal Brief envelope contains a final (3/3) signal;
- each expected worker has terminal success evidence;
- each successful worker has PR or Done evidence;
- receipt evidence is still provider-only, so the packet keeps the receipt boundary explicit.

Expected output starts with:

    Candidate: terminal-brief final-count closeout
    Mode: read-only/no-live
    Parent round: round-690-no-live
    Trigger: 3/3 source=envelope
    Completion watcher: ready_for_finalizer (candidate)

## Decisions

- candidate: the final-count signal reached N/N and the completion watcher is ready for a broker finalizer review.
- blocked: a partial M/N signal, conflicting final counts, missing worker evidence, missing PR/Done/Block evidence, failed worker evidence, or duplicate worker conflict prevents closeout.
- waiting: no final-count signal has been observed yet.

The final-count layer is stricter than a notification parser. A final (N/N) message is only a trigger for broker review. The broker finalizer still owns any irreversible action.

## Idempotency and conflicts

Duplicate final (N/N) messages for the same parent round and worker evidence produce the same idempotency key. This lets repeated Terminal Brief notifications wake the broker without creating duplicate closeout work.

Conflicting totals fail closed. For example, observing both (3/3) and (4/4) in the same parent round blocks the candidate and requires manual evidence review.

## Receipt boundary

Provider accepted/message-id evidence is never terminal ACK, read receipt, visibility proof, or operator approval. The underlying completion watcher carries receipt gaps into the final-count candidate so broker automation cannot silently upgrade provider send evidence into operator-visible completion.

## Safety boundary

This module is source/no-live safe. It only reads local JSON evidence and renders JSON or markdown. Live provider send, terminal ACK/replay, Gateway or broker restart, DB mutation, historical replay, release/tag/npm publish, public GitHub merge/close action, and secret movement remain separately approval-gated.
