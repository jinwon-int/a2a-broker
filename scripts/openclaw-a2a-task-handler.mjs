#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HANDLER_VERSION = "0.2.9";
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

function isDockerBrokerNoopSmokeTask(task) {
  const payload = taskPayload(task);
  return taskMode(task) === "docker-broker-noop-smoke" && payload.noOp === true;
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

function isDockerRunnerBinConfigured(env = process.env) {
  return safeText(env.A2A_DOCKER_RUNNER_BIN, "").length > 0;
}

// Returns true when the executor policy mandates docker for all GitHub patch tasks.
// In these modes the runner binary must be explicitly configured up-front.
function isDockerFirstMode(env = process.env) {
  const executorMode = normalizedExecutorMode(env);
  if (executorMode === "docker") return true;
  if (executorMode === "auto" && normalizedDockerScope(env) === "all-github") return true;
  return false;
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

  if (!isGithubEvidenceTask(task)) return false;
  if (executorMode === "docker") return true;
  if (normalizedDockerScope(env) === "all-github") {
    return !(hasBlockedClaudeDockerConfig(env) && isOpenClawBridgeConfigured(env));
  }

  const payload = taskPayload(task);
  const repo = safeText(payload.repo, "");
  const requestedPreset = safeText(payload.runnerPreset ?? env.A2A_DOCKER_RUNNER_PRESET, "");
  return requestedPreset === "openclaw-plugin-a2a-dev" || /openclaw-plugin-a2a/.test(repo);
}

function hasBlockedClaudeDockerConfig(env = process.env) {
  if (isTruthyEnv(env.A2A_ALLOW_CLAUDE_IN_DOCKER) || isTruthyEnv(env.A2A_DOCKER_RUNNER_ALLOW_CLAUDE_IN_DOCKER)) return false;

  const commandValues = [
    env.A2A_DOCKER_RUNNER_PATCH_COMMAND_SCRIPT,
    env.A2A_DOCKER_RUNNER_PATCH_COMMAND_JSON,
    env.A2A_DOCKER_RUNNER_PATCH_COMMAND_TEMPLATE,
  ];
  if (commandValues.some((value) => value && referencesClaudeDocker(value))) return true;

  const mounts = safeText(env.A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON, "");
  return Boolean(mounts && referencesClaudeDocker(mounts));
}

function referencesClaudeDocker(value) {
  return [
    /@anthropic-ai\/claude-code/i,
    /(^|[\s;|&"'`])claude([\s;|&"'`-]|$)/i,
    /\.claude(?:\.json|\/|$)/i,
    /claude-(?:install|output|prompt)\.log|claude-prompt\.md/i,
    /claude(?:\.json|-dir)?/i,
  ].some((pattern) => pattern.test(String(value ?? "")));
}

function isOpenClawBridgeConfigured(env = process.env) {
  if (isTruthyEnv(env.A2A_OPENCLAW_BRIDGE_DISABLED)) return false;
  return isTruthyEnv(env.A2A_OPENCLAW_BRIDGE_ENABLED) || Boolean(safeText(env.OPENCLAW_BIN, ""));
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
    prompt: [
      safeText(task.message, safeText(payload.prompt, "")),
      "Leave a Start marker before work begins and a PR, Done, or Block marker when work ends; return startCommentUrl plus prUrl, doneCommentUrl, or blockCommentUrl when available.",
      "Before creating a PR, fail closed if OpenClaw runtime/bootstrap context files would enter the branch or artifact evidence. Report the exact repo-relative offending paths, including any of: AGENTS.md, SOUL.md, USER.md, TOOLS.md, HEARTBEAT.md, IDENTITY.md, .openclaw/**.",
    ].filter(Boolean).join("\n\n"),
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

  if (Array.isArray(payload.repos) && payload.repos.length > 0) {
    runnerTask.repos = payload.repos;
  }
  if (Array.isArray(payload.commands) && payload.commands.every((item) => typeof item === "string")) {
    runnerTask.commands = payload.commands;
  }

  return runnerTask;
}

function isGithubEvidenceTask(task) {
  const mode = taskMode(task);
  const intent = safeText(task.intent, "");
  if (intent === "propose_patch" && (mode === "github-propose-patch" || mode === "github-issue-instruction")) return true;
  if (intent === "verify" && mode === "github-verify") return true;
  return false;
}


function shouldUseOpenClawBridge(task, env = process.env) {
  if (!isGithubEvidenceTask(task)) return false;
  if (normalizedExecutorMode(env) !== "auto") return false;
  const dockerScope = normalizedDockerScope(env);
  if (dockerScope !== "plugin-only" && !(dockerScope === "all-github" && hasBlockedClaudeDockerConfig(env))) return false;
  return isOpenClawBridgeConfigured(env);
}

function githubExecutorNotConfigured(task, env = process.env) {
  return {
    error: {
      code: "github_executor_not_configured",
      message:
        "github-propose-patch tasks require docker-runner or OpenClaw bridge execution evidence; " +
        "refusing built-in no-op success without PR/Done/Block URL",
      details: {
        executorMode: normalizedExecutorMode(env),
        dockerScope: normalizedDockerScope(env),
        bridgeConfigured: shouldUseOpenClawBridge(task, env),
        requiredEvidence: ["prUrl", "doneCommentUrl", "blockCommentUrl"],
        buildInfo: BUILD_INFO,
      },
    },
  };
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

function startCommentUrlFromResponse(response) {
  return safeText(response?.startCommentUrl || response?.startedCommentUrl, "");
}

function withStartEvidence(evidence, response) {
  const startCommentUrl = startCommentUrlFromResponse(response);
  return startCommentUrl ? { ...evidence, startCommentUrl } : evidence;
}

function githubEvidenceFromResponse(response) {
  const status = safeText(response?.status || response?.outcome, "");
  const prUrl = safeText(response?.prUrl || response?.pullRequestUrl, "");
  const doneCommentUrl = safeText(response?.doneCommentUrl || response?.commentUrl, "");
  const blockCommentUrl = safeText(response?.blockCommentUrl || response?.blockerCommentUrl, "");
  if (prUrl) return withStartEvidence({ outcome: "pr_opened", prUrl }, response);
  if (blockCommentUrl) return withStartEvidence({ outcome: status || "blocked", blockCommentUrl }, response);
  if (doneCommentUrl) return withStartEvidence({ outcome: status || "done", doneCommentUrl }, response);
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
    "Leave a Start marker on the GitHub issue before work begins.",
    "Do not report success unless you opened a pull request, posted a Done comment, or posted a Block comment on GitHub.",
    "Use the local workspace and GitHub tools available in this OpenClaw session. If the repo is not present, clone/fetch it into a temporary or appropriate workspace directory.",
    "Never commit sensitive data, raw private paths, or session dumps.",
    "If implementation is unsafe, unclear, or cannot finish within the available time, post a Block comment on the issue with blocker evidence and return its URL.",
    "Return JSON only, no markdown, with exactly this shape:",
    '{"status":"pr_opened|blocked|done","summary":"...","startCommentUrl":"https://github.com/.../issues/123#issuecomment-... optional","prUrl":"https://github.com/.../pull/123 optional","blockCommentUrl":"https://github.com/.../issues/123#issuecomment-... optional","doneCommentUrl":"https://github.com/.../issues/123#issuecomment-... optional","branch":"optional","tests":["cmd -> result"],"filesChanged":["path"],"risks":["..."]}',
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

  const watchdogMs = env.A2A_OPENCLAW_WATCHDOG_MS
    ? Number(env.A2A_OPENCLAW_WATCHDOG_MS)
    : (Number(timeoutSec) + 30) * 1000;

  const child = spawnSync(command, args, {
    cwd: safeText(env.A2A_HANDLER_CWD, process.cwd()),
    env,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
    timeout: watchdogMs,
    killSignal: "SIGKILL",
  });

  if (child.error) {
    const isTimeout = child.error.code === "ETIMEDOUT";
    return {
      error: {
        code: isTimeout ? "openclaw_bridge_timeout" : "openclaw_bridge_spawn_failed",
        message: child.error.message,
        details: { signal: child.signal ?? undefined, buildInfo: BUILD_INFO },
      },
    };
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

  // --- no-final-json safeguards (issue #193) ---
  let envelope;
  try {
    envelope = parseOpenClawEnvelope(child.stdout, child.stderr);
  } catch {
    return {
      error: {
        code: "openclaw_bridge_no_final_json",
        message: "OpenClaw bridge produced no parseable output envelope",
        details: { buildInfo: BUILD_INFO },
      },
    };
  }

  const text = extractOpenClawText(envelope);
  if (!text) {
    return {
      error: {
        code: "openclaw_bridge_no_final_json",
        message: "OpenClaw bridge returned no visible text output",
        details: { buildInfo: BUILD_INFO },
      },
    };
  }

  let response;
  try {
    response = parseJsonFromLooseText(text);
  } catch {
    return {
      error: {
        code: "openclaw_bridge_no_final_json",
        message: "OpenClaw bridge response text contained no valid JSON",
        details: { buildInfo: BUILD_INFO },
      },
    };
  }

  const evidence = githubEvidenceFromResponse(response);
  if (!evidence) {
    return {
      error: {
        code: "openclaw_bridge_evidence_missing",
        message: "OpenClaw bridge response JSON missing prUrl, doneCommentUrl, or blockCommentUrl",
        details: { buildInfo: BUILD_INFO },
      },
    };
  }

  try {
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
    if (safeText(evidence.startCommentUrl, "")) output.startCommentUrl = safeText(evidence.startCommentUrl);
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

function extractOpenClawBootstrapLeakPaths(...values) {
  const text = values
    .map((value) => typeof value === "string" ? value : JSON.stringify(value ?? ""))
    .join("\n");
  const matches = new Set();
  const patterns = [
    /(?:^|[\s"'`:,])((?:\.?\/?|[A-Za-z]:\\)?(?:[\w.-]+[\\/])*AGENTS\.md)(?=$|[\s"'`,])/g,
    /(?:^|[\s"'`:,])((?:\.?\/?|[A-Za-z]:\\)?(?:[\w.-]+[\\/])*SOUL\.md)(?=$|[\s"'`,])/g,
    /(?:^|[\s"'`:,])((?:\.?\/?|[A-Za-z]:\\)?(?:[\w.-]+[\\/])*USER\.md)(?=$|[\s"'`,])/g,
    /(?:^|[\s"'`:,])((?:\.?\/?|[A-Za-z]:\\)?(?:[\w.-]+[\\/])*TOOLS\.md)(?=$|[\s"'`,])/g,
    /(?:^|[\s"'`:,])((?:\.?\/?|[A-Za-z]:\\)?(?:[\w.-]+[\\/])*HEARTBEAT\.md)(?=$|[\s"'`,])/g,
    /(?:^|[\s"'`:,])((?:\.?\/?|[A-Za-z]:\\)?(?:[\w.-]+[\\/])*IDENTITY\.md)(?=$|[\s"'`,])/g,
    /(?:^|[\s"'`:,])((?:\.?\/?|[A-Za-z]:\\)?(?:[\w.-]+[\\/])*\.openclaw(?:[\\/][^\s"'`,]+)?)(?=$|[\s"'`,])/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      matches.add(match[1].replace(/\\/g, "/").replace(/^\.\//, ""));
    }
  }
  return [...matches].sort();
}

function buildOutputGithub(parsed) {
  const nested = parsed?.github && typeof parsed.github === "object" && !Array.isArray(parsed.github)
    ? parsed.github
    : {};
  const github = {};
  let hasTerminal = false;
  const startCommentUrl = safeText(parsed.startCommentUrl, safeText(nested.startCommentUrl, ""));
  const prUrl = safeText(parsed.prUrl, safeText(nested.prUrl, ""));
  const doneCommentUrl = safeText(parsed.doneCommentUrl, safeText(nested.doneCommentUrl, ""));
  const blockCommentUrl = safeText(parsed.blockCommentUrl, safeText(nested.blockCommentUrl, ""));
  if (startCommentUrl) github.startCommentUrl = startCommentUrl;
  if (prUrl) { github.prUrl = prUrl; hasTerminal = true; }
  if (doneCommentUrl) { github.doneCommentUrl = doneCommentUrl; hasTerminal = true; }
  if (blockCommentUrl) { github.blockCommentUrl = blockCommentUrl; hasTerminal = true; }
  return hasTerminal ? github : undefined;
}

function runDockerRunner(task, env = process.env) {
  // docker-first readiness guard: explicit docker mode or all-github scope requires
  // A2A_DOCKER_RUNNER_BIN to be set so the operator has consciously chosen a runner path.
  // Without it we return a clear config error instead of a confusing ENOENT spawn failure.
  if (isDockerFirstMode(env) && !isDockerRunnerBinConfigured(env)) {
    return {
      error: {
        code: "docker_runner_not_configured",
        message:
          "docker-first executor policy requires A2A_DOCKER_RUNNER_BIN to be explicitly configured; " +
          "refusing github-propose-patch without a confirmed runner path",
        details: {
          executorMode: normalizedExecutorMode(env),
          dockerScope: normalizedDockerScope(env),
          requiredEnv: ["A2A_DOCKER_RUNNER_BIN"],
          buildInfo: BUILD_INFO,
        },
      },
    };
  }

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
      const openclawBootstrapLeakPaths = extractOpenClawBootstrapLeakPaths(parsed, stdout, stderr);
      return {
        error: {
          code: isTimeout ? "docker_runner_timeout" : "docker_runner_failed",
          message: parsed?.error || stderr || `a2a-docker-runner exited with code ${child.status}`,
          details: {
            runnerTask,
            exitCode: child.status,
            signal: child.signal ?? undefined,
            runnerResult: parsed,
            ...(openclawBootstrapLeakPaths.length ? { openclawBootstrapLeakPaths } : {}),
          },
        },
      };
    }

    const nodeId = safeText(env.A2A_NODE_ID || env.NODE_ID || env.WORKER_ID, "unknown-node");
    const repo = safeText(runnerTask.repo, "");
    const issue = safeText(runnerTask.issue, "");
    const issueUrl = safeText(runnerTask.issueUrl, "");

    const output = {
      runner: {
        status: parsed.status,
        workDir: parsed.workDir,
        artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts : [],
      },
    };

    if (repo) output.repo = repo;
    if (issue) output.issue = issue;
    if (issueUrl) output.issueUrl = issueUrl;
    output.nodeId = nodeId;
    output.taskId = safeText(task.id, undefined);

    const branch = safeText(parsed.branch, "");
    if (branch) output.branch = branch;
    const tests = normalizeStringArray(parsed.tests);
    if (tests.length) output.tests = tests;
    const filesChanged = normalizeStringArray(parsed.filesChanged);
    if (filesChanged.length) output.filesChanged = filesChanged;
    const risks = normalizeStringArray(parsed.risks);
    if (risks.length) output.risks = risks;

    // --- fail-closed branch mismatch guard (issue #447) ---
    const expectedBaseBranch = safeText(runnerTask.baseBranch, "");
    if (expectedBaseBranch && branch && branch !== expectedBaseBranch) {
      return {
        error: {
          code: "docker_runner_branch_mismatch",
          message:
            `docker runner completed on branch "${branch}" but task expected baseBranch "${expectedBaseBranch}"; ` +
            "refusing to merge evidence from an unexpected branch",
          details: {
            runnerTask,
            expectedBaseBranch,
            actualBranch: branch,
            runnerResult: parsed,
          },
        },
      };
    }

    // --- fail-closed no-diff guard (issue #447) ---
    if (isGithubEvidenceTask(task) && filesChanged.length === 0) {
      return {
        error: {
          code: "docker_runner_no_diff",
          message:
            "docker runner completed but produced no file changes; " +
            "github-propose-patch tasks must modify at least one tracked file",
          details: {
            runnerTask,
            runnerResult: parsed,
            branch,
          },
        },
      };
    }

    // map all evidence URLs from runner result through both github sub-object and top-level output
    const githubEvidence = buildOutputGithub(parsed);
    if (githubEvidence) {
      output.github = githubEvidence;
    }
    if (safeText(githubEvidence?.startCommentUrl, "")) output.startCommentUrl = safeText(githubEvidence.startCommentUrl);
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
      return handleBuiltinTask(task, env);
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

function handleBuiltinTask(task, env = process.env) {
  if (isGithubEvidenceTask(task)) {
    return githubExecutorNotConfigured(task, env);
  }

  const mode = taskMode(task);
  const payload = taskPayload(task);

  if (isDockerBrokerNoopSmokeTask(task)) {
    return {
      result: {
        summary: `docker broker noop smoke completed ${safeText(task.id, "unknown")}`,
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
          smoke: {
            ok: true,
            noOp: true,
            runId: safeText(payload.runId, undefined),
            worker: safeText(payload.worker, safeText(task.assignedWorkerId, undefined)),
            completedAt: new Date().toISOString(),
          },
          payloadKeys: Object.keys(payload).sort(),
        },
      },
    };
  }

  const summary = `generic ${mode} task accepted by versioned OpenClaw A2A handler`;

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

  return handleBuiltinTask(task, env);
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
