/**
 * Project broker task state into GitHub status-comment payloads.
 *
 * The broker remains the source of truth; GitHub comments are an
 * append-only audit/collaboration surface. This module is purely
 * functional: it produces the marker and the rendered body. Posting
 * (the GitHub API call) is intentionally left to a downstream adapter.
 *
 * GitHub-origin tasks are tagged in the broker read model with
 * `taskOrigin: "github"` (set by the ingestion service when projecting
 * `/a2a assign` commands). Downstream consumers can filter on that field
 * via `listTasks({ taskOrigin: "github" })` to distinguish GitHub-driven
 * collaboration from API/sessions_send-origin tasks; this module itself
 * is origin-agnostic and renders any task that is handed to it.
 *
 * Status → marker mapping:
 *   - `queued`               → no marker (null projection — nothing to post)
 *   - `claimed` | `running`  → `Start`
 *   - `succeeded` (no PR)    → `Done`
 *   - `succeeded` (with PR)  → `PR`  (an extracted pull-request URL upgrades
 *                                     `Done` → `PR`)
 *   - `failed` | `canceled`  → `Block`
 *
 * Body fields per marker:
 *   - `Start`: `worker=<assigned-or-target> status=<task.status>`
 *   - `Done`:  `summary: <result.summary or result.note>` (when present),
 *              followed by an `output:` block listing each `result.output`
 *              key on its own indented line. Both summary and output are
 *              redacted before serialization (see redaction below).
 *   - `PR`:    `pull_request: <url>` extracted from `result.output`
 *              (`pullRequestUrl` / `prUrl` / `pull_request_url`) or, as a
 *              fallback, matched against `result.summary`. Followed by the
 *              same redacted `summary:` line as `Done`.
 *   - `Block`: `reason: <error.message or cancellation.reason or
 *              `task <status>`>`, optionally followed by `code: <error.code>`.
 *
 * Every body starts with the canonical marker line:
 *   `[a2a:<Marker>] task=<task.id>`
 * Downstream consumers grep this header to dedup/replace earlier projections
 * for the same task.
 *
 * Redaction (see `redactSensitive`):
 *   - Object keys matching /(token|secret|api[_-]?key|password|credential|
 *     authorization)/i have their value replaced with `[REDACTED]`.
 *   - Token-shaped substrings inside string values (`ghp_…`, `gho_…`,
 *     `ghu_…`, `ghs_…`, `ghr_…`, `github_pat_…`) are scrubbed regardless of
 *     the surrounding key, so accidental token leaks in summaries or output
 *     fields are caught.
 *   - Redaction recurses into nested objects and arrays.
 *
 * Truncation:
 *   - The rendered body is hard-capped at `MAX_GITHUB_COMMENT_LENGTH` (60_000
 *     bytes — well under GitHub's 65_536 limit). Bodies exceeding the cap are
 *     sliced and have `\n\n…(truncated)` appended so reviewers know more was
 *     produced. Truncation happens after rendering and after redaction, so
 *     redacted markers always reach the wire even when the body is clipped.
 */

import type { TaskRecord, TaskStatus } from "../core/types.js";

export type GitHubStatusMarker = "Start" | "Block" | "PR" | "Done";

/** Hard cap on rendered comment length. GitHub's own limit is 65_536. */
export const MAX_GITHUB_COMMENT_LENGTH = 60_000;

const TRUNCATION_MARKER = "\n\n…(truncated)";

export interface ProjectedComment {
  marker: GitHubStatusMarker;
  taskId: string;
  body: string;
}

// ---------------------------------------------------------------------------
// Marker mapping
// ---------------------------------------------------------------------------

export function projectStatusMarker(task: TaskRecord): GitHubStatusMarker | null {
  switch (task.status as TaskStatus) {
    case "queued":
      return null;
    case "claimed":
    case "running":
      return "Start";
    case "succeeded":
      return extractPullRequestUrl(task) ? "PR" : "Done";
    case "failed":
    case "canceled":
      return "Block";
    default:
      return null;
  }
}

export function projectTaskComment(task: TaskRecord): ProjectedComment | null {
  const marker = projectStatusMarker(task);
  if (!marker) return null;
  const body = boundLength(renderBody(marker, task));
  return { marker, taskId: task.id, body };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderBody(marker: GitHubStatusMarker, task: TaskRecord): string {
  const header = `[a2a:${marker}] task=${task.id}`;
  const lines: string[] = [header];

  switch (marker) {
    case "Start": {
      const worker = task.assignedWorkerId ?? task.targetNodeId;
      lines.push(`worker=${worker} status=${task.status}`);
      break;
    }
    case "Done": {
      const summary = task.result?.summary ?? task.result?.note;
      if (summary) lines.push(`summary: ${stringifyRedacted(summary)}`);
      const output = task.result?.output;
      if (output && Object.keys(output).length > 0) {
        lines.push("output:");
        lines.push(formatRecord(output as Record<string, unknown>));
      }
      break;
    }
    case "PR": {
      const url = extractPullRequestUrl(task);
      if (url) lines.push(`pull_request: ${url}`);
      const summary = task.result?.summary ?? task.result?.note;
      if (summary) lines.push(`summary: ${stringifyRedacted(summary)}`);
      break;
    }
    case "Block": {
      const reason =
        task.error?.message ??
        task.cancellation?.reason ??
        `task ${task.status}`;
      lines.push(`reason: ${stringifyRedacted(reason)}`);
      if (task.error?.code) lines.push(`code: ${task.error.code}`);
      break;
    }
  }
  return lines.join("\n");
}

function formatRecord(record: Record<string, unknown>): string {
  const safe = redactSensitive(record) as Record<string, unknown>;
  return Object.entries(safe)
    .map(([k, v]) => `  ${k}: ${stringify(v)}`)
    .join("\n");
}

function stringify(value: unknown): string {
  if (value == null) return String(value);
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function stringifyRedacted(value: unknown): string {
  return stringify(redactSensitive(value));
}

function boundLength(body: string): string {
  if (body.length <= MAX_GITHUB_COMMENT_LENGTH) return body;
  const headRoom = MAX_GITHUB_COMMENT_LENGTH - TRUNCATION_MARKER.length;
  return body.slice(0, Math.max(0, headRoom)) + TRUNCATION_MARKER;
}

// ---------------------------------------------------------------------------
// PR URL extraction
// ---------------------------------------------------------------------------

const PR_URL_RE = /^https?:\/\/[^\s]*\/pull\/\d+/;

function extractPullRequestUrl(task: TaskRecord): string | null {
  const output = task.result?.output;
  if (output && typeof output === "object") {
    const candidates = [
      (output as Record<string, unknown>).pullRequestUrl,
      (output as Record<string, unknown>).prUrl,
      (output as Record<string, unknown>).pull_request_url,
    ];
    for (const c of candidates) {
      if (typeof c === "string" && PR_URL_RE.test(c)) return c;
    }
  }
  const summary = task.result?.summary;
  if (typeof summary === "string") {
    const match = summary.match(/https?:\/\/\S*\/pull\/\d+/);
    if (match) return match[0];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

const SENSITIVE_KEY_RE = /(token|secret|api[_-]?key|password|credential|authorization)/i;
// Common token-like values worth scrubbing even when the key is innocuous.
const TOKEN_VALUE_RE = /\b(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]+/g;

export function redactSensitive(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redactSensitive);

  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY_RE.test(key)) {
      out[key] = "[REDACTED]";
    } else {
      out[key] = redactSensitive(raw);
    }
  }
  return out;
}

function redactString(value: string): string {
  return value.replace(TOKEN_VALUE_RE, "[REDACTED]");
}
