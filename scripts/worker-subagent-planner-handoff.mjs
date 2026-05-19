#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import process from "node:process";

import {
  buildA2AWorkerSubagentPlannerHandoff,
  extractA2AWorkerSubagentPlannerHandoffInput,
  renderA2AWorkerSubagentPlannerHandoffMarkdown,
} from "../dist/core/worker-subagent-planner-handoff.js";

function readOption(argv, name) {
  const inline = argv.find((arg) => arg.startsWith(name + "="));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function main() {
  const argv = process.argv.slice(2);
  const inputPath = readOption(argv, "--input");
  if (!inputPath) throw new Error("usage: node scripts/worker-subagent-planner-handoff.mjs --input fixture.json [--json]");
  const raw = JSON.parse(await readFile(inputPath, "utf8"));
  const packet = buildA2AWorkerSubagentPlannerHandoff(extractA2AWorkerSubagentPlannerHandoffInput(raw));
  if (argv.includes("--json")) console.log(JSON.stringify(packet, null, 2));
  else console.log(renderA2AWorkerSubagentPlannerHandoffMarkdown(packet));
}

main().catch((error) => {
  console.error("worker-subagent-planner-handoff: " + (error instanceof Error ? error.message : String(error)));
  process.exit(2);
});
