#!/usr/bin/env node
// Source-only Terminal Brief sidecar preflight chain review. It consumes an
// already-built preflight evidence collector packet and reviews chain
// completeness. It does not dispatch approvals, grant approval, invoke
// executors, spawn processes, start sidecars, enable default-on, send
// providers, ACK terminal rows, mutate state, restart services, replay history,
// publish releases, or move secrets.

import { readFile } from "node:fs/promises";
import process from "node:process";

import {
  buildTerminalBriefSidecarPreflightChainReview,
  extractTerminalBriefSidecarPreflightChainReviewCollector,
  extractTerminalBriefSidecarPreflightChainReviewOptions,
  renderTerminalBriefSidecarPreflightChainReviewMarkdown,
} from "../dist/core/terminal-brief-sidecar-preflight-chain-review.js";

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
    return extractTerminalBriefSidecarPreflightChainReviewOptions(await readJsonFile(options.optionsFile));
  }
  return extractTerminalBriefSidecarPreflightChainReviewOptions(rawInput);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.input) {
    throw new Error("usage: npm run terminal_brief_sidecar_preflight_chain_review -- --input preflight-collector.json [--options-file options.json] [--markdown|--json]");
  }
  const rawInput = await readJsonFile(options.input);
  const collector = extractTerminalBriefSidecarPreflightChainReviewCollector(rawInput);
  const reviewOptions = await readOptions(options, rawInput);
  const packet = buildTerminalBriefSidecarPreflightChainReview(collector, reviewOptions);
  if (options.json && !options.markdown) console.log(JSON.stringify(packet, null, 2));
  else console.log(renderTerminalBriefSidecarPreflightChainReviewMarkdown(packet));
  process.exit(packet.state === "ready_for_supervised_dry_run_chain_review" ? 0 : 1);
}

main().catch((error) => {
  console.error("terminal-brief-sidecar-preflight-chain-review: " + sanitize(error.message));
  process.exit(2);
});
