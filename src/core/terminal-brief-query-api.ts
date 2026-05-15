/**
 * Terminal Brief bounded query and export API.
 *
 * Provides filtered queries, cursor-based pagination, export formatting,
 * round progress summaries, and acknowledgment reconciliation queries
 * built on top of {@link TerminalTaskEventOutbox}.
 *
 * Design principles:
 * - All queries are bounded (max LIMIT) to prevent unbounded memory/storage scans.
 * - All exports are structured (JSON, compact round-up, markdown summary).
 * - No mutation — read-only queries against the outbox snapshot.
 * - No secret/producer-side access — only safe, operator-facing data.
 */

import type {
  TerminalTaskEventOutbox,
  TerminalTaskEventPayload,
  TerminalTaskOutboxEvent,
  TerminalTaskOutboxAckState,
} from "./terminal-event-outbox.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of events returned by any query. */
export const TERMINAL_BRIEF_QUERY_MAX_LIMIT = 200;

/** Maximum export rows for structured exports. */
export const TERMINAL_BRIEF_EXPORT_MAX_ROWS = 500;

// ---------------------------------------------------------------------------
// Filter types
// ---------------------------------------------------------------------------

/**
 * Filter criteria for querying terminal brief events.
 * All filter fields are optional; omitted fields are not filtered.
 */
export interface TerminalBriefQueryFilter {
  /** Filter by parent round id (exact match). */
  parentRoundId?: string;
  /** Filter by origin broker id (exact match). */
  originBrokerId?: string;
  /** Filter by broker of record id (exact match). */
  brokerOfRecordId?: string;
  /** Filter by worker id (exact match). */
  worker?: string;
  /** Filter by status (exact match). */
  status?: string;
  /** Filter to only acked (receipt-confirmed) events. */
  acked?: boolean;
  /** Filter to only unacked events. */
  unacked?: boolean;
  /** Filter to only failed/timed-out events. */
  errored?: boolean;
  /** Filter by task status (succeeded, failed, canceled, blocked). */
  taskStatus?: string;
  /** Filter by ticket/repo identifier (e.g., "jinwon-int/a2a-broker#649"). */
  ticketRef?: string;
}

/**
 * Pagination cursor for bounded queries.
 */
export interface TerminalBriefQueryCursor {
  /** Exclusive-start event id. Omit for the first page. */
  afterId?: string;
}

/**
 * Query result from the terminal brief query API.
 */
export interface TerminalBriefQueryResult {
  events: TerminalBriefQueryEvent[];
  /** Opaque cursor for fetching the next page. Null when no more results. */
  nextCursor: string | null;
  /** Total number of matching events across all pages (bounded estimate). */
  totalMatching: number;
  /** The cursor used for this query (for idempotent retry). */
  cursor: TerminalBriefQueryCursor;
}

/**
 * Sanitized, operator-safe view of a terminal brief event for query/export.
 * This is a projection of {@link TerminalTaskOutboxEvent} with secrets stripped.
 */
export interface TerminalBriefQueryEvent {
  id: string;
  taskId: string;
  parentRoundId?: string;
  originBrokerId?: string;
  brokerOfRecordId?: string;
  status: string;
  receiptStatus: string;
  receiptConfirmed: boolean;
  worker?: string;
  taskBrief?: string;
  prUrl?: string;
  doneUrl?: string;
  blockUrl?: string;
  parentRoundProgress?: number;
  parentRoundTotal?: number;
  createdAt: string;
  updatedAt?: string;
  completedAt?: string;
  templateId?: string;
  taskFlowRunId?: string;
  taskFlowTaskId?: string;
  ackDecision?: string;
  ackReason?: string;
}

// ---------------------------------------------------------------------------
// Export types
// ---------------------------------------------------------------------------

/** Structured export row for terminal brief events. */
export interface TerminalBriefExportRow {
  id: string;
  taskId: string;
  parentRoundId: string;
  worker: string;
  status: string;
  receiptStatus: string;
  receiptConfirmed: string;
  prUrl: string;
  doneUrl: string;
  blockUrl: string;
  progress: string;
  completedAt: string;
  templateId: string;
  taskFlowRunId: string;
  ackDecision: string;
}

/** Compact round progress summary for a single parent round. */
export interface TerminalBriefRoundProgressSummary {
  parentRoundId: string;
  workerCount: number;
  completedCount: number;
  ackedCount: number;
  failedCount: number;
  pendingCount: number;
  isComplete: boolean;
  allAcked: boolean;
}

/** Structured export format selector. */
export type TerminalBriefExportFormat = "json" | "compact-round-up" | "markdown-summary";

// ---------------------------------------------------------------------------
// HARD_BOUND constant: max page size (safety limit)
// ---------------------------------------------------------------------------

const HARD_BOUND = 200;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 1) return 50;
  return Math.min(limit, HARD_BOUND);
}

/** Check if a {@link TerminalTaskOutboxEvent} matches an accept/reject predicate. */
function matches(
  event: TerminalTaskOutboxEvent,
  filter: TerminalBriefQueryFilter,
): boolean {
  const p = event.payload;
  if (filter.parentRoundId && p.parentRoundId !== filter.parentRoundId) return false;
  if (filter.originBrokerId && p.originBrokerId !== filter.originBrokerId) return false;
  if (filter.brokerOfRecordId && p.brokerOfRecordId !== filter.brokerOfRecordId) return false;
  if (filter.worker && p.worker !== filter.worker) return false;
  if (filter.status && event.receipt.status !== filter.status) return false;
  if (filter.acked !== undefined && filter.acked && !event.ack) return false;
  if (filter.unacked !== undefined && filter.unacked && event.ack) return false;
  if (filter.errored !== undefined && filter.errored) {
    const erroredReceipts = ["failed", "timed_out", "stale"];
    const erroredTaskStatuses = ["failed", "canceled", "blocked"];
    if (!erroredReceipts.includes(event.receipt.status) && !erroredTaskStatuses.includes(p.status)) return false;
  }
  if (filter.taskStatus && p.status !== filter.taskStatus) return false;
  if (filter.ticketRef && p.taskId !== filter.ticketRef) {
    const ref = `${p.repo ?? ""}#${p.issue ?? ""}`;
    if (ref !== filter.ticketRef && p.taskBrief !== filter.ticketRef) return false;
  }
  return true;
}

function toQueryEvent(event: TerminalTaskOutboxEvent): TerminalBriefQueryEvent {
  const p = event.payload;
  return {
    id: event.id,
    taskId: p.taskId,
    parentRoundId: p.parentRoundId,
    originBrokerId: p.originBrokerId,
    brokerOfRecordId: p.brokerOfRecordId,
    status: p.status,
    receiptStatus: event.receipt.status,
    receiptConfirmed: event.ack?.status === "receipt_confirmed" || false,
    worker: p.worker,
    taskBrief: p.taskBrief,
    prUrl: p.prUrl,
    doneUrl: p.doneUrl,
    blockUrl: p.blockUrl,
    parentRoundProgress: p.parentRoundProgress,
    parentRoundTotal: p.parentRoundTotal,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    completedAt: p.completedAt,
    ackDecision: event.ackAudit?.decision,
    ackReason: event.ackAudit?.reason,
  };
}

function formatCell(value: string | undefined | number): string {
  if (value === undefined || value === null) return "";
  return String(value);
}

// ---------------------------------------------------------------------------
// Query API
// ---------------------------------------------------------------------------

/**
 * Query terminal brief events from the outbox with filtering and cursor-based
 * pagination. All queries are bounded by {@link TERMINAL_BRIEF_QUERY_MAX_LIMIT}.
 *
 * @param outbox - The terminal task event outbox to query.
 * @param filter - Optional filter criteria.
 * @param cursor - Optional cursor for pagination.
 * @param limit - Maximum events to return (capped at HARD_BOUND).
 * @returns A bounded query result with events and next cursor.
 */
export function queryTerminalBriefEvents(
  outbox: TerminalTaskEventOutbox,
  filter: TerminalBriefQueryFilter = {},
  cursor?: TerminalBriefQueryCursor,
  limit?: number,
): TerminalBriefQueryResult {
  const snapshot: TerminalTaskOutboxEvent[] = outbox.snapshot();
  const effectiveLimit = clampLimit(limit);

  // Determine start index from cursor
  let startIndex = 0;
  if (cursor?.afterId) {
    const idx = snapshot.findIndex((eventCandidate) => eventCandidate.id === cursor.afterId);
    if (idx >= 0) startIndex = idx + 1;
  }

  // Apply filter and pagination
  const filtered: TerminalTaskOutboxEvent[] = [];
  for (let i = startIndex; i < snapshot.length && filtered.length < effectiveLimit; i++) {
    if (matches(snapshot[i]!, filter)) {
      filtered.push(snapshot[i]!);
    }
  }

  // Determine next cursor
  const nextCursor: string | null =
    filtered.length > 0
      ? filtered[filtered.length - 1]!.id
      : null;

  // Count total matching (bounded — only scans up to the full snapshot once)
  const totalMatching = snapshot.filter((eventToMatch) => matches(eventToMatch, filter)).length;

  return {
    events: filtered.map(toQueryEvent),
    nextCursor,
    totalMatching,
    cursor: cursor ?? {},
  };
}

/**
 * Return a count of matching events without returning the event data.
 * Useful for dashboard badges and operator summaries.
 */
export function countTerminalBriefEvents(
  outbox: TerminalTaskEventOutbox,
  filter: TerminalBriefQueryFilter = {},
): number {
  return outbox.snapshot().filter((eventToMatch) => matches(eventToMatch, filter)).length;
}

/**
 * Retrieve a single terminal brief event by its stable id.
 * Returns null when not found.
 */
export function getTerminalBriefEvent(
  outbox: TerminalTaskEventOutbox,
  id: string,
): TerminalBriefQueryEvent | null {
  const event = outbox.snapshot().find((eventCandidate) => eventCandidate.id === id);
  return event ? toQueryEvent(event) : null;
}

// ---------------------------------------------------------------------------
// Export API
// ---------------------------------------------------------------------------

/**
 * Export terminal brief events in the requested format.
 *
 * @param outbox - The terminal task event outbox to export.
 * @param filter - Optional filter criteria.
 * @param format - Output format: "json", "compact-round-up", or "markdown-summary".
 * @param limit - Maximum export rows (capped at TERMINAL_BRIEF_EXPORT_MAX_ROWS).
 * @returns Formatted export string.
 */
export function exportTerminalBriefEvents(
  outbox: TerminalTaskEventOutbox,
  filter: TerminalBriefQueryFilter = {},
  format: TerminalBriefExportFormat = "json",
  limit?: number,
): string {
  const snapshot = outbox.snapshot();
  const effectiveLimit = typeof limit === "number" && limit > 0
    ? Math.min(limit, TERMINAL_BRIEF_EXPORT_MAX_ROWS)
    : TERMINAL_BRIEF_EXPORT_MAX_ROWS;

  const matching = snapshot.filter((eventToMatch) => matches(eventToMatch, filter)).slice(0, effectiveLimit);

  switch (format) {
    case "compact-round-up":
      return formatCompactRoundUp(matching);
    case "markdown-summary":
      return formatMarkdownSummary(matching);
    case "json":
    default:
      return formatJsonExport(matching);
  }
}

/**
 * Compute round progress summaries grouped by parentRoundId.
 * Returns summaries for the top N rounds by event count.
 *
 * @param outbox - The outbox to analyze.
 * @param maxRounds - Maximum number of round summaries to return (default 20).
 */
export function summarizeTerminalBriefRounds(
  outbox: TerminalTaskEventOutbox,
  maxRounds: number = 20,
): TerminalBriefRoundProgressSummary[] {
  const events = outbox.snapshot();
  const rounds = new Map<string, TerminalTaskOutboxEvent[]>();

  for (const event of events) {
    const key = event.payload.parentRoundId ?? "_ungrouped";
    const list = rounds.get(key) ?? [];
    list.push(event);
    rounds.set(key, list);
  }

  const summaries: TerminalBriefRoundProgressSummary[] = [];
  const sorted = [...rounds.entries()].sort((a, b) => b[1].length - a[1].length);

  for (const [roundId, roundEvents] of sorted.slice(0, maxRounds)) {
    const total = roundEvents.length;
    const completed = roundEvents.filter((eventToMatch) => eventToMatch.payload.status === "succeeded").length;
    const acked = roundEvents.filter((eventToMatch) => eventToMatch.ack?.status === "receipt_confirmed").length;
    const failed = roundEvents.filter(
      (eventToMatch) => eventToMatch.payload.status === "failed" || eventToMatch.payload.status === "canceled",
    ).length;
    const pending = total - completed;

    summaries.push({
      parentRoundId: roundId,
      workerCount: total,
      completedCount: completed,
      ackedCount: acked,
      failedCount: failed,
      pendingCount: pending,
      isComplete: pending === 0 && failed === 0,
      allAcked: acked === total,
    });
  }

  return summaries;
}

/**
 * List all unique workers that have terminal brief events in the outbox.
 * Useful for operator assignment queries.
 */
export function listTerminalBriefWorkers(
  outbox: TerminalTaskEventOutbox,
  filter?: TerminalBriefQueryFilter,
): string[] {
  const workers = new Set<string>();
  for (const event of outbox.snapshot()) {
    if (filter && !matches(event, filter)) continue;
    if (event.payload.worker) workers.add(event.payload.worker);
  }
  return [...workers].sort();
}

// ---------------------------------------------------------------------------
// Internal formatters
// ---------------------------------------------------------------------------

function formatJsonExport(events: TerminalTaskOutboxEvent[]): string {
  const rows: TerminalBriefExportRow[] = events.map(toExportRow);
  return JSON.stringify(rows, null, 2);
}

function formatCompactRoundUp(events: TerminalTaskOutboxEvent[]): string {
  const lines: string[] = [];

  for (const event of events) {
    const p = event.payload;
    const ackMark = event.ack ? "✓" : "○";
    const statusIcon = p.status === "succeeded" ? "✅" : p.status === "failed" ? "❌" : "◻️";
    const progress = p.parentRoundProgress && p.parentRoundTotal
      ? `(${p.parentRoundProgress}/${p.parentRoundTotal})`
      : "";
    const worker = p.worker ?? "?";
    const brief = p.taskBrief ? `: ${p.taskBrief}` : "";
    const evidence = p.doneUrl ? ` ${p.doneUrl}` : p.prUrl ? ` ${p.prUrl}` : "";

    lines.push(`${ackMark} ${statusIcon} ${worker}${progress}${brief}${evidence}`);
  }

  return lines.length > 0 ? lines.join("\n") : "(no events)";
}

function formatMarkdownSummary(events: TerminalTaskOutboxEvent[]): string {
  if (events.length === 0) return "_No terminal brief events found._\n";

  const lines: string[] = ["| # | Worker | Status | Receipt | ACK | Progress | Ticket |",
    "|---|--------|--------|---------|-----|----------|--------|"];

  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    const p = event.payload;
    const status = p.status;
    const receipt = event.receipt.status;
    const ack = event.ack ? `✓ ${event.ack.evidence}` : "○";
    const progress = p.parentRoundProgress && p.parentRoundTotal
      ? `${p.parentRoundProgress}/${p.parentRoundTotal}`
      : "-";
    const ticket = p.taskBrief ? p.taskBrief.slice(0, 40) : p.taskId;
    const worker = p.worker ?? "-";

    lines.push(
      `| ${i + 1} | ${worker} | ${status} | ${receipt} | ${ack} | ${progress} | ${ticket} |`,
    );
  }

  return lines.join("\n") + "\n";
}

function toExportRow(event: TerminalTaskOutboxEvent): TerminalBriefExportRow {
  const p = event.payload;
  return {
    id: formatCell(event.id),
    taskId: formatCell(p.taskId),
    parentRoundId: formatCell(p.parentRoundId ?? p.run),
    worker: formatCell(p.worker),
    status: formatCell(p.status),
    receiptStatus: formatCell(event.receipt.status),
    receiptConfirmed: event.ack?.status === "receipt_confirmed" ? "yes" : "no",
    prUrl: formatCell(p.prUrl),
    doneUrl: formatCell(p.doneUrl),
    blockUrl: formatCell(p.blockUrl),
    progress: p.parentRoundProgress && p.parentRoundTotal
      ? `${p.parentRoundProgress}/${p.parentRoundTotal}`
      : "",
    completedAt: formatCell(p.completedAt),
    templateId: "",
    taskFlowRunId: "",
    ackDecision: formatCell(event.ackAudit?.decision),
  };
}
