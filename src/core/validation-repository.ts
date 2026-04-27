import type { ValidationResult } from "./types.js";

/**
 * Runtime seam for proposal validation results.
 *
 * JSON/in-memory deployments continue to use the broker maps and canonical
 * snapshot saves. SQLite deployments can bind this interface to the
 * broker_validations hot table so proposal validation reads and writes have a
 * table-native path while snapshots remain export-compatible.
 */
export interface ValidationRuntimeRepository {
  getValidation(id: string): ValidationResult | null;
  listValidationsForProposal(proposalId: string): ValidationResult[];
  upsertValidation(validation: ValidationResult): void;
}
