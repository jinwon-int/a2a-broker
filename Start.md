# Start: R15 structured Terminal Brief all-hands lane

**Timestamp:** 2026-05-18T05:00:00Z

## Plan

1. **Create `src/core/terminal-brief-metadata.ts`** — Canonical Terminal Brief metadata schema documenting all dispatch, projection, handoff, and notification-ownership fields with constraint annotations
2. **Modify `src/core/broker.ts`** — Add fail-closed task creation guard: validate Terminal Brief metadata fields in task payload at creation time, rejecting with `BrokerError("bad_request", ...)` when metadata is present but inconsistent
3. **Add tests** in `src/core/terminal-brief-metadata.test.ts` — Cover schema assumptions and the fail-closed guard
4. **OpenClaw file check** — .gitignore already blocks these files; no programmatic check needed since the runner prevents them from being committed

## Verifications
- `.gitignore` already blocks `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, `.openclaw/**` ✓
- No OpenClaw runtime files found in repo ✓
