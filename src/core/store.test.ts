import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CURRENT_BROKER_STATE_VERSION,
  JsonFileBrokerStateStore,
  emptySnapshot,
} from "./store.js";

function withTempFile(name: string): {
  dir: string;
  filePath: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-store-"));
  return {
    dir,
    filePath: join(dir, name),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("JsonFileBrokerStateStore loads backward-compatible empty objects", () => {
  const temp = withTempFile("state.json");
  try {
    writeFileSync(temp.filePath, "{}", "utf8");

    const store = new JsonFileBrokerStateStore(temp.filePath);
    assert.deepEqual(store.load(), emptySnapshot());
  } finally {
    temp.cleanup();
  }
});

test("JsonFileBrokerStateStore rejects oversized snapshots", () => {
  const temp = withTempFile("large-state.json");
  try {
    writeFileSync(
      temp.filePath,
      JSON.stringify({
        version: CURRENT_BROKER_STATE_VERSION,
        exchanges: [],
        exchangeMessages: [],
        proposals: [],
        artifacts: [],
        validations: [],
        auditEvents: [],
        workers: [],
        tasks: [],
        padding: "x".repeat(1_024),
      }),
      "utf8",
    );

    const store = new JsonFileBrokerStateStore(temp.filePath, { maxBytes: 128 });
    assert.throws(() => store.load(), /broker snapshot exceeds max size/);
  } finally {
    temp.cleanup();
  }
});

test("JsonFileBrokerStateStore rejects malformed snapshot entries", () => {
  const temp = withTempFile("invalid-state.json");
  try {
    writeFileSync(
      temp.filePath,
      JSON.stringify({
        version: CURRENT_BROKER_STATE_VERSION,
        exchanges: [{ id: 123 }],
      }),
      "utf8",
    );

    const store = new JsonFileBrokerStateStore(temp.filePath);
    assert.throws(() => store.load(), /invalid broker snapshot/);
  } finally {
    temp.cleanup();
  }
});
