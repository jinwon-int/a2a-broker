#!/usr/bin/env node
// Source-only Terminal Brief approval receipt evidence ingestor.
//
// Classifies harness receipt/approval evidence without sending providers,
// mutating terminal receipts, granting approval, or executing closeout actions.

import { readFile } from "node:fs/promises";
import process from "node:process";

import {
  buildTerminalBriefApprovalReceiptIngestor,
  extractTerminalBriefApprovalDispatchAdapterPacket,
  extractTerminalBriefApprovalReceiptEvidence,
  renderTerminalBriefApprovalReceiptIngestorMarkdown,
} from "../dist/core/terminal-brief-approval-receipt-ingestor.js";

function parseArgs(argv) {
  const readOption = (name) => {
    const prefix = name + "=";
    const inline = argv.find((arg) => arg.startsWith(prefix));
    if (inline) return inline.slice(prefix.length);
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const maxAgeRaw = readOption("--max-age-ms");
  return {
    input: readOption("--input"),
    evidenceFile: readOption("--evidence-file"),
    evidenceKind: readOption("--evidence-kind") ?? readOption("--kind"),
    observedAt: readOption("--observed-at"),
    expiresAt: readOption("--expires-at"),
    receiptId: readOption("--receipt-id"),
    providerMessageId: readOption("--provider-message-id"),
    target: readOption("--target"),
    action: readOption("--action"),
    approvedAction: readOption("--approved-action"),
    approvedTarget: readOption("--approved-target"),
    operatorId: readOption("--operator-id"),
    currentSessionId: readOption("--current-session-id"),
    source: readOption("--source"),
    note: readOption("--note"),
    maxAgeMs: maxAgeRaw ? Number(maxAgeRaw) : undefined,
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

async function readEvidence(options, rawInput) {
  if (options.evidenceFile) {
    const raw = JSON.parse(await readFile(options.evidenceFile, "utf8"));
    const fromFile = extractTerminalBriefApprovalReceiptEvidence(raw);
    if (fromFile.length) return fromFile;
    if (Array.isArray(raw)) return raw.filter((value) => value && typeof value === "object");
    if (raw && typeof raw === "object") return [raw];
  }
  const fromInput = extractTerminalBriefApprovalReceiptEvidence(rawInput);
  if (fromInput.length) return fromInput;
  if (options.evidenceKind) {
    return [{
      kind: options.evidenceKind,
      observedAt: options.observedAt,
      expiresAt: options.expiresAt,
      receiptId: options.receiptId,
      providerMessageId: options.providerMessageId,
      target: options.target,
      action: options.action,
      approvedAction: options.approvedAction,
      approvedTarget: options.approvedTarget,
      operatorId: options.operatorId,
      currentSessionId: options.currentSessionId,
      source: options.source,
      note: options.note,
    }];
  }
  return [];
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.input) {
    throw new Error("usage: npm run terminal_brief_approval_receipt_ingestor -- --input approval-dispatch.json [--evidence-file evidence.json | --evidence-kind current_session_visible --observed-at ISO] [--max-age-ms 300000] [--markdown|--json]");
  }
  const rawInput = JSON.parse(await readFile(options.input, "utf8"));
  const dispatch = extractTerminalBriefApprovalDispatchAdapterPacket(rawInput);
  const evidence = await readEvidence(options, rawInput);
  const packet = buildTerminalBriefApprovalReceiptIngestor(dispatch, evidence, {
    maxAgeMs: options.maxAgeMs,
  });
  if (options.json && !options.markdown) console.log(JSON.stringify(packet, null, 2));
  else console.log(renderTerminalBriefApprovalReceiptIngestorMarkdown(packet));
  process.exit(packet.state === "blocked" || packet.state === "conflicting" || packet.state === "stale" ? 1 : 0);
}

main().catch((error) => {
  console.error("terminal-brief-approval-receipt-ingestor: " + sanitize(error.message));
  process.exit(2);
});
