"use client";

import { AppIcon } from "@/shared/ui/app-icon";

type SetupStepStatus = "complete" | "current" | "pending";

export function ManagedMcpSetupProgress({
  configurationReady,
  dependencyReady,
  dependencyRequired,
  permissionsReady,
  runtimeReady,
  tx,
}: {
  configurationReady: boolean;
  dependencyReady: boolean;
  dependencyRequired: boolean;
  permissionsReady: boolean;
  runtimeReady: boolean;
  tx: (zh: string, en: string) => string;
}) {
  const runtimeComplete = runtimeReady;
  const dependencyComplete = runtimeComplete && (!dependencyRequired || dependencyReady);
  const configurationComplete = dependencyComplete && configurationReady;
  const permissionsComplete = configurationComplete && permissionsReady;
  const completion = [runtimeComplete, dependencyComplete, configurationComplete, permissionsComplete, false];
  const currentIndex = completion.findIndex((complete) => !complete);
  const labels = [
    tx("选择 Runtime", "Select runtime"),
    dependencyRequired ? tx("安装依赖 CLI", "Install dependency CLI") : tx("检查依赖", "Check dependencies"),
    tx("配置参数", "Configure"),
    tx("确认工具权限", "Approve tools"),
    tx("验证连接", "Verify connection"),
  ];

  return (
    <ol aria-label={tx("MCP 连接进度", "MCP connection progress")} className="mcp-setup-progress">
      {labels.map((label, index) => {
        const status: SetupStepStatus = completion[index] ? "complete" : index === currentIndex ? "current" : "pending";
        return (
          <li aria-current={status === "current" ? "step" : undefined} className={`mcp-setup-progress__step mcp-setup-progress__step--${status}`} key={label}>
            <span aria-hidden="true" className="mcp-setup-progress__index">{status === "complete" ? <AppIcon name="checkCircle" /> : index + 1}</span>
            <span>{label}</span>
          </li>
        );
      })}
    </ol>
  );
}
