/**
 * edge-secret-preflight.test.mjs
 *
 * Tests for the edge-secret preflight diagnostic script.
 * Verifies safe detection of missing vars, concrete values, and
 * proper JSON/text output modes.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = new URL('./edge-secret-preflight.mjs', import.meta.url).pathname;

/**
 * Run the preflight against a temp directory containing the given files.
 * `files` is an object mapping relative paths to content strings.
 */
async function runPreflight(files, args = []) {
  const dir = await mkdtemp(join(tmpdir(), 'esp-'));
  try {
    for (const [relPath, content] of Object.entries(files)) {
      const filePath = join(dir, relPath);
      await mkdir(join(filePath, '..'), { recursive: true });
      await writeFile(filePath, content, 'utf8');
    }
    const result = spawnSync(process.execPath, [script, ...args], {
      encoding: 'utf8',
      cwd: dir,
      input: '',
    });
    let data = null;
    // Try to parse JSON if --json was passed
    if (args.includes('--json')) {
      try { data = JSON.parse(result.stdout.trim()); } catch { /* fall through */ }
    }
    return { data, status: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Test: env file missing
// ═══════════════════════════════════════════════════════════════════════

describe('env file missing', () => {
  it('warns when --env-file points to a nonexistent file', async () => {
    const { data } = await runPreflight({}, ['--json', '--check-env', 'nonexistent.env']);
    assert.ok(data, 'should produce JSON output');
    const warns = data.checks.filter((c) => c.severity === 'warn' && c.check === 'env-file-exists');
    assert.equal(warns.length, 1, 'should warn about missing file');
    assert.equal(data.ok, true, 'missing file is a warning, not a fail');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Test: complete valid env example
// ═══════════════════════════════════════════════════════════════════════

describe('valid env example with all secrets', () => {
  const envContent = [
    '# Broker edge auth',
    'EDGE_SECRET=<place-holder>',
    'A2A_EDGE_SECRET=<place-holder>',
    '',
    '# Worker edge auth',
    'BROKER_EDGE_SECRET=${BROKER_EDGE_SECRET}',
    'A2A_BROKER_EDGE_SECRET=${A2A_BROKER_EDGE_SECRET}',
    '',
    '# Other',
    'PORT=8787',
    'HOST=0.0.0.0',
  ].join('\n') + '\n';

  it('passes when all edge secrets exist with safe values', async () => {
    const { data } = await runPreflight({ '.env.example': envContent }, ['--json']);
    assert.ok(data, 'should produce JSON output');
    assert.equal(data.ok, true, 'should pass');
    assert.equal(data.summary.fail, 0, 'zero failures');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Test: missing broker edge secret
// ═══════════════════════════════════════════════════════════════════════

describe('missing broker edge secret', () => {
  const envContent = [
    '# Only worker secrets',
    'BROKER_EDGE_SECRET=${BROKER_EDGE_SECRET}',
    'A2A_BROKER_EDGE_SECRET=${A2A_BROKER_EDGE_SECRET}',
  ].join('\n') + '\n';

  it('fails when EDGE_SECRET is missing', async () => {
    const { data } = await runPreflight({ '.env.example': envContent }, ['--json']);
    assert.ok(data, 'should produce JSON output');
    const fails = data.checks.filter((c) => c.severity === 'fail');
    assert.ok(fails.length >= 2, 'should fail for missing EDGE_SECRET and A2A_EDGE_SECRET');
    assert.ok(data.checks.some((c) => c.detail.includes('EDGE_SECRET') && c.severity === 'fail'),
      'EDGE_SECRET missing should be a fail');
    assert.equal(data.ok, false, 'should not pass');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Test: concrete secret values
// ═══════════════════════════════════════════════════════════════════════

describe('concrete secret values', () => {
  const envContent = [
    'EDGE_SECRET=real-secret-value-123',
    'A2A_EDGE_SECRET=<placeholder>',
    'BROKER_EDGE_SECRET=${BROKER_EDGE_SECRET}',
    'A2A_BROKER_EDGE_SECRET=another-concrete-val',
  ].join('\n') + '\n';

  it('fails when any edge secret has a concrete value', async () => {
    const { data } = await runPreflight({ '.env.example': envContent }, ['--json']);
    assert.ok(data, 'should produce JSON output');
    assert.equal(data.ok, false, 'should not pass');
    const fails = data.checks.filter((c) => c.severity === 'fail' && c.check === 'edge-secret-value');
    assert.equal(fails.length, 2, 'two concrete secret values should be flagged');
    // Verify the specific variables are flagged
    const flaggedKeys = fails.map((f) => f.detail);
    assert.ok(flaggedKeys.some((d) => d.startsWith('EDGE_SECRET=')), 'EDGE_SECRET should be flagged');
    assert.ok(flaggedKeys.some((d) => d.startsWith('A2A_BROKER_EDGE_SECRET=')), 'A2A_BROKER_EDGE_SECRET should be flagged');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Test: empty values (warning, not fail)
// ═══════════════════════════════════════════════════════════════════════

describe('empty edge secret values', () => {
  const envContent = [
    'EDGE_SECRET=',
    'A2A_EDGE_SECRET=',
    'BROKER_EDGE_SECRET=',
    'A2A_BROKER_EDGE_SECRET=',
  ].join('\n') + '\n';

  it('warns but does not fail on empty values', async () => {
    const { data } = await runPreflight({ '.env.example': envContent }, ['--json']);
    assert.ok(data, 'should produce JSON output');
    assert.equal(data.ok, true, 'empty values are not a hard fail');
    const warns = data.checks.filter((c) => c.severity === 'warn' && c.check === 'edge-secret-value');
    assert.equal(warns.length, 4, 'all four empty edge secrets should warn');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Test: shell expansion values
// ═══════════════════════════════════════════════════════════════════════

describe('shell expansion values', () => {
  const envContent = [
    'EDGE_SECRET=${EDGE_SECRET}',
    'A2A_EDGE_SECRET=${A2A_EDGE_SECRET}',
    'BROKER_EDGE_SECRET=${BROKER_EDGE_SECRET}',
    'A2A_BROKER_EDGE_SECRET=${A2A_BROKER_EDGE_SECRET}',
  ].join('\n') + '\n';

  it('passes when all values use shell expansion', async () => {
    const { data } = await runPreflight({ '.env.example': envContent }, ['--json']);
    assert.ok(data, 'should produce JSON output');
    assert.equal(data.ok, true, 'shell expansion values are safe');
    assert.equal(data.summary.fail, 0, 'no failures');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Test: --env-file with specific path
// ═══════════════════════════════════════════════════════════════════════

describe('--env-file with specific path', () => {
  const validEnv = [
    'EDGE_SECRET=<placeholder>',
    'A2A_EDGE_SECRET=<placeholder>',
    'BROKER_EDGE_SECRET=${BROKER_EDGE_SECRET}',
    'A2A_BROKER_EDGE_SECRET=${A2A_BROKER_EDGE_SECRET}',
  ].join('\n') + '\n';

  const leakyEnv = [
    'EDGE_SECRET=leaked-concrete-secret',
    'A2A_EDGE_SECRET=<placeholder>',
    'BROKER_EDGE_SECRET=${BROKER_EDGE_SECRET}',
    'A2A_BROKER_EDGE_SECRET=also-leaked',
  ].join('\n') + '\n';

  it('passes a clean env file with --env-file', async () => {
    const { data } = await runPreflight({
      '.env.example': 'PORT=8787',
      'envs/broker.env': validEnv,
    }, ['--json', '--check-env', 'envs/broker.env']);
    assert.ok(data, 'should produce JSON output');
    assert.equal(data.ok, true, 'clean env file should pass');
  });

  it('correctly validates multiple --env-file paths', async () => {
    const { data } = await runPreflight({
      '.env.example': 'PORT=8787',
      'envs/clean.env': validEnv,
      'envs/leaky.env': leakyEnv,
    }, ['--json', '--check-env', 'envs/clean.env', '--check-env', 'envs/leaky.env']);
    assert.ok(data, 'should produce JSON output');
    assert.equal(data.ok, false, 'leaky file should cause failure');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Test: JSON output format
// ═══════════════════════════════════════════════════════════════════════

describe('JSON output format', () => {
  const envContent = [
    'EDGE_SECRET=<safe>',
    'A2A_EDGE_SECRET=<safe>',
    'BROKER_EDGE_SECRET=${BROKER_EDGE_SECRET}',
    'A2A_BROKER_EDGE_SECRET=${A2A_BROKER_EDGE_SECRET}',
  ].join('\n') + '\n';

  it('produces valid JSON with summary and checks', async () => {
    const { data } = await runPreflight({ '.env.example': envContent }, ['--json']);
    assert.ok(data, 'should parse as JSON');
    assert.ok(data.summary, 'should have summary');
    assert.ok(typeof data.summary.total === 'number', 'summary.total should be a number');
    assert.ok(typeof data.summary.pass === 'number', 'summary.pass should be a number');
    assert.ok(typeof data.summary.fail === 'number', 'summary.fail should be a number');
    assert.ok(Array.isArray(data.checks), 'should have checks array');
    assert.ok(data.checks.every((c) => c.check && c.severity && c.detail), 'each check should have check/severity/detail');
  });

  it('redacts concrete values from failure detail', async () => {
    const envContent = [
      'EDGE_SECRET=real-concrete-value',
      'A2A_EDGE_SECRET=<placeholder>',
      'BROKER_EDGE_SECRET=${BROKER_EDGE_SECRET}',
      'A2A_BROKER_EDGE_SECRET=${A2A_BROKER_EDGE_SECRET}',
    ].join('\n') + '\n';
    const { data } = await runPreflight({ '.env.example': envContent }, ['--json']);
    const failChecks = data.checks.filter((c) => c.severity === 'fail');
    for (const c of failChecks) {
      // The detail should not contain the actual value
      assert.ok(!c.detail.includes('real-concrete-value'), 'detail should not contain concrete secret value');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Test: exit codes
// ═══════════════════════════════════════════════════════════════════════

describe('exit codes', () => {
  it('exits 0 on all pass', async () => {
    const envContent = [
      'EDGE_SECRET=${EDGE_SECRET}',
      'A2A_EDGE_SECRET=${A2A_EDGE_SECRET}',
      'BROKER_EDGE_SECRET=${BROKER_EDGE_SECRET}',
      'A2A_BROKER_EDGE_SECRET=${A2A_BROKER_EDGE_SECRET}',
    ].join('\n') + '\n';
    const { status } = await runPreflight({ '.env.example': envContent });
    assert.equal(status, 0, 'should exit 0');
  });

  it('exits 1 on failures', async () => {
    const envContent = 'EDGE_SECRET=leaked-value\n';
    const { status } = await runPreflight({ '.env.example': envContent });
    assert.equal(status, 1, 'should exit 1');
  });

  it('exits 0 with only warnings', async () => {
    const envContent = [
      'EDGE_SECRET=',
      'A2A_EDGE_SECRET=',
      'BROKER_EDGE_SECRET=',
      'A2A_BROKER_EDGE_SECRET=',
    ].join('\n') + '\n';
    const { status } = await runPreflight({ '.env.example': envContent });
    assert.equal(status, 0, 'warnings should not cause non-zero exit');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Test: actual .env.example from repo
// ═══════════════════════════════════════════════════════════════════════

describe('actual repo .env.example', () => {
  it('runs against repo .env.example without --json', async () => {
    // Run from repo root where .env.example exists
    const result = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      cwd: process.cwd(),
    });
    // The repo .env.example has empty values, which are warnings, not fails
    assert.equal(result.status, 0, 'should exit 0 (warnings only)');
    assert.ok(result.stdout.includes('edge-secret-preflight:'), 'should have summary line');
  });

  it('runs against repo .env.example with --json', async () => {
    const result = spawnSync(process.execPath, [script, '--json'], {
      encoding: 'utf8',
      cwd: process.cwd(),
    });
    assert.equal(result.status, 0, 'should exit 0');
    const data = JSON.parse(result.stdout);
    assert.ok(data.summary, 'should have summary');
    // All 4 (2 broker + 2 worker) × 2 checks each = 8 total
    assert.ok(data.summary.total >= 8, `expected at least 8 checks, got ${data.summary.total}`);
  });
});
