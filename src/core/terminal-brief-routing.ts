/**
 * Terminal Brief parent-origin routing helper (#634).
 *
 * This module defines the four normal Seoseo/Team1 and Gwakga/Team2 routing
 * cases. It is deliberately pure and side-effect free: resolving a route never
 * creates tasks, sends provider messages, mutates DB/outbox state, or ACKs a
 * Terminal Brief. Runtime dispatch layers may use this helper to derive the
 * metadata they then persist explicitly.
 */

export type TerminalBriefTeamScope = "team1-only" | "team2-only" | "team1+team2";
export type TerminalBriefExecutionPath = "local-only" | "local-plus-cross-team-child-projection";
export type TerminalBriefRoutingRejectCode =
  | "unknown_initiating_broker"
  | "unsupported_team_scope"
  | "team_scope_not_owned_by_initiator";

export interface TerminalBriefBrokerTeamRegistration {
  brokerId: string;
  teamId: "team1" | "team2";
}

export interface ResolveTerminalBriefParentOriginRouteInput {
  initiatingBrokerId: string;
  requestedTeamScope: string;
  brokers?: readonly TerminalBriefBrokerTeamRegistration[];
}

export interface TerminalBriefHandoffRoute {
  handoffBrokerId: string;
  handoffTeamIds: ["team1"] | ["team2"];
  projectionDestinationBrokerId: string;
}

export interface TerminalBriefParentOriginRoute {
  initiatingBrokerId: string;
  requestedTeamScope: TerminalBriefTeamScope;
  parentBrokerId: string;
  originBrokerId: string;
  operatorFacingTerminalBriefSender: string;
  localTeamIds: ["team1"] | ["team2"];
  handoff: TerminalBriefHandoffRoute | null;
  childProjectionRequired: boolean;
  parentSeedRequired: boolean;
  executionPath: TerminalBriefExecutionPath;
  notification: {
    parentBrokerOnly: true;
    childLocalNotificationSuppressedAfterRelaySuccess: boolean;
    relayFailureFallsBackToLocalNotification: boolean;
  };
  requiredMetadataFields: readonly string[];
  safety: {
    liveProviderSend: false;
    terminalOutboxAckMutated: false;
    terminalAckReplay: false;
    operatorApprovalInferred: false;
  };
}

export type TerminalBriefParentOriginRouteResult =
  | { ok: true; route: TerminalBriefParentOriginRoute }
  | { ok: false; code: TerminalBriefRoutingRejectCode; reason: string };

export const DEFAULT_TERMINAL_BRIEF_BROKER_TEAMS: readonly TerminalBriefBrokerTeamRegistration[] = [
  { brokerId: "seoseo", teamId: "team1" },
  { brokerId: "gwakga", teamId: "team2" },
] as const;

export const TERMINAL_BRIEF_PARENT_ORIGIN_METADATA_FIELDS = [
  "teamScope",
  "initiatingBrokerId",
  "originBrokerId",
  "parentBrokerId",
  "parentRoundId",
  "parentRoundOrder",
  "parentRoundTotal",
  "handoffBrokerId",
  "childBrokerId",
] as const;

function normalizeToken(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeTerminalBriefTeamScope(scope: string): TerminalBriefTeamScope | undefined {
  const normalized = normalizeToken(scope).replace(/\s+/g, "");
  switch (normalized) {
    case "team1":
    case "team1-only":
    case "team1only":
      return "team1-only";
    case "team2":
    case "team2-only":
    case "team2only":
      return "team2-only";
    case "team1+team2":
    case "team2+team1":
    case "all":
    case "all-teams":
    case "both":
    case "cross-team":
    case "team1team2":
    case "team2team1":
      return "team1+team2";
    default:
      return undefined;
  }
}

function brokerByTeam(
  brokers: readonly TerminalBriefBrokerTeamRegistration[],
  teamId: "team1" | "team2",
): TerminalBriefBrokerTeamRegistration | undefined {
  return brokers.find((broker) => broker.teamId === teamId);
}

export function resolveTerminalBriefParentOriginRoute(
  input: ResolveTerminalBriefParentOriginRouteInput,
): TerminalBriefParentOriginRouteResult {
  const initiatingBrokerId = normalizeToken(input.initiatingBrokerId);
  const brokers = input.brokers ?? DEFAULT_TERMINAL_BRIEF_BROKER_TEAMS;
  const initiator = brokers.find((broker) => broker.brokerId === initiatingBrokerId);
  if (!initiator) {
    return {
      ok: false,
      code: "unknown_initiating_broker",
      reason: `unknown Terminal Brief initiating broker: ${input.initiatingBrokerId}`,
    };
  }

  const requestedTeamScope = normalizeTerminalBriefTeamScope(input.requestedTeamScope);
  if (!requestedTeamScope) {
    return {
      ok: false,
      code: "unsupported_team_scope",
      reason: `unsupported Terminal Brief team scope: ${input.requestedTeamScope}`,
    };
  }

  if (requestedTeamScope === "team1-only" && initiator.teamId !== "team1") {
    return {
      ok: false,
      code: "team_scope_not_owned_by_initiator",
      reason: "Team1-only Terminal Brief work must be initiated and sent by the Team1 broker",
    };
  }
  if (requestedTeamScope === "team2-only" && initiator.teamId !== "team2") {
    return {
      ok: false,
      code: "team_scope_not_owned_by_initiator",
      reason: "Team2-only Terminal Brief work must be initiated and sent by the Team2 broker",
    };
  }

  const localTeamIds = [initiator.teamId] as ["team1"] | ["team2"];
  const parentBrokerId = initiatingBrokerId;
  const originBrokerId = initiatingBrokerId;

  if (requestedTeamScope === "team1+team2") {
    const remoteTeamId = initiator.teamId === "team1" ? "team2" : "team1";
    const remoteBroker = brokerByTeam(brokers, remoteTeamId);
    if (!remoteBroker) {
      return {
        ok: false,
        code: "unknown_initiating_broker",
        reason: `no broker is registered for ${remoteTeamId}`,
      };
    }
    return {
      ok: true,
      route: {
        initiatingBrokerId,
        requestedTeamScope,
        parentBrokerId,
        originBrokerId,
        operatorFacingTerminalBriefSender: initiatingBrokerId,
        localTeamIds,
        handoff: {
          handoffBrokerId: remoteBroker.brokerId,
          handoffTeamIds: [remoteTeamId] as ["team1"] | ["team2"],
          projectionDestinationBrokerId: initiatingBrokerId,
        },
        childProjectionRequired: true,
        parentSeedRequired: true,
        executionPath: "local-plus-cross-team-child-projection",
        notification: {
          parentBrokerOnly: true,
          childLocalNotificationSuppressedAfterRelaySuccess: true,
          relayFailureFallsBackToLocalNotification: true,
        },
        requiredMetadataFields: TERMINAL_BRIEF_PARENT_ORIGIN_METADATA_FIELDS,
        safety: {
          liveProviderSend: false,
          terminalOutboxAckMutated: false,
          terminalAckReplay: false,
          operatorApprovalInferred: false,
        },
      },
    };
  }

  return {
    ok: true,
    route: {
      initiatingBrokerId,
      requestedTeamScope,
      parentBrokerId,
      originBrokerId,
      operatorFacingTerminalBriefSender: initiatingBrokerId,
      localTeamIds,
      handoff: null,
      childProjectionRequired: false,
      parentSeedRequired: false,
      executionPath: "local-only",
      notification: {
        parentBrokerOnly: true,
        childLocalNotificationSuppressedAfterRelaySuccess: false,
        relayFailureFallsBackToLocalNotification: false,
      },
      requiredMetadataFields: TERMINAL_BRIEF_PARENT_ORIGIN_METADATA_FIELDS,
      safety: {
        liveProviderSend: false,
        terminalOutboxAckMutated: false,
        terminalAckReplay: false,
        operatorApprovalInferred: false,
      },
    },
  };
}
