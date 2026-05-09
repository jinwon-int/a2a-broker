import type {
  A2AExchangeIntent,
  A2APartyRole,
  A2AWorkerEnvironment,
  WorkerCapabilities,
  WorkerMode,
  WorkerStatus,
  WorkerView,
} from "./types.js";
import type { AgentCapabilities, AgentSkill } from "../a2a/agent-card.js";

export const WORKER_CAPABILITY_CARD_SCHEMA_VERSION = "worker-capability-card/v1";

export type WorkerRegistryTeamId = "team1" | "team2";
export type WorkerAssignmentRole = "implementation" | "docs-compat" | "runner-safety" | "libero";
export type WorkerRegistryVisibilityScope = "public" | "team" | "private";
export type LiberoAuthority = "advisory" | "blocking";

export interface WorkerVisibilityFlags {
  /** Public means safe to publish in an AgentCard-style registry. */
  scope: WorkerRegistryVisibilityScope;
  /** Explicit opt-in for discovery; false keeps the card broker-local. */
  safeForDiscovery: boolean;
  /** Broker URLs may be private; only expose after an explicit allow-list review. */
  exposeBrokerUrl: boolean;
  /** Workspace IDs can reveal tenant/project names; default false for public cards. */
  exposeWorkspaceIds: boolean;
  /** Capacity/liveness are hints only, never lease authority. */
  exposeCapacity: boolean;
  exposeLiveness: boolean;
  /** Must stay false; validation fails if a producer tries to expose secrets. */
  exposesSecrets: false;
}

export interface WorkerCapabilityCard {
  schemaVersion: typeof WORKER_CAPABILITY_CARD_SCHEMA_VERSION;
  worker: {
    id: string;
    name?: string;
    role: A2APartyRole;
    mode: WorkerMode;
  };
  team: {
    teamId: WorkerRegistryTeamId;
    brokerOfRecord: string;
    lane: WorkerRegistryTeamId;
  };
  assignment: {
    roles: WorkerAssignmentRole[];
    supportedTaskTypes: A2AExchangeIntent[];
    environments: A2AWorkerEnvironment[];
    libero?: {
      validatesTeams: WorkerRegistryTeamId[];
      authority: LiberoAuthority;
      safeToAssignProduction: boolean;
    };
  };
  capabilities: WorkerCapabilities;
  skills: AgentSkill[];
  safety: {
    canTouchLive: boolean;
    requiresApprovalForLive: boolean;
    boundaries: string[];
  };
  visibility: WorkerVisibilityFlags;
  runtime: {
    containerized?: boolean;
  };
  capacity?: {
    maxConcurrentTasks?: number;
    currentAssignedTasks?: number;
  };
  liveness?: {
    status: WorkerStatus;
    lastSeenAt?: string;
  };
  /** AgentCard-compatible discovery subset; intentionally omits URLs/provider metadata. */
  agentCard: {
    protocolVersion: string;
    capabilities: AgentCapabilities;
    defaultInputModes: string[];
    defaultOutputModes: string[];
    skills: AgentSkill[];
  };
}

export interface CreateWorkerCapabilityCardOptions {
  teamId: WorkerRegistryTeamId;
  brokerOfRecord: string;
  assignmentRoles: WorkerAssignmentRole[];
  supportedTaskTypes: A2AExchangeIntent[];
  skills: AgentSkill[];
  visibility?: Partial<WorkerVisibilityFlags>;
  lane?: WorkerRegistryTeamId;
  mode?: WorkerMode;
  containerized?: boolean;
  maxConcurrentTasks?: number;
  currentAssignedTasks?: number;
  libero?: WorkerCapabilityCard["assignment"]["libero"];
  protocolVersion?: string;
  agentCapabilities?: Partial<AgentCapabilities>;
  safetyBoundaries?: string[];
}

export interface WorkerCapabilityCardValidationResult {
  ok: boolean;
  errors: string[];
}

const DEFAULT_VISIBILITY: WorkerVisibilityFlags = {
  scope: "team",
  safeForDiscovery: false,
  exposeBrokerUrl: false,
  exposeWorkspaceIds: false,
  exposeCapacity: true,
  exposeLiveness: true,
  exposesSecrets: false,
};

const SECRET_KEY_RE = /(secret|token|password|credential|private[_-]?key|api[_-]?key|edge[_-]?secret)/i;
const SECRET_VALUE_RE = /(ghp_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|xox[baprs]-|-----BEGIN [A-Z ]*PRIVATE KEY-----|sk-[A-Za-z0-9]{16,})/;

export function createWorkerCapabilityCard(
  worker: WorkerView,
  options: CreateWorkerCapabilityCardOptions,
): WorkerCapabilityCard {
  const visibility = { ...DEFAULT_VISIBILITY, ...options.visibility } satisfies WorkerVisibilityFlags;
  const skills = options.skills.map(copySkill);
  const capabilities = projectCapabilities(worker.capabilities, visibility);

  return {
    schemaVersion: WORKER_CAPABILITY_CARD_SCHEMA_VERSION,
    worker: {
      id: worker.nodeId,
      name: worker.displayName,
      role: worker.role,
      mode: options.mode ?? worker.workerMode ?? "persistent",
    },
    team: {
      teamId: options.teamId,
      brokerOfRecord: options.brokerOfRecord,
      lane: options.lane ?? options.teamId,
    },
    assignment: {
      roles: uniqueList(options.assignmentRoles),
      supportedTaskTypes: uniqueList(options.supportedTaskTypes),
      environments: capabilities.environments,
      libero: options.libero,
    },
    capabilities,
    skills,
    safety: {
      canTouchLive: capabilities.canPromoteLive || capabilities.environments.includes("live"),
      requiresApprovalForLive: true,
      boundaries: uniqueList(options.safetyBoundaries ?? ["no auto-production-routing", "operator approval required for live impact"]),
    },
    visibility,
    runtime: {
      containerized: options.containerized,
    },
    capacity: visibility.exposeCapacity
      ? {
          maxConcurrentTasks: options.maxConcurrentTasks,
          currentAssignedTasks: options.currentAssignedTasks,
        }
      : undefined,
    liveness: visibility.exposeLiveness
      ? {
          status: worker.status,
          lastSeenAt: worker.lastSeenAt,
        }
      : undefined,
    agentCard: {
      protocolVersion: options.protocolVersion ?? "1.0",
      capabilities: {
        streaming: options.agentCapabilities?.streaming ?? true,
        pushNotifications: options.agentCapabilities?.pushNotifications ?? false,
      },
      defaultInputModes: ["text"],
      defaultOutputModes: ["text"],
      skills,
    },
  };
}

export function validateWorkerCapabilityCard(card: WorkerCapabilityCard): WorkerCapabilityCardValidationResult {
  const errors: string[] = [];

  if (card.schemaVersion !== WORKER_CAPABILITY_CARD_SCHEMA_VERSION) {
    errors.push("schemaVersion must be worker-capability-card/v1");
  }
  if (!card.worker?.id?.trim()) {
    errors.push("worker.id is required");
  }
  if (!card.team?.teamId || !isRegistryTeamId(card.team.teamId)) {
    errors.push("team.teamId must be team1 or team2");
  }
  if (!card.team?.brokerOfRecord?.trim()) {
    errors.push("team.brokerOfRecord is required");
  }
  if (!card.team?.lane || !isRegistryTeamId(card.team.lane)) {
    errors.push("team.lane must be team1 or team2");
  }
  if (!Array.isArray(card.assignment?.roles) || card.assignment.roles.length === 0) {
    errors.push("assignment.roles must include at least one role");
  }
  if (!Array.isArray(card.assignment?.supportedTaskTypes) || card.assignment.supportedTaskTypes.length === 0) {
    errors.push("assignment.supportedTaskTypes must include at least one task type");
  }
  if (card.assignment?.roles?.includes("libero")) {
    if (!card.assignment.libero) {
      errors.push("assignment.libero metadata is required for libero workers");
    } else if (card.assignment.libero.validatesTeams.length === 0) {
      errors.push("assignment.libero.validatesTeams must include team1 or team2");
    }
  }
  if (!card.visibility || card.visibility.exposesSecrets !== false) {
    errors.push("visibility.exposesSecrets must be false");
  }
  if (card.visibility?.scope === "public") {
    if (!card.visibility.safeForDiscovery) {
      errors.push("public cards must set visibility.safeForDiscovery=true");
    }
    if (card.visibility.exposeBrokerUrl) {
      errors.push("public cards must not expose brokerUrl by default");
    }
    if (card.visibility.exposeWorkspaceIds) {
      errors.push("public cards must not expose workspaceIds by default");
    }
  }
  if (!card.safety?.requiresApprovalForLive) {
    errors.push("safety.requiresApprovalForLive must stay true");
  }
  if (card.capabilities?.canPromoteLive && !card.safety?.requiresApprovalForLive) {
    errors.push("live-capable workers require live approval gating");
  }

  for (const path of collectSecretLikePaths(card)) {
    errors.push(`secret-like registry field is not allowed: ${path}`);
  }

  return { ok: errors.length === 0, errors };
}

function projectCapabilities(capabilities: WorkerCapabilities, visibility: WorkerVisibilityFlags): WorkerCapabilities {
  return {
    canAnalyze: capabilities.canAnalyze,
    canBackfill: capabilities.canBackfill,
    canPatchWorkspace: capabilities.canPatchWorkspace,
    canPromoteLive: capabilities.canPromoteLive,
    workspaceIds: visibility.exposeWorkspaceIds ? uniqueList(capabilities.workspaceIds) : [],
    environments: uniqueList(capabilities.environments),
  };
}

function copySkill(skill: AgentSkill): AgentSkill {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    tags: skill.tags ? uniqueList(skill.tags) : undefined,
    examples: skill.examples ? [...skill.examples] : undefined,
  };
}

function uniqueList<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function isRegistryTeamId(value: string): value is WorkerRegistryTeamId {
  return value === "team1" || value === "team2";
}

function collectSecretLikePaths(value: unknown, path = "card"): string[] {
  if (!value || typeof value !== "object") {
    if (typeof value === "string" && SECRET_VALUE_RE.test(value)) {
      return [path];
    }
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectSecretLikePaths(item, `${path}[${index}]`));
  }

  const record = value as Record<string, unknown>;
  const paths: string[] = [];
  for (const [key, child] of Object.entries(record)) {
    const childPath = `${path}.${key}`;
    if (key !== "exposesSecrets" && SECRET_KEY_RE.test(key)) {
      paths.push(childPath);
      continue;
    }
    paths.push(...collectSecretLikePaths(child, childPath));
  }
  return paths;
}
