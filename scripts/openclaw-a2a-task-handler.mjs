#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HANDLER_VERSION = "0.1.0";
const SOURCE_PATH = fileURLToPath(import.meta.url);
const sourceSha256 = createHash("sha256").update(readFileSync(SOURCE_PATH)).digest("hex");

export const BUILD_INFO = Object.freeze({
  name: "openclaw-a2a-task-handler",
  version: HANDLER_VERSION,
  source: "repo:scripts/openclaw-a2a-task-handler.mjs",
  sourceSha256,
  contract: "stdin A2A task JSON -> stdout WorkerHandlerOutcome JSON",
  credentialFree: true,
  hostNeutral: true,
});

function safeText(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function taskMode(task) {
  const payload = task && typeof task.payload === "object" && !Array.isArray(task.payload) ? task.payload : {};
  return safeText(payload.mode, safeText(task?.intent, "generic"));
}

export function handleTask(task) {
  if (!task || typeof task !== "object" || Array.isArray(task)) {
    return { error: { code: "invalid_task", message: "handler input must be a task object", details: { buildInfo: BUILD_INFO } } };
  }

  const mode = taskMode(task);
  const summary = mode === "github-propose-patch"
    ? "generic patch proposal task accepted by versioned OpenClaw A2A handler"
    : `generic ${mode} task accepted by versioned OpenClaw A2A handler`;

  return {
    result: {
      summary,
      handler: BUILD_INFO,
      lifecycle: {
        intent: safeText(task.intent, "unknown"),
        mode,
        taskId: safeText(task.id, "unknown"),
        proposalId: safeText(task.proposalId, undefined),
        exchangeId: safeText(task.exchangeId, undefined),
      },
      output: {
        message: safeText(task.message, ""),
        payloadKeys: task.payload && typeof task.payload === "object" && !Array.isArray(task.payload)
          ? Object.keys(task.payload).sort()
          : [],
      },
    },
  };
}

async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  return input;
}

if (process.argv[1] === SOURCE_PATH) {
  try {
    const input = await readStdin();
    const task = JSON.parse(input || "null");
    process.stdout.write(`${JSON.stringify(handleTask(task))}\n`);
  } catch (error) {
    process.stdout.write(JSON.stringify({
      error: {
        code: "handler_exception",
        message: error instanceof Error ? error.message : String(error),
        details: { buildInfo: BUILD_INFO },
      },
    }) + "\n");
    process.exitCode = 1;
  }
}
