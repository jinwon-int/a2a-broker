#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import process from "node:process";

import {
  buildReleaseEvidenceExport,
  renderReleaseEvidenceMarkdown,
  type ReleaseEvidenceExportOptions,
} from "./core/release-evidence.js";
import type { TaskRecord } from "./core/types.js";

interface InputEnvelope {
  tasks?: TaskRecord[];
  options?: ReleaseEvidenceExportOptions;
  repo?: string;
  issue?: string;
  parentIssue?: string;
  runId?: string;
}

function readOption(argv: string[], name: string): string | undefined {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function usage(): string {
  return [
    "Usage: node dist/release-evidence-export.js --input <tasks-or-envelope.json> [--markdown|--json]",
    "",
    "Read-only dry-run exporter. The input may be an array of TaskRecord objects or",
    "{ tasks, options, repo, issue, parentIssue, runId }. It prints sanitized release",
    "evidence only; it does not call providers, ACK terminal outbox, or mutate broker state.",
  ].join("\n");
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const inputPath = readOption(argv, "--input");
  if (!inputPath) {
    console.error(usage());
    process.exitCode = 2;
    return;
  }

  const raw = JSON.parse(await readFile(inputPath, "utf8")) as InputEnvelope | TaskRecord[];
  const envelope = Array.isArray(raw) ? { tasks: raw } : raw;
  const tasks = Array.isArray(envelope.tasks) ? envelope.tasks : [];
  const options: ReleaseEvidenceExportOptions = {
    ...(envelope.options ?? {}),
    ...(envelope.repo ? { repo: envelope.repo } : {}),
    ...(envelope.issue ? { issue: envelope.issue } : {}),
    ...(envelope.parentIssue ? { parentIssue: envelope.parentIssue } : {}),
    ...(envelope.runId ? { runId: envelope.runId } : {}),
  };

  const report = buildReleaseEvidenceExport(tasks, options);
  if (argv.includes("--markdown") || argv.includes("--format=markdown")) {
    process.stdout.write(renderReleaseEvidenceMarkdown(report));
    return;
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`release-evidence-export: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  });
}
