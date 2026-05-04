# Receipt/Release Gate Validation Matrix

Issue: `jinwon-int/a2a-broker#343`  
Parent: `jinwon-int/a2a-broker#294`  
Run: `a2a-receipt-release-gate-20260504092730`

This matrix is the read-only validation lane for receipt/release gates. It uses synthetic
fixtures and local test databases only: no production deploy, Gateway restart, live
Telegram send, DB mutation, all-worker live smoke, or real terminal-outbox ACK.

| Scenario | Gate surface | Fixture/proof | Expected result | Guardrail asserted |
| --- | --- | --- | --- | --- |
| S1 healthy clean gate | Migration health gate + live-readiness canary | Current schema/state versions, normalized worker row, receipt-confirmed terminal outbox ACK with `provider_delivery_receipt`, empty queue, canonical HTTP PR/Done/Block evidence | Pass | Clean broker/plugin/runner-style output remains releasable. |
| S2 legacy residue accepted only under explicit cutoff | Migration health gate | Accepted-only terminal outbox row created before `legacyResidueCutoff` | Pass only when cutoff is provided; fail without cutoff | Legacy residue is quarantined, reported, and never silently ACKed. |
| S3 post-cutoff receipt gap fails | Migration health gate | Accepted-only terminal outbox row created after cutoff and older than `maxUnackedAgeMs` | Fail | Current receipt gaps produce `stale_unacked_receipt_evidence`. |
| S4 non-zero queue/stale fails | Live-readiness canary | Diagnostics fixture with `queued=1` and `stale=1` | Fail | Release readiness blocks until queued/claimed/running/stale counts are zero. |
| S5 missing/invalid canonical evidence fails | Live-readiness canary | Terminal event with non-HTTP evidence URL and send-only `provider_sent` receipt evidence | Fail | Terminal evidence must be canonical HTTP PR/Done/Block evidence and receipt evidence must be operator-visible/confirmed or provider-delivery. |

Focused validation commands:

```sh
npm test
node --test scripts/broker-migration-health-gate.test.mjs scripts/broker-live-readiness-canary.test.mjs
node scripts/broker-live-readiness-canary.mjs --no-live --json
```

Focused expected outputs:

- `npm test`: all TypeScript build/unit gates pass.
- Script tests: named S1-S5 fixtures pass, including explicit negative assertions for S2 without cutoff, S4 queue/stale, and S5 canonical evidence.
- No-live canary JSON: `ok: true`, `mode: "no-live"`, `brokerHttpRequested: false`, `dbMutationAttempted: false`, `terminalAckAttempted: false`.
