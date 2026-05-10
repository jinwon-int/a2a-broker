# Broker source-public risk audit — 2026-05-10

Run: `a2a-source-release-gate-20260510T113438Z`  
Lane: Team2 independent broker audit for issue #476  
Parent: jinwon-int/a2a-plane#192

## Scope

This is a repository-only source-public readiness audit. It does not approve or perform a public release, repository visibility change, production deploy/restart, live provider send, database mutation, terminal ACK, secret change, history rewrite, force-push, package publication, or community post.

The audit cross-checks the broker against the Team1 broker lane (#475) for:

- hidden broker/plugin/runner coupling;
- private endpoints, host aliases, chat targets, and raw operational assumptions in public-facing docs/examples;
- source-public scanner and history-scan requirements;
- public API/compatibility documentation coverage;
- operator approval boundaries and evidence hygiene.

## Repository findings

- `docs/public-stable-readiness.md` already defines the broker/plugin/runner responsibility split and blocks any public/stable decision until operator approval, license, scan, CI, smoke, rollback, and evidence gates are complete.
- `docs/protocol-compatibility.md` documents the advertised A2A 1.0-compatible alpha profile, non-goals, JSON-RPC/SSE behavior, extension boundaries, and the conformance gate.
- `docs/release-gate.md` separates the technical broker gate from public/stable approval and repeats that green technical checks do not authorize visibility changes, publishing, live sends, production mutation, or terminal ACKs.
- `npm run scan:public-readiness` is present and redacts findings by default. In this audit it reported `0 fail, 29 warn, 29 total`; all warnings were review prompts for host aliases/private-topology wording, not concrete secret or chat-target failures.
- Root `LICENSE` remains missing, so source-public release is blocked until an approved license decision is recorded.
- Root `SECURITY.md` and `CONTRIBUTING.md` were missing before this audit patch. This patch adds minimal public-safe files that point back to the existing approval and evidence gates.
- `CODEOWNERS`, `.github/ISSUE_TEMPLATE`, and `.github/PULL_REQUEST_TEMPLATE.md` remain missing; these are recommended follow-ups for a public-facing repository but do not by themselves authorize release.

## Team1 parity check

At the time of this audit, Team1 broker lane #475 had a Start marker but no posted closeout evidence yet. Treat this Team2 record as independent evidence and reconcile it with Team1's final packet before any GO decision.

## Runtime/bootstrap file gate

Before creating a PR, verify that local runner/bootstrap context files are not tracked, staged, or included in artifact evidence. This audit's pre-PR gate found no such files in the repository diff.

## Current decision

**Block public/stable release or repository visibility change** until:

1. an approved root license decision lands;
2. host-alias/private-topology warnings are either remediated or explicitly accepted as public-safe evidence;
3. Team1 and Team2 broker evidence is reconciled;
4. CI and local validation are green for the proposed commit;
5. operator approval explicitly names the requested public/stable action.
