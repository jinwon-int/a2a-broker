/**
 * Phase 8: read-only `a2a.peer.status` implementation.
 *
 * Lets callers ask whether a peer is reachable, busy, stale, or degraded
 * without creating a task. Follows docs/phase-8-peer-status-rfc.md.
 */

import type { InMemoryA2ABroker } from "../core/broker.js";
import type { TaskRecord, WorkerRecord } from "../core/types.js";

// ---------------------------------------------------------------------------
// Types (RFC §2)
// ---------------------------------------------------------------------------

export interface PeerStatusRequest {
  /** Canonical node id, e.g. "seoseo", "yukson" */
  target: string;
  /** Caller's tolerance for cached answer in ms; default 5000 */
  maxCacheAgeMs?: number;
  /** Requires elevated scope; default false */
  verbose?: boolean;
}

export type PeerHealth = "ok" | "degraded" | "stale" | "unreachable";
export type PeerGatewayMode = "internal" | "standalone" | "dual";

export interface PeerStatusResponse {
  schemaVersion: 1;
  target: string;
  observedAt: number; // epoch ms
  cacheAgeMs: number;
  gateway: {
    reachable: boolean;
    version?: string;
    mode?: PeerGatewayMode;
  };
  worker: {
    registered: boolean;
    lastHeartbeatAt?: number;
    capacity?: {
      slotsTotal: number;
      slotsBusy: number;
    };
  };
  tasks: {
    active: number;
    queued: number;
    stale: number;
  };
  health: PeerHealth;
  rateLimit?: {
    remaining: number;
    resetAt: number;
  };
}

export interface PeerStatusError {
  errorCode: string;
  message: string;
  retryAfterMs?: number;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  response: PeerStatusResponse;
  computedAt: number; // epoch ms
}

const DEFAULT_CACHE_TTL_MS = 5_000;

// ---------------------------------------------------------------------------
// Rate limiter: per (caller, target)
// ---------------------------------------------------------------------------

interface RateBucket {
  count: number;
  windowStart: number; // epoch ms
}

const RATE_WINDOW_MS = 10_000; // 10 s
const RATE_LIMIT = 20; // requests per window
const RATE_BURST = 5; // extra burst above limit

const GLOBAL_RECOMPUTE_CAP_PER_S = 200;

// ---------------------------------------------------------------------------
// Stampede protection
// ---------------------------------------------------------------------------

const inFlightComputations = new Map<string, Promise<PeerStatusResponse>>();

// ---------------------------------------------------------------------------
// PeerStatusService
// ---------------------------------------------------------------------------

export class PeerStatusService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly rateBuckets = new Map<string, RateBucket>();
  private globalRecomputeCount = 0;
  private globalRecomputeWindowStart = 0;

  constructor(
    private readonly broker: InMemoryA2ABroker,
    private readonly options: {
      cacheTtlMs?: number;
      workerOfflineAfterMs?: number;
    } = {},
  ) {}

  get cacheTtlMs(): number {
    return this.options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  }

  /**
   * Main entry point: get or compute peer status.
   * Returns either a PeerStatusResponse or a PeerStatusError.
   */
  query(
    request: PeerStatusRequest,
    callerId: string | null,
  ): PeerStatusResponse | PeerStatusError {
    if (!request.target || typeof request.target !== "string" || !request.target.trim()) {
      return { errorCode: "bad_request", message: "target is required" };
    }

    const target = request.target.trim();

    // Rate-limit check (only for authenticated callers)
    if (callerId) {
      const rateError = this.checkRateLimit(callerId, target);
      if (rateError) {
        return rateError;
      }
    }

    const maxCacheAge = request.maxCacheAgeMs ?? DEFAULT_CACHE_TTL_MS;

    // Check cache
    const cached = this.cache.get(target);
    const now = Date.now();
    if (cached && now - cached.computedAt <= maxCacheAge) {
      const response = {
        ...cached.response,
        cacheAgeMs: now - cached.computedAt,
      };
      // Attach rate-limit info
      if (callerId) {
        response.rateLimit = this.getRateLimitInfo(callerId, target);
      }
      return response;
    }

    // Stampede protection: check if there's already an in-flight computation
    // For synchronous usage (broker is in-memory), we compute directly
    // but still protect against global recompute cap
    const recompute = this.tryAcquireGlobalRecomputeSlot(now);
    if (!recompute && cached) {
      // Serve stale cache when global cap is hit
      const response = {
        ...cached.response,
        cacheAgeMs: now - cached.computedAt,
      };
      if (callerId) {
        response.rateLimit = this.getRateLimitInfo(callerId, target);
      }
      return response;
    }

    // Compute fresh status
    const response = this.computeStatus(target, now);

    // Store in cache
    this.cache.set(target, { response, computedAt: now });

    const finalResponse: PeerStatusResponse = {
      ...response,
      cacheAgeMs: 0,
    };

    if (callerId) {
      finalResponse.rateLimit = this.getRateLimitInfo(callerId, target);
    }

    return finalResponse;
  }

  /** Clear all cached entries. Useful for testing. */
  clearCache(): void {
    this.cache.clear();
  }

  // ---------------------------------------------------------------------------
  // Compute
  // ---------------------------------------------------------------------------

  private computeStatus(target: string, nowMs: number): PeerStatusResponse {
    const worker = this.broker.getWorker(target);
    const allTasks = this.broker.listTasks({ targetNodeId: target });
    const offlineAfterMs = this.options.workerOfflineAfterMs ?? 90_000;

    const workerView = this.broker.getWorkerView(target, offlineAfterMs);

    // Gateway reachability: worker is registered and not stale
    const isReachable = worker !== null;
    const isWorkerStale = workerView?.status === "stale";

    // Task counts
    const activeTasks = allTasks.filter(
      (t: TaskRecord) => t.status === "claimed" || t.status === "running",
    );
    const queuedTasks = allTasks.filter(
      (t: TaskRecord) => t.status === "queued",
    );
    const staleTasks = allTasks.filter((t: TaskRecord) => {
      if (t.status !== "claimed" && t.status !== "running") return false;
      const lastSignal = t.lastHeartbeatAt
        ? Date.parse(t.lastHeartbeatAt)
        : t.claimedAt
          ? Date.parse(t.claimedAt)
          : Date.parse(t.createdAt);
      return nowMs - lastSignal > 120_000; // 2 min stale threshold
    });

    // Health determination
    const health = this.computeHealth(isReachable, isWorkerStale, staleTasks.length, activeTasks.length);

    return {
      schemaVersion: 1,
      target,
      observedAt: nowMs,
      cacheAgeMs: 0, // always 0 on fresh compute; caller will override from cache
      gateway: {
        reachable: isReachable,
        version: worker?.metadata?.version,
        mode: "standalone" as PeerGatewayMode,
      },
      worker: {
        registered: isReachable,
        lastHeartbeatAt: worker ? Date.parse(worker.lastSeenAt) : undefined,
        capacity: isReachable
          ? { slotsTotal: 10, slotsBusy: activeTasks.length }
          : undefined,
      },
      tasks: {
        active: activeTasks.length,
        queued: queuedTasks.length,
        stale: staleTasks.length,
      },
      health,
    };
  }

  private computeHealth(
    reachable: boolean,
    workerStale: boolean,
    staleTaskCount: number,
    activeTaskCount: number,
  ): PeerHealth {
    if (!reachable) return "unreachable";
    if (workerStale) return "stale";
    if (staleTaskCount > 0) return "degraded";
    return "ok";
  }

  // ---------------------------------------------------------------------------
  // Rate limiting
  // ---------------------------------------------------------------------------

  private checkRateLimit(callerId: string, target: string): PeerStatusError | null {
    const key = `${callerId}:${target}`;
    const now = Date.now();
    let bucket = this.rateBuckets.get(key);

    if (!bucket || now - bucket.windowStart >= RATE_WINDOW_MS) {
      bucket = { count: 0, windowStart: now };
      this.rateBuckets.set(key, bucket);
    }

    const limit = RATE_LIMIT + RATE_BURST;
    if (bucket.count >= limit) {
      const resetAt = bucket.windowStart + RATE_WINDOW_MS;
      return {
        errorCode: "rate_limited",
        message: `rate limit exceeded for ${callerId} → ${target}`,
        retryAfterMs: resetAt - now,
      };
    }

    bucket.count++;
    return null;
  }

  private getRateLimitInfo(callerId: string, target: string): { remaining: number; resetAt: number } {
    const key = `${callerId}:${target}`;
    const now = Date.now();
    const bucket = this.rateBuckets.get(key);
    const limit = RATE_LIMIT + RATE_BURST;
    const windowEnd = (bucket?.windowStart ?? now) + RATE_WINDOW_MS;

    return {
      remaining: Math.max(0, limit - (bucket?.count ?? 0)),
      resetAt: windowEnd,
    };
  }

  // ---------------------------------------------------------------------------
  // Global recompute cap
  // ---------------------------------------------------------------------------

  private tryAcquireGlobalRecomputeSlot(nowMs: number): boolean {
    if (nowMs - this.globalRecomputeWindowStart >= 1000) {
      this.globalRecomputeWindowStart = nowMs;
      this.globalRecomputeCount = 0;
    }

    if (this.globalRecomputeCount >= GLOBAL_RECOMPUTE_CAP_PER_S) {
      return false;
    }

    this.globalRecomputeCount++;
    return true;
  }
}
