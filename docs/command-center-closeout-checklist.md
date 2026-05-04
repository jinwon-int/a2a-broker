# Command-center Closeout Checklist

Issue #355 adds a compact, read-only checklist for A2A round closeout. It is meant for operator summaries where the important question is: _which lane issue/PR is closing, did CI/checks pass, is it merged/closed, and is the broker queue/stale state clean?_

## Quick run from sanitized evidence

```sh
npm run command_center_closeout_checklist -- \
  --input closeout-evidence.json \
  --markdown
```

The renderer accepts compact evidence such as:

```json
{
  "mode": "read-only/no-live",
  "github": {
    "repo": "jinwon-int/a2a-broker",
    "issue": "#355",
    "issueUrl": "https://github.com/jinwon-int/a2a-broker/issues/355",
    "prUrl": "https://github.com/jinwon-int/a2a-broker/pull/356",
    "prState": "MERGED",
    "issueState": "CLOSED",
    "checks": [{ "name": "test", "conclusion": "success" }]
  },
  "dashboard": {
    "operatorSnapshot": {
      "taskStatusSummary": {
        "active": 0,
        "byStatus": { "blocked": 0, "queued": 0, "claimed": 0, "running": 0 }
      },
      "recoverySummary": {
        "stale": { "staleWorkersWithActiveTasks": [] },
        "retry": { "totalRequeued": 0 }
      },
      "attentionItems": []
    }
  }
}
```

## Optional live read-only inputs

The same script can read current GitHub state with `gh` and broker dashboard state with a GET request:

```sh
npm run command_center_closeout_checklist -- \
  --repo jinwon-int/a2a-broker \
  --issue 355 \
  --pr 356 \
  --dashboard-url https://broker.example/dashboard \
  --markdown
```

If the dashboard requires the edge secret, set it in the environment and keep the default `--edge-secret-env BROKER_EDGE_SECRET`. The script only uses the value as a request header and never prints it.

## Output

Markdown output is intentionally small enough for Telegram/operator summaries:

```text
Done: command-center closeout checklist
Mode: read-only/no-live
Lane issue: jinwon-int/a2a-broker#355 (https://github.com/jinwon-int/a2a-broker/issues/355)
PR: https://github.com/jinwon-int/a2a-broker/pull/356
CI/check: 1/1 passing
Merge/close: pr=merged issue=CLOSED
Active queue: 0 (queued=0, claimed=0, running=0, blocked=0)
Stale/retry: workers=0, tasks=0, requeued=0
```

The script exits `0` only when required evidence is present, checks pass, active queue count is zero, and stale worker/task counts are zero. It exits `1` with a `Block:` summary when evidence is missing or closeout is not clean.

## Safety

This checklist is read-only. It does not perform live Telegram sends, Gateway restarts, production deploys, broker mutations, or terminal-outbox ACKs.
