/**
 * Teleconference fan-in proof and transcript artifact (issue #83).
 *
 * Extends the closeout reconciler concept for multi-agent teleconference:
 * deterministic fan-in of participant contributions into a quorum decision
 * and a redacted transcript artifact.
 */

// ---------------------------------------------------------------------------
// Participant and contribution types
// ---------------------------------------------------------------------------

export type ParticipantRole = "chair" | "presenter" | "reviewer" | "observer";

export type ParticipantStatus = "joined" | "contributing" | "idle" | "left" | "blocked" | "timed_out";

export interface ConferenceParticipant {
  nodeId: string;
  displayName?: string;
  role: ParticipantRole;
  status: ParticipantStatus;
  joinedAt: string;
  lastActiveAt: string;
  leftAt?: string;
}

export interface Contribution {
  id: string;
  participantId: string;
  /** Operator summary. Transcript output always passes this through the default redactor. */
  summary: string;
  /** Contribution category. */
  category: "analysis" | "decision" | "question" | "artifact" | "correction";
  /** Artifact IDs referenced. */
  artifactIds?: string[];
  /** Reply-to contribution ID (threading). */
  replyTo?: string;
  /** Timestamp. */
  createdAt: string;
}

export type QuorumDecision = "ready" | "waiting" | "blocked" | "failed";

export type ConferenceTimeInput = string | number | Date;

export interface ConferenceJoinInput {
  nodeId: string;
  displayName?: string;
  role: ParticipantRole;
  joinedAt?: ConferenceTimeInput;
  lastActiveAt?: ConferenceTimeInput;
}

// ---------------------------------------------------------------------------
// Conference config
// ---------------------------------------------------------------------------

export interface ConferenceConfig {
  /** Minimum participants required for quorum. Default: 2. */
  minQuorum?: number;
  /** Chair must contribute before closeout. Default: true. */
  requireChairContribution?: boolean;
  /** Timeout in ms for active, unsettled participants. Default: 300000 (5min). */
  idleTimeoutMs?: number;
  /** Max contributions per participant. Default: no limit. */
  maxContributionsPerParticipant?: number;
  /** Redaction boundary applied to every transcript summary. */
  redactSummary?: (summary: string) => string;
}

type ResolvedConferenceConfig = {
  minQuorum: number;
  requireChairContribution: boolean;
  idleTimeoutMs: number;
  maxContributionsPerParticipant: number;
  redactSummary: (summary: string) => string;
};

const DEFAULT_CONF: ResolvedConferenceConfig = {
  minQuorum: 2,
  requireChairContribution: true,
  idleTimeoutMs: 300_000,
  maxContributionsPerParticipant: Number.POSITIVE_INFINITY,
  redactSummary: defaultRedactSummary,
};

const TERMINAL_STATUSES = new Set<ParticipantStatus>(["left", "blocked", "timed_out"]);
const SETTLED_STATUSES = new Set<ParticipantStatus>(["idle", "left", "blocked", "timed_out"]);
const EPOCH_MS = Date.UTC(2026, 0, 1, 0, 0, 0, 0);

// ---------------------------------------------------------------------------
// Conference fan-in reconciler
// ---------------------------------------------------------------------------

export interface ConferenceVerdict {
  decision: QuorumDecision;
  reason: string;
  participantCounts: {
    total: number;
    joined: number;
    contributing: number;
    idle: number;
    left: number;
    blocked: number;
    timed_out: number;
  };
  contributionCounts: {
    total: number;
    analysis: number;
    decision: number;
    question: number;
    artifact: number;
    correction: number;
  };
  signals: string[];
  decidedAt: string;
  seq: number;
}

export class ConferenceFanIn {
  private readonly participants = new Map<string, ConferenceParticipant>();
  private readonly contributions: Contribution[] = [];
  private readonly idempotencyKeys = new Set<string>();
  private seq = 0;
  private logicalMs = EPOCH_MS;
  private lastDecisionAt = toIso(EPOCH_MS);
  private readonly config: ResolvedConferenceConfig;

  constructor(config?: ConferenceConfig) {
    this.config = { ...DEFAULT_CONF, ...config };
  }

  // -------------------------------------------------------------------------
  // Participant management
  // -------------------------------------------------------------------------

  /** Register a participant joining the conference. */
  joinParticipant(p: ConferenceJoinInput): ConferenceVerdict {
    const joinedAt = normalizeTime(p.joinedAt ?? this.nextTimestamp());
    const lastActiveAt = normalizeTime(p.lastActiveAt ?? joinedAt);
    this.participants.set(p.nodeId, {
      nodeId: p.nodeId,
      displayName: p.displayName,
      role: p.role,
      status: "joined",
      joinedAt,
      lastActiveAt,
    });
    this.recordMutation(lastActiveAt);
    return this.computeVerdict();
  }

  /** Update participant status. */
  updateParticipant(nodeId: string, status: ParticipantStatus, at?: ConferenceTimeInput): ConferenceVerdict {
    const p = this.participants.get(nodeId);
    if (!p) return this.computeVerdict();
    const timestamp = normalizeTime(at ?? this.nextTimestamp());
    p.status = status;
    p.lastActiveAt = timestamp;
    if (TERMINAL_STATUSES.has(status)) {
      p.leftAt = timestamp;
    }
    this.recordMutation(timestamp);
    return this.computeVerdict();
  }

  /** Mark participant as contributing. */
  markContributing(nodeId: string, at?: ConferenceTimeInput): ConferenceVerdict {
    const p = this.participants.get(nodeId);
    if (!p) return this.computeVerdict();
    const timestamp = normalizeTime(at ?? this.nextTimestamp());
    p.status = "contributing";
    p.lastActiveAt = timestamp;
    this.recordMutation(timestamp);
    return this.computeVerdict();
  }

  /** Reconcile elapsed idleTimeoutMs into concrete timed_out participant states. */
  reconcileTimeouts(at: ConferenceTimeInput = this.lastDecisionAt): ConferenceVerdict {
    const asOf = normalizeTime(at);
    let changed = false;

    for (const p of this.participants.values()) {
      if (!this.isTimeoutEligible(p)) continue;
      if (elapsedMs(p.lastActiveAt, asOf) >= this.config.idleTimeoutMs) {
        p.status = "timed_out";
        p.leftAt = asOf;
        p.lastActiveAt = asOf;
        changed = true;
      }
    }

    if (changed) {
      this.recordMutation(asOf);
    }

    return this.computeVerdict(asOf);
  }

  // -------------------------------------------------------------------------
  // Contribution management
  // -------------------------------------------------------------------------

  /**
   * Add a contribution. Idempotent by (participantId, id) pair.
   * Returns the updated verdict.
   */
  addContribution(c: Contribution): { verdict: ConferenceVerdict; accepted: boolean; reason?: string } {
    const key = `${c.participantId}:${c.id}`;
    if (this.idempotencyKeys.has(key)) {
      return { verdict: this.computeVerdict(), accepted: false, reason: "duplicate" };
    }

    const p = this.participants.get(c.participantId);
    if (!p) {
      return { verdict: this.computeVerdict(), accepted: false, reason: "unknown_participant" };
    }

    const pCount = this.contributions.filter(x => x.participantId === c.participantId).length;
    if (pCount >= this.config.maxContributionsPerParticipant) {
      return { verdict: this.computeVerdict(), accepted: false, reason: "max_contributions" };
    }

    const createdAt = normalizeTime(c.createdAt);
    this.idempotencyKeys.add(key);
    this.contributions.push({ ...c, createdAt });
    p.status = "contributing";
    p.lastActiveAt = createdAt;
    this.recordMutation(createdAt);
    return { verdict: this.computeVerdict(), accepted: true };
  }

  // -------------------------------------------------------------------------
  // Query
  // -------------------------------------------------------------------------

  getParticipants(): ConferenceParticipant[] {
    return sortParticipants([...this.participants.values()]).map(p => ({ ...p }));
  }

  getContributions(): Contribution[] {
    return sortContributions(this.contributions).map(c => ({ ...c, artifactIds: sortedUnique(c.artifactIds ?? []) }));
  }

  getParticipant(nodeId: string): ConferenceParticipant | undefined {
    const p = this.participants.get(nodeId);
    return p ? { ...p } : undefined;
  }

  currentVerdict(asOf?: ConferenceTimeInput): ConferenceVerdict {
    return this.computeVerdict(asOf ? normalizeTime(asOf) : undefined);
  }

  getParticipantCount(): number {
    return this.participants.size;
  }

  reset(): void {
    this.participants.clear();
    this.contributions.length = 0;
    this.idempotencyKeys.clear();
    this.seq = 0;
    this.logicalMs = EPOCH_MS;
    this.lastDecisionAt = toIso(EPOCH_MS);
  }

  // -------------------------------------------------------------------------
  // Transcript artifact
  // -------------------------------------------------------------------------

  /**
   * Produce a deterministic, redacted transcript artifact.
   * No raw session text is emitted; every summary crosses a redaction boundary.
   */
  buildTranscriptArtifact(): TranscriptArtifact {
    const contributions = sortContributions(this.contributions);
    const participants = sortParticipants([...this.participants.values()]);

    return {
      type: "teleconference-transcript",
      generatedAt: this.artifactTimestamp(contributions, participants),
      participants: participants.map(p => ({
        nodeId: p.nodeId,
        displayName: p.displayName,
        role: p.role,
        status: p.status,
        contributionCount: contributions.filter(c => c.participantId === p.nodeId).length,
      })),
      contributions: contributions.map(c => ({
        id: c.id,
        participantId: c.participantId,
        summary: this.config.redactSummary(c.summary),
        category: c.category,
        artifactIds: sortedUnique(c.artifactIds ?? []),
        replyTo: c.replyTo,
        createdAt: normalizeTime(c.createdAt),
      })),
      decisionCategories: this.summarizeCategories(),
      threadCount: contributions.filter(c => c.replyTo).length,
      uniqueArtifacts: sortedUnique(contributions.flatMap(c => c.artifactIds ?? [])),
    };
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private computeVerdict(asOf?: string): ConferenceVerdict {
    const decisionAt = asOf ?? this.lastDecisionAt;
    const parts = this.effectiveParticipants(decisionAt, asOf !== undefined);
    const total = parts.length;

    if (total === 0) {
      return this.verdict("waiting", "No participants", emptyParticipantCounts(), emptyContributionCounts(), [], decisionAt);
    }

    const participantCounts = this.countParticipants(parts);
    const contributionCounts = this.summarizeCategories();
    const signals: string[] = [];

    if (this.config.requireChairContribution) {
      const chair = sortParticipants(parts.filter(p => p.role === "chair"))[0];
      if (!chair) {
        return this.verdict("blocked", "Chair required but not present", participantCounts, contributionCounts, signals, decisionAt);
      }
      const chairContrib = this.hasContribution(chair.nodeId);
      if (!chairContrib) {
        signals.push(`chair:${chair.nodeId}:no_contribution`);
      }
    }

    if (participantCounts.blocked > 0) {
      const blockedParts = sortParticipants(parts.filter(p => p.status === "blocked"));
      signals.push(...blockedParts.map(p => `blocked:${p.nodeId}`));
      return this.verdict("blocked", `${participantCounts.blocked} participant(s) blocked`, participantCounts, contributionCounts, signals, decisionAt);
    }

    if (participantCounts.timed_out > 0) {
      const timedOutParts = sortParticipants(parts.filter(p => p.status === "timed_out"));
      signals.push(...timedOutParts.map(p => `timeout:${p.nodeId}`));
      return this.verdict("blocked", `${participantCounts.timed_out} participant(s) timed out`, participantCounts, contributionCounts, signals, decisionAt);
    }

    const availableForQuorum = parts.filter(p => !TERMINAL_STATUSES.has(p.status)).length;
    const minRequired = this.config.minQuorum;
    if (availableForQuorum < minRequired && participantCounts.left > 0) {
      return this.verdict(
        "failed",
        `Quorum unreachable: ${availableForQuorum} available (need ${minRequired}), ${participantCounts.left} left`,
        participantCounts,
        contributionCounts,
        signals,
        decisionAt,
      );
    }

    if (availableForQuorum < minRequired) {
      return this.verdict("waiting", `Quorum: ${availableForQuorum}/${minRequired} available`, participantCounts, contributionCounts, signals, decisionAt);
    }

    if (this.contributions.length === 0) {
      return this.verdict("waiting", `Quorum met (${availableForQuorum} available) but no contributions`, participantCounts, contributionCounts, signals, decisionAt);
    }

    if (this.config.requireChairContribution) {
      const chair = sortParticipants(parts.filter(p => p.role === "chair"))[0];
      if (chair && !this.hasContribution(chair.nodeId)) {
        return this.verdict("waiting", `Quorum met but chair (${chair.nodeId}) has not contributed`, participantCounts, contributionCounts, signals, decisionAt);
      }
    }

    const awaiting = sortParticipants(
      parts.filter(p => !TERMINAL_STATUSES.has(p.status) && !this.isSettledForReady(p)),
    );
    if (awaiting.length > 0) {
      signals.push(...awaiting.map(p => `awaiting:${p.nodeId}`));
      const stillContributing = awaiting.filter(p => p.status === "contributing").length;
      const reason = stillContributing > 0
        ? `Quorum met, ${stillContributing} still contributing`
        : `Quorum met, awaiting ${awaiting.length} participant(s)`;
      return this.verdict("waiting", reason, participantCounts, contributionCounts, signals, decisionAt);
    }

    return this.verdict("ready", `Quorum met, ${this.contributions.length} contributions received`, participantCounts, contributionCounts, signals, decisionAt);
  }

  private effectiveParticipants(asOf: string, applyTimeouts: boolean): ConferenceParticipant[] {
    return sortParticipants([...this.participants.values()].map(p => {
      if (applyTimeouts && this.isTimeoutEligible(p) && elapsedMs(p.lastActiveAt, asOf) >= this.config.idleTimeoutMs) {
        return { ...p, status: "timed_out", leftAt: asOf, lastActiveAt: asOf };
      }
      return { ...p };
    }));
  }

  private isTimeoutEligible(p: ConferenceParticipant): boolean {
    return !TERMINAL_STATUSES.has(p.status) && p.status !== "idle";
  }

  private isSettledForReady(p: ConferenceParticipant): boolean {
    if (SETTLED_STATUSES.has(p.status)) return true;
    if (!this.hasContribution(p.nodeId)) return false;
    return p.status !== "contributing";
  }

  private hasContribution(nodeId: string): boolean {
    return this.contributions.some(c => c.participantId === nodeId);
  }

  private countParticipants(parts: ConferenceParticipant[]): ConferenceVerdict["participantCounts"] {
    const counts = emptyParticipantCounts();
    counts.total = parts.length;
    for (const p of parts) {
      counts[p.status]++;
    }
    return counts;
  }

  private summarizeCategories(): ConferenceVerdict["contributionCounts"] {
    const counts = emptyContributionCounts();
    counts.total = this.contributions.length;
    for (const c of this.contributions) {
      counts[c.category]++;
    }
    return counts;
  }

  private verdict(
    decision: QuorumDecision,
    reason: string,
    participantCounts: ConferenceVerdict["participantCounts"],
    contributionCounts: ConferenceVerdict["contributionCounts"],
    signals: string[],
    decidedAt: string,
  ): ConferenceVerdict {
    return { decision, reason, participantCounts, contributionCounts, signals: [...signals].sort(), decidedAt: normalizeTime(decidedAt), seq: this.seq };
  }

  private nextTimestamp(): string {
    this.logicalMs += 1;
    return toIso(this.logicalMs);
  }

  private recordMutation(at: string): void {
    this.seq++;
    if (timestampMs(at) >= timestampMs(this.lastDecisionAt)) {
      this.lastDecisionAt = normalizeTime(at);
    }
  }

  private artifactTimestamp(contributions: readonly Contribution[], participants: readonly ConferenceParticipant[]): string {
    const timestamps = [
      this.lastDecisionAt,
      ...contributions.map(c => c.createdAt),
      ...participants.flatMap(p => [p.joinedAt, p.lastActiveAt, p.leftAt].filter((x): x is string => Boolean(x))),
    ];
    return maxTimestamp(timestamps);
  }
}

// ---------------------------------------------------------------------------
// Transcript artifact type
// ---------------------------------------------------------------------------

export interface TranscriptArtifact {
  type: "teleconference-transcript";
  generatedAt: string;
  participants: Array<{
    nodeId: string;
    displayName?: string;
    role: ParticipantRole;
    status: ParticipantStatus;
    contributionCount: number;
  }>;
  contributions: Array<{
    id: string;
    participantId: string;
    summary: string;
    category: string;
    artifactIds: string[];
    replyTo?: string;
    createdAt: string;
  }>;
  decisionCategories: {
    total: number;
    analysis: number;
    decision: number;
    question: number;
    artifact: number;
    correction: number;
  };
  threadCount: number;
  uniqueArtifacts: string[];
}

// ---------------------------------------------------------------------------
// Comment formatter
// ---------------------------------------------------------------------------

export function formatConferenceComment(verdict: ConferenceVerdict, transcript?: TranscriptArtifact): string {
  const icon = { ready: "✅", waiting: "⏳", blocked: "🚫", failed: "❌" }[verdict.decision];
  const p = verdict.participantCounts;
  const c = verdict.contributionCounts;

  const lines = [
    `${icon} **Teleconference: ${verdict.decision.toUpperCase()}**`,
    `> ${verdict.reason}`,
    `> Participants: ${p.joined} joined, ${p.contributing} active, ${p.idle} idle, ${p.left} left, ${p.blocked} blocked, ${p.timed_out} timed-out`,
    `> Contributions: ${c.total} (${c.analysis} analysis, ${c.decision} decisions, ${c.question} questions, ${c.artifact} artifacts, ${c.correction} corrections)`,
  ];

  if (transcript) {
    lines.push(`> Threads: ${transcript.threadCount} | Artifacts: ${transcript.uniqueArtifacts.length}`);
  }

  if (verdict.signals.length > 0) {
    lines.push(`> Signals: ${verdict.signals.join(", ")}`);
  }

  return lines.join("\n");
}

export function defaultRedactSummary(summary: string): string {
  const scrubbed = summary
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\[(?:private|raw|secret)\][\s\S]*?\[\/(?:private|raw|secret)\]/gi, "[REDACTED]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]")
    .replace(/\b(?:\+?82[-.\s]?)?0?1[016789][-.\s]?\d{3,4}[-.\s]?\d{4}\b/g, "[REDACTED_PHONE]")
    .replace(/\b\d{6}[-\s]?\d{7}\b/g, "[REDACTED_ID]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})\b/g, "[REDACTED_TOKEN]")
    .replace(/\b(?:bearer|token|api[_-]?key|secret|password)\s*[:=]\s*\S+/gi, "$1=[REDACTED]")
    .replace(/\b(?:raw|private)\s*[:=]\s*[^.;\n]+/gi, "[REDACTED]")
    .replace(/https?:\/\/\S+/gi, url => redactUrl(url))
    .replace(/\s+/g, " ")
    .trim();

  if (scrubbed.length <= 480) return scrubbed;
  return `${scrubbed.slice(0, 477).trimEnd()}...`;
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = url.search ? "?redacted" : "";
    return url.toString();
  } catch {
    return "[REDACTED_URL]";
  }
}

function sortParticipants(parts: readonly ConferenceParticipant[]): ConferenceParticipant[] {
  return [...parts].sort((a, b) => compareStrings(a.nodeId, b.nodeId) || compareStrings(a.role, b.role));
}

function sortContributions(contributions: readonly Contribution[]): Contribution[] {
  return [...contributions].sort(
    (a, b) => timestampMs(a.createdAt) - timestampMs(b.createdAt)
      || compareStrings(a.participantId, b.participantId)
      || compareStrings(a.id, b.id)
      || compareStrings(a.category, b.category),
  );
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareStrings);
}

function emptyParticipantCounts(): ConferenceVerdict["participantCounts"] {
  return { total: 0, joined: 0, contributing: 0, idle: 0, left: 0, blocked: 0, timed_out: 0 };
}

function emptyContributionCounts(): ConferenceVerdict["contributionCounts"] {
  return { total: 0, analysis: 0, decision: 0, question: 0, artifact: 0, correction: 0 };
}

function elapsedMs(from: string, to: string): number {
  return timestampMs(to) - timestampMs(from);
}

function maxTimestamp(values: readonly string[]): string {
  const maxMs = values.map(timestampMs).reduce((max, value) => Math.max(max, value), EPOCH_MS);
  return toIso(maxMs);
}

function normalizeTime(value: ConferenceTimeInput): string {
  return toIso(timestampMs(value));
}

function timestampMs(value: ConferenceTimeInput): number {
  if (value instanceof Date) {
    const ms = value.getTime();
    if (Number.isFinite(ms)) return ms;
  } else if (typeof value === "number") {
    if (Number.isFinite(value)) return value;
  } else {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  throw new Error(`Invalid conference timestamp: ${String(value)}`);
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

function compareStrings(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: false, sensitivity: "variant" });
}
