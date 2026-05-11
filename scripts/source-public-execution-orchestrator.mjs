#!/usr/bin/env node
// Render a deterministic, dry-run/simulate-only final approval execution plan.
// Requires `npm run build` first so the compiled core module is available.

import process from 'node:process';
import {
  buildSourcePublicExecutionPlanBundle,
  renderSourcePublicExecutionPlanMarkdown,
} from '../dist/core/source-public-execution-orchestrator.js';

const preflightKeys = new Set([
  'evidencePacketApproved',
  'scannerHistoryBound',
  'bootstrapContextExcluded',
  'rollbackAbortRunbookPresent',
  'explicitOperatorGatePresent',
]);
const preflightStatuses = new Set(['pass', 'warn', 'fail', 'pending']);

function parseArgs(argv) {
  const options = {
    json: false,
    approvedEvidencePacket: {
      packetId: 'packet-required',
      intentId: 'intent-required',
      idempotencyKey: 'approval-idempotency-required',
      evidenceBundleId: 'evidence-bundle-required',
      decision: 'NEEDS_OPERATOR_APPROVAL',
    },
    scannerHistory: {},
    preflights: {},
    priorExecutionKeys: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--run-id') options.runId = argv[++index];
    else if (arg === '--worker') options.worker = argv[++index];
    else if (arg === '--repo') options.repo = argv[++index];
    else if (arg === '--issue') options.issueNumber = Number(argv[++index]);
    else if (arg === '--parent') options.parentIssueUrl = argv[++index];
    else if (arg === '--generated-at') options.generatedAt = argv[++index];
    else if (arg === '--mode') {
      const mode = argv[++index];
      if (mode !== 'dry-run' && mode !== 'simulate') throw new Error(`Invalid mode: ${mode}`);
      options.runMode = mode;
    } else if (arg === '--packet-id') options.approvedEvidencePacket.packetId = argv[++index];
    else if (arg === '--approval-intent-id') options.approvedEvidencePacket.intentId = argv[++index];
    else if (arg === '--approval-idempotency-key') options.approvedEvidencePacket.idempotencyKey = argv[++index];
    else if (arg === '--evidence-bundle-id') options.approvedEvidencePacket.evidenceBundleId = argv[++index];
    else if (arg === '--evidence-decision') options.approvedEvidencePacket.decision = argv[++index];
    else if (arg === '--approved-by') options.approvedEvidencePacket.approvedBy = argv[++index];
    else if (arg === '--approved-at') options.approvedEvidencePacket.approvedAt = argv[++index];
    else if (arg === '--scanner-run-id') options.scannerHistory.scannerRunId = argv[++index];
    else if (arg === '--scanner-digest') options.scannerHistory.scannerDigest = argv[++index];
    else if (arg === '--history-cursor') options.scannerHistory.historyCursor = argv[++index];
    else if (arg === '--history-digest') options.scannerHistory.historyDigest = argv[++index];
    else if (arg === '--prior-execution-key') options.priorExecutionKeys.push(argv[++index]);
    else if (arg === '--preflight') {
      const [key, status] = String(argv[++index] ?? '').split('=');
      if (!preflightKeys.has(key) || !preflightStatuses.has(status)) {
        throw new Error(`Invalid preflight override: ${key}=${status}`);
      }
      options.preflights[key] = status;
    } else if (arg === '--help' || arg === '-h') {
      console.log([
        'Usage: node scripts/source-public-execution-orchestrator.mjs [--json] [--mode dry-run|simulate]',
        '       [--run-id ID] [--worker NAME] [--repo OWNER/REPO] [--issue N] [--parent URL]',
        '       --packet-id ID --approval-intent-id ID --approval-idempotency-key KEY --evidence-bundle-id ID --evidence-decision GO_CANDIDATE',
        '       --scanner-run-id ID --scanner-digest sha256:HEX --history-cursor ID --history-digest sha256:HEX',
        '       [--preflight key=pass|warn|fail|pending] [--prior-execution-key KEY]',
        '',
        'Dry-run/simulate only: renders a final approval packet, execution ledger/idempotency key, scanner/history binding, preflight failure semantics, and rollback/abort runbook. It performs no approval, release, visibility, provider, deploy/restart, ACK, DB, community, merge, or force-push action.',
      ].join('\n'));
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

const options = parseArgs(process.argv.slice(2));
const bundle = buildSourcePublicExecutionPlanBundle(options);

if (options.json) {
  console.log(JSON.stringify(bundle, null, 2));
} else {
  console.log(renderSourcePublicExecutionPlanMarkdown(bundle));
}

process.exit(bundle.decision.value === 'PREFLIGHT_BLOCKED' ? 1 : 0);
