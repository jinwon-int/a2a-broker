import test from "node:test";
import assert from "node:assert/strict";

import {
  containsOpenClawRuntimeTextPath,
  findOpenClawRuntimePaths,
  assertNoOpenClawRuntimePaths,
} from "./openclaw-runtime-path-guard.js";

test("containsOpenClawRuntimeTextPath detects AGENTS.md", () => {
  assert.equal(containsOpenClawRuntimeTextPath("see AGENTS.md for context"), true);
});

test("containsOpenClawRuntimeTextPath detects .openclaw/ paths", () => {
  assert.equal(containsOpenClawRuntimeTextPath("file: .openclaw/state.json"), true);
});

test("containsOpenClawRuntimeTextPath rejects clean text", () => {
  assert.equal(containsOpenClawRuntimeTextPath("worker completed safely"), false);
});

test("containsOpenClawRuntimeTextPath rejects empty string", () => {
  assert.equal(containsOpenClawRuntimeTextPath(""), false);
});

test("findOpenClawRuntimePaths collects all offending paths from a string", () => {
  const paths = findOpenClawRuntimePaths(
    "includes AGENTS.md and .openclaw/workspace-state.json and SOUL.md",
  );
  assert.deepEqual(paths, [".openclaw/workspace-state.json", "AGENTS.md", "SOUL.md"]);
});

test("findOpenClawRuntimePaths visits nested object keys and values", () => {
  const paths = findOpenClawRuntimePaths({
    summary: "check USER.md",
    taskBrief: "see HEARTBEAT.md",
    metadata: {
      context: "in .openclaw/cache.json",
    },
  });
  assert.deepEqual(paths, [".openclaw/cache.json", "HEARTBEAT.md", "USER.md"]);
});

test("findOpenClawRuntimePaths collects from arrays", () => {
  const paths = findOpenClawRuntimePaths([
    "reference TOOLS.md",
    { note: "has SOUL.md data" },
  ]);
  assert.deepEqual(paths, ["SOUL.md", "TOOLS.md"]);
});

test("assertNoOpenClawRuntimePaths throws for unsafe content", () => {
  assert.throws(
    () => assertNoOpenClawRuntimePaths({ output: "see USER.md" }),
    { message: /refusing to project OpenClaw runtime\/bootstrap paths/ },
  );
});

test("assertNoOpenClawRuntimePaths passes for clean content", () => {
  assert.doesNotThrow(() => assertNoOpenClawRuntimePaths({ output: "worker completed safely" }));
});
