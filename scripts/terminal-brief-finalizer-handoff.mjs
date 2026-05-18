#!/usr/bin/env node
// Read-only Terminal Brief broker finalizer handoff packet.
//
// Consumes sanitized no-live Terminal Brief sidecar integration evidence and
// renders the packet a single broker finalizer can review. It never sends
// providers, ACKs terminal rows, mutates DB state, restarts services, replays
// history, merges/closes/comments on GitHub, publishes releases, or touches
// secrets.

import { readFile } from "node:fs/promises";
import process from "node:process";

import {
  buildTerminalBriefFinalizerHandoff,
  renderTerminalBriefFinalizerHandoffMarkdown,
} from "../dist/core/terminal-brief-finalizer-handoff.js";
import {
  buildTerminalBriefSidecarIntegrationRehearsal,
} from "../dist/core/terminal-brief-sidecar-integration-rehearsal.js";

function parseArgs(argv) {
  const readOption = (name) => {
    const prefix = name + "=";
    const inline = argv.find((arg) => arg.startsWith(prefix));
    if (inline) return inline.slice(prefix.length);
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    input: readOption("--input"),
    parentRoundId: readOption("--parent-round-id") ?? readOption("--parent"),
    expectedWorkers: parseList(readOption("--expected-workers")),
    expectedTotal: parsePositiveInt(readOption("--expected-total")),
    brokerOfRecordId: readOption("--broker") ?? readOption("--broker-of-record"),
    finalizerOwner: readOption("--finalizer") ?? readOption("--finalizer-owner"),
    json: argv.includes("--json") || argv.includes("--format=json"),
    markdown: argv.includes("--markdown") || argv.includes("--format=markdown"),
  };
}

function parseList(value) {
  if (!value) return undefined;
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function parsePositiveInt(value) {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function sanitize(value) {
  if (typeof value !== "string") return String(value);
  return value
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, "[redacted-token]")
    .replace(/\b(BROKER_EDGE_SECRET|EDGE_SECRET|TOKEN|SECRET)=\S+/gi, "$1=[redacted]")
    .replace(/\/root\/\.openclaw\/[^\s]+/g, "[openclaw-path]")
    .slice(0, 500);
}

function normalizeIntegrationInput(raw, options) {
  const envelope = raw && typeof raw === "object" ? raw : {};
  const source = envelope.rehearsalInput && typeof envelope.rehearsalInput === "object"
    ? envelope.rehearsalInput
    : envelope;
  const terminalBrief = source.terminalBrief && typeof source.terminalBrief === "object"
    ? source.terminalBrief
    : {};
  const sidecar = source.sidecar && typeof source.sidecar === "object"
    ? source.sidecar
    : {};
  const sidecarSpool = Array.isArray(source.sidecarSpool)
    ? source.sidecarSpool
    : Array.isArray(sidecar.spool)
      ? sidecar.spool
      : Array.isArray(sidecar.spoolRecords)
        ? sidecar.spoolRecords
        : [];
  const sidecarReceipts = Array.isArray(source.sidecarReceipts)
    ? source.sidecarReceipts
    : Array.isArray(sidecar.receipts)
      ? sidecar.receipts
      : Array.isArray(sidecar.receiptDecisions)
        ? sidecar.receiptDecisions
        : [];
  const events = Array.isArray(source.events)
    ? source.events
    : Array.isArray(terminalBrief.events)
      ? terminalBrief.events
      : [];
  return {
    parentRoundId: options.parentRoundId ?? source.parentRoundId ?? terminalBrief.parentRoundId,
    expectedWorkers: options.expectedWorkers ?? source.expectedWorkers ?? terminalBrief.expectedWorkers,
    expectedTotal: options.expectedTotal ?? source.expectedTotal ?? terminalBrief.expectedTotal,
    finalCountSignals: source.finalCountSignals ?? terminalBrief.finalCountSignals,
    sidecarSpool,
    sidecarReceipts,
    events,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.input) {
    throw new Error("usage: npm run terminal_brief_finalizer_handoff -- --input fixture.json [--broker seoseo] [--finalizer seoseo] [--markdown|--json]");
  }
  const raw = JSON.parse(await readFile(options.input, "utf8"));
  const rehearsal = buildTerminalBriefSidecarIntegrationRehearsal(
    normalizeIntegrationInput(raw, options),
  );
  const packet = buildTerminalBriefFinalizerHandoff(rehearsal, {
    brokerOfRecordId: options.brokerOfRecordId ?? raw.brokerOfRecordId,
    finalizerOwner: options.finalizerOwner ?? raw.finalizerOwner,
  });
  if (options.json && !options.markdown) console.log(JSON.stringify(packet, null, 2));
  else console.log(renderTerminalBriefFinalizerHandoffMarkdown(packet));
  process.exit(packet.decision === "ready" ? 0 : 1);
}

main().catch((error) => {
  console.error("terminal-brief-finalizer-handoff: " + sanitize(error.message));
  process.exit(2);
});
