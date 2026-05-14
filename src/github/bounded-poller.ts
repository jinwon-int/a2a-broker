/**
 * Bounded poller: a background polling loop that periodically fetches new
 * GitHub events via a caller-supplied `fetchEvents` function and ingests
 * them through `GitHubIngestionService`.
 *
 * "Bounded" means:
 *   - Configurable maximum events per poll cycle
 *   - Exponential backoff on successive empty or error responses
 *   - Poll interval floor/ceiling so the poller cannot spin
 *   - Concurrent poll semantics: a poll cycle that is still running when
 *     the next interval fires is skipped rather than stacked.
 *
 * Exported types and interfaces are stable; internal timer handling uses
 * Node.js `Timers` and is safe for test environments via `vi.useFakeTimers`
 * or `sinon.useFakeTimers`.
 */

import type { GitHubWebhookEvent, GitHubDeliveryContext } from "./types.js";
import { GitHubIngestionService, type IngestionResult } from "./ingestion.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PollerFetchResult {
  events: GitHubWebhookEvent[];
  context: GitHubDeliveryContext;
}

export interface BoundedPollerOptions {
  /** Service used to ingest each fetched event. */
  ingestionService: GitHubIngestionService;

  /**
   * Caller-supplied function that returns the next batch of events.
   * The poller calls this synchronously or returns a promise; the return
   * value MUST be a `PollerFetchResult` or an array of them.
   */
  fetchEvents: () => PollerFetchResult | PollerFetchResult[] | Promise<PollerFetchResult | PollerFetchResult[]>;

  /** Minimum interval between poll cycles in milliseconds. Default 30_000. */
  pollIntervalMs?: number;

  /** Maximum events to process in a single poll cycle. Default 50. */
  maxEventsPerPoll?: number;

  /** Base backoff delay in milliseconds when a poll cycle yields 0 events.
   *  Doubles on each successive empty/idle cycle up to `maxBackoffMs`. Default 5_000. */
  baseBackoffMs?: number;

  /** Maximum backoff delay. Default 300_000 (5 minutes). */
  maxBackoffMs?: number;

  /** Label used for log messages. Default `"github-bounded-poller"`. */
  label?: string;

  /** Optional logger. Defaults to `console`. */
  logger?: Pick<typeof console, "log" | "warn" | "error">;
}

export interface BoundedPollerStats {
  /** Unique label assigned at construction. */
  label: string;
  /** True when the poller is currently running. */
  running: boolean;
  /** True when a poll cycle is in-flight. */
  busy: boolean;
  /** Total number of completed poll cycles since start. */
  totalPolls: number;
  /** Total events fetched across all cycles. */
  totalEventsFetched: number;
  /** Total events successfully ingested. */
  totalEventsIngested: number;
  /** Total cycles that returned zero events (idle). */
  idleCycles: number;
  /** Total cycles that encountered a fetch error. */
  errorCycles: number;
  /** ISO timestamp of the last completed poll cycle, or null. */
  lastPollAt: string | null;
  /** ISO timestamp of the last fetch error, or null. */
  lastErrorAt: string | null;
  /** Error message from the last fetch error, or null. */
  lastErrorMessage: string | null;
  /** Current backoff delay in milliseconds. */
  currentBackoffMs: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_MAX_EVENTS_PER_POLL = 50;
const DEFAULT_BASE_BACKOFF_MS = 5_000;
const DEFAULT_MAX_BACKOFF_MS = 300_000;

export class BoundedPoller {
  private readonly ingestionService: GitHubIngestionService;
  private readonly fetchEvents: () => PollerFetchResult | PollerFetchResult[] | Promise<PollerFetchResult | PollerFetchResult[]>;
  private readonly pollIntervalMs: number;
  private readonly maxEventsPerPoll: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly label: string;
  private readonly logger: Pick<typeof console, "log" | "warn" | "error">;

  private _running = false;
  private _busy = false;
  private _timer: ReturnType<typeof setTimeout> | null = null;

  // Statistics
  private _totalPolls = 0;
  private _totalEventsFetched = 0;
  private _totalEventsIngested = 0;
  private _idleCycles = 0;
  private _errorCycles = 0;
  private _lastPollAt: string | null = null;
  private _lastErrorAt: string | null = null;
  private _lastErrorMessage: string | null = null;
  private _currentBackoffMs: number;

  constructor(options: BoundedPollerOptions) {
    this.ingestionService = options.ingestionService;
    this.fetchEvents = options.fetchEvents;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.maxEventsPerPoll = options.maxEventsPerPoll ?? DEFAULT_MAX_EVENTS_PER_POLL;
    this.baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.label = options.label ?? "github-bounded-poller";
    this.logger = options.logger ?? console;
    this._currentBackoffMs = this.pollIntervalMs;
  }

  /** Start the poller. No-op if already running. */
  start(): void {
    if (this._running) return;
    this._running = true;
    this._currentBackoffMs = this.pollIntervalMs;
    this.logger.log(`[${this.label}] started (interval=${this.pollIntervalMs}ms, maxEvents=${this.maxEventsPerPoll})`);
    this.scheduleNext();
  }

  /** Stop the poller. Safe to call multiple times. */
  stop(): void {
    this._running = false;
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this.logger.log(`[${this.label}] stopped`);
  }

  /** Returns true while the poller is intended to be running. */
  get running(): boolean {
    return this._running;
  }

  /** Returns true while a poll cycle is in-flight. */
  get busy(): boolean {
    return this._busy;
  }

  /** Snapshot of poller statistics for diagnostics / health endpoints. */
  getStats(): BoundedPollerStats {
    return {
      label: this.label,
      running: this._running,
      busy: this._busy,
      totalPolls: this._totalPolls,
      totalEventsFetched: this._totalEventsFetched,
      totalEventsIngested: this._totalEventsIngested,
      idleCycles: this._idleCycles,
      errorCycles: this._errorCycles,
      lastPollAt: this._lastPollAt,
      lastErrorAt: this._lastErrorAt,
      lastErrorMessage: this._lastErrorMessage,
      currentBackoffMs: this._currentBackoffMs,
    };
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private scheduleNext(): void {
    if (!this._running) return;
    this._timer = setTimeout(() => this.poll(), this._currentBackoffMs);
    this._timer.unref?.();
  }

  private async poll(): Promise<void> {
    if (!this._running) return;
    if (this._busy) {
      this.logger.log(`[${this.label}] previous poll cycle still in-flight, skipping`);
      this.scheduleNext();
      return;
    }

    this._busy = true;

    try {
      const result = await this.fetchEvents();
      const batches = Array.isArray(result) ? result : [result];
      let totalFetched = 0;
      let totalIngested = 0;

      for (const batch of batches) {
        const events = batch.events.slice(0, this.maxEventsPerPoll - totalFetched);
        if (events.length === 0) continue;

        totalFetched += events.length;

        for (const event of events) {
          const ingestionResult: IngestionResult = this.ingestionService.ingest(event, batch.context);
          if (!ingestionResult.deduped && !ingestionResult.replaySkipped) {
            totalIngested++;
          }
        }

        if (totalFetched >= this.maxEventsPerPoll) break;
      }

      this._totalPolls++;
      this._totalEventsFetched += totalFetched;
      this._totalEventsIngested += totalIngested;
      this._lastPollAt = new Date().toISOString();
      this._idleCycles += totalFetched === 0 ? 1 : 0;

      if (totalFetched > 0) {
        // Reset backoff on successful non-empty poll
        this._currentBackoffMs = this.pollIntervalMs;
      } else {
        // Exponential backoff on idle cycles
        this._currentBackoffMs = Math.min(
          this._currentBackoffMs * 2,
          this.maxBackoffMs,
        );
      }
    } catch (error) {
      this._totalPolls++;
      this._errorCycles++;
      this._lastErrorAt = new Date().toISOString();
      this._lastErrorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`[${this.label}] poll cycle error: ${this._lastErrorMessage}`);

      // Exponential backoff on errors
      this._currentBackoffMs = Math.min(
        this._currentBackoffMs * 2,
        this.maxBackoffMs,
      );

      // Reset backoff to base on first error after a successful cycle
      if (this._idleCycles === 0 && this._totalEventsFetched > 0) {
        this._currentBackoffMs = Math.max(this.baseBackoffMs, this._currentBackoffMs);
      }
    } finally {
      this._busy = false;
    }

    this.scheduleNext();
  }
}
