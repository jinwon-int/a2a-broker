import { createHash } from "node:crypto";

import type {
  TerminalTaskOutboxEvent,
  TerminalTaskReceiptStatus,
  TerminalTaskStatus,
} from "../core/terminal-event-outbox.js";
import { redactSensitive } from "./projection.js";

export type TerminalBriefGitHubEvidenceMarker = "Start" | "PR" | "Done" | "Block";
export type TerminalBriefGitHubEvidenceSource = "task-start" | "terminal-task-outbox";

export interface TerminalBriefGitHubCommentTarget {
  /** GitHub repository in owner/name form. */
  repo: string;
  /** Issue or pull-request number. GitHub PR comments use the issue comments API. */
  number: number;
}

export interface TerminalBriefGitHubStartInput extends TerminalBriefGitHubCommentTarget {
  kind: "start";
  taskId: string;
  run?: string;
  worker?: string;
  status?: "claimed" | "running";
  taskBrief?: string;
  traceId?: string;
}

export interface TerminalBriefGitHubTerminalInput {
  kind: "terminal";
  event: TerminalTaskOutboxEvent;
}

export type TerminalBriefGitHubEvidenceInput =
  | TerminalBriefGitHubStartInput
  | TerminalBriefGitHubTerminalInput;

export interface TerminalBriefGitHubEvidenceOptions {
  /** Optional deterministic timestamp for tests or offline rendering. Not part of the manifest digest. */
  renderedAt?: string;
}

export interface TerminalBriefGitHubEvidenceManifest {
  kind: "a2a-broker.terminal-brief.github-evidence";
  version: 1;
  source: TerminalBriefGitHubEvidenceSource;
  marker: TerminalBriefGitHubEvidenceMarker;
  repo: string;
  issueOrPrNumber: number;
  taskId: string;
  parentRoundId?: string;
  run?: string;
  originBrokerId?: string;
  brokerOfRecordId?: string;
  worker?: string;
  traceId?: string;
  startStatus?: "claimed" | "running";
  taskBrief?: string;
  terminalBriefTitle?: string;
  parentRoundProgress?: number;
  parentRoundTotal?: number;
  parentRoundOrder?: number;
  crossBrokerHandoff?: {
    parentRoundId: string;
    originBrokerId: string;
    handoffBrokerId?: string;
    originTaskId?: string;
    childWorkerId?: string;
  };
  notificationOwnership?: {
    ownerBrokerId: string;
    scope: "parent-broker-only";
    providerSendPermittedByProjection: false;
    terminalAckPermittedByProjection: false;
  };
  terminalOutboxCursor?: string;
  taskEventId?: number;
  terminalStatus?: TerminalTaskStatus;
  receiptStatus?: TerminalTaskReceiptStatus;
  evidenceUrls: {
    pullRequest?: string;
    done?: string;
    block?: string;
  };
  semantics: {
    githubCommentIsEvidenceLedgerEntry: true;
    githubCommentIsTerminalAck: false;
    githubCommentIsReadReceipt: false;
    githubCommentIsVisibilityProof: false;
    githubCommentIsOperatorApproval: false;
  };
}

export interface TerminalBriefGitHubEvidenceProjection {
  marker: TerminalBriefGitHubEvidenceMarker;
  target: TerminalBriefGitHubCommentTarget;
  taskId: string;
  idempotencyKey: string;
  manifest: TerminalBriefGitHubEvidenceManifest;
  manifestSha256: string;
  body: string;
}

export interface GitHubIssueCommentObservation {
  id: number;
  body: string;
  htmlUrl?: string;
}

export type TerminalBriefGitHubCommentWritePlan =
  | {
      action: "create";
      projection: TerminalBriefGitHubEvidenceProjection;
    }
  | {
      action: "update";
      commentId: number;
      htmlUrl?: string;
      projection: TerminalBriefGitHubEvidenceProjection;
    }
  | {
      action: "noop";
      commentId: number;
      htmlUrl?: string;
      projection: TerminalBriefGitHubEvidenceProjection;
    };

export interface TerminalBriefGitHubCommentWriter {
  listIssueComments(target: TerminalBriefGitHubCommentTarget): Promise<GitHubIssueCommentObservation[]>;
  createIssueComment(
    target: TerminalBriefGitHubCommentTarget,
    body: string,
  ): Promise<GitHubIssueCommentObservation>;
  updateIssueComment(
    target: TerminalBriefGitHubCommentTarget,
    commentId: number,
    body: string,
  ): Promise<GitHubIssueCommentObservation>;
}

export interface TerminalBriefGitHubCommentWriteResult {
  plan: TerminalBriefGitHubCommentWritePlan;
  comment: GitHubIssueCommentObservation;
}

const MARKER_PREFIX = "<!-- a2a:terminal-brief-github-evidence";
const MAX_COMMENT_CHARS = 60_000;
const TRUNCATION_MARKER = "\n\n…(truncated)";
const UNSAFE_OPENCLAW_RUNTIME_PATH_RE = /(^|[\s([{"'`])((?:\.openclaw\/[^\s)\]}'"`<>]+)|AGENTS\.md|SOUL\.md|USER\.md|TOOLS\.md|HEARTBEAT\.md|IDENTITY\.md)(?=$|[\s)\]},.'"`<>])/g;
const URL_RE = /^https?:\/\/[^\s]+$/;

export function projectTerminalBriefGitHubEvidenceComment(
  input: TerminalBriefGitHubEvidenceInput,
  options: TerminalBriefGitHubEvidenceOptions = {},
): TerminalBriefGitHubEvidenceProjection | null {
  const manifest = buildManifest(input);
  if (!manifest) return null;

  assertNoOpenClawRuntimePaths(manifest);

  const canonicalManifest = stableStringify(manifest);
  const manifestSha256 = sha256(canonicalManifest);
  const idempotencyKey = buildIdempotencyKey(manifest, manifestSha256);
  const body = boundCommentLength(renderCommentBody(manifest, manifestSha256, idempotencyKey, options.renderedAt));

  return {
    marker: manifest.marker,
    target: { repo: manifest.repo, number: manifest.issueOrPrNumber },
    taskId: manifest.taskId,
    idempotencyKey,
    manifest,
    manifestSha256,
    body,
  };
}

export function planTerminalBriefGitHubCommentWrite(
  projection: TerminalBriefGitHubEvidenceProjection,
  existingComments: GitHubIssueCommentObservation[],
): TerminalBriefGitHubCommentWritePlan {
  const existing = findExistingProjectionComment(projection, existingComments);
  if (!existing) return { action: "create", projection };
  if (existing.body === projection.body) {
    return {
      action: "noop",
      commentId: existing.id,
      htmlUrl: existing.htmlUrl,
      projection,
    };
  }
  return {
    action: "update",
    commentId: existing.id,
    htmlUrl: existing.htmlUrl,
    projection,
  };
}

export function reconcileTerminalBriefGitHubEvidenceComments(
  inputs: TerminalBriefGitHubEvidenceInput[],
  existingComments: GitHubIssueCommentObservation[],
  options: TerminalBriefGitHubEvidenceOptions = {},
): TerminalBriefGitHubCommentWritePlan[] {
  const plans: TerminalBriefGitHubCommentWritePlan[] = [];
  for (const input of inputs) {
    const projection = projectTerminalBriefGitHubEvidenceComment(input, options);
    if (projection) plans.push(planTerminalBriefGitHubCommentWrite(projection, existingComments));
  }
  return plans;
}

export async function writeTerminalBriefGitHubEvidenceComment(
  input: TerminalBriefGitHubEvidenceInput,
  writer: TerminalBriefGitHubCommentWriter,
  options: TerminalBriefGitHubEvidenceOptions = {},
): Promise<TerminalBriefGitHubCommentWriteResult | null> {
  const projection = projectTerminalBriefGitHubEvidenceComment(input, options);
  if (!projection) return null;

  const comments = await writer.listIssueComments(projection.target);
  const plan = planTerminalBriefGitHubCommentWrite(projection, comments);
  switch (plan.action) {
    case "create":
      return {
        plan,
        comment: await writer.createIssueComment(projection.target, projection.body),
      };
    case "update":
      return {
        plan,
        comment: await writer.updateIssueComment(projection.target, plan.commentId, projection.body),
      };
    case "noop": {
      const comment = comments.find((candidate) => candidate.id === plan.commentId);
      return { plan, comment: comment ?? { id: plan.commentId, body: projection.body, htmlUrl: plan.htmlUrl } };
    }
  }
}

export function findOpenClawRuntimePaths(value: unknown): string[] {
  const found = new Set<string>();
  visitForUnsafePaths(value, found);
  return [...found].sort();
}

export function assertNoOpenClawRuntimePaths(value: unknown): void {
  const offendingPaths = findOpenClawRuntimePaths(value);
  if (offendingPaths.length > 0) {
    throw new Error(`refusing to project OpenClaw runtime/bootstrap paths into GitHub evidence: ${offendingPaths.join(", ")}`);
  }
}

function buildManifest(input: TerminalBriefGitHubEvidenceInput): TerminalBriefGitHubEvidenceManifest | null {
  if (input.kind === "start") return buildStartManifest(input);
  return buildTerminalManifest(input.event);
}

function buildStartManifest(input: TerminalBriefGitHubStartInput): TerminalBriefGitHubEvidenceManifest {
  const manifest = baseManifest({
    source: "task-start",
    marker: "Start",
    repo: input.repo,
    issueOrPrNumber: input.number,
    taskId: input.taskId,
    run: safeText(input.run),
    worker: safeText(input.worker),
    traceId: safeText(input.traceId),
    startStatus: input.status,
    taskBrief: safeText(input.taskBrief),
    evidenceUrls: {},
  });
  return manifest;
}

function buildTerminalManifest(event: TerminalTaskOutboxEvent): TerminalBriefGitHubEvidenceManifest | null {
  const { payload } = event;
  if (!payload.repo || payload.issue === undefined) return null;
  const marker = markerForTerminalEvent(event);
  const manifest = baseManifest({
    source: "terminal-task-outbox",
    marker,
    repo: payload.repo,
    issueOrPrNumber: payload.issue,
    taskId: payload.taskId,
    parentRoundId: safeText(payload.parentRoundId ?? payload.run),
    run: safeText(payload.run),
    originBrokerId: safeText(payload.originBrokerId),
    brokerOfRecordId: safeText(payload.brokerOfRecordId),
    worker: safeText(payload.worker),
    traceId: safeText(payload.traceId),
    taskBrief: safeText(payload.taskBrief),
    terminalBriefTitle: safeText(payload.terminalBriefTitle),
    parentRoundProgress: safePositiveInt(payload.parentRoundProgress),
    parentRoundTotal: safePositiveInt(payload.parentRoundTotal),
    parentRoundOrder: safePositiveInt(payload.parentRoundOrder),
    crossBrokerHandoff: safeCrossBrokerHandoff(payload.crossBrokerHandoff),
    notificationOwnership: safeNotificationOwnership(payload.notificationOwnership),
    terminalOutboxCursor: event.id,
    taskEventId: event.taskEventId,
    terminalStatus: payload.status,
    receiptStatus: event.receipt.status,
    evidenceUrls: {
      pullRequest: marker === "PR" ? safeUrl(payload.prUrl) : undefined,
      done: safeUrl(payload.doneUrl),
      block: safeUrl(payload.blockUrl),
    },
  });
  return manifest;
}

function baseManifest(
  input: Omit<TerminalBriefGitHubEvidenceManifest, "kind" | "version" | "semantics">,
): TerminalBriefGitHubEvidenceManifest {
  return stripUndefined({
    kind: "a2a-broker.terminal-brief.github-evidence",
    version: 1,
    ...input,
    semantics: {
      githubCommentIsEvidenceLedgerEntry: true,
      githubCommentIsTerminalAck: false,
      githubCommentIsReadReceipt: false,
      githubCommentIsVisibilityProof: false,
      githubCommentIsOperatorApproval: false,
    },
  }) as TerminalBriefGitHubEvidenceManifest;
}

function markerForTerminalEvent(event: TerminalTaskOutboxEvent): TerminalBriefGitHubEvidenceMarker {
  switch (event.payload.status) {
    case "succeeded":
      return safeUrl(event.payload.prUrl) ? "PR" : "Done";
    case "failed":
    case "blocked":
    case "canceled":
      return "Block";
  }
}

function renderCommentBody(
  manifest: TerminalBriefGitHubEvidenceManifest,
  manifestSha256: string,
  idempotencyKey: string,
  renderedAt?: string,
): string {
  const lines = [
    `${MARKER_PREFIX} v=1 key=${idempotencyKey} manifest=sha256:${manifestSha256} -->`,
    `[a2a:${manifest.marker}] task=${manifest.taskId}`,
    `repo: ${manifest.repo}#${manifest.issueOrPrNumber}`,
  ];
  if (manifest.run) lines.push(`run: ${manifest.run}`);
  if (manifest.parentRoundId && manifest.parentRoundId !== manifest.run) lines.push(`parent_round_id: ${manifest.parentRoundId}`);
  if (manifest.originBrokerId) lines.push(`origin_broker: ${manifest.originBrokerId}`);
  if (manifest.brokerOfRecordId) lines.push(`broker_of_record: ${manifest.brokerOfRecordId}`);
  if (manifest.worker) lines.push(`worker: ${manifest.worker}`);
  if (manifest.traceId) lines.push(`trace: ${manifest.traceId}`);
  if (manifest.startStatus) lines.push(`start_status: ${manifest.startStatus}`);
  if (manifest.taskBrief) lines.push(`task_brief: ${manifest.taskBrief}`);
  if (manifest.terminalBriefTitle) lines.push(`terminal_brief_title: ${manifest.terminalBriefTitle}`);
  if (manifest.parentRoundProgress && manifest.parentRoundTotal) lines.push(`parent_round_progress: ${manifest.parentRoundProgress}/${manifest.parentRoundTotal}`);
  if (manifest.parentRoundOrder) lines.push(`parent_round_order: ${manifest.parentRoundOrder}`);
  if (manifest.crossBrokerHandoff) {
    const handoff = manifest.crossBrokerHandoff;
    const parts = [
      `parent=${handoff.parentRoundId}`,
      `origin=${handoff.originBrokerId}`,
      handoff.handoffBrokerId ? `handoff=${handoff.handoffBrokerId}` : undefined,
      handoff.originTaskId ? `origin_task=${handoff.originTaskId}` : undefined,
      handoff.childWorkerId ? `child_worker=${handoff.childWorkerId}` : undefined,
    ].filter(Boolean);
    lines.push(`cross_broker_handoff: ${parts.join("; ")}`);
  }
  if (manifest.notificationOwnership) {
    lines.push(`notification_owner: ${manifest.notificationOwnership.ownerBrokerId} (${manifest.notificationOwnership.scope}; provider_send_by_projection=false; terminal_ack_by_projection=false)`);
  }
  if (manifest.terminalStatus) lines.push(`terminal_status: ${manifest.terminalStatus}`);
  if (manifest.terminalOutboxCursor) lines.push(`terminal_outbox_cursor: ${manifest.terminalOutboxCursor}`);
  if (manifest.receiptStatus) lines.push(`receipt_status: ${manifest.receiptStatus}`);
  if (renderedAt) lines.push(`rendered_at: ${safeText(renderedAt)}`);

  const evidenceLines = renderEvidenceLines(manifest);
  if (evidenceLines.length > 0) {
    lines.push("evidence:");
    lines.push(...evidenceLines.map((line) => `- ${line}`));
  }

  lines.push(`manifest_sha256: ${manifestSha256}`);
  lines.push("non_ack_semantics:");
  lines.push("- GitHub comments are evidence ledger entries only.");
  lines.push("- This comment is not a Terminal Brief ACK, read receipt, visibility proof, or operator approval.");
  lines.push("- Posting/replaying this comment must not call terminal ACK APIs or mutate production/provider state.");
  lines.push("manifest_json:");
  lines.push("```json");
  lines.push(stableStringify(redactSensitive(manifest)));
  lines.push("```");

  return redactCommentText(lines.join("\n"));
}

function renderEvidenceLines(manifest: TerminalBriefGitHubEvidenceManifest): string[] {
  const lines: string[] = [];
  if (manifest.evidenceUrls.pullRequest) lines.push(`pull_request: ${manifest.evidenceUrls.pullRequest}`);
  if (manifest.evidenceUrls.done) lines.push(`done: ${manifest.evidenceUrls.done}`);
  if (manifest.evidenceUrls.block) lines.push(`block: ${manifest.evidenceUrls.block}`);
  if (lines.length === 0) lines.push(`${manifest.marker}: manifest-bound status evidence`);
  return lines;
}

function findExistingProjectionComment(
  projection: TerminalBriefGitHubEvidenceProjection,
  comments: GitHubIssueCommentObservation[],
): GitHubIssueCommentObservation | undefined {
  return comments.find((comment) =>
    comment.body.includes(MARKER_PREFIX) && comment.body.includes(`key=${projection.idempotencyKey}`),
  );
}

function buildIdempotencyKey(manifest: TerminalBriefGitHubEvidenceManifest, manifestSha256: string): string {
  const sourceKey = manifest.terminalOutboxCursor ?? `${manifest.run ?? "no-run"}:${manifest.taskId}`;
  return [
    "terminal-brief",
    manifest.source,
    manifest.repo,
    String(manifest.issueOrPrNumber),
    manifest.marker,
    sourceKey,
    manifestSha256.slice(0, 16),
  ]
    .map((part) => encodeURIComponent(part))
    .join(":");
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortForStableJson(value));
}

function sortForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForStableJson);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const sorted = sortForStableJson(value[key]);
    if (sorted !== undefined) out[key] = sorted;
  }
  return out;
}

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    const stripped = stripUndefined(raw);
    if (stripped !== undefined) out[key] = stripped;
  }
  return out;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function boundCommentLength(body: string): string {
  if (body.length <= MAX_COMMENT_CHARS) return body;
  const headRoom = MAX_COMMENT_CHARS - TRUNCATION_MARKER.length;
  return body.slice(0, Math.max(0, headRoom)) + TRUNCATION_MARKER;
}

function safeUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (!URL_RE.test(value)) return undefined;
  return redactCommentText(value);
}

function safeText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const redacted = redactCommentText(value).trim().replace(/\s+/g, " ");
  return redacted.length > 0 ? redacted.slice(0, 500) : undefined;
}

function safePositiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && Number.isFinite(value)
    ? value
    : undefined;
}

function safeNotificationOwnership(value: unknown): TerminalBriefGitHubEvidenceManifest["notificationOwnership"] | undefined {
  if (!isRecord(value)) return undefined;
  const ownerBrokerId = safeText(value.ownerBrokerId);
  if (!ownerBrokerId || value.scope !== "parent-broker-only") return undefined;
  return {
    ownerBrokerId,
    scope: "parent-broker-only",
    providerSendPermittedByProjection: false,
    terminalAckPermittedByProjection: false,
  };
}

function safeCrossBrokerHandoff(value: unknown): TerminalBriefGitHubEvidenceManifest["crossBrokerHandoff"] | undefined {
  if (!isRecord(value)) return undefined;
  const parentRoundId = safeText(value.parentRoundId);
  const originBrokerId = safeText(value.originBrokerId);
  if (!parentRoundId || !originBrokerId) return undefined;
  return stripUndefined({
    parentRoundId,
    originBrokerId,
    handoffBrokerId: safeText(value.handoffBrokerId),
    originTaskId: safeText(value.originTaskId),
    childWorkerId: safeText(value.childWorkerId),
  }) as TerminalBriefGitHubEvidenceManifest["crossBrokerHandoff"];
}

function redactCommentText(value: string): string {
  return value
    .replace(/\b(?:(?:ghp|gho|ghu|ghs|ghr)_|github_pat_)[-_A-Za-z0-9]+\b/g, "[REDACTED]")
    .replace(/\b(?:sk|xox[abp])-[-_A-Za-z0-9]+\b/g, "[REDACTED]")
    .replace(/\b(token|secret|password|api[_-]?key|authorization|credential)\s*[:=]\s*\S+/gi, "$1=[REDACTED]");
}

function visitForUnsafePaths(value: unknown, found: Set<string>): void {
  if (typeof value === "string") {
    for (const match of value.matchAll(UNSAFE_OPENCLAW_RUNTIME_PATH_RE)) {
      found.add(match[2]);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) visitForUnsafePaths(item, found);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, raw] of Object.entries(value)) {
    visitForUnsafePaths(key, found);
    visitForUnsafePaths(raw, found);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
