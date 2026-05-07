#!/usr/bin/env node
// Compare two broker worker lists before cutover and fail closed when the same
// worker id is online on both brokers. The script only performs GET requests.

import process from 'node:process';

export function normalizeWorkerId(worker) {
  if (!worker || typeof worker !== 'object') return null;
  const id = worker.workerId ?? worker.nodeId ?? worker.id;
  return typeof id === 'string' && id.trim() ? id.trim() : null;
}

export function onlineWorkers(workers) {
  if (!Array.isArray(workers)) return [];
  return workers
    .map((worker) => ({ worker, workerId: normalizeWorkerId(worker) }))
    .filter(({ worker, workerId }) => workerId && worker.status === 'online');
}

export function findDuplicateOnlineWorkerIds(seoseoWorkers, gwakgaWorkers) {
  const seoseoById = new Map();
  const gwakgaById = new Map();

  for (const entry of onlineWorkers(seoseoWorkers)) seoseoById.set(entry.workerId, entry.worker);
  for (const entry of onlineWorkers(gwakgaWorkers)) gwakgaById.set(entry.workerId, entry.worker);

  return [...seoseoById.keys()]
    .filter((workerId) => gwakgaById.has(workerId))
    .sort()
    .map((workerId) => ({
      workerId,
      seoseo: summarizeWorker(seoseoById.get(workerId)),
      gwakga: summarizeWorker(gwakgaById.get(workerId)),
    }));
}

function summarizeWorker(worker) {
  return {
    nodeId: worker.nodeId ?? null,
    workerId: worker.workerId ?? worker.nodeId ?? worker.id ?? null,
    role: worker.role ?? null,
    displayName: worker.displayName ?? null,
    lastSeenAt: worker.lastSeenAt ?? null,
    workerMode: worker.workerMode ?? null,
  };
}

function getArg(argv, name) {
  const idx = argv.indexOf(name);
  if (idx !== -1) return argv[idx + 1];
  return argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
}

export function parseArgs(argv, env = process.env) {
  return {
    seoseoUrl: getArg(argv, '--seoseo-url') || env.SEOSEO_BROKER_URL || env.A2A_SEOSEO_BROKER_URL,
    gwakgaUrl: getArg(argv, '--gwakga-url') || env.GWAKGA_BROKER_URL || env.A2A_GWAKGA_BROKER_URL,
    json: argv.includes('--json'),
  };
}

function workersUrl(baseUrl) {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/$/, '')}/workers`;
  url.search = '';
  url.hash = '';
  return url;
}

export async function fetchWorkerList(baseUrl, fetchImpl = fetch) {
  const url = workersUrl(baseUrl);
  const response = await fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  const body = await response.json();
  if (!Array.isArray(body?.items)) throw new Error(`${url} did not return a worker items array`);
  return body.items;
}

function printHuman(result) {
  console.log('A2A two-broker worker cutover preflight');
  console.log(`seoseo online workers: ${result.seoseoOnline}`);
  console.log(`gwakga online workers: ${result.gwakgaOnline}`);

  if (result.duplicates.length === 0) {
    console.log('PASS duplicate online workerIds: none found across seoseo and gwakga');
    return;
  }

  console.log('FAIL duplicate online workerIds: found across seoseo and gwakga');
  for (const duplicate of result.duplicates) {
    console.log(`- ${duplicate.workerId}: seoseo lastSeenAt=${duplicate.seoseo.lastSeenAt ?? 'unknown'}, gwakga lastSeenAt=${duplicate.gwakga.lastSeenAt ?? 'unknown'}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.seoseoUrl || !options.gwakgaUrl) {
    console.error('fatal: provide --seoseo-url/--gwakga-url or SEOSEO_BROKER_URL/GWAKGA_BROKER_URL');
    process.exit(2);
  }

  const [seoseoWorkers, gwakgaWorkers] = await Promise.all([
    fetchWorkerList(options.seoseoUrl),
    fetchWorkerList(options.gwakgaUrl),
  ]);

  const duplicates = findDuplicateOnlineWorkerIds(seoseoWorkers, gwakgaWorkers);
  const result = {
    ok: duplicates.length === 0,
    seoseoOnline: onlineWorkers(seoseoWorkers).length,
    gwakgaOnline: onlineWorkers(gwakgaWorkers).length,
    duplicates,
  };

  if (options.json) console.log(JSON.stringify(result, null, 2));
  else printHuman(result);

  process.exit(result.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`fatal: ${error.message}`);
    process.exit(2);
  });
}
