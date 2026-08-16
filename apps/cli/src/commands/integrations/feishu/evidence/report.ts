// 从 feishu/evidence.ts 拆出（3.6-3 补充），域：report。
import { listExternalChannelBindingsSync, listExternalDataOperationRunsSync, listExternalIntegrationEventsSync, listExternalIntegrationsSync, listExternalMessageMappingsSync, listExternalMessageOutboxSync, listExternalThreadBindingsSync } from "@dofe-agent/db";
import { FEISHU_PROVIDER_ID } from "@dofe-agent/services";
import { uniqueStrings } from "../cli-shared.ts";
import { FEISHU_CLI_PLACEHOLDERS, FEISHU_SMOKE_EVIDENCE_MAX_AGE_MS } from "../types.ts";
import type { BuildFeishuEvidenceReportInput, FeishuBotAddedPayloadEvidenceVerification, FeishuEvidenceRemediationStep, FeishuEvidenceReport, FeishuIntegrationEvidence, FeishuIntegrationEvidenceSource, FeishuLocalEvidenceFreshnessSummary, FeishuOpenApiSmokeEvidenceVerification } from "../types.ts";
import { buildFeishuIntegrationEvidence, hasNonEmptyString } from "./core.ts";
import { verifyFeishuOpenApiSmokeEvidence, buildFeishuOpenApiEvidenceRemediationSteps, verifyFeishuBotAddedPayloadEvidence, buildFeishuBotAddedPayloadEvidenceRemediationSteps } from "./smoke.ts";
import { buildFeishuExpectedEvidenceCallbackRouteProofs, buildFeishuExpectedBotAddedPayloadIdentityProofs, buildFeishuExpectedEvidenceArtifactIntegrationIds, buildFeishuExpectedBotAddedPayloadChatReferences, buildFeishuExpectedTodo120NativeSecondAgentAppProofs, hasFreshFeishuEvidenceTimestamp, hasFreshFeishuIntegrationEventEvidence } from "./proofs.ts";
import { buildFeishuWorkspaceEvidenceSatisfaction, sumFeishuEvidenceCounts, isFeishuEvidenceReportStrictSatisfied, buildFeishuScopedAllEvidenceSatisfied } from "./satisfaction.ts";

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
