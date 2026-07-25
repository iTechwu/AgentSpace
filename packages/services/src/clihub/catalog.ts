import {
  listRuntimeAppCatalogItemsSync,
  readRuntimeAppCatalogHealthSync,
  readRuntimeAppCatalogItemSync,
  upsertRuntimeAppCatalogItemsSync,
  type RuntimeAppCatalogItemRecord,
  type RuntimeAppCatalogSource,
  type UpsertRuntimeAppCatalogItemInput,
} from "@dofe-agent/db";

export const CLIHUB_HARNESS_REGISTRY_URL = "https://hkuds.github.io/CLI-Anything/registry.json";
export const CLIHUB_PUBLIC_REGISTRY_URL = "https://hkuds.github.io/CLI-Anything/public_registry.json";
export const CLIHUB_PUBLIC_REGISTRY_FALLBACK_URL = "https://raw.githubusercontent.com/HKUDS/CLI-Anything/main/public_registry.json";

export interface CliHubCatalogSyncResult {
  status: "fresh" | "stale";
  itemCount: number;
  syncedCount: number;
  syncedAt?: string;
  errors: string[];
}

interface CliHubRegistryEntry {
  name?: unknown;
  display_name?: unknown;
  displayName?: unknown;
  description?: unknown;
  version?: unknown;
  category?: unknown;
  install_cmd?: unknown;
  installCmd?: unknown;
  uninstall_cmd?: unknown;
  update_cmd?: unknown;
  entry_point?: unknown;
  entryPoint?: unknown;
  skill_md?: unknown;
  skillMd?: unknown;
  requires?: unknown;
  requires_text?: unknown;
  homepage?: unknown;
}

export async function syncCliHubCatalog(options?: {
  fetchImpl?: typeof fetch;
  now?: Date;
  upsertItemsSync?: typeof upsertRuntimeAppCatalogItemsSync;
  readHealthSync?: typeof readRuntimeAppCatalogHealthSync;
}): Promise<CliHubCatalogSyncResult> {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const upsertItemsSync = options?.upsertItemsSync ?? upsertRuntimeAppCatalogItemsSync;
  const readHealthSync = options?.readHealthSync ?? readRuntimeAppCatalogHealthSync;
  const syncedAt = (options?.now ?? new Date()).toISOString();
  const errors: string[] = [];
  const items: UpsertRuntimeAppCatalogItemInput[] = [];

  for (const target of [
    { source: "clihub_harness" as const, urls: [CLIHUB_HARNESS_REGISTRY_URL] },
    { source: "clihub_public" as const, urls: [CLIHUB_PUBLIC_REGISTRY_URL, CLIHUB_PUBLIC_REGISTRY_FALLBACK_URL] },
  ]) {
    try {
      const payload = await fetchFirstAvailableRegistryPayload(fetchImpl, target.urls);
      items.push(...normalizeCliHubRegistryPayload(target.source, payload, syncedAt));
    } catch (error) {
      errors.push(`${target.source}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const syncedCount = upsertItemsSync(items);
  const health = readHealthSync();
  return {
    status: items.length > 0 ? "fresh" : "stale",
    itemCount: health.itemCount,
    syncedCount,
    syncedAt: items.length > 0 ? syncedAt : health.lastSyncedAt,
    errors,
  };
}

export function listCliHubCatalogItems(options?: Parameters<typeof listRuntimeAppCatalogItemsSync>[0]): RuntimeAppCatalogItemRecord[] {
  return listRuntimeAppCatalogItemsSync(options);
}

export function readCliHubCatalogItem(
  source: RuntimeAppCatalogSource,
  name: string,
): RuntimeAppCatalogItemRecord | null {
  return readRuntimeAppCatalogItemSync(source, name);
}

export function readCliHubCatalogHealth(): ReturnType<typeof readRuntimeAppCatalogHealthSync> {
  return readRuntimeAppCatalogHealthSync();
}

async function fetchFirstAvailableRegistryPayload(fetchImpl: typeof fetch, urls: string[]): Promise<unknown> {
  const failures: string[] = [];
  for (const url of urls) {
    try {
      const response = await fetchImpl(url, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }
      return response.json();
    } catch (error) {
      failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(failures.join("; "));
}

export function normalizeCliHubRegistryPayload(
  source: RuntimeAppCatalogSource,
  payload: unknown,
  syncedAt: string,
): UpsertRuntimeAppCatalogItemInput[] {
  const entries = extractRegistryEntries(payload);
  return entries
    .map((entry) => normalizeCliHubRegistryEntry(source, entry, syncedAt))
    .filter((item): item is UpsertRuntimeAppCatalogItemInput => item !== null);
}

function extractRegistryEntries(payload: unknown): CliHubRegistryEntry[] {
  if (Array.isArray(payload)) {
    return payload.filter(isRecord) as CliHubRegistryEntry[];
  }
  if (!isRecord(payload)) {
    return [];
  }
  if (Array.isArray(payload.clis)) {
    return payload.clis.filter(isRecord) as CliHubRegistryEntry[];
  }
  if (Array.isArray(payload.items)) {
    return payload.items.filter(isRecord) as CliHubRegistryEntry[];
  }
  if (Array.isArray(payload.registry)) {
    return payload.registry.filter(isRecord) as CliHubRegistryEntry[];
  }
  return [];
}

function normalizeCliHubRegistryEntry(
  source: RuntimeAppCatalogSource,
  entry: CliHubRegistryEntry,
  syncedAt: string,
): UpsertRuntimeAppCatalogItemInput | null {
  const name = readString(entry.name);
  if (!name) {
    return null;
  }
  const installCmd = readString(entry.install_cmd) ?? readString(entry.installCmd);
  const entryPoint = readString(entry.entry_point) ?? readString(entry.entryPoint);
  return {
    source,
    name,
    displayName: readString(entry.display_name) ?? readString(entry.displayName) ?? name,
    description: readString(entry.description) ?? "",
    version: readString(entry.version) ?? "",
    category: readString(entry.category) ?? "",
    entryPoint: entryPoint ?? "",
    installStrategy: inferInstallStrategy(installCmd),
    installCmd,
    uninstallCmd: readString(entry.uninstall_cmd),
    updateCmd: readString(entry.update_cmd),
    skillMd: readString(entry.skill_md) ?? readString(entry.skillMd),
    requiresText: readString(entry.requires_text) ?? readString(entry.requires),
    homepage: readString(entry.homepage),
    registryJson: JSON.stringify(entry),
    syncedAt,
  };
}

function inferInstallStrategy(installCmd: string | undefined): UpsertRuntimeAppCatalogItemInput["installStrategy"] {
  const command = installCmd?.trim().toLowerCase() ?? "";
  if (!command) {
    return "cli_hub";
  }
  if (/\bnpm\s+install\b/.test(command)) {
    return "npm";
  }
  if (/\buv\s+/.test(command)) {
    return "uv";
  }
  if (/\bpip(?:3|\s|$)|python\s+-m\s+pip/.test(command)) {
    return "pip";
  }
  return "manual";
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
