#!/usr/bin/env node
// Read-only Terminal Brief final-count closeout candidate builder.
//
// Consumes sanitized no-live Terminal Brief signals and worker terminal events.
// It prepares a broker finalizer candidate only; it never merges PRs, closes
// issues, sends providers, ACKs terminal rows, mutates DB state, restarts
// services, replays history, publishes releases, or touches secrets.

import { readFile } from "node:fs/promises";
import process from "node:process";

import {
  buildTerminalBriefFinalCountCloseoutCandidate,
  renderTerminalBriefFinalCountCloseoutMarkdown,
} from "../dist/core/terminal-brief-final-count-closeout.js";

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

function normalizeInput(raw, options) {
  const envelope = raw && typeof raw === "object" ? raw : {};
  const terminalBrief = envelope.terminalBrief && typeof envelope.terminalBrief === "object"
    ? envelope.terminalBrief
    : {};
  const finalCountSignals = Array.isArray(envelope.finalCountSignals)
    ? envelope.finalCountSignals
    : Array.isArray(envelope.signals)
      ? envelope.signals
      : Array.isArray(terminalBrief.finalCountSignals)
        ? terminalBrief.finalCountSignals
        : Array.isArray(terminalBrief.signals)
          ? terminalBrief.signals
          : [];
  const events = Array.isArray(envelope.events)
    ? envelope.events
    : Array.isArray(terminalBrief.events)
      ? terminalBrief.events
      : [];
  return {
    parentRoundId: options.parentRoundId ?? envelope.parentRoundId ?? terminalBrief.parentRoundId,
    expectedWorkers: options.expectedWorkers ?? envelope.expectedWorkers ?? terminalBrief.expectedWorkers,
    expectedTotal: options.expectedTotal ?? envelope.expectedTotal ?? terminalBrief.expectedTotal,
    finalCountSignals,
    events,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.input) {
    throw new Error("usage: npm run terminal_brief_final_count_closeout -- --input fixture.json [--markdown|--json]");
  }
  const raw = JSON.parse(await readFile(options.input, "utf8"));
  const candidate = buildTerminalBriefFinalCountCloseoutCandidate(normalizeInput(raw, options));
  if (options.json && !options.markdown) console.log(JSON.stringify(candidate, null, 2));
  else console.log(renderTerminalBriefFinalCountCloseoutMarkdown(candidate));
  process.exit(candidate.decision === "candidate" ? 0 : 1);
}

main().catch((error) => {
  console.error("terminal-brief-final-count-closeout: " + sanitize(error.message));
  process.exit(2);
});
