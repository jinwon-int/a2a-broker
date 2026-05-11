#!/usr/bin/env node
// Render the deterministic no-live receipt-gate canary matrix.
// This runner is intentionally independent of a pre-existing dist/ build: it
// uses the compiled module when available and otherwise falls back to a small
// dependency-free runtime copy. It never calls provider APIs or ACKs production
// terminal-outbox rows.

import process from 'node:process';

const DEFAULT_DIST_URL = new URL('../dist/core/receipt-gate-canary.js', import.meta.url);
const DEFAULT_RUNTIME_URL = new URL('./receipt-gate-canary-runtime.mjs', import.meta.url);

function parseArgs(argv) {
  return { json: argv.includes('--json') };
}

export async function loadReceiptGateCanaryModule(options = {}) {
  const distUrl = options.distUrl ?? DEFAULT_DIST_URL;
  try {
    return await import(distUrl.href ?? distUrl);
  } catch (error) {
    if (!isMissingModuleError(error)) throw error;
  }

  const runtimeUrl = options.runtimeUrl ?? DEFAULT_RUNTIME_URL;
  return import(runtimeUrl.href ?? runtimeUrl);
}

function isMissingModuleError(error) {
  return error?.code === 'ERR_MODULE_NOT_FOUND' || error?.code === 'MODULE_NOT_FOUND';
}

export async function runCli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const {
    renderReceiptGateCanaryMarkdown,
    runReceiptGateCanaryMatrix,
  } = await loadReceiptGateCanaryModule();
  const matrix = runReceiptGateCanaryMatrix();

  if (options.json) {
    console.log(JSON.stringify(matrix, null, 2));
  } else {
    console.log(renderReceiptGateCanaryMarkdown(matrix));
  }

  return matrix.overallVerdict === 'pass' ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli().then((code) => {
    process.exit(code);
  }).catch((error) => {
    console.error(`fatal: ${error.message}`);
    process.exit(2);
  });
}
