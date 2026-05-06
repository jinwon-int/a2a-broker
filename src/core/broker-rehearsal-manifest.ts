import { runReceiptGateCanaryMatrix } from "./receipt-gate-canary.js";

export type BrokerRehearsalRunMode = "no-live";
export type BrokerRehearsalVerdict = "pass" | "fail";

export interface BrokerRehearsalManifestOptions {
  generatedAt?: string;
  runId?: string;
  worker?: string;
  repo?: string;
  issueNumber?: number;
}

export interface BrokerRehearsalManifest {
  kind: "a2a-broker.rehearsal-manifest";
  version: 1;
  runMode: BrokerRehearsalRunMode;
  generatedAt: string;
  runId: string;
  worker: string;
  sourceIssue: {
    repo: string;
    issueNumber: number;
    issueUrl: string;
  };
  safety: {
    productionDeploy: false;
    gatewayRestart: false;
    liveProviderSend: false;
    databaseMutation: false;
    terminalOutboxAck: false;
  };
  canonicalGithubTaskPayload: {
    intent: "propose_patch";
    taskOrigin: "github";
    payload: {
      mode: "github-propose-patch";
      repo: string;
      issue: string;
      issueNumber: number;
      issueUrl: string;
    };
  };
  terminalOutboxReadinessGate: {
    subscribeOnly: true;
    ackEndpointExercised: false;
    requiredAckEvidence: ["operator_visible", "operator_confirmed", "provider_delivery_receipt"];
    rejectedEvidence: ["provider_send_success"];
    readyWhen: string[];
  };
  ackAuditDecisions: Array<{
    receiptStatus: "accepted" | "provider_sent" | "provider_accepted" | "operator_visible" | "failed" | "timed_out" | "stale";
    decision: "pending" | "eligible" | "rejected";
    ackAllowed: boolean;
    evidence?: "operator_visible" | "operator_confirmed" | "provider_delivery_receipt";
    reason: string;
  }>;
  safeEvidenceFields: {
    github: ["prUrl", "doneCommentUrl", "blockCommentUrl"];
    receipt: ["status", "evidence", "receiptId", "updatedAt"];
    terminalPayload: ["run", "traceId", "worker", "repo", "issue", "taskBrief", "testSummary"];
    forbidden: ["rawPrompt", "rawLogs", "localPath", "secrets", "providerSendOnlySuccess"];
  };
  receiptGateCanary: ReturnType<typeof runReceiptGateCanaryMatrix>;
  operatorSummary: string[];
  overallVerdict: BrokerRehearsalVerdict;
}

export function buildBrokerRehearsalManifest(options: BrokerRehearsalManifestOptions = {}): BrokerRehearsalManifest {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const repo = options.repo ?? "jinwon-int/a2a-broker";
  const issueNumber = options.issueNumber ?? 328;
  const issueUrl = `https://github.com/${repo}/issues/${issueNumber}`;
  const receiptGateCanary = runReceiptGateCanaryMatrix({ generatedAt });

  const manifest: BrokerRehearsalManifest = {
    kind: "a2a-broker.rehearsal-manifest",
    version: 1,
    runMode: "no-live",
    generatedAt,
    runId: options.runId ?? "a2a-no-live-integration-rehearsal",
    worker: options.worker ?? "sogyo",
    sourceIssue: { repo, issueNumber, issueUrl },
    safety: {
      productionDeploy: false,
      gatewayRestart: false,
      liveProviderSend: false,
      databaseMutation: false,
      terminalOutboxAck: false,
    },
    canonicalGithubTaskPayload: {
      intent: "propose_patch",
      taskOrigin: "github",
      payload: {
        mode: "github-propose-patch",
        repo,
        issue: `#${issueNumber}`,
        issueNumber,
        issueUrl,
      },
    },
    terminalOutboxReadinessGate: {
      subscribeOnly: true,
      ackEndpointExercised: false,
      requiredAckEvidence: ["operator_visible", "operator_confirmed", "provider_delivery_receipt"],
      rejectedEvidence: ["provider_send_success"],
      readyWhen: [
        "terminal event is replayable from the broker outbox cursor",
        "operator-visible or provider-delivery receipt evidence exists",
        "provider send acceptance alone is held unacked",
      ],
    },
    ackAuditDecisions: [
      {
        receiptStatus: "accepted",
        decision: "pending",
        ackAllowed: false,
        reason: "terminal notice accepted for delivery, but no receipt evidence exists yet",
      },
      {
        receiptStatus: "provider_sent",
        decision: "pending",
        ackAllowed: false,
        reason: "provider send-only success is not terminal ACK evidence",
      },
      {
        receiptStatus: "operator_visible",
        decision: "eligible",
        ackAllowed: true,
        evidence: "operator_visible",
        reason: "operator-visible receipt can satisfy the ACK gate in a live notifier",
      },
      {
        receiptStatus: "failed",
        decision: "pending",
        ackAllowed: false,
        reason: "failed delivery remains replayable/reconcilable and is not acked",
      },
      {
        receiptStatus: "timed_out",
        decision: "pending",
        ackAllowed: false,
        reason: "receipt timeout keeps the terminal event unacked for reconciliation",
      },
      {
        receiptStatus: "stale",
        decision: "pending",
        ackAllowed: false,
        reason: "stale receipt state is surfaced without acknowledging the outbox row",
      },
    ],
    safeEvidenceFields: {
      github: ["prUrl", "doneCommentUrl", "blockCommentUrl"],
      receipt: ["status", "evidence", "receiptId", "updatedAt"],
      terminalPayload: ["run", "traceId", "worker", "repo", "issue", "taskBrief", "testSummary"],
      forbidden: ["rawPrompt", "rawLogs", "localPath", "secrets", "providerSendOnlySuccess"],
    },
    receiptGateCanary,
    operatorSummary: [
      "no-live rehearsal only; no provider send or broker terminal ACK is attempted",
      "canonical GitHub task payload is present for runner/plugin lanes",
      "terminal outbox ACK remains gated on operator-visible/provider-delivery receipt evidence",
      `receipt-gate canary verdict: ${receiptGateCanary.overallVerdict}`,
    ],
    overallVerdict: receiptGateCanary.overallVerdict,
  };

  return manifest;
}

export function renderBrokerRehearsalManifestMarkdown(manifest: BrokerRehearsalManifest): string {
  const safety = Object.entries(manifest.safety)
    .map(([name, attempted]) => `- ${name}: ${attempted ? "attempted" : "not attempted"}`);
  const ackRows = manifest.ackAuditDecisions.map((decision) => (
    `| ${decision.receiptStatus} | ${decision.decision} | ${decision.ackAllowed ? "yes" : "no"} | ${decision.evidence ?? "none"} | ${decision.reason} |`
  ));

  return [
    `A2A broker no-live rehearsal manifest: ${manifest.overallVerdict}`,
    "",
    `Run: ${manifest.runId}`,
    `Generated: ${manifest.generatedAt}`,
    `Source: ${manifest.sourceIssue.issueUrl}`,
    "",
    "Safety gate:",
    ...safety,
    "",
    "Canonical GitHub task payload:",
    `- intent: ${manifest.canonicalGithubTaskPayload.intent}`,
    `- taskOrigin: ${manifest.canonicalGithubTaskPayload.taskOrigin}`,
    `- mode: ${manifest.canonicalGithubTaskPayload.payload.mode}`,
    `- issue: ${manifest.canonicalGithubTaskPayload.payload.repo}#${manifest.canonicalGithubTaskPayload.payload.issueNumber}`,
    "",
    "Terminal outbox readiness:",
    `- subscribeOnly: ${manifest.terminalOutboxReadinessGate.subscribeOnly}`,
    `- ackEndpointExercised: ${manifest.terminalOutboxReadinessGate.ackEndpointExercised}`,
    `- rejected evidence: ${manifest.terminalOutboxReadinessGate.rejectedEvidence.join(", ")}`,
    "",
    "| Receipt status | Decision | ACK allowed | Evidence | Reason |",
    "| --- | --- | --- | --- | --- |",
    ...ackRows,
    "",
    "Operator summary:",
    ...manifest.operatorSummary.map((line) => `- ${line}`),
  ].join("\n");
}
