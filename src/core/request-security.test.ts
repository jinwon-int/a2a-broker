import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import test from "node:test";

import { classifyRateLimitBucket } from "./request-security.js";

function createRequest(method: string, headers: Record<string, string> = {}): IncomingMessage {
  return {
    method,
    headers,
    socket: { remoteAddress: "127.0.0.1" },
  } as IncomingMessage;
}

test("matching assignedWorkerId task polls use the worker rate limit bucket", () => {
  const bucket = classifyRateLimitBucket(
    createRequest("GET", { "x-a2a-requester-id": "worker-a" }),
    new URL("http://broker.test/tasks?assignedWorkerId=worker-a&status=queued"),
  );

  assert.equal(bucket, "worker");
});

test("mismatched assignedWorkerId task polls stay on the general rate limit bucket", () => {
  const bucket = classifyRateLimitBucket(
    createRequest("GET", { "x-a2a-requester-id": "hub-a" }),
    new URL("http://broker.test/tasks?assignedWorkerId=worker-a&status=queued"),
  );

  assert.equal(bucket, "general");
});
