#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import process from 'node:process';

const COMMAND_CENTER_URL = 'https://github.com/jinwon-int/a2a-broker/issues/241';
const PLUGIN_REGRESSION_URL = 'https://github.com/jinwon-int/openclaw-plugin-a2a/issues/168';
const PLUGIN_PR_URL = 'https://github.com/jinwon-int/openclaw-plugin-a2a/pull/164';
const VALID_RECEIPT_EVIDENCE = new Set(['operator_visible', 'operator_confirmed', 'provider_delivery_receipt']);
const APPROVAL_FIELDS = [
  'environment',
  'node',
  'brokerSha',
  'pluginSha',
  'openclawSha',
  'telegramTargetClass',
  'maxSends',
  'rollbackOwner',
  'stopCondition',
];
const NO_LIVE_ROLLOUT_CELLS = [
  ['ciSafeBrokerRegression', 'CI-safe broker regression'],
  ['readOnlyTerminalOutboxPreflight', 'read-only terminal-outbox preflight'],
  ['receiptGateRejectsSendSuccessOnly', 'receipt gate rejects send-success-only ACK'],
  ['reconcileReplayBeforeReceipt', 'reconcile_unacked replay before receipt'],
  ['duplicateSuppressionNoTelegram', 'duplicate suppression with no Telegram send'],
  ['rollbackNoLiveCleanup', 'rollback/cleanup leaves no-live state safe'],
];

function usage() {
  return `Usage: node scripts/receipt-gated-smoke-evidence.mjs --input <evidence.json> [--format markdown]\n\nRenders the final #241/#168 receipt-gated ACK smoke evidence comment from a sanitized\nJSON evidence file. This collector is read-only: it never deploys, restarts Gateway, sends\nTelegram, or ACKs terminal outbox records. Missing receipt-gate proof renders a Block\ncomment instead of a false Done.\n`;
}

function parseArgs(argv) {
  const options = { format: 'markdown' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      i += 1;
      return value;
    };
    if (arg === '--input') options.input = next();
    else if (arg === '--format') options.format = next();
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function asBool(value) {
  return value === true || value === 'yes';
}

function clean(value, fallback = '<missing>') {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value);
}

function hasHttpUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function requireField(blockers, obj, path, label = path) {
  const value = path.split('.').reduce((acc, key) => acc?.[key], obj);
  if (value === undefined || value === null || value === '') blockers.push(`missing ${label}`);
  return value;
}

function validateApprovalGate(evidence, blockers) {
  const liveGate = evidence.liveSendGate ?? {};
  const sendsExecuted = Number(liveGate.sendsExecuted ?? 0);
  if (!Number.isFinite(sendsExecuted) || sendsExecuted < 0) {
    blockers.push('liveSendGate.sendsExecuted must be a non-negative number');
    return;
  }

  if (evidence.rolloutMode === 'no-live') {
    if (sendsExecuted !== 0) blockers.push('no-live rollout requires liveSendGate.sendsExecuted to be 0');
    if (liveGate.approvalCommentUrl) blockers.push('no-live rollout must not include liveSendGate.approvalCommentUrl');
    return;
  }

  if (sendsExecuted === 0) return;

  if (!hasHttpUrl(liveGate.approvalCommentUrl)) {
    blockers.push('live send executed but liveSendGate.approvalCommentUrl is missing or not an http(s) URL');
  }

  const approval = liveGate.approval ?? {};
  for (const field of APPROVAL_FIELDS) {
    requireField(blockers, approval, field, `liveSendGate.approval.${field}`);
  }

  const maxSends = Number(approval.maxSends);
  if (!Number.isFinite(maxSends) || maxSends < sendsExecuted) {
    blockers.push('liveSendGate.approval.maxSends must cover liveSendGate.sendsExecuted');
  }
}

function validateNoLiveRolloutProofMatrix(evidence, blockers) {
  if (evidence.rolloutMode !== 'no-live') {
    blockers.push('rolloutMode must be no-live for receipt-gated terminal notification rollout proof');
  }

  const matrix = evidence.noLiveRolloutProofMatrix ?? {};
  for (const [id, label] of NO_LIVE_ROLLOUT_CELLS) {
    const cell = matrix[id];
    if (!cell) {
      blockers.push(`missing noLiveRolloutProofMatrix.${id} (${label})`);
      continue;
    }
    if (cell.status !== 'pass') blockers.push(`noLiveRolloutProofMatrix.${id}.status must be pass`);
    if (!cell.evidence || typeof cell.evidence !== 'string') {
      blockers.push(`noLiveRolloutProofMatrix.${id}.evidence is required`);
    }
  }
}

function validateEvidence(evidence) {
  const blockers = [];
  requireField(blockers, evidence, 'candidates.broker', 'candidates.broker');
  requireField(blockers, evidence, 'candidates.plugin', 'candidates.plugin');
  requireField(blockers, evidence, 'ci.command', 'ci.command');
  requireField(blockers, evidence, 'ci.result', 'ci.result');
  requireField(blockers, evidence, 'dryRunAckGate.outboxId', 'dryRunAckGate.outboxId');

  if (!asBool(evidence.dryRunAckGate?.invalidAckRejected)) {
    blockers.push('dryRunAckGate.invalidAckRejected must be yes/true');
  }
  if (!asBool(evidence.dryRunAckGate?.reconcileUnackedReplayedBeforeReceipt)) {
    blockers.push('dryRunAckGate.reconcileUnackedReplayedBeforeReceipt must be yes/true');
  }
  if (!VALID_RECEIPT_EVIDENCE.has(evidence.dryRunAckGate?.validReceiptEvidence)) {
    blockers.push(`dryRunAckGate.validReceiptEvidence must be one of ${[...VALID_RECEIPT_EVIDENCE].join(', ')}`);
  }
  if (evidence.dryRunAckGate?.ackStatus !== 'receipt_confirmed') {
    blockers.push('dryRunAckGate.ackStatus must be receipt_confirmed');
  }

  requireField(blockers, evidence, 'duplicateGuard.dedupeKey', 'duplicateGuard.dedupeKey');
  const plannedSends = Number(evidence.duplicateGuard?.plannedTelegramSendsForSameId);
  if (!Number.isFinite(plannedSends) || plannedSends > 1) {
    blockers.push('duplicateGuard.plannedTelegramSendsForSameId must be 0 or 1');
  }
  if (!asBool(evidence.duplicateGuard?.replayAfterReceiptClosedRetryCandidate)) {
    blockers.push('duplicateGuard.replayAfterReceiptClosedRetryCandidate must be yes/true');
  }

  if (evidence.rollbackCleanup?.notifierLiveDeliveryDisabledOrUnchanged !== true && evidence.rollbackCleanup?.notifierLiveDeliveryDisabledOrUnchanged !== 'yes') {
    blockers.push('rollbackCleanup.notifierLiveDeliveryDisabledOrUnchanged must be yes/true');
  }

  validateNoLiveRolloutProofMatrix(evidence, blockers);
  validateApprovalGate(evidence, blockers);
  return blockers;
}

function yn(value) {
  return asBool(value) ? 'yes' : 'no';
}

function renderDone(evidence) {
  const liveGate = evidence.liveSendGate ?? {};
  const approved = liveGate.approvalCommentUrl ? liveGate.approvalCommentUrl : 'no';
  return `Done: #241/#168 receipt-gated ACK canary smoke

Candidates:
- broker: ${clean(evidence.candidates?.broker)}
- plugin: ${clean(evidence.candidates?.plugin)}
- openclaw: ${clean(evidence.candidates?.openclaw, 'not-live/staged')}
- rollout mode: ${clean(evidence.rolloutMode)}

CI-safe proof:
- command: ${clean(evidence.ci?.command)}
- result: ${clean(evidence.ci?.result)}

No-live rollout proof matrix:
${NO_LIVE_ROLLOUT_CELLS.map(([id, label]) => `- ${label}: ${clean(evidence.noLiveRolloutProofMatrix?.[id]?.status)} — ${clean(evidence.noLiveRolloutProofMatrix?.[id]?.evidence)}`).join('\n')}

Dry-run ACK gate:
- outbox id: ${clean(evidence.dryRunAckGate?.outboxId)}
- invalid ACK rejected: ${yn(evidence.dryRunAckGate?.invalidAckRejected)}${evidence.dryRunAckGate?.invalidAckStatus ? ` (${evidence.dryRunAckGate.invalidAckStatus})` : ''}
- reconcile_unacked replayed before receipt: ${yn(evidence.dryRunAckGate?.reconcileUnackedReplayedBeforeReceipt)}
- valid receipt evidence: ${clean(evidence.dryRunAckGate?.validReceiptEvidence)}
- ack status: ${clean(evidence.dryRunAckGate?.ackStatus)}

Duplicate guard:
- dedupe key: ${clean(evidence.duplicateGuard?.dedupeKey)}
- planned Telegram sends for same id: ${clean(evidence.duplicateGuard?.plannedTelegramSendsForSameId)}
- replay after receipt closed retry candidate: ${yn(evidence.duplicateGuard?.replayAfterReceiptClosedRetryCandidate)}

Live-send gate:
- approved: ${approved}
- sends executed: ${clean(liveGate.sendsExecuted ?? 0)}

Rollback/cleanup:
- notifier live delivery disabled or unchanged: ${yn(evidence.rollbackCleanup?.notifierLiveDeliveryDisabledOrUnchanged)}
- unacknowledged records remain replayable: ${clean(evidence.rollbackCleanup?.unacknowledgedRecordsRemainReplayable, 'not-applicable')}

Links:
- command center: ${COMMAND_CENTER_URL}
- plugin regression: ${PLUGIN_REGRESSION_URL}
- plugin PR: ${PLUGIN_PR_URL}`;
}

function renderBlock(evidence, blockers) {
  return `Block: #241/#168 receipt-gated ACK canary smoke evidence is incomplete\n\nMissing or failed gates:\n${blockers.map((item) => `- ${item}`).join('\n')}\n\nNo production deploy, Gateway restart, live Telegram send, or real terminal-outbox ACK was performed by this collector.\n\nLinks:\n- command center: ${COMMAND_CENTER_URL}\n- plugin regression: ${PLUGIN_REGRESSION_URL}\n- plugin PR: ${PLUGIN_PR_URL}`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return 0;
  }
  if (options.format !== 'markdown') throw new Error('only --format markdown is supported');
  if (!options.input) throw new Error('--input is required');

  const evidence = JSON.parse(readFileSync(options.input, 'utf8'));
  const blockers = validateEvidence(evidence);
  if (blockers.length) {
    console.log(renderBlock(evidence, blockers));
    return 1;
  }

  console.log(renderDone(evidence));
  return 0;
}

try {
  process.exitCode = main();
} catch (err) {
  console.error(`receipt-gated-smoke-evidence: ${err.message}`);
  process.exitCode = 2;
}
