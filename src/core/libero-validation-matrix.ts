export type LiberoValidationArea =
  | "hot_table_memory"
  | "retention_hygiene"
  | "terminal_outbox_hygiene"
  | "receipt_semantics"
  | "replay_canary"
  | "observability_readiness"
  | "evidence_hygiene";

export type LiberoEvidenceStatus = "pass" | "warn" | "blocked" | "missing";

export type LiberoForbiddenAction =
  | "productionDeploy"
  | "gatewayRestart"
  | "liveProviderSend"
  | "terminalAck"
  | "dbMutation"
  | "secretChange"
  | "release"
  | "forcePush";

export interface LiberoRegressionGate {
  id: string;
  area: LiberoValidationArea;
  sourceIssue: "#497" | "#294" | "#497/#294";
  noLiveOnly: true;
  gate: string;
  requiredProof: string;
  noGoIf: string;
}

export interface LiberoEvidenceInput {
  area: LiberoValidationArea;
  status: LiberoEvidenceStatus;
  evidenceUrl?: string;
  note?: string;
}

export interface LiberoSafetyInput {
  productionDeploy?: boolean;
  gatewayRestart?: boolean;
  liveProviderSend?: boolean;
  terminalAck?: boolean;
  dbMutation?: boolean;
  secretChange?: boolean;
  release?: boolean;
  forcePush?: boolean;
}

export interface LiberoReadinessResult {
  decision: "go" | "no-go";
  missingAreas: LiberoValidationArea[];
  blockedAreas: LiberoValidationArea[];
  warningAreas: LiberoValidationArea[];
  forbiddenActions: LiberoForbiddenAction[];
}

export const LIBERO_REQUIRED_AREAS: readonly LiberoValidationArea[] = [
  "hot_table_memory",
  "retention_hygiene",
  "terminal_outbox_hygiene",
  "receipt_semantics",
  "replay_canary",
  "observability_readiness",
  "evidence_hygiene",
] as const;

export const LIBERO_FORBIDDEN_ACTIONS: readonly LiberoForbiddenAction[] = [
  "productionDeploy",
  "gatewayRestart",
  "liveProviderSend",
  "terminalAck",
  "dbMutation",
  "secretChange",
  "release",
  "forcePush",
] as const;

export const LIBERO_REGRESSION_GATES: readonly LiberoRegressionGate[] = [
  {
    id: "L1",
    area: "hot_table_memory",
    sourceIssue: "#497",
    noLiveOnly: true,
    gate: "SQLite hot-table/OOM risk remains bounded under representative historical task, audit, worker, and terminal-outbox rows.",
    requiredProof: "Focused store/build tests or a no-live fixture showing bounded hot-table startup, heap/readiness diagnostics, and no all-history materialization regression.",
    noGoIf: "Startup or health proof requires loading unbounded historical rows, hides heap pressure, or substitutes NODE_OPTIONS as the only mitigation.",
  },
  {
    id: "L2",
    area: "retention_hygiene",
    sourceIssue: "#497",
    noLiveOnly: true,
    gate: "Completed tasks, audit events, tombstones, workers, and exchange hot tables have explicit retention or protected-id behavior.",
    requiredProof: "Retention-plan tests and read-only table-count diagnostics; no production prune/migration in validation.",
    noGoIf: "Completed/audit/tombstone rows can grow without a bounded plan, or validation performs a live DB prune/migration.",
  },
  {
    id: "L3",
    area: "terminal_outbox_hygiene",
    sourceIssue: "#497/#294",
    noLiveOnly: true,
    gate: "Terminal outbox unacked backlog is observable, replay-safe, and not a memory-pressure blind spot.",
    requiredProof: "terminal_receipt_gap_matrix and terminal_outbox_preflight no-live output, plus compact unacked/stale counts when read-only broker access exists.",
    noGoIf: "Unacked rows are hidden, blindly ACKed, pruned without receipt evidence, or replay requires a live provider send.",
  },
  {
    id: "L4",
    area: "receipt_semantics",
    sourceIssue: "#294",
    noLiveOnly: true,
    gate: "Provider send acceptance is never treated as operator-visible receipt or terminal ACK evidence.",
    requiredProof: "receipt_gate_canary and terminal_receipt_gap_matrix passing outputs covering accepted/sent/provider_sent/timed_out/stale/failed/operator-visible states.",
    noGoIf: "Any provider-send-only state allows ACK, Done evidence, or queue closeout without operator-visible/provider-delivery proof.",
  },
  {
    id: "L5",
    area: "replay_canary",
    sourceIssue: "#294",
    noLiveOnly: true,
    gate: "Broker → plugin → worker → result projection can be rehearsed without provider delivery or real terminal ACK.",
    requiredProof: "No-live canary/rehearsal output showing providerCalled=false and productionAckAttempted=false for every step.",
    noGoIf: "The canary path sends Telegram/provider traffic, mutates broker state, ACKs terminal rows, or cannot replay stale/queued evidence.",
  },
  {
    id: "L6",
    area: "observability_readiness",
    sourceIssue: "#497/#294",
    noLiveOnly: true,
    gate: "Operators can see heap/readiness risk, table counts, queued/blocked/stale tasks, and terminal-outbox gaps before OOM or false closeout.",
    requiredProof: "Health/readiness or report evidence with heap/table/outbox/task-status summaries; read-only snapshot blocker is explicit if endpoint access is unavailable.",
    noGoIf: "OOM/receipt gaps require raw DB inspection, private host paths, or live mutation to diagnose.",
  },
  {
    id: "L7",
    area: "evidence_hygiene",
    sourceIssue: "#497/#294",
    noLiveOnly: true,
    gate: "Start and PR/Done/Block evidence is compact, secret-safe, and excludes OpenClaw runtime/bootstrap context files.",
    requiredProof: "Issue/PR evidence lists commands, pass/fail results, blockers, and safety flags without raw session dumps, secrets, host-private paths, or AGENTS/SOUL/USER/TOOLS/HEARTBEAT/IDENTITY/.openclaw artifacts.",
    noGoIf: "Evidence or branch artifacts include secrets, raw sessions, private paths, OpenClaw bootstrap files, or missing final marker URLs.",
  },
] as const;

export function evaluateLiberoValidationReadiness(
  evidence: readonly LiberoEvidenceInput[],
  safety: LiberoSafetyInput = {},
): LiberoReadinessResult {
  const byArea = new Map<LiberoValidationArea, LiberoEvidenceInput>();
  for (const item of evidence) {
    byArea.set(item.area, item);
  }

  const missingAreas: LiberoValidationArea[] = [];
  const blockedAreas: LiberoValidationArea[] = [];
  const warningAreas: LiberoValidationArea[] = [];

  for (const area of LIBERO_REQUIRED_AREAS) {
    const item = byArea.get(area);
    if (!item || item.status === "missing") {
      missingAreas.push(area);
      continue;
    }
    if (item.status === "blocked") {
      blockedAreas.push(area);
      continue;
    }
    if (item.status === "warn") {
      warningAreas.push(area);
    }
  }

  const forbiddenActions = LIBERO_FORBIDDEN_ACTIONS.filter((action) => safety[action] === true);

  return {
    decision: missingAreas.length === 0 && blockedAreas.length === 0 && warningAreas.length === 0 && forbiddenActions.length === 0 ? "go" : "no-go",
    missingAreas,
    blockedAreas,
    warningAreas,
    forbiddenActions,
  };
}

export function renderLiberoValidationMatrixMarkdown(
  gates: readonly LiberoRegressionGate[] = LIBERO_REGRESSION_GATES,
): string {
  const rows = gates.map((item) => (
    `| ${item.id} | ${item.area} | ${item.sourceIssue} | ${item.gate} | ${item.requiredProof} | ${item.noGoIf} |`
  ));

  return [
    "| ID | Area | Source | Gate | Required proof | NO-GO if |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}
