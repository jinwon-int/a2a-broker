#!/usr/bin/env node
// Source-only Terminal Brief supervised sidecar dry-run start executor gate.
//
// Renders start-executor readiness without dispatching executor, starting
// sidecar, enabling default-on, sending providers, ACKing terminal rows,
// mutating state, restarting services, or moving secrets.

import { readFile } from "node:fs/promises";
import process from "node:process";

import {
  buildTerminalBriefSidecarStartExecutorGate,
  extractTerminalBriefSidecarStartExecutorGateOptions,
  extractTerminalBriefSidecarStartExecutorGateReceipt,
  renderTerminalBriefSidecarStartExecutorGateMarkdown,
} from "../dist/core/terminal-brief-sidecar-start-executor-gate.js";

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
    return extractTerminalBriefSidecarStartExecutorGateOptions(await readJsonFile(options.optionsFile));
  }
  return extractTerminalBriefSidecarStartExecutorGateOptions(rawInput);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.input) {
    throw new Error("usage: npm run terminal_brief_sidecar_start_executor_gate -- --input activation-receipt.json [--options-file options.json] [--markdown|--json]");
  }
  const rawInput = await readJsonFile(options.input);
  const receipt = extractTerminalBriefSidecarStartExecutorGateReceipt(rawInput);
  const gateOptions = await readOptions(options, rawInput);
  const packet = buildTerminalBriefSidecarStartExecutorGate(receipt, gateOptions);
  if (options.json && !options.markdown) console.log(JSON.stringify(packet, null, 2));
  else console.log(renderTerminalBriefSidecarStartExecutorGateMarkdown(packet));
  process.exit(packet.state === "ready_for_start_executor_review" ? 0 : 1);
}

main().catch((error) => {
  console.error("terminal-brief-sidecar-start-executor-gate: " + sanitize(error.message));
  process.exit(2);
});
