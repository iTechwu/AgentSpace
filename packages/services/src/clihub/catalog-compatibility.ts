import type { RuntimeAppCatalogItemRecord, RuntimeAppCatalogSource, RuntimeAppInstallStrategy } from "@dofe-agent/db";

interface CliHubCatalogCompatibilityOverride {
  entryPoint?: string;
  installCmd?: string;
  installStrategy?: RuntimeAppInstallStrategy;
  npmPackage?: string;
}

const COMPATIBILITY_OVERRIDES: Readonly<Record<string, CliHubCatalogCompatibilityOverride>> = {
  "clihub_public:minimax-cli": {
    entryPoint: "minimax",
  },
  "clihub_harness:hacker-feeds-cli": {
    entryPoint: "hf",
    installCmd: "npm install -g hacker-feeds-cli",
    installStrategy: "npm",
    npmPackage: "hacker-feeds-cli",
  },
};

export function readCliHubCatalogCompatibilityOverride(
  source: RuntimeAppCatalogSource,
  name: string,
): CliHubCatalogCompatibilityOverride | undefined {
  return COMPATIBILITY_OVERRIDES[`${source}:${name}`];
}

export function applyCliHubCatalogCompatibility(item: RuntimeAppCatalogItemRecord): RuntimeAppCatalogItemRecord {
  const compatibility = readCliHubCatalogCompatibilityOverride(item.source, item.name);
  if (!compatibility) return item;
  return {
    ...item,
    entryPoint: compatibility.entryPoint ?? item.entryPoint,
    installCmd: compatibility.installCmd ?? item.installCmd,
    installStrategy: compatibility.installStrategy ?? item.installStrategy,
    registryJson: patchRegistryJson(item.registryJson, compatibility),
  };
}

function patchRegistryJson(registryJson: string, compatibility: CliHubCatalogCompatibilityOverride): string {
  try {
    const entry = JSON.parse(registryJson) as unknown;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return registryJson;
    return JSON.stringify({
      ...(entry as Record<string, unknown>),
      ...(compatibility.entryPoint ? { entry_point: compatibility.entryPoint } : {}),
      ...(compatibility.installCmd ? { install_cmd: compatibility.installCmd } : {}),
    });
  } catch {
    return registryJson;
  }
}
