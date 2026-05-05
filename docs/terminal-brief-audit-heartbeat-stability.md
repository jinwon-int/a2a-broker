# Terminal Brief audit/heartbeat stability

This runbook keeps Terminal Brief validation receipt-safe while reducing noisy broker audit warnings.

## Read-only checks

Use these checks before considering any cleanup:

1. Sample `GET /health` and inspect `auditDiagnostics`.
2. Treat `workerHeartbeatRatio` as historical shape only.
3. Treat `recentWorkerHeartbeat`, `recentWorkerHeartbeatRatio`, and `recentWindowMs` as the active-churn signal.
4. Confirm Terminal Brief validation did not ACK terminal-outbox rows or use live provider sends unless an operator explicitly approved that action.

A heartbeat-heavy hot audit table is historical residue when `recentWorkerHeartbeat` is low or zero. It should not by itself be treated as CPU churn or hot polling.

## Warning policy

`/health.auditDiagnostics.warnings` should stay actionable:

- warn on oversized `broker_audit_events` hot-table retention;
- warn on heartbeat dominance only when the recent window also shows heartbeat churn;
- do not warn solely because old retained rows are mostly `worker.heartbeat` events.

## Cleanup policy

Manual prune is backup-only and requires explicit operator approval because it mutates the broker database. Prefer retaining evidence in GitHub comments and using read-only diagnostics first. If cleanup is approved, record only bounded counts, cutoff windows, and redacted paths; never record secrets, raw session dumps, provider tokens, or private host-specific paths.
