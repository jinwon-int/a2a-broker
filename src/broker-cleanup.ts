#!/usr/bin/env node
import { exit, argv, stderr, stdout } from "node:process";

import {
  BROKER_CLEANUP_APPROVAL,
  applyBrokerCleanupPlan,
  buildBrokerCleanupPlan,
  type BrokerCleanupPlanOptions,
} from "./core/broker-cleanup.js";
import { SqliteBrokerStateStore } from "./core/store.js";

interface CliOptions extends BrokerCleanupPlanOptions {
  sqliteFile?: string;
  execute: boolean;
  approval?: string;
  backupProofRef?: string;
  backupProofSha256?: string;
}

function parseCliArgs(args: string[]): CliOptions {
  const options: CliOptions = { execute: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = (): string => {
      const value = args[i + 1];
      if (!value) {
        throw new Error(`${arg} requires a value`);
      }
      i += 1;
      return value;
    };
    switch (arg) {
      case "--sqlite":
      case "--sqlite-file":
        options.sqliteFile = next();
        break;
      case "--execute":
        options.execute = true;
        break;
      case "--approval":
        options.approval = next();
        break;
      case "--backup-proof":
      case "--backup-proof-ref":
        options.backupProofRef = next();
        break;
      case "--backup-proof-sha256":
        options.backupProofSha256 = next();
        break;
      case "--now-ms":
        options.nowMs = Number(next());
        break;
      case "--task-retention-ms":
        options.taskRetentionMs = Number(next());
        break;
      case "--max-terminal-tasks":
        options.maxTerminalTasks = Number(next());
        break;
      case "--audit-retention-ms":
        options.auditRetentionMs = Number(next());
        break;
      case "--max-audit-events":
        options.maxAuditEvents = Number(next());
        break;
      case "--worker-retention-ms":
        options.workerRetentionMs = Number(next());
        break;
      case "--max-inactive-workers":
        options.maxInactiveWorkers = Number(next());
        break;
      case "--help":
        printHelp();
        exit(0);
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function printHelp(): void {
  stdout.write(`Usage: broker-cleanup --sqlite-file <db> [planning options]\n\n`);
  stdout.write(`Default mode is dry-run planning only. To prune candidates, pass:\n`);
  stdout.write(`  --execute --approval ${BROKER_CLEANUP_APPROVAL} --backup-proof <artifact-ref>\n\n`);
  stdout.write(`Planning options:\n`);
  stdout.write(`  --task-retention-ms <ms> --max-terminal-tasks <n>\n`);
  stdout.write(`  --audit-retention-ms <ms> --max-audit-events <n>\n`);
  stdout.write(`  --worker-retention-ms <ms> --max-inactive-workers <n>\n`);
}

async function main(): Promise<void> {
  const options = parseCliArgs(argv.slice(2));
  if (!options.sqliteFile) {
    throw new Error("--sqlite-file is required");
  }
  const store = new SqliteBrokerStateStore(options.sqliteFile, { loadSource: "hot-tables" });
  try {
    const plan = buildBrokerCleanupPlan(store, options);
    if (!options.execute) {
      stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
      return;
    }
    const result = applyBrokerCleanupPlan(store, plan, {
      approval: options.approval,
      backupProof: {
        ref: options.backupProofRef,
        sha256: options.backupProofSha256,
        createdAt: new Date().toISOString(),
      },
    });
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    store.close();
  }
}

main().catch((error: unknown) => {
  stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  exit(1);
});
