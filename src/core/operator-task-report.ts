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
  if (context.kind === "result") {
    const evidence = context.github?.prUrl ?? context.github?.doneCommentUrl ?? context.github?.blockCommentUrl;
    if (task.status === "succeeded") {
      return `완료: ${subject}${evidence ? ` — ${evidence}` : context.resultSummary ? ` — ${context.resultSummary}` : ""}`;
    }
    if (task.status === "failed") {
      return `실패: ${subject}${task.error?.code ? ` — ${task.error.code}` : ""}${task.error?.message ? `: ${task.error.message}` : ""}`;
    }
    return `종료: ${subject} — ${task.status}`;
  }
  if (context.kind === "stale") {
    return `중간보고 필요: ${subject} — ${task.status} 상태 ${formatDuration(context.statusAgeMs)} 동안 갱신 없음`;
  }
  return `진행중: ${subject} — ${task.status}`;
}

function extractGithubEvidence(task: TaskRecord): OperatorTaskReportItem["github"] | undefined {
  const output = task.result?.output;
  const nested = output?.github && typeof output.github === "object" && !Array.isArray(output.github)
    ? output.github as Record<string, unknown>
    : {};
  const prUrl = safeString(output?.prUrl ?? nested.prUrl);
  const doneCommentUrl = safeString(output?.doneCommentUrl ?? nested.doneCommentUrl);
  const blockCommentUrl = safeString(output?.blockCommentUrl ?? nested.blockCommentUrl);
  if (!prUrl && !doneCommentUrl && !blockCommentUrl) return undefined;
  return { prUrl, doneCommentUrl, blockCommentUrl };
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
