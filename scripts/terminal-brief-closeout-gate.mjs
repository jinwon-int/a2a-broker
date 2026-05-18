#!/usr/bin/env node
// Source-only Terminal Brief closeout gate.
//
// Consumes a Terminal Brief finalizer workflow packet and renders the dry-run
// approval gate that must sit before any real closeout mutation. It never posts
// comments, merges/closes GitHub items, sends providers, ACKs terminal rows,
// creates TaskFlow records, mutates DB state, restarts services, replays
// history, publishes releases, or touches secrets.

import { readFile } from "node:fs/promises";
import process from "node:process";

import {
  buildTerminalBriefCloseoutGate,
  extractTerminalBriefFinalizerWorkflowPacket,
  renderTerminalBriefCloseoutGateMarkdown,
} from "../dist/core/terminal-brief-closeout-gate.js";
import {
  buildTerminalBriefFinalizerWorkflow,
} from "../dist/core/terminal-brief-finalizer-workflow.js";

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
    issueUrl: readOption("--issue-url"),
    prUrl: readOption("--pr-url"),
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

function workflowFromRaw(raw) {
  try {
    return extractTerminalBriefFinalizerWorkflowPacket(raw);
  } catch {
    const handoff = raw?.handoff ?? raw?.finalizerHandoff ?? raw;
    if (handoff?.kind === "a2a-broker.terminal-brief-finalizer-handoff.packet") {
      return buildTerminalBriefFinalizerWorkflow(handoff, {
        issueUrl: raw?.issueUrl,
        prUrl: raw?.prUrl,
      });
    }
    throw new Error("input must contain a Terminal Brief finalizer workflow packet or handoff packet");
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.input) {
    throw new Error("usage: npm run terminal_brief_closeout_gate -- --input fixture.json [--issue-url https://github.com/owner/repo/issues/1] [--pr-url https://github.com/owner/repo/pull/1] [--markdown|--json]");
  }
  const raw = JSON.parse(await readFile(options.input, "utf8"));
  const workflow = workflowFromRaw(raw);
  const packet = buildTerminalBriefCloseoutGate(workflow, {
    issueUrl: options.issueUrl ?? raw.issueUrl,
    prUrl: options.prUrl ?? raw.prUrl,
  });
  if (options.json && !options.markdown) console.log(JSON.stringify(packet, null, 2));
  else console.log(renderTerminalBriefCloseoutGateMarkdown(packet));
  process.exit(packet.decision === "ready_for_approval" ? 0 : 1);
}

main().catch((error) => {
  console.error("terminal-brief-closeout-gate: " + sanitize(error.message));
  process.exit(2);
});
