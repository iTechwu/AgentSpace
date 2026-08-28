// 从 commands/integrations/feishu.ts 拆出（3.6-3），由原文件 barrel 再导出。

import {
  readExternalIntegrationSync,
  type ExternalIntegrationRecord
} from "@dofe-agent/db";
import { createFeishuApiClient, executeBoundFeishuReadDataOperation, fetchFeishuTenantAccessToken, FEISHU_PROVIDER_ID, readFeishuIntegrationCredentials, planBoundFeishuWriteDataOperation, planBoundFeishuWriteDataOperationWithApproval, reviewFeishuDataOperationApproval, resolveFeishuResourceDescriptorForType, sanitizeFeishuOperationResponseSummary, type ExternalDataOperationRequest, type ExternalDataOperationResult, type FeishuDataOperationApprovalContext, type FeishuApiClient, type FeishuApiRequest } from "@dofe-agent/services/integrations";
import { asRecord, copyJsonFlagAsParameter, copyStringFlagAsParameter, getOptionalNumberFlag, isFeishuCliPlaceholderValue, normalizeOptionalText, readNumberFromRecord, readStringFromRecord, requireActiveFeishuCliIntegration, requireNonEmpty } from "./cli-shared.ts";
import { readFeishuMetadataString, sanitizeFeishuCliHealthErrorMessage } from "./readiness.ts";
import type { FeishuApiUploadRequest, FeishuDataOperationApprovalReviewCliResult, FeishuDataOperationCliResult } from "./types.ts";

export async function runFeishuDataOperationForCli(
  input: {
    workspaceId: string;
    integrationId: string;
    operation: string;
    providerResourceType?: string;
    resourceUrlOrToken: string;
    actorType?: string;
    actorId?: string;
    approvalAgentId?: string;
    approvalChannelName?: string;
    approvalContentPreview?: string;
    baseUrl?: string;
    parameters?: Record<string, unknown>;
  },
  deps: {
    readIntegration?: typeof readExternalIntegrationSync;
    readCredentials?: typeof readFeishuIntegrationCredentials;
    resolveResourceDescriptor?: typeof resolveFeishuResourceDescriptorForType;
    fetchTenantAccessToken?: typeof fetchFeishuTenantAccessToken;
    createClient?: typeof createFeishuApiClient;
    executeReadOperation?: typeof executeBoundFeishuReadDataOperation;
    planWriteOperation?: typeof planBoundFeishuWriteDataOperation;
    planWriteOperationWithApproval?: typeof planBoundFeishuWriteDataOperationWithApproval;
  } = {},
): Promise<FeishuDataOperationCliResult> {
  const readIntegration = deps.readIntegration ?? readExternalIntegrationSync;
  const readCredentials = deps.readCredentials ?? readFeishuIntegrationCredentials;
  const resolveResourceDescriptor = deps.resolveResourceDescriptor ?? resolveFeishuResourceDescriptorForType;
  const fetchTenantAccessToken = deps.fetchTenantAccessToken ?? fetchFeishuTenantAccessToken;
  const createClient = deps.createClient ?? createFeishuApiClient;
  const executeReadOperation = deps.executeReadOperation ?? executeBoundFeishuReadDataOperation;
  const planWriteOperation = deps.planWriteOperation ?? planBoundFeishuWriteDataOperation;
  const planWriteOperationWithApproval = deps.planWriteOperationWithApproval ?? planBoundFeishuWriteDataOperationWithApproval;
  const placeholderIssue = findFeishuCliDataOperationPlaceholderIssue(input);
  if (placeholderIssue) {
    return buildFeishuCliDataOperationPlaceholderResult(input, placeholderIssue);
  }
  const operation = resolveFeishuCliDataOperation(input.operation, input.providerResourceType);
  const integration = requireActiveFeishuCliIntegration({
    workspaceId: input.workspaceId,
    integrationId: input.integrationId,
    readIntegration,
  });
  const descriptor = resolveResourceDescriptor(
    operation.providerResourceType,
    requireNonEmpty(input.resourceUrlOrToken, "feishu.data_operation.missing_resource"),
  );
  if (!descriptor) {
    throw new Error("feishu.data_operation.invalid_resource");
  }

  const request: ExternalDataOperationRequest = {
    operationType: operation.operationType,
    providerResourceType: descriptor.providerResourceType,
    providerResourceToken: descriptor.providerResourceToken,
    actorType: parseFeishuCliDataOperationActorType(input.actorType),
    actorId: normalizeOptionalText(input.actorId),
    parameters: {
      ...(descriptor.metadata ?? {}),
      ...(operation.defaultParameters ?? {}),
      ...(input.parameters ?? {}),
    },
  };
  const sensitiveValues = [
    integration.appId,
    descriptor.providerResourceToken,
    descriptor.providerResourceUrl,
    input.resourceUrlOrToken,
    readFeishuMetadataString(request.parameters, "appToken"),
    readFeishuMetadataString(request.parameters, "baseToken"),
    readFeishuMetadataString(request.parameters, "tableId"),
  ];
  let liveApiCalled = false;

  try {
    const baseParameterIssue = findFeishuCliBaseDataOperationParameterIssue(request);
    if (baseParameterIssue) {
      throw new Error(baseParameterIssue);
    }
    const context = {
      workspaceId: input.workspaceId,
      integrationId: integration.id,
      provider: FEISHU_PROVIDER_ID,
    };
    const approvalContext = buildFeishuCliDataOperationApprovalContext(input);
    if (approvalContext && !operation.writeOperation) {
      throw new Error("feishu.data_operation_approval_requires_write_operation");
    }
    const executed = operation.writeOperation
      ? approvalContext
        ? await planWriteOperationWithApproval({
          context,
          client: createNoopFeishuCliWritePlanClient(),
          request,
          approval: approvalContext,
        })
        : await planWriteOperation({
          context,
          client: createNoopFeishuCliWritePlanClient(),
          request,
        })
      : await executeReadOperation({
        context,
        client: createLazyFeishuCliDataOperationReadClient({
          integration,
          baseUrl: input.baseUrl,
          readCredentials,
          fetchTenantAccessToken,
          createClient,
          sensitiveValues,
          onInitialize: () => {
            liveApiCalled = true;
          },
        }),
        request,
      });

    return buildFeishuDataOperationCliResult({
      workspaceId: input.workspaceId,
      integrationId: integration.id,
      request,
      result: executed.result,
      runId: executed.runId,
      resourceBindingId: executed.resourceBinding?.id,
      liveApiCalled,
      sensitiveValues,
    });
  } catch (error) {
    return {
      ok: false,
      workspaceId: input.workspaceId,
      integrationId: integration.id,
      operationType: request.operationType,
      providerResourceType: request.providerResourceType,
      externalIdRedacted: true,
      liveApiCalled,
      approvalRequired: false,
      errorCode: error instanceof Error && error.message ? error.message : "feishu.data_operation.cli_failed",
      errorMessage: sanitizeFeishuCliHealthErrorMessage(
        error instanceof Error ? error.message : String(error),
        sensitiveValues,
      ),
    };
  }
}
export async function runFeishuDataOperationApprovalReviewForCli(
  input: {
    workspaceId: string;
    approvalId: string;
    decision: string;
    reviewerComment?: string;
    baseUrl?: string;
  },
  deps: {
    reviewApproval?: typeof reviewFeishuDataOperationApproval;
  } = {},
): Promise<FeishuDataOperationApprovalReviewCliResult> {
  const approvalId = input.approvalId.trim();
  if (!approvalId) {
    return buildFeishuDataOperationApprovalReviewInputError({
      workspaceId: input.workspaceId,
      approvalId: "unknown",
      errorCode: "feishu.data_operation_review.missing_approval_id",
      errorMessage: "Feishu data-operation review requires --approval-id.",
    });
  }
  if (isFeishuCliPlaceholderValue(approvalId)) {
    return buildFeishuDataOperationApprovalReviewInputError({
      workspaceId: input.workspaceId,
      approvalId: "unknown",
      errorCode: "feishu.data_operation_review.placeholder_value",
      errorMessage: "Feishu data-operation review approval-id contains a placeholder value; replace CHANGE_ME_* placeholders before rerunning.",
    });
  }
  const decision = parseFeishuCliApprovalReviewDecisionResult(input.decision);
  if (!decision.ok) {
    return buildFeishuDataOperationApprovalReviewInputError({
      workspaceId: input.workspaceId,
      approvalId,
      errorCode: decision.errorCode,
      errorMessage: decision.errorMessage,
    });
  }
  const reviewApproval = deps.reviewApproval ?? reviewFeishuDataOperationApproval;
  try {
    const reviewed = await reviewApproval({
      workspaceId: input.workspaceId,
      approvalId,
      decision: decision.value,
      reviewerComment: normalizeOptionalText(input.reviewerComment),
      baseUrl: input.baseUrl,
    });
    const execution = reviewed.execution
      ? buildFeishuDataOperationApprovalReviewExecutionSummary(reviewed.execution)
      : undefined;
    return {
      ok: decision.value === "rejected" ? true : execution?.resultOk === true,
      workspaceId: input.workspaceId,
      approvalId,
      decision: decision.value,
      approvalStatus: reviewed.approval.status,
      externalIdRedacted: true,
      execution,
    };
  } catch (error) {
    return {
      ok: false,
      workspaceId: input.workspaceId,
      approvalId,
      decision: decision.value,
      externalIdRedacted: true,
      errorCode: error instanceof Error && error.message ? error.message : "feishu.data_operation_review.failed",
      errorMessage: sanitizeFeishuCliHealthErrorMessage(
        error instanceof Error ? error.message : String(error),
        [],
      ),
    };
  }
}
export function buildFeishuDataOperationApprovalReviewInputError(input: {
  workspaceId: string;
  approvalId: string;
  errorCode: string;
  errorMessage: string;
}): FeishuDataOperationApprovalReviewCliResult {
  return {
    ok: false,
    workspaceId: input.workspaceId,
    approvalId: input.approvalId,
    externalIdRedacted: true,
    errorCode: input.errorCode,
    errorMessage: input.errorMessage,
  };
}
export function parseFeishuCliApprovalReviewDecisionResult(value: string): {
  ok: true;
  value: "approved" | "rejected";
} | {
  ok: false;
  errorCode: string;
  errorMessage: string;
} {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return {
      ok: false,
      errorCode: "feishu.data_operation_review.missing_decision",
      errorMessage: "Feishu data-operation review requires --decision approved|rejected.",
    };
  }
  if (normalized === "approved" || normalized === "approve") {
    return {
      ok: true,
      value: "approved",
    };
  }
  if (normalized === "rejected" || normalized === "reject") {
    return {
      ok: true,
      value: "rejected",
    };
  }
  return {
    ok: false,
    errorCode: "feishu.data_operation_review.invalid_decision",
    errorMessage: "Feishu data-operation review decision must be approved or rejected.",
  };
}
export function buildFeishuDataOperationApprovalReviewExecutionSummary(input: {
  runId: string;
  result: ExternalDataOperationResult;
}): NonNullable<FeishuDataOperationApprovalReviewCliResult["execution"]> {
  const data = asRecord(input.result.data);
  return {
    runId: input.runId,
    resultOk: input.result.ok,
    runStatus: input.result.ok ? "succeeded" : "failed",
    errorCode: input.result.errorCode,
    errorMessage: sanitizeFeishuCliHealthErrorMessage(input.result.errorMessage, []),
    payloadHash: readStringFromRecord(data, "payloadHash"),
    responseSummary: sanitizeFeishuOperationResponseSummary(asRecord(data?.responseSummary)),
    previewSummary: summarizeFeishuCliDataOperationPreview(asRecord(data?.resultPreview)),
  };
}
export function findFeishuCliDataOperationPlaceholderIssue(input: {
  integrationId: string;
  operation: string;
  providerResourceType?: string;
  resourceUrlOrToken: string;
  actorType?: string;
  actorId?: string;
  approvalAgentId?: string;
  approvalChannelName?: string;
  approvalContentPreview?: string;
  parameters?: Record<string, unknown>;
}): string | undefined {
  const candidates: Array<[string, string | undefined]> = [
    ["integration", input.integrationId],
    ["operation", input.operation],
    ["type", input.providerResourceType],
    ["resource", input.resourceUrlOrToken],
    ["actor_type", input.actorType],
    ["actor_id", input.actorId],
    ["approval_agent", input.approvalAgentId],
    ["approval_channel", input.approvalChannelName],
    ["approval_preview", input.approvalContentPreview],
  ];
  for (const [field, value] of candidates) {
    if (value && isFeishuCliPlaceholderValue(value)) {
      return field;
    }
  }
  return findFeishuCliDataOperationParameterPlaceholder(input.parameters);
}
export function findFeishuCliDataOperationParameterPlaceholder(
  parameters: Record<string, unknown> | undefined,
  path = "parameters",
): string | undefined {
  if (!parameters) {
    return undefined;
  }
  for (const [key, value] of Object.entries(parameters)) {
    const fieldPath = `${path}.${key}`;
    if (typeof value === "string" && isFeishuCliPlaceholderValue(value)) {
      return fieldPath;
    }
    if (Array.isArray(value)) {
      const arrayIssue = findFeishuCliDataOperationArrayPlaceholder(value, fieldPath);
      if (arrayIssue) {
        return arrayIssue;
      }
      continue;
    }
    if (value && typeof value === "object") {
      const objectIssue = findFeishuCliDataOperationParameterPlaceholder(value as Record<string, unknown>, fieldPath);
      if (objectIssue) {
        return objectIssue;
      }
    }
  }
  return undefined;
}
export function findFeishuCliDataOperationArrayPlaceholder(values: unknown[], path: string): string | undefined {
  for (const [index, value] of values.entries()) {
    const fieldPath = `${path}[${index}]`;
    if (typeof value === "string" && isFeishuCliPlaceholderValue(value)) {
      return fieldPath;
    }
    if (Array.isArray(value)) {
      const arrayIssue = findFeishuCliDataOperationArrayPlaceholder(value, fieldPath);
      if (arrayIssue) {
        return arrayIssue;
      }
      continue;
    }
    if (value && typeof value === "object") {
      const objectIssue = findFeishuCliDataOperationParameterPlaceholder(value as Record<string, unknown>, fieldPath);
      if (objectIssue) {
        return objectIssue;
      }
    }
  }
  return undefined;
}
export function buildFeishuCliDataOperationApprovalContext(input: {
  approvalAgentId?: string;
  approvalChannelName?: string;
  approvalContentPreview?: string;
}): FeishuDataOperationApprovalContext | undefined {
  const agentId = normalizeOptionalText(input.approvalAgentId);
  const channelName = normalizeOptionalText(input.approvalChannelName);
  const contentPreview = normalizeOptionalText(input.approvalContentPreview);
  if (!agentId && !channelName && !contentPreview) {
    return undefined;
  }
  if (!agentId) {
    throw new Error("feishu.data_operation_approval_agent_missing");
  }
  if (!channelName) {
    throw new Error("feishu.data_operation_approval_channel_missing");
  }
  return {
    agentId,
    channelName,
    contentPreview,
  };
}
export function buildFeishuCliDataOperationPlaceholderResult(
  input: {
    workspaceId: string;
    integrationId: string;
    operation: string;
    providerResourceType?: string;
  },
  fieldPath: string,
): FeishuDataOperationCliResult {
  return {
    ok: false,
    workspaceId: input.workspaceId,
    integrationId: isFeishuCliPlaceholderValue(input.integrationId) ? "unknown" : input.integrationId,
    operationType: isFeishuCliPlaceholderValue(input.operation)
      ? "unknown"
      : normalizeOptionalText(input.operation) ?? "unknown",
    providerResourceType: input.providerResourceType && !isFeishuCliPlaceholderValue(input.providerResourceType)
      ? input.providerResourceType
      : "unknown",
    externalIdRedacted: true,
    liveApiCalled: false,
    approvalRequired: false,
    errorCode: "feishu.data_operation.placeholder_value",
    errorMessage: `Feishu data-operation input ${fieldPath} contains a placeholder value; replace CHANGE_ME_* placeholders before rerunning.`,
  };
}
export function buildFeishuCliDataOperationParameters(flags: Record<string, string | boolean>): Record<string, unknown> {
  const parameters: Record<string, unknown> = {};
  copyStringFlagAsParameter(flags, parameters, "range", "range");
  copyStringFlagAsParameter(flags, parameters, "page-token", "pageToken");
  copyStringFlagAsParameter(flags, parameters, "app-token", "appToken");
  copyStringFlagAsParameter(flags, parameters, "table-id", "tableId");
  copyStringFlagAsParameter(flags, parameters, "view-id", "viewId");
  copyStringFlagAsParameter(flags, parameters, "record-id", "recordId");
  copyStringFlagAsParameter(flags, parameters, "mutation", "mutation");
  copyStringFlagAsParameter(flags, parameters, "title", "title");
  copyStringFlagAsParameter(flags, parameters, "folder-token", "folderToken");
  copyStringFlagAsParameter(flags, parameters, "parent-block-id", "parentBlockId");
  copyStringFlagAsParameter(flags, parameters, "block-id", "blockId");
  copyStringFlagAsParameter(flags, parameters, "client-token", "clientToken");
  copyStringFlagAsParameter(flags, parameters, "user-id-type", "userIdType");
  const pageSize = getOptionalNumberFlag(flags, "page-size");
  if (pageSize !== undefined) {
    parameters.pageSize = pageSize;
  }
  const documentRevisionId = getOptionalNumberFlag(flags, "document-revision-id");
  if (documentRevisionId !== undefined) {
    parameters.documentRevisionId = documentRevisionId;
  }
  const index = getOptionalNumberFlag(flags, "index");
  if (index !== undefined) {
    parameters.index = index;
  }
  copyJsonFlagAsParameter(flags, parameters, "values-json", "values");
  copyJsonFlagAsParameter(flags, parameters, "fields-json", "fields");
  copyJsonFlagAsParameter(flags, parameters, "records-json", "records");
  copyJsonFlagAsParameter(flags, parameters, "block-json", "block");
  copyJsonFlagAsParameter(flags, parameters, "body-json", "body");
  copyJsonFlagAsParameter(flags, parameters, "update-json", "update");
  copyJsonFlagAsParameter(flags, parameters, "blocks-json", "blocks");
  copyJsonFlagAsParameter(flags, parameters, "children-json", "children");
  copyJsonFlagAsParameter(flags, parameters, "requests-json", "requests");
  return parameters;
}
export function findFeishuCliBaseDataOperationParameterIssue(
  request: ExternalDataOperationRequest,
): string | undefined {
  if (!request.operationType.startsWith("base.")) {
    return undefined;
  }
  if (request.providerResourceType === "base") {
    return readFeishuMetadataString(request.parameters, "tableId")
      ? undefined
      : "feishu.data_operation_base_table_id_missing";
  }
  if (request.providerResourceType !== "base_table" && request.providerResourceType !== "base_view") {
    return undefined;
  }
  const hasAppToken = Boolean(
    readFeishuMetadataString(request.parameters, "appToken") ??
      readFeishuMetadataString(request.parameters, "baseToken"),
  );
  if (!hasAppToken) {
    return "feishu.data_operation_base_app_token_missing";
  }
  if (request.providerResourceType === "base_view" && !readFeishuMetadataString(request.parameters, "tableId")) {
    return "feishu.data_operation_base_table_id_missing";
  }
  return undefined;
}
export function resolveFeishuCliDataOperation(
  operation: string,
  providerResourceType?: string,
): {
  operationType: string;
  providerResourceType: string;
  writeOperation: boolean;
  defaultParameters?: Record<string, unknown>;
} {
  const normalized = requireNonEmpty(operation, "feishu.data_operation.missing_operation");
  const aliases: Record<string, {
    operationType: string;
    providerResourceType: string;
    writeOperation: boolean;
    defaultParameters?: Record<string, unknown>;
  }> = {
    "read-doc": {
      operationType: "docs.read_document",
      providerResourceType: "doc",
      writeOperation: false,
    },
    "plan-doc-create": {
      operationType: "docs.create_document",
      providerResourceType: "doc",
      writeOperation: true,
    },
    "plan-doc-update": {
      operationType: "docs.update_document",
      providerResourceType: "doc",
      writeOperation: true,
    },
    "plan-doc-append": {
      operationType: "docs.update_document",
      providerResourceType: "doc",
      writeOperation: true,
      defaultParameters: { mutation: "append_blocks" },
    },
    "read-sheet": {
      operationType: "sheets.read_range",
      providerResourceType: "sheet",
      writeOperation: false,
    },
    "query-base": {
      operationType: "base.query_records",
      providerResourceType: "base_table",
      writeOperation: false,
    },
    "read-base": {
      operationType: "base.query_records",
      providerResourceType: "base_table",
      writeOperation: false,
    },
    "plan-sheet-write": {
      operationType: "sheets.update_range",
      providerResourceType: "sheet",
      writeOperation: true,
    },
    "plan-base-update": {
      operationType: "base.mutate_records",
      providerResourceType: "base_table",
      writeOperation: true,
      defaultParameters: { mutation: "update_record" },
    },
  };
  const aliased = aliases[normalized];
  if (aliased) {
    return {
      ...aliased,
      providerResourceType: normalizeOptionalText(providerResourceType) ?? aliased.providerResourceType,
    };
  }

  const operationType = normalized;
  const inferredProviderResourceType = normalizeOptionalText(providerResourceType)
    ?? inferFeishuCliDataOperationResourceType(operationType);
  if (!inferredProviderResourceType) {
    throw new Error("feishu.data_operation.missing_type");
  }
  return {
    operationType,
    providerResourceType: inferredProviderResourceType,
    writeOperation: isFeishuCliWriteDataOperation(operationType),
  };
}
export function inferFeishuCliDataOperationResourceType(operationType: string): string | undefined {
  if (operationType.startsWith("docs.")) {
    return "doc";
  }
  if (operationType.startsWith("sheets.")) {
    return "sheet";
  }
  if (operationType.startsWith("base.")) {
    return "base_table";
  }
  return undefined;
}
export function isFeishuCliWriteDataOperation(operationType: string): boolean {
  return operationType === "docs.create_document" ||
    operationType === "docs.update_document" ||
    operationType === "sheets.update_range" ||
    operationType === "base.mutate_records";
}
export function parseFeishuCliDataOperationActorType(value: string | undefined): ExternalDataOperationRequest["actorType"] {
  const normalized = normalizeOptionalText(value) ?? "agent";
  if (normalized === "agent" || normalized === "user" || normalized === "system") {
    return normalized;
  }
  throw new Error("feishu.data_operation.invalid_actor_type");
}
export async function createFeishuCliDataOperationReadClient(input: {
  integration: ExternalIntegrationRecord;
  baseUrl?: string;
  readCredentials: typeof readFeishuIntegrationCredentials;
  fetchTenantAccessToken: typeof fetchFeishuTenantAccessToken;
  createClient: typeof createFeishuApiClient;
  sensitiveValues: Array<string | undefined>;
}): Promise<FeishuApiClient> {
  const credentials = input.readCredentials(input.integration);
  input.sensitiveValues.push(credentials.appSecret);
  const tenant = await input.fetchTenantAccessToken({
    appId: input.integration.appId ?? "",
    appSecret: credentials.appSecret,
    baseUrl: input.baseUrl,
  });
  input.sensitiveValues.push(tenant.tenantAccessToken);
  return input.createClient({
    credentials: {
      appId: input.integration.appId ?? "",
      appSecret: credentials.appSecret,
      tenantAccessToken: tenant.tenantAccessToken,
    },
    baseUrl: input.baseUrl,
  });
}
export function createLazyFeishuCliDataOperationReadClient(input: {
  integration: ExternalIntegrationRecord;
  baseUrl?: string;
  readCredentials: typeof readFeishuIntegrationCredentials;
  fetchTenantAccessToken: typeof fetchFeishuTenantAccessToken;
  createClient: typeof createFeishuApiClient;
  sensitiveValues: Array<string | undefined>;
  onInitialize?: () => void;
}): FeishuApiClient {
  let clientPromise: Promise<FeishuApiClient> | undefined;
  const readClient = () => {
    if (!clientPromise) {
      input.onInitialize?.();
      clientPromise = createFeishuCliDataOperationReadClient(input);
    }
    return clientPromise;
  };
  return {
    async request<T = unknown>(request: FeishuApiRequest) {
      const client = await readClient();
      return client.request<T>(request);
    },
    async upload<T = unknown>(request: FeishuApiUploadRequest) {
      const client = await readClient();
      if (!client.upload) {
        throw new Error("feishu.data_operation.upload_unavailable");
      }
      return client.upload<T>(request);
    },
  };
}
export function createNoopFeishuCliWritePlanClient(): FeishuApiClient {
  return {
    async request() {
      throw new Error("feishu.data_operation.write_plan_unexpected_api_call");
    },
  };
}
export function buildFeishuDataOperationCliResult(input: {
  workspaceId: string;
  integrationId: string;
  request: ExternalDataOperationRequest;
  result: ExternalDataOperationResult;
  runId: string;
  resourceBindingId?: string;
  liveApiCalled: boolean;
  sensitiveValues: Array<string | undefined>;
}): FeishuDataOperationCliResult {
  const data = asRecord(input.result.data);
  const approvalRequired = input.result.errorCode === "feishu.data_operation_requires_approval" ||
    readStringFromRecord(data, "policyDecision") === "require_approval";
  const approvalId = readStringFromRecord(data, "approvalId");
  return {
    ok: input.result.ok || approvalRequired,
    workspaceId: input.workspaceId,
    integrationId: input.integrationId,
    operationType: input.request.operationType,
    providerResourceType: input.request.providerResourceType,
    externalIdRedacted: true,
    liveApiCalled: input.liveApiCalled,
    approvalRequired,
    ...(approvalId
      ? {
          approvalId,
          approvalStatus: approvalRequired ? "pending" : undefined,
        }
      : {}),
    runId: input.runId,
    runStatus: readStringFromRecord(data, "runStatus")
      ?? (input.result.ok ? "succeeded" : approvalRequired ? "pending" : "failed"),
    resourceBindingId: input.resourceBindingId,
    resultOk: input.result.ok,
    errorCode: input.result.errorCode,
    errorMessage: sanitizeFeishuCliHealthErrorMessage(input.result.errorMessage, input.sensitiveValues),
    payloadHash: readStringFromRecord(data, "payloadHash"),
    responseSummary: sanitizeFeishuOperationResponseSummary(asRecord(data?.responseSummary)),
    previewSummary: summarizeFeishuCliDataOperationPreview(asRecord(data?.resultPreview)),
  };
}
export function summarizeFeishuCliDataOperationPreview(preview: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!preview) {
    return undefined;
  }
  const kind = readStringFromRecord(preview, "kind");
  if (kind === "doc_blocks") {
    return {
      kind,
      blockCount: readNumberFromRecord(preview, "blockCount"),
      previewBlockCount: Array.isArray(preview.blocks) ? preview.blocks.length : undefined,
    };
  }
  if (kind === "sheet_values") {
    const range = readStringFromRecord(preview, "range");
    return {
      kind,
      ...(range ? { rangeRedacted: true } : {}),
      rowCount: readNumberFromRecord(preview, "rowCount"),
      columnCount: readNumberFromRecord(preview, "columnCount"),
      previewRowCount: Array.isArray(preview.rows) ? preview.rows.length : undefined,
    };
  }
  if (kind === "base_records") {
    const records = Array.isArray(preview.records) ? preview.records : [];
    return {
      kind,
      recordCount: readNumberFromRecord(preview, "recordCount"),
      previewRecordCount: records.length,
      fieldNames: Array.from(new Set(records.flatMap((record) =>
        Object.keys(asRecord(record)?.fieldsPreview ?? {}),
      ))).sort(),
    };
  }
  return {
    kind,
    previewKeys: Object.keys(preview).sort().slice(0, 10),
  };
}
