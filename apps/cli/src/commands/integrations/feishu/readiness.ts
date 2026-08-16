// 从 commands/integrations/feishu.ts 拆出（3.6-3），由原文件 barrel 再导出。

import {
  listExternalChannelBindingsSync,
  listExternalIntegrationsSync,
  listExternalMessageOutboxSync,
  listExternalResourceBindingsSync,
  listExternalUserBindingsSync,
  updateExternalIntegrationHealthSync,
  type ExternalChannelBindingRecord,
  type ExternalIntegrationRecord,
  type ExternalMessageOutboxRecord,
  type ExternalResourceBindingRecord,
  type ExternalUserBindingRecord
} from "@dofe-agent/db";
import {
  checkFeishuIntegrationHealth,
  buildFeishuHealthSnapshotConfigJson,
  FEISHU_BOT_SMOKE_SCOPES,
  FEISHU_DATA_PLANE_SMOKE_SCOPES,
  FEISHU_EVENT_CALLBACK_PATH,
  FEISHU_PROVIDER_ID,
  readFeishuIntegrationCredentials,
  summarizeFeishuStoredCredentials,
  type FeishuHealthCheckResult
} from "@dofe-agent/services";
import { isFeishuCliPlaceholderValue, uniqueStrings } from "./cli-shared.ts";
import { hasNonEmptyString } from "./evidence.ts";
import type { BuildFeishuReadinessReportInput, FeishuHealthCheckCliItem, FeishuHealthCheckCliReport, FeishuIntegrationReadiness, FeishuReadinessReport, FeishuReadinessSetupCheck, FeishuRequiredReadiness, FeishuSmokePlanStep } from "./types.ts";

export function buildFeishuReadinessReport(input: BuildFeishuReadinessReportInput): FeishuReadinessReport {
  const requiredReadiness = input.requiredReadiness ?? "bot";
  const integrations = (input.integrations ?? listExternalIntegrationsSync({
    workspaceId: input.workspaceId,
    provider: FEISHU_PROVIDER_ID,
    includeDisabled: true,
  })).filter((integration) =>
    (!input.integrationId || integration.id === input.integrationId) &&
    (!input.agentId || integration.agentId === input.agentId) &&
    (!input.agentOnly || Boolean(integration.agentId))
  );

  const readinessItems = integrations.map((integration) => {
    const channelBindings = input.channelBindingsByIntegrationId?.[integration.id]
      ?? listExternalChannelBindingsSync({ workspaceId: input.workspaceId, integrationId: integration.id });
    const userBindings = input.userBindingsByIntegrationId?.[integration.id]
      ?? listExternalUserBindingsSync({ workspaceId: input.workspaceId, integrationId: integration.id });
    const resourceBindings = input.resourceBindingsByIntegrationId?.[integration.id]
      ?? listExternalResourceBindingsSync({ workspaceId: input.workspaceId, integrationId: integration.id });
    const failedOutbox = input.failedOutboxByIntegrationId?.[integration.id]
      ?? listExternalMessageOutboxSync({
        workspaceId: input.workspaceId,
        integrationId: integration.id,
        status: "failed",
        limit: 20,
      });
    const pendingOutbox = input.pendingOutboxByIntegrationId?.[integration.id]
      ?? listExternalMessageOutboxSync({
        workspaceId: input.workspaceId,
        integrationId: integration.id,
        status: "pending",
        limit: 20,
      }).filter((item) => Boolean(item.lastError));
    return buildFeishuIntegrationReadiness({
      integration,
      channelBindings,
      userBindings,
      resourceBindings,
      failedOutbox,
      pendingOutbox,
    });
  });

  return {
    workspaceId: input.workspaceId,
    requiredReadiness,
    integrationCount: readinessItems.length,
    readyForBotSmokeCount: readinessItems.filter((item) => item.readyForBotSmoke).length,
    readyForDataPlaneSmokeCount: readinessItems.filter((item) => item.readyForDataPlaneSmoke).length,
    readyForWorkerSmokeCount: readinessItems.filter((item) => item.readyForWorkerSmoke).length,
    strictSatisfied: readinessItems.some((item) => isFeishuReadinessSatisfied(item, requiredReadiness)),
    integrations: readinessItems,
  };
}
export async function runFeishuHealthCheckCli(input: {
  workspaceId: string;
  integrationId?: string;
  agentId?: string;
  agentOnly?: boolean;
  baseUrl?: string;
  persist?: boolean;
  integrations?: ExternalIntegrationRecord[];
  healthChecker?: (input: {
    appId: string;
    appSecret: string;
    baseUrl?: string;
  }) => Promise<FeishuHealthCheckResult>;
  readCredentials?: typeof readFeishuIntegrationCredentials;
  updateHealth?: typeof updateExternalIntegrationHealthSync;
}): Promise<FeishuHealthCheckCliReport> {
  const integrations = (input.integrations ?? listExternalIntegrationsSync({
    workspaceId: input.workspaceId,
    provider: FEISHU_PROVIDER_ID,
    includeDisabled: true,
  })).filter((integration) =>
    (!input.integrationId || integration.id === input.integrationId) &&
    (!input.agentId || integration.agentId === input.agentId) &&
    (!input.agentOnly || Boolean(integration.agentId))
  );
  const healthChecker = input.healthChecker ?? checkFeishuIntegrationHealth;
  const readCredentials = input.readCredentials ?? readFeishuIntegrationCredentials;
  const updateHealth = input.updateHealth ?? updateExternalIntegrationHealthSync;
  const persist = input.persist !== false;
  const results: FeishuHealthCheckCliItem[] = [];

  for (const integration of integrations) {
    const credentials = readCredentials(integration);
    const health = await healthChecker({
      appId: integration.appId ?? "",
      appSecret: credentials.appSecret,
      baseUrl: input.baseUrl,
    });
    const errorMessage = sanitizeFeishuCliHealthErrorMessage(health.errorMessage, [
      integration.appId,
      credentials.appSecret,
    ]);
    if (persist) {
      updateHealth({
        workspaceId: input.workspaceId,
        integrationId: integration.id,
        lastHealthStatus: health.status,
        lastError: errorMessage,
        configJson: buildFeishuHealthSnapshotConfigJson({
          configJson: integration.configJson,
          health,
        }),
      });
    }
    results.push(buildFeishuHealthCheckCliItem({
      integration,
      health,
      errorMessage,
      persisted: persist,
    }));
  }

  return {
    workspaceId: input.workspaceId,
    integrationId: input.integrationId,
    agentId: input.agentId,
    agentOnly: input.agentOnly,
    integrationCount: integrations.length,
    checkedCount: results.length,
    healthyCount: results.filter((item) => item.status === "healthy").length,
    degradedCount: results.filter((item) => item.status === "degraded").length,
    errorCount: results.filter((item) => item.status === "error").length,
    strictSatisfied: results.length > 0 && results.every((item) => item.status === "healthy"),
    persisted: persist,
    results,
  };
}
export function buildFeishuIntegrationReadiness(input: {
  integration: ExternalIntegrationRecord;
  channelBindings: ExternalChannelBindingRecord[];
  userBindings: ExternalUserBindingRecord[];
  resourceBindings: ExternalResourceBindingRecord[];
  failedOutbox: ExternalMessageOutboxRecord[];
  pendingOutbox: ExternalMessageOutboxRecord[];
}): FeishuIntegrationReadiness {
  const credentialSummary = summarizeFeishuStoredCredentials(input.integration);
  const activeChannelBindings = input.channelBindings.filter((binding) => binding.status === "active");
  const activeUserBindings = input.userBindings.filter((binding) => binding.status === "active");
  const activeResourceBindings = input.resourceBindings.filter((binding) => binding.status === "active");
  const docResourceCount = activeResourceBindings.filter((binding) => binding.providerResourceType === "doc").length;
  const docWritableResourceCount = activeResourceBindings.filter((binding) =>
    binding.providerResourceType === "doc" && isFeishuResourceBindingWriteEnabled(binding)
  ).length;
  const sheetResourceCount = activeResourceBindings.filter((binding) => binding.providerResourceType === "sheet").length;
  const sheetWritableResourceCount = activeResourceBindings.filter((binding) =>
    binding.providerResourceType === "sheet" && isFeishuResourceBindingWriteEnabled(binding)
  ).length;
  const baseResourceCount = activeResourceBindings.filter((binding) =>
    binding.providerResourceType === "base" ||
    binding.providerResourceType === "base_table" ||
    binding.providerResourceType === "base_view"
  ).length;
  const baseReadyResourceCount = activeResourceBindings.filter(isFeishuReadinessBaseBindingDataPlaneReady).length;
  const baseWritableResourceCount = activeResourceBindings.filter((binding) =>
    isFeishuReadinessBaseBindingDataPlaneReady(binding) && isFeishuResourceBindingWriteEnabled(binding)
  ).length;
  const availableScopes = readFeishuReadinessScopeList(input.integration.scopesJson);
  const missingBotScopes = findMissingFeishuReadinessScopes(availableScopes, FEISHU_BOT_SMOKE_SCOPES);
  const missingDataPlaneScopes = findMissingFeishuReadinessScopes(availableScopes, FEISHU_DATA_PLANE_SMOKE_SCOPES);
  const appConfigured = Boolean(input.integration.appId?.trim());
  const credentialsConfigured = credentialSummary.hasAppSecret &&
    (!doesFeishuReadinessRequireVerificationToken(input.integration) || credentialSummary.hasVerificationToken);
  const healthStatus = input.integration.lastHealthStatus ?? "unknown";
  const issues = buildFeishuReadinessIssues({
    integration: input.integration,
    appConfigured,
    credentialsConfigured,
    healthStatus,
    activeChannelBindingCount: activeChannelBindings.length,
    activeUserBindingCount: activeUserBindings.length,
    docResourceCount,
    docWritableResourceCount,
    sheetResourceCount,
    sheetWritableResourceCount,
    baseResourceCount,
    baseReadyResourceCount,
    baseWritableResourceCount,
    failedOutboxCount: input.failedOutbox.length,
    pendingOutboxWithErrorsCount: input.pendingOutbox.length,
    missingBotScopes,
    missingDataPlaneScopes,
  });
  const readyForBotSmoke = input.integration.status === "active" &&
    appConfigured &&
    credentialsConfigured &&
    activeChannelBindings.length > 0 &&
    activeUserBindings.length > 0 &&
    healthStatus !== "unknown" &&
    healthStatus !== "error" &&
    input.failedOutbox.length === 0 &&
    input.pendingOutbox.length === 0 &&
    missingBotScopes.length === 0;
  const readyForDataPlaneSmoke = readyForBotSmoke &&
    healthStatus === "healthy" &&
    docResourceCount > 0 &&
    docWritableResourceCount > 0 &&
    sheetResourceCount > 0 &&
    sheetWritableResourceCount > 0 &&
    baseReadyResourceCount > 0 &&
    baseWritableResourceCount > 0 &&
    missingDataPlaneScopes.length === 0;
  const readyForWorkerSmoke = readyForBotSmoke && input.integration.transportMode === "websocket_worker";
  const setupChecks = buildFeishuReadinessSetupChecks({
    integration: input.integration,
    appConfigured,
    hasAppSecret: credentialSummary.hasAppSecret,
    hasVerificationToken: credentialSummary.hasVerificationToken,
    hasEncryptKey: credentialSummary.hasEncryptKey,
    healthStatus,
    activeChannelBindingCount: activeChannelBindings.length,
    activeUserBindingCount: activeUserBindings.length,
    docResourceCount,
    docWritableResourceCount,
    sheetResourceCount,
    sheetWritableResourceCount,
    baseResourceCount,
    baseReadyResourceCount,
    baseWritableResourceCount,
    failedOutboxCount: input.failedOutbox.length,
    pendingOutboxWithErrorsCount: input.pendingOutbox.length,
  });

  return {
    id: input.integration.id,
    displayName: input.integration.displayName,
    agentId: input.integration.agentId,
    status: input.integration.status,
    transportMode: input.integration.transportMode,
    appConfigured,
    credentialsConfigured,
    healthStatus,
    channelBindings: {
      active: activeChannelBindings.length,
      total: input.channelBindings.length,
    },
    userBindings: {
      active: activeUserBindings.length,
      total: input.userBindings.length,
    },
    resourceBindings: {
      active: activeResourceBindings.length,
      total: input.resourceBindings.length,
      doc: docResourceCount,
      docWritable: docWritableResourceCount,
      sheet: sheetResourceCount,
      sheetWritable: sheetWritableResourceCount,
      base: baseResourceCount,
      baseReady: baseReadyResourceCount,
      baseWritable: baseWritableResourceCount,
    },
    outboxFailures: input.failedOutbox.length,
    pendingOutboxWithErrors: input.pendingOutbox.length,
    scopes: {
      configuredCount: availableScopes.length,
      missingForBotSmoke: missingBotScopes,
      missingForDataPlaneSmoke: missingDataPlaneScopes,
    },
    readyForBotSmoke,
    readyForDataPlaneSmoke,
    readyForWorkerSmoke,
    setupChecks,
    issues,
  };
}
export function buildFeishuReadinessSetupChecks(input: {
  integration: ExternalIntegrationRecord;
  appConfigured: boolean;
  hasAppSecret: boolean;
  hasVerificationToken: boolean;
  hasEncryptKey: boolean;
  healthStatus: string;
  activeChannelBindingCount: number;
  activeUserBindingCount: number;
  docResourceCount: number;
  docWritableResourceCount: number;
  sheetResourceCount: number;
  sheetWritableResourceCount: number;
  baseResourceCount: number;
  baseReadyResourceCount: number;
  baseWritableResourceCount: number;
  failedOutboxCount: number;
  pendingOutboxWithErrorsCount: number;
}): FeishuReadinessSetupCheck[] {
  const requiresVerificationToken = doesFeishuReadinessRequireVerificationToken(input.integration);
  const hasCoreCredentials = input.appConfigured &&
    input.hasAppSecret &&
    (!requiresVerificationToken || input.hasVerificationToken);
  const missingRecommendedEncryptKey = requiresVerificationToken && hasCoreCredentials && !input.hasEncryptKey;
  const credentialsIssues = [
    ...(!input.appConfigured ? ["app_id_missing"] : []),
    ...(!input.hasAppSecret ? ["app_secret_missing"] : []),
    ...(requiresVerificationToken && !input.hasVerificationToken ? ["verification_token_missing"] : []),
    ...(missingRecommendedEncryptKey ? ["encrypt_key_missing"] : []),
  ];
  const outboxIssueCount = input.failedOutboxCount + input.pendingOutboxWithErrorsCount;

  return [
    {
      key: "credentials",
      status: hasCoreCredentials
        ? missingRecommendedEncryptKey ? "attention" : "ready"
        : "missing",
      current: hasCoreCredentials && !missingRecommendedEncryptKey
        ? "complete"
        : missingRecommendedEncryptKey
          ? "missing_encrypt_key"
          : "incomplete",
      required: requiresVerificationToken
        ? "app_id/app_secret/verification_token"
        : "app_id/app_secret",
      issues: credentialsIssues,
    },
    {
      key: "health",
      status: input.healthStatus === "healthy"
        ? "ready"
        : input.healthStatus === "unknown"
          ? "missing"
          : "attention",
      current: input.healthStatus,
      required: "healthy",
      issues: input.healthStatus === "healthy"
        ? []
        : input.healthStatus === "unknown"
          ? ["health_not_checked"]
          : [`health_${input.healthStatus}`],
    },
    {
      key: "transport",
      status: input.integration.transportMode === "websocket_worker" || input.integration.transportMode === "http_webhook"
        ? "ready"
        : "missing",
      current: input.integration.transportMode,
      required: "http_webhook_or_websocket_worker",
      issues: input.integration.transportMode === "websocket_worker" || input.integration.transportMode === "http_webhook"
        ? []
        : ["transport_mode_invalid"],
    },
    buildCountReadinessSetupCheck("chat_binding", input.activeChannelBindingCount, "channel_binding_missing"),
    buildCountReadinessSetupCheck("user_binding", input.activeUserBindingCount, "user_binding_missing"),
    buildFeishuWritableReadinessSetupCheck(
      "doc_binding",
      input.docResourceCount,
      input.docWritableResourceCount,
      "doc_resource_binding_missing",
      "doc_resource_write_grant_missing",
    ),
    buildFeishuWritableReadinessSetupCheck(
      "sheet_binding",
      input.sheetResourceCount,
      input.sheetWritableResourceCount,
      "sheet_resource_binding_missing",
      "sheet_resource_write_grant_missing",
    ),
    buildFeishuBaseReadinessSetupCheck(input.baseResourceCount, input.baseReadyResourceCount, input.baseWritableResourceCount),
    {
      key: "outbox",
      status: outboxIssueCount === 0 ? "ready" : "attention",
      current: outboxIssueCount,
      required: 0,
      issues: [
        ...(input.failedOutboxCount > 0 ? ["outbox_failed_items"] : []),
        ...(input.pendingOutboxWithErrorsCount > 0 ? ["outbox_retry_errors"] : []),
      ],
    },
  ];
}
export function doesFeishuReadinessRequireVerificationToken(
  integration: Pick<ExternalIntegrationRecord, "transportMode">,
): boolean {
  return integration.transportMode === "http_webhook";
}
export function buildCountReadinessSetupCheck(
  key: Extract<
    FeishuReadinessSetupCheck["key"],
    "chat_binding" | "user_binding" | "doc_binding" | "sheet_binding" | "base_binding"
  >,
  count: number,
  issue: string,
): FeishuReadinessSetupCheck {
  return {
    key,
    status: count > 0 ? "ready" : "missing",
    current: count,
    required: 1,
    issues: count > 0 ? [] : [issue],
  };
}
export function buildFeishuBaseReadinessSetupCheck(
  baseResourceCount: number,
  baseReadyResourceCount: number,
  baseWritableResourceCount: number,
): FeishuReadinessSetupCheck {
  if (baseWritableResourceCount > 0) {
    return {
      key: "base_binding",
      status: "ready",
      current: baseWritableResourceCount,
      required: "1 writable data-plane-ready Base binding",
      issues: [],
    };
  }
  if (baseReadyResourceCount > 0) {
    return {
      key: "base_binding",
      status: "attention",
      current: `${baseWritableResourceCount}/${baseReadyResourceCount}`,
      required: "1 writable data-plane-ready Base binding",
      issues: ["base_resource_write_grant_missing"],
    };
  }
  if (baseResourceCount > 0) {
    return {
      key: "base_binding",
      status: "attention",
      current: `${baseReadyResourceCount}/${baseResourceCount}`,
      required: "1 data-plane-ready Base binding",
      issues: ["base_resource_app_token_missing"],
    };
  }
  return buildCountReadinessSetupCheck("base_binding", 0, "base_resource_binding_missing");
}
export function buildFeishuWritableReadinessSetupCheck(
  key: Extract<FeishuReadinessSetupCheck["key"], "doc_binding" | "sheet_binding">,
  resourceCount: number,
  writableResourceCount: number,
  missingIssue: string,
  writeIssue: string,
): FeishuReadinessSetupCheck {
  if (writableResourceCount > 0) {
    return {
      key,
      status: "ready",
      current: writableResourceCount,
      required: "1 writable binding",
      issues: [],
    };
  }
  if (resourceCount > 0) {
    return {
      key,
      status: "attention",
      current: `${writableResourceCount}/${resourceCount}`,
      required: "1 writable binding",
      issues: [writeIssue],
    };
  }
  return {
    key,
    status: "missing",
    current: 0,
    required: "1 writable binding",
    issues: [missingIssue],
  };
}
export function isFeishuReadinessBaseBindingDataPlaneReady(binding: ExternalResourceBindingRecord): boolean {
  const providerResourceType = binding.providerResourceType;
  if (providerResourceType === "base") {
    return Boolean(binding.providerResourceToken.trim());
  }
  if (providerResourceType !== "base_table" && providerResourceType !== "base_view") {
    return false;
  }
  const metadata = readFeishuReadinessBindingMetadata(binding.metadataJson);
  const appToken = readFeishuMetadataString(metadata, "appToken")
    ?? readFeishuMetadataString(metadata, "baseToken");
  const tableId = providerResourceType === "base_table"
    ? binding.providerResourceToken.trim()
    : readFeishuMetadataString(metadata, "tableId");
  return Boolean(appToken && tableId);
}
export function isFeishuResourceBindingWriteEnabled(binding: ExternalResourceBindingRecord): boolean {
  const permissions = readFeishuReadinessBindingMetadata(binding.permissionsJson);
  return permissions.canWrite === true || permissions.write === true;
}
export function readFeishuReadinessBindingMetadata(metadataJson: string | null | undefined): Record<string, unknown> {
  if (!metadataJson) {
    return {};
  }
  try {
    const parsed = JSON.parse(metadataJson) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}
export function readFeishuMetadataString(value: Record<string, unknown>, key: string): string | undefined {
  const candidate = value[key];
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : undefined;
}
export function buildFeishuReadinessIssues(input: {
  integration: ExternalIntegrationRecord;
  appConfigured: boolean;
  credentialsConfigured: boolean;
  healthStatus: string;
  activeChannelBindingCount: number;
  activeUserBindingCount: number;
  docResourceCount: number;
  docWritableResourceCount: number;
  sheetResourceCount: number;
  sheetWritableResourceCount: number;
  baseResourceCount: number;
  baseReadyResourceCount: number;
  baseWritableResourceCount: number;
  failedOutboxCount: number;
  pendingOutboxWithErrorsCount: number;
  missingBotScopes: string[];
  missingDataPlaneScopes: string[];
}): string[] {
  const issues: string[] = [];
  if (input.integration.status !== "active") {
    issues.push("integration_not_active");
  }
  if (!input.appConfigured) {
    issues.push("app_id_missing");
  }
  if (!input.credentialsConfigured) {
    issues.push("credentials_incomplete");
  }
  if (input.healthStatus === "unknown") {
    issues.push("health_not_checked");
  } else if (input.healthStatus !== "healthy") {
    issues.push(`health_${input.healthStatus}`);
  }
  if (input.activeChannelBindingCount === 0) {
    issues.push("channel_binding_missing");
  }
  if (input.activeUserBindingCount === 0) {
    issues.push("user_binding_missing");
  }
  if (input.missingBotScopes.length > 0) {
    issues.push("bot_scope_missing");
  }
  if (input.docResourceCount === 0) {
    issues.push("doc_resource_binding_missing");
  } else if (input.docWritableResourceCount === 0) {
    issues.push("doc_resource_write_grant_missing");
  }
  if (input.sheetResourceCount === 0) {
    issues.push("sheet_resource_binding_missing");
  } else if (input.sheetWritableResourceCount === 0) {
    issues.push("sheet_resource_write_grant_missing");
  }
  if (input.baseResourceCount === 0) {
    issues.push("base_resource_binding_missing");
  } else if (input.baseReadyResourceCount === 0) {
    issues.push("base_resource_app_token_missing");
  } else if (input.baseWritableResourceCount === 0) {
    issues.push("base_resource_write_grant_missing");
  }
  if (input.missingDataPlaneScopes.length > 0) {
    issues.push("data_plane_scope_missing");
  }
  if (input.failedOutboxCount > 0) {
    issues.push("outbox_failed_items");
  }
  if (input.pendingOutboxWithErrorsCount > 0) {
    issues.push("outbox_retry_errors");
  }
  return issues;
}
export function readFeishuReadinessScopeList(scopesJson: string | readonly string[] | null | undefined): string[] {
  if (Array.isArray(scopesJson)) {
    return normalizeFeishuReadinessScopeList(scopesJson);
  }
  if (typeof scopesJson !== "string") {
    return [];
  }
  try {
    const parsed = JSON.parse(scopesJson) as unknown;
    return Array.isArray(parsed) ? normalizeFeishuReadinessScopeList(parsed) : [];
  } catch {
    return normalizeFeishuReadinessScopeList(scopesJson.split(/\s+/));
  }
}
export function normalizeFeishuReadinessScopeList(scopes: readonly unknown[]): string[] {
  return Array.from(new Set(scopes
    .filter((scope): scope is string => typeof scope === "string")
    .map((scope) => scope.trim())
    .filter(Boolean)))
    .sort();
}
export function findMissingFeishuReadinessScopes(
  availableScopes: readonly string[],
  requiredScopes: readonly string[],
): string[] {
  if (availableScopes.includes("*")) {
    return [];
  }
  const available = new Set(availableScopes);
  return requiredScopes.filter((scope) => !available.has(scope));
}
export function buildFeishuCliEventCallbackUrl(input: {
  appUrl: string;
  workspaceId: string;
  integrationId: string;
}): string {
  const searchParams = new URLSearchParams({
    workspaceId: input.workspaceId,
    integrationId: input.integrationId,
  });
  return buildFeishuCliPublicUrl(`${FEISHU_EVENT_CALLBACK_PATH}?${searchParams.toString()}`, input.appUrl);
}
export function buildFeishuCliPublicUrl(path: string, appUrl: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return new URL(normalizedPath, appUrl.endsWith("/") ? appUrl : `${appUrl}/`).toString();
}
export function readFeishuCliPublicAppUrl(): string | undefined {
  return normalizeFeishuCliPublicAppUrl(
    process.env.DOFE_AGENT_APP_URL?.trim()
    || process.env.NEXT_PUBLIC_DOFE_AGENT_APP_URL?.trim()
    || process.env.NEXT_PUBLIC_APP_URL?.trim(),
  );
}
export function normalizeFeishuCliPublicAppUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (isFeishuCliPlaceholderValue(value)) {
    return undefined;
  }
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}
export function buildFeishuHealthCheckCliItem(input: {
  integration: ExternalIntegrationRecord;
  health: FeishuHealthCheckResult;
  errorMessage?: string;
  persisted: boolean;
}): FeishuHealthCheckCliItem {
  return {
    id: input.integration.id,
    displayName: input.integration.displayName,
    agentId: input.integration.agentId,
    status: input.health.status,
    previousHealthStatus: input.integration.lastHealthStatus,
    checkedAt: input.health.checkedAt,
    botAppName: input.health.botAppName,
    scopeReadiness: input.health.scopeReadiness,
    enabledScopeCount: input.health.enabledScopes?.length,
    missingScopes: input.health.missingScopes,
    errorCode: resolveFeishuHealthCliErrorCode(input.health),
    errorMessage: input.errorMessage,
    persisted: input.persisted,
  };
}
export function resolveFeishuHealthCliErrorCode(health: FeishuHealthCheckResult): string | undefined {
  if (health.status === "healthy") {
    return undefined;
  }
  if (health.scopeReadiness === "missing_required_scopes") {
    return "feishu.integration.scope_missing";
  }
  if (health.scopeReadiness === "unauthorized") {
    return "feishu.integration.scope_unauthorized";
  }
  if (health.scopeReadiness === "manual_review_required") {
    return "feishu.integration.scope_manual_review_required";
  }
  return "feishu.integration.connection_failed";
}
export function sanitizeFeishuCliHealthErrorMessage(
  message: string | undefined,
  sensitiveValues: Array<string | undefined>,
): string | undefined {
  const original = message?.trim();
  if (!original) {
    return undefined;
  }
  let sanitized = original
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\b(app_secret|appSecret|tenant_access_token|tenantAccessToken|verification_token|verificationToken|encrypt_key|encryptKey)\b\s*[:=]\s*("[^"]+"|'[^']+'|[^,\s]+)/g, "$1=[redacted]");
  for (const value of sensitiveValues) {
    if (!value) {
      continue;
    }
    sanitized = sanitized.split(value).join("[redacted]");
  }
  return sanitized.slice(0, 1000);
}
export function selectFeishuReadinessCandidate(
  items: readonly FeishuIntegrationReadiness[],
  gate: FeishuRequiredReadiness,
): FeishuIntegrationReadiness | undefined {
  return [...items].sort((left, right) => {
    const scoreDelta = scoreFeishuReadinessCandidate(right, gate) - scoreFeishuReadinessCandidate(left, gate);
    if (scoreDelta !== 0) {
      return scoreDelta;
    }
    return `${left.displayName}:${left.id}`.localeCompare(`${right.displayName}:${right.id}`);
  })[0];
}
export interface FeishuNativeAgentBotSmokeReadiness {
  ready: boolean;
  agentBotBindingCount: number;
  readyAgentBotBindingCount: number;
  issues: string[];
}
export function buildFeishuNativeAgentBotSmokeReadiness(input: {
  readinessItems: readonly FeishuIntegrationReadiness[];
  integrations: readonly ExternalIntegrationRecord[];
}): FeishuNativeAgentBotSmokeReadiness {
  const integrationsById = new Map(input.integrations.map((integration) => [integration.id, integration]));
  const agentBotItems = input.readinessItems.filter((item) => hasNonEmptyString(item.agentId));
  const phase6ReadyItems = agentBotItems.filter((item) =>
    isFeishuNativeAgentBotSmokeReady(item, integrationsById.get(item.id))
  );
  const distinctAgentIds = new Set(phase6ReadyItems.map((item) => item.agentId?.trim()).filter(hasNonEmptyString));
  const distinctAppIds = new Set(phase6ReadyItems
    .map((item) => integrationsById.get(item.id)?.appId?.trim())
    .filter(hasNonEmptyString));
  const issues: string[] = [];
  if (agentBotItems.length < 2) {
    issues.push("second_agent_bot_missing");
  }
  if (phase6ReadyItems.length < 2) {
    issues.push("second_agent_bot_not_ready");
  }
  if (distinctAgentIds.size < 2) {
    issues.push("second_agent_bot_distinct_agent_missing");
  }
  if (distinctAppIds.size < 2) {
    issues.push("second_agent_bot_distinct_app_missing");
  }
  return {
    ready: issues.length === 0,
    agentBotBindingCount: agentBotItems.length,
    readyAgentBotBindingCount: phase6ReadyItems.length,
    issues,
  };
}
export function isFeishuNativeAgentBotSmokeReady(
  item: FeishuIntegrationReadiness,
  integration: ExternalIntegrationRecord | undefined,
): boolean {
  return item.status === "active" &&
    hasNonEmptyString(item.agentId) &&
    hasNonEmptyString(integration?.appId) &&
    item.appConfigured &&
    item.credentialsConfigured &&
    item.healthStatus !== "unknown" &&
    item.healthStatus !== "error" &&
    item.scopes.missingForBotSmoke.length === 0 &&
    item.outboxFailures === 0 &&
    item.pendingOutboxWithErrors === 0;
}
export function isFeishuReadinessSatisfied(
  item: FeishuIntegrationReadiness,
  gate: FeishuRequiredReadiness,
): boolean {
  if (gate === "data-plane") {
    return item.readyForDataPlaneSmoke;
  }
  if (gate === "worker") {
    return item.readyForWorkerSmoke;
  }
  return item.readyForBotSmoke;
}
export function scoreFeishuReadinessCandidate(
  item: FeishuIntegrationReadiness,
  gate: FeishuRequiredReadiness,
): number {
  let score = 0;
  if (gate === "bot" && item.readyForBotSmoke) {
    score += 100;
  }
  if (gate === "data-plane" && item.readyForDataPlaneSmoke) {
    score += 100;
  }
  if (gate === "worker" && item.readyForWorkerSmoke) {
    score += 100;
  }
  if (item.status === "active") {
    score += 8;
  }
  if (item.appConfigured) {
    score += 4;
  }
  if (item.credentialsConfigured) {
    score += 4;
  }
  if (item.healthStatus !== "unknown" && item.healthStatus !== "error") {
    score += 4;
  }
  if (item.healthStatus === "healthy") {
    score += 2;
  }
  if (item.channelBindings.active > 0) {
    score += 4;
  }
  if (item.userBindings.active > 0) {
    score += 4;
  }
  if (item.scopes.missingForBotSmoke.length === 0) {
    score += 4;
  }
  if (gate === "worker" && item.transportMode === "websocket_worker") {
    score += 12;
  }
  if (gate === "data-plane") {
    if (item.resourceBindings.docWritable > 0) {
      score += 2;
    }
    if (item.resourceBindings.sheetWritable > 0) {
      score += 2;
    }
    if (item.resourceBindings.baseWritable > 0) {
      score += 2;
    }
    if (item.scopes.missingForDataPlaneSmoke.length === 0) {
      score += 4;
    }
  }
  return score;
}
export function prereqStatus(
  hasIntegration: boolean,
  conditionMet: boolean,
): FeishuSmokePlanStep["status"] {
  if (conditionMet) {
    return "done";
  }
  return hasIntegration ? "pending" : "blocked";
}
export function collectSetupIssues(
  candidate: FeishuIntegrationReadiness | undefined,
  issueCodes: readonly string[],
): string[] {
  if (!candidate) {
    return ["integration_missing"];
  }
  const issueSet = new Set(issueCodes);
  return candidate.issues.filter((issue) => issueSet.has(issue));
}
export function collectDataPlaneBindingIssues(input: {
  hasDocBinding: boolean;
  hasAnyDocBinding: boolean;
  hasSheetBinding: boolean;
  hasAnySheetBinding: boolean;
  hasBaseBinding: boolean;
  hasAnyBaseBinding: boolean;
  hasBaseReadyBinding: boolean;
}): string[] {
  const issues: string[] = [];
  if (!input.hasDocBinding) {
    issues.push(input.hasAnyDocBinding ? "doc_resource_write_grant_missing" : "doc_resource_binding_missing");
  }
  if (!input.hasSheetBinding) {
    issues.push(input.hasAnySheetBinding ? "sheet_resource_write_grant_missing" : "sheet_resource_binding_missing");
  }
  if (!input.hasBaseBinding) {
    issues.push(
      !input.hasAnyBaseBinding
        ? "base_resource_binding_missing"
        : input.hasBaseReadyBinding
          ? "base_resource_write_grant_missing"
          : "base_resource_app_token_missing",
    );
  }
  return issues;
}
export function buildFeishuWorkerSmokeIssues(
  candidate: FeishuIntegrationReadiness | undefined,
  botIssues: readonly string[],
): string[] {
  if (!candidate) {
    return ["websocket_worker_integration_missing"];
  }
  return uniqueStrings([
    ...(candidate.transportMode === "websocket_worker" ? [] : ["websocket_worker_integration_missing"]),
    ...candidate.issues.filter((issue) =>
      issue === "integration_not_active" ||
      issue === "app_id_missing" ||
      issue === "credentials_incomplete" ||
      issue === "health_not_checked" ||
      issue === "health_error" ||
      issue === "channel_binding_missing" ||
      issue === "user_binding_missing" ||
      issue === "bot_scope_missing"
    ),
    ...botIssues.filter((issue) =>
      issue === "channel_binding_missing" ||
      issue === "user_binding_missing" ||
      issue === "bot_scope_missing"
    ),
  ]);
}
