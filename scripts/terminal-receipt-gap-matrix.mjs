#!/usr/bin/env node
// Render the deterministic no-live matrix for current terminal receipt gaps.

import {
  renderTerminalReceiptGapMarkdown,
  runTerminalReceiptGapMatrix,
} from '../dist/core/terminal-receipt-gap-matrix.js';

const matrix = runTerminalReceiptGapMatrix();
console.log(renderTerminalReceiptGapMarkdown(matrix));
process.exit(matrix.overallVerdict === 'pass' ? 0 : 1);
