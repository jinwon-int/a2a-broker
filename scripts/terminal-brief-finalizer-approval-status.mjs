#!/usr/bin/env node
// Source-only Terminal Brief broker finalizer approval status table.
//
// Renders a compact readiness view from approval dispatch and receipt-ingestor
// packets without sending providers, ACKing terminal rows, granting approval,
// mutating GitHub/DB/TaskFlow state, or executing closeout actions.

import { readFile } from "node:fs/promises";
import process from "node:process";

import {
  buildTerminalBriefFinalizerApprovalStatus,
  extractTerminalBriefFinalizerApprovalReceiptStatus,
  extractTerminalBriefFinalizerApprovalStatusDispatch,
  renderTerminalBriefFinalizerApprovalStatusMarkdown,
} from "../dist/core/terminal-brief-finalizer-approval-status.js";

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
    receiptFile: readOption("--receipt-file"),
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

async function readReceipt(options, rawInput) {
  if (options.receiptFile) {
    const raw = JSON.parse(await readFile(options.receiptFile, "utf8"));
    const receipt = extractTerminalBriefFinalizerApprovalReceiptStatus(raw);
    if (!receipt) throw new Error("receipt file did not contain a Terminal Brief approval receipt ingestor packet");
    return receipt;
  }
  return extractTerminalBriefFinalizerApprovalReceiptStatus(rawInput);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.input) {
    throw new Error("usage: npm run terminal_brief_finalizer_approval_status -- --input approval-dispatch.json [--receipt-file approval-receipt-ingestor.json] [--markdown|--json]");
  }
  const rawInput = JSON.parse(await readFile(options.input, "utf8"));
  const dispatch = extractTerminalBriefFinalizerApprovalStatusDispatch(rawInput);
  const receipt = await readReceipt(options, rawInput);
  const packet = buildTerminalBriefFinalizerApprovalStatus(dispatch, receipt);
  if (options.json && !options.markdown) console.log(JSON.stringify(packet, null, 2));
  else console.log(renderTerminalBriefFinalizerApprovalStatusMarkdown(packet));
  process.exit(packet.state === "ready_for_finalizer_review" ? 0 : 1);
}

main().catch((error) => {
  console.error("terminal-brief-finalizer-approval-status: " + sanitize(error.message));
  process.exit(2);
});
