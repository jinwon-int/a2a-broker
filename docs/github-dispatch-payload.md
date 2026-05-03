# Canonical GitHub Patch Dispatch Payload

GitHub-driven patch tasks must use the canonical task payload at the broker/API boundary so workers can fail closed when dispatch evidence is incomplete.

## Required task fields

- `intent`: `"propose_patch"`
- `taskOrigin`: `"github"` (the broker stamps this automatically for canonical GitHub patch payloads; conflicting values are rejected)
- `payload.mode`: `"github-propose-patch"`
- `payload.repo`: GitHub repository in `owner/name` form
- `payload.issueNumber`: positive integer issue number
- `payload.issue`: string issue reference such as `"#291"` (accepted as input; normalized from `issueNumber` when omitted)
- `payload.issueUrl`: canonical GitHub issue URL

## Compatibility guard

The broker accepts the previous legacy-only shape (`githubRepo`, `githubIssueNumber`, `githubIssueUrl`, `workMode=github`) only by deterministically normalizing it into the canonical fields above and adding:

```json
"githubDispatchCompatibility": {
  "normalizedFromLegacyPayload": true,
  "legacyFields": ["githubRepo", "githubIssueNumber", "workMode"]
}
```

Canonical GitHub dispatch payloads with a non-`github` `taskOrigin` are rejected with an actionable `bad_request` error. This prevents ad-hoc API callers from silently creating GitHub patch tasks that workers cannot recognize.

See `examples/github-dispatch-payload.json` for a reusable fixture.
