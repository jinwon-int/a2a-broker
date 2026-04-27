import type { ArtifactRecord } from "./types.js";

/**
 * Runtime seam for proposal artifact metadata.
 *
 * JSON/in-memory deployments continue to use the broker maps and canonical
 * snapshot saves. SQLite deployments can bind this interface to the
 * broker_artifacts hot table so proposal artifact metadata reads and writes
 * have a table-native path while snapshots remain export-compatible.
 */
export interface ArtifactRuntimeRepository {
  getArtifact(id: string): ArtifactRecord | null;
  listArtifactsForProposal(proposalId: string): ArtifactRecord[];
  upsertArtifact(artifact: ArtifactRecord): void;
}
