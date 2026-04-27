import type { ChangeProposal, ProposalListFilters } from "./types.js";

/**
 * Runtime seam for change proposal lifecycle state.
 *
 * JSON/in-memory deployments continue to use the broker maps and canonical
 * snapshot saves. SQLite deployments can bind this interface to the
 * broker_proposals hot table so proposal lifecycle reads and writes have a
 * table-native path while snapshots remain export-compatible.
 */
export interface ProposalRuntimeRepository {
  getProposal(id: string): ChangeProposal | null;
  listProposals(filters?: ProposalListFilters): ChangeProposal[];
  upsertProposal(proposal: ChangeProposal): void;
}
