import type { TaskRecord, TaskStatus } from "./types.js";
import { normalizeTerminalTaskReceiptStatus, type TerminalTaskReceiptStatus } from "./terminal-event-outbox.js";

export type OperatorTaskReportStage = "queued" | "claimed" | "running" | "terminal";
export type OperatorTaskReportKind = "progress" | "stale" | "result";

export interface OperatorTaskReportOptions {
  nowMs?: number;
  staleAfterMs?: number;
  taskIds?: string[];
  parentIssue?: string;
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
  receiptStatus?: TerminalTaskReceiptStatus;
  github?: {
    repo?: string;
    issue?: string;
    issueUrl?: string;
    nodeId?: string;
    taskId?: string;
    branch?: string;
    branchUrl?: string;
    prUrl?: string;
    doneCommentUrl?: string;
    blockCommentUrl?: string;
    partial?: boolean;
  };
  nextAction?: string;
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
  const parentIssue = normalizeIssueRef(options.parentIssue);
  const updatedAfterMs = options.updatedAfter ? Date.parse(options.updatedAfter) : NaN;
  const hasUpdatedAfter = Number.isFinite(updatedAfterMs);

  const items = tasks
    .filter((task) => !wanted.size || wanted.has(task.id))
    .filter((task) => !parentIssue || taskMatchesIssueRef(task, parentIssue))
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
  const receiptStatus = extractReceiptStatus(task, final);
  const resultSummary = task.result?.summary ?? task.result?.note;
  const nextAction = buildNextAction(task, github);

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
    receiptStatus,
    github,
    nextAction,
    reportLine: buildReportLine(task, { kind, statusAgeMs, resultSummary, github, receiptStatus }),
  };
}

function buildReportLine(
  task: TaskRecord,
  context: {
    kind: OperatorTaskReportKind;
    statusAgeMs: number;
    resultSummary?: string;
    github?: OperatorTaskReportItem["github"];
    receiptStatus?: TerminalTaskReceiptStatus;
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
      const receiptGap = context.receiptStatus && context.receiptStatus !== "operator_visible"
        ? ` — receipt gap: ${context.receiptStatus}`
        : "";
      const suffix = evidence ? ` — ${evidence}` : context.resultSummary ? ` — ${context.resultSummary}` : "";
      return `완료: ${subject}${evidenceLabel}${receiptGap}${suffix}`;
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

function extractReceiptStatus(task: TaskRecord, final: boolean): TerminalTaskReceiptStatus | undefined {
  if (!final) return undefined;
  const output = asRecord(task.result?.output);
  const nested = asRecord(output?.receipt);
  const candidate = output?.receiptStatus ?? nested?.status;
  return normalizeTerminalTaskReceiptStatus(candidate) ?? "accepted";
}

function extractGithubEvidence(task: TaskRecord): OperatorTaskReportItem["github"] | undefined {
  const output = task.result?.output;
  const failedRunnerResult = task.status === "failed" ? asRecord(task.error?.details?.runnerResult) : undefined;
  const failedRunnerTask = task.status === "failed" ? asRecord(task.error?.details?.runnerTask) : undefined;
  if (!output && !failedRunnerResult && !failedRunnerTask) return undefined;

  const primary = asRecord(output);
  const nested = asRecord(primary?.github) ?? asRecord(failedRunnerResult?.github) ?? {};
  const scanned = scanGithubEvidenceText(
    [failedRunnerResult?.stdout, failedRunnerResult?.stderr, failedRunnerResult?.finalAssistantEvidence, failedRunnerResult?.summary]
      .map((value) => safeString(value))
      .filter((value): value is string => Boolean(value))
      .join("\n"),
  );

  // Evidence URLs (from normal output, failed runner JSON, or sanitized GitHub URL scan)
  const prUrl = safeString(primary?.prUrl ?? nested.prUrl ?? failedRunnerResult?.prUrl ?? scanned.prUrl);
  const doneCommentUrl = safeString(primary?.doneCommentUrl ?? nested.doneCommentUrl ?? failedRunnerResult?.doneCommentUrl ?? scanned.doneCommentUrl);
  const blockCommentUrl = safeString(primary?.blockCommentUrl ?? nested.blockCommentUrl ?? failedRunnerResult?.blockCommentUrl ?? scanned.blockCommentUrl);
  const branchUrl = safeString(primary?.branchUrl ?? nested.branchUrl ?? failedRunnerResult?.branchUrl ?? scanned.branchUrl);

  // Enriched metadata (docker-runner result output including bridge path)
  const repo = safeString(primary?.repo ?? nested.repo ?? failedRunnerTask?.repo ?? failedRunnerResult?.repo ?? parseRepoFromGithubUrl(prUrl ?? doneCommentUrl ?? blockCommentUrl ?? branchUrl));
  const issue = safeString(primary?.issue ?? nested.issue ?? failedRunnerTask?.issue ?? failedRunnerResult?.issue);
  const issueUrl = safeString(primary?.issueUrl ?? nested.issueUrl ?? failedRunnerTask?.issueUrl ?? failedRunnerResult?.issueUrl ?? scanned.issueUrl);
  const nodeId = safeString(primary?.nodeId ?? nested.nodeId ?? failedRunnerResult?.nodeId);
  const taskId = safeString(primary?.taskId ?? nested.taskId ?? failedRunnerResult?.taskId);
  const branch = safeString(primary?.branch ?? nested.branch ?? failedRunnerResult?.branch);
  const partial = Boolean(!output && (failedRunnerResult || failedRunnerTask));

  // Require at least one evidence URL OR enriched metadata; otherwise
  // this is not a GitHub-evidence-carrying result.
  if (!prUrl && !doneCommentUrl && !blockCommentUrl && !branchUrl && !repo && !issue && !issueUrl) return undefined;

  return { repo, issue, issueUrl, nodeId, taskId, branch, branchUrl, prUrl, doneCommentUrl, blockCommentUrl, partial };
}

function buildNextAction(task: TaskRecord, github?: OperatorTaskReportItem["github"]): string | undefined {
  if (task.status !== "failed" || !github) return undefined;
  const evidence = github.prUrl ?? github.doneCommentUrl ?? github.blockCommentUrl ?? github.branchUrl;
  if (!evidence) return undefined;
  if (github.prUrl) return `review recovered PR evidence before retrying or reassigning: ${github.prUrl}`;
  if (github.doneCommentUrl) return `verify recovered Done evidence, then mark/reconcile the task instead of rerunning blindly: ${github.doneCommentUrl}`;
  if (github.blockCommentUrl) return `inspect recovered Block evidence and resolve the blocker before rerunning: ${github.blockCommentUrl}`;
  return `inspect recovered branch evidence before rerunning or replacing the worker: ${evidence}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function scanGithubEvidenceText(text: string): Partial<NonNullable<OperatorTaskReportItem["github"]>> {
  if (!text) return {};
  const urls = [...text.matchAll(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:pull|issues|tree)\/[^\s)\]}>"']+/g)]
    .map((match) => match[0].replace(/[.,;:]+$/, ""));
  const prUrl = urls.find((url) => /\/pull\/\d+(?:$|[?#])/.test(url));
  const issueCommentUrl = urls.find((url) => /\/issues\/\d+#issuecomment-\d+/.test(url));
  const issueUrl = urls.find((url) => /\/issues\/\d+(?:$|[?#])/.test(url));
  const branchUrl = urls.find((url) => /\/tree\//.test(url));
  return {
    prUrl,
    doneCommentUrl: issueCommentUrl,
    issueUrl,
    branchUrl,
  };
}

function parseRepoFromGithubUrl(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    const [, owner, repo] = new URL(url).pathname.split("/");
    return owner && repo ? `${owner}/${repo}` : undefined;
  } catch {
    return undefined;
  }
}

function safeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function taskMatchesIssueRef(task: TaskRecord, issueRef: string): boolean {
  for (const candidate of taskIssueRefCandidates(task)) {
    if (normalizeIssueRef(candidate) === issueRef) return true;
  }
  return false;
}

function taskIssueRefCandidates(task: TaskRecord): string[] {
  const payload = asRecord(task.payload) ?? {};
  const nestedTask = asRecord(payload.task);
  const via = asRecord(task.via);
  return [
    payload.parentIssue,
    payload.parent_issue,
    payload.parentIssueUrl,
    payload.parent_issue_url,
    payload.commandCenterIssue,
    payload.command_center_issue,
    nestedTask?.parentIssue,
    nestedTask?.parent_issue,
    via?.parentIssue,
    via?.parent_issue,
    task.message,
  ].map((value) => safeString(value)).filter((value): value is string => Boolean(value));
}

function normalizeIssueRef(value?: string): string | undefined {
  if (!value) return undefined;
  const compact = value.trim();
  if (!compact) return undefined;
  const urlRef = parseGithubIssueRef(compact);
  if (urlRef) return urlRef;
  const inlineRef = compact.match(/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)\b/);
  if (inlineRef) return `${inlineRef[1].toLowerCase()}#${inlineRef[2]}`;
  return compact.toLowerCase();
}

function parseGithubIssueRef(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.hostname !== "github.com") return undefined;
    const [, owner, repo, kind, number] = url.pathname.split("/");
    if (!owner || !repo || kind !== "issues" || !/^\d+$/.test(number ?? "")) return undefined;
    return `${owner.toLowerCase()}/${repo.toLowerCase()}#${number}`;
  } catch {
    return undefined;
  }
}

function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${totalSec}s`;
}
