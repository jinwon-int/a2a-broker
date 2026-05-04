#!/usr/bin/env node
// Render the deterministic broker no-live rehearsal manifest.
// Requires `npm run build` first so the compiled core module is available.

import process from 'node:process';
import {
  buildBrokerRehearsalManifest,
  renderBrokerRehearsalManifestMarkdown,
} from '../dist/core/broker-rehearsal-manifest.js';

function parseArgs(argv) {
  const options = { json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--run-id') options.runId = argv[++index];
    else if (arg === '--worker') options.worker = argv[++index];
    else if (arg === '--repo') options.repo = argv[++index];
    else if (arg === '--issue') options.issueNumber = Number(argv[++index]);
    else if (arg === '--generated-at') options.generatedAt = argv[++index];
    else if (arg === '--help' || arg === '-h') {
      console.log([
        'Usage: node scripts/broker-rehearsal-manifest.mjs [--json] [--run-id ID] [--worker NAME] [--repo OWNER/REPO] [--issue N]',
        '',
        'No-live rehearsal only: renders evidence without provider sends, DB writes, Gateway restarts, or terminal-outbox ACKs.',
      ].join('\n'));
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const manifest = buildBrokerRehearsalManifest(options);

if (options.json) {
  console.log(JSON.stringify(manifest, null, 2));
} else {
  console.log(renderBrokerRehearsalManifestMarkdown(manifest));
}

process.exit(manifest.overallVerdict === 'pass' ? 0 : 1);
