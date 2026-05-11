import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const REPO_ROOT = process.cwd();
const CONFIG_SOURCE_FILES = ["src/server.ts", "src/worker.ts"];

function readRepoFile(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

function extractEnvVars(source: string): Set<string> {
  const names = new Set<string>();
  const dotAccessPatterns = [/\bprocess\.env\.([A-Z][A-Z0-9_]*)\b/g, /\benv\.([A-Z][A-Z0-9_]*)\b/g];
  for (const pattern of dotAccessPatterns) {
    for (const match of source.matchAll(pattern)) {
      names.add(match[1]!);
    }
  }

  // requiredEnv(env, ["BROKER_URL", "A2A_BROKER_URL"]) keeps names as string literals
  // instead of env.FOO property accesses, so include those arrays in the alignment audit.
  for (const match of source.matchAll(/requiredEnv\(\s*env\s*,\s*\[([\s\S]*?)\]/g)) {
    const requiredEnvArgs = match[1]!;
    for (const literal of requiredEnvArgs.matchAll(/["']([A-Z][A-Z0-9_]*)["']/g)) {
      names.add(literal[1]!);
    }
  }

  return names;
}

test("broker and worker env config fields stay registered in .env.example", () => {
  const example = readRepoFile(".env.example");
  const sourceEnvVars = new Set<string>();

  for (const file of CONFIG_SOURCE_FILES) {
    for (const name of extractEnvVars(readRepoFile(file))) {
      sourceEnvVars.add(name);
    }
  }

  const missing = [...sourceEnvVars]
    .filter((name) => !new RegExp(`(^|\\n)\\s*${name}=`, "m").test(example))
    .sort();

  assert.deepEqual(missing, [], `missing env config fields in .env.example: ${missing.join(", ")}`);
});
