// 从 feishu/evidence.ts 拆出（3.6-3 补充），域：proofs。
import { createHash } from "node:crypto";
import type { ExternalIntegrationEventRecord, ExternalIntegrationRecord } from "@dofe-agent/db";
import { FEISHU_SMOKE_EVIDENCE_MAX_AGE_MS, FEISHU_SMOKE_EVIDENCE_MAX_FUTURE_SKEW_MS } from "../types.ts";
import type { FeishuEvidenceRequirement, FeishuExpectedBotAddedPayloadChatReferenceProof, FeishuExpectedBotAddedPayloadIdentityProof, FeishuExpectedCallbackRouteProof, FeishuExpectedTodo120NativeSecondAgentAppProof, FeishuIntegrationEvidence, FeishuIntegrationEvidenceSource } from "../types.ts";
import { hasNonEmptyString } from "./core.ts";
import { hasFeishuWorkspaceNativeExperienceEvidence, listFeishuWorkspaceNativeExperienceChatReferences, listFeishuIntegrationIdsForSafeChatReference, isFeishuEvidenceSatisfiedExceptNative } from "./satisfaction.ts";

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
