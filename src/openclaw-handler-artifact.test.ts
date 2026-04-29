import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const handlerPath = "scripts/openclaw-a2a-task-handler.mjs";

test("versioned OpenClaw handler exposes credential-free build metadata", () => {
  const task = {
    id: "task-fixture-1",
    intent: "propose_patch",
    message: "generic chat/proposal lifecycle fixture",
    payload: { mode: "github-propose-patch", repo: "owner/repo", issue: "#1" },
    proposalId: "proposal-fixture-1",
    exchangeId: "exchange-fixture-1",
  };

  const result = spawnSync(process.execPath, [handlerPath], {
    input: JSON.stringify(task),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.result.handler.name, "openclaw-a2a-task-handler");
  assert.equal(payload.result.handler.version, "0.1.0");
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
