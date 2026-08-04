import type { McpConnectionOperationStage, RuntimeAppCatalogSource, RuntimeAppOperationStage } from "@dofe-agent/db";

export type CapabilityTranslator = (zh: string, en: string) => string;

export type CliCatalogProductSource = RuntimeAppCatalogSource | "official";

export interface CliInstallabilityProjection {
  status: "installable" | "needs_configuration" | "unsupported";
  code?: string;
  requiredTools?: Array<"npm" | "python" | "pip" | "cli_hub">;
}

export interface RuntimeCliReadinessProjection {
  npm: boolean;
  python: boolean;
  pip: boolean;
  cliHub: boolean;
}

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
    case "workspace_private":
      return tx("工作区私有", "Workspace private");
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

export function isActiveCapabilityOperationStatus(status: string): boolean {
  return status === "pending" || status === "claimed" || status === "running";
}

export function runtimeAppOperationStageLabel(
  stage: RuntimeAppOperationStage | undefined,
  tx: CapabilityTranslator,
): string | undefined {
  switch (stage) {
    case "queued": return tx("等待执行", "Queued");
    case "installing": return tx("正在安装", "Installing");
    case "verifying": return tx("正在验证", "Verifying");
    case "finalizing": return tx("正在收尾", "Finalizing");
    case "completed": return tx("已完成", "Completed");
    default: return undefined;
  }
}

export function mcpOperationStageLabel(
  stage: McpConnectionOperationStage | undefined,
  tx: CapabilityTranslator,
): string | undefined {
  switch (stage) {
    case "queued": return tx("等待执行", "Queued");
    case "connecting": return tx("正在连接", "Connecting");
    case "negotiating": return tx("协议协商", "Negotiating");
    case "discovering_tools": return tx("发现工具", "Discovering tools");
    case "finalizing": return tx("正在收尾", "Finalizing");
    case "completed": return tx("已完成", "Completed");
    default: return undefined;
  }
}

export function projectRuntimeAppInstallability(
  installability: CliInstallabilityProjection,
  readiness: RuntimeCliReadinessProjection,
): CliInstallabilityProjection {
  if (installability.status !== "installable") return installability;
  for (const tool of installability.requiredTools ?? []) {
    const key = tool === "cli_hub" ? "cliHub" : tool;
    if (!readiness[key]) {
      return { status: "needs_configuration", code: `runtime_app.runtime_${tool}_unavailable`, requiredTools: installability.requiredTools };
    }
  }
  return { status: "installable", requiredTools: installability.requiredTools };
}

export function runtimeAppInstallabilityStatusLabel(
  status: CliInstallabilityProjection["status"],
  tx: CapabilityTranslator,
): string {
  if (status === "installable") return tx("可安装", "Installable");
  if (status === "needs_configuration") return tx("需要配置", "Needs configuration");
  return tx("不可安装", "Not installable");
}

export function runtimeAppInstallabilityReason(
  code: string | undefined,
  tx: CapabilityTranslator,
): string {
  switch (code) {
    case undefined:
      return tx("已通过目录与 Runtime 预检。", "Catalog and Runtime preflight checks passed.");
    case "runtime_app.release_unpinned":
      return tx("目录没有提供固定版本，需由维护者发布不可变 release。", "The catalog does not provide a fixed version. The maintainer must publish an immutable release.");
    case "runtime_app.entrypoint_missing":
      return tx("目录没有声明可验证的入口命令。", "The catalog does not declare a verifiable entry point.");
    case "runtime_app.install_command_missing":
      return tx("目录没有提供安装声明。", "The catalog does not provide an install declaration.");
    case "runtime_app.install_command_unsafe":
      return tx("上游安装声明包含 shell 控制或下载执行命令，平台已阻断。", "The upstream declaration contains shell control or download-and-execute commands and has been blocked.");
    case "runtime_app.install_artifact_unpinned":
      return tx("安装 artifact 未固定到精确包版本或 Git commit。", "The install artifact is not pinned to an exact package version or Git commit.");
    case "runtime_app.runtime_dependency_unsupported":
      return tx("该应用依赖桌面、本机服务或交互式安装，当前 Runtime 不支持。", "This app requires a desktop, local service, or interactive installation that the Runtime does not support.");
    case "runtime_app.configuration_required":
      return tx("安装前需要账号或凭据配置，当前目录尚无安全配置流程。", "Account or credential setup is required, but this catalog entry has no safe configuration flow yet.");
    case "runtime_app.install_strategy_unsupported":
      return tx("当前安装策略不受受控执行器支持。", "The controlled installer does not support this install strategy.");
    case "runtime_app.runtime_npm_unavailable":
      return tx("目标 Runtime 缺少 npm，请更换 Runtime 或更新运行镜像。", "The target Runtime does not have npm. Choose another Runtime or update its image.");
    case "runtime_app.runtime_python_unavailable":
      return tx("目标 Runtime 缺少 Python，请更换 Runtime 或更新运行镜像。", "The target Runtime does not have Python. Choose another Runtime or update its image.");
    case "runtime_app.runtime_pip_unavailable":
      return tx("目标 Runtime 缺少 pip，请更换 Runtime 或更新运行镜像。", "The target Runtime does not have pip. Choose another Runtime or update its image.");
    case "runtime_app.runtime_cli_hub_unavailable":
      return tx("目标 Runtime 未预装受管 CLI-Hub，平台不会临时安装可漂移版本。", "The target Runtime does not have managed CLI-Hub. The platform will not bootstrap a mutable version.");
    case "runtime.offline":
      return tx("没有可用的在线 Runtime。", "No online Runtime is available.");
    default:
      return tx("该条目未通过安装预检。", "This catalog entry did not pass installation preflight.");
  }
}
