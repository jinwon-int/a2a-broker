#!/usr/bin/env node
// Render a deterministic, read-only source-public approval rehearsal packet.
// Requires `npm run build` first so the compiled core module is available.

import process from 'node:process';
import {
  buildSourcePublicApprovalRehearsalBundle,
  renderSourcePublicApprovalRehearsalMarkdown,
} from '../dist/core/source-public-approval-rehearsal.js';

const evidenceKeys = new Set([
  'publicReadinessScan',
  'bootstrapContextExcluded',
  'localTests',
  'licenseDecision',
  'externalScannerEvidence',
  'explicitOperatorApproval',
]);
const evidenceStatuses = new Set(['pass', 'warn', 'fail', 'pending']);

function parseArgs(argv) {
  const options = { json: false, evidence: {}, priorApprovalIntentIds: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--run-id') options.runId = argv[++index];
    else if (arg === '--worker') options.worker = argv[++index];
    else if (arg === '--repo') options.repo = argv[++index];
    else if (arg === '--issue') options.issueNumber = Number(argv[++index]);
    else if (arg === '--parent') options.parentIssueUrl = argv[++index];
    else if (arg === '--generated-at') options.generatedAt = argv[++index];
    else if (arg === '--operator') options.operator = argv[++index];
    else if (arg === '--approval-intent-id') options.approvalIntentId = argv[++index];
    else if (arg === '--prior-intent-id') options.priorApprovalIntentIds.push(argv[++index]);
    else if (arg === '--evidence') {
      const [key, status] = String(argv[++index] ?? '').split('=');
      if (!evidenceKeys.has(key) || !evidenceStatuses.has(status)) {
        throw new Error(`Invalid evidence override: ${key}=${status}`);
      }
      options.evidence[key] = status;
    } else if (arg === '--help' || arg === '-h') {
      console.log([
        'Usage: node scripts/source-public-approval-rehearsal.mjs [--json] [--run-id ID] [--worker NAME] [--repo OWNER/REPO] [--issue N]',
        '       [--generated-at ISO] [--operator NAME] [--approval-intent-id ID] [--prior-intent-id ID]',
        '       [--evidence key=pass|warn|fail|pending]',
        '',
        'Read-only/no-live only: renders approval packets, evidence bundles, Terminal Brief rehearsal, replay/no-duplicate proof, rollback/abort paths, and GO_CANDIDATE/NO_GO/NEEDS_OPERATOR_APPROVAL decision output.',
      ].join('\n'));
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const bundle = buildSourcePublicApprovalRehearsalBundle(options);

if (options.json) {
  console.log(JSON.stringify(bundle, null, 2));
} else {
  console.log(renderSourcePublicApprovalRehearsalMarkdown(bundle));
}

process.exit(bundle.decision.value === 'NO_GO' ? 1 : 0);
