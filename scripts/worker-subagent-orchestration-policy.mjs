#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import process from "node:process";

import {
  buildA2AWorkerSubagentOrchestrationPolicy,
  renderA2AWorkerSubagentOrchestrationPolicyMarkdown,
} from "../dist/core/worker-subagent-orchestration-policy.js";

function readOption(argv, name) {
  const inline = argv.find((arg) => arg.startsWith(name + "="));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function main() {
  const argv = process.argv.slice(2);
  const inputPath = readOption(argv, "--input");
  if (!inputPath) throw new Error("usage: node scripts/worker-subagent-orchestration-policy.mjs --input fixture.json [--json]");
  const input = JSON.parse(await readFile(inputPath, "utf8"));
  const packet = buildA2AWorkerSubagentOrchestrationPolicy(input);
  if (argv.includes("--json")) console.log(JSON.stringify(packet, null, 2));
  else console.log(renderA2AWorkerSubagentOrchestrationPolicyMarkdown(packet));
}

main().catch((error) => {
  console.error("worker-subagent-orchestration-policy: " + (error instanceof Error ? error.message : String(error)));
  process.exit(2);
});
