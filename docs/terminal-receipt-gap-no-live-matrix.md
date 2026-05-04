# Terminal receipt gap no-live matrix

Issue: [#349](https://github.com/jinwon-int/a2a-broker/issues/349)  
Parent: [#294](https://github.com/jinwon-int/a2a-broker/issues/294)

This matrix is the validation/libero boundary for the six current post-cutoff terminal-outbox gaps seen after `2026-05-04T07:10:00.000Z`.

Safety contract:

- no provider API calls
- no live Telegram sends
- no SQLite mutation
- no production terminal-outbox ACK
- provider send acceptance is never treated as delivery/receipt confirmation

Run:

```bash
npm test
npm run terminal_receipt_gap_matrix
```

Expected proof shape:

- The six current post-cutoff gap-shaped rows stay **operator-visible**, **replayable**, and **not ACKed**.
- Receipt vocabulary states are covered: `accepted`, `sent`, `provider-delivered-if-known`, `operator-visible`, `timed_out`, `stale`, `failed`.
- ACK is modeled as allowed only for the positive-control case with real operator-visible/receipt-confirmed evidence; even that control performs no production ACK.
