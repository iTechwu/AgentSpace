import type { RuntimeAppCatalogSource } from "@dofe-agent/db";

export type CapabilityTranslator = (zh: string, en: string) => string;

export type CliCatalogProductSource = RuntimeAppCatalogSource | "official";

export function runtimeAppSourceLabel(
  source: CliCatalogProductSource,
  tx: CapabilityTranslator,
): string {
  switch (source) {
    case "official":
      return tx("平台官方", "Official");
    case "clihub_harness":
      return tx("CLI-Anything 工具套件", "CLI-Anything harness");
    case "clihub_public":
      return tx("社区目录", "Community catalog");
    case "skill_dependency":
      return tx("Skill 依赖", "Skill dependency");
  }
}

export function runtimeAppRiskLabel(
  risk: "low" | "medium" | "high",
  tx: CapabilityTranslator,
): string {
  switch (risk) {
    case "low":
      return tx("低风险", "Low risk");
    case "medium":
      return tx("中风险", "Medium risk");
    case "high":
      return tx("高风险", "High risk");
  }
}
