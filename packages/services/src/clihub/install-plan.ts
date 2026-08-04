import type { RuntimeAppCatalogItemRecord, RuntimeAppInstallStrategy, RuntimeAppRiskLevel } from "@dofe-agent/db";
import type { RuntimeAppCommandPlanItem, RuntimeAppInstallPlan, RuntimeAppOperationType } from "@dofe-agent/domain";
import { applyCliHubCatalogCompatibility, readCliHubCatalogCompatibilityOverride } from "./catalog-compatibility.ts";

const UNSAFE_COMMAND_PATTERN = /(\||&&|;|`|\$\(|<\(|>\(|\bcurl\b|\bwget\b|\bsudo\b|\bsu\b|\bchmod\b|\bchown\b|\bsystemctl\b|\blaunchctl\b|\btee\s+-a\b|>>|~\/\.(?:bash|zsh|profile|config))/i;
const CLI_HUB_PIP_ENV = { PIP_BREAK_SYSTEM_PACKAGES: "1" } as const;
const NPM_PACKAGE_PATTERN = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;
const NPM_PACKAGE_SPEC_PATTERN = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/i;
const PYPI_PACKAGE_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
const PYPI_PACKAGE_SPEC_PATTERN = /^([a-z0-9][a-z0-9._-]*)==(\d+\.\d+\.\d+(?:[a-z0-9.-]+)?)$/i;
const MUTABLE_VERSION_PATTERN = /(?:^|[-_.])(latest|head|main|master|next|nightly|snapshot|dev)(?:$|[-_.])/i;
const DESKTOP_OR_INTERACTIVE_REQUIREMENT_PATTERN = /\b(gui|desktop|installed locally|local app|server running|running locally|interactive install|interactive login)\b/i;
const CONFIGURATION_REQUIREMENT_PATTERN = /\b(api key|token|credential|login|account)\b/i;

export type RuntimeAppInstallabilityStatus = "installable" | "needs_configuration" | "unsupported";
export type RuntimeAppRequiredTool = "npm" | "python" | "pip" | "cli_hub";

export interface RuntimeAppInstallability {
  status: RuntimeAppInstallabilityStatus;
  code?: string;
  requiredTools: RuntimeAppRequiredTool[];
}

interface RuntimeAppReadinessInput {
  npm: { available: boolean };
  python: { available: boolean };
  pip: { available: boolean };
  cliHub: { available: boolean };
}

interface PublicPypiPackage {
  name: string;
  spec: string;
}

interface PrivateArtifactLock {
  url: string;
  integrity: string;
  localPath: string;
}

export function buildRuntimeAppInstallPlan(input: {
  item: RuntimeAppCatalogItemRecord;
  operation: RuntimeAppOperationType;
  cliHubAvailable?: boolean;
}): RuntimeAppInstallPlan {
  if (input.operation === "install" || input.operation === "update") {
    const installability = assessRuntimeAppInstallability(input.item);
    if (installability.status !== "installable") {
      throw new Error(installability.code ?? "runtime_app.not_installable");
    }
  }
  const compatibility = readCliHubCatalogCompatibilityOverride(input.item.source, input.item.name);
  const item = applyCliHubCatalogCompatibility(input.item);
  const cliHubAvailable = input.cliHubAvailable !== false;
  const risk = assessRuntimeAppRisk(item);
  const npmPackage = compatibility?.npmPackage ?? readPublicNpmPackage(item);
  const pypiPackage = readPublicPypiPackage(item);
  const cliHubRegistrySnapshot = readCliHubRegistrySnapshot(item);
  const privateArtifactLock = input.operation === "install" || input.operation === "update"
    ? readPrivateArtifactLock(item)
    : undefined;
  const strategy: RuntimeAppInstallStrategy =
    input.operation === "disable" || input.operation === "enable"
      ? "manual"
      : npmPackage
        ? "npm"
        : pypiPackage
          ? "pip"
          : cliHubAvailable
            ? "cli_hub"
            : input.operation === "install"
              ? "pip"
              : "cli_hub";
  const commands = buildOperationCommands(item, input.operation, strategy, cliHubAvailable, npmPackage, pypiPackage, privateArtifactLock);
  const verifyCommands = shouldVerifyAfterOperation(input.operation)
    ? buildVerifyCommands(item, strategy, npmPackage, pypiPackage)
    : [];
  const notes = buildPlanNotes(item, input.operation, strategy, risk);
  return {
    app: {
      source: item.source,
      name: item.name,
      version: item.version,
      entryPoint: item.entryPoint,
    },
    strategy,
    commands,
    verifyCommands,
    risk,
    requiresApproval: true,
    notes,
    ...(privateArtifactLock ? { artifactLock: privateArtifactLock, integrityLock: privateArtifactLock.integrity } : {}),
    ...(strategy === "cli_hub" && cliHubRegistrySnapshot
      ? { cliHubRegistrySnapshot }
      : {}),
  };
}

export function assessRuntimeAppInstallability(
  inputItem: RuntimeAppCatalogItemRecord,
  readiness?: RuntimeAppReadinessInput,
): RuntimeAppInstallability {
  const compatibility = readCliHubCatalogCompatibilityOverride(inputItem.source, inputItem.name);
  const item = applyCliHubCatalogCompatibility(inputItem);
  const version = item.version.trim();
  if (!isImmutableVersion(version)) {
    return blocked("unsupported", "runtime_app.release_unpinned");
  }
  if (!item.entryPoint.trim()) {
    return blocked("unsupported", "runtime_app.entrypoint_missing");
  }
  if (!item.installCmd?.trim()) {
    return blocked("unsupported", "runtime_app.install_command_missing");
  }
  if (UNSAFE_COMMAND_PATTERN.test(item.installCmd)) {
    return blocked("unsupported", "runtime_app.install_command_unsafe");
  }
  if (DESKTOP_OR_INTERACTIVE_REQUIREMENT_PATTERN.test(item.requiresText ?? "")) {
    return blocked("unsupported", "runtime_app.runtime_dependency_unsupported");
  }
  if (CONFIGURATION_REQUIREMENT_PATTERN.test(item.requiresText ?? "")) {
    return blocked("needs_configuration", "runtime_app.configuration_required");
  }
  if (item.installStrategy === "manual" || item.installStrategy === "system" || item.installStrategy === "bundled" || item.installStrategy === "uv") {
    return blocked("unsupported", "runtime_app.install_strategy_unsupported");
  }
  if (item.source === "workspace_private" && !readPrivateArtifactLock(item)) {
    return blocked("unsupported", "runtime_app.artifact_integrity_missing");
  }

  const npmPackage = normalizeExactNpmPackageSpec(
    compatibility?.npmPackage ?? readPublicNpmPackage(item),
    version,
  );
  if (npmPackage) {
    return checkRuntimeTools(["npm"], readiness);
  }
  const pypiPackage = readPublicPypiPackage(item);
  if (pypiPackage) {
    return checkRuntimeTools(["python", "pip"], readiness);
  }
  if (!isPinnedCliHubInstallCommand(item.installCmd)) {
    return blocked("unsupported", "runtime_app.install_artifact_unpinned");
  }
  return checkRuntimeTools(["cli_hub"], readiness);
}

export function assessRuntimeAppRisk(item: Pick<RuntimeAppCatalogItemRecord, "source" | "installCmd" | "requiresText" | "installStrategy">): RuntimeAppRiskLevel {
  if (item.source === "workspace_private") return "high";
  const command = item.installCmd ?? "";
  const requiresText = item.requiresText ?? "";
  if (UNSAFE_COMMAND_PATTERN.test(command)) {
    return "high";
  }
  if (/\b(api key|token|credential|login|account|gui|desktop|server running|running|installed locally|local app)\b/i.test(requiresText)) {
    return "medium";
  }
  if (item.installStrategy === "manual") {
    return "high";
  }
  return "low";
}

function buildOperationCommands(
  item: RuntimeAppCatalogItemRecord,
  operation: RuntimeAppOperationType,
  strategy: RuntimeAppInstallStrategy,
  cliHubAvailable: boolean,
  npmPackage?: string,
  pypiPackage?: PublicPypiPackage,
  privateArtifactLock?: PrivateArtifactLock,
): RuntimeAppCommandPlanItem[] {
  if (operation === "disable" || operation === "enable" || operation === "verify") {
    return [];
  }
  if (strategy === "cli_hub") {
    const operationCommand = buildCliHubCommand([operation, item.name]);
    if (!cliHubAvailable) {
      throw new Error("runtime_app.runtime_cli_hub_unavailable");
    }
    return [operationCommand];
  }
  if (strategy === "npm" && npmPackage) {
    if (operation === "uninstall") {
      return [{ executable: "npm", args: ["uninstall", "--global", npmPackageName(npmPackage)] }];
    }
    if (operation === "install" || operation === "update") {
      return [{ executable: "npm", args: ["install", "--global", privateArtifactLock?.localPath ?? npmPackage] }];
    }
  }
  if (strategy === "pip" && pypiPackage) {
    if (operation === "uninstall") {
      return [{ executable: "python3", args: ["-m", "pip", "uninstall", "--yes", pypiPackage.name], env: CLI_HUB_PIP_ENV }];
    }
    if (operation === "install" || operation === "update") {
      return [{ executable: "python3", args: ["-m", "pip", "install", "--user", privateArtifactLock?.localPath ?? pypiPackage.spec], env: CLI_HUB_PIP_ENV }];
    }
  }
  if (operation !== "install") {
    return cliHubAvailable ? [buildCliHubCommand([operation, item.name])] : [];
  }
  throw new Error("runtime_app.install_strategy_unsupported");
}

function buildCliHubCommand(args: string[]): RuntimeAppCommandPlanItem {
  return { executable: "cli-hub", args, env: CLI_HUB_PIP_ENV };
}

function shouldVerifyAfterOperation(operation: RuntimeAppOperationType): boolean {
  return operation === "install" || operation === "update" || operation === "verify";
}

function buildVerifyCommands(
  item: RuntimeAppCatalogItemRecord,
  strategy: RuntimeAppInstallStrategy,
  npmPackage?: string,
  pypiPackage?: PublicPypiPackage,
): RuntimeAppCommandPlanItem[] {
  if (strategy === "npm" && npmPackage) {
    return [
      { executable: "npm", args: ["list", "--global", "--depth=0", npmPackage] },
      ...(item.entryPoint.trim() ? [{ executable: "which", args: [item.entryPoint.trim()] }] : []),
    ];
  }
  if (strategy === "pip" && pypiPackage) {
    return [
      { executable: "python3", args: ["-m", "pip", "show", pypiPackage.name], env: CLI_HUB_PIP_ENV },
      ...(item.entryPoint.trim() ? [{ executable: "which", args: [item.entryPoint.trim()] }] : []),
    ];
  }
  const commands: RuntimeAppCommandPlanItem[] = strategy === "cli_hub"
    ? [buildCliHubCommand(["info", item.name])]
    : [];
  if (item.entryPoint.trim()) {
    commands.push({ executable: "which", args: [item.entryPoint.trim()] });
    commands.push({ executable: item.entryPoint.trim(), args: ["--help"] });
  }
  return commands;
}

function buildPlanNotes(
  item: RuntimeAppCatalogItemRecord,
  operation: RuntimeAppOperationType,
  strategy: RuntimeAppInstallStrategy,
  risk: RuntimeAppRiskLevel,
): string[] {
  const notes = [
    `Operation: ${operation}`,
    `Install strategy: ${strategy}`,
    "DofeAgent executes a controlled command plan with argument arrays; registry install_cmd is catalog metadata only.",
  ];
  if (strategy === "cli_hub") {
    notes.push("CLI-Hub uses the synchronized catalog snapshot in Runtime HOME instead of downloading the registry again.");
  }
  if (item.requiresText?.trim()) {
    notes.push(`Dependency warning: ${item.requiresText.trim()}`);
  }
  if (risk === "high") {
    notes.push("High risk catalog command detected; manual admin confirmation is required before execution.");
  }
  return notes;
}

function readPublicNpmPackage(item: RuntimeAppCatalogItemRecord): string | undefined {
  if ((item.source !== "clihub_public" && item.source !== "workspace_private") || item.installStrategy !== "npm") {
    return undefined;
  }
  try {
    const registry = JSON.parse(item.registryJson) as Record<string, unknown>;
    const exactSpec = typeof registry.npm_package_spec === "string" ? registry.npm_package_spec.trim() : "";
    if (NPM_PACKAGE_SPEC_PATTERN.test(exactSpec)) return exactSpec;
    const candidate = typeof registry.npm_package === "string" ? registry.npm_package.trim() : item.name.trim();
    return NPM_PACKAGE_PATTERN.test(candidate) ? normalizeExactNpmPackageSpec(candidate, item.version) : undefined;
  } catch {
    return undefined;
  }
}

function readPublicPypiPackage(item: RuntimeAppCatalogItemRecord): PublicPypiPackage | undefined {
  if ((item.source !== "clihub_public" && item.source !== "workspace_private") || item.installStrategy !== "pip") {
    return undefined;
  }
  try {
    const registry = JSON.parse(item.registryJson) as Record<string, unknown>;
    const spec = typeof registry.pypi_package_spec === "string" ? registry.pypi_package_spec.trim() : "";
    const match = PYPI_PACKAGE_SPEC_PATTERN.exec(spec);
    if (!match?.[1] || !PYPI_PACKAGE_PATTERN.test(match[1])) return undefined;
    return { name: match[1], spec };
  } catch {
    return undefined;
  }
}

function readPrivateArtifactLock(item: RuntimeAppCatalogItemRecord): PrivateArtifactLock | undefined {
  if (item.source !== "workspace_private" || (item.installStrategy !== "npm" && item.installStrategy !== "pip")) return undefined;
  try {
    const registry = JSON.parse(item.registryJson) as Record<string, unknown>;
    const url = typeof registry.artifact_url === "string" ? registry.artifact_url.trim() : "";
    const integrity = typeof registry.artifact_integrity === "string" ? registry.artifact_integrity.trim() : "";
    const parsed = new URL(url);
    const expectedHost = item.installStrategy === "npm" ? "registry.npmjs.org" : "files.pythonhosted.org";
    const fileName = parsed.pathname.split("/").at(-1) ?? "";
    if (
      parsed.protocol !== "https:" || parsed.hostname !== expectedHost || parsed.username || parsed.password || parsed.search || parsed.hash
      || !/^sha(?:256|384|512)-[A-Za-z0-9+/=]+$/.test(integrity)
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/.test(fileName)
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/.test(item.name)
    ) return undefined;
    return {
      url: parsed.toString(),
      integrity,
      localPath: `.runtime-app-artifacts/${item.name}-${fileName}`,
    };
  } catch {
    return undefined;
  }
}

function readCliHubRegistrySnapshot(item: RuntimeAppCatalogItemRecord): RuntimeAppInstallPlan["cliHubRegistrySnapshot"] {
  if (item.source !== "clihub_harness" && item.source !== "clihub_public") return undefined;
  try {
    const entry = JSON.parse(item.registryJson) as unknown;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
    if ((entry as Record<string, unknown>).name !== item.name) return undefined;
    const runtimeEntry = { ...(entry as Record<string, unknown>) };
    if (typeof runtimeEntry.install_cmd === "string") {
      runtimeEntry.install_cmd = rewriteGitHubPipInstallToArchive(runtimeEntry.install_cmd) ?? runtimeEntry.install_cmd;
    }
    return { source: item.source, registryJson: JSON.stringify(runtimeEntry) };
  } catch {
    return undefined;
  }
}

function rewriteGitHubPipInstallToArchive(command: string): string | undefined {
  const match = /^pip install git\+https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\.git(?:@([A-Za-z0-9._/-]+))?(#subdirectory=[A-Za-z0-9._/-]+)?$/.exec(command.trim());
  if (!match) return undefined;
  const [, owner, repository, ref, fragment = ""] = match;
  if (!ref || !/^[a-f0-9]{40}$/i.test(ref)) return undefined;
  return `pip install https://codeload.github.com/${owner}/${repository}/zip/${ref}${fragment}`;
}

function normalizeExactNpmPackageSpec(candidate: string | undefined, version: string): string | undefined {
  const value = candidate?.trim() ?? "";
  if (NPM_PACKAGE_SPEC_PATTERN.test(value)) return value;
  if (!NPM_PACKAGE_PATTERN.test(value) || !isImmutableVersion(version)) return undefined;
  return `${value}@${version}`;
}

function npmPackageName(packageSpec: string): string {
  const versionSeparator = packageSpec.lastIndexOf("@");
  return versionSeparator > 0 ? packageSpec.slice(0, versionSeparator) : packageSpec;
}

function isImmutableVersion(version: string): boolean {
  return Boolean(
    version
    && !MUTABLE_VERSION_PATTERN.test(version)
    && !/[\s*^~<>=|]/.test(version)
    && /^v?\d+(?:[.][0-9A-Za-z-]+)+(?:[+][0-9A-Za-z.-]+)?$/.test(version),
  );
}

function isPinnedCliHubInstallCommand(command: string): boolean {
  const normalized = command.trim();
  if (/^pip3? install git\+https:\/\/[^\s]+[.]git@[a-f0-9]{40}(?:#\S+)?$/i.test(normalized)) return true;
  if (/^pip3? install https:\/\/codeload[.]github[.]com\/[^\s]+\/(?:zip|tar[.]gz)\/[a-f0-9]{40}(?:#\S+)?$/i.test(normalized)) return true;
  if (/^npm (?:install|i) (?:--global|-g) (?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/i.test(normalized)) return true;
  return /^(?:(?:python3?|python) -m )?pip3? install(?: --user)? [a-z0-9][a-z0-9._-]*==\d+\.\d+\.\d+(?:[a-z0-9.-]+)?$/i.test(normalized);
}

function blocked(status: Exclude<RuntimeAppInstallabilityStatus, "installable">, code: string): RuntimeAppInstallability {
  return { status, code, requiredTools: [] };
}

function checkRuntimeTools(
  requiredTools: RuntimeAppRequiredTool[],
  readiness?: RuntimeAppReadinessInput,
): RuntimeAppInstallability {
  if (!readiness) return { status: "installable", requiredTools };
  for (const tool of requiredTools) {
    if (!readiness[tool === "cli_hub" ? "cliHub" : tool].available) {
      return {
        status: "needs_configuration",
        code: `runtime_app.runtime_${tool}_unavailable`,
        requiredTools,
      };
    }
  }
  return { status: "installable", requiredTools };
}
