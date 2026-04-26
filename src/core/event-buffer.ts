/**
 * Shared cursor/replay substrate for broker-owned event projections.
 *
 * The buffer owns monotonically increasing manager/stream-wide ids and bounded
 * FIFO retention. It intentionally does not own domain idempotency; callers that
 * need duplicate suppression must keep durable operation state outside the
 * replay buffer so eviction cannot change mutation semantics.
 */
export class CursorEventBuffer<TEvent extends { id: number }> {
  private readonly events: TEvent[] = [];
  private readonly maxEvents: number;
  private nextId = 0;

  constructor(maxEvents: number) {
    this.maxEvents = maxEvents;
  }

  allocateId(): number {
    this.nextId += 1;
    return this.nextId;
  }

  push(event: TEvent): TEvent {
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
    return event;
  }

  subscribe(options: {
    afterId?: number;
    limit?: number;
    matches?: (event: TEvent) => boolean;
  } = {}): TEvent[] {
    const afterId = options.afterId ?? 0;
    const result: TEvent[] = [];
    for (const event of this.events) {
      if (event.id <= afterId) continue;
      if (options.matches && !options.matches(event)) continue;
      result.push(event);
      if (options.limit !== undefined && result.length >= options.limit) break;
    }
    return result;
  }

  /** Largest event id ever assigned. Useful as the initial cursor. */
  get latestId(): number {
    return this.nextId;
  }

  /** Number of events currently retained (post FIFO eviction). */
  get size(): number {
    return this.events.length;
  }
}
