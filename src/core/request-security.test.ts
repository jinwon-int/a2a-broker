import assert from "node:assert/strict";
import test from "node:test";
import type { IncomingMessage } from "node:http";

import { extractRequesterIdentity, rateLimitKey } from "./request-security.js";

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

test("extractRequesterIdentity parses requester scopes from headers", () => {
  const request = createRequest({
    headers: {
      "x-a2a-requester-id": "worker-a",
      "x-a2a-requester-scopes": "z.scope,a2a.peer.status.verbose z.scope",
    },
  });

  assert.deepEqual(extractRequesterIdentity(request), {
    id: "worker-a",
    scopes: ["a2a.peer.status.verbose", "z.scope"],
  });
});

test("extractRequesterIdentity rejects scopes headers without requester id", () => {
  const request = createRequest({
    headers: {
      "x-a2a-requester-scopes": "a2a.peer.status.verbose",
    },
  });

  assert.throws(
    () => extractRequesterIdentity(request),
    /x-a2a-requester-id is required/,
  );
});
