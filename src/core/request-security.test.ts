import assert from "node:assert/strict";
import test from "node:test";
import type { IncomingMessage } from "node:http";

import { rateLimitKey } from "./request-security.js";

function createRequest(params: {
  headers?: Record<string, string>;
  remoteAddress?: string;
} = {}): IncomingMessage {
  return {
    headers: params.headers ?? {},
    socket: {
      remoteAddress: params.remoteAddress ?? "127.0.0.1",
    },
  } as IncomingMessage;
}

test("rateLimitKey ignores x-forwarded-for unless trusted proxy mode is enabled", () => {
  const request = createRequest({
    headers: {
      "x-forwarded-for": "203.0.113.10, 10.0.0.2",
    },
    remoteAddress: "10.0.0.2",
  });

  assert.equal(rateLimitKey(request, null), "ip:10.0.0.2");
  assert.equal(rateLimitKey(request, null, { trustedProxy: true }), "ip:203.0.113.10");
});

test("rateLimitKey always prefers requester identity over proxy headers", () => {
  const request = createRequest({
    headers: {
      "x-forwarded-for": "203.0.113.10",
    },
    remoteAddress: "10.0.0.2",
  });

  assert.equal(
    rateLimitKey(
      request,
      {
        id: "worker-a",
      },
      { trustedProxy: true },
    ),
    "requester:worker-a",
  );
});
