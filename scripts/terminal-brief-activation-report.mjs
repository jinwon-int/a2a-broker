#!/usr/bin/env node
// Read-only Terminal Brief activation gate report.
// No-live by design: this script renders bounded activation evidence only. It never
// deploys, restarts Gateway, calls a notification provider, mutates DB state, or
// ACKs terminal-outbox records.

import process from 'node:process';

const ISSUE = '#392';
const PARENT = '#383';
const HTTP_URL = /^https?:\/\//;

const GATES = [
  {
    id: 'codeMerged',
    title: 'Code merged',
    evidenceFlags: ['--code-merged-evidence'],
    passDetail: 'broker/plugin/runner merged code evidence is present',
    pendingDetail: 'missing merged broker/plugin/runner code evidence',
  },
  {
    id: 'canaryDeployed',
    title: 'Canary deployed',
    evidenceFlags: ['--canary-deployed-evidence', '--production-deployed-evidence'],
    passDetail: 'bounded canary deployment evidence is present',
    pendingDetail: 'missing bounded canary deployment evidence',
  },
  {
    id: 'operatorBridgeEnabled',
    title: 'Operator bridge enabled',
    evidenceFlags: ['--operator-bridge-evidence'],
    passDetail: 'operator bridge enablement evidence is present',
    pendingDetail: 'missing operator bridge enablement evidence',
  },
  {
    id: 'oneShotFreshTaskSent',
    title: 'One-shot fresh task sent',
    evidenceFlags: ['--fresh-task-evidence', '--provider-send-evidence'],
    passDetail: 'one-shot fresh task/send evidence is present',
    pendingDetail: 'missing one-shot fresh task/send evidence',
  },
  {
    id: 'operatorVisibleReceiptProven',
    title: 'Operator-visible receipt proven',
    evidenceFlags: ['--operator-receipt-evidence'],
    passDetail: 'operator-visible receipt evidence is present',
    pendingDetail: 'missing operator-visible receipt evidence; task/provider send success is insufficient',
  },
  {
    id: 'manualAckRecorded',
    title: 'Manual ACK recorded',
    evidenceFlags: ['--manual-ack-evidence', '--terminal-ack-evidence'],
    passDetail: 'manual terminal-outbox ACK evidence is present',
    pendingDetail: 'missing manual ACK evidence; receipt proof alone is not an ACK',
  },
  {
    id: 'finalNoLiveRestored',
    title: 'Final no-live restoration',
    evidenceFlags: ['--final-no-live-restoration-evidence'],
    passDetail: 'post-proof no-live restoration evidence is present',
    pendingDetail: 'missing final no-live restoration evidence',
  },
];

function readOption(argv, name) {
  const prefix = `${name}=`;
  const inline = argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function readAnyOption(argv, names) {
  for (const name of names) {
    const value = readOption(argv, name);
    if (value !== undefined) return value;
  }
  return undefined;
}

function sanitizeEvidence(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return '<non-string-evidence>';
  const trimmed = value.trim();
  if (!HTTP_URL.test(trimmed)) return '<redacted-non-http-evidence>';
  return trimmed
    .replace(/\b(?:ghp|gho|ghu|ghs|github_pat|sk|xox[abp])-[-_A-Za-z0-9]+\b/g, '[redacted]')
    .replace(/\b(token|secret|password|api[_-]?key)\s*[:=]\s*[^&#\s]+/gi, '$1=[redacted]')
    .slice(0, 180);
}

function safeLabel(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (!trimmed) return undefined;
  return trimmed
    .replace(/\b(?:ghp|gho|ghu|ghs|github_pat|sk|xox[abp])-[-_A-Za-z0-9]+\b/g, '[redacted]')
    .replace(/\b(token|secret|password|api[_-]?key)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .slice(0, 160);
}

function safePositiveInt(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0 && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function buildGate(definition, evidence) {
  const sanitizedEvidence = sanitizeEvidence(evidence);
  const proven = Boolean(sanitizedEvidence && sanitizedEvidence !== '<redacted-non-http-evidence>');
  return {
    id: definition.id,
    title: definition.title,
    proven,
    status: proven ? 'proven' : 'pending',
    evidence: sanitizedEvidence,
    detail: proven ? definition.passDetail : definition.pendingDetail,
  };
}

function buildProjectionParity(context = {}) {
  const parentBrokerFinalizer = safeLabel(context.parentBrokerFinalizer ?? context.parentBroker ?? context.brokerOfRecord);
  const handoffBroker = safeLabel(context.handoffBroker ?? context.team2Broker ?? context.originBroker);
  const parentRoundId = safeLabel(context.parentRoundId ?? context.run);
  const worker = safeLabel(context.worker);
  const knownTotal = safePositiveInt(context.knownTotal ?? context.parentRoundTotal);
  return {
    parentRoundId,
    parentBrokerFinalizer,
    handoffBroker,
    worker,
    knownTotal,
    compactParentRoundTitle: worker && knownTotal ? `A2A Terminal Brief 완료: ${worker}(n/${knownTotal})` : undefined,
    parentBrokerAggregationMetadataRequired: true,
    parentOnlyNotificationOwnership: true,
    childProjectionProviderSendPermitted: false,
    childProjectionTerminalAckPermitted: false,
  };
}

function buildGoNoGoPacket(gates, warnings, activationReady) {
  const blockers = [
    ...gates.filter((gate) => !gate.proven).map((gate) => gate.pendingDetail),
    ...warnings,
  ];
  return {
    decision: activationReady ? 'GO' : 'NO-GO',
    evidencePolicy: 'PR/Done/Block evidence only; no live action evidence is synthesized by this report',
    blockers,
    readyCriteria: 'all seven activation gates have bounded HTTP evidence and receipt/ACK separation warnings are empty',
  };
}

function buildReceiptAckBoundaryProof() {
  return {
    providerSendSuccessIsOperatorVisibleReceipt: false,
    providerAcceptedMessageIdIsTerminalAck: false,
    operatorVisibleReceiptIsManualAck: false,
    manualAckRequiresIndependentReceiptEvidence: true,
    projectionMayAckTerminalOutbox: false,
  };
}

function buildApprovalGatedActivationRollbackPlan() {
  return {
    activationRequiresFreshExplicitOperatorApproval: true,
    rollbackRequiresFreshExplicitOperatorApproval: true,
    activationSteps: [
      'verify merged code and parent-broker aggregation evidence',
      'obtain fresh explicit operator approval for the bounded proof window',
      'enable the operator bridge only under the approved window',
      'send one fresh allowlisted proof task only after approval',
      'verify operator-visible/provider-delivery receipt independently from provider acceptance',
      'record manual terminal ACK only after receipt evidence and explicit approval',
    ],
    rollbackSteps: [
      'disable the operator bridge/provider path under the approved rollback plan',
      'confirm no-live restoration evidence',
      'leave unacked/replayable records intact unless a separate ACK/prune approval exists',
    ],
    forbiddenWithoutFreshApproval: [
      'deploy/restart/reload',
      'live provider send',
      'terminal ACK/replay or historical outbox replay',
      'production DB mutation',
      'secret/visibility change',
      'release/tag publish',
    ],
  };
}

export function runTerminalBriefActivationReport(options = {}) {
  const gates = GATES.map((gate) => buildGate(gate, options[gate.id]));
  const byId = Object.fromEntries(gates.map((gate) => [gate.id, gate]));
  const warnings = [];
  if (byId.oneShotFreshTaskSent.proven && !byId.operatorVisibleReceiptProven.proven) {
    warnings.push('one-shot task/provider send evidence is not operator-visible receipt evidence');
  }
  if (byId.operatorVisibleReceiptProven.proven && !byId.manualAckRecorded.proven) {
    warnings.push('operator-visible receipt evidence is not manual ACK evidence');
  }
  if (byId.manualAckRecorded.proven && !byId.operatorVisibleReceiptProven.proven) {
    warnings.push('manual ACK evidence requires independently proven operator-visible/provider-delivery receipt evidence');
  }
  if (byId.manualAckRecorded.proven && !byId.finalNoLiveRestored.proven) {
    warnings.push('manual ACK evidence is not final no-live restoration evidence');
  }

  const activationReady = gates.every((gate) => gate.proven) && warnings.length === 0;
  const issue = safeLabel(options.issue) ?? ISSUE;
  const parent = safeLabel(options.parent) ?? PARENT;
  return {
    kind: 'broker.terminal-brief-activation-report',
    issue,
    parent,
    mode: 'no-live-read-only',
    ok: true,
    activationReady,
    activationDecision: activationReady ? 'Ready' : 'Block',
    goNoGoPacket: buildGoNoGoPacket(gates, warnings, activationReady),
    projectionParity: buildProjectionParity(options.context),
    receiptAckBoundaryProof: buildReceiptAckBoundaryProof(),
    approvalGatedActivationRollbackPlan: buildApprovalGatedActivationRollbackPlan(),
    gates,
    warnings,
    safety: {
      productionDeployAttempted: false,
      canaryDeployAttempted: false,
      gatewayRestartAttempted: false,
      operatorBridgeEnabledByThisReport: false,
      providerSendAttempted: false,
      dbMutationAttempted: false,
      workerRestartOrRolloutAttempted: false,
      terminalAckAttempted: false,
      rawPayloadsIncluded: false,
    },
  };
}

function escapeCell(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function renderMarkdown(report) {
  const lines = [
    `${report.activationDecision}: ${report.issue} Terminal Brief activation gate report`,
    '',
    `Parent: ${report.parent}`,
    `Mode: ${report.mode}`,
    `GO/NO-GO: ${report.goNoGoPacket?.decision ?? (report.activationReady ? 'GO' : 'NO-GO')}`,
    '',
    '| Gate | Status | Evidence | Detail |',
    '| --- | --- | --- | --- |',
    ...report.gates.map((gate) => `| ${escapeCell(gate.title)} | ${gate.status} | ${escapeCell(gate.evidence ?? 'none')} | ${escapeCell(gate.detail)} |`),
    '',
    'Projection parity:',
    `- parent round: ${report.projectionParity?.parentRoundId ?? 'not specified'}`,
    `- parent broker/finalizer: ${report.projectionParity?.parentBrokerFinalizer ?? 'not specified'}`,
    `- handoff broker: ${report.projectionParity?.handoffBroker ?? 'not specified'}`,
    `- compact title target: ${report.projectionParity?.compactParentRoundTitle ?? 'requires worker and known total'}`,
    `- parent-only notification ownership: ${report.projectionParity?.parentOnlyNotificationOwnership ? 'yes' : 'no'}`,
    '',
    'Separation checks:',
    `- one-shot task/provider send counted as operator-visible receipt: ${report.gates.find((gate) => gate.id === 'oneShotFreshTaskSent')?.proven && !report.gates.find((gate) => gate.id === 'operatorVisibleReceiptProven')?.proven ? 'no' : 'not applicable'}`,
    `- operator-visible receipt counted as manual ACK: ${report.gates.find((gate) => gate.id === 'operatorVisibleReceiptProven')?.proven && !report.gates.find((gate) => gate.id === 'manualAckRecorded')?.proven ? 'no' : 'not applicable'}`,
    `- manual ACK counted as final no-live restoration: ${report.gates.find((gate) => gate.id === 'manualAckRecorded')?.proven && !report.gates.find((gate) => gate.id === 'finalNoLiveRestored')?.proven ? 'no' : 'not applicable'}`,
    `- provider accepted/message id counted as terminal ACK: ${report.receiptAckBoundaryProof?.providerAcceptedMessageIdIsTerminalAck ? 'yes' : 'no'}`,
    `- projection may ACK terminal outbox: ${report.receiptAckBoundaryProof?.projectionMayAckTerminalOutbox ? 'yes' : 'no'}`,
    '',
    'Approval-gated activation/rollback:',
    `- activation requires fresh explicit operator approval: ${report.approvalGatedActivationRollbackPlan?.activationRequiresFreshExplicitOperatorApproval ? 'yes' : 'no'}`,
    `- rollback requires fresh explicit operator approval: ${report.approvalGatedActivationRollbackPlan?.rollbackRequiresFreshExplicitOperatorApproval ? 'yes' : 'no'}`,
    `- forbidden without approval: ${(report.approvalGatedActivationRollbackPlan?.forbiddenWithoutFreshApproval ?? []).join(', ')}`,
    '',
    'Safety:',
    '- production deploy attempted: no',
    '- canary deploy attempted by this report: no',
    '- Gateway restart attempted: no',
    '- operator bridge enabled by this report: no',
    '- live provider send attempted by this report: no',
    '- production DB mutation attempted: no',
    '- worker service restart/runner rollout attempted: no',
    '- terminal-outbox ACK attempted: no',
  ];
  if (report.warnings.length > 0) {
    lines.splice(lines.indexOf('Safety:'), 0, 'Warnings:', ...report.warnings.map((warning) => `- ${warning}`), '');
  }
  return lines.join('\n');
}

function parseArgs(argv) {
  const options = {
    issue: readOption(argv, '--issue'),
    parent: readOption(argv, '--parent'),
    context: {
      parentRoundId: readOption(argv, '--parent-round-id') ?? readOption(argv, '--run'),
      parentBrokerFinalizer: readOption(argv, '--parent-broker') ?? readOption(argv, '--parent-finalizer'),
      handoffBroker: readOption(argv, '--handoff-broker'),
      worker: readOption(argv, '--worker'),
      knownTotal: readOption(argv, '--known-total') ?? readOption(argv, '--parent-round-total'),
    },
  };
  for (const gate of GATES) options[gate.id] = readAnyOption(argv, gate.evidenceFlags);
  return {
    json: argv.includes('--json') || argv.includes('--format=json'),
    markdown: argv.includes('--markdown') || argv.includes('--md') || argv.includes('--format=markdown'),
    options,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = runTerminalBriefActivationReport(args.options);
  if (args.json && !args.markdown) console.log(JSON.stringify(report, null, 2));
  else console.log(renderMarkdown(report));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`fatal: ${error.message}`);
    process.exit(2);
  });
}
