#!/usr/bin/env node
// Read-only Terminal Brief activation gate report.
// No-live by design: this script renders bounded activation evidence only. It never
// deploys, restarts Gateway, calls a notification provider, mutates DB state, or
// ACKs terminal-outbox records.

import process from 'node:process';

const ISSUE = '#385';
const PARENT = '#383';
const HTTP_URL = /^https?:\/\//;

const GATES = [
  {
    id: 'codeMerged',
    title: 'Code merged',
    evidenceFlag: '--code-merged-evidence',
    passDetail: 'merged code evidence is present',
    pendingDetail: 'missing merged code evidence',
  },
  {
    id: 'productionDeployed',
    title: 'Production deployed',
    evidenceFlag: '--production-deployed-evidence',
    passDetail: 'production deployment evidence is present',
    pendingDetail: 'missing production deployment evidence',
  },
  {
    id: 'liveProviderSendAttempted',
    title: 'Live provider send attempted',
    evidenceFlag: '--provider-send-evidence',
    passDetail: 'live provider send attempt evidence is present',
    pendingDetail: 'missing live provider send attempt evidence',
  },
  {
    id: 'operatorVisibleReceiptProven',
    title: 'Operator-visible receipt proven',
    evidenceFlag: '--operator-receipt-evidence',
    passDetail: 'operator-visible receipt evidence is present',
    pendingDetail: 'missing operator-visible receipt evidence; provider send success is insufficient',
  },
  {
    id: 'terminalAckPerformed',
    title: 'Terminal ACK performed',
    evidenceFlag: '--terminal-ack-evidence',
    passDetail: 'terminal ACK evidence is present',
    pendingDetail: 'missing terminal ACK evidence; receipt proof alone is not an ACK',
  },
];

function readOption(argv, name) {
  const prefix = `${name}=`;
  const inline = argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
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

export function runTerminalBriefActivationReport(options = {}) {
  const gates = GATES.map((gate) => buildGate(gate, options[gate.id]));
  const byId = Object.fromEntries(gates.map((gate) => [gate.id, gate]));
  const warnings = [];
  if (byId.liveProviderSendAttempted.proven && !byId.operatorVisibleReceiptProven.proven) {
    warnings.push('provider send evidence is not operator-visible receipt evidence');
  }
  if (byId.operatorVisibleReceiptProven.proven && !byId.terminalAckPerformed.proven) {
    warnings.push('operator-visible receipt evidence is not terminal ACK evidence');
  }
  if (byId.terminalAckPerformed.proven && !byId.operatorVisibleReceiptProven.proven) {
    warnings.push('terminal ACK evidence requires independently proven operator-visible/provider-delivery receipt evidence');
  }

  const activationReady = gates.every((gate) => gate.proven) && warnings.length === 0;
  return {
    kind: 'broker.terminal-brief-activation-report',
    issue: ISSUE,
    parent: PARENT,
    mode: 'no-live-read-only',
    ok: true,
    activationReady,
    activationDecision: activationReady ? 'Ready' : 'Block',
    gates,
    warnings,
    safety: {
      productionDeployAttempted: false,
      gatewayRestartAttempted: false,
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
    `${report.activationDecision}: ${ISSUE} Terminal Brief activation gate report`,
    '',
    `Parent: ${PARENT}`,
    `Mode: ${report.mode}`,
    '',
    '| Gate | Status | Evidence | Detail |',
    '| --- | --- | --- | --- |',
    ...report.gates.map((gate) => `| ${escapeCell(gate.title)} | ${gate.status} | ${escapeCell(gate.evidence ?? 'none')} | ${escapeCell(gate.detail)} |`),
    '',
    'Separation checks:',
    `- provider send success counted as operator-visible receipt: ${report.gates.find((gate) => gate.id === 'liveProviderSendAttempted')?.proven && !report.gates.find((gate) => gate.id === 'operatorVisibleReceiptProven')?.proven ? 'no' : 'not applicable'}`,
    `- operator-visible receipt counted as terminal ACK: ${report.gates.find((gate) => gate.id === 'operatorVisibleReceiptProven')?.proven && !report.gates.find((gate) => gate.id === 'terminalAckPerformed')?.proven ? 'no' : 'not applicable'}`,
    '',
    'Safety:',
    '- production deploy attempted: no',
    '- Gateway restart attempted: no',
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
  const options = {};
  for (const gate of GATES) options[gate.id] = readOption(argv, gate.evidenceFlag);
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
