# Contributing

Thanks for helping improve `a2a-broker`.

## Before opening a PR

- Keep changes small and focused.
- Run `npm test` for code changes. For docs-only changes, run `npm run build` when practical plus any focused scanner/docs check that matches the change.
- Do not include secrets, private hostnames, chat IDs, raw session logs, production database dumps, or local OpenClaw runtime/bootstrap files.
- Do not commit generated build output such as `dist/`.

## Public-readiness and release safety

A PR must not perform or imply approval for any of these actions unless a separate operator approval names the exact action:

- repository visibility change;
- release/package/image publication;
- production deploy, Gateway/broker/worker restart, or worker rollout;
- live provider or Telegram send;
- production database mutation;
- terminal outbox ACK;
- secret, branch-protection, or repository-visibility change;
- history rewrite or force-push.

Public/stable readiness work should cite [`docs/public-stable-readiness.md`](docs/public-stable-readiness.md) and include compact, redacted evidence only.

## Evidence hygiene

Use placeholders such as `<edge-secret-placeholder>`, `<broker-host>`, `<worker-host>`, and `<telegram-chat-id>` in docs and examples. If command output is needed, include summarized pass/fail lines instead of raw logs when raw logs may contain host paths, tokens, chat IDs, or session content.
