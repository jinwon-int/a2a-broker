import type {
  A2APartyRef,
  A2AWorkerEnvironment,
  ChangeProposal,
  CreateTaskRequest,
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

const LIVE_IMPACT_INTENTS = new Set(["promote_to_live", "rollback_live"]);
const DANGEROUS_TASK_INTENTS = new Set([
  "apply_local_change",
  "promote_to_live",
  "rollback_live",
]);

export interface NormalizedTaskPolicyContext {
  requiresApproval?: boolean;
  liveImpact?: boolean;
  targetEnvironment?: A2AWorkerEnvironment;
}

export function normalizeTaskPolicyContext(
  request: CreateTaskRequest,
): NormalizedTaskPolicyContext | undefined {
  const inferredLiveImpact = isLiveImpactTask(request);
  const requiresGate = taskRequiresHumanGate(request);
  const context = { ...(request.policyContext ?? {}) };

  if (inferredLiveImpact && context.liveImpact === undefined) {
    context.liveImpact = true;
  }
  if (inferredLiveImpact && context.targetEnvironment === undefined) {
    context.targetEnvironment = "live";
  }
  if (requiresGate && context.requiresApproval === undefined) {
    context.requiresApproval = true;
  }

  return Object.keys(context).length > 0 ? context : undefined;
}

export function assertTaskHumanGateAllowed(request: CreateTaskRequest): void {
  if (!taskRequiresHumanGate(request)) {
    return;
  }

  const requesterRole = request.requester.role;
  if (requesterRole === "operator" || requesterRole === "hub") {
    return;
  }

  throw new PolicyError(
    "live-impact task creation requires an operator or hub requester",
  );
}

function taskRequiresHumanGate(request: CreateTaskRequest): boolean {
  return (
    DANGEROUS_TASK_INTENTS.has(request.intent) ||
    request.policyContext?.requiresApproval === true ||
    request.policyContext?.liveImpact === true ||
    request.policyContext?.targetEnvironment === "live" ||
    isLiveImpactTask(request)
  );
}

function isLiveImpactTask(request: CreateTaskRequest): boolean {
  if (LIVE_IMPACT_INTENTS.has(request.intent)) {
    return true;
  }
  if (request.policyContext?.liveImpact === true) {
    return true;
  }
  if (request.policyContext?.targetEnvironment === "live") {
    return true;
  }
  return request.intent === "apply_local_change" && request.target.role === "live-trader";
}
