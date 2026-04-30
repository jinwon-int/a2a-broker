/**
 * Phase 8: read-only `a2a.peer.status` implementation.
 *
 * Lets callers ask whether a peer is reachable, busy, stale, or degraded
 * without creating a task. Follows docs/phase-8-peer-status-rfc.md.
 */

import type { InMemoryA2ABroker } from "../core/broker.js";
import type { TaskRecord } from "../core/types.js";

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

export type PeerHealth = "ok" | "busy" | "degraded" | "stale" | "unreachable";
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
    workerMode?: "persistent" | "mobile";
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
  requiredScope?: string;
}

export interface PeerStatusCallerContext {
  callerId: string | null;
  scopes?: readonly string[];
}

export const PEER_STATUS_READ_SCOPE = "a2a.peer.status.read";
export const PEER_STATUS_VERBOSE_SCOPE = "a2a.peer.status.verbose";

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
      /**
       * Milliseconds after which a persistent worker is considered stale.
       * Default: 90_000 (90 s).
       */
      workerOfflineAfterMs?: number;
      /**
       * Milliseconds after which a mobile worker is considered stale.
       * Default: 30_000 (30 s) — mobile nodes may sleep briefly.
       */
      mobileOfflineAfterMs?: number;
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
    caller: string | PeerStatusCallerContext | null,
  ): PeerStatusResponse | PeerStatusError {
    const { callerId, scopes } = normalizeCaller(caller);

    if (!request.target || typeof request.target !== "string" || !request.target.trim()) {
      return { errorCode: "bad_request", message: "target is required" };
    }

    const target = request.target.trim();

    if (!callerId) {
      return { errorCode: "unauthenticated", message: "caller identity is required" };
    }

    if (request.verbose && !hasScope(scopes, PEER_STATUS_VERBOSE_SCOPE)) {
      return {
        errorCode: "scope_denied",
        message: `missing required scope: ${PEER_STATUS_VERBOSE_SCOPE}`,
        requiredScope: PEER_STATUS_VERBOSE_SCOPE,
      };
    }

    // Rate-limit check (only for authenticated callers)
    const rateError = this.checkRateLimit(callerId, target);
    if (rateError) {
      return rateError;
    }

    const maxCacheAge = request.maxCacheAgeMs ?? DEFAULT_CACHE_TTL_MS;

    // Check cache
    const cached = this.cache.get(target);
    const now = Date.now();
    if (cached && now - cached.computedAt <= maxCacheAge) {
      return this.buildDefaultResponse(cached.response, now - cached.computedAt, callerId, target);
    }

    // Stampede protection: check if there's already an in-flight computation
    // For synchronous usage (broker is in-memory), we compute directly
    // but still protect against global recompute cap
    const recompute = this.tryAcquireGlobalRecomputeSlot(now);
    if (!recompute && cached) {
      // Serve stale cache when global cap is hit
      return this.buildDefaultResponse(cached.response, now - cached.computedAt, callerId, target);
    }

    // Compute fresh status
    const response = this.buildDefaultResponse(this.computeStatus(target, now), 0, callerId, target);

    // Store in cache
    this.cache.set(target, { response, computedAt: now });

    return response;
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
    const isMobile = worker?.workerMode === "mobile";
    const offlineAfterMs = isMobile
      ? (this.options.mobileOfflineAfterMs ?? 30_000)
      : (this.options.workerOfflineAfterMs ?? 90_000);

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

    // Capacity: default 10 slots for persistent workers, 3 for mobile
    const slotsTotal = isMobile ? 3 : 10;
    const slotsBusy = activeTasks.length + queuedTasks.length;

    // Health determination
    const health = this.computeHealth(
      isReachable,
      isWorkerStale,
      staleTasks.length,
      slotsBusy,
      slotsTotal,
      isMobile,
    );

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
        workerMode: worker?.workerMode,
        capacity: isReachable
          ? { slotsTotal, slotsBusy }
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

  /**
   * Determine peer health from observed signals.
   *
   * Priority order (first match wins):
   * 1. unreachable – worker not registered at all
   * 2. stale – worker heartbeat too old for its mode
   * 3. busy – all capacity slots occupied (active + queued >= total)
   * 4. degraded – stale tasks exist (claim/running tasks with missed heartbeats)
   * 5. ok – everything nominal
   *
   * Mobile workers use a shorter stale window (30 s default vs 90 s)
   * and a smaller capacity (3 slots vs 10), reflecting the constraints
   * of battery-powered / sleep-capable devices.
   */
  private computeHealth(
    reachable: boolean,
    workerStale: boolean,
    staleTaskCount: number,
    occupiedSlots: number,
    totalSlots: number,
    _isMobile: boolean,
  ): PeerHealth {
    if (!reachable) return "unreachable";
    if (workerStale) return "stale";
    if (totalSlots > 0 && occupiedSlots >= totalSlots) return "busy";
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

  private buildDefaultResponse(
    response: PeerStatusResponse,
    cacheAgeMs: number,
    callerId: string,
    target: string,
  ): PeerStatusResponse {
    const safeResponse: PeerStatusResponse = {
      schemaVersion: 1,
      target: response.target,
      observedAt: response.observedAt,
      cacheAgeMs,
      gateway: {
        reachable: response.gateway.reachable,
        ...(response.gateway.version !== undefined ? { version: response.gateway.version } : {}),
        ...(response.gateway.mode !== undefined ? { mode: response.gateway.mode } : {}),
      },
      worker: {
        registered: response.worker.registered,
        ...(response.worker.workerMode !== undefined ? { workerMode: response.worker.workerMode } : {}),
        ...(response.worker.lastHeartbeatAt !== undefined
          ? { lastHeartbeatAt: response.worker.lastHeartbeatAt }
          : {}),
        ...(response.worker.capacity
          ? {
            capacity: {
              slotsTotal: response.worker.capacity.slotsTotal,
              slotsBusy: response.worker.capacity.slotsBusy,
            },
          }
          : {}),
      },
      tasks: {
        active: response.tasks.active,
        queued: response.tasks.queued,
        stale: response.tasks.stale,
      },
      health: response.health,
      rateLimit: this.getRateLimitInfo(callerId, target),
    };

    return safeResponse;
  }
}

function normalizeCaller(
  caller: string | PeerStatusCallerContext | null,
): PeerStatusCallerContext {
  if (typeof caller === "string" || caller === null) {
    return { callerId: caller };
  }
  return caller;
}

function hasScope(scopes: readonly string[] | undefined, requiredScope: string): boolean {
  return Array.isArray(scopes) && scopes.includes(requiredScope);
}
