#!/usr/bin/env node
/**
 * edge-secret-preflight.mjs
 *
 * Secret-safe preflight diagnostic for A2A broker edge-secret rotation planning.
 *
 * Scans .env.example and examples/*.env.example for edge-secret variable names,
 * validates they exist, and checks that their values are not concrete secrets
 * (placeholders, shell-expansion, or empty values are fine — concrete secret
 * values are a fail).
 *
 * Read-only: never reads production env, never resolves secret values, never
 * prints or transmits secrets. JSON output for CI/tooling.
 *
 * Usage:
 *   node scripts/edge-secret-preflight.mjs
 *   node scripts/edge-secret-preflight.mjs --json
 *   node scripts/edge-secret-preflight.mjs --check-env .env.example
 */

import { readFileSync, statSync } from 'node:fs';
import process from 'node:process';

// ── Configuration ────────────────────────────────────────────────────────────

/** Required edge-secret variable names that must exist in the env file. */
const REQUIRED_BROKER_EDGE_SECRETS = ['EDGE_SECRET', 'A2A_EDGE_SECRET'];

/** Required worker-side edge-secret variable names. */
const REQUIRED_WORKER_EDGE_SECRETS = ['BROKER_EDGE_SECRET', 'A2A_BROKER_EDGE_SECRET'];

/** Patterns that denote a safe (non-concrete) value. */
const SAFE_VALUE_PATTERNS = [
  /^<.*>$/,               // <placeholder>, <edge-secret>, <masked>
  /\$\{/,                  // ${VAR} shell expansion
  /^$/,                    // empty
];

/** Patterns that indicate a concrete/real secret value. */
const CONCRETE_VALUE_PATTERNS = [
  /^[a-zA-Z0-9_-]{6,}$/,  // Any non-trivial alphanumeric string
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function ok(check, detail, extra = {}) {
  return { ok: true, check, detail, severity: 'pass', ...extra };
}

function fail(check, detail, extra = {}) {
  return { ok: false, check, detail, severity: 'fail', ...extra };
}

function warn(check, detail, extra = {}) {
  return { ok: true, check, detail, severity: 'warn', ...extra };
}

function isSafeValue(value) {
  return SAFE_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

function isConcreteValue(value) {
  if (isSafeValue(value)) return false;
  // Boolean/yse/no literals are not secrets
  if (/^(true|false|yes|no)$/i.test(value)) return false;
  return CONCRETE_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Parse a flat key=value env file into entries, stripping comments and blanks.
 * Supports quoted values and inline comments.
 */
function parseEnvLines(lines) {
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNumber = i + 1;

    // Strip inline comments (but not inside quoted values)
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      entries.push({ lineNumber, raw, kind: 'comment' });
      continue;
    }

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) {
      entries.push({ lineNumber, raw, kind: 'other' });
      continue;
    }

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    // Strip trailing inline comment (#). Skip if # is inside a quoted value.
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0];
      const closeIdx = value.indexOf(quote, 1);
      if (closeIdx !== -1) {
        value = value.slice(0, closeIdx + 1);
      }
    } else {
      const commentIdx = value.indexOf(' #');
      if (commentIdx !== -1) {
        value = value.slice(0, commentIdx).trim();
      }
    }

    entries.push({ lineNumber, raw, key, value, kind: 'assignment' });
  }
  return entries;
}

function loadEnvFile(envPath) {
  let text;
  try {
    text = readFileSync(envPath, 'utf8');
  } catch (err) {
    return { ok: false, error: `Cannot read ${envPath}: ${err.message}` };
  }
  const lines = text.split(/\r?\n/);
  const entries = parseEnvLines(lines);
  return { ok: true, path: envPath, entries };
}

// ── Checks ───────────────────────────────────────────────────────────────────

function checkEdgeSecretExists(entries, varName) {
  const assignment = entries.find(
    (e) => e.kind === 'assignment' && e.key === varName,
  );
  if (!assignment) {
    return fail('edge-secret-exists', `Required edge-secret variable ${varName} is missing`);
  }
  return ok('edge-secret-exists', `${varName} is defined`);
}

function checkEdgeSecretValue(entries, varName) {
  const assignment = entries.find(
    (e) => e.kind === 'assignment' && e.key === varName,
  );
  if (!assignment) {
    return fail('edge-secret-value', `${varName} is missing — cannot validate value`);
  }

  const value = assignment.value;

  // Empty is acceptable for a template
  if (value === '' || value === undefined || value === null) {
    return warn(
      'edge-secret-value',
      `${varName}= has empty value — consider adding a placeholder comment`,
      { value: '<empty>' },
    );
  }

  if (isSafeValue(value)) {
    return ok('edge-secret-value', `${varName}= uses safe value pattern`, { value: '<safe>' });
  }

  return fail(
    'edge-secret-value',
    `${varName}= appears to have a concrete value — replace with placeholder before rotation prep`,
    { value: '<redacted>' },
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const options = {
    envFiles: [],
    json: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '--check-env') {
      const next = argv[++i];
      if (!next) throw new Error('--check-env requires a value');
      options.envFiles.push(next);
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg.startsWith('--check-env=')) {
      options.envFiles.push(arg.slice('--env-file='.length));
    }
  }

  return options;
}

export function runPreflight(options) {
  const envFiles = options.envFiles.length > 0
    ? options.envFiles
    : ['.env.example'];

  const allChecks = [];

  for (const envPath of envFiles) {
    // Skip if the file doesn't exist (warn once)
    try { statSync(envPath); } catch {
      allChecks.push(warn('env-file-exists', `Env file not found: ${envPath}`));
      continue;
    }

    const result = loadEnvFile(envPath);
    if (!result.ok) {
      allChecks.push(fail('env-file-load', result.error));
      continue;
    }

    const { entries } = result;

    // Check broker edge secrets
    for (const varName of REQUIRED_BROKER_EDGE_SECRETS) {
      allChecks.push(checkEdgeSecretExists(entries, varName));
      allChecks.push(checkEdgeSecretValue(entries, varName));
    }

    // Check worker edge secrets
    for (const varName of REQUIRED_WORKER_EDGE_SECRETS) {
      allChecks.push(checkEdgeSecretExists(entries, varName));
      allChecks.push(checkEdgeSecretValue(entries, varName));
    }
  }

  const summary = allChecks.reduce(
    (acc, check) => {
      if (check.severity === 'fail') acc.fail += 1;
      else if (check.severity === 'warn') acc.warn += 1;
      else acc.pass += 1;
      acc.total += 1;
      return acc;
    },
    { total: 0, pass: 0, fail: 0, warn: 0 },
  );

  const hasFails = summary.fail > 0;

  return { summary, checks: allChecks, ok: !hasFails };
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(2);
  }

  if (options.help) {
    console.log(`
Usage: node scripts/edge-secret-preflight.mjs [options]

Options:
  --json                Output JSON (machine-readable)
  --check-env <path>    Check a specific env file (repeatable; default: .env.example)
  --help, -h            Show this help

Description:
  Secret-safe preflight diagnostic for A2A broker edge-secret rotation planning.
  Scans env files for edge-secret variable coverage and validates that values
  are not concrete secrets (placeholders, shell-expansion, and empty values are
  safe). Never prints, resolves, or transmits secret values.

Exit codes:
  0  All checks pass (or only warnings)
  1  One or more checks failed
  2  Usage/argument error
`);
    process.exit(0);
  }

  const result = runPreflight(options);

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`edge-secret-preflight: ${result.summary.pass} pass, ${result.summary.fail} fail, ${result.summary.warn} warn, ${result.summary.total} total`);
    for (const check of result.checks) {
      const icon = check.severity === 'fail' ? 'FAIL' : check.severity === 'warn' ? 'WARN' : 'PASS';
      console.log(`${icon} [${check.check}] ${check.detail}`);
    }
    console.log(`\nResult: ${result.ok ? 'PASS' : 'FAIL'}`);
  }

  process.exitCode = result.ok ? 0 : 1;
}

main();
