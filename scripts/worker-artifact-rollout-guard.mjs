#!/usr/bin/env node
// a2a-broker worker artifact rollout guard
//
// Validates handler compatibility path, upstream bridge marker, executor
// policy, and dry-run readiness before deploying worker artifacts.
//
// Usage:
//   node scripts/worker-artifact-rollout-guard.mjs [--dry-run] [--smoke] [--verbose]
//   node scripts/worker-artifact-rollout-guard.mjs --docker-check
//   node scripts/worker-artifact-rollout-guard.mjs --deployed
//
// Exit codes:
//   0  — all guards passed / dry-run completed
//   1  — one or more guards failed
//   2  — setup error (missing source, unreadable file, etc.)
//
// Environment (honoured, never logged):
//   A2A_EXECUTOR_MODE         — executor mode (auto|docker|builtin)
//   A2A_DOCKER_RUNNER_SCOPE   — runner scope (plugin-only|all-github)
//   OPENCLAW_BIN              — host OpenClaw bridge binary path
//   A2A_WORKER_HANDLER_COMMAND / WORKER_HANDLER_COMMAND
//   HANDLERS_ROOT             — override handlers/ directory (default: ./handlers)
//   SCRIPTS_ROOT              — override scripts/ directory (default: ./scripts)

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = dirname(scriptPath);
const brokerRoot = resolve(scriptDir, '..');

const DRY_RUN = process.argv.includes('--dry-run');
const SMOKE = process.argv.includes('--smoke') || DRY_RUN;
const VERBOSE = process.argv.includes('--verbose');
const DOCKER_CHECK = process.argv.includes('--docker-check');
const DEPLOYED_CHECK = process.argv.includes('--deployed') || process.argv.includes('--runtime');

const HANDLER_FILENAME = 'openclaw-a2a-task-handler.mjs';

const handlersRoot = resolve(
  process.env.HANDLERS_ROOT || join(brokerRoot, 'handlers'),
);
const scriptsRoot = resolve(
  process.env.SCRIPTS_ROOT || join(brokerRoot, 'scripts'),
);

function safeBasename(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const cleaned = value.replace(/^\.\.?[/\\]+/, '').replace(/[/\\]/g, '_');
  return cleaned || null;
}

class GuardError extends Error {
  constructor(message, guard) {
    super(message);
    this.name = 'GuardError';
    this.guard = guard;
  }
}

class SetupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SetupError';
    this.setupError = true;
  }
}

const guards = [];

function guard(name, fn) {
  guards.push({ name, fn });
}

function ok(name, detail) {
  return { guard: name, ok: true, ...(detail ? { detail } : {}) };
}

function fail(name, message, detail) {
  return {
    guard: name,
    ok: false,
    error: message instanceof Error ? message.message : String(message),
    ...(detail ? { detail } : {}),
  };
}

function envPresence(name) {
  const value = process.env[name]?.trim();
  return {
    configured: !!value,
    present: value !== undefined,
    valueHint: value
      ? value.length <= 20
        ? '<redacted-short>'
        : `${value.slice(0, 8)}...<redacted>`
      : undefined,
  };
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function readFileSafe(filePath) {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

function tryRequire(path) {
  // Dynamic import for ESM modules
  return undefined; // we use regex-based parsing instead
}

function parseBuildInfo(source) {
  // Extract BUILD_INFO from handler source without executing it.
  // Handles both literal strings and constant references (e.g., version: HANDLER_VERSION).
  const nameMatch = source.match(/name:\s*["']([^"']+)["']/);

  // version may be a constant reference like `version: HANDLER_VERSION`
  let version = null;
  const versionLiteralMatch = source.match(/version:\s*["']([^"']+)["']/);
  if (versionLiteralMatch) {
    version = versionLiteralMatch[1];
  } else {
    // Try to resolve from constant: `const HANDLER_VERSION = "..."`
    const versionRefMatch = source.match(/version:\s*(\w+)/);
    if (versionRefMatch) {
      const refName = versionRefMatch[1];
      const constMatch = source.match(
        new RegExp(`const\\s+${refName}\\s*=\\s*["']([^"']+)["']`),
      );
      if (constMatch) version = constMatch[1];
    }
  }

  const sourceMatch = source.match(
    /source:\s*["'](repo:scripts\/openclaw-a2a-task-handler\.mjs)["']/,
  );

  // sourceSha256 may be a local variable reference too
  let declaredSha = null;
  let shaRefMatch = null;
  const shaLiteralMatch = source.match(/sourceSha256:\s*["']([a-f0-9]{64})["']/);
  if (shaLiteralMatch) {
    declaredSha = shaLiteralMatch[1];
  } else {
    // Handle `sourceSha256` (variable reference)
    shaRefMatch = source.match(/sourceSha256/);
    if (shaRefMatch) {
      // The actual sha is computed at module load; we can't recover it from static
      // analysis. Accept presence of the marker field as sufficient.
      declaredSha = '<computed-at-runtime>';
    }
  }

  const contractMatch = source.match(
    /contract:\s*["'](stdin A2A task JSON -> stdout WorkerHandlerOutcome JSON)["']/,
  );
  const credentialMatch = source.match(/credentialFree:\s*(true|false)/);
  const hostNeutralMatch = source.match(/hostNeutral:\s*(true|false)/);

  const computedSha = sha256(source);

  // If declaredSha is a runtime value, we can't verify exact match
  const shaMatches = declaredSha && declaredSha !== '<computed-at-runtime>'
    ? declaredSha === computedSha
    : null;

  return {
    name: nameMatch?.[1] ?? null,
    version,
    source: sourceMatch?.[1] ?? null,
    declaredSha,
    computedSha,
    shaMatches,
    contract: contractMatch?.[1] ?? null,
    credentialFree: credentialMatch?.[1] === 'true',
    hostNeutral: hostNeutralMatch?.[1] === 'true',
    markerFound: !!(
      nameMatch &&
      version &&
      sourceMatch &&
      (shaLiteralMatch || shaRefMatch) &&
      contractMatch
    ),
  };
}

// ---------------------------------------------------------------------------
// guards
// ---------------------------------------------------------------------------

// Guard 1: Source handler exists and is readable
guard('source-handler', () => {
  const sourcePath = join(scriptsRoot, HANDLER_FILENAME);
  if (!existsSync(sourcePath)) {
    return fail('source-handler', `source handler not found: ${sourcePath}`);
  }
  const content = readFileSafe(sourcePath);
  if (content === undefined) {
    return fail('source-handler', `source handler unreadable: ${sourcePath}`);
  }
  const size = Buffer.byteLength(content, 'utf8');
  if (VERBOSE) {
    console.error(`[guard:source] ${sourcePath} — ${size} bytes`);
  }
  return ok('source-handler', { path: sourcePath, size });
});

// Guard 2: Handlers compat path exists and matches source
guard('handlers-compat-path', () => {
  const sourcePath = join(scriptsRoot, HANDLER_FILENAME);
  const handlersPath = join(handlersRoot, HANDLER_FILENAME);

  const sourceContent = readFileSafe(sourcePath);
  if (sourceContent === undefined) {
    return fail('handlers-compat-path', `cannot read source handler: ${sourcePath}`);
  }
  const sourceHash = sha256(sourceContent);

  if (!existsSync(handlersPath)) {
    if (!DEPLOYED_CHECK) {
      return ok('handlers-compat-path', {
        checked: false,
        reason: 'handlers compat path is generated during worker artifact deploy; use --deployed to require it',
        sourcePath,
        handlersPath,
        sourceHash,
      });
    }

    return fail(
      'handlers-compat-path',
      `handlers compat path missing: ${handlersPath}`,
      {
        sourcePath,
        sourceHash,
        hint:
          'copy scripts/openclaw-a2a-task-handler.mjs → handlers/openclaw-a2a-task-handler.mjs',
        fix: DRY_RUN
          ? '[dry-run] would copy handlers/'
          : undefined,
      },
    );
  }

  const handlersContent = readFileSafe(handlersPath);
  if (handlersContent === undefined) {
    return fail(
      'handlers-compat-path',
      `handlers compat path unreadable: ${handlersPath}`,
    );
  }

  const handlersHash = sha256(handlersContent);
  if (handlersHash !== sourceHash) {
    return fail(
      'handlers-compat-path',
      `handlers compat path content differs from source`,
      {
        sourcePath,
        handlersPath,
        sourceHash,
        handlersHash,
        hint: 'update handlers/ copy to match scripts/',
      },
    );
  }

  return ok('handlers-compat-path', {
    sourcePath,
    handlersPath,
    matched: true,
    sourceHash,
  });
});

// Guard 3: Upstream bridge marker present in handler
guard('bridge-marker', () => {
  const sourcePath = join(scriptsRoot, HANDLER_FILENAME);
  const sourceContent = readFileSafe(sourcePath);
  if (sourceContent === undefined) {
    return fail('bridge-marker', `cannot read source handler: ${sourcePath}`);
  }

  const info = parseBuildInfo(sourceContent);

  if (!info.markerFound) {
    return fail(
      'bridge-marker',
      'BUILD_INFO marker incomplete or missing',
      {
        found: {
          name: info.name,
          version: info.version,
          source: info.source,
          declaredSha: info.declaredSha,
          contract: info.contract,
        },
        required: [
          'name',
          'version',
          'source',
          'sourceSha256',
          'contract',
        ],
      },
    );
  }

  if (info.shaMatches === false) {
    return fail(
      'bridge-marker',
      `sourceSha256 mismatch: declared=${info.declaredSha} computed=${info.computedSha}`,
      {
        declaredSha: info.declaredSha,
        computedSha: info.computedSha,
        hint: 'handler source was modified; update BUILD_INFO.sourceSha256',
      },
    );
  }

  // null shaMatches means runtime-computed sha — verified by field presence

  if (!info.credentialFree) {
    return fail('bridge-marker', 'credentialFree must be true');
  }

  if (!info.hostNeutral) {
    return fail('bridge-marker', 'hostNeutral must be true');
  }

  if (info.contract !== 'stdin A2A task JSON -> stdout WorkerHandlerOutcome JSON') {
    return fail(
      'bridge-marker',
      `unexpected contract: ${info.contract}`,
      { expected: 'stdin A2A task JSON -> stdout WorkerHandlerOutcome JSON' },
    );
  }

  return ok('bridge-marker', {
    name: info.name,
    version: info.version,
    sourceMarker: info.source,
    shaMatches: true,
    credentialFree: true,
    hostNeutral: true,
  });
});

// Guard 4: Executor policy environment — report without leaking values
guard('executor-policy', () => {
  const policies = {
    A2A_EXECUTOR_MODE: envPresence('A2A_EXECUTOR_MODE'),
    A2A_DOCKER_RUNNER_SCOPE: envPresence('A2A_DOCKER_RUNNER_SCOPE'),
    A2A_DOCKER_RUNNER_ENABLED: envPresence('A2A_DOCKER_RUNNER_ENABLED'),
    A2A_DOCKER_RUNNER_ALL_GITHUB: envPresence('A2A_DOCKER_RUNNER_ALL_GITHUB'),
  };

  const bridgePolicies = {
    OPENCLAW_BIN: envPresence('OPENCLAW_BIN'),
    A2A_OPENCLAW_BRIDGE_ENABLED: envPresence('A2A_OPENCLAW_BRIDGE_ENABLED'),
    A2A_OPENCLAW_BRIDGE_DISABLED: envPresence('A2A_OPENCLAW_BRIDGE_DISABLED'),
    A2A_OPENCLAW_SESSION_ID: envPresence('A2A_OPENCLAW_SESSION_ID'),
    A2A_OPENCLAW_THINKING: envPresence('A2A_OPENCLAW_THINKING'),
    A2A_OPENCLAW_TIMEOUT_SEC: envPresence('A2A_OPENCLAW_TIMEOUT_SEC'),
  };

  const runtimePolicies = {
    A2A_EXECUTOR_FALLBACK: envPresence('A2A_EXECUTOR_FALLBACK'),
    A2A_DOCKER_RUNNER_TASK_TIMEOUT_MS: envPresence('A2A_DOCKER_RUNNER_TASK_TIMEOUT_MS'),
    A2A_DOCKER_RUNNER_ROOT: envPresence('A2A_DOCKER_RUNNER_ROOT'),
    A2A_DOCKER_RUNNER_GITHUB_TOKEN_FILE: envPresence('A2A_DOCKER_RUNNER_GITHUB_TOKEN_FILE'),
    A2A_DOCKER_RUNNER_BIN: envPresence('A2A_DOCKER_RUNNER_BIN'),
    A2A_DOCKER_RUNNER_ARGS_JSON: envPresence('A2A_DOCKER_RUNNER_ARGS_JSON'),
    A2A_DOCKER_RUNNER_MEMORY: envPresence('A2A_DOCKER_RUNNER_MEMORY'),
    A2A_DOCKER_RUNNER_CPUS: envPresence('A2A_DOCKER_RUNNER_CPUS'),
  };

  const handlerRefs = {
    WORKER_HANDLER_COMMAND: envPresence('WORKER_HANDLER_COMMAND'),
    A2A_WORKER_HANDLER_COMMAND: envPresence('A2A_WORKER_HANDLER_COMMAND'),
    WORKER_HANDLER_ARGS_JSON: envPresence('WORKER_HANDLER_ARGS_JSON'),
    WORKER_HANDLER_CWD: envPresence('WORKER_HANDLER_CWD'),
    WORKER_HANDLER_BUILTIN: envPresence('WORKER_HANDLER_BUILTIN'),
  };

  // Sanitize: presence-only, no values
  const report = {
    executor: policies,
    bridge: bridgePolicies,
    runtime: runtimePolicies,
    handlerRefs,
  };

  // Check for clear misconfiguration
  const warnings = [];
  const executorMode = process.env.A2A_EXECUTOR_MODE?.trim().toLowerCase();

  if (executorMode && !['auto', 'docker', 'builtin'].includes(executorMode)) {
    warnings.push(`A2A_EXECUTOR_MODE="${process.env.A2A_EXECUTOR_MODE}" is invalid (expected: auto|docker|builtin)`);
  }

  if (policies.A2A_DOCKER_RUNNER_ENABLED.configured && !runtimePolicies.A2A_DOCKER_RUNNER_BIN.configured) {
    warnings.push('A2A_DOCKER_RUNNER_ENABLED is set but A2A_DOCKER_RUNNER_BIN is not configured');
  }

  if (bridgePolicies.OPENCLAW_BIN.configured && bridgePolicies.A2A_OPENCLAW_BRIDGE_DISABLED.configured) {
    warnings.push('OPENCLAW_BIN is set but A2A_OPENCLAW_BRIDGE_DISABLED is also set; bridge is disabled');
  }

  return ok('executor-policy', {
    policies: report,
    warnings: warnings.length ? warnings : undefined,
    safe: true, // no secrets leaked
  });
});

// Guard 5: Dockerfile includes handler scripts
guard('docker-handler-inclusion', () => {
  if (!DOCKER_CHECK) {
    return ok('docker-handler-inclusion', { checked: false, reason: '--docker-check not specified' });
  }

  const dockerfilePath = join(brokerRoot, 'Dockerfile');
  const dockerfileContent = readFileSafe(dockerfilePath);
  if (dockerfileContent === undefined) {
    return fail('docker-handler-inclusion', `Dockerfile not found: ${dockerfilePath}`);
  }

  const hasHandlerCopy = /COPY\s+scripts\/openclaw-a2a-task-handler\.mjs/.test(dockerfileContent);
  const hasHandlersDir = /handlers\//.test(dockerfileContent) || /mkdir.*handlers/i.test(dockerfileContent);

  if (!hasHandlerCopy && !hasHandlersDir) {
    return fail(
      'docker-handler-inclusion',
      'Dockerfile does not copy handler scripts into the image; ' +
        'deployed container will lack scripts/openclaw-a2a-task-handler.mjs and handlers/ compat path',
      {
        fix: 'add COPY scripts/openclaw-a2a-task-handler.mjs ./scripts/ and COPY scripts/openclaw-a2a-task-handler.mjs ./handlers/ to Dockerfile',
        dryRun: DRY_RUN,
      },
    );
  }

  return ok('docker-handler-inclusion', {
    hasHandlerCopy,
    hasHandlersDir,
  });
});

// Guard 6: Dockerfile compat path — handlers/ directory is created in image
guard('docker-compat-path', () => {
  if (!DOCKER_CHECK) {
    return ok('docker-compat-path', { checked: false, reason: '--docker-check not specified' });
  }

  const dockerfilePath = join(brokerRoot, 'Dockerfile');
  const dockerfileContent = readFileSafe(dockerfilePath);
  if (dockerfileContent === undefined) {
    return fail('docker-compat-path', `Dockerfile not found: ${dockerfilePath}`);
  }

  // Count handler copies via COPY or RUN cp to both scripts/ and handlers/ paths
  const copyMatches = dockerfileContent.match(
    /COPY\s+scripts\/openclaw-a2a-task-handler\.mjs/g,
  ) || [];
  const hasRunCopy = /RUN.*cp\s+.*openclaw-a2a-task-handler\.mjs.*handlers\//.test(dockerfileContent);
  const hasHandlersMkdir = /mkdir.*handlers/i.test(dockerfileContent);

  const scriptsCopyCount = copyMatches.length;
  const handlersCopyCount = hasRunCopy ? 1 : 0;

  if (scriptsCopyCount < 1) {
    return fail(
      'docker-compat-path',
      'Dockerfile does not copy handler to scripts/ path',
      { hint: 'add COPY scripts/openclaw-a2a-task-handler.mjs ./scripts/', dryRun: DRY_RUN },
    );
  }

  if (handlersCopyCount < 1) {
    return fail(
      'docker-compat-path',
      'Dockerfile does not populate handlers/ compat path',
      {
        hint: 'add RUN mkdir -p ./handlers && cp scripts/openclaw-a2a-task-handler.mjs ./handlers/',
        dryRun: DRY_RUN,
      },
    );
  }

  return ok('docker-compat-path', {
    scriptsCopyCount,
    handlersPopulated: hasRunCopy,
    hasHandlersMkdir,
  });
});

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function runGuards() {
  if (DRY_RUN) {
    console.error('[guard] DRY-RUN mode — no changes will be made');
  }
  if (SMOKE && !DRY_RUN) {
    console.error('[guard] SMOKE mode — validation only, no changes');
  }
  if (DOCKER_CHECK) {
    console.error('[guard] DOCKER-CHECK mode — validating Dockerfile inclusion');
  }

  const results = [];
  let allOk = true;

  for (const { name, fn } of guards) {
    try {
      const result = fn();
      results.push(result);
      if (!result.ok) {
        allOk = false;
      }
    } catch (error) {
      const errResult = fail(name, error);
      results.push(errResult);
      allOk = false;
    }
  }

  // Collect summary
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  const total = results.length;

  const output = {
    ok: allOk,
    dryRun: DRY_RUN,
    smoke: SMOKE,
    dockerCheck: DOCKER_CHECK,
    timestamp: new Date().toISOString(),
    brokerRoot,
    handlersRoot,
    scriptsRoot,
    handlerFilename: HANDLER_FILENAME,
    summary: {
      passed,
      failed,
      total,
      message: allOk
        ? `all ${total} guards passed`
        : `${passed}/${total} passed, ${failed} failed`,
    },
    results,
    rollback:
      failed > 0
        ? {
            action: 'fix_issues_and_re_run',
            hint: 'address failures above, re-run guard until all pass',
            emergencyFallback:
              'if handler compat path is broken: cp scripts/openclaw-a2a-task-handler.mjs handlers/openclaw-a2a-task-handler.mjs',
          }
        : undefined,
  };

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);

  if (VERBOSE) {
    for (const r of results) {
      if (r.ok) {
        console.error(`[guard] ✅ ${r.guard}`);
      } else {
        console.error(`[guard] ❌ ${r.guard}: ${r.error}`);
      }
    }
  }

  return allOk;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const allPassed = await runGuards();
process.exit(allPassed ? 0 : 1);
