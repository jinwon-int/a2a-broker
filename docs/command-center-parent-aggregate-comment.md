# Command Center Parent Aggregate Comment

Issue #369 adds a preview-first helper for maintaining one managed aggregate comment on a parent GitHub issue.

## Preview only (default)

```bash
node scripts/parent-aggregate-comment.mjs \
  --task-report-json artifacts/task-report.json \
  --closeout-markdown artifacts/closeout.md \
  --repo jinwon-int/a2a-broker \
  --issue 364
```

The generated markdown includes the managed marker:

```html
<!-- a2a-command-center-parent-aggregate:v1 -->
```

## Post or update the managed comment

GitHub writes are opt-in. Use `--mode=post` or `--mode=update` only after reviewing the preview:

```bash
node scripts/parent-aggregate-comment.mjs \
  --task-report-json artifacts/task-report.json \
  --closeout-markdown artifacts/closeout.md \
  --repo jinwon-int/a2a-broker \
  --issue 364 \
  --mode=post
```

The helper lists issue comments, finds the marker, and patches that comment when present; otherwise it creates one comment. This keeps repeated operator runs idempotent and avoids duplicate aggregate-comment spam.

Safety: the helper redacts common token/secret patterns and `/work/...` paths in rendered markdown. It does not deploy, restart Gateway, mutate broker state, send Telegram, ACK terminal outbox, publish packages, or change repository visibility.
