import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type {
  ArtifactRecord,
  AuditEvent,
  A2AExchangeMessageRecord,
  A2AExchangeState,
  ChangeProposal,
  TaskRecord,
  ValidationResult,
  WorkerRecord,
} from "./types.js";

export const CURRENT_BROKER_STATE_VERSION = 5;

export interface BrokerSnapshot {
  version: number;
  exchanges: A2AExchangeState[];
  exchangeMessages: A2AExchangeMessageRecord[];
  proposals: ChangeProposal[];
  artifacts: ArtifactRecord[];
  validations: ValidationResult[];
  auditEvents: AuditEvent[];
  workers: WorkerRecord[];
  tasks: TaskRecord[];
}

export interface BrokerStateStore {
  load(): BrokerSnapshot;
  save(snapshot: BrokerSnapshot): void;
}

export class JsonFileBrokerStateStore implements BrokerStateStore {
  constructor(private readonly filePath: string) {}

  load(): BrokerSnapshot {
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<BrokerSnapshot>;
      return {
        version:
          typeof parsed.version === "number"
            ? parsed.version
            : CURRENT_BROKER_STATE_VERSION,
        exchanges: Array.isArray(parsed.exchanges) ? parsed.exchanges : [],
        exchangeMessages: Array.isArray(parsed.exchangeMessages) ? parsed.exchangeMessages : [],
        proposals: Array.isArray(parsed.proposals) ? parsed.proposals : [],
        artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts : [],
        validations: Array.isArray(parsed.validations) ? parsed.validations : [],
        auditEvents: Array.isArray(parsed.auditEvents) ? parsed.auditEvents : [],
        workers: Array.isArray(parsed.workers) ? parsed.workers : [],
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      };
    } catch (error) {
      if (isMissingFileError(error)) {
        return emptySnapshot();
      }
      throw error;
    }
  }

  save(snapshot: BrokerSnapshot): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    const payload = JSON.stringify(
      {
        ...snapshot,
        version: CURRENT_BROKER_STATE_VERSION,
      },
      null,
      2,
    );
    writeFileSync(tempPath, payload, "utf8");
    renameSync(tempPath, this.filePath);
  }
}

export function emptySnapshot(): BrokerSnapshot {
  return {
    version: CURRENT_BROKER_STATE_VERSION,
    exchanges: [],
    exchangeMessages: [],
    proposals: [],
    artifacts: [],
    validations: [],
    auditEvents: [],
    workers: [],
    tasks: [],
  };
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
