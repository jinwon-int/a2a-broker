#!/usr/bin/env node
// Render the deterministic no-live receipt-gate canary matrix.
// Requires `npm run build` first so the compiled core module is available.

import process from 'node:process';
import {
  renderReceiptGateCanaryMarkdown,
  runReceiptGateCanaryMatrix,
} from '../dist/core/receipt-gate-canary.js';

function parseArgs(argv) {
  return { json: argv.includes('--json') };
}

const options = parseArgs(process.argv.slice(2));
const matrix = runReceiptGateCanaryMatrix();

if (options.json) {
  console.log(JSON.stringify(matrix, null, 2));
} else {
  console.log(renderReceiptGateCanaryMarkdown(matrix));
}

process.exit(matrix.overallVerdict === 'pass' ? 0 : 1);
