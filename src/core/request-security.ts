import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";

import { BrokerError } from "./broker.js";
import type { A2APartyKind, A2APartyRole, ChangeProposal, TaskRecord } from "./types.js";

const requesterKindSchema = z.enum(["session", "node", "user", "service"]);
const requesterRoleSchema = z.enum(["hub", "live-trader", "researcher", "analyst", "operator"]);

export interface RequesterIdentity {
  id: string;
  kind?: A2APartyKind;
  role?: A2APartyRole;
  scopes?: string[];
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

export interface RateLimitPressureSnapshot {
  limit: number;
  windowMs: number;
  activeKeys: number;
  allowedRequests: number;
  deniedRequests: number;
  busiest: Array<{
    key: string;
    inWindow: number;
    remaining: number;
    resetAtMs: number;
  }>;
}

export class InMemoryRateLimiter {
  private readonly buckets = new Map<string, number[]>();
  private allowedRequests = 0;
  private deniedRequests = 0;

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
      this.allowedRequests += 1;
    } else {
      this.deniedRequests += 1;
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

  snapshot(nowMs = Date.now(), topKeys = 5): RateLimitPressureSnapshot {
    const windowStart = nowMs - this.windowMs;
    const activeEntries = [...this.buckets.entries()]
      .map(([key, timestamps]) => {
        const inWindow = timestamps.filter((value) => value > windowStart);
        if (inWindow.length === 0) {
          this.buckets.delete(key);
          return null;
        }
        this.buckets.set(key, inWindow);
        return {
          key,
          inWindow: inWindow.length,
          remaining: Math.max(0, this.maxRequests - inWindow.length),
          resetAtMs: (inWindow[0] ?? nowMs) + this.windowMs,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .sort((a, b) => {
        if (b.inWindow !== a.inWindow) {
          return b.inWindow - a.inWindow;
        }
        return a.key.localeCompare(b.key);
      });

    return {
      limit: this.maxRequests,
      windowMs: this.windowMs,
      activeKeys: activeEntries.length,
      allowedRequests: this.allowedRequests,
      deniedRequests: this.deniedRequests,
      busiest: activeEntries.slice(0, topKeys),
    };
  }
}

export function extractRequesterIdentity(req: IncomingMessage): RequesterIdentity | null {
  const id = headerValue(req, "x-a2a-requester-id");
  const rawKind = headerValue(req, "x-a2a-requester-kind");
  const rawRole = headerValue(req, "x-a2a-requester-role");
  const rawScopes = headerValue(req, "x-a2a-requester-scopes") ?? headerValue(req, "x-a2a-requester-scope");

  if (!id) {
    if (rawKind || rawRole || rawScopes) {
      throw new BrokerError(
        "bad_request",
        "x-a2a-requester-id is required when requester kind, role, or scopes headers are present",
      );
    }
    return null;
  }

  const kind = parseRequesterKind(rawKind);
  const role = parseRequesterRole(rawRole);
  const scopes = parseRequesterScopes(rawScopes);

  return {
    id,
    ...(kind ? { kind } : {}),
    ...(role ? { role } : {}),
    ...(scopes ? { scopes } : {}),
  };
}

export interface RateLimitKeyOptions {
  trustedProxy?: boolean;
}

export function rateLimitKey(
  req: IncomingMessage,
  identity: RequesterIdentity | null,
  options: RateLimitKeyOptions = {},
): string {
  if (identity?.id) {
    return `requester:${identity.id}`;
  }

  const forwarded = options.trustedProxy ? headerValue(req, "x-forwarded-for") : undefined;
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

export function assertRequesterCanSubscribeToTask(
  identity: RequesterIdentity | null,
  task: TaskRecord,
): void {
  const requester = requireRequesterIdentity(identity);

  if (requester.role === "hub" || requester.role === "operator") {
    return;
  }

  const allowedIds = new Set(
    [task.requester.id, task.targetNodeId, task.assignedWorkerId].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    ),
  );

  if (allowedIds.has(requester.id)) {
    return;
  }

  throw new BrokerError(
    "unauthorized",
    "task subscribe requires the task requester, target, assigned worker, or a hub/operator role",
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

function parseRequesterKind(value: string | undefined): A2APartyKind | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = requesterKindSchema.safeParse(value);
  if (!parsed.success) {
    throw new BrokerError(
      "bad_request",
      `x-a2a-requester-kind must be one of: ${requesterKindSchema.options.join(", ")}`,
    );
  }
  return parsed.data;
}

function parseRequesterRole(value: string | undefined): A2APartyRole | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = requesterRoleSchema.safeParse(value);
  if (!parsed.success) {
    throw new BrokerError(
      "bad_request",
      `x-a2a-requester-role must be one of: ${requesterRoleSchema.options.join(", ")}`,
    );
  }
  return parsed.data;
}

function parseRequesterScopes(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }

  const scopes = [...new Set(
    value
      .split(/[\s,]+/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  )].sort((left, right) => left.localeCompare(right));

  return scopes.length > 0 ? scopes : undefined;
}
