/**
 * Teleconference fan-in proof and transcript artifact (issue #83).
 *
 * Extends the closeout reconciler concept for multi-agent teleconference:
 * deterministic fan-in of participant contributions into a quorum decision
 * and a redacted transcript artifact.
 */

import type { TaskStatus } from "./types.js";
import type {
  CloseoutDecision,
  CloseoutVerdict,
} from "./closeout-reconciler.js";

// ---------------------------------------------------------------------------
// Participant and contribution types
// ---------------------------------------------------------------------------

export type ParticipantRole = "chair" | "presenter" | "reviewer" | "observer";

export type ParticipantStatus = "joined" | "contributing" | "idle" | "left" | "timed_out";

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
  /** Redacted summary — no raw private text. */
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

// ---------------------------------------------------------------------------
// Conference config
// ---------------------------------------------------------------------------

export interface ConferenceConfig {
  /** Minimum participants required for quorum. Default: 2. */
  minQuorum?: number;
  /** Chair must contribute before closeout. Default: true. */
  requireChairContribution?: boolean;
  /** Timeout in ms for idle participants. Default: 300000 (5min). */
  idleTimeoutMs?: number;
  /** Max contributions per participant. Default: no limit. */
  maxContributionsPerParticipant?: number;
}

const DEFAULT_CONF: Required<ConferenceConfig> = {
  minQuorum: 2,
  requireChairContribution: true,
  idleTimeoutMs: 300_000,
  maxContributionsPerParticipant: Infinity,
};

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
  private readonly config: Required<ConferenceConfig>;

  constructor(config?: ConferenceConfig) {
    this.config = { ...DEFAULT_CONF, ...config };
  }

  // -------------------------------------------------------------------------
  // Participant management
  // -------------------------------------------------------------------------

  /** Register a participant joining the conference. */
  joinParticipant(p: Omit<ConferenceParticipant, "status" | "joinedAt" | "lastActiveAt">): ConferenceVerdict {
    const now = new Date().toISOString();
    this.participants.set(p.nodeId, {
      ...p,
      status: "joined",
      joinedAt: now,
      lastActiveAt: now,
    });
    this.seq++;
    return this.computeVerdict();
  }

  /** Update participant status. */
  updateParticipant(nodeId: string, status: ParticipantStatus): ConferenceVerdict {
    const p = this.participants.get(nodeId);
    if (!p) return this.computeVerdict();
    p.status = status;
    p.lastActiveAt = new Date().toISOString();
    if (status === "left" || status === "timed_out") {
      p.leftAt = new Date().toISOString();
    }
    this.seq++;
    return this.computeVerdict();
  }

  /** Mark participant as contributing. */
  markContributing(nodeId: string): ConferenceVerdict {
    const p = this.participants.get(nodeId);
    if (!p) return this.computeVerdict();
    p.status = "contributing";
    p.lastActiveAt = new Date().toISOString();
    this.seq++;
    return this.computeVerdict();
  }

  // -------------------------------------------------------------------------
  // Contribution management
  // -------------------------------------------------------------------------

  /**
   * Add a contribution. Idempotent by (participantId, id) pair.
   * Returns the updated verdict.
   */
  addContribution(c: Contribution): { verdict: ConferenceVerdict; accepted: boolean; reason?: string } {
    // Idempotency
    const key = `${c.participantId}:${c.id}`;
    if (this.idempotencyKeys.has(key)) {
      return { verdict: this.computeVerdict(), accepted: false, reason: "duplicate" };
    }

    // Participant must exist
    const p = this.participants.get(c.participantId);
    if (!p) {
      return { verdict: this.computeVerdict(), accepted: false, reason: "unknown_participant" };
    }

    // Max contributions check
    const pCount = this.contributions.filter(x => x.participantId === c.participantId).length;
    if (pCount >= this.config.maxContributionsPerParticipant) {
      return { verdict: this.computeVerdict(), accepted: false, reason: "max_contributions" };
    }

    this.idempotencyKeys.add(key);
    this.contributions.push(c);
    this.markContributing(c.participantId);
    return { verdict: this.computeVerdict(), accepted: true };
  }

  // -------------------------------------------------------------------------
  // Query
  // -------------------------------------------------------------------------

  getParticipants(): ConferenceParticipant[] {
    return [...this.participants.values()];
  }

  getContributions(): Contribution[] {
    return [...this.contributions];
  }

  getParticipant(nodeId: string): ConferenceParticipant | undefined {
    return this.participants.get(nodeId);
  }

  currentVerdict(): ConferenceVerdict {
    return this.computeVerdict();
  }

  getParticipantCount(): number {
    return this.participants.size;
  }

  reset(): void {
    this.participants.clear();
    this.contributions.length = 0;
    this.idempotencyKeys.clear();
    this.seq = 0;
  }

  // -------------------------------------------------------------------------
  // Transcript artifact
  // -------------------------------------------------------------------------

  /**
   * Produce a redacted transcript artifact.
   * No raw session text — only structured summaries.
   */
  buildTranscriptArtifact(): TranscriptArtifact {
    const contributions = [...this.contributions].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );

    return {
      type: "teleconference-transcript",
      generatedAt: new Date().toISOString(),
      participants: this.getParticipants().map(p => ({
        nodeId: p.nodeId,
        displayName: p.displayName,
        role: p.role,
        status: p.status,
        contributionCount: contributions.filter(c => c.participantId === p.nodeId).length,
      })),
      contributions: contributions.map(c => ({
        id: c.id,
        participantId: c.participantId,
        summary: c.summary,
        category: c.category,
        artifactIds: c.artifactIds,
        replyTo: c.replyTo,
        createdAt: c.createdAt,
      })),
      decisionCategories: this.summarizeCategories(),
      threadCount: contributions.filter(c => c.replyTo).length,
      uniqueArtifacts: [...new Set(contributions.flatMap(c => c.artifactIds ?? []))],
    };
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private computeVerdict(): ConferenceVerdict {
    const parts = [...this.participants.values()];
    const total = parts.length;

    if (total === 0) {
      return this.verdict("waiting", "No participants", { total: 0, joined: 0, contributing: 0, idle: 0, left: 0, timed_out: 0 }, { total: 0, analysis: 0, decision: 0, question: 0, artifact: 0, correction: 0 }, []);
    }

    let joined = 0, contributing = 0, idle = 0, left = 0, timed_out = 0;
    const signals: string[] = [];

    for (const p of parts) {
      switch (p.status) {
        case "joined": joined++; break;
        case "contributing": contributing++; break;
        case "idle": idle++; break;
        case "left": left++; break;
        case "timed_out": timed_out++; break;
      }
    }

    // Blocked: chair required but absent
    if (this.config.requireChairContribution) {
      const chair = parts.find(p => p.role === "chair");
      if (!chair) {
        return this.verdict("blocked", "Chair required but not present", { total, joined, contributing, idle, left, timed_out }, this.summarizeCategories(), signals);
      }
      const chairContrib = this.contributions.some(c => c.participantId === chair.nodeId);
      if (!chairContrib && (contributing + joined > 0)) {
        signals.push(`chair:${chair.nodeId}:no_contribution`);
      }
    }

    // Blocked: timed-out participants
    if (timed_out > 0) {
      const timedOutParts = parts.filter(p => p.status === "timed_out");
      signals.push(...timedOutParts.map(p => `timeout:${p.nodeId}`));
      return this.verdict("blocked", `${timed_out} participant(s) timed out`, { total, joined, contributing, idle, left, timed_out }, this.summarizeCategories(), signals);
    }

    // Failed: quorum cannot be reached
    const active = joined + contributing + idle;
    const minRequired = this.config.minQuorum;
    if (active < minRequired && left > 0) {
      return this.verdict("failed", `Quorum unreachable: ${active} active (need ${minRequired}), ${left} left`, { total, joined, contributing, idle, left, timed_out }, this.summarizeCategories(), signals);
    }

    // Waiting: quorum not yet met
    if (active < minRequired) {
      return this.verdict("waiting", `Quorum: ${active}/${minRequired} active`, { total, joined, contributing, idle, left, timed_out }, this.summarizeCategories(), signals);
    }

    // Waiting: quorum met but no contributions yet
    if (this.contributions.length === 0) {
      return this.verdict("waiting", `Quorum met (${active} active) but no contributions`, { total, joined, contributing, idle, left, timed_out }, this.summarizeCategories(), signals);
    }

    // Chair contribution required but not yet received
    if (this.config.requireChairContribution) {
      const chair = parts.find(p => p.role === "chair");
      if (chair && !this.contributions.some(c => c.participantId === chair.nodeId)) {
        return this.verdict("waiting", `Quorum met but chair (${chair.nodeId}) has not contributed`, { total, joined, contributing, idle, left, timed_out }, this.summarizeCategories(), signals);
      }
    }

    // Waiting: some participants still active (contributing)
    if (contributing > 0) {
      return this.verdict("waiting", `Quorum met, ${contributing} still contributing`, { total, joined, contributing, idle, left, timed_out }, this.summarizeCategories(), signals);
    }

    // Ready: quorum met, all active participants have contributed or are idle
    if (signals.length === 0 || signals.every(s => s.startsWith("chair:"))) {
      return this.verdict("ready", `Quorum met, ${this.contributions.length} contributions received`, { total, joined, contributing, idle, left, timed_out }, this.summarizeCategories(), signals);
    }

    return this.verdict("waiting", "Quorum met, awaiting completion", { total, joined, contributing, idle, left, timed_out }, this.summarizeCategories(), signals);
  }

  private summarizeCategories() {
    const counts = { total: this.contributions.length, analysis: 0, decision: 0, question: 0, artifact: 0, correction: 0 };
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
  ): ConferenceVerdict {
    return { decision, reason, participantCounts, contributionCounts, signals, decidedAt: new Date().toISOString(), seq: this.seq };
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
    artifactIds?: string[];
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
    `> Participants: ${p.joined} joined, ${p.contributing} active, ${p.idle} idle, ${p.left} left, ${p.timed_out} timed-out`,
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
