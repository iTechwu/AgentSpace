// @deprecated — Phase 2 pg 原型 cutover，保留作 Prisma 接入迁移期 fallback。
// 生产路径走 skill-service-catalog-prisma-cutover.ts。

import { listSkillServiceCatalogSync } from "../skill-services.ts";
import type { StoredSkillServiceCatalogRecord } from "../types.ts";
import {
  isSkillServiceCatalogAsyncReadEnabled,
  isSkillServiceCatalogShadowReadEnabled,
  listSkillServiceCatalogAsync,
} from "./skill-service-catalog-async.ts";
import { buildDomainCutover } from "./cutover-runner.ts";
import type { ReadCutoverMetric } from "./read-cutover.ts";

export type ListSkillServiceCatalogCutoverMetric = ReadCutoverMetric;
export type ListSkillServiceCatalogCutoverMetricSink = (
  metric: ListSkillServiceCatalogCutoverMetric,
) => void;

/**
 * @deprecated Use {@link listSkillServiceCatalogPrismaCutover} instead.
 * Kept as Prisma 接入迁移期 fallback + 影子对比驱动。
 */
export function listSkillServiceCatalogCutover(
  workspaceId: string = "default",
  metricSink?: ListSkillServiceCatalogCutoverMetricSink,
): Promise<StoredSkillServiceCatalogRecord[]> {
  return buildDomainCutover<
    string,
    StoredSkillServiceCatalogRecord[],
    ListSkillServiceCatalogCutoverMetric
  >({
    isEnabled: isSkillServiceCatalogAsyncReadEnabled,
    isShadowEnabled: isSkillServiceCatalogShadowReadEnabled,
    runPrimary: async (id) => listSkillServiceCatalogAsync(id),
    runFallback: (id) => listSkillServiceCatalogSync(id),
    compare: (primary, fallback) => recordsEqual(primary, fallback),
  })(workspaceId, metricSink);
}

export function recordsEqual(
  primary: StoredSkillServiceCatalogRecord[],
  fallback: StoredSkillServiceCatalogRecord[],
): boolean {
  if (primary.length !== fallback.length) return false;
  for (let i = 0; i < primary.length; i += 1) {
    if (!recordEqual(primary[i]!, fallback[i]!)) return false;
  }
  return true;
}

function recordEqual(
  primary: StoredSkillServiceCatalogRecord,
  fallback: StoredSkillServiceCatalogRecord,
): boolean {
  return (
    primary.id === fallback.id &&
    primary.workspaceId === fallback.workspaceId &&
    primary.slug === fallback.slug &&
    primary.templateVersion === fallback.templateVersion &&
    primary.deploymentType === fallback.deploymentType &&
    primary.imageDigest === fallback.imageDigest &&
    primary.protocol === fallback.protocol &&
    primary.scope === fallback.scope &&
    primary.resourcesJson === fallback.resourcesJson &&
    primary.healthJson === fallback.healthJson &&
    primary.networkJson === fallback.networkJson &&
    primary.configSchemaVersion === fallback.configSchemaVersion &&
    primary.configSchemaJson === fallback.configSchemaJson &&
    primary.secretFieldsJson === fallback.secretFieldsJson &&
    primary.externalDependenciesJson === fallback.externalDependenciesJson &&
    primary.rollbackClass === fallback.rollbackClass &&
    primary.templateDigest === fallback.templateDigest &&
    primary.sbomDigest === fallback.sbomDigest &&
    primary.runAsNonRoot === fallback.runAsNonRoot &&
    primary.readOnlyRootfs === fallback.readOnlyRootfs &&
    primary.capDropJson === fallback.capDropJson &&
    primary.signatureKeyPem === fallback.signatureKeyPem &&
    primary.signatureRequired === fallback.signatureRequired &&
    primary.risk === fallback.risk &&
    primary.createdAt === fallback.createdAt &&
    primary.updatedAt === fallback.updatedAt
  );
}