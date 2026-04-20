import type {
  A2AExchangeMessageRecord,
  A2AExchangeState,
  A2APartyRef,
  ChangeProposal,
  TaskRecord,
  WorkerRecord,
} from "./types.js";

const KNOWN_A2A_DISPLAY_NAMES = new Map<string, string>([
  ["seoseo", "서서"],
  ["bangtong", "방통"],
  ["dungae", "등애"],
  ["dengae", "등애"],
]);

export function resolveKnownA2ADisplayName(id: string): string | undefined {
  const normalized = id.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  return KNOWN_A2A_DISPLAY_NAMES.get(normalized);
}

export function applyKnownA2APartyDisplayName<T extends A2APartyRef>(party: T): T {
  if (party.displayName) {
    return party;
  }
  const displayName = resolveKnownA2ADisplayName(party.id);
  return displayName ? ({ ...party, displayName } as T) : party;
}

export function applyKnownA2AWorkerDisplayName<T extends WorkerRecord>(worker: T): T {
  if (worker.displayName) {
    return worker;
  }
  const displayName = resolveKnownA2ADisplayName(worker.nodeId);
  return displayName ? ({ ...worker, displayName } as T) : worker;
}

export function applyKnownExchangeDisplayNames(exchange: A2AExchangeState): A2AExchangeState {
  return {
    ...exchange,
    requester: applyKnownA2APartyDisplayName(exchange.requester),
    target: applyKnownA2APartyDisplayName(exchange.target),
  };
}

export function applyKnownExchangeMessageDisplayNames(
  message: A2AExchangeMessageRecord,
): A2AExchangeMessageRecord {
  return {
    ...message,
    requester: message.requester
      ? applyKnownA2APartyDisplayName(message.requester)
      : message.requester,
    actor: message.actor ? applyKnownA2APartyDisplayName(message.actor) : message.actor,
  };
}

export function applyKnownProposalDisplayNames(proposal: ChangeProposal): ChangeProposal {
  return {
    ...proposal,
    source: applyKnownA2APartyDisplayName(proposal.source),
    target: applyKnownA2APartyDisplayName(proposal.target),
  };
}

export function applyKnownTaskDisplayNames(task: TaskRecord): TaskRecord {
  return {
    ...task,
    requester: applyKnownA2APartyDisplayName(task.requester),
    target: applyKnownA2APartyDisplayName(task.target),
  };
}
