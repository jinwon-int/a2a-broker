import type {
  A2APartyRef,
  ChangeProposal,
  ProposalActorRequest,
  SubmitValidationRequest,
} from "./types.js";

export class PolicyError extends Error {
  readonly code = "policy_denied" as const;

  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

export function assertProposalCreationAllowed(source: A2APartyRef, target: A2APartyRef): void {
  if (!source.id || !target.id) {
    throw new PolicyError("source.id and target.id are required");
  }

  if (source.role === "researcher" && target.role === "live-trader") {
    return;
  }

  if (source.role === "operator" || source.role === "hub") {
    return;
  }

  if (source.id === target.id) {
    return;
  }

  return;
}

export function assertProposalReviewAllowed(
  proposal: ChangeProposal,
  request: ProposalActorRequest,
): void {
  const actor = request.actor;
  if (!actor?.id) {
    throw new PolicyError("actor.id is required");
  }

  if (actor.role === "operator") {
    return;
  }

  if (actor.id !== proposal.targetNodeId) {
    throw new PolicyError("only the target node or an operator may review this proposal");
  }
}

export function assertProposalApplyAllowed(
  proposal: ChangeProposal,
  request: ProposalActorRequest,
): void {
  const actor = request.actor;
  if (!actor?.id) {
    throw new PolicyError("actor.id is required");
  }

  if (actor.role === "operator") {
    return;
  }

  if (actor.id !== proposal.targetNodeId) {
    throw new PolicyError("only the target node or an operator may apply this proposal");
  }

  if (actor.role === "researcher" && proposal.target.role === "live-trader") {
    throw new PolicyError("research nodes cannot apply directly to live workspaces");
  }
}

export function assertValidationSubmissionAllowed(
  proposal: ChangeProposal,
  request: SubmitValidationRequest,
): void {
  if (!request.nodeId) {
    throw new PolicyError("nodeId is required");
  }

  if (request.nodeId === proposal.targetNodeId || request.nodeId === proposal.sourceNodeId) {
    return;
  }

  throw new PolicyError("validation may only be submitted by the source or target node in phase 1");
}
