import type { TaskTombstone, TombstoneListFilters } from "./types.js";

/**
 * Runtime seam for terminal task tombstones.
 *
 * JSON/in-memory deployments continue to use the broker map and canonical
 * snapshot saves. SQLite deployments can bind this interface to the
 * broker_tombstones hot table so post-mortem diagnostics can read terminal
 * context without relying on a snapshot-first path.
 */
export interface TombstoneRuntimeRepository {
  getTombstone(taskId: string): TaskTombstone | null;
  listTombstones(filters?: TombstoneListFilters): TaskTombstone[];
  upsertTombstone(tombstone: TaskTombstone): void;
}
