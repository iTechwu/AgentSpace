// 从 commands/integrations/feishu.ts 拆出（3.6-3），由原文件 barrel 再导出。

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  listExternalChannelBindingsSync,
  listExternalDataOperationRunsSync,
  listExternalIntegrationEventsSync,
  listExternalIntegrationsSync,
  listExternalMessageMappingsSync,
  listExternalMessageOutboxSync,
  listExternalThreadBindingsSync,
  type ExternalChannelBindingRecord,
  type ExternalDataOperationRunRecord,
  type ExternalIntegrationEventRecord,
  type ExternalIntegrationRecord,
  type ExternalMessageMappingRecord,
  type ExternalMessageOutboxRecord,
  type ExternalThreadBindingRecord
} from "@dofe-agent/db";
import {
  FEISHU_LARK_CLI_RESULT_MANIFEST_RELATIVE_PATH,
  FEISHU_OPENAPI_REQUIRED_DESTRUCTIVE_LIVE_SMOKE_STEPS,
  FEISHU_OPENAPI_REQUIRED_LIVE_SMOKE_STEPS,
  FEISHU_OPENAPI_REQUIRED_REQUEST_STEPS,
  FEISHU_PROVIDER_ID
} from "@dofe-agent/services";
import { uniqueStrings } from "./cli-shared.ts";
import { buildFeishuAgentChannelAccessSmokeCommands, buildFeishuDataPlaneSmokeCommands, buildFeishuExternalGuestPolicySmokeCommands, buildFeishuSmokeHarnessSummary } from "./smoke-env.ts";
import { FEISHU_CLI_PLACEHOLDERS, FEISHU_SMOKE_EVIDENCE_MAX_AGE_MS, FEISHU_SMOKE_EVIDENCE_MAX_FUTURE_SKEW_MS } from "./types.ts";
import { buildFeishuWorkerHarnessSummary } from "./worker.ts";
import type { BuildFeishuEvidenceReportInput, FeishuBotAddedPayloadEvidenceVerification, FeishuEvidenceRemediationStep, FeishuEvidenceReport, FeishuEvidenceRequirement, FeishuExpectedBotAddedPayloadChatReferenceProof, FeishuExpectedBotAddedPayloadIdentityProof, FeishuExpectedCallbackRouteProof, FeishuExpectedTodo120NativeSecondAgentAppProof, FeishuIntegrationEvidence, FeishuIntegrationEvidenceSource, FeishuLocalEvidenceFreshnessSummary, FeishuOpenApiSmokeEvidenceVerification } from "./types.ts";

export function buildFeishuEvidenceReport(input: BuildFeishuEvidenceReportInput): FeishuEvidenceReport {
  const requiredEvidence = input.requiredEvidence ?? "bot";
  const sourceIntegrations = input.integrations ?? listExternalIntegrationsSync({
    workspaceId: input.workspaceId,
    provider: FEISHU_PROVIDER_ID,
    includeDisabled: true,
  });
  const evidenceSources: FeishuIntegrationEvidenceSource[] = sourceIntegrations.map((integration) => {
    const events = input.eventsByIntegrationId
      ? input.eventsByIntegrationId[integration.id] ?? []
      : listExternalIntegrationEventsSync({
          workspaceId: input.workspaceId,
          integrationId: integration.id,
          provider: FEISHU_PROVIDER_ID,
          limit: 100,
        });
    const outbox = input.outboxByIntegrationId
      ? input.outboxByIntegrationId[integration.id] ?? []
      : listExternalMessageOutboxSync({
          workspaceId: input.workspaceId,
          integrationId: integration.id,
          limit: 100,
        });
    const messageMappings = input.messageMappingsByIntegrationId
      ? input.messageMappingsByIntegrationId[integration.id] ?? []
      : listExternalMessageMappingsSync({
          workspaceId: input.workspaceId,
          integrationId: integration.id,
          limit: 100,
        });
    const channelBindings = input.channelBindingsByIntegrationId
      ? input.channelBindingsByIntegrationId[integration.id] ?? []
      : listExternalChannelBindingsSync({
          workspaceId: input.workspaceId,
          integrationId: integration.id,
        });
    const threadBindings = input.threadBindingsByIntegrationId
      ? input.threadBindingsByIntegrationId[integration.id] ?? []
      : listExternalThreadBindingsSync({
          workspaceId: input.workspaceId,
          integrationId: integration.id,
          provider: FEISHU_PROVIDER_ID,
          limit: 100,
        });
    const dataOperations = input.dataOperationsByIntegrationId
      ? input.dataOperationsByIntegrationId[integration.id] ?? []
      : listExternalDataOperationRunsSync({
          workspaceId: input.workspaceId,
          integrationId: integration.id,
          limit: 100,
        });
    return {
      workspaceId: input.workspaceId,
      integration,
      events,
      messageMappings,
      outbox,
      channelBindings,
      threadBindings,
      dataOperations,
    };
  });
  const freshEvidenceSources = evidenceSources.map((source) => filterFreshFeishuIntegrationEvidenceSource(source));
  const allEvidenceItems = freshEvidenceSources.map((source) => buildFeishuIntegrationEvidence(source));
  const evidenceItems = allEvidenceItems.filter((item) => !input.integrationId || item.id === input.integrationId);
  const workspaceEvidence = buildFeishuWorkspaceEvidenceSatisfaction(allEvidenceItems, freshEvidenceSources, {
    requiredNativeIntegrationId: input.integrationId,
  });
  const dofeAgentStrictSatisfied = isFeishuEvidenceReportStrictSatisfied({
    requiredEvidence,
    evidenceItems,
    workspaceEvidence,
    scopedIntegrationId: input.integrationId,
  });
  const expectedArtifactIdentityIntegrationIds = buildFeishuExpectedEvidenceArtifactIntegrationIds({
    requiredEvidence,
    scopedIntegrationId: input.integrationId,
    evidenceItems: allEvidenceItems,
    evidenceSources: freshEvidenceSources,
  });
  const expectedCallbackRouteProofs = buildFeishuExpectedEvidenceCallbackRouteProofs({
    workspaceId: input.workspaceId,
    requiredEvidence,
    scopedIntegrationId: input.integrationId,
    anchorIntegrationIds: expectedArtifactIdentityIntegrationIds,
  });
  const expectedBotAddedPayloadIdentityProofs = buildFeishuExpectedBotAddedPayloadIdentityProofs(
    sourceIntegrations,
    {
      integrationId: input.integrationId,
      integrationIds: expectedArtifactIdentityIntegrationIds,
    },
  );
  const expectedBotAddedPayloadChatReferences = buildFeishuExpectedBotAddedPayloadChatReferences({
    requiredEvidence,
    scopedIntegrationId: input.integrationId,
    evidenceSources: freshEvidenceSources,
    anchorIntegrationIds: expectedArtifactIdentityIntegrationIds,
  });
  const expectedTodo120NativeSecondAgentAppProofs = buildFeishuExpectedTodo120NativeSecondAgentAppProofs({
    requiredEvidence,
    scopedIntegrationId: input.integrationId,
    evidenceSources: freshEvidenceSources,
    anchorIntegrationIds: expectedArtifactIdentityIntegrationIds,
  });
  const openApiEvidence = requiredEvidence === "all" || input.openApiEvidencePath || input.openApiEvidence !== undefined
    ? verifyFeishuOpenApiSmokeEvidence({
      evidencePath: input.openApiEvidencePath,
      evidence: input.openApiEvidence,
      expectedCallbackRouteProofs,
      expectedIdentityProofs: expectedBotAddedPayloadIdentityProofs,
      expectedSecondAgentAppProofs: expectedTodo120NativeSecondAgentAppProofs,
      remediationContext: {
        workspaceId: input.workspaceId,
        integrationId: input.integrationId,
      },
    })
    : undefined;
  const rawBotAddedPayloadEvidence = requiredEvidence === "all" ||
    input.botAddedPayloadEvidencePath ||
    input.botAddedPayloadEvidence !== undefined
    ? verifyFeishuBotAddedPayloadEvidence({
      evidencePath: input.botAddedPayloadEvidencePath,
      evidence: input.botAddedPayloadEvidence,
      expectedIdentityProofs: expectedBotAddedPayloadIdentityProofs,
      expectedChatReferences: expectedBotAddedPayloadChatReferences,
      remediationContext: {
        workspaceId: input.workspaceId,
        integrationId: input.integrationId,
      },
    })
    : undefined;
  const artifactAnchorConsistency = reconcileFeishuArtifactAnchorConsistency({
    openApiEvidence,
    botAddedPayloadEvidence: rawBotAddedPayloadEvidence,
    remediationContext: {
      workspaceId: input.workspaceId,
      integrationId: input.integrationId,
    },
  });
  const finalOpenApiEvidence = artifactAnchorConsistency.openApiEvidence;
  const botAddedPayloadEvidence = artifactAnchorConsistency.botAddedPayloadEvidence;
  const localEvidenceFreshRows = sumFeishuEvidenceCounts(
    evidenceItems,
    (item) => item.localEvidenceFreshness.freshRows,
  );
  const localEvidenceStaleRows = sumFeishuEvidenceCounts(
    evidenceItems,
    (item) => item.localEvidenceFreshness.staleRows,
  );
  const workspaceLocalEvidenceFreshRows = sumFeishuEvidenceCounts(
    allEvidenceItems,
    (item) => item.localEvidenceFreshness.freshRows,
  );
  const workspaceLocalEvidenceStaleRows = sumFeishuEvidenceCounts(
    allEvidenceItems,
    (item) => item.localEvidenceFreshness.staleRows,
  );
  const reportIssues = buildFeishuEvidenceReportIssues({
    sourceIntegrationCount: sourceIntegrations.length,
    scopedIntegrationId: input.integrationId,
    evidenceItems,
  });
  const reportRemediationSteps = buildFeishuEvidenceReportRemediationSteps({
    workspaceId: input.workspaceId,
    integrationId: input.integrationId,
    issues: reportIssues,
  });

  return {
    workspaceId: input.workspaceId,
    ...(input.integrationId ? { integrationId: input.integrationId } : {}),
    requiredEvidence,
    integrationCount: evidenceItems.length,
    strictSatisfied: reportIssues.length === 0 &&
      dofeAgentStrictSatisfied &&
      (!finalOpenApiEvidence || finalOpenApiEvidence.valid) &&
      (!botAddedPayloadEvidence || botAddedPayloadEvidence.valid),
    issues: reportIssues,
    remediationSteps: reportRemediationSteps,
    ...(finalOpenApiEvidence ? { openApiEvidence: finalOpenApiEvidence } : {}),
    ...(botAddedPayloadEvidence ? { botAddedPayloadEvidence } : {}),
    summary: {
      botSatisfiedCount: evidenceItems.filter((item) => item.bot.satisfied).length,
      nativeExperienceSatisfiedCount: evidenceItems.filter((item) => item.nativeExperience.satisfied).length,
      guestPolicySatisfiedCount: evidenceItems.filter((item) => item.guestPolicy.satisfied).length,
      dataPlaneSatisfiedCount: evidenceItems.filter((item) => item.dataPlane.satisfied).length,
      workerSatisfiedCount: evidenceItems.filter((item) => item.worker.satisfied).length,
      failureVisibleCount: evidenceItems.filter((item) => item.failureVisibility.satisfied).length,
      workspaceBotSatisfied: workspaceEvidence.botSatisfied,
      workspaceNativeExperienceSatisfied: workspaceEvidence.nativeExperienceSatisfied,
      workspaceGuestPolicySatisfied: workspaceEvidence.guestPolicySatisfied,
      workspaceDataPlaneSatisfied: workspaceEvidence.dataPlaneSatisfied,
      workspaceWorkerSatisfied: workspaceEvidence.workerSatisfied,
      workspaceFailureVisible: workspaceEvidence.failureVisibilitySatisfied,
      workspaceAllSatisfied: workspaceEvidence.allSatisfied,
      scopedAllSatisfied: buildFeishuScopedAllEvidenceSatisfied({
        evidenceItems,
        workspaceEvidence,
        scopedIntegrationId: input.integrationId,
      }),
      localEvidenceFreshRows,
      localEvidenceStaleRows,
      workspaceLocalEvidenceFreshRows,
      workspaceLocalEvidenceStaleRows,
      localEvidenceMaxAgeHours: FEISHU_SMOKE_EVIDENCE_MAX_AGE_MS / (60 * 60 * 1000),
    },
    integrations: evidenceItems,
  };
}
export function filterFreshFeishuIntegrationEvidenceSource(
  source: FeishuIntegrationEvidenceSource,
): FeishuIntegrationEvidenceSource {
  const localEvidenceFreshness = buildFeishuLocalEvidenceFreshnessSummary(source);
  return {
    ...source,
    localEvidenceFreshness,
    events: source.events.filter(hasFreshFeishuIntegrationEventEvidence),
    messageMappings: source.messageMappings.filter((mapping) =>
      hasFreshFeishuEvidenceTimestamp(mapping.createdAt)
    ),
    outbox: source.outbox.filter((item) =>
      hasFreshFeishuEvidenceTimestamp(item.sentAt, item.updatedAt, item.createdAt)
    ),
    channelBindings: source.channelBindings.filter((binding) =>
      hasFreshFeishuEvidenceTimestamp(binding.updatedAt, binding.createdAt)
    ),
    threadBindings: source.threadBindings.filter((binding) =>
      hasFreshFeishuEvidenceTimestamp(binding.lastMessageAt, binding.updatedAt, binding.createdAt)
    ),
    dataOperations: source.dataOperations.filter((operation) =>
      hasFreshFeishuEvidenceTimestamp(
        operation.finishedAt,
        operation.updatedAt,
        operation.startedAt,
        operation.createdAt,
      )
    ),
  };
}
export function buildFeishuLocalEvidenceFreshnessSummary(
  source: FeishuIntegrationEvidenceSource,
): FeishuLocalEvidenceFreshnessSummary {
  const freshness = [
    ...source.events.map(hasFreshFeishuIntegrationEventEvidence),
    ...source.messageMappings.map((mapping) => hasFreshFeishuEvidenceTimestamp(mapping.createdAt)),
    ...source.outbox.map((item) => hasFreshFeishuEvidenceTimestamp(item.sentAt, item.updatedAt, item.createdAt)),
    ...source.channelBindings.map((binding) => hasFreshFeishuEvidenceTimestamp(binding.updatedAt, binding.createdAt)),
    ...source.threadBindings.map((binding) =>
      hasFreshFeishuEvidenceTimestamp(binding.lastMessageAt, binding.updatedAt, binding.createdAt)
    ),
    ...source.dataOperations.map((operation) =>
      hasFreshFeishuEvidenceTimestamp(
        operation.finishedAt,
        operation.updatedAt,
        operation.startedAt,
        operation.createdAt,
      )
    ),
  ];
  const freshRows = freshness.filter(Boolean).length;
  return {
    totalRows: freshness.length,
    freshRows,
    staleRows: freshness.length - freshRows,
    maxAgeHours: FEISHU_SMOKE_EVIDENCE_MAX_AGE_MS / (60 * 60 * 1000),
  };
}
export function formatFeishuEvidenceCommandText(report: FeishuEvidenceReport): string {
  const lines = [
    "DofeAgent Feishu evidence",
    `Workspace: ${report.workspaceId}`,
    ...(report.integrationId ? [`Selected integration: ${report.integrationId}`] : []),
    `Required evidence: ${report.requiredEvidence}`,
    `Strict evidence satisfied: ${report.strictSatisfied ? "yes" : "no"}`,
    `Integrations: ${report.integrationCount}`,
    "",
    "Workspace gates:",
    `- bot reply: ${formatFeishuCliYesNo(report.summary.workspaceBotSatisfied)} (${report.summary.botSatisfiedCount})`,
    `- native agent bot: ${formatFeishuCliYesNo(report.summary.workspaceNativeExperienceSatisfied)} (${report.summary.nativeExperienceSatisfiedCount})`,
    `- guest policy: ${formatFeishuCliYesNo(report.summary.workspaceGuestPolicySatisfied)} (${report.summary.guestPolicySatisfiedCount})`,
    `- data plane: ${formatFeishuCliYesNo(report.summary.workspaceDataPlaneSatisfied)} (${report.summary.dataPlaneSatisfiedCount})`,
    `- worker: ${formatFeishuCliYesNo(report.summary.workspaceWorkerSatisfied)} (${report.summary.workerSatisfiedCount})`,
    `- failure visibility: ${formatFeishuCliYesNo(report.summary.workspaceFailureVisible)} (${report.summary.failureVisibleCount})`,
    `- local evidence freshness: scoped fresh=${report.summary.localEvidenceFreshRows}, staleIgnored=${report.summary.localEvidenceStaleRows}; workspace fresh=${report.summary.workspaceLocalEvidenceFreshRows}, staleIgnored=${report.summary.workspaceLocalEvidenceStaleRows}; maxAgeHours=${report.summary.localEvidenceMaxAgeHours}`,
    `- scoped all: ${formatFeishuCliYesNo(report.summary.scopedAllSatisfied)}`,
    `- workspace all: ${formatFeishuCliYesNo(report.summary.workspaceAllSatisfied)}`,
    "",
    "Artifact evidence:",
    ...formatFeishuArtifactEvidenceLines("OpenAPI strict live", report.openApiEvidence),
    ...formatFeishuArtifactEvidenceLines("Bot-added payload", report.botAddedPayloadEvidence),
    "",
    "Report issues:",
  ];

  if (report.issues.length === 0) {
    lines.push("- none");
  } else {
    lines.push(`- ${report.issues.slice(0, 12).join(", ")}${report.issues.length > 12 ? ", ..." : ""}`);
  }

  lines.push(
    "",
    "Integration evidence:",
  );

  if (report.integrations.length === 0) {
    lines.push(formatFeishuEmptyIntegrationEvidenceLine(report));
  } else {
    for (const item of report.integrations.slice(0, 8)) {
      lines.push(
        `- ${item.displayName} (${item.id}, ${item.transportMode})`,
        `  status: ${item.status}`,
        `  gates: bot=${formatFeishuCliYesNo(item.bot.satisfied)}, native=${formatFeishuCliYesNo(item.nativeExperience.satisfied)}, guest=${formatFeishuCliYesNo(item.guestPolicy.satisfied)}, data=${formatFeishuCliYesNo(item.dataPlane.satisfied)}, worker=${formatFeishuCliYesNo(item.worker.satisfied)}, failure=${formatFeishuCliYesNo(item.failureVisibility.satisfied)}`,
        `  local evidence freshness: fresh=${item.localEvidenceFreshness.freshRows}, staleIgnored=${item.localEvidenceFreshness.staleRows}, maxAgeHours=${item.localEvidenceFreshness.maxAgeHours}`,
      );
      if (item.issues.length > 0) {
        lines.push(`  issues: ${item.issues.slice(0, 12).join(", ")}${item.issues.length > 12 ? ", ..." : ""}`);
      } else {
        lines.push("  issues: none");
      }
    }
    if (report.integrations.length > 8) {
      lines.push(`- ... ${report.integrations.length - 8} more integration evidence item(s); rerun with --json for all counters.`);
    }
  }

  const remediationSteps = collectFeishuEvidenceRemediationSteps(report);
  lines.push("", "Remediation:");
  if (remediationSteps.length === 0) {
    lines.push("- none");
  } else {
    for (const step of remediationSteps.slice(0, 8)) {
      lines.push(`- ${step.title} (${step.stepId})`);
      if (step.issues.length > 0) {
        lines.push(`  issues: ${step.issues.join(", ")}`);
      }
      if (step.command) {
        lines.push(`  command: ${step.command.replace(/\n/g, "\n  ")}`);
      }
    }
    if (remediationSteps.length > 8) {
      lines.push(`- ... ${remediationSteps.length - 8} more remediation step(s); rerun with --json for the full list.`);
    }
  }
  lines.push("", "Use --json for full counters, artifact summaries, and all remediation steps.");

  return lines.join("\n");
}
export function formatFeishuArtifactEvidenceLines(
  label: string,
  evidence: FeishuOpenApiSmokeEvidenceVerification | FeishuBotAddedPayloadEvidenceVerification | undefined,
): string[] {
  if (!evidence) {
    return [`- ${label}: not requested`];
  }
  const lines = [
    `- ${label}: present=${formatFeishuCliYesNo(evidence.present)}, valid=${formatFeishuCliYesNo(evidence.valid)}`,
  ];
  if (evidence.evidencePath) {
    lines.push(`  path: ${evidence.evidencePath}`);
  }
  if (evidence.summary) {
    lines.push(`  generatedAtFresh: ${formatFeishuCliYesNo(evidence.summary.generatedAtFresh)}`);
    const botAddedSummary = evidence.summary as { eventCreateTimeFresh?: unknown };
    if (typeof botAddedSummary.eventCreateTimeFresh === "boolean") {
      lines.push(`  eventCreateTimeFresh: ${formatFeishuCliYesNo(botAddedSummary.eventCreateTimeFresh)}`);
    }
  }
  if (evidence.issues.length > 0) {
    lines.push(`  issues: ${evidence.issues.slice(0, 12).join(", ")}${evidence.issues.length > 12 ? ", ..." : ""}`);
  } else {
    lines.push("  issues: none");
  }
  return lines;
}
export function collectFeishuEvidenceRemediationSteps(report: FeishuEvidenceReport): FeishuEvidenceRemediationStep[] {
  const steps = [
    ...report.remediationSteps,
    ...(report.openApiEvidence?.remediationSteps ?? []),
    ...(report.botAddedPayloadEvidence?.remediationSteps ?? []),
    ...report.integrations.flatMap((item) => item.remediationSteps),
  ];
  const seen = new Set<string>();
  const result: FeishuEvidenceRemediationStep[] = [];
  for (const step of steps) {
    const key = `${step.stepId}:${step.title}:${step.command ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(step);
  }
  return result;
}
export function formatFeishuCliYesNo(value: boolean): "yes" | "no" {
  return value ? "yes" : "no";
}
export function formatFeishuEmptyIntegrationEvidenceLine(report: FeishuEvidenceReport): string {
  if (report.issues.includes("selected_integration_missing") && report.integrationId) {
    return `- none matched --integration ${report.integrationId}; run smoke-plan without --integration to list active Feishu agent bot bindings, or bind a fresh agent-specific Feishu bot.`;
  }
  if (report.issues.includes("integration_missing")) {
    if (report.integrationId) {
      return `- no Feishu agent bot integrations found in this workspace; --integration ${report.integrationId} cannot be evaluated until an agent-specific Feishu bot is bound.`;
    }
    return "- no Feishu agent bot integrations found; run smoke-plan, then bind a Feishu custom app to a concrete DofeAgent agent.";
  }
  return "- none found; create or select an active Feishu agent bot integration before final evidence.";
}
export function buildFeishuEvidenceReportIssues(input: {
  sourceIntegrationCount: number;
  scopedIntegrationId?: string;
  evidenceItems: readonly FeishuIntegrationEvidence[];
}): string[] {
  if (input.sourceIntegrationCount === 0) {
    return ["integration_missing"];
  }
  if (input.scopedIntegrationId && input.evidenceItems.length === 0) {
    return ["selected_integration_missing"];
  }
  if (input.scopedIntegrationId && input.evidenceItems.some((item) => item.status !== "active")) {
    return ["selected_integration_not_active"];
  }
  if (input.scopedIntegrationId && input.evidenceItems.some((item) => !hasNonEmptyString(item.agentId))) {
    return ["selected_integration_not_agent_bot"];
  }
  if (!input.scopedIntegrationId && input.evidenceItems.length > 0 && input.evidenceItems.every((item) => item.status !== "active")) {
    return ["active_integration_missing"];
  }
  if (!input.scopedIntegrationId && input.evidenceItems.length > 0 && !input.evidenceItems.some((item) =>
    item.status === "active" && hasNonEmptyString(item.agentId)
  )) {
    return ["active_agent_bot_integration_missing"];
  }
  return [];
}
export function buildFeishuEvidenceReportRemediationSteps(input: {
  workspaceId: string;
  integrationId?: string;
  issues: readonly string[];
}): FeishuEvidenceRemediationStep[] {
  const steps: FeishuEvidenceRemediationStep[] = [];
  for (const issue of input.issues) {
    switch (issue) {
      case "integration_missing":
        steps.push({
          stepId: "bind_feishu_agent_bot",
          title: "Live smoke: create an active Feishu agent bot binding",
          detail: "Final evidence requires at least one active DofeAgent Feishu agent bot binding. Run smoke-plan for the ordered setup checklist, then bind a Feishu custom app to a concrete DofeAgent agent with App ID and App Secret.",
          issues: [issue],
          command: [
            `dofe-agent integrations feishu smoke-plan --workspace-id ${input.workspaceId}`,
            `dofe-agent integrations feishu bind-agent-bot --workspace-id ${input.workspaceId} --agent ${FEISHU_CLI_PLACEHOLDERS.agentName} --env-file scripts/feishu/.env --app-id-env FEISHU_APP_ID --app-secret-env FEISHU_APP_SECRET --json`,
          ].join("\n"),
        });
        break;
      case "selected_integration_missing":
        steps.push({
          stepId: "select_active_agent_bot_binding",
          title: "Live smoke: select an existing Feishu agent bot binding",
          detail: "The requested --integration id did not match any Feishu integration in this workspace. Rerun smoke-plan without --integration to find active bindings, or bind a fresh agent-specific Feishu bot before final evidence.",
          issues: [issue],
          command: `dofe-agent integrations feishu smoke-plan --workspace-id ${input.workspaceId}`,
        });
        break;
      case "selected_integration_not_active":
        steps.push({
          stepId: "select_active_agent_bot_binding",
          title: "Live smoke: select an active Feishu agent bot binding",
          detail: "The requested --integration id matched a disabled or archived Feishu binding. Final evidence only counts active agent bot bindings, so choose an active binding or bind a fresh agent-specific Feishu bot before rerunning smoke.",
          issues: [issue],
          command: [
            `dofe-agent integrations feishu smoke-plan --workspace-id ${input.workspaceId} --integration ${input.integrationId ?? FEISHU_CLI_PLACEHOLDERS.integrationId}`,
            `dofe-agent integrations feishu bind-agent-bot --workspace-id ${input.workspaceId} --agent ${FEISHU_CLI_PLACEHOLDERS.agentName} --env-file scripts/feishu/.env --app-id-env FEISHU_APP_ID --app-secret-env FEISHU_APP_SECRET --json`,
          ].join("\n"),
        });
        break;
      case "selected_integration_not_agent_bot":
        steps.push({
          stepId: "bind_feishu_agent_bot",
          title: "Live smoke: bind a Feishu bot to a concrete DofeAgent agent",
          detail: "The requested --integration id is a workspace-level Feishu integration, not an agent-scoped bot binding. TODO120 final evidence requires each Feishu bot identity to be bound to a concrete DofeAgent agent.",
          issues: [issue],
          command: [
            `dofe-agent integrations feishu smoke-plan --workspace-id ${input.workspaceId}`,
            `dofe-agent integrations feishu bind-agent-bot --workspace-id ${input.workspaceId} --agent ${FEISHU_CLI_PLACEHOLDERS.agentName} --env-file scripts/feishu/.env --app-id-env FEISHU_APP_ID --app-secret-env FEISHU_APP_SECRET --json`,
          ].join("\n"),
        });
        break;
      case "active_integration_missing":
        steps.push({
          stepId: "bind_feishu_agent_bot",
          title: "Live smoke: create or select an active Feishu agent bot binding",
          detail: "Feishu integration records exist, but none are active. Final evidence requires an active DofeAgent Feishu agent bot binding with fresh local smoke evidence.",
          issues: [issue],
          command: [
            `dofe-agent integrations feishu smoke-plan --workspace-id ${input.workspaceId}`,
            `dofe-agent integrations feishu bind-agent-bot --workspace-id ${input.workspaceId} --agent ${FEISHU_CLI_PLACEHOLDERS.agentName} --env-file scripts/feishu/.env --app-id-env FEISHU_APP_ID --app-secret-env FEISHU_APP_SECRET --json`,
          ].join("\n"),
        });
        break;
      case "active_agent_bot_integration_missing":
        steps.push({
          stepId: "bind_feishu_agent_bot",
          title: "Live smoke: create an active Feishu agent bot binding",
          detail: "Feishu integration records exist, but none are active agent-scoped bot bindings. Bind a Feishu custom app to a concrete DofeAgent agent before collecting TODO120 native smoke evidence.",
          issues: [issue],
          command: [
            `dofe-agent integrations feishu smoke-plan --workspace-id ${input.workspaceId}`,
            `dofe-agent integrations feishu bind-agent-bot --workspace-id ${input.workspaceId} --agent ${FEISHU_CLI_PLACEHOLDERS.agentName} --env-file scripts/feishu/.env --app-id-env FEISHU_APP_ID --app-secret-env FEISHU_APP_SECRET --json`,
          ].join("\n"),
        });
        break;
    }
  }
  return steps;
}
export function reconcileFeishuArtifactAnchorConsistency(input: {
  openApiEvidence?: FeishuOpenApiSmokeEvidenceVerification;
  botAddedPayloadEvidence?: FeishuBotAddedPayloadEvidenceVerification;
  remediationContext?: {
    workspaceId: string;
    integrationId?: string;
  };
}): {
  openApiEvidence?: FeishuOpenApiSmokeEvidenceVerification;
  botAddedPayloadEvidence?: FeishuBotAddedPayloadEvidenceVerification;
} {
  const openApiMatchedIntegrationId = input.openApiEvidence?.summary?.matchedIntegrationId;
  const botAddedMatchedIntegrationId = input.botAddedPayloadEvidence?.summary?.matchedIntegrationId;
  if (
    !input.openApiEvidence ||
    !input.botAddedPayloadEvidence ||
    !openApiMatchedIntegrationId ||
    !botAddedMatchedIntegrationId ||
    openApiMatchedIntegrationId === botAddedMatchedIntegrationId
  ) {
    return {
      openApiEvidence: input.openApiEvidence,
      botAddedPayloadEvidence: input.botAddedPayloadEvidence,
    };
  }

  const openApiIssues = uniqueStrings([
    ...input.openApiEvidence.issues,
    "openapi_bot_added_payload_anchor_mismatch",
  ]);
  const botAddedIssues = uniqueStrings([
    ...input.botAddedPayloadEvidence.issues,
    "bot_added_payload_openapi_anchor_mismatch",
  ]);
  return {
    openApiEvidence: {
      ...input.openApiEvidence,
      valid: false,
      issues: openApiIssues,
      remediationSteps: buildFeishuOpenApiEvidenceRemediationSteps({
        issues: openApiIssues,
        context: input.remediationContext,
      }),
    },
    botAddedPayloadEvidence: {
      ...input.botAddedPayloadEvidence,
      valid: false,
      issues: botAddedIssues,
      remediationSteps: buildFeishuBotAddedPayloadEvidenceRemediationSteps({
        issues: botAddedIssues,
        context: input.remediationContext,
      }),
    },
  };
}
export function buildFeishuIntegrationEvidence(input: {
  workspaceId: string;
  integration: ExternalIntegrationRecord;
  events: ExternalIntegrationEventRecord[];
  messageMappings: ExternalMessageMappingRecord[];
  outbox: ExternalMessageOutboxRecord[];
  channelBindings: ExternalChannelBindingRecord[];
  threadBindings: ExternalThreadBindingRecord[];
  dataOperations: ExternalDataOperationRunRecord[];
  localEvidenceFreshness?: FeishuLocalEvidenceFreshnessSummary;
}): FeishuIntegrationEvidence {
  const processedInboundEvents = countFeishuProcessedInboundMessageEvents(input.events);
  const processedApprovalCardActions = countFeishuProcessedApprovalCardActionEvents(input.events);
  const failedEvents = input.events.filter((event) => event.status === "failed").length;
  const inboundMessageMappings = input.messageMappings.filter((mapping) => mapping.direction === "inbound").length;
  const outboundMessageMappings = input.messageMappings.filter((mapping) => mapping.direction === "outbound").length;
  const correlatedReplyMappings = countCorrelatedFeishuReplyMappings(input.messageMappings);
  const nativeBotReplyEvidence = countFeishuNativeBotReplyEvidence(input.messageMappings);
  const agentBotRouteEvidence = countFeishuAgentBotRouteEvidence(input.messageMappings);
  const boundUserMentionEvidence = countFeishuNativeActorMentionEvidence(input.messageMappings, "user");
  const externalGuestMentionEvidence = countFeishuNativeActorMentionEvidence(input.messageMappings, "external_guest");
  const agentChannelPolicyDeniedEvidence = countFeishuAgentChannelPolicyDeniedEvidence(input.messageMappings);
  const botSenderLoopGuardEvidence = countFeishuBotSenderLoopGuardEvidence(input.messageMappings);
  const externalGuestAllowedEvidence = countFeishuExternalGuestPolicyEvidence(input.messageMappings, {
    decision: "allow",
    dispatchStatus: "sent",
    reasonCode: "feishu_external_guest_allowed",
    unboundUserMode: "reply_on_mention",
    expectedPermissionProfile: "channel_context_only",
    agentBotMentioned: true,
    requireDispatchEvidence: true,
  });
  const externalGuestReplyAllEvidence = countFeishuExternalGuestReplyAllEvidence(input.messageMappings);
  const externalGuestRequireIdentityEvidence = countFeishuExternalGuestPolicyEvidence(input.messageMappings, {
    decision: "require_identity",
    reasonCode: "feishu_external_guest_identity_required",
    dispatchStatus: "ignored",
    unboundUserMode: "require_identity",
    expectedPermissionProfile: "none",
    agentBotMentioned: true,
    requireNoDispatchEvidence: true,
  });
  const externalGuestIdentityBindingNoticeEvidence = countFeishuIdentityBindingNoticeEvidence(
    input.messageMappings,
    input.outbox,
  );
  const externalGuestIgnoreEvidence = countFeishuExternalGuestPolicyEvidence(input.messageMappings, {
    decision: "ignore",
    reasonCode: "feishu_external_guest_ignored",
    unboundUserMode: "ignore",
    dispatchStatus: "ignored",
    expectedPermissionProfile: "none",
    agentBotMentioned: true,
    requireNoDispatchEvidence: true,
    requireNoOutboundReply: true,
  });
  const externalGuestMentionRequiredEvidence = countFeishuExternalGuestPolicyEvidence(input.messageMappings, {
    decision: "ignore",
    reasonCode: "feishu_external_guest_bot_mention_required",
    unboundUserMode: "reply_on_mention",
    dispatchStatus: "ignored",
    expectedPermissionProfile: "channel_context_only",
    agentBotMentioned: false,
    requireNoDispatchEvidence: true,
    requireNoOutboundReply: true,
  });
  const autoProvisionedChannelBindings = countFeishuAutoProvisionedChannelBindings(input.channelBindings);
  const botAddedAutoProvisionedChannelBindings = countFeishuAutoProvisionedChannelBindings(
    input.channelBindings,
    "bot_added",
  );
  const firstMessageAutoProvisionedChannelBindings = countFeishuAutoProvisionedChannelBindings(
    input.channelBindings,
    "first_message",
  );
  const reusedProviderChannelBindings = countFeishuReusedProviderChannelBindings(input.channelBindings);
  const threadTaskBindings = countFeishuThreadTaskBindingEvidence(input.threadBindings);
  const threadContinuationEvidence = countFeishuThreadContinuationEvidence(input.messageMappings, input.threadBindings);
  const threadCollaborationEvidence = countFeishuThreadCollaborationEvidence(input.threadBindings);
  const threadCollaborationCardEvidence = countFeishuThreadCollaborationCardEvidence(
    input.outbox,
    input.threadBindings,
  );
  const sentOutboxItems = countFeishuSentAgentBotReplyOutboxEvidence(input.outbox);
  const failedOutboxItems = input.outbox.filter((item) =>
    item.status === "failed" || (item.status === "pending" && Boolean(item.lastError))
  ).length;
  const failedOutboxAgentBotEvidence = countFeishuFailedOutboxAgentBotEvidence(input.outbox);
  const healthStatus = input.integration.lastHealthStatus ?? "unknown";
  const healthFailureVisible = healthStatus === "degraded" || healthStatus === "error";
  const docReadSucceeded = countNonRuntimeFeishuDocReadOperations(input.dataOperations);
  const agentDocReadSucceeded = countAgentRuntimeFeishuDocReadOperations(input.dataOperations);
  const docWriteSucceeded = countSucceededFeishuOperations(input.dataOperations, [
    "docs.create_document",
    "docs.update_document",
  ]);
  const docApprovedWritesSucceeded = countApprovedSucceededFeishuOperations(input.dataOperations, [
    "docs.create_document",
    "docs.update_document",
  ]);
  const sheetReadSucceeded = countBoundGovernedFeishuReadOperations(input.dataOperations, ["sheets.read_range"]);
  const sheetWriteSucceeded = countSucceededFeishuOperations(input.dataOperations, ["sheets.update_range"]);
  const sheetApprovedWritesSucceeded = countApprovedSucceededFeishuOperations(input.dataOperations, [
    "sheets.update_range",
  ]);
  const sheetApprovedWriteSyncSucceeded = countApprovedSyncedFeishuDataTableWriteOperations(input.dataOperations, [
    "sheets.update_range",
  ]);
  const baseReadSucceeded = countBoundGovernedFeishuReadOperations(input.dataOperations, ["base.query_records"]);
  const baseMutateSucceeded = countSucceededFeishuOperations(input.dataOperations, ["base.mutate_records"]);
  const baseApprovedMutationsSucceeded = countApprovedSucceededFeishuOperations(input.dataOperations, [
    "base.mutate_records",
  ]);
  const baseApprovedMutationSyncSucceeded = countApprovedSyncedFeishuDataTableWriteOperations(input.dataOperations, [
    "base.mutate_records",
  ]);
  const userActorEvidence = countFeishuGovernanceActorEvidence(input.dataOperations, "user");
  const externalGuestActorEvidence = countFeishuGovernanceActorEvidence(input.dataOperations, "external_guest");
  const externalGuestReadSucceeded = countFeishuExternalGuestReadEvidence(input.dataOperations);
  const externalGuestWriteDeniedEvidence = countFeishuExternalGuestWriteDeniedEvidence(input.dataOperations);
  const failedDataOperations = input.dataOperations.filter((operation) => operation.status === "failed").length;
  const failedDataOperationAgentBotEvidence = countFeishuFailedDataOperationAgentBotEvidence(input.dataOperations);
  const agentBotFailureEvidence = failedOutboxAgentBotEvidence + failedDataOperationAgentBotEvidence;
  const integrationActive = input.integration.status === "active";
  const integrationAgentScoped = hasNonEmptyString(input.integration.agentId);
  const integrationReadyForAgentBotEvidence = integrationActive && integrationAgentScoped;
  const botSatisfied = integrationReadyForAgentBotEvidence &&
    processedInboundEvents > 0 &&
    sentOutboxItems > 0 &&
    inboundMessageMappings > 0 &&
    outboundMessageMappings > 0 &&
    correlatedReplyMappings > 0;
  const nativeExperienceSatisfied = integrationReadyForAgentBotEvidence &&
    agentBotRouteEvidence > 0 &&
    nativeBotReplyEvidence > 0 &&
    boundUserMentionEvidence > 0 &&
    externalGuestMentionEvidence > 0 &&
    agentChannelPolicyDeniedEvidence > 0 &&
    botSenderLoopGuardEvidence > 0 &&
    autoProvisionedChannelBindings > 0 &&
    botAddedAutoProvisionedChannelBindings > 0 &&
    firstMessageAutoProvisionedChannelBindings > 0 &&
    reusedProviderChannelBindings > 0 &&
    threadTaskBindings > 0 &&
    threadContinuationEvidence > 0 &&
    threadCollaborationEvidence > 0 &&
    threadCollaborationCardEvidence > 0;
  const guestPolicySatisfied = integrationReadyForAgentBotEvidence &&
    externalGuestAllowedEvidence > 0 &&
    externalGuestReplyAllEvidence > 0 &&
    externalGuestRequireIdentityEvidence > 0 &&
    externalGuestIdentityBindingNoticeEvidence > 0 &&
    externalGuestIgnoreEvidence > 0 &&
    externalGuestMentionRequiredEvidence > 0;
  const dataPlaneSatisfied = integrationReadyForAgentBotEvidence &&
    docReadSucceeded > 0 &&
    agentDocReadSucceeded > 0 &&
    docApprovedWritesSucceeded > 0 &&
    sheetReadSucceeded > 0 &&
    sheetApprovedWriteSyncSucceeded > 0 &&
    baseReadSucceeded > 0 &&
    baseApprovedMutationSyncSucceeded > 0 &&
    userActorEvidence > 0 &&
    externalGuestActorEvidence > 0 &&
    externalGuestReadSucceeded > 0 &&
    externalGuestWriteDeniedEvidence > 0;
  const requiredWorkerCorrelatedReplies = input.integration.transportMode === "websocket_worker" ? 2 : 0;
  const workerRestartRecoverySatisfied = correlatedReplyMappings >= requiredWorkerCorrelatedReplies;
  const workerApprovalCardActionSatisfied = input.integration.transportMode !== "websocket_worker" ||
    processedApprovalCardActions > 0;
  const workerSatisfied = integrationReadyForAgentBotEvidence &&
    input.integration.transportMode === "websocket_worker" &&
    botSatisfied &&
    workerRestartRecoverySatisfied &&
    workerApprovalCardActionSatisfied;
  const providerFailureVisible = failedOutboxItems > 0 || failedDataOperations > 0;
  const failureSatisfied = integrationReadyForAgentBotEvidence &&
    providerFailureVisible &&
    healthFailureVisible &&
    agentBotFailureEvidence > 0;
  const localEvidenceFreshness = input.localEvidenceFreshness ?? {
    totalRows: input.events.length +
      input.messageMappings.length +
      input.outbox.length +
      input.channelBindings.length +
      input.threadBindings.length +
      input.dataOperations.length,
    freshRows: input.events.length +
      input.messageMappings.length +
      input.outbox.length +
      input.channelBindings.length +
      input.threadBindings.length +
      input.dataOperations.length,
    staleRows: 0,
    maxAgeHours: FEISHU_SMOKE_EVIDENCE_MAX_AGE_MS / (60 * 60 * 1000),
  };
  const issues = buildFeishuEvidenceIssues({
    integration: input.integration,
    localEvidenceFreshness,
    botSatisfied,
    nativeExperienceSatisfied,
    guestPolicySatisfied,
    dataPlaneSatisfied,
    workerSatisfied,
    failureSatisfied,
    processedInboundEvents,
    inboundMessageMappings,
    sentOutboxItems,
    outboundMessageMappings,
    correlatedReplyMappings,
    agentBotRouteEvidence,
    nativeBotReplyEvidence,
    boundUserMentionEvidence,
    externalGuestMentionEvidence,
    agentChannelPolicyDeniedEvidence,
    botSenderLoopGuardEvidence,
    externalGuestAllowedEvidence,
    externalGuestReplyAllEvidence,
    externalGuestRequireIdentityEvidence,
    externalGuestIdentityBindingNoticeEvidence,
    externalGuestIgnoreEvidence,
    externalGuestMentionRequiredEvidence,
    autoProvisionedChannelBindings,
    botAddedAutoProvisionedChannelBindings,
    firstMessageAutoProvisionedChannelBindings,
    reusedProviderChannelBindings,
    threadTaskBindings,
    threadContinuationEvidence,
    threadCollaborationEvidence,
    threadCollaborationCardEvidence,
    docReadSucceeded,
    agentDocReadSucceeded,
    docWriteSucceeded,
    docApprovedWritesSucceeded,
    sheetReadSucceeded,
    sheetWriteSucceeded,
    sheetApprovedWritesSucceeded,
    sheetApprovedWriteSyncSucceeded,
    baseReadSucceeded,
    baseMutateSucceeded,
    baseApprovedMutationsSucceeded,
    baseApprovedMutationSyncSucceeded,
    userActorEvidence,
    externalGuestActorEvidence,
    externalGuestReadSucceeded,
    externalGuestWriteDeniedEvidence,
    workerRestartRecoverySatisfied,
    workerApprovalCardActionSatisfied,
    providerFailureVisible,
    healthFailureVisible,
    agentBotFailureEvidence,
  });
  const remediationSteps = buildFeishuIntegrationEvidenceRemediationSteps({
    workspaceId: input.workspaceId,
    integration: input.integration,
    issues,
  });

  return {
    id: input.integration.id,
    displayName: input.integration.displayName,
    ...(input.integration.agentId ? { agentId: input.integration.agentId } : {}),
    status: input.integration.status,
    transportMode: input.integration.transportMode,
    localEvidenceFreshness,
    bot: {
      processedInboundEvents,
      inboundMessageMappings,
      sentOutboxItems,
      outboundMessageMappings,
      correlatedReplyMappings,
      satisfied: botSatisfied,
    },
    nativeExperience: {
      agentBotRouteEvidence,
      nativeBotReplyEvidence,
      boundUserMentionEvidence,
      externalGuestMentionEvidence,
      agentChannelPolicyDeniedEvidence,
      botSenderLoopGuardEvidence,
      autoProvisionedChannelBindings,
      botAddedAutoProvisionedChannelBindings,
      firstMessageAutoProvisionedChannelBindings,
      reusedProviderChannelBindings,
      threadTaskBindings,
      threadContinuationEvidence,
      threadCollaborationEvidence,
      threadCollaborationCardEvidence,
      satisfied: nativeExperienceSatisfied,
    },
    guestPolicy: {
      externalGuestAllowedEvidence,
      externalGuestReplyAllEvidence,
      externalGuestRequireIdentityEvidence,
      externalGuestIdentityBindingNoticeEvidence,
      externalGuestIgnoreEvidence,
      externalGuestMentionRequiredEvidence,
      satisfied: guestPolicySatisfied,
    },
    dataPlane: {
      docReadSucceeded,
      agentDocReadSucceeded,
      docWriteSucceeded,
      docApprovedWritesSucceeded,
      sheetReadSucceeded,
      sheetWriteSucceeded,
      sheetApprovedWritesSucceeded,
      sheetApprovedWriteSyncSucceeded,
      baseReadSucceeded,
      baseMutateSucceeded,
      baseApprovedMutationsSucceeded,
      baseApprovedMutationSyncSucceeded,
      userActorEvidence,
      externalGuestActorEvidence,
      externalGuestReadSucceeded,
      externalGuestWriteDeniedEvidence,
      satisfied: dataPlaneSatisfied,
    },
    worker: {
      correlatedReplyMappings,
      requiredCorrelatedReplies: requiredWorkerCorrelatedReplies,
      restartRecoverySatisfied: workerRestartRecoverySatisfied,
      processedApprovalCardActions,
      approvalCardActionSatisfied: workerApprovalCardActionSatisfied,
      satisfied: workerSatisfied,
    },
    failureVisibility: {
      healthStatus,
      healthFailureVisible,
      providerFailureVisible,
      agentBotFailureEvidence,
      failedEvents,
      failedOutboxItems,
      failedDataOperations,
      satisfied: failureSatisfied,
    },
    issues,
    remediationSteps,
  };
}
export function countSucceededFeishuOperations(
  operations: readonly ExternalDataOperationRunRecord[],
  operationTypes: readonly string[],
): number {
  const allowed = new Set(operationTypes);
  return operations.filter((operation) =>
    operation.status === "succeeded" && allowed.has(operation.operationType)
  ).length;
}
export function countNonRuntimeFeishuDocReadOperations(
  operations: readonly ExternalDataOperationRunRecord[],
): number {
  return operations.filter((operation) =>
    operation.status === "succeeded" &&
    operation.operationType === "docs.read_document" &&
    hasBoundFeishuGovernedReadContext(operation) &&
    !hasFeishuAgentRuntimeDocReadEvidence(operation)
  ).length;
}
export function countBoundGovernedFeishuReadOperations(
  operations: readonly ExternalDataOperationRunRecord[],
  operationTypes: readonly string[],
): number {
  const allowed = new Set(operationTypes);
  return operations.filter((operation) =>
    operation.status === "succeeded" &&
    allowed.has(operation.operationType) &&
    hasBoundFeishuGovernedReadContext(operation)
  ).length;
}
export function countApprovedSucceededFeishuOperations(
  operations: readonly ExternalDataOperationRunRecord[],
  operationTypes: readonly string[],
): number {
  const allowed = new Set(operationTypes);
  return operations.filter((operation) =>
    operation.status === "succeeded" &&
    allowed.has(operation.operationType) &&
    hasFeishuApprovedWriteEvidence(operation)
  ).length;
}
export function countApprovedSyncedFeishuDataTableWriteOperations(
  operations: readonly ExternalDataOperationRunRecord[],
  operationTypes: readonly string[],
): number {
  const allowed = new Set(operationTypes);
  return operations.filter((operation) =>
    operation.status === "succeeded" &&
    allowed.has(operation.operationType) &&
    hasFeishuApprovedWriteEvidence(operation) &&
    hasFeishuApprovedDataTableWriteSyncEvidence(operation)
  ).length;
}
export function countAgentRuntimeFeishuDocReadOperations(
  operations: readonly ExternalDataOperationRunRecord[],
): number {
  return operations.filter((operation) =>
    operation.status === "succeeded" &&
    operation.operationType === "docs.read_document" &&
    operation.actorType === "agent" &&
    hasBoundFeishuGovernedReadContext(operation) &&
    hasFeishuAgentRuntimeDocReadEvidence(operation)
  ).length;
}
export function hasFeishuAgentRuntimeDocReadEvidence(operation: ExternalDataOperationRunRecord): boolean {
  const request = readJsonRecord(operation.requestJson);
  const result = readJsonRecord(operation.resultJson);
  const runtimeResultManifest = isRecord(result?.runtimeResultManifest)
    ? result.runtimeResultManifest
    : undefined;
  return request?.source === "lark-cli-result-manifest" &&
    request.resultManifestPath === FEISHU_LARK_CLI_RESULT_MANIFEST_RELATIVE_PATH &&
    runtimeResultManifest?.path === FEISHU_LARK_CLI_RESULT_MANIFEST_RELATIVE_PATH;
}
export function hasFeishuApprovedWriteEvidence(operation: ExternalDataOperationRunRecord): boolean {
  const result = readJsonRecord(operation.resultJson);
  return result?.policyDecision === "approved" &&
    typeof result.approvalId === "string" &&
    result.approvalId.trim().length > 0 &&
    hasFeishuPayloadHashEvidence(result.payloadHash) &&
    hasNonEmptyString(operation.resourceBindingId) &&
    hasFeishuSafeDataOperationResultSummary(operation) &&
    hasFeishuAgentBotGovernedWriteContext(operation);
}
export function hasFeishuPayloadHashEvidence(value: unknown): boolean {
  if (!hasNonEmptyString(value)) {
    return false;
  }
  const normalized = value.trim();
  return /^[a-f0-9]{64}$/i.test(normalized) ||
    /^sha256:[a-f0-9]{64}$/i.test(normalized);
}
export function hasFeishuSha256HashEvidence(value: unknown): value is string {
  return hasNonEmptyString(value) && /^[a-f0-9]{64}$/i.test(value.trim());
}
export function matchFeishuExpectedIdentityProof(
  proofs: readonly FeishuExpectedBotAddedPayloadIdentityProof[],
  evidence: Record<string, unknown>,
): {
  appMatchedProof?: FeishuExpectedBotAddedPayloadIdentityProof;
  fullMatchedProof?: FeishuExpectedBotAddedPayloadIdentityProof;
  tenantIssue?: "tenant_key_hash_missing" | "tenant_key_mismatch" | "tenant_key_unexpected";
} {
  if (!hasFeishuSha256HashEvidence(evidence.appIdHash)) {
    return {};
  }
  const appMatchedProofs = proofs.filter((proof) => proof.appIdHash === evidence.appIdHash);
  if (appMatchedProofs.length === 0) {
    return {};
  }
  const fullMatchedProof = appMatchedProofs.find((proof) =>
    readFeishuMatchedIdentityIntegrationId(proof, evidence) === proof.integrationId
  );
  if (fullMatchedProof) {
    return {
      appMatchedProof: fullMatchedProof,
      fullMatchedProof,
    };
  }

  const evidenceTenantPresent = evidence.tenantKeyPresent === true ||
    hasFeishuSha256HashEvidence(evidence.tenantKeyHash);
  if (!evidenceTenantPresent && appMatchedProofs.some((proof) => proof.tenantKeyHash)) {
    return {
      appMatchedProof: appMatchedProofs[0],
      tenantIssue: "tenant_key_hash_missing",
    };
  }
  if (evidenceTenantPresent && appMatchedProofs.every((proof) => !proof.tenantKeyHash)) {
    return {
      appMatchedProof: appMatchedProofs[0],
      tenantIssue: "tenant_key_unexpected",
    };
  }
  return {
    appMatchedProof: appMatchedProofs[0],
    tenantIssue: "tenant_key_mismatch",
  };
}
export function readFeishuMatchedIdentityIntegrationId(
  proof: FeishuExpectedBotAddedPayloadIdentityProof | undefined,
  evidence: unknown,
): string | undefined {
  if (!proof || !isRecord(evidence)) {
    return undefined;
  }
  if (proof.tenantKeyHash) {
    return evidence.tenantKeyHash === proof.tenantKeyHash ? proof.integrationId : undefined;
  }
  return evidence.tenantKeyPresent !== true && !hasFeishuSha256HashEvidence(evidence.tenantKeyHash)
    ? proof.integrationId
    : undefined;
}
export function hasFeishuApprovedDataTableWriteSyncEvidence(operation: ExternalDataOperationRunRecord): boolean {
  const result = readJsonRecord(operation.resultJson);
  const dofeAgentSync = isRecord(result?.dofeAgentSync) ? result.dofeAgentSync : undefined;
  return dofeAgentSync?.dataTableLastApprovedWriteSynced === true;
}
export function hasFeishuAgentBotGovernedWriteContext(operation: ExternalDataOperationRunRecord): boolean {
  const governanceContext = readFeishuGovernanceContext(operation);
  if (!hasFeishuAgentBotDataOperationContext(operation, governanceContext)) {
    return false;
  }
  const actorType = readFeishuGovernanceActorType(operation);
  if (actorType === "agent") {
    return true;
  }
  if (actorType === "user") {
    return hasNonEmptyString(governanceContext.actorUserId);
  }
  return false;
}
export function hasBoundFeishuGovernedReadContext(operation: ExternalDataOperationRunRecord): boolean {
  const governanceContext = readFeishuGovernanceContext(operation);
  if (!hasNonEmptyString(operation.resourceBindingId)) {
    return false;
  }
  if (!hasFeishuAgentBotDataOperationContext(operation, governanceContext)) {
    return false;
  }
  if (!hasFeishuSafeDataOperationResultSummary(operation)) {
    return false;
  }
  const actorType = readFeishuGovernanceActorType(operation);
  if (actorType === "agent") {
    return true;
  }
  if (actorType === "user") {
    return hasNonEmptyString(governanceContext.actorUserId);
  }
  if (actorType === "external_guest") {
    return countFeishuGovernanceActorEvidence([operation], "external_guest") === 1 &&
      governanceContext.externalGuestPermissionProfile === "channel_context_only" &&
      governanceContext.externalGuestResourceAccess === "guest_readable_current_channel" &&
      hasNonEmptyString(governanceContext.channelName);
  }
  return false;
}
export function countFeishuGovernanceActorEvidence(
  operations: readonly ExternalDataOperationRunRecord[],
  actorType: "user" | "external_guest",
): number {
  return operations.filter((operation) => {
    const governanceContext = readFeishuGovernanceContext(operation);
    if (governanceContext?.actorType !== actorType) {
      return false;
    }
    if (!hasFeishuAgentBotDataOperationContext(operation, governanceContext)) {
      return false;
    }
    if (actorType === "user") {
      return hasNonEmptyString(governanceContext.actorUserId);
    }
    return hasNonEmptyString(governanceContext.externalActorReference) &&
      isFeishuAcceptedExternalGuestDataPlanePermissionProfile(governanceContext.externalGuestPermissionProfile) &&
      hasFeishuExternalGuestNoWorkspaceMemberEvidence(governanceContext);
  }).length;
}
export function isFeishuAcceptedExternalGuestDataPlanePermissionProfile(value: unknown): boolean {
  return value === "channel_context_only" || value === "none";
}
export function countFeishuExternalGuestWriteDeniedEvidence(
  operations: readonly ExternalDataOperationRunRecord[],
): number {
  const writeOperations = new Set([
    "docs.create_document",
    "docs.update_document",
    "sheets.update_range",
    "base.mutate_records",
  ]);
  return operations.filter((operation) =>
    readFeishuGovernanceActorType(operation) === "external_guest" &&
    countFeishuGovernanceActorEvidence([operation], "external_guest") === 1 &&
    operation.status === "failed" &&
    operation.errorCode === "feishu.data_operation_external_guest_requires_identity" &&
    writeOperations.has(operation.operationType) &&
    hasNonEmptyString(operation.resourceBindingId) &&
    hasFeishuSafeDataOperationResultSummary(operation)
  ).length;
}
export function countFeishuExternalGuestReadEvidence(
  operations: readonly ExternalDataOperationRunRecord[],
): number {
  const readOperations = new Set(["docs.read_document", "sheets.read_range", "base.query_records"]);
  return operations.filter((operation) => {
    const governanceContext = readFeishuGovernanceContext(operation);
    return operation.status === "succeeded" &&
      readOperations.has(operation.operationType) &&
      hasBoundFeishuGovernedReadContext(operation) &&
      countFeishuGovernanceActorEvidence([operation], "external_guest") === 1 &&
      governanceContext?.externalGuestPermissionProfile === "channel_context_only" &&
      governanceContext?.externalGuestResourceAccess === "guest_readable_current_channel" &&
      hasNonEmptyString(governanceContext.channelName);
  }).length;
}
export function readFeishuGovernanceActorType(
  operation: ExternalDataOperationRunRecord,
): "user" | "external_guest" | "agent" | "system" | undefined {
  const governanceContext = readFeishuGovernanceContext(operation);
  const actorType = typeof governanceContext?.actorType === "string"
    ? governanceContext.actorType
    : undefined;
  return actorType === "user" ||
    actorType === "external_guest" ||
    actorType === "agent" ||
    actorType === "system"
    ? actorType
    : undefined;
}
export function readFeishuGovernanceContext(operation: ExternalDataOperationRunRecord): Record<string, unknown> | undefined {
  const request = readJsonRecord(operation.requestJson);
  return isRecord(request?.governanceContext)
    ? request.governanceContext
    : isRecord(request?.feishuGovernance)
      ? request.feishuGovernance
      : undefined;
}
export function hasFeishuSafeDataOperationResultSummary(operation: ExternalDataOperationRunRecord): boolean {
  const result = readJsonRecord(operation.resultJson);
  if (!result) {
    return false;
  }
  const serialized = JSON.stringify(result);
  return hasNoFeishuRawDataOperationResourceContext(result) &&
    !containsFeishuSecretLikeEvidence(serialized) &&
    !containsRawFeishuOpenApiEvidenceIdentifier(serialized);
}
export function hasNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
export function hasNoFeishuUserIdentity(metadata: Record<string, unknown>): boolean {
  const rawIdentityFields = [
    "userId",
    "actorUserId",
    "externalUserId",
    "externalOpenId",
    "externalUnionId",
    "feishuOpenId",
    "feishuUnionId",
    "openId",
    "unionId",
    "providerUserId",
    "providerOpenId",
    "providerUnionId",
    "senderOpenId",
    "senderUnionId",
    "user_id",
    "open_id",
    "union_id",
    "external_user_id",
    "external_open_id",
    "external_union_id",
    "provider_user_id",
    "provider_open_id",
    "provider_union_id",
  ];
  return rawIdentityFields.every((field) => !hasNonEmptyString(metadata[field]));
}
export function hasFeishuExternalGuestNoWorkspaceMemberEvidence(metadata: Record<string, unknown>): boolean {
  return metadata.workspaceMemberCreated === false && hasNoFeishuUserIdentity(metadata);
}
export function hasFeishuSafeInboundMessageContext(metadata: Record<string, unknown> | undefined): metadata is Record<string, unknown> {
  return metadata !== undefined &&
    hasNonEmptyString(metadata.externalChatReference) &&
    hasNonEmptyString(metadata.externalThreadReference) &&
    hasNoFeishuRawExternalLocationContext(metadata) &&
    hasNoFeishuRawProviderIdentityContext(metadata) &&
    hasNoFeishuUnsafeSerializedEvidenceContext(metadata);
}
export function hasFeishuMessageMappingAgentBotContext(
  mapping: ExternalMessageMappingRecord,
  metadata: Record<string, unknown> | undefined,
): metadata is Record<string, unknown> {
  return hasNonEmptyString(metadata?.agentId) &&
    readStringMetadata(metadata?.botBindingId) === mapping.integrationId;
}
export function countFeishuSentAgentBotReplyOutboxEvidence(outbox: readonly ExternalMessageOutboxRecord[]): number {
  return outbox.filter((item) => {
    if (item.status !== "sent" || !hasNonEmptyString(item.sentAt)) {
      return false;
    }
    if (
      !hasNonEmptyString(item.channelBindingId) ||
      !hasNonEmptyString(item.dofeAgentMessageId) ||
      !hasNonEmptyString(item.targetExternalThreadId)
    ) {
      return false;
    }
    const metadata = readJsonRecord(item.metadataJson);
    if (metadata?.provider !== FEISHU_PROVIDER_ID || metadata.outboxSource !== "agent_reply") {
      return false;
    }
    if (
      !hasNonEmptyString(metadata.agentId) ||
      !hasNonEmptyString(metadata.botBindingId) ||
      metadata.botBindingId.trim() !== item.integrationId ||
      !hasFeishuSafeBotReplyMetadataContext(metadata)
    ) {
      return false;
    }
    return true;
  }).length;
}
export function countFeishuProcessedInboundMessageEvents(events: ExternalIntegrationEventRecord[]): number {
  return events.filter((event) => {
    if (event.eventType !== "im.message.receive_v1" || event.status !== "processed") {
      return false;
    }
    const payload = readJsonRecord(event.payloadJson);
    if (
      payload?.provider !== FEISHU_PROVIDER_ID ||
      payload.rawPayloadStored !== false ||
      !hasNonEmptyString(payload.payloadHash) ||
      !hasNonEmptyString(payload.externalEventReference) ||
      payload.externalEventIdRedacted !== true ||
      !hasNoFeishuUnsafeSerializedEvidenceContext(payload)
    ) {
      return false;
    }
    const message = isRecord(payload.message) ? payload.message : undefined;
    const sender = isRecord(payload.sender) ? payload.sender : undefined;
    return hasNonEmptyString(message?.messageReference) &&
      message?.messageIdRedacted === true &&
      !hasNonEmptyString(message?.messageId) &&
      !hasNonEmptyString(message?.message_id) &&
      hasNonEmptyString(message?.chatReference) &&
      message?.chatIdRedacted === true &&
      !hasNonEmptyString(message?.chatId) &&
      !hasNonEmptyString(message?.chat_id) &&
      hasNonEmptyString(message?.threadReference) &&
      message?.threadIdRedacted === true &&
      !hasNonEmptyString(message?.threadId) &&
      !hasNonEmptyString(message?.thread_id) &&
      hasNonEmptyString(sender?.openIdReference) &&
      sender?.openIdRedacted === true &&
      !hasNonEmptyString(sender?.openId) &&
      !hasNonEmptyString(sender?.open_id) &&
      !hasNonEmptyString(sender?.unionId) &&
      !hasNonEmptyString(sender?.union_id) &&
      !hasNonEmptyString(sender?.userId) &&
      !hasNonEmptyString(sender?.user_id);
  }).length;
}
export function isFeishuApprovalCardActionEventType(eventType: string): boolean {
  const normalized = eventType.trim().toLowerCase();
  return normalized === "card.action.trigger" ||
    normalized === "im.message.message_card.action_v1" ||
    normalized === "message_card.action";
}
export function countFeishuProcessedApprovalCardActionEvents(events: ExternalIntegrationEventRecord[]): number {
  return events.filter((event) => {
    if (!isFeishuApprovalCardActionEventType(event.eventType) || event.status !== "processed") {
      return false;
    }
    const payload = readJsonRecord(event.payloadJson);
    if (
      !payload ||
      readStringMetadata(payload.provider) !== FEISHU_PROVIDER_ID ||
      payload.rawPayloadStored !== false ||
      !hasNoFeishuUnsafeSerializedEvidenceContext(payload)
    ) {
      return false;
    }
    const approvalCardAction = isRecord(payload.approvalCardAction) ? payload.approvalCardAction : undefined;
    const decision = readStringMetadata(approvalCardAction?.decision)?.toLowerCase();
    return readStringMetadata(approvalCardAction?.provider) === FEISHU_PROVIDER_ID &&
      readStringMetadata(approvalCardAction?.kind) === "data_operation_approval" &&
      hasNonEmptyString(approvalCardAction?.approvalId) &&
      hasFeishuPayloadHashEvidence(approvalCardAction?.payloadHash) &&
      (decision === "approved" || decision === "rejected") &&
      approvalCardAction?.tokenStored === false &&
      approvalCardAction?.rawActionPayloadStored === false &&
      hasFeishuSafeApprovalCardActionContext(approvalCardAction) &&
      hasNoFeishuUserIdentity(approvalCardAction);
  }).length;
}
export function hasFeishuSafeApprovalCardActionContext(action: Record<string, unknown>): boolean {
  const serialized = JSON.stringify(action);
  return hasNoFeishuRawApprovalCardActionData(action) &&
    hasNoFeishuRawDataOperationResourceContext(action) &&
    !containsFeishuSecretLikeEvidence(serialized) &&
    !containsRawFeishuOpenApiEvidenceIdentifier(serialized);
}
export function hasNoFeishuRawApprovalCardActionData(action: Record<string, unknown>): boolean {
  const rawActionFields = [
    "token",
    "actionToken",
    "action_token",
    "tenantAccessToken",
    "tenant_access_token",
    "rawActionPayload",
    "raw_action_payload",
    "actionPayload",
    "action_payload",
    "rawPayload",
    "raw_payload",
  ];
  return rawActionFields.every((field) => action[field] === undefined || action[field] === null);
}
export function readJsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
export function readStringMetadata(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
export function readStringArrayMetadata(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return uniqueStrings(value.filter(hasNonEmptyString).map((item) => item.trim()));
}
export function buildFeishuCliExternalReference(kind: string, value: string): string {
  return `${kind}:${createHash("sha256").update(`${kind}:${value}`, "utf8").digest("hex").slice(0, 16)}`;
}
export function buildFeishuShortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
export function buildFeishuEvidenceIssues(input: {
  integration: ExternalIntegrationRecord;
  localEvidenceFreshness: FeishuLocalEvidenceFreshnessSummary;
  botSatisfied: boolean;
  nativeExperienceSatisfied: boolean;
  guestPolicySatisfied: boolean;
  dataPlaneSatisfied: boolean;
  workerSatisfied: boolean;
  failureSatisfied: boolean;
  processedInboundEvents: number;
  inboundMessageMappings: number;
  sentOutboxItems: number;
  outboundMessageMappings: number;
  correlatedReplyMappings: number;
  agentBotRouteEvidence: number;
  nativeBotReplyEvidence: number;
  boundUserMentionEvidence: number;
  externalGuestMentionEvidence: number;
  agentChannelPolicyDeniedEvidence: number;
  botSenderLoopGuardEvidence: number;
  externalGuestAllowedEvidence: number;
  externalGuestReplyAllEvidence: number;
  externalGuestRequireIdentityEvidence: number;
  externalGuestIdentityBindingNoticeEvidence: number;
  externalGuestIgnoreEvidence: number;
  externalGuestMentionRequiredEvidence: number;
  autoProvisionedChannelBindings: number;
  botAddedAutoProvisionedChannelBindings: number;
  firstMessageAutoProvisionedChannelBindings: number;
  reusedProviderChannelBindings: number;
  threadTaskBindings: number;
  threadContinuationEvidence: number;
  threadCollaborationEvidence: number;
  threadCollaborationCardEvidence: number;
  docReadSucceeded: number;
  agentDocReadSucceeded: number;
  docWriteSucceeded: number;
  docApprovedWritesSucceeded: number;
  sheetReadSucceeded: number;
  sheetWriteSucceeded: number;
  sheetApprovedWritesSucceeded: number;
  sheetApprovedWriteSyncSucceeded: number;
  baseReadSucceeded: number;
  baseMutateSucceeded: number;
  baseApprovedMutationsSucceeded: number;
  baseApprovedMutationSyncSucceeded: number;
  userActorEvidence: number;
  externalGuestActorEvidence: number;
  externalGuestReadSucceeded: number;
  externalGuestWriteDeniedEvidence: number;
  workerRestartRecoverySatisfied: boolean;
  workerApprovalCardActionSatisfied: boolean;
  providerFailureVisible: boolean;
  healthFailureVisible: boolean;
  agentBotFailureEvidence: number;
}): string[] {
  const issues: string[] = [];
  if (input.integration.status !== "active") {
    issues.push("integration_not_active");
  }
  if (!hasNonEmptyString(input.integration.agentId)) {
    issues.push("integration_not_agent_bot");
  }
  if (input.localEvidenceFreshness.totalRows > 0 && input.localEvidenceFreshness.freshRows === 0) {
    issues.push("stale_local_evidence_rows_ignored");
  }
  if (!input.botSatisfied) {
    if (input.processedInboundEvents === 0) {
      issues.push("processed_inbound_event_missing");
    }
    if (input.inboundMessageMappings === 0) {
      issues.push("inbound_message_mapping_missing");
    }
    if (input.sentOutboxItems === 0) {
      issues.push("sent_outbox_missing");
    }
    if (input.outboundMessageMappings === 0) {
      issues.push("outbound_message_mapping_missing");
    }
    if (input.correlatedReplyMappings === 0) {
      issues.push("correlated_reply_mapping_missing");
    }
  }
  if (!input.nativeExperienceSatisfied) {
    if (input.agentBotRouteEvidence === 0) {
      issues.push("agent_bot_route_evidence_missing");
    }
    if (input.nativeBotReplyEvidence === 0) {
      issues.push("native_agent_bot_reply_evidence_missing");
    }
    if (input.boundUserMentionEvidence === 0) {
      issues.push("bound_user_bot_mention_evidence_missing");
    }
    if (input.externalGuestMentionEvidence === 0) {
      issues.push("external_guest_bot_mention_evidence_missing");
    }
    if (input.agentChannelPolicyDeniedEvidence === 0) {
      issues.push("agent_channel_policy_disabled_evidence_missing");
    }
    if (input.botSenderLoopGuardEvidence === 0) {
      issues.push("bot_sender_loop_guard_evidence_missing");
    }
    if (input.autoProvisionedChannelBindings === 0) {
      issues.push("channel_auto_provision_evidence_missing");
    }
    if (input.botAddedAutoProvisionedChannelBindings === 0) {
      issues.push("bot_added_auto_provision_evidence_missing");
    }
    if (input.firstMessageAutoProvisionedChannelBindings === 0) {
      issues.push("first_message_auto_provision_evidence_missing");
    }
    if (input.reusedProviderChannelBindings === 0) {
      issues.push("multi_agent_channel_reuse_evidence_missing");
    }
    if (input.threadTaskBindings === 0) {
      issues.push("thread_task_binding_evidence_missing");
    }
    if (input.threadContinuationEvidence === 0) {
      issues.push("thread_continuation_evidence_missing");
    }
    if (input.threadCollaborationEvidence === 0) {
      issues.push("thread_collaboration_evidence_missing");
    } else if (input.threadCollaborationCardEvidence === 0) {
      issues.push("thread_collaboration_card_evidence_missing");
    }
  }
  if (!input.guestPolicySatisfied) {
    if (input.externalGuestAllowedEvidence === 0) {
      issues.push("external_guest_policy_allow_evidence_missing");
    }
    if (input.externalGuestReplyAllEvidence === 0) {
      issues.push("external_guest_policy_reply_all_evidence_missing");
    }
    if (input.externalGuestRequireIdentityEvidence === 0) {
      issues.push("external_guest_policy_require_identity_evidence_missing");
    }
    if (input.externalGuestIdentityBindingNoticeEvidence === 0) {
      issues.push("external_guest_identity_binding_notice_evidence_missing");
    }
    if (input.externalGuestIgnoreEvidence === 0) {
      issues.push("external_guest_policy_ignore_evidence_missing");
    }
    if (input.externalGuestMentionRequiredEvidence === 0) {
      issues.push("external_guest_policy_mention_required_evidence_missing");
    }
  }
  if (!input.dataPlaneSatisfied) {
    if (input.docReadSucceeded === 0) {
      issues.push("doc_read_evidence_missing");
    } else if (input.agentDocReadSucceeded === 0) {
      issues.push("agent_doc_read_evidence_missing");
    }
    if (input.docWriteSucceeded === 0) {
      issues.push("doc_write_evidence_missing");
    } else if (input.docApprovedWritesSucceeded === 0) {
      issues.push("doc_write_approval_evidence_missing");
    }
    if (input.sheetReadSucceeded === 0) {
      issues.push("sheet_read_evidence_missing");
    }
    if (input.sheetWriteSucceeded === 0) {
      issues.push("sheet_write_evidence_missing");
    } else if (input.sheetApprovedWritesSucceeded === 0) {
      issues.push("sheet_write_approval_evidence_missing");
    } else if (input.sheetApprovedWriteSyncSucceeded === 0) {
      issues.push("sheet_write_dofe-agent_sync_evidence_missing");
    }
    if (input.baseReadSucceeded === 0) {
      issues.push("base_read_evidence_missing");
    }
    if (input.baseMutateSucceeded === 0) {
      issues.push("base_mutate_evidence_missing");
    } else if (input.baseApprovedMutationsSucceeded === 0) {
      issues.push("base_mutate_approval_evidence_missing");
    } else if (input.baseApprovedMutationSyncSucceeded === 0) {
      issues.push("base_mutate_dofe-agent_sync_evidence_missing");
    }
    if (input.userActorEvidence === 0) {
      issues.push("user_actor_data_operation_evidence_missing");
    }
    if (input.externalGuestActorEvidence === 0) {
      issues.push("external_guest_actor_data_operation_evidence_missing");
    } else if (input.externalGuestReadSucceeded === 0) {
      issues.push("external_guest_read_evidence_missing");
    } else if (input.externalGuestWriteDeniedEvidence === 0) {
      issues.push("external_guest_write_deny_evidence_missing");
    }
  }
  if (input.integration.transportMode === "websocket_worker") {
    if (!input.botSatisfied) {
      issues.push("websocket_worker_receive_evidence_missing");
    } else if (!input.workerRestartRecoverySatisfied) {
      issues.push("websocket_worker_restart_evidence_missing");
    }
    if (!input.workerApprovalCardActionSatisfied) {
      issues.push("websocket_worker_card_action_evidence_missing");
    }
  }
  if (!input.failureSatisfied) {
    if (!input.providerFailureVisible) {
      issues.push("provider_failure_evidence_missing");
    }
    if (!input.healthFailureVisible) {
      issues.push("health_failure_evidence_missing");
    }
    if (input.providerFailureVisible && input.agentBotFailureEvidence === 0) {
      issues.push("agent_bot_failure_evidence_missing");
    }
    issues.push("failure_visibility_evidence_missing");
  }
  return issues;
}
export interface FeishuEvidenceRemediationSpec {
  stepId: string;
  title: string;
  detail: string;
  command?: string;
}
export function buildFeishuIntegrationEvidenceRemediationSteps(input: {
  workspaceId: string;
  integration: ExternalIntegrationRecord;
  issues: readonly string[];
}): FeishuEvidenceRemediationStep[] {
  const grouped = new Map<string, FeishuEvidenceRemediationStep>();
  for (const issue of input.issues) {
    const spec = mapFeishuEvidenceIssueToRemediationSpec({
      issue,
      workspaceId: input.workspaceId,
      integration: input.integration,
    });
    if (!spec) {
      continue;
    }
    const current = grouped.get(spec.stepId);
    if (current) {
      current.issues = uniqueStrings([...current.issues, issue]);
      continue;
    }
    grouped.set(spec.stepId, {
      stepId: spec.stepId,
      title: spec.title,
      detail: spec.detail,
      issues: [issue],
      ...(spec.command ? { command: spec.command } : {}),
    });
  }
  return [...grouped.values()];
}
export function mapFeishuEvidenceIssueToRemediationSpec(input: {
  issue: string;
  workspaceId: string;
  integration: ExternalIntegrationRecord;
}): FeishuEvidenceRemediationSpec | undefined {
  const dataPlaneCommands = buildFeishuDataPlaneSmokeCommands({
    workspaceId: input.workspaceId,
    integrationId: input.integration.id,
  });
  const workerHarness = buildFeishuWorkerHarnessSummary({
    workspaceId: input.workspaceId,
    integrationId: input.integration.id,
  });
  const externalGuestPolicyCommands = buildFeishuExternalGuestPolicySmokeCommands({
    workspaceId: input.workspaceId,
    integrationId: input.integration.id,
    agentId: input.integration.agentId,
  });
  const agentChannelAccessCommands = buildFeishuAgentChannelAccessSmokeCommands({
    workspaceId: input.workspaceId,
    integrationId: input.integration.id,
    agentId: input.integration.agentId ?? FEISHU_CLI_PLACEHOLDERS.agentName,
  });

  switch (input.issue) {
    case "integration_not_active":
      return {
        stepId: "enable_agent_bot_binding",
        title: "Live smoke: use an active Feishu agent bot binding",
        detail: "Final evidence must be captured through an active DofeAgent Feishu agent bot binding. Re-enable the intended binding or create a fresh active agent bot binding before rerunning smoke-plan, live smoke, and the final evidence gate.",
      };
    case "integration_not_agent_bot":
      return {
        stepId: "bind_feishu_agent_bot",
        title: "Live smoke: bind Feishu to a concrete DofeAgent agent",
        detail: "Final evidence cannot use a workspace-level Feishu integration as the bot identity. Bind a Feishu custom app to the concrete DofeAgent agent that users will mention in Feishu.",
        command: `dofe-agent integrations feishu bind-agent-bot --workspace-id ${input.workspaceId} --agent ${input.integration.agentId ?? FEISHU_CLI_PLACEHOLDERS.agentName} --env-file scripts/feishu/.env --app-id-env FEISHU_APP_ID --app-secret-env FEISHU_APP_SECRET --json`,
      };
    case "stale_local_evidence_rows_ignored":
      return {
        stepId: "rerun_fresh_dofe-agent_live_smoke",
        title: "Live smoke: rerun stale DofeAgent evidence steps",
        detail: "The final evidence gate only counts local DofeAgent DB evidence rows from the last 24 hours. Rerun the native bot, guest-policy, data-plane, worker when using websocket_worker, and failure smoke steps, then rerun the final evidence gate.",
        command: `dofe-agent integrations feishu smoke-plan --workspace-id ${input.workspaceId} --integration ${input.integration.id}`,
      };
    case "processed_inbound_event_missing":
    case "inbound_message_mapping_missing":
    case "sent_outbox_missing":
    case "outbound_message_mapping_missing":
    case "correlated_reply_mapping_missing":
      return {
        stepId: "live_bot_message_reply",
        title: "Live smoke: @Agent in Feishu and verify reply",
        detail: "Send a message in the bound Feishu group mentioning the concrete agent bot, then verify the final evidence sees a processed safe inbound summary, a sent Feishu agent_reply outbox with agentId, botBindingId, DofeAgent message/channel binding, safe chat/thread references, and a same-bot correlated reply mapping in the same Feishu thread.",
      };
    case "agent_bot_route_evidence_missing":
    case "bound_user_bot_mention_evidence_missing":
      return {
        stepId: "live_agent_bot_direct_mention",
        title: "Live smoke: @agent bot routes to its DofeAgent agent",
        detail: "From a bound Feishu user, mention the agent-specific Feishu bot in a group and verify DofeAgent records actorType=user, actorUserId, safe audit references, and a sent inbound mapping with agentId, botBindingId, task, and message evidence.",
      };
    case "external_guest_bot_mention_evidence_missing":
      return {
        stepId: "live_external_guest_agent_bot_mention",
        title: "Live smoke: unbound Feishu user routes as external guest",
        detail: "From an unbound Feishu user, mention the agent-specific bot and verify DofeAgent records actorType=external_guest, permissionProfile=channel_context_only, no userId/actorUserId, task/message dispatch, safe audit references, and no raw Feishu user ids.",
        command: externalGuestPolicyCommands.replyOnMentionCommand,
      };
    case "external_guest_policy_allow_evidence_missing":
      return {
        stepId: "live_external_guest_agent_bot_mention",
        title: "Live smoke: unbound Feishu user routes as external guest",
        detail: "From an unbound Feishu user, mention the agent-specific bot and verify DofeAgent records external_guest policy allow metadata plus low-permission task/message dispatch with permissionProfile=channel_context_only and no userId/actorUserId.",
        command: externalGuestPolicyCommands.replyOnMentionCommand,
      };
    case "external_guest_policy_reply_all_evidence_missing":
      return {
        stepId: "live_external_guest_reply_all",
        title: "Live smoke: external guest reply_all dispatches without mention",
        detail: `Set the agent bot external guest policy to reply_all, send an unbound Feishu message without mentioning the bot, and verify DofeAgent records the reply_all allow decision plus the low-permission task dispatch. Restore after this smoke step with: ${externalGuestPolicyCommands.restoreDefaultCommand}`,
        command: externalGuestPolicyCommands.replyAllCommand,
      };
    case "external_guest_policy_require_identity_evidence_missing":
      return {
        stepId: "live_external_guest_identity_required",
        title: "Live smoke: external guest is asked to bind identity",
        detail: `Set the agent bot external guest policy to require_identity, mention the bot from an unbound Feishu user, and verify DofeAgent records the require_identity decision and sends the binding notice with externalGuestReference, permissionProfile=none, and no raw Feishu open_id/union_id. Restore after this smoke step with: ${externalGuestPolicyCommands.restoreDefaultCommand}`,
        command: externalGuestPolicyCommands.requireIdentityCommand,
      };
    case "external_guest_identity_binding_notice_evidence_missing":
      return {
        stepId: "live_external_guest_identity_required",
        title: "Live smoke: external guest identity notice is sent",
        detail: `Set the agent bot external guest policy to require_identity, mention the bot from an unbound Feishu user, drain the Feishu outbox, and verify DofeAgent records a sent identity-binding notice correlated to that ignored inbound message with externalGuestReference, permissionProfile=none, and no raw Feishu open_id/union_id. Restore after this smoke step with: ${externalGuestPolicyCommands.restoreDefaultCommand}`,
        command: externalGuestPolicyCommands.requireIdentityCommand,
      };
    case "external_guest_policy_ignore_evidence_missing":
      return {
        stepId: "live_external_guest_reply_disabled",
        title: "Live smoke: external guest replies can be disabled",
        detail: `Set the agent bot external guest policy to ignore with permissionProfile=none, mention the bot from an unbound Feishu user, and verify DofeAgent records the ignore decision without dispatching a task or reply. Restore after this smoke step with: ${externalGuestPolicyCommands.restoreDefaultCommand}`,
        command: externalGuestPolicyCommands.ignoreCommand,
      };
    case "external_guest_policy_mention_required_evidence_missing":
      return {
        stepId: "live_unmentioned_guest_message_ignored",
        title: "Live smoke: unmentioned guest message is ignored",
        detail: "With reply_on_mention enabled, send an unbound Feishu message that does not mention the agent bot and verify DofeAgent records the bot-mention-required decision without dispatching.",
        command: externalGuestPolicyCommands.replyOnMentionCommand,
      };
    case "agent_channel_policy_disabled_evidence_missing":
      return {
        stepId: "live_agent_channel_policy_disabled",
        title: "Live smoke: disabled agent/channel policy blocks replies",
        detail: `Disable the agent's channel-member access, mention the Feishu agent bot, and verify DofeAgent records the policy denial without writing a channel message, queueing a task, or sending a bot reply. Restore after this smoke step with: ${agentChannelAccessCommands.restoreCommand}`,
        command: agentChannelAccessCommands.disableCommand,
      };
    case "channel_auto_provision_evidence_missing":
      return {
        stepId: "live_agent_bot_channel_auto_provision",
        title: "Live smoke: agent bot auto-provisions channel",
        detail: "Add the agent bot to a new Feishu group or send a first mentioned message in an unbound group, then verify the channel binding records an DofeAgent channel name, review status, and safe chat reference with bot_added or first_message auto-provisioning.",
      };
    case "bot_added_auto_provision_evidence_missing":
      return {
        stepId: "live_agent_bot_channel_auto_provision",
        title: "Live smoke: agent bot auto-provisions channel",
        detail: "Add the agent bot to a new Feishu group and verify the channel binding records provisionSource=bot_added with DofeAgent channel identity, review status, and safe chat reference metadata.",
      };
    case "first_message_auto_provision_evidence_missing":
      return {
        stepId: "live_agent_bot_first_message_auto_provision",
        title: "Live smoke: first mentioned message provisions channel",
        detail: "Send the first mentioned message from an unbound Feishu group and verify DofeAgent records provisionSource=first_message with DofeAgent channel identity, review status, and safe chat reference metadata.",
      };
    case "multi_agent_channel_reuse_evidence_missing":
      return {
        stepId: "live_multi_agent_bot_channel_reuse",
        title: "Live smoke: second agent bot reuses channel",
        detail: "Add a second agent bot to the same Feishu group and verify DofeAgent adds that agent to the existing channel with a distinct linkedFromBindingId plus different linkedFromAgentId/linkedFromBotBindingId metadata instead of creating a duplicate channel.",
      };
    case "thread_task_binding_evidence_missing":
      return {
        stepId: "live_feishu_thread_task_binding",
        title: "Live smoke: Feishu thread binds to DofeAgent task",
        detail: "Mention the agent bot in a Feishu thread and verify DofeAgent records the thread binding with taskQueueId, dofeAgentMessageId, agentId, and botBindingId.",
      };
    case "thread_continuation_evidence_missing":
      return {
        stepId: "live_feishu_thread_continuation",
        title: "Live smoke: Feishu thread follow-up continues without re-mention",
        detail: "After a mentioned agent bot message creates a Feishu thread binding, send a follow-up in the same Feishu thread without mentioning the bot and verify DofeAgent records threadContinuation=true with taskQueueId, dofeAgentMessageId, agentId, botBindingId, and the same active thread binding reference.",
      };
    case "thread_collaboration_evidence_missing":
    case "thread_collaboration_card_evidence_missing":
      return {
        stepId: "live_multi_agent_thread_collaboration",
        title: "Live smoke: second agent bot joins an active thread",
        detail: "Mention one agent bot in a Feishu thread, then mention a second agent bot in that same thread and verify DofeAgent keeps separate thread bindings, records threadCollaboration=true with collaborator agent ids and bot binding ids, and sends a collaboration card that matches the active thread binding without raw Feishu ids.",
      };
    case "bot_sender_loop_guard_evidence_missing":
      return {
        stepId: "live_multi_agent_thread_collaboration",
        title: "Live smoke: second agent bot joins an active thread",
        detail: "Mention one agent bot in a Feishu thread, then have another registered agent bot reply or mention it in the same group; verify DofeAgent records feishu_bot_sender_ignored without dispatching a task or leaking raw Feishu ids.",
      };
    case "doc_read_evidence_missing":
      return {
        stepId: "live_doc_read",
        title: "Live smoke: read bound Feishu Doc",
        detail: "Run the DofeAgent data-operation Doc read smoke so a succeeded, non-runtime Doc read operation is recorded with active resource binding, Feishu governance context, agentId, botBindingId, actor provenance, safe resource references, and no raw resource tokens.",
        command: dataPlaneCommands.liveDocReadCommand,
      };
    case "agent_doc_read_evidence_missing":
      return {
        stepId: "live_agent_bound_doc_summary",
        title: "Live smoke: @Agent summarizes a bound Feishu Doc",
        detail: "Ask an Agent from the bound Feishu group to summarize the already-bound Doc so DofeAgent records the lark-cli result-manifest Doc read evidence.",
      };
    case "doc_write_evidence_missing":
    case "doc_write_approval_evidence_missing":
      return {
        stepId: "live_doc_write_with_approval",
        title: "Live smoke: approve a small Doc write",
        detail: "Create and approve the governed Doc append operation so the operation run carries approvalId, SHA-256 payloadHash, approved policy metadata, active resource binding, and a safe Feishu write result.",
        command: dataPlaneCommands.liveDocWriteCommand,
      };
    case "sheet_read_evidence_missing":
      return {
        stepId: "live_sheet_read",
        title: "Live smoke: read bound Feishu Sheet",
        detail: "Run the DofeAgent data-operation Sheet read smoke so a succeeded safe range preview is recorded with active resource binding, Feishu governance context, agentId, botBindingId, actor provenance, safe resource references, and no raw resource tokens.",
        command: dataPlaneCommands.liveSheetReadCommand,
      };
    case "sheet_write_evidence_missing":
    case "sheet_write_approval_evidence_missing":
    case "sheet_write_dofe-agent_sync_evidence_missing":
      return {
        stepId: "live_sheet_write_with_approval",
        title: "Live smoke: approve a small Sheet write",
        detail: "Create and approve the governed Sheet write smoke so the operation run carries approvalId, SHA-256 payloadHash, approved policy metadata, active resource binding, and DofeAgent syncs the bound data table preview from the approved write result.",
        command: dataPlaneCommands.liveSheetWriteCommand,
      };
    case "base_read_evidence_missing":
    case "base_mutate_evidence_missing":
    case "base_mutate_approval_evidence_missing":
    case "base_mutate_dofe-agent_sync_evidence_missing":
      return {
        stepId: "live_base_preview_and_update",
        title: "Live smoke: preview and update one Base record",
        detail: "Run the Base preview plus approved Base update smoke so DofeAgent records safe read evidence with active resource binding, Feishu governance context, agentId, botBindingId, actor provenance, safe resource references, and no raw resource tokens, plus approvalId, SHA-256 payloadHash, Feishu Base write evidence, and approved data-table sync evidence.",
        command: dataPlaneCommands.liveBaseCommand,
      };
    case "user_actor_data_operation_evidence_missing":
      return {
        stepId: "live_bound_user_data_operation",
        title: "Live smoke: bound Feishu user data operation",
        detail: "Bind one Feishu user to an DofeAgent user, then ask that user to trigger a governed Doc/Sheet/Base operation so the run records governanceContext.actorType=user.",
        command: dataPlaneCommands.liveDocReadCommand,
      };
    case "external_guest_actor_data_operation_evidence_missing":
    case "external_guest_read_evidence_missing":
      return {
        stepId: "live_external_guest_read_guest_readable",
        title: "Live smoke: external guest reads guest-readable resource",
        detail: "From an unbound Feishu user, ask an agent bot to read a guest-readable resource bound to the current channel and verify DofeAgent records permissionProfile=channel_context_only plus externalGuestResourceAccess=guest_readable_current_channel.",
        command: [
          externalGuestPolicyCommands.replyOnMentionCommand,
          dataPlaneCommands.liveDocReadCommand,
        ].join("\n"),
      };
    case "external_guest_write_deny_evidence_missing":
      return {
        stepId: "live_external_guest_write_denied",
        title: "Live smoke: external guest write is denied",
        detail: `From an unbound Feishu user, ask an agent bot to write a bound Sheet/Base resource and verify DofeAgent records external_guest governance with permissionProfile=none or permissionProfile=channel_context_only on the bound write operation plus the identity-required denial. Restore after this smoke step with: ${externalGuestPolicyCommands.restoreDefaultCommand}`,
        command: [
          externalGuestPolicyCommands.requireIdentityCommand,
          dataPlaneCommands.liveSheetWriteCommand,
        ].join("\n"),
      };
    case "websocket_worker_receive_evidence_missing":
      return {
        stepId: "live_websocket_receive_message",
        title: "Live smoke: receive Feishu message through WebSocket worker",
        detail: "Start the self-hosted WebSocket worker, send a bound Feishu message, and verify the DofeAgent task/reply path runs without the HTTP callback route.",
        command: workerHarness.startCommand,
      };
    case "websocket_worker_restart_evidence_missing":
      return {
        stepId: "live_websocket_worker_restart",
        title: "Live smoke: restart WebSocket worker and verify recovery",
        detail: "Restart the WebSocket worker and send another bound Feishu message so the final evidence gate sees two correlated WebSocket replies.",
        command: workerHarness.systemdRestartCommand,
      };
    case "websocket_worker_card_action_evidence_missing":
      return {
        stepId: "live_websocket_receive_message",
        title: "Live smoke: receive Feishu message through WebSocket worker",
        detail: "Trigger one approval card action through the self-hosted worker so DofeAgent proves card-button governance without a public callback URL.",
        command: workerHarness.startCommand,
      };
    case "provider_failure_evidence_missing":
    case "health_failure_evidence_missing":
    case "agent_bot_failure_evidence_missing":
    case "failure_visibility_evidence_missing":
      return {
        stepId: "live_failure_visibility",
        title: "Live smoke: verify visible provider failure",
        detail: "Temporarily use a wrong agent bot secret, revoke a required scope, or force a failed agent-bot outbox/data operation, then refresh Feishu health until degraded/error status and a provider failure row with agentId, botBindingId, and safe chat/resource context are both visible.",
        command: `dofe-agent integrations feishu health-check --workspace-id ${input.workspaceId} --integration ${input.integration.id} --json`,
      };
    default:
      return undefined;
  }
}
export function countCorrelatedFeishuReplyMappings(
  mappings: readonly ExternalMessageMappingRecord[],
): number {
  const inboundMappings = mappings.filter((mapping) => mapping.direction === "inbound");
  return mappings.filter((mapping) => {
    if (mapping.direction !== "outbound" || !mapping.externalThreadId) {
      return false;
    }
    const inbound = inboundMappings.find((candidate) =>
      candidate.externalMessageId === mapping.externalThreadId ||
      candidate.externalThreadId === mapping.externalThreadId
    );
    return Boolean(inbound && hasMatchingFeishuBotReplyMetadata(inbound, mapping));
  }).length;
}
export function countFeishuNativeBotReplyEvidence(
  mappings: readonly ExternalMessageMappingRecord[],
): number {
  const inboundMappings = mappings.filter((mapping) => mapping.direction === "inbound");
  return mappings.filter((mapping) => {
    if (mapping.direction !== "outbound" || !mapping.externalThreadId) {
      return false;
    }
    const inbound = inboundMappings.find((candidate) =>
      candidate.externalMessageId === mapping.externalThreadId ||
      candidate.externalThreadId === mapping.externalThreadId
    );
    if (
      !inbound ||
      (inbound.channelBindingId && mapping.channelBindingId && inbound.channelBindingId !== mapping.channelBindingId)
    ) {
      return false;
    }
    if (!hasMatchingFeishuBotReplyMetadata(inbound, mapping)) {
      return false;
    }
    const outboundMetadata = readJsonRecord(mapping.metadataJson);
    if (!outboundMetadata) {
      return false;
    }
    const policyInput = isRecord(outboundMetadata.agentActionPolicyInput)
      ? outboundMetadata.agentActionPolicyInput
      : undefined;
    const action = isRecord(policyInput?.action) ? policyInput.action : undefined;
    return hasFeishuSafeBotReplyActionContext(action) &&
      hasNoFeishuRawExternalLocationContext(outboundMetadata) &&
      hasNoFeishuRawProviderIdentityContext(outboundMetadata);
  }).length;
}
export function hasFeishuSafeBotReplyActionContext(action: Record<string, unknown> | undefined): boolean {
  if (!action) {
    return false;
  }
  const serialized = JSON.stringify(action);
  return hasNonEmptyString(action.resourceReference) &&
    action.resourceIdRedacted === true &&
    !hasNonEmptyString(action.resourceId) &&
    hasNoFeishuRawDataOperationResourceContext(action) &&
    !containsFeishuSecretLikeEvidence(serialized) &&
    !containsRawFeishuOpenApiEvidenceIdentifier(serialized);
}
export function hasMatchingFeishuBotReplyMetadata(
  inbound: ExternalMessageMappingRecord,
  outbound: ExternalMessageMappingRecord,
): boolean {
  if (outbound.direction !== "outbound" || !outbound.externalThreadId) {
    return false;
  }
  if (inbound.direction !== "inbound") {
    return false;
  }
  if (
    inbound.externalMessageId !== outbound.externalThreadId &&
    inbound.externalThreadId !== outbound.externalThreadId
  ) {
    return false;
  }
  if (inbound.channelBindingId && outbound.channelBindingId && inbound.channelBindingId !== outbound.channelBindingId) {
    return false;
  }
  const inboundMetadata = readJsonRecord(inbound.metadataJson);
  const outboundMetadata = readJsonRecord(outbound.metadataJson);
  return inboundMetadata?.provider === FEISHU_PROVIDER_ID &&
    outboundMetadata?.provider === FEISHU_PROVIDER_ID &&
    hasFeishuMessageMappingAgentBotContext(inbound, inboundMetadata) &&
    hasFeishuMessageMappingAgentBotContext(outbound, outboundMetadata) &&
    hasFeishuSafeBotReplyMappingContext(inboundMetadata) &&
    outboundMetadata.agentId === inboundMetadata.agentId &&
    outboundMetadata.botBindingId === inboundMetadata.botBindingId &&
    hasFeishuSafeBotReplyMappingContext(outboundMetadata);
}
export function hasFeishuSafeBotReplyMappingContext(
  metadata: Record<string, unknown> | undefined,
): metadata is Record<string, unknown> {
  return hasFeishuSafeBotReplyMetadataContext(metadata);
}
export function hasFeishuSafeBotReplyMetadataContext(
  metadata: Record<string, unknown> | undefined,
): metadata is Record<string, unknown> {
  if (!hasFeishuSafeInboundMessageContext(metadata)) {
    return false;
  }
  const serialized = JSON.stringify(metadata);
  return hasNoFeishuRawDataOperationResourceContext(metadata) &&
    !containsFeishuSecretLikeEvidence(serialized) &&
    !containsRawFeishuOpenApiEvidenceIdentifier(serialized);
}
export function hasNoFeishuUnsafeSerializedEvidenceContext(metadata: Record<string, unknown>): boolean {
  const serialized = JSON.stringify(metadata);
  return hasNoFeishuRawDataOperationResourceContext(metadata) &&
    !containsFeishuSecretLikeEvidence(serialized) &&
    !containsRawFeishuOpenApiEvidenceIdentifier(serialized);
}
export function countFeishuAgentBotRouteEvidence(
  mappings: readonly ExternalMessageMappingRecord[],
): number {
  return mappings.filter((mapping) => {
    if (mapping.direction !== "inbound" || !mapping.taskQueueId || !mapping.dofeAgentMessageId) {
      return false;
    }
    const metadata = readJsonRecord(mapping.metadataJson);
    return metadata?.provider === FEISHU_PROVIDER_ID &&
      metadata.dispatchStatus === "sent" &&
      hasFeishuSafeInboundMessageContext(metadata) &&
      hasNoFeishuDofeAgentCommandRoute(metadata) &&
      metadata.agentBotMentioned === true &&
      hasFeishuMessageMappingAgentBotContext(mapping, metadata);
  }).length;
}
export function countFeishuNativeActorMentionEvidence(
  mappings: readonly ExternalMessageMappingRecord[],
  actorType: "user" | "external_guest",
): number {
  return mappings.filter((mapping) => {
    if (mapping.direction !== "inbound" || !mapping.taskQueueId || !mapping.dofeAgentMessageId) {
      return false;
    }
    const metadata = readJsonRecord(mapping.metadataJson);
    if (
      metadata?.provider !== FEISHU_PROVIDER_ID ||
      metadata.dispatchStatus !== "sent" ||
      !hasFeishuSafeInboundMessageContext(metadata) ||
      !hasNoFeishuDofeAgentCommandRoute(metadata) ||
      metadata.agentBotMentioned !== true ||
      metadata.actorType !== actorType ||
      !hasFeishuMessageMappingAgentBotContext(mapping, metadata)
    ) {
      return false;
    }
    if (actorType === "external_guest") {
      return typeof metadata.externalGuestReference === "string" &&
        metadata.externalGuestReference.trim().length > 0 &&
        metadata.externalGuestPermissionProfile === "channel_context_only" &&
        hasFeishuExternalGuestNoWorkspaceMemberEvidence(metadata);
    }
    return typeof metadata.actorUserId === "string" &&
      metadata.actorUserId.trim().length > 0 &&
      hasNoFeishuRawProviderIdentityContext(metadata);
  }).length;
}
export function countFeishuAgentChannelPolicyDeniedEvidence(
  mappings: readonly ExternalMessageMappingRecord[],
): number {
  const policyDenialReasonCodes = new Set([
    "feishu_agent_not_enabled_in_channel",
    "feishu_agent_channel_member_access_disabled",
    "feishu_agent_unavailable_to_actor",
    "feishu_agent_runtime_unavailable",
    "feishu_agent_runtime_unavailable_to_actor",
  ]);
  return mappings.filter((mapping) => {
    if (mapping.direction !== "inbound" || mapping.taskQueueId || mapping.dofeAgentMessageId) {
      return false;
    }
    const metadata = readJsonRecord(mapping.metadataJson);
    const reasonCode = typeof metadata?.reasonCode === "string" ? metadata.reasonCode : undefined;
    return metadata?.provider === FEISHU_PROVIDER_ID &&
      metadata.dispatchStatus === "ignored" &&
      hasFeishuMessageMappingAgentBotContext(mapping, metadata) &&
      hasFeishuSafeInboundMessageContext(metadata) &&
      hasNoFeishuDofeAgentCommandRoute(metadata) &&
      hasNoFeishuRawExternalLocationContext(metadata) &&
      hasNoFeishuRawProviderIdentityContext(metadata) &&
      metadata.agentBotMentioned === true &&
      Boolean(reasonCode && policyDenialReasonCodes.has(reasonCode)) &&
      !hasFeishuCorrelatedOutboundReply(mappings, mapping);
  }).length;
}
export function hasFeishuCorrelatedOutboundReply(
  mappings: readonly ExternalMessageMappingRecord[],
  inbound: ExternalMessageMappingRecord,
): boolean {
  return mappings.some((mapping) => {
    if (mapping.direction !== "outbound" || !mapping.externalThreadId) {
      return false;
    }
    const matchesInboundMessage = mapping.externalThreadId === inbound.externalMessageId;
    const matchesInboundThread = Boolean(inbound.externalThreadId) &&
      mapping.externalThreadId === inbound.externalThreadId;
    if (!matchesInboundMessage && !matchesInboundThread) {
      return false;
    }
    return !inbound.channelBindingId ||
      !mapping.channelBindingId ||
      inbound.channelBindingId === mapping.channelBindingId;
  });
}
export function hasNoFeishuDofeAgentCommandRoute(metadata: Record<string, unknown>): boolean {
  if (
    metadata.dofeAgentCommandUsed === true ||
    metadata.routeCommandUsed === true ||
    metadata.slashCommandUsed === true ||
    metadata.agentCommandUsed === true
  ) {
    return false;
  }
  return !containsFeishuDofeAgentCommandSummary(metadata);
}
export function containsFeishuDofeAgentCommandSummary(metadata: Record<string, unknown>): boolean {
  const textFields = [
    "text",
    "messageText",
    "messageSummary",
    "textSummary",
    "textPreview",
    "contentPreview",
    "safeText",
    "safeTextPreview",
    "normalizedText",
  ];
  return textFields.some((field) => {
    const value = metadata[field];
    return typeof value === "string" && /(^|\s)\/agent(?:\s|$)/i.test(value.trim());
  });
}
export function countFeishuBotSenderLoopGuardEvidence(
  mappings: readonly ExternalMessageMappingRecord[],
): number {
  return mappings.filter((mapping) => {
    if (mapping.direction !== "inbound" || mapping.taskQueueId || mapping.dofeAgentMessageId) {
      return false;
    }
    const metadata = readJsonRecord(mapping.metadataJson);
    return metadata?.provider === FEISHU_PROVIDER_ID &&
      metadata.dispatchStatus === "ignored" &&
      metadata.reasonCode === "feishu_bot_sender_ignored" &&
      metadata.agentBotMentioned === false &&
      hasFeishuMessageMappingAgentBotContext(mapping, metadata) &&
      hasFeishuSafeInboundMessageContext(metadata) &&
      hasNoFeishuRawExternalLocationContext(metadata) &&
      hasNoFeishuRawProviderIdentityContext(metadata) &&
      !hasFeishuCorrelatedOutboundReply(mappings, mapping);
  }).length;
}
export function countFeishuExternalGuestPolicyEvidence(
  mappings: readonly ExternalMessageMappingRecord[],
  input: {
    decision: "allow" | "ignore" | "require_identity";
    dispatchStatus: "sent" | "ignored";
    reasonCode?: string;
    unboundUserMode?: string;
    expectedPermissionProfile?: string;
    agentBotMentioned?: boolean;
    requireDispatchEvidence?: boolean;
    requireNoDispatchEvidence?: boolean;
    requireNoOutboundReply?: boolean;
  },
): number {
  return mappings.filter((mapping) => {
    if (mapping.direction !== "inbound") {
      return false;
    }
    const metadata = readJsonRecord(mapping.metadataJson);
    if (
      metadata?.provider !== FEISHU_PROVIDER_ID ||
      metadata.actorType !== "external_guest" ||
      metadata.dispatchStatus !== input.dispatchStatus ||
      metadata.externalGuestPolicyDecision !== input.decision ||
      typeof metadata.externalGuestReference !== "string" ||
      metadata.externalGuestReference.trim().length === 0 ||
      !hasFeishuSafeInboundMessageContext(metadata) ||
      typeof metadata.externalGuestPermissionProfile !== "string" ||
      metadata.externalGuestPermissionProfile.trim().length === 0 ||
      !hasFeishuExternalGuestNoWorkspaceMemberEvidence(metadata) ||
      !hasNoFeishuDofeAgentCommandRoute(metadata) ||
      !hasFeishuMessageMappingAgentBotContext(mapping, metadata)
    ) {
      return false;
    }
    if (input.requireDispatchEvidence && (!mapping.taskQueueId || !mapping.dofeAgentMessageId)) {
      return false;
    }
    if (input.requireNoDispatchEvidence && (mapping.taskQueueId || mapping.dofeAgentMessageId)) {
      return false;
    }
    if (input.requireNoOutboundReply && hasFeishuCorrelatedOutboundReply(mappings, mapping)) {
      return false;
    }
    if (input.reasonCode && metadata.externalGuestPolicyReasonCode !== input.reasonCode) {
      return false;
    }
    if (input.unboundUserMode && metadata.externalGuestUnboundUserMode !== input.unboundUserMode) {
      return false;
    }
    if (input.expectedPermissionProfile && metadata.externalGuestPermissionProfile !== input.expectedPermissionProfile) {
      return false;
    }
    if (input.agentBotMentioned !== undefined && metadata.agentBotMentioned !== input.agentBotMentioned) {
      return false;
    }
    return true;
  }).length;
}
export function countFeishuExternalGuestReplyAllEvidence(
  mappings: readonly ExternalMessageMappingRecord[],
): number {
  return mappings.filter((mapping) => {
    if (mapping.direction !== "inbound" || !mapping.taskQueueId || !mapping.dofeAgentMessageId) {
      return false;
    }
    const metadata = readJsonRecord(mapping.metadataJson);
    return metadata?.provider === FEISHU_PROVIDER_ID &&
      metadata.actorType === "external_guest" &&
      metadata.dispatchStatus === "sent" &&
      metadata.externalGuestPolicyDecision === "allow" &&
      metadata.externalGuestPolicyReasonCode === "feishu_external_guest_allowed" &&
      metadata.externalGuestUnboundUserMode === "reply_all" &&
      metadata.agentBotMentioned === false &&
      hasNoFeishuDofeAgentCommandRoute(metadata) &&
      hasFeishuSafeInboundMessageContext(metadata) &&
      typeof metadata.externalGuestReference === "string" &&
      metadata.externalGuestReference.trim().length > 0 &&
      metadata.externalGuestPermissionProfile === "channel_context_only" &&
      hasFeishuExternalGuestNoWorkspaceMemberEvidence(metadata) &&
      hasFeishuMessageMappingAgentBotContext(mapping, metadata);
  }).length;
}
export function countFeishuIdentityBindingNoticeEvidence(
  mappings: readonly ExternalMessageMappingRecord[],
  outbox: readonly ExternalMessageOutboxRecord[],
): number {
  return mappings.filter((mapping) => {
    if (mapping.direction !== "inbound" || mapping.taskQueueId || mapping.dofeAgentMessageId) {
      return false;
    }
    const metadata = readJsonRecord(mapping.metadataJson);
    if (
      metadata?.provider !== FEISHU_PROVIDER_ID ||
      metadata.actorType !== "external_guest" ||
      metadata.dispatchStatus !== "ignored" ||
      metadata.externalGuestPolicyDecision !== "require_identity" ||
      metadata.externalGuestPolicyReasonCode !== "feishu_external_guest_identity_required" ||
      metadata.externalGuestUnboundUserMode !== "require_identity" ||
      metadata.agentBotMentioned !== true ||
      !hasFeishuExternalGuestNoWorkspaceMemberEvidence(metadata) ||
      !hasFeishuMessageMappingAgentBotContext(mapping, metadata) ||
      !hasNoFeishuDofeAgentCommandRoute(metadata) ||
      !hasFeishuSafeInboundMessageContext(metadata)
    ) {
      return false;
    }
    return outbox.some((item) => hasMatchingFeishuIdentityBindingNotice(item, mapping, metadata));
  }).length;
}
export function hasMatchingFeishuIdentityBindingNotice(
  item: ExternalMessageOutboxRecord,
  mapping: ExternalMessageMappingRecord,
  inboundMetadata: Record<string, unknown>,
): boolean {
  if (item.status !== "sent" || item.integrationId !== mapping.integrationId || !hasNonEmptyString(item.sentAt)) {
    return false;
  }
  if (!mapping.channelBindingId || item.channelBindingId !== mapping.channelBindingId) {
    return false;
  }
  const replyTargetExternalId = mapping.externalThreadId || mapping.externalMessageId;
  if (!hasNonEmptyString(replyTargetExternalId) || item.targetExternalThreadId !== replyTargetExternalId) {
    return false;
  }
  const metadata = readJsonRecord(item.metadataJson);
  const replyTargetReference = buildFeishuShortHash(replyTargetExternalId);
  return metadata?.provider === FEISHU_PROVIDER_ID &&
    metadata.noticeType === "identity_binding_required" &&
    metadata.noticeSource === "external_guest_policy" &&
    metadata.reasonCode === "feishu_external_guest_identity_required" &&
    metadata.actorType === "external_guest" &&
    metadata.agentId === inboundMetadata.agentId &&
    metadata.botBindingId === inboundMetadata.botBindingId &&
    metadata.externalGuestReference === inboundMetadata.externalGuestReference &&
    metadata.externalGuestPermissionProfile === "none" &&
    metadata.externalChatReference === inboundMetadata.externalChatReference &&
    metadata.externalThreadReference === replyTargetReference &&
    hasFeishuExternalGuestNoWorkspaceMemberEvidence(metadata) &&
    hasNoFeishuRawExternalLocationContext(metadata) &&
    hasNoFeishuUnsafeSerializedEvidenceContext(metadata);
}
export function countFeishuAutoProvisionedChannelBindings(
  bindings: readonly ExternalChannelBindingRecord[],
  provisionSource?: "bot_added" | "first_message",
): number {
  return bindings.filter((binding) => {
    if (binding.status !== "active") {
      return false;
    }
    const metadata = readJsonRecord(binding.metadataJson);
    const source = typeof metadata?.provisionSource === "string" ? metadata.provisionSource : undefined;
    if (provisionSource ? source !== provisionSource : source !== "bot_added" && source !== "first_message") {
      return false;
    }
    return metadata?.provider === FEISHU_PROVIDER_ID &&
      hasFeishuAutoProvisionedChannelIdentity(binding, metadata);
  }).length;
}
export function countFeishuReusedProviderChannelBindings(
  bindings: readonly ExternalChannelBindingRecord[],
): number {
  return bindings.filter((binding) => {
    if (binding.status !== "active") {
      return false;
    }
    const metadata = readJsonRecord(binding.metadataJson);
    const bindingId = binding.id.trim();
    const agentId = hasNonEmptyString(metadata?.agentId) ? metadata.agentId.trim() : "";
    const botBindingId = hasNonEmptyString(metadata?.botBindingId) ? metadata.botBindingId.trim() : "";
    const linkedFromAgentId = hasNonEmptyString(metadata?.linkedFromAgentId)
      ? metadata.linkedFromAgentId.trim()
      : "";
    const linkedFromBotBindingId = hasNonEmptyString(metadata?.linkedFromBotBindingId)
      ? metadata.linkedFromBotBindingId.trim()
      : "";
    return metadata?.provider === FEISHU_PROVIDER_ID &&
      metadata.provisionSource === "bot_added" &&
      hasFeishuAutoProvisionedChannelIdentity(binding, metadata) &&
      typeof metadata.linkedFromBindingId === "string" &&
      metadata.linkedFromBindingId.trim().length > 0 &&
      metadata.linkedFromBindingId.trim() !== bindingId &&
      agentId.length > 0 &&
      botBindingId === binding.integrationId &&
      linkedFromAgentId.length > 0 &&
      linkedFromAgentId !== agentId &&
      linkedFromBotBindingId.length > 0 &&
      linkedFromBotBindingId !== botBindingId &&
      typeof metadata.externalChatReference === "string" &&
      metadata.externalChatReference.trim().length > 0;
  }).length;
}
export function hasFeishuAutoProvisionedChannelIdentity(
  binding: ExternalChannelBindingRecord,
  metadata: Record<string, unknown> | undefined,
): boolean {
  return hasNonEmptyString(binding.id) &&
    hasNonEmptyString(binding.integrationId) &&
    hasNonEmptyString(binding.channelName) &&
    hasNonEmptyString(binding.externalChatId) &&
    hasFeishuSafeAutoProvisionMetadata(metadata) &&
    hasFeishuAutoProvisionedAgentBotContext(binding, metadata);
}
export function hasFeishuSafeAutoProvisionMetadata(
  metadata: Record<string, unknown> | undefined,
): metadata is Record<string, unknown> {
  return metadata !== undefined &&
    hasNonEmptyString(metadata.externalChatReference) &&
    isFeishuAutoProvisionReviewStatus(metadata.reviewStatus) &&
    hasNoFeishuRawExternalLocationContext(metadata) &&
    hasNoFeishuRawProviderIdentityContext(metadata) &&
    hasNoFeishuUnsafeSerializedEvidenceContext(metadata);
}
export function hasFeishuAutoProvisionedAgentBotContext(
  binding: ExternalChannelBindingRecord,
  metadata: Record<string, unknown> | undefined,
): boolean {
  return hasNonEmptyString(metadata?.agentId) &&
    readStringMetadata(metadata?.botBindingId) === binding.integrationId;
}
export function isFeishuAutoProvisionReviewStatus(value: unknown): boolean {
  return value === "approved" ||
    value === "pending_admin_review" ||
    value === "needs_identity_binding";
}
export function countFeishuThreadTaskBindingEvidence(
  bindings: readonly ExternalThreadBindingRecord[],
): number {
  return bindings.filter((binding) => {
    if (binding.provider !== FEISHU_PROVIDER_ID || binding.status !== "active") {
      return false;
    }
    if (!binding.taskQueueId || !binding.dofeAgentMessageId || !binding.agentId) {
      return false;
    }
    const metadata = readJsonRecord(binding.metadataJson);
    const agentId = hasNonEmptyString(metadata?.agentId) ? metadata.agentId.trim() : "";
    const botBindingId = hasNonEmptyString(metadata?.botBindingId) ? metadata.botBindingId.trim() : "";
    return metadata?.provider === FEISHU_PROVIDER_ID &&
      agentId.length > 0 &&
      binding.agentId.trim() === agentId &&
      botBindingId.length > 0 &&
      botBindingId === binding.integrationId &&
      hasFeishuSafeThreadEvidenceContext(metadata);
  }).length;
}
export function countFeishuThreadContinuationEvidence(
  mappings: readonly ExternalMessageMappingRecord[],
  bindings: readonly ExternalThreadBindingRecord[],
): number {
  return mappings.filter((mapping) => {
    if (mapping.direction !== "inbound" || !mapping.taskQueueId || !mapping.dofeAgentMessageId) {
      return false;
    }
    const metadata = readJsonRecord(mapping.metadataJson);
    if (
      metadata?.provider !== FEISHU_PROVIDER_ID ||
      metadata.dispatchStatus !== "sent" ||
      metadata.threadContinuation !== true ||
      metadata.agentBotMentioned !== false ||
      typeof metadata.threadBindingId !== "string" ||
      metadata.threadBindingId.trim().length === 0 ||
      typeof metadata.agentId !== "string" ||
      metadata.agentId.trim().length === 0 ||
      typeof metadata.botBindingId !== "string" ||
      metadata.botBindingId.trim().length === 0 ||
      !hasFeishuSafeThreadEvidenceContext(metadata)
    ) {
      return false;
    }
    return hasMatchingFeishuThreadContinuationBinding(mapping, bindings, {
      threadBindingId: metadata.threadBindingId.trim(),
      agentId: metadata.agentId.trim(),
      botBindingId: metadata.botBindingId.trim(),
    });
  }).length;
}
export function hasMatchingFeishuThreadContinuationBinding(
  mapping: ExternalMessageMappingRecord,
  bindings: readonly ExternalThreadBindingRecord[],
  expected: {
    threadBindingId: string;
    agentId: string;
    botBindingId: string;
  },
): boolean {
  return bindings.some((binding) => {
    if (
      binding.id !== expected.threadBindingId ||
      binding.provider !== FEISHU_PROVIDER_ID ||
      binding.status !== "active" ||
      binding.integrationId !== mapping.integrationId ||
      binding.channelBindingId !== mapping.channelBindingId ||
      binding.taskQueueId !== mapping.taskQueueId ||
      binding.dofeAgentMessageId !== mapping.dofeAgentMessageId ||
      expected.botBindingId !== binding.integrationId ||
      !binding.agentId ||
      binding.agentId.trim() !== expected.agentId
    ) {
      return false;
    }
    const metadata = readJsonRecord(binding.metadataJson);
    return metadata?.provider === FEISHU_PROVIDER_ID &&
      metadata.agentId === expected.agentId &&
      metadata.botBindingId === expected.botBindingId &&
      hasFeishuSafeThreadEvidenceContext(metadata);
  });
}
export function countFeishuThreadCollaborationEvidence(
  bindings: readonly ExternalThreadBindingRecord[],
): number {
  return bindings.filter((binding) => {
    if (binding.provider !== FEISHU_PROVIDER_ID || binding.status !== "active") {
      return false;
    }
    if (!binding.taskQueueId || !binding.dofeAgentMessageId || !binding.agentId) {
      return false;
    }
    const metadata = readJsonRecord(binding.metadataJson);
    const agentId = hasNonEmptyString(metadata?.agentId) ? metadata.agentId.trim() : "";
    const botBindingId = hasNonEmptyString(metadata?.botBindingId) ? metadata.botBindingId.trim() : "";
    return metadata?.provider === FEISHU_PROVIDER_ID &&
      metadata.threadCollaboration === true &&
      agentId.length > 0 &&
      binding.agentId.trim() === agentId &&
      botBindingId.length > 0 &&
      botBindingId === binding.integrationId &&
      hasDifferentFeishuCollaboratingId(metadata.collaboratingAgentIds, agentId) &&
      hasDifferentFeishuCollaboratingId(metadata.collaboratingBotBindingIds, botBindingId) &&
      hasFeishuSafeThreadEvidenceContext(metadata);
  }).length;
}
export function countFeishuThreadCollaborationCardEvidence(
  outbox: readonly ExternalMessageOutboxRecord[],
  bindings: readonly ExternalThreadBindingRecord[],
): number {
  return outbox.filter((item) => {
    if (item.status !== "sent" || !hasNonEmptyString(item.sentAt)) {
      return false;
    }
    const metadata = readJsonRecord(item.metadataJson);
    const agentId = hasNonEmptyString(metadata?.agentId) ? metadata.agentId.trim() : "";
    const botBindingId = hasNonEmptyString(metadata?.botBindingId) ? metadata.botBindingId.trim() : "";
    const externalChatReference = readStringMetadata(metadata?.externalChatReference);
    const externalThreadReference = readStringMetadata(metadata?.externalThreadReference);
    return metadata?.provider === FEISHU_PROVIDER_ID &&
      metadata.noticeType === "thread_collaboration" &&
      metadata.noticeSource === "native_agent_bot" &&
      agentId.length > 0 &&
      botBindingId.length > 0 &&
      botBindingId === item.integrationId &&
      hasDifferentFeishuCollaboratingId(metadata.collaboratingAgentIds, agentId) &&
      hasDifferentFeishuCollaboratingId(metadata.collaboratingBotBindingIds, botBindingId) &&
      externalChatReference !== undefined &&
      externalThreadReference !== undefined &&
      hasNoFeishuRawExternalLocationContext(metadata) &&
      hasNoFeishuRawProviderIdentityContext(metadata) &&
      hasNoFeishuUnsafeSerializedEvidenceContext(metadata) &&
      hasMatchingFeishuThreadCollaborationBindingForCard(bindings, {
        integrationId: item.integrationId,
        agentId,
        botBindingId,
        externalChatReference,
        externalThreadReference,
        collaboratingAgentIds: metadata.collaboratingAgentIds,
        collaboratingBotBindingIds: metadata.collaboratingBotBindingIds,
      });
  }).length;
}
export function hasMatchingFeishuThreadCollaborationBindingForCard(
  bindings: readonly ExternalThreadBindingRecord[],
  expected: {
    integrationId: string;
    agentId: string;
    botBindingId: string;
    externalChatReference: string;
    externalThreadReference: string;
    collaboratingAgentIds: unknown;
    collaboratingBotBindingIds: unknown;
  },
): boolean {
  const expectedCollaboratingAgentIds = readStringArrayMetadata(expected.collaboratingAgentIds)
    .filter((agentId) => agentId !== expected.agentId);
  const expectedCollaboratingBotBindingIds = readStringArrayMetadata(expected.collaboratingBotBindingIds)
    .filter((botBindingId) => botBindingId !== expected.botBindingId);
  if (expectedCollaboratingAgentIds.length === 0 || expectedCollaboratingBotBindingIds.length === 0) {
    return false;
  }

  return bindings.some((binding) => {
    if (
      binding.provider !== FEISHU_PROVIDER_ID ||
      binding.status !== "active" ||
      binding.integrationId !== expected.integrationId ||
      !binding.taskQueueId ||
      !binding.dofeAgentMessageId ||
      !binding.agentId ||
      binding.agentId.trim() !== expected.agentId
    ) {
      return false;
    }
    const metadata = readJsonRecord(binding.metadataJson);
    const agentId = hasNonEmptyString(metadata?.agentId) ? metadata.agentId.trim() : "";
    const botBindingId = hasNonEmptyString(metadata?.botBindingId) ? metadata.botBindingId.trim() : "";
    if (
      metadata?.provider !== FEISHU_PROVIDER_ID ||
      metadata.threadCollaboration !== true ||
      agentId !== expected.agentId ||
      botBindingId !== expected.botBindingId ||
      botBindingId !== binding.integrationId ||
      metadata.externalChatReference !== expected.externalChatReference ||
      metadata.externalThreadReference !== expected.externalThreadReference ||
      !hasFeishuSafeThreadEvidenceContext(metadata)
    ) {
      return false;
    }

    return hasFeishuCollaboratingIdIntersection(metadata.collaboratingAgentIds, expectedCollaboratingAgentIds) &&
      hasFeishuCollaboratingIdIntersection(metadata.collaboratingBotBindingIds, expectedCollaboratingBotBindingIds);
  });
}
export function hasFeishuSafeThreadEvidenceContext(
  metadata: Record<string, unknown> | undefined,
): metadata is Record<string, unknown> {
  return metadata !== undefined &&
    hasNonEmptyString(metadata.externalChatReference) &&
    hasNonEmptyString(metadata.externalThreadReference) &&
    hasNoFeishuRawExternalLocationContext(metadata) &&
    hasNoFeishuRawProviderIdentityContext(metadata) &&
    hasNoFeishuUnsafeSerializedEvidenceContext(metadata);
}
export function hasFeishuCollaboratingIdIntersection(value: unknown, expectedIds: readonly string[]): boolean {
  const ids = readStringArrayMetadata(value);
  return expectedIds.some((expectedId) => ids.includes(expectedId));
}
export function hasDifferentFeishuCollaboratingId(value: unknown, currentId: string): boolean {
  if (!Array.isArray(value)) {
    return false;
  }
  return value.some((id) =>
    typeof id === "string" &&
    id.trim().length > 0 &&
    id.trim() !== currentId
  );
}
export function countFeishuFailedOutboxAgentBotEvidence(
  outbox: readonly ExternalMessageOutboxRecord[],
): number {
  return outbox.filter((item) => {
    if (item.status !== "failed" && !(item.status === "pending" && Boolean(item.lastError))) {
      return false;
    }
    const metadata = readJsonRecord(item.metadataJson);
    return metadata?.provider === FEISHU_PROVIDER_ID &&
      hasNonEmptyString(metadata.agentId) &&
      hasNonEmptyString(metadata.botBindingId) &&
      metadata.botBindingId.trim() === item.integrationId &&
      hasNonEmptyString(metadata.externalChatReference) &&
      !hasNonEmptyString(metadata.externalChatId) &&
      !hasNonEmptyString(metadata.external_chat_id) &&
      !hasNonEmptyString(metadata.externalThreadId) &&
      !hasNonEmptyString(metadata.external_thread_id) &&
      !hasNonEmptyString(metadata.targetExternalChatId) &&
      !hasNonEmptyString(metadata.target_external_chat_id) &&
      !hasNonEmptyString(metadata.targetExternalThreadId) &&
      !hasNonEmptyString(metadata.target_external_thread_id) &&
      hasNoFeishuUnsafeSerializedEvidenceContext(metadata) &&
      hasNoFeishuRawFailureText(item.lastError) &&
      hasFeishuFailureOutboxSource(metadata);
  }).length;
}
export function hasFeishuFailureOutboxSource(metadata: Record<string, unknown>): boolean {
  return metadata.outboxSource === "direct_outbound_message" ||
    metadata.outboxSource === "agent_reply" ||
    metadata.outboxSource === "agent_status_card" ||
    metadata.noticeType === "identity_binding_required";
}
export function countFeishuFailedDataOperationAgentBotEvidence(
  operations: readonly ExternalDataOperationRunRecord[],
): number {
  return operations.filter((operation) => {
    if (operation.status !== "failed") {
      return false;
    }
    const governanceContext = readFeishuGovernanceContext(operation);
    return hasFeishuAgentBotDataOperationContext(operation, governanceContext) &&
      hasNonEmptyString(operation.resourceBindingId) &&
      hasNonEmptyString(operation.operationType) &&
      hasNonEmptyString(operation.providerResourceType) &&
      hasFeishuSafeDataOperationResultSummary(operation) &&
      hasNoFeishuRawFailureText(operation.errorMessage);
  }).length;
}
export function hasNoFeishuRawFailureText(value: unknown): boolean {
  if (!hasNonEmptyString(value)) {
    return true;
  }
  return !containsFeishuSecretLikeEvidence(value) &&
    !containsRawFeishuOpenApiEvidenceIdentifier(value);
}
export function hasFeishuAgentBotDataOperationContext(
  operation: ExternalDataOperationRunRecord,
  governanceContext: Record<string, unknown> | undefined,
): governanceContext is Record<string, unknown> {
  const botBindingId = readStringMetadata(governanceContext?.botBindingId);
  return governanceContext?.provider === FEISHU_PROVIDER_ID &&
    hasNonEmptyString(governanceContext.agentId) &&
    botBindingId === operation.integrationId &&
    hasFeishuSafeDataOperationResourceContext(governanceContext);
}
export function hasFeishuSafeDataOperationResourceContext(governanceContext: Record<string, unknown>): boolean {
  return hasNonEmptyString(governanceContext.resourceReference) &&
    governanceContext.resourceIdRedacted === true &&
    hasNoFeishuRawExternalLocationContext(governanceContext) &&
    hasNoFeishuRawProviderIdentityContext(governanceContext) &&
    hasNoFeishuUnsafeSerializedEvidenceContext(governanceContext);
}
export function hasNoFeishuRawProviderIdentityContext(metadata: Record<string, unknown>): boolean {
  const rawIdentityFields = [
    "externalUserId",
    "externalOpenId",
    "externalUnionId",
    "feishuOpenId",
    "feishuUnionId",
    "openId",
    "unionId",
    "providerUserId",
    "providerOpenId",
    "providerUnionId",
    "senderOpenId",
    "senderUnionId",
    "user_id",
    "open_id",
    "union_id",
    "external_user_id",
    "external_open_id",
    "external_union_id",
    "provider_user_id",
    "provider_open_id",
    "provider_union_id",
  ];
  return rawIdentityFields.every((field) => !hasNonEmptyString(metadata[field]));
}
export function hasNoFeishuRawExternalLocationContext(metadata: Record<string, unknown>): boolean {
  const rawLocationFields = [
    "chatId",
    "externalChatId",
    "sourceChatId",
    "targetExternalChatId",
    "threadId",
    "externalThreadId",
    "sourceThreadId",
    "targetExternalThreadId",
    "chat_id",
    "external_chat_id",
    "source_chat_id",
    "target_external_chat_id",
    "thread_id",
    "external_thread_id",
    "source_thread_id",
    "target_external_thread_id",
  ];
  return rawLocationFields.every((field) => !hasNonEmptyString(metadata[field]));
}
export function hasNoFeishuRawDataOperationResourceContext(metadata: Record<string, unknown>): boolean {
  const rawResourceFields = [
    "providerResourceToken",
    "externalResourceId",
    "externalResourceToken",
    "resourceId",
    "resourceToken",
    "rawResourceToken",
    "docToken",
    "documentId",
    "sheetToken",
    "spreadsheetToken",
    "baseToken",
    "appToken",
    "tableId",
    "viewId",
    "provider_resource_token",
    "external_resource_id",
    "external_resource_token",
    "resource_id",
    "resource_token",
    "raw_resource_token",
    "doc_token",
    "document_id",
    "sheet_token",
    "spreadsheet_token",
    "base_token",
    "app_token",
    "table_id",
    "view_id",
  ];
  return rawResourceFields.every((field) => !hasNonEmptyString(metadata[field]));
}
export function verifyFeishuOpenApiSmokeEvidence(input: {
  evidencePath?: string;
  evidence?: unknown;
  expectedCallbackRouteProofs?: readonly FeishuExpectedCallbackRouteProof[];
  expectedIdentityProofs?: readonly FeishuExpectedBotAddedPayloadIdentityProof[];
  expectedSecondAgentAppProofs?: readonly FeishuExpectedTodo120NativeSecondAgentAppProof[];
  remediationContext?: {
    workspaceId: string;
    integrationId?: string;
  };
}): FeishuOpenApiSmokeEvidenceVerification {
  if (!input.evidencePath && input.evidence === undefined) {
    const issues = ["openapi_evidence_missing"];
    return {
      present: false,
      valid: false,
      issues,
      remediationSteps: buildFeishuOpenApiEvidenceRemediationSteps({
        issues,
        context: input.remediationContext,
      }),
    };
  }

  let evidence = input.evidence;
  if (evidence === undefined && input.evidencePath) {
    try {
      evidence = JSON.parse(readFileSync(input.evidencePath, "utf8")) as unknown;
    } catch {
      const issues = ["openapi_evidence_unreadable"];
      return {
        evidencePath: input.evidencePath,
        present: false,
        valid: false,
        issues,
        remediationSteps: buildFeishuOpenApiEvidenceRemediationSteps({
          issues,
          context: input.remediationContext,
        }),
      };
    }
  }

  const issues: string[] = [];
  const output = isRecord(evidence) ? evidence : undefined;
  const summary = isRecord(output?.summary) ? output.summary : undefined;
  const appIdentity = isRecord(output?.appIdentity) ? output.appIdentity : undefined;
  const todo120NativeSmoke = isRecord(output?.todo120NativeSmoke) ? output.todo120NativeSmoke : undefined;
  const steps = Array.isArray(output?.steps) ? output.steps : [];
  let appMatchedIdentityProof: FeishuExpectedBotAddedPayloadIdentityProof | undefined;
  let matchedIdentityProof: FeishuExpectedBotAddedPayloadIdentityProof | undefined;

  if (!output) {
    issues.push("openapi_evidence_not_object");
  }
  const generatedAtState = readFeishuSmokeEvidenceGeneratedAtState(output?.generatedAt);
  if (!generatedAtState.present) {
    issues.push("openapi_evidence_generated_at_missing");
  } else if (!generatedAtState.valid) {
    issues.push("openapi_evidence_generated_at_invalid");
  } else if (!generatedAtState.fresh) {
    issues.push("openapi_evidence_stale");
  }
  if (output?.live !== true) {
    issues.push("openapi_not_live_run");
  }
  if (output?.strictLive !== true) {
    issues.push("openapi_not_strict_live_run");
  }
  if (summary?.strictLiveSatisfied !== true) {
    issues.push("openapi_strict_live_not_satisfied");
  }
  if (readNumber(summary?.liveSkipped) !== 0) {
    issues.push("openapi_live_steps_skipped");
  }
  if (readNumber(summary?.liveFailed) !== 0) {
    issues.push("openapi_live_steps_failed");
  }
  if (Array.isArray(summary?.missingEnv) && summary.missingEnv.length > 0) {
    issues.push("openapi_missing_live_env");
  }
  if (!appIdentity) {
    issues.push("openapi_app_identity_missing");
  } else if (!hasFeishuSha256HashEvidence(appIdentity.appIdHash)) {
    issues.push("openapi_app_identity_app_id_hash_missing");
  } else if (input.expectedIdentityProofs && input.expectedIdentityProofs.length === 0) {
    issues.push("openapi_app_identity_active_integration_missing");
  } else if ((input.expectedIdentityProofs?.length ?? 0) > 0) {
    const identityMatch = matchFeishuExpectedIdentityProof(input.expectedIdentityProofs ?? [], appIdentity);
    appMatchedIdentityProof = identityMatch.appMatchedProof;
    matchedIdentityProof = identityMatch.fullMatchedProof;
    if (!appMatchedIdentityProof) {
      issues.push("openapi_app_identity_app_id_mismatch");
    } else if (identityMatch.tenantIssue) {
      issues.push(`openapi_app_identity_${identityMatch.tenantIssue}`);
    }
  }
  if (!todo120NativeSmoke) {
    issues.push("openapi_todo120_native_smoke_missing");
  } else {
    if (todo120NativeSmoke.requiredForCommand !== true) {
      issues.push("openapi_todo120_native_smoke_not_required");
    }
    if (todo120NativeSmoke.ready !== true) {
      issues.push("openapi_todo120_native_smoke_not_ready");
    }
    if (readNumber(todo120NativeSmoke.required) < 2) {
      issues.push("openapi_todo120_native_smoke_requirement_incomplete");
    }
    if (readNumber(todo120NativeSmoke.configured) < readNumber(todo120NativeSmoke.required)) {
      issues.push("openapi_todo120_native_smoke_env_incomplete");
    }
    if (!hasFeishuSha256HashEvidence(todo120NativeSmoke.secondAgentAppIdHash)) {
      issues.push("openapi_todo120_native_smoke_second_app_id_hash_missing");
    } else if (input.expectedSecondAgentAppProofs && matchedIdentityProof) {
      const expectedSecondAgentAppProofs = input.expectedSecondAgentAppProofs.filter((proof) =>
        proof.anchorIntegrationId === matchedIdentityProof.integrationId
      );
      if (expectedSecondAgentAppProofs.length === 0) {
        issues.push("openapi_todo120_native_smoke_second_app_local_evidence_missing");
      } else if (!expectedSecondAgentAppProofs.some((proof) =>
        proof.appIdHash === todo120NativeSmoke.secondAgentAppIdHash
      )) {
        issues.push("openapi_todo120_native_smoke_second_app_mismatch");
      }
    }
  }
  if (readNumber(summary?.liveChecks) < FEISHU_OPENAPI_REQUIRED_LIVE_SMOKE_STEPS.length) {
    issues.push("openapi_live_check_summary_incomplete");
  }
  if (readNumber(summary?.livePassed) < FEISHU_OPENAPI_REQUIRED_LIVE_SMOKE_STEPS.length) {
    issues.push("openapi_live_passed_summary_incomplete");
  }

  for (const stepName of FEISHU_OPENAPI_REQUIRED_LIVE_SMOKE_STEPS) {
    const step = steps.find((item) => isFeishuOpenApiSmokeStepNamed(item, stepName));
    if (!step) {
      issues.push(`openapi_required_step_missing:${stepName}`);
      continue;
    }
    if (step.status !== "pass") {
      issues.push(`openapi_required_step_not_passed:${stepName}`);
    }
    if (step.liveCheck !== true) {
      issues.push(`openapi_required_step_not_marked_live:${stepName}`);
    }
  }

  const callbackStep = steps.find((item) => isFeishuOpenApiSmokeStepNamed(item, "DofeAgent callback URL verification"));
  if (!hasValidFeishuCallbackRouteProof(callbackStep)) {
    issues.push("openapi_callback_route_proof_missing");
  } else if (input.expectedCallbackRouteProofs) {
    const expectedCallbackRouteProofs = matchedIdentityProof
      ? input.expectedCallbackRouteProofs.filter((proof) => proof.integrationId === matchedIdentityProof.integrationId)
      : input.expectedCallbackRouteProofs;
    if (expectedCallbackRouteProofs.length === 0) {
      issues.push("openapi_callback_route_active_integration_missing");
    } else if (!expectedCallbackRouteProofs.some((proof) => matchesFeishuCallbackRouteProof(callbackStep, proof))) {
      issues.push("openapi_callback_route_proof_mismatch");
    }
  }

  for (const stepName of FEISHU_OPENAPI_REQUIRED_REQUEST_STEPS) {
    const step = steps.find((item) => isFeishuOpenApiSmokeStepNamed(item, stepName));
    if (!step) {
      continue;
    }
    if (!hasFeishuOpenApiSmokeRequestSummary(step)) {
      issues.push(`openapi_required_request_summary_missing:${stepName}`);
    }
  }

  const sheetWrite = steps.find((item) => isFeishuOpenApiSmokeStepNamed(item, "Sheets write values"));
  const docAppend = steps.find((item) => isFeishuOpenApiSmokeStepNamed(item, "Docs docx append blocks"));
  const baseUpdate = steps.find((item) => isFeishuOpenApiSmokeStepNamed(item, "Base update record"));
  if (docAppend?.destructive !== true) {
    issues.push("openapi_doc_append_not_marked_destructive");
  }
  if (sheetWrite?.destructive !== true) {
    issues.push("openapi_sheet_write_not_marked_destructive");
  }
  if (baseUpdate?.destructive !== true) {
    issues.push("openapi_base_update_not_marked_destructive");
  }
  if (readNumber(summary?.destructiveLiveChecks) < FEISHU_OPENAPI_REQUIRED_DESTRUCTIVE_LIVE_SMOKE_STEPS.length) {
    issues.push("openapi_destructive_live_checks_missing");
  }

  for (const step of steps) {
    if (!isFeishuOpenApiSmokeStep(step)) {
      continue;
    }
    if (isRecord(step.request) && !hasFeishuOpenApiSmokeRequestSummary(step)) {
      issues.push(`openapi_request_summary_malformed:${step.name}`);
    } else if (hasFeishuOpenApiSmokeRequestSummary(step) && !isRedactedFeishuOpenApiSmokeRequestPath(step.request.path)) {
      issues.push(`openapi_request_path_not_redacted:${step.name}`);
    }
    if (typeof step.detail === "string" && containsRawFeishuOpenApiEvidenceIdentifier(step.detail)) {
      issues.push(`openapi_raw_feishu_identifier_in_detail:${step.name}`);
    }
    if (typeof step.detail === "string" && containsDofeAgentCallbackUrlOpenApiEvidence(step.detail)) {
      issues.push(`openapi_callback_url_in_detail:${step.name}`);
    }
  }
  if (containsFeishuSecretLikeEvidence(JSON.stringify(evidence))) {
    issues.push("openapi_secret_like_value_in_evidence");
  }
  if (containsRawFeishuOpenApiEvidenceIdentifier(JSON.stringify(evidence))) {
    issues.push("openapi_raw_feishu_identifier_in_evidence");
  }
  if (containsDofeAgentCallbackUrlOpenApiEvidence(JSON.stringify(evidence))) {
    issues.push("openapi_callback_url_in_evidence");
  }

  return {
    ...(input.evidencePath ? { evidencePath: input.evidencePath } : {}),
    present: true,
    valid: issues.length === 0,
    issues,
    remediationSteps: buildFeishuOpenApiEvidenceRemediationSteps({
      issues,
      context: input.remediationContext,
    }),
    summary: {
      live: output?.live === true,
      strictLive: output?.strictLive === true,
      strictLiveSatisfied: summary?.strictLiveSatisfied === true,
      liveChecks: readNumber(summary?.liveChecks),
      livePassed: readNumber(summary?.livePassed),
      liveSkipped: readNumber(summary?.liveSkipped),
      liveFailed: readNumber(summary?.liveFailed),
      destructiveLiveChecks: readNumber(summary?.destructiveLiveChecks),
      requiredLiveSteps: FEISHU_OPENAPI_REQUIRED_LIVE_SMOKE_STEPS.length,
      generatedAtPresent: generatedAtState.present,
      generatedAtFresh: generatedAtState.fresh,
      appIdentityPresent: Boolean(appIdentity),
      appIdHashPresent: hasFeishuSha256HashEvidence(appIdentity?.appIdHash),
      appIdentityMatched: Boolean(appMatchedIdentityProof),
      ...(readFeishuMatchedIdentityIntegrationId(matchedIdentityProof, appIdentity)
        ? { matchedIntegrationId: readFeishuMatchedIdentityIntegrationId(matchedIdentityProof, appIdentity) }
        : {}),
      tenantKeyHashPresent: hasFeishuSha256HashEvidence(appIdentity?.tenantKeyHash),
      tenantKeyMatched: Boolean(
        matchedIdentityProof &&
          (matchedIdentityProof.tenantKeyHash
            ? appIdentity?.tenantKeyHash === matchedIdentityProof.tenantKeyHash
            : appIdentity?.tenantKeyPresent !== true && !hasFeishuSha256HashEvidence(appIdentity?.tenantKeyHash)),
      ),
      todo120NativeSmokeReady: todo120NativeSmoke?.ready === true,
      todo120NativeSmokeRequiredForCommand: todo120NativeSmoke?.requiredForCommand === true,
      todo120NativeSmokeRequired: readNumber(todo120NativeSmoke?.required),
      todo120NativeSmokeConfigured: readNumber(todo120NativeSmoke?.configured),
      todo120NativeSmokeSecondAgentAppIdHashPresent: hasFeishuSha256HashEvidence(
        todo120NativeSmoke?.secondAgentAppIdHash,
      ),
    },
  };
}
export function buildFeishuOpenApiEvidenceRemediationSteps(input: {
  issues: readonly string[];
  context?: {
    workspaceId: string;
    integrationId?: string;
  };
}): FeishuEvidenceRemediationStep[] {
  if (input.issues.length === 0) {
    return [];
  }
  const harness = input.context
    ? buildFeishuSmokeHarnessSummary(input.context)
    : undefined;
  return [{
    stepId: "run_openapi_live_smoke_harness",
    title: "Live smoke: run isolated Feishu callback and OpenAPI harness",
    detail: "Regenerate the strict live OpenAPI evidence artifact after check-env passes; the artifact must include the current callback fingerprint, all required IM/Docs/Sheets/Base live checks, destructive write checks, and redacted request summaries.",
    issues: uniqueStrings([...input.issues]),
    command: harness
      ? `${harness.strictLiveCommand}\n${harness.verifyEvidenceCommand}`
    : "pnpm run smoke:feishu -- --env-file scripts/feishu/.env --live --strict-live --evidence runtime-output/feishu-smoke/live.json --json --require-todo120-native\npnpm run smoke:feishu -- --verify-evidence runtime-output/feishu-smoke/live.json --json",
  }];
}
export function verifyFeishuBotAddedPayloadEvidence(input: {
  evidencePath?: string;
  evidence?: unknown;
  expectedIdentityProofs?: readonly FeishuExpectedBotAddedPayloadIdentityProof[];
  expectedChatReferences?: readonly FeishuExpectedBotAddedPayloadChatReferenceProof[];
  remediationContext?: {
    workspaceId: string;
    integrationId?: string;
  };
}): FeishuBotAddedPayloadEvidenceVerification {
  if (!input.evidencePath && input.evidence === undefined) {
    const issues = ["bot_added_payload_evidence_missing"];
    return {
      present: false,
      valid: false,
      issues,
      remediationSteps: buildFeishuBotAddedPayloadEvidenceRemediationSteps({
        issues,
        context: input.remediationContext,
      }),
    };
  }

  let evidence = input.evidence;
  if (evidence === undefined && input.evidencePath) {
    try {
      evidence = JSON.parse(readFileSync(input.evidencePath, "utf8")) as unknown;
    } catch {
      const issues = ["bot_added_payload_evidence_unreadable"];
      return {
        evidencePath: input.evidencePath,
        present: false,
        valid: false,
        issues,
        remediationSteps: buildFeishuBotAddedPayloadEvidenceRemediationSteps({
          issues,
          context: input.remediationContext,
        }),
      };
    }
  }

  const issues: string[] = [];
  const output = isRecord(evidence) ? evidence : undefined;
  const summary = isRecord(output?.summary) ? output.summary : undefined;
  let appMatchedIdentityProof: FeishuExpectedBotAddedPayloadIdentityProof | undefined;
  let matchedIdentityProof: FeishuExpectedBotAddedPayloadIdentityProof | undefined;

  if (!output) {
    issues.push("bot_added_payload_evidence_not_object");
  }
  const generatedAtState = readFeishuSmokeEvidenceGeneratedAtState(output?.generatedAt);
  if (!generatedAtState.present) {
    issues.push("bot_added_payload_evidence_generated_at_missing");
  } else if (!generatedAtState.valid) {
    issues.push("bot_added_payload_evidence_generated_at_invalid");
  } else if (!generatedAtState.fresh) {
    issues.push("bot_added_payload_evidence_stale");
  }
  if (output?.valid !== true) {
    issues.push("bot_added_payload_evidence_not_valid");
  }
  if (Array.isArray(output?.issues) && output.issues.length > 0) {
    issues.push("bot_added_payload_evidence_has_issues");
  }
  if (!summary) {
    issues.push("bot_added_payload_summary_missing");
  } else {
    if (!hasFeishuSha256HashEvidence(summary.appIdHash)) {
      issues.push("bot_added_payload_app_id_hash_missing");
    } else if (input.expectedIdentityProofs && input.expectedIdentityProofs.length === 0) {
      issues.push("bot_added_payload_active_integration_missing");
    } else if ((input.expectedIdentityProofs?.length ?? 0) > 0) {
      const identityMatch = matchFeishuExpectedIdentityProof(input.expectedIdentityProofs ?? [], summary);
      appMatchedIdentityProof = identityMatch.appMatchedProof;
      matchedIdentityProof = identityMatch.fullMatchedProof;
      if (!appMatchedIdentityProof) {
        issues.push("bot_added_payload_app_id_mismatch");
      } else if (identityMatch.tenantIssue) {
        issues.push(`bot_added_payload_${identityMatch.tenantIssue}`);
      }
    }
    if (summary.botAddedEvent !== true) {
      issues.push("bot_added_payload_not_bot_added");
    }
    if (summary.chatDescriptorPresent !== true) {
      issues.push("bot_added_payload_chat_descriptor_missing");
    }
    if (summary.chatIdRedacted !== true) {
      issues.push("bot_added_payload_chat_id_not_redacted");
    }
    if (!hasNonEmptyString(summary.chatIdSource)) {
      issues.push("bot_added_payload_chat_id_source_missing");
    }
    if (!isSafeFeishuBotAddedReference(summary.chatReference, "chat")) {
      issues.push("bot_added_payload_chat_reference_missing");
    } else if (input.expectedChatReferences && input.expectedChatReferences.length === 0) {
      issues.push("bot_added_payload_chat_reference_local_evidence_missing");
    } else if ((input.expectedChatReferences?.length ?? 0) > 0) {
      const identityProof = matchedIdentityProof;
      const expectedChatReferences = identityProof
        ? input.expectedChatReferences?.filter((proof) => proof.integrationId === identityProof.integrationId)
        : input.expectedChatReferences;
      if (!expectedChatReferences || expectedChatReferences.length === 0) {
        issues.push("bot_added_payload_chat_reference_local_evidence_missing");
      } else if (!expectedChatReferences.some((proof) =>
        doFeishuSafeReferencesMatch(summary.chatReference, proof.chatReference)
      )) {
        issues.push("bot_added_payload_chat_reference_mismatch");
      }
    }
    if (summary.externalEventIdRedacted !== true) {
      issues.push("bot_added_payload_event_id_not_redacted");
    }
    if (summary.eventCreateTimePresent !== true) {
      issues.push("bot_added_payload_event_create_time_missing");
    } else if (summary.eventCreateTimeFresh !== true) {
      issues.push("bot_added_payload_event_create_time_stale");
    }
    if (!isSafeFeishuBotAddedReference(summary.externalEventReference, "event")) {
      issues.push("bot_added_payload_event_reference_missing");
    }
    if (!hasFeishuPayloadHashEvidence(summary.payloadHash)) {
      issues.push("bot_added_payload_hash_missing");
    }
    if (summary.rawPayloadStored !== false) {
      issues.push("bot_added_payload_raw_payload_stored");
    }
  }

  const serialized = JSON.stringify(evidence);
  if (containsFeishuSecretLikeEvidence(serialized)) {
    issues.push("bot_added_payload_secret_like_value");
  }
  if (containsRawFeishuOpenApiEvidenceIdentifier(serialized)) {
    issues.push("bot_added_payload_raw_feishu_identifier");
  }
  if (containsDofeAgentCallbackUrlOpenApiEvidence(serialized)) {
    issues.push("bot_added_payload_callback_url");
  }

  return {
    ...(input.evidencePath ? { evidencePath: input.evidencePath } : {}),
    present: true,
    valid: issues.length === 0,
    issues,
    remediationSteps: buildFeishuBotAddedPayloadEvidenceRemediationSteps({
      issues,
      context: input.remediationContext,
    }),
    ...(summary
      ? {
        summary: {
          eventType: typeof summary.eventType === "string" ? summary.eventType : "",
          botAddedEvent: summary.botAddedEvent === true,
          appIdPresent: summary.appIdPresent === true,
          appIdHashPresent: hasFeishuSha256HashEvidence(summary.appIdHash),
          appIdentityMatched: Boolean(appMatchedIdentityProof),
          ...(readFeishuMatchedIdentityIntegrationId(matchedIdentityProof, summary)
            ? { matchedIntegrationId: readFeishuMatchedIdentityIntegrationId(matchedIdentityProof, summary) }
            : {}),
          tenantKeyPresent: summary.tenantKeyPresent === true,
          tenantKeyHashPresent: hasFeishuSha256HashEvidence(summary.tenantKeyHash),
          tenantKeyMatched: Boolean(
            matchedIdentityProof &&
              (matchedIdentityProof.tenantKeyHash
                ? summary.tenantKeyHash === matchedIdentityProof.tenantKeyHash
                : summary.tenantKeyPresent !== true && !hasFeishuSha256HashEvidence(summary.tenantKeyHash)),
          ),
          chatDescriptorPresent: summary.chatDescriptorPresent === true,
          ...(hasNonEmptyString(summary.chatIdSource) ? { chatIdSource: summary.chatIdSource } : {}),
          ...(isSafeFeishuBotAddedReference(summary.chatReference, "chat")
            ? { chatReference: summary.chatReference }
            : {}),
          chatIdRedacted: summary.chatIdRedacted === true,
          ...(hasNonEmptyString(summary.chatType) ? { chatType: summary.chatType } : {}),
          chatNamePresent: summary.chatNamePresent === true,
          ...(isSafeFeishuBotAddedReference(summary.externalEventReference, "event")
            ? { externalEventReference: summary.externalEventReference }
            : {}),
          externalEventIdRedacted: summary.externalEventIdRedacted === true,
          eventCreateTimePresent: summary.eventCreateTimePresent === true,
          eventCreateTimeFresh: summary.eventCreateTimeFresh === true,
          payloadHashPresent: hasFeishuPayloadHashEvidence(summary.payloadHash),
          rawPayloadStored: summary.rawPayloadStored === true,
          generatedAtPresent: generatedAtState.present,
          generatedAtFresh: generatedAtState.fresh,
        },
      }
      : {}),
  };
}
export function buildFeishuBotAddedPayloadEvidenceRemediationSteps(input: {
  issues: readonly string[];
  context?: {
    workspaceId: string;
    integrationId?: string;
  };
}): FeishuEvidenceRemediationStep[] {
  if (input.issues.length === 0) {
    return [];
  }
  const harness = input.context
    ? buildFeishuSmokeHarnessSummary(input.context)
    : undefined;
  return [{
    stepId: "verify_real_bot_added_payload_sample",
    title: "Live smoke: verify captured Feishu bot-added callback payload",
    detail: "Save one raw im.chat.member.bot.added_v1 callback JSON from the disposable Feishu tenant/app, then regenerate the safe bot-added payload evidence artifact without raw chat ids, user ids, event ids, group names, secrets, or callback URLs.",
    issues: uniqueStrings([...input.issues]),
    command: harness
      ? harness.verifyBotAddedPayloadCommand
      : "pnpm run smoke:feishu -- --verify-bot-added-payload runtime-output/feishu-smoke/bot-added-callback.json --bot-added-payload-evidence runtime-output/feishu-smoke/bot-added-payload-evidence.json --json",
  }];
}
export function isSafeFeishuBotAddedReference(value: unknown, prefix: "chat" | "event"): value is string {
  return typeof value === "string" && new RegExp(`^${prefix} [a-f0-9]{16}$`).test(value);
}
export function isFeishuOpenApiSmokeStepNamed(value: unknown, name: string): value is Record<string, unknown> {
  return isFeishuOpenApiSmokeStep(value) && value.name === name;
}
export function isFeishuOpenApiSmokeStep(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && typeof value.name === "string";
}
export function hasFeishuOpenApiSmokeRequestSummary(
  step: Record<string, unknown>,
): step is Record<string, unknown> & { request: { method: string; path: string } } {
  if (!isRecord(step.request)) {
    return false;
  }
  return typeof step.request.method === "string" &&
    typeof step.request.path === "string" &&
    step.request.path.trim().length > 0;
}
export function isRedactedFeishuOpenApiSmokeRequestPath(path: string): boolean {
  if (!path.startsWith("/open-apis/")) {
    return false;
  }
  if (path.startsWith("/open-apis/docx/v1/documents/")) {
    return [
      "/open-apis/docx/v1/documents/:doc_token/blocks",
      "/open-apis/docx/v1/documents/:doc_token/blocks/:parent_block_id/children",
    ].includes(path);
  }
  if (path.startsWith("/open-apis/sheets/v2/spreadsheets/")) {
    return [
      "/open-apis/sheets/v2/spreadsheets/:sheet_token/metainfo",
      "/open-apis/sheets/v2/spreadsheets/:sheet_token/values",
      "/open-apis/sheets/v2/spreadsheets/:sheet_token/values/:range",
    ].includes(path);
  }
  if (path.startsWith("/open-apis/bitable/v1/apps/")) {
    return [
      "/open-apis/bitable/v1/apps/:app_token/tables",
      "/open-apis/bitable/v1/apps/:app_token/tables/:table_id/records",
      "/open-apis/bitable/v1/apps/:app_token/tables/:table_id/records/:record_id",
    ].includes(path);
  }
  return true;
}
export function containsFeishuSecretLikeEvidence(serialized: string): boolean {
  return [
    /\bBearer\s+[A-Za-z0-9._-]{8,}/i,
    /\b(?:tenant_access_token|tenantAccessToken|app_secret|appSecret|verification_token|verificationToken|encrypt_key|encryptKey)\b\s*[:=]\s*["']?[A-Za-z0-9._-]{4,}/i,
  ].some((pattern) => pattern.test(serialized));
}
export function containsRawFeishuOpenApiEvidenceIdentifier(serialized: string): boolean {
  return [
    /\b(?:doccn|doxcn|shtcn|bascn)[A-Za-z0-9_-]{4,}\b/i,
    /\b(?:tbl|vew)[A-Za-z0-9_-]{4,}\b/i,
    /\brec(?!eive|ord)[A-Za-z0-9_-]{4,}\b/i,
    /\b(?:oc|ou|om|on)_[A-Za-z0-9_-]{4,}\b/i,
    /\b[\p{L}\p{N}_. -]{1,80}![A-Z]{1,3}\d+(?::[A-Z]{1,3}\d+)?\b/u,
  ].some((pattern) => pattern.test(serialized));
}
export function containsDofeAgentCallbackUrlOpenApiEvidence(serialized: string): boolean {
  return /https?:\/\/[^"'\s<>]+\/api\/integrations\/feishu\/events(?:\?[^"'\s<>]*)?/i.test(serialized);
}
export function buildFeishuExpectedCallbackRouteProof(input: {
  workspaceId: string;
  integrationId: string;
}): FeishuExpectedCallbackRouteProof {
  const routeKey = `/api/integrations/feishu/events?workspaceId=${input.workspaceId}&integrationId=${input.integrationId}`;
  return {
    integrationId: input.integrationId,
    callbackRoute: "/api/integrations/feishu/events",
    callbackRouteFingerprint: `sha256:${createHash("sha256").update(routeKey, "utf8").digest("hex").slice(0, 16)}`,
  };
}
export function buildFeishuExpectedEvidenceCallbackRouteProofs(input: {
  workspaceId: string;
  requiredEvidence: FeishuEvidenceRequirement;
  scopedIntegrationId?: string;
  anchorIntegrationIds?: ReadonlySet<string>;
}): FeishuExpectedCallbackRouteProof[] | undefined {
  if (input.scopedIntegrationId) {
    return [buildFeishuExpectedCallbackRouteProof({
      workspaceId: input.workspaceId,
      integrationId: input.scopedIntegrationId,
    })];
  }
  if (input.requiredEvidence !== "all") {
    return undefined;
  }
  return [...(input.anchorIntegrationIds ?? [])]
    .sort()
    .map((integrationId) => buildFeishuExpectedCallbackRouteProof({
      workspaceId: input.workspaceId,
      integrationId,
    }));
}
export function buildFeishuExpectedBotAddedPayloadIdentityProofs(
  integrations: readonly ExternalIntegrationRecord[],
  input: {
    integrationId?: string;
    integrationIds?: ReadonlySet<string>;
  },
): FeishuExpectedBotAddedPayloadIdentityProof[] {
  const proofs: FeishuExpectedBotAddedPayloadIdentityProof[] = [];
  for (const integration of integrations) {
    if (input.integrationId && integration.id !== input.integrationId) {
      continue;
    }
    if (input.integrationIds && !input.integrationIds.has(integration.id)) {
      continue;
    }
    if (integration.status !== "active") {
      continue;
    }
    if (!hasNonEmptyString(integration.appId)) {
      continue;
    }
    proofs.push({
      integrationId: integration.id,
      appIdHash: sha256FeishuEvidenceText(integration.appId.trim()),
      ...(hasNonEmptyString(integration.tenantKey)
        ? { tenantKeyHash: sha256FeishuEvidenceText(integration.tenantKey.trim()) }
        : {}),
    });
  }
  return proofs;
}
export function buildFeishuExpectedEvidenceArtifactIntegrationIds(input: {
  requiredEvidence: FeishuEvidenceRequirement;
  scopedIntegrationId?: string;
  evidenceItems: readonly FeishuIntegrationEvidence[];
  evidenceSources: readonly FeishuIntegrationEvidenceSource[];
}): ReadonlySet<string> | undefined {
  if (input.scopedIntegrationId) {
    return new Set([input.scopedIntegrationId]);
  }
  if (input.requiredEvidence !== "all") {
    return undefined;
  }
  const activeSources = input.evidenceSources.filter((source) => source.integration.status === "active");
  return new Set(input.evidenceItems
    .filter((item) =>
      isFeishuEvidenceSatisfiedExceptNative(item) &&
      hasFeishuWorkspaceNativeExperienceEvidence(activeSources, {
        requiredIntegrationId: item.id,
      })
    )
    .map((item) => item.id));
}
export function buildFeishuExpectedBotAddedPayloadChatReferences(input: {
  requiredEvidence: FeishuEvidenceRequirement;
  scopedIntegrationId?: string;
  evidenceSources: readonly FeishuIntegrationEvidenceSource[];
  anchorIntegrationIds?: ReadonlySet<string>;
}): readonly FeishuExpectedBotAddedPayloadChatReferenceProof[] | undefined {
  if (input.requiredEvidence !== "all") {
    return undefined;
  }
  const activeSources = input.evidenceSources.filter((source) => source.integration.status === "active");
  const integrationIds = input.scopedIntegrationId
    ? [input.scopedIntegrationId]
    : [...(input.anchorIntegrationIds ?? [])].sort();
  return integrationIds.flatMap((integrationId) =>
    listFeishuWorkspaceNativeExperienceChatReferences(activeSources, {
      requiredIntegrationId: integrationId,
      allowedIntegrationIds: input.anchorIntegrationIds,
    }).map((chatReference) => ({
      integrationId,
      chatReference,
    }))
  );
}
export function buildFeishuExpectedTodo120NativeSecondAgentAppProofs(input: {
  requiredEvidence: FeishuEvidenceRequirement;
  scopedIntegrationId?: string;
  evidenceSources: readonly FeishuIntegrationEvidenceSource[];
  anchorIntegrationIds?: ReadonlySet<string>;
}): readonly FeishuExpectedTodo120NativeSecondAgentAppProof[] | undefined {
  if (input.requiredEvidence !== "all") {
    return undefined;
  }
  const activeSources = input.evidenceSources.filter((source) => source.integration.status === "active");
  const activeSourcesById = new Map(activeSources.map((source) => [source.integration.id, source]));
  const anchorIntegrationIds = input.scopedIntegrationId
    ? [input.scopedIntegrationId]
    : [...(input.anchorIntegrationIds ?? [])].sort();
  const proofs: FeishuExpectedTodo120NativeSecondAgentAppProof[] = [];
  for (const anchorIntegrationId of anchorIntegrationIds) {
    const anchor = activeSourcesById.get(anchorIntegrationId)?.integration;
    if (!anchor || !hasNonEmptyString(anchor.appId) || !hasNonEmptyString(anchor.agentId)) {
      continue;
    }
    const chatReferences = listFeishuWorkspaceNativeExperienceChatReferences(activeSources, {
      requiredIntegrationId: anchorIntegrationId,
      allowedIntegrationIds: input.anchorIntegrationIds,
    });
    for (const chatReference of chatReferences) {
      const scopedIntegrationIds = listFeishuIntegrationIdsForSafeChatReference(activeSources, chatReference);
      for (const secondIntegrationId of scopedIntegrationIds) {
        if (secondIntegrationId === anchorIntegrationId) {
          continue;
        }
        const second = activeSourcesById.get(secondIntegrationId)?.integration;
        if (
          !second ||
          !hasNonEmptyString(second.appId) ||
          !hasNonEmptyString(second.agentId) ||
          second.appId.trim() === anchor.appId.trim() ||
          second.agentId.trim() === anchor.agentId.trim()
        ) {
          continue;
        }
        proofs.push({
          anchorIntegrationId,
          secondIntegrationId,
          appIdHash: sha256FeishuEvidenceText(second.appId.trim()),
        });
      }
    }
  }
  const seen = new Set<string>();
  return proofs.filter((proof) => {
    const key = `${proof.anchorIntegrationId}:${proof.secondIntegrationId}:${proof.appIdHash}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
export function sha256FeishuEvidenceText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
export function hasValidFeishuCallbackRouteProof(step: unknown): boolean {
  if (!isRecord(step)) {
    return false;
  }
  return step.callbackRoute === "/api/integrations/feishu/events" &&
    typeof step.callbackRouteFingerprint === "string" &&
    /^sha256:[a-f0-9]{16}$/.test(step.callbackRouteFingerprint);
}
export function matchesFeishuCallbackRouteProof(
  step: unknown,
  expected: FeishuExpectedCallbackRouteProof,
): boolean {
  if (!isRecord(step)) {
    return false;
  }
  return step.callbackRoute === expected.callbackRoute &&
    step.callbackRouteFingerprint === expected.callbackRouteFingerprint;
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
export function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
export function readFeishuSmokeEvidenceGeneratedAtState(value: unknown): {
  present: boolean;
  valid: boolean;
  fresh: boolean;
} {
  if (typeof value !== "string" || !value.trim()) {
    return { present: false, valid: false, fresh: false };
  }
  const generatedAtMs = Date.parse(value);
  if (!Number.isFinite(generatedAtMs)) {
    return { present: true, valid: false, fresh: false };
  }
  const now = Date.now();
  if (generatedAtMs - now > FEISHU_SMOKE_EVIDENCE_MAX_FUTURE_SKEW_MS) {
    return { present: true, valid: false, fresh: false };
  }
  return {
    present: true,
    valid: true,
    fresh: now - generatedAtMs <= FEISHU_SMOKE_EVIDENCE_MAX_AGE_MS,
  };
}
export function hasFreshFeishuEvidenceTimestamp(...values: readonly unknown[]): boolean {
  return values.some((value) => {
    const state = readFeishuSmokeEvidenceGeneratedAtState(value);
    return state.valid && state.fresh;
  });
}
export function hasFreshFeishuIntegrationEventEvidence(event: ExternalIntegrationEventRecord): boolean {
  return hasFreshFeishuEvidenceTimestamp(event.processedAt, event.receivedAt);
}
export interface FeishuWorkspaceEvidenceSatisfaction {
  botSatisfied: boolean;
  nativeExperienceSatisfied: boolean;
  guestPolicySatisfied: boolean;
  dataPlaneSatisfied: boolean;
  workerSatisfied: boolean;
  failureVisibilitySatisfied: boolean;
  allSatisfied: boolean;
}
export function buildFeishuWorkspaceEvidenceSatisfaction(
  items: readonly FeishuIntegrationEvidence[],
  sources: readonly FeishuIntegrationEvidenceSource[],
  options: {
    requiredNativeIntegrationId?: string;
  } = {},
): FeishuWorkspaceEvidenceSatisfaction {
  const activeSources = sources.filter((source) => source.integration.status === "active");
  const activeIntegrationIds = new Set(activeSources.map((source) => source.integration.id));
  const activeItems = items.filter((item) => activeIntegrationIds.has(item.id));
  const botSatisfied = activeItems.some((item) => item.bot.satisfied);
  const nativeExperienceSatisfied = hasFeishuWorkspaceNativeExperienceEvidence(activeSources, {
    requiredIntegrationId: options.requiredNativeIntegrationId,
  });
  const guestPolicySatisfied = sumFeishuEvidenceCounts(activeItems, (item) =>
    item.guestPolicy.externalGuestAllowedEvidence
  ) > 0 &&
    sumFeishuEvidenceCounts(activeItems, (item) => item.guestPolicy.externalGuestReplyAllEvidence) > 0 &&
    sumFeishuEvidenceCounts(activeItems, (item) => item.guestPolicy.externalGuestRequireIdentityEvidence) > 0 &&
    sumFeishuEvidenceCounts(activeItems, (item) =>
      item.guestPolicy.externalGuestIdentityBindingNoticeEvidence
    ) > 0 &&
    sumFeishuEvidenceCounts(activeItems, (item) => item.guestPolicy.externalGuestIgnoreEvidence) > 0 &&
    sumFeishuEvidenceCounts(activeItems, (item) => item.guestPolicy.externalGuestMentionRequiredEvidence) > 0;
  const dataPlaneSatisfied = sumFeishuEvidenceCounts(activeItems, (item) => item.dataPlane.docReadSucceeded) > 0 &&
    sumFeishuEvidenceCounts(activeItems, (item) => item.dataPlane.agentDocReadSucceeded) > 0 &&
    sumFeishuEvidenceCounts(activeItems, (item) => item.dataPlane.docApprovedWritesSucceeded) > 0 &&
    sumFeishuEvidenceCounts(activeItems, (item) => item.dataPlane.sheetReadSucceeded) > 0 &&
    sumFeishuEvidenceCounts(activeItems, (item) => item.dataPlane.sheetApprovedWriteSyncSucceeded) > 0 &&
    sumFeishuEvidenceCounts(activeItems, (item) => item.dataPlane.baseReadSucceeded) > 0 &&
    sumFeishuEvidenceCounts(activeItems, (item) => item.dataPlane.baseApprovedMutationSyncSucceeded) > 0 &&
    sumFeishuEvidenceCounts(activeItems, (item) => item.dataPlane.userActorEvidence) > 0 &&
    sumFeishuEvidenceCounts(activeItems, (item) => item.dataPlane.externalGuestActorEvidence) > 0 &&
    sumFeishuEvidenceCounts(activeItems, (item) => item.dataPlane.externalGuestReadSucceeded) > 0 &&
    sumFeishuEvidenceCounts(activeItems, (item) => item.dataPlane.externalGuestWriteDeniedEvidence) > 0;
  const hasWebSocketWorkerIntegration = activeItems.some((item) => item.transportMode === "websocket_worker");
  const workerSatisfied = activeItems.length > 0 &&
    (hasWebSocketWorkerIntegration
      ? activeItems.some((item) => item.worker.satisfied)
      : true);
  const failureVisibilitySatisfied = activeItems.some((item) => item.failureVisibility.satisfied);
  const allSatisfied = activeItems.some((item) =>
    isFeishuEvidenceSatisfiedExceptNative(item) &&
    hasFeishuWorkspaceNativeExperienceEvidence(activeSources, {
      requiredIntegrationId: item.id,
    })
  );
  return {
    botSatisfied,
    nativeExperienceSatisfied,
    guestPolicySatisfied,
    dataPlaneSatisfied,
    workerSatisfied,
    failureVisibilitySatisfied,
    allSatisfied,
  };
}
export function hasFeishuWorkspaceNativeExperienceEvidence(
  sources: readonly FeishuIntegrationEvidenceSource[],
  options: {
    requiredIntegrationId?: string;
    allowedIntegrationIds?: ReadonlySet<string>;
  } = {},
): boolean {
  return listFeishuWorkspaceNativeExperienceChatReferences(sources, options).length > 0;
}
export function listFeishuWorkspaceNativeExperienceChatReferences(
  sources: readonly FeishuIntegrationEvidenceSource[],
  options: {
    requiredIntegrationId?: string;
    allowedIntegrationIds?: ReadonlySet<string>;
  } = {},
): string[] {
  const messageMappings = sources.flatMap((source) => source.messageMappings);
  const outbox = sources.flatMap((source) => source.outbox);
  const channelBindings = sources.flatMap((source) => source.channelBindings);
  const threadBindings = sources.flatMap((source) => source.threadBindings);
  const chatReferences = uniqueStrings([
    ...messageMappings.map((mapping) => readFeishuSafeChatReference(mapping.metadataJson)),
    ...outbox.map((item) => readFeishuSafeChatReference(item.metadataJson)),
    ...channelBindings.map((binding) => readFeishuSafeChatReference(binding.metadataJson)),
    ...threadBindings.map((binding) => readFeishuSafeChatReference(binding.metadataJson)),
  ].filter(hasNonEmptyString));

  return chatReferences.filter((chatReference) => {
    const scopedMappings = messageMappings.filter((mapping) =>
      readFeishuSafeChatReference(mapping.metadataJson) === chatReference
    );
    const scopedChannelBindings = channelBindings.filter((binding) =>
      readFeishuSafeChatReference(binding.metadataJson) === chatReference
    );
    const scopedOutbox = outbox.filter((item) =>
      readFeishuSafeChatReference(item.metadataJson) === chatReference
    );
    const scopedThreadBindings = threadBindings.filter((binding) =>
      readFeishuSafeChatReference(binding.metadataJson) === chatReference
    );
    const scopedIntegrationIds = new Set([
      ...scopedMappings.map((mapping) => mapping.integrationId),
      ...scopedOutbox.map((item) => item.integrationId),
      ...scopedChannelBindings.map((binding) => binding.integrationId),
      ...scopedThreadBindings.map((binding) => binding.integrationId),
    ].filter(hasNonEmptyString));
    if (options.requiredIntegrationId && !scopedIntegrationIds.has(options.requiredIntegrationId)) {
      return false;
    }
    if (
      options.allowedIntegrationIds &&
      ![...scopedIntegrationIds].some((integrationId) => options.allowedIntegrationIds?.has(integrationId))
    ) {
      return false;
    }
    if (!hasDistinctActiveFeishuAgentBotBindingsInScope(sources, scopedIntegrationIds)) {
      return false;
    }

    return countFeishuAgentBotRouteEvidence(scopedMappings) > 0 &&
      countFeishuNativeBotReplyEvidence(scopedMappings) > 0 &&
      countFeishuNativeActorMentionEvidence(scopedMappings, "user") > 0 &&
      countFeishuNativeActorMentionEvidence(scopedMappings, "external_guest") > 0 &&
      countFeishuAgentChannelPolicyDeniedEvidence(scopedMappings) > 0 &&
      countFeishuBotSenderLoopGuardEvidence(scopedMappings) > 0 &&
      countFeishuAutoProvisionedChannelBindings(scopedChannelBindings) > 0 &&
      countFeishuAutoProvisionedChannelBindings(scopedChannelBindings, "bot_added") > 0 &&
      countFeishuAutoProvisionedChannelBindings(scopedChannelBindings, "first_message") > 0 &&
      countFeishuReusedProviderChannelBindings(scopedChannelBindings) > 0 &&
      countFeishuThreadTaskBindingEvidence(scopedThreadBindings) > 0 &&
      countFeishuThreadContinuationEvidence(scopedMappings, scopedThreadBindings) > 0 &&
      countFeishuThreadCollaborationEvidence(scopedThreadBindings) > 0 &&
      countFeishuThreadCollaborationCardEvidence(scopedOutbox, scopedThreadBindings) > 0;
  });
}
export function listFeishuIntegrationIdsForSafeChatReference(
  sources: readonly FeishuIntegrationEvidenceSource[],
  chatReference: string,
): string[] {
  const matchingIds = sources.flatMap((source) => [
    ...source.messageMappings
      .filter((mapping) => readFeishuSafeChatReference(mapping.metadataJson) === chatReference)
      .map((mapping) => mapping.integrationId),
    ...source.outbox
      .filter((item) => readFeishuSafeChatReference(item.metadataJson) === chatReference)
      .map((item) => item.integrationId),
    ...source.channelBindings
      .filter((binding) => readFeishuSafeChatReference(binding.metadataJson) === chatReference)
      .map((binding) => binding.integrationId),
    ...source.threadBindings
      .filter((binding) => readFeishuSafeChatReference(binding.metadataJson) === chatReference)
      .map((binding) => binding.integrationId),
  ]);
  return uniqueStrings(matchingIds.filter(hasNonEmptyString)).sort();
}
export function doFeishuSafeReferencesMatch(left: unknown, right: unknown): boolean {
  const leftHash = readFeishuSafeReferenceComparableHash(left);
  const rightHash = readFeishuSafeReferenceComparableHash(right);
  if (!leftHash || !rightHash) {
    return false;
  }
  return leftHash === rightHash ||
    (leftHash.length >= rightHash.length && rightHash.length >= 8 && leftHash.startsWith(rightHash)) ||
    (rightHash.length >= leftHash.length && leftHash.length >= 8 && rightHash.startsWith(leftHash));
}
export function readFeishuSafeReferenceComparableHash(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  const prefixed = /^(?:chat|event)[ :]([a-f0-9]{8,64})$/.exec(normalized);
  if (prefixed) {
    return prefixed[1];
  }
  const ref = /^ref_([a-f0-9]{8,64})$/.exec(normalized);
  if (ref) {
    return ref[1];
  }
  return /^[a-f0-9]{8,64}$/.test(normalized) ? normalized : undefined;
}
export interface FeishuAgentBotBindingIdentity {
  integrationId: string;
  agentId: string;
  appId: string;
  tenantKey?: string;
}
export function hasDistinctActiveFeishuAgentBotBindingsInScope(
  sources: readonly FeishuIntegrationEvidenceSource[],
  scopedIntegrationIds: ReadonlySet<string>,
): boolean {
  const identities = sources.flatMap((source): FeishuAgentBotBindingIdentity[] => {
    const integration = source.integration;
    if (
      !scopedIntegrationIds.has(integration.id) ||
      integration.status !== "active" ||
      integration.provider !== FEISHU_PROVIDER_ID ||
      !hasNonEmptyString(integration.agentId) ||
      !hasNonEmptyString(integration.appId)
    ) {
      return [];
    }
    return [{
      integrationId: integration.id.trim(),
      agentId: integration.agentId.trim(),
      appId: integration.appId.trim(),
      ...(hasNonEmptyString(integration.tenantKey) ? { tenantKey: integration.tenantKey.trim() } : {}),
    }];
  });
  const activeIntegrationIds = new Set(identities.map((identity) => identity.integrationId));
  const distinctAgentIds = new Set(identities.map((identity) => identity.agentId));
  const distinctAppIds = new Set(identities.map((identity) => identity.appId));
  const explicitTenantKeys = new Set(identities.map((identity) => identity.tenantKey).filter(hasNonEmptyString));
  return activeIntegrationIds.size >= 2 &&
    distinctAgentIds.size >= 2 &&
    distinctAppIds.size >= 2 &&
    explicitTenantKeys.size <= 1;
}
export function readFeishuSafeChatReference(metadataJson: string): string | undefined {
  const metadata = readJsonRecord(metadataJson);
  return hasNonEmptyString(metadata?.externalChatReference) ? metadata.externalChatReference.trim() : undefined;
}
export function sumFeishuEvidenceCounts(
  items: readonly FeishuIntegrationEvidence[],
  select: (item: FeishuIntegrationEvidence) => number,
): number {
  return items.reduce((total, item) => total + select(item), 0);
}
export function isFeishuEvidenceReportStrictSatisfied(input: {
  requiredEvidence: FeishuEvidenceRequirement;
  evidenceItems: readonly FeishuIntegrationEvidence[];
  workspaceEvidence: FeishuWorkspaceEvidenceSatisfaction;
  scopedIntegrationId?: string;
}): boolean {
  if (input.evidenceItems.length === 0) {
    return false;
  }
  if (input.requiredEvidence === "native") {
    return input.workspaceEvidence.nativeExperienceSatisfied;
  }
  if (input.requiredEvidence === "all") {
    return buildFeishuScopedAllEvidenceSatisfied(input);
  }
  return input.evidenceItems.some((item) => isFeishuEvidenceSatisfied(item, input.requiredEvidence));
}
export function buildFeishuScopedAllEvidenceSatisfied(input: {
  evidenceItems: readonly FeishuIntegrationEvidence[];
  workspaceEvidence: FeishuWorkspaceEvidenceSatisfaction;
  scopedIntegrationId?: string;
}): boolean {
  if (input.scopedIntegrationId) {
    return input.workspaceEvidence.nativeExperienceSatisfied &&
      input.evidenceItems.some((item) => isFeishuEvidenceSatisfiedExceptNative(item));
  }
  return input.workspaceEvidence.allSatisfied;
}
export function isFeishuEvidenceSatisfiedExceptNative(item: FeishuIntegrationEvidence): boolean {
  return item.bot.satisfied &&
    item.guestPolicy.satisfied &&
    item.dataPlane.satisfied &&
    item.failureVisibility.satisfied &&
    (item.transportMode !== "websocket_worker" || item.worker.satisfied);
}
export function isFeishuEvidenceSatisfied(
  item: FeishuIntegrationEvidence,
  requiredEvidence: FeishuEvidenceRequirement,
): boolean {
  if (requiredEvidence === "native") {
    return item.nativeExperience.satisfied;
  }
  if (requiredEvidence === "guest-policy") {
    return item.guestPolicy.satisfied;
  }
  if (requiredEvidence === "data-plane") {
    return item.dataPlane.satisfied;
  }
  if (requiredEvidence === "worker") {
    return item.worker.satisfied;
  }
  if (requiredEvidence === "failure") {
    return item.failureVisibility.satisfied;
  }
  if (requiredEvidence === "all") {
    return item.bot.satisfied &&
      item.nativeExperience.satisfied &&
      item.guestPolicy.satisfied &&
      item.dataPlane.satisfied &&
      item.failureVisibility.satisfied &&
      (item.transportMode !== "websocket_worker" || item.worker.satisfied);
  }
  return item.bot.satisfied;
}
