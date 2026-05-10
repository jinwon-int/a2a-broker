# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately through GitHub's private vulnerability reporting flow when it is enabled for this repository, or by contacting the repository maintainers through the approved private support channel for this project.

Do **not** open a public issue with exploit details, secret values, provider tokens, private hostnames, database snapshots, raw session logs, or live message identifiers that could expose user or infrastructure data.

## Public-readiness boundary

This repository is not approved for a public/stable release until the checklist in [`docs/public-stable-readiness.md`](docs/public-stable-readiness.md) is complete and operator approval is recorded.

Security-sensitive release gates include:

- a root `LICENSE` decision;
- committed-history and working-tree secret scans;
- review of public docs/examples for private topology, host aliases, chat targets, and concrete secrets;
- confirmation that external provider accepted-send evidence is not treated as read, visibility, or terminal ACK evidence;
- explicit approval before any repository visibility change, release publication, production deploy/restart, database mutation, provider send, or terminal ACK.

## Supported versions

Until a stable release is approved, only the current default branch and active release-candidate pull requests are in scope for vulnerability triage.
