#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function argValue(name) {
  const prefix = `${name}=`;
  for (let i = 2; i < process.argv.length; i += 1) {
    const arg = process.argv[i];
    if (arg === name) {
      return process.argv[i + 1];
    }
    if (arg.startsWith(prefix)) {
      return arg.slice(prefix.length);
    }
  }
  return undefined;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function usage(exitCode = 0) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`Usage: node scripts/export-sqlite-state.mjs --db <state.sqlite> [--out <state.json>] [--max-bytes <bytes>]\n\n`);
  stream.write(`Options:\n`);
  stream.write(`  --db          SQLite broker state DB. Defaults to BROKER_SQLITE_FILE or SQLITE_STATE_FILE.\n`);
  stream.write(`  --out         Output JSON file. If omitted, writes canonical JSON to stdout.\n`);
  stream.write(`  --max-bytes   Max snapshot size to read/write. Defaults to STATE_FILE_MAX_BYTES or store default.\n`);
  stream.write(`  --help        Show this help.\n`);
  process.exit(exitCode);
}

if (hasFlag('--help') || hasFlag('-h')) {
  usage(0);
}

const dbFile = argValue('--db') ?? process.env.BROKER_SQLITE_FILE ?? process.env.SQLITE_STATE_FILE;
if (!dbFile) {
  process.stderr.write('Missing SQLite DB path. Provide --db or BROKER_SQLITE_FILE.\n');
  usage(2);
}

const outFile = argValue('--out');
const maxBytesValue = argValue('--max-bytes') ?? process.env.STATE_FILE_MAX_BYTES;
const maxBytes = maxBytesValue ? Number(maxBytesValue) : undefined;
if (maxBytesValue && (!Number.isFinite(maxBytes) || maxBytes <= 0)) {
  process.stderr.write('--max-bytes must be a positive number.\n');
  process.exit(2);
}

let storeModule;
try {
  storeModule = await import(`${rootDir}/dist/core/store.js`);
} catch (error) {
  process.stderr.write(`Failed to load dist/core/store.js. Run npm run build before exporting.\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

const { SqliteBrokerStateStore, serializeBrokerSnapshot, writeBrokerSnapshotFile } = storeModule;
const store = new SqliteBrokerStateStore(dbFile, maxBytes ? { maxBytes } : {});
try {
  const snapshot = store.load();
  if (outFile) {
    writeBrokerSnapshotFile(outFile, snapshot, maxBytes);
    process.stderr.write(`Exported SQLite broker state to ${outFile}\n`);
  } else {
    writeFileSync(process.stdout.fd, `${serializeBrokerSnapshot(snapshot, maxBytes)}\n`, 'utf8');
  }
} finally {
  store.close();
}
