#!/usr/bin/env node
// Read-only cross-broker terminal receipt parity check for Seoseo ↔ Gwakga.
// This script only performs GET requests and a deterministic no-live canary; it
// never sends provider messages, mutates broker state, or ACKs terminal rows.

import process from 'node:process';
import { runReceiptGateCanaryMatrix } from '../dist/core/receipt-gate-canary.js';
import {
  analyzeBrokerTerminalReceiptSnapshot,
  compareBrokerTerminalReceiptParity,
  renderBrokerTerminalReceiptParityMarkdown,
} from '../dist/core/broker-terminal-receipt-parity.js';

const DEFAULT_LIMIT = 20;

function getArg(argv, name) {
  const index = argv.indexOf(name);
  if (index !== -1) return argv[index + 1];
  return argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
}

function parseArgs(argv, env = process.env) {
  const limitRaw = getArg(argv, '--limit') ?? env.BROKER_TERMINAL_RECEIPT_PARITY_LIMIT;
  const limit = Number(limitRaw ?? DEFAULT_LIMIT);
  return {
    seoseoUrl: getArg(argv, '--seoseo-url') ?? env.SEOSEO_BROKER_URL ?? env.A2A_SEOSEO_BROKER_URL,
    gwakgaUrl: getArg(argv, '--gwakga-url') ?? env.GWAKGA_BROKER_URL ?? env.A2A_GWAKGA_BROKER_URL,
    edgeSecret: getArg(argv, '--edge-secret') ?? env.BROKER_EDGE_SECRET ?? env.EDGE_SECRET,
    seoseoEdgeSecret: getArg(argv, '--seoseo-edge-secret') ?? env.SEOSEO_BROKER_EDGE_SECRET,
    gwakgaEdgeSecret: getArg(argv, '--gwakga-edge-secret') ?? env.GWAKGA_BROKER_EDGE_SECRET,
    limit: Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_LIMIT,
    json: argv.includes('--json'),
  };
}

function headers(edgeSecret) {
  const result = {
    accept: 'application/json',
    'x-a2a-requester-id': 'broker-terminal-receipt-parity',
    'x-a2a-requester-role': 'operator',
  };
  if (edgeSecret) {
    result['x-a2a-edge-secret'] = edgeSecret;
    result['x-edge-secret'] = edgeSecret;
  }
  return result;
}

function terminalOutboxUrl(baseUrl, limit) {
  const url = new URL('/a2a/tasks/terminal-outbox', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  url.searchParams.set('limit', String(limit));
  return url;
}

async function fetchTerminalOutbox(baseUrl, edgeSecret, limit, fetchImpl = fetch) {
  const url = terminalOutboxUrl(baseUrl, limit);
  const response = await fetchImpl(url, { method: 'GET', headers: headers(edgeSecret) });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { parseError: true, preview: text.slice(0, 160) };
  }
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return body;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.seoseoUrl || !options.gwakgaUrl) {
    console.error('fatal: provide --seoseo-url/--gwakga-url or SEOSEO_BROKER_URL/GWAKGA_BROKER_URL');
    process.exit(2);
  }

  const [seoseoSnapshot, gwakgaSnapshot] = await Promise.all([
    fetchTerminalOutbox(options.seoseoUrl, options.seoseoEdgeSecret ?? options.edgeSecret, options.limit),
    fetchTerminalOutbox(options.gwakgaUrl, options.gwakgaEdgeSecret ?? options.edgeSecret, options.limit),
  ]);

  const report = compareBrokerTerminalReceiptParity({
    seoseo: analyzeBrokerTerminalReceiptSnapshot('seoseo', seoseoSnapshot),
    gwakga: analyzeBrokerTerminalReceiptSnapshot('gwakga', gwakgaSnapshot),
    receiptGateCanary: runReceiptGateCanaryMatrix(),
  });

  if (options.json) console.log(JSON.stringify(report, null, 2));
  else console.log(renderBrokerTerminalReceiptParityMarkdown(report));

  process.exit(report.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`fatal: ${error.message}`);
    process.exit(2);
  });
}
