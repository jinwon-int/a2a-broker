#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HANDLER_VERSION = "0.2.0";
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

function taskPayload(task) {
  return task && typeof task.payload === "object" && !Array.isArray(task.payload) ? task.payload : {};
}

function taskMode(task) {
  const payload = taskPayload(task);
  return safeText(payload.mode, safeText(task?.intent, "generic"));
}

function isTruthyEnv(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? "").trim());
}

function normalizedExecutorMode(env = process.env) {
  const mode = safeText(env.A2A_EXECUTOR_MODE, "").toLowerCase();
  if (["auto", "docker", "builtin"].includes(mode)) return mode;
  return isTruthyEnv(env.A2A_DOCKER_RUNNER_ENABLED) ? "auto" : "builtin";
}

function normalizedDockerScope(env = process.env) {
  const scope = safeText(env.A2A_DOCKER_RUNNER_SCOPE, "").toLowerCase().replace(/_/g, "-");
  if (["all", "all-github", "github"].includes(scope)) return "all-github";
  if (["plugin", "plugin-only", "openclaw-plugin-a2a"].includes(scope)) return "plugin-only";
  return isTruthyEnv(env.A2A_DOCKER_RUNNER_ALL_GITHUB) ? "all-github" : "plugin-only";
}

function shouldFallbackToBuiltin(env = process.env) {
  return isTruthyEnv(env.A2A_DOCKER_RUNNER_FALLBACK_TO_BUILTIN) ||
    safeText(env.A2A_EXECUTOR_FALLBACK, "").toLowerCase() === "builtin";
}

function parseJsonArrayEnv(value) {
  if (!value) return [];
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("A2A_DOCKER_RUNNER_ARGS_JSON must be a JSON string array");
  }
  return parsed;
}

function shouldUseDockerRunner(task, env = process.env) {
  const executorMode = normalizedExecutorMode(env);
  if (executorMode === "builtin") return false;

  const mode = taskMode(task);
  if (task?.intent !== "propose_patch" && mode !== "github-propose-patch") return false;
  if (executorMode === "docker") return true;
  if (normalizedDockerScope(env) === "all-github") return true;

  const payload = taskPayload(task);
  const repo = safeText(payload.repo, "");
  const requestedPreset = safeText(payload.runnerPreset ?? env.A2A_DOCKER_RUNNER_PRESET, "");
  return requestedPreset === "openclaw-plugin-a2a-dev" || /openclaw-plugin-a2a/.test(repo);
}

function buildRunnerTask(task, env = process.env) {
  const payload = taskPayload(task);
  const repo = safeText(payload.repo, "");
  const requestedPreset = safeText(payload.runnerPreset ?? env.A2A_DOCKER_RUNNER_PRESET, "");
  const usesPluginPreset = requestedPreset === "openclaw-plugin-a2a-dev" || /openclaw-plugin-a2a/.test(repo);

  const runnerTask = {
    id: safeText(task.id, `task-${Date.now()}`),
    intent: safeText(task.intent, "propose_patch"),
    mode: taskMode(task),
    prompt: safeText(task.message, safeText(payload.prompt, "")),
    timeoutMs: Number(env.A2A_DOCKER_RUNNER_TASK_TIMEOUT_MS || payload.timeoutMs || 45 * 60 * 1000),
  };

  const issueUrl = safeText(payload.issueUrl, "");
  const issue = safeText(payload.issue, "");
  const issueNumber = safeText(payload.issueNumber, "");
  const reportLanguage = safeText(payload.reportLanguage, "");
  const requestedBy = safeText(payload.requestedBy, safeText(task?.requester?.id, ""));

  if (issueUrl) runnerTask.issueUrl = issueUrl;
  if (issue) runnerTask.issue = issue;
  if (issueNumber) runnerTask.issueNumber = issueNumber;
  if (reportLanguage) runnerTask.reportLanguage = reportLanguage;
  if (requestedBy) runnerTask.requestedBy = requestedBy;

  if (usesPluginPreset) {
    runnerTask.preset = "openclaw-plugin-a2a-dev";
    if (safeText(payload.baseBranch, "")) runnerTask.baseBranch = safeText(payload.baseBranch);
    return runnerTask;
  }

  if (repo) {
    runnerTask.repo = repo;
    if (safeText(payload.baseBranch, "")) runnerTask.baseBranch = safeText(payload.baseBranch);
  }

  return runnerTask;
}

function isGithubEvidenceTask(task) {
  const mode = taskMode(task);
  const intent = safeText(task.intent, "");
  return intent === "propose_patch" && mode === "github-propose-patch";
}


function shouldUseOpenClawBridge(task, env = process.env) {
  if (!isGithubEvidenceTask(task)) return false;
  if (normalizedExecutorMode(env) !== "auto") return false;
  if (isTruthyEnv(env.A2A_OPENCLAW_BRIDGE_DISABLED)) return false;
  return isTruthyEnv(env.A2A_OPENCLAW_BRIDGE_ENABLED) || Boolean(safeText(env.OPENCLAW_BIN, ""));
}

function stripCodeFences(text) {
  const trimmed = safeText(text, "");
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : trimmed;
}

function parseJsonFromLooseText(text) {
  const trimmed = stripCodeFences(text);
  const candidates = [trimmed];
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // keep trying looser candidates
    }
  }
  throw new Error("OpenClaw bridge response was not valid JSON text");
}

function parseOpenClawEnvelope(stdout, stderr) {
  const candidates = [safeText(stdout, ""), safeText(stderr, "")]
    .filter(Boolean)
    .flatMap((text) => {
      const variants = [text];
      const lastBraceLine = text.lastIndexOf("\n{");
      if (lastBraceLine >= 0) variants.push(text.slice(lastBraceLine + 1));
      const firstBrace = text.indexOf("{");
      if (firstBrace > 0) variants.push(text.slice(firstBrace));
      return variants;
    });

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // keep trying
    }
  }
  throw new Error("OpenClaw bridge envelope was not valid JSON");
}

function extractOpenClawText(parsed) {
  if (!parsed || typeof parsed !== "object") return "";
  const payloads = Array.isArray(parsed.payloads) ? parsed.payloads : [];
  const pieces = payloads
    .map((item) => item && typeof item === "object" && typeof item.text === "string" ? item.text.trim() : "")
    .filter(Boolean);
  if (pieces.length) return pieces.join("\n\n");
  return typeof parsed.text === "string" ? parsed.text.trim() : "";
}

function normalizeStringArray(value) {
  return Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : [];
}

function githubEvidenceFromResponse(response) {
  const status = safeText(response?.status || response?.outcome, "");
  const prUrl = safeText(response?.prUrl || response?.pullRequestUrl, "");
  const doneCommentUrl = safeText(response?.doneCommentUrl || response?.commentUrl, "");
  const blockCommentUrl = safeText(response?.blockCommentUrl || response?.blockerCommentUrl, "");
  if (prUrl) return { outcome: "pr_opened", prUrl };
  if (blockCommentUrl) return { outcome: status || "blocked", blockCommentUrl };
  if (doneCommentUrl) return { outcome: status || "done", doneCommentUrl };
  return undefined;
}

function extractIssueNumber(task) {
  const payload = taskPayload(task);
  const raw = safeText(payload.issue, safeText(payload.issueNumber, ""));
  const match = raw.match(/#?(\d+)/);
  return match ? match[1] : raw;
}

function jsonForPrompt(value, limit = 24000) {
  const text = JSON.stringify(value, null, 2);
  return text.length <= limit ? text : `${text.slice(0, limit - 40)}\n...\n[truncated ${text.length - limit + 40} chars]`;
}

function runOpenClawBridge(task, env = process.env) {
  const payload = taskPayload(task);
  const repo = safeText(payload.repo, "");
  const issue = extractIssueNumber(task);
  const issueUrl = safeText(payload.issueUrl, issue && repo ? `https://github.com/${repo}/issues/${issue}` : "");
  if (!repo) {
    return { error: { code: "openclaw_bridge_invalid_task", message: "github-propose-patch requires payload.repo", details: { buildInfo: BUILD_INFO } } };
  }
  if (!issue && !issueUrl) {
    return { error: { code: "openclaw_bridge_invalid_task", message: "github-propose-patch requires payload.issue or payload.issueUrl", details: { buildInfo: BUILD_INFO } } };
  }

  const nodeId = safeText(env.A2A_NODE_ID || env.NODE_ID || env.WORKER_ID, "unknown-node");
  const timeoutSec = String(Math.max(1, Number(env.A2A_OPENCLAW_TIMEOUT_SEC || 900)));
  const sessionId = safeText(env.A2A_OPENCLAW_SESSION_ID, `a2a-${nodeId}-${safeText(task.id, String(Date.now()))}-github`);
  const prompt = [
    `You are A2A worker ${nodeId}. Complete this GitHub development assignment end-to-end.`,
    "Do not report success unless you opened a pull request, posted a Done comment, or posted a Block comment on GitHub.",
    "Use the local workspace and GitHub tools available in this OpenClaw session. If the repo is not present, clone/fetch it into a temporary or appropriate workspace directory.",
    "Never commit sensitive data, raw private paths, or session dumps.",
    "If implementation is unsafe, unclear, or cannot finish within the available time, post a Block comment on the issue with blocker evidence and return its URL.",
    "Return JSON only, no markdown, with exactly this shape:",
    '{"status":"pr_opened|blocked|done","summary":"...","prUrl":"https://github.com/.../pull/123 optional","blockCommentUrl":"https://github.com/.../issues/123#issuecomment-... optional","doneCommentUrl":"https://github.com/.../issues/123#issuecomment-... optional","branch":"optional","tests":["cmd -> result"],"filesChanged":["path"],"risks":["..."]}',
    "At least one of prUrl, blockCommentUrl, or doneCommentUrl is required.",
    "All human-readable text should be Korean unless quoting code/test output.",
    `Repository: ${repo}`,
    `Issue: ${issue ? `#${issue}` : issueUrl}`,
    `Issue URL: ${issueUrl}`,
    `Current workspace root: ${env.A2A_HANDLER_CWD || process.cwd()}`,
    `Task title: ${safeText(payload.title, "")}`,
    `Task focus: ${safeText(payload.focus, "")}`,
    `Acceptance: ${safeText(payload.acceptance, "")}`,
    `Full task message:\n${safeText(task.message, "")}`,
    `Payload JSON:\n${jsonForPrompt(payload)}`,
  ].join("\n\n");

  const command = safeText(env.OPENCLAW_BIN, "openclaw");
  const args = [
    "agent",
    "--local",
    "--agent", safeText(env.A2A_OPENCLAW_AGENT_ID, "main"),
    "--session-id", sessionId,
    "--message", prompt,
    "--thinking", safeText(env.A2A_OPENCLAW_THINKING, "low"),
    "--timeout", timeoutSec,
    "--json",
  ];

  const child = spawnSync(command, args, {
    cwd: safeText(env.A2A_HANDLER_CWD, process.cwd()),
    env,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
    timeout: (Number(timeoutSec) + 30) * 1000,
  });

  if (child.error) {
    return { error: { code: "openclaw_bridge_spawn_failed", message: child.error.message, details: { buildInfo: BUILD_INFO } } };
  }
  if (child.status !== 0) {
    return {
      error: {
        code: child.signal ? "openclaw_bridge_timeout" : "openclaw_bridge_failed",
        message: safeText(child.stderr, safeText(child.stdout, `openclaw exited with ${child.status ?? "unknown"}`)),
        details: { exitCode: child.status, signal: child.signal ?? undefined, buildInfo: BUILD_INFO },
      },
    };
  }

  try {
    const envelope = parseOpenClawEnvelope(child.stdout, child.stderr);
    const text = extractOpenClawText(envelope);
    if (!text) throw new Error("OpenClaw bridge returned no visible text");
    const response = parseJsonFromLooseText(text);
    const evidence = githubEvidenceFromResponse(response);
    if (!evidence) {
      throw new Error("OpenClaw bridge response missing prUrl, doneCommentUrl, or blockCommentUrl");
    }

    const output = {
      github: evidence,
      repo,
      issue: issue ? `#${issue}` : undefined,
      issueUrl,
      branch: safeText(response.branch, undefined),
      tests: normalizeStringArray(response.tests),
      filesChanged: normalizeStringArray(response.filesChanged),
      risks: normalizeStringArray(response.risks),
      nodeId,
      taskId: safeText(task.id, undefined),
    };
    if (safeText(evidence.prUrl, "")) output.prUrl = safeText(evidence.prUrl);
    if (safeText(evidence.doneCommentUrl, "")) output.doneCommentUrl = safeText(evidence.doneCommentUrl);
    if (safeText(evidence.blockCommentUrl, "")) output.blockCommentUrl = safeText(evidence.blockCommentUrl);

    return {
      result: {
        summary: safeText(response.summary, `GitHub task ${evidence.outcome}`),
        note: safeText(response.note, safeText(response.summary, "OpenClaw bridge completed GitHub task")),
        handler: BUILD_INFO,
        lifecycle: {
          intent: safeText(task.intent, "unknown"),
          mode: taskMode(task),
          taskId: safeText(task.id, "unknown"),
          proposalId: safeText(task.proposalId, undefined),
          exchangeId: safeText(task.exchangeId, undefined),
        },
        output,
      },
    };
  } catch (error) {
    return {
      error: {
        code: "openclaw_bridge_invalid_response",
        message: error instanceof Error ? error.message : String(error),
        details: { buildInfo: BUILD_INFO },
      },
    };
  }
}

function buildOutputGithub(parsed) {
  const nested = parsed?.github && typeof parsed.github === "object" && !Array.isArray(parsed.github)
    ? parsed.github
    : {};
  const github = {};
  let hasAny = false;
  const prUrl = safeText(parsed.prUrl, safeText(nested.prUrl, ""));
  const doneCommentUrl = safeText(parsed.doneCommentUrl, safeText(nested.doneCommentUrl, ""));
  const blockCommentUrl = safeText(parsed.blockCommentUrl, safeText(nested.blockCommentUrl, ""));
  if (prUrl) { github.prUrl = prUrl; hasAny = true; }
  if (doneCommentUrl) { github.doneCommentUrl = doneCommentUrl; hasAny = true; }
  if (blockCommentUrl) { github.blockCommentUrl = blockCommentUrl; hasAny = true; }
  return hasAny ? github : undefined;
}

function runDockerRunner(task, env = process.env) {
  const tempDir = mkdtempSync(join(tmpdir(), "openclaw-a2a-runner-"));
  const taskPath = join(tempDir, "task.json");
  const runnerTask = buildRunnerTask(task, env);
  writeFileSync(taskPath, `${JSON.stringify(runnerTask, null, 2)}\n`);

  const command = safeText(env.A2A_DOCKER_RUNNER_BIN, "a2a-docker-runner");
  const args = [...parseJsonArrayEnv(env.A2A_DOCKER_RUNNER_ARGS_JSON), "run", taskPath];

  try {
    const child = spawnSync(command, args, {
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
      env,
    });

    const stdout = safeText(child.stdout, "");
    const stderr = safeText(child.stderr, "");
    const parsed = stdout ? JSON.parse(stdout) : undefined;

    // timeout detection: runner status, signal, or non-zero exit
    const isTimeout =
      parsed?.status === "timeout" ||
      child.signal === "SIGTERM" ||
      child.signal === "SIGKILL" ||
      child.status === 124; // timeout exit code convention

    if (child.status !== 0 || !parsed?.ok) {
      return {
        error: {
          code: isTimeout ? "docker_runner_timeout" : "docker_runner_failed",
          message: parsed?.error || stderr || `a2a-docker-runner exited with code ${child.status}`,
          details: {
            runnerTask,
            exitCode: child.status,
            signal: child.signal ?? undefined,
            runnerResult: parsed,
          },
        },
      };
    }

    const output = {
      runner: {
        status: parsed.status,
        workDir: parsed.workDir,
        artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts : [],
      },
    };

    // map all evidence URLs from runner result through both github sub-object and top-level output
    const githubEvidence = buildOutputGithub(parsed);
    if (githubEvidence) {
      output.github = githubEvidence;
    }
    if (safeText(githubEvidence?.prUrl, "")) output.prUrl = safeText(githubEvidence.prUrl);
    if (safeText(githubEvidence?.doneCommentUrl, "")) output.doneCommentUrl = safeText(githubEvidence.doneCommentUrl);
    if (safeText(githubEvidence?.blockCommentUrl, "")) output.blockCommentUrl = safeText(githubEvidence.blockCommentUrl);

    // github-propose-patch tasks must carry completion evidence; fail early if missing
    if (isGithubEvidenceTask(task) && !githubEvidence) {
      return {
        error: {
          code: "docker_runner_evidence_missing",
          message:
            "docker runner completed but produced no PR/Done/Block evidence URL; " +
            "github-propose-patch tasks require at least one of prUrl, doneCommentUrl, or blockCommentUrl",
          details: {
            runnerTask,
            runnerResult: parsed,
            requiredEvidence: ["prUrl", "doneCommentUrl", "blockCommentUrl"],
          },
        },
      };
    }

    return {
      result: {
        summary: `docker runner completed ${safeText(task.id, "unknown")}`,
        handler: BUILD_INFO,
        lifecycle: {
          intent: safeText(task.intent, "unknown"),
          mode: taskMode(task),
          taskId: safeText(task.id, "unknown"),
          proposalId: safeText(task.proposalId, undefined),
          exchangeId: safeText(task.exchangeId, undefined),
        },
        output,
      },
    };
  } catch (error) {
    if (shouldFallbackToBuiltin(env)) {
      return handleBuiltinTask(task);
    }
    return {
      error: {
        code: "docker_runner_exception",
        message: error instanceof Error ? error.message : String(error),
        details: { runnerTask, buildInfo: BUILD_INFO },
      },
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function handleBuiltinTask(task) {
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

export function handleTask(task, env = process.env) {
  if (!task || typeof task !== "object" || Array.isArray(task)) {
    return { error: { code: "invalid_task", message: "handler input must be a task object", details: { buildInfo: BUILD_INFO } } };
  }

  if (shouldUseDockerRunner(task, env)) {
    return runDockerRunner(task, env);
  }

  if (shouldUseOpenClawBridge(task, env)) {
    return runOpenClawBridge(task, env);
  }

  return handleBuiltinTask(task);
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
    const outcome = handleTask(task);
    process.stdout.write(`${JSON.stringify(outcome)}\n`);
    if (outcome.error) process.exitCode = 1;
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
