import type { TaskRecord, TaskStatus } from "./types.js";

export type OperatorTaskReportStage = "queued" | "claimed" | "running" | "terminal";
export type OperatorTaskReportKind = "progress" | "stale" | "result";

export interface OperatorTaskReportOptions {
  nowMs?: number;
  staleAfterMs?: number;
  taskIds?: string[];
  updatedAfter?: string;
}

export interface OperatorTaskReportItem {
  taskId: string;
  status: TaskStatus;
  stage: OperatorTaskReportStage;
  kind: OperatorTaskReportKind;
  final: boolean;
  stale: boolean;
  reportable: boolean;
  statusAgeMs: number;
  targetNodeId: string;
  assignedWorkerId?: string;
  claimedBy?: string;
  intent: string;
  updatedAt: string;
  claimedAt?: string;
  completedAt?: string;
  errorCode?: string;
  errorMessage?: string;
  resultSummary?: string;
  github?: {
    repo?: string;
    issue?: string;
    issueUrl?: string;
    nodeId?: string;
    taskId?: string;
    prUrl?: string;
    doneCommentUrl?: string;
    blockCommentUrl?: string;
  };
  reportLine: string;
}

export interface OperatorTaskReport {
  generatedAt: string;
  staleAfterMs: number;
  total: number;
  active: number;
  terminal: number;
  stale: number;
  reportable: number;
  allTerminal: boolean;
  items: OperatorTaskReportItem[];
}

const DEFAULT_STALE_AFTER_MS = 15 * 60 * 1000;
const TERMINAL_STATUSES = new Set<TaskStatus>(["succeeded", "failed", "canceled"]);

export function buildOperatorTaskReport(tasks: TaskRecord[], options: OperatorTaskReportOptions = {}): OperatorTaskReport {
  const nowMs = options.nowMs ?? Date.now();
  const staleAfterMs = Math.max(1, options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS);
  const wanted = new Set((options.taskIds ?? []).filter(Boolean));
  const updatedAfterMs = options.updatedAfter ? Date.parse(options.updatedAfter) : NaN;
  const hasUpdatedAfter = Number.isFinite(updatedAfterMs);

  const items = tasks
    .filter((task) => !wanted.size || wanted.has(task.id))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .map((task) => buildOperatorTaskReportItem(task, { nowMs, staleAfterMs, updatedAfterMs: hasUpdatedAfter ? updatedAfterMs : undefined }));

  const terminal = items.filter((item) => item.final).length;
  const stale = items.filter((item) => item.stale).length;
  const reportable = items.filter((item) => item.reportable).length;
  return {
    generatedAt: new Date(nowMs).toISOString(),
    staleAfterMs,
    total: items.length,
    active: items.length - terminal,
    terminal,
    stale,
    reportable,
    allTerminal: items.length > 0 && terminal === items.length,
    items,
  };
}

function buildOperatorTaskReportItem(
  task: TaskRecord,
  options: { nowMs: number; staleAfterMs: number; updatedAfterMs?: number },
): OperatorTaskReportItem {
  const final = TERMINAL_STATUSES.has(task.status);
  const stage = final ? "terminal" : task.status === "running" ? "running" : task.status === "claimed" ? "claimed" : "queued";
  const statusAgeMs = Math.max(0, options.nowMs - Date.parse(task.lastHeartbeatAt ?? task.updatedAt));
  const stale = !final && statusAgeMs >= options.staleAfterMs;
  const kind: OperatorTaskReportKind = final ? "result" : stale ? "stale" : "progress";
  const updatedMs = Date.parse(task.updatedAt);
  const reportable = final || stale || (options.updatedAfterMs !== undefined && Number.isFinite(updatedMs) && updatedMs > options.updatedAfterMs);
  const github = extractGithubEvidence(task);
  const resultSummary = task.result?.summary ?? task.result?.note;

  return {
    taskId: task.id,
    status: task.status,
    stage,
    kind,
    final,
    stale,
    reportable,
    statusAgeMs,
    targetNodeId: task.targetNodeId,
    assignedWorkerId: task.assignedWorkerId,
    claimedBy: task.claimedBy,
    intent: task.intent,
    updatedAt: task.updatedAt,
    claimedAt: task.claimedAt,
    completedAt: task.completedAt,
    errorCode: task.error?.code,
    errorMessage: task.error?.message,
    resultSummary,
    github,
    reportLine: buildReportLine(task, { kind, statusAgeMs, resultSummary, github }),
  };
}

function buildReportLine(
  task: TaskRecord,
  context: {
    kind: OperatorTaskReportKind;
    statusAgeMs: number;
    resultSummary?: string;
    github?: OperatorTaskReportItem["github"];
  },
): string {
  const node = task.targetNodeId || task.assignedWorkerId || "unknown-node";
  const pr = safeString(task.payload?.pullRequest ?? task.payload?.issue ?? task.payload?.issueNumber);
  const lane = safeString(task.payload?.lane ?? task.payload?.title);
  const subject = [node, pr, lane].filter(Boolean).join(" / ") || `${node} / ${task.intent}`;

  // Build scoped repo/issue label from evidence metadata when available.
  const evidenceLabel = buildEvidenceLabel(context.github);

  if (context.kind === "result") {
    const evidence = context.github?.prUrl ?? context.github?.doneCommentUrl ?? context.github?.blockCommentUrl;
    if (task.status === "succeeded") {
      const suffix = evidence ? ` — ${evidence}` : context.resultSummary ? ` — ${context.resultSummary}` : "";
      return `완료: ${subject}${evidenceLabel}${suffix}`;
    }
    if (task.status === "failed") {
      return `실패: ${subject}${evidenceLabel}${task.error?.code ? ` — ${task.error.code}` : ""}${task.error?.message ? `: ${task.error.message}` : ""}`;
    }
    return `종료: ${subject}${evidenceLabel} — ${task.status}`;
  }
  if (context.kind === "stale") {
    return `중간보고 필요: ${subject}${evidenceLabel} — ${task.status} 상태 ${formatDuration(context.statusAgeMs)} 동안 갱신 없음`;
  }
  return `진행중: ${subject}${evidenceLabel} — ${task.status}`;
}

/**
 * Build a compact `repo#issue` label from evidence metadata so the operator
 * can identify which task/issue produced each evidence URL at a glance.
 *
 * Returns an empty string when no repo or issue/issueUrl is present.
 */
function buildEvidenceLabel(evidence?: OperatorTaskReportItem["github"]): string {
  if (!evidence?.repo) return "";
  const issueRef = evidence.issue || (evidence.issueUrl ? `#${parseIssueNumberFromUrl(evidence.issueUrl)}` : "");
  return issueRef ? ` [${evidence.repo}${issueRef}]` : ` [${evidence.repo}]`;
}

function parseIssueNumberFromUrl(url: string): string | undefined {
  try {
    const m = new URL(url).pathname.match(/\/issues\/(\d+)\/?$/);
    return m ? m[1] : undefined;
  } catch {
    return undefined;
  }
}

function extractGithubEvidence(task: TaskRecord): OperatorTaskReportItem["github"] | undefined {
  const output = task.result?.output;
  if (!output) return undefined;
  const nested = output.github && typeof output.github === "object" && !Array.isArray(output.github)
    ? output.github as Record<string, unknown>
    : {};

  // Evidence URLs (from top-level output or nested github object)
  const prUrl = safeString(output.prUrl ?? nested.prUrl);
  const doneCommentUrl = safeString(output.doneCommentUrl ?? nested.doneCommentUrl);
  const blockCommentUrl = safeString(output.blockCommentUrl ?? nested.blockCommentUrl);

  // Enriched metadata (docker-runner result output including bridge path)
  const repo = safeString(output.repo ?? nested.repo);
  const issue = safeString(output.issue ?? nested.issue);
  const issueUrl = safeString(output.issueUrl ?? nested.issueUrl);
  const nodeId = safeString(output.nodeId ?? nested.nodeId);
  const taskId = safeString(output.taskId ?? nested.taskId);

  // Require at least one evidence URL OR enriched metadata; otherwise
  // this is not a GitHub-evidence-carrying result.
  if (!prUrl && !doneCommentUrl && !blockCommentUrl && !repo && !issue && !issueUrl) return undefined;

  return { repo, issue, issueUrl, nodeId, taskId, prUrl, doneCommentUrl, blockCommentUrl };
}

function safeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${totalSec}s`;
}
