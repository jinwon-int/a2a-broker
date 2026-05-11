import { createHash } from "node:crypto";

export type SourcePublicApprovalDecision = "GO_CANDIDATE" | "NO_GO" | "NEEDS_OPERATOR_APPROVAL";
export type SourcePublicEvidenceStatus = "pass" | "warn" | "fail" | "pending";

export interface SourcePublicApprovalRehearsalOptions {
  generatedAt?: string;
  runId?: string;
  repo?: string;
  issueNumber?: number;
  parentIssueUrl?: string;
  worker?: string;
  operator?: string;
  approvalIntentId?: string;
  priorApprovalIntentIds?: string[];
  evidence?: Partial<SourcePublicEvidenceInputs>;
}

export interface SourcePublicEvidenceInputs {
  publicReadinessScan: SourcePublicEvidenceStatus;
  bootstrapContextExcluded: SourcePublicEvidenceStatus;
  localTests: SourcePublicEvidenceStatus;
  licenseDecision: SourcePublicEvidenceStatus;
  externalScannerEvidence: SourcePublicEvidenceStatus;
  explicitOperatorApproval: SourcePublicEvidenceStatus;
}

export interface SourcePublicApprovalRehearsalBundle {
  kind: "a2a-broker.source-public-approval-rehearsal";
  version: 1;
  runMode: "read-only-no-live";
  generatedAt: string;
  runId: string;
  worker: string;
  sourceIssue: {
    repo: string;
    issueNumber: number;
    issueUrl: string;
    parentIssueUrl: string;
  };
  safety: {
    productionDeploy: false;
    gatewayRestart: false;
    brokerWorkerRestart: false;
    liveProviderSend: false;
    terminalBriefAck: false;
    productionDatabaseMutation: false;
    secretOrVisibilityChange: false;
    releasePublication: false;
    approvalExecution: false;
  };
  approvalPacket: {
    packetId: string;
    requestedAction: "source-public-visibility-approval";
    status: "rehearsed-not-executed";
    approver: string;
    operatorApprovalRequired: true;
    executionAllowed: false;
    intentId: string;
    idempotencyKey: string;
    requestFingerprint: string;
    forbiddenActions: string[];
  };
  approvalIntentRehearsalRecord: {
    recordId: string;
    idempotencyKey: string;
    intentId: string;
    replaySafe: boolean;
    duplicate: boolean;
    duplicateOf?: string;
    persistence: "not-written";
    mutationAttempted: false;
    replayProof: string;
  };
  evidenceBundle: {
    bundleId: string;
    redaction: {
      rawPromptIncluded: false;
      rawLogsIncluded: false;
      secretsIncluded: false;
      hostPrivatePathsIncluded: false;
      allowedFields: string[];
    };
    checks: SourcePublicEvidenceInputs;
    terminalBriefRehearsal: {
      mode: "no-live";
      rendered: true;
      liveProviderSendAttempted: false;
      terminalAckAttempted: false;
      terminalBriefAckEligible: false;
      proof: string;
    };
    replayNoDuplicateProof: {
      idempotencyKey: string;
      duplicate: boolean;
      proof: string;
    };
    rollbackAbortPaths: string[];
  };
  decision: {
    value: SourcePublicApprovalDecision;
    reasons: string[];
    nextOperatorAction: string;
  };
}

const DEFAULT_RUN_ID = "a2a-source-public-approval-rehearsal-20260511T014240Z";
const DEFAULT_REPO = "jinwon-int/a2a-broker";
const DEFAULT_ISSUE = 484;
const DEFAULT_PARENT = "https://github.com/jinwon-int/a2a-plane/issues/211";

const DEFAULT_EVIDENCE: SourcePublicEvidenceInputs = {
  publicReadinessScan: "pending",
  bootstrapContextExcluded: "pending",
  localTests: "pending",
  licenseDecision: "pending",
  externalScannerEvidence: "pending",
  explicitOperatorApproval: "pending",
};

const FORBIDDEN_ACTIONS = [
  "approval execution",
  "repository visibility change",
  "release publication",
  "production deploy",
  "Gateway/broker/worker restart",
  "live provider or Telegram send",
  "terminal ACK",
  "production DB mutation",
  "secret change",
  "history rewrite or force-push",
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

function mergeEvidence(evidence: Partial<SourcePublicEvidenceInputs> | undefined): SourcePublicEvidenceInputs {
  return { ...DEFAULT_EVIDENCE, ...evidence };
}

function decide(checks: SourcePublicEvidenceInputs, duplicate: boolean): SourcePublicApprovalRehearsalBundle["decision"] {
  const failed = Object.entries(checks).filter(([, status]) => status === "fail").map(([name]) => name);
  const pending = Object.entries(checks).filter(([, status]) => status === "pending").map(([name]) => name);
  const reasons: string[] = [];

  if (failed.length > 0) {
    reasons.push(`failed evidence gates: ${failed.join(", ")}`);
    return {
      value: "NO_GO",
      reasons,
      nextOperatorAction: "Fix failed evidence gates, rerun rehearsal, and do not approve source-public execution.",
    };
  }

  if (duplicate) {
    reasons.push("approval-intent rehearsal is a replay of an existing idempotency key; no duplicate record should be written");
  }

  if (checks.explicitOperatorApproval !== "pass") {
    reasons.push("explicit operator approval is absent from this read-only rehearsal");
    if (pending.length > 0) reasons.push(`pending evidence gates: ${pending.join(", ")}`);
    return {
      value: "NEEDS_OPERATOR_APPROVAL",
      reasons,
      nextOperatorAction: "Review the deterministic approval packet and explicitly approve or reject the named source-public action outside this rehearsal.",
    };
  }

  if (pending.length > 0) {
    reasons.push(`pending evidence gates: ${pending.join(", ")}`);
    return {
      value: "NO_GO",
      reasons,
      nextOperatorAction: "Complete pending evidence gates before requesting source-public approval.",
    };
  }

  reasons.push("all local evidence gates passed and explicit operator approval is recorded as present");
  return {
    value: "GO_CANDIDATE",
    reasons,
    nextOperatorAction: "Operator may perform the real source-public action in a separate approved live run; this rehearsal still executed nothing.",
  };
}

export function buildSourcePublicApprovalRehearsalBundle(
  options: SourcePublicApprovalRehearsalOptions = {},
): SourcePublicApprovalRehearsalBundle {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const runId = options.runId ?? DEFAULT_RUN_ID;
  const repo = options.repo ?? DEFAULT_REPO;
  const issueNumber = options.issueNumber ?? DEFAULT_ISSUE;
  const issueUrl = `https://github.com/${repo}/issues/${issueNumber}`;
  const worker = options.worker ?? "dungae";
  const approver = options.operator ?? "operator-required";
  const checks = mergeEvidence(options.evidence);

  const intentSeed = {
    runId,
    repo,
    issueNumber,
    requestedAction: "source-public-visibility-approval",
    approver,
  };
  const intentId = options.approvalIntentId ?? sha256("approval-intent", intentSeed);
  const idempotencyKey = sha256("source-public-approval", { intentId, ...intentSeed });
  const duplicate = (options.priorApprovalIntentIds ?? []).includes(intentId)
    || (options.priorApprovalIntentIds ?? []).includes(idempotencyKey);
  const requestFingerprint = sha256("approval-request", {
    intentId,
    runId,
    repo,
    issueNumber,
    safety: "no-live-read-only",
  });
  const packetId = sha256("approval-packet", { idempotencyKey, requestFingerprint });
  const recordId = sha256("approval-rehearsal-record", { idempotencyKey, intentId });
  const bundleId = sha256("evidence-bundle", { packetId, checks });

  const decision = decide(checks, duplicate);

  return {
    kind: "a2a-broker.source-public-approval-rehearsal",
    version: 1,
    runMode: "read-only-no-live",
    generatedAt,
    runId,
    worker,
    sourceIssue: {
      repo,
      issueNumber,
      issueUrl,
      parentIssueUrl: options.parentIssueUrl ?? DEFAULT_PARENT,
    },
    safety: {
      productionDeploy: false,
      gatewayRestart: false,
      brokerWorkerRestart: false,
      liveProviderSend: false,
      terminalBriefAck: false,
      productionDatabaseMutation: false,
      secretOrVisibilityChange: false,
      releasePublication: false,
      approvalExecution: false,
    },
    approvalPacket: {
      packetId,
      requestedAction: "source-public-visibility-approval",
      status: "rehearsed-not-executed",
      approver,
      operatorApprovalRequired: true,
      executionAllowed: false,
      intentId,
      idempotencyKey,
      requestFingerprint,
      forbiddenActions: FORBIDDEN_ACTIONS,
    },
    approvalIntentRehearsalRecord: {
      recordId,
      idempotencyKey,
      intentId,
      replaySafe: true,
      duplicate,
      duplicateOf: duplicate ? intentId : undefined,
      persistence: "not-written",
      mutationAttempted: false,
      replayProof: duplicate
        ? "matching prior intent/key detected; rehearsal returns the existing logical record without writing"
        : "no prior intent/key supplied; first rehearsal packet is deterministic but not persisted",
    },
    evidenceBundle: {
      bundleId,
      redaction: {
        rawPromptIncluded: false,
        rawLogsIncluded: false,
        secretsIncluded: false,
        hostPrivatePathsIncluded: false,
        allowedFields: [
          "runId",
          "repo",
          "issueNumber",
          "packetId",
          "intentId",
          "idempotencyKey",
          "decision",
          "sanitized check statuses",
        ],
      },
      checks,
      terminalBriefRehearsal: {
        mode: "no-live",
        rendered: true,
        liveProviderSendAttempted: false,
        terminalAckAttempted: false,
        terminalBriefAckEligible: false,
        proof: "Terminal Brief packet is rendered for operator review only; no provider send or ACK endpoint is exercised.",
      },
      replayNoDuplicateProof: {
        idempotencyKey,
        duplicate,
        proof: duplicate
          ? "same intent/key replays to the same packet and suppresses duplicate record creation"
          : "idempotency key is derived from stable run/action fields and can be replay-compared before any write",
      },
      rollbackAbortPaths: [
        "Abort if any evidence gate fails or remains pending before live execution.",
        "Close or supersede this rehearsal packet; no broker state rollback is required because persistence is not written.",
        "Require a fresh explicit operator approval for any future source-public visibility/release action.",
      ],
    },
    decision,
  };
}

export function renderSourcePublicApprovalRehearsalMarkdown(bundle: SourcePublicApprovalRehearsalBundle): string {
  const safetyRows = Object.entries(bundle.safety).map(
    ([name, attempted]) => `| ${name} | ${attempted ? "attempted" : "not attempted"} |`,
  );
  const checkRows = Object.entries(bundle.evidenceBundle.checks).map(([name, status]) => `| ${name} | ${status} |`);

  return [
    `# Source-public approval rehearsal: ${bundle.decision.value}`,
    "",
    `Run: ${bundle.runId}`,
    `Generated: ${bundle.generatedAt}`,
    `Source: ${bundle.sourceIssue.issueUrl}`,
    `Parent: ${bundle.sourceIssue.parentIssueUrl}`,
    `Worker: ${bundle.worker}`,
    "",
    "## Approval packet",
    "",
    `- packetId: ${bundle.approvalPacket.packetId}`,
    `- intentId: ${bundle.approvalPacket.intentId}`,
    `- idempotencyKey: ${bundle.approvalPacket.idempotencyKey}`,
    `- status: ${bundle.approvalPacket.status}`,
    `- executionAllowed: ${bundle.approvalPacket.executionAllowed}`,
    "",
    "## Safety gates",
    "",
    "| Action | State |",
    "| --- | --- |",
    ...safetyRows,
    "",
    "## Evidence checks",
    "",
    "| Check | Status |",
    "| --- | --- |",
    ...checkRows,
    "",
    "## Terminal Brief rehearsal",
    "",
    `- mode: ${bundle.evidenceBundle.terminalBriefRehearsal.mode}`,
    `- liveProviderSendAttempted: ${bundle.evidenceBundle.terminalBriefRehearsal.liveProviderSendAttempted}`,
    `- terminalAckAttempted: ${bundle.evidenceBundle.terminalBriefRehearsal.terminalAckAttempted}`,
    `- proof: ${bundle.evidenceBundle.terminalBriefRehearsal.proof}`,
    "",
    "## Replay/no-duplicate proof",
    "",
    `- duplicate: ${bundle.approvalIntentRehearsalRecord.duplicate}`,
    `- persistence: ${bundle.approvalIntentRehearsalRecord.persistence}`,
    `- mutationAttempted: ${bundle.approvalIntentRehearsalRecord.mutationAttempted}`,
    `- proof: ${bundle.evidenceBundle.replayNoDuplicateProof.proof}`,
    "",
    "## Rollback / abort paths",
    "",
    ...bundle.evidenceBundle.rollbackAbortPaths.map((path) => `- ${path}`),
    "",
    "## Decision",
    "",
    `- value: ${bundle.decision.value}`,
    ...bundle.decision.reasons.map((reason) => `- reason: ${reason}`),
    `- nextOperatorAction: ${bundle.decision.nextOperatorAction}`,
  ].join("\n");
}
