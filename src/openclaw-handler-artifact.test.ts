import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const handlerPath = "scripts/openclaw-a2a-task-handler.mjs";

function githubTask() {
  return {
    id: "task-fixture-1",
    intent: "propose_patch",
    message: "generic chat/proposal lifecycle fixture",
    payload: { mode: "github-propose-patch", repo: "owner/repo", issue: "#1" },
    proposalId: "proposal-fixture-1",
    exchangeId: "exchange-fixture-1",
  };
}

test("versioned OpenClaw handler exposes credential-free build metadata", () => {
  const result = spawnSync(process.execPath, [handlerPath], {
    input: JSON.stringify(githubTask()),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.result.handler.name, "openclaw-a2a-task-handler");
  assert.equal(payload.result.handler.version, "0.2.0");
  assert.match(payload.result.handler.sourceSha256, /^[a-f0-9]{64}$/);
  assert.equal(payload.result.handler.credentialFree, true);
  assert.equal(payload.result.handler.hostNeutral, true);
  assert.equal(payload.result.lifecycle.mode, "github-propose-patch");
});

test("versioned OpenClaw handler source does not embed credentials or host paths", () => {
  const source = readFileSync(handlerPath, "utf8");
  assert.doesNotMatch(source, /(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|refresh_token)/i);
  assert.doesNotMatch(source, /\/root\//);
  assert.doesNotMatch(source, /bangtong|dungae|sogyo|yukson/i);
});

test("feature flag routes GitHub propose_patch tasks through docker runner", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "handler-runner-test-"));
  const fakeRunnerPath = join(tempDir, "fake-runner.mjs");
  try {
    writeFileSync(fakeRunnerPath, `
import { readFileSync } from "node:fs";
const taskPath = process.argv.at(-1);
const task = JSON.parse(readFileSync(taskPath, "utf8"));
if (process.argv[2] !== "run") throw new Error("expected run subcommand");
if (task.repo !== "owner/repo") throw new Error("expected repo mapping");
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

    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(githubTask()),
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_DOCKER_RUNNER_ENABLED: "1",
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
console.log(JSON.stringify({ ok: true, taskId: task.id, status: "completed", workDir: "/tmp/work-fixture", artifacts: [] }));
`);

    const task = githubTask();
    task.payload.repo = "jinon86/openclaw-plugin-a2a";
    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(task),
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_DOCKER_RUNNER_ENABLED: "1",
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
