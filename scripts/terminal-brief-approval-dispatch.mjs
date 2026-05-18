#!/usr/bin/env node
// Source-only Terminal Brief approval dispatch adapter shell.
//
// Produces harness-neutral transcript/receipt drafts for OpenClaw, Hermes,
// Gongyung, or generic adapters without sending providers or granting approval.

import { readFile } from "node:fs/promises";
import process from "node:process";

import {
  buildTerminalBriefApprovalDispatchAdapter,
  extractTerminalBriefApprovalExecutorPacket,
  renderTerminalBriefApprovalDispatchAdapterMarkdown,
} from "../dist/core/terminal-brief-approval-dispatch-adapter.js";
import {
  buildTerminalBriefApprovalExecutor,
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
    adapter: readOption("--adapter"),
    target: readOption("--target"),
    channel: readOption("--channel"),
    requestedBy: readOption("--requested-by"),
    receiptId: readOption("--receipt-id"),
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

function executorFromRaw(raw, options) {
  try {
    return extractTerminalBriefApprovalExecutorPacket(raw);
  } catch {
    // Try lower-level packet convenience paths below.
  }
  try {
    const approvalRequest = raw?.approvalRequest ?? raw?.approvalRequestPacket ?? raw?.requestPacket ?? raw?.packet ?? raw;
    if (approvalRequest?.kind === "a2a-broker.terminal-brief-approval-request.packet") {
      return buildTerminalBriefApprovalExecutor(approvalRequest, {
        selectedAction: options.selectedAction,
        selectedTarget: options.selectedTarget,
        attemptExecute: options.attemptExecute,
      });
    }
  } catch {
    // Try closeout gate/workflow/handoff paths below.
  }
  try {
    const gate = extractTerminalBriefCloseoutGatePacket(raw);
    return buildTerminalBriefApprovalExecutor(buildTerminalBriefApprovalRequest(gate), {
      selectedAction: options.selectedAction,
      selectedTarget: options.selectedTarget,
      attemptExecute: options.attemptExecute,
    });
  } catch {
    // Try workflow/handoff paths below.
  }
  try {
    const workflow = extractTerminalBriefFinalizerWorkflowPacket(raw);
    return buildTerminalBriefApprovalExecutor(buildTerminalBriefApprovalRequest(buildTerminalBriefCloseoutGate(workflow, {
      issueUrl: options.issueUrl ?? raw?.issueUrl,
      prUrl: options.prUrl ?? raw?.prUrl,
    })), {
      selectedAction: options.selectedAction,
      selectedTarget: options.selectedTarget,
      attemptExecute: options.attemptExecute,
    });
  } catch {
    const handoff = raw?.handoff ?? raw?.finalizerHandoff ?? raw;
    if (handoff?.kind === "a2a-broker.terminal-brief-finalizer-handoff.packet") {
      const workflow = buildTerminalBriefFinalizerWorkflow(handoff, {
        issueUrl: options.issueUrl ?? raw?.issueUrl,
        prUrl: options.prUrl ?? raw?.prUrl,
      });
      return buildTerminalBriefApprovalExecutor(buildTerminalBriefApprovalRequest(buildTerminalBriefCloseoutGate(workflow, {
        issueUrl: options.issueUrl ?? raw?.issueUrl,
        prUrl: options.prUrl ?? raw?.prUrl,
      })), {
        selectedAction: options.selectedAction,
        selectedTarget: options.selectedTarget,
        attemptExecute: options.attemptExecute,
      });
    }
  }
  throw new Error("input must contain a Terminal Brief approval executor, approval request, closeout gate, finalizer workflow, or finalizer handoff packet");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.input) {
    throw new Error("usage: npm run terminal_brief_approval_dispatch -- --input executor.json [--adapter generic|openclaw|hermes|gongyung] [--target target] [--channel channel] [--selected-action post_closeout_comment] [--markdown|--json]");
  }
  const raw = JSON.parse(await readFile(options.input, "utf8"));
  const executor = executorFromRaw(raw, options);
  const packet = buildTerminalBriefApprovalDispatchAdapter(executor, {
    adapter: options.adapter,
    target: options.target,
    channel: options.channel,
    requestedBy: options.requestedBy,
    receiptId: options.receiptId,
  });
  if (options.json && !options.markdown) console.log(JSON.stringify(packet, null, 2));
  else console.log(renderTerminalBriefApprovalDispatchAdapterMarkdown(packet));
  process.exit(packet.state === "dispatch_blocked" ? 1 : 0);
}

main().catch((error) => {
  console.error("terminal-brief-approval-dispatch: " + sanitize(error.message));
  process.exit(2);
});
