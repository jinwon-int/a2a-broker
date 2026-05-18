#!/usr/bin/env node
// Source-only Terminal Brief sidecar adapter handoff approval packet.
// It renders adapter handoff metadata and a draft approval request body without
// sending approval requests, granting approval, invoking executors, spawning
// processes, starting sidecar, enabling default-on, sending providers, ACKing
// terminal rows, mutating state, restarting services, or moving secrets.

import { readFile } from "node:fs/promises";
import process from "node:process";

import {
  buildTerminalBriefSidecarAdapterHandoffApproval,
  extractTerminalBriefSidecarAdapterHandoffApprovalOptions,
  extractTerminalBriefSidecarAdapterHandoffApprovalPacket,
  renderTerminalBriefSidecarAdapterHandoffApprovalMarkdown,
} from "../dist/core/terminal-brief-sidecar-adapter-handoff-approval.js";

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
    return extractTerminalBriefSidecarAdapterHandoffApprovalOptions(await readJsonFile(options.optionsFile));
  }
  return extractTerminalBriefSidecarAdapterHandoffApprovalOptions(rawInput);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.input) {
    throw new Error("usage: npm run terminal_brief_sidecar_adapter_handoff_approval -- --input runtime-preflight-approval.json [--options-file options.json] [--markdown|--json]");
  }
  const rawInput = await readJsonFile(options.input);
  const approval = extractTerminalBriefSidecarAdapterHandoffApprovalPacket(rawInput);
  const handoffOptions = await readOptions(options, rawInput);
  const packet = buildTerminalBriefSidecarAdapterHandoffApproval(approval, handoffOptions);
  if (options.json && !options.markdown) console.log(JSON.stringify(packet, null, 2));
  else console.log(renderTerminalBriefSidecarAdapterHandoffApprovalMarkdown(packet));
  process.exit(packet.state === "handoff_packet_ready" ? 0 : 1);
}

main().catch((error) => {
  console.error("terminal-brief-sidecar-adapter-handoff-approval: " + sanitize(error.message));
  process.exit(2);
});
