import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { BrokerError } from "./broker.js";
import type { A2APartyKind, A2APartyRole, ChangeProposal } from "./types.js";

export interface RequesterIdentity {
  id: string;
  kind?: A2APartyKind;
  role?: A2APartyRole;
}

export type RateLimitBucket = "general" | "worker";

export interface RateLimitDecision {
  key: string;
  limit: number;
  remaining: number;
  resetAtMs: number;
  retryAfterSec: number;
  allowed: boolean;
}

export class InMemoryRateLimiter {
  private readonly buckets = new Map<string, number[]>();

  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number,
  ) {}

  check(key: string, nowMs = Date.now()): RateLimitDecision {
    const windowStart = nowMs - this.windowMs;
    const timestamps = (this.buckets.get(key) ?? []).filter((value) => value > windowStart);
    const allowed = timestamps.length < this.maxRequests;

    if (allowed) {
      timestamps.push(nowMs);
    }

    this.buckets.set(key, timestamps);

    const earliest = timestamps[0] ?? nowMs;
    const resetAtMs = earliest + this.windowMs;
    const retryAfterSec = Math.max(1, Math.ceil((resetAtMs - nowMs) / 1000));

    return {
      key,
      limit: this.maxRequests,
      remaining: Math.max(0, this.maxRequests - timestamps.length),
      resetAtMs,
      retryAfterSec,
      allowed,
    };
  }
}

export function extractRequesterIdentity(req: IncomingMessage): RequesterIdentity | null {
  const id = headerValue(req, "x-a2a-requester-id");
  if (!id) {
    return null;
  }

  return {
    id,
    kind: headerValue(req, "x-a2a-requester-kind") as A2APartyKind | undefined,
    role: headerValue(req, "x-a2a-requester-role") as A2APartyRole | undefined,
  };
}

export function rateLimitKey(req: IncomingMessage, identity: RequesterIdentity | null): string {
  if (identity?.id) {
    return `requester:${identity.id}`;
  }

  const forwarded = headerValue(req, "x-forwarded-for");
  const remoteAddress = forwarded?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
  return `ip:${remoteAddress}`;
}

export function applyRateLimitHeaders(
  res: ServerResponse<IncomingMessage>,
  decision: RateLimitDecision,
  bucket: RateLimitBucket,
): void {
  res.setHeader("x-a2a-ratelimit-bucket", bucket);
  res.setHeader("x-ratelimit-limit", String(decision.limit));
  res.setHeader("x-ratelimit-remaining", String(decision.remaining));
  res.setHeader("x-ratelimit-reset", String(Math.floor(decision.resetAtMs / 1000)));
}

export function assertEdgeSecret(
  req: IncomingMessage,
  expectedSecret: string | undefined,
): void {
  if (!expectedSecret) {
    return;
  }

  const providedSecret = headerValue(req, "x-a2a-edge-secret");
  if (providedSecret && secretsMatch(providedSecret, expectedSecret)) {
    return;
  }

  throw new BrokerError(
    "unauthorized",
    "x-a2a-edge-secret is required for this route",
  );
}

export function classifyRateLimitBucket(req: IncomingMessage, url: URL): RateLimitBucket {
  const path = url.pathname;
  const segments = path.split("/").filter(Boolean);

  if (req.method === "POST" && path === "/workers/register") {
    return "worker";
  }

  if (req.method === "POST" && segments[0] === "workers" && segments[1] && segments[2] === "heartbeat") {
    return "worker";
  }

  if (
    req.method === "POST" &&
    segments[0] === "tasks" &&
    segments[1] &&
    ["claim", "start", "complete", "fail"].includes(segments[2] ?? "")
  ) {
    return "worker";
  }

  const assignedWorkerId = url.searchParams.get("assignedWorkerId")?.trim();
  const requesterId = headerValue(req, "x-a2a-requester-id");
  if (
    req.method === "GET" &&
    path === "/tasks" &&
    assignedWorkerId &&
    requesterId === assignedWorkerId
  ) {
    return "worker";
  }

  return "general";
}

export function requireRequesterIdentity(identity: RequesterIdentity | null): RequesterIdentity {
  if (!identity?.id) {
    throw new BrokerError(
      "unauthorized",
      "x-a2a-requester-id is required for this route",
    );
  }

  return identity;
}

export function assertRequesterMatchesParty(
  identity: RequesterIdentity | null,
  expected: { id: string; role?: A2APartyRole },
  context: string,
): void {
  const requester = requireRequesterIdentity(identity);

  if (requester.id !== expected.id) {
    throw new BrokerError(
      "unauthorized",
      `${context} requester id must match ${expected.id}`,
    );
  }

  if (
    expected.role &&
    (expected.role === "hub" || expected.role === "operator") &&
    requester.role !== expected.role
  ) {
    throw new BrokerError(
      "unauthorized",
      `${context} requester role must match privileged actor role ${expected.role}`,
    );
  }

  if (requester.role && expected.role && requester.role !== expected.role) {
    throw new BrokerError(
      "unauthorized",
      `${context} requester role must match ${expected.role}`,
    );
  }
}

export function assertRequesterCanTouchProposalArtifacts(
  identity: RequesterIdentity | null,
  proposal: ChangeProposal,
): void {
  const requester = requireRequesterIdentity(identity);

  if (requester.role === "operator") {
    return;
  }

  if (requester.id === proposal.sourceNodeId || requester.id === proposal.targetNodeId) {
    return;
  }

  throw new BrokerError(
    "unauthorized",
    "artifact updates require the proposal source, target, or an operator requester",
  );
}

export function assertRequesterHasRole(
  identity: RequesterIdentity | null,
  allowedRoles: A2APartyRole[],
  context: string,
): void {
  const requester = requireRequesterIdentity(identity);

  if (!requester.role || !allowedRoles.includes(requester.role)) {
    throw new BrokerError(
      "unauthorized",
      `${context} requester role must be one of: ${allowedRoles.join(", ")}`,
    );
  }
}

function secretsMatch(providedSecret: string, expectedSecret: string): boolean {
  const providedBuffer = Buffer.from(providedSecret);
  const expectedBuffer = Buffer.from(expectedSecret);

  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(providedBuffer, expectedBuffer);
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  if (Array.isArray(value)) {
    return value[0]?.trim() || undefined;
  }
  if (typeof value === "string") {
    return value.trim() || undefined;
  }
  return undefined;
}
