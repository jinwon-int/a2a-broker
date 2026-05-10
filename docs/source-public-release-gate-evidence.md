# Source-public release gate — evidence and approval packet

Issue: [#475](https://github.com/jinwon-int/a2a-broker/issues/475)  
Parent: [a2a-plane#192](https://github.com/jinwon-int/a2a-plane/issues/192)  
Run: `a2a-source-release-gate-20260510T113438Z`  
Lane: Team1 — bangtong

This is a read-only evidence and approval packet for the source-public release
gate. It records the deterministic repo-local checks and scan results needed
before a source-public readiness decision. It does not change repository
visibility, deploy production, restart Gateway/broker/workers, send live
Telegram traffic, mutate the production DB, or ACK terminal-outbox rows.

## Safety declaration

| Action | Performed? | Evidence |
|--------|-----------|----------|
| Production deploy | No | N/A |
| Gateway restart | No | N/A |
| Broker/worker restart | No | N/A |
| Live provider/Telegram send | No | N/A |
| Terminal-outbox ACK | No | N/A |
| Production DB mutation | No | N/A |
| Secret/visibility change | No | N/A |
| History rewrite / force-push | No | N/A |
| Release publication | No | N/A |
| Community post | No | N/A |

## Evidence checklist

### 1. Public-readiness scan

```bash
npm run scan:public-readiness -- --json
```

**Result:** 0 failures, 29 warnings.

All 29 warnings are host-alias patterns (`<private-host>`) intentionally used as
placeholders in documentation. No secrets, private host names, chat IDs, or
private paths were detected. The scan is the deterministic repo-local scanner
(`scripts/public-readiness-scan.mjs`); external scanners (gitleaks/trufflehog)
are supplementary per `docs/scanner-coverage-vs-gitleaks-trufflehog.md`.

✅ PASS — no secret/private-content leaks detected.

### 2. OpenClaw bootstrap context exclusion

The repository `.gitignore` excludes all OpenClaw runtime/bootstrap context
files:

- `.openclaw/`
- `AGENTS.md`
- `SOUL.md`
- `USER.md`
- `TOOLS.md`
- `HEARTBEAT.md`
- `IDENTITY.md`

These files are not tracked in git and will not enter any branch or PR.

✅ PASS — no bootstrap context would enter the branch.

### 3. Release gate documentation

The release gate is documented in `docs/release-gate.md` and the public/stable
readiness checklist in `docs/public-stable-readiness.md`. Both documents cover:

- Docker runtime preflight (`npm run docker_runtime_preflight -- --dry-run`)
- Compose smoke gate (`npm run release_gate`)
- Restart recovery gate
- Live-impact approval lifecycle proof
- SQLite/WAL persistence mode coverage
- Phase 7b operator-stream checklist
- Public/stable readiness checklist with explicit approval boundaries

✅ PASS — release gate documentation is current and complete.

### 4. License and metadata

| Item | State |
|------|-------|
| `package.json` | `private: true`, `version: 0.1.0` |
| `LICENSE` file | Not currently present (blocker — see below) |
| `.env.example` | Role placeholders only, no real secrets |
| `README.md` | Comprehensive, host aliases use `<private-host>` placeholders |

### 5. Cross-repo alignment

Per `docs/public-stable-readiness.md`:

| Repository | Responsibility |
|------------|---------------|
| `jinwon-int/a2a-broker` | Broker APIs, AgentCard, task lifecycle, worker registration, persistence, docs, release gates |
| `jinwon-int/openclaw-plugin-a2a` | OpenClaw-facing request/status/cancel mapping, operator config |
| `jinwon-int/a2a-docker-runner` | Isolated Docker execution for GitHub patch tasks, runner-owned artifact collection |

✅ PASS — cross-repo boundaries are documented and aligned.

### 6. Docs review

Key docs inspected:

- `docs/release-gate.md` — comprehensive gate documentation
- `docs/public-stable-readiness.md` — full checklist with approval boundaries
- `docs/protocol-compatibility.md` — A2A protocol compatibility
- `docs/release-notes-round-35-sqlite-runtime.md` — current round release notes
- `docs/team1-public-readiness-final-closeout-matrix.md` — Team1 closeout state

All docs use `<private-host>` placeholders for private references. No host-specific
paths, secret values, or private topology leaks found.

✅ PASS — docs are sanitized for public visibility.

### 7. Rollback plan

If the source-public release gate evidence is later found to be incomplete or
invalid:

- **Owner:** seoseo (operator approval boundary per public-stable-readiness)
- **Path:** Close issue #475 as Block, reopen with corrected evidence
- **No production rollback needed:** this is a read-only evidence packet only

## Blockers

| Blocker | Status | Detail |
|---------|--------|--------|
| Root `LICENSE` file | Pending | `package.json.private=true` is not itself a license; a `LICENSE` file matching the approved release intent is required per `docs/public-stable-readiness.md` |
| Operator approval | Pending | seoseo must explicitly approve the source-public readiness action |
| External scanner evidence | Supplementary | Not required per `docs/scanner-coverage-vs-gitleaks-trufflehog.md` decision; repo-local scanner is the deterministic gate |

## Decision record

- **Decision:** Block (pending license file and operator approval)
- **Commit/PR:** `a2a-patch-20260510-113553-744f6813-6215-478a-9042-364fa2684bd7`
- **Approver:** seoseo (required)
- **CI evidence:** To be supplied by runner
- **Local validation:** Public-readiness scan passed (0 fail, 29 warn)
- **Secret/history scan:** Clean (0 fail)
- **License decision:** Pending — root `LICENSE` file required
- **Rollback owner and path:** seoseo; close #475 as Block
- **Deferred follow-ups:** External scanner run (operator-triggered only)
