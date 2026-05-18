#!/usr/bin/env node
// Source-only Terminal Brief sidecar operator review table packet.
// It renders final pre-dispatch operator review rows without sending approval
// requests, granting approval, invoking executors, spawning processes, starting
// sidecar, enabling default-on, sending providers, ACKing terminal rows,
// mutating state, restarting services, or moving secrets.

import { readFile } from "node:fs/promises";
import process from "node:process";

import {
  buildTerminalBriefSidecarOperatorReviewTable,
  extractTerminalBriefSidecarOperatorReviewTableHandoff,
  extractTerminalBriefSidecarOperatorReviewTableOptions,
  renderTerminalBriefSidecarOperatorReviewTableMarkdown,
} from "../dist/core/terminal-brief-sidecar-operator-review-table.js";

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
    return extractTerminalBriefSidecarOperatorReviewTableOptions(await readJsonFile(options.optionsFile));
  }
  return extractTerminalBriefSidecarOperatorReviewTableOptions(rawInput);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.input) {
    throw new Error("usage: npm run terminal_brief_sidecar_operator_review_table -- --input adapter-handoff-approval.json [--options-file options.json] [--markdown|--json]");
  }
  const rawInput = await readJsonFile(options.input);
  const handoff = extractTerminalBriefSidecarOperatorReviewTableHandoff(rawInput);
  const reviewOptions = await readOptions(options, rawInput);
  const packet = buildTerminalBriefSidecarOperatorReviewTable(handoff, reviewOptions);
  if (options.json && !options.markdown) console.log(JSON.stringify(packet, null, 2));
  else console.log(renderTerminalBriefSidecarOperatorReviewTableMarkdown(packet));
  process.exit(packet.state === "review_table_ready" ? 0 : 1);
}

main().catch((error) => {
  console.error("terminal-brief-sidecar-operator-review-table: " + sanitize(error.message));
  process.exit(2);
});
