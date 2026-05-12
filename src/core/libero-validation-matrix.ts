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

export type LiberoSourceIssue = "#497" | "#294" | "#497/#294";

export interface LiberoRegressionGate {
  id: string;
  area: LiberoValidationArea;
  sourceIssue: LiberoSourceIssue;
  noLiveOnly: true;
  gate: string;
  requiredProof: string;
  noGoIf: string;
}

export interface LiberoClosureCriterion {
  id: string;
  sourceIssue: LiberoSourceIssue;
  criterion: string;
  requiredEvidence: string;
  closesWhen: string;
}

export interface LiberoNoGoTrap {
  id: string;
  area: LiberoValidationArea;
  trap: string;
  failClosedResponse: string;
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

export const LIBERO_CLOSURE_CRITERIA: readonly LiberoClosureCriterion[] = [
  {
    id: "C1",
    sourceIssue: "#497",
    criterion: "Hot-table persistence no longer depends on full-history heap residency for normal startup, health, or single-row updates.",
    requiredEvidence: "Bounded no-live fixture or focused test covering representative task/audit/outbox history and heap/readiness diagnostics.",
    closesWhen: "The evidence proves state growth is bounded by active/recent windows or documented caps, not by retained historical row count.",
  },
  {
    id: "C2",
    sourceIssue: "#497",
    criterion: "Retention and cleanup policy is explicit for completed tasks, audit events, tombstones, workers, snapshots, WAL, and terminal outbox rows.",
    requiredEvidence: "Tests or docs for caps/age windows/protected IDs plus read-only reporting; production cleanup remains separately approved.",
    closesWhen: "Operators can distinguish safe retention, pending cleanup approval, and current unbounded-growth blockers without mutating the live DB.",
  },
  {
    id: "C3",
    sourceIssue: "#294",
    criterion: "Receipt semantics keep provider accepted-send, operator-visible/current-session receipt, and terminal ACK as separate states.",
    requiredEvidence: "receipt_gate_canary and terminal_receipt_gap_matrix outputs showing provider accepted/sent never implies ACK or human visibility.",
    closesWhen: "Every terminal closeout path requires ACK-safe receipt evidence or stays pending/blocked with compact evidence.",
  },
  {
    id: "C4",
    sourceIssue: "#294",
    criterion: "Replay/canary paths are duplicate-safe and default no-live, with live provider sends and terminal ACKs opt-in only after separate approval.",
    requiredEvidence: "No-live canary/preflight output with providerCalled=false, terminalAckAttempted=false, and duplicate/replay suppression proof.",
    closesWhen: "A stale backlog or rerun cannot produce duplicate provider sends, forged ACKs, or false Done evidence.",
  },
  {
    id: "C5",
    sourceIssue: "#497/#294",
    criterion: "Closure evidence is compact, reproducible, and excludes OpenClaw runtime/bootstrap context files and secrets.",
    requiredEvidence: "Start plus PR/Done/Block evidence, command results, blocker URLs, and candidate diff checks for runtime/bootstrap path leaks.",
    closesWhen: "The branch/artifact set is free of AGENTS/SOUL/USER/TOOLS/HEARTBEAT/IDENTITY/.openclaw files and raw session/private-host dumps.",
  },
] as const;

export const LIBERO_NO_GO_TRAPS: readonly LiberoNoGoTrap[] = [
  {
    id: "T1",
    area: "receipt_semantics",
    trap: "Treating provider accepted-send, Telegram message id, GitHub comment projection, or task success as operator-visible receipt.",
    failClosedResponse: "Keep the row pending, report the receipt gap, and do not ACK or close #294 from provider-only evidence.",
  },
  {
    id: "T2",
    area: "hot_table_memory",
    trap: "Masking hot-table OOM risk with a restart, NODE_OPTIONS heap increase, or one clean /health sample instead of bounded-state proof.",
    failClosedResponse: "Mark #497 NO-GO until representative no-live history/churn evidence proves bounded heap/readiness behavior.",
  },
  {
    id: "T3",
    area: "terminal_outbox_hygiene",
    trap: "Pruning, expiring, or ACKing unacked terminal-outbox rows as cleanup during validation.",
    failClosedResponse: "Block and request separate DB cleanup/ACK approval; validation may only report compact read-only counts and IDs when safe.",
  },
  {
    id: "T4",
    area: "replay_canary",
    trap: "Using a live provider send, real terminal ACK, or duplicate replay to compensate for missing no-live canary proof.",
    failClosedResponse: "Stop the lane, keep notification/ACK disabled, and require no-live replay evidence before any new live approval request.",
  },
  {
    id: "T5",
    area: "evidence_hygiene",
    trap: "Allowing OpenClaw runtime/bootstrap files, raw session dumps, private host paths, or secret-shaped values into branch diff or artifact evidence.",
    failClosedResponse: "Fail closed before PR creation and report the exact repo-relative offending paths.",
  },
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

export function renderLiberoClosureCriteriaMarkdown(
  criteria: readonly LiberoClosureCriterion[] = LIBERO_CLOSURE_CRITERIA,
): string {
  const rows = criteria.map((item) => (
    `| ${item.id} | ${item.sourceIssue} | ${item.criterion} | ${item.requiredEvidence} | ${item.closesWhen} |`
  ));

  return [
    "| ID | Source | Closure criterion | Required evidence | Closes when |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

export function renderLiberoNoGoTrapsMarkdown(
  traps: readonly LiberoNoGoTrap[] = LIBERO_NO_GO_TRAPS,
): string {
  const rows = traps.map((item) => (
    `| ${item.id} | ${item.area} | ${item.trap} | ${item.failClosedResponse} |`
  ));

  return [
    "| ID | Area | NO-GO trap | Fail-closed response |",
    "| --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}
