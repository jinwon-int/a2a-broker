import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { validateTaskCompletionEvidence } from "./worker.js";
import type { TaskRecord } from "./core/types.js";

const handlerPath = "scripts/openclaw-a2a-task-handler.mjs";

interface GithubTaskFixture {
  id: string;
  intent: "propose_patch" | "analyze";
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
    intent: task.intent,
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

test("feature flag alone keeps non-plugin GitHub tasks on the built-in path", () => {
  const result = spawnSync(process.execPath, [handlerPath], {
    input: JSON.stringify(githubTask()),
    encoding: "utf8",
    env: {
      ...process.env,
      A2A_DOCKER_RUNNER_ENABLED: "1",
      A2A_DOCKER_RUNNER_BIN: "/path/that/should/not/run",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.result.summary, "generic patch proposal task accepted by versioned OpenClaw A2A handler");
  assert.equal(payload.result.lifecycle.mode, "github-propose-patch");
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
console.log(JSON.stringify({ ok: true, taskId: task.id, status: "completed", workDir: "/tmp/work-fixture", artifacts: [], prUrl: "https://github.com/jinon86/openclaw-plugin-a2a/pull/1" }));
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
    handler: { name: "openclaw-a2a-task-handler", version: "0.2.0" },
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
