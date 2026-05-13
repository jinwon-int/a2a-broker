import type { TaskError, TaskRecord, TaskResult } from "./types.js";

const GITHUB_TASK_MODES = new Set(["github-propose-patch", "github-issue-instruction"]);
const READ_ONLY_ANALYSIS_MODES = new Set(["analysis-only", "read-only-analysis", "analyze-only"]);
const GITHUB_READ_ONLY_VALIDATION_MODES = new Set([
  "github-verify",
  "github-read-only-validation",
  "read-only-validation",
  "github-libero-validation",
  "libero-validation",
]);
const RECEIPT_STATUSES = new Set([
  "accepted",
  "started",
  "produced",
  "sent",
  "provider_sent",
  "provider_accepted",
  "current_session_visible",
  "operator_visible",
  "timed_out",
  "stale",
  "failed",
]);
const RECEIPT_ACK_EVIDENCE = new Set([
  "current_session_visible",
  "operator_visible",
  "operator_confirmed",
  "provider_delivery_receipt",
]);

export function validateGithubTaskCompletionEvidence(task: TaskRecord, result?: TaskResult): TaskError | null {
  if (!requiresGithubCompletionEvidence(task)) {
    return null;
  }

  if (isGithubReadOnlyValidationTask(task) && !hasGithubNoPatchCompletionEvidence(result)) {
    return {
      code: "github_completion_evidence_missing",
      message:
        "github-origin read-only validation/libero tasks must return Done-comment or Block-comment evidence; PR-only evidence is reserved for propose_patch tasks",
      details: {
        taskId: task.id,
        taskOrigin: task.taskOrigin,
        mode: typeof task.payload?.mode === "string" ? task.payload.mode : undefined,
        requiredEvidence: [
          "result.output.github.doneCommentUrl",
          "result.output.github.blockCommentUrl",
          "result.output.doneCommentUrl",
          "result.output.blockCommentUrl",
        ],
      },
    };
  }

  if (!hasGithubCompletionEvidence(result)) {
    return {
      code: "github_completion_evidence_missing",
      message:
        "github-origin propose_patch tasks must return PR, Done-comment, or Block-comment evidence before they can succeed",
      details: {
        taskId: task.id,
        taskOrigin: task.taskOrigin,
        mode: typeof task.payload?.mode === "string" ? task.payload.mode : undefined,
        requiredEvidence: [
          "result.output.github.prUrl",
          "result.output.github.doneCommentUrl",
          "result.output.github.blockCommentUrl",
          "result.output.prUrl",
          "result.output.doneCommentUrl",
          "result.output.blockCommentUrl",
        ],
      },
    };
  }

  const receiptError = validateCompletionReceipt(result);
  if (receiptError) {
    return receiptError;
  }

  return null;
}

export function requiresGithubCompletionEvidence(task: TaskRecord): boolean {
  if (isGithubReadOnlyValidationTask(task)) {
    return true;
  }

  // Analysis-only / read-only tasks that are not GitHub validation lanes are
  // exempt from PR evidence requirements. They carry findings/summary/risks
  // without producing a patch or pull request.
  if (task.intent === "analyze" && isReadOnlyAnalysisMode(task.payload?.mode)) {
    return false;
  }

  const mode = typeof task.payload?.mode === "string" ? task.payload.mode : undefined;
  return task.intent === "propose_patch" && (task.taskOrigin === "github" || isGithubTaskMode(mode));
}

function isGithubTaskMode(mode: string | undefined): boolean {
  return mode !== undefined && GITHUB_TASK_MODES.has(mode);
}

function isGithubReadOnlyValidationTask(task: TaskRecord): boolean {
  if (task.taskOrigin !== "github") {
    return false;
  }

  const mode = typeof task.payload?.mode === "string" ? task.payload.mode : undefined;
  if (!mode) {
    return false;
  }

  if (task.intent === "verify" && GITHUB_READ_ONLY_VALIDATION_MODES.has(mode)) {
    return true;
  }

  if (task.intent === "analyze" && GITHUB_READ_ONLY_VALIDATION_MODES.has(mode)) {
    return true;
  }

  return task.intent === "validate_change" && GITHUB_READ_ONLY_VALIDATION_MODES.has(mode);
}

function isReadOnlyAnalysisMode(mode: unknown): boolean {
  return typeof mode === "string" && READ_ONLY_ANALYSIS_MODES.has(mode);
}

function hasGithubCompletionEvidence(result?: TaskResult): boolean {
  const output = result?.output;
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return false;
  }

  const github = output.github;
  if (github && typeof github === "object" && !Array.isArray(github)) {
    const record = github as Record<string, unknown>;
    if (isHttpUrl(record.prUrl) || isHttpUrl(record.doneCommentUrl) || isHttpUrl(record.blockCommentUrl)) {
      return true;
    }
  }

  return (
    isHttpUrl(output.prUrl) ||
    isHttpUrl(output.doneCommentUrl) ||
    isHttpUrl(output.blockCommentUrl)
  );
}

function hasGithubNoPatchCompletionEvidence(result?: TaskResult): boolean {
  const output = result?.output;
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return false;
  }

  const github = output.github;
  if (github && typeof github === "object" && !Array.isArray(github)) {
    const record = github as Record<string, unknown>;
    if (isHttpUrl(record.doneCommentUrl) || isHttpUrl(record.blockCommentUrl)) {
      return true;
    }
  }

  return isHttpUrl(output.doneCommentUrl) || isHttpUrl(output.blockCommentUrl);
}

function validateCompletionReceipt(result?: TaskResult): TaskError | null {
  const output = result?.output;
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return null;
  }

  const receipt = output.receipt;
  const receiptRecord = receipt && typeof receipt === "object" && !Array.isArray(receipt)
    ? receipt as Record<string, unknown>
    : undefined;
  const status = receiptRecord?.status ?? output.receiptStatus;
  if (status !== undefined && !isCanonicalReceiptStatus(status)) {
    return {
      code: "github_completion_receipt_invalid",
      message:
        "github-origin propose_patch completion receipt status must be accepted, sent/provider_sent/provider_accepted, current_session_visible, operator_visible, timed_out, stale, or failed",
      details: { receiptStatus: safeDetailValue(status) },
    };
  }

  const evidence = receiptRecord?.evidence ?? output.receiptEvidence;
  if (evidence !== undefined && !isReceiptAckEvidence(evidence)) {
    return {
      code: "github_completion_receipt_invalid",
      message:
        "github-origin propose_patch completion receipt evidence must be current_session_visible, operator_visible, operator_confirmed, or provider_delivery_receipt; provider send success is not receipt evidence",
      details: { receiptEvidence: safeDetailValue(evidence) },
    };
  }

  return null;
}

function isCanonicalReceiptStatus(value: unknown): boolean {
  return typeof value === "string" && RECEIPT_STATUSES.has(value);
}

function isReceiptAckEvidence(value: unknown): boolean {
  return typeof value === "string" && RECEIPT_ACK_EVIDENCE.has(value);
}

function isHttpUrl(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\//.test(value);
}

function safeDetailValue(value: unknown): string {
  return typeof value === "string" ? value.slice(0, 80) : typeof value;
}
