import { createHash } from "node:crypto";

export type SourcePublicExecutionRunMode = "dry-run" | "simulate";
export type SourcePublicExecutionPreflightStatus = "pass" | "warn" | "fail" | "pending";
export type SourcePublicExecutionDecision =
  | "READY_FOR_OPERATOR_APPROVAL"
  | "NEEDS_OPERATOR_APPROVAL"
  | "PREFLIGHT_BLOCKED"
  | "REPLAY_SUPPRESSED";

export interface SourcePublicApprovedEvidencePacket {
  packetId: string;
  intentId: string;
  idempotencyKey: string;
  evidenceBundleId: string;
  decision: "GO_CANDIDATE" | "NO_GO" | "NEEDS_OPERATOR_APPROVAL" | string;
  approvedBy?: string;
  approvedAt?: string;
}

export interface SourcePublicScannerHistoryBinding {
  scannerRunId?: string;
  scannerDigest?: string;
  historyCursor?: string;
  historyDigest?: string;
}

export interface SourcePublicExecutionPreflights {
  evidencePacketApproved: SourcePublicExecutionPreflightStatus;
  scannerHistoryBound: SourcePublicExecutionPreflightStatus;
  bootstrapContextExcluded: SourcePublicExecutionPreflightStatus;
  rollbackAbortRunbookPresent: SourcePublicExecutionPreflightStatus;
  explicitOperatorGatePresent: SourcePublicExecutionPreflightStatus;
}

export interface SourcePublicExecutionOrchestratorOptions {
  generatedAt?: string;
  runId?: string;
  repo?: string;
  issueNumber?: number;
  parentIssueUrl?: string;
  worker?: string;
  runMode?: SourcePublicExecutionRunMode;
  approvedEvidencePacket: SourcePublicApprovedEvidencePacket;
  scannerHistory: SourcePublicScannerHistoryBinding;
  preflights?: Partial<SourcePublicExecutionPreflights>;
  priorExecutionKeys?: string[];
}

export interface SourcePublicExecutionLedgerEntry {
  ledgerId: string;
  executionIntentId: string;
  executionIdempotencyKey: string;
  packetId: string;
  evidenceBundleId: string;
  scannerRunId: string;
  scannerDigest: string;
  historyCursor: string;
  historyDigest: string;
  replay: boolean;
  replayOf?: string;
  persistence: "not-written";
  mutationAttempted: false;
}

export interface SourcePublicGoNoGoGateLedgerEntry {
  gate: keyof SourcePublicExecutionPreflights;
  status: SourcePublicExecutionPreflightStatus;
  requiredForGo: true;
  effect: "allow-review" | "warn-review" | "block-execution" | "await-operator";
}

export interface SourcePublicApprovalIntentRecord {
  recordId: string;
  approvalIntentId: string;
  approvalIdempotencyKey: string;
  requestedAction: "source-public-execution-final-approval";
  explicitOperatorApprovalRequired: true;
  explicitOperatorApprovalPresent: boolean;
  decision: SourcePublicExecutionDecision;
  persistence: "not-written";
  mutationAttempted: false;
  replaySafe: true;
}

export interface SourcePublicExecutionPlanBundle {
  kind: "a2a-broker.source-public-final-approval-execution-plan";
  version: 1;
  generatedAt: string;
  runId: string;
  worker: string;
  runMode: SourcePublicExecutionRunMode;
  sourceIssue: {
    repo: string;
    issueNumber: number;
    issueUrl: string;
    parentIssueUrl: string;
  };
  finalApprovalPacket: {
    finalApprovalPacketId: string;
    requestedAction: "source-public-execution-final-approval";
    status: "approval-ready-not-executed" | "blocked-not-executed" | "replay-suppressed-not-executed";
    approvedEvidencePacketId: string;
    approvalIntentId: string;
    approvalIdempotencyKey: string;
    executionIntentId: string;
    executionIdempotencyKey: string;
    operatorApprovalRequired: true;
    explicitOperatorGate: true;
    executionAllowed: false;
    mutationAllowed: false;
  };
  ledgerEntry: SourcePublicExecutionLedgerEntry;
  goNoGoGateLedger: SourcePublicGoNoGoGateLedgerEntry[];
  approvalIntentRecord: SourcePublicApprovalIntentRecord;
  scannerHistoryBinding: Required<SourcePublicScannerHistoryBinding> & {
    bound: boolean;
  };
  preflight: {
    ok: boolean;
    checks: SourcePublicExecutionPreflights;
    failures: string[];
    pending: string[];
    warnings: string[];
    semantics: string;
  };
  rollbackAbortRunbook: string[];
  safety: {
    dryRunOnly: true;
    simulateOnly: boolean;
    liveActionAllowed: false;
    prohibitedActions: string[];
  };
  redaction: {
    rawEvidenceIncluded: false;
    rawPromptIncluded: false;
    rawLogsIncluded: false;
    secretsIncluded: false;
    hostPrivatePathsIncluded: false;
    runtimeBootstrapContextIncluded: false;
    allowedFields: string[];
  };
  decision: {
    value: SourcePublicExecutionDecision;
    reasons: string[];
    nextOperatorAction: string;
  };
}

const DEFAULT_RUN_ID = "a2a-source-public-execution-orchestrator-20260511T023207Z";
const DEFAULT_REPO = "jinwon-int/a2a-broker";
const DEFAULT_ISSUE = 486;
const DEFAULT_PARENT = "https://github.com/jinwon-int/a2a-plane/issues/218";
const DEFAULT_PREFLIGHTS: SourcePublicExecutionPreflights = {
  evidencePacketApproved: "pending",
  scannerHistoryBound: "pending",
  bootstrapContextExcluded: "pending",
  rollbackAbortRunbookPresent: "pass",
  explicitOperatorGatePresent: "pass",
};

const PROHIBITED_ACTIONS = [
  "approval_execution",
  "repository_visibility_change",
  "release_publication",
  "production_deploy",
  "gateway_restart",
  "broker_or_worker_restart",
  "live_provider_or_telegram_send",
  "terminal_ack",
  "production_db_mutation",
  "secret_change",
  "history_rewrite_or_force_push",
  "community_post",
  "automatic_merge_or_approval",
];

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function sha256(prefix: string, value: unknown): string {
  return `${prefix}-${createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 24)}`;
}

function mergePreflights(preflights: Partial<SourcePublicExecutionPreflights> | undefined): SourcePublicExecutionPreflights {
  return { ...DEFAULT_PREFLIGHTS, ...preflights };
}

export function buildSourcePublicExecutionPlanBundle(
  options: SourcePublicExecutionOrchestratorOptions,
): SourcePublicExecutionPlanBundle {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const runId = safeToken(options.runId) ?? DEFAULT_RUN_ID;
  const repo = safeRepo(options.repo) ?? DEFAULT_REPO;
  const issueNumber = Number.isInteger(options.issueNumber) && options.issueNumber && options.issueNumber > 0
    ? options.issueNumber
    : DEFAULT_ISSUE;
  const worker = safeToken(options.worker) ?? "dungae";
  const runMode = options.runMode ?? "dry-run";
  const approvedPacket = normalizeApprovedPacket(options.approvedEvidencePacket);
  const scannerHistory = normalizeScannerHistory(options.scannerHistory);
  const preflightChecks = normalizePreflights(mergePreflights(options.preflights), approvedPacket, scannerHistory);
  const failures = statusKeys(preflightChecks, "fail");
  const pending = statusKeys(preflightChecks, "pending");
  const warnings = statusKeys(preflightChecks, "warn");

  const executionIntentSeed = {
    runId,
    repo,
    issueNumber,
    runMode,
    packetId: approvedPacket.packetId,
    approvalIntentId: approvedPacket.intentId,
    approvalIdempotencyKey: approvedPacket.idempotencyKey,
    scannerRunId: scannerHistory.scannerRunId,
    scannerDigest: scannerHistory.scannerDigest,
    historyCursor: scannerHistory.historyCursor,
    historyDigest: scannerHistory.historyDigest,
    requestedAction: "source-public-execution-final-approval",
  };
  const executionIntentId = sha256("source-public-execution-intent", executionIntentSeed);
  const executionIdempotencyKey = sha256("source-public-execution", { executionIntentId, ...executionIntentSeed });
  const replay = (options.priorExecutionKeys ?? []).includes(executionIntentId)
    || (options.priorExecutionKeys ?? []).includes(executionIdempotencyKey);
  const ledgerId = sha256("source-public-execution-ledger", { executionIntentId, executionIdempotencyKey });
  const finalApprovalPacketId = sha256("source-public-final-approval-packet", {
    executionIdempotencyKey,
    packetId: approvedPacket.packetId,
  });

  const decision = decide(preflightChecks, approvedPacket, replay);
  const goNoGoGateLedger = buildGoNoGoGateLedger(preflightChecks);
  const approvalIntentRecord: SourcePublicApprovalIntentRecord = {
    recordId: sha256("source-public-approval-intent-record", {
      executionIntentId,
      executionIdempotencyKey,
      decision: decision.value,
    }),
    approvalIntentId: executionIntentId,
    approvalIdempotencyKey: executionIdempotencyKey,
    requestedAction: "source-public-execution-final-approval",
    explicitOperatorApprovalRequired: true,
    explicitOperatorApprovalPresent: preflightChecks.explicitOperatorGatePresent === "pass",
    decision: decision.value,
    persistence: "not-written",
    mutationAttempted: false,
    replaySafe: true,
  };

  return {
    kind: "a2a-broker.source-public-final-approval-execution-plan",
    version: 1,
    generatedAt,
    runId,
    worker,
    runMode,
    sourceIssue: {
      repo,
      issueNumber,
      issueUrl: `https://github.com/${repo}/issues/${issueNumber}`,
      parentIssueUrl: safeGithubIssueUrl(options.parentIssueUrl) ?? DEFAULT_PARENT,
    },
    finalApprovalPacket: {
      finalApprovalPacketId,
      requestedAction: "source-public-execution-final-approval",
      status: replay
        ? "replay-suppressed-not-executed"
        : decision.value === "READY_FOR_OPERATOR_APPROVAL"
          ? "approval-ready-not-executed"
          : "blocked-not-executed",
      approvedEvidencePacketId: approvedPacket.packetId,
      approvalIntentId: approvedPacket.intentId,
      approvalIdempotencyKey: approvedPacket.idempotencyKey,
      executionIntentId,
      executionIdempotencyKey,
      operatorApprovalRequired: true,
      explicitOperatorGate: true,
      executionAllowed: false,
      mutationAllowed: false,
    },
    ledgerEntry: {
      ledgerId,
      executionIntentId,
      executionIdempotencyKey,
      packetId: approvedPacket.packetId,
      evidenceBundleId: approvedPacket.evidenceBundleId,
      scannerRunId: scannerHistory.scannerRunId,
      scannerDigest: scannerHistory.scannerDigest,
      historyCursor: scannerHistory.historyCursor,
      historyDigest: scannerHistory.historyDigest,
      replay,
      replayOf: replay ? executionIdempotencyKey : undefined,
      persistence: "not-written",
      mutationAttempted: false,
    },
    goNoGoGateLedger,
    approvalIntentRecord,
    scannerHistoryBinding: {
      ...scannerHistory,
      bound: preflightChecks.scannerHistoryBound !== "fail" && preflightChecks.scannerHistoryBound !== "pending",
    },
    preflight: {
      ok: failures.length === 0 && pending.length === 0,
      checks: preflightChecks,
      failures,
      pending,
      warnings,
      semantics: failures.length > 0
        ? "fail-closed: one or more preflight gates failed; no execution packet may be used for live action"
        : pending.length > 0
          ? "fail-closed: preflight evidence is incomplete; operator must not execute live action"
          : "preflight clean for operator review only; live execution still requires a separate explicit approval run",
    },
    rollbackAbortRunbook: [
      "Abort immediately if any preflight is fail or pending; do not execute visibility/release/provider/deploy/DB/ACK actions.",
      "On replay, return the existing execution idempotency key and suppress duplicate ledger writes.",
      "If scanner or history binding changes, discard this packet and build a new final approval packet from the new evidence digest.",
      "If operator rejects or withholds approval, close/supersede the packet; no broker rollback is required because this model writes no state.",
      "For any later live run, require fresh explicit operator approval and re-check all safety gates before mutation-capable code is reachable.",
    ],
    safety: {
      dryRunOnly: true,
      simulateOnly: runMode === "simulate",
      liveActionAllowed: false,
      prohibitedActions: [...PROHIBITED_ACTIONS],
    },
    redaction: {
      rawEvidenceIncluded: false,
      rawPromptIncluded: false,
      rawLogsIncluded: false,
      secretsIncluded: false,
      hostPrivatePathsIncluded: false,
      runtimeBootstrapContextIncluded: false,
      allowedFields: [
        "runId",
        "repo",
        "issueNumber",
        "approved evidence packet ids",
        "scanner/history digests",
        "preflight statuses",
        "execution idempotency key",
        "decision",
      ],
    },
    decision,
  };
}

export function renderSourcePublicExecutionPlanMarkdown(bundle: SourcePublicExecutionPlanBundle): string {
  const preflightRows = Object.entries(bundle.preflight.checks).map(([name, status]) => `| ${name} | ${status} |`);
  return [
    `# Source-public final approval execution plan: ${bundle.decision.value}`,
    "",
    `Run: ${bundle.runId}`,
    `Generated: ${bundle.generatedAt}`,
    `Mode: ${bundle.runMode}`,
    `Source: ${bundle.sourceIssue.issueUrl}`,
    `Parent: ${bundle.sourceIssue.parentIssueUrl}`,
    `Worker: ${bundle.worker}`,
    "",
    "## Final approval packet",
    "",
    `- finalApprovalPacketId: ${bundle.finalApprovalPacket.finalApprovalPacketId}`,
    `- approvedEvidencePacketId: ${bundle.finalApprovalPacket.approvedEvidencePacketId}`,
    `- executionIntentId: ${bundle.finalApprovalPacket.executionIntentId}`,
    `- executionIdempotencyKey: ${bundle.finalApprovalPacket.executionIdempotencyKey}`,
    `- status: ${bundle.finalApprovalPacket.status}`,
    `- operatorApprovalRequired: ${bundle.finalApprovalPacket.operatorApprovalRequired}`,
    `- executionAllowed: ${bundle.finalApprovalPacket.executionAllowed}`,
    `- mutationAllowed: ${bundle.finalApprovalPacket.mutationAllowed}`,
    "",
    "## Scanner/history binding",
    "",
    `- scannerRunId: ${bundle.scannerHistoryBinding.scannerRunId}`,
    `- scannerDigest: ${bundle.scannerHistoryBinding.scannerDigest}`,
    `- historyCursor: ${bundle.scannerHistoryBinding.historyCursor}`,
    `- historyDigest: ${bundle.scannerHistoryBinding.historyDigest}`,
    `- bound: ${bundle.scannerHistoryBinding.bound}`,
    "",
    "## Preflight gates",
    "",
    "| Gate | Status |",
    "| --- | --- |",
    ...preflightRows,
    "",
    `Preflight ok: ${bundle.preflight.ok}`,
    `Semantics: ${bundle.preflight.semantics}`,
    "",
    "## Ledger/idempotency",
    "",
    `- ledgerId: ${bundle.ledgerEntry.ledgerId}`,
    `- replay: ${bundle.ledgerEntry.replay}`,
    `- persistence: ${bundle.ledgerEntry.persistence}`,
    `- mutationAttempted: ${bundle.ledgerEntry.mutationAttempted}`,
    "",
    "## Final go/no-go gate ledger",
    "",
    "| Gate | Status | Effect |",
    "| --- | --- | --- |",
    ...bundle.goNoGoGateLedger.map((entry) => `| ${entry.gate} | ${entry.status} | ${entry.effect} |`),
    "",
    "## Approval intent record",
    "",
    `- recordId: ${bundle.approvalIntentRecord.recordId}`,
    `- approvalIntentId: ${bundle.approvalIntentRecord.approvalIntentId}`,
    `- approvalIdempotencyKey: ${bundle.approvalIntentRecord.approvalIdempotencyKey}`,
    `- explicitOperatorApprovalRequired: ${bundle.approvalIntentRecord.explicitOperatorApprovalRequired}`,
    `- explicitOperatorApprovalPresent: ${bundle.approvalIntentRecord.explicitOperatorApprovalPresent}`,
    `- decision: ${bundle.approvalIntentRecord.decision}`,
    `- persistence: ${bundle.approvalIntentRecord.persistence}`,
    `- mutationAttempted: ${bundle.approvalIntentRecord.mutationAttempted}`,
    "",
    "## Rollback / abort runbook",
    "",
    ...bundle.rollbackAbortRunbook.map((step) => `- ${step}`),
    "",
    "## Decision",
    "",
    `- value: ${bundle.decision.value}`,
    ...bundle.decision.reasons.map((reason) => `- reason: ${reason}`),
    `- nextOperatorAction: ${bundle.decision.nextOperatorAction}`,
    "",
    "No approval execution, repository visibility change, release publication, provider send, deploy/restart, terminal ACK, DB mutation, community post, merge/approval, history rewrite, or force-push is performed by this plan.",
  ].join("\n");
}

function buildGoNoGoGateLedger(checks: SourcePublicExecutionPreflights): SourcePublicGoNoGoGateLedgerEntry[] {
  return (Object.keys(checks) as Array<keyof SourcePublicExecutionPreflights>).sort().map((gate) => {
    const status = checks[gate];
    return {
      gate,
      status,
      requiredForGo: true,
      effect: gateEffect(status),
    };
  });
}

function gateEffect(status: SourcePublicExecutionPreflightStatus): SourcePublicGoNoGoGateLedgerEntry["effect"] {
  if (status === "pass") return "allow-review";
  if (status === "warn") return "warn-review";
  if (status === "pending") return "await-operator";
  return "block-execution";
}

function normalizeApprovedPacket(packet: SourcePublicApprovedEvidencePacket): SourcePublicApprovedEvidencePacket {
  return {
    packetId: safeToken(packet.packetId) ?? "packet-redacted",
    intentId: safeToken(packet.intentId) ?? "intent-redacted",
    idempotencyKey: safeToken(packet.idempotencyKey) ?? "idempotency-redacted",
    evidenceBundleId: safeToken(packet.evidenceBundleId) ?? "evidence-bundle-redacted",
    decision: safeToken(packet.decision) ?? "NEEDS_OPERATOR_APPROVAL",
    ...(safeToken(packet.approvedBy) ? { approvedBy: safeToken(packet.approvedBy) } : {}),
    ...(safeIso(packet.approvedAt) ? { approvedAt: packet.approvedAt } : {}),
  };
}

function normalizeScannerHistory(binding: SourcePublicScannerHistoryBinding): Required<SourcePublicScannerHistoryBinding> {
  return {
    scannerRunId: safeToken(binding.scannerRunId) ?? "missing-scanner-run",
    scannerDigest: safeDigest(binding.scannerDigest) ?? "missing-scanner-digest",
    historyCursor: safeToken(binding.historyCursor) ?? "missing-history-cursor",
    historyDigest: safeDigest(binding.historyDigest) ?? "missing-history-digest",
  };
}

function normalizePreflights(
  checks: SourcePublicExecutionPreflights,
  approvedPacket: SourcePublicApprovedEvidencePacket,
  scannerHistory: Required<SourcePublicScannerHistoryBinding>,
): SourcePublicExecutionPreflights {
  return {
    ...checks,
    evidencePacketApproved: approvedPacket.decision === "GO_CANDIDATE" ? checks.evidencePacketApproved : "fail",
    scannerHistoryBound: Object.values(scannerHistory).some((value) => value.startsWith("missing-"))
      ? "fail"
      : checks.scannerHistoryBound,
  };
}

function decide(
  checks: SourcePublicExecutionPreflights,
  approvedPacket: SourcePublicApprovedEvidencePacket,
  replay: boolean,
): SourcePublicExecutionPlanBundle["decision"] {
  const failures = statusKeys(checks, "fail");
  const pending = statusKeys(checks, "pending");
  const warnings = statusKeys(checks, "warn");
  const reasons: string[] = [];

  if (replay) {
    reasons.push("matching execution intent/idempotency key already exists; duplicate execution ledger write is suppressed");
    return {
      value: "REPLAY_SUPPRESSED",
      reasons,
      nextOperatorAction: "Review the existing execution packet instead of creating or executing a duplicate.",
    };
  }

  if (approvedPacket.decision !== "GO_CANDIDATE") {
    reasons.push(`approved evidence packet is not a GO_CANDIDATE: ${approvedPacket.decision}`);
  }

  if (failures.length > 0) {
    reasons.push(`failed preflight gates: ${failures.join(", ")}`);
    return {
      value: "PREFLIGHT_BLOCKED",
      reasons,
      nextOperatorAction: "Fix failed gates and rebuild the final approval packet; do not execute source-public actions.",
    };
  }

  if (pending.length > 0) {
    reasons.push(`pending preflight gates: ${pending.join(", ")}`);
    return {
      value: "NEEDS_OPERATOR_APPROVAL",
      reasons,
      nextOperatorAction: "Complete pending gates and obtain explicit operator approval before any separate live execution path.",
    };
  }

  if (warnings.length > 0) reasons.push(`warning preflight gates: ${warnings.join(", ")}`);
  reasons.push("all required final approval preflights passed for operator review; execution remains disabled in this plan");
  return {
    value: "READY_FOR_OPERATOR_APPROVAL",
    reasons,
    nextOperatorAction: "Operator may review this packet for a separate explicit live approval run; this plan itself must not execute mutations.",
  };
}

function statusKeys(checks: SourcePublicExecutionPreflights, status: SourcePublicExecutionPreflightStatus): string[] {
  return Object.entries(checks)
    .filter(([, value]) => value === status)
    .map(([key]) => key)
    .sort();
}

const GITHUB_ISSUE_RE = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/\d+$/;
const SECRETISH_RE = /token|secret|chat_id|BROKER_EDGE_SECRET|EDGE_SECRET|\/work\//i;

function safeRepo(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed) && !SECRETISH_RE.test(trimmed) ? trimmed : undefined;
}

function safeGithubIssueUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return GITHUB_ISSUE_RE.test(trimmed) && !SECRETISH_RE.test(trimmed) ? trimmed : undefined;
}

function safeToken(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value).trim();
  return /^[A-Za-z0-9._:#/-]{1,160}$/.test(text) && !SECRETISH_RE.test(text) ? text : undefined;
}

function safeDigest(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return /^(?:sha256:)?[a-fA-F0-9]{16,128}$/.test(text) ? text : undefined;
}

function safeIso(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return Number.isFinite(Date.parse(value)) ? value : undefined;
}
