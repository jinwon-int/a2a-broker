/**
 * public-readiness-scan.test.mjs
 *
 * Tests for the public-readiness scanner covering:
 * - UPPER_CASE secret detection (existing after #438)
 * - camelCase / PascalCase secret detection (new)
 * - YAML-style `:` assignment
 * - Boolean literal exclusion
 * - Placeholder exclusion
 * - Shell-expansion / file-pointer exclusion
 * - No false positives on innocent text
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = new URL('./public-readiness-scan.mjs', import.meta.url).pathname;

/**
 * Run the scanner against a temp directory containing the given files.
 * `files` is an object mapping relative paths to content strings.
 * The scanner runs with CWD set to the temp dir.
 */
async function scan(files) {
  const dir = await mkdtemp(join(tmpdir(), 'prs-'));
  try {
    for (const [relPath, content] of Object.entries(files)) {
      const filePath = join(dir, relPath);
      await mkdir(join(filePath, '..'), { recursive: true });
      await writeFile(filePath, content, 'utf8');
    }
    const result = spawnSync(process.execPath, ['--input-type=module', script], {
      encoding: 'utf8',
      cwd: dir,
      input: '',
    });
    // The script prints to stdout; try to parse JSON output.
    // When no --json is passed, the final line is the summary.
    // For this test, we always run with --json by importing differently.
    return { stdout: result.stdout, stderr: result.stderr, status: result.status };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Run scanner with --json and return parsed result.
 */
async function scanJson(files) {
  const dir = await mkdtemp(join(tmpdir(), 'prs-'));
  try {
    for (const [relPath, content] of Object.entries(files)) {
      const filePath = join(dir, relPath);
      await mkdir(join(filePath, '..'), { recursive: true });
      await writeFile(filePath, content, 'utf8');
    }
    const result = spawnSync(process.execPath, [script, '--json'], {
      encoding: 'utf8',
      cwd: dir,
    });
    let data = null;
    try { data = JSON.parse(result.stdout.trim()); } catch { /* fall through */ }
    return { data, status: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ═══════════════════════════════════════════════════════════════════════
// UPPER_CASE (ENV_VAR style) detection
// ═══════════════════════════════════════════════════════════════════════

describe('UPPER_CASE secret detection', () => {
  it('flags concrete EDGE_SECRET value', async () => {
    const { data } = await scanJson({ '.env.example': 'EDGE_SECRET=abc123real\n' });
    assert.ok(data, 'should produce JSON output');
    const fails = data.findings.filter((f) => f.kind === 'secret-value');
    assert.equal(fails.length, 1, 'should have one secret-value finding');
    assert.match(fails[0].detail, /concrete value/i);
    assert.equal(fails[0].severity, 'fail');
  });

  it('flags concrete BROKER_TOKEN value', async () => {
    const { data } = await scanJson({ '.env.example': 'BROKER_TOKEN=xXx-secret-token-xXx\n' });
    const fails = data.findings.filter((f) => f.kind === 'secret-value');
    assert.equal(fails.length, 1);
  });

  it('skips EDGE_SECRET=<placeholder>', async () => {
    const { data } = await scanJson({ '.env.example': 'EDGE_SECRET=<edge-secret-placeholder>\n' });
    const fails = data.findings.filter((f) => f.kind === 'secret-value');
    assert.equal(fails.length, 0, 'placeholder value should not be flagged');
    assert.equal(data.summary.fail, 0);
  });

  it('skips ENABLE_SECRET=true (boolean literal)', async () => {
    const { data } = await scanJson({ '.env.example': 'ENABLE_SECRET=true\n' });
    const fails = data.findings.filter((f) => f.kind === 'secret-value');
    assert.equal(fails.length, 0, 'boolean true should not be flagged');
  });

  it('skips USE_TOKEN=false (boolean literal)', async () => {
    const { data } = await scanJson({ '.env.example': 'USE_TOKEN=false\n' });
    const fails = data.findings.filter((f) => f.kind === 'secret-value');
    assert.equal(fails.length, 0);
  });

  it('skips HAS_API_KEY=yes (boolean literal)', async () => {
    const { data } = await scanJson({ '.env.example': 'HAS_API_KEY=yes\n' });
    const fails = data.findings.filter((f) => f.kind === 'secret-value');
    assert.equal(fails.length, 0);
  });

  it('skips shell expansion', async () => {
    const { data } = await scanJson({ '.env.example': 'EDGE_SECRET=${EDGE_SECRET}\n' });
    const fails = data.findings.filter((f) => f.kind === 'secret-value');
    assert.equal(fails.length, 0);
  });

  it('skips file pointer keys', async () => {
    const { data } = await scanJson({ '.env.example': 'EDGE_SECRET_FILE=/run/secrets/edge\n' });
    const fails = data.findings.filter((f) => f.kind === 'secret-value');
    assert.equal(fails.length, 0, 'file pointer keys should not be flagged');
  });

  it('skips empty value', async () => {
    const { data } = await scanJson({ '.env.example': 'EDGE_SECRET=\n' });
    const fails = data.findings.filter((f) => f.kind === 'secret-value');
    assert.equal(fails.length, 0, 'empty value should not be flagged');
  });

  it('flags concrete API_KEY value', async () => {
    const { data } = await scanJson({ '.env.example': 'OPENAI_API_KEY=sk-abc123notreal\n' });
    const fails = data.findings.filter((f) => f.kind === 'secret-value');
    assert.equal(fails.length, 1);
  });

  it('does not false-positive on unrelated keys', async () => {
    const { data } = await scanJson({ '.env.example': 'PORT=8787\nHOST=0.0.0.0\nWORKER_ID=worker-a\n' });
    const fails = data.findings.filter((f) => f.kind === 'secret-value');
    assert.equal(fails.length, 0, 'unrelated keys should not be flagged');
  });

  it('skips ENABLE_SECRET=true, with trailing comma', async () => {
    const { data } = await scanJson({ 'docs/test.md': '- **Boolean exclusion** \u2014 `ENABLE_SECRET=true`, `edgeSecret: false`\n' });
    const fails = data.findings.filter((f) => f.kind === 'secret-value');
    assert.equal(fails.length, 0, 'boolean values with trailing punctuation should be excluded');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// camelCase / PascalCase detection (new after #438)
// ═══════════════════════════════════════════════════════════════════════

describe('camelCase secret detection', () => {
  it('flags concrete edgeSecret= value', async () => {
    const { data } = await scanJson({ 'docs/test.md': 'edgeSecret=abc123real\n' });
    const fails = data.findings.filter((f) => f.kind === 'secret-value');
    assert.equal(fails.length, 1, 'camelCase edgeSecret should be detected');
    // The UPPER_CASE pattern (with /i flag) catches keys like edgeSecret
    // because they contain the substring SECRET. Either detail message is fine;
    // what matters is that the concrete value was flagged.
  });

  it('flags concrete apiToken= value', async () => {
    const { data } = await scanJson({ 'docs/test.md': 'apiToken=sk-abc123notreal\n' });
    const fails = data.findings.filter((f) => f.kind === 'secret-value');
    assert.equal(fails.length, 1);
  });

  it('flags concrete brokerPassword: value (YAML style)', async () => {
    const { data } = await scanJson({ 'docs/test.md': 'brokerPassword: supersecret123\n' });
    const fails = data.findings.filter((f) => f.kind === 'secret-value');
    assert.equal(fails.length, 1, 'YAML-style camelCase should be detected');
  });

  it('flags concrete apiKey: value (YAML style)', async () => {
    const { data } = await scanJson({ 'docs/test.md': 'apiKey: "sk-not-real"\n' });
    const fails = data.findings.filter((f) => f.kind === 'secret-value');
    assert.equal(fails.length, 1);
  });

  it('flags concrete EdgeSecret value (PascalCase)', async () => {
    const { data } = await scanJson({ 'docs/test.md': 'EdgeSecret: concrete-value\n' });
    const fails = data.findings.filter((f) => f.kind === 'secret-value');
    assert.equal(fails.length, 1, 'PascalCase should be detected');
  });

  it('flags AuthToken value', async () => {
    const { data } = await scanJson({ 'docs/test.md': 'AuthToken: bearer-xyz-123\n' });
    const fails = data.findings.filter((f) => f.kind === 'secret-value');
    assert.equal(fails.length, 1);
  });

  it('flags AccessToken value', async () => {
    const { data } = await scanJson({ 'docs/test.md': 'accessToken = ghp_fake1234567890abcdef\n' });
    const fails = data.findings.filter((f) => f.kind === 'secret-value');
    assert.equal(fails.length, 1);
  });

  it('flags RefreshToken value', async () => {
    const { data } = await scanJson({ 'docs/test.md': 'refreshToken=eyJhbGciOiJIUzI1NiJ9.fake\n' });
    const fails = data.findings.filter((f) => f.kind === 'secret-value');
    assert.equal(fails.length, 1);
  });

  it('skips camelCase with placeholder value', async () => {
    const { data } = await scanJson({ 'docs/test.md': 'edgeSecret=<edge-secret-placeholder>\n' });
    const fails = data.findings.filter((f) => f.kind === 'secret-value');
    assert.equal(fails.length, 0, 'placeholder should not be flagged');
  });

  it('skips camelCase with boolean true', async () => {
    const { data } = await scanJson({ 'docs/test.md': 'edgeSecret: true\n' });
    const fails = data.findings.filter((f) => f.kind === 'secret-value');
    assert.equal(fails.length, 0, 'boolean true should not be flagged');
  });

  it('skips camelCase with boolean false', async () => {
    const { data } = await scanJson({ 'docs/test.md': 'useApiToken: false\n' });
    const fails = data.findings.filter((f) => f.kind === 'secret-value');
    assert.equal(fails.length, 0);
  });

  it('skips camelCase with shell expansion', async () => {
    const { data } = await scanJson({ 'docs/test.md': 'edgeSecret: ${EDGE_SECRET}\n' });
    const fails = data.findings.filter((f) => f.kind === 'secret-value');
    assert.equal(fails.length, 0);
  });

  it('skips camelCase with example/masked', async () => {
    const { data } = await scanJson({ 'docs/test.md': 'apiToken: example-token-value\n' });
    const fails = data.findings.filter((f) => f.kind === 'secret-value');
    assert.equal(fails.length, 0);
  });

  it('does not false-positive on non-secret properties', async () => {
    const { data } = await scanJson({ 'docs/test.md': [
      'name: my-service',
      'url: https://example.com',
      'version: 1.0.0',
      'streaming: true',
      'pushNotifications: false',
    ].join('\n') + '\n' });
    const fails = data.findings.filter((f) => f.kind === 'secret-value');
    assert.equal(fails.length, 0, 'non-secret properties should not be flagged');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Compound / nested camelCase keys
// ═══════════════════════════════════════════════════════════════════════

describe('compound camelCase keys', () => {
  it('detects brokerApiSecret with = separator', async () => {
    const { data } = await scanJson({ 'docs/test.md': 'brokerApiSecret=real-secret-123\n' });
    const fails = data.findings.filter((f) => f.kind === 'secret-value');
    assert.equal(fails.length, 1);
  });

  it('detects clientJwtSecret with : separator', async () => {
    const { data } = await scanJson({ 'docs/test.md': 'clientJwtSecret: "concrete-jwt"\n' });
    const fails = data.findings.filter((f) => f.kind === 'secret-value');
    assert.equal(fails.length, 1);
  });

  it('detects oauthToken with = separator', async () => {
    const { data } = await scanJson({ 'docs/test.md': 'oauthToken=ya29.fakeOauthTokenValue\n' });
    const fails = data.findings.filter((f) => f.kind === 'secret-value');
    assert.equal(fails.length, 1);
  });

  it('skips edgeSecret_present: true (compound boolean)', async () => {
    const { data } = await scanJson({ 'docs/test.md': '1. edge-secret presence proof as boolean (`edgeSecret_present: true`)\n' });
    const fails = data.findings.filter((f) => f.kind === 'secret-value');
    assert.equal(fails.length, 0, 'compound property with boolean value should not be flagged');
  });

  it('flags edgeSecret_value: concrete when value is not boolean', async () => {
    const { data } = await scanJson({ 'docs/test.md': 'edgeSecret_value: abc-real-secret\n' });
    const fails = data.findings.filter((f) => f.kind === 'secret-value');
    assert.equal(fails.length, 1, 'compound property with concrete value should be flagged');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// YAML-style UPPER_CASE keys (regression)
// ═══════════════════════════════════════════════════════════════════════

describe('YAML-style UPPER_CASE keys', () => {
  it('still flags UPPER_CASE with = (no regression)', async () => {
    const { data } = await scanJson({ '.env.example': 'EDGE_SECRET=real-leaked-value\n' });
    const fails = data.findings.filter((f) => f.kind === 'secret-value');
    assert.equal(fails.length, 1);
  });

  it('now flags UPPER_CASE with YAML : via camelCase path', async () => {
    // The enhanced scanner now catches UPPER_CASE keys with YAML colon
    // via the camelCase detection path, which is the safer behavior.
    const { data } = await scanJson({ 'docs/test.md': 'EDGE_SECRET: concrete-value\n' });
    const fails = data.findings.filter((f) => f.kind === 'secret-value');
    assert.equal(fails.length, 1,
      'UPPER_CASE keys with YAML : are now caught by the camelCase detection path');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Integration: summary and exit code
// ═══════════════════════════════════════════════════════════════════════

describe('summary and exit codes', () => {
  it('exit code 0 when no fails', async () => {
    const { status, data } = await scanJson({ '.env.example': 'EDGE_SECRET=<placeholder>\nPORT=8787\n' });
    assert.equal(status, 0, 'should exit 0 with no failures');
    assert.equal(data.summary.fail, 0);
  });

  it('exit code 1 when at least one fail', async () => {
    const { status } = await scanJson({ '.env.example': 'EDGE_SECRET=real-value-leaked\n' });
    assert.equal(status, 1, 'should exit 1 on failure');
  });

  it('summary counts are correct', async () => {
    const { data } = await scanJson({ '.env.example': [
      'EDGE_SECRET=leaked1',
      'BROKER_TOKEN=leaked2',
      'PORT=8787',
    ].join('\n') + '\n' });
    assert.equal(data.summary.fail, 2);
    assert.equal(data.summary.total, 2);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// JSON output format
// ═══════════════════════════════════════════════════════════════════════

describe('JSON output format', () => {
  it('produces valid JSON with --json', async () => {
    const { data } = await scanJson({ '.env.example': 'EDGE_SECRET=real\n' });
    assert.ok(data, 'should parse as JSON');
    assert.ok(data.summary, 'should have summary');
    assert.ok(Array.isArray(data.findings), 'should have findings array');
  });

  it('redacts secret values in excerpts', async () => {
    const { data } = await scanJson({ '.env.example': 'EDGE_SECRET=super-secret-abc123\n' });
    const finding = data.findings.find((f) => f.kind === 'secret-value');
    assert.ok(finding, 'should have a secret-value finding');
    assert.ok(!finding.excerpt.includes('super-secret-abc123'),
      'excerpt should redact the actual secret value');
  });

  it('includes file and line info', async () => {
    const { data } = await scanJson({ 'docs/test.md': 'edgeSecret=real\n' });
    const finding = data.findings.find((f) => f.kind === 'secret-value');
    assert.ok(finding, 'should have a finding');
    assert.ok(finding.file, 'should have file path');
    assert.ok(typeof finding.line === 'number', 'should have line number');
  });
});
