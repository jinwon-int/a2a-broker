# Scanner Coverage vs. External Secret Scanners (gitleaks / trufflehog)

## Decision

**The `public-readiness-scan.mjs` scanner is sufficient as the sole
deterministic pre-release secret scan for `a2a-broker` public-facing
files.**  `gitleaks` and `trufflehog` are not hard blockers for this repo.

## Rationale

### Scope alignment

`gitleaks` and `trufflehog` are general-purpose secret scanners designed
for full-repository history, all file types, and broad pattern matching.
The `a2a-broker` public-readiness gate is narrower:

| Dimension | gitleaks / trufflehog | public-readiness-scan.mjs |
|---|---|---|
| Target | Entire repo history + all file types | Public-facing docs/examples only (`README.md`, `.env.example`, `docs/`, `examples/`) |
| Output | Raw matches with partial redaction | Redacted, category-tagged JSON with file/line/severity |
| Custom rules | Provider-specific `.toml` / config | Inline JS patterns maintained in-repo |
| Determinism | Depends on external binary version | Single Node.js script, no external deps |
| CI integration | Separate toolchain install | `npm run scan:public-readiness` (already in `package.json`) |

### What the repo-local scanner covers

- **Concrete secret values** in `KEY=VALUE` (UPPER_CASE) and `key: value` or
  `key=value` (camelCase / PascalCase) assignments.
- **Boolean literal exclusion** — `ENABLE_SECRET=true`, `edgeSecret: true`
  are not flagged (the value is a boolean feature flag, not a secret).
- **Shell-expansion exclusion** — `${VAR}` references are not flagged.
- **File-pointer exclusion** — `*_FILE` and `*_PATH` keys are not flagged.
- **Placeholder detection** — `<placeholder>`, `example`, `masked`,
  `redacted`, `YOUR_*`, `CHANGEME` patterns are excluded.
- **Telegram chat targets** — numeric IDs are blocked.
- **Private host aliases** — `seoseo`, `racknerd` references are warned.
- **URL allowlisting** — documented URLs are checked against a per-repo
  allowlist.

### Why gitleaks/trufflehog are not required

1. **No binary dependency** — The repo-local scanner runs on Node.js (≥22)
   with zero external toolchain requirements. `gitleaks` and `trufflehog`
   would add Go/Python runtime dependencies and version management
   complexity.
2. **Deterministic output** — The scanner produces stable `--json` output
   that can be diffed across commits. External tools can change behavior
   across versions, breaking CI determinism.
3. **Repo-local evidence** — The scanner is versioned in the same repo,
   so every commit's scan behavior is reproducible. The test file
   (`public-readiness-scan.test.mjs`) pins scanner behavior to specific
   input/output pairs.
4. **Scope fit** — The repo's public surface is limited to markdown,
   YAML, JSON, and `.env.example` files. A full-history, multi-format
   gitleaks scan would produce mostly noise from test fixtures and
   internal source code that is already isolated from the public docs
   directory.

### When to reconsider

If the repo's public surface expands to include:

- Binary artifacts or images
- Committed config files with real values
- Third-party vendor files
- Large history with potential past leaks

…then adding `gitleaks` or `trufflehog` as a secondary gate (not a
replacement) would be appropriate. The decision would need an explicit
operator approval and CI integration.

## Current scan coverage matrix

```
public-readiness-scan.mjs          test coverage (38 tests)
├── UPPER_CASE secret detection    ✓ EDGE_SECRET, BROKER_TOKEN, API_KEY
│   ├── Boolean exclusion          ✓ true, false, yes, no
│   ├── Placeholder exclusion      ✓ <placeholder>, example, masked
│   ├── Shell expansion exclusion  ✓ ${VAR}, $VAR
│   ├── File pointer exclusion     ✓ *_FILE, *_PATH
│   └── Empty value exclusion      ✓ KEY=
├── camelCase secret detection     ✓ edgeSecret, apiToken, apiKey, brokerPassword
│   ├── YAML : separator           ✓ key: value
│   ├── PascalCase                 ✓ EdgeSecret, AuthToken, AccessToken
│   ├── Boolean exclusion          ✓ true, false
│   ├── Placeholder exclusion      ✓ <placeholder>, example-*
│   ├── Shell expansion exclusion  ✓ ${VAR}
│   └── Trailing punctuation       ✓ true), false], yes`
├── Telegram target detection      ✓ numeric chat IDs
├── URL inspection                 ✓ allowlist, private networks
└── Host alias detection           ✓ seoseo, racknerd patterns
```

## Evidence

Run the scanner and its test suite locally:

```bash
npm run scan:public-readiness          # human-readable output
npm run scan:public-readiness -- --json  # machine-readable output
node --test scripts/public-readiness-scan.test.mjs  # 38 tests, 0 failures
```

The scanner and test file are kept in `scripts/` and versioned alongside
the repo. No external tools are required.
