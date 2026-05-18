#!/usr/bin/env node
// Source-only Terminal Brief approval executor shell.
//
// This shell validates dispatch, simulated approval, and execute-blocked states
// without sending the request, granting real approval, or executing any action.

import { readFile } from "node:fs/promises";
import process from "node:process";

import {
  buildTerminalBriefApprovalExecutor,
  extractTerminalBriefApprovalRequestPacket,
  renderTerminalBriefApprovalExecutorMarkdown,
} from "../dist/core/terminal-brief-approval-executor.js";
import {
  buildTerminalBriefApprovalRequest,
  extractTerminalBriefCloseoutGatePacket,
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
    selectedAction: readOption("--selected-action"),
    selectedTarget: readOption("--selected-target"),
    attemptExecute: argv.includes("--attempt-execute"),
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

function approvalRequestFromRaw(raw, options) {
  try {
    return extractTerminalBriefApprovalRequestPacket(raw);
  } catch {
    // Try lower-level packet convenience paths below.
  }
  try {
    return buildTerminalBriefApprovalRequest(extractTerminalBriefCloseoutGatePacket(raw));
  } catch {
    // Try workflow/handoff paths below.
  }
  try {
    const workflow = extractTerminalBriefFinalizerWorkflowPacket(raw);
    return buildTerminalBriefApprovalRequest(buildTerminalBriefCloseoutGate(workflow, {
      issueUrl: options.issueUrl ?? raw?.issueUrl,
      prUrl: options.prUrl ?? raw?.prUrl,
    }));
  } catch {
    const handoff = raw?.handoff ?? raw?.finalizerHandoff ?? raw;
    if (handoff?.kind === "a2a-broker.terminal-brief-finalizer-handoff.packet") {
      const workflow = buildTerminalBriefFinalizerWorkflow(handoff, {
        issueUrl: options.issueUrl ?? raw?.issueUrl,
        prUrl: options.prUrl ?? raw?.prUrl,
      });
      return buildTerminalBriefApprovalRequest(buildTerminalBriefCloseoutGate(workflow, {
        issueUrl: options.issueUrl ?? raw?.issueUrl,
        prUrl: options.prUrl ?? raw?.prUrl,
      }));
    }
  }
  throw new Error("input must contain a Terminal Brief approval request, closeout gate, finalizer workflow, or finalizer handoff packet");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.input) {
    throw new Error("usage: npm run terminal_brief_approval_executor -- --input approval-request.json [--selected-action post_closeout_comment] [--selected-target https://github.com/owner/repo/issues/1] [--attempt-execute] [--markdown|--json]");
  }
  const raw = JSON.parse(await readFile(options.input, "utf8"));
  const approvalRequest = approvalRequestFromRaw(raw, options);
  const packet = buildTerminalBriefApprovalExecutor(approvalRequest, {
    selectedAction: options.selectedAction,
    selectedTarget: options.selectedTarget,
    attemptExecute: options.attemptExecute,
  });
  if (options.json && !options.markdown) console.log(JSON.stringify(packet, null, 2));
  else console.log(renderTerminalBriefApprovalExecutorMarkdown(packet));
  process.exit(packet.state === "blocked" ? 1 : 0);
}

main().catch((error) => {
  console.error("terminal-brief-approval-executor: " + sanitize(error.message));
  process.exit(2);
});
