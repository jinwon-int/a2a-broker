export interface AgentProvider {
  organization: string;
  url?: string;
}

export interface AgentCapabilities {
  streaming: boolean;
  pushNotifications: boolean;
}

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  tags?: string[];
  examples?: string[];
}

/**
 * A2A 1.0 AgentCard (public discovery shape).
 *
 * **Naming guard:** `AgentCard.capabilities` carries A2A protocol-level flags
 * (`streaming`, `pushNotifications`). This is deliberately distinct from
 * {@link WorkerCapabilities} (`canAnalyze`, `canBackfill`, …) which describe
 * broker-internal worker runtime abilities. The two capability types MUST NOT
 * be merged into a single shape; they serve different consumers (public A2A
 * clients vs. internal broker scheduler).
 */
export interface AgentCard {
  name: string;
  description: string;
  url: string;
  version: string;
  protocolVersion: string;
  provider?: AgentProvider;
  /** A2A protocol-level capabilities. Not to be confused with worker runtime
   * {@link WorkerCapabilities}. */
  capabilities: AgentCapabilities;
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: AgentSkill[];
}

export interface CreateBrokerAgentCardOptions {
  serviceName: string;
  publicBaseUrl: string;
  version?: string;
  protocolVersion?: string;
  description?: string;
  provider?: AgentProvider;
  supportsStreaming?: boolean;
  supportsPushNotifications?: boolean;
}

export function createBrokerAgentCard(options: CreateBrokerAgentCardOptions): AgentCard {
  const baseUrl = trimTrailingSlash(options.publicBaseUrl);
  return {
    name: options.serviceName,
    description:
      options.description ??
      "Broker-first A2A coordination service for delegated tasks, proposal review, and auditable worker execution.",
    url: `${baseUrl}/a2a/jsonrpc`,
    version: options.version ?? "0.1.0",
    protocolVersion: options.protocolVersion ?? "1.0",
    provider: options.provider,
    capabilities: {
      streaming: options.supportsStreaming ?? false,
      pushNotifications: options.supportsPushNotifications ?? false,
    },
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    skills: [
      {
        id: "analyze",
        name: "Analyze",
        description: "Dispatch research and analysis tasks to registered workers.",
        tags: ["analysis", "research"],
      },
      {
        id: "backfill",
        name: "Backfill",
        description: "Coordinate replay and backfill jobs across broker-managed workers.",
        tags: ["backfill", "history"],
      },
      {
        id: "propose_patch",
        name: "Propose patch",
        description: "Submit a patch proposal for remote review and approval.",
        tags: ["proposal", "patch", "approval"],
      },
      {
        id: "validate_change",
        name: "Validate change",
        description: "Route validation work and record verdicts in the broker pipeline.",
        tags: ["validation", "review"],
      },
      {
        id: "apply_local_change",
        name: "Apply local change",
        description: "Coordinate target-side apply after approval while preserving local workspace ownership.",
        tags: ["apply", "workspace", "policy"],
      },
    ],
  };
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
