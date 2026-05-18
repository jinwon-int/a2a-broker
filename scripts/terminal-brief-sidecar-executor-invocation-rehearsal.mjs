#!/usr/bin/env node
// Source-only Terminal Brief supervised sidecar dry-run executor invocation
// rehearsal. It renders invocation metadata without dispatching an executor,
// spawning a process, starting sidecar, enabling default-on, sending providers,
// ACKing terminal rows, mutating state, restarting services, or moving secrets.

import { readFile } from "node:fs/promises";
import process from "node:process";

import {
  buildTerminalBriefSidecarExecutorInvocationRehearsal,
  extractTerminalBriefSidecarExecutorInvocationRehearsalGate,
  extractTerminalBriefSidecarExecutorInvocationRehearsalOptions,
  renderTerminalBriefSidecarExecutorInvocationRehearsalMarkdown,
} from "../dist/core/terminal-brief-sidecar-executor-invocation-rehearsal.js";

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
    optionsFile: readOption("--options-file"),
    json: argv.includes("--json") || argv.includes("--format=json"),
    markdown: argv.includes("--markdown") || argv.includes("--format=markdown"),
  };
}

function sanitize(value) {
  if (typeof value !== "string") return String(value);
  return value
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, "[redacted-token]")
    .replace(/\b(BROKER_EDGE_SECRET|EDGE_SECRET|TOKEN|SECRET)=\S+/gi, "$1=[redacted]")
    .replace(/\/root\/\.openclaw\/[^\s]+/g, "[openclaw-path]")
    .slice(0, 500);
}

async function readJsonFile(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readOptions(options, rawInput) {
  if (options.optionsFile) {
    return extractTerminalBriefSidecarExecutorInvocationRehearsalOptions(await readJsonFile(options.optionsFile));
  }
  return extractTerminalBriefSidecarExecutorInvocationRehearsalOptions(rawInput);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.input) {
    throw new Error("usage: npm run terminal_brief_sidecar_executor_invocation_rehearsal -- --input start-executor-gate.json [--options-file options.json] [--markdown|--json]");
  }
  const rawInput = await readJsonFile(options.input);
  const gate = extractTerminalBriefSidecarExecutorInvocationRehearsalGate(rawInput);
  const rehearsalOptions = await readOptions(options, rawInput);
  const packet = buildTerminalBriefSidecarExecutorInvocationRehearsal(gate, rehearsalOptions);
  if (options.json && !options.markdown) console.log(JSON.stringify(packet, null, 2));
  else console.log(renderTerminalBriefSidecarExecutorInvocationRehearsalMarkdown(packet));
  process.exit(packet.state === "ready_for_executor_invocation_rehearsal" ? 0 : 1);
}

main().catch((error) => {
  console.error("terminal-brief-sidecar-executor-invocation-rehearsal: " + sanitize(error.message));
  process.exit(2);
});
