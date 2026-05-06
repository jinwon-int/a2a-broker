import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { validateTaskCompletionEvidence } from "./worker.js";
import type { TaskRecord } from "./core/types.js";

const handlerPath = "scripts/openclaw-a2a-task-handler.mjs";

interface GithubTaskFixture {
  id: string;
  intent: "propose_patch" | "analyze" | "verify";
  message: string;
  payload: Record<string, unknown>;
  proposalId: string;
  exchangeId: string;
}

function githubTask(overrides?: Partial<GithubTaskFixture>): GithubTaskFixture {
  return {
    id: "task-fixture-1",
    intent: "propose_patch",
    message: "generic chat/proposal lifecycle fixture",
    payload: { mode: "github-propose-patch", repo: "owner/repo", issue: "#1" },
    proposalId: "proposal-fixture-1",
    exchangeId: "exchange-fixture-1",
    ...overrides,
  };
}

function makeTaskRecord(task: GithubTaskFixture): TaskRecord {
  return {
    id: task.id,
    intent: task.intent as TaskRecord["intent"],
    requester: { id: "test-requester", role: "hub" },
    target: { id: "test-target", role: "operator" },
    message: task.message,
    payload: task.payload,
    proposalId: task.proposalId,
    exchangeId: task.exchangeId,
    status: "running" as const,
    targetNodeId: "test-target",
    assignedWorkerId: "test-worker",
    taskOrigin: "github" as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

test("versioned OpenClaw handler exposes credential-free build metadata", () => {
  const result = spawnSync(process.execPath, [handlerPath], {
    input: JSON.stringify(githubTask({ intent: "analyze", payload: { mode: "analysis" } })),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.result.handler.name, "openclaw-a2a-task-handler");
  assert.equal(payload.result.handler.version, "0.2.8");
  assert.match(payload.result.handler.sourceSha256, /^[a-f0-9]{64}$/);
  assert.equal(payload.result.handler.credentialFree, true);
  assert.equal(payload.result.handler.hostNeutral, true);
  assert.equal(payload.result.lifecycle.mode, "analysis");
});

test("versioned OpenClaw handler source does not embed credentials or host paths", () => {
  const source = readFileSync(handlerPath, "utf8");
  assert.doesNotMatch(source, /(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|refresh_token)/i);
  assert.doesNotMatch(source, /\/root\//);
  assert.doesNotMatch(source, /bangtong|dungae|sogyo|yukson/i);
});

test("explicit all-github flag routes GitHub propose_patch tasks through docker runner", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "handler-runner-test-"));
  const fakeRunnerPath = join(tempDir, "fake-runner.mjs");
  try {
    writeFileSync(fakeRunnerPath, `
import { readFileSync } from "node:fs";
const taskPath = process.argv.at(-1);
const task = JSON.parse(readFileSync(taskPath, "utf8"));
if (process.argv[2] !== "run") throw new Error("expected run subcommand");
if (task.repo !== "owner/repo") throw new Error("expected repo mapping");
if (task.mode !== "github-propose-patch") throw new Error("expected mode propagation");
if (task.issue !== "#1") throw new Error("expected issue propagation");
if (task.issueUrl !== "https://github.com/owner/repo/issues/1") throw new Error("expected issueUrl propagation");
if (task.reportLanguage !== "ko") throw new Error("expected reportLanguage propagation");
if (task.requestedBy !== "seoseo-test") throw new Error("expected requestedBy propagation");
console.log(JSON.stringify({
  ok: true,
  taskId: task.id,
  status: "completed",
  workDir: "/tmp/work-fixture",
  stdout: "https://github.com/owner/repo/pull/123",
  stderr: "",
  artifacts: ["/tmp/work-fixture/artifacts/summary.txt"],
  prUrl: "https://github.com/owner/repo/pull/123"
}));
`);

    const task = githubTask({
      payload: {
        mode: "github-propose-patch",
        repo: "owner/repo",
        issue: "#1",
        issueUrl: "https://github.com/owner/repo/issues/1",
        reportLanguage: "ko",
        requestedBy: "seoseo-test",
      },
    });
    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(task),
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_DOCKER_RUNNER_ENABLED: "1",
        A2A_DOCKER_RUNNER_ALL_GITHUB: "1",
        A2A_DOCKER_RUNNER_SCOPE: "all-github",
        A2A_DOCKER_RUNNER_BIN: process.execPath,
        A2A_DOCKER_RUNNER_ARGS_JSON: JSON.stringify([fakeRunnerPath]),
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.result.summary, "docker runner completed task-fixture-1");
    assert.equal(payload.result.output.github.prUrl, "https://github.com/owner/repo/pull/123");
    assert.equal(payload.result.output.prUrl, "https://github.com/owner/repo/pull/123");
    assert.deepEqual(payload.result.output.runner.artifacts, ["/tmp/work-fixture/artifacts/summary.txt"]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("feature flag alone rejects non-plugin GitHub tasks when no bridge is configured", () => {
  const result = spawnSync(process.execPath, [handlerPath], {
    input: JSON.stringify(githubTask()),
    encoding: "utf8",
    env: {
      ...process.env,
      A2A_DOCKER_RUNNER_ENABLED: "1",
      A2A_DOCKER_RUNNER_BIN: "/path/that/should/not/run",
      OPENCLAW_BIN: "",
    },
  });

  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.error.code, "github_executor_not_configured");
  assert.equal(payload.error.details.executorMode, "auto");
  assert.equal(payload.error.details.dockerScope, "plugin-only");
});

test("A2A_EXECUTOR_MODE=builtin refuses GitHub no-op success even with legacy docker flags", () => {
  const result = spawnSync(process.execPath, [handlerPath], {
    input: JSON.stringify(githubTask()),
    encoding: "utf8",
    env: {
      ...process.env,
      A2A_EXECUTOR_MODE: "builtin",
      A2A_DOCKER_RUNNER_ENABLED: "1",
      A2A_DOCKER_RUNNER_ALL_GITHUB: "1",
      A2A_DOCKER_RUNNER_BIN: "/path/that/should/not/run",
    },
  });

  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.error.code, "github_executor_not_configured");
  assert.equal(payload.error.details.executorMode, "builtin");
});

test("A2A_EXECUTOR_MODE=docker routes GitHub propose_patch tasks without legacy gate", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "handler-executor-docker-test-"));
  const fakeRunnerPath = join(tempDir, "fake-runner.mjs");
  try {
    writeFileSync(fakeRunnerPath, `
import { readFileSync } from "node:fs";
const taskPath = process.argv.at(-1);
const task = JSON.parse(readFileSync(taskPath, "utf8"));
if (task.repo !== "owner/repo") throw new Error("expected repo mapping");
console.log(JSON.stringify({ ok: true, taskId: task.id, status: "completed", workDir: "/tmp/work-fixture", artifacts: [], prUrl: "https://github.com/owner/repo/pull/123" }));
`);

    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(githubTask()),
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_EXECUTOR_MODE: "docker",
        A2A_DOCKER_RUNNER_BIN: process.execPath,
        A2A_DOCKER_RUNNER_ARGS_JSON: JSON.stringify([fakeRunnerPath]),
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.result.output.github.prUrl, "https://github.com/owner/repo/pull/123");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("A2A_EXECUTOR_MODE=auto respects A2A_DOCKER_RUNNER_SCOPE=all-github", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "handler-executor-scope-test-"));
  const fakeRunnerPath = join(tempDir, "fake-runner.mjs");
  try {
    writeFileSync(fakeRunnerPath, `
console.log(JSON.stringify({ ok: true, taskId: "task-fixture-1", status: "completed", workDir: "/tmp/work-fixture", artifacts: [], doneCommentUrl: "https://github.com/owner/repo/issues/1#issuecomment-123" }));
`);

    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(githubTask()),
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_EXECUTOR_MODE: "auto",
        A2A_DOCKER_RUNNER_SCOPE: "all-github",
        A2A_DOCKER_RUNNER_BIN: process.execPath,
        A2A_DOCKER_RUNNER_ARGS_JSON: JSON.stringify([fakeRunnerPath]),
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.result.output.github.doneCommentUrl, "https://github.com/owner/repo/issues/1#issuecomment-123");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("all-github auto falls back to host OpenClaw bridge when Claude Docker config is blocked", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "handler-blocked-claude-bridge-test-"));
  const fakeRunnerPath = join(tempDir, "fake-runner.mjs");
  const fakeOpenClawPath = join(tempDir, "fake-openclaw.mjs");
  try {
    writeFileSync(fakeRunnerPath, `
throw new Error("docker runner should not run when Claude Docker config is blocked and bridge is configured");
`);
    writeFileSync(fakeOpenClawPath, `#!/usr/bin/env node
console.log(JSON.stringify({
  payloads: [{
    text: JSON.stringify({
      status: "blocked",
      summary: "bridge handled blocked Claude Docker config",
      blockCommentUrl: "https://github.com/owner/repo/issues/1#issuecomment-456",
      tests: ["bridge fallback fixture -> pass"],
      risks: []
    })
  }]
}));
`);
    chmodSync(fakeOpenClawPath, 0o755);

    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(githubTask()),
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_EXECUTOR_MODE: "auto",
        A2A_DOCKER_RUNNER_SCOPE: "all-github",
        A2A_DOCKER_RUNNER_BIN: process.execPath,
        A2A_DOCKER_RUNNER_ARGS_JSON: JSON.stringify([fakeRunnerPath]),
        A2A_DOCKER_RUNNER_PATCH_COMMAND_JSON: JSON.stringify({ argv: ["claude", "--print", "hello"] }),
        A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON: JSON.stringify([
          { source: "/tmp/.claude", target: "/run/secrets/claude-dir", readOnly: true },
        ]),
        OPENCLAW_BIN: fakeOpenClawPath,
        A2A_NODE_ID: "worker-bridge-fallback",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.result.summary, "bridge handled blocked Claude Docker config");
    assert.equal(payload.result.output.github.outcome, "blocked");
    assert.equal(payload.result.output.github.blockCommentUrl, "https://github.com/owner/repo/issues/1#issuecomment-456");
    assert.equal(payload.result.output.nodeId, "worker-bridge-fallback");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("explicit Claude-in-Docker opt-in keeps all-github tasks on docker runner", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "handler-claude-opt-in-docker-test-"));
  const fakeRunnerPath = join(tempDir, "fake-runner.mjs");
  const fakeOpenClawPath = join(tempDir, "fake-openclaw.mjs");
  try {
    writeFileSync(fakeRunnerPath, `
console.log(JSON.stringify({ ok: true, taskId: "task-fixture-1", status: "completed", workDir: "/tmp/work-fixture", artifacts: [], prUrl: "https://github.com/owner/repo/pull/789" }));
`);
    writeFileSync(fakeOpenClawPath, `#!/usr/bin/env node
throw new Error("bridge should not run when Claude-in-Docker is explicitly allowed");
`);
    chmodSync(fakeOpenClawPath, 0o755);

    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(githubTask()),
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_EXECUTOR_MODE: "auto",
        A2A_DOCKER_RUNNER_SCOPE: "all-github",
        A2A_ALLOW_CLAUDE_IN_DOCKER: "1",
        A2A_DOCKER_RUNNER_BIN: process.execPath,
        A2A_DOCKER_RUNNER_ARGS_JSON: JSON.stringify([fakeRunnerPath]),
        A2A_DOCKER_RUNNER_PATCH_COMMAND_JSON: JSON.stringify({ argv: ["claude", "--print", "hello"] }),
        OPENCLAW_BIN: fakeOpenClawPath,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.result.summary, "docker runner completed task-fixture-1");
    assert.equal(payload.result.output.github.prUrl, "https://github.com/owner/repo/pull/789");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("A2A_EXECUTOR_MODE=auto rejects plugin-only non-plugin GitHub task without OpenClaw bridge", () => {
  const result = spawnSync(process.execPath, [handlerPath], {
    input: JSON.stringify(githubTask()),
    encoding: "utf8",
    env: {
      ...process.env,
      A2A_EXECUTOR_MODE: "auto",
      A2A_DOCKER_RUNNER_SCOPE: "plugin-only",
      A2A_DOCKER_RUNNER_BIN: "/path/that/should/not/run",
      OPENCLAW_BIN: "",
    },
  });

  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.error.code, "github_executor_not_configured");
  assert.equal(payload.error.details.executorMode, "auto");
  assert.equal(payload.error.details.dockerScope, "plugin-only");
});

test("plugin-only GitHub tasks use host OpenClaw bridge when configured", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "handler-openclaw-bridge-test-"));
  const fakeOpenClawPath = join(tempDir, "fake-openclaw.mjs");
  try {
    writeFileSync(fakeOpenClawPath, `#!/usr/bin/env node
if (!process.argv.includes("agent")) throw new Error("expected agent subcommand");
if (!process.argv.includes("--json")) throw new Error("expected json output flag");
console.log(JSON.stringify({
  payloads: [{
    text: JSON.stringify({
      status: "pr_opened",
      summary: "bridge completed",
      prUrl: "https://github.com/owner/repo/pull/456",
      branch: "bridge-fixture",
      tests: ["fake bridge -> pass"],
      filesChanged: ["src/example.ts"],
      risks: []
    })
  }]
}));
`);
    chmodSync(fakeOpenClawPath, 0o755);

    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(githubTask()),
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_EXECUTOR_MODE: "auto",
        A2A_DOCKER_RUNNER_SCOPE: "plugin-only",
        OPENCLAW_BIN: fakeOpenClawPath,
        A2A_NODE_ID: "worker-a",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.result.summary, "bridge completed");
    assert.equal(payload.result.output.github.outcome, "pr_opened");
    assert.equal(payload.result.output.github.prUrl, "https://github.com/owner/repo/pull/456");
    assert.equal(payload.result.output.prUrl, "https://github.com/owner/repo/pull/456");
    assert.equal(payload.result.output.branch, "bridge-fixture");
    assert.deepEqual(payload.result.output.tests, ["fake bridge -> pass"]);
    assert.deepEqual(payload.result.output.filesChanged, ["src/example.ts"]);
    assert.equal(payload.result.output.nodeId, "worker-a");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("OpenClaw bridge can be disabled explicitly", () => {
  const result = spawnSync(process.execPath, [handlerPath], {
    input: JSON.stringify(githubTask()),
    encoding: "utf8",
    env: {
      ...process.env,
      A2A_EXECUTOR_MODE: "auto",
      A2A_DOCKER_RUNNER_SCOPE: "plugin-only",
      OPENCLAW_BIN: "/path/that/should/not/run",
      A2A_OPENCLAW_BRIDGE_DISABLED: "1",
    },
  });

  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.error.code, "github_executor_not_configured");
  assert.equal(payload.error.details.bridgeConfigured, false);
});



test("docker runner preserves Start marker URL alongside terminal PR evidence (#354)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "handler-start-marker-354-"));
  const fakeRunnerPath = join(tempDir, "fake-runner.mjs");
  try {
    writeFileSync(fakeRunnerPath, `
import { readFileSync } from "node:fs";
const taskPath = process.argv.at(-1);
const task = JSON.parse(readFileSync(taskPath, "utf8"));
if (!task.prompt.includes("Leave a Start marker")) throw new Error("expected Start marker instruction");
console.log(JSON.stringify({
  ok: true,
  taskId: task.id,
  status: "completed",
  workDir: "/tmp/work-fixture",
  artifacts: [],
  startCommentUrl: "https://github.com/owner/repo/issues/354#issuecomment-start",
  prUrl: "https://github.com/owner/repo/pull/354"
}));
`);

    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(githubTask({ payload: { mode: "github-propose-patch", repo: "owner/repo", issue: "#354" } })),
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_EXECUTOR_MODE: "docker",
        A2A_DOCKER_RUNNER_BIN: process.execPath,
        A2A_DOCKER_RUNNER_ARGS_JSON: JSON.stringify([fakeRunnerPath]),
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.result.output.startCommentUrl, "https://github.com/owner/repo/issues/354#issuecomment-start");
    assert.equal(payload.result.output.github.startCommentUrl, "https://github.com/owner/repo/issues/354#issuecomment-start");
    assert.equal(payload.result.output.prUrl, "https://github.com/owner/repo/pull/354");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("docker runner Start marker alone is not terminal evidence (#354)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "handler-start-only-354-"));
  const fakeRunnerPath = join(tempDir, "fake-runner.mjs");
  try {
    writeFileSync(fakeRunnerPath, `
console.log(JSON.stringify({
  ok: true,
  taskId: "task-fixture-1",
  status: "completed",
  workDir: "/tmp/work-fixture",
  artifacts: [],
  startCommentUrl: "https://github.com/owner/repo/issues/354#issuecomment-start"
}));
`);

    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(githubTask({ payload: { mode: "github-propose-patch", repo: "owner/repo", issue: "#354" } })),
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_EXECUTOR_MODE: "docker",
        A2A_DOCKER_RUNNER_BIN: process.execPath,
        A2A_DOCKER_RUNNER_ARGS_JSON: JSON.stringify([fakeRunnerPath]),
      },
    });

    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.error.code, "docker_runner_evidence_missing");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("docker runner failures surface as handler errors", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "handler-runner-fail-test-"));
  const fakeRunnerPath = join(tempDir, "fake-runner.mjs");
  try {
    writeFileSync(fakeRunnerPath, `
console.log(JSON.stringify({
  ok: false,
  taskId: "task-fixture-1",
  status: "failed",
  error: "runner fixture failed",
  artifacts: []
}));
process.exit(1);
`);

    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(githubTask()),
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_DOCKER_RUNNER_ENABLED: "1",
        A2A_DOCKER_RUNNER_ALL_GITHUB: "1",
        A2A_DOCKER_RUNNER_SCOPE: "all-github",
        A2A_DOCKER_RUNNER_BIN: process.execPath,
        A2A_DOCKER_RUNNER_ARGS_JSON: JSON.stringify([fakeRunnerPath]),
      },
    });

    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.error.code, "docker_runner_failed");
    assert.equal(payload.error.message, "runner fixture failed");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("openclaw-plugin-a2a repo requests map to the plugin runner preset", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "handler-plugin-preset-test-"));
  const fakeRunnerPath = join(tempDir, "fake-runner.mjs");
  try {
    writeFileSync(fakeRunnerPath, `
import { readFileSync } from "node:fs";
const taskPath = process.argv.at(-1);
const task = JSON.parse(readFileSync(taskPath, "utf8"));
if (task.preset !== "openclaw-plugin-a2a-dev") throw new Error("expected plugin preset");
console.log(JSON.stringify({ ok: true, taskId: task.id, status: "completed", workDir: "/tmp/work-fixture", artifacts: [], prUrl: "https://github.com/jinwon-int/openclaw-plugin-a2a/pull/1" }));
`);

    const task = githubTask();
    task.payload.repo = "jinwon-int/openclaw-plugin-a2a";
    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(task),
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_EXECUTOR_MODE: "auto",
        A2A_DOCKER_RUNNER_SCOPE: "plugin-only",
        A2A_DOCKER_RUNNER_BIN: process.execPath,
        A2A_DOCKER_RUNNER_ARGS_JSON: JSON.stringify([fakeRunnerPath]),
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.result.output.runner.status, "completed");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ——— docker-runner contract hardening regression tests (issue #169) ———

test("docker runner timeout surfaces as structured handler error (contract #169)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "handler-timeout-test-"));
  const fakeRunnerPath = join(tempDir, "fake-runner.mjs");
  try {
    writeFileSync(fakeRunnerPath, `
console.log(JSON.stringify({
  ok: false,
  taskId: "task-fixture-1",
  status: "timeout",
  error: "runner timed out after 600s",
  artifacts: []
}));
process.exit(1);
`);

    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(githubTask()),
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_DOCKER_RUNNER_ENABLED: "1",
        A2A_DOCKER_RUNNER_ALL_GITHUB: "1",
        A2A_DOCKER_RUNNER_SCOPE: "all-github",
        A2A_DOCKER_RUNNER_BIN: process.execPath,
        A2A_DOCKER_RUNNER_ARGS_JSON: JSON.stringify([fakeRunnerPath]),
      },
    });

    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.error.code, "docker_runner_timeout");
    assert.match(payload.error.message, /timed out/);
    assert.equal(payload.error.details.exitCode, 1);
    assert.ok(payload.error.details.runnerResult, "should include runner result details");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("github issue-instruction tasks fail closed when no executor evidence path is configured", () => {
  const result = spawnSync(process.execPath, [handlerPath], {
    input: JSON.stringify(githubTask({ payload: { mode: "github-issue-instruction", repo: "owner/repo", issue: "#1" } })),
    encoding: "utf8",
    env: {
      ...process.env,
      A2A_EXECUTOR_MODE: "builtin",
      A2A_DOCKER_RUNNER_ENABLED: "1",
      A2A_DOCKER_RUNNER_ALL_GITHUB: "1",
      A2A_DOCKER_RUNNER_BIN: "/path/that/should/not/run",
    },
  });

  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.error.code, "github_executor_not_configured");
  assert.equal(payload.error.details.executorMode, "builtin");
});

test("github issue-instruction runner success without evidence surfaces as docker_runner_evidence_missing", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "handler-issue-instruction-no-evidence-"));
  const fakeRunnerPath = join(tempDir, "fake-runner.mjs");
  try {
    writeFileSync(fakeRunnerPath, `
import { readFileSync } from "node:fs";
const taskPath = process.argv.at(-1);
const task = JSON.parse(readFileSync(taskPath, "utf8"));
if (task.mode !== "github-issue-instruction") throw new Error("expected github-issue-instruction, got " + task.mode);
console.log(JSON.stringify({
  ok: true,
  taskId: task.id,
  status: "completed",
  workDir: "/tmp/work-fixture",
  artifacts: []
}));
`);

    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(githubTask({ payload: { mode: "github-issue-instruction", repo: "owner/repo", issue: "#1" } })),
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_EXECUTOR_MODE: "docker",
        A2A_DOCKER_RUNNER_BIN: process.execPath,
        A2A_DOCKER_RUNNER_ARGS_JSON: JSON.stringify([fakeRunnerPath]),
      },
    });

    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.error.code, "docker_runner_evidence_missing");
    assert.match(payload.error.message, /docker runner completed but produced no PR\/Done\/Block evidence/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("docker runner failure surfaces OpenClaw bootstrap leak paths when runner reports them", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "handler-bootstrap-leak-test-"));
  const fakeRunnerPath = join(tempDir, "fake-runner.mjs");
  try {
    writeFileSync(fakeRunnerPath, `
import { readFileSync } from "node:fs";
const taskPath = process.argv.at(-1);
const task = JSON.parse(readFileSync(taskPath, "utf8"));
if (!task.prompt.includes("Report the exact repo-relative offending paths")) {
  throw new Error("missing bootstrap leak prompt guard");
}
console.log(JSON.stringify({
  ok: false,
  status: "blocked",
  error: "openclaw_workspace_bootstrap_leak: AGENTS.md .openclaw/workspace-state.json",
  artifacts: ["AGENTS.md", ".openclaw/workspace-state.json"]
}));
`);

    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(githubTask()),
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_DOCKER_RUNNER_ENABLED: "1",
        A2A_DOCKER_RUNNER_ALL_GITHUB: "1",
        A2A_DOCKER_RUNNER_SCOPE: "all-github",
        A2A_DOCKER_RUNNER_BIN: process.execPath,
        A2A_DOCKER_RUNNER_ARGS_JSON: JSON.stringify([fakeRunnerPath]),
      },
    });

    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.error.code, "docker_runner_failed");
    assert.deepEqual(payload.error.details.openclawBootstrapLeakPaths, [
      ".openclaw/workspace-state.json",
      "AGENTS.md",
    ]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("docker runner success without evidence surfaces as docker_runner_evidence_missing (contract #169)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "handler-no-evidence-test-"));
  const fakeRunnerPath = join(tempDir, "fake-runner.mjs");
  try {
    // runner exits 0 and ok=true but has no prUrl / doneCommentUrl / blockCommentUrl
    writeFileSync(fakeRunnerPath, `
import { readFileSync } from "node:fs";
const taskPath = process.argv.at(-1);
const task = JSON.parse(readFileSync(taskPath, "utf8"));
console.log(JSON.stringify({
  ok: true,
  taskId: task.id,
  status: "completed",
  workDir: "/tmp/work-fixture",
  artifacts: ["/tmp/work-fixture/summary.txt"]
}));
`);

    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(githubTask()),
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_DOCKER_RUNNER_ENABLED: "1",
        A2A_DOCKER_RUNNER_ALL_GITHUB: "1",
        A2A_DOCKER_RUNNER_SCOPE: "all-github",
        A2A_DOCKER_RUNNER_BIN: process.execPath,
        A2A_DOCKER_RUNNER_ARGS_JSON: JSON.stringify([fakeRunnerPath]),
      },
    });

    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.error.code, "docker_runner_evidence_missing");
    assert.match(payload.error.message, /docker runner completed but produced no PR\/Done\/Block evidence/);
    assert.deepEqual(payload.error.details.requiredEvidence, ["prUrl", "doneCommentUrl", "blockCommentUrl"]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});


test("github-verify tasks route through docker runner instead of built-in generic success", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "handler-github-verify-test-"));
  const fakeRunnerPath = join(tempDir, "fake-runner.mjs");
  try {
    writeFileSync(fakeRunnerPath, `
import { readFileSync } from "node:fs";
const taskPath = process.argv.at(-1);
const task = JSON.parse(readFileSync(taskPath, "utf8"));
if (process.argv[2] !== "run") throw new Error("expected run subcommand");
if (task.intent !== "verify") throw new Error("expected verify intent propagation");
if (task.mode !== "github-verify") throw new Error("expected github-verify mode propagation");
if (task.repo !== "owner/repo") throw new Error("expected repo mapping");
console.log(JSON.stringify({
  ok: true,
  taskId: task.id,
  status: "completed",
  workDir: "/tmp/work-fixture",
  artifacts: [],
  doneCommentUrl: "https://github.com/owner/repo/issues/1#issuecomment-789"
}));
`);

    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(githubTask({ intent: "verify", payload: { mode: "github-verify", repo: "owner/repo", issue: "#1" } })),
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_DOCKER_RUNNER_ENABLED: "1",
        A2A_DOCKER_RUNNER_ALL_GITHUB: "1",
        A2A_DOCKER_RUNNER_SCOPE: "all-github",
        A2A_DOCKER_RUNNER_BIN: process.execPath,
        A2A_DOCKER_RUNNER_ARGS_JSON: JSON.stringify([fakeRunnerPath]),
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.result.summary, "docker runner completed task-fixture-1");
    assert.equal(payload.result.lifecycle.intent, "verify");
    assert.equal(payload.result.lifecycle.mode, "github-verify");
    assert.equal(payload.result.output.doneCommentUrl, "https://github.com/owner/repo/issues/1#issuecomment-789");
    assert.doesNotMatch(payload.result.summary, /generic github-verify/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("docker broker noop smoke has dedicated non-generic handler evidence", () => {
  const smokeTask = githubTask();
  smokeTask.id = "smoke-task-1";
  smokeTask.intent = "analyze";
  (smokeTask as unknown as { assignedWorkerId: string }).assignedWorkerId = "bangtong";
  smokeTask.payload = {
    schemaVersion: 1,
    mode: "docker-broker-noop-smoke",
    noOp: true,
    runId: "smoke-run-1",
    worker: "bangtong",
  };

  const result = spawnSync(process.execPath, [handlerPath], {
    input: JSON.stringify(smokeTask),
    encoding: "utf8",
    env: {
      ...process.env,
      A2A_DOCKER_RUNNER_ENABLED: "1",
      A2A_DOCKER_RUNNER_ALL_GITHUB: "1",
      A2A_DOCKER_RUNNER_BIN: "/path/that/should/not/run",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.result.summary, "docker broker noop smoke completed smoke-task-1");
  assert.equal(payload.result.lifecycle.mode, "docker-broker-noop-smoke");
  assert.equal(payload.result.output.smoke.ok, true);
  assert.equal(payload.result.output.smoke.runId, "smoke-run-1");
  assert.doesNotMatch(payload.result.summary, /generic .* accepted by versioned OpenClaw A2A handler/);
});

test("evidence-missing check skips non-github tasks on built-in handler path (contract #169)", () => {
  // non-github tasks use the built-in handler path; they complete without evidence.
  const nonGhTask = githubTask();
  nonGhTask.payload.mode = "analysis";
  nonGhTask.intent = "analyze";

  const result = spawnSync(process.execPath, [handlerPath], {
    input: JSON.stringify(nonGhTask),
    encoding: "utf8",
    env: {
      ...process.env,
      A2A_DOCKER_RUNNER_ENABLED: "1",
      A2A_DOCKER_RUNNER_ALL_GITHUB: "1",
      A2A_DOCKER_RUNNER_BIN: "/path/that/should/not/run",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.ok(payload.result, "non-github tasks should succeed via built-in handler");
  // built-in handler summary confirms no runner was invoked (and no evidence check)
  assert.match(payload.result.summary, /accepted by versioned OpenClaw A2A handler/);
});

test("docker runner prUrl output passes validateTaskCompletionEvidence (contract #169 regression)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "handler-vtce-pr-"));
  const fakeRunnerPath = join(tempDir, "fake-runner.mjs");
  try {
    writeFileSync(fakeRunnerPath, `
import { readFileSync } from "node:fs";
const taskPath = process.argv.at(-1);
const task = JSON.parse(readFileSync(taskPath, "utf8"));
console.log(JSON.stringify({
  ok: true,
  taskId: task.id,
  status: "completed",
  workDir: "/tmp/work-fixture",
  artifacts: [],
  prUrl: "https://github.com/owner/repo/pull/123"
}));
`);

    const task = githubTask();
    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(task),
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_DOCKER_RUNNER_ENABLED: "1",
        A2A_DOCKER_RUNNER_ALL_GITHUB: "1",
        A2A_DOCKER_RUNNER_SCOPE: "all-github",
        A2A_DOCKER_RUNNER_BIN: process.execPath,
        A2A_DOCKER_RUNNER_ARGS_JSON: JSON.stringify([fakeRunnerPath]),
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.result.output.prUrl, "https://github.com/owner/repo/pull/123");
    assert.equal(payload.result.output.github.prUrl, "https://github.com/owner/repo/pull/123");

    // regression: validateTaskCompletionEvidence must accept this output
    const evidenceError = validateTaskCompletionEvidence(
      makeTaskRecord(task),
      payload.result,
    );
    assert.equal(evidenceError, null, `should not reject prUrl evidence: ${JSON.stringify(evidenceError)}`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("docker runner doneCommentUrl output passes validateTaskCompletionEvidence (contract #169 regression)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "handler-vtce-done-"));
  const fakeRunnerPath = join(tempDir, "fake-runner.mjs");
  try {
    writeFileSync(fakeRunnerPath, `
import { readFileSync } from "node:fs";
const taskPath = process.argv.at(-1);
const task = JSON.parse(readFileSync(taskPath, "utf8"));
console.log(JSON.stringify({
  ok: true,
  taskId: task.id,
  status: "completed",
  workDir: "/tmp/work-fixture",
  artifacts: [],
  github: { doneCommentUrl: "https://github.com/owner/repo/issues/1#issuecomment-123" }
}));
`);

    const task = githubTask();
    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(task),
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_DOCKER_RUNNER_ENABLED: "1",
        A2A_DOCKER_RUNNER_ALL_GITHUB: "1",
        A2A_DOCKER_RUNNER_SCOPE: "all-github",
        A2A_DOCKER_RUNNER_BIN: process.execPath,
        A2A_DOCKER_RUNNER_ARGS_JSON: JSON.stringify([fakeRunnerPath]),
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.result.output.doneCommentUrl, "https://github.com/owner/repo/issues/1#issuecomment-123");
    assert.equal(payload.result.output.github.doneCommentUrl, "https://github.com/owner/repo/issues/1#issuecomment-123");

    // regression: validateTaskCompletionEvidence must accept doneCommentUrl evidence
    const evidenceError = validateTaskCompletionEvidence(
      makeTaskRecord(task),
      payload.result,
    );
    assert.equal(evidenceError, null, `should not reject doneCommentUrl evidence: ${JSON.stringify(evidenceError)}`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("docker runner blockCommentUrl output passes validateTaskCompletionEvidence (contract #169 regression)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "handler-vtce-block-"));
  const fakeRunnerPath = join(tempDir, "fake-runner.mjs");
  try {
    writeFileSync(fakeRunnerPath, `
import { readFileSync } from "node:fs";
const taskPath = process.argv.at(-1);
const task = JSON.parse(readFileSync(taskPath, "utf8"));
console.log(JSON.stringify({
  ok: true,
  taskId: task.id,
  status: "completed",
  workDir: "/tmp/work-fixture",
  artifacts: [],
  blockCommentUrl: "https://github.com/owner/repo/issues/1#issuecomment-456"
}));
`);

    const task = githubTask();
    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(task),
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_DOCKER_RUNNER_ENABLED: "1",
        A2A_DOCKER_RUNNER_ALL_GITHUB: "1",
        A2A_DOCKER_RUNNER_SCOPE: "all-github",
        A2A_DOCKER_RUNNER_BIN: process.execPath,
        A2A_DOCKER_RUNNER_ARGS_JSON: JSON.stringify([fakeRunnerPath]),
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.result.output.blockCommentUrl, "https://github.com/owner/repo/issues/1#issuecomment-456");
    assert.equal(payload.result.output.github.blockCommentUrl, "https://github.com/owner/repo/issues/1#issuecomment-456");

    // regression: validateTaskCompletionEvidence must accept blockCommentUrl evidence
    const evidenceError = validateTaskCompletionEvidence(
      makeTaskRecord(task),
      payload.result,
    );
    assert.equal(evidenceError, null, `should not reject blockCommentUrl evidence: ${JSON.stringify(evidenceError)}`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("docker runner evidence-missing fails validateTaskCompletionEvidence (contract #169 regression)", () => {
  // Evidence-missing error from handler already maps to handler error,
  // but verify directly that an empty runner-style result also fails the gate
  const task = githubTask();
  const emptyResult = {
    summary: "completed with no evidence",
    handler: { name: "openclaw-a2a-task-handler", version: "0.2.2" },
    lifecycle: {
      intent: task.intent,
      mode: task.payload.mode,
      taskId: task.id,
    },
    output: {
      runner: { status: "completed", artifacts: [] },
    },
  };

  const evidenceError = validateTaskCompletionEvidence(makeTaskRecord(task), emptyResult);
  assert.ok(evidenceError, "should reject empty result from github-propose-patch task");
  assert.equal(evidenceError!.code, "github_completion_evidence_missing");
});

test("docker runner with multi-evidence output maps all URLs correctly (contract #169)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "handler-multi-evidence-"));
  const fakeRunnerPath = join(tempDir, "fake-runner.mjs");
  try {
    writeFileSync(fakeRunnerPath, `
import { readFileSync } from "node:fs";
const taskPath = process.argv.at(-1);
const task = JSON.parse(readFileSync(taskPath, "utf8"));
console.log(JSON.stringify({
  ok: true,
  taskId: task.id,
  status: "completed",
  workDir: "/tmp/work-fixture",
  artifacts: ["/tmp/work-fixture/summary.txt"],
  prUrl: "https://github.com/owner/repo/pull/10",
  doneCommentUrl: "https://github.com/owner/repo/issues/1#issuecomment-10",
  blockCommentUrl: "https://github.com/owner/repo/issues/1#issuecomment-11"
}));
`);

    const task = githubTask();
    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(task),
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_DOCKER_RUNNER_ENABLED: "1",
        A2A_DOCKER_RUNNER_ALL_GITHUB: "1",
        A2A_DOCKER_RUNNER_SCOPE: "all-github",
        A2A_DOCKER_RUNNER_BIN: process.execPath,
        A2A_DOCKER_RUNNER_ARGS_JSON: JSON.stringify([fakeRunnerPath]),
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.result.output.prUrl, "https://github.com/owner/repo/pull/10");
    assert.equal(payload.result.output.doneCommentUrl, "https://github.com/owner/repo/issues/1#issuecomment-10");
    assert.equal(payload.result.output.blockCommentUrl, "https://github.com/owner/repo/issues/1#issuecomment-11");
    assert.equal(payload.result.output.github.prUrl, "https://github.com/owner/repo/pull/10");
    assert.equal(payload.result.output.github.doneCommentUrl, "https://github.com/owner/repo/issues/1#issuecomment-10");
    assert.equal(payload.result.output.github.blockCommentUrl, "https://github.com/owner/repo/issues/1#issuecomment-11");

    const evidenceError = validateTaskCompletionEvidence(
      makeTaskRecord(task),
      payload.result,
    );
    assert.equal(evidenceError, null, `multi-evidence should pass gate: ${JSON.stringify(evidenceError)}`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ——— OpenClaw bridge watchdog and final-evidence safeguards (issue #193) ———

test("OpenClaw bridge SIGKILL surfaces as openclaw_bridge_timeout (issue #193 watchdog)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "handler-bridge-kill-193-"));
  const fakeBridgePath = join(tempDir, "fake-openclaw-kill.mjs");
  try {
    writeFileSync(fakeBridgePath, `#!/usr/bin/env node
process.kill(process.pid, "SIGKILL");
`);
    chmodSync(fakeBridgePath, 0o755);

    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(githubTask()),
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_EXECUTOR_MODE: "auto",
        A2A_DOCKER_RUNNER_SCOPE: "plugin-only",
        OPENCLAW_BIN: fakeBridgePath,
      },
    });

    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.error.code, "openclaw_bridge_timeout");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("OpenClaw bridge watchdog ETIMEDOUT surfaces as openclaw_bridge_timeout (issue #193 watchdog)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "handler-bridge-watchdog-193-"));
  const fakeBridgePath = join(tempDir, "fake-openclaw-hang.mjs");
  try {
    writeFileSync(fakeBridgePath, `#!/usr/bin/env node
// keeps event loop alive so the watchdog must kill it
setTimeout(() => {}, 99999999);
`);
    chmodSync(fakeBridgePath, 0o755);

    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(githubTask()),
      encoding: "utf8",
      timeout: 10000,
      env: {
        ...process.env,
        A2A_EXECUTOR_MODE: "auto",
        A2A_DOCKER_RUNNER_SCOPE: "plugin-only",
        OPENCLAW_BIN: fakeBridgePath,
        A2A_OPENCLAW_WATCHDOG_MS: "1500",
      },
    });

    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.error.code, "openclaw_bridge_timeout");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("OpenClaw bridge empty output surfaces as openclaw_bridge_no_final_json (issue #193)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "handler-bridge-nojson-193-"));
  const fakeBridgePath = join(tempDir, "fake-openclaw-empty.mjs");
  try {
    writeFileSync(fakeBridgePath, `#!/usr/bin/env node
process.stderr.write("bridge ran but produced no JSON output\\n");
`);
    chmodSync(fakeBridgePath, 0o755);

    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(githubTask()),
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_EXECUTOR_MODE: "auto",
        A2A_DOCKER_RUNNER_SCOPE: "plugin-only",
        OPENCLAW_BIN: fakeBridgePath,
      },
    });

    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.error.code, "openclaw_bridge_no_final_json");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("OpenClaw bridge text-only output (no JSON) surfaces as openclaw_bridge_no_final_json (issue #193)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "handler-bridge-textonly-193-"));
  const fakeBridgePath = join(tempDir, "fake-openclaw-textonly.mjs");
  try {
    writeFileSync(fakeBridgePath, `#!/usr/bin/env node
// envelope parses but inner text has no JSON
console.log(JSON.stringify({ payloads: [{ text: "I worked on it but could not finish. No structured result available." }] }));
`);
    chmodSync(fakeBridgePath, 0o755);

    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(githubTask()),
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_EXECUTOR_MODE: "auto",
        A2A_DOCKER_RUNNER_SCOPE: "plugin-only",
        OPENCLAW_BIN: fakeBridgePath,
      },
    });

    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.error.code, "openclaw_bridge_no_final_json");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("OpenClaw bridge JSON without evidence URLs surfaces as openclaw_bridge_evidence_missing (issue #193)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "handler-bridge-noevidence-193-"));
  const fakeBridgePath = join(tempDir, "fake-openclaw-noevidence.mjs");
  try {
    writeFileSync(fakeBridgePath, `#!/usr/bin/env node
// valid JSON in the response but no prUrl/doneCommentUrl/blockCommentUrl
console.log(JSON.stringify({ payloads: [{ text: JSON.stringify({ status: "done", summary: "work completed" }) }] }));
`);
    chmodSync(fakeBridgePath, 0o755);

    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(githubTask()),
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_EXECUTOR_MODE: "auto",
        A2A_DOCKER_RUNNER_SCOPE: "plugin-only",
        OPENCLAW_BIN: fakeBridgePath,
      },
    });

    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.error.code, "openclaw_bridge_evidence_missing");
    assert.match(payload.error.message, /prUrl|doneCommentUrl|blockCommentUrl/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ——— docker-first readiness guard (issue #189) ———

test("A2A_EXECUTOR_MODE=docker without A2A_DOCKER_RUNNER_BIN returns docker_runner_not_configured (#189 readiness)", () => {
  const result = spawnSync(process.execPath, [handlerPath], {
    input: JSON.stringify(githubTask()),
    encoding: "utf8",
    env: {
      ...process.env,
      A2A_EXECUTOR_MODE: "docker",
      A2A_DOCKER_RUNNER_BIN: "",
    },
  });

  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.error.code, "docker_runner_not_configured");
  assert.equal(payload.error.details.executorMode, "docker");
  assert.deepEqual(payload.error.details.requiredEnv, ["A2A_DOCKER_RUNNER_BIN"]);
  assert.match(payload.error.message, /A2A_DOCKER_RUNNER_BIN/);
});

test("SCOPE=all-github without A2A_DOCKER_RUNNER_BIN returns docker_runner_not_configured (#189 readiness)", () => {
  const result = spawnSync(process.execPath, [handlerPath], {
    input: JSON.stringify(githubTask()),
    encoding: "utf8",
    env: {
      ...process.env,
      A2A_EXECUTOR_MODE: "auto",
      A2A_DOCKER_RUNNER_SCOPE: "all-github",
      A2A_DOCKER_RUNNER_BIN: "",
    },
  });

  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.error.code, "docker_runner_not_configured");
  assert.equal(payload.error.details.executorMode, "auto");
  assert.equal(payload.error.details.dockerScope, "all-github");
  assert.deepEqual(payload.error.details.requiredEnv, ["A2A_DOCKER_RUNNER_BIN"]);
});

// ——— docker-runner evidence metadata projection (issue #196) ———

test("docker runner output preserves repo/issue/issueUrl/nodeId/taskId trace fields (issue #196)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "handler-trace-fields-196-"));
  const fakeRunnerPath = join(tempDir, "fake-runner.mjs");
  try {
    writeFileSync(fakeRunnerPath, `
import { readFileSync } from "node:fs";
const taskPath = process.argv.at(-1);
const task = JSON.parse(readFileSync(taskPath, "utf8"));
console.log(JSON.stringify({
  ok: true,
  taskId: task.id,
  status: "completed",
  workDir: "/tmp/work-fixture",
  artifacts: [],
  prUrl: "https://github.com/owner/repo/pull/196",
  branch: "fix/issue-196",
  tests: ["npm test -- --testNamePattern handler -> pass"],
  filesChanged: ["scripts/openclaw-a2a-task-handler.mjs"],
  risks: ["minor: version bump required"]
}));
`);

    const task = githubTask({
      payload: {
        mode: "github-propose-patch",
        repo: "owner/repo",
        issue: "#196",
        issueUrl: "https://github.com/owner/repo/issues/196",
      },
    });
    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(task),
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_EXECUTOR_MODE: "docker",
        A2A_DOCKER_RUNNER_BIN: process.execPath,
        A2A_DOCKER_RUNNER_ARGS_JSON: JSON.stringify([fakeRunnerPath]),
        A2A_NODE_ID: "dungae-node",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.result.output.repo, "owner/repo", "repo must be in output");
    assert.equal(payload.result.output.issue, "#196", "issue must be in output");
    assert.equal(payload.result.output.issueUrl, "https://github.com/owner/repo/issues/196", "issueUrl must be in output");
    assert.equal(payload.result.output.nodeId, "dungae-node", "nodeId must be in output");
    assert.equal(payload.result.output.taskId, "task-fixture-1", "taskId must be in output");
    assert.equal(payload.result.output.branch, "fix/issue-196", "branch must be projected from runner response");
    assert.deepEqual(payload.result.output.tests, ["npm test -- --testNamePattern handler -> pass"], "tests must be projected");
    assert.deepEqual(payload.result.output.filesChanged, ["scripts/openclaw-a2a-task-handler.mjs"], "filesChanged must be projected");
    assert.deepEqual(payload.result.output.risks, ["minor: version bump required"], "risks must be projected");
    assert.equal(payload.result.output.prUrl, "https://github.com/owner/repo/pull/196");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("docker runner output nodeId falls back to unknown-node when no node env is set (issue #196)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "handler-nodeid-fallback-196-"));
  const fakeRunnerPath = join(tempDir, "fake-runner.mjs");
  try {
    writeFileSync(fakeRunnerPath, `
console.log(JSON.stringify({ ok: true, taskId: "task-fixture-1", status: "completed", workDir: "/tmp/work", artifacts: [], prUrl: "https://github.com/owner/repo/pull/1" }));
`);

    const env = { ...process.env };
    delete env.A2A_NODE_ID;
    delete env.NODE_ID;
    delete env.WORKER_ID;
    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(githubTask()),
      encoding: "utf8",
      env: {
        ...env,
        A2A_EXECUTOR_MODE: "docker",
        A2A_DOCKER_RUNNER_BIN: process.execPath,
        A2A_DOCKER_RUNNER_ARGS_JSON: JSON.stringify([fakeRunnerPath]),
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.result.output.nodeId, "unknown-node", "nodeId should fall back to unknown-node");
    assert.equal(payload.result.output.taskId, "task-fixture-1", "taskId must be preserved");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("plugin-only scope with unconfigured A2A_DOCKER_RUNNER_BIN does not trigger readiness guard for plugin repo (#189)", () => {
  // plugin-only is NOT a docker-first mandate — the guard should not fire;
  // the runner spawn error (or success) is handled inside runDockerRunner as before.
  const tempDir = mkdtempSync(join(tmpdir(), "handler-plugin-readiness-189-"));
  const fakeRunnerPath = join(tempDir, "fake-runner.mjs");
  try {
    writeFileSync(fakeRunnerPath, `
import { readFileSync } from "node:fs";
const taskPath = process.argv.at(-1);
const task = JSON.parse(readFileSync(taskPath, "utf8"));
if (task.preset !== "openclaw-plugin-a2a-dev") throw new Error("expected plugin preset");
console.log(JSON.stringify({ ok: true, taskId: task.id, status: "completed", workDir: "/tmp/work-fixture", artifacts: [], prUrl: "https://github.com/jinon86/openclaw-plugin-a2a/pull/2" }));
`);

    const task = githubTask();
    task.payload.repo = "jinon86/openclaw-plugin-a2a";
    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(task),
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_EXECUTOR_MODE: "auto",
        A2A_DOCKER_RUNNER_SCOPE: "plugin-only",
        A2A_DOCKER_RUNNER_BIN: process.execPath,
        A2A_DOCKER_RUNNER_ARGS_JSON: JSON.stringify([fakeRunnerPath]),
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.result.output.github.prUrl, "https://github.com/jinon86/openclaw-plugin-a2a/pull/2");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
