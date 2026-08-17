// 3.5-4：自 provider-runtime.ts 拆出——任务运行时工具能力清单：内置
// dofe-agent/lark-cli 能力、CLI-Hub runtime app 能力与去重合并。
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RuntimeAppContextEntry, RuntimeToolCapability } from "@dofe-agent/domain";
import { buildFeishuLarkCliDiagnosticRuntimeToolCapability } from "@dofe-agent/services/integrations";
import { resolveRuntimeAppUserBinDir } from "../runtime-apps.ts";
import { dedupeStrings, findExecutableOnPath, isPathLike, shellQuote } from "./executables.ts";
import type { ProviderTaskOptions } from "./types.ts";

export function buildRuntimeToolCapabilities(options: ProviderTaskOptions): RuntimeToolCapability[] {
  return dedupeRuntimeToolCapabilities([
    ...buildBuiltinRuntimeToolCapabilities(options.contextEnv),
    ...buildCliHubRuntimeToolCapabilities(
      options.runtimeApps ?? [],
      options.runtimeAppBinDir,
      options.runtimeAppHostDiagnostics ?? true,
    ),
    ...(options.runtimeToolCapabilities ?? []),
  ]);
}

function buildBuiltinRuntimeToolCapabilities(contextEnv?: Record<string, string>): RuntimeToolCapability[] {
  const capabilities: RuntimeToolCapability[] = [
    {
      id: "dofe-agent-output",
      command: "dofe-agent",
      displayName: "DofeAgent output CLI",
      binDir: process.env.DOFE_AGENT_DAEMON_BIN ? dirname(process.env.DOFE_AGENT_DAEMON_BIN) : undefined,
      pathDirs: [
        process.env.DOFE_AGENT_DAEMON_INSTALL_ROOT
          ? join(process.env.DOFE_AGENT_DAEMON_INSTALL_ROOT, "bin")
          : "",
      ].filter(Boolean),
      allowedShellPatterns: [
        "dofe-agent output text *",
        "dofe-agent output attach *",
        "dofe-agent output validate *",
        "dofe-agent output preview *",
      ],
      source: "builtin",
    },
  ];

  // curl is deliberately NOT a built-in capability. Auto-injecting
  // `Bash(curl *)` into every task bypassed the task-frozen approved-capability
  // gate, and the Skill Runner runs with `--network none`, so agent-side curl
  // could not make HTTP requests anyway. A skill that needs curl declares
  // `system:curl`, which resolves through the curated system-dependency catalog
  // and the readiness/approval flow before reaching the Provider. The daemon's
  // own curl use (e.g. provider credential probing) runs through a node
  // subprocess and never touches the agent.

  const feishuLarkCliCapability = buildFeishuLarkCliDiagnosticRuntimeToolCapability({
    environment: process.env,
    source: "builtin",
  });
  if (feishuLarkCliCapability) {
    capabilities.push({
      ...feishuLarkCliCapability,
      binPath: isPathLike(feishuLarkCliCapability.command) ? feishuLarkCliCapability.command : feishuLarkCliCapability.binPath,
      binDir: resolveCommandDirFromCurrentEnv(feishuLarkCliCapability.command),
    });
  }

  return capabilities;
}

function buildCliHubRuntimeToolCapabilities(
  runtimeApps: RuntimeAppContextEntry[],
  runtimeAppBinDir?: string,
  enableHostDiagnostics = true,
): RuntimeToolCapability[] {
  if (runtimeApps.length === 0) return [];
  const pythonUserBinDir = runtimeAppBinDir?.trim() || resolveRuntimeAppUserBinDir();
  return runtimeApps.flatMap((app): RuntimeToolCapability[] => {
    const command = app.entryPoint?.trim();
    if (!command) {
      return [];
    }
    return [{
      id: `clihub:${app.source}:${app.name}`,
      command,
      displayName: app.displayName || app.name,
      binDir: runtimeAppBinDir?.trim()
        || resolveCommandDirFromCurrentEnv(command)
        || (pythonUserBinDir && existsSync(join(pythonUserBinDir, command)) ? pythonUserBinDir : undefined),
      allowedShellPatterns: [`${command} *`, `${command} --help`, `command -v ${command}`],
      diagnosticCommands: enableHostDiagnostics ? [`command -v ${shellQuote(command)}`] : undefined,
      source: "cli-hub",
    }];
  });
}

function resolveCommandDirFromCurrentEnv(command: string): string | undefined {
  if (isPathLike(command)) {
    return dirname(command);
  }
  const path = findExecutableOnPath(command);
  return path ? dirname(path) : undefined;
}

function dedupeRuntimeToolCapabilities(capabilities: RuntimeToolCapability[]): RuntimeToolCapability[] {
  const result: RuntimeToolCapability[] = [];
  const seen = new Set<string>();
  for (const capability of capabilities) {
    const id = capability.id.trim();
    const command = capability.command.trim();
    if (!id || !command || seen.has(id)) {
      continue;
    }
    seen.add(id);
    result.push({
      ...capability,
      id,
      command,
      allowedShellPatterns: dedupeStrings(capability.allowedShellPatterns ?? []),
      diagnosticCommands: capability.diagnosticCommands ? dedupeStrings(capability.diagnosticCommands) : undefined,
      pathDirs: capability.pathDirs ? dedupeStrings(capability.pathDirs) : undefined,
    });
  }
  return result;
}
