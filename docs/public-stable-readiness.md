# Public/stable readiness scan and dummy-worker smoke

This is the safe public-readiness lane for broker docs, examples, and local smoke evidence. It is intentionally local-only: no repo visibility changes, package publish, production deploy, Gateway restart, live Telegram send, database mutation, or terminal-outbox ACK.

## Redacted sanitization scan

Run the scan before publishing or linking public/stable evidence:

```bash
npm run scan:public-readiness
```

The scan covers `README.md`, `.env.example`, `docs/`, and `examples/` for:

- concrete secret-like assignments (`*SECRET*`, `*TOKEN*`, `*PASSWORD*`, `*API_KEY*`)
- Telegram chat targets
- private host aliases
- non-allowlisted URLs that should be confirmed public or converted to placeholders

Output is redacted by default. Findings only include file, line, category, and a sanitized excerpt. A non-zero exit means a high-confidence public-safety issue must be fixed before the lane can be marked Done. Warnings are review prompts; either replace the value with a role placeholder or keep the warning as explicit review evidence when the reference is intentionally public.

For machine-readable evidence:

```bash
npm run scan:public-readiness -- --json
```

Do not paste raw secrets, private paths, chat IDs, host-local session dumps, or unredacted command logs into issues or PRs.

## Local broker + dummy-worker smoke

Use the existing single-host smoke stack to prove the broker can accept a task and a dummy worker can complete it without live infrastructure:

```bash
docker compose -f examples/docker-compose.smoke.yml up --build -d
curl -sf http://127.0.0.1:8787/health | head -c 400 ; echo
curl -sf http://127.0.0.1:8787/workers | head -c 400 ; echo
```

Then follow `docs/smoke-compose.md` to create a task for `echo-worker-1`, poll it to `status:"succeeded"`, and inspect the task audit trail. The compose file uses the built-in `echo` handler from `src/worker.ts`; it does not require external workers, edge secrets, live Telegram, or production state.

When finished:

```bash
docker compose -f examples/docker-compose.smoke.yml down --volumes
```

## Evidence checklist

Public/stable Done or PR evidence should include only compact, redacted output:

- `npm run scan:public-readiness` summary and any sanitized warnings
- local smoke command names and pass/fail status
- task lifecycle summary (`queued` to `succeeded`) if the Docker smoke was run
- explicit statement that no forbidden live action was performed
