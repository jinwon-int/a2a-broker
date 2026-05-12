/**
 * Default-off safety validation for durable Gwakga → Seoseo handoff receiver input.
 *
 * This module is intentionally pure: it does not create tasks, mutate broker
 * state, post comments, read secrets, or call remote systems. A durable receiver
 * can use it before accepting a GitHub comment/manifest into the Seoseo broker
 * inbox and before returning sanitized evidence to a parent issue.
 */

export const GWAKGA_SEOSEO_RECEIVER_STATUSES = [
  "accepted",
  "running",
  "pr-open",
  "done",
  "blocked",
] as const;

export type GwakgaSeoseoReceiverStatus = typeof GWAKGA_SEOSEO_RECEIVER_STATUSES[number];

export interface GwakgaSeoseoHandoffCandidate {
  brokerOfRecord?: string;
  requestedByBroker?: string;
  requestingAgent?: string;
  sourceTaskId?: string;
  targetTaskId?: string;
  targetTeam?: string;
  targetWorker?: string;
  handoffReason?: string;
  status?: string;
  idempotencyKey?: string;
  evidenceUrls?: string[];
  /** Original comment or manifest text; scanned for accidental secret leakage. */
  rawText?: string;
}

export interface GwakgaSeoseoHandoffReceiverOptions {
  brokerOfRecord?: string;
  requestedByBroker?: string;
  targetTeam?: string;
  allowedWorkers: readonly string[];
  knownIdempotencyKeys?: ReadonlySet<string>;
}

export interface GwakgaSeoseoHandoffValidationResult {
  ok: boolean;
  status: GwakgaSeoseoReceiverStatus | "rejected";
  reason?: string;
  sanitizedCandidate?: GwakgaSeoseoHandoffCandidate;
}

const DEFAULT_BROKER_OF_RECORD = "seoseo";
const DEFAULT_REQUESTED_BY_BROKER = "gwakga";
const DEFAULT_TARGET_TEAM = "team1";
const REDACTED = "<redacted>";

const SECRET_PATTERNS: RegExp[] = [
  /\b(?:A2A_)?(?:BROKER_)?EDGE_SECRET\s*[:=]\s*[^\s,;]+/gi,
  /\b(?:gho|ghp|github_pat)_[A-Za-z0-9_]+/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\bX-A2A-Edge-Secret\s*[:=]\s*[^\s,;]+/gi,
];

export function redactHandoffReceiverSecrets(value: string): string {
  return SECRET_PATTERNS.reduce((text, pattern) => text.replace(pattern, REDACTED), value);
}

export function validateGwakgaSeoseoHandoffCandidate(
  candidate: GwakgaSeoseoHandoffCandidate,
  opts: GwakgaSeoseoHandoffReceiverOptions,
): GwakgaSeoseoHandoffValidationResult {
  const sanitizedCandidate = sanitizeCandidate(candidate);
  const brokerOfRecord = opts.brokerOfRecord ?? DEFAULT_BROKER_OF_RECORD;
  const requestedByBroker = opts.requestedByBroker ?? DEFAULT_REQUESTED_BY_BROKER;
  const targetTeam = opts.targetTeam ?? DEFAULT_TARGET_TEAM;
  const status = normalizeStatus(candidate.status);

  if (JSON.stringify(candidate) !== JSON.stringify(sanitizedCandidate)) {
    return reject("secret_redacted", sanitizedCandidate);
  }
  if (candidate.brokerOfRecord !== brokerOfRecord) {
    return reject(`broker_of_record_must_be_${brokerOfRecord}`, sanitizedCandidate);
  }
  if (candidate.requestedByBroker !== requestedByBroker) {
    return reject(`requested_by_broker_must_be_${requestedByBroker}`, sanitizedCandidate);
  }
  if (candidate.targetTeam !== targetTeam) {
    return reject(`target_team_must_be_${targetTeam}`, sanitizedCandidate);
  }
  if (!candidate.idempotencyKey?.trim()) {
    return reject("missing_idempotency_key", sanitizedCandidate);
  }
  if (opts.knownIdempotencyKeys?.has(candidate.idempotencyKey)) {
    return reject("duplicate_idempotency_key", sanitizedCandidate);
  }
  if (!candidate.targetWorker || !opts.allowedWorkers.includes(candidate.targetWorker)) {
    return reject("unknown_target_worker", sanitizedCandidate);
  }
  if (!candidate.sourceTaskId?.trim()) {
    return reject("missing_source_task_id", sanitizedCandidate);
  }
  if (!candidate.requestingAgent?.trim()) {
    return reject("missing_requesting_agent", sanitizedCandidate);
  }
  if (!candidate.handoffReason?.trim()) {
    return reject("missing_handoff_reason", sanitizedCandidate);
  }
  if (!status) {
    return reject("unsupported_status", sanitizedCandidate);
  }

  return { ok: true, status, sanitizedCandidate };
}

export function parseA2AAssignComment(comment: string): GwakgaSeoseoHandoffCandidate | undefined {
  const line = comment.split(/\r?\n/).find(value => value.trim().startsWith("/a2a assign "));
  if (!line) return undefined;

  const [, targetWorker, rest = ""] = line.trim().match(/^\/a2a\s+assign\s+(\S+)\s*(.*)$/) ?? [];
  if (!targetWorker) return undefined;

  const fields = parseKeyValueFields(rest);
  return {
    brokerOfRecord: fields.brokerOfRecord,
    requestedByBroker: fields.requestedByBroker,
    requestingAgent: fields.requestingAgent,
    sourceTaskId: fields.sourceTaskId,
    targetTaskId: fields.targetTaskId,
    targetTeam: fields.targetTeam,
    targetWorker,
    handoffReason: fields.handoffReason,
    status: fields.status ?? "accepted",
    idempotencyKey: fields.idempotencyKey,
    evidenceUrls: fields.evidenceUrls ? fields.evidenceUrls.split(",").filter(Boolean) : undefined,
    rawText: comment,
  };
}

function sanitizeCandidate(candidate: GwakgaSeoseoHandoffCandidate): GwakgaSeoseoHandoffCandidate {
  return Object.fromEntries(
    Object.entries(candidate).map(([key, value]) => {
      if (typeof value === "string") return [key, redactHandoffReceiverSecrets(value)];
      if (Array.isArray(value)) return [key, value.map(item => typeof item === "string" ? redactHandoffReceiverSecrets(item) : item)];
      return [key, value];
    }),
  ) as GwakgaSeoseoHandoffCandidate;
}

function normalizeStatus(status: string | undefined): GwakgaSeoseoReceiverStatus | undefined {
  const value = status ?? "accepted";
  return GWAKGA_SEOSEO_RECEIVER_STATUSES.includes(value as GwakgaSeoseoReceiverStatus)
    ? value as GwakgaSeoseoReceiverStatus
    : undefined;
}

function reject(reason: string, sanitizedCandidate: GwakgaSeoseoHandoffCandidate): GwakgaSeoseoHandoffValidationResult {
  return { ok: false, status: "rejected", reason, sanitizedCandidate };
}

function parseKeyValueFields(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const matches = text.matchAll(/(\w+)=((?:"[^"]*")|(?:'[^']*')|\S+)/g);
  for (const match of matches) {
    const [, key, rawValue] = match;
    fields[key] = rawValue.replace(/^(["'])(.*)\1$/, "$2");
  }
  return fields;
}
