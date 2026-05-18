# Terminal Brief Sidecar Integration Rehearsal

Issue #693 adds a source/no-live integration rehearsal connecting the Terminal Brief sidecar dry-run/spool evidence path to the broker completion watcher and final-count closeout candidate builder.

The rehearsal consumes:

- broker terminal task events;
- Terminal Brief sidecar spool records such as a2a.terminalBrief.hermesGongyungAdapter.spool.v1;
- sidecar receipt decisions such as terminalReceiptStatus=produced.

It then derives final-count signals from the sidecar envelope title/text and renders the same broker-finalizer candidate produced by the final-count closeout layer.

## No-live quick run

Run:

    npm run terminal_brief_sidecar_integration_rehearsal -- --input fixtures/terminal-brief/sidecar-integration.no-live.json --markdown

The fixture models a three-worker round:

- sidecar spool records show bangtong(1/3), sogyo(2/3), and nosuk(3/3);
- every spool record has providerSend=false, terminalAck=false, and dryRunOnly=true;
- the sidecar receipt decision is ackTerminalEvent=false with terminalReceiptStatus=produced;
- broker terminal events have PR or Done evidence and produced receipt state.

Expected output starts with:

    Candidate: terminal-brief sidecar integration rehearsal
    Mode: read-only/no-live
    Parent round: round-693-no-live
    Sidecar spool: records=3 signals=3 dryRunOnly=true providerSendAttempted=false terminalAckAttempted=false
    Sidecar receipts: decisions=1 statuses=produced

## Decision Rules

- candidate: sidecar dry-run spool contains final N/N, broker worker evidence is ready, and no sidecar safety flags indicate provider send or terminal ACK.
- blocked: partial M/N, conflicting final counts, missing worker evidence, provider-send attempt, terminal-ACK attempt, or missing/unsafe sidecar dry-run safety flags.
- waiting: no final-count sidecar evidence has appeared yet.

## Receipt Boundary

Sidecar spool and terminalReceiptStatus=produced are not terminal ACK, read receipt, visibility proof, or operator approval. They are useful for cursor/rehearsal evidence only. The broker finalizer candidate must preserve receipt gaps until current-session-visible or manual operator receipt evidence exists.

## Safety Boundary

This rehearsal is source/no-live safe. It reads local JSON and renders JSON or markdown. It does not merge pull requests, close issues, send providers, ACK terminal rows, restart Gateway/broker/worker/sidecar services, mutate the broker database, replay history, publish releases, or move secrets.
