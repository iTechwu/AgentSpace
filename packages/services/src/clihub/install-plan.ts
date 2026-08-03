import type { RuntimeAppCatalogItemRecord, RuntimeAppInstallStrategy, RuntimeAppRiskLevel } from "@dofe-agent/db";
import type { RuntimeAppCommandPlanItem, RuntimeAppInstallPlan, RuntimeAppOperationType } from "@dofe-agent/domain";

const UNSAFE_COMMAND_PATTERN = /(\||&&|;|`|\$\(|<\(|>\(|\bcurl\b|\bwget\b|\bsudo\b|\bsu\b|\bchmod\b|\bchown\b|\bsystemctl\b|\blaunchctl\b|\btee\s+-a\b|>>|~\/\.(?:bash|zsh|profile|config))/i;
const CLI_HUB_PIP_ENV = { PIP_BREAK_SYSTEM_PACKAGES: "1" } as const;
const NPM_PACKAGE_PATTERN = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;

export function buildRuntimeAppInstallPlan(input: {
  item: RuntimeAppCatalogItemRecord;
  operation: RuntimeAppOperationType;
  cliHubAvailable?: boolean;
}): RuntimeAppInstallPlan {
  const cliHubAvailable = input.cliHubAvailable !== false;
  const risk = assessRuntimeAppRisk(input.item);
  const npmPackage = readPublicNpmPackage(input.item);
  const strategy: RuntimeAppInstallStrategy =
    input.operation === "disable" || input.operation === "enable"
      ? "manual"
      : npmPackage
        ? "npm"
        : cliHubAvailable
          ? "cli_hub"
          : input.operation === "install"
            ? "pip"
            : "cli_hub";
  const commands = buildOperationCommands(input.item, input.operation, strategy, cliHubAvailable, npmPackage);
  const verifyCommands = shouldVerifyAfterOperation(input.operation)
    ? buildVerifyCommands(input.item, strategy, npmPackage)
    : [];
  const notes = buildPlanNotes(input.item, input.operation, strategy, risk, cliHubAvailable);
  return {
    app: {
      source: input.item.source,
      name: input.item.name,
      version: input.item.version,
      entryPoint: input.item.entryPoint,
    },
    strategy,
    commands,
    verifyCommands,
    risk,
    requiresApproval: true,
    notes,
  };
}

export function assessRuntimeAppRisk(item: Pick<RuntimeAppCatalogItemRecord, "installCmd" | "requiresText" | "installStrategy">): RuntimeAppRiskLevel {
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
): RuntimeAppCommandPlanItem[] {
  if (operation === "disable" || operation === "enable" || operation === "verify") {
    return [];
  }
  if (strategy === "cli_hub") {
    const operationCommand = buildCliHubCommand([operation, item.name]);
    return cliHubAvailable ? [operationCommand] : [buildCliHubBootstrapCommand(), operationCommand];
  }
  if (strategy === "npm" && npmPackage) {
    if (operation === "uninstall") {
      return [{ executable: "npm", args: ["uninstall", "--global", npmPackage] }];
    }
    if (operation === "install" || operation === "update") {
      return [{ executable: "npm", args: ["install", "--global", npmPackage] }];
    }
  }
  if (operation !== "install") {
    return cliHubAvailable ? [buildCliHubCommand([operation, item.name])] : [];
  }
  return [
    buildCliHubBootstrapCommand(),
    buildCliHubCommand(["install", item.name]),
  ];
}

function buildCliHubBootstrapCommand(): RuntimeAppCommandPlanItem {
  return {
    executable: "python3",
    args: ["-m", "pip", "install", "--user", "cli-anything-hub"],
    env: CLI_HUB_PIP_ENV,
  };
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
): RuntimeAppCommandPlanItem[] {
  if (strategy === "npm" && npmPackage) {
    return [{
      executable: "npm",
      args: ["list", "--global", "--depth=0", npmPackage],
    }];
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
  cliHubAvailable: boolean,
): string[] {
  const notes = [
    `Operation: ${operation}`,
    `Install strategy: ${strategy}`,
    "DofeAgent executes a controlled command plan with argument arrays; registry install_cmd is catalog metadata only.",
  ];
  if (strategy === "cli_hub" && !cliHubAvailable && (operation === "install" || operation === "update" || operation === "uninstall")) {
    notes.push("Target runtime did not report cli-hub readiness, so the plan bootstraps cli-anything-hub with python3 -m pip install --user before running cli-hub.");
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
  if (item.source !== "clihub_public" || item.installStrategy !== "npm") {
    return undefined;
  }
  try {
    const registry = JSON.parse(item.registryJson) as Record<string, unknown>;
    const candidate = typeof registry.npm_package === "string" ? registry.npm_package.trim() : item.name.trim();
    return NPM_PACKAGE_PATTERN.test(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}
