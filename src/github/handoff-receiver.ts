import type { InMemoryA2ABroker } from "../core/broker.js";
import type {
  A2AExchangeIntent,
  CreateTaskRequest,
  TaskRecord,
  TaskStatus,
} from "../core/types.js";
import { parseAssignmentIntents, type AssignmentIntent } from "./ingestion.js";
import type { GitHubDeliveryContext, GitHubIssueCommentEvent } from "./types.js";

export type HandoffEvidenceStatus = "accepted" | "running" | "pr-open" | "done" | "blocked";

export type HandoffReceiverSkippedReason =
  | "no_handoff_manifest"
  | "no_assignment_command"
  | "unknown_worker"
  | "wrong_broker_of_record"
  | "wrong_target_team"
  | "missing_idempotency_key";

export interface GwakgaSeoseoHandoffManifest {
  brokerOfRecord?: string;
  requestedByBroker?: string;
  requestingAgent?: string;
  sourceTaskId?: string;
  targetTaskId?: string;
  targetTeam?: string;
  handoffReason?: string;
  status?: string;
  idempotencyKey?: string;
  evidence: string[];
  /** Optional structured-manifest-only target. `/a2a assign <worker>` remains preferred. */
  targetWorker?: string;
  /** Parent round identifier for Terminal Brief aggregation. */
  parentRoundId?: string;
  /** Total worker/task count expected for the parent round (denominator). */
  parentRoundTotal?: number | string;
}

export interface HandoffReceiverOptions {
  broker: InMemoryA2ABroker;
  /** Local broker expected to own created tasks. Defaults to `seoseo`. */
  brokerOfRecord?: string;
  /** Local team/tenant expected to own created tasks. Defaults to `team1`. */
  targetTeam?: string;
  /** Remote broker allowed to request this handoff. Defaults to `gwakga`. */
  requestedByBroker?: string;
  /** Intent used when a `/a2a assign` command omits `--intent`. */
  defaultIntent?: A2AExchangeIntent;
  /** Service requester id used when the manifest omits `requestingAgent`. */
  requesterId?: string;
}

export interface HandoffReceiveInput {
  body: string;
  repoFullName: string;
  issueNumber: number;
  issueUrl: string;
  commentId?: number;
  commentUrl?: string;
  ctx: GitHubDeliveryContext;
}

export interface HandoffEvidenceEntry {
  workerId: string;
  targetTaskId: string;
  status: HandoffEvidenceStatus;
  evidenceUrl?: string;
}

export interface HandoffReceiveResult {
  accepted: boolean;
  replayed: boolean;
  skippedReason?: HandoffReceiverSkippedReason;
  manifest?: GwakgaSeoseoHandoffManifest;
  targetTaskIds: string[];
  evidence: HandoffEvidenceEntry[];
  evidenceCommentBody?: string;
}

const MANIFEST_KEYS = new Set([
  "brokerOfRecord",
  "requestedByBroker",
  "requestingAgent",
  "sourceTaskId",
  "targetTaskId",
  "targetTeam",
  "handoffReason",
  "status",
  "idempotencyKey",
  "targetWorker",
  "targetWorkerId",
  "targetNodeId",
  "worker",
  "parentRoundId",
  "parentRoundTotal",
]);

export class GwakgaSeoseoHandoffReceiver {
  private readonly broker: InMemoryA2ABroker;
  private readonly brokerOfRecord: string;
  private readonly targetTeam: string;
  private readonly requestedByBroker: string;
  private readonly defaultIntent: A2AExchangeIntent;
  private readonly requesterId: string;

  constructor(options: HandoffReceiverOptions) {
    this.broker = options.broker;
    this.brokerOfRecord = options.brokerOfRecord ?? "seoseo";
    this.targetTeam = options.targetTeam ?? "team1";
    this.requestedByBroker = options.requestedByBroker ?? "gwakga";
    this.defaultIntent = options.defaultIntent ?? "propose_patch";
    this.requesterId = options.requesterId ?? "gwakga-seoseo-handoff-receiver";
  }

  receiveIssueComment(event: GitHubIssueCommentEvent, ctx: GitHubDeliveryContext): HandoffReceiveResult {
    return this.receive({
      body: event.comment.body,
      repoFullName: event.repo.fullName,
      issueNumber: event.issue.number,
      issueUrl: event.issue.htmlUrl,
      commentId: event.comment.id,
      commentUrl: event.comment.htmlUrl,
      ctx,
    });
  }

  receive(input: HandoffReceiveInput): HandoffReceiveResult {
    const manifest = parseGwakgaSeoseoHandoffManifest(input.body);
    if (!manifest) {
      return emptyResult("no_handoff_manifest");
    }

    const brokerOfRecord = normalizeString(manifest.brokerOfRecord);
    if (brokerOfRecord !== this.brokerOfRecord) {
      return emptyResult("wrong_broker_of_record", manifest);
    }
    const requestedByBroker = normalizeString(manifest.requestedByBroker);
    if (requestedByBroker && requestedByBroker !== this.requestedByBroker) {
      return emptyResult("wrong_broker_of_record", manifest);
    }
    const targetTeam = normalizeString(manifest.targetTeam);
    if (targetTeam !== this.targetTeam) {
      return emptyResult("wrong_target_team", manifest);
    }
    const idempotencyKey = normalizeString(manifest.idempotencyKey);
    if (!idempotencyKey) {
      return emptyResult("missing_idempotency_key", manifest);
    }

    const intents = parseAssignmentIntents(input.body);
    const assignmentIntents = intents.length > 0 ? intents : manifest.targetWorker ? [intentFromManifest(manifest)] : [];
    if (assignmentIntents.length === 0) {
      return emptyResult("no_assignment_command", manifest);
    }

    const targetTaskIds: string[] = [];
    const evidence: HandoffEvidenceEntry[] = [];
    let replayed = false;

    for (let index = 0; index < assignmentIntents.length; index++) {
      const intent = assignmentIntents[index]!;
      const worker = this.broker.getWorker(intent.target);
      if (!worker) {
        return emptyResult("unknown_worker", manifest);
      }
      const workerTeam = normalizeString(worker.metadata?.teamId);
      if (workerTeam && workerTeam !== this.targetTeam) {
        return emptyResult("wrong_target_team", manifest);
      }
      const workerBroker = normalizeString(worker.metadata?.brokerOfRecord ?? worker.metadata?.brokerId ?? worker.metadata?.homeBrokerId);
      if (workerBroker && workerBroker !== this.brokerOfRecord) {
        return emptyResult("wrong_broker_of_record", manifest);
      }

      const taskId = taskIdForHandoff(manifest, intent.target, index, assignmentIntents.length);
      const existing = this.broker.getTask(taskId);
      const task = existing ?? this.createTask({ input, manifest, intent, taskId, index });
      if (existing) replayed = true;
      targetTaskIds.push(task.id);
      evidence.push({
        workerId: task.assignedWorkerId ?? task.targetNodeId,
        targetTaskId: task.id,
        status: toEvidenceStatus(task),
        ...(extractEvidenceUrl(task) ? { evidenceUrl: extractEvidenceUrl(task)! } : {}),
      });
    }

    const result: HandoffReceiveResult = {
      accepted: true,
      replayed,
      manifest,
      targetTaskIds,
      evidence,
    };
    return {
      ...result,
      evidenceCommentBody: renderHandoffEvidenceComment(result),
    };
  }

  private createTask(args: {
    input: HandoffReceiveInput;
    manifest: GwakgaSeoseoHandoffManifest;
    intent: AssignmentIntent;
    taskId: string;
    index: number;
  }): TaskRecord {
    const { input, manifest, intent, taskId, index } = args;
    const message = redactHandoffText(intent.message ?? intent.raw);
    const requesterId = normalizeString(manifest.requestingAgent) ?? this.requesterId;
    const request: CreateTaskRequest = {
      id: taskId,
      intent: intent.intent ?? this.defaultIntent,
      requester: { id: requesterId, kind: "service", role: "operator" },
      target: { id: intent.target, kind: "node" },
      assignedWorkerId: intent.target,
      message,
      taskOrigin: "github",
      brokerOfRecord: this.brokerOfRecord,
      teamId: this.targetTeam,
      payload: {
        handoffKind: "gwakga-seoseo",
        brokerOfRecord: this.brokerOfRecord,
        requestedByBroker: normalizeString(manifest.requestedByBroker),
        requestingAgent: requesterId,
        sourceTaskId: redactHandoffText(normalizeString(manifest.sourceTaskId) ?? input.issueUrl),
        requestedTargetTaskId: redactHandoffText(normalizeString(manifest.targetTaskId) ?? ""),
        targetTeam: this.targetTeam,
        handoffReason: redactHandoffText(normalizeString(manifest.handoffReason) ?? ""),
        handoffStatus: normalizeString(manifest.status) ?? "requested",
        idempotencyKey: normalizeString(manifest.idempotencyKey),
        evidenceUrls: manifest.evidence.map(redactHandoffText),
        ...(intent.intent === "propose_patch" || (!intent.intent && this.defaultIntent === "propose_patch")
          ? { mode: "github-propose-patch", repo: input.repoFullName, issue: `#${input.issueNumber}`, issueNumber: input.issueNumber, issueUrl: input.issueUrl }
          : {}),
        githubDeliveryId: input.ctx.deliveryId,
        githubReceivedAt: input.ctx.receivedAt,
        githubRepo: input.repoFullName,
        githubIssueNumber: input.issueNumber,
        githubIssueUrl: input.issueUrl,
        githubWorkMode: intent.workMode,
        githubKind: "handoff",
        ...(input.commentId !== undefined ? { githubCommentId: input.commentId } : {}),
        ...(input.commentUrl ? { githubCommentUrl: input.commentUrl } : {}),
        githubCommandIndex: index,
        ...(manifest.parentRoundId ? { parentRoundId: manifest.parentRoundId } : {}),
        ...(manifest.parentRoundTotal ? { parentRoundTotal: manifest.parentRoundTotal } : {}),
      },
    };
    return this.broker.createTask(request);
  }
}

export function parseGwakgaSeoseoHandoffManifest(text: string | null | undefined): GwakgaSeoseoHandoffManifest | null {
  if (!text) return null;
  for (const block of manifestCandidateBlocks(text)) {
    const parsed = parseManifestBlock(block);
    if (parsed) return parsed;
  }
  return null;
}

export function renderHandoffEvidenceComment(result: Pick<HandoffReceiveResult, "manifest" | "evidence">): string {
  const manifest = result.manifest;
  const header = "[a2a:Gwakga→Seoseo handoff]";
  const lines = [header];
  if (manifest) {
    lines.push(`brokerOfRecord: ${redactHandoffText(manifest.brokerOfRecord ?? "")}`);
    lines.push(`requestedByBroker: ${redactHandoffText(manifest.requestedByBroker ?? "")}`);
    lines.push(`targetTeam: ${redactHandoffText(manifest.targetTeam ?? "")}`);
    lines.push(`idempotencyKey: ${redactHandoffText(manifest.idempotencyKey ?? "")}`);
    if (manifest.sourceTaskId) lines.push(`sourceTaskId: ${redactHandoffText(manifest.sourceTaskId)}`);
    if (manifest.parentRoundId) lines.push(`parentRoundId: ${redactHandoffText(manifest.parentRoundId)}`);
    if (manifest.parentRoundTotal !== undefined && manifest.parentRoundTotal !== null) lines.push(`parentRoundTotal: ${String(manifest.parentRoundTotal)}`);
  }
  lines.push("targetTasks:");
  for (const entry of result.evidence) {
    const suffix = entry.evidenceUrl ? ` evidence=${redactHandoffText(entry.evidenceUrl)}` : "";
    lines.push(`- worker=${redactHandoffText(entry.workerId)} targetTaskId=${redactHandoffText(entry.targetTaskId)} status=${entry.status}${suffix}`);
  }
  return lines.join("\n");
}

export function redactHandoffText(value: string): string {
  return value
    .replace(/\b((?:edge[_-]?secret|secret|token|api[_-]?key|password|authorization))\s*[:=]\s*("[^"]*"|'[^']*'|`[^`]*`|[^\s,;]+)/gi, "$1=[REDACTED]")
    .replace(/\b(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]+/g, "[REDACTED]");
}

function manifestCandidateBlocks(text: string): string[] {
  const blocks: string[] = [];
  const fence = /```(?:yaml|yml|json)?\s*\n([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(text)) !== null) {
    blocks.push(match[1]!);
  }
  blocks.push(text);
  return blocks;
}

function parseManifestBlock(block: string): GwakgaSeoseoHandoffManifest | null {
  const fields: Record<string, string> = {};
  const evidence: string[] = [];
  let inEvidence = false;

  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const kv = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (kv) {
      inEvidence = kv[1] === "evidence";
      if (inEvidence) {
        const inline = stripValue(kv[2] ?? "");
        if (inline && inline !== "[]") evidence.push(inline);
      } else if (MANIFEST_KEYS.has(kv[1]!)) {
        fields[canonicalKey(kv[1]!)] = stripValue(kv[2] ?? "");
      }
      continue;
    }
    if (inEvidence) {
      const item = line.match(/^-\s*(.+)$/);
      if (item) evidence.push(stripValue(item[1]!));
    }
  }

  if (!fields.brokerOfRecord && !fields.requestedByBroker && !fields.targetTeam && !fields.idempotencyKey) {
    return null;
  }

  return {
    ...(fields.brokerOfRecord ? { brokerOfRecord: fields.brokerOfRecord } : {}),
    ...(fields.requestedByBroker ? { requestedByBroker: fields.requestedByBroker } : {}),
    ...(fields.requestingAgent ? { requestingAgent: fields.requestingAgent } : {}),
    ...(fields.sourceTaskId ? { sourceTaskId: fields.sourceTaskId } : {}),
    ...(fields.targetTaskId ? { targetTaskId: fields.targetTaskId } : {}),
    ...(fields.targetTeam ? { targetTeam: fields.targetTeam } : {}),
    ...(fields.handoffReason ? { handoffReason: fields.handoffReason } : {}),
    ...(fields.status ? { status: fields.status } : {}),
    ...(fields.idempotencyKey ? { idempotencyKey: fields.idempotencyKey } : {}),
    ...(fields.targetWorker ? { targetWorker: fields.targetWorker } : {}),
    ...(fields.parentRoundId ? { parentRoundId: fields.parentRoundId } : {}),
    ...(fields.parentRoundTotal ? { parentRoundTotal: fields.parentRoundTotal } : {}),
    evidence,
  };
}

function canonicalKey(key: string): string {
  if (key === "targetWorkerId" || key === "targetNodeId" || key === "worker") return "targetWorker";
  return key;
}

function stripValue(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
      (trimmed.startsWith("`") && trimmed.endsWith("`"))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function intentFromManifest(manifest: GwakgaSeoseoHandoffManifest): AssignmentIntent {
  return {
    raw: `structured handoff for ${manifest.targetWorker}`,
    target: manifest.targetWorker!,
    workMode: "github",
    args: {},
    ...(manifest.handoffReason ? { message: manifest.handoffReason } : {}),
  };
}

function taskIdForHandoff(
  manifest: GwakgaSeoseoHandoffManifest,
  workerId: string,
  index: number,
  count: number,
): string {
  const explicit = normalizeString(manifest.targetTaskId);
  if (explicit && count === 1) return explicit;
  const key = slugForId(normalizeString(manifest.idempotencyKey) ?? "handoff");
  return `handoff-${key}-${slugForId(workerId)}-${index}`;
}

function toEvidenceStatus(task: TaskRecord): HandoffEvidenceStatus {
  switch (task.status as TaskStatus) {
    case "claimed":
    case "running":
      return "running";
    case "succeeded":
      return extractPullRequestUrl(task) ? "pr-open" : "done";
    case "failed":
    case "canceled":
    case "blocked":
      return "blocked";
    case "queued":
    default:
      return "accepted";
  }
}

function extractEvidenceUrl(task: TaskRecord): string | undefined {
  return extractPullRequestUrl(task) ?? firstString(task.result?.output, ["doneCommentUrl", "blockCommentUrl", "doneUrl", "blockUrl"]);
}

function extractPullRequestUrl(task: TaskRecord): string | undefined {
  const fromOutput = firstString(task.result?.output, ["pullRequestUrl", "prUrl", "pull_request_url"]);
  if (fromOutput && /\/pull\/\d+/.test(fromOutput)) return fromOutput;
  const summary = task.result?.summary;
  if (typeof summary === "string") {
    const match = summary.match(/https?:\/\/\S*\/pull\/\d+/);
    if (match) return match[0];
  }
  return undefined;
}

function firstString(source: unknown, keys: string[]): string | undefined {
  if (!source || typeof source !== "object") return undefined;
  const record = source as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

function normalizeString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function slugForId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "handoff";
}

function emptyResult(reason: HandoffReceiverSkippedReason, manifest?: GwakgaSeoseoHandoffManifest): HandoffReceiveResult {
  return {
    accepted: false,
    replayed: false,
    skippedReason: reason,
    ...(manifest ? { manifest } : {}),
    targetTaskIds: [],
    evidence: [],
  };
}
