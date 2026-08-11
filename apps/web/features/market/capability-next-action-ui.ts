import type { CapabilityNextAction } from "@dofe-agent/services";
import type { CapabilityTranslator } from "./capability-presentation";

export interface CapabilityNextActionBadge {
  nextAction: CapabilityNextAction;
  primaryLabel: string;
  primaryEnabled: boolean;
  statusTone: "positive" | "warning" | "danger" | "neutral";
}

/**
 * Maps the server-side 9-state `CapabilityNextAction` projection to the
 * primary button copy and enabled state shown on the catalog detail pane.
 * The projection itself is computed server-side; this table is the only
 * place the UI translates the projection into copy + enable.
 */
export function buildCapabilityNextActionBadge(input: {
  nextAction: CapabilityNextAction;
  canManage: boolean;
  userState: "available" | "installed" | "connected" | "requested" | "blocked";
  tx: CapabilityTranslator;
}): CapabilityNextActionBadge {
  const { nextAction, canManage, userState, tx } = input;
  switch (nextAction) {
    case "install":
      return {
        nextAction,
        primaryLabel: userState === "installed" ? tx("更新", "Update") : tx("安装", "Install"),
        primaryEnabled: true,
        statusTone: "positive",
      };
    case "connect":
      return {
        nextAction,
        primaryLabel: userState === "connected" ? tx("重新连接", "Reconnect") : tx("连接", "Connect"),
        primaryEnabled: true,
        statusTone: "positive",
      };
    case "configure_credentials":
      return {
        nextAction,
        primaryLabel: tx("配置凭据", "Configure credentials"),
        primaryEnabled: true,
        statusTone: "warning",
      };
    case "request_deployment":
      return {
        nextAction,
        primaryLabel: canManage ? tx("部署并启用", "Deploy and enable") : tx("申请管理员部署", "Request admin deployment"),
        primaryEnabled: true,
        statusTone: "warning",
      };
    case "wait_for_approval":
      return {
        nextAction,
        primaryLabel: tx("查看申请", "View request"),
        primaryEnabled: false,
        statusTone: "neutral",
      };
    case "wait_for_operation":
      return {
        nextAction,
        primaryLabel: tx("查看进度", "View progress"),
        primaryEnabled: false,
        statusTone: "neutral",
      };
    case "repair":
      return {
        nextAction,
        primaryLabel: tx("暂时不可用", "Temporarily unavailable"),
        primaryEnabled: false,
        statusTone: "danger",
      };
    case "govern_release":
      return {
        nextAction,
        primaryLabel: tx("暂未开放", "Not yet available"),
        primaryEnabled: false,
        statusTone: "neutral",
      };
    case "none":
      return {
        nextAction,
        primaryLabel: tx("已启用", "Enabled"),
        primaryEnabled: false,
        statusTone: "positive",
      };
  }
}

/**
 * Legacy fallback for the CLI primary button when the server-side V2
 * projection is absent (feature flag off, or no projection computed for this
 * tuple). Reconstructs the pre-projection label + enabled state from the
 * legacy `installability` + installed signals so the page keeps working
 * during a rollback and so the market flow remains testable without V2.
 */
export function buildLegacyCliCapabilityBadge(input: {
  installable: boolean;
  installed: boolean;
  canManage: boolean;
  tx: CapabilityTranslator;
}): CapabilityNextActionBadge {
  const enabled = input.installable && input.canManage;
  return {
    nextAction: input.installable ? "install" : "none",
    primaryLabel: input.installed ? input.tx("更新", "Update") : input.tx("安装", "Install"),
    primaryEnabled: enabled,
    statusTone: enabled ? "positive" : "neutral",
  };
}

/**
 * Legacy fallback for the MCP primary button when no V2 projection exists.
 * The pre-projection button always offered "配置并连接" once the dependency
 * CLI was ready and the form was submittable; both `connect` and
 * `configure_credentials` route to the same submit handler.
 */
export function buildLegacyMcpCapabilityBadge(input: {
  canManage: boolean;
  tx: CapabilityTranslator;
}): CapabilityNextActionBadge {
  return {
    nextAction: "connect",
    primaryLabel: input.tx("配置并连接", "Configure and connect"),
    primaryEnabled: input.canManage,
    statusTone: "positive",
  };
}

export function capabilityNextActionLabel(
  nextAction: CapabilityNextAction,
  tx: CapabilityTranslator,
): string {
  switch (nextAction) {
    case "install": return tx("安装", "Install");
    case "connect": return tx("连接", "Connect");
    case "configure_credentials": return tx("配置凭据", "Configure credentials");
    case "request_deployment": return tx("申请管理员部署", "Request admin deployment");
    case "wait_for_approval": return tx("等待审核", "Awaiting approval");
    case "wait_for_operation": return tx("处理中", "In progress");
    case "repair": return tx("需要修复", "Needs repair");
    case "govern_release": return tx("暂未开放", "Not yet available");
    case "none": return tx("已启用", "Enabled");
  }
}