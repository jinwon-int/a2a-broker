import type { AuditEvent, AuditListFilters } from "./types.js";

/**
 * Runtime seam for append-only audit events.
 *
 * JSON/in-memory deployments continue to use the broker map and canonical
 * snapshot saves. SQLite deployments can bind this interface to the
 * broker_audit_events hot table so diagnostics and recovery paths can read
 * recent audit context without depending on a snapshot-first reload.
 */
export interface AuditRuntimeRepository {
  listAuditEvents(filters?: AuditListFilters): AuditEvent[];
  appendAuditEvent(event: AuditEvent): void;
}
