// skill-service-catalog read cutover runner（真 Prisma Client primary）：
// Phase 2 第十三域生产路径。pg 原型同款 runner 见
// skill-service-catalog-cutover.ts（@deprecated）。

import { listSkillServiceCatalogSync } from "../skill-services.ts";
import type { StoredSkillServiceCatalogRecord } from "../types.ts";
import { buildDomainCutover } from "./cutover-runner.ts";
import { createPrismaCutoverMetricSink } from "./cutover-observability.ts";
import type { ReadCutoverMetric } from "./read-cutover.ts";
import { listSkillServiceCatalogPrisma } from "./skill-service-catalog-prisma.ts";

export type ListSkillServiceCatalogPrismaCutoverMetric = ReadCutoverMetric;
export type ListSkillServiceCatalogPrismaCutoverMetricSink = (
  metric: ListSkillServiceCatalogPrismaCutoverMetric,
) => void;

const listSkillServiceCatalogPrismaCutoverImpl = buildDomainCutover<
  string,
  StoredSkillServiceCatalogRecord[],
  ListSkillServiceCatalogPrismaCutoverMetric
>({
  isEnabled: () => process.env.SKILL_SERVICE_CATALOG_PRISMA_READ_ENABLED === "1",
  isShadowEnabled: () => process.env.SKILL_SERVICE_CATALOG_PRISMA_SHADOW_READ_ENABLED === "1",
  runPrimary: async (workspaceId) => listSkillServiceCatalogPrisma(workspaceId),
  runFallback: (workspaceId) => listSkillServiceCatalogSync(workspaceId),
  compare: (primary, fallback) => recordsEqual(primary, fallback),
  emitMetric: createPrismaCutoverMetricSink({
    domain: "skill_service_catalog",
    operation: "list",
  }),
});

export function listSkillServiceCatalogPrismaCutover(
  workspaceId: string = "default",
  metricSink?: ListSkillServiceCatalogPrismaCutoverMetricSink,
): Promise<StoredSkillServiceCatalogRecord[]> {
  return listSkillServiceCatalogPrismaCutoverImpl(workspaceId, metricSink);
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