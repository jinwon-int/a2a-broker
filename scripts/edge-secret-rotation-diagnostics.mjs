#!/usr/bin/env node
// Secret-safe broker/worker edge-secret rotation planning diagnostics.
// This script is plan-only: it never rotates secrets, mutates config, restarts
// services, sends provider messages, touches a DB, or ACKs terminal records.
// It reports only where edge-secret inputs are handled and the rules for
// handling them. It must never print secret values or hashes of secret values.

import { readFileSync } from 'node:fs';
import process from 'node:process';

export const EDGE_SECRET_ENV_NAMES = Object.freeze([
  'EDGE_SECRET',
  'A2A_EDGE_SECRET',
  'BROKER_EDGE_SECRET',
  'A2A_BROKER_EDGE_SECRET',
]);

export const EDGE_SECRET_FILE_ENV_NAMES = Object.freeze([
  'EDGE_SECRET_FILE',
  'A2A_EDGE_SECRET_FILE',
  'BROKER_EDGE_SECRET_FILE',
  'A2A_BROKER_EDGE_SECRET_FILE',
]);

const ALL_EDGE_SECRET_NAMES = Object.freeze([
  ...EDGE_SECRET_ENV_NAMES,
  ...EDGE_SECRET_FILE_ENV_NAMES,
]);

const HANDLING_RULES = Object.freeze([
  'Do not print, hash, screenshot, or persist edge-secret values.',
  'Record only variable names, file/env/drop-in locations, and approval-safe handling rules.',
  'Rotate broker first, then active workers one at a time only after explicit operator approval.',
  'After an approved rotation, restart only the affected broker/worker service and keep validation output redacted.',
  'Unset local shell variables used during an approved rotation after validation completes.',
]);

const SAFETY = Object.freeze({
  rotationAttempted: false,
  configMutationAttempted: false,
  deployAttempted: false,
  restartAttempted: false,
  brokerHttpRequested: false,
  providerSendAttempted: false,
  dbMutationAttempted: false,
  terminalAckAttempted: false,
  replayAttempted: false,
  releaseAttempted: false,
  secretValuesRecorded: false,
});

function readOption(argv, name) {
  const prefix = `${name}=`;
  const inline = argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function readRepeated(argv, names) {
  const result = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    for (const name of names) {
      const prefix = `${name}=`;
      if (arg.startsWith(prefix)) result.push(arg.slice(prefix.length));
      else if (arg === name && argv[index + 1]) result.push(argv[index + 1]);
    }
  }
  return result;
}

export function parseArgs(argv) {
  return {
    brokerEnvFiles: readRepeated(argv, ['--broker-env-file']),
    workerEnvFiles: readRepeated(argv, ['--worker-env-file']),
    brokerSystemdCats: readRepeated(argv, ['--broker-systemd-cat']),
    workerSystemdCats: readRepeated(argv, ['--worker-systemd-cat']),
    json: argv.includes('--json') || readOption(argv, '--format') === 'json',
    markdown: argv.includes('--markdown') || readOption(argv, '--format') === 'markdown',
    sample: argv.includes('--sample'),
  };
}

function emptyLocation(component, source, location) {
  return {
    component,
    source,
    location,
    edgeSecretVariables: [],
    edgeSecretFileVariables: [],
    referencedSecretFiles: [],
    referencedEnvFiles: [],
    valueHandling: 'values-redacted-and-not-recorded',
    handlingRules: HANDLING_RULES,
  };
}

function unique(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.length > 0))].sort();
}

function lineWithoutComment(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return '';
  return trimmed;
}

function unquote(value) {
  return value.trim().replace(/^['"]|['"]$/g, '');
}

function sanitizeLocationValue(value) {
  const trimmed = unquote(String(value ?? '')).replace(/^-/, '');
  if (!trimmed || /[\r\n]/.test(trimmed)) return undefined;
  // *_FILE and EnvironmentFile values are expected to be locations. If an
  // operator accidentally puts secret material there, fail closed by redacting
  // anything that does not look path-like or variable-expanded.
  if (/^(?:\/|\.\/|\.\.\/|~\/|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?\/|[A-Za-z0-9_.-]+\/)/.test(trimmed)) {
    return trimmed;
  }
  return '<non-path-redacted>';
}

function matchesAssignment(line, name) {
  return new RegExp(`(?:^|[^A-Za-z0-9_])${name}\\s*=`).test(line);
}

function extractAssignedValue(line, name) {
  const match = line.match(new RegExp(`(?:^|[^A-Za-z0-9_])${name}\\s*=\\s*("[^"]*"|'[^']*'|\\S+)`));
  return match ? unquote(match[1]) : undefined;
}

export function inspectConfigText({ component, source, location, text }) {
  const result = emptyLocation(component, source, location);
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = lineWithoutComment(rawLine);
    if (!line) continue;

    for (const name of EDGE_SECRET_ENV_NAMES) {
      if (matchesAssignment(line, name)) result.edgeSecretVariables.push(name);
    }

    for (const name of EDGE_SECRET_FILE_ENV_NAMES) {
      if (matchesAssignment(line, name)) {
        result.edgeSecretFileVariables.push(name);
        const assigned = sanitizeLocationValue(extractAssignedValue(line, name));
        if (assigned) result.referencedSecretFiles.push(assigned);
      }
    }

    const environmentFile = line.match(/(?:^|\s)EnvironmentFile\s*=\s*("[^"]+"|'[^']+'|\S+)/);
    if (environmentFile) {
      const locationValue = sanitizeLocationValue(environmentFile[1]);
      if (locationValue) result.referencedEnvFiles.push(locationValue);
    }
  }

  result.edgeSecretVariables = unique(result.edgeSecretVariables);
  result.edgeSecretFileVariables = unique(result.edgeSecretFileVariables);
  result.referencedSecretFiles = unique(result.referencedSecretFiles);
  result.referencedEnvFiles = unique(result.referencedEnvFiles);
  return result;
}

export function inspectEnvironment(env = process.env) {
  const components = ['broker', 'worker'];
  return components.map((component) => {
    const result = emptyLocation(component, 'process-env-presence', `${component} process environment`);
    result.edgeSecretVariables = EDGE_SECRET_ENV_NAMES.filter((name) => env[name] !== undefined);
    result.edgeSecretFileVariables = EDGE_SECRET_FILE_ENV_NAMES.filter((name) => env[name] !== undefined);
    result.referencedSecretFiles = EDGE_SECRET_FILE_ENV_NAMES
      .filter((name) => env[name] !== undefined && env[name] !== '')
      .map((name) => sanitizeLocationValue(env[name]))
      .filter(Boolean);
    result.presentOnly = true;
    return result;
  });
}

function readLocation(component, source, location) {
  const text = readFileSync(location, 'utf8');
  return inspectConfigText({ component, source, location, text });
}

function hasSecretLocation(location) {
  return location.edgeSecretVariables.length > 0
    || location.edgeSecretFileVariables.length > 0
    || location.referencedSecretFiles.length > 0
    || location.referencedEnvFiles.length > 0;
}

function buildChecks(locations) {
  const withDirectSecret = locations.filter((location) => location.edgeSecretVariables.length > 0).length;
  const withSecretFile = locations.filter((location) => location.edgeSecretFileVariables.length > 0 || location.referencedSecretFiles.length > 0).length;
  const withEnvFileRefs = locations.filter((location) => location.referencedEnvFiles.length > 0).length;
  const discovered = locations.filter(hasSecretLocation).length;
  return [
    discovered > 0
      ? { ok: true, check: 'edge-secret locations', detail: `${discovered} location(s) record handling shape only` }
      : { ok: false, check: 'edge-secret locations', detail: 'no edge-secret locations were discovered; provide env/drop-in snapshots or presence env' },
    { ok: true, check: 'direct env variables', detail: `${withDirectSecret} location(s) mention direct edge-secret variables; values not recorded` },
    { ok: true, check: 'file-based secrets', detail: `${withSecretFile} location(s) mention file-based injection; file paths only, file contents not read` },
    { ok: true, check: 'systemd env files', detail: `${withEnvFileRefs} referenced EnvironmentFile location(s); referenced files not read unless explicitly supplied` },
    { ok: true, check: 'safety gate', detail: 'plan-only diagnostics; no rotation, deploy, restart, provider send, DB mutation, terminal ACK, replay, release, or secret change' },
  ];
}

export function buildRotationDiagnostics(options = {}) {
  const locations = [];
  for (const location of options.brokerEnvFiles ?? []) locations.push(readLocation('broker', 'env-file', location));
  for (const location of options.workerEnvFiles ?? []) locations.push(readLocation('worker', 'env-file', location));
  for (const location of options.brokerSystemdCats ?? []) locations.push(readLocation('broker', 'systemd-cat', location));
  for (const location of options.workerSystemdCats ?? []) locations.push(readLocation('worker', 'systemd-cat', location));

  if (options.sample) {
    locations.push(inspectConfigText({
      component: 'broker',
      source: 'sample-env-file',
      location: 'sample:broker.env',
      text: 'EDGE_SECRET=<redacted>\n',
    }));
    locations.push(inspectConfigText({
      component: 'worker',
      source: 'sample-env-file',
      location: 'sample:worker.env',
      text: 'BROKER_EDGE_SECRET_FILE=/run/secrets/a2a-broker-edge\n',
    }));
  }

  locations.push(...inspectEnvironment(options.env ?? process.env));

  const activeLocations = locations.filter(hasSecretLocation);
  const checks = buildChecks(activeLocations);
  return {
    kind: 'broker.edge-secret-rotation-diagnostics',
    mode: 'plan-only',
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    safety: SAFETY,
    secretNamesHandled: ALL_EDGE_SECRET_NAMES,
    requiredHandlingRules: HANDLING_RULES,
    locations: activeLocations,
    checks,
    ok: checks.every((check) => check.ok),
  };
}

export function renderMarkdown(report) {
  const lines = [
    `${report.ok ? 'Done' : 'Block'}: broker/worker edge-secret rotation planning diagnostics`,
    '',
    `Mode: ${report.mode}`,
    '',
    'Checks:',
    ...report.checks.map((check) => `- ${check.ok ? 'PASS' : 'FAIL'} ${check.check}: ${check.detail}`),
    '',
    'Locations and handling shape:',
  ];

  if (report.locations.length === 0) {
    lines.push('- None discovered. Provide redacted env/drop-in snapshots with --broker-env-file, --worker-env-file, --broker-systemd-cat, or --worker-systemd-cat.');
  } else {
    for (const location of report.locations) {
      const keys = [...location.edgeSecretVariables, ...location.edgeSecretFileVariables].join(', ') || 'none';
      const refs = [...location.referencedSecretFiles, ...location.referencedEnvFiles].join(', ') || 'none';
      lines.push(`- ${location.component} ${location.source} ${location.location}: keys=${keys}; locations=${refs}; values=<not recorded>`);
    }
  }

  lines.push(
    '',
    'Required handling rules:',
    ...report.requiredHandlingRules.map((rule) => `- ${rule}`),
    '',
    'Safety:',
    '- no rotation, config mutation, deploy, restart, provider send, DB mutation, terminal ACK, replay, release, or secret change attempted',
  );
  return lines.join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = buildRotationDiagnostics(options);
  if (options.markdown && !options.json) console.log(renderMarkdown(report));
  else console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`edge-secret-rotation-diagnostics: ${error.message}`);
    process.exit(2);
  });
}
