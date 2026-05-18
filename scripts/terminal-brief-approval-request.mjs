#!/usr/bin/env node
// Source-only Terminal Brief approval request planner.
//
// Consumes a Terminal Brief closeout gate packet, or a finalizer workflow/handoff
// that can be lowered into a gate, and renders the deterministic approval
// request draft. It never sends the request, grants approval, posts comments,
// merges/closes GitHub items, sends providers, ACKs terminal rows, creates
// TaskFlow records, mutates DB state, restarts services, replays history,
// publishes releases, or touches secrets.

import { readFile } from "node:fs/promises";
import process from "node:process";

import {
  buildTerminalBriefApprovalRequest,
  extractTerminalBriefCloseoutGatePacket,
  renderTerminalBriefApprovalRequestMarkdown,
} from "../dist/core/terminal-brief-approval-request.js";
import {
  buildTerminalBriefCloseoutGate,
  extractTerminalBriefFinalizerWorkflowPacket,
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
    expiresAt: readOption("--expires-at"),
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

function gateFromRaw(raw, options) {
  try {
    return extractTerminalBriefCloseoutGatePacket(raw);
  } catch {
    // Try workflow/handoff convenience path below.
  }
  try {
    const workflow = extractTerminalBriefFinalizerWorkflowPacket(raw);
    return buildTerminalBriefCloseoutGate(workflow, {
      issueUrl: options.issueUrl ?? raw?.issueUrl,
      prUrl: options.prUrl ?? raw?.prUrl,
    });
  } catch {
    const handoff = raw?.handoff ?? raw?.finalizerHandoff ?? raw;
    if (handoff?.kind === "a2a-broker.terminal-brief-finalizer-handoff.packet") {
      const workflow = buildTerminalBriefFinalizerWorkflow(handoff, {
        issueUrl: options.issueUrl ?? raw?.issueUrl,
        prUrl: options.prUrl ?? raw?.prUrl,
      });
      return buildTerminalBriefCloseoutGate(workflow, {
        issueUrl: options.issueUrl ?? raw?.issueUrl,
        prUrl: options.prUrl ?? raw?.prUrl,
      });
    }
  }
  throw new Error("input must contain a Terminal Brief closeout gate, finalizer workflow, or finalizer handoff packet");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.input) {
    throw new Error("usage: npm run terminal_brief_approval_request -- --input closeout-gate.json [--issue-url https://github.com/owner/repo/issues/1] [--pr-url https://github.com/owner/repo/pull/1] [--expires-at ISO] [--markdown|--json]");
  }
  const raw = JSON.parse(await readFile(options.input, "utf8"));
  const gate = gateFromRaw(raw, options);
  const packet = buildTerminalBriefApprovalRequest(gate, {
    expiresAt: options.expiresAt,
  });
  if (options.json && !options.markdown) console.log(JSON.stringify(packet, null, 2));
  else console.log(renderTerminalBriefApprovalRequestMarkdown(packet));
  process.exit(packet.decision === "request_ready" ? 0 : 1);
}

main().catch((error) => {
  console.error("terminal-brief-approval-request: " + sanitize(error.message));
  process.exit(2);
});
