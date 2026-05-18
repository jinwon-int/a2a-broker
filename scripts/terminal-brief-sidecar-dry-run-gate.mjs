#!/usr/bin/env node
// Source-only Terminal Brief sidecar always-on dry-run operating gate.
//
// Renders readiness for supervised dry-run operation without starting the
// sidecar, enabling default-on, sending providers, ACKing terminal rows,
// mutating state, restarting services, or moving secrets.

import { readFile } from "node:fs/promises";
import process from "node:process";

import {
  buildTerminalBriefSidecarDryRunGate,
  extractTerminalBriefSidecarDryRunGateFinalizerStatus,
  extractTerminalBriefSidecarDryRunGateRehearsal,
  extractTerminalBriefSidecarDryRunOperatingEvidence,
  renderTerminalBriefSidecarDryRunGateMarkdown,
} from "../dist/core/terminal-brief-sidecar-dry-run-gate.js";

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
    finalizerStatusFile: readOption("--finalizer-status-file"),
    evidenceFile: readOption("--evidence-file"),
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

async function readFinalizerStatus(options, rawInput) {
  if (options.finalizerStatusFile) {
    const raw = await readJsonFile(options.finalizerStatusFile);
    const status = extractTerminalBriefSidecarDryRunGateFinalizerStatus(raw);
    if (!status) throw new Error("finalizer status file did not contain a Terminal Brief finalizer approval status packet");
    return status;
  }
  return extractTerminalBriefSidecarDryRunGateFinalizerStatus(rawInput);
}

async function readOperatingEvidence(options, rawInput) {
  if (options.evidenceFile) {
    return extractTerminalBriefSidecarDryRunOperatingEvidence(await readJsonFile(options.evidenceFile));
  }
  return extractTerminalBriefSidecarDryRunOperatingEvidence(rawInput);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.input) {
    throw new Error("usage: npm run terminal_brief_sidecar_dry_run_gate -- --input sidecar-rehearsal.json [--finalizer-status-file status.json] [--evidence-file evidence.json] [--markdown|--json]");
  }
  const rawInput = await readJsonFile(options.input);
  const sidecarRehearsal = extractTerminalBriefSidecarDryRunGateRehearsal(rawInput);
  const finalizerStatus = await readFinalizerStatus(options, rawInput);
  const operatingEvidence = await readOperatingEvidence(options, rawInput);
  const packet = buildTerminalBriefSidecarDryRunGate(sidecarRehearsal, finalizerStatus, operatingEvidence);
  if (options.json && !options.markdown) console.log(JSON.stringify(packet, null, 2));
  else console.log(renderTerminalBriefSidecarDryRunGateMarkdown(packet));
  process.exit(packet.state === "ready_for_operator_approval" ? 0 : 1);
}

main().catch((error) => {
  console.error("terminal-brief-sidecar-dry-run-gate: " + sanitize(error.message));
  process.exit(2);
});
