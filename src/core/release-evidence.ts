import type { TaskKind, TaskRecord, TaskStatus } from "./types.js";

const TERMINAL_STATUSES = new Set<TaskStatus>(["succeeded", "failed", "canceled"]);
const TASK_STATUSES: TaskStatus[] = ["blocked", "queued", "claimed", "running", "succeeded", "failed", "canceled"];
const GITHUB_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:pull|issues|tree)\/[^\s)\]}>'"]+$/;
const GITHUB_ISSUE_RE = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/\d+(?:#issuecomment-\d+)?$/;
const SECRETISH_RE = /token|secret|chat_id|BROKER_EDGE_SECRET|EDGE_SECRET|\/work\/|AGENTS\.md|SOUL\.md|USER\.md|TOOLS\.md|HEARTBEAT\.md|IDENTITY\.md|\.openclaw/i;

export type ReleaseEvidenceKind = "pr" | "done" | "block" | "branch" | "missing" | "none";

export interface ReleaseEvidenceObservedActions {
  providerCalled?: boolean;
  terminalAckAttempted?: boolean;
  dbMutationAttempted?: boolean;
  productionDeploy?: boolean;
  gatewayRestart?: boolean;
  workerRestart?: boolean;
  releasePublished?: boolean;
}

export interface ReleaseEvidenceExportOptions {
  generatedAt?: string;
  repo?: string;
  issue?: string;
  parentIssue?: string;
  runId?: string;
  sourcePublicExecution?: "NO-GO" | "GO" | string;
  observedActions?: ReleaseEvidenceObservedActions;
}

export interface ReleaseEvidenceItem {
  taskId: string;
  intent: TaskKind;
  status: TaskStatus;
  terminal: boolean;
  targetNodeId: string;
  assignedWorkerId?: string;
  claimedBy?: string;
  issue?: string;
  issueUrl?: string;
  prUrl?: string;
  doneCommentUrl?: string;
  blockCommentUrl?: string;
  branchUrl?: string;
  evidenceKind: ReleaseEvidenceKind;
  completedAt?: string;
  updatedAt: string;
}

export interface ReleaseEvidenceExport {
  kind: "broker.release-evidence.export";
  generatedAt: string;
  mode: "dry-run/read-only";
  readOnly: true;
  repo?: string;
  issue?: string;
  parentIssue?: string;
  runId?: string;
  sourcePublicExecution: string;
  gates: {
    ok: boolean;
    liveActionAllowed: false;
    mutationAllowed: false;
    prohibitedActions: string[];
    observedActions: Required<ReleaseEvidenceObservedActions>;
  };
  taskSummary: {
    total: number;
    active: number;
    terminal: number;
    byStatus: Record<TaskStatus, number>;
  };
  evidenceSummary: Record<ReleaseEvidenceKind, number>;
  links: {
    issues: string[];
    pullRequests: string[];
    doneComments: string[];
    blockComments: string[];
  };
  items: ReleaseEvidenceItem[];
}

const PROHIBITED_ACTIONS = [
  "production_deploy",
  "gateway_restart",
  "broker_or_worker_restart",
  "live_provider_or_telegram_send",
  "terminal_ack",
  "production_db_mutation",
  "secret_or_visibility_change",
  "history_rewrite_or_force_push",
  "release_publication",
  "community_post",
];

export function buildReleaseEvidenceExport(
  tasks: TaskRecord[],
  options: ReleaseEvidenceExportOptions = {},
): ReleaseEvidenceExport {
  const items = tasks
    .map(projectReleaseEvidenceItem)
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt) || left.taskId.localeCompare(right.taskId));

  const byStatus = Object.fromEntries(TASK_STATUSES.map((status) => [status, 0])) as Record<TaskStatus, number>;
  const evidenceSummary = {
    pr: 0,
    done: 0,
    block: 0,
    branch: 0,
    missing: 0,
    none: 0,
  } satisfies Record<ReleaseEvidenceKind, number>;

  for (const item of items) {
    byStatus[item.status] += 1;
    evidenceSummary[item.evidenceKind] += 1;
  }

  const observedActions = normalizeObservedActions(options.observedActions);
  const unsafeObserved = Object.values(observedActions).some(Boolean);
  const missingTerminalEvidence = items.some((item) => item.terminal && item.evidenceKind === "missing");

  return {
    kind: "broker.release-evidence.export",
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    mode: "dry-run/read-only",
    readOnly: true,
    ...(safeRepo(options.repo) ? { repo: safeRepo(options.repo) } : {}),
    ...(safeIssueRef(options.issue) ? { issue: safeIssueRef(options.issue) } : {}),
    ...(safeIssueRef(options.parentIssue) ? { parentIssue: safeIssueRef(options.parentIssue) } : {}),
    ...(safeToken(options.runId) ? { runId: safeToken(options.runId) } : {}),
    sourcePublicExecution: safeToken(options.sourcePublicExecution) ?? "NO-GO",
    gates: {
      ok: !unsafeObserved && !missingTerminalEvidence,
      liveActionAllowed: false,
      mutationAllowed: false,
      prohibitedActions: [...PROHIBITED_ACTIONS],
      observedActions,
    },
    taskSummary: {
      total: items.length,
      active: items.filter((item) => !item.terminal).length,
      terminal: items.filter((item) => item.terminal).length,
      byStatus,
    },
    evidenceSummary,
    links: collectLinks(items),
    items,
  };
}

export function renderReleaseEvidenceMarkdown(report: ReleaseEvidenceExport): string {
  const title = report.gates.ok ? "Done" : "Block";
  const lines = [
    `${title}: broker read-only release evidence export`,
    `Run: ${report.runId ?? "unknown"}`,
    `Mode: ${report.mode}; source-public execution: ${report.sourcePublicExecution}`,
    `Scope: ${[report.repo, report.issue, report.parentIssue ? `parent ${report.parentIssue}` : undefined].filter(Boolean).join(" ") || "unspecified"}`,
    `Tasks: total=${report.taskSummary.total} active=${report.taskSummary.active} terminal=${report.taskSummary.terminal}`,
    `Evidence: pr=${report.evidenceSummary.pr} done=${report.evidenceSummary.done} block=${report.evidenceSummary.block} branch=${report.evidenceSummary.branch} missing=${report.evidenceSummary.missing}`,
    `Safety gates: ${report.gates.ok ? "clean" : "blocked"}; liveActionAllowed=false mutationAllowed=false`,
    "",
    "Items:",
  ];

  if (report.items.length === 0) {
    lines.push("- No tasks matched the export filters.");
  } else {
    for (const item of report.items) {
      const evidence = item.prUrl ?? item.doneCommentUrl ?? item.blockCommentUrl ?? item.branchUrl ?? item.issueUrl ?? "no canonical evidence URL";
      lines.push(`- ${item.taskId}: ${item.status} ${item.evidenceKind} — ${evidence}`);
    }
  }

  lines.push("", "No live sends, terminal ACKs, production DB mutations, deploys, restarts, or release publications are performed by this exporter.");
  return `${lines.join("\n")}\n`;
}

function projectReleaseEvidenceItem(task: TaskRecord): ReleaseEvidenceItem {
  const terminal = TERMINAL_STATUSES.has(task.status);
  const evidence = extractEvidence(task);
  const evidenceKind = classifyEvidence(evidence, terminal);

  return {
    taskId: safeToken(task.id) ?? "<redacted>",
    intent: task.intent,
    status: task.status,
    terminal,
    targetNodeId: safeToken(task.targetNodeId) ?? "<redacted>",
    ...(safeToken(task.assignedWorkerId) ? { assignedWorkerId: safeToken(task.assignedWorkerId) } : {}),
    ...(safeToken(task.claimedBy) ? { claimedBy: safeToken(task.claimedBy) } : {}),
    ...evidence,
    evidenceKind,
    ...(safeIso(task.completedAt) ? { completedAt: task.completedAt } : {}),
    updatedAt: safeIso(task.updatedAt) ?? new Date(0).toISOString(),
  };
}

function classifyEvidence(evidence: Partial<ReleaseEvidenceItem>, terminal: boolean): ReleaseEvidenceKind {
  if (evidence.prUrl) return "pr";
  if (evidence.doneCommentUrl) return "done";
  if (evidence.blockCommentUrl) return "block";
  if (evidence.branchUrl) return "branch";
  return terminal ? "missing" : "none";
}

function extractEvidence(task: TaskRecord): Partial<ReleaseEvidenceItem> {
  const output = asRecord(task.result?.output);
  const nestedGithub = asRecord(output?.github);
  const failedRunnerResult = task.status === "failed" ? asRecord(task.error?.details?.runnerResult) : undefined;
  const payload = asRecord(task.payload);

  const prUrl = safeGithubUrl(first(output?.prUrl, nestedGithub?.prUrl, failedRunnerResult?.prUrl));
  const doneCommentUrl = safeIssueCommentUrl(first(output?.doneCommentUrl, nestedGithub?.doneCommentUrl, failedRunnerResult?.doneCommentUrl));
  const blockCommentUrl = safeIssueCommentUrl(first(output?.blockCommentUrl, nestedGithub?.blockCommentUrl, failedRunnerResult?.blockCommentUrl));
  const branchUrl = safeGithubUrl(first(output?.branchUrl, nestedGithub?.branchUrl, failedRunnerResult?.branchUrl));
  const issueUrl = safeIssueUrl(first(output?.issueUrl, nestedGithub?.issueUrl, failedRunnerResult?.issueUrl, payload?.issueUrl, payload?.githubIssueUrl));
  const issue = safeIssueRef(first(output?.issue, nestedGithub?.issue, failedRunnerResult?.issue, payload?.issue, payload?.issueNumber));

  return {
    ...(issue ? { issue } : {}),
    ...(issueUrl ? { issueUrl } : {}),
    ...(prUrl ? { prUrl } : {}),
    ...(doneCommentUrl ? { doneCommentUrl } : {}),
    ...(blockCommentUrl ? { blockCommentUrl } : {}),
    ...(branchUrl ? { branchUrl } : {}),
  };
}

function collectLinks(items: ReleaseEvidenceItem[]): ReleaseEvidenceExport["links"] {
  return {
    issues: uniqueSorted(items.map((item) => item.issueUrl).filter(isString)),
    pullRequests: uniqueSorted(items.map((item) => item.prUrl).filter(isString)),
    doneComments: uniqueSorted(items.map((item) => item.doneCommentUrl).filter(isString)),
    blockComments: uniqueSorted(items.map((item) => item.blockCommentUrl).filter(isString)),
  };
}

function normalizeObservedActions(actions: ReleaseEvidenceObservedActions = {}): Required<ReleaseEvidenceObservedActions> {
  return {
    providerCalled: actions.providerCalled === true,
    terminalAckAttempted: actions.terminalAckAttempted === true,
    dbMutationAttempted: actions.dbMutationAttempted === true,
    productionDeploy: actions.productionDeploy === true,
    gatewayRestart: actions.gatewayRestart === true,
    workerRestart: actions.workerRestart === true,
    releasePublished: actions.releasePublished === true,
  };
}

function first(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function safeGithubUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().replace(/[.,;:]+$/, "");
  return GITHUB_URL_RE.test(trimmed) && !SECRETISH_RE.test(trimmed) ? trimmed : undefined;
}

function safeIssueUrl(value: unknown): string | undefined {
  const url = safeGithubUrl(value);
  return url && GITHUB_ISSUE_RE.test(url) ? url : undefined;
}

function safeIssueCommentUrl(value: unknown): string | undefined {
  const url = safeIssueUrl(value);
  return url?.includes("#issuecomment-") ? url : undefined;
}

function safeIssueRef(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return `#${value}`;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (/^#?\d{1,10}$/.test(trimmed)) return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d{1,10}$/.test(trimmed) && !SECRETISH_RE.test(trimmed)) return trimmed;
  return undefined;
}

function safeRepo(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed) && !SECRETISH_RE.test(trimmed) ? trimmed : undefined;
}

function safeToken(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value).trim();
  return /^[A-Za-z0-9._:#/-]{1,128}$/.test(text) && !SECRETISH_RE.test(text) ? text : undefined;
}

function safeIso(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? value : undefined;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}
