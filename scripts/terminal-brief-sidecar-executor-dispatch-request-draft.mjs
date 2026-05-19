#!/usr/bin/env node
// Source-only Terminal Brief sidecar executor dispatch request draft. It renders
// dispatch metadata without dispatching/invoking executors, spawning processes,
// starting sidecar, enabling default-on, sending providers, ACKing terminal
// rows, mutating state, restarting services, or moving secrets.

import { readFile } from "node:fs/promises";
import process from "node:process";

import {
  buildTerminalBriefSidecarExecutorDispatchRequestDraft,
  extractTerminalBriefSidecarExecutorDispatchRequestDraftFinalReview,
  extractTerminalBriefSidecarExecutorDispatchRequestDraftOptions,
  renderTerminalBriefSidecarExecutorDispatchRequestDraftMarkdown,
} from "../dist/core/terminal-brief-sidecar-executor-dispatch-request-draft.js";

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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.input) {
    throw new Error("usage: npm run terminal_brief_sidecar_executor_dispatch_request_draft -- --input dispatch-draft.json [--options-file options.json] [--markdown|--json]");
  }
  const rawInput = await readJsonFile(options.input);
  const finalReview = extractTerminalBriefSidecarExecutorDispatchRequestDraftFinalReview(rawInput);
  const draftOptions = options.optionsFile
    ? extractTerminalBriefSidecarExecutorDispatchRequestDraftOptions(await readJsonFile(options.optionsFile))
    : extractTerminalBriefSidecarExecutorDispatchRequestDraftOptions(rawInput);
  const packet = buildTerminalBriefSidecarExecutorDispatchRequestDraft(finalReview, draftOptions);
  if (options.json && !options.markdown) console.log(JSON.stringify(packet, null, 2));
  else console.log(renderTerminalBriefSidecarExecutorDispatchRequestDraftMarkdown(packet));
  process.exit(packet.state === "dispatch_request_draft_ready" ? 0 : 1);
}

main().catch((error) => {
  console.error("terminal-brief-sidecar-executor-dispatch-request-draft: " + sanitize(error.message));
  process.exit(2);
});
