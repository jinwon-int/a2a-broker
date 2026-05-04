#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import process from 'node:process';

const ISSUE_URL = 'https://github.com/jinwon-int/a2a-broker/issues/311';
const PARENT_URL = 'https://github.com/jinwon-int/a2a-broker/issues/294';

const REQUIRED_MATRIX_CELLS = [
  ['brokerWorkerResultProjection', 'broker -> worker -> result projection'],
  ['workerHeartbeatObserved', 'worker heartbeat observed'],
  ['staleTaskDetected', 'stale task detection'],
  ['manualRequeueObserved', 'manual stale requeue observed'],
  ['retryAttemptVisible', 'retry/task-attempt visibility'],
  ['receiptGapObservable', 'receipt-gap observability'],
  ['noLiveDeliveryOrAck', 'no live delivery or real ACK'],
];

const FORBIDDEN_SAFETY_FLAGS = [
  ['productionDeploy', 'production deploy'],
  ['gatewayRestart', 'Gateway restart'],
  ['liveTelegramSend', 'live Telegram send'],
  ['dbMutation', 'database mutation'],
  ['realTerminalOutboxAck', 'real terminal-outbox ACK'],
];

function usage() {
  return `Usage: node scripts/broker-lifecycle-proof-evidence.mjs --input <evidence.json> [--format markdown]\n\nRenders a reusable no-live lifecycle/recovery proof comment for #311/#294.\nThe collector is read-only: it validates sanitized evidence and refuses Done if\nproduction deploys, Gateway restarts, live Telegram sends, DB mutations, or real\nterminal-outbox ACKs are reported.\n`;
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

function clean(value, fallback = '<missing>') {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value);
}

function asBool(value) {
  return value === true || value === 'yes';
}

function numberValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function requireField(blockers, obj, path, label = path) {
  const value = path.split('.').reduce((acc, key) => acc?.[key], obj);
  if (value === undefined || value === null || value === '') blockers.push(`missing ${label}`);
  return value;
}

function validateMatrix(evidence, blockers) {
  const matrix = evidence.noLiveCanaryProofMatrix ?? {};
  for (const [id, label] of REQUIRED_MATRIX_CELLS) {
    const cell = matrix[id];
    if (!cell) {
      blockers.push(`missing noLiveCanaryProofMatrix.${id} (${label})`);
      continue;
    }
    if (cell.status !== 'pass') blockers.push(`noLiveCanaryProofMatrix.${id}.status must be pass`);
    if (!cell.evidence || typeof cell.evidence !== 'string') blockers.push(`noLiveCanaryProofMatrix.${id}.evidence is required`);
  }
}

function validateSafety(evidence, blockers) {
  if (evidence.rolloutMode !== 'no-live') blockers.push('rolloutMode must be no-live');
  const safety = evidence.safety ?? {};
  for (const [field, label] of FORBIDDEN_SAFETY_FLAGS) {
    if (asBool(safety[field])) blockers.push(`no-live proof must not report ${label}`);
  }
}

function validateRecovery(evidence, blockers) {
  const recovery = evidence.recovery ?? {};
  requireField(blockers, evidence, 'recovery.staleTaskId');
  requireField(blockers, evidence, 'recovery.workerId');

  const heartbeatAgeMs = numberValue(recovery.heartbeatAgeMs);
  const staleAfterMs = numberValue(recovery.staleAfterMs);
  if (heartbeatAgeMs === null || staleAfterMs === null) {
    blockers.push('recovery.heartbeatAgeMs and recovery.staleAfterMs must be numbers');
  } else if (heartbeatAgeMs < staleAfterMs) {
    blockers.push('recovery.heartbeatAgeMs must be greater than or equal to recovery.staleAfterMs');
  }

  const before = numberValue(recovery.requeueCountBefore);
  const after = numberValue(recovery.requeueCountAfter);
  if (before === null || after === null) {
    blockers.push('recovery.requeueCountBefore and recovery.requeueCountAfter must be numbers');
  } else if (after <= before) {
    blockers.push('recovery.requeueCountAfter must be greater than recovery.requeueCountBefore');
  }

  const attemptBefore = numberValue(recovery.attemptBefore);
  const attemptAfter = numberValue(recovery.attemptAfter);
  if (attemptBefore === null || attemptAfter === null) {
    blockers.push('recovery.attemptBefore and recovery.attemptAfter must be numbers');
  } else if (attemptAfter <= attemptBefore) {
    blockers.push('recovery.attemptAfter must be greater than recovery.attemptBefore');
  }
}

function validateReceiptGap(evidence, blockers) {
  requireField(blockers, evidence, 'receiptGap.outboxId');
  if (!asBool(evidence.receiptGap?.unacknowledgedReplayed)) {
    blockers.push('receiptGap.unacknowledgedReplayed must be yes/true');
  }
  if (asBool(evidence.receiptGap?.realAckPerformed)) {
    blockers.push('receiptGap.realAckPerformed must be false/no for this no-live lane');
  }
  if (evidence.receiptGap?.ackStatus === 'receipt_confirmed') {
    blockers.push('receiptGap.ackStatus must not be receipt_confirmed when no real ACK is performed');
  }
}

function validateEvidence(evidence) {
  const blockers = [];
  requireField(blockers, evidence, 'candidates.broker', 'candidates.broker');
  requireField(blockers, evidence, 'ci.command', 'ci.command');
  requireField(blockers, evidence, 'ci.result', 'ci.result');
  requireField(blockers, evidence, 'lifecycle.taskId', 'lifecycle.taskId');
  requireField(blockers, evidence, 'lifecycle.workerId', 'lifecycle.workerId');
  if (!asBool(evidence.lifecycle?.resultProjectionObserved)) {
    blockers.push('lifecycle.resultProjectionObserved must be yes/true');
  }
  validateMatrix(evidence, blockers);
  validateRecovery(evidence, blockers);
  validateReceiptGap(evidence, blockers);
  validateSafety(evidence, blockers);
  return blockers;
}

function renderMatrix(evidence) {
  return REQUIRED_MATRIX_CELLS.map(([id, label]) => `- ${label}: ${clean(evidence.noLiveCanaryProofMatrix?.[id]?.status)} — ${clean(evidence.noLiveCanaryProofMatrix?.[id]?.evidence)}`).join('\n');
}

function renderDone(evidence) {
  return `Done: #311 no-live lifecycle/recovery proof gate\n\nParent: #294\n\nCandidate:\n- broker: ${clean(evidence.candidates?.broker)}\n- rollout mode: ${clean(evidence.rolloutMode)}\n\nValidation:\n- command: ${clean(evidence.ci?.command)}\n- result: ${clean(evidence.ci?.result)}\n\nNo-live canary proof matrix:\n${renderMatrix(evidence)}\n\nLifecycle projection:\n- task id: ${clean(evidence.lifecycle?.taskId)}\n- worker id: ${clean(evidence.lifecycle?.workerId)}\n- terminal/result projection observed: ${asBool(evidence.lifecycle?.resultProjectionObserved) ? 'yes' : 'no'}\n\nStale/retry/requeue visibility:\n- stale task id: ${clean(evidence.recovery?.staleTaskId)}\n- heartbeat age/stale threshold: ${clean(evidence.recovery?.heartbeatAgeMs)}ms / ${clean(evidence.recovery?.staleAfterMs)}ms\n- requeue count: ${clean(evidence.recovery?.requeueCountBefore)} -> ${clean(evidence.recovery?.requeueCountAfter)}\n- attempt: ${clean(evidence.recovery?.attemptBefore)} -> ${clean(evidence.recovery?.attemptAfter)}\n\nReceipt-gap observability:\n- outbox id: ${clean(evidence.receiptGap?.outboxId)}\n- unacknowledged replayed: ${asBool(evidence.receiptGap?.unacknowledgedReplayed) ? 'yes' : 'no'}\n- real ACK performed: ${asBool(evidence.receiptGap?.realAckPerformed) ? 'yes' : 'no'}\n- ACK status: ${clean(evidence.receiptGap?.ackStatus, 'not-confirmed')}\n\nSafety gate:\n- production deploy: ${asBool(evidence.safety?.productionDeploy) ? 'yes' : 'no'}\n- Gateway restart: ${asBool(evidence.safety?.gatewayRestart) ? 'yes' : 'no'}\n- live Telegram send: ${asBool(evidence.safety?.liveTelegramSend) ? 'yes' : 'no'}\n- DB mutation: ${asBool(evidence.safety?.dbMutation) ? 'yes' : 'no'}\n- real terminal-outbox ACK: ${asBool(evidence.safety?.realTerminalOutboxAck) ? 'yes' : 'no'}\n\nLinks:\n- issue: ${ISSUE_URL}\n- parent: ${PARENT_URL}`;
}

function renderBlock(blockers) {
  return `Block: #311 no-live lifecycle/recovery proof gate is incomplete\n\nMissing or failed gates:\n${blockers.map((item) => `- ${item}`).join('\n')}\n\nNo production deploy, Gateway restart, live Telegram send, DB mutation, or real terminal-outbox ACK was performed by this collector.\n\nLinks:\n- issue: ${ISSUE_URL}\n- parent: ${PARENT_URL}`;
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
    console.log(renderBlock(blockers));
    return 1;
  }

  console.log(renderDone(evidence));
  return 0;
}

try {
  process.exitCode = main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
