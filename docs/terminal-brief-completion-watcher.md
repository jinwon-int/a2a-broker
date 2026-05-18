# Terminal Brief Completion Watcher

Issue #689 adds a read-only broker packet builder for Terminal Brief completion evidence. The watcher consumes sanitized terminal outbox events and prepares a structured broker-finalizer packet so the broker can decide the next step without rereading raw logs.

The watcher is intentionally not a closeout actor. It does not merge PRs, close issues, send providers, ACK terminal rows, restart services, mutate the broker database, replay history, publish releases, or move secrets.

## No-live quick run

Run:

    npm run terminal_brief_completion_watcher -- --input fixtures/terminal-brief/completion-watcher.no-live.json --markdown

The fixture models a completed three-worker round where all workers have PR or Done evidence and the last event carries 3/3 progress. Receipt status is still provider-only, so the output marks the closeout as a broker-finalizer candidate while preserving receipt gaps:

    Ready: terminal-brief completion watcher
    Mode: read-only/no-live
    Parent round: round-689-no-live
    Workers: expected=3 observed=3 ready=3 blocked=0 waiting=0 needsEvidence=0 conflicts=0
    Final count: 3/3 reached=true
    Receipt proof: confirmed=0 operatorVisible=0 providerOnly=3 failedOrStale=0

## Packet decisions

- ready_for_finalizer — every expected worker lane has terminal success and PR/Done evidence. The broker finalizer still decides whether to merge, close, comment, or ask for approval.
- blocked — missing expected worker events, missing PR/Done/Block evidence, failed/blocked/canceled lanes, or conflicting duplicate worker evidence.
- waiting — the round does not yet have enough terminal events, but no hard evidence conflict has been detected.

## Receipt boundary

Provider accepted/message-id evidence is never terminal ACK, read receipt, visibility proof, or operator approval. The packet records provider-only receipt gaps separately so closeout candidates cannot silently become ACKs.

ACK eligibility remains limited to receipt-confirmed evidence such as current-session visibility, operator-visible proof, operator confirmation, or provider delivery receipt.

## Safety boundary

This watcher is source/no-live safe. It only reads local JSON evidence and renders JSON or markdown. Any live provider send, terminal ACK/replay, Gateway or broker restart, DB mutation, historical replay, release/tag/npm publish, public GitHub merge/close action, or secret movement remains separately approval-gated.
