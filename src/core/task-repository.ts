import type { TaskListFilters, TaskRecord } from "./types.js";

/**
 * Runtime seam for high-churn task lifecycle state.
 *
 * JSON/in-memory deployments continue to use the broker maps and canonical
 * snapshot saves. SQLite deployments can bind this interface to the
 * broker_tasks hot table so task lifecycle transitions have a table-native
 * write/read path while snapshots remain export-compatible.
 */
export interface TaskRuntimeRepository {
  getTask(id: string): TaskRecord | null;
  listTasks(filters?: TaskListFilters): TaskRecord[];
  upsertTask(task: TaskRecord): void;
}
