import type { WorkerListFilters, WorkerRecord } from "./types.js";

/**
 * Runtime seam for high-churn worker state.
 *
 * JSON/in-memory deployments can continue to rely on the broker maps and
 * canonical snapshot saves. SQLite deployments can bind this interface to the
 * broker_workers hot table so register/heartbeat/lastSeen state has a
 * table-native write/read path while snapshots remain export-compatible.
 */
export interface WorkerRuntimeRepository {
  getWorker(nodeId: string): WorkerRecord | null;
  listWorkers(filters?: WorkerListFilters): WorkerRecord[];
  upsertWorker(worker: WorkerRecord): void;
}
