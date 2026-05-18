#!/usr/bin/env node
// Source-only Terminal Brief sidecar supervised dry-run start approval request.
// It consumes an already-built preflight chain review packet and renders an
// approval request draft. It does not send the request, grant approval, invoke
// executors, spawn processes, start sidecars, enable default-on, send
// providers, ACK terminal rows, mutate state, restart services, replay history,
// publish releases, or move secrets.

import { readFile } from "node:fs/promises";
import process from "node:process";

import {
  buildTerminalBriefSidecarDryRunStartApprovalRequest,
  extractTerminalBriefSidecarDryRunStartApprovalRequestChainReview,
  extractTerminalBriefSidecarDryRunStartApprovalRequestOptions,
  renderTerminalBriefSidecarDryRunStartApprovalRequestMarkdown,
} from "../dist/core/terminal-brief-sidecar-dry-run-start-approval-request.js";

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
    requestFile: readOption("--request-file"),
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

async function readRequestOptions(options, rawInput) {
  if (options.requestFile) {
    return extractTerminalBriefSidecarDryRunStartApprovalRequestOptions(await readJsonFile(options.requestFile));
  }
  return extractTerminalBriefSidecarDryRunStartApprovalRequestOptions(rawInput);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.input) {
    throw new Error("usage: npm run terminal_brief_sidecar_dry_run_start_approval_request -- --input preflight-chain-review.json [--request-file request.json] [--markdown|--json]");
  }
  const rawInput = await readJsonFile(options.input);
  const chainReview = extractTerminalBriefSidecarDryRunStartApprovalRequestChainReview(rawInput);
  const requestOptions = await readRequestOptions(options, rawInput);
  const packet = buildTerminalBriefSidecarDryRunStartApprovalRequest(chainReview, requestOptions);
  if (options.json && !options.markdown) console.log(JSON.stringify(packet, null, 2));
  else console.log(renderTerminalBriefSidecarDryRunStartApprovalRequestMarkdown(packet));
  process.exit(packet.state === "approval_request_draft_ready" ? 0 : 1);
}

main().catch((error) => {
  console.error("terminal-brief-sidecar-dry-run-start-approval-request: " + sanitize(error.message));
  process.exit(2);
});
