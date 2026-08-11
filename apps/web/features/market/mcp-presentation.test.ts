import { describe, expect, it } from "vitest";
import {
  mcpCatalogCategoryLabel,
  mcpCatalogSourceLabel,
  mcpConnectionStatusLabel,
  mcpOperationLabel,
  mcpOperationSourceLabel,
  mcpOperationStatusLabel,
  mcpRiskLabel,
  mcpToolCallOutcomeLabel,
  mcpTransportLabel,
} from "@/features/market/capability-presentation";

const tx = (zh: string, _en: string) => zh;

describe("MCP presentation labels", () => {
  it("translates transport and risk values", () => {
    expect(mcpTransportLabel("streamable_http", tx)).toBe("流式 HTTP");
    expect(mcpTransportLabel("managed_stdio", tx)).toBe("受管 stdio");
    expect(mcpTransportLabel("managed_service", tx)).toBe("受管服务");
    expect(mcpTransportLabel("sse", tx)).toBe("SSE");
    expect(mcpRiskLabel("low", tx)).toBe("低风险");
    expect(mcpRiskLabel("medium", tx)).toBe("中风险");
    expect(mcpRiskLabel("high", tx)).toBe("高风险");
  });

  it("translates catalog categories and sources", () => {
    expect(mcpCatalogCategoryLabel("developer_tools", tx)).toBe("开发工具");
    expect(mcpCatalogCategoryLabel("data_analytics", tx)).toBe("数据分析");
    expect(mcpCatalogSourceLabel("official", tx)).toBe("官方");
    expect(mcpCatalogSourceLabel("workspace_private", tx)).toBe("工作区私有");
  });

  it("translates connection lifecycle values", () => {
    expect(mcpConnectionStatusLabel("pending_configuration", tx)).toBe("待配置");
    expect(mcpConnectionStatusLabel("queued_verification", tx)).toBe("等待验证");
    expect(mcpConnectionStatusLabel("verifying", tx)).toBe("验证中");
    expect(mcpConnectionStatusLabel("ready", tx)).toBe("已验证");
    expect(mcpConnectionStatusLabel("degraded", tx)).toBe("连接异常");
    expect(mcpConnectionStatusLabel("failed", tx)).toBe("验证失败");
    expect(mcpConnectionStatusLabel("disabled", tx)).toBe("已停用");
  });

  it("translates operation and tool-call values", () => {
    expect(mcpOperationLabel("verify", tx)).toBe("验证");
    expect(mcpOperationLabel("remove", tx)).toBe("移除");
    expect(mcpOperationSourceLabel("health_check", tx)).toBe("健康检查");
    expect(mcpOperationStatusLabel("pending", tx)).toBe("等待中");
    expect(mcpOperationStatusLabel("running", tx)).toBe("进行中");
    expect(mcpOperationStatusLabel("succeeded", tx)).toBe("已成功");
    expect(mcpOperationStatusLabel("failed", tx)).toBe("失败");
    expect(mcpOperationStatusLabel("cancelled", tx)).toBe("已取消");
    expect(mcpToolCallOutcomeLabel("succeeded", tx)).toBe("成功");
    expect(mcpToolCallOutcomeLabel("failed", tx)).toBe("失败");
  });

  it("uses a safe Chinese fallback for unknown values", () => {
    expect(mcpTransportLabel("future_transport", tx)).toBe("未知传输");
    expect(mcpConnectionStatusLabel("future_status", tx)).toBe("状态未知");
    expect(mcpOperationStatusLabel("future_operation_status", tx)).toBe("状态未知");
    expect(mcpToolCallOutcomeLabel("future_outcome", tx)).toBe("结果未知");
  });
});
