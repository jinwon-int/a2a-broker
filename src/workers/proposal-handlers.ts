/**
 * Builtin intent handlers for proposal lifecycle operations.
 *
 * These handlers are designed to be registered via createIntentRouter and
 * call back to the broker's proposal APIs. They don't execute the actual
 * work (patching files, running backtests) — they coordinate the broker
 * lifecycle. The real work is delegated to an external handler or plugin.
 *
 * Usage:
 * ```ts
 * const router = createIntentRouter({
 *   handlers: [
 *     { intent: "validate_change", handler: createValidateProposalHandler(validator) },
 *     { intent: "apply_local_change", handler: createApplyProposalHandler(applier) },
 *     { intent: "propose_patch", handler: createProposePatchHandler() },
 *     { intent: "propose_params", handler: createProposeParamsHandler() },
 *   ],
 * });
 * ```
 */
import {
  TaskAssertionError,
  assertProposalTask,
  assertWorkspaceTask,
  assertPayloadField,
} from "./intent-router.js";
import type {
  TaskRecord,
  TaskResult,
  ValidationVerdict,
  ValidationKind,
} from "../core/types.js";
import type { A2ABrokerWorker, WorkerHandlerOutcome } from "../worker.js";

// --- Types for external plugins ---

export interface ProposalValidator {
  /**
   * Validate a proposal. Returns a verdict and optional metrics.
   * Throw to indicate a handler error (not a validation failure).
   */
  validate(task: TaskRecord): Promise<{
    verdict: ValidationVerdict;
    kind: ValidationKind;
    metrics?: Record<string, number | string | boolean>;
    artifactIds?: string[];
    note?: string;
  }>;
}

export interface ProposalApplier {
  /**
   * Apply a proposal's changes locally.
   * Throw to indicate a handler error.
   */
  apply(task: TaskRecord): Promise<{
    artifactIds?: string[];
    note?: string;
  }>;
}

// --- Handler factories ---

/**
 * Handler for `validate_change` intent.
 *
 * 1. Fetches proposal details from broker
 * 2. Delegates validation to the provided validator
 * 3. Submits validation result to broker
 *
 * The validator is responsible for the actual check (backtest, replay, etc.).
 */
export function createValidateProposalHandler(
  worker: A2ABrokerWorker,
  validator: ProposalValidator,
): (task: TaskRecord) => Promise<WorkerHandlerOutcome> {
  return async (task: TaskRecord): Promise<WorkerHandlerOutcome> => {
    assertProposalTask(task, "validate_change");

    // Optionally preload proposal details via worker API
    let proposalDetails;
    try {
      proposalDetails = await worker.getProposalDetails(task.proposalId!);
    } catch (error) {
      return {
        error: {
          code: "proposal_not_found",
          message: `proposal ${task.proposalId} not found on broker`,
          details: { proposalId: task.proposalId },
        },
      };
    }

    try {
      const validation = await validator.validate(task);

      // Return result with validation field — the broker's completeTask flow
      // will automatically call submitValidationResult based on this.
      return {
        result: {
          summary: `validation ${validation.verdict} for proposal ${task.proposalId}`,
          note: validation.note,
          artifactIds: validation.artifactIds,
          validation: {
            nodeId: worker.workerId,
            kind: validation.kind,
            verdict: validation.verdict,
            metrics: validation.metrics ?? {},
            artifactIds: validation.artifactIds ?? [],
            note: validation.note,
          },
        } satisfies TaskResult,
      };
    } catch (error) {
      if (error instanceof TaskAssertionError) {
        return error.outcome;
      }
      return {
        error: {
          code: "validation_handler_error",
          message: error instanceof Error ? error.message : "validator threw an error",
          details: { proposalId: task.proposalId },
        },
      };
    }
  };
}

/**
 * Handler for `apply_local_change` intent.
 *
 * 1. Fetches proposal details from broker
 * 2. Delegates apply to the provided applier
 * 3. Calls broker's apply endpoint to update proposal status
 */
export function createApplyProposalHandler(
  applier: ProposalApplier,
): (task: TaskRecord) => Promise<WorkerHandlerOutcome> {
  return async (task: TaskRecord): Promise<WorkerHandlerOutcome> => {
    assertProposalTask(task, "apply_local_change");
    assertWorkspaceTask(task);

    try {
      const applyResult = await applier.apply(task);

      // Return result with apply field — the broker's completeTask flow
      // will automatically call applyProposalLocally based on this.
      return {
        result: {
          summary: `applied proposal ${task.proposalId}`,
          note: applyResult.note,
          artifactIds: applyResult.artifactIds,
          apply: {
            workspace: task.workspace,
            artifactIds: applyResult.artifactIds ?? [],
            note: applyResult.note,
          },
        } satisfies TaskResult,
      };
    } catch (error) {
      if (error instanceof TaskAssertionError) {
        return error.outcome;
      }
      return {
        error: {
          code: "apply_handler_error",
          message: error instanceof Error ? error.message : "applier threw an error",
          details: { proposalId: task.proposalId },
        },
      };
    }
  };
}

/**
 * Handler for `propose_patch` intent.
 *
 * Creates a new patch proposal on the broker from task payload.
 *
 * Expected payload fields:
 * - `targetNodeId` (string, required)
 * - `summary` (string, required)
 * - `patchText` (string, optional)
 * - `rationale` (string, optional)
 */
export function createProposePatchHandler(
  worker: A2ABrokerWorker,
): (task: TaskRecord) => Promise<WorkerHandlerOutcome> {
  return async (task: TaskRecord): Promise<WorkerHandlerOutcome> => {
    try {
      const targetNodeId = String(assertPayloadField(task, "targetNodeId"));
      const summary = String(assertPayloadField(task, "summary"));
      const patchText = task.payload.patchText ? String(task.payload.patchText) : undefined;
      const rationale = task.payload.rationale ? String(task.payload.rationale) : undefined;

      const proposal = await worker.createProposal({
        source: { id: worker.workerId, kind: "node", role: worker.brokerClient.role },
        target: { id: targetNodeId, kind: "node" },
        kind: "patch",
        summary,
        rationale,
        workspace: task.workspace ?? { nodeId: targetNodeId, workspaceId: "default" },
        patchText,
        artifactIds: task.artifactIds ?? [],
      });

      return {
        result: {
          summary: `created patch proposal ${proposal.id}`,
          note: summary,
          output: { proposalId: proposal.id, status: proposal.status },
        } satisfies TaskResult,
      };
    } catch (error) {
      if (error instanceof TaskAssertionError) {
        return error.outcome;
      }
      return {
        error: {
          code: "propose_patch_error",
          message: error instanceof Error ? error.message : "failed to create proposal",
        },
      };
    }
  };
}

/**
 * Handler for `propose_params` intent.
 *
 * Creates a new parameter proposal on the broker from task payload.
 *
 * Expected payload fields:
 * - `targetNodeId` (string, required)
 * - `summary` (string, required)
 * - `parameterPayload` (object, required)
 * - `rationale` (string, optional)
 */
export function createProposeParamsHandler(
  worker: A2ABrokerWorker,
): (task: TaskRecord) => Promise<WorkerHandlerOutcome> {
  return async (task: TaskRecord): Promise<WorkerHandlerOutcome> => {
    try {
      const targetNodeId = String(assertPayloadField(task, "targetNodeId"));
      const summary = String(assertPayloadField(task, "summary"));
      const parameterPayload = assertPayloadField(task, "parameterPayload");
      const rationale = task.payload.rationale ? String(task.payload.rationale) : undefined;

      if (!parameterPayload || typeof parameterPayload !== "object" || Array.isArray(parameterPayload)) {
        return {
          error: {
            code: "invalid_payload",
            message: "parameterPayload must be a JSON object",
          },
        };
      }

      const proposal = await worker.createProposal({
        source: { id: worker.workerId, kind: "node", role: worker.brokerClient.role },
        target: { id: targetNodeId, kind: "node" },
        kind: "params",
        summary,
        rationale,
        workspace: task.workspace ?? { nodeId: targetNodeId, workspaceId: "default" },
        parameterPayload: parameterPayload as Record<string, unknown>,
        artifactIds: task.artifactIds ?? [],
      });

      return {
        result: {
          summary: `created params proposal ${proposal.id}`,
          note: summary,
          output: { proposalId: proposal.id, status: proposal.status },
        } satisfies TaskResult,
      };
    } catch (error) {
      if (error instanceof TaskAssertionError) {
        return error.outcome;
      }
      return {
        error: {
          code: "propose_params_error",
          message: error instanceof Error ? error.message : "failed to create proposal",
        },
      };
    }
  };
}
