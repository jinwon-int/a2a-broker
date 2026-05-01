#!/usr/bin/env node
// Docker Compose runtime preflight for the production A2A Broker service.
// Dry-run mode is CI-safe and validates repo-local compose invariants only.

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import process from 'node:process';

const execFileAsync = promisify(execFile);

export const REQUIRED = Object.freeze({
  serviceName: 'a2a-broker',
  containerName: 'a2a-broker',
  hostPublish: '127.0.0.1:8787:8787',
  containerHost: '0.0.0.0',
  stateBind: '/var/lib/a2a-broker:/var/lib/a2a-broker',
  legacyService: 'a2a-broker.service',
});

function ok(check, detail) {
  return { ok: true, check, detail };
}

function fail(check, detail) {
  return { ok: false, check, detail };
}

function hasComposeMapping(text, key, value) {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${key}:\\s*(?:["']?${escaped}["']?)`, 'm').test(text);
}

export function checkComposeText(text, composePath = 'docker-compose.yml') {
  const checks = [];

  checks.push(
    /^services:\s*$/m.test(text) && new RegExp(`^  ${REQUIRED.serviceName}:\\s*$`, 'm').test(text)
      ? ok('compose service', `${composePath} defines services.${REQUIRED.serviceName}`)
      : fail('compose service', `${composePath} must define services.${REQUIRED.serviceName}`),
  );

  checks.push(
    hasComposeMapping(text, 'container_name', '${SERVICE_NAME:-a2a-broker}') || hasComposeMapping(text, 'container_name', REQUIRED.containerName)
      ? ok('container name', 'container_name resolves to a2a-broker by default')
      : fail('container name', 'container_name must default to a2a-broker'),
  );

  checks.push(
    text.includes(`"${REQUIRED.hostPublish}"`) || text.includes(`'${REQUIRED.hostPublish}'`) || text.includes(`- ${REQUIRED.hostPublish}`)
      ? ok('loopback publish', `ports includes ${REQUIRED.hostPublish}`)
      : fail('loopback publish', `ports must include ${REQUIRED.hostPublish}`),
  );

  checks.push(
    hasComposeMapping(text, 'HOST', REQUIRED.containerHost)
      ? ok('container HOST', `HOST=${REQUIRED.containerHost}`)
      : fail('container HOST', `environment must set HOST=${REQUIRED.containerHost}`),
  );

  checks.push(
    text.includes(REQUIRED.stateBind)
      ? ok('state bind mount', `volumes includes ${REQUIRED.stateBind}`)
      : fail('state bind mount', `volumes must include ${REQUIRED.stateBind}`),
  );

  return checks;
}

function parseArgs(argv) {
  const args = new Set(argv);
  return {
    dryRun: args.has('--dry-run'),
    json: args.has('--json'),
    composePath: argv.find((arg) => arg.startsWith('--compose='))?.slice('--compose='.length) || 'docker-compose.yml',
    container: argv.find((arg) => arg.startsWith('--container='))?.slice('--container='.length) || REQUIRED.containerName,
  };
}

async function dockerInspect(container) {
  const { stdout } = await execFileAsync('docker', ['inspect', container], { maxBuffer: 1024 * 1024 });
  const parsed = JSON.parse(stdout);
  if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error(`unexpected docker inspect payload for ${container}`);
  return parsed[0];
}

function checkContainerInspect(inspect, container) {
  const env = Object.fromEntries((inspect.Config?.Env || []).map((entry) => {
    const idx = entry.indexOf('=');
    return idx === -1 ? [entry, ''] : [entry.slice(0, idx), entry.slice(idx + 1)];
  }));
  const portBindings = inspect.HostConfig?.PortBindings?.['8787/tcp'] || [];
  const mounts = inspect.Mounts || [];

  return [
    inspect.Name === `/${container}`
      ? ok('live container name', inspect.Name)
      : fail('live container name', `expected /${container}, got ${inspect.Name || 'unknown'}`),
    env.HOST === REQUIRED.containerHost
      ? ok('live HOST', `HOST=${env.HOST}`)
      : fail('live HOST', `expected HOST=${REQUIRED.containerHost}, got ${env.HOST || 'unset'}`),
    portBindings.some((binding) => binding.HostIp === '127.0.0.1' && binding.HostPort === '8787')
      ? ok('live loopback publish', '8787/tcp is published on 127.0.0.1:8787')
      : fail('live loopback publish', `expected 127.0.0.1:8787 binding, got ${JSON.stringify(portBindings)}`),
    mounts.some((mount) => mount.Source === '/var/lib/a2a-broker' && mount.Destination === '/var/lib/a2a-broker')
      ? ok('live state bind mount', REQUIRED.stateBind)
      : fail('live state bind mount', `expected ${REQUIRED.stateBind}`),
    inspect.State?.Health?.Status === 'healthy'
      ? ok('live health', 'container health is healthy')
      : fail('live health', `expected healthy, got ${inspect.State?.Health?.Status || inspect.State?.Status || 'unknown'}`),
  ];
}

async function checkLegacyService() {
  try {
    const { stdout } = await execFileAsync('systemctl', ['is-enabled', REQUIRED.legacyService]);
    const state = stdout.trim();
    return state === 'disabled'
      ? ok('legacy service disabled', `${REQUIRED.legacyService} is disabled`)
      : fail('legacy service disabled', `${REQUIRED.legacyService} is ${state}`);
  } catch (error) {
    const state = (error.stdout || '').trim();
    if (state === 'disabled') return ok('legacy service disabled', `${REQUIRED.legacyService} is disabled`);
    if (state === 'not-found') return ok('legacy service disabled', `${REQUIRED.legacyService} is not installed`);
    return fail('legacy service disabled', `${REQUIRED.legacyService} is ${state || 'unknown'} (systemctl exit ${error.code ?? 'unknown'})`);
  }
}

async function checkLegacyInactive() {
  try {
    const { stdout } = await execFileAsync('systemctl', ['is-active', REQUIRED.legacyService]);
    const state = stdout.trim();
    return state === 'inactive'
      ? ok('legacy service inactive', `${REQUIRED.legacyService} is inactive`)
      : fail('legacy service inactive', `${REQUIRED.legacyService} is ${state}`);
  } catch (error) {
    const state = (error.stdout || '').trim();
    if (state === 'inactive' || state === 'unknown' || state === 'failed') {
      return state === 'failed'
        ? fail('legacy service inactive', `${REQUIRED.legacyService} is failed; clear/disable before release`)
        : ok('legacy service inactive', `${REQUIRED.legacyService} is ${state}`);
    }
    return fail('legacy service inactive', `${REQUIRED.legacyService} is ${state || 'unknown'} (systemctl exit ${error.code ?? 'unknown'})`);
  }
}

function printHuman(checks, dryRun) {
  console.log(`A2A Broker Docker runtime preflight (${dryRun ? 'dry-run' : 'live'})`);
  for (const result of checks) {
    console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.check}: ${result.detail}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const composeText = await readFile(options.composePath, 'utf8');
  const checks = checkComposeText(composeText, options.composePath);

  if (!options.dryRun) {
    try {
      checks.push(...checkContainerInspect(await dockerInspect(options.container), options.container));
    } catch (error) {
      checks.push(fail('docker inspect', error.message));
    }
    checks.push(await checkLegacyService());
    checks.push(await checkLegacyInactive());
  }

  if (options.json) {
    console.log(JSON.stringify({ dryRun: options.dryRun, checks }, null, 2));
  } else {
    printHuman(checks, options.dryRun);
  }

  process.exit(checks.every((result) => result.ok) ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`fatal: ${error.message}`);
    process.exit(2);
  });
}
